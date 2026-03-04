/**
 * OpenClaw Agent Dashboard
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3456;
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');

// ── Agent config helpers ──────────────────────────────────────────────────
// Reads openclaw.json to build agentId -> { workspace, identity, model } map.
// Avoids hardcoding agent names or workspace paths anywhere else.

let _agentConfigCache = null;
let _tokenCache = null;
let _tokenCacheAt = 0;
let _agentConfigCacheAt = 0;
const AGENT_CONFIG_TTL = 30000;
const GATEWAY_LOG_DIR = process.env.GATEWAY_LOG_DIR || '/tmp/openclaw';

// ── Model Monitor ────────────────────────────────────────────────────────
// 读取 openclaw.json 获取模型配置，检测各模型可用性

let _modelStatusCache = null;
let _modelStatusCacheAt = 0;
let _modelCheckTimer = null;

// 读取模型配置
function getModelConfigs() {
  const config = readJsonFile(path.join(OPENCLAW_DIR, 'openclaw.json')) || {};
  const agents = config.agents?.list || [];
  const models = config.models?.providers || {};
  
  const agentModels = [];
  for (const agent of agents) {
    const modelId = agent.model;
    if (!modelId) continue;
    
    const [providerName, modelName] = modelId.split('/');
    const provider = models[providerName];
    
    if (!provider) continue;
    
    const modelConfig = (provider.models || []).find(m => m.id === modelId) || {};
    const apiType = modelConfig.api || provider.api || 'chat/completions';
    
    agentModels.push({
      agentId: agent.id,
      agentName: agent.name,
      modelId: modelId,
      modelName: modelConfig.name || modelName,
      provider: providerName,
      baseUrl: provider.baseUrl,
      apiType: apiType
    });
  }
  return agentModels;
}

// 检测单个模型可用性
async function checkModelStatus(modelConfig) {
  const { baseUrl, apiType, modelId, provider } = modelConfig;
  if (!baseUrl) return { available: false, error: 'No baseUrl (external)' };

  // 从环境变量读取 API Key，格式：{PROVIDER_NAME}_API_KEY
  const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`] || '';

  try {
    const url = `${baseUrl}/${apiType || 'chat/completions'}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (response.ok) {
      return { available: true, status: response.status };
    } else {
      const body = await response.text().catch(() => '');
      return { available: false, error: `HTTP ${response.status}`, detail: body.slice(0, 200) };
    }
  } catch (err) {
    return { available: false, error: err.name === 'AbortError' ? 'Timeout' : err.message };
  }
}

// 定时巡检逻辑
function getNextCheckInterval() {
  const now = new Date();
  const hour = now.getHours();
  return (hour >= 9 && hour < 24) ? 300000 : 3600000;
}

// 执行模型状态检查
async function checkAllModels() {
  const models = getModelConfigs();
  const results = [];
  
  for (const model of models) {
    const status = await checkModelStatus(model);
    results.push({
      ...model,
      available: status.available,
      error: status.error,
      lastCheck: new Date().toISOString()
    });
  }
  
  _modelStatusCache = results;
  _modelStatusCacheAt = Date.now();
  broadcastSSE('modelStatus', results);
  
  return results;
}

// 启动定时巡检
function startModelMonitor() {
  const runCheck = async () => {
    await checkAllModels();
    const interval = getNextCheckInterval();
    _modelCheckTimer = setTimeout(runCheck, interval);
  };
  runCheck();
}

// ── Agent config helpers ──────────────────────────────────────────────────

function getAgentConfigs() {
  const now = Date.now();
  if (_agentConfigCache && now - _agentConfigCacheAt < AGENT_CONFIG_TTL) return _agentConfigCache;
  const config = readJsonFile(path.join(OPENCLAW_DIR, 'openclaw.json')) || {};
  const defaultWorkspace = (config.agents && config.agents.defaults && config.agents.defaults.workspace)
    || path.join(OPENCLAW_DIR, 'workspace');
  const list = (config.agents && config.agents.list) || [];
  const map = {};
  for (const a of list) {
    if (!a.id) continue;
    map[a.id] = { workspace: a.workspace || defaultWorkspace, identity: a.identity || null, model: a.model || null };
  }
  _agentConfigCache = map;
  _agentConfigCacheAt = now;
  return map;
}

function getAgentWorkspace(agentId) {
  const configs = getAgentConfigs();
  if (configs[agentId] && configs[agentId].workspace) return configs[agentId].workspace;
  return path.join(OPENCLAW_DIR, 'workspace-' + agentId);
}

function getDefaultTasksFile() {
  const config = readJsonFile(path.join(OPENCLAW_DIR, 'openclaw.json')) || {};
  const defaultWorkspace = (config.agents && config.agents.defaults && config.agents.defaults.workspace)
    || path.join(OPENCLAW_DIR, 'workspace');
  return path.join(defaultWorkspace, 'tasks.json');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── SSE clients registry ──────────────────────────────────────────────────
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
}

app.get('/api/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('event: ping\ndata: {}\n\n');
  sseClients.add(res);
  const _sseCleanup = () => sseClients.delete(res);
  req.on('close', _sseCleanup);
  res.on('finish', _sseCleanup);
  res.on('error', _sseCleanup);
});

setInterval(() => {
  try {
    const overview = buildOverview();
    broadcastSSE('overview', overview);
    if (overview.alerts && overview.alerts.length > 0) {
      broadcastSSE('alerts', overview.alerts);
    }
  } catch {}
}, 5000);

// ── Helpers ──────────────────────────────────────────────────────────────

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function readJsonLines(filePath, limit) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-(limit || 200)).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function getStat(p) { try { return fs.statSync(p); } catch { return null; } }

/**
 * v1.13 修复：列出 sessions 目录下所有 jsonl 文件（含 .reset.xxx 归档文件）
 * 保证工时/Token 统计不因系统归档而"缩水"。
 */
function listAllJsonlFiles(sessionsDir) {
  try {
    return fs.readdirSync(sessionsDir).filter(f => {
      return /\.jsonl/.test(f) && !f.includes('.deleted');
    });
  } catch { return []; }
}

// ── Token/Usage aggregation (shared core, single source of truth) ─────────
//
// aggregateAllAgentTokens(): 公共聚合函数，供 Overview 和 Analytics 两个页面共用。
// 统计规则：
//   1. 全量扫描 *.jsonl 及 *.jsonl.reset.* 归档文件（不遗漏）
//   2. 屏蔽 delivery-mirror 虚拟模型
//   3. 只统计 role=assistant 的消息（避免重复计入）
//   4. 使用 totalTokens（含 cacheRead/cacheWrite），与 Analytics 页保持一致
//   5. 每文件最多读取 5000 条记录（与 buildAnalyticsTokens 一致）

