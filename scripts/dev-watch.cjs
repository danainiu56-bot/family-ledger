#!/usr/bin/env node
/** 监听源文件变更，自动重新打包 book/index.html（与线上一致） */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const buildScript = path.join(__dirname, 'build-bookkeeping-standalone.cjs');
const watchFiles = [
  'book.template.html',
  'styles/pages/bookkeeping.css',
  'scripts/pages/bookkeeping.js',
  'scripts/pages/bookkeeping-config.js',
];

let timer = null;
function rebuild() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    process.stdout.write('\n→ 检测到变更，重新打包…\n');
    try {
      execFileSync(process.execPath, [buildScript], { cwd: root, stdio: 'inherit' });
      process.stdout.write('✓ 已更新 book/ 与 book.html，请刷新浏览器\n');
    } catch (e) {
      process.stderr.write('✗ 打包失败\n');
    }
  }, 200);
}

execFileSync(process.execPath, [buildScript], { cwd: root, stdio: 'inherit' });
console.log('监听中（改完保存后刷新 http://127.0.0.1:8765/book/ 即可）：');
watchFiles.forEach((rel) => {
  const abs = path.join(root, rel);
  fs.watch(abs, rebuild);
  console.log('  ·', rel);
});
