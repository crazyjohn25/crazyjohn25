"""Local server for the market desk. Run: python3 marketdesk/server.py"""

from __future__ import annotations

import json
import socket
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from engine.service import asset_view, board
from engine.universe import BY_ID

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PORT = 8765


class DualStackServer(ThreadingHTTPServer):
    """One socket for ::1 and 127.0.0.1. IPv4-only left localhost on ::1 refused."""

    address_family = socket.AF_INET6
    allow_reuse_address = True
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()
        host, port, *_rest = self.server_address
        self.server_address = (host, port)


class Handler(BaseHTTPRequestHandler):
    server_version = "MarketDesk/1.0"

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/board":
            self._json(lambda: board())
            return
        if parsed.path == "/api/asset":
            query = parse_qs(parsed.query)
            asset_id = (query.get("id") or [""])[0]
            horizon = (query.get("horizon") or ["swing"])[0]
            if asset_id not in BY_ID or horizon not in {"swing", "intraday"}:
                self._send(400, {"error": "未知标的或周期"})
                return
            self._json(lambda: asset_view(asset_id, horizon))
            return
        if parsed.path == "/api/health":
            self._send(200, {"ok": True})
            return
        if parsed.path in {"/", "/index.html"}:
            self._file(STATIC / "index.html", "text/html; charset=utf-8")
            return
        if parsed.path.startswith("/static/"):
            name = parsed.path.removeprefix("/static/")
            if not name or "/" in name or "\\" in name:
                self._send(404, {"error": "没有这个文件"})
                return
            path = (STATIC / name).resolve()
            if path.parent != STATIC.resolve() or not path.is_file():
                self._send(404, {"error": "没有这个文件"})
                return
            kind = {
                ".html": "text/html; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8",
            }.get(path.suffix, "application/octet-stream")
            self._file(path, kind)
            return
        self._send(404, {"error": "没有这个路径"})

    def _json(self, loader):
        try:
            payload = loader()
        except Exception:
            traceback.print_exc()
            self._send(502, {"error": "上游数据或计算暂时失败"})
            return
        self._send(200, payload)

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, content_type: str):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args):
        print(f"[desk] {self.address_string()} {fmt % args}")


def main():
    try:
        server = DualStackServer(("::", PORT), Handler)
    except OSError as exc:
        print(f"IPv6 双栈不可用（{exc}），只监听 IPv4")
        server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
        server.allow_reuse_address = True
    print(f"核对台 http://127.0.0.1:{PORT}  http://[::1]:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
