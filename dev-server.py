#!/usr/bin/env python3
"""
本地静态服务器 + API 代理
- 静态文件：从当前目录提供（含 livereload 文件变更检查）
- API：/prod-api/* 转发到 https://ptm.iaioa.com.cn/prod-api/*
- 自动处理 CORS（覆盖原服务器重复 / 冲突的 CORS 头）
"""
import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import ssl
import sys
import os

PORT = 8765
TARGET = 'https://ptm.iaioa.com.cn'
ALLOW_ORIGIN = '*'

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # 减少日志噪音
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), format % args))

    # ---- CORS 预检 ----
    def do_OPTIONS(self):
        if self.path.startswith('/prod-api/'):
            self.send_response(200)
            self._send_cors()
            self.end_headers()
            return
        super().do_OPTIONS() if hasattr(super(), 'do_OPTIONS') else self.send_response(405)

    def _send_cors(self):
        self.send_header('Access-Control-Allow-Origin', ALLOW_ORIGIN)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Requested-With')
        self.send_header('Access-Control-Max-Age', '3600')

    # ---- 通用代理转发 ----
    def _proxy(self, method='GET', body=None):
        url = TARGET + self.path
        req = urllib.request.Request(url, data=body, method=method)
        # 转发关键头
        for h in ['Authorization', 'Cookie', 'Content-Type', 'Accept', 'Accept-Language']:
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)
        # 必要时模拟浏览器
        req.add_header('User-Agent', 'Mozilla/5.0 ProxyDev')
        ctx = ssl._create_unverified_context()
        try:
            with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
                data = r.read()
                self.send_response(r.status)
                self.send_header('Content-Type', r.headers.get('Content-Type', 'application/json'))
                self._send_cors()
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read() or b''
            self.send_response(e.code)
            self.send_header('Content-Type', e.headers.get('Content-Type', 'application/json'))
            self._send_cors()
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            err = (u'{"code":500,"msg":"proxy error: %s"}' % str(e)).encode('utf-8')
            self.send_response(502)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self._send_cors()
            self.send_header('Content-Length', str(len(err)))
            self.end_headers()
            self.wfile.write(err)

    def do_GET(self):
        if self.path.startswith('/prod-api/'):
            self._proxy('GET')
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/prod-api/'):
            length = int(self.headers.get('Content-Length', 0) or 0)
            body = self.rfile.read(length) if length > 0 else None
            self._proxy('POST', body)
            return
        self.send_response(405)
        self.end_headers()

    def end_headers(self):
        # 静态文件禁用缓存，方便 livereload
        if not self.path.startswith('/prod-api/'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """多线程 + 端口可重用。
    多线程很重要：避免 livereload 长轮询请求阻塞其它静态文件请求。"""
    allow_reuse_address = True
    daemon_threads = True   # 主进程退出时自动 kill 子线程


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'Static + Proxy server running at http://localhost:{PORT}')
    print(f'  Static : ./')
    print(f'  Proxy  : /prod-api/* → {TARGET}/prod-api/*')
    with ReusableTCPServer(('0.0.0.0', PORT), ProxyHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            httpd.server_close()
