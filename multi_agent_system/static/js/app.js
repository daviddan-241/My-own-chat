// NEXUS — Multi-Agent AI Frontend

let messagesEl, emptyEl;
let conversation     = [];
let pendingFiles     = [];
let currentSessionId = null;
let currentAbort     = null;
let msgCounter       = 0;
let allCodeBlocks    = [];
let _gitRepoContext  = null;

// ── TEXT-TO-SPEECH ──
let _ttsActive = false;
let _ttsUtterance = null;
let _ttsAutoRead = false;
let _ttsCurrentBtn = null;

function toggleTTS() {
  _ttsAutoRead = !_ttsAutoRead;
  const btn = document.getElementById('tts-btn');
  if (btn) {
    btn.classList.toggle('speaking', _ttsAutoRead);
    btn.title = _ttsAutoRead ? 'TTS on — click to disable' : 'Text to speech';
  }
  if (!_ttsAutoRead) stopTTS();
  showToast(_ttsAutoRead ? '🔊 Auto-read enabled' : '🔇 Auto-read off');
}

function speakText(text, btn) {
  if (!('speechSynthesis' in window)) { showToast('TTS not supported in this browser'); return; }
  stopTTS();
  const clean = text
    .replace(/```[\s\S]*?```/g, '[code block]')
    .replace(/`[^`]+`/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .slice(0, 3000);
  if (!clean.trim()) return;
  _ttsUtterance = new SpeechSynthesisUtterance(clean);
  _ttsUtterance.rate  = 1.05;
  _ttsUtterance.pitch = 1.0;
  _ttsUtterance.lang  = 'en-US';
  const voices = speechSynthesis.getVoices();
  const pref   = voices.find(v => v.name.includes('Google') && v.lang.startsWith('en'))
               || voices.find(v => v.lang.startsWith('en') && !v.name.includes('espeak'));
  if (pref) _ttsUtterance.voice = pref;
  if (btn) { btn.classList.add('active'); _ttsCurrentBtn = btn; }
  _ttsActive = true;
  _ttsUtterance.onend = _ttsUtterance.onerror = () => {
    _ttsActive = false;
    if (_ttsCurrentBtn) { _ttsCurrentBtn.classList.remove('active'); _ttsCurrentBtn = null; }
  };
  speechSynthesis.speak(_ttsUtterance);
}

function stopTTS() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  _ttsActive = false;
  if (_ttsCurrentBtn) { _ttsCurrentBtn.classList.remove('active'); _ttsCurrentBtn = null; }
}

// ── SYNTAX HIGHLIGHTING ──
function _highlightCode(code, lang) {
  if (typeof hljs === 'undefined') return escapeHtmlRaw(code);
  try {
    const validLang = hljs.getLanguage(lang) ? lang : null;
    if (validLang) return hljs.highlight(code, {language: validLang, ignoreIllegals: true}).value;
    return hljs.highlightAuto(code, ['python','javascript','bash','html','css','json','typescript','sql','yaml']).value;
  } catch(e) { return escapeHtmlRaw(code); }
}

// ── SPLIT PREVIEW PANEL ──
let _splitPreviewOpen = false;
let _splitPreviewCode = '';

function openSplitPreview(html, label) {
  _splitPreviewCode = html;
  const panel  = document.getElementById('split-preview-panel');
  const iframe = document.getElementById('split-preview-iframe');
  const lbl    = document.getElementById('split-preview-label');
  if (!panel || !iframe) return;
  if (lbl) lbl.textContent = label || 'Live Preview';
  iframe.classList.remove('mobile-view');
  panel.classList.add('open');
  document.body.classList.add('split-preview-active');
  _splitPreviewOpen = true;
  _loadSplitPreview(html);
  document.querySelectorAll('#split-preview-bar .viewport-btn').forEach((b,i) => b.classList.toggle('active', i===0));
}

async function _loadSplitPreview(html) {
  const iframe = document.getElementById('split-preview-iframe');
  if (!iframe) return;
  try {
    const res = await fetch('/api/preview', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({html})});
    if (res.ok) { const d = await res.json(); if (d.url) { iframe.src = d.url; iframe.removeAttribute('srcdoc'); return; } }
  } catch(_) {}
  iframe.removeAttribute('src');
  iframe.srcdoc = html;
}

function closeSplitPreview() {
  const panel = document.getElementById('split-preview-panel');
  if (panel) panel.classList.remove('open');
  document.body.classList.remove('split-preview-active');
  _splitPreviewOpen = false;
}

function openSplitPreviewUrl(url, label) {
  const panel  = document.getElementById('split-preview-panel');
  const iframe = document.getElementById('split-preview-iframe');
  const lbl    = document.getElementById('split-preview-label');
  const status = document.getElementById('split-preview-status');
  if (!panel || !iframe) return;
  if (lbl) lbl.textContent = label || 'Live Preview';
  if (status) { status.textContent = 'live'; status.style.color = 'var(--green)'; }
  iframe.classList.remove('mobile-view');
  panel.classList.add('open');
  document.body.classList.add('split-preview-active');
  _splitPreviewOpen = true;
  iframe.src = url;
  iframe.removeAttribute('srcdoc');
  document.querySelectorAll('#split-preview-bar .viewport-btn').forEach((b,i) => b.classList.toggle('active', i===0));
}

function refreshSplitPreview() {
  if (_splitPreviewCode) _loadSplitPreview(_splitPreviewCode);
}

function popoutSplitPreview() {
  const iframe = document.getElementById('split-preview-iframe');
  if (iframe?.src && !iframe.src.startsWith('about:')) { window.open(iframe.src,'_blank'); return; }
  const w = window.open(); if (w) { w.document.open(); w.document.write(_splitPreviewCode); w.document.close(); }
}

function setSplitViewport(mode, btn) {
  const iframe = document.getElementById('split-preview-iframe');
  if (!iframe) return;
  document.querySelectorAll('#split-preview-bar .viewport-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (mode === 'mobile') iframe.classList.add('mobile-view');
  else iframe.classList.remove('mobile-view');
}

// Code-execution tools — output goes to Live Console, not chat
const _CODE_TOOLS = new Set(['run_shell','run_code','debug_code']);
let _pendingConsoleEntries = {};
let _toolMeta              = {};

// ── AGENT META ──
const AGENT_META = {
  orchestrator: { label:'Orchestrator',   icon:'🧠', cls:'tc-orchestrator', tagCls:'at-orchestrator' },
  coder:        { label:'Coding Agent',   icon:'🧑‍💻', cls:'tc-coder',       tagCls:'at-coder' },
  debug:        { label:'Debug Agent',    icon:'🐞', cls:'tc-debug',       tagCls:'at-debug' },
  terminal:     { label:'Terminal Agent', icon:'🖥️', cls:'tc-terminal',    tagCls:'at-terminal' },
  files:        { label:'Filesystem',     icon:'📦', cls:'tc-files',       tagCls:'at-files' },
  deploy:       { label:'Deploy Agent',   icon:'🌐', cls:'tc-deploy',      tagCls:'at-deploy' },
  analysis:     { label:'Analysis',       icon:'📊', cls:'tc-analysis',    tagCls:'at-analysis' },
  memory:       { label:'Memory Agent',   icon:'💾', cls:'tc-memory',      tagCls:'at-memory' },
  image:        { label:'Image Agent',    icon:'🎨', cls:'tc-image',       tagCls:'at-image' },
  search:       { label:'Research',       icon:'🔍', cls:'tc-search',      tagCls:'at-search' },
  installer:    { label:'Installer',      icon:'📦', cls:'tc-terminal',    tagCls:'at-terminal' },
  launcher:     { label:'Server Launcher',icon:'🚀', cls:'tc-deploy',      tagCls:'at-deploy' },
  health:       { label:'Health Check',   icon:'❤️', cls:'tc-terminal',    tagCls:'at-terminal' },
  killer:       { label:'Process Killer', icon:'💀', cls:'tc-debug',       tagCls:'at-debug' },
  security:     { label:'Security Agent', icon:'🛡️', cls:'tc-security',    tagCls:'at-security' },
};

const TOOL_AGENT_MAP = {
  run_shell:        'terminal',
  run_code:         'coder',
  debug_code:       'debug',
  web_search:       'search',
  write_file:       'files',
  read_file:        'files',
  list_files:       'files',
  create_project:   'coder',
  analyze_logs:     'analysis',
  deploy_check:     'deploy',
  generate_image:   'image',
  remember:         'memory',
  install_packages: 'installer',
  launch_server:    'launcher',
  check_server:     'health',
  kill_process:     'killer',
  security_scan:    'security',
};

function _agentMeta(agentType) {
  return AGENT_META[agentType] || AGENT_META['orchestrator'];
}

// ── AGENT ROSTER ACTIVATION ──
let _currentActiveAgent = null;
function _activateAgent(agentType) {
  if (_currentActiveAgent) {
    const prev = document.querySelector(`.agent-chip[data-agent="${_currentActiveAgent}"]`);
    if (prev) prev.classList.remove('active');
  }
  _currentActiveAgent = agentType;
  const chip = document.querySelector(`.agent-chip[data-agent="${agentType}"]`);
  if (chip) chip.classList.add('active');
}
function _deactivateAllAgents() {
  document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('active'));
  _currentActiveAgent = null;
}

// ── TOOL CARDS ──
function _toolSummary(name, input) {
  if (!input) return '';
  if (name === 'run_shell')         return (input.command || '').slice(0,90);
  if (name === 'run_code')          return `[${input.language||'code'}] ${(input.code||'').split('\n')[0].slice(0,60)}`;
  if (name === 'web_search')        return input.query || '';
  if (name === 'write_file')        return input.path || '';
  if (name === 'read_file')         return input.path || '';
  if (name === 'list_files')        return input.directory || '/home/runner/workspace';
  if (name === 'create_project')    return `${Object.keys(input.files||{}).length} files → ${input.base_dir||'workspace'}`;
  if (name === 'debug_code')        return (input.error||'').slice(0,70);
  if (name === 'analyze_logs')      return 'Analyzing logs...';
  if (name === 'deploy_check')      return `→ ${input.platform||'render'}`;
  if (name === 'generate_image')    return (input.prompt||'').slice(0,70);
  if (name === 'remember')          return `${input.key} = ${(input.value||'').slice(0,40)}`;
  if (name === 'install_packages')  return input.packages ? `${input.manager||'auto'}: ${input.packages.slice(0,60)}` : 'auto-detect from manifest';
  if (name === 'launch_server')     return `${input.command||''} (port ${input.port||3000})`;
  if (name === 'check_server')      return `port ${input.port||3000}${input.url?' → '+input.url.slice(0,40):''}`;
  if (name === 'kill_process')      return input.port ? `port ${input.port}` : (input.id||'by ID');
  return JSON.stringify(input).slice(0,80);
}

// ── PROCESS MONITOR ──
let _procMonitorOpen = false;
let _procPollTimer   = null;
let _procBgPollTimer = null;  // always-on background poll for badge
let _procUptimeTimer = null;  // uptime tick

// Start background polling immediately on page load
(function startBgPoll() {
  fetchProcesses();
  _procBgPollTimer = setInterval(fetchProcesses, 5000);
})();

function toggleProcMonitor() {
  _procMonitorOpen = !_procMonitorOpen;
  const panel = document.getElementById('proc-monitor-panel');
  const btn   = document.getElementById('proc-monitor-btn');
  if (!panel) return;
  panel.classList.toggle('open', _procMonitorOpen);
  if (btn) btn.classList.toggle('active', _procMonitorOpen);
  if (_procMonitorOpen) {
    fetchProcesses();
    _procPollTimer = setInterval(fetchProcesses, 3000);
    _procUptimeTimer = setInterval(_tickUptimes, 1000);
  } else {
    clearInterval(_procPollTimer);  _procPollTimer   = null;
    clearInterval(_procUptimeTimer); _procUptimeTimer = null;
  }
}

function closeProcMonitor() {
  _procMonitorOpen = false;
  document.getElementById('proc-monitor-panel')?.classList.remove('open');
  document.getElementById('proc-monitor-btn')?.classList.remove('active');
  clearInterval(_procPollTimer);   _procPollTimer   = null;
  clearInterval(_procUptimeTimer); _procUptimeTimer = null;
}

// Open the panel and flash the new server entry
function _openProcMonitorForServer(procId) {
  if (!_procMonitorOpen) toggleProcMonitor();
  setTimeout(() => {
    const card = document.querySelector(`[data-proc-id="${procId}"]`);
    if (card) { card.classList.add('proc-item-new'); setTimeout(() => card.classList.remove('proc-item-new'), 2000); }
  }, 400);
}

let _cachedProcs = [];

async function fetchProcesses() {
  try {
    const res  = await fetch('/api/processes');
    const data = await res.json();
    _cachedProcs = data.processes || [];
    _renderProcesses(_cachedProcs);
  } catch(_) {}
}

function _uptimeStr(startTs) {
  if (!startTs) return '';
  const s = Math.floor(Date.now()/1000 - startTs);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60);
  return `${h}h ${m}m`;
}

function _tickUptimes() {
  document.querySelectorAll('.proc-item-uptime[data-start]').forEach(el => {
    const ts = parseFloat(el.dataset.start);
    el.textContent = _uptimeStr(ts);
  });
}

function _renderProcesses(procs) {
  const body  = document.getElementById('proc-monitor-body');
  const badge = document.getElementById('proc-count-badge');

  const running = procs.filter(p => p.status === 'running');
  if (badge) {
    badge.textContent = running.length;
    badge.style.display = running.length > 0 ? 'flex' : 'none';
  }
  // Update header btn glow when servers are running
  const btn = document.getElementById('proc-monitor-btn');
  if (btn) btn.classList.toggle('has-servers', running.length > 0);
  // Update count label in panel header
  const countLbl = document.getElementById('pm-server-count');
  if (countLbl) countLbl.textContent = running.length > 0 ? `(${running.length} running)` : '';

  if (!body) return;

  if (!procs.length) {
    body.innerHTML = `
      <div class="proc-monitor-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.3;margin-bottom:8px"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/></svg>
        <div>No servers running.</div>
        <div style="font-size:10.5px;margin-top:4px;opacity:.7">Ask NEXUS to build and launch a web app.<br>It will appear here with a live URL.</div>
      </div>`;
    return;
  }

  body.innerHTML = procs.map(p => {
    const up      = p.status === 'running';
    const urlText = p.url ? p.url.replace(/^https?:\/\//, '') : `localhost:${p.port||'?'}`;
    const uptime  = up ? _uptimeStr(p.started) : 'stopped';
    return `
    <div class="proc-item ${up?'':'proc-item-stopped'}" data-proc-id="${escapeHtml(p.id)}">
      <div class="proc-item-left">
        <div class="proc-item-dot ${up?'':'stopped'}"></div>
        <div class="proc-item-info">
          <div class="proc-item-name">${escapeHtml(p.name||'Server')}</div>
          <div class="proc-item-meta">
            <span class="proc-item-port">:${p.port||'?'}</span>
            <span class="proc-item-sep">·</span>
            <span class="proc-item-uptime" data-start="${p.started||0}">${uptime}</span>
          </div>
        </div>
      </div>
      <div class="proc-item-right">
        ${p.url ? `
          <a class="proc-open-btn" href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="Open in new tab">
            Open ↗
          </a>
          <button class="proc-preview-btn" onclick="previewServer('${escapeHtml(p.url)}','${escapeHtml(p.name||'Server')}')" title="Preview in chat">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/></svg>
          </button>` : ''}
        ${up ? `<button class="proc-kill-btn" onclick="killProcess('${escapeHtml(p.id)}')" title="Stop server">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>` : ''}
      </div>
    </div>
    ${up && p.url ? `<div class="proc-item-url-bar"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.url)}</a></div>` : ''}`;
  }).join('');
}

function previewServer(url, name) {
  const chatEl = document.getElementById('messages') || document.querySelector('.messages');
  if (!chatEl) { window.open(url, '_blank'); return; }
  const wrap = document.createElement('div');
  wrap.className = 'server-preview-embed';
  wrap.innerHTML = `
    <div class="server-preview-bar">
      <span class="server-preview-dot"></span>
      <span class="server-preview-title">${escapeHtml(name)}</span>
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="server-preview-ext">Open full ↗</a>
      <button onclick="this.closest('.server-preview-embed').remove()" class="server-preview-close">✕</button>
    </div>
    <iframe src="${escapeHtml(url)}" class="server-preview-frame" sandbox="allow-scripts allow-same-origin allow-forms" loading="lazy"></iframe>`;
  chatEl.appendChild(wrap);
  wrap.scrollIntoView({behavior:'smooth', block:'end'});
}

async function killProcess(id) {
  try {
    await fetch(`/api/processes/${id}/kill`, {method:'POST'});
    await fetchProcesses();
    showToast('Server stopped');
  } catch(e) {
    showToast('Error: ' + e.message);
  }
}

// ── SERVER LAUNCHED CARD ──
function _createServerLaunchedCard(data) {
  const div = document.createElement('div');
  div.className = 'server-launched-card';
  div.innerHTML = `
    <div class="server-launched-left">
      <div class="server-launched-dot"></div>
      <div class="server-launched-info">
        <div class="server-launched-title">🚀 ${escapeHtml(data.name||'Server')} is LIVE</div>
        <div class="server-launched-sub">Port ${data.port||'?'} · Ready</div>
        ${data.url ? `<div class="server-launched-url"><a href="${escapeHtml(data.url)}" target="_blank" rel="noopener">${escapeHtml(data.url)}</a></div>` : ''}
      </div>
    </div>
    <div class="server-launched-actions">
      ${data.url ? `<a class="server-open-btn" href="${escapeHtml(data.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
      ${data.url ? `<button class="server-preview-btn-inline" onclick="previewServer('${escapeHtml(data.url)}','${escapeHtml(data.name||'Server')}')">Preview</button>` : ''}
    </div>`;
  // Auto-refresh processes list and open the panel
  fetchProcesses().then(() => {
    if (data.id) _openProcMonitorForServer(data.id);
  });
  return div;
}

let _toolStepCounter = 0;
function _resetToolStepCounter() { _toolStepCounter = 0; }

function _toolChipIcon(name) {
  const m = {
    run_shell:'⌨️', run_code:'▶', debug_code:'🐛', write_file:'📝',
    read_file:'📖', list_files:'📂', create_project:'📦', web_search:'🔍',
    generate_image:'🎨', remember:'💾', install_packages:'📥',
    launch_server:'🚀', check_server:'❤️', kill_process:'💀',
    security_scan:'🛡️', analyze_logs:'📊', deploy_check:'🌐',
  };
  return m[name] || '⚡';
}

function _createToolCard(id, name, input, agentLabel) {
  _toolStepCounter++;
  const agentType = TOOL_AGENT_MAP[name] || 'orchestrator';
  const meta = _agentMeta(agentType);
  const summary = _toolSummary(name, input);
  const icon = _toolChipIcon(name);

  let inputHtml = '';
  if (name === 'run_shell' && input?.command) {
    inputHtml = `<div class="ia-input-block"><div class="ia-input-label">Command</div><div class="ia-input-code">${escapeHtmlRaw(input.command)}</div></div>`;
  } else if (name === 'run_code' && input?.code) {
    inputHtml = `<div class="ia-input-block"><div class="ia-input-label">${escapeHtml(input.language||'code')}</div><div class="ia-input-code">${escapeHtmlRaw(input.code.slice(0,1200))}${input.code.length>1200?'\n…':''}</div></div>`;
  } else if (name === 'write_file' && input?.path) {
    inputHtml = `<div class="ia-input-block"><div class="ia-input-label">→ ${escapeHtml(input.path)}</div><div class="ia-input-code">${escapeHtmlRaw((input.content||'').slice(0,600))}${(input.content||'').length>600?'\n…':''}</div></div>`;
  } else if (name === 'generate_image' && input?.prompt) {
    inputHtml = `<div class="ia-input-block"><div class="ia-input-label">Prompt</div><div class="ia-input-code">${escapeHtml(input.prompt)}</div></div>`;
  } else if (name === 'debug_code' && input?.error) {
    inputHtml = `<div class="ia-input-block"><div class="ia-input-label">Error</div><div class="ia-input-code">${escapeHtmlRaw(input.error.slice(0,400))}</div></div>`;
  } else if (name === 'list_files') {
    inputHtml = `<div class="ia-input-block"><div class="ia-input-label">Directory</div><div class="ia-input-code">${escapeHtml(input.directory||'/workspace')}</div></div>`;
  } else if (name === 'create_project' && input?.files) {
    const fileList = Object.keys(input.files).slice(0,8).join('  ');
    const extra = Object.keys(input.files).length > 8 ? ` +${Object.keys(input.files).length-8} more` : '';
    inputHtml = `<div class="ia-input-block"><div class="ia-input-label">${Object.keys(input.files).length} files</div><div class="ia-input-code">${escapeHtml(fileList+extra)}</div></div>`;
  }

  const card = document.createElement('div');
  card.className = 'inline-action';
  card.dataset.toolId   = id;
  card.dataset.toolName = name;
  card.innerHTML = `
    <div class="ia-row" onclick="toggleIA(this)">
      <span class="ia-icon">${icon}</span>
      <span class="ia-agent ${meta.cls}">${meta.icon} ${escapeHtml(agentLabel || meta.label)}</span>
      <span class="ia-summary">${escapeHtml(summary.slice(0, 80))}</span>
      <span class="ia-status" id="ias-${id}"><span class="tool-spinner"></span></span>
      <svg class="ia-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="ia-details" id="iad-${id}" style="display:none">
      ${inputHtml}
      <pre class="ia-output" id="iao-${id}"><em style="color:var(--text3)">Running…</em></pre>
    </div>`;
  return card;
}

function toggleIA(rowEl) {
  const ia = rowEl.closest('.inline-action'); if (!ia) return;
  const details = ia.querySelector('.ia-details');
  const chevron = ia.querySelector('.ia-chevron');
  if (!details) return;
  const open = details.style.display !== 'none';
  details.style.display = open ? 'none' : 'block';
  if (chevron) chevron.style.transform = open ? '' : 'rotate(180deg)';
}

function _updateToolCard(card, output, ok) {
  const id = card.dataset.toolId;
  const statusEl = document.getElementById('ias-' + id);
  const outputEl = document.getElementById('iao-' + id);
  if (statusEl) {
    statusEl.innerHTML = ok
      ? '<span class="ia-ok">✓ done</span>'
      : '<span class="ia-err">✗ error</span>';
  }
  if (outputEl) {
    const MAX = 2000;
    const trimmed = (output || '').trim();
    const shown = trimmed.slice(0, MAX);
    const extra = trimmed.length > MAX ? `\n… +${trimmed.length - MAX} chars` : '';
    outputEl.innerHTML = `<span class="${ok?'':'err-output'}">${escapeHtmlRaw(shown+extra) || '(no output)'}</span>`;
  }
  card.classList.add(ok ? 'ok' : 'err');
}

// ── IMAGE RESULT IN CHAT ──
function _createImageBlock(url, prompt, style, imgId) {
  const div = document.createElement('div');
  div.className = 'img-result-block';
  const dlName = `nexus-image-${imgId||'gen'}.jpg`;
  const safeUrl    = escapeHtml(url);
  const safePrompt = escapeHtml(prompt);
  const safeStyle  = escapeHtml(style||'');
  const uid = 'img-' + (imgId || Date.now());
  div.innerHTML = `
    <div class="img-result-header">
      <span>🎨</span>
      <span>Image Agent — Generated</span>
    </div>
    <div class="img-result-body">
      <div class="img-loader-wrap" id="${uid}-wrap">
        <div class="img-loader-spinner" id="${uid}-spin"></div>
        <img id="${uid}" src="${safeUrl}" alt="${safePrompt}"
             style="display:none;"
             onclick="openImgLightbox('${safeUrl}','${safePrompt}','${safeStyle}')"
             onload="_imgOnLoad('${uid}')"
             onerror="_imgOnError('${uid}','${safeUrl}','${safePrompt}','${safeStyle}')" />
        <div class="img-error-state" id="${uid}-err" style="display:none;">
          <div style="font-size:22px;margin-bottom:8px;">🖼️</div>
          <div style="font-size:12px;color:var(--text2);margin-bottom:10px;">Image failed to load</div>
          <button class="img-action-btn" onclick="_imgRetry('${uid}','${safeUrl}','${safePrompt}','${safeStyle}')">↺ Retry</button>
          <a class="img-action-btn" href="${safeUrl}" target="_blank" rel="noopener" style="margin-left:6px;">🔗 Open Direct</a>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:6px;line-height:1.5;">${safePrompt}</div>
      <div class="img-result-actions">
        <a class="img-action-btn" href="${safeUrl}" target="_blank" rel="noopener">🔗 Open</a>
        <a class="img-action-btn" href="${safeUrl}" download="${dlName}">⬇ Download</a>
        <button class="img-action-btn" onclick="openImgLightbox('${safeUrl}','${safePrompt}','${safeStyle}')">⛶ Fullscreen</button>
      </div>
    </div>`;
  return div;
}

function _imgOnLoad(uid) {
  const img  = document.getElementById(uid);
  const spin = document.getElementById(uid + '-spin');
  const err  = document.getElementById(uid + '-err');
  if (img)  { img.style.display  = 'block'; }
  if (spin) { spin.style.display = 'none';  }
  if (err)  { err.style.display  = 'none';  }
}

function _imgOnError(uid, url, prompt, style) {
  const img  = document.getElementById(uid);
  const spin = document.getElementById(uid + '-spin');
  const err  = document.getElementById(uid + '-err');
  if (img)  { img.style.display  = 'none';  }
  if (spin) { spin.style.display = 'none';  }
  if (err)  { err.style.display  = 'flex';  }
}

function _imgRetry(uid, url, prompt, style) {
  const img  = document.getElementById(uid);
  const spin = document.getElementById(uid + '-spin');
  const err  = document.getElementById(uid + '-err');
  if (!img) return;
  if (spin) { spin.style.display = 'block'; }
  if (err)  { err.style.display  = 'none';  }
  img.style.display = 'none';
  // Cache-bust the URL to force a fresh attempt
  const sep = url.includes('?') ? '&' : '?';
  img.src = url + sep + '_t=' + Date.now();
}

// ── IMAGE LIGHTBOX ──
function openImgLightbox(url, prompt, style) {
  const ov  = document.getElementById('img-lightbox-overlay');
  const img = document.getElementById('img-lightbox-img');
  const meta= document.getElementById('img-lightbox-meta');
  const dl  = document.getElementById('img-lightbox-dl');
  if (!ov) return;
  img.src = url;
  meta.innerHTML = `<strong>Prompt:</strong> ${escapeHtml(prompt)}${style?` &nbsp;·&nbsp; <strong>Style:</strong> ${escapeHtml(style)}`:''}`;
  dl.href = url; dl.download = 'nexus-image.jpg';
  ov.classList.add('open');
}
function closeImgLightbox() {
  const ov = document.getElementById('img-lightbox-overlay');
  if (ov) ov.classList.remove('open');
}

// ── INLINE TASK TRACKING ──
const _taskMap = new Map();
function _startInlineTask(task_id, barEl, dotEl, labelEl, timerEl, stopBtn) {
  const start = Date.now();
  barEl.style.display = 'flex';
  function tick() {
    const s = Math.floor((Date.now()-start)/1000);
    const m = Math.floor(s/60);
    timerEl.textContent = m>0 ? `${m}m ${s%60}s` : `${s}s`;
  }
  const iv = setInterval(tick, 1000); tick();
  stopBtn.addEventListener('click', () => stopInlineTask(task_id));
  _taskMap.set(task_id, {barEl,dotEl,labelEl,timerEl,stopBtn,start,iv});
}
function _finishInlineTask(task_id, stopped=false) {
  const t = _taskMap.get(task_id); if (!t) return;
  clearInterval(t.iv);
  t.dotEl.className = 'task-dot task-dot-done';
  t.labelEl.textContent = stopped ? 'Stopped' : 'Done';
  t.labelEl.className = 'task-label ' + (stopped ? 'task-stopped' : 'task-done');
  t.stopBtn.style.display = 'none';
  if (!stopped) {
    const btn = document.createElement('button');
    btn.className = 'task-reconnect-btn';
    btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg> Reconnect`;
    btn.onclick = () => {
      const body = t.barEl.closest('.msg-body');
      const flowEl = body?.querySelector('[id^="mf"]');
      const agentTagEl = body?.querySelector('.agent-tag');
      if (flowEl && agentTagEl) reconnectTask(task_id, flowEl, agentTagEl);
      btn.remove();
    };
    t.barEl.appendChild(btn);
  }
  _taskMap.delete(task_id);
}
async function stopInlineTask(task_id) {
  try { await fetch(`/api/tasks/${task_id}/stop`,{method:'POST'}); } catch(_) {}
  _finishInlineTask(task_id, true);
  showToast('Task stopped');
}

async function reconnectTask(task_id, flowEl, agentTagEl) {
  setStatus('Reconnecting...','thinking');
  const toolCards = {};
  let curSeg=null; let curSegText=''; let curSegSearch='';
  function _rGetSeg() {
    if (!curSeg) {
      curSeg = document.createElement('div'); curSeg.className='text-seg';
      flowEl.appendChild(curSeg); curSegText=''; curSegSearch='';
    }
    return curSeg;
  }
  function _rSealSeg() {
    if (curSeg) { curSeg.querySelector('.cursor')?.remove(); curSeg=null; curSegText=''; curSegSearch=''; }
  }
  try {
    const res = await fetch(`/api/tasks/${task_id}/stream`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf='', fullText='', searchHtml='';
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      buf += dec.decode(value,{stream:true});
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6).trim());
          if (d.type==='task_id') continue;
          if (d.type==='agent' && d.agent) _applyAgentTag(agentTagEl, d.agent);
          if (d.type==='tool_start' && d.id && d.name) {
            _rSealSeg();
            const card = _createToolCard(d.id, d.name, d.input||{}, d.agent_label);
            toolCards[d.id] = card;
            _toolMeta[d.id] = {name:d.name, input:d.input||{}};
            flowEl.appendChild(card);
            if (_CODE_TOOLS.has(d.name)) {
              const lang  = d.name==='run_shell' ? 'sh' : (d.input?.language||'code');
              const label = d.name==='run_shell'
                ? ('$ '+(d.input?.command||'').slice(0,90))
                : d.name==='run_code'
                  ? (`▶ [${d.input?.language||'code'}] ${(d.input?.code||'').split('\n')[0].slice(0,70)}`)
                  : ('▶ debug: '+(d.input?.error||'').slice(0,60));
              _pendingConsoleEntries[d.id] = _consolePendingEntry(d.id, lang, label);
            }
            scrollToBottom();
          }
          if (d.type==='tool_result' && d.id && toolCards[d.id]) {
            const ok = d.ok!==false;
            _updateToolCard(toolCards[d.id], d.output||'', ok);
            if (_pendingConsoleEntries[d.id]) {
              _consoleCompleteEntry(_pendingConsoleEntries[d.id], d.output||'', ok);
              delete _pendingConsoleEntries[d.id];
            }
            delete _toolMeta[d.id];
          }
          if (d.type==='image_result') {
            _rSealSeg();
            flowEl.appendChild(_createImageBlock(d.url,d.prompt,d.style,d.id));
            loadGallery(); scrollToBottom();
          }
          if (d.type==='server_launched') {
            _rSealSeg();
            flowEl.appendChild(_createServerLaunchedCard(d));
            fetchProcesses(); scrollToBottom();
            if (d.url) setTimeout(() => openSplitPreviewUrl(d.url, (d.name||'App')+' — Live'), 1200);
          }
          if (d.type==='content' && d.content) {
            curSegText += d.content; fullText += d.content;
            const seg = _rGetSeg();
            seg.innerHTML = formatContent(curSegText) + curSegSearch + '<span class="cursor"></span>';
            scrollToBottom();
          }
          if (d.type==='search_result' && d.results) {
            curSegSearch = _buildSearchHtml(d.results); searchHtml = curSegSearch;
            const seg = _rGetSeg();
            seg.innerHTML = formatContent(curSegText) + curSegSearch + '<span class="cursor"></span>';
          }
        } catch(_) {}
      }
    }
    _rSealSeg();
    flowEl.querySelectorAll('.cursor').forEach(c=>c.remove());
    if (!fullText && !searchHtml) {
      const noR=document.createElement('div'); noR.className='text-seg';
      noR.innerHTML='<span style="color:var(--text3)">Task completed.</span>';
      flowEl.appendChild(noR);
    }
  } catch(e) {
    const errSeg=document.createElement('div'); errSeg.className='text-seg';
    errSeg.innerHTML=`<span style="color:var(--orange)">Reconnect error: ${escapeHtml(e.message)}</span>`;
    flowEl.appendChild(errSeg);
  } finally { setStatus('Ready','ready'); _deactivateAllAgents(); }
}

function _applyAgentTag(el, agentType) {
  if (!el) return;
  const meta = _agentMeta(agentType);
  el.textContent = meta.label;
  el.className = 'agent-tag ' + meta.tagCls;
  _activateAgent(agentType);
}

// ── PLAN CARDS ──
const PLAN_AGENT_ICONS = {
  orchestrator:'🧠', coder:'🧑‍💻', debug:'🐞', terminal:'🖥️',
  files:'📦', deploy:'🌐', analysis:'📊', memory:'💾', image:'🎨', search:'🔍',
  installer:'📦', launcher:'🚀', health:'❤️', killer:'💀',
};
const PLAN_AGENT_COLORS = {
  coder:'var(--accent)', debug:'var(--orange)', terminal:'var(--green)',
  files:'var(--yellow)', deploy:'var(--cyan)', analysis:'var(--purple)',
  memory:'var(--pink)', image:'var(--purple)', search:'var(--yellow)',
  orchestrator:'var(--accent)', installer:'var(--green)', launcher:'var(--cyan)',
  health:'var(--green)', killer:'var(--red)',
};

const _planStepTimes = new Map(); // key: planCardId+'-'+stepIndex → start timestamp

function _createPlanCard(steps) {
  const card = document.createElement('div');
  card.className = 'plan-card collapsed';
  card.id = 'plan-' + Date.now();
  card.dataset.totalSteps = steps.length;
  const stepsHtml = steps.map((s, i) => {
    const icon  = PLAN_AGENT_ICONS[s.agent] || '⚡';
    const color = PLAN_AGENT_COLORS[s.agent] || 'var(--text2)';
    const label = AGENT_META[s.agent]?.label || s.agent;
    return `<div class="plan-step" id="ps-${card.id}-${i}" data-agent="${escapeHtml(s.agent)}" data-step="${i}">
      <div class="plan-step-num">${i+1}</div>
      <div class="plan-step-icon" style="color:${color}">${icon}</div>
      <div class="plan-step-body">
        <div class="plan-step-agent" style="color:${color}">${escapeHtml(label)}</div>
        <div class="plan-step-task">${escapeHtml(s.task)}</div>
      </div>
      <div class="plan-step-status" id="pss-${card.id}-${i}"></div>
      <span class="plan-step-time" id="pst-${card.id}-${i}"></span>
    </div>`;
  }).join('');
  card.innerHTML = `
    <div class="plan-card-header" onclick="this.closest('.plan-card').classList.toggle('collapsed')" style="cursor:pointer;user-select:none;">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      <span>NEXUS — ${steps.length}-step plan</span>
      <span class="plan-toggle-icon" style="margin-left:auto;font-size:10px;color:var(--text3);">▼</span>
    </div>
    <div class="plan-body">
      <div class="plan-progress-bar-wrap">
        <div class="plan-progress-track"><div class="plan-progress-fill" id="ppf-${card.id}"></div></div>
        <span class="plan-progress-label" id="ppl-${card.id}">0 / ${steps.length}</span>
      </div>
      <div class="plan-steps">${stepsHtml}</div>
    </div>`;
  return card;
}

function _activatePlanStep(planCard, agentType) {
  if (!planCard) return;
  planCard.querySelectorAll('.plan-step').forEach(s => s.classList.remove('active'));
  const matching = planCard.querySelector(`.plan-step[data-agent="${agentType}"]`);
  if (matching) {
    matching.classList.add('active');
    matching.classList.remove('done');
    const st = matching.querySelector('.plan-step-status');
    if (st) st.innerHTML = '<span class="plan-spinner"></span>';
    const stepKey = planCard.id + '-' + (matching.dataset.step || '0');
    _planStepTimes.set(stepKey, Date.now());
  }
}

function _completePlanStep(planCard, agentType) {
  if (!planCard) return;
  planCard.querySelectorAll(`.plan-step[data-agent="${agentType}"]`).forEach(s => {
    s.classList.remove('active');
    s.classList.add('done');
    const st = s.querySelector('.plan-step-status');
    if (st) st.innerHTML = '<span class="plan-check">✓</span>';
    const stepKey = planCard.id + '-' + (s.dataset.step || '0');
    const start = _planStepTimes.get(stepKey);
    const timeEl = document.getElementById(`pst-${planCard.id}-${s.dataset.step}`);
    if (timeEl && start) {
      const ms = Date.now() - start;
      timeEl.textContent = ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`;
      _planStepTimes.delete(stepKey);
    }
  });
  const done  = planCard.querySelectorAll('.plan-step.done').length;
  const total = parseInt(planCard.dataset.totalSteps || '0');
  const fill  = document.getElementById(`ppf-${planCard.id}`);
  const label = document.getElementById(`ppl-${planCard.id}`);
  if (fill)  fill.style.width  = `${total > 0 ? (done/total)*100 : 0}%`;
  if (label) label.textContent = `${done} / ${total}`;
}

