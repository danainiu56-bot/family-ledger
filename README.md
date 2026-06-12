# 月度记账本（family-ledger）

微信里用的家庭共享记账本 H5，独立于产品营销项目。

- 线上地址（GitHub Pages）：`https://danainiu56-bot.github.io/family-ledger/book/`
- **本地开发（推荐）**：在 `family-ledger` 目录执行 `./scripts/dev-local.sh`  
  - 先 `git pull` 对齐线上 → 改 `book.template.html` / `scripts/` / `styles/` → 保存后自动打包 → 刷新浏览器  
  - 预览地址（与线上一致）：`http://127.0.0.1:8765/book/`（`book.html` 会自动跳转到此处）

> 请在 **`~/Desktop/family-ledger`** 开发。8765 若被 Cursor 工作区占用，预览会是过期代码；`dev-local.sh` 会自动清理。

> 注意：GitHub 上这个仓库**必须命名为 `family-ledger`**，否则代码里的线上链接会 404。若要改名，需同步修改 `book.template.html`、`scripts/pages/bookkeeping.js` 里的仓库名。

发布、Supabase 建表与多人共享说明见 [发布与共享.md](./发布与共享.md)。
