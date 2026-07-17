/**
 * Supabase 配置 — 填入后可多人共享账本。
 * 说明见：产品文档/02-需求设计/记账本-发布与共享.md
 */
window.BOOKKEEPING_CONFIG = {
  supabaseUrl: 'https://kjasiqqtihagwsnthbvc.supabase.co',
  supabaseAnonKey: 'sb_publishable_Cft7P8JHV2P08jHc2BP9Nw_fLptoQJ3',
  // Cloudflare Worker AI 代理；智谱 Key 仅保存在 Worker Secret 中。
  aiSummaryUrl: 'https://family-ledger-ai.danainiu56.workers.dev',
  zhipuApiKey: '',
  zhipuModel: 'glm-4-flash'
};