// ── SEARCH RESULTS ──
function _buildSearchHtml(results) {
  let html = '<br><div class="search-header">WEB RESULTS</div>';
  results.forEach(r => {
    const url = r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">↗ ${escapeHtml(r.url.replace(/^https?:\/\//,'').slice(0,50))}</a>` : '';
    const srcBadge = r.source ? `<span class="search-source-badge">${escapeHtml(r.source)}</span>` : '';
    html += `<div class="search-result">
      <div class="search-result-title-row">
        <div class="search-result-title">${escapeHtml(r.title||'')}</div>
        ${srcBadge}
      </div>
      <div class="search-result-snippet">${escapeHtml(r.snippet||'')}</div>
      ${url ? `<div class="search-result-url">${url}</div>` : ''}
    </div>`;
  });
  return html;
}

// ── IMAGE GALLERY ──
let _galleryImages = [];
async function loadGallery() {
  try {
    const res = await fetch('/api/images');
    const data = await res.json();
    _galleryImages = data.images || [];
    _renderGallery();
  } catch(_) {}
}

function _renderGallery() {
  const grid  = document.getElementById('gallery-grid');
  const count = document.getElementById('gallery-count');
  if (!grid) return;
  if (count) count.textContent = _galleryImages.length;
  if (!_galleryImages.length) {
    grid.innerHTML = '<div class="gallery-empty">No images yet.<br>Ask NEXUS to generate an image<br>or use the form above.</div>';
    return;
  }
  grid.innerHTML = _galleryImages.map(img => `
    <div class="gallery-item" onclick="openImgLightbox('${escapeHtml(img.url)}','${escapeHtml(img.prompt)}','${escapeHtml(img.style||'')}')">
      <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.prompt)}" loading="lazy"
           onerror="this.parentElement.style.opacity='.5'" />
      <div class="gallery-item-overlay">
        <div class="gallery-item-prompt">${escapeHtml(img.prompt)}</div>
      </div>
      <button class="gallery-del-btn" onclick="event.stopPropagation();deleteGalleryImage('${img.id}')">✕</button>
    </div>
  `).join('');
}

