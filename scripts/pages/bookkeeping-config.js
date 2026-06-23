/**
 * Supabase 配置 — 填入后可多人共享账本。
 * 说明见：产品文档/02-需求设计/记账本-发布与共享.md
 */
window.BOOKKEEPING_CONFIG = {
  supabaseUrl: 'https://kjasiqqtihagwsnthbvc.supabase.co',
  supabaseAnonKey: 'sb_publishable_Cft7P8JHV2P08jHc2BP9Nw_fLptoQJ3',
  // Cloudflare Worker AI 代理（独立于 Supabase）；留空则不走代理
  aiSummaryUrl: '',
  // 智谱直连（国内访问快且稳）。填了 zhipuApiKey 时优先直连，不再经过代理。
  // 注意：本文件会内联进公开页面，key 可被他人看到，如被滥用可在智谱后台重置。
  zhipuApiKey: '6a349d45338c4ffcbb57c336f31db058.2aPi5LajGaZ8Wxis',
  zhipuModel: 'glm-4-flash'
};