function aggregateAllAgentTokens() {
  const now = Date.now();
  if (_tokenCache && now - _tokenCacheAt < 30000) return _tokenCache;
  const agentsDir = path.join(OPENCLAW_DIR, 'agents');
  let agentNames = [];
  try { agentNames = fs.readdirSync(agentsDir).filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory()); } catch {}

  const perAgent = {};
  let totalTokens = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalMessages = 0;

  for (const name of agentNames) {
    const sessionsDir = path.join(agentsDir, name, 'sessions');
    const files = listAllJsonlFiles(sessionsDir);

    let agentTokens = 0, agentInput = 0, agentOutput = 0, agentCacheRead = 0, agentMsgs = 0;
    for (const filename of files) {
      const fp = path.join(sessionsDir, filename);
      const records = readJsonLines(fp, 5000);
      for (const r of records) {
        if (r.type !== 'message') continue;
        const msg = r.message || {};
        if (msg.role !== 'assistant') continue;
        const msgModel = msg.model || '';
        if (msgModel === 'delivery-mirror') continue;
        const usage = msg.usage;
        if (!usage) continue;

        const out = usage.output || 0;
        const cacheRead = usage.cacheRead || 0;
        const cacheWrite = usage.cacheWrite || 0;
        const rawInp = usage.input || 0;
        const tokens = usage.totalTokens || rawInp + out;
        // 部分 provider input 不含 cacheRead，统一补齐
        const inp = (rawInp + out + cacheRead + cacheWrite === tokens) ? rawInp + cacheRead : rawInp;

        agentTokens += tokens;
        agentInput += inp;
        agentOutput += out;
        agentCacheRead += cacheRead;
        agentMsgs++;
      }
    }

    perAgent[name] = { totalTokens: agentTokens, input: agentInput, output: agentOutput, cacheRead: agentCacheRead, messages: agentMsgs };
    totalTokens += agentTokens;
    totalInput += agentInput;
    totalOutput += agentOutput;
    totalCacheRead += agentCacheRead;
    totalMessages += agentMsgs;
  }

  return { perAgent, totalTokens, totalInput, totalOutput, totalCacheRead, totalMessages };
}

// aggregateTokenUsage(): Overview 页使用的包装函数，调用公共聚合函数
function aggregateTokenUsage() {
  return aggregateAllAgentTokens();
}

// ── v1.2 Analytics: 详细 Token 统计（按模型、按 Agent）──────────────────

function buildAnalyticsTokens() {
  const agentsDir = path.join(OPENCLAW_DIR, 'agents');
  let agentNames = [];
  try { agentNames = fs.readdirSync(agentsDir).filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory()); } catch {}

  const perAgent = {};
  const perModel = {};
  const perDate = {}; // { 'YYYY-MM-DD': { total, input, output } }

  let grandTotal = 0, grandInput = 0, grandOutput = 0, grandCacheRead = 0, grandMessages = 0;

  for (const name of agentNames) {
    const sessionsDir = path.join(agentsDir, name, 'sessions');
    let files = [];
    files = listAllJsonlFiles(sessionsDir);

    const agentData = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, messages: 0, models: {} };

    for (const filename of files) {
      const fp = path.join(sessionsDir, filename);
      const records = readJsonLines(fp, 5000);
      for (const r of records) {
        if (r.type !== 'message') continue; const msgModel = r.message && r.message.model || ''; if (msgModel === 'delivery-mirror') continue;
        const msg = r.message || {};
        const usage = msg.usage;
        if (!usage || msg.role !== 'assistant') continue;

        // 屏蔽 delivery-mirror 虚拟模型
        const model = msg.model || 'unknown';
        if (model === 'delivery-mirror') continue;

        const out = usage.output || 0;
        const cacheRead = usage.cacheRead || 0;
        const cacheWrite = usage.cacheWrite || 0;
        const rawInp = usage.input || 0;
        const tokens = usage.totalTokens || rawInp + out;
        // 部分 provider input 不含 cacheRead，统一补齐
        const inp = (rawInp + out + cacheRead + cacheWrite === tokens) ? rawInp + cacheRead : rawInp;

        agentData.totalTokens += tokens;
        agentData.input += inp;
        agentData.output += out;
        agentData.cacheRead += cacheRead;
        agentData.messages += 1;

        if (!agentData.models[model]) agentData.models[model] = { totalTokens: 0, input: 0, output: 0, messages: 0 };
        agentData.models[model].totalTokens += tokens;
        agentData.models[model].input += inp;
        agentData.models[model].output += out;
        agentData.models[model].messages += 1;

        if (!perModel[model]) perModel[model] = { totalTokens: 0, input: 0, output: 0, messages: 0 };
        perModel[model].totalTokens += tokens;
        perModel[model].input += inp;
        perModel[model].output += out;
        perModel[model].messages += 1;

        grandTotal += tokens;
        grandInput += inp;
        grandOutput += out;
        grandCacheRead += cacheRead;
        grandMessages += 1;

        // 按日期聚合趋势
        const ts = r.timestamp;
        if (ts) {
          const dateStr = new Date(typeof ts === 'number' ? ts : ts).toISOString().slice(0, 10);
          if (!perDate[dateStr]) perDate[dateStr] = { total: 0, input: 0, output: 0 };
          perDate[dateStr].total += tokens;
          perDate[dateStr].input += inp;
          perDate[dateStr].output += out;
        }
      }
    }

    perAgent[name] = agentData;
  }

  // 生成有序日期趋势数组
  const dailyTrend = Object.keys(perDate).sort().map(date => ({
    date,
    total: perDate[date].total,
    input: perDate[date].input,
    output: perDate[date].output,
  }));

  return {
    grandTotal,
    grandInput,
    grandOutput,
    grandCacheRead,
    grandMessages,
    perAgent,
    perModel,
    dailyTrend,
    generatedAt: Date.now(),
  };
}

// ── v1.2 Analytics: 系统资源（CPU + 内存）──────────────────────────────