async function deleteGalleryImage(id) {
  try {
    await fetch(`/api/images/${id}/delete`, {method:'DELETE'});
    await loadGallery();
  } catch(_) {}
}

let _galleryOpen = false;
function toggleImageGallery() {
  _galleryOpen = !_galleryOpen;
  const drawer = document.getElementById('image-gallery-drawer');
  const overlay= document.getElementById('image-gallery-overlay');
  const btn    = document.getElementById('gallery-btn');
  drawer.classList.toggle('open', _galleryOpen);
  overlay.classList.toggle('open', _galleryOpen);
  if (btn) btn.classList.toggle('active', _galleryOpen);
  if (_galleryOpen) loadGallery();
}
function closeImageGallery() {
  _galleryOpen = false;
  document.getElementById('image-gallery-drawer')?.classList.remove('open');
  document.getElementById('image-gallery-overlay')?.classList.remove('open');
  document.getElementById('gallery-btn')?.classList.remove('active');
}

async function generateImageDirect() {
  const promptEl = document.getElementById('img-prompt');
  const styleEl  = document.getElementById('img-style');
  const sizeEl   = document.getElementById('img-size');
  const btn      = document.getElementById('img-gen-btn');
  const prompt   = promptEl?.value.trim();
  if (!prompt) { showToast('Enter a prompt first'); return; }

  const [w, h] = (sizeEl?.value || '1024x1024').split('x').map(Number);
  btn.disabled = true;
  btn.innerHTML = '<span class="tool-spinner" style="border-color:var(--purple);border-top-color:transparent"></span> Generating...';

  // Add loading placeholder
  const grid  = document.getElementById('gallery-grid');
  const loader = document.createElement('div');
  loader.className = 'gallery-loading';
  loader.innerHTML = '<div class="gallery-loading-spinner"></div>';
  if (grid) grid.prepend(loader);

  try {
    const res = await fetch('/api/images/generate', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({prompt, style:styleEl?.value||'realistic', width:w, height:h})
    });
    const data = await res.json();
    if (data.success) {
      promptEl.value = '';
      await loadGallery();
      showToast('Image generated!');
    } else {
      showToast('Error: ' + (data.error||'Unknown'));
    }
  } catch(e) {
    showToast('Error: ' + e.message);
  } finally {
    loader.remove();
    btn.disabled = false;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate`;
  }
}

// ── GITHUB IMPORT ──
async function importGitRepo() {
  const input  = document.getElementById('git-url-input');
  const btn    = document.getElementById('git-import-btn');
  const status = document.getElementById('git-import-status');
  const url    = input.value.trim();
  if (!url) { input.focus(); return; }
  btn.disabled = true; status.className='busy'; status.textContent='Cloning...';
  try {
    const res  = await fetch('/api/import-github',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    const data = await res.json();
    if (!data.success) { status.className='err'; status.textContent=data.error||'Import failed'; btn.disabled=false; return; }
    _gitRepoContext = data.context;
    status.className='ok'; status.textContent=`✓ ${data.files_read} files · ${data.total_size_kb}KB`;
    showMessages();
    messagesEl.appendChild(_buildRepoCard(data));
    scrollToBottom(); input.value=''; enableSend();
    const autoPrompt = `I just imported "${data.repo_name}" from GitHub (${data.files_read} files). Explore the codebase and give me a detailed overview: purpose, architecture, key files, dependencies, and anything notable.`;
    document.getElementById('chat-input').value = autoPrompt;
    document.getElementById('chat-input').dispatchEvent(new Event('input'));
    document.getElementById('chat-input').focus();
  } catch(e) { status.className='err'; status.textContent=e.message; }
  finally { btn.disabled=false; }
}

function _buildRepoCard(data) {
  const div = document.createElement('div');
  div.className = 'repo-import-card';
  const tree = data.file_tree.slice(0,30).join('\n') + (data.file_tree.length>30 ? `\n... and ${data.file_tree.length-30} more` : '');
  div.innerHTML = `
    <div class="repo-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg></div>
    <div class="repo-card-body">
      <div class="repo-card-title">✓ Imported: ${escapeHtml(data.repo_name)}</div>
      <div class="repo-card-meta">
        <span class="repo-meta-item">📄 ${data.files_read} files</span>
        <span class="repo-meta-item">💾 ${data.total_size_kb}KB</span>
        ${data.files_skipped ? `<span class="repo-meta-item" style="color:var(--text3)">${data.files_skipped} skipped</span>` : ''}
        <span class="repo-meta-item"><a href="${escapeHtml(data.url)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(data.url)} ↗</a></span>
      </div>
      <div class="repo-card-tree">${escapeHtml(tree)}</div>
    </div>`;
  return div;
}

// ── HISTORY ──
const HISTORY_KEY = 'nexus_history_v2';
function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'); } catch { return []; } }
function saveHistory(h) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch {} }
function saveSession(s) {
  const h = loadHistory(); const idx = h.findIndex(x=>x.id===s.id);
  if (idx>=0) h[idx]=s; else h.unshift(s);
  saveHistory(h.slice(0,100));
}
function deleteSession(id) { saveHistory(loadHistory().filter(s=>s.id!==id)); if(currentSessionId===id)currentSessionId=null; renderHistoryList(); }
function openHistory()  { renderHistoryList(); document.getElementById('history-drawer').classList.add('open'); document.getElementById('history-overlay').classList.add('open'); }
function closeHistory() { document.getElementById('history-drawer').classList.remove('open'); document.getElementById('history-overlay').classList.remove('open'); }
function newChat()      { closeHistory(); clearChat(); }

function loadSession(id) {
  const s = loadHistory().find(x=>x.id===id); if (!s) return;
  closeHistory(); clearChat(false);
  currentSessionId=id; conversation=[...(s.conversation||[])]; allCodeBlocks=[]; _gitRepoContext=null;
  showMessages();
  (s.messages||[]).forEach(m => {
    if (m.role==='user') _renderUserBubble(m.content, m.time, m.fileName);
    else {
      const bub = _renderAIBubble(m.content, m.time, m.agent||'orchestrator');
      if (m.task_id && !m.task_done) _addReconnectBar(bub, m.task_id);
    }
  });
  scrollToBottom();
}
function _addReconnectBar(bubbleEl, task_id) {
  const body = bubbleEl.querySelector('.msg-body'); if(!body) return;
  const bar = document.createElement('div');
  bar.className='reconnect-bar'; bar.id='reconnect-bar-'+task_id;
  bar.innerHTML=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg><span>Task may still be running</span><button class="reconnect-btn" onclick="reconnectTaskFromHistory('${task_id}',this)">Reconnect</button>`;
  body.appendChild(bar);
}
function reconnectTaskFromHistory(task_id, btn) {
  const bar=btn.closest('.reconnect-bar'); const body=bar?.parentElement; if(!body) return;
  bar.remove();
  const contentEl=body.querySelector('.msg-content'); const agentTagEl=body.querySelector('.agent-tag');
  if (contentEl && agentTagEl) reconnectTask(task_id, contentEl, agentTagEl);
}

