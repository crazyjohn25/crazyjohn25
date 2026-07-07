#!/usr/bin/env bash
# 一键启动本地预览（Mac / Linux）
set -e
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo ">>> 启动中，请在浏览器打开: http://localhost:${PORT}"
echo ">>> 按 Ctrl+C 停止"
python3 -m http.server "$PORT"