async function getSystemStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = ((usedMem / totalMem) * 100).toFixed(1);

  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown';
  const cpuCount = cpus.length;

  function getCpuTimes() {
    return os.cpus().map(c => {
      const t = c.times;
      return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
    });
  }

  const t1 = getCpuTimes();
  const cpuPercent = await new Promise(resolve => {
    setTimeout(() => {
      const t2 = getCpuTimes();
      const percents = t1.map((c, i) => {
        const idleDelta = t2[i].idle - c.idle;
        const totalDelta = t2[i].total - c.total;
        return totalDelta === 0 ? 0 : (1 - idleDelta / totalDelta) * 100;
      });
      const avg = percents.reduce((s, v) => s + v, 0) / percents.length;
      resolve(parseFloat(avg.toFixed(1)));
    }, 300);
  });

  const loadAvg = os.loadavg();

  return {
    cpu: {
      model: cpuModel,
      cores: cpuCount,
      usagePercent: cpuPercent,
      loadAvg1: parseFloat(loadAvg[0].toFixed(2)),
      loadAvg5: parseFloat(loadAvg[1].toFixed(2)),
      loadAvg15: parseFloat(loadAvg[2].toFixed(2)),
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usagePercent: parseFloat(memPercent),
      totalFormatted: formatBytes(totalMem),
      usedFormatted: formatBytes(usedMem),
      freeFormatted: formatBytes(freeMem),
    },
    uptime: os.uptime(),
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    generatedAt: Date.now(),
  };
}

// ── Error/Alert detection ─────────────────────────────────────────────────

function detectAlerts() {
  const alerts = [];

  const subagentData = readJsonFile(path.join(OPENCLAW_DIR, 'subagents', 'runs.json')) || { runs: {} };
  const runs = Object.values(subagentData.runs || {});

  for (const r of runs) {
    const outcome = r.outcome || {};
    const isErrorOutcome = outcome.status === 'error';
    const isErrorReason = r.endedReason === 'error' || r.endedReason === 'timeout';
    if (isErrorOutcome || isErrorReason) {
      alerts.push({
        type: 'subagent_error',
        severity: 'error',
        message: `Subagent "${r.label || (r.runId || '').slice(0, 12)}" 失败 (${r.endedReason || 'error'})`,
        detail: outcome.error || r.endedReason,
        time: r.endedAt || r.createdAt,
      });
    }
  }

  const cronData = readJsonFile(path.join(OPENCLAW_DIR, 'cron', 'jobs.json')) || {};
  const jobs = Object.values(cronData.jobs || cronData || {}).filter(j => j && typeof j === 'object' && j.id);
  for (const j of jobs) {
    const state = j.state || {};
    if (state.lastRunStatus === 'error' || state.lastError) {
      alerts.push({
        type: 'cron_error',
        severity: 'error',
        message: `Cron Job "${j.label || j.name || j.id}" 最近一次运行失败`,
        detail: state.lastError,
        time: state.lastRunAtMs,
      });
    }
  }

  return alerts;
}

// ── Overview builder ──────────────────────────────────────────────────────

function buildOverview() {
  const config = readJsonFile(path.join(OPENCLAW_DIR, 'openclaw.json')) || {};
  const updateCheck = readJsonFile(path.join(OPENCLAW_DIR, 'update-check.json')) || {};
  const subagentRuns = readJsonFile(path.join(OPENCLAW_DIR, 'subagents', 'runs.json')) || { runs: {} };
  const agentsDir = path.join(OPENCLAW_DIR, 'agents');
  let agentList = [];
  try { agentList = fs.readdirSync(agentsDir).filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory()); } catch {}
  const runs = Object.values(subagentRuns.runs || {});
  const now = Date.now();
  const activeRuns = runs.filter(r => r.archiveAtMs && now < r.archiveAtMs);
  const errorRuns = runs.filter(r => {
    const outcome = r.outcome || {};
    return outcome.status === 'error' || r.endedReason === 'error' || r.endedReason === 'timeout';
  });

  const tokenUsage = aggregateTokenUsage();
  const alerts = detectAlerts();

  return {
    version: (config.meta && config.meta.lastTouchedVersion) || 'unknown',
    lastTouchedAt: (config.meta && config.meta.lastTouchedAt) || null,
    agents: agentList,
    agentCount: agentList.length,
    activeSubagents: activeRuns.length,
    totalSubagentRuns: runs.length,
    errorSubagents: errorRuns.length,
    updateInfo: updateCheck,
    tokenUsage,
    alerts,
    serverTime: now,
  };
}

// ── Model Status API ─────────────────────────────────────────────────