// ── ACTIVE TASK PERSISTENCE (survives page refresh) ──
const _ACTIVE_TASK_KEY = 'nexus_active_task';
function _checkForActiveTask() {
  try {
    const saved = JSON.parse(localStorage.getItem(_ACTIVE_TASK_KEY) || 'null');
    if (!saved || !saved.task_id) return;
    // Discard stale tasks older than 8 hours (long enough for overnight hacks)
    if (Date.now() - (saved.ts || 0) > 8 * 60 * 60 * 1000) {
      localStorage.removeItem(_ACTIVE_TASK_KEY); return;
    }
    _showActiveTaskBanner(saved.task_id, saved.msg || 'previous task');
  } catch(_) {}
}

async function _loadRecentTasks() {
  try {
    const res = await fetch('/api/tasks');
    if (!res.ok) return;
    const data = await res.json();
    const tasks = (data.tasks || []).filter(t => !t.done).slice(0, 3);
    tasks.forEach(t => {
      if (!localStorage.getItem(_ACTIVE_TASK_KEY + '_' + t.task_id)) {
        _showActiveTaskBanner(t.task_id, t.message || 'previous task');
      }
    });
  } catch(_) {}
}
function _showActiveTaskBanner(task_id, msg) {
  const existing = document.getElementById('active-task-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'active-task-banner';
  banner.className = 'active-task-banner';
  banner.innerHTML = `
    <div class="atb-inner">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      <span>Task still running: <em>${escapeHtml(msg)}</em></span>
      <button class="atb-reconnect" onclick="_reconnectActiveTask('${escapeHtml(task_id)}')">Reconnect</button>
      <button class="atb-dismiss" onclick="document.getElementById('active-task-banner').remove();localStorage.removeItem('${_ACTIVE_TASK_KEY}')">✕</button>
    </div>`;
  document.body.appendChild(banner);
}
async function _reconnectActiveTask(task_id) {
  const banner = document.getElementById('active-task-banner');
  if (banner) banner.remove();
  try {
    const check = await fetch(`/api/tasks/${task_id}/stream`, {method:'HEAD'}).catch(()=>null);
    if (check && check.status === 404) {
      localStorage.removeItem(_ACTIVE_TASK_KEY);
      showToast('Task no longer available (server may have restarted)');
      return;
    }
  } catch(_) {}
  showMessages();
  const se = _createStreamEl();
  // Remove the default text-seg so reconnect builds fresh
  se.flowEl.innerHTML = '';
  reconnectTask(task_id, se.flowEl, se.agentTag);
  localStorage.removeItem(_ACTIVE_TASK_KEY);
}
function renderHistoryList() {
  const list = document.getElementById('history-list');
  const h = loadHistory();
  if (!h.length) { list.innerHTML='<div class="history-empty">No conversations yet.</div>'; return; }
  const today=new Date(); today.setHours(0,0,0,0);
  const yest=new Date(today); yest.setDate(yest.getDate()-1);
  const groups={};
  h.forEach(s => {
    const d=new Date(s.timestamp); d.setHours(0,0,0,0);
    const label = d.getTime()===today.getTime() ? 'Today' : d.getTime()===yest.getTime() ? 'Yesterday' : d.toLocaleDateString([],{month:'short',day:'numeric'});
    if (!groups[label]) groups[label]=[];
    groups[label].push(s);
  });
  let html='';
  for (const [label,sessions] of Object.entries(groups)) {
    html+=`<div class="history-section-label">${label}</div>`;
    sessions.forEach(s => {
      const active = s.id===currentSessionId ? ' active' : '';
      html+=`<div class="history-item${active}" onclick="loadSession('${s.id}')">
        <div class="history-item-text">
          <div class="history-item-title">${escapeHtml(s.title||'Untitled')}</div>
          <div class="history-item-meta">${new Date(s.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
        </div>
        <button class="history-item-del" onclick="event.stopPropagation();deleteSession('${s.id}')" title="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
    });
  }
  list.innerHTML = html;
}

// ── FILE HANDLING ──
async function handleFileSelect(input) {
  const files = Array.from(input.files); input.value='';
  if (!files.length) return;
  const btn=document.querySelector('.attach-btn'); btn.style.opacity='.5';
  for (const f of files) await uploadFile(f);
  btn.style.opacity=''; updateFileBar(); enableSend();
}
async function uploadFile(file) {
  try {
    const fd=new FormData(); fd.append('file',file);
    const res=await fetch('/api/upload',{method:'POST',body:fd});
    const data=await res.json();
    if (data.success) pendingFiles.push(data);
  } catch(e) { console.error('Upload:',e); }
}
function updateFileBar() {
  const bar=document.getElementById('file-bar'); const chips=document.getElementById('file-chips');
  const btn=document.querySelector('.attach-btn');
  if (!pendingFiles.length) { bar.style.display='none'; btn.classList.remove('has-files'); return; }
  bar.style.display='block'; btn.classList.add('has-files');
  chips.innerHTML=pendingFiles.map((f,i) => {
    const preview = f.type==='image' && f.b64 && f.mime
      ? `<img src="data:${f.mime};base64,${f.b64}" style="width:34px;height:34px;object-fit:cover;border-radius:4px;flex-shrink:0;cursor:pointer"
             onclick="openImgLightbox('data:${f.mime};base64,${f.b64}','${escapeHtml(f.filename)}','')" />`
      : `<span style="font-size:16px">${f.ext==='zip'?'📦':'📄'}</span>`;
    return `<div class="file-chip">${preview}
      <span class="file-chip-name" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
      <span style="color:var(--text3);font-size:11px">${formatBytes(f.size)}</span>
      ${f.type!=='image'&&f.saved_path?`<button class="file-chip-action" onclick="runFile(${i})" title="Run">▶</button>`:''}
      <button class="file-chip-remove" onclick="removeFile(${i})">×</button>
    </div>`;
  }).join('');
}
function removeFile(idx) { pendingFiles.splice(idx,1); updateFileBar(); enableSend(); }
async function runFile(idx) {
  const f=pendingFiles[idx]; if(!f||!f.saved_path) return;
  showMessages(); _renderUserBubble(`run: ${f.filename}`, ts(), f.filename);
  conversation.push({role:'user',content:`Run: ${f.filename}`});
  const se=_createStreamEl(); setStatus('Running...','thinking');
  try {
    const res=await fetch('/api/run-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:f.saved_path})});
    const data=await res.json();
    const out=data.stdout||data.output||data.error||JSON.stringify(data);
    se.contentEl.innerHTML=formatContent('```\n'+out+'\n```');
    _applyAgentTag(se.agentTag,'terminal');
    conversation.push({role:'assistant',content:out});
    consolePush('sh',`▶ ${f.filename}`,out,0);
  } catch(e) {
    se.contentEl.innerHTML=`<span style="color:var(--orange)">Error: ${escapeHtml(e.message)}</span>`;
  } finally { setStatus('Ready','ready'); }
}

// ── DRAG & DROP ──
function initDragDrop() {
  const app=document.getElementById('app');
  app.addEventListener('dragover', e=>{e.preventDefault();app.classList.add('drag-over');});
  app.addEventListener('dragleave', e=>{if(!app.contains(e.relatedTarget))app.classList.remove('drag-over');});
  app.addEventListener('drop', async e=>{
    e.preventDefault(); app.classList.remove('drag-over');
    const files=Array.from(e.dataTransfer.files); if(!files.length) return;
    const btn=document.querySelector('.attach-btn'); btn.style.opacity='.5';
    for (const f of files) await uploadFile(f);
    btn.style.opacity=''; updateFileBar(); enableSend();
  });
}

// ── LIVE PREVIEW ──
let _previewCode='', _previewFullscreen=false;
async function openPreview(id) {
  const el=document.getElementById(id); if(!el) return;
  _previewCode = el.innerText;
  await _loadPreview(_previewCode);
  document.getElementById('preview-overlay').classList.add('open');
  document.getElementById('preview-modal').classList.add('open');
  document.getElementById('preview-label').textContent = 'Live Preview';
  setViewport('desktop', document.querySelector('.viewport-btn'));
}
async function _loadPreview(html) {
  const iframe=document.getElementById('preview-iframe');
  try {
    const res=await fetch('/api/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({html})});
    if (res.ok) { const data=await res.json(); iframe.src=data.url; iframe.removeAttribute('srcdoc'); return; }
  } catch(_) {}
  iframe.removeAttribute('src'); iframe.srcdoc=html;
}
function closePreview() {
  document.getElementById('preview-overlay').classList.remove('open');
  document.getElementById('preview-modal').classList.remove('open');
  _previewFullscreen=false;
  document.getElementById('preview-modal').classList.remove('fullscreen');
  document.getElementById('preview-frame-wrap').classList.remove('padded');
}
function togglePreviewSize() {
  _previewFullscreen=!_previewFullscreen;
  document.getElementById('preview-modal').classList.toggle('fullscreen',_previewFullscreen);
}
function openPreviewTab() {
  const iframe=document.getElementById('preview-iframe');
  if (iframe.src&&!iframe.src.startsWith('about:')) { window.open(iframe.src,'_blank'); return; }
  const w=window.open();
  if (w) { w.document.open(); w.document.write(_previewCode); w.document.close(); }
}
function downloadPreview() {
  const a=document.createElement('a');
  a.href='data:text/html;charset=utf-8,'+encodeURIComponent(_previewCode);
  a.download='preview.html'; a.click();
}
function setViewport(mode, btn) {
  const wrap=document.getElementById('preview-frame-wrap');
  const iframe=document.getElementById('preview-iframe');
  const dims=document.getElementById('preview-dims');
  document.querySelectorAll('.viewport-btn').forEach(b=>b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  wrap.classList.remove('padded');
  if (mode==='desktop') { iframe.style.width='100%'; iframe.style.height='100%'; if(dims) dims.textContent=''; }
  else if (mode==='tablet')  { wrap.classList.add('padded'); iframe.style.width='768px'; iframe.style.height='100%'; if(dims) dims.textContent='768px'; }
  else if (mode==='mobile')  { wrap.classList.add('padded'); iframe.style.width='375px'; iframe.style.height='100%'; if(dims) dims.textContent='375px'; }
}

// ── CODE PREVIEW DRAWER ──
let _cpdOpen=false;
function toggleCodePreview() {
  _cpdOpen=!_cpdOpen;
  document.getElementById('code-preview-drawer').classList.toggle('open',_cpdOpen);
  document.getElementById('code-preview-overlay').classList.toggle('open',_cpdOpen);
  document.getElementById('code-preview-btn').classList.toggle('active',_cpdOpen);
  if (_cpdOpen) _renderCPD();
}
function closeCodePreview() {
  _cpdOpen=false;
  document.getElementById('code-preview-drawer').classList.remove('open');
  document.getElementById('code-preview-overlay').classList.remove('open');
  document.getElementById('code-preview-btn').classList.remove('active');
}
let _cpdActive=0;
function _renderCPD() {
  const tabs=document.getElementById('cpd-tabs'); const body=document.getElementById('cpd-body');
  if (!allCodeBlocks.length) {
    tabs.innerHTML=''; body.innerHTML='<div class="cpd-empty">No code files yet.<br>Code generated by agents will appear here.</div>'; return;
  }
  tabs.innerHTML = allCodeBlocks.map((b,i)=>`
    <button class="cpd-tab ${i===_cpdActive?'active':''}" onclick="setCPDTab(${i})">
      <span class="cpd-tab-lang">${escapeHtml(b.lang||'code')}</span>
      <span class="cpd-tab-name">${escapeHtml((b.filename||('block_'+(i+1))).slice(0,20))}</span>
    </button>`).join('');
  const b = allCodeBlocks[_cpdActive];
  body.innerHTML = b ? `
    <div class="cpd-toolbar">
      <span class="cpd-file-name">${escapeHtml(b.filename||'Untitled')}</span>
      <div class="cpd-actions">
        <button class="sm-btn" onclick="copyCPD()">Copy</button>
        <button class="sm-btn" onclick="downloadCPD()">Download</button>
        ${['html','htm'].includes(b.lang) ? `<button class="sm-btn" style="color:var(--accent)" onclick="openPreviewFromCPD()">Preview</button>` : ''}
      </div>
    </div>
    <div class="cpd-code-wrap"><pre><code class="hljs">${_highlightCode(b.code||'', b.lang||'')}</code></pre></div>` : '<div class="cpd-empty">Empty</div>';
}
function setCPDTab(i) { _cpdActive=i; _renderCPD(); }
function _refreshCPDBadge() {
  const el=document.getElementById('cpd-count'); if(el) el.textContent=allCodeBlocks.length;
}
function copyCPD() {
  const b=allCodeBlocks[_cpdActive]; if(!b) return;
  navigator.clipboard?.writeText(b.code||'');
  showToast('Copied!');
}
function downloadCPD() {
  const b=allCodeBlocks[_cpdActive]; if(!b) return;
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(b.code||'');
  a.download=b.filename||'code.txt'; a.click();
}
function openPreviewFromCPD() {
  const b=allCodeBlocks[_cpdActive]; if(!b) return;
  _loadPreview(b.code);
  document.getElementById('preview-overlay').classList.add('open');
  document.getElementById('preview-modal').classList.add('open');
  closeCodePreview();
}
async function downloadSessionZip() {
  if (!allCodeBlocks.length) { showToast('No code files yet'); return; }
  try {
    const res=await fetch('/api/generate-zip',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({files:allCodeBlocks.map(b=>({filename:b.filename||'code.txt',content:b.code||''}))})});
    if (!res.ok) throw new Error('Failed');
    const blob=await res.blob();
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='nexus_code.zip'; a.click();
  } catch(e) { showToast('Error: '+e.message); }
}

// ── FORMAT CONTENT ──
function _cleanAIText(text) {
  if (!text) return text;
  return text
    // Strip fake tool-output lines that leaked through the server-side filter
    .replace(/^\s*\[TOOL(?:\s+OUTPUT)?(?:\s*:[^\]]*)?(?:\])[^\n]*/gim, '')
    .replace(/^\s*\[Final URL\s*:[^\]]*\][^\n]*/gim, '')
    .replace(/^\s*Running (?:command|'[^']*'|"[^"]*")[^\n]*/gim, '')
    .replace(/^\s*\[NEXUS\][^\n]*/gim, '')
    .replace(/<use_tool>\s*\{[^]*?\}\s*<\/use_tool>/g, '')
    .replace(/\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[^\n]*\}/g, '')
    // Strip raw JSON tool-call objects (multi-line)
    .replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
    // Strip Phase / Step / Module / Component / Part N: planning headers
    .replace(/^#{1,4}\s*(phase|step|module|component|part|section)\s+\d+[:.][^\n]*/gim, '')
    // Strip bare "Phase N:" lines
    .replace(/^(phase|step|module|component|part)\s+\d+[:.][^\n]*/gim, '')
    // Collapse triple+ blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatContent(text) {
  if (!text) return '';
  text = _cleanAIText(text);
  let html = '';
  const lines = text.split('\n');
  let inCode = false; let codeLang = ''; let codeLines = [];
  let inTable = false; let tableRows = [];

  for (let i=0; i<lines.length; i++) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode=true; codeLang=line.slice(3).trim()||'code'; codeLines=[];
      } else {
        inCode=false;
        const code = codeLines.join('\n');
        const blockId = 'cb' + (++msgCounter);
        const isHtml = ['html','htm'].includes(codeLang.toLowerCase());
        const isRunnable = ['python','py','javascript','js','bash','sh','node'].includes(codeLang.toLowerCase());
        const lang = codeLang.toLowerCase();
        let filename = lang==='python'||lang==='py' ? 'script.py'
          : lang==='javascript'||lang==='js'||lang==='node' ? 'script.js'
          : lang==='html'||lang==='htm' ? 'index.html'
          : lang==='css' ? 'style.css' : lang==='bash'||lang==='sh' ? 'script.sh' : `code.${lang}`;

        // Save to code blocks
        allCodeBlocks.push({lang:codeLang, code, filename, id:blockId});
        _refreshCPDBadge();

        const runBtn = isRunnable ? `<button class="code-btn code-run" onclick="runCodeBlock('${blockId}','${escapeHtml(codeLang)}')">▶ Run</button>` : '';
        const previewBtn = isHtml ? `<button class="code-btn code-preview" onclick="openSplitPreview(document.getElementById('${blockId}').innerText,'${escapeHtml(filename)}')">⛶ Preview</button>` : '';
        const copyBtn = `<button class="code-btn" onclick="copyCode('${blockId}')">Copy</button>`;
        const saveBtn = `<button class="code-btn" onclick="saveCode('${blockId}','${escapeHtml(filename)}')">Save</button>`;
        const highlighted = _highlightCode(code, codeLang.toLowerCase());
        html += `<div class="code-block">
          <div class="code-header">
            <span class="code-lang">${escapeHtml(codeLang)}</span>
            <div class="code-actions">${runBtn}${previewBtn}${copyBtn}${saveBtn}</div>
          </div>
          <pre><code id="${blockId}" class="language-${escapeHtml(codeLang.toLowerCase())}">${highlighted}</code></pre>
        </div>`;
        codeLines=[]; codeLang='';
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    // Headings
    if (line.startsWith('### ')) { html+=`<h3>${_inlineFormat(line.slice(4))}</h3>`; continue; }
    if (line.startsWith('## '))  { html+=`<h2>${_inlineFormat(line.slice(3))}</h2>`; continue; }
    if (line.startsWith('# '))   { html+=`<h1>${_inlineFormat(line.slice(2))}</h1>`; continue; }

    // Blockquote
    if (line.startsWith('> '))   { html+=`<blockquote>${_inlineFormat(line.slice(2))}</blockquote>`; continue; }

    // HR
    if (/^---+$/.test(line.trim())) { html+='<hr style="border:none;border-top:1px solid var(--border);margin:12px 0">'; continue; }

    // Lists
    if (/^(\s*[-*+])\s/.test(line))  { html+=`<li>${_inlineFormat(line.replace(/^\s*[-*+]\s/,''))}</li>`; continue; }
    if (/^\s*\d+\.\s/.test(line))    { html+=`<li>${_inlineFormat(line.replace(/^\s*\d+\.\s/,''))}</li>`; continue; }

    // Empty line
    if (!line.trim()) { html+='<br>'; continue; }

    // Regular paragraph
    html += `<p>${_inlineFormat(line)}</p>`;
  }
  if (inCode && codeLines.length) {
    html += `<pre><code>${escapeHtmlRaw(codeLines.join('\n'))}</code></pre>`;
  }
  return html;
}

function _inlineFormat(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/`(.+?)`/g,'<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function escapeHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeHtmlRaw(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function formatBytes(n) {
  if (n<1024) return n+'B'; if (n<1048576) return (n/1024).toFixed(1)+'KB'; return (n/1048576).toFixed(1)+'MB';
}
function ts() {
  return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}
function showToast(msg, dur=2200) {
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  const el=document.createElement('div'); el.className='toast'; el.textContent=msg;
  document.body.appendChild(el); setTimeout(()=>el.remove(), dur);
}

// ── LIVE CONSOLE ──
let _consoleOpen=false, _consoleCount=0;
function toggleLiveConsole() {
  _consoleOpen=!_consoleOpen;
  document.getElementById('live-console-panel').classList.toggle('open',_consoleOpen);
  document.getElementById('live-console-btn').classList.toggle('active',_consoleOpen);
}
function consoleClear() { const el=document.getElementById('live-console-output'); if(el) el.innerHTML=''; }
function consolePush(lang, label, output, rc) {
  _consoleCount++;
  const el=document.getElementById('console-exec-count'); if(el) el.textContent=_consoleCount+' runs';
  const out=document.getElementById('live-console-output'); if(!out) return;
  const isOk=rc===0;
  const entry=document.createElement('div'); entry.className='console-entry';
  entry.innerHTML=`
    <div class="console-entry-header">
      <span class="console-entry-badge ${isOk?'badge-ok':'badge-err'}">${escapeHtml(lang)}</span>
      <span style="color:var(--text2)">${escapeHtml(label)}</span>
      <span style="color:${isOk?'var(--green)':'var(--orange)'};margin-left:auto">exit ${rc}</span>
    </div>
    <div class="console-entry-output">${escapeHtmlRaw(output.slice(0,4000))}</div>`;
  out.appendChild(entry);
  out.scrollTop=out.scrollHeight;
  if (!_consoleOpen) toggleLiveConsole();
}

// ── LIVE CONSOLE PENDING ENTRIES ──
function _consolePendingEntry(toolId, lang, label) {
  const out = document.getElementById('live-console-output');
  if (!out) return null;
  _consoleCount++;
  const countEl = document.getElementById('console-exec-count');
  if (countEl) countEl.textContent = _consoleCount + ' runs';
  const entry = document.createElement('div');
  entry.className = 'console-entry'; entry.id = 'cpe-' + toolId;
  entry.innerHTML = `
    <div class="console-entry-header">
      <span class="console-entry-badge badge-sh">${escapeHtml(lang)}</span>
      <span style="color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(label)}</span>
      <span class="cpe-status" style="color:var(--text3);display:flex;align-items:center;gap:4px;margin-left:8px;flex-shrink:0">
        <span class="tool-spinner" style="width:9px;height:9px;border-width:1.5px;border-color:var(--text3);border-top-color:transparent"></span> running
      </span>
    </div>
    <div class="cpe-out" style="color:var(--text3);font-style:italic;font-size:11px;padding:2px 0">waiting for output…</div>`;
  out.appendChild(entry); out.scrollTop = out.scrollHeight;
  if (!_consoleOpen) toggleLiveConsole();
  return entry;
}
function _consoleCompleteEntry(entry, output, ok) {
  if (!entry) return;
  const statusEl = entry.querySelector('.cpe-status');
  if (statusEl) statusEl.innerHTML = ok
    ? '<span style="color:var(--green)">✓ exit 0</span>'
    : '<span style="color:var(--orange)">✗ exit 1</span>';
  const outEl = entry.querySelector('.cpe-out');
  if (outEl) {
    outEl.style.fontStyle = '';
    outEl.style.color = ok ? 'var(--text2)' : 'var(--orange)';
    const text = (output || '').trim();
    outEl.textContent = text.slice(0, 8000) + (text.length > 8000 ? '\n… (truncated)' : '');
    if (!text) { outEl.style.color = 'var(--text3)'; outEl.textContent = '(no output)'; }
  }
  const out = document.getElementById('live-console-output');
  if (out) out.scrollTop = out.scrollHeight;
}

// ── CODE ACTIONS ──
function copyCode(id) {
  const el=document.getElementById(id); if(!el) return;
  navigator.clipboard?.writeText(el.innerText);
  showToast('Copied!');
}
function saveCode(id, filename) {
  const el=document.getElementById(id); if(!el) return;
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(el.innerText);
  a.download=filename||'code.txt'; a.click();
}
async function runCodeBlock(id, lang) {
  const el=document.getElementById(id); if(!el) return;
  const code=el.innerText; const l=lang.toLowerCase();
  const runBtn=el.closest('.code-block')?.querySelector('.code-run');
  if (runBtn) { runBtn.textContent='⏳ Running...'; runBtn.disabled=true; }
  if (!_consoleOpen) toggleLiveConsole();
  try {
    let data;
    if (l==='js'||l==='javascript'||l==='node') {
      const res=await fetch('/api/run-node',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
      data=await res.json();
    } else {
      const ext={python:'py',py:'py',sh:'sh',bash:'sh',shell:'sh'}[l]||'py';
      const res=await fetch('/api/run-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,lang:ext})});
      data=await res.json();
    }
    const out=data.stdout||data.output||data.error||'No output';
    const rc=data.returncode??(data.success?0:1);
    consolePush(lang, `▶ code block`, out, rc);
    const label=rc===0 ? '✅ Output' : `❌ Error (exit ${rc})`;
    showMessages();
    _renderAIBubble(`**${label}:**\n\`\`\`\n${out}\n\`\`\``, ts(), 'terminal');
    conversation.push({role:'assistant',content:'Code output:\n'+out});
    scrollToBottom();
  } catch(e) {
    consolePush(lang,'▶ code block','Error: '+e.message,1);
  } finally {
    if (runBtn) { runBtn.textContent='▶ Run'; runBtn.disabled=false; }
  }
}

// ── COPY / EDIT ACTIONS ──
function copyMessage(btn) {
  const msgBody=btn.closest('.msg-body');
  const contentEl=msgBody?.querySelector('.msg-content');
  if (!contentEl) return;
  const text=contentEl.innerText||contentEl.textContent||'';
  navigator.clipboard?.writeText(text.trim()).then(()=>{
    btn.classList.add('copied');
    btn.innerHTML=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Copied`;
    setTimeout(()=>{ btn.classList.remove('copied'); btn.innerHTML=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy`; }, 1800);
  }).catch(()=>showToast('Copy failed'));
}
function editMessage(btn) {
  const msgBody=btn.closest('.msg-body');
  const contentEl=msgBody?.querySelector('.msg-content');
  if (!contentEl) return;
  const text=(contentEl.innerText||contentEl.textContent||'').trim();
  const input=document.getElementById('chat-input');
  input.value=text; input.style.height='auto';
  input.style.height=Math.min(input.scrollHeight,140)+'px';
  enableSend(); input.focus();
  input.setSelectionRange(text.length, text.length);
  showToast('Message loaded for editing');
}

