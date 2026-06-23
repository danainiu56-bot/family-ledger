/**
 * 复制本文件为 bookkeeping-config.js 并填入 Supabase 配置。
 * 配置完成后多人可通过同一「账本编号」共享数据。
 *
 * Supabase 建表 SQL 见：产品文档/02-需求设计/记账本-发布与共享.md
 */
window.BOOKKEEPING_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  // AI 建议：二选一。填 zhipuApiKey 走智谱直连（国内快）；或填 aiSummaryUrl 走代理。
  aiSummaryUrl: '',
  zhipuApiKey: '',
  zhipuModel: 'glm-4-flash'
};
