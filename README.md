# 🤖 OpenClaw Agent Dashboard

> 全能 AI 监控与调度看板 · 一眼掌握所有 Agent 状态、工时算力与任务生命周期

**当前版本：v1.13**（含 Token 统计口径 Hotfix）

---

## 🚀 快速启动

```bash
cd /root/.openclaw/workspace/projects/openclaw-dashboard
./start.sh
```

服务默认跑在 **http://localhost:3456**

如果你在远程服务器上，用 SSH 隧道访问：
```bash
# 在本地机器执行
ssh -L 3456:localhost:3456 root@你的服务器IP
# 然后本地浏览器打开 http://localhost:3456
```

---

## 📋 功能一览

### 🏠 总览页（Overview）
- 系统版本、Agent 数量、活跃 Subagent 数
- 最近 Subagent 运行快照
- 每 30 秒自动刷新，全局防闪烁差量更新

### 🧑‍💼 Agents 页（含子任务 Runs 合并）
- 展示所有 Agent（main / code / flash / player / writer）
- 每个 Agent 的身份（名字、emoji）、会话数、活跃频道
- 点进去查看 Agent 详情多 Tab 视图：
  - **会话列表**：每条会话的 Token 消耗、消息数、时间、状态（活跃/已重置/已删除）
  - **对话历史**：完整 User ↔ Assistant 对话气泡、token 用量、时间戳
  - **🧠 记忆大脑**（二合一 Tab）：
    - MEMORY.md 长期记忆 + memory/ 目录所有日常记忆文件（点击展开内容）
    - 工具调用热度排行榜（兵器谱）
  - **⚡ 子任务 Runs**：按 Agent 过滤展示所属 Subagent 任务记录，卡片支持展开/折叠查看完整内容

### 📋 任务大厅（Task Center）
- 三列看板泳道：⏳ 排队中 / 🔥 正在进行 / ✅ 已完成
- 任务卡片展示：标题、负责人（agent）、描述、创建时间、完成时间
- 实时搜索框：过滤 title / description / id / agent
- 状态 Chip 筛选 + Agent 下拉筛选
- 点击卡片弹出详情层，含关联 Run 信息（runId、sessionKey 可一键复制）
- 启发式匹配：自动关联任务与 Subagent Run（关键词重叠 + 时间接近算法）
- **自动化 Cron Jobs 区块**（任务大厅下半部分，已合并）：
  - 展示所有定时任务卡片（正常/错误/禁用状态）
  - 带数量角标提示

### 🧮 数据统计（Analytics）
- **Token 聚合主视角（Hero Section）**：
  - 4 张摘要大卡：总 Token / 输入 / 输出 / 消息轮次
  - 每日 Token 消耗趋势折线图
  - 各 Agent Token 消耗柱状图（输入/输出分色）
  - 各模型 Token 分布饼图（甜甜圈）
  - 屏蔽虚拟模型 delivery-mirror，统计口径统一
- **系统状态横幅 Banner**（极简一行）：
  - CPU / 内存 / 负载 / 运行时长 / 磁盘摘要
  - 颜色语义：绿色正常 / 黄色告警 / 红色危险
- **💾 磁盘监控卡片**：
  - 挂载点使用率进度条（>85% 黄色，>95% 红色）
  - .openclaw 关键目录 Top 占用排行
  - 结果缓存 60 秒，避免 I/O 压力

### ⏱️ 工时统计（KPI）
- **全量归档解析**：涵盖所有 *.jsonl 及 *.jsonl.reset.* 变体文件，工时数据精准不缩水
- 每个 Agent 的工时进度条：长时任务工时 vs 碎片工具工时分拆显示
- 接单数 / 完成数 / 完成率 / 工具调用次数四格统计
- 内卷指数渐变大字展示
- 主力工具 Tag（耗时 Top 3）
- 效率标签：🔥卷王本卷 / ⚡超级内卷 / 💪努力打工 / 😴摸鱼达人 / 🐌在线摆烂 / 🌱新手上路
- 前三名 🥇🥈🥉 高亮排行榜

