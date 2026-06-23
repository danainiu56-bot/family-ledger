/**
 * Supabase 配置 — 与现有 H5（book/）共用同一项目和 ledgers 表，家人数据互通。
 * 真机/体验版需把 supabaseUrl 域名加入小程序后台 request 合法域名。
 */
module.exports = {
  supabaseUrl: 'https://kjasiqqtihagwsnthbvc.supabase.co',
  supabaseAnonKey: 'sb_publishable_Cft7P8JHV2P08jHc2BP9Nw_fLptoQJ3',
  // Cloudflare Worker AI 代理（独立于 Supabase）；留空则不走代理
  aiSummaryUrl: '',
  // 智谱直连（国内访问快且稳）。填了 zhipuApiKey 时优先直连。
  // 真机/体验版需把 open.bigmodel.cn 加入小程序后台 request 合法域名。
  zhipuApiKey: '6a349d45338c4ffcbb57c336f31db058.2aPi5LajGaZ8Wxis',
  zhipuModel: 'glm-4-flash'
};
