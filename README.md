# 月度记账本（family-ledger）

微信里用的家庭共享记账本 H5，独立于产品营销项目。

- 线上地址（GitHub Pages）：`https://danainiu56-bot.github.io/family-ledger/book/`
- **本地开发（推荐）**：在 `family-ledger` 目录执行 `./scripts/dev-local.sh`  
  - 先 `git pull` 对齐线上 → 改 `book.template.html` / `scripts/` / `styles/` → 保存后自动打包 → 刷新浏览器  
  - 预览地址（与线上一致）：`http://127.0.0.1:8765/book/`（`book.html` 会自动跳转到此处）

> 请在 **`~/Desktop/family-ledger`** 开发。8765 若被 Cursor 工作区占用，预览会是过期代码；`dev-local.sh` 会自动清理。

> 注意：GitHub 上这个仓库**必须命名为 `family-ledger`**，否则代码里的线上链接会 404。若要改名，需同步修改 `book.template.html`、`scripts/pages/bookkeeping.js` 里的仓库名。

发布、Supabase 建表与多人共享说明见 [发布与共享.md](./发布与共享.md)。

---

## 微信小程序版（miniprogram/）

与 H5 共用同一个 Supabase 项目和 `ledgers` 表，**家人数据互通**（同一账本编号 `bk_xxx`）。实时同步用前台轮询（约 15s）。

详细接入流程见 [miniprogram/接入指南.md](./miniprogram/接入指南.md)。快速步骤：

1. 注册微信小程序（个人主体即可，免费），拿到 **AppID**
2. 安装并打开微信开发者工具 → 导入项目，目录选 `miniprogram/`，填 AppID
3. 开发阶段在「详情 → 本地设置」勾选 **不校验合法域名** 即可调试
4. 真机/体验版前，在小程序后台「开发设置 → request 合法域名」添加 Supabase 域名（HTTPS）：
   `https://kjasiqqtihagwsnthbvc.supabase.co`
5. 「预览」真机测试 →「上传」设体验版 → 后台把家人加为「体验成员」即可使用

> `miniprogram/config.js` 为 Supabase 配置（已填好，与 H5 同源）。改库名或换 Supabase 项目时同步更新。
