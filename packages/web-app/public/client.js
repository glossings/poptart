'use strict';

// Browser UI: CodeMirror editor with poptart-aware autocomplete (real VST parameter names
// inside `.param("…")`, plugin names inside `.s("…")`/`.fx("…")`, method/builder names
// elsewhere), a searchable params panel, plugin browser, and transport - all over the same
// fetch('/api/…') endpoints as before. No build step: CodeMirror 5 is loaded as plain scripts
// from /vendor/codemirror/ (served out of node_modules by server.js).

const evalBtn = document.getElementById('evalBtn');
const stopBtn = document.getElementById('stopBtn');
const scanBtn = document.getElementById('scanBtn');
const engineStatus = document.getElementById('engineStatus');
const trackInfo = document.getElementById('trackInfo');
const paramSearch = document.getElementById('paramSearch');
const paramList = document.getElementById('paramList');
const paramsCount = document.getElementById('paramsCount');
const pluginList = document.getElementById('pluginList');
const log = document.getElementById('log');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed: ${res.status}`);
  return data;
}

function logLine(text, isError = false) {
  const line = document.createElement('div');
  if (isError) line.className = 'error';
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  log.prepend(line);
}

function copyText(text, what) {
  navigator.clipboard.writeText(text);
  logLine(`copied ${what}: ${text}`);
}

// ---------------------------------------------------------------------------------------------
// Editor + autocomplete
// ---------------------------------------------------------------------------------------------

// Completion sources. `chainSlots` comes from GET /api/chainParams after each eval:
// [{ slot, plugin, params: [{ name, label, index }] }]. `knownPlugins` from the plugin scan.
let chainSlots = [];
let knownPlugins = [];

const BUILDERS = ['n', 'note', 'mini', 'sine', 'saw', 'tri', 'square', 'env'];
const METHODS = ['scale', 's', 'fx', 'param', 'range', 'fast', 'rate', 'phase'];

// The sublime keymap supplies the expected editing chords (Cmd/Ctrl-/ comment, Cmd/Ctrl-D
// select-next, line swapping, etc.); extraKeys layers transport + VS Code-style duplicate-line
// on top and wins on conflicts.
const cm = CodeMirror.fromTextArea(document.getElementById('editor'), {
  mode: { name: 'javascript' },
  theme: 'poptart',
  keyMap: 'sublime',
  lineNumbers: true,
  matchBrackets: true,
  autoCloseBrackets: true,
  viewportMargin: Infinity,
  extraKeys: {
    'Cmd-Enter': doEval,
    'Ctrl-Enter': doEval,
    'Cmd-.': doStop,
    'Ctrl-.': doStop,
    'Shift-Cmd-Down': 'duplicateLine',
    'Shift-Ctrl-Down': 'duplicateLine',
    'Shift-Alt-Down': 'duplicateLine',
    'Ctrl-Space': (cm) => cm.showHint({ hint: poptartHint, completeSingle: false }),
  },
});

// Transport hotkeys work no matter what has focus (params search, plugin list, …). When the
// editor has focus CodeMirror handles these first and preventDefaults, so no double-fire.
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    doEval();
  } else if (e.key === '.') {
    e.preventDefault();
    doStop();
  }
});

// Rank case-insensitively: prefix matches first, then substring matches, alphabetical within
// each group. Used for params and plugin names alike.
function rankedMatches(names, typed, limit) {
  const q = typed.toLowerCase();
  const starts = [];
  const contains = [];
  for (const item of names) {
    const idx = item.key.toLowerCase().indexOf(q);
    if (idx === 0) starts.push(item);
    else if (idx > 0) contains.push(item);
  }
  return [...starts, ...contains].slice(0, limit);
}

function hintResult(cur, typed, completions) {
  return {
    list: completions,
    from: CodeMirror.Pos(cur.line, cur.ch - typed.length),
    to: cur,
  };
}

// A `.param(` call targets whatever is last in the chain at that point in the method chain:
// slot 0 (the instrument) before any .fx(), then slot 1, 2, … after each. Counting `.fx(`
// occurrences before the cursor mirrors that rule.
function slotAtCursor(textBefore) {
  return (textBefore.match(/\.fx\s*\(/g) ?? []).length;
}

function paramHints(cur, typed, textBefore) {
  const slot = slotAtCursor(textBefore);
  const entry = chainSlots.find((s) => s.slot === slot);
  // Fall back to every loaded plugin's params (tagged by plugin) if the slot isn't loaded yet.
  const pool = entry?.params?.length
    ? entry.params.map((p) => ({ key: p.name, param: p }))
    : chainSlots.flatMap((s) => s.params.map((p) => ({ key: p.name, param: p, plugin: s.plugin })));
  const completions = rankedMatches(pool, typed, 80).map((item) => ({
    text: item.param.name,
    displayText:
      item.param.name +
      (item.param.label ? ` · ${item.param.label}` : '') +
      (item.plugin ? `  (${item.plugin})` : ''),
  }));
  return hintResult(cur, typed, completions);
}

function pluginHints(cur, typed) {
  const pool = knownPlugins.map((p) => ({ key: p.name, plugin: p }));
  const completions = rankedMatches(pool, typed, 40).map((item) => ({
    text: item.plugin.name,
    displayText: `${item.plugin.name}  (${item.plugin.format}${item.plugin.isInstrument ? ', instrument' : ''})`,
  }));
  return hintResult(cur, typed, completions);
}

function wordHints(cur, typed, words) {
  const pool = words.map((w) => ({ key: w }));
  const completions = rankedMatches(pool, typed, 20).map((item) => ({
    text: `${item.key}(`,
    displayText: `${item.key}(`,
  }));
  return hintResult(cur, typed, completions);
}

function poptartHint(cm) {
  const cur = cm.getCursor();
  const before = cm.getRange(CodeMirror.Pos(0, 0), cur);

  // Inside the name string of .param(" → real VST parameter names.
  let m = before.match(/\.param\s*\(\s*["']([^"']*)$/);
  if (m) return paramHints(cur, m[1], before);

  // Inside .s(" or .fx(" → scanned plugin names.
  m = before.match(/\.(?:s|fx)\s*\(\s*["']([^"']*)$/);
  if (m) return pluginHints(cur, m[1]);

  // After a dot → chain methods; bare word → top-level builders.
  m = before.match(/\.([A-Za-z_]*)$/);
  if (m) return wordHints(cur, m[1], METHODS);
  m = before.match(/(?:^|[^.\w"'])([A-Za-z_]+)$/);
  if (m) return wordHints(cur, m[1], BUILDERS);

  return { list: [], from: cur, to: cur };
}

// Auto-open the hint popup while typing (quotes/parens/word chars, plus spaces so multi-word
// param names like "Filter 1 Freq" keep the popup alive).
cm.on('inputRead', (cm, change) => {
  if (cm.state.completionActive) return;
  const typedChar = change.text[change.text.length - 1].slice(-1);
  if (/[\w"'( ]/.test(typedChar)) {
    cm.showHint({ hint: poptartHint, completeSingle: false });
  }
});

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

async function refreshStatus() {
  const { loaded, error } = await api('GET', '/api/status');
  engineStatus.textContent = loaded ? 'engine ready' : `engine not loaded: ${error}`;
  engineStatus.className = `status ${loaded ? 'ok' : 'error'}`;
  return loaded;
}

function renderTrack(result) {
  trackInfo.innerHTML = '';
  const chain = [result.instrument, ...result.fxChain];
  chain.forEach((plugin, slot) => {
    const row = document.createElement('div');
    row.className = 'chain-row';
    const name = document.createElement('span');
    name.textContent = `${slot}  ${plugin ?? '(no instrument)'}`;
    row.appendChild(name);
    if (plugin) {
      const uiBtn = document.createElement('button');
      uiBtn.className = 'small';
      uiBtn.textContent = 'ui';
      uiBtn.title = "open the plugin's own editor window";
      uiBtn.onclick = () => api('POST', '/api/showEditor', { slot }).catch((e) => logLine(e.message, true));
      row.appendChild(uiBtn);
    }
    trackInfo.appendChild(row);
  });
  if (result.paramNames.length) {
    const row = document.createElement('div');
    row.className = 'chain-params';
    row.textContent = `modulating: ${result.paramNames.join(', ')}`;
    trackInfo.appendChild(row);
  }
}

async function doEval() {
  try {
    const result = await api('POST', '/api/evaluate', { code: cm.getValue() });
    renderTrack(result);
    logLine('evaluated ok');
    loadChainParams();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function doStop() {
  await api('POST', '/api/stop');
  logLine('stopped');
}

// ---------------------------------------------------------------------------------------------
// Params panel (also feeds autocomplete via `chainSlots`)
// ---------------------------------------------------------------------------------------------

const MAX_PARAM_ROWS = 300;

function renderParams() {
  const query = paramSearch.value.trim().toLowerCase();
  paramList.innerHTML = '';

  const total = chainSlots.reduce((sum, s) => sum + s.params.length, 0);
  paramsCount.textContent = total ? `${total}` : '';
  if (!chainSlots.length) {
    paramList.textContent = 'evaluate a pattern to load its plugins’ parameters';
    return;
  }

  let shown = 0;
  let matched = 0;
  for (const slot of chainSlots) {
    const matches = slot.params.filter((p) => !query || p.name.toLowerCase().includes(query));
    matched += matches.length;

    const head = document.createElement('div');
    head.className = 'slot-head';
    head.textContent = `${slot.slot} · ${slot.plugin} — ${slot.error ?? `${matches.length}${query ? ` of ${slot.params.length}` : ''} params`}`;
    paramList.appendChild(head);

    for (const p of matches) {
      if (shown >= MAX_PARAM_ROWS) break;
      const row = document.createElement('div');
      row.className = 'param-row';
      row.title = 'click to copy';
      const name = document.createElement('span');
      name.textContent = p.name;
      row.appendChild(name);
      if (p.label) {
        const label = document.createElement('span');
        label.className = 'dim';
        label.textContent = p.label;
        row.appendChild(label);
      }
      row.onclick = () => copyText(p.name, 'param');
      paramList.appendChild(row);
      shown++;
    }
  }

  if (matched > shown) {
    const more = document.createElement('div');
    more.className = 'more-note';
    more.textContent = `…${matched - shown} more — refine the filter to see them`;
    paramList.appendChild(more);
  }
}

async function loadChainParams() {
  paramList.textContent = 'loading params… (first load of a plugin can take a few seconds)';
  try {
    const { slots } = await api('GET', '/api/chainParams');
    chainSlots = slots;
    renderParams();
    for (const s of slots.filter((s) => s.error)) {
      logLine(`params for slot ${s.slot} (${s.plugin}): ${s.error}`, true);
    }
  } catch (e) {
    paramList.textContent = 'failed to load params';
    logLine(e.message ?? String(e), true);
  }
}

paramSearch.addEventListener('input', renderParams);

// ---------------------------------------------------------------------------------------------
// Plugin browser (also feeds autocomplete via `knownPlugins`)
// ---------------------------------------------------------------------------------------------

function renderPlugins(plugins) {
  knownPlugins = plugins;
  pluginList.innerHTML = '';
  if (!plugins.length) {
    pluginList.textContent = 'no plugins found';
    return;
  }
  for (const p of plugins) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    row.title = 'click to copy';
    const name = document.createElement('span');
    name.textContent = p.name;
    row.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'dim';
    meta.textContent = `${p.format}${p.isInstrument ? ' · inst' : ''}`;
    row.appendChild(meta);
    row.onclick = () => copyText(p.name, 'plugin');
    pluginList.appendChild(row);
  }
}

async function doScan() {
  logLine('scanning for plugins…');
  try {
    const { plugins, crashed } = await api('POST', '/api/scanPlugins', { extraPaths: [] });
    renderPlugins(plugins);
    logLine(`found ${plugins.length} plugin(s)`);
    if (crashed.length) {
      logLine(`skipped ${crashed.length} plugin(s) that crashed the scanner: ${crashed.join(', ')}`, true);
    }
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// The engine's boot-time VSTPlugin.search usually already knows the plugins - populate the
// browser (and .s()/.fx() autocomplete) without requiring a manual rescan.
async function loadKnownPlugins() {
  try {
    const plugins = await api('GET', '/api/knownPlugins');
    if (plugins.length) {
      renderPlugins(plugins);
      logLine(`${plugins.length} plugin(s) known`);
    }
  } catch {
    // engine not up yet - the rescan button still works later
  }
}

// ---------------------------------------------------------------------------------------------
// Theme picker - themes are palette blocks in style.css (`:root[data-theme="…"]`); adding one
// there + here is all it takes. index.html applies the saved choice pre-paint.
// ---------------------------------------------------------------------------------------------

const THEMES = ['poptart', 'blueberry', 'matcha', 'paper'];
const themeSelect = document.getElementById('themeSelect');
for (const t of THEMES) themeSelect.add(new Option(t, t));
themeSelect.value = THEMES.includes(document.documentElement.dataset.theme)
  ? document.documentElement.dataset.theme
  : 'poptart';
themeSelect.addEventListener('change', () => {
  document.documentElement.dataset.theme = themeSelect.value;
  localStorage.setItem('poptart-theme', themeSelect.value);
});

// ---------------------------------------------------------------------------------------------

evalBtn.addEventListener('click', doEval);
stopBtn.addEventListener('click', doStop);
scanBtn.addEventListener('click', doScan);

refreshStatus().then((loaded) => {
  if (loaded) loadKnownPlugins();
});
