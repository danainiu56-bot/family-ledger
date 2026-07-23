const OPENAI_API_URL = "https://api.openai.com/v1";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_DURATION_MS = 31_000;
const MAX_TEXT_LENGTH = 300;
const MAX_PLANS = 10;
const ALLOWED_TYPES = ["income", "savings", "expenses"] as const;
const REVIEW_FIELDS = ["type", "name", "amount", "date"] as const;

type PlanType = typeof ALLOWED_TYPES[number];
type ReviewField = typeof REVIEW_FIELDS[number];

interface VoicePlan {
  type: PlanType;
  name: string;
  amount: number;
  date: string;
  reviewFields: ReviewField[];
}

function corsHeaders(request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": request.headers.get("origin") || "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(
  request: Request,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json; charset=utf-8" },
  });
}

function allowedOrigin(request: Request): boolean {
  const configured = Deno.env.get("VOICE_PLAN_ALLOWED_ORIGINS");
  if (!configured) return true;
  const origin = request.headers.get("origin") || "";
  return configured.split(",").map((value) => value.trim()).includes(origin);
}

function validCycle(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function nextMonth(value: string): string {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function cycleBounds(cycle: string): { start: string; end: string } {
  return { start: `${cycle}-10`, end: `${nextMonth(cycle)}-10` };
}

function validDateInCycle(value: string, cycle: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return false;
  const bounds = cycleBounds(cycle);
  return value >= bounds.start && value < bounds.end;
}

function localToday(timezone: string): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date())) values[part.type] = part.value;
  return `${values.year}-${values.month}-${values.day}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function consumeRateLimit(
  bookId: string,
  source: string,
  windowName: string,
  limit: number,
  expiresAt: Date,
): Promise<boolean> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("rate_limit_unavailable");
  const bucketKey = await sha256(`${bookId}|${source}|${windowName}`);
  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/check_voice_plan_rate_limit`,
    {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_bucket_key: bucketKey,
        p_limit: limit,
        p_expires_at: expiresAt.toISOString(),
      }),
    },
  );
  if (!response.ok) throw new Error("rate_limit_unavailable");
  return await response.json() === true;
}

async function enforceRateLimit(request: Request, bookId: string): Promise<void> {
  const source = (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const now = new Date();
  const minuteAllowed = await consumeRateLimit(
    bookId,
    source,
    `minute:${now.toISOString().slice(0, 16)}`,
    5,
    new Date(now.getTime() + 60_000),
  );
  const dayAllowed = await consumeRateLimit(
    bookId,
    source,
    `day:${now.toISOString().slice(0, 10)}`,
    30,
    new Date(now.getTime() + 24 * 60 * 60_000),
  );
  if (!minuteAllowed || !dayAllowed) throw new Error("rate_limited");
}

async function transcribeAudio(audio: File, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append("file", audio, audio.name || "voice-plan.webm");
  form.append("model", Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-mini-transcribe");
  form.append("language", "zh");
  form.append("response_format", "json");
  const response = await fetch(`${OPENAI_API_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error("transcription_failed");
  const result = await response.json();
  return String(result.text || "").trim();
}

async function structurePlans(
  transcript: string,
  currentCycle: string,
  timezone: string,
  apiKey: string,
): Promise<VoicePlan[]> {
  const today = localToday(timezone);
  const bounds = cycleBounds(currentCycle);
  const defaultDate = validDateInCycle(today, currentCycle) ? today : bounds.start;
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      plans: {
        type: "array",
        minItems: 1,
        maxItems: MAX_PLANS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ALLOWED_TYPES },
            name: { type: "string", maxLength: 20 },
            amount: { type: "number", minimum: 0 },
            date: { type: "string" },
            reviewFields: {
              type: "array",
              uniqueItems: true,
              items: { type: "string", enum: REVIEW_FIELDS },
            },
          },
          required: ["type", "name", "amount", "date", "reviewFields"],
        },
      },
    },
    required: ["plans"],
  };
  const systemPrompt = [
    "你是家庭账本计划解析器，只拆分用户明确表达的计划，不补造项目。",
    "type 只能是 income（收入）、savings（储蓄）、expenses（开支）。",
    `当前账期从 ${bounds.start} 开始，到 ${bounds.end} 之前结束；当前日期是 ${today}。`,
    `日期必须位于当前账期；未说日期时使用 ${defaultDate}，并把 date 放入 reviewFields。`,
    "把中文金额准确换算为数字。金额、名称、类型或日期有歧义时，将对应字段放入 reviewFields。",
    `最多返回 ${MAX_PLANS} 条；无法确认的金额填 0 并标记 amount。`,
  ].join("\n");

  const response = await fetch(`${OPENAI_API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_PARSE_MODEL") || "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcript },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "voice_plans", strict: true, schema },
      },
    }),
  });
  if (!response.ok) throw new Error("structure_failed");
  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error("structure_failed");
  const parsed = JSON.parse(content);
  return Array.isArray(parsed.plans) ? parsed.plans : [];
}