### 🛡️ 异常雷达
- 扫描 /tmp/openclaw/*.log 中 WARN / ERROR / FATAL 级别的网关告警
- ERROR 红色 / WARN 橙色高亮，支持前端复选框过滤
- 定时任务健康度：展示连续失败的 Cron 任务，无异常时显示"全部健康"

### 🛠️ 运维工具箱（Ops Toolbox）
- **模块 A - 关键文件速览**（只读·自动脱敏）：
  - 支持 openclaw.json / cron/jobs.json / tasks.json
  - 敏感字段（apiKey / token / secret 等）自动脱敏
  - JSON 语法高亮（key / string / number / bool / null 分色）
- **模块 B - 日志快照**（只读）：
  - 网关日志（结构化 JSON，按 level 显色）
  - 命令日志（~/.openclaw/logs/commands.log）
  - 可选 100 / 200 / 500 行，一键刷新
- **模块 C - 快捷排障命令**（12 条）：
  - 网关状态 / 重启 / 停止 / 实时日志
  - 磁盘分析 / 进程检查 / 网络连通性检测
  - 点击即复制命令，✅ 复制成功反馈

---

## 🔒 安全说明

- **纯只读**：只读取文件，不写入、不修改任何 OpenClaw 数据
- **本机绑定**：服务绑定 0.0.0.0:3456，建议通过 SSH 隧道访问
- **数据脱敏**：API key / token 等敏感字段不会暴露

---

## 📂 项目结构

```
openclaw-dashboard/
├── src/
│   └── server.js        # Express 后端，读取 ~/.openclaw 数据
├── public/
│   ├── index.html       # 单页应用入口
│   ├── css/style.css    # 暗色主题 UI（含 v1.12 新增约 200 行样式）
│   └── js/app.js        # 前端逻辑（差量防闪烁、弹层、折叠动画）
├── start.sh             # 一键启动脚本
├── package.json
└── README.md
```

---

## 🔧 API 端点（参考）

| 端点 | 说明 |
|------|------|
| GET /api/overview | 系统概览 |
| GET /api/agents | 所有 Agent 列表 |
| GET /api/agents/:id/sessions | Agent 会话列表（含 tokenTotal） |
| GET /api/agents/:id/sessions/:sid | 会话对话历史 |
| GET /api/subagents | Subagent 运行记录（可按 Agent 过滤） |
| GET /api/tasks | 任务列表（基础） |
| GET /api/tasks/enriched | 任务列表（含启发式 Run 关联） |
| GET /api/analytics/tokens | Token 聚合统计（含 dailyTrend） |
| GET /api/analytics/system | 系统资源（CPU / 内存 / 运行时长） |
| GET /api/analytics/disk | 磁盘监控（挂载点 + 目录占用） |
| GET /api/analytics/kpi | 工时统计（全量归档解析） |
| GET /api/errors/gateway | 网关 WARN/ERROR/FATAL 告警 |
| GET /api/errors/cron | 定时任务健康度 |
| GET /api/knowledge/skills | 工具调用热度（支持 ?agentId= 过滤） |
| GET /api/cron | Cron Jobs |
| GET /api/toolbox/files | 关键文件速览（脱敏） |
| GET /api/toolbox/gateway-logs | 网关日志快照 |
| GET /api/toolbox/commands-log | 命令日志快照 |

---

## 📅 版本历史

| 版本 | 主要内容 |
|------|----------|
| v1.1 | 项目初始化，Agent 会话与对话历史查看 |
| v1.2 | 数据统计面板：Token 消耗 + 系统资源监控 |
| v1.3 | 异常雷达：网关告警 + 定时任务健康度 |
| v1.4 | 记忆图谱与技能树（初版） |
| v1.5 | 任务作战大厅（三列看板）+ 全局防闪烁差量更新 |
| v1.6 | Agent 绩效考核面板（工时统计初版） |
| v1.7 | 每日 Token 趋势图 + 屏蔽 delivery-mirror + Session 卡片展示 Token |
| v1.8 | 任务大厅统一化：Cron Jobs 合并至任务大厅，移除独立菜单 |
| v1.9 | PM 走查迭代打磨（小O产品视角体验优化） |
| v1.10 | 磁盘监控 + 任务大厅搜索/筛选/弹层 + Ops Toolbox 运维工具台 |
| v1.11 | 架构降噪：Agent/Subagent 合并；绩效→工时统计重命名；日志去重；工具箱汉化 |
| v1.12 | 核心要素重排：Token 升主视角；系统监控极简横幅；记忆图谱下放至 Agent 详情 |
| v1.13 | 架构收敛：记忆大脑 Tab 二合一；侧边栏分类合并；工时统计精度修复（全量归档解析） |
| Hotfix | 统一各页面 Token 统计口径（归档日志读取规则与 delivery-mirror 屏蔽策略一致性） |

---

## 🛠️ 开发信息

- **开发时间**：2026-02-28（一夜极速完成，持续迭代至 v1.13 🚀）
- **技术栈**：Node.js · Express · 原生 HTML/CSS/JS · Chart.js 4.4
- **核心设计理念**：
  - 防闪烁：safeSetHTML() 差量更新，数据未变不触发 DOM 重绘
  - 只读原则：所有 API 严格只读，绝不修改 OpenClaw 核心状态
  - 架构收敛：持续合并重复页面，保持侧边栏简洁直观

---

*由 小C（OpenClaw Agent）开发维护*
