// AI 开支建议代理 — 接收本月开支概览，调用智谱 GLM-4-Flash 生成建议。
// API Key 藏在服务端环境变量，前端（H5/小程序）只和本函数通信。
//
// 部署：supabase functions deploy ai-summary --no-verify-jwt
// 配密钥：supabase secrets set ZHIPU_API_KEY=你的智谱key

const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fmt(n: unknown): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = Math.abs(v) % 1 === 0 ? v.toFixed(0) : v.toFixed(2);
  return "¥" + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

interface Segment { label?: string; amount?: number; memberName?: string }
interface RankItem { name?: string; paid?: number; segments?: Segment[] }
interface Overview {
  income?: number; saving?: number; spent?: number; planned?: number;
  budget?: number; balance?: number; ranked?: RankItem[];
  remainingDays?: number; forecast?: number; nextMonthKey?: string;
  trends?: unknown[]; recurring?: string[]; categories?: unknown[];
  members?: unknown[]; localAnomalies?: unknown[];
}

function buildPrompt(monthKey: string, ov: Overview): string {
  const lines: string[] = [];
  lines.push(`统计周期：${monthKey}（每月10号到次月10号为一个账单周期）`);
  lines.push(`收入：${fmt(ov.income)}`);
  lines.push(`储蓄：${fmt(ov.saving)}`);
  lines.push(`已完成开支：${fmt(ov.spent)}`);
  lines.push(`计划开支：${fmt(ov.planned)}`);
  if (ov.budget) lines.push(`预算总额：${fmt(ov.budget)}`);
  lines.push(`本期结余：${fmt(ov.balance)}`);
  lines.push(`剩余天数：${Number(ov.remainingDays) || 0}`);
  lines.push(`预计周期末开支：${fmt(ov.forecast)}`);
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
  if (Array.isArray(ov.trends) && ov.trends.length) lines.push(`最近周期趋势：${JSON.stringify(ov.trends)}`);
  if (Array.isArray(ov.recurring) && ov.recurring.length) lines.push(`重复支出候选：${ov.recurring.join("、")}`);
  if (Array.isArray(ov.categories) && ov.categories.length) lines.push(`标准分类汇总：${JSON.stringify(ov.categories)}`);
  if (Array.isArray(ov.members) && ov.members.length) lines.push(`成员支出汇总：${JSON.stringify(ov.members)}`);
  if (Array.isArray(ov.localAnomalies) && ov.localAnomalies.length) {
    lines.push(`本地规则已识别异常：${JSON.stringify(ov.localAnomalies)}`);
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  `你是一位务实、亲切的家庭理财助手。请根据10号账单周期数据优先识别有明确数据证据的异常。` +
  `只返回合法JSON，不要使用代码围栏。结构必须为：` +
  `{"overview":"一句话概览","advice":"300字内的简体中文建议，可使用Markdown列表",` +
  `"risks":[{"title":"异常标题","reason":"数据证据和具体建议","amount":数字}],` +
  `"actions":[{"type":"set_budget","monthKey":"输入给出的建议预算对应周期","amount":数字,"label":"采用建议预算 ¥金额"}]}` +
  `。risks最多3项，没有明确异常时必须为空数组；actions最多1项，预算金额必须合理且大于0。` +
  `不要编造数据，不要输出账本编号、设备ID或成员ID，语气自然、不说教。`;

function parseStructured(content: string, ov: Overview) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    const advice = typeof parsed.advice === "string" ? parsed.advice.trim() : "";
    if (!advice) return { advice: content, risks: [], actions: [] };
    const risks = Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3).map((risk: Record<string, unknown>) => ({
      title: String((risk && risk.title) || "支出提醒").slice(0, 40),
      reason: String((risk && risk.reason) || "").slice(0, 180),
      amount: Math.max(0, Number(risk && risk.amount) || 0),
    })) : [];
    const actions = Array.isArray(parsed.actions) ? parsed.actions.filter((action: Record<string, unknown>) =>
      action && action.type === "set_budget" &&
      action.monthKey === ov.nextMonthKey &&
      Number(action.amount) > 0
    ).slice(0, 1).map((action: Record<string, unknown>) => ({
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
  } catch {
    return { advice: content, risks: [], actions: [] };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);

  const apiKey = (Deno.env.get("ZHIPU_API_KEY") || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .replace(/[^\x21-\x7E]/g, "");
  if (!apiKey) return json({ error: "服务端未配置 ZHIPU_API_KEY" }, 500);

  let payload: { monthKey?: string; overview?: Overview };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }

  const monthKey = (payload && payload.monthKey) || "";
  const ov = payload && payload.overview;
  if (!ov || typeof ov !== "object") return json({ error: "缺少 overview 数据" }, 400);

  const userPrompt = buildPrompt(monthKey, ov);

  try {
    const resp = await fetch(ZHIPU_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: 800,
      }),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) ||
        `智谱接口错误 HTTP ${resp.status}`;
      return json({ error: msg }, 502);
    }

    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && (data.choices[0].message.content || "").trim();
    if (!content) return json({ error: "AI 未返回内容" }, 502);

    return json({ ...parseStructured(content, ov), model: MODEL, generatedAt: new Date().toISOString() });
  } catch (e) {
    return json({ error: "调用 AI 失败：" + ((e && (e as Error).message) || String(e)) }, 502);
  }
});