function normalizePlans(plans: VoicePlan[], currentCycle: string): VoicePlan[] {
  return plans.slice(0, MAX_PLANS).map((plan) => {
    const reviewFields = Array.isArray(plan.reviewFields)
      ? plan.reviewFields.filter((field): field is ReviewField =>
        REVIEW_FIELDS.includes(field as ReviewField)
      )
      : [];
    let type = plan.type;
    const name = String(plan.name || "").trim().slice(0, 20);
    let amount = Number(plan.amount);
    let date = String(plan.date || "");
    if (!ALLOWED_TYPES.includes(type)) {
      type = "expenses";
      reviewFields.push("type");
    }
    if (!name) reviewFields.push("name");
    if (!Number.isFinite(amount) || amount <= 0) {
      amount = 0;
      reviewFields.push("amount");
    } else amount = Math.round(amount * 100) / 100;
    if (!validDateInCycle(date, currentCycle)) {
      date = cycleBounds(currentCycle).start;
      reviewFields.push("date");
    }
    return { type, name, amount, date, reviewFields: [...new Set(reviewFields)] };
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "仅支持 POST 请求" }, 405);
  }
  if (!allowedOrigin(request)) {
    return jsonResponse(request, { error: "当前来源不允许调用语音服务" }, 403);
  }
  if (Number(request.headers.get("content-length") || 0) > MAX_AUDIO_BYTES + 100_000) {
    return jsonResponse(request, { error: "录音文件过大，请控制在 30 秒内" }, 413);
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let audio: File | null = null;
    let transcript = "";
    let currentCycle = "";
    let timezone = "Asia/Shanghai";
    let bookId = "";
    let durationMs = 0;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const candidate = form.get("audio");
      if (!(candidate instanceof File)) {
        return jsonResponse(request, { error: "未收到录音文件" }, 400);
      }
      audio = candidate;
      durationMs = Number(form.get("durationMs") || 0);
      currentCycle = String(form.get("currentCycle") || "");
      timezone = String(form.get("timezone") || "Asia/Shanghai").slice(0, 64);
      bookId = String(form.get("bookId") || "");
      if (!audio.type.startsWith("audio/") || audio.size > MAX_AUDIO_BYTES) {
        return jsonResponse(request, { error: "录音格式不支持或文件过大" }, 400);
      }
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
        return jsonResponse(request, { error: "录音时长需在 30 秒以内" }, 400);
      }
    } else if (contentType.includes("application/json")) {
      const body = await request.json();
      transcript = String(body.text || "").trim();
      currentCycle = String(body.currentCycle || "");
      timezone = String(body.timezone || "Asia/Shanghai").slice(0, 64);
      bookId = String(body.bookId || "");
      if (!transcript || transcript.length > MAX_TEXT_LENGTH) {
        return jsonResponse(request, { error: "请输入 1 至 300 个字的计划" }, 400);
      }
    } else {
      return jsonResponse(request, { error: "请求格式不支持" }, 415);
    }

    if (!validCycle(currentCycle) || !/^[a-z0-9_-]{4,32}$/.test(bookId)) {
      return jsonResponse(request, { error: "账本或账期参数不正确" }, 400);
    }
    await enforceRateLimit(request, bookId);
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return jsonResponse(request, { error: "语音服务尚未配置" }, 503);
    if (audio) transcript = await transcribeAudio(audio, apiKey);
    transcript = transcript.trim().slice(0, MAX_TEXT_LENGTH);
    if (!transcript) return jsonResponse(request, { error: "没有听清内容，请重新说一次" }, 422);

    const plans = normalizePlans(
      await structurePlans(transcript, currentCycle, timezone, apiKey),
      currentCycle,
    );
    if (!plans.length) return jsonResponse(request, { error: "没有识别到可创建的计划" }, 422);
    return jsonResponse(request, { transcript, plans });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "rate_limited") {
      return jsonResponse(request, { error: "操作过于频繁，请稍后再试" }, 429);
    }
    if (code === "rate_limit_unavailable") {
      return jsonResponse(request, { error: "语音服务初始化未完成" }, 503);
    }
    if (code === "transcription_failed") {
      return jsonResponse(request, { error: "录音识别失败，请重新说一次" }, 502);
    }
    if (code === "structure_failed" || error instanceof SyntaxError) {
      return jsonResponse(request, { error: "计划解析失败，请换一种说法" }, 502);
    }
    console.error("voice-plan error", error);
    return jsonResponse(request, { error: "语音服务暂时不可用" }, 500);
  }
});
