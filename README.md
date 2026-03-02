# 🤖 OpenClaw Agent Dashboard

> AI Agent 监控与调度看板 · 一眼掌握所有 Agent 状态、Token 消耗与任务生命周期

---

## 🚀 快速启动

```bash
git clone https://github.com/your-username/openclaw-dashboard.git
cd openclaw-dashboard
npm install
./start.sh
```

服务默认跑在 **http://localhost:3456**

如果在远程服务器上，用 SSH 隧道访问：
```bash
ssh -L 3456:localhost:3456 user@your-server-ip
# 然后本地浏览器打开 http://localhost:3456
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3456` | 监听端口 |
| `OPENCLAW_DIR` | `~/.openclaw` | OpenClaw 数据目录 |

---

## 📋 功能一览

### 🏠 总览页（Overview）
- 系统版本、Agent 数量、活跃 Subagent 数
- 每 30 秒自动刷新，全局防闪烁差量更新

### 🧑‍💼 Agents 页
- 展示所有 Agent（从 `openclaw.json` 动态读取，无硬编码）
- 每个 Agent 的身份（名字、emoji）、会话数、活跃频道
- 多 Tab 详情：会话列表 / 对话历史 / 记忆大脑 / 子任务 Runs

### 📋 任务大厅（Task Center）
- 三列看板泳道：⏳ 排队中 / 🔥 正在进行 / ✅ 已完成
- 实时搜索 + 状态/Agent 筛选，含 Cron Jobs 区块

### 🧮 数据统计（Analytics）
- Token 聚合统计（每日趋势图 / 各 Agent 柱状图 / 各模型饼图）
- 系统资源：CPU / 内存 / 负载 / 磁盘

### ⏱️ 工时统计（KPI）
- 「相邻累加 + 3 分钟闲置阈值」算法，过滤挂机时间
- 全量归档解析（含 `*.jsonl.reset.*` 变体文件）

### 🛡️ 异常雷达
- 网关日志 WARN/ERROR/FATAL 告警 + Cron Job 健康度

### 🛠️ 运维工具箱
- 关键文件速览（只读·自动脱敏）
- 网关日志 + 命令日志快照

---

## 🔒 安全说明

- **纯只读**：所有 API 只读取文件，不修改任何 OpenClaw 数据
- **数据脱敏**：`apiKey` / `token` / `secret` 等敏感字段自动脱敏
- **本地访问**：建议通过 SSH 隧道访问，不要直接暴露公网

---

## 📂 项目结构

```
openclaw-dashboard/
├── src/
│   └── server.js        # Express 后端，读取 OPENCLAW_DIR 数据
├── public/
│   ├── index.html       # 单页应用入口
│   ├── css/style.css    # 暗色主题 UI
│   └── js/app.js        # 前端逻辑
├── start.sh             # 一键启动脚本
├── package.json
└── README.md
```

---

## 🔧 API 端点

| 端点 | 说明 |
|------|------|
| `GET /api/overview` | 系统概览 |
| `GET /api/agents` | 所有 Agent 列表 |
| `GET /api/agents/:id/sessions` | Agent 会话列表 |
| `GET /api/agents/:id/sessions/:sid` | 会话对话历史 |
| `GET /api/subagents` | Subagent 运行记录 |
| `GET /api/tasks/enriched` | 任务列表（含启发式 Run 关联） |
| `GET /api/analytics/tokens` | Token 聚合统计 |
| `GET /api/analytics/system` | 系统资源 |
| `GET /api/analytics/disk` | 磁盘监控 |
| `GET /api/analytics/kpi` | 工时统计 |
| `GET /api/errors/gateway` | 网关告警 |
| `GET /api/errors/cron` | 定时任务健康度 |
| `GET /api/cron` | Cron Jobs |
| `GET /api/toolbox/files` | 关键文件速览（脱敏） |
| `GET /api/toolbox/gateway-logs` | 网关日志快照 |
| `GET /api/toolbox/commands-log` | 命令日志快照 |

---

## 📅 版本历史

| 版本 | 主要内容 |
|------|----------|
| v1.1 | 项目初始化，Agent 会话与对话历史查看 |
| v1.2 | Token 消耗统计 + 系统资源监控 |
| v1.3 | 异常雷达：网关告警 + Cron 健康度 |
| v1.4 | 记忆图谱与技能树 |
| v1.5 | 任务看板 + 全局防闪烁差量更新 |
| v1.6 | 工时统计初版 |
| v1.7 | 每日 Token 趋势图 + delivery-mirror 屏蔽 |
| v1.8 | Cron Jobs 合并至任务大厅 |
| v1.9 | 体验优化迭代 |
| v1.10 | 磁盘监控 + 任务搜索/筛选/弹层 + Ops Toolbox |
| v1.11 | 架构降噪：合并重复页面，工时统计重命名 |
| v1.12 | Token 升主视角，系统监控极简横幅 |
| v1.13 | 记忆大脑 Tab 二合一，工时精度修复 |
| v1.14 | Token 统计口径统一 |
| v1.15 | 去除 hardcode：Agent 配置从 openclaw.json 动态读取 |

---

## 🛠️ 技术栈

- **后端**：Node.js · Express
- **前端**：原生 HTML/CSS/JS · Chart.js 4.4
- **核心设计**：
  - 防闪烁：`safeSetHTML()` 差量更新
  - 只读原则：所有 API 严格只读
  - 通用性：Agent 配置动态读取，无硬编码