// ── VOICE INPUT ──
let _voiceRec=null, _voiceActive=false;
function toggleVoice() {
  const btn=document.getElementById('voice-btn');
  if (_voiceActive) { _voiceRec?.stop(); return; }
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if (!SR) { showToast('Voice not supported in this browser'); return; }
  const rec=new SR(); rec.lang='en-US'; rec.continuous=false; rec.interimResults=true;
  _voiceRec=rec; _voiceActive=true; btn.classList.add('recording');
  const input=document.getElementById('chat-input');
  const base=input.value;
  rec.onresult=e=>{
    let interim='', final='';
    for (let i=e.resultIndex;i<e.results.length;i++) {
      if (e.results[i].isFinal) final+=e.results[i][0].transcript;
      else interim+=e.results[i][0].transcript;
    }
    input.value=base+(final||interim);
    input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,140)+'px';
    enableSend();
  };
  rec.onend=()=>{ _voiceActive=false; btn.classList.remove('recording'); _voiceRec=null; };
  rec.onerror=e=>{ showToast('Mic error: '+e.error); _voiceActive=false; btn.classList.remove('recording'); };
  rec.start();
}

// ── RENDER BUBBLES ──
function _renderUserBubble(text, time, fileName, imgList) {
  const div=document.createElement('div'); div.className='message user-msg';
  const hasImgs = imgList && imgList.length > 0;
  const fileHtml = fileName && !hasImgs ? `<div class="file-attach-chip">📎 ${escapeHtml(fileName)}</div>` : '';
  const imgHtml  = hasImgs ? `<div class="chat-upload-imgs">${
    imgList.map(img =>
      `<img src="data:${escapeHtml(img.mime)};base64,${img.b64}"
            class="chat-upload-img" loading="lazy"
            onclick="openImgLightbox('data:${escapeHtml(img.mime)};base64,${img.b64}','${escapeHtml(img.name)}','')"
            title="${escapeHtml(img.name)}" />`
    ).join('')
  }</div>` : '';
  div.innerHTML=`
    <div class="msg-avatar user-avatar">U</div>
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-name">You</span><span class="msg-time">${time||ts()}</span></div>
      <div class="msg-content">${fileHtml}${imgHtml}${text ? escapeHtml(text) : ''}</div>
      <div class="msg-actions">
        <button class="msg-action-btn" onclick="copyMessage(this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy</button>
        <button class="msg-action-btn" onclick="editMessage(this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit</button>
      </div>
    </div>`;
  messagesEl.appendChild(div); scrollToBottom(); return div;
}
function _renderAIBubble(content, time, agentType) {
  const div=document.createElement('div'); div.className='message';
  const meta=_agentMeta(agentType||'orchestrator');
  const mid='ai'+(++msgCounter);
  div.id=mid;
  div.innerHTML=`
    <div class="msg-avatar ai-avatar">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name">NEXUS</span>
        <span class="msg-time">${time||ts()}</span>
        <span class="agent-tag ${meta.tagCls}">${meta.label}</span>
      </div>
      <div class="msg-content" id="mc${mid}">${formatContent(content)}</div>
      <div class="msg-actions">
        <button class="msg-action-btn" onclick="copyMessage(this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy</button>
        <button class="msg-tts-btn" onclick="speakText(${JSON.stringify(content)},this)" title="Read aloud">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg> Speak
        </button>
      </div>
    </div>`;
  messagesEl.appendChild(div); scrollToBottomSmooth();
  if (_ttsAutoRead) speakText(content);
  return div;
}
function _createStreamEl() {
  const id='stream'+(++msgCounter);
  const div=document.createElement('div'); div.className='message streaming'; div.id=id;
  div.innerHTML=`
    <div class="msg-avatar ai-avatar">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name">NEXUS</span>
        <span class="msg-time">${ts()}</span>
        <span class="agent-tag at-thinking" id="at${id}">thinking</span>
      </div>
      <div class="msg-flow" id="mf${id}">
        <!-- inline action rows and text segments appear here -->
      </div>
      <div class="task-bar" id="tb${id}" style="display:none">
        <div class="task-dot task-dot-running" id="td${id}"></div>
        <span class="task-label task-running" id="tl${id}">Running</span>
        <span class="task-timer" id="tt${id}">0s</span>
        <button class="task-stop-btn" id="tsb${id}">■ Stop</button>
      </div>
    </div>`;
  messagesEl.appendChild(div); scrollToBottomSmooth();
  // Create a default text segment as contentEl for simple/legacy use
  const flowEl = div.querySelector(`#mf${id}`);
  const defaultSeg = document.createElement('div');
  defaultSeg.className = 'text-seg';
  defaultSeg.innerHTML = '<span class="cursor"></span>';
  flowEl.appendChild(defaultSeg);
  return {
    msgEl:        div,
    msgBodyEl:    div.querySelector('.msg-body'),
    flowEl,
    contentEl:    defaultSeg,   // default text segment (for simple cases)
    agentTag:     div.querySelector(`#at${id}`),
    taskBarEl:    div.querySelector(`#tb${id}`),
    taskDotEl:    div.querySelector(`#td${id}`),
    taskLabelEl:  div.querySelector(`#tl${id}`),
    taskTimerEl:  div.querySelector(`#tt${id}`),
    taskStopBtn:  div.querySelector(`#tsb${id}`),
  };
}
function addTyping() {
  const div=document.createElement('div'); div.className='message typing-msg';
  div.innerHTML=`
    <div class="msg-avatar ai-avatar">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-name">NEXUS</span></div>
      <div class="msg-content"><div class="typing-dots"><span></span><span></span><span></span></div></div>
    </div>`;
  messagesEl.appendChild(div); scrollToBottom(); return div;
}

