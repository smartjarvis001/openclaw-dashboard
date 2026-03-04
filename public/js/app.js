/* ── OpenClaw Dashboard v1.1 ── */

const API = {
  get: async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
};


/* ── Anti-Flicker: safeSetHTML ───────────────────────────────────────────────
 * 比较 innerHTML，内容未变则跳过赋值，同时恢复滚动位置。
 * 彻底解决 5s 定时刷新导致的页面闪烁/滚动条跳动问题。
 */
function safeSetHTML(el, newHtml) {
  if (!el) return;
  if (el.innerHTML === newHtml) return;   // 无变化，不更新 DOM
  const st = el.scrollTop;               // 记录滚动位置
  el.innerHTML = newHtml;
  if (st > 0) el.scrollTop = st;         // 恢复滚动
}

function safeSetHTMLById(id, newHtml) {
  safeSetHTML(document.getElementById(id), newHtml);
}

function timeAgo(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  const sec = Math.floor((Date.now() - d) / 1000);
  if (sec < 60) return `${sec}秒前`;
  if (sec < 3600) return `${Math.floor(sec/60)}分钟前`;
  if (sec < 86400) return `${Math.floor(sec/3600)}小时前`;
  return `${Math.floor(sec/86400)}天前`;
}


// ── Tool color map (shared) ──────────────────────────────
const toolColors = {
  Bash: '#e67e22', Read: '#3498db', Write: '#2ecc71', Edit: '#9b59b6',
  WebSearch: '#1abc9c', WebFetch: '#16a085', Browser: '#e74c3c',
  memory_search: '#f39c12', memory_get: '#d35400',
};
function getToolColor(name) {
  for (const [k, v] of Object.entries(toolColors)) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return '#7f8c8d';
}
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function numFmt(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'K';
  return String(n);
}

/* ── Auto Refresh Counter ── */
let autoRefreshTimer = null;
let autoRefreshEnabled = true;
let lastRefreshTime = Date.now();
const REFRESH_INTERVAL = 60000;

function updateRefreshIndicator() {
  const el = document.getElementById('autoRefreshIndicator');
  if (el) {
    el.textContent = autoRefreshEnabled ? '🟢 实时' : '⏸ 暂停';
    el.title = autoRefreshEnabled ? '点击暂停自动刷新' : '点击启动自动刷新';
  }
}

/* ── SSE Real-time Connection ── */
let sseConn = null;

function connectSSE() {
  if (sseConn) { sseConn.close(); }
  sseConn = new EventSource('/api/sse');
  
  sseConn.addEventListener('overview', (e) => {
    const data = JSON.parse(e.data);
    if (currentPage === 'overview') {
      renderOverview(data, null);
    }
    // Update alert badge regardless of page
    updateAlertBadge(data.alerts || []);
  });

  sseConn.addEventListener('alerts', (e) => {
    const alerts = JSON.parse(e.data);
    updateAlertBadge(alerts);
  });

  sseConn.addEventListener('modelStatus', (e) => {
    if (currentPage === 'overview') loadOverview();
  });

  sseConn.addEventListener('ping', () => {
    lastRefreshTime = Date.now();
    document.getElementById('lastUpdate') && (document.getElementById('lastUpdate').textContent = '实时 · ' + fmtTime(Date.now()));
  });

  sseConn.onerror = () => {
    // SSE disconnected, fall back to polling
    setTimeout(connectSSE, 10000);
  };
}

function updateAlertBadge(alerts) {
  // 暂时禁用 alert badge
  const badge = document.getElementById('alertBadge');
  if (badge) badge.style.display = 'none';
}

/* ── Router ── */
let currentPage = 'overview';
let currentAgent = null;
let _subrunExpanded = {};
let currentSession = null;
// Page-level auto refresh timers
const pageTimers = {};

document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    navigateTo(el.dataset.page);
  });
});

function navigateTo(page) {
  // Stop any previous page timer
  Object.values(pageTimers).forEach(t => clearInterval(t));
  Object.keys(pageTimers).forEach(k => delete pageTimers[k]);

  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');

  loadPage(page);

  // Set up page-specific auto-refresh (5s)
  if (autoRefreshEnabled) {
    pageTimers[page] = setInterval(() => {
      if (currentPage === page) loadPage(page);
    }, REFRESH_INTERVAL);
  }
}

async function loadPage(page) {
  switch (page) {
    case 'overview':  await loadOverview(); break;
    case 'analytics': await loadAnalytics(); break;
    case 'error-radar': await loadErrorRadar(); break;
    case 'knowledge':    await loadKnowledge(); break;
    case 'tasks':        await loadTasks(); break;
    case 'kpi':          await loadKpi(); break;
    case 'toolbox':      await loadToolbox(); break;
  }
}

/* ── Alerts Banner ── */
function getDismissedAlerts() {
  try { return new Set(JSON.parse(sessionStorage.getItem('dismissedAlerts') || '[]')); }
  catch(e) { return new Set(); }
}

function saveDismissedAlert(key) {
  const set = getDismissedAlerts();
  set.add(key);
  sessionStorage.setItem('dismissedAlerts', JSON.stringify([...set]));
}

// 全局告警池：overview alerts + disk alerts 合并后统一渲染
let _overviewAlerts = [];
let _diskAlerts = [];

function _mergeAndRenderAlerts() {
  const all = [..._overviewAlerts, ..._diskAlerts];
  _renderAlertsBanner(all);
}

function renderAlerts(alerts) {
  // 暂时禁用 alert banner
  const container = document.getElementById('alertsBanner');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }
}

