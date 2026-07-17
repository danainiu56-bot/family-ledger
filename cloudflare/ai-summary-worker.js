// Cloudflare Worker: AI 开支建议代理
// 环境变量：ZHIPU_API_KEY
// 部署后前端请求该 Worker 地址，避免 Supabase Edge Function 到智谱接口超时。

const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";
const MAX_BODY_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;
const rateBuckets = new Map();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fmt(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = Math.abs(v) % 1 === 0 ? v.toFixed(0) : v.toFixed(2);
  return "¥" + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function cleanApiKey(value) {
  return (value || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .replace(/[^\x21-\x7E]/g, "");
}

function rateLimited(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

function buildPrompt(monthKey, ov) {
  const lines = [];
  lines.push(`统计周期：${monthKey}（每月10号到次月10号为一个账单周期）`);
  lines.push(`收入：${fmt(ov.income)}`);
  lines.push(`储蓄：${fmt(ov.saving)}`);
  lines.push(`已完成开支：${fmt(ov.spent)}`);
  lines.push(`计划开支：${fmt(ov.planned)}`);
  if (ov.budget) lines.push(`预算总额：${fmt(ov.budget)}`);
  lines.push(`本期结余：${fmt(ov.balance)}`);
  lines.push(`剩余天数：${Number(ov.remainingDays) || 0}`);
  lines.push(`按当前速度预计周期末开支：${fmt(ov.forecast)}`);
  lines.push(`建议预算对应周期：${ov.nextMonthKey || ""}`);
  lines.push("");
  lines.push("开支明细（按金额从高到低）：");

  const ranked = Array.isArray(ov.ranked) ? ov.ranked : [];
  if (!ranked.length) {
    lines.push("（本周期暂无已支出记录）");
  } else {
    ranked.forEach((it, i) => {
      let line = `${i + 1}. ${it.name || "未命名"}：${fmt(it.paid)}`;
      const segs = (it.segments || []).filter((s) => Number(s.amount) > 0);
      if (segs.length) {
        const detail = segs
          .map((s) => `${(s.label || "").trim() || "未备注"} ${fmt(s.amount)}（${s.memberName || "未标注"}）`)
          .join("、");
        line += `（明细：${detail}）`;
      }
      lines.push(line);
    });
  }
  if (Array.isArray(ov.trends) && ov.trends.length) {
    lines.push(`最近3个周期趋势：${JSON.stringify(ov.trends)}`);
  }
  if (Array.isArray(ov.recurring) && ov.recurring.length) {
    lines.push(`固定或重复支出候选：${ov.recurring.join("、")}`);
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  `你是一位务实、亲切的家庭理财助手。请根据10号账单周期数据识别风险、趋势和可优化开支。` +
  `只返回合法 JSON，不要使用代码围栏。结构必须为：` +
  `{"overview":"一句话概览","advice":"300字内的简体中文建议，可使用Markdown列表",` +
  `"risks":[{"title":"风险标题","reason":"证据和建议","amount":数字}],` +
  `"actions":[{"type":"set_budget","monthKey":"输入给出的建议预算对应周期","amount":数字,"label":"采用建议预算 ¥金额"}]}` +
  `。risks 最多3项；若数据不足可为空。actions 最多1项，预算金额必须合理且大于0。` +
  `不要编造数据，不要说教，不要输出账本编号、设备ID或成员ID。`;

function parseStructured(content, ov) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { advice: content };
  }
  const advice = typeof parsed.advice === "string" ? parsed.advice.trim() : "";
  if (!advice) return { advice: content };
  const risks = Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3).map((risk) => ({
    title: String((risk && risk.title) || "支出提醒").slice(0, 40),
    reason: String((risk && risk.reason) || "").slice(0, 180),
    amount: Math.max(0, Number(risk && risk.amount) || 0),
  })) : [];
  const actions = Array.isArray(parsed.actions) ? parsed.actions.filter((action) =>
    action && action.type === "set_budget" &&
    action.monthKey === ov.nextMonthKey &&
    Number(action.amount) > 0
  ).slice(0, 1).map((action) => ({
    type: "set_budget",
    monthKey: action.monthKey,
    amount: Math.round(Number(action.amount) * 100) / 100,
    label: String(action.label || `采用建议预算 ${fmt(action.amount)}`).slice(0, 60),
  })) : [];
  return {
    advice,
    overview: typeof parsed.overview === "string" ? parsed.overview.slice(0, 180) : "",
    risks,
    actions,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (request.method !== "POST") return json({ error: "仅支持 POST" }, 405);
    if (rateLimited(request)) return json({ error: "请求过于频繁，请稍后再试" }, 429);
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_BODY_BYTES) return json({ error: "请求数据过大" }, 413);

    const apiKey = cleanApiKey(env.ZHIPU_API_KEY);
    if (!apiKey) return json({ error: "服务端未配置 ZHIPU_API_KEY" }, 500);

    let payload;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
        return json({ error: "请求数据过大" }, 413);
      }
      payload = JSON.parse(raw);
    } catch {
      return json({ error: "请求体不是合法 JSON" }, 400);
    }

    const monthKey = (payload && payload.monthKey) || "";
    const ov = payload && payload.overview;
    if (!ov || typeof ov !== "object") return json({ error: "缺少 overview 数据" }, 400);

    const userPrompt = buildPrompt(monthKey, ov);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 25000);

    try {
      const resp = await fetch(ZHIPU_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.6,
          max_tokens: 1200,
        }),
        signal: controller.signal,
      });

      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg =
          (data && data.error && data.error.message) ||
          `智谱接口错误 HTTP ${resp.status}`;
        return json({ error: msg }, 502);
      }

      const content =
        data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        (data.choices[0].message.content || "").trim();
      if (!content) return json({ error: "AI 未返回内容" }, 502);

      const structured = parseStructured(content, ov);
      return json({ ...structured, model: MODEL, generatedAt: new Date().toISOString() });
    } catch (e) {
      const msg = e && e.name === "AbortError" ? "AI 请求超时，请稍后重试" : "调用 AI 失败：" + ((e && e.message) || String(e));
      return json({ error: msg }, 502);
    } finally {
      clearTimeout(timeout);
    }
  },
};
