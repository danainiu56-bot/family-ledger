#!/usr/bin/env bash
# 本地开发：同步线上 → 打包 → 启动 family-ledger 专属 dev-server + 自动 rebuild
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-8765}"

echo "→ 从 GitHub 拉取线上最新…"
git pull origin main

echo "→ 打包（book/ 与 book.html 均与线上一致）…"
node scripts/build-bookkeeping-standalone.cjs

# 清掉 8765 上所有旧服务（含 Cursor 工作区），避免 book.html / book/ 读到过期代码
for pid in $(lsof -ti "TCP:${PORT}" -sTCP:LISTEN 2>/dev/null || true); do
  cwd="$(lsof -p "$pid" 2>/dev/null | awk '/cwd/ {print $NF}' | head -1 || true)"
  echo "→ 停止端口 ${PORT} 上的进程 (pid ${pid}${cwd:+, cwd ${cwd}})…"
  kill "$pid" 2>/dev/null || true
done
sleep 0.3

echo "→ 启动 family-ledger dev-server (端口 ${PORT})…"
python3 dev-server.py &
sleep 0.8

if ! pgrep -f "dev-watch.cjs" >/dev/null 2>&1; then
  echo "→ 启动文件监听（改源文件自动重新打包）…"
  node scripts/dev-watch.cjs &
fi

echo ""
echo "✓ 本地预览（与线上一致，两个链接进同一应用）："
echo "  http://127.0.0.1:${PORT}/book.html  → 自动跳转到 book/"
echo "  http://127.0.0.1:${PORT}/book/"
echo ""
echo "改 HTML/JS/CSS 后保存 → 自动打包 → 刷新浏览器"
echo "改完发布: git add -A && git commit && git push origin main"
