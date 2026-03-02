#!/bin/bash
# OpenClaw Dashboard 启动脚本
cd "$(dirname "$0")"
PORT=${PORT:-3456}

echo "🤖 启动 OpenClaw Dashboard..."
echo "📍 访问地址: http://localhost:$PORT"
echo "🔒 只读模式 — 不会修改任何 OpenClaw 数据"
echo ""
echo "按 Ctrl+C 停止服务"
echo ""

PORT=$PORT node src/server.js