/* 核心渲染：key-based diff，已关闭的不重建，已存在的不闪烁 */
function _renderAlertsBanner(alerts) {
  const container = document.getElementById('alertsBanner');
  if (!container) return;

  const dismissed = getDismissedAlerts();
  const visible = (alerts || []).filter(a => {
    const key = (a.message || '') + '|' + (a.severity || '');
    return !dismissed.has(key);
  });

  if (visible.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = 'block';

  // 收集当前 DOM 中已有的 alert keys（用于 diff）
  const existingKeys = new Set();
  container.querySelectorAll('.alert-item[data-alert-key]').forEach(el => {
    existingKeys.add(el.dataset.alertKey);
  });

  // 需要新插入的 keys
  const visibleKeys = new Set(visible.map(a => (a.message || '') + '|' + (a.severity || '')));

  // 移除 DOM 中已不在 visible 列表里的告警（数据消失了）
  container.querySelectorAll('.alert-item[data-alert-key]').forEach(el => {
    if (!visibleKeys.has(el.dataset.alertKey)) el.remove();
  });

  // 插入新出现的告警（已存在的跳过，保留用户关闭后的 DOM 状态）
  visible.forEach(a => {
    const key = (a.message || '') + '|' + (a.severity || '');
    if (existingKeys.has(key)) return;  // 已在 DOM 中，不重建
    const div = document.createElement('div');
    div.className = `alert-item alert-${esc(a.severity)}`;
    div.dataset.alertKey = key;
    div.innerHTML = `
      <span class="alert-icon">${a.severity === 'error' ? '🚨' : '⚠️'}</span>
      <div class="alert-content">
        <div class="alert-msg">${esc(a.message)}</div>
        ${a.detail ? `<div class="alert-detail">${esc(a.detail)}</div>` : ''}
        ${a.time ? `<div class="alert-time">${timeAgo(a.time)}</div>` : ''}
      </div>
      <button class="alert-dismiss" data-key="${esc(key)}" onclick="dismissAlert(this)" title="关闭">✕</button>
    `;
    container.appendChild(div);
  });

  // 再次检查，如果全部移除则隐藏
  if (!container.querySelector('.alert-item')) {
    container.style.display = 'none';
  }
}

/* 关闭按钮处理器 */
function dismissAlert(btn) {
  const key = btn.dataset.key;
  saveDismissedAlert(key);
  const item = btn.closest('.alert-item');
  if (item) item.remove();
  const container = document.getElementById('alertsBanner');
  if (container && !container.querySelector('.alert-item')) {
    container.style.display = 'none';
  }
}

/* ── Overview / Workbench ── */
async function loadOverview() {
  try {
    const [overview, subagents, agents, sysStats, modelStatus] = await Promise.all([
      API.get('/api/overview'),
      API.get('/api/subagents'),
      API.get('/api/agents'),
      API.get('/api/analytics/system').catch(() => null),
      API.get('/api/models/status').catch(() => []),
    ]);
    renderOverview(overview, subagents);
    const modelStatusMap = {};
    (modelStatus || []).forEach(m => { modelStatusMap[m.agentId] = m; });
    renderAgentsCompact(agents, (overview.tokenUsage || {}).perAgent || {}, modelStatusMap);
    if (sysStats) renderSysStatusBar(sysStats);
  } catch (e) {
    console.error('loadOverview failed:', e);
  }
}

function renderModelStatusBar(statuses) {
  const items = document.getElementById('modelStatusItems');
  const meta = document.getElementById('modelStatusMeta');
  if (!items || !Array.isArray(statuses) || statuses.length === 0) return;

  const pills = statuses.map(s => {
    const ok = s.available;
    const label = s.agentName || s.agentId;
    const model = (s.modelId || '').split('/').pop();
    const tip = ok ? `${s.modelId}` : `${s.modelId}: ${s.error || '不可用'}`;
    return `<span class="model-pill model-pill-${ok ? 'ok' : 'err'}" title="${esc(tip)}">
      <span class="model-pill-dot"></span>${esc(label)}<span class="model-pill-model">${esc(model)}</span>
    </span>`;
  }).join('');

  safeSetHTML(items, pills);

  const downCount = statuses.filter(s => !s.available).length;
  const lastCheck = statuses[0]?.lastCheck;
  const timeStr = lastCheck ? fmtTime(new Date(lastCheck).getTime()) : '';
  if (meta) meta.textContent = (downCount > 0 ? `⚠ ${downCount} 异常` : '全部正常') + (timeStr ? ` · ${timeStr}` : '');
}

function renderOverview(overview, subagents) {
  document.getElementById('versionInfo').textContent = `v${overview.version}`;
  document.getElementById('lastUpdate').textContent = `实时 · ${fmtTime(Date.now())}`;
  renderAlerts(overview.alerts || []);

  // Metrics strip
  const tu = overview.tokenUsage || {};
  const activeColor = overview.activeSubagents > 0 ? '#4ade80' : '#60a5fa';
  safeSetHTMLById('metricsStrip', `
    <div class="metric-pill"><div class="metric-pill-label">Agents</div><div class="metric-pill-val">${overview.agentCount}</div></div>
    <div class="metric-pill"><div class="metric-pill-label">活跃任务</div><div class="metric-pill-val" style="color:${activeColor}">${overview.activeSubagents}</div></div>
    <div class="metric-pill"><div class="metric-pill-label">总 Token</div><div class="metric-pill-val">${numFmt(tu.totalTokens||0)}</div></div>
    <div class="metric-pill"><div class="metric-pill-label">输入</div><div class="metric-pill-val" style="color:#34d399">${numFmt(tu.totalInput||0)}</div></div>
    <div class="metric-pill"><div class="metric-pill-label">输出</div><div class="metric-pill-val" style="color:#f472b6">${numFmt(tu.totalOutput||0)}</div></div>
    ${overview.errorSubagents > 0 ? `<div class="metric-pill metric-pill-error"><div class="metric-pill-label">⚠ 错误</div><div class="metric-pill-val" style="color:#f87171">${overview.errorSubagents}</div></div>` : ''}
  `);

  // Activity feed
  if (subagents) {
    const recent = subagents.slice(0, 15);
    const container = document.getElementById('recentSubagents');
    if (container) {
      const html = recent.length === 0
        ? emptyState('没有 Subagent 运行记录')
        : recent.map(r => `
            <div class="activity-item${r.hasError ? ' activity-error' : r.isActive ? ' activity-active' : ''}">
              <span class="card-badge ${r.hasError ? 'badge-error' : r.isActive ? 'badge-active' : 'badge-done'}">
                ${r.hasError ? '🔴 错误' : r.isActive ? '🟢 运行中' : '⚪ 完成'}
              </span>
              <div class="activity-body">
                <div class="activity-title">${esc(r.label || (r.runId||'').slice(0,12))}</div>
                <div class="activity-desc">${esc(r.taskPreview)}</div>
              </div>
              <div class="activity-time">${timeAgo(r.createdAt)}</div>
            </div>
          `).join('');
      safeSetHTML(container, html);
    }
  }
}

function renderSysStatusBar(s) {
  const bar = document.getElementById('sysStatusBar');
  if (!bar) return;
  const cpu = s.cpu || {};
  const mem = s.memory || {};
  const cpuPct = cpu.usagePercent || 0;
  const memPct = mem.usagePercent || 0;
  const uptimeSec = s.uptime || 0;
  const uptimeStr = uptimeSec < 3600
    ? Math.floor(uptimeSec / 60) + 'min'
    : uptimeSec < 86400
      ? Math.floor(uptimeSec / 3600) + 'h'
      : Math.floor(uptimeSec / 86400) + 'd';
  function cls(pct, t1, t2) { return pct > t2 ? 'danger' : pct > t1 ? 'warn' : 'ok'; }
  safeSetHTML(bar, `
    <div class="sys-pill"><span class="sys-pill-label">CPU</span><span class="sys-pill-val ${cls(cpuPct,50,80)}">${cpuPct}%</span></div>
    <div class="sys-pill"><span class="sys-pill-label">内存</span><span class="sys-pill-val ${cls(memPct,65,85)}">${memPct}%</span>${mem.usedFormatted ? `<span class="sys-pill-sub">${mem.usedFormatted}/${mem.totalFormatted}</span>` : ''}</div>
    <div class="sys-pill"><span class="sys-pill-label">负载</span><span class="sys-pill-val ok">${cpu.loadAvg1 || '—'}</span></div>
    <div class="sys-pill"><span class="sys-pill-label">运行时长</span><span class="sys-pill-val ok">${uptimeStr}</span></div>
    ${s.hostname ? `<div class="sys-pill sys-pill-host"><span class="sys-pill-sub">${esc(s.hostname)}</span></div>` : ''}
  `);
}

function renderAgentsCompact(agents, perAgentTokens, modelStatusMap = {}) {
  const container = document.getElementById('agentsList');
  if (!container) return;
  const countEl = document.getElementById('agentsCount');
  if (countEl) countEl.textContent = agents.length;
  if (!agents || !agents.length) {
    safeSetHTML(container, emptyState('暂无 Agent'));
    return;
  }
  safeSetHTML(container, agents.map(a => {
    const isActive = a.activeSessions > 0;
    const emoji = a.identity?.emoji || '🤖';
    const name = a.identity?.name || a.id;
    const tok = perAgentTokens[a.id] || {};
    const totalTok = tok.totalTokens || (tok.input||0) + (tok.output||0);
    const ms = modelStatusMap[a.id] || {};
    let modelStatusHtml = '';
    if (ms.available === true) {
      modelStatusHtml = `<div class="acc-model-status acc-model-ok" title="正常 · ${ms.responseTime || ''}ms">${ms.responseTime || ''}ms</div>`;
    } else if (ms.available === false) {
      const errCode = ms.error ? ms.error.replace(/^HTTP (\d+).*/, '$1') : 'ERR';
      modelStatusHtml = `<div class="acc-model-status acc-model-err" title="${ms.error || '异常'}">${errCode}</div>`;
    }
    return `
      <div class="agent-compact-card" onclick="openAgent('${esc(a.id)}')">
        <div class="acc-emoji">${esc(emoji)}</div>
        <div class="acc-info">
          <div class="acc-name">${esc(name)}</div>
          <div class="acc-meta">会话 ${a.sessionCount} · ${timeAgo(a.lastActive)}</div>
        </div>
        <div class="acc-stats">
          ${modelStatusHtml}
          ${totalTok > 0 ? `<div class="acc-tokens">${numFmt(totalTok)} tok</div>` : ''}
          ${a.activeSessions > 0 ? `<div class="acc-active-sessions">${a.activeSessions} 活跃</div>` : ''}
        </div>
        <div class="acc-status ${isActive ? 'acc-active' : 'acc-idle'}" title="${isActive ? '活跃' : '空闲'}"></div>
      </div>
    `;
  }).join(''));
}

/* ── Workbench navigation ── */
function showWorkbench() {
  document.getElementById('workbenchView').classList.remove('hidden');
  document.getElementById('agentDetail').classList.add('hidden');
  document.getElementById('sessionDetail').classList.add('hidden');
  currentAgent = null;
  currentSession = null;
}

async function openAgent(agentId) {
  currentAgent = agentId;
  document.getElementById('workbenchView').classList.add('hidden');
  document.getElementById('sessionDetail').classList.add('hidden');
  const detail = document.getElementById('agentDetail');
  detail.classList.remove('hidden');
  document.getElementById('detailAgentName').textContent = `agent:${agentId}`;
  switchTab('sessions');
  await loadSessionsList(agentId);
}

async function loadSessionsList(agentId) {
  const container = document.getElementById('sessionsList');
  container.innerHTML = '<div style="color:#64748b;padding:12px">加载中...</div>';
  try {
    const sessions = await API.get(`/api/agents/${agentId}/sessions`);
    if (!sessions.length) { container.innerHTML = emptyState('暂无会话记录'); return; }
    container.innerHTML = sessions.map(s => {
      let statusClass = 'status-normal';
      if (s.isActive) statusClass = 'status-active';
      else if (s.isReset) statusClass = 'status-reset';
      else if (s.isDeleted) statusClass = 'status-deleted';
      return `
        <div class="session-row ${s.isActive ? 'is-active' : ''}" onclick="openSession('${esc(agentId)}', '${esc(s.sessionId)}')">
          <div class="session-status ${statusClass}"></div>
          <div class="session-id">${esc(s.sessionId.slice(0,16))}…</div>
          <div style="font-size:11px;color:#475569">${s.isDeleted?'🗑 ':''}${s.isReset?'↺ ':''}</div>
          <div class="session-info">
            <div class="session-msgs">💬 ${s.messageCount} 条</div>
            ${s.tokenTotal > 0 ? `<div class="session-tokens">🪙 ${numFmt(s.tokenTotal)} tokens</div>` : ''}
            <div class="session-time">${timeAgo(s.mtime)}</div>
            <div class="session-size">${s.size}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch(e) {
    container.innerHTML = `<div style="color:#f87171">加载失败: ${e.message}</div>`;
  }
}

/* ── Tool Icons ── */
const TOOL_ICONS = {
  web_search: '🔍', web_fetch: '🌐', read: '📄', write: '✏️', edit: '🔧',
  exec: '💻', browser: '🌍', message: '📨', feishu_doc: '📝', feishu_wiki: '📚',
  feishu_bitable_list_records: '🗃️', feishu_bitable_create_record: '➕',
  feishu_bitable_update_record: '📊', feishu_bitable_get_record: '🔎',
  feishu_drive: '☁️', canvas: '🖼️', nodes: '📡', tts: '🔊',
  subagents: '⚡', process: '⚙️',
};

function getToolIcon(name) {
  return TOOL_ICONS[name] || '🔧';
}

function renderToolCall(tc, idx) {
  const icon = getToolIcon(tc.name);
  const argsStr = JSON.stringify(tc.arguments || {}, null, 2);
  const argsPreview = argsStr.length > 100 ? argsStr.slice(0,100) + '...' : argsStr;
  const callId = `tc-${idx}-${tc.id || Math.random().toString(36).slice(2)}`;
  return `
    <div class="tool-call">
      <div class="tool-call-header" onclick="toggleToolCall('${callId}')">
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${esc(tc.name)}</span>
        <span class="tool-args-preview">${esc(argsPreview)}</span>
        <span class="tool-toggle" id="toggle-${callId}">▶</span>
      </div>
      <div class="tool-call-body" id="${callId}" style="display:none">
        <pre class="tool-args">${esc(argsStr)}</pre>
      </div>
    </div>
  `;
}

function toggleToolCall(id) {
  const body = document.getElementById(id);
  const toggle = document.getElementById('toggle-' + id);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (toggle) toggle.textContent = open ? '▶' : '▼';
}

function roleLabel(role) {
  const map = { user: '👤 User', assistant: '🤖 Assistant', system: '⚙️ System', toolResult: '📤 Tool Result' };
  return map[role] || role;
}

async function openSession(agentId, sessionId) {
  currentSession = sessionId;
  document.getElementById('agentDetail').classList.add('hidden');
  const detail = document.getElementById('sessionDetail');
  detail.classList.remove('hidden');
  document.getElementById('detailSessionId').textContent = sessionId.slice(0, 20) + '…';

  const container = document.getElementById('chatMessages');
  container.innerHTML = '<div style="color:#64748b;padding:20px">加载对话历史...</div>';

  try {
    const data = await API.get(`/api/agents/${agentId}/sessions/${sessionId}?limit=80`);
    const msgs = data.messages;

    if (!msgs.length) { container.innerHTML = emptyState('暂无对话记录'); return; }

    // Session token usage bar
    const tu = data.tokenUsage || {};
    const tokenBar = tu.input || tu.output ? `
      <div class="session-token-bar">
        <span class="stb-label">本会话 Token</span>
        <span class="stb-in">↑ ${numFmt(tu.input)}</span>
        <span class="stb-out">↓ ${numFmt(tu.output)}</span>
        <span class="stb-total">合计 ${numFmt((tu.input||0)+(tu.output||0))}</span>
      </div>
    ` : '';

    container.innerHTML = tokenBar + `
      <div style="text-align:center;font-size:11px;color:#475569;padding:8px 0;margin-bottom:8px">
        创建于 ${fmtTime(data.createdAt)} · 共 ${data.totalRecords} 条记录 · 显示最近 ${msgs.length} 条消息
      </div>
    ` + msgs.map((m, mi) => {
      const role = m.role || 'system';
      const truncated = m.fullLength > 3000;
      const tokens = m.usage ? `📊 in:${m.usage.input||0} out:${m.usage.output||0}` : '';

      // Tool calls block
      let toolCallsHtml = '';
      if (m.toolCalls && m.toolCalls.length > 0) {
        toolCallsHtml = `<div class="tool-calls-group">${m.toolCalls.map((tc, i) => renderToolCall(tc, mi+'_'+i)).join('')}</div>`;
      }

      // Tool results block
      let toolResultsHtml = '';
      if (role === 'toolResult' && m.toolResults && m.toolResults.length > 0) {
        const resultId = `tr-${mi}`;
        toolResultsHtml = `
          <div class="tool-result-header" onclick="toggleToolCall('${resultId}')">
            <span>📤 工具返回结果</span>
            <span id="toggle-${resultId}">▶</span>
          </div>
          <div id="${resultId}" style="display:none">
            ${m.toolResults.map(tr => `<pre class="tool-result-content">${esc(tr.text)}</pre>`).join('')}
          </div>
        `;
      }

      // Text content (hide if it's a pure toolResult with no text)
      const showText = m.text && m.text.trim() && role !== 'toolResult';

      return `
        <div class="msg-bubble ${esc(role)}">
          <div class="msg-role">${roleLabel(role)}${m.hasThinking ? ' 💭' : ''}</div>
          ${showText ? `<div class="msg-content">${esc(m.text || '(空)')}</div>` : ''}
          ${toolCallsHtml}
          ${role === 'toolResult' ? toolResultsHtml : ''}
          ${truncated ? `<div class="msg-truncated">⚠ 内容已截断 (原始 ${m.fullLength} 字符)</div>` : ''}
          <div class="msg-meta">
            <span>${fmtTime(m.timestamp)}</span>
            ${m.model ? `<span>🧠 ${esc(m.model)}</span>` : ''}
            ${tokens ? `<span>${tokens}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    container.scrollTop = container.scrollHeight;
  } catch(e) {
    container.innerHTML = `<div style="color:#f87171">加载失败: ${e.message}</div>`;
  }
}

/* ── Tabs ── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
  if (tab === 'subruns' && currentAgent) loadAgentSubruns(currentAgent);
  if (tab === 'brain' && currentAgent) loadBrainTab(currentAgent);
}

/* ── v1.13: 🧠 记忆大脑 Tab（记忆文件 + 工具调用热度 合并版） ── */
async function loadBrainTab(agentId) {
  const memContainer = document.getElementById('brainMemoryContent');
  const skillContainer = document.getElementById('brainSkillsContent');
  if (!memContainer || !skillContainer) return;
  memContainer.innerHTML = '<div style="color:#64748b;padding:12px">加载记忆文件...</div>';
  skillContainer.innerHTML = '<div style="color:#64748b;padding:12px">加载技能数据...</div>';

  // 上半区：记忆文件树
  try {
    const data = await API.get(`/api/agents/${agentId}/memory`);
    let html = '<div class="section-title" style="margin-top:0">📂 记忆文件树</div><div class="memory-section">';
    if (data.memoryMd) {
      html += `<div class="section-title" style="font-size:13px">MEMORY.md (长期记忆)</div><div class="memory-md">${esc(data.memoryMd)}</div>`;
    }
    if (data.files && data.files.length) {
      html += `<div class="section-title" style="font-size:13px">记忆文件 (${data.files.length})</div><div class="memory-files">`;
      html += data.files.map(f => `
        <div class="memory-file-row" onclick="toggleBrainMemoryFile('${esc(agentId)}', '${esc(f.filename)}', this)">
          <div class="memory-file-name">📄 ${esc(f.filename)}</div>
          <div class="memory-file-meta">${f.size} · ${timeAgo(f.mtime)}</div>
        </div>
        <div class="memory-file-content" id="bmf-${esc(f.filename)}" style="display:none"></div>
      `).join('');
      html += '</div>';
    }
    if (!data.memoryMd && !(data.files && data.files.length)) {
      html += '<div class="empty-state" style="padding:20px"><div class="empty-icon">🧠</div><div class="empty-text">暂无记忆文件</div></div>';
    }
    html += '</div>';
    memContainer.innerHTML = html;
  } catch(e) {
    memContainer.innerHTML = `<div style="color:#f87171">记忆文件加载失败: ${esc(e.message)}</div>`;
  }

  // 下半区：工具调用热度
  try {
    const skillData = await API.get('/api/knowledge/skills?agentId=' + encodeURIComponent(agentId));
    const ranking = (skillData.ranking || []).slice(0, 15);
    let html = '<div class="section-title" style="margin-top:16px">⚡ 兵器谱 — 工具调用热度</div>';
    html += '<div class="agent-skills-section"><div class="agent-skills-block">';
    html += `<div class="agent-skills-meta">扫描会话: ${skillData.totalSessionsScanned} · 独立工具: ${skillData.uniqueTools} · 总调用: ${numFmt(skillData.totalToolCalls)}</div>`;
    if (ranking.length === 0) {
      html += '<div class="empty-state" style="padding:20px"><div class="empty-icon">🔧</div><div class="empty-text">暂无工具调用记录</div></div>';
    } else {
      const maxCount = ranking[0].count;
      const toolColors = {
        exec:'#f59e0b',browser:'#60a5fa',web_search:'#34d399',web_fetch:'#10b981',
        feishu_doc:'#a78bfa',feishu_wiki:'#c084fc',read:'#94a3b8',write:'#7dd3fc',
        edit:'#6ee7b7',canvas:'#fbbf24',nodes:'#f87171',tts:'#4ade80',
        message:'#38bdf8',subagents:'#e2e8f0',process:'#64748b',
      };
      function getToolColor(name) {
        if (toolColors[name]) return toolColors[name];
        if (name.startsWith('feishu_')) return '#c084fc';
        return '#64748b';
      }
      html += '<div class="agent-skill-chart">' + ranking.map((item, idx) => {
        const barW = maxCount > 0 ? ((item.count / maxCount) * 100).toFixed(1) : 0;
        const color = getToolColor(item.name);
        return `<div class="skill-row">
          <div class="skill-rank">${idx+1}</div>
          <div class="skill-name">${esc(item.name)}</div>
          <div class="skill-bar-wrap"><div class="skill-bar" style="width:${barW}%;background:${color}"></div></div>
          <div class="skill-count">${numFmt(item.count)}</div>
          <div class="skill-pct">${item.percent}%</div>
        </div>`;
      }).join('') + '</div>';
    }
    html += '</div></div>';
    skillContainer.innerHTML = html;
  } catch(e) {
    skillContainer.innerHTML = `<div style="color:#f87171">技能数据加载失败: ${esc(e.message)}</div>`;
  }
}

async function toggleBrainMemoryFile(agentId, filename, row) {
  const id = `bmf-${filename}`;
  const el = document.getElementById(id);
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.textContent = '加载中...';
  try {
    const data = await API.get(`/api/agents/${agentId}/memory/${encodeURIComponent(filename)}`);
    el.textContent = data.content;
  } catch(e) {
    el.textContent = `加载失败: ${e.message}`;
  }
}

async function loadMemory(agentId) {
  const container = document.getElementById('memoryContent');
  container.innerHTML = '<div style="color:#64748b;padding:12px">加载中...</div>';
  try {
    const data = await API.get(`/api/agents/${agentId}/memory`);
    let html = '<div class="memory-section">';
    if (data.memoryMd) {
      html += `<div class="section-title">MEMORY.md (长期记忆)</div><div class="memory-md">${esc(data.memoryMd)}</div>`;
    }
    if (data.files && data.files.length) {
      html += `<div class="section-title">记忆文件 (${data.files.length})</div><div class="memory-files">`;
      html += data.files.map(f => `
        <div class="memory-file-row" onclick="toggleMemoryFile('${esc(agentId)}', '${esc(f.filename)}', this)">
          <div class="memory-file-name">📄 ${esc(f.filename)}</div>
          <div class="memory-file-meta">${f.size} · ${timeAgo(f.mtime)}</div>
        </div>
        <div class="memory-file-content" id="mf-${esc(f.filename)}" style="display:none"></div>
      `).join('');
      html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = `<div style="color:#f87171">加载失败: ${e.message}</div>`;
  }
}

async function toggleMemoryFile(agentId, filename, row) {
  const id = `mf-${filename}`;
  const el = document.getElementById(id);
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.textContent = '加载中...';
  try {
    const data = await API.get(`/api/agents/${agentId}/memory/${encodeURIComponent(filename)}`);
    el.textContent = data.content;
  } catch(e) {
    el.textContent = `加载失败: ${e.message}`;
  }
}

/* ── v1.12: Agent 记忆与技能 Tab ── */
async function loadAgentSkills(agentId) {
  const container = document.getElementById('agentSkillsContent');
  if (!container) return;
  container.innerHTML = '<div style="color:#64748b;padding:16px">加载中...</div>';
  try {
    const [memData, skillData] = await Promise.all([
      API.get('/api/agents/' + agentId + '/memory'),
      API.get('/api/knowledge/skills?agentId=' + encodeURIComponent(agentId)),
    ]);
    let html = '<div class="agent-skills-section">';

    // 记忆摘要
    const fileCount = (memData.files || []).length + (memData.memoryMd ? 1 : 0);
    const hasMemoryMd = !!memData.memoryMd;
    const dailyCount = (memData.files || []).filter(f => f.filename && !f.filename.includes('MEMORY')).length;

    html += `<div class="agent-skills-block">
      <div class="agent-skills-block-title">🧠 长期记忆状态</div>
      <div class="agent-mem-summary">
        <div class="agent-mem-item ${hasMemoryMd ? 'mem-active' : 'mem-empty'}">
          <div class="agent-mem-icon">${hasMemoryMd ? '⭐' : '○'}</div>
          <div class="agent-mem-label">MEMORY.md</div>
          <div class="agent-mem-status">${hasMemoryMd ? '已建立' : '未建立'}</div>
        </div>
        <div class="agent-mem-item">
          <div class="agent-mem-icon">📅</div>
          <div class="agent-mem-label">每日记忆</div>
          <div class="agent-mem-status">${dailyCount} 个文件</div>
        </div>
        <div class="agent-mem-item">
          <div class="agent-mem-icon">📄</div>
          <div class="agent-mem-label">记忆文件总计</div>
          <div class="agent-mem-status">${fileCount} 个</div>
        </div>
      </div>`;

    if (hasMemoryMd && memData.memoryMd) {
      html += `<div class="agent-memory-md-preview">
        <div class="agent-mem-preview-label">MEMORY.md 摘要（前 500 字符）</div>
        <div class="agent-mem-preview-content">${esc(memData.memoryMd.slice(0, 500))}${memData.memoryMd.length > 500 ? '…' : ''}</div>
      </div>`;
    }
    html += '</div>';

    // 工具调用热度
    const ranking = (skillData.ranking || []).slice(0, 15);
    html += `<div class="agent-skills-block">
      <div class="agent-skills-block-title">⚡ 兵器谱 — 工具调用热度</div>
      <div class="agent-skills-meta">
        扫描会话: ${skillData.totalSessionsScanned} · 独立工具: ${skillData.uniqueTools} · 总调用: ${numFmt(skillData.totalToolCalls)}
      </div>`;

    if (ranking.length === 0) {
      html += '<div class="empty-state" style="padding:20px"><div class="empty-icon">🔧</div><div class="empty-text">暂无工具调用记录</div></div>';
    } else {
      const maxCount = ranking[0].count;
      const toolColors = {
        exec:'#f59e0b',browser:'#60a5fa',web_search:'#34d399',web_fetch:'#10b981',
        feishu_doc:'#a78bfa',feishu_wiki:'#c084fc',read:'#94a3b8',write:'#7dd3fc',
        edit:'#6ee7b7',canvas:'#fbbf24',nodes:'#f87171',tts:'#4ade80',
        message:'#38bdf8',subagents:'#e2e8f0',process:'#64748b',
      };
      function getToolColor(name) {
        if (toolColors[name]) return toolColors[name];
        if (name.startsWith('feishu_')) return '#c084fc';
        return '#64748b';
      }
      html += '<div class="agent-skill-chart">' + ranking.map((item, idx) => {
        const barW = maxCount > 0 ? ((item.count / maxCount) * 100).toFixed(1) : 0;
        const color = getToolColor(item.name);
        return `<div class="skill-row">
          <div class="skill-rank">${idx+1}</div>
          <div class="skill-name">${esc(item.name)}</div>
          <div class="skill-bar-wrap"><div class="skill-bar" style="width:${barW}%;background:${color}"></div></div>
          <div class="skill-count">${numFmt(item.count)}</div>
          <div class="skill-pct">${item.percent}%</div>
        </div>`;
      }).join('') + '</div>';
    }
    html += '</div></div>';
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = `<div style="color:#f87171;padding:16px">加载失败: ${esc(e.message)}</div>`;
  }
}

document.getElementById('backToWorkbench').addEventListener('click', () => showWorkbench());
document.getElementById('backToAgent').addEventListener('click', () => {
  document.getElementById('sessionDetail').classList.add('hidden');
  document.getElementById('agentDetail').classList.remove('hidden');
});

/* ── Subagents ── */
async function loadSubagents() {
  const container = document.getElementById('subagentsList');
  container.innerHTML = '<div style="color:#64748b;padding:20px">加载中...</div>';
  try {
    const runs = await API.get('/api/subagents');
    if (!runs.length) { container.innerHTML = emptyState('暂无 Subagent 记录'); return; }
    container.innerHTML = runs.map(r => `
      <div class="subagent-card ${r.isActive ? 'active' : ''} ${r.hasError ? 'has-error' : ''}">
        <div class="subagent-header">
          <span class="card-badge ${r.hasError ? 'badge-error' : r.isActive ? 'badge-active' : 'badge-done'}">
            ${r.hasError ? '🚨 错误' : r.isActive ? '🟢 运行中' : '⚪ 已完成'}
          </span>
          <div class="subagent-label">${esc(r.label || '(未命名)')}</div>
          <div style="font-size:11px;color:#64748b">${timeAgo(r.createdAt)}</div>
        </div>
        ${r.hasError ? `<div class="subagent-error-msg">🚨 ${esc(r.errorMsg || '运行失败')}</div>` : ''}
        <div class="subagent-task">${esc(r.taskPreview)}${r.task && r.task.length > 120 ? '…' : ''}</div>
        <div class="subagent-footer">
          <div class="subagent-meta">ID: <span>${esc((r.runId||'').slice(0,12))}…</span></div>
          <div class="subagent-meta">模型: <span>${esc(r.model||'—')}</span></div>
          <div class="subagent-meta">来源: <span>${esc((r.requesterDisplayKey||'').split(':').slice(0,2).join(':') || '—')}</span></div>
          <div class="subagent-meta">创建: <span>${fmtTime(r.createdAt)}</span></div>
          ${r.archiveAtMs ? `<div class="subagent-meta">归档: <span>${fmtTime(r.archiveAtMs)}</span></div>` : ''}
        </div>
      </div>
    `).join('');
  } catch(e) {
    container.innerHTML = `<div style="color:#f87171">加载失败: ${e.message}</div>`;
  }
}


/* ── v1.11: Agent 子任务 Runs（合并到 Agent 详情页） ── */
async function loadAgentSubruns(agentId) {
  const container = document.getElementById('agentSubrunsList');
  if (!container) return;
  container.innerHTML = '<div style="color:#64748b;padding:20px">加载中...</div>';
  try {
    const runs = await API.get('/api/subagents');
    // 过滤出属于此 agent 的 runs（按 requesterDisplayKey 或 agentId 匹配）
    const agentRuns = runs.filter(r => {
      const key = r.requesterDisplayKey || r.sessionKey || '';
      return key.includes(':' + agentId + ':') || key.startsWith(agentId + ':') ||
             (r.agentId && r.agentId === agentId);
    });
    if (!agentRuns.length) {
      container.innerHTML = emptyState('该 Agent 暂无子任务记录');
      return;
    }
    // 展开/折叠状态映射

  function _toggleSubrun(runId) {
    _subrunExpanded[runId] = !_subrunExpanded[runId];
    const body = document.getElementById('subrun-body-' + runId);
    const arrow = document.getElementById('subrun-arrow-' + runId);
    if (body) body.style.display = _subrunExpanded[runId] ? 'block' : 'none';
    if (arrow) arrow.textContent = _subrunExpanded[runId] ? '▼' : '▶';
  }
  window._toggleSubrun = _toggleSubrun;

  container.innerHTML = agentRuns.map(r => {
    const rid = esc(r.runId || Math.random().toString(36).slice(2));
    const fullTask = r.task || r.taskPreview || '';
    const isLong = fullTask.length > 120;
    return `
      <div class="subrun-card ${r.isActive ? 'active' : ''} ${r.hasError ? 'has-error' : ''}" onclick="_toggleSubrun('${rid}')" style="cursor:pointer">
        <div class="subrun-header">
          <span class="card-badge ${r.hasError ? 'badge-error' : r.isActive ? 'badge-active' : 'badge-done'}">
            ${r.hasError ? '🚨 错误' : r.isActive ? '🟢 运行中' : '⚪ 已完成'}
          </span>
          <div class="subrun-label">${esc(r.label || '(未命名)')}</div>
          <div class="subrun-time">${timeAgo(r.createdAt)}</div>
          <span class="subrun-toggle" id="subrun-arrow-${rid}">▶</span>
        </div>
        <div class="subrun-task-preview">${esc(fullTask.slice(0, 100))}${isLong ? '…' : ''}</div>
        <div class="subrun-body" id="subrun-body-${rid}" style="display:none">
          ${r.hasError ? `<div class="subrun-error-msg">🚨 ${esc(r.errorMsg || '运行失败')}</div>` : ''}
          <div class="subrun-full-task"><div class="subrun-field-label">完整任务描述</div><div class="subrun-field-val">${esc(fullTask)}</div></div>
          <div class="subrun-detail-grid">
            <div class="subrun-detail-item"><span class="subrun-field-label">Run ID</span><span class="subrun-field-mono">${esc(r.runId||'—')}</span></div>
            <div class="subrun-detail-item"><span class="subrun-field-label">模型</span><span>${esc(r.model||'—')}</span></div>
            <div class="subrun-detail-item"><span class="subrun-field-label">创建时间</span><span>${fmtTime(r.createdAt)}</span></div>
            <div class="subrun-detail-item"><span class="subrun-field-label">结束时间</span><span>${r.endedAt ? fmtTime(r.endedAt) : '运行中'}</span></div>
            ${r.endedReason ? `<div class="subrun-detail-item"><span class="subrun-field-label">结束原因</span><span>${esc(r.endedReason)}</span></div>` : ''}
            ${r.childSessionKey ? `<div class="subrun-detail-item subrun-detail-full"><span class="subrun-field-label">Session</span><span class="subrun-field-mono">${esc(r.childSessionKey)}</span></div>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
  } catch(e) {
    container.innerHTML = `<div style="color:#f87171">加载失败: ${esc(e.message)}</div>`;
  }
}

/* ── Cron ── */
/* ── v1.8: renderCronJobsInTasks ── 渲染 Cron Jobs 到任务大厅 ─────────────── */
async function renderCronJobsInTasks() {
  const container = document.getElementById('taskCronList');
  const badge = document.getElementById('cronCountBadge');
  if (!container) return;
  try {
    const jobs = await API.get('/api/cron');
    if (badge) {
      badge.textContent = jobs.length > 0 ? jobs.length : '';
      badge.style.display = jobs.length > 0 ? 'inline-block' : 'none';
    }
    if (!jobs.length) {
      safeSetHTML(container, emptyState('暂无定时任务'));
      return;
    }
    const newHtml = jobs.map(j => `
      <div class="cron-card ${j.hasError ? 'cron-error' : ''}">
        <div class="cron-schedule">${esc(j.cron || (j.schedule && j.schedule.expr) || j.schedule || '—')}</div>
        <div class="cron-body">
          <div class="cron-name">
            ${j.hasError ? '🚨 ' : (j.enabled === false ? '⏸ ' : '✅ ')}
            ${esc(j.label || j.name || j.id || '(未命名)')}
          </div>
          ${j.hasError ? `<div class="cron-error-msg">${esc(j.errorMsg || '最近执行失败')}</div>` : ''}
          <div class="cron-task">${esc((j.task || (j.payload && j.payload.message) || j.prompt || '').slice(0, 200))}</div>
          <div class="cron-meta">
            模型: ${esc(j.model || '—')} ·
            最后运行: ${timeAgo(j.state && j.state.lastRunAtMs)} ·
            ${j.enabled === false ? '⏸ 已禁用' : '✅ 启用'}
          </div>
        </div>
      </div>
    `).join('');
    safeSetHTML(container, newHtml);
  } catch(e) {
    safeSetHTML(container, `<div style="color:#f87171">加载定时任务失败: ${esc(e.message)}</div>`);
  }
}

/* ── Logs ── */
async function loadLogs() {
  const container = document.getElementById('logsList');
  container.innerHTML = '<div style="color:#64748b;padding:20px">加载中...</div>';
  try {
    const logs = await API.get('/api/logs?limit=100');
    if (!logs.length) { container.innerHTML = emptyState('暂无日志'); return; }
    container.innerHTML = logs.map(l => {
      const keyVal = l.sessionKey || l.senderId || '—';
      return `
      <div class="log-row">
        <span class="log-time">${fmtTime(l.timestamp)}</span>
        <span class="log-action">${esc(l.action || '—')}</span>
        <span class="log-source">${esc(l.source || '—')}</span>
        <span class="log-key-wrap">
          <span class="log-key" title="${esc(keyVal)}">${esc(keyVal)}</span>
          <button class="log-copy-btn" title="复制" onclick="navigator.clipboard.writeText(${JSON.stringify(keyVal)}).then(()=>{this.textContent='✅';setTimeout(()=>{this.textContent='📋'},1200)})">📋</button>
        </span>
      </div>
    `}).join('');
  } catch(e) {
    container.innerHTML = `<div style="color:#f87171">加载失败: ${e.message}</div>`;
  }
}

/* ── Utils ── */
function emptyState(text) {
  return `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">${text}</div></div>`;
}

/* ── Refresh button ── */
document.getElementById('refreshBtn').addEventListener('click', () => {
  loadPage(currentPage);
});

// Toggle auto-refresh
document.getElementById('autoRefreshIndicator') && document.getElementById('autoRefreshIndicator').addEventListener('click', () => {
  autoRefreshEnabled = !autoRefreshEnabled;
  Object.values(pageTimers).forEach(t => clearInterval(t));
  Object.keys(pageTimers).forEach(k => delete pageTimers[k]);
  if (autoRefreshEnabled) {
    pageTimers[currentPage] = setInterval(() => {
      if (currentPage) loadPage(currentPage);
    }, REFRESH_INTERVAL);
    connectSSE();
  } else {
    if (sseConn) sseConn.close();
  }
  updateRefreshIndicator();
});

/* ── Init ── */
connectSSE();
updateRefreshIndicator();
loadOverview();

/* ── v1.2 Analytics ──────────────────────────────────────────────────────── */

// Chart instances (keep refs for destroy on re-render)
let _agentChart = null;
let _modelChart = null;
let _trendChart = null; // v1.7 每日Token趋势图

async function loadAnalytics() {
  document.getElementById('analyticsUpdate').textContent = '加载中...';
  try {
    const [tokens, system] = await Promise.all([
      API.get('/api/analytics/tokens'),
      API.get('/api/analytics/system'),
    ]);
    renderSystemStats(system);
    renderTokenAnalytics(tokens);
    loadDiskMonitor();
    document.getElementById('analyticsUpdate').textContent = '更新于 ' + fmtTime(Date.now());
  } catch (e) {
    document.getElementById('systemGrid').innerHTML = `<div class="sys-card" style="color:#f87171">加载失败: ${e.message}</div>`;
  }
}

// v1.12: 系统状态 Banner — 紧凑单行摘要
function renderSystemStats(s) {
  const cpu = s.cpu || {};
  const mem = s.memory || {};
  const cpuPct = cpu.usagePercent || 0;
  const memPct = mem.usagePercent || 0;
  const cpuClass = cpuPct > 80 ? 'banner-danger' : cpuPct > 50 ? 'banner-warn' : 'banner-ok';
  const memClass = memPct > 85 ? 'banner-danger' : memPct > 65 ? 'banner-warn' : 'banner-ok';
  const uptimeSec = s.uptime || 0;
  const uptimeStr = uptimeSec < 3600
    ? Math.floor(uptimeSec / 60) + 'min'
    : uptimeSec < 86400
      ? Math.floor(uptimeSec / 3600) + 'h'
      : Math.floor(uptimeSec / 86400) + 'd';

  document.getElementById('systemGrid').innerHTML = `
    <span class="sys-banner-item">
      <span class="sys-banner-icon">⚡</span>
      <span class="sys-banner-label">CPU</span>
      <span class="sys-banner-val ${cpuClass}">${cpuPct}%</span>
    </span>
    <span class="sys-banner-sep">·</span>
    <span class="sys-banner-item">
      <span class="sys-banner-icon">🧠</span>
      <span class="sys-banner-label">内存</span>
      <span class="sys-banner-val ${memClass}">${memPct}%</span>
      <span class="sys-banner-sub">(${mem.usedFormatted||'?'}/${mem.totalFormatted||'?'})</span>
    </span>
    <span class="sys-banner-sep">·</span>
    <span class="sys-banner-item">
      <span class="sys-banner-icon">📈</span>
      <span class="sys-banner-label">负载</span>
      <span class="sys-banner-val">${cpu.loadAvg1||'?'}</span>
    </span>
    <span class="sys-banner-sep">·</span>
    <span class="sys-banner-item">
      <span class="sys-banner-icon">⏱</span>
      <span class="sys-banner-label">运行</span>
      <span class="sys-banner-val">${uptimeStr}</span>
    </span>
    <span class="sys-banner-sep">·</span>
    <span class="sys-banner-item">
      <span class="sys-banner-sub">${esc(s.hostname||'')} ${esc(s.platform||'')} ${esc(s.arch||'')}</span>
    </span>
  `;

  // Gauges 紧凑进度
  document.getElementById('systemGauges').innerHTML = `
    <span class="sys-banner-gauge">
      <span class="sys-banner-gauge-fill ${cpuClass}" style="width:${Math.min(100,cpuPct)}%"></span>
    </span>
    <span class="sys-banner-gauge">
      <span class="sys-banner-gauge-fill ${memClass}" style="width:${Math.min(100,memPct)}%"></span>
    </span>
  `;
}

function renderTokenAnalytics(data) {
  const grandTotal = data.grandTotal || 0;
  const grandInput = data.grandInput || 0;
  const grandOutput = data.grandOutput || 0;
  const grandCacheRead = data.grandCacheRead || 0;
  const grandMessages = data.grandMessages || 0;
  // Summary cards
  document.getElementById('tokenSummaryCards').innerHTML = `
    <div class="token-summary-card">
      <div class="token-summary-label">总 Token 消耗</div>
      <div class="token-summary-value">${numFmt(grandTotal)}</div>
      <div class="token-summary-sub">输入 + 输出</div>
    </div>
    <div class="token-summary-card">
      <div class="token-summary-label">输入 Tokens</div>
      <div class="token-summary-value" style="color:#34d399">${numFmt(grandInput)}</div>
      <div class="token-summary-sub">含缓存命中 ${numFmt(grandCacheRead)}</div>
    </div>
    <div class="token-summary-card">
      <div class="token-summary-label">输出 Tokens</div>
      <div class="token-summary-value" style="color:#f472b6">${numFmt(grandOutput)}</div>
      <div class="token-summary-sub">模型生成内容</div>
    </div>
    <div class="token-summary-card">
      <div class="token-summary-label">总消息轮次</div>
      <div class="token-summary-value" style="color:#fb923c">${numFmt(grandMessages)}</div>
      <div class="token-summary-sub">助手回复次数</div>
    </div>
  `;

  // ── Agent 柱状图 ──
  const agentEntries = Object.entries(data.perAgent || {})
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  const agentLabels = agentEntries.map(([k]) => k);
  const agentInputData = agentEntries.map(([, v]) => v.input);
  const agentOutputData = agentEntries.map(([, v]) => v.output);

  const agentCtx = document.getElementById('agentTokenChart').getContext('2d');
  if (agentEntries.length > 0) {
    if (_agentChart) {
      // 差量更新，避免进场动画重绘
      _agentChart.data.labels = agentLabels;
      _agentChart.data.datasets[0].data = agentInputData;
      _agentChart.data.datasets[1].data = agentOutputData;
      _agentChart.update('none');
    } else {
      _agentChart = new Chart(agentCtx, {
        type: 'bar',
        data: {
          labels: agentLabels,
          datasets: [
            {
              label: '输入 Tokens',
              data: agentInputData,
              backgroundColor: 'rgba(52,211,153,0.7)',
              borderColor: '#34d399',
              borderWidth: 1,
            },
            {
              label: '输出 Tokens',
              data: agentOutputData,
              backgroundColor: 'rgba(244,114,182,0.7)',
              borderColor: '#f472b6',
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            legend: { labels: { color: '#94a3b8', font: { size: 11 } } },
            tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${numFmt(ctx.parsed.y)}` } },
          },
          scales: {
            x: { ticks: { color: '#64748b' }, grid: { color: '#1e2a3a' } },
            y: { ticks: { color: '#64748b', callback: v => numFmt(v) }, grid: { color: '#1e2a3a' } },
          },
        },
      });
    }
  } else {
    if (_agentChart) { _agentChart.destroy(); _agentChart = null; }
    agentCtx.canvas.parentElement.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-text">暂无 Agent 数据</div></div>';
  }

  // ── 模型饼图 ──
  const modelEntries = Object.entries(data.perModel || {})
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    .slice(0, 10);
  const modelLabels = modelEntries.map(([k]) => k.split('/').pop().slice(0, 24));
  const modelData = modelEntries.map(([, v]) => v.totalTokens);
  const palette = [
    '#60a5fa','#34d399','#f472b6','#fb923c','#a78bfa',
    '#facc15','#38bdf8','#4ade80','#c084fc','#f87171'
  ];

  const modelCtx = document.getElementById('modelTokenChart').getContext('2d');
  if (modelEntries.length > 0) {
    if (_modelChart) {
      // 差量更新，避免进场动画重绘
      _modelChart.data.labels = modelLabels;
      _modelChart.data.datasets[0].data = modelData;
      _modelChart.data.datasets[0].backgroundColor = palette.slice(0, modelEntries.length);
      _modelChart.update('none');
    } else {
      _modelChart = new Chart(modelCtx, {
        type: 'doughnut',
        data: {
          labels: modelLabels,
          datasets: [{
            data: modelData,
            backgroundColor: palette.slice(0, modelEntries.length),
            borderColor: '#161b27',
            borderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          plugins: {
            legend: { position: 'right', labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 } },
            tooltip: { callbacks: { label: ctx => `${ctx.label}: ${numFmt(ctx.parsed)} tokens` } },
          },
        },
      });
    }
  } else {
    if (_modelChart) { _modelChart.destroy(); _modelChart = null; }
    modelCtx.canvas.parentElement.innerHTML = '<div class="empty-state"><div class="empty-icon">🧠</div><div class="empty-text">暂无模型数据</div></div>';
  }

  // ── Agent 详细表格 ──
  if (agentEntries.length > 0) {
    const rows = agentEntries.map(([name, v]) => {
      const pct = grandTotal > 0 ? ((v.totalTokens / grandTotal) * 100).toFixed(1) : 0;
      const modelRows = Object.entries(v.models || {})
        .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
        .map(([m, mv]) => `
          <tr class="subrow">
            <td>↳ ${esc(m)}</td>
            <td class="num">${numFmt(mv.totalTokens)}</td>
            <td class="num">${numFmt(mv.input)}</td>
            <td class="num">${numFmt(mv.output)}</td>
            <td class="num">${mv.messages}</td>
          </tr>
        `).join('');
      return `
        <tr>
          <td class="highlight">🤖 ${esc(name)}</td>
          <td class="num">
            ${numFmt(v.totalTokens)}
            <span class="mini-bar-wrap"><span class="mini-bar" style="width:${pct}%"></span></span>
          </td>
          <td class="num">${numFmt(v.input||0)}</td>
          <td class="num" style="font-size:11px;color:#60a5fa">${v.cacheRead ? numFmt(v.cacheRead) : '-'}</td>
          <td class="num">${numFmt(v.output)}</td>
          <td class="num">${v.messages}</td>
        </tr>
        ${modelRows}
      `;
    }).join('');
    document.getElementById('agentTokenTable').innerHTML = `
      <table class="analytics-table">
        <thead><tr>
          <th>Agent</th><th class="num">总 Tokens</th><th class="num">输入</th><th class="num" style="color:#60a5fa">缓存读取</th><th class="num">输出</th><th class="num">消息数</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } else {
    document.getElementById('agentTokenTable').innerHTML = emptyState('暂无 Agent Token 数据');
  }

  // ── 模型详细表格 ──
  const allModelEntries = Object.entries(data.perModel || {}).sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  if (allModelEntries.length > 0) {
    const rows = allModelEntries.map(([model, v]) => {
      const pct = grandTotal > 0 ? ((v.totalTokens / grandTotal) * 100).toFixed(1) : 0;
      return `
        <tr>
          <td class="highlight">🧠 ${esc(model)}</td>
          <td class="num">
            ${numFmt(v.totalTokens)}
            <span class="mini-bar-wrap"><span class="mini-bar" style="width:${pct}%"></span></span>
          </td>
          <td class="num">${numFmt(v.input)}</td>
          <td class="num">${numFmt(v.output)}</td>
          <td class="num">${v.messages}</td>
        </tr>
      `;
    }).join('');
    document.getElementById('modelTokenTable').innerHTML = `
      <table class="analytics-table">
        <thead><tr>
          <th>模型</th><th class="num">总 Tokens</th><th class="num">输入</th><th class="num">输出</th><th class="num">消息数</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } else {
    document.getElementById('modelTokenTable').innerHTML = emptyState('暂无模型 Token 数据');
  }

  // ── v1.7 每日 Token 消耗趋势折线图 ──
  const trendData = data.dailyTrend || [];
  const trendCanvas = document.getElementById('tokenTrendChart');
  if (trendCanvas) {
    const trendCtx = trendCanvas.getContext('2d');
    if (trendData.length > 0) {
      const trendLabels = trendData.map(d => d.date);
      const trendTotals = trendData.map(d => d.total);
      if (_trendChart) {
        _trendChart.data.labels = trendLabels;
        _trendChart.data.datasets[0].data = trendTotals;
        _trendChart.update('none');
      } else {
        _trendChart = new Chart(trendCtx, {
          type: 'line',
          data: {
            labels: trendLabels,
            datasets: [{
              label: '每日 Token 消耗',
              data: trendTotals,
              borderColor: '#60a5fa',
              backgroundColor: 'rgba(96,165,250,0.15)',
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: '#60a5fa',
              fill: true,
              tension: 0.3,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: { labels: { color: '#94a3b8', font: { size: 11 } } },
              tooltip: { callbacks: { label: ctx => `Total: ${numFmt(ctx.parsed.y)} tokens` } },
            },
            scales: {
              x: {
                ticks: {
                  color: '#64748b',
                  maxRotation: 45,
                  maxTicksLimit: window.innerWidth < 768 ? 5 : 14,
                  font: { size: window.innerWidth < 768 ? 9 : 11 },
                },
                grid: { color: '#1e2a3a' },
              },
              y: { ticks: { color: '#64748b', callback: v => numFmt(v), font: { size: window.innerWidth < 768 ? 9 : 11 } }, grid: { color: '#1e2a3a' } },
            },
          },
        });
      }
    } else {
      if (_trendChart) { _trendChart.destroy(); _trendChart = null; }
      trendCanvas.parentElement.innerHTML = '<div class="empty-state"><div class="empty-icon">📈</div><div class="empty-text">暂无趋势数据</div></div>';
    }
  }
}

/* ── v1.3 异常雷达 (Error Radar) ─────────────────────────────────────────── */

// 缓存最新数据，用于前端过滤
let _radarGatewayData = null;

async function loadErrorRadar() {
  document.getElementById('radarUpdate').textContent = '加载中...';
  document.getElementById('gatewayLogList').innerHTML = '<div class="radar-loading">正在扫描网关日志...</div>';
  document.getElementById('cronHealthList').innerHTML = '<div class="radar-loading">正在检查 Cron 任务...</div>';

  try {
    const [gwData, cronData] = await Promise.all([
      API.get('/api/errors/gateway'),
      API.get('/api/errors/cron'),
    ]);

    _radarGatewayData = gwData;
    renderGatewayLogs(gwData);
    renderCronHealth(cronData);
    document.getElementById('radarUpdate').textContent = '更新于 ' + fmtTime(Date.now());

    // 更新侧边栏角标
    const totalErrors = (gwData.entries || []).filter(e => e.level === 'ERROR').length + (cronData.errorCount || 0);
    const badge = document.getElementById('radarBadge');
    if (badge) {
      if (totalErrors > 0) {
        badge.textContent = totalErrors > 99 ? '99+' : totalErrors;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch (e) {
    document.getElementById('gatewayLogList').innerHTML = `<div class="radar-error">加载失败: ${esc(e.message)}</div>`;
  }
}

function renderGatewayLogs(data) {
  const entries = data.entries || [];
  const logFiles = data.logFiles || [];

  // 更新文件名提示
  const filesEl = document.getElementById('gatewayLogFiles');
  if (filesEl) filesEl.textContent = logFiles.length > 0 ? `来源: ${logFiles.join(', ')}` : '';

  // 更新计数角标
  const errorCount = entries.filter(e => e.level === 'ERROR').length;
  const warnCount = entries.filter(e => e.level === 'WARN').length;
  const countEl = document.getElementById('gatewayErrorCount');
  if (countEl) {
    countEl.textContent = entries.length > 0
      ? `ERROR: ${errorCount} · WARN: ${warnCount} · 共 ${data.total} 条`
      : '无告警';
    countEl.className = errorCount > 0 ? 'radar-count-badge radar-badge-error' : warnCount > 0 ? 'radar-count-badge radar-badge-warn' : 'radar-count-badge radar-badge-ok';
  }

  renderGatewayLogEntries(entries);

  // 绑定过滤复选框事件（每次渲染时重新绑定）
  const cbError = document.getElementById('filterError');
  const cbWarn = document.getElementById('filterWarn');
  function applyFilter() {
    if (!_radarGatewayData) return;
    const showError = cbError && cbError.checked;
    const showWarn = cbWarn && cbWarn.checked;
    const filtered = (_radarGatewayData.entries || []).filter(e => {
      if (e.level === 'ERROR') return showError;
      if (e.level === 'WARN') return showWarn;
      return true;
    });
    renderGatewayLogEntries(filtered);
  }
  if (cbError) { cbError.onchange = applyFilter; }
  if (cbWarn) { cbWarn.onchange = applyFilter; }
}

function renderGatewayLogEntries(entries) {
  const container = document.getElementById('gatewayLogList');
  if (!container) return;

  if (entries.length === 0) {
    safeSetHTML(container, `
      <div class="radar-empty">
        <div class="radar-empty-icon">✅</div>
        <div class="radar-empty-text">当前过滤条件下无告警日志</div>
      </div>`);
    return;
  }

  // Anti-flicker: build full HTML string first, then diff-update
  const _newGwHtml = entries.map(e => {
    const isError = e.level === 'ERROR';
    const levelClass = isError ? 'radar-log-error' : 'radar-log-warn';
    const levelIcon = isError ? '🔴' : '🟡';

    // 截断长消息，保留可展开
    const shortMsg = e.message.length > 200 ? e.message.slice(0, 200) + '…' : e.message;
    const hasMore = e.message.length > 200;
    const msgId = 'rmsg-' + Math.random().toString(36).slice(2);

    return `
      <div class="radar-log-row ${levelClass}">
        <div class="radar-log-header">
          <span class="radar-log-level">${levelIcon} ${esc(e.level)}</span>
          <span class="radar-log-subsystem">${esc(e.subsystem || '—')}</span>
          <span class="radar-log-time">${fmtTime(e.time)}</span>
          <span class="radar-log-file">${esc(e.file || '')}</span>
        </div>
        <div class="radar-log-msg" id="${msgId}">${esc(shortMsg)}</div>
        ${hasMore ? `<button class="radar-expand-btn" onclick="
          const el = document.getElementById('${msgId}');
          const btn = this;
          if (btn.dataset.expanded === '1') {
            el.textContent = ${JSON.stringify(shortMsg)};
            btn.textContent = '展开';
            btn.dataset.expanded = '0';
          } else {
            el.textContent = ${JSON.stringify(e.message)};
            btn.textContent = '收起';
            btn.dataset.expanded = '1';
          }
        " data-expanded="0">展开</button>` : ''}
      </div>`;
  }).join('');
  safeSetHTML(container, _newGwHtml);
}

function renderCronHealth(data) {
  const errorJobs = data.errorJobs || [];
  const totalJobs = data.totalJobs || 0;
  const errorCount = data.errorCount || 0;

  const countEl = document.getElementById('cronErrorCount');
  if (countEl) {
    countEl.textContent = errorCount > 0
      ? `⚠ ${errorCount} 个任务异常 / 共 ${totalJobs} 个`
      : `✅ 全部 ${totalJobs} 个任务正常`;
    countEl.className = errorCount > 0 ? 'radar-count-badge radar-badge-error' : 'radar-count-badge radar-badge-ok';
  }

  const container = document.getElementById('cronHealthList');
  if (!container) return;

  if (errorJobs.length === 0) {
    safeSetHTML(container, `
      <div class="radar-empty">
        <div class="radar-empty-icon">✅</div>
        <div class="radar-empty-text">所有定时任务健康运行，无静默失败</div>
        <div class="radar-empty-sub">共 ${totalJobs} 个任务</div>
      </div>`);
    return;
  }

  const _newCronHtml = errorJobs.map(j => {
    const schedExpr = j.schedule ? (j.schedule.expr || j.schedule) : '—';
    const errorsText = j.consecutiveErrors > 0 ? `连续失败 ${j.consecutiveErrors} 次` : '最近1次失败';
    return `
      <div class="radar-cron-card">
        <div class="radar-cron-header">
          <span class="radar-cron-badge">🚨 FAILED</span>
          <span class="radar-cron-name">${esc(j.name)}</span>
          <span class="radar-cron-agent">agent:${esc(j.agentId || '—')}</span>
        </div>
        ${j.description ? `<div class="radar-cron-desc">${esc(j.description)}</div>` : ''}
        <div class="radar-cron-meta">
          <span class="radar-cron-tag radar-cron-tag-error">⚠ ${esc(errorsText)}</span>
          <span class="radar-cron-tag">📅 ${esc(schedExpr)}</span>
          ${!j.enabled ? '<span class="radar-cron-tag radar-cron-tag-disabled">⏸ 已禁用</span>' : ''}
          <span class="radar-cron-tag">最后运行: ${timeAgo(j.lastRunAtMs)}</span>
        </div>
        ${j.lastError ? `<div class="radar-cron-error-detail">💥 ${esc(j.lastError)}</div>` : ''}
      </div>`;
  }).join('');
  safeSetHTML(container, _newCronHtml);
}


/* ── v1.4: Knowledge Map ── */

let _skillChart = null;

async function loadKnowledge() {
  try {
    const [memData, skillData] = await Promise.all([
      API.get('/api/knowledge/memory'),
      API.get('/api/knowledge/skills'),
    ]);
    renderKnowledgeStats(memData);
    renderKnowledgeAgents(memData);
    renderSkillTree(skillData);
    const upEl = document.getElementById('knowledgeUpdate');
    if (upEl) upEl.textContent = '已更新 · ' + fmtTime(Date.now());
  } catch (e) {
    const g = document.getElementById('knowledgeStatsGrid');
    if (g) g.innerHTML = `<div class="stat-card" style="color:#f87171">加载失败: ${esc(e.message)}</div>`;
  }
}

function renderKnowledgeStats(data) {
  const grid = document.getElementById('knowledgeStatsGrid');
  if (!grid) return;

  const lastLearn = data.latestMtime
    ? timeAgo(data.latestMtime) + ' (' + fmtTime(data.latestMtime) + ')'
    : '暂无记录';

  grid.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">📄 记忆文件总数</div>
      <div class="stat-value" style="color:#60a5fa">${data.totalFiles}</div>
      <div class="stat-sub">长期记忆 + 每日记录</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">📝 总记录行数</div>
      <div class="stat-value" style="color:#4ade80">${numFmt(data.totalLines)}</div>
      <div class="stat-sub">约 ${numFmt(data.totalWords)} 词</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">🤖 记忆 Agent 数</div>
      <div class="stat-value" style="color:#f59e0b">${(data.perAgent || []).length}</div>
      <div class="stat-sub">各自独立记忆空间</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">⏱️ 最后学习时间</div>
      <div class="stat-value" style="font-size:14px;padding-top:10px;line-height:1.4">${esc(lastLearn)}</div>
      <div class="stat-sub">记忆更新频率</div>
    </div>
  `;
}

function renderKnowledgeAgents(data) {
  const container = document.getElementById('knowledgeAgentList');
  if (!container) return;
  const agents = data.perAgent || [];
  if (agents.length === 0) {
    container.innerHTML = emptyState('暂无记忆文件');
    return;
  }

  container.innerHTML = agents.map(a => {
    const dailyCount = (a.files || []).filter(f => f.type === 'daily').length;
    const ltCount = (a.files || []).filter(f => f.type === 'longterm').length;
    const fileRows = (a.files || []).slice(0, 5).map(f => `
      <div class="km-file-row">
        <span class="km-file-type ${f.type === 'longterm' ? 'km-lt' : 'km-daily'}">${f.type === 'longterm' ? '⭐长期' : '📅每日'}</span>
        <span class="km-file-name">${esc(f.filename)}</span>
        <span class="km-file-stat">${f.lines} 行 / ${numFmt(f.words)} 词</span>
        <span class="km-file-time">${timeAgo(f.mtime)}</span>
      </div>
    `).join('');

    return `
      <div class="knowledge-agent-card">
        <div class="knowledge-agent-header">
          <span class="knowledge-agent-name">🤖 agent:${esc(a.agentId)}</span>
          <div class="knowledge-agent-badges">
            <span class="km-badge km-badge-lt">⭐ 长期 ×${ltCount}</span>
            <span class="km-badge km-badge-daily">📅 每日 ×${dailyCount}</span>
            <span class="km-badge">📄 共 ${a.fileCount} 文件</span>
          </div>
        </div>
        <div class="knowledge-agent-stats">
          ${numFmt(a.lines)} 行 · ${numFmt(a.words)} 词 · 最后更新 ${timeAgo(a.latestMtime)}
        </div>
        ${fileRows ? `<div class="km-file-list">${fileRows}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderSkillTree(data) {
  const container = document.getElementById('knowledgeSkillChart');
  if (!container) return;

  const metaEl = document.getElementById('skillMeta');
  if (metaEl) {
    metaEl.innerHTML = `
      <span class="skill-meta-item">🔍 扫描 Session: <strong>${data.totalSessionsScanned}</strong></span>
      <span class="skill-meta-item">🛠️ 独立工具数: <strong>${data.uniqueTools}</strong></span>
      <span class="skill-meta-item">📊 总调用次数: <strong>${numFmt(data.totalToolCalls)}</strong></span>
    `;
  }

  const ranking = (data.ranking || []).slice(0, 20);
  if (ranking.length === 0) {
    container.innerHTML = emptyState('暂无工具调用记录');
    return;
  }

  const maxCount = ranking[0].count;

  // 工具颜色映射
  const toolColorMap = {
    exec: '#f59e0b',
    browser: '#60a5fa',
    web_search: '#34d399',
    web_fetch: '#10b981',
    feishu_doc: '#a78bfa',
    feishu_wiki: '#c084fc',
    feishu_bitable_list_records: '#e879f9',
    feishu_bitable_get_meta: '#f0abfc',
    feishu_bitable_create_record: '#f472b6',
    feishu_bitable_update_record: '#fb7185',
    read: '#94a3b8',
    write: '#7dd3fc',
    edit: '#6ee7b7',
    canvas: '#fbbf24',
    nodes: '#f87171',
    tts: '#4ade80',
    message: '#38bdf8',
    subagents: '#e2e8f0',
  };

  function getColor(name) {
    if (toolColorMap[name]) return toolColorMap[name];
    // feishu_* 统一紫色系
    if (name.startsWith('feishu_')) return '#c084fc';
    return '#64748b';
  }

  container.innerHTML = `
    <div class="skill-chart-wrap">
      ${ranking.map((item, idx) => {
        const barWidth = maxCount > 0 ? ((item.count / maxCount) * 100).toFixed(1) : 0;
        const color = getColor(item.name);
        return `
          <div class="skill-row">
            <div class="skill-rank">${idx + 1}</div>
            <div class="skill-name">${esc(item.name)}</div>
            <div class="skill-bar-wrap">
              <div class="skill-bar" style="width:${barWidth}%;background:${color}"></div>
            </div>
            <div class="skill-count">${numFmt(item.count)}</div>
            <div class="skill-pct">${item.percent}%</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}


/* ── v1.5: 任务作战大厅 (Task Center) ────────────────────────────────────── */

// 缓存上次渲染的任务数据哈希（用于防闪烁对比）


// ─────────────────────────────────────────────────────────────────────────────
// v1.6 KPI Performance Board
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 将毫秒转为易读的 hh小时mm分ss秒 格式
 */
function fmtWorkTime(ms) {
  if (!ms || ms <= 0) return '0秒';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

async function loadKpi() {
  try {
    const data = await API.get('/api/analytics/kpi');
    renderKpi(data);
    document.getElementById('kpiUpdate').textContent = '更新时间: ' + fmtTime(data.generatedAt);
  // v1.11: 工时统计
  } catch (e) {
    safeSetHTMLById('kpiSummaryGrid', `<div class="stat-card" style="color:#f87171">加载失败: ${esc(e.message)}</div>`);
    safeSetHTMLById('kpiRankingBoard', '');
  }
}

function renderKpi(data) {
  const agents = data.agents || [];
  const totalWorkTimeMs = data.totalWorkTimeMs || 0;
  const totalTaskCount = data.totalTaskCount || 0;
  const activeAgents = agents.filter(a => a.taskCount > 0).length;

  // ── 汇总卡片 ──
  const summaryHtml = `
    <div class="stat-card">
      <div class="stat-label">👤 参与考核员工</div>
      <div class="stat-value">${agents.length}</div>
      <div class="stat-sub">活跃 ${activeAgents} 人</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">⏱️ 全员累计工时</div>
      <div class="stat-value">${fmtWorkTime(totalWorkTimeMs)}</div>
      <div class="stat-sub">含碎片工具工时</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">📦 总接单数</div>
      <div class="stat-value">${totalTaskCount}</div>
      <div class="stat-sub">Subagent 任务</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">🔧 全员工具调用</div>
      <div class="stat-value">${numFmt(agents.reduce((s, a) => s + a.toolCallCount, 0))}</div>
      <div class="stat-sub">碎片工具执行次数</div>
    </div>
  `;
  safeSetHTMLById('kpiSummaryGrid', summaryHtml);

  // ── 排行榜 ──
  if (agents.length === 0) {
    safeSetHTMLById('kpiRankingBoard', '<div class="kanban-empty"><span>🕳️</span><div>暂无考核数据</div></div>');
    return;
  }

  // 计算最大工时（用于进度条）
  const maxWorkTime = Math.max(...agents.map(a => a.totalWorkTimeMs), 1);

  const rowsHtml = agents.map((agent, idx) => {
    const rank = idx + 1;
    const rankEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
    const barPct = Math.round((agent.totalWorkTimeMs / maxWorkTime) * 100);

    // 顶部工具
    const topToolsHtml = agent.topTools && agent.topTools.length > 0
      ? agent.topTools.map(t => `<span class="kpi-tool-tag" title="${esc(fmtWorkTime(t.ms))}">${esc(t.name)}</span>`).join('')
      : '<span class="kpi-tool-tag kpi-tool-empty">暂无工具数据</span>';

    // 任务完成率
    const completionRate = agent.taskCount > 0
      ? Math.round((agent.completedCount / agent.taskCount) * 100)
      : 0;

    return `
      <div class="kpi-row ${rank <= 3 ? 'kpi-row-top' : ''}">
        <div class="kpi-rank">${rankEmoji}</div>
        <div class="kpi-agent-info">
          <div class="kpi-agent-name">
            <span class="kpi-emoji">${esc(agent.identity.emoji)}</span>
            <strong>${esc(agent.identity.name)}</strong>
          </div>
        </div>
        <div class="kpi-work-time">
          <div class="kpi-time-main">${fmtWorkTime(agent.totalWorkTimeMs)}</div>
          <div class="kpi-time-bar">
            <div class="kpi-time-bar-fill" style="width:${barPct}%"></div>
          </div>
          <div class="kpi-time-sub">
            <span title="长时任务工时">📋 ${fmtWorkTime(agent.taskRunTimeMs)}</span>
            <span title="碎片工具工时">🔧 ${fmtWorkTime(agent.fragmentMs)}</span>
          </div>
        </div>
        <div class="kpi-stats">
          <div class="kpi-stat-item">
            <span class="kpi-stat-label">接单</span>
            <span class="kpi-stat-val">${agent.taskCount}</span>
          </div>
          <div class="kpi-stat-item">
            <span class="kpi-stat-label">完成</span>
            <span class="kpi-stat-val kpi-done">${agent.completedCount}</span>
          </div>
          <div class="kpi-stat-item">
            <span class="kpi-stat-label">完成率</span>
            <span class="kpi-stat-val">${completionRate}%</span>
          </div>
          <div class="kpi-stat-item">
            <span class="kpi-stat-label">工具调用</span>
            <span class="kpi-stat-val">${numFmt(agent.toolCallCount)}</span>
          </div>
        </div>
        <div class="kpi-top-tools">
          <div class="kpi-tools-label">主力工具</div>
          <div class="kpi-tools-list">${topToolsHtml}</div>
        </div>
      </div>
    `;
  }).join('');

  safeSetHTMLById('kpiRankingBoard', `<div class="kpi-table">${rowsHtml}</div>`);
}

/* ══════════════════════════════════════════════════════════════════════
   v1.10 新增：磁盘监控 / 任务搜索筛选详情 / Ops Toolbox
   ══════════════════════════════════════════════════════════════════════ */

/* ── v1.10: 磁盘监控 ─────────────────────────────────────────────────── */

async function loadDiskMonitor() {
  const wrap = document.getElementById('diskMonitor');
  if (!wrap) return;
  try {
    const data = await API.get('/api/analytics/disk');
    renderDiskMonitor(data);
  } catch(e) {
    if (wrap) wrap.innerHTML = `<div class="radar-error" style="padding:12px;color:#f87171">磁盘信息加载失败: ${esc(e.message)}</div>`;
  }
}

// v1.12: 磁盘监控 — Banner 紧凑模式（只显示摘要）
function renderDiskMonitor(data) {
  const wrap = document.getElementById('diskMonitor');
  if (!wrap) return;
  const mounts = data.mounts || [];

  if (mounts.length === 0) {
    wrap.innerHTML = '<span class="sys-banner-sub" style="color:#64748b">磁盘信息不可用</span>';
    return;
  }

  // 只展示关键挂载点的紧凑摘要
  const keyMounts = mounts.filter(m => ['/', '/root', '/home'].includes(m.mountpoint)).slice(0, 3);
  const items = (keyMounts.length > 0 ? keyMounts : mounts.slice(0, 2));
  wrap.innerHTML = items.map(m => {
    const cls = m.percent >= 95 ? 'banner-danger' : m.percent >= 85 ? 'banner-warn' : 'banner-ok';
    return `<span class="sys-banner-item">
      <span class="sys-banner-icon">💾</span>
      <span class="sys-banner-label">${esc(m.mountpoint)}</span>
      <span class="sys-banner-val ${cls}">${m.percent}%</span>
      <span class="sys-banner-sub">(${esc(m.freeFormatted)}剩余)</span>
    </span>`;
  }).join('<span class="sys-banner-sep">·</span>');

  // 磁盘告警注入：通过统一的 _diskAlerts + _mergeAndRenderAlerts 走 dismissed 过滤
  const dangerMounts = mounts.filter(m => m.percent >= 95);
  const warnMounts = mounts.filter(m => m.percent >= 85 && m.percent < 95);
  _diskAlerts = [
    ...dangerMounts.map(m => ({ message: `磁盘 ${m.mountpoint} 使用率 ${m.percent}% — 即将耗尽!`, severity: 'error' })),
    ...warnMounts.map(m => ({ message: `磁盘 ${m.mountpoint} 使用率 ${m.percent}% — 请关注`, severity: 'warning' })),
  ];
  _mergeAndRenderAlerts();
}

/* ── v1.10: 任务搜索/筛选/详情 ──────────────────────────────────────── */

let _allEnrichedTasks = [];
let _tasksSearchQ = '';
let _tasksStatusFilter = 'all';
let _tasksAgentFilter = '';

async function loadTasks() {
  const upEl = document.getElementById('tasksUpdate');
  if (upEl && !upEl.textContent) upEl.textContent = '加载中...';
  try {
    const data = await API.get('/api/tasks/enriched');
    _allEnrichedTasks = data.tasks || [];
    _syncAgentFilterOptions(_allEnrichedTasks);
    _applyTaskFilters();
    if (upEl) upEl.textContent = '更新于 ' + fmtTime(Date.now());
    renderCronJobsInTasks();

    const doingCount = _allEnrichedTasks.filter(t => t.status === 'doing').length;
    const badge = document.getElementById('tasksBadge');
    if (badge) {
      badge.textContent = doingCount > 99 ? '99+' : doingCount;
      badge.style.display = doingCount > 0 ? 'inline-block' : 'none';
    }
  } catch(e) {
    safeSetHTMLById('list-todo', `<div style="color:#f87171">加载失败: ${esc(e.message)}</div>`);
  }
}

function _syncAgentFilterOptions(tasks) {
  const sel = document.getElementById('tasksAgentFilter');
  if (!sel) return;
  const agents = [...new Set(tasks.map(t => t.agent).filter(Boolean))].sort();
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部 Agent</option>' + agents.map(a => `<option value="${esc(a)}"${a === cur ? ' selected' : ''}>${esc(a)}</option>`).join('');
}

function _applyTaskFilters() {
  const q = _tasksSearchQ.toLowerCase().trim();
  const status = _tasksStatusFilter;
  const agent = _tasksAgentFilter;

  const filtered = _allEnrichedTasks.filter(t => {
    if (status !== 'all' && t.status !== status) return false;
    if (agent && t.agent !== agent) return false;
    if (q) {
      const hay = [t.id, t.title, t.description, t.agent].join(' ').toLowerCase();
      if (!q.split(/\s+/).every(word => hay.includes(word))) return false;
    }
    return true;
  });

  const cntEl = document.getElementById('tasksResultCount');
  if (cntEl) cntEl.textContent = q || status !== 'all' || agent ? `共 ${filtered.length} / ${_allEnrichedTasks.length} 条` : '';

  renderTasksKanbanFiltered(filtered);
}

function renderTasksKanbanFiltered(tasks) {
  const STATUS_MAP = {
    todo:  { id: 'list-todo',  cnt: 'cnt-todo'  },
    doing: { id: 'list-doing', cnt: 'cnt-doing' },
    done:  { id: 'list-done',  cnt: 'cnt-done'  },
  };
  const grouped = { todo: [], doing: [], done: [] };
  for (const t of tasks) {
    const key = t.status in grouped ? t.status : 'todo';
    grouped[key].push(t);
  }
  for (const [status, col] of Object.entries(STATUS_MAP)) {
    const items = grouped[status] || [];
    const cntEl = document.getElementById(col.cnt);
    if (cntEl) cntEl.textContent = items.length;
    let html;
    if (items.length === 0) {
      const emptyTexts = {
        todo: ['⏳', '暂无排队任务', '一切就绪，等待新任务'],
        doing: ['🔥', '暂无进行中任务', '空闲中，随时待命'],
        done: ['✅', '已完成任务将在此显示', '干得漂亮，继续加油！'],
      };
      const et = emptyTexts[status] || ['🗃️', '暂无任务', ''];
      html = `<div class="kanban-empty"><span class="kanban-empty-icon">${et[0]}</span><div>${et[1]}</div><div class="kanban-empty-hint">${et[2]}</div></div>`;
    } else {
      html = items.map(t => renderTaskCardV10(t)).join('');
    }
    safeSetHTMLById(col.id, html);
  }
}

function renderTaskCardV10(t) {
  const statusClass = { todo:'task-card-todo', doing:'task-card-doing', done:'task-card-done' }[t.status] || '';
  const statusIcon = { todo:'⏳', doing:'🔥', done:'✅' }[t.status] || '📌';
  const agentBadge = t.agent ? `<span class="task-card-agent">🤖 ${esc(t.agent)}</span>` : '';
  const descLine = t.description ? `<div class="task-card-desc">${esc(t.description)}</div>` : '';
  const idStr = t.id ? `<div class="task-card-id">#${esc(t.id)}</div>` : '';
  const createdLine = t.createdAt ? `<div class="task-card-time">📅 ${fmtTime(t.createdAt)}</div>` : '';
  const completedLine = t.completedAt ? `<div class="task-card-time task-card-done-time">🏁 ${fmtTime(t.completedAt)}</div>` : '';
  const runHint = t.guessedRun ? `<div class="task-card-time" style="color:#60a5fa">🔗 关联run: ${esc((t.guessedRun.runId||'').slice(0,10))}…</div>` : '';

  const taskJson = esc(JSON.stringify(t));
  return `
    <div class="task-card ${statusClass}" onclick="openTaskDetail(${taskJson})">
      <div class="task-card-header">
        <span class="task-card-status-icon">${statusIcon}</span>
        <div class="task-card-title">${esc(t.title)}</div>
        ${agentBadge}
      </div>
      ${idStr}
      ${descLine}
      <div class="task-card-footer">
        ${createdLine}
        ${completedLine}
        ${runHint}
      </div>
    </div>`;
}

function openTaskDetail(task) {
  if (typeof task === 'string') { try { task = JSON.parse(task); } catch {} }
  const modal = document.getElementById('taskDetailModal');
  const title = document.getElementById('modalTaskTitle');
  const body = document.getElementById('modalTaskBody');
  if (!modal || !title || !body) return;

  title.textContent = task.title || '(无标题)';

  const field = (label, val, mono) => `
    <div class="modal-field">
      <div class="modal-field-label">${label}</div>
      <div class="modal-field-value ${mono ? 'modal-field-mono' : ''}">${val || '<span style="color:#475569">—</span>'}</div>
    </div>`;

  const copyBtn = (text, label) => `<button class="modal-copy-btn" onclick="copyToClip(${JSON.stringify(text)}, this)">${label || '复制'}</button>`;

  let runSection = '';
  const r = task.guessedRun;
  if (r) {
    const runIdStr = r.runId || '—';
    const sessionStr = r.childSessionKey || '—';
    runSection = `
      <div class="modal-field">
        <div class="modal-field-label">关联 Subagent Run（启发式匹配）</div>
        <div class="modal-run-box">
          <div class="modal-run-row">
            <span class="modal-run-key">Run ID</span>
            <span class="modal-run-val">${esc(runIdStr)}</span>
            ${copyBtn(runIdStr, '📋 复制')}
          </div>
          <div class="modal-run-row">
            <span class="modal-run-key">结束原因</span>
            <span class="modal-run-val">${esc(r.endedReason || '—')}</span>
          </div>
          ${r.errorMsg ? `<div class="modal-run-row"><span class="modal-run-key">错误信息</span><span class="modal-run-val" style="color:#f87171">${esc(r.errorMsg)}</span></div>` : ''}
          <div class="modal-run-row">
            <span class="modal-run-key">Session Key</span>
            <span class="modal-run-val">${esc(sessionStr)}</span>
            ${copyBtn(sessionStr, '📋 复制')}
          </div>
          <div class="modal-run-row">
            <span class="modal-run-key">运行时间</span>
            <span class="modal-run-val">${fmtTime(r.createdAt)} ~ ${r.endedAt ? fmtTime(r.endedAt) : '运行中'}</span>
          </div>
        </div>
      </div>`;
  } else {
    runSection = `<div class="modal-field"><div class="modal-field-label">关联 Subagent Run</div><div class="modal-no-run">未找到关联 run（任务可能由主 Agent 直接执行，或 run 已归档）</div></div>`;
  }

  body.innerHTML = `
    ${field('任务 ID', `<span class="modal-field-mono">${esc(task.id || '—')}</span>`)}
    ${field('状态', `<span class="task-card-agent">${{todo:'⏳ 排队中',doing:'🔥 进行中',done:'✅ 已完成'}[task.status] || task.status}</span>`)}
    ${field('执行 Agent', task.agent ? `🤖 ${esc(task.agent)}` : null)}
    ${field('描述', esc(task.description))}
    ${field('创建时间', fmtTime(task.createdAt))}
    ${task.completedAt ? field('完成时间', fmtTime(task.completedAt)) : ''}
    ${runSection}
  `;

  modal.style.display = 'flex';
}

function closeTaskModal() {
  const modal = document.getElementById('taskDetailModal');
  if (modal) modal.style.display = 'none';
}

function copyToClip(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) { const orig = btn.textContent; btn.textContent = '✅ 已复制'; setTimeout(() => btn.textContent = orig, 1500); }
  }).catch(() => {
    if (btn) { btn.textContent = '❌ 失败'; setTimeout(() => btn.textContent = '📋 复制', 1500); }
  });
}

// Escape key to close modal
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTaskModal(); });

/* ── 任务搜索筛选事件绑定 ──────────────────────────────────────────── */
(function initTaskFilters() {
  const searchInput = document.getElementById('tasksSearch');
  const clearBtn = document.getElementById('tasksSearchClear');
  const agentSel = document.getElementById('tasksAgentFilter');

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      _tasksSearchQ = searchInput.value;
      if (clearBtn) clearBtn.style.display = _tasksSearchQ ? 'block' : 'none';
      _applyTaskFilters();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      _tasksSearchQ = '';
      if (searchInput) searchInput.value = '';
      clearBtn.style.display = 'none';
      _applyTaskFilters();
    });
  }
  document.querySelectorAll('input[name="taskStatus"]').forEach(radio => {
    radio.addEventListener('change', () => {
      _tasksStatusFilter = radio.value;
      // Update chip styles
      document.querySelectorAll('.tasks-filter-chip').forEach(chip => {
        chip.classList.toggle('tasks-filter-chip-active', chip.dataset.status === radio.value);
      });
      _applyTaskFilters();
    });
  });
  if (agentSel) {
    agentSel.addEventListener('change', () => {
      _tasksAgentFilter = agentSel.value;
      _applyTaskFilters();
    });
  }
})();

/* ── v1.10: Ops Toolbox ──────────────────────────────────────────────── */

let _toolboxCurrentFile = 'openclaw.json';
let _toolboxCurrentLog = 'gateway';
let _toolboxFileRaw = {};

async function loadToolbox() {
  // v1.11 运维工具箱
  document.getElementById('toolboxUpdate').textContent = '加载中...';
  _initToolboxCmds();
  await loadToolboxFile(_toolboxCurrentFile);
  await loadToolboxLog(_toolboxCurrentLog);
  document.getElementById('toolboxUpdate').textContent = '更新于 ' + fmtTime(Date.now());
}

/* 文件速览 */
async function loadToolboxFile(name) {
  _toolboxCurrentFile = name;
  const viewer = document.getElementById('toolboxFileViewer');
  const searchWrap = document.getElementById('toolboxFileSearch');
  if (!viewer) return;
  viewer.innerHTML = '<div style="color:#64748b;padding:16px">加载中...</div>';
  if (searchWrap) searchWrap.style.display = name === 'tasks.json' ? 'flex' : 'none';

  try {
    const data = await API.get(`/api/toolbox/files?name=${encodeURIComponent(name)}`);
    if (!data.exists) {
      viewer.innerHTML = `<div style="color:#64748b">文件不存在: ${esc(name)}</div>`;
      return;
    }
    _toolboxFileRaw[name] = data.raw || '';
    renderToolboxFileContent(data.raw || '', viewer);
  } catch(e) {
    viewer.innerHTML = `<div style="color:#f87171">加载失败: ${esc(e.message)}</div>`;
  }
}

function renderToolboxFileContent(raw, viewer, highlight) {
  // Simple JSON syntax highlight
  const highlighted = raw
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"(apikey|api_key|token|secret|password|key)(\w*)"\s*:\s*"([^"]*)"/gi, (_, k1, k2, v) => {
      const isRedacted = v.includes('****');
      return `<span class="json-key">"${k1}${k2}"</span>: <span class="${isRedacted ? 'json-redacted' : 'json-string'}">"${v}"</span>`;
    })
    .replace(/"([^"]+)"(\s*:)/g, '<span class="json-key">"$1"</span>$2')
    .replace(/:\s*"([^"]*)"/g, ': <span class="json-string">"$1"</span>')
    .replace(/:\s*(-?\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');

  if (highlight) {
    // Highlight search term
    const escaped = highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped})`, 'gi');
    viewer.innerHTML = highlighted.replace(re, '<mark style="background:#2d3f10;color:#86efac;border-radius:2px">$1</mark>');
  } else {
    viewer.innerHTML = highlighted;
  }
}

/* runs.json 搜索 */
(function initToolboxFileSearch() {
  const input = document.getElementById('toolboxFileSearchInput');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim();
    const name = _toolboxCurrentFile;
    const raw = _toolboxFileRaw[name] || '';
    const viewer = document.getElementById('toolboxFileViewer');
    if (!viewer) return;
    if (!q) { renderToolboxFileContent(raw, viewer); return; }
    renderToolboxFileContent(raw, viewer, q);
  });
})();

/* 日志快照 */
async function loadToolboxLog(logType) {
  _toolboxCurrentLog = logType;
  const viewer = document.getElementById('toolboxLogViewer');
  if (!viewer) return;
  viewer.innerHTML = '<div style="color:#64748b;padding:12px">加载中...</div>';
  const limit = parseInt(document.getElementById('toolboxLogLimit')?.value || '200');

  try {
    if (logType === 'gateway') {
      const data = await API.get(`/api/toolbox/gateway-logs?limit=${limit}`);
      const lines = data.lines || [];
      if (lines.length === 0) { viewer.innerHTML = '<div style="color:#64748b;padding:8px">无日志</div>'; return; }
      viewer.innerHTML = lines.map(line => {
        let parsed = null;
        try { parsed = JSON.parse(line); } catch {}
        if (parsed) {
          const meta = parsed._meta || {};
          const level = (meta.logLevelName || '').toUpperCase();
          const levelColor = level === 'ERROR' ? '#f87171' : level === 'WARN' ? '#fbbf24' : '#64748b';
          const time = parsed.time ? fmtTime(parsed.time) : '';
          const msg = [0,1,2,3].map(i => parsed[String(i)]).filter(v => v !== undefined).map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ');
          return `<div class="toolbox-log-entry"><span class="toolbox-log-ts">${esc(time)}</span><span style="color:${levelColor};min-width:52px;flex-shrink:0">${esc(level)}</span><span class="toolbox-log-msg" title="${esc(msg)}">${esc(msg)}</span></div>`;
        }
        return `<div class="toolbox-log-entry"><span class="toolbox-log-msg">${esc(line.slice(0, 300))}</span></div>`;
      }).join('');
    } else {
      const data = await API.get(`/api/toolbox/commands-log?limit=${limit}`);
      const lines = data.lines || [];
      if (lines.length === 0) { viewer.innerHTML = '<div style="color:#64748b;padding:8px">无命令日志</div>'; return; }
      viewer.innerHTML = lines.map(l => `
        <div class="toolbox-log-entry">
          <span class="toolbox-log-ts">${esc(fmtTime(l.timestamp))}</span>
          <span class="toolbox-log-action">${esc(l.action || '—')}</span>
          <span class="toolbox-log-msg" title="${esc(l.sessionKey || '')}">${esc(l.source || '')} ${esc((l.sessionKey || '').slice(0,24))}${(l.sessionKey||'').length>24?'…':''}</span>
        </div>`).join('');
    }
  } catch(e) {
    viewer.innerHTML = `<div style="color:#f87171;padding:8px">加载失败: ${esc(e.message)}</div>`;
  }
}

/* 排障命令 */
function _initToolboxCmds() {
  const container = document.getElementById('toolboxCmds');
  if (!container || container.innerHTML.includes('toolbox-cmd-card')) return;

  const cmds = [
    { title: '查看 Gateway 状态', cmd: 'openclaw gateway status', hint: '检查网关服务是否正常运行' },
    { title: '重启 Gateway', cmd: 'openclaw gateway restart', hint: '遭遇 SSE 断线或推送卡死时使用' },
    { title: '停止 Gateway', cmd: 'openclaw gateway stop', hint: '彻底停止网关服务' },
    { title: '查看实时网关日志', cmd: 'tail -n 200 -f /tmp/openclaw/*.log', hint: '实时跟踪最新日志输出' },
    { title: '查看命令日志', cmd: `tail -n 200 ~/.openclaw/logs/commands.log`, hint: '查看最近 200 条指令记录' },
    { title: '磁盘占用分析', cmd: `du -h -d 2 ~/.openclaw | sort -h | tail -20`, hint: '按大小排序，找出占用最大目录' },
    { title: '/tmp 清理预检', cmd: `du -sh /tmp/openclaw 2>/dev/null; ls /tmp/openclaw/ | head`, hint: '查看临时目录大小和文件列表' },
    { title: '检查 OpenClaw 进程', cmd: `ps aux | grep -E 'openclaw|node' | grep -v grep`, hint: '查看所有相关进程' },
    { title: 'Node 内存快照', cmd: `node -e "const v8=require('v8');console.log(v8.getHeapStatistics())"`, hint: '打印 Node.js 堆内存使用状态' },
    { title: '查看 openclaw.json', cmd: `cat ~/.openclaw/openclaw.json | python3 -m json.tool 2>/dev/null || cat ~/.openclaw/openclaw.json`, hint: '格式化查看主配置文件' },
    { title: '列出所有 Cron Jobs', cmd: `cat ~/.openclaw/cron/jobs.json | python3 -m json.tool 2>/dev/null`, hint: '查看所有定时任务配置' },
    { title: '网络连通性检测', cmd: 'curl -s --max-time 5 https://api.openai.com/v1/models -I | head -3 || echo "连接失败"', hint: '测试 AI API 服务是否可达' },
  ];

  container.innerHTML = cmds.map((c, i) => `
    <div class="toolbox-cmd-card" onclick="_copyCmd(${i})" id="toolbox-cmd-${i}">
      <div class="toolbox-cmd-title">⚡ ${esc(c.title)}</div>
      <div class="toolbox-cmd-code">${esc(c.cmd)}</div>
      <div class="toolbox-cmd-hint">${esc(c.hint)}</div>
      <div class="toolbox-cmd-copied" id="toolbox-copied-${i}">✅ 已复制！</div>
    </div>`).join('');

  window._toolboxCmdList = cmds;
}

function _copyCmd(idx) {
  const cmds = window._toolboxCmdList || [];
  const c = cmds[idx];
  if (!c) return;
  navigator.clipboard.writeText(c.cmd).then(() => {
    const copiedEl = document.getElementById(`toolbox-copied-${idx}`);
    if (copiedEl) {
      copiedEl.style.display = 'block';
      setTimeout(() => copiedEl.style.display = 'none', 1800);
    }
  });
}

/* ── Toolbox 事件绑定 ────────────────────────────────────────────── */
(function initToolboxEvents() {
  // File tabs
  document.querySelectorAll('.toolbox-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toolbox-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const name = btn.dataset.file;
      if (name) loadToolboxFile(name);
    });
  });

  // Log tabs
  document.querySelectorAll('.toolbox-log-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toolbox-log-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const log = btn.dataset.log;
      if (log) loadToolboxLog(log);
    });
  });

  // Log refresh
  const refreshBtn = document.getElementById('toolboxLogRefresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadToolboxLog(_toolboxCurrentLog));
  }
})();

