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

interface Segment { label?: string; amount?: number }
interface RankItem { name?: string; paid?: number; segments?: Segment[] }
interface Overview {
  income?: number; saving?: number; spent?: number; planned?: number;
  budget?: number; balance?: number; ranked?: RankItem[];
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
          .map((s) => `${(s.label || "").trim() || "未备注"} ${fmt(s.amount)}`)
          .join("、");
        line += `（明细：${detail}）`;
      }
      lines.push(line);
    });
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  `你是一位务实、亲切的家庭理财助手。用户会给你本月（按10号账单周期）的家庭收支数据和开支明细。` +
  `请用简体中文输出，总长度控制在300字以内，分成三个部分，每部分用方括号标题开头：\n` +
  `[开支概览] 用一两句话总结这个月钱主要花在哪、收支结构是否健康。\n` +
  `[可优化项] 结合开支明细和备注，指出可能不必要或偏高的开支，给出2-3条具体、可执行的省钱建议；如果开支都合理，就如实说明，不要硬找问题。\n` +
  `[下月预算建议] 基于本月情况，给出下个月主要开支项的预算参考或一个总预算区间，帮助用户做预算判断。\n` +
  `语气自然、不说教，不要编造数据中没有的信息，不要使用多余的 Markdown 符号。`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);

  const apiKey = Deno.env.get("ZHIPU_API_KEY");
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

    const advice = data && data.choices && data.choices[0] &&
      data.choices[0].message && (data.choices[0].message.content || "").trim();
    if (!advice) return json({ error: "AI 未返回内容" }, 502);

    return json({ advice, model: MODEL, generatedAt: new Date().toISOString() });
  } catch (e) {
    return json({ error: "调用 AI 失败：" + ((e && (e as Error).message) || String(e)) }, 502);
  }
});