// ── SEND MESSAGE ──
async function sendMessage() {
  const input=document.getElementById('chat-input');
  const text=input.value.trim();
  if (!text && !pendingFiles.length) return;
  if (currentAbort) { currentAbort.abort(); currentAbort=null; }

  const userText    = text || '(files attached)';
  const msgTime     = ts();
  const filesToSend = [...pendingFiles];
  pendingFiles=[]; updateFileBar();
  input.value=''; input.style.height='auto';
  document.getElementById('send-btn').disabled=true;

  let fileContext=null, fileNames=null, imageB64=null, imageMime=null, allImages=[];
  if (filesToSend.length) {
    const textFiles=filesToSend.filter(f=>f.type!=='image');
    const imgFiles =filesToSend.filter(f=>f.type==='image');
    if (textFiles.length) { fileContext=textFiles.map(f=>`=== ${f.filename} ===\n${f.content}`).join('\n\n'); fileNames=filesToSend.map(f=>f.filename).join(', '); }
    if (imgFiles.length) {
      allImages = imgFiles.map(f=>({b64:f.b64, mime:f.mime, name:f.filename}));
      imageB64=imgFiles[0].b64; imageMime=imgFiles[0].mime;
      if(!fileNames) fileNames=imgFiles.map(f=>f.filename).join(', ');
    }
  }

  showMessages();
  _renderUserBubble(userText, msgTime, fileNames, allImages);
  setStatus('Thinking...','thinking');

  if (!currentSessionId) currentSessionId=(crypto.randomUUID?.())||(Date.now().toString(36)+Math.random().toString(36).slice(2));

  const typingEl=addTyping();

  let combinedCtx=fileContext||'';
  if (_gitRepoContext) { combinedCtx=_gitRepoContext+(combinedCtx?'\n\n'+combinedCtx:''); _gitRepoContext=null; }

  const convoToSend=conversation.slice(-30);
  let currentTaskId=null;

  try {
    currentAbort=new AbortController();
    const res=await fetch('/api/chat/stream',{
      method:'POST', headers:{'Content-Type':'application/json'},
      signal:currentAbort.signal,
      body:JSON.stringify({
        message:userText, conversation:convoToSend,
        file_context:combinedCtx||null, image_b64:imageB64, image_mime:imageMime,
        images: allImages.length ? allImages : null
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    typingEl.remove();

    const se=_createStreamEl();
    const {flowEl,agentTag,taskBarEl,taskDotEl,taskLabelEl,taskTimerEl,taskStopBtn,msgBodyEl}=se;

    const reader=res.body.getReader(); const dec=new TextDecoder();
    let buf='', fullText='', lastAgent='orchestrator', searchHtml='';
    const toolCards={}; let planCard=null;
    // Text-segment tracking (Replit Agent-style inline layout)
    let currentTextDiv=null; let currentTextFull=''; let currentSearchHtml='';

    function _getTextSeg() {
      if (!currentTextDiv) {
        // Remove the default empty segment created by _createStreamEl
        const old = flowEl.querySelector('.text-seg:last-child');
        if (old && old.textContent.trim()==='') old.remove();
        currentTextDiv = document.createElement('div');
        currentTextDiv.className = 'text-seg';
        flowEl.appendChild(currentTextDiv);
        currentTextFull = ''; currentSearchHtml = '';
      }
      return currentTextDiv;
    }
    function _sealTextSeg() {
      if (currentTextDiv) {
        const c = currentTextDiv.querySelector('.cursor'); if (c) c.remove();
        if (!currentTextFull && !currentSearchHtml) currentTextDiv.remove();
        currentTextDiv = null; currentTextFull = ''; currentSearchHtml = '';
      }
    }

    while (true) {
      const {done,value}=await reader.read(); if (done) break;
      buf+=dec.decode(value,{stream:true});
      const lines=buf.split('\n'); buf=lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw=line.slice(6).trim();
        if (raw==='[DONE]') continue;
        try {
          const d=JSON.parse(raw);

          if (d.type==='task_id' && d.task_id) {
            currentTaskId=d.task_id;
            _startInlineTask(d.task_id,taskBarEl,taskDotEl,taskLabelEl,taskTimerEl,taskStopBtn);
            try { localStorage.setItem('nexus_active_task', JSON.stringify({
              task_id: d.task_id, ts: Date.now(), msg: userText.slice(0,120)
            })); } catch(_) {}
          }

          if (d.type==='plan' && d.steps && d.steps.length >= 2) {
            planCard = _createPlanCard(d.steps);
            flowEl.insertBefore(planCard, flowEl.firstChild);
            scrollToBottom();
          }

          if (d.type==='agent' && d.agent) {
            lastAgent=d.agent;
            _applyAgentTag(agentTag, d.agent);
            if (planCard) _activatePlanStep(planCard, d.agent);
          }

          if (d.type==='tool_start' && d.id && d.name) {
            _sealTextSeg();
            const card=_createToolCard(d.id, d.name, d.input||{}, d.agent_label);
            toolCards[d.id]=card;
            _toolMeta[d.id]={name:d.name, input:d.input||{}};
            flowEl.appendChild(card);
            if (_CODE_TOOLS.has(d.name)) {
              const lang  = d.name==='run_shell' ? 'sh' : (d.input?.language||'code');
              const label = d.name==='run_shell'
                ? ('$ '+(d.input?.command||'').slice(0,90))
                : d.name==='run_code'
                  ? (`▶ [${d.input?.language||'code'}] ${(d.input?.code||'').split('\n')[0].slice(0,70)}`)
                  : ('▶ debug: '+(d.input?.error||'').slice(0,60));
              _pendingConsoleEntries[d.id] = _consolePendingEntry(d.id, lang, label);
            }
            scrollToBottom();
          }

          if (d.type==='tool_result' && d.id && toolCards[d.id]) {
            const ok=d.ok!==false;
            _updateToolCard(toolCards[d.id], d.output||'', ok);
            if (_pendingConsoleEntries[d.id]) {
              _consoleCompleteEntry(_pendingConsoleEntries[d.id], d.output||'', ok);
              delete _pendingConsoleEntries[d.id];
            }
            delete _toolMeta[d.id];
            if (planCard && d.agent_type) _completePlanStep(planCard, d.agent_type);
            scrollToBottom();
          }

          if (d.type==='server_launched') {
            _sealTextSeg();
            const slCard = _createServerLaunchedCard(d);
            flowEl.appendChild(slCard);
            if (planCard) _completePlanStep(planCard, 'deploy');
            fetchProcesses();
            scrollToBottom();
            if (d.url) setTimeout(() => openSplitPreviewUrl(d.url, (d.name || 'App') + ' — Live'), 1200);
          }

          if (d.type==='image_result') {
            _sealTextSeg();
            const imgBlock=_createImageBlock(d.url, d.prompt, d.style, d.id);
            flowEl.appendChild(imgBlock);
            if (planCard) _completePlanStep(planCard, 'image');
            loadGallery();
            scrollToBottom();
          }

          if (d.type==='content' && d.content) {
            const seg = _getTextSeg();
            currentTextFull += d.content;
            fullText += d.content;
            seg.innerHTML = formatContent(currentTextFull) + currentSearchHtml + '<span class="cursor"></span>';
            scrollToBottomSmooth();
          }

          if (d.type==='search_result' && d.results) {
            currentSearchHtml = _buildSearchHtml(d.results);
            searchHtml = currentSearchHtml;
            const seg = _getTextSeg();
            seg.innerHTML = formatContent(currentTextFull) + currentSearchHtml + '<span class="cursor"></span>';
            if (planCard) _completePlanStep(planCard, 'search');
            scrollToBottom();
          }

          if (d.done && currentTaskId) _finishInlineTask(currentTaskId, false);
          if (d.error) {
            const seg = _getTextSeg();
            seg.innerHTML += `<br><span style="color:var(--orange)">Error: ${escapeHtml(d.error)}</span>`;
          }
          // ai_debug: API failed — store errors for retry button
          if (d.type === 'ai_debug' && d.errors) {
            window._lastAiDebugErrors = d.errors;
          }
        } catch(_) {}
      }
    }

    if (currentTaskId) _finishInlineTask(currentTaskId, false);
    try { localStorage.removeItem('nexus_active_task'); } catch(_) {}
    // Seal the last text segment
    _sealTextSeg();
    // Remove any leftover cursor
    flowEl.querySelectorAll('.cursor').forEach(c=>c.remove());
    if (!fullText && !searchHtml) {
      const noResp=document.createElement('div'); noResp.className='text-seg';
      noResp.innerHTML='<span style="color:var(--text3)">Task completed.</span>';
      flowEl.appendChild(noResp);
    }

    // ZIP download is only available via the Code Files drawer (⬇ ZIP button) — not auto-injected

    // Remove streaming class when done
    se.msgEl.classList.remove('streaming');

    // Add action buttons to completed streaming message
    const actionsDiv=document.createElement('div'); actionsDiv.className='msg-actions';
    actionsDiv.innerHTML=`
      <button class="msg-action-btn" onclick="copyMessage(this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy</button>
      <button class="msg-tts-btn" onclick="speakText(${JSON.stringify(fullText)},this)" title="Read aloud"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg> Speak</button>`;
    // Show retry button when AI fell back to offline mode
    if (window._lastAiDebugErrors) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'msg-action-btn';
      retryBtn.style.cssText = 'background:var(--blue);color:#fff;border-color:var(--blue);font-weight:600;';
      retryBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Retry`;
      const _retryMsg = userText;
      retryBtn.onclick = () => {
        window._lastAiDebugErrors = null;
        retryBtn.disabled = true;
        retryBtn.textContent = 'Retrying…';
        const inp = document.getElementById('chat-input');
        if (inp) { inp.value = _retryMsg; }
        sendMessage();
      };
      actionsDiv.appendChild(retryBtn);
      window._lastAiDebugErrors = null;  // consume it (shown once per failure)
    }
    msgBodyEl.appendChild(actionsDiv);

    // Auto-read if TTS enabled
    if (_ttsAutoRead && fullText) speakText(fullText);

    // Fire notification if user is away from the tab
    if (document.hidden || !document.hasFocus()) {
      _notifyTaskDone('NEXUS — Task Done ✓', userText);
    }

    const cleanedReply = _cleanAIText(fullText);
    conversation.push({role:'user',content:userText+(fileContext?'\n\n[Files: '+fileNames+']':'')});
    conversation.push({role:'assistant',content:cleanedReply||fullText});

    const existingH=loadHistory(); const existing=existingH.find(s=>s.id===currentSessionId);
    const msgs=existing?[...(existing.messages||[])]:[];
    msgs.push({role:'user',content:userText,time:msgTime,fileName:fileNames});
    msgs.push({role:'assistant',content:fullText,time:ts(),agent:lastAgent,task_id:currentTaskId||null,task_done:true});
    saveSession({
      id:currentSessionId,
      title:existing?.title||userText.slice(0,60),
      timestamp:existing?.timestamp||Date.now(),
      conversation:conversation.slice(-60),
      messages:msgs.slice(-200)
    });

  } catch(err) {
    if (err.name==='AbortError') return;
    if (currentTaskId) _finishInlineTask(currentTaskId, true);
    try { localStorage.removeItem('nexus_active_task'); } catch(_) {}
    typingEl.remove();
    const errEl=_createStreamEl();
    errEl.contentEl.innerHTML=`<span style="color:var(--orange)">Connection error: ${escapeHtml(err.message)}</span>`;
    _applyAgentTag(errEl.agentTag,'debug');
    const c=errEl.contentEl.querySelector('.cursor'); if(c) c.remove();
  } finally {
    currentAbort=null;
    setStatus('Ready','ready');
    _deactivateAllAgents();
    document.getElementById('send-btn').disabled=false;
    document.getElementById('chat-input').focus();
  }
}

function insertAndSend(text) {
  const i=document.getElementById('chat-input'); i.value=text; i.dispatchEvent(new Event('input')); sendMessage();
}

function clearChat(resetSession=true) {
  if (messagesEl) messagesEl.innerHTML='';
  if (emptyEl)    emptyEl.style.display='flex';
  if (messagesEl) messagesEl.style.display='flex';
  setStatus('Ready','ready'); _deactivateAllAgents();
  pendingFiles=[]; allCodeBlocks=[]; _gitRepoContext=null;
  _taskMap.forEach(t=>clearInterval(t.iv)); _taskMap.clear();
  updateFileBar(); _refreshCPDBadge();
  _resetToolStepCounter();
  if (resetSession) { currentSessionId=null; conversation=[]; }
}

// ── UI HELPERS ──
let _userScrolledUp = false;

function scrollToBottom() {
  const a = document.getElementById('chat-area');
  if (a) { a.scrollTop = a.scrollHeight; _userScrolledUp = false; _updateScrollBtn(); }
}
function scrollToBottomSmooth() {
  if (!_userScrolledUp) scrollToBottom();
}

function _updateScrollBtn() {
  const btn = document.getElementById('scroll-bottom-btn');
  if (!btn) return;
  const a = document.getElementById('chat-area');
  if (!a) return;
  const atBottom = a.scrollHeight - a.scrollTop - a.clientHeight < 80;
  btn.classList.toggle('visible', !atBottom);
}

function _initScrollBtn() {
  const a = document.getElementById('chat-area');
  if (!a) return;
  a.addEventListener('scroll', () => {
    const atBottom = a.scrollHeight - a.scrollTop - a.clientHeight < 80;
    _userScrolledUp = !atBottom;
    _updateScrollBtn();
  }, { passive: true });
}
function showMessages()   { if(emptyEl) emptyEl.style.display='none'; if(messagesEl) messagesEl.style.display='flex'; }
function setStatus(text, mode='ready') {
  const p=document.getElementById('status-pill'), l=document.getElementById('status-text');
  if (p&&l) { p.className='status-pill '+mode; l.textContent=text; }
}
function enableSend() {
  const i=document.getElementById('chat-input'), b=document.getElementById('send-btn');
  if (b) b.disabled=!i?.value.trim()&&!pendingFiles.length;
}

// ── GITHUB PUSH MODAL ──
function pushToGitHub() {
  document.getElementById('gh-modal-overlay').classList.add('open');
  ghStep(1);
}
function ghModalCancel() { document.getElementById('gh-modal-overlay').classList.remove('open'); }
function ghModalClose(e) { if(e.target===document.getElementById('gh-modal-overlay')) ghModalCancel(); }
function ghPickDir(dir) { document.getElementById('gh-dir-input').value=dir; }
function ghStep(n) {
  [1,2,3].forEach(i=>{
    document.getElementById('gh-panel-'+i).style.display=i===n?'block':'none';
    const s=document.getElementById('gh-step-'+i);
    s.className='gh-step'+(i===n?' active':i<n?' done':'');
  });
}
async function ghDoPush() {
  const repo   =document.getElementById('gh-repo-input')?.value.trim();
  const msg    =document.getElementById('gh-msg-input')?.value.trim()||'Update from NEXUS';
  const dir    =document.getElementById('gh-dir-input')?.value.trim()||(window.NEXUS_WORKSPACE||'/home/runner/workspace');
  const errEl  =document.getElementById('gh-push-error');
  const btn    =document.getElementById('gh-push-submit');
  if (!repo) { errEl.style.display='block'; errEl.textContent='Enter a repository URL'; return; }
  errEl.style.display='none'; btn.disabled=true; btn.textContent='Pushing...';
  try {
    const res=await fetch('/api/push-github',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repo,message:msg,directory:dir})});
    const data=await res.json();
    if (data.success) { ghModalCancel(); showToast('✓ Pushed to GitHub!'); }
    else { errEl.style.display='block'; errEl.textContent=data.error||'Push failed'; }
  } catch(e) { errEl.style.display='block'; errEl.textContent=e.message; }
  finally { btn.disabled=false; btn.textContent='Push'; }
}

// ── TERMINAL ──
let _termOpen=false, _termHistory=[], _termHistIdx=-1, _termCwd=(window.NEXUS_WORKSPACE||'/home/runner/workspace'), _termBusy=false;
let _termSession = 'terminal';  // Kali session slot

function initTerminal() {
  const ti=document.getElementById('terminal-input'); if(!ti) return;
  ti.addEventListener('keydown', e=>{
    if (e.key==='Enter') { e.preventDefault(); termSubmit(); }
    else if (e.key==='ArrowUp') { e.preventDefault(); if(_termHistory.length){_termHistIdx=Math.min(_termHistIdx+1,_termHistory.length-1);ti.value=_termHistory[_termHistory.length-1-_termHistIdx]||'';} }
    else if (e.key==='ArrowDown') { e.preventDefault(); _termHistIdx=Math.max(_termHistIdx-1,-1); ti.value=_termHistIdx<0?'':(_termHistory[_termHistory.length-1-_termHistIdx]||''); }
    else if (e.key==='l'&&e.ctrlKey) { e.preventDefault(); termClear(); }
  });
  document.getElementById('terminal-bar')?.addEventListener('dblclick', ()=>document.getElementById('terminal-panel').classList.toggle('tall'));
  termPrint('info','🐉 Kali Linux terminal — all commands run on real Kali machine');
  termPrint('info','Ctrl+L to clear · ↑↓ history · Double-click bar to resize');
  // Check Kali status
  _checkKaliStatus();
}

async function _checkKaliStatus() {
  const badge = document.getElementById('kali-badge');
  try {
    const r = await fetch('/api/kali-status');
    const d = await r.json();
    if (badge) {
      if (d.ok) {
        badge.className = 'kali-badge';
        badge.title = 'Kali Linux connected: ' + (d.output||'').split('\n')[0];
      } else {
        badge.className = 'kali-badge offline';
        badge.textContent = '🔴 Kali offline';
        badge.title = d.error || 'Cannot reach Kali';
      }
    }
  } catch(e) {
    if (badge) { badge.className='kali-badge offline'; badge.textContent='🔴 Kali?'; }
  }
}

function termNewSession() {
  _termSession = 'terminal_' + Date.now();
  fetch('/api/kali-session/reset', {method:'POST'}).catch(()=>{});
  termClear();
  termPrint('info', '🐉 New Kali session started — fresh shell environment');
}

function toggleTerminal() {
  _termOpen=!_termOpen;
  document.getElementById('terminal-panel').classList.toggle('open',_termOpen);
  document.getElementById('terminal-toggle-btn').classList.toggle('active',_termOpen);
  if (_termOpen) setTimeout(()=>document.getElementById('terminal-input')?.focus(),100);
}
function termClear() { const el=document.getElementById('terminal-output'); if(el) el.innerHTML=''; }
function termPrint(type, text) {
  const out=document.getElementById('terminal-output'); if(!out) return;
  text.split('\n').forEach(line=>{ const p=document.createElement('p'); p.className=`term-line ${type}`; p.textContent=line; out.appendChild(p); });
  out.scrollTop=out.scrollHeight;
}
async function termSubmit() {
  const ti=document.getElementById('terminal-input');
  const cmd=ti.value.trim(); if(!cmd||_termBusy) return;
  ti.value=''; _termHistIdx=-1; _termHistory.push(cmd);
  if (_termHistory.length>200) _termHistory.shift();

  if (cmd==='clear'||cmd==='cls') { termClear(); return; }
  if (cmd==='new session'||cmd==='reset') { termNewSession(); return; }

  termPrint('cmd','$ '+cmd); _termBusy=true;
  const runBtn=document.querySelector('.term-run-btn'); if(runBtn) runBtn.disabled=true;
  const t0=Date.now();
  try {
    const r=await fetch('/api/shell',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({command:cmd, cwd:_termCwd, session:_termSession, timeout:90})});
    const d=await r.json();
    const ms=Date.now()-t0;
    const host = d.kali ? '🐉 kali' : '🖥 local';

    // Track cd on local fallback only
    if (!d.kali && cmd.startsWith('cd ') && d.stdout?.trim()) {
      _termCwd=d.stdout.trim();
      const cwdEl=document.getElementById('term-cwd'); if(cwdEl) cwdEl.textContent=_termCwd;
    }

    if (d.stdout&&d.stdout.trim()) termPrint('out', d.stdout.trimEnd());
    if (d.stderr&&d.stderr.trim()) termPrint('err', d.stderr.trimEnd());
    if (!d.stdout?.trim()&&!d.stderr?.trim()) termPrint('info','(no output)');

    const rc=d.returncode??(d.success?0:1);
    termPrint('meta', `[${host} · ${ms}ms${rc!==0?' · exit '+rc:''}]`);

    consolePush('sh','$ '+cmd, ((d.stdout||'')+(d.stderr?'\n[stderr]\n'+d.stderr:'')).trim()||'(no output)', rc);
  } catch(e) { termPrint('err','Request failed: '+e.message); }
  finally { _termBusy=false; if(runBtn) runBtn.disabled=false; document.getElementById('terminal-input')?.focus(); }
}
function terminalRun(cmd) {
  if (!_termOpen) toggleTerminal();
  const ti=document.getElementById('terminal-input'); if(ti) ti.value=cmd;
  setTimeout(termSubmit,300);
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', ()=>{
  messagesEl=document.getElementById('messages');
  emptyEl=document.getElementById('empty-state');
  const input=document.getElementById('chat-input');

  input.addEventListener('input', ()=>{
    input.style.height='auto';
    input.style.height=Math.min(input.scrollHeight,140)+'px';
    enableSend();
  });
  input.addEventListener('keydown', e=>{
    // Enter always inserts a newline — only the send button submits
    if (e.key==='Enter') { e.stopPropagation(); }
  });
  document.addEventListener('keydown', e=>{
    if (e.key==='Escape') {
      if (document.getElementById('img-lightbox-overlay').classList.contains('open')) { closeImgLightbox(); return; }
      if (document.getElementById('preview-modal').classList.contains('open')) { closePreview(); return; }
      if (_splitPreviewOpen) { closeSplitPreview(); return; }
      if (_cpdOpen) { closeCodePreview(); return; }
      if (_galleryOpen) { closeImageGallery(); return; }
      closeHistory();
    }
  });

  // Init git import enter key
  document.getElementById('git-url-input')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){e.preventDefault();importGitRepo();} });

  // Image gallery prompt enter
  document.getElementById('img-prompt')?.addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();generateImageDirect();} });

  initDragDrop();
  initTerminal();
  loadGallery();
  _initScrollBtn();
  input.focus();
  _checkForActiveTask();

  // ── Kali Live Stream Panel ──
  window._kaliLiveOpen  = false;
  window._kaliLiveSSE   = null;
  window._kaliLiveLines = 0;
  window._kaliLiveSlot  = '';
  window._kaliLiveTimer = null;
  window._kaliLiveStart = 0;
  window._kaliLiveAccum = [];  // accumulated output lines for "Send to Chat"

  window.toggleKaliLive = function() {
    window._kaliLiveOpen = !window._kaliLiveOpen;
    const panel = document.getElementById('kali-live-panel');
    const btn   = document.getElementById('kali-live-btn');
    panel.classList.toggle('open', window._kaliLiveOpen);
    document.body.classList.toggle('kali-live-open', window._kaliLiveOpen);
    if (btn) btn.classList.toggle('active', window._kaliLiveOpen);
    if (window._kaliLiveOpen) {
      setTimeout(() => document.getElementById('kali-live-target')?.focus(), 120);
    }
  };

  window.setKaliPreset = function(cmd) {
    const c = document.getElementById('kali-live-cmd');
    if (c) { c.value = cmd; c.focus(); }
  };

  window.kaliLiveClear = function() {
    const out = document.getElementById('kali-live-output');
    if (out) out.innerHTML = '';
    window._kaliLiveLines = 0;
    window._kaliLiveAccum = [];
    const stats = document.getElementById('kali-live-stats');
    if (stats) stats.textContent = 'Ready';
    const dot = document.getElementById('kali-live-status');
    if (dot) dot.className = 'kali-live-dot';
  };

  window.kaliLiveCopy = function() {
    const text = window._kaliLiveAccum.join('\n');
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => showToast('Output copied'));
  };

  window.kaliLiveSendToChat = function() {
    const text = window._kaliLiveAccum.join('\n');
    if (!text) return;
    const inp = document.getElementById('user-input');
    if (inp) {
      inp.value = 'Analyze this Kali scan output and give me attack vectors:\n\n```\n' + text.slice(0, 4000) + '\n```';
      inp.focus();
      inp.dispatchEvent(new Event('input'));
    }
    showToast('Output pasted into chat');
  };

  window.kaliLiveStop = function() {
    if (window._kaliLiveSSE) {
      window._kaliLiveSSE.close();
      window._kaliLiveSSE = null;
    }
    clearInterval(window._kaliLiveTimer);
    window._kaliLiveTimer = null;
    // Tell server to kill the background process
    if (window._kaliLiveSlot) {
      fetch('/api/kali/stream-stop', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({slot: window._kaliLiveSlot})
      }).catch(()=>{});
    }
    const dot    = document.getElementById('kali-live-status');
    const runBtn = document.getElementById('kali-live-run');
    const stopBtn = document.getElementById('kali-live-stop');
    const stats  = document.getElementById('kali-live-stats');
    if (dot)    dot.className = 'kali-live-dot error';
    if (runBtn) runBtn.disabled = false;
    if (stopBtn) stopBtn.style.display = 'none';
    if (stats)  stats.textContent = window._kaliLiveLines + ' lines · stopped';
    _klPrint('— stopped by user —', 'meta');
  };

  function _klLineClass(text) {
    const t = text.toLowerCase();
    if (/\b(open|found|success|valid|\[+\]|credential|vulnerable|login correct|sql injection|injectable)\b/.test(t))
      return 'kl-hit';
    if (/\b(error|failed|refused|denied|unreachable|not found|cannot|unable)\b/.test(t))
      return 'kl-err';
    if (/\b(warning|filtered|timeout|closed|skipping)\b/.test(t))
      return 'kl-warn';
    if (/\b(nmap scan|host is up|service|version|starting nmap|port\s+\d+|discovered)\b/.test(t) ||
        text.startsWith('[') || text.startsWith('==['))
      return 'kl-info';
    return 'kl-out';
  }

  function _klPrint(text, cls) {
    const out = document.getElementById('kali-live-output');
    if (!out) return;
    const p = document.createElement('p');
    p.className = 'kl-line ' + (cls || _klLineClass(text));
    p.textContent = text;
    out.appendChild(p);
    out.scrollTop = out.scrollHeight;
    window._kaliLiveLines++;
    if (cls !== 'meta' && cls !== 'cmd') window._kaliLiveAccum.push(text);
  }

  function _klStartTimer() {
    clearInterval(window._kaliLiveTimer);
    window._kaliLiveStart = Date.now();
    window._kaliLiveTimer = setInterval(() => {
      const s = ((Date.now() - window._kaliLiveStart) / 1000).toFixed(0);
      const stats = document.getElementById('kali-live-stats');
      if (stats) stats.textContent = window._kaliLiveLines + ' lines · ' + s + 's';
    }, 1000);
  }

  window.runKaliLive = function() {
    const cmdEl    = document.getElementById('kali-live-cmd');
    const targetEl = document.getElementById('kali-live-target');
    const runBtn   = document.getElementById('kali-live-run');
    const stopBtn  = document.getElementById('kali-live-stop');
    const dot      = document.getElementById('kali-live-status');
    const stats    = document.getElementById('kali-live-stats');

    const cmd    = (cmdEl?.value || '').trim();
    const target = (targetEl?.value || '').trim();
    if (!cmd) { cmdEl?.focus(); return; }

    // Cancel any running stream
    if (window._kaliLiveSSE) { window._kaliLiveSSE.close(); window._kaliLiveSSE = null; }
    clearInterval(window._kaliLiveTimer);

    // Reset state
    window._kaliLiveLines = 0;
    window._kaliLiveAccum = [];

    // Generate a unique slot per run so sessions don't collide
    window._kaliLiveSlot = 'kali_live_' + Date.now();

    // Show running state
    if (runBtn)  runBtn.disabled = true;
    if (stopBtn) stopBtn.style.display = 'inline-flex';
    if (dot)     dot.className = 'kali-live-dot running';
    if (stats)   stats.textContent = '0 lines · 0s';

    // Print command header
    const displayCmd = target ? cmd.replace(/\{target\}/g, target) : cmd;
    _klPrint('$ ' + displayCmd, 'cmd');
    _klStartTimer();

    const params = new URLSearchParams({ cmd, target, slot: window._kaliLiveSlot });
    const sse    = new EventSource('/api/kali/stream-live?' + params.toString());
    window._kaliLiveSSE = sse;

    sse.onmessage = function(e) {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }

      if (data.type === 'line') {
        _klPrint(data.line);
      } else if (data.type === 'error') {
        _klPrint(data.line || 'Error', 'kl-err');
      } else if (data.type === 'ping') {
        // keepalive — update timer only
      } else if (data.type === 'start') {
        // already handled
      } else if (data.type === 'done') {
        clearInterval(window._kaliLiveTimer);
        window._kaliLiveTimer = null;
        const elapsed = (data.elapsed || ((Date.now() - window._kaliLiveStart) / 1000)).toFixed(1);
        _klPrint('─── done in ' + elapsed + 's · ' + window._kaliLiveLines + ' lines ───', 'meta');
        if (dot)    dot.className = 'kali-live-dot ' + (data.ok !== false ? 'done' : 'error');
        if (stats)  stats.textContent = window._kaliLiveLines + ' lines · ' + elapsed + 's';
        if (runBtn)  runBtn.disabled = false;
        if (stopBtn) stopBtn.style.display = 'none';
        sse.close();
        window._kaliLiveSSE = null;
      }
    };

    sse.onerror = function() {
      clearInterval(window._kaliLiveTimer);
      window._kaliLiveTimer = null;
      if (dot)    dot.className = 'kali-live-dot error';
      if (runBtn)  runBtn.disabled = false;
      if (stopBtn) stopBtn.style.display = 'none';
      sse.close();
      window._kaliLiveSSE = null;
    };
  };

  // Initialise dynamic workspace paths
  const _ws = window.NEXUS_WORKSPACE || '/home/runner/workspace';
  const cwdEl = document.getElementById('term-cwd');
  if (cwdEl) cwdEl.textContent = _ws;
  _termCwd = _ws;

  // Wire up GitHub quick-pick buttons
  const ghPickRoot = document.getElementById('gh-pick-root');
  const ghPickSub  = document.getElementById('gh-pick-sub');
  const ghDirInput = document.getElementById('gh-dir-input');
  if (ghDirInput) ghDirInput.value = _ws;
  if (ghPickRoot) ghPickRoot.onclick = () => { if(ghDirInput) ghDirInput.value = _ws; };
  if (ghPickSub)  ghPickSub.onclick  = () => { if(ghDirInput) ghDirInput.value = _ws + '/multi_agent_system'; };

  // Initialise service worker and restore notification state
  initNotifications();
});

// ── PUSH / BROWSER NOTIFICATIONS ──
let _swRegistration = null;
let _notifSubscription = null;

async function initNotifications() {
  if (!('serviceWorker' in navigator)) return;
  try {
    _swRegistration = await navigator.serviceWorker.register('/static/sw.js');
    // Update button state from saved pref
    const saved = localStorage.getItem('nexus_notif_enabled');
    if (saved === '1' && Notification.permission === 'granted') {
      _restorePushSubscription();
      _setNotifBtnState(true);
    }
  } catch(e) { console.log('[NEXUS] SW reg failed:', e); }
}

async function _restorePushSubscription() {
  try {
    if (!_swRegistration) return;
    const existing = await _swRegistration.pushManager.getSubscription();
    if (existing) { _notifSubscription = existing; }
  } catch(_) {}
}

async function requestNotifPermission() {
  if (!('Notification' in window)) { showToast('Notifications not supported in this browser'); return; }
  const btn = document.getElementById('notif-btn');
  const current = Notification.permission;

  // Toggle: if already granted and subscribed, unsubscribe
  if (current === 'granted' && _notifSubscription) {
    try {
      await _notifSubscription.unsubscribe();
      await fetch('/api/push/unsubscribe', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({endpoint: _notifSubscription.endpoint})
      });
    } catch(_) {}
    _notifSubscription = null;
    _setNotifBtnState(false);
    localStorage.setItem('nexus_notif_enabled', '0');
    showToast('Notifications disabled');
    return;
  }

  // Request permission
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    await _subscribeToPush();
    _setNotifBtnState(true);
    localStorage.setItem('nexus_notif_enabled', '1');
    showToast('Notifications enabled — you\'ll be alerted when tasks finish');
  } else {
    showToast('Permission denied — enable notifications in browser settings');
    _setNotifBtnState(false);
  }
}

async function _subscribeToPush() {
  try {
    if (!_swRegistration) return;
    // Get VAPID public key from backend
    const resp = await fetch('/api/push/vapid-key');
    if (!resp.ok) return;
    const {public_key} = await resp.json();
    if (!public_key) return;

    // Convert base64url VAPID key to Uint8Array
    const base64 = public_key.replace(/-/g,'+').replace(/_/g,'/');
    const raw = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

    const sub = await _swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: raw,
    });
    _notifSubscription = sub;

    // Send subscription to backend
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(sub.toJSON()),
    });
  } catch(e) {
    console.log('[NEXUS] Push subscribe error:', e);
    // Fallback: at least we have Notification permission for direct notifications
  }
}

function _notifyTaskDone(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const opts = {
      body: (body || 'Task complete!').slice(0, 120),
      icon: '/static/icon-192.png',
      badge: '/static/icon-192.png',
      tag: 'nexus-done',
      vibrate: [200, 100, 200],
      requireInteraction: false,
    };
    if (_swRegistration) {
      _swRegistration.showNotification(title || 'NEXUS', opts).catch(()=>{
        new Notification(title || 'NEXUS', opts);
      });
    } else {
      new Notification(title || 'NEXUS', opts);
    }
  } catch(e) { console.log('[NEXUS] Notification error:', e); }
}

function _setNotifBtnState(enabled) {
  const btn = document.getElementById('notif-btn');
  if (!btn) return;
  btn.classList.toggle('active', enabled);
  btn.title = enabled ? 'Notifications ON — click to disable' : 'Enable push notifications';
}

function toggleUserMenu() {
  const dd = document.getElementById('user-dropdown');
  if (!dd) return;
  dd.classList.toggle('open');
  // Close when clicking outside
  if (dd.classList.contains('open')) {
    const handler = (e) => {
      if (!document.getElementById('user-menu')?.contains(e.target)) {
        dd.classList.remove('open');
        document.removeEventListener('click', handler);
      }
    };
    setTimeout(() => document.addEventListener('click', handler), 10);
  }
}