app.get('/api/models/status', (req, res) => {
  try {
    // 如果缓存超过 1 分钟，强制刷新
    if (!_modelStatusCache || Date.now() - _modelStatusCacheAt > 60000) {
      checkAllModels().then(results => res.json(results));
    } else {
      res.json(_modelStatusCache);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/api/overview', (req, res) => {
  try { res.json(buildOverview()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v1.2 Analytics API ────────────────────────────────────────────────────

app.get('/api/analytics/tokens', (req, res) => {
  try {
    res.json(buildAnalyticsTokens());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/analytics/system', async (req, res) => {
  try {
    const stats = await getSystemStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── v1.3 Error Radar APIs ─────────────────────────────────────────────────

// /api/errors/gateway — 读取网关日志，提取 WARN/ERROR 条目（最近100条，倒序）
app.get('/api/errors/gateway', (req, res) => {
  try {
    const logDir = GATEWAY_LOG_DIR;
    let logFiles = [];
    try {
      logFiles = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log'))
        .map(f => path.join(logDir, f))
        .sort(); // 按文件名（日期）升序，以便后续合并时按时间顺序
    } catch { return res.json({ entries: [], total: 0, logFiles: [], generatedAt: Date.now() }); }

    const TARGET_LEVELS = new Set(['WARN', 'ERROR', 'FATAL']);
    const entries = [];

    for (const filePath of logFiles) {
      try {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            const meta = obj._meta || {};
            const level = (meta.logLevelName || '').toUpperCase();
            if (!TARGET_LEVELS.has(level)) continue;

            // 提取消息文本：拼接数字键 "0" "1" "2"...
            const msgParts = [];
            for (let i = 0; i <= 5; i++) {
              if (obj[String(i)] !== undefined) {
                const part = typeof obj[String(i)] === 'string'
                  ? obj[String(i)]
                  : JSON.stringify(obj[String(i)]);
                msgParts.push(part);
              }
            }
            const message = msgParts.join(' ').trim();

            // 解析 subsystem
            let subsystem = meta.name || null;
            try {
              const parsed = JSON.parse(meta.name || '{}');
              subsystem = parsed.subsystem || meta.name || null;
            } catch {}

            entries.push({
              level,
              message,
              time: obj.time || meta.date || null,
              hostname: meta.hostname || null,
              subsystem,
              file: (meta.path && meta.path.fileNameWithLine) || null,
              sourceFile: filePath.split('/').pop(),
            });
          } catch { /* 跳过解析失败的行 */ }
        }
      } catch { /* 跳过无法读取的文件 */ }
    }

    // 按时间倒序，取最近100条
    entries.sort((a, b) => {
      const ta = a.time ? new Date(a.time).getTime() : 0;
      const tb = b.time ? new Date(b.time).getTime() : 0;
      return tb - ta;
    });

    res.json({
      entries: entries.slice(0, 100),
      total: entries.length,
      logFiles: logFiles.map(f => f.split('/').pop()),
      generatedAt: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /api/errors/cron — 筛选出有错误的定时任务
app.get('/api/errors/cron', (req, res) => {
  try {
    const data = readJsonFile(path.join(OPENCLAW_DIR, 'cron', 'jobs.json')) || {};
    const allJobs = Object.values(data.jobs || data || {}).filter(j => j && typeof j === 'object' && j.id);

    const errorJobs = allJobs.filter(j => {
      const state = j.state || {};
      return (state.consecutiveErrors > 0) || (state.lastStatus === 'error') || (state.lastRunStatus === 'error');
    });

    res.json({
      errorJobs: errorJobs.map(j => {
        const state = j.state || {};
        return {
          id: j.id,
          name: j.name || j.label || '(未命名)',
          description: j.description || '',
          enabled: j.enabled !== false,
          schedule: j.schedule,
          consecutiveErrors: state.consecutiveErrors || 0,
          lastStatus: state.lastStatus || state.lastRunStatus || 'unknown',
          lastError: state.lastError || null,
          lastRunAtMs: state.lastRunAtMs || null,
          nextRunAtMs: state.nextRunAtMs || null,
          agentId: j.agentId || null,
        };
      }),
      totalJobs: allJobs.length,
      errorCount: errorJobs.length,
      generatedAt: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 原有 API routes（完整保留）───────────────────────────────────────────

app.get('/api/agents', (req, res) => {
  const agentsDir = path.join(OPENCLAW_DIR, 'agents');
  let agents = [];
  try {
    const agentNames = fs.readdirSync(agentsDir).filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory());
    for (const name of agentNames) {
      const agentDir = path.join(agentsDir, name);
      const sessionsJson = readJsonFile(path.join(agentDir, 'sessions', 'sessions.json')) || {};
      let sessionFiles = [];
      try { sessionFiles = fs.readdirSync(path.join(agentDir, 'sessions')).filter(f => f.endsWith('.jsonl') && !f.includes('.deleted') && !f.includes('.reset')); } catch {}
      let lastActive = null;
      const activeSessions = Object.values(sessionsJson);
      const times = activeSessions.map(s => s.updatedAt).filter(Boolean);
      if (times.length > 0) lastActive = Math.max(...times);
      const workspaceDir = getAgentWorkspace(name);
      let identity = { name, emoji: '🤖' };
      const identityFile = path.join(workspaceDir, 'IDENTITY.md');
      if (fs.existsSync(identityFile)) {
        try {
          const content = fs.readFileSync(identityFile, 'utf8');
          const nm = content.match(/\*\*Name:\*\*\s*(.+)/);
          const em = content.match(/\*\*Emoji:\*\*\s*(.+)/);
          identity = { name: nm ? nm[1].trim() : name, emoji: em ? em[1].trim() : '🤖' };
        } catch {}
      }
      // Skip agents where all sessions are ACP (no native subagent sessions)
      const hasNativeSessions = sessionFiles.length > 0 || activeSessions.some(s => !s.acp);
      if (!hasNativeSessions) continue;

      agents.push({
        id: name,
        identity,
        sessionCount: sessionFiles.length,
        activeSessions: activeSessions.length,
        lastActive,
        hasWorkspace: fs.existsSync(workspaceDir),
        sessions: activeSessions.map(s => ({
          sessionId: s.sessionId,
          channel: s.lastChannel,
          to: s.lastTo,
          updatedAt: s.updatedAt,
          modelOverride: s.modelOverride,
        })),
      });
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json(agents);
});

app.get('/api/agents/:agentId/sessions', (req, res) => {
  const sessionsDir = path.join(OPENCLAW_DIR, 'agents', req.params.agentId, 'sessions');
  if (!fs.existsSync(sessionsDir)) return res.status(404).json({ error: 'Agent not found' });
  const sessionsJson = readJsonFile(path.join(sessionsDir, 'sessions.json')) || {};
  const activeIds = new Set(Object.values(sessionsJson).map(s => s.sessionId).filter(Boolean));
  let files = [];
  try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')); } catch {}
  const sessions = files.map(filename => {
    const fp = path.join(sessionsDir, filename);
    const stat = getStat(fp);
    const sessionId = filename.replace(/\.jsonl.*$/, '');
    let messageCount = 0, toolCallCount = 0, createdAt = null;
    let tokenTotal = 0;
    try {
      const content = fs.readFileSync(fp, 'utf8');
      const firstLine = content.split('\n')[0];
      try { createdAt = JSON.parse(firstLine).timestamp; } catch {}
      const lines = content.split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const r = JSON.parse(l);
          if (r.type === 'message') {
            const role = r.message && r.message.role;
            if (role === 'user' || role === 'assistant') messageCount++;
            const cnt = r.message && r.message.content;
            if (Array.isArray(cnt)) {
              toolCallCount += cnt.filter(c => c && c.type === 'toolCall').length;
            }
            // 累计 token 消耗（跳过 delivery-mirror）
            const model = r.message && r.message.model;
            if (model !== 'delivery-mirror' && r.message && r.message.usage) {
              const u = r.message.usage;
              tokenTotal += u.totalTokens || (u.input || 0) + (u.output || 0);
            }
          }
        } catch {}
      }
    } catch {}
    return {
      sessionId,
      filename,
      isActive: activeIds.has(sessionId),
      isDeleted: filename.includes('.deleted'),
      isReset: filename.includes('.reset'),
      size: stat ? formatBytes(stat.size) : 'N/A',
      mtime: stat ? stat.mtime : null,
      createdAt,
      messageCount,
      toolCallCount,
      tokenTotal,
    };
  }).sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  res.json(sessions);
});

app.get('/api/agents/:agentId/sessions/:sessionId', (req, res) => {
  const { agentId, sessionId } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  const sessionsDir = path.join(OPENCLAW_DIR, 'agents', agentId, 'sessions');
  let filePath = path.join(sessionsDir, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) {
    try {
      const match = fs.readdirSync(sessionsDir).find(f => f.startsWith(sessionId) && f.endsWith('.jsonl'));
      if (match) filePath = path.join(sessionsDir, match);
    } catch {}
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });

  const records = readJsonLines(filePath, 1000);
  const sessionHeader = records.find(r => r.type === 'session');
  const messageRecords = records.filter(r => r.type === 'message');
  const recentMessages = messageRecords.slice(-limit);

  const messages = recentMessages.map(r => {
    const msg = r.message || {};
    const role = msg.role || 'system';
    const contentArr = Array.isArray(msg.content) ? msg.content : [];

    let text = '';
    if (Array.isArray(msg.content)) {
      text = msg.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
    } else if (typeof msg.content === 'string') {
      text = msg.content;
    }

    const toolCalls = contentArr
      .filter(c => c && c.type === 'toolCall')
      .map(c => ({ id: c.id, name: c.name, arguments: c.arguments || {} }));

    let toolResults = [];
    if (role === 'toolResult') {
      toolResults = contentArr
        .filter(c => c && c.type === 'text')
        .map(c => ({ text: (c.text || '').slice(0, 2000) }));
    }

    const hasThinking = contentArr.some(c => c && c.type === 'thinking');

    return {
      id: r.id,
      role,
      text: text.slice(0, 3000),
      fullLength: text.length,
      timestamp: r.timestamp,
      model: msg.model,
      usage: msg.usage,
      toolCalls,
      toolResults,
      hasThinking,
    };
  });

  let totalInput = 0, totalOutput = 0;
  for (const r of records) {
    if (r.message && r.message.usage) {
      totalInput += r.message.usage.input || 0;
      totalOutput += r.message.usage.output || 0;
    }
  }

  res.json({
    sessionId,
    agentId,
    createdAt: sessionHeader && sessionHeader.timestamp,
    totalRecords: records.length,
    messages,
    tokenUsage: { input: totalInput, output: totalOutput },
  });
});

app.get('/api/subagents', (req, res) => {
  const data = readJsonFile(path.join(OPENCLAW_DIR, 'subagents', 'runs.json')) || { runs: {} };
  const runs = Object.values(data.runs || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const now = Date.now();
  res.json(runs.map(r => {
    const isActive = r.archiveAtMs ? now < r.archiveAtMs : false;
    const outcome = r.outcome || {};
    const hasError = outcome.status === 'error' || r.endedReason === 'error' || r.endedReason === 'timeout';
    return {
      ...r,
      isActive,
      hasError,
      errorMsg: hasError ? (outcome.error || r.endedReason) : null,
      taskPreview: (r.task || '').slice(0, 120),
    };
  }));
});

app.get('/api/cron', (req, res) => {
  const data = readJsonFile(path.join(OPENCLAW_DIR, 'cron', 'jobs.json')) || {};
  const jobs = Object.values(data.jobs || data || {}).filter(j => j && typeof j === 'object' && j.id);
  res.json(jobs.map(j => ({
    ...j,
    hasError: (j.state && j.state.lastRunStatus === 'error') || !!(j.state && j.state.lastError),
    errorMsg: (j.state && j.state.lastError) || null,
  })));
});

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logFile = path.join(OPENCLAW_DIR, 'logs', 'commands.log');
  if (!fs.existsSync(logFile)) return res.json([]);
  res.json(readJsonLines(logFile, limit).reverse());
});

app.get('/api/agents/:agentId/memory', (req, res) => {
  const { agentId } = req.params;
  const workspaceDir = getAgentWorkspace(agentId);
  const memoryDir = path.join(workspaceDir, 'memory');
  let files = [];
  if (fs.existsSync(memoryDir)) {
    try {
      files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') || f.endsWith('.json')).map(f => {
        const s = getStat(path.join(memoryDir, f));
        return { filename: f, size: s ? formatBytes(s.size) : 'N/A', mtime: s ? s.mtime : null };
      }).sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    } catch {}
  }
  let memoryMd = null;
  const mpath = path.join(workspaceDir, 'MEMORY.md');
  if (fs.existsSync(mpath)) { try { memoryMd = fs.readFileSync(mpath, 'utf8').slice(0, 3000); } catch {} }
  res.json({ files, memoryMd });
});

app.get('/api/agents/:agentId/memory/:filename', (req, res) => {
  const { agentId, filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) return res.status(400).json({ error: 'Invalid filename' });
  const workspaceDir = getAgentWorkspace(agentId);
  const filePath = path.join(workspaceDir, 'memory', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  try { res.json({ filename, content: fs.readFileSync(filePath, 'utf8').slice(0, 10000) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


// ── v1.4 Knowledge Map APIs ───────────────────────────────────────────────

// /api/knowledge/memory — 读取所有 Agent 的记忆文件，生成知识库活跃度统计
app.get('/api/knowledge/memory', (req, res) => {
  try {
    const agentsDir = path.join(OPENCLAW_DIR, 'agents');
    let agentNames = [];
    try { agentNames = fs.readdirSync(agentsDir).filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory()); } catch {}

    const perAgent = [];
    let totalFiles = 0;
    let totalWords = 0;
    let totalLines = 0;
    let latestMtime = null;

    for (const agentId of agentNames) {
      const workspaceDir = getAgentWorkspace(agentId);
      const memoryDir = path.join(workspaceDir, 'memory');
      const memoryMdPath = path.join(workspaceDir, 'MEMORY.md');

      let agentWords = 0, agentLines = 0, agentFiles = 0;
      let agentLatest = null;
      const fileList = [];

      // 读取 MEMORY.md（长期记忆）
      if (fs.existsSync(memoryMdPath)) {
        try {
          const stat = fs.statSync(memoryMdPath);
          const txt = fs.readFileSync(memoryMdPath, 'utf8');
          const words = txt.split(/\s+/).filter(Boolean).length;
          const lines = txt.split('\n').length;
          agentWords += words;
          agentLines += lines;
          agentFiles += 1;
          if (!agentLatest || stat.mtimeMs > agentLatest) agentLatest = stat.mtimeMs;
          fileList.push({ filename: 'MEMORY.md', type: 'longterm', words, lines, mtime: stat.mtime });
        } catch {}
      }

      // 读取 memory/ 目录下的每日记忆文件
      if (fs.existsSync(memoryDir)) {
        let dailyFiles = [];
        try { dailyFiles = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') || f.endsWith('.json')); } catch {}
        for (const fname of dailyFiles) {
          const fp = path.join(memoryDir, fname);
          try {
            const stat = fs.statSync(fp);
            const txt = fs.readFileSync(fp, 'utf8');
            const words = txt.split(/\s+/).filter(Boolean).length;
            const lines = txt.split('\n').length;
            agentWords += words;
            agentLines += lines;
            agentFiles += 1;
            if (!agentLatest || stat.mtimeMs > agentLatest) agentLatest = stat.mtimeMs;
            fileList.push({ filename: fname, type: 'daily', words, lines, mtime: stat.mtime });
          } catch {}
        }
      }

      if (!latestMtime || (agentLatest && agentLatest > latestMtime)) latestMtime = agentLatest;
      totalFiles += agentFiles;
      totalWords += agentWords;
      totalLines += agentLines;

      if (agentFiles > 0) {
        perAgent.push({
          agentId,
          fileCount: agentFiles,
          words: agentWords,
          lines: agentLines,
          latestMtime: agentLatest,
          files: fileList.sort((a, b) => new Date(b.mtime) - new Date(a.mtime)).slice(0, 10),
        });
      }
    }

    res.json({
      totalFiles,
      totalWords,
      totalLines,
      latestMtime,
      perAgent,
      generatedAt: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /api/knowledge/skills — 遍历所有（或指定 Agent 的）session .jsonl，统计 toolName 调用频次
// 支持 ?agentId=xxx 按 Agent 过滤
app.get('/api/knowledge/skills', (req, res) => {
  try {
    const agentsDir = path.join(OPENCLAW_DIR, 'agents');
    const filterAgentId = req.query.agentId || null;
    let agentNames = [];
    try { agentNames = fs.readdirSync(agentsDir).filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory()); } catch {}

    // 若指定 agentId，只扫描该 Agent
    if (filterAgentId) {
      agentNames = agentNames.filter(n => n === filterAgentId);
    }

    const toolCounts = {};
    let totalToolCalls = 0;
    let totalSessionsScanned = 0;

    for (const agentId of agentNames) {
      const sessionsDir = path.join(agentsDir, agentId, 'sessions');
      let files = [];
      files = listAllJsonlFiles(sessionsDir);

      for (const filename of files) {
        const fp = path.join(sessionsDir, filename);
        totalSessionsScanned++;
        try {
          const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const r = JSON.parse(line);
              // 从 message.content 数组中提取 toolCall
              if (r.type === 'message' && r.message && Array.isArray(r.message.content)) {
                for (const c of r.message.content) {
                  if (c && c.type === 'toolCall' && c.name) {
                    toolCounts[c.name] = (toolCounts[c.name] || 0) + 1;
                    totalToolCalls++;
                  }
                }
              }
              // 兼容直接记录 toolName 的格式
              if (r.toolName && typeof r.toolName === 'string') {
                toolCounts[r.toolName] = (toolCounts[r.toolName] || 0) + 1;
                totalToolCalls++;
              }
            } catch {}
          }
        } catch {}
      }
    }

    const ranking = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({
        name,
        count,
        percent: totalToolCalls > 0 ? parseFloat(((count / totalToolCalls) * 100).toFixed(1)) : 0,
      }));

    res.json({
      ranking,
      totalToolCalls,
      totalSessionsScanned,
      uniqueTools: ranking.length,
      agentId: filterAgentId || null,
      generatedAt: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── v1.5 Tasks API ────────────────────────────────────────────────────────

app.get('/api/tasks', (req, res) => {
  try {
    const tasksFile = getDefaultTasksFile();
    if (!fs.existsSync(tasksFile)) {
      return res.json({ tasks: [], generatedAt: Date.now() });
    }
    const data = readJsonFile(tasksFile) || { tasks: [] };
    const tasks = (data.tasks || []).map(t => ({
      id: t.id || '',
      title: t.title || '(无标题)',
      description: t.description || '',
      agent: t.agent || '\u2014',
      status: t.status || 'todo',
      createdAt: t.createdAt || null,
      completedAt: t.completedAt || null,
    }));
    res.json({ tasks, generatedAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6 KPI Performance Board
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v1.15 修复【严重算法漏洞】：彻底废弃「首条 timestamp - 末条 timestamp」的错误算法。
 *
 * 旧算法 Bug（v1.14）：
 *   用 session 首条/末条时间戳之差计算工时，把 Agent 长时间空闲挂机（摸鱼）的时间
 *   全部计入，导致 254+ 小时的虚假注水工时（实际有效工时仅约 13 小时）。
 *
 * 新算法「相邻动作累加 + 闲置阈值过滤」：
 *   - 遍历 session 内所有相邻事件的时间戳差值
 *   - 若相邻两条记录间隔 ≤ IDLE_THRESHOLD_MS（3分钟），则计为有效工时并累加
 *   - 若间隔 > IDLE_THRESHOLD_MS，视为 Agent 空闲/挂机，该段时间绝对不计入工时
 *   - 如果 toolResult 上有 details.durationMs，会在 buildKpiFromSessions 中另行累加
 *   - 排除 .deleted.* 文件（已被用户主动删除）
 *   - runs.json 仅用于辅助获取"任务完成/错误"计数
 *
 * 效果：将 254.9h（虚假）→ 13.7h（真实），挤干 94.6% 的摸鱼水分。
 */
const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3分钟，超过则视为空闲

function buildKpiFromRuns() {
  const agentsDir = path.join(OPENCLAW_DIR, 'agents');
  let agentNames = [];
  try {
    agentNames = fs.readdirSync(agentsDir).filter(f =>
      fs.statSync(path.join(agentsDir, f)).isDirectory()
    );
  } catch {}

  // 读取 runs.json 获取"任务完成/错误"计数（仅辅助用，不用于工时计算）
  const runsData = readJsonFile(path.join(OPENCLAW_DIR, 'subagents', 'runs.json')) || { runs: {} };
  const runs = Object.values(runsData.runs || {});
  const completedByAgent = {};
  const errorByAgent = {};
  for (const run of runs) {
    const csk = run.childSessionKey || '';
    const m = csk.match(/^agent:([^:]+):/);
    const aid = m ? m[1] : 'unknown';
    if (run.endedAt && run.endedReason === 'subagent-complete') {
      completedByAgent[aid] = (completedByAgent[aid] || 0) + 1;
    }
    if (run.outcome && run.outcome.status === 'error') {
      errorByAgent[aid] = (errorByAgent[aid] || 0) + 1;
    }
  }

  const agentStats = {};

  for (const agentId of agentNames) {
    const sessionsDir = path.join(agentsDir, agentId, 'sessions');
    // listAllJsonlFiles 已经包含 .reset.* 归档文件，并排除 .deleted.*
    const files = listAllJsonlFiles(sessionsDir);

    let taskRunTimeMs = 0;
    let taskCount = 0;

    for (const filename of files) {
      const fp = path.join(sessionsDir, filename);
      try {
        const content = fs.readFileSync(fp, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        if (lines.length < 2) continue; // 只有1条记录的 session 无法计算

        // 收集所有有效时间戳
        const timestamps = [];
        for (const line of lines) {
          try {
            const r = JSON.parse(line);
            if (r.timestamp) {
              timestamps.push(new Date(r.timestamp).getTime());
            }
          } catch {}
        }

        if (timestamps.length < 2) continue;

        // 「相邻累加 + 闲置阈值」：仅累加间隔 ≤ 3分钟的相邻事件时间差
        // 超过3分钟的间隔 = Agent 空闲/挂机，不计入工时
        let sessionActiveMs = 0;
        for (let i = 1; i < timestamps.length; i++) {
          const gap = timestamps[i] - timestamps[i - 1];
          if (gap > 0 && gap <= IDLE_THRESHOLD_MS) {
            sessionActiveMs += gap;
          }
          // gap > IDLE_THRESHOLD_MS：视为空闲，跳过，不累加
        }

        taskRunTimeMs += sessionActiveMs;
        taskCount += 1;
      } catch {}
    }

    agentStats[agentId] = {
      agentId,
      taskRunTimeMs,
      taskCount,
      completedCount: completedByAgent[agentId] || 0,
      errorCount: errorByAgent[agentId] || 0,
    };
  }

  return agentStats;
}

/**
 * 从 agents/*\/sessions\/*.jsonl 读取 toolResult 的 details.durationMs，
 * 累加为该 Agent 的「碎片工具工时」
 */
function buildKpiFromSessions() {
  const agentsDir = path.join(OPENCLAW_DIR, 'agents');
  let agentNames = [];
  try { agentNames = fs.readdirSync(agentsDir).filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory()); } catch {}

  const toolStats = {};

  for (const agentId of agentNames) {
    const sessionsDir = path.join(agentsDir, agentId, 'sessions');
    let files = [];
    files = listAllJsonlFiles(sessionsDir);

    let fragmentMs = 0;
    let toolCallCount = 0;
    const toolBreakdown = {};

    for (const filename of files) {
      const fp = path.join(sessionsDir, filename);
      try {
        const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const r = JSON.parse(line);
            if (r.type === 'message' && r.message && r.message.role === 'toolResult') {
              const details = r.message.details || {};
              const dur = typeof details.durationMs === 'number' ? details.durationMs : 0;
              fragmentMs += dur;
              toolCallCount += 1;
              const toolName = r.message.toolName || 'unknown';
              toolBreakdown[toolName] = (toolBreakdown[toolName] || 0) + dur;
            }
          } catch {}
        }
      } catch {}
    }

    toolStats[agentId] = { agentId, fragmentMs, toolCallCount, toolBreakdown };
  }

  return toolStats;
}

app.get('/api/analytics/kpi', (req, res) => {
  try {
    const runStats = buildKpiFromRuns();
    const sessionStats = buildKpiFromSessions();

    const allAgentIds = new Set([...Object.keys(runStats), ...Object.keys(sessionStats)]);

    const agentsDir = path.join(OPENCLAW_DIR, 'agents');
    const identityMap = {};
    for (const agentId of allAgentIds) {
      const workspaceDir = getAgentWorkspace(agentId);
      let identity = { name: agentId, emoji: '🤖' };
      const identityFile = path.join(workspaceDir, 'IDENTITY.md');
      if (fs.existsSync(identityFile)) {
        try {
          const content = fs.readFileSync(identityFile, 'utf8');
          const nm = content.match(/\*\*Name:\*\*\s*(.+)/);
          const em = content.match(/\*\*Emoji:\*\*\s*(.+)/);
          identity = { name: nm ? nm[1].trim() : agentId, emoji: em ? em[1].trim() : '🤖' };
        } catch {}
      }
      // Identity comes from openclaw.json (config) or IDENTITY.md (file).
      // No hardcoded name overrides.
      identityMap[agentId] = identity;
    }

    const result = [];
    for (const agentId of allAgentIds) {
      const run = runStats[agentId] || { taskRunTimeMs: 0, taskCount: 0, completedCount: 0, errorCount: 0 };
      const sess = sessionStats[agentId] || { fragmentMs: 0, toolCallCount: 0, toolBreakdown: {} };

      const taskRunTimeMs = run.taskRunTimeMs || 0;
      const fragmentMs = sess.fragmentMs || 0;
      const totalWorkTimeMs = taskRunTimeMs + fragmentMs;

      const completedCount = run.completedCount || 0;
      const toolCallCount = sess.toolCallCount || 0;

      result.push({
        agentId,
        identity: identityMap[agentId] || { name: agentId, emoji: '🤖' },
        taskRunTimeMs,
        fragmentMs,
        totalWorkTimeMs,
        taskCount: run.taskCount || 0,
        completedCount,
        errorCount: run.errorCount || 0,
        toolCallCount,
        topTools: Object.entries(sess.toolBreakdown || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name, ms]) => ({ name, ms })),

      });
    }

    result.sort((a, b) => b.totalWorkTimeMs - a.totalWorkTimeMs);

    res.json({
      agents: result,
      generatedAt: Date.now(),
      totalTaskCount: result.reduce((s, a) => s + a.taskCount, 0),
      totalWorkTimeMs: result.reduce((s, a) => s + a.totalWorkTimeMs, 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ── v1.10 Disk Analytics ──────────────────────────────────────────────────────

function getDiskInfo() {
  const mounts = [];
  try {
    const output = execSync('df -kP 2>/dev/null', { timeout: 5000 }).toString();
    const lines = output.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const filesystem = parts[0];
      const total = parseInt(parts[1]) * 1024;
      const used = parseInt(parts[2]) * 1024;
      const free = parseInt(parts[3]) * 1024;
      const pct = parseInt(parts[4]);
      const mountpoint = parts[5];
      // 只取关键挂载点
      const KEY_MOUNTS = ['/', '/root', '/home', '/tmp', '/var'];
      if (!KEY_MOUNTS.includes(mountpoint) && !mountpoint.startsWith('/dev')) continue;
      if (filesystem.startsWith('tmpfs') && mountpoint !== '/tmp') continue;
      mounts.push({ filesystem, mountpoint, total, used, free, percent: pct,
        totalFormatted: formatBytes(total), usedFormatted: formatBytes(used), freeFormatted: formatBytes(free) });
    }
  } catch(e) {}
  return mounts;
}

function getDirSizes() {
  const dirs = [
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), '.openclaw', 'logs'),
    path.join(os.homedir(), '.openclaw', 'agents'),
    GATEWAY_LOG_DIR,
  ];
  const results = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const output = execSync(`du -x -B1 -d 2 "${dir}" 2>/dev/null | sort -n`, { timeout: 10000 }).toString();
      const lines = output.trim().split('\n');
      // 取最后一行（total）以及 top entries
      const entries = lines.map(l => {
        const [bytes, p] = l.split('\t');
        return { path: p, bytes: parseInt(bytes) };
      }).filter(e => !isNaN(e.bytes) && e.path);
      if (entries.length === 0) continue;
      const total = entries[entries.length - 1];
      results.push({
        path: dir,
        bytes: total.bytes,
        formatted: formatBytes(total.bytes),
        subDirs: entries.slice(0, -1).sort((a, b) => b.bytes - a.bytes).slice(0, 5).map(e => ({
          path: e.path, bytes: e.bytes, formatted: formatBytes(e.bytes)
        }))
      });
    } catch(e) {}
  }
  return results.sort((a, b) => b.bytes - a.bytes);
}

// Cache disk data for 60 seconds
let _diskCache = null;
let _diskCacheAt = 0;

app.get('/api/analytics/disk', async (req, res) => {
  try {
    const now = Date.now();
    if (_diskCache && now - _diskCacheAt < 60000) {
      return res.json(_diskCache);
    }
    const mounts = getDiskInfo();
    const topDirs = getDirSizes();
    _diskCache = { mounts, topDirs, generatedAt: now };
    _diskCacheAt = now;
    res.json(_diskCache);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── v1.10 Tasks Enriched API ──────────────────────────────────────────────────

app.get('/api/tasks/enriched', (req, res) => {
  try {
    const tasksFile = getDefaultTasksFile();
    const data = fs.existsSync(tasksFile) ? (JSON.parse(fs.readFileSync(tasksFile, 'utf8')) || {}) : {};
    const tasks = (data.tasks || []);

    const subagentData = readJsonFile(path.join(OPENCLAW_DIR, 'subagents', 'runs.json')) || { runs: {} };
    const runs = Object.values(subagentData.runs || {});

    // Heuristic: match task to run by label/title similarity or time proximity
    function guessRun(task) {
      if (!runs.length) return null;
      const titleLower = (task.title || '').toLowerCase();
      const descLower = (task.description || '').toLowerCase();
      const taskTime = task.createdAt ? new Date(task.createdAt).getTime() : 0;

      // Try label match
      let best = null;
      let bestScore = 0;
      for (const r of runs) {
        let score = 0;
        const label = (r.label || '').toLowerCase();
        const preview = (r.taskPreview || r.task || '').toLowerCase();
        // keyword overlap
        const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);
        for (const w of titleWords) {
          if (label.includes(w) || preview.includes(w)) score += 2;
        }
        const descWords = descLower.split(/\s+/).filter(w => w.length > 3);
        for (const w of descWords.slice(0, 10)) {
          if (preview.includes(w)) score += 1;
        }
        // time proximity: within 5 minutes
        if (taskTime && r.createdAt) {
          const timeDiff = Math.abs(taskTime - r.createdAt);
          if (timeDiff < 300000) score += 3;
          else if (timeDiff < 900000) score += 1;
        }
        if (score > bestScore) { bestScore = score; best = r; }
      }
      if (bestScore < 2) return null;
      return {
        runId: best.runId,
        label: best.label,
        endedReason: best.endedReason,
        errorMsg: (best.outcome && best.outcome.error) || null,
        childSessionKey: best.childSessionKey,
        createdAt: best.createdAt,
        endedAt: best.endedAt,
        matchScore: bestScore,
      };
    }

    const enriched = tasks.map(t => ({
      id: t.id || '',
      title: t.title || '(无标题)',
      description: t.description || '',
      agent: t.agent || '\u2014',
      status: t.status || 'todo',
      createdAt: t.createdAt || null,
      completedAt: t.completedAt || null,
      guessedRun: guessRun(t),
    }));

    res.json({ tasks: enriched, generatedAt: Date.now() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── v1.10 Toolbox APIs ────────────────────────────────────────────────────────

// Whitelist of allowed files
const TOOLBOX_FILE_WHITELIST = {
  'openclaw.json': path.join(OPENCLAW_DIR, 'openclaw.json'),
  'jobs.json': path.join(OPENCLAW_DIR, 'cron', 'jobs.json'),
  'runs.json': path.join(OPENCLAW_DIR, 'subagents', 'runs.json'),
};

// Desensitize sensitive fields recursively
function desensitize(obj, depth) {
  if (depth > 10) return obj;
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => desensitize(item, depth + 1));
  const SENSITIVE = /^(apikey|api_key|token|bottoken|bot_token|secret|password|passwd|key|apiSecret|credential|auth|authorization|accesstoken|access_token|refreshtoken|refresh_token|clientsecret|client_secret|appSecret|appsecret)$/i;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = v.slice(0, 4) + '****' + v.slice(-2);
    } else {
      out[k] = desensitize(v, depth + 1);
    }
  }
  return out;
}

app.get('/api/toolbox/files', (req, res) => {
  const name = req.query.name;
  if (!name || !TOOLBOX_FILE_WHITELIST[name]) {
    return res.status(400).json({ error: 'Invalid file name. Allowed: ' + Object.keys(TOOLBOX_FILE_WHITELIST).join(', ') });
  }
  const filePath = TOOLBOX_FILE_WHITELIST[name];
  if (!fs.existsSync(filePath)) {
    return res.json({ name, exists: false, content: null });
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const desensitized = parsed ? desensitize(parsed, 0) : null;
    res.json({
      name,
      exists: true,
      raw: desensitized ? JSON.stringify(desensitized, null, 2) : raw.slice(0, 50000),
      parsed: desensitized,
      size: raw.length,
      generatedAt: Date.now(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/toolbox/gateway-logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  try {
    const logDir = GATEWAY_LOG_DIR;
    if (!fs.existsSync(logDir)) return res.json({ lines: [], files: [], generatedAt: Date.now() });
    const logFiles = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ name: f, path: path.join(logDir, f), mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (logFiles.length === 0) return res.json({ lines: [], files: [], generatedAt: Date.now() });
    const latest = logFiles[0];
    const content = fs.readFileSync(latest.path, 'utf8');
    const lines = content.split('\n').filter(Boolean).slice(-limit).reverse();
    res.json({
      lines,
      files: logFiles.map(f => f.name),
      currentFile: latest.name,
      generatedAt: Date.now(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Toolbox: commands.log ──
app.get('/api/toolbox/commands-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  try {
    const logFile = path.join(OPENCLAW_DIR, 'logs', 'commands.log');
    if (!fs.existsSync(logFile)) return res.json({ lines: [], generatedAt: Date.now() });
    const lines = readJsonLines(logFile, limit).reverse();
    res.json({ lines, generatedAt: Date.now() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  startModelMonitor();
  console.log('\n🤖 OpenClaw Dashboard 已启动');
  console.log('📍 访问地址: http://localhost:' + PORT);
  console.log('📂 数据目录: ' + OPENCLAW_DIR);
  console.log('📡 SSE 实时推送: /api/sse');
  console.log('📊 数据统计 API: /api/analytics/tokens, /api/analytics/system, /api/analytics/disk');
  console.log('🛡️  异常雷达 API: /api/errors/gateway, /api/errors/cron');
  console.log('🧠 知识图谱 API: /api/knowledge/memory, /api/knowledge/skills');
  console.log('🔧 Toolbox API: /api/toolbox/files, /api/toolbox/gateway-logs, /api/toolbox/commands-log');
  console.log('📋 任务 API: /api/tasks/enriched (含关联 run 启发式推断)\n');
});

