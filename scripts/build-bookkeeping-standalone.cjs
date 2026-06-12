#!/usr/bin/env node
/**
 * 打包单文件记账本（CSS/JS 内联），用于 GitHub Pages 与 jsDelivr 轻量分支。
 * 源模板：book.template.html → 输出 book/index.html（与线上一致）+ book.html（跳转到 book/）
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist');
const outFile = path.join(outDir, 'book-standalone.html');
const bookIndex = path.join(root, 'book', 'index.html');
const bookRedirect = path.join(root, 'book.html');
const templateFile = path.join(root, 'book.template.html');

const css = fs.readFileSync(path.join(root, 'styles/pages/bookkeeping.css'), 'utf8');
const configJs = fs.readFileSync(path.join(root, 'scripts/pages/bookkeeping-config.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'scripts/pages/bookkeeping.js'), 'utf8');
const html = fs.readFileSync(templateFile, 'utf8');

const bodyMatch = html.match(/<body>([\s\S]*)<script src="scripts\/pages\/bookkeeping-config\.js"><\/script>/);
if (!bodyMatch) {
  console.error('Failed to parse book.template.html body');
  process.exit(1);
}

const standalone = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#6366f1">
  <meta name="format-detection" content="telephone=no,email=no,address=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="x5-orientation" content="portrait">
  <meta name="x5-fullscreen" content="true">
  <meta name="x5-page-mode" content="app">
  <title>月度记账本</title>
  <style>
${css}
  </style>
</head>
<body>
${bodyMatch[1].trim()}
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/dist/umd/supabase.min.js"></script>
  <script>
${configJs}
  </script>
  <script>
${appJs}
  </script>
</body>
</html>
`;

const redirectHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0;url=book/">
  <script>location.replace('book/' + location.search + location.hash);</script>
  <title>跳转中…</title>
</head>
<body>
  <p>正在跳转… <a href="book/">点此进入记账本</a></p>
</body>
</html>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.dirname(bookIndex), { recursive: true });
fs.writeFileSync(outFile, standalone, 'utf8');
fs.writeFileSync(bookIndex, standalone, 'utf8');
fs.writeFileSync(bookRedirect, redirectHtml, 'utf8');
console.log('Built', outFile, '(' + Math.round(fs.statSync(outFile).size / 1024) + ' KB)');
console.log('Built', bookIndex);
console.log('Built', bookRedirect, '(redirect → book/)');
