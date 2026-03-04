#!/bin/bash
# OpenClaw Dashboard Nginx 配置脚本（仅配置 nginx，不启动应用）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="openclaw-dashboard"

echo "🌐 配置 Nginx 反向代理..."

# 复制配置文件
sudo -n cp "$SCRIPT_DIR/nginx.conf" /etc/nginx/sites-available/$APP_NAME

# 创建软链接
sudo -n ln -sf /etc/nginx/sites-available/$APP_NAME /etc/nginx/sites-enabled/$APP_NAME

# 测试配置
echo "🧪 测试 Nginx 配置..."
sudo -n nginx -t

# 重载 nginx
echo "🔄 重载 Nginx..."
sudo -n systemctl reload nginx

echo ""
echo "✅ Nginx 配置完成！"
echo "📍 Dashboard 访问地址: http://$(hostname -I | awk '{print $1}'):13456"
