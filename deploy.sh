#!/bin/bash
# OpenClaw Dashboard 一键部署脚本
# 使用 pm2 管理进程 + nginx 反向代理
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="openclaw-dashboard"
APP_PORT=3456
NGINX_PORT=13456

echo "🚀 部署 OpenClaw Dashboard..."
echo "📂 项目目录: $SCRIPT_DIR"
echo ""

cd "$SCRIPT_DIR"

# 1. 检查 pm2
if ! command -v pm2 &> /dev/null; then
    echo "📦 安装 pm2..."
    npm install -g pm2
fi

# 2. 启动 / 重启 dashboard
if pm2 list | grep -q "$APP_NAME"; then
    echo "🔄 重启 $APP_NAME..."
    pm2 restart "$APP_NAME"
else
    echo "▶️  启动 $APP_NAME..."
    pm2 start src/server.js --name "$APP_NAME"
fi

# 3. 等待服务就绪
echo "⏳ 等待服务就绪..."
for i in $(seq 1 10); do
    if curl -s "http://localhost:$APP_PORT/api/overview" > /dev/null 2>&1; then
        echo "✅ 服务已就绪"
        break
    fi
    sleep 1
done

# 4. 保存 pm2 进程列表
pm2 save

# 5. 配置 pm2 开机自启（首次）
if ! systemctl is-enabled pm2-openclaw &> /dev/null 2>&1; then
    echo "🔧 配置 pm2 开机自启..."
    sudo -n env PATH=$PATH:/usr/bin pm2 startup systemd -u openclaw --hp /home/openclaw
    pm2 save
fi

# 6. 配置 nginx
echo "🌐 配置 Nginx (端口 $NGINX_PORT → $APP_PORT)..."
sudo -n cp "$SCRIPT_DIR/nginx.conf" /etc/nginx/sites-available/$APP_NAME
sudo -n ln -sf /etc/nginx/sites-available/$APP_NAME /etc/nginx/sites-enabled/$APP_NAME

echo "🧪 测试 Nginx 配置..."
sudo -n nginx -t

echo "🔄 重载 Nginx..."
sudo -n systemctl reload nginx

echo ""
echo "✅ 部署完成！"
echo "📍 访问地址: http://$(hostname -I | awk '{print $1}'):$NGINX_PORT"
echo ""
echo "常用命令:"
echo "  pm2 status              查看进程状态"
echo "  pm2 logs $APP_NAME      查看日志"
echo "  pm2 restart $APP_NAME   重启服务"
