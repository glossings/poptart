'use strict';

// Browser UI: CodeMirror editor with poptart-aware autocomplete (real VST parameter names
// inside `.param("…")`, plugin names inside `.synth("…")`/`.fx("…")`, method/builder names
// elsewhere), live playback highlighting of mini-notation (the atom currently sounding lights
// up, Strudel-style), a searchable params panel, plugin browser, an interactive theme editor,
// and transport - all over the same fetch('/api/…') endpoints. No build step: CodeMirror 5 is
// loaded as plain scripts from /vendor/codemirror/, and pattern-core's own mini parser + label
// splitter are imported as ESM from /pattern-core/ (both served by server.js), so the browser
// computes exactly the same steps the server plays.

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

// pattern-core modules, loaded async at startup; highlighting/label/shape-editor features just
// stay off until they arrive (or if the import fails).
let miniMod = null;
let labelsMod = null;
let shapeMod = null;
Promise.all([
  import('/pattern-core/mini.mjs'),
  import('/pattern-core/labels.mjs'),
  import('/pattern-core/shape.mjs'),
])
  .then(([m, l, s]) => {
    miniMod = m;
    labelsMod = l;
    shapeMod = s;
    initLfoEditor();
    updateMutedDim();
  })
  .catch((e) => logLine(`pattern-core import failed (no live highlighting / lfo editor): ${e.message}`, true));

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
  // Mirror everything to the devtools console too, so the log is still there when the in-app
  // console is minimized (and gets devtools' filtering/timestamps).
  (isError ? console.error : console.log)(`[poptart] ${text}`);
}

function copyText(text, what) {
  navigator.clipboard.writeText(text);
  logLine(`copied ${what}: ${text}`);
}

// ---------------------------------------------------------------------------------------------
// Editor + autocomplete
// ---------------------------------------------------------------------------------------------

// Completion sources. `chainSlots` comes from GET /api/chainParams after each eval:
// [{ track, slot, plugin, params: [{ name, label, index }] }]. `knownPlugins` from the scan.
let chainSlots = [];
let knownPlugins = [];

const BUILDERS = ['n', 'note', 'mini', 's', 'synth', 'sine', 'saw', 'tri', 'square', 'ramp', 'rand', 'lfo', 'env', 'midicc', 'midikeys', 'setbpm'];
const METHODS = [
  'scale', 'synth', 'fx', 'param', 'gain', 'pan', 'o', 'vel', 'range', 'fast', 'rate', 'phase', 'curve',
  'add', 'sub', 'mul', 'div', 'mod', 'round', 'abs', 'floor', 'ceil', 'clamp',
  'gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'when', 'hold', 'as',
  'i', 'n', 'note', 'begin', 'end', 'loop', 'speed', 'stretch', 'fit', 'slice',
];

// The sublime keymap supplies the expected editing chords (Cmd/Ctrl-/ comment, Cmd/Ctrl-D
// select-next, etc.); extraKeys layers transport + VS Code-style line moving/duplication
// (Alt-Up/Down move, Shift-Alt-Down copies) on top and wins on conflicts.
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
    'Shift-Alt-Down': 'duplicateLine',
    'Alt-Up': 'swapLineUp',
    'Alt-Down': 'swapLineDown',
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

// ---------------------------------------------------------------------------------------------
// Code-in-URL sharing (Strudel-style): the buffer is kept base64url-encoded in location.hash
// (replaceState, so typing doesn't spam history) - copy the URL to share the patch; opening a
// link restores the code instead of the default snippet.
// ---------------------------------------------------------------------------------------------

function encodeCodeHash(code) {
  const bytes = new TextEncoder().encode(code);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCodeHash(hash) {
  const bin = atob(hash.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

if (location.hash.length > 1) {
  try {
    cm.setValue(decodeCodeHash(location.hash.slice(1)));
    foldConfigBlobs();
  } catch {
    logLine('could not decode code from the URL - keeping the default snippet', true);
  }
}

// ---------------------------------------------------------------------------------------------
// Config folding: captured plugin-state blobs (`synth("Serum 2", { state: "..." })`) and long
// lfo() shape strings collapse to a small clickable widget so they don't drown the code. The
// full text stays in the buffer - and therefore in the URL hash - only the *display* folds.
// Click a widget to expand it; everything re-folds on load and after each eval.
// ---------------------------------------------------------------------------------------------

function foldSpan(fromIdx, toIdx, label, title) {
  const from = cm.posFromIndex(fromIdx);
  const to = cm.posFromIndex(toIdx);
  if (cm.findMarks(from, to).some((mk) => mk.poptartFold)) return; // already folded
  const widget = document.createElement('span');
  widget.className = 'cm-config-fold';
  widget.textContent = label;
  widget.title = title;
  const mk = cm.markText(from, to, { replacedWith: widget, atomic: true });
  mk.poptartFold = true;
  widget.onclick = () => mk.clear();
}

function foldConfigBlobs() {
  const code = cm.getValue();
  let m;
  // Captured plugin state objects - base64ish payload, so a simple regex is safe.
  const stateRe = /\{\s*state:\s*"[A-Za-z0-9+/=]+"\s*\}/g;
  while ((m = stateRe.exec(code))) {
    const kb = Math.max(1, Math.round(m[0].length / 1024));
    foldSpan(m.index, m.index + m[0].length, `{⋯${kb}kb}`, 'captured plugin state — click to expand');
  }
  // Long lfo() shape strings; short ones stay readable inline.
  const lfoRe = /\blfo\s*\(\s*("(?:[^"\\\n]|\\.)*")/g;
  while ((m = lfoRe.exec(code))) {
    const str = m[1];
    if (str.length < 24) continue;
    const start = m.index + m[0].length - str.length;
    foldSpan(start, start + str.length, '"⋯"', 'lfo shape — click to expand, or use the shape editor');
  }
}

// String/bracket-aware scan from an opening paren to its matching close; -1 if unbalanced.
function matchParen(code, openIdx) {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Index just past the closing quote of the first string literal in [from, to); -1 if none.
function endOfFirstString(code, from, to) {
  for (let i = from; i < to; i++) {
    const q = code[i];
    if (q !== '"' && q !== "'") continue;
    for (let j = i + 1; j < to; j++) {
      if (code[j] === '\\') j++;
      else if (code[j] === q) return j + 1;
    }
    return -1;
  }
  return -1;
}

// Locates the synth(...) call (slot 0) or the slot-th .fx(...) call inside a track's block and
// returns where its `{ state }` argument goes: [afterFirstArg, closeParen).
function findChainCall(code, from, to, slot) {
  const re = /\b(synth|fx)\s*\(/g;
  re.lastIndex = from;
  let m;
  let fxSeen = 0;
  while ((m = re.exec(code)) && m.index < to) {
    const isTarget = m[1] === 'synth' ? slot === 0 : ++fxSeen === slot;
    if (!isTarget) continue;
    const open = m.index + m[0].length - 1;
    const closeParen = matchParen(code, open);
    if (closeParen < 0 || closeParen > to) return null;
    const afterFirstArg = endOfFirstString(code, open + 1, closeParen);
    if (afterFirstArg < 0) return null;
    return { afterFirstArg, closeParen };
  }
  return null;
}

// The "pin" button: capture the live plugin's full state and write it into the code as the
// synth/fx call's second argument (replacing any previous one), then fold it. The state then
// restores on every load/eval and shares via the URL like the rest of the code.
async function pinPluginState(trackLabel, blockStart, blockEnd, slot) {
  try {
    const { state } = await api('POST', '/api/pluginState', { trackId: trackLabel, slot });
    const code = cm.getValue();
    const end = Math.min(blockEnd, code.length);
    const call = findChainCall(code, Math.min(blockStart, end), end, slot);
    if (!call) {
      logLine(`could not find the ${slot === 0 ? 'synth(...)' : '.fx(...)'} call for track "${trackLabel}" slot ${slot} - re-eval and try again`, true);
      return;
    }
    cm.replaceRange(`, { state: "${state}" }`, cm.posFromIndex(call.afterFirstArg), cm.posFromIndex(call.closeParen));
    foldConfigBlobs();
    logLine(`pinned plugin state into the code (track "${trackLabel}", slot ${slot})`);
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

let hashTimer = null;
cm.on('change', () => {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    history.replaceState(null, '', '#' + encodeCodeHash(cm.getValue()));
  }, 400);
  clearTimeout(mutedDimTimer);
  mutedDimTimer = setTimeout(updateMutedDim, 150);
});

// ---------------------------------------------------------------------------------------------
// Muted-code dimming: blocks that won't play - muted (`_name:`) or not soloed while another
// block is (`Sname:`) - render in the comment color, no syntax highlighting, so what's actually
// sounding is obvious at a glance. Recomputed straight from the buffer text on every edit
// (mute/solo are just label spellings), no eval needed. Explicit `//` comments already get the
// same treatment from the syntax mode itself.
// ---------------------------------------------------------------------------------------------

let mutedDimTimer = null;
let mutedDimMarks = [];

function updateMutedDim() {
  if (!labelsMod) return;
  for (const mk of mutedDimMarks) mk.clear();
  mutedDimMarks = [];
  const blocks = labelsMod.splitLabeledBlocks(cm.getValue());
  const anySolo = blocks.some((b) => b.soloed && !b.muted);
  for (const b of blocks) {
    if (!b.muted && !(anySolo && !b.soloed)) continue;
    mutedDimMarks.push(
      cm.markText(cm.posFromIndex(b.start), cm.posFromIndex(b.end), { className: 'cm-muted-code' }),
    );
  }
}

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

// Which labeled block is the cursor inside? Scopes `.param(` autocomplete to that block's
// track chain. Falls back to a whole-buffer view if the label splitter isn't loaded yet.
function blockAtCursor() {
  if (!labelsMod) return null;
  const idx = cm.indexFromPos(cm.getCursor());
  const blocks = labelsMod.splitLabeledBlocks(cm.getValue());
  return blocks.find((b) => idx >= b.start && idx <= b.end) ?? null;
}

function paramHints(cur, typed, textBefore) {
  // A `.param(` call targets whatever is last in the chain at that point of the method chain:
  // slot 0 (the instrument) before any .fx(), then slot 1, 2, … after each. Count `.fx(`
  // occurrences between the block start and the cursor to mirror that rule.
  const block = blockAtCursor();
  const sinceBlockStart = block ? textBefore.slice(block.start) : textBefore;
  const slot = (sinceBlockStart.match(/\.fx\s*\(/g) ?? []).length;
  const entry =
    (block && chainSlots.find((s) => s.track === block.label && s.slot === slot)) ??
    chainSlots.find((s) => s.slot === slot);
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

// Connected MIDI device names for the device string of midicc("/midikeys(". Fetched lazily on
// first use (the request also switches on MIDI input engine-side, which typing a MIDI builder
// implies anyway) - the first popup awaits the fetch (show-hint accepts a promise), later ones
// use the cache and refresh it in the background.
let midiDevices = null;

async function fetchMidiDevices() {
  const firstFetch = midiDevices == null;
  try {
    midiDevices = await api('GET', '/api/midiDevices');
    if (firstFetch && midiDevices.length === 0) {
      logLine('midikeys/midicc: engine reports no MIDI sources - they are scanned once at engine start, so restart poptart after plugging a device in', true);
    }
  } catch (err) {
    if (firstFetch) logLine(`midikeys/midicc: device list unavailable (${err.message})`, true);
    midiDevices = midiDevices ?? []; // engine not up yet - background refreshes will self-heal
  }
  return midiDevices;
}

function midiDeviceHints(cur, typed) {
  const toResult = (devices) => {
    const pool = devices.map((d) => ({ key: d }));
    let matches = rankedMatches(pool, typed, 24);
    // The string must name a real connected device, so when what's typed matches nothing the
    // most useful popup is the full list ("here's what IS connected"), not silence.
    if (matches.length === 0) matches = pool.slice(0, 24);
    return hintResult(cur, typed, matches.map((item) => ({ text: item.key })));
  };
  if (midiDevices) {
    fetchMidiDevices();
    return toResult(midiDevices);
  }
  return fetchMidiDevices().then(toResult);
}

function wordHints(cur, typed, words) {
  const pool = words.map((w) => ({ key: w }));
  const completions = rankedMatches(pool, typed, 24).map((item) => ({
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

  // Inside .synth(" or .fx(" → scanned plugin names.
  m = before.match(/\.(?:synth|fx)\s*\(\s*["']([^"']*)$/);
  if (m) return pluginHints(cur, m[1]);

  // Inside the device string of midicc(" or midikeys(" → connected MIDI device names.
  m = before.match(/\b(?:midicc|midikeys)\s*\(\s*["']([^"']*)$/);
  if (m) return midiDeviceHints(cur, m[1]);

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
// Interactive LFO shape editor - put the cursor inside any `lfo(...)` call and a Serum-style
// panel opens: drag breakpoints, drag a segment to bend it (curvature), double-click to
// add/remove points, pick presets, set rate + free/retrigger/envelope mode. Every change is
// serialized straight back into the code as `lfo("x,y,c …", { rate, mode })` - the code stays
// the single source of truth (and shares via the URL hash like everything else).
// ---------------------------------------------------------------------------------------------

const lfoPanel = document.getElementById('lfoPanel');
const lfoCanvas = document.getElementById('lfoCanvas');
const lfoPreset = document.getElementById('lfoPreset');
const lfoRandom = document.getElementById('lfoRandom');
const lfoCloseBtn = document.getElementById('lfoClose');
const lfoRate = document.getElementById('lfoRate');
const lfoMode = document.getElementById('lfoMode');

let lfoState = null; // { marker, callStart, points, rate, mode }
let lfoDismissedStart = null; // call the user explicitly closed - don't auto-reopen it
let lfoSuppressCursor = false;

function matchParen(code, open) {
  let depth = 0;
  let inStr = null;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

function findLfoCallAt(code, idx) {
  const re = /\blfo\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close == null) continue;
    if (idx >= m.index && idx <= close + 1) return { start: m.index, open, close };
  }
  return null;
}

function parseLfoCall(inner) {
  const shapeMatch = /(["'])((?:\\.|(?!\1).)*?)\1/.exec(inner);
  const rate = Number((/rate\s*:\s*([\d.]+)/.exec(inner) ?? [])[1] ?? 1) || 1;
  const mode = (/mode\s*:\s*["'](\w+)["']/.exec(inner) ?? [])[1] ?? 'free';
  let points = null;
  try {
    if (shapeMatch?.[2]?.trim()) points = shapeMod.parseShapePoints(shapeMatch[2]);
  } catch {
    // unparseable shape string - fall back to the default below
  }
  if (!points) points = shapeMod.parseShapePoints('0,0 0.5,1 1,0');
  return { points, rate, mode: ['free', 'retrigger', 'envelope'].includes(mode) ? mode : 'free' };
}

function serializeLfoCall({ points, rate, mode }) {
  const cfg = mode === 'free' ? `{ rate: ${rate} }` : `{ rate: ${rate}, mode: '${mode}' }`;
  return `lfo("${shapeMod.serializeShapePoints(points)}", ${cfg})`;
}

function openLfoEditor(call) {
  const from = cm.posFromIndex(call.start);
  const to = cm.posFromIndex(call.close + 1);
  const inner = cm.getValue().slice(call.open + 1, call.close);
  if (lfoState?.marker) lfoState.marker.clear();
  lfoState = { marker: cm.markText(from, to, {}), callStart: call.start, ...parseLfoCall(inner) };
  lfoRate.value = lfoState.rate;
  lfoMode.value = lfoState.mode;
  lfoPreset.value = '';
  lfoPanel.classList.remove('hidden');
  drawLfoShape();
}

function closeLfoEditor(dismissCall = false) {
  if (dismissCall && lfoState) lfoDismissedStart = lfoState.callStart;
  if (lfoState?.marker) lfoState.marker.clear();
  lfoState = null;
  lfoPanel.classList.add('hidden');
}

function writeLfoCall() {
  if (!lfoState) return;
  const range = lfoState.marker.find();
  if (!range) return;
  const text = serializeLfoCall(lfoState);
  lfoSuppressCursor = true;
  cm.replaceRange(text, range.from, range.to);
  // replaceRange collapses the marker - re-pin it over the fresh text
  lfoState.marker.clear();
  const startIdx = cm.indexFromPos(range.from);
  lfoState.marker = cm.markText(range.from, cm.posFromIndex(startIdx + text.length), {});
  lfoState.callStart = startIdx;
  lfoSuppressCursor = false;
}

function initLfoEditor() {
  for (const name of Object.keys(shapeMod.SHAPE_PRESETS)) lfoPreset.add(new Option(name, name));

  cm.on('cursorActivity', () => {
    if (lfoSuppressCursor || !shapeMod) return;
    const call = findLfoCallAt(cm.getValue(), cm.indexFromPos(cm.getCursor()));
    if (!call) {
      lfoDismissedStart = null;
      if (lfoState) closeLfoEditor();
      return;
    }
    if (call.start === lfoDismissedStart) return;
    if (lfoState && call.start === lfoState.callStart) return; // already editing this call
    openLfoEditor(call);
  });

  lfoPreset.addEventListener('change', () => {
    if (!lfoState || !lfoPreset.value) return;
    lfoState.points = shapeMod.parseShapePoints(shapeMod.SHAPE_PRESETS[lfoPreset.value]);
    writeLfoCall();
    drawLfoShape();
  });
  lfoRandom.addEventListener('click', () => {
    if (!lfoState) return;
    const count = 3 + Math.floor(Math.random() * 5);
    const xs = [0, 1, ...Array.from({ length: count }, () => Math.random())].sort((a, b) => a - b);
    lfoState.points = xs.map((x) => ({
      x,
      y: Math.round(Math.random() * 100) / 100,
      c: Math.random() < 0.4 ? Math.round((Math.random() * 8 - 4) * 10) / 10 : 0,
    }));
    lfoPreset.value = '';
    writeLfoCall();
    drawLfoShape();
  });
  lfoRate.addEventListener('change', () => {
    if (!lfoState) return;
    lfoState.rate = Math.max(0.01, Number(lfoRate.value) || 1);
    writeLfoCall();
  });
  lfoMode.addEventListener('change', () => {
    if (!lfoState) return;
    lfoState.mode = lfoMode.value;
    writeLfoCall();
  });
  lfoCloseBtn.addEventListener('click', () => closeLfoEditor(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lfoState) closeLfoEditor(true);
  });

  initLfoCanvas();
}

// --- canvas: draw + interactions ---

const LFO_PAD = 10;

function lfoToCanvas(p) {
  const w = lfoCanvas.width - 2 * LFO_PAD;
  const h = lfoCanvas.height - 2 * LFO_PAD;
  return { px: LFO_PAD + p.x * w, py: LFO_PAD + (1 - p.y) * h };
}

function canvasToLfo(px, py) {
  const w = lfoCanvas.width - 2 * LFO_PAD;
  const h = lfoCanvas.height - 2 * LFO_PAD;
  return {
    x: Math.min(1, Math.max(0, (px - LFO_PAD) / w)),
    y: Math.min(1, Math.max(0, 1 - (py - LFO_PAD) / h)),
  };
}

function drawLfoShape() {
  if (!lfoState || !shapeMod) return;
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const ctx = lfoCanvas.getContext('2d');
  const { width: W, height: H } = lfoCanvas;
  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = col('--border');
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gx = LFO_PAD + ((W - 2 * LFO_PAD) * i) / 4;
    const gy = LFO_PAD + ((H - 2 * LFO_PAD) * i) / 4;
    ctx.beginPath(); ctx.moveTo(gx, LFO_PAD); ctx.lineTo(gx, H - LFO_PAD); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(LFO_PAD, gy); ctx.lineTo(W - LFO_PAD, gy); ctx.stroke();
  }

  ctx.strokeStyle = col('--accent');
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 200; i++) {
    const x = i / 200;
    const { px, py } = lfoToCanvas({ x, y: shapeMod.sampleShape(lfoState.points, x) });
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  for (const p of lfoState.points) {
    const { px, py } = lfoToCanvas(p);
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, 2 * Math.PI);
    ctx.fillStyle = col('--bg-panel');
    ctx.fill();
    ctx.strokeStyle = col('--accent');
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function initLfoCanvas() {
  let drag = null; // { kind: 'point'|'curve', index }

  const canvasPos = (e) => {
    const r = lfoCanvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  const hitPoint = (px, py) => {
    for (let i = 0; i < lfoState.points.length; i++) {
      const c = lfoToCanvas(lfoState.points[i]);
      if (Math.hypot(c.px - px, c.py - py) < 8) return i;
    }
    return null;
  };

  const segmentAt = (px) => {
    const { x } = canvasToLfo(px, 0);
    const pts = lfoState.points;
    for (let i = 0; i < pts.length - 1; i++) {
      if (x >= pts[i].x && x <= pts[i + 1].x && pts[i + 1].x > pts[i].x) return i;
    }
    return null;
  };

  lfoCanvas.addEventListener('pointerdown', (e) => {
    if (!lfoState) return;
    lfoCanvas.setPointerCapture(e.pointerId);
    const { px, py } = canvasPos(e);
    const pointIdx = hitPoint(px, py);
    drag = pointIdx != null ? { kind: 'point', index: pointIdx } : { kind: 'curve', index: segmentAt(px) };
  });

  lfoCanvas.addEventListener('pointermove', (e) => {
    if (!drag || !lfoState || drag.index == null) return;
    const { px, py } = canvasPos(e);
    const pts = lfoState.points;
    if (drag.kind === 'point') {
      const i = drag.index;
      const { x, y } = canvasToLfo(px, py);
      const isEnd = i === 0 || i === pts.length - 1;
      pts[i] = {
        ...pts[i],
        // endpoints keep their x (the shape always spans the full period)
        x: isEnd ? pts[i].x : Math.min(pts[i + 1].x, Math.max(pts[i - 1].x, x)),
        y,
      };
    } else {
      // vertical drag bends the segment: push the curve toward the pointer
      const seg = pts[drag.index];
      const rising = pts[drag.index + 1].y >= seg.y;
      const delta = (e.movementY ?? 0) * 0.08 * (rising ? 1 : -1);
      seg.c = Math.max(-12, Math.min(12, (seg.c ?? 0) + delta));
    }
    drawLfoShape();
  });

  lfoCanvas.addEventListener('pointerup', (e) => {
    if (drag && lfoState) writeLfoCall();
    drag = null;
    lfoCanvas.releasePointerCapture(e.pointerId);
  });

  lfoCanvas.addEventListener('dblclick', (e) => {
    if (!lfoState) return;
    const { px, py } = canvasPos(e);
    const pointIdx = hitPoint(px, py);
    const pts = lfoState.points;
    if (pointIdx != null) {
      // delete (endpoints stay - the shape must span the period)
      if (pointIdx > 0 && pointIdx < pts.length - 1) pts.splice(pointIdx, 1);
    } else {
      const { x, y } = canvasToLfo(px, py);
      const at = pts.findIndex((p) => p.x > x);
      pts.splice(at === -1 ? pts.length - 1 : at, 0, { x, y, c: 0 });
    }
    lfoPreset.value = '';
    writeLfoCall();
    drawLfoShape();
  });
}

// ---------------------------------------------------------------------------------------------
// Live playback highlighting - light up the mini-notation atom currently sounding.
//
// The scheduler's timebase is wall-clock: cyclePos = Date.now()/1000 * cps (see
// Scheduler#start and OscEngine#getTime), and browser + server share the machine clock, so the
// client can compute the playing step locally with no polling. At eval time we find every
// mini-notation string literal in the evaluated code, parse it with the same parser the server
// uses, and pin a CodeMirror marker over it (markers track position through later edits). A
// ~30fps ticker then asks each parsed pattern which atoms are sounding at the current cycle
// position and marks their source ranges.
// ---------------------------------------------------------------------------------------------

// Authoritative clock state comes back from each /api/evaluate: cyclePos is no longer simply
// t*cps once setbpm() has run, so the server sends its Transport's {cps, baseSec, baseCycle}
// and we mirror the same rebased formula. (A tempo *signal* keeps changing cps between evals;
// highlighting then drifts until the next eval - known, cosmetic.)
// Starts paused at cycle 0 - the server's clock only advances while something is playing.
let transport = { cps: 0.5, baseSec: 0, baseCycle: 0, paused: true };
let playing = false;
let patternRegions = []; // { marker, ast, lastKey, marks: [] }

function clearPatternRegions() {
  for (const r of patternRegions) {
    r.marker.clear();
    for (const mk of r.marks) mk.clear();
  }
  patternRegions = [];
}

// Blanks out // and /* */ comments (string-aware, offsets preserved) so commented-out code
// never gets playback highlighting - a `// .param("x", "0 1")` line isn't playing.
function maskComments(code) {
  const out = code.split('');
  let inStr = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
    } else if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') out[i++] = ' ';
    } else if (ch === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      const end = close === -1 ? code.length : close + 2;
      for (; i < end; i++) if (code[i] !== '\n') out[i] = ' ';
      i--;
    }
  }
  return out.join('');
}

function findStringLiterals(code) {
  const out = [];
  // Backticks included (multi-line `<...>*n` patterns from midi-record); the s flag lets a
  // template literal's newlines match. Comments are already masked out by the caller.
  const re = /(["'`])((?:\\.|(?!\1).)*?)\1/gs;
  let m;
  while ((m = re.exec(code)) !== null) {
    out.push({ index: m.index, raw: m[2], end: m.index + m[0].length });
  }
  return out;
}

// Only strings used *as patterns* get highlighted: arguments to n()/note()/mini()/s(),
// chain methods whose first argument can be mini-notation (.when()/.i()/.gain()/.add()/…),
// second-position arguments (`.param("name", "0.2 0.8")`), and strings that immediately chain
// a method (`"0 0.5 1".gte(0.5)`). Deliberately not: `.synth("Serum 2")`/`.fx(...)`/
// `.scale("F minor")`, or `.param("Filter 1 Freq", …)`'s name string - those are lookups,
// not patterns.
function isPatternContext(code, lit) {
  const before = code.slice(0, lit.index);
  const after = code.slice(lit.end);
  if (/(?<!\.)\b(?:n|note|mini|s)\s*\(\s*$/.test(before)) return true;
  if (/\.\s*(?:when|hold|i|n|note|vel|begin|end|loop|speed|stretch|fit|slice|gain|pan|add|sub|mul|div|mod|gte|gt|lte|lt|eq|neq)\s*\(\s*$/.test(before)) return true;
  if (/,\s*$/.test(before)) return true;
  if (/^\s*\.\s*[A-Za-z_]/.test(after)) return true;
  return false;
}

function setupHighlighting(code, tracks) {
  clearPatternRegions();
  if (!miniMod) return;
  const masked = maskComments(code); // same offsets, comments blanked
  const activeRanges = tracks.filter((t) => t.active).map((t) => [t.start, t.end]);
  for (const lit of findStringLiterals(masked)) {
    if (!activeRanges.some(([a, b]) => lit.index >= a && lit.index <= b)) continue;
    if (!isPatternContext(masked, lit)) continue;
    let ast;
    try {
      ast = miniMod.parseMini(lit.raw);
    } catch {
      continue; // not parseable mini-notation (e.g. a plain word) - just skip it
    }
    const from = cm.posFromIndex(lit.index + 1); // just inside the opening quote
    const to = cm.posFromIndex(lit.index + 1 + lit.raw.length);
    patternRegions.push({ marker: cm.markText(from, to, {}), ast, lastKey: '', marks: [] });
  }
}

// The transport mirror as a cycle position "now" - the same rebased formula the server uses.
// A paused transport is frozen at baseCycle (0 after a stop / at page load).
function currentCyclePos() {
  if (transport.paused) return transport.baseCycle;
  return transport.baseCycle + (Date.now() / 1000 - transport.baseSec) * transport.cps;
}

function highlightTick() {
  if (!playing || !miniMod || patternRegions.length === 0) return;
  const cyclePos = currentCyclePos();
  const cycle = Math.floor(cyclePos);
  const phase = cyclePos - cycle;

  for (const r of patternRegions) {
    const range = r.marker.find();
    if (!range) continue; // the string was deleted from the buffer
    let steps;
    try {
      steps = miniMod.getStepsForCycle(r.ast, cycle);
    } catch {
      continue;
    }
    const sounding = steps.filter((s) => s.value != null && s.loc && phase >= s.start && phase < s.end);
    const key = sounding.map((s) => s.loc.join('-')).join(',');
    if (key === r.lastKey) continue; // same atoms still sounding - don't churn marks
    r.lastKey = key;
    for (const mk of r.marks) mk.clear();
    r.marks = sounding.map((s) => {
      const base = cm.indexFromPos(range.from);
      return cm.markText(cm.posFromIndex(base + s.loc[0]), cm.posFromIndex(base + s.loc[1]), {
        className: 'cm-playing',
      });
    });
  }
}
setInterval(() => {
  highlightTick();
  updatePhraseViz();
  updateRecButton();
}, 33);

function stopHighlighting() {
  playing = false;
  for (const r of patternRegions) {
    for (const mk of r.marks) mk.clear();
    r.marks = [];
    r.lastKey = '';
  }
}

// ---------------------------------------------------------------------------------------------
// Phrase position - four clock-face circles in the header, one per cycle of the 4-cycle
// phrase. The current cycle's circle fills around its circumference; completed cycles stay
// full rings; everything resets when the phrase (cycle % 4) wraps. Driven from the same
// transport mirror as playback highlighting, so it needs no polling.
// ---------------------------------------------------------------------------------------------

const PHRASE_CYCLES = 4;
const phraseViz = document.getElementById('phraseViz');
for (let i = 0; i < PHRASE_CYCLES; i++) {
  phraseViz.insertAdjacentHTML(
    'beforeend',
    '<svg class="phrase-c" viewBox="0 0 16 16"><circle class="ring" cx="8" cy="8" r="6"></circle><circle class="arc" cx="8" cy="8" r="6" pathLength="1"></circle></svg>',
  );
}
const phraseArcs = [...phraseViz.querySelectorAll('.arc')];

function updatePhraseViz() {
  const active = playing || recState != null;
  phraseViz.classList.toggle('rec', recState != null);
  const pos = currentCyclePos();
  const cycle = Math.floor(pos);
  const idx = ((cycle % PHRASE_CYCLES) + PHRASE_CYCLES) % PHRASE_CYCLES;
  const phase = pos - cycle;
  phraseArcs.forEach((arc, i) => {
    const p = !active ? 0 : i < idx ? 1 : i === idx ? phase : 0;
    arc.style.strokeDasharray = `${p} 1`;
  });
}

// ---------------------------------------------------------------------------------------------
// MIDI record - capture what's being played on a midikeys() route and write it back into the
// code as a `<...>*n`.as("note:vel:clip") pattern, replacing the kb()/midikeys() call. The
// server owns the recording window (/api/midiRecord/*): it arms at the next 4-cycle phrase
// boundary (the wait is the count-in - watch the circles), records for the chosen number of
// cycles at the chosen grid, and serves the converted pattern; this side polls for it, edits
// the buffer, and re-evaluates so the loop takes over from the live keys seamlessly.
// ---------------------------------------------------------------------------------------------

const recBtn = document.getElementById('recBtn');
const recOptsBtn = document.getElementById('recOptsBtn');
const recPanel = document.getElementById('recPanel');
const recCycles = document.getElementById('recCycles');
const recGrid = document.getElementById('recGrid');

let recState = null; // latest /api/midiRecord status while armed/recording, else null
let recPollTimer = null;

recOptsBtn.addEventListener('click', () => recPanel.classList.toggle('hidden'));
recBtn.addEventListener('click', () => (recState ? cancelMidiRecord(true) : startMidiRecord()));

async function startMidiRecord() {
  recPanel.classList.add('hidden');
  try {
    recState = await api('POST', '/api/midiRecord/start', {
      cycles: Number(recCycles.value),
      grid: Number(recGrid.value),
    });
    if (recState.transport) transport = recState.transport;
    recPollTimer = setInterval(pollMidiRecord, 300);
    logLine(
      `midi record armed: ${recState.cycles} cycle(s), quantize ${recGrid.selectedOptions[0].textContent} - recording starts when the phrase ends`,
    );
  } catch (e) {
    recState = null;
    logLine(e.message ?? String(e), true);
  }
}

async function cancelMidiRecord(log = false) {
  clearInterval(recPollTimer);
  recPollTimer = null;
  recState = null;
  try {
    await api('POST', '/api/midiRecord/cancel');
  } catch {
    // server may already be idle - nothing to clean up
  }
  if (log) logLine('midi record cancelled');
}

async function pollMidiRecord() {
  try {
    const s = await api('GET', '/api/midiRecord/status');
    if (s.transport) transport = s.transport;
    if (s.phase === 'done') {
      clearInterval(recPollTimer);
      recPollTimer = null;
      recState = null;
      api('POST', '/api/midiRecord/cancel').catch(() => {}); // ack: clear the served results
      applyRecording(s.results ?? []);
    } else if (s.phase === 'idle') {
      // server restarted / lost the recording
      clearInterval(recPollTimer);
      recPollTimer = null;
      recState = null;
      logLine('midi record: the server dropped the recording', true);
    } else {
      recState = s;
    }
  } catch {
    // transient fetch error - keep polling
  }
}

function updateRecButton() {
  if (!recState) {
    if (recBtn.textContent !== '● rec') recBtn.textContent = '● rec';
    recBtn.classList.remove('rec-armed', 'rec-live');
    return;
  }
  const pos = currentCyclePos();
  if (pos < recState.startCycle) {
    recBtn.textContent = `● in ${Math.max(0, recState.startCycle - pos).toFixed(1)}`;
    recBtn.classList.add('rec-armed');
    recBtn.classList.remove('rec-live');
  } else {
    recBtn.textContent = `● ${Math.min(recState.cycles, pos - recState.startCycle).toFixed(1)}/${recState.cycles}`;
    recBtn.classList.add('rec-live');
    recBtn.classList.remove('rec-armed');
  }
}

function applyRecording(results) {
  if (!results.length) {
    logLine('midi record: no notes were played during the recording window', true);
    return;
  }
  let applied = 0;
  for (const r of results) {
    if (r.error) {
      logLine(`midi record (${r.label}): ${r.error}`, true);
      continue;
    }
    const replacement = '`' + r.pattern + '`.as("note:vel:clip")';
    if (replaceKbCall(r.label, replacement)) {
      applied++;
      logLine(`midi record: wrote ${r.count} note(s) into "${r.label}"`);
    } else {
      logLine(
        `midi record (${r.label}): no midikeys/kb call found to replace - recorded pattern: ${r.pattern.replace(/\n\s*/g, ' ')}`,
        true,
      );
    }
  }
  if (applied) doEval();
}

// Finds the live-keys call in the labeled block - either `midikeys("device")(ch)` directly or
// `kb(ch)` through any `const kb = midikeys(...)` binding declared in the buffer - and swaps
// the whole call expression for the recorded pattern. First candidate in the block wins.
function replaceKbCall(label, replacement) {
  if (!labelsMod) return false;
  const code = cm.getValue();
  const block = labelsMod.splitLabeledBlocks(code).find((b) => b.label === label);
  if (!block) return false;

  const spanFrom = (callStart, openParenIdx) => {
    const close = matchParen(code, openParenIdx);
    return close == null || close < 0 ? null : [callStart, close + 1];
  };
  const spans = [];

  const direct = /\bmidikeys\s*\(/g;
  let m;
  while ((m = direct.exec(code))) {
    if (m.index < block.start || m.index >= block.end) continue;
    const close1 = matchParen(code, m.index + m[0].length - 1);
    if (close1 == null || close1 < 0) continue;
    let j = close1 + 1;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== '(') continue; // a bare midikeys(...) definition, not a played route
    const span = spanFrom(m.index, j);
    if (span) spans.push(span);
  }

  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*midikeys\s*\(/g;
  const names = new Set([...code.matchAll(declRe)].map((d) => d[1]));
  for (const name of names) {
    const call = new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
    while ((m = call.exec(code))) {
      if (m.index < block.start || m.index >= block.end) continue;
      const span = spanFrom(m.index, m.index + m[0].length - 1);
      if (span) spans.push(span);
    }
  }
  if (!spans.length) return false;

  spans.sort((a, b) => a[0] - b[0]);
  const [from, to] = spans[0];
  cm.replaceRange(replacement, cm.posFromIndex(from), cm.posFromIndex(to));
  removeChainedScale(from + replacement.length);
  return true;
}

// Recorded notes are absolute MIDI (live scale-quantization already happened engine-side), so
// a .scale() chained directly onto the replaced call would wrongly remap them as degrees -
// walk the method chain that follows the replacement and drop the first .scale(...) in it.
function removeChainedScale(idx) {
  const code = cm.getValue();
  let i = idx;
  for (;;) {
    let j = i;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== '.') return;
    let k = j + 1;
    while (k < code.length && /\s/.test(code[k])) k++;
    const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(k));
    if (!m) return;
    let p = k + m[0].length;
    while (p < code.length && /\s/.test(code[p])) p++;
    if (code[p] !== '(') return;
    const close = matchParen(code, p);
    if (close == null || close < 0) return;
    if (m[0] === 'scale') {
      cm.replaceRange('', cm.posFromIndex(j), cm.posFromIndex(close + 1));
      logLine('midi record: dropped the chained .scale() - the recorded notes are already absolute');
      return;
    }
    i = close + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

async function refreshStatus() {
  const { loaded, error } = await api('GET', '/api/status');
  engineStatus.textContent = loaded ? 'engine ready' : `engine not loaded: ${error}`;
  engineStatus.className = `status ${loaded ? 'ok' : 'error'}`;
  return loaded;
}

function renderTracks(result) {
  trackInfo.innerHTML = '';
  for (const t of result.tracks) {
    const head = document.createElement('div');
    head.className = 'track-head';
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = t.label;
    head.appendChild(name);
    if (t.muted) head.appendChild(badge('muted', 'badge-muted'));
    if (t.soloed) head.appendChild(badge('solo', 'badge-solo'));
    if (!t.active && !t.muted) head.appendChild(badge('off', 'badge-muted'));
    trackInfo.appendChild(head);

    const chain = [t.instrument, ...t.fxChain];
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
        uiBtn.onclick = () =>
          api('POST', '/api/showEditor', { trackId: t.label, slot }).catch((e) => logLine(e.message, true));
        row.appendChild(uiBtn);
        const pinBtn = document.createElement('button');
        pinBtn.className = 'small';
        pinBtn.textContent = 'pin';
        pinBtn.title = 'capture the plugin state into the code, so it restores on load and shares via the URL';
        pinBtn.onclick = () => pinPluginState(t.label, t.start, t.end, slot);
        row.appendChild(pinBtn);
      }
      trackInfo.appendChild(row);
    });
    if (t.paramNames.length) {
      const row = document.createElement('div');
      row.className = 'chain-params';
      row.textContent = `modulating: ${t.paramNames.join(', ')}`;
      trackInfo.appendChild(row);
    }
  }
}

function badge(text, cls) {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

async function doEval() {
  const code = cm.getValue();
  try {
    const result = await api('POST', '/api/evaluate', { code });
    transport = result.transport ?? { cps: result.cps ?? transport.cps, baseSec: 0, baseCycle: 0, paused: false };
    renderTracks(result);
    setupHighlighting(code, result.tracks);
    foldConfigBlobs();
    playing = true;
    logLine(`evaluated ok (${result.tracks.filter((t) => t.active).length}/${result.tracks.length} pattern(s) playing)`);
    loadChainParams();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function doStop() {
  if (recState) cancelMidiRecord(true);
  const result = await api('POST', '/api/stop');
  if (result.transport) transport = result.transport; // frozen at cycle 0
  stopHighlighting();
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
    const trackPrefix = slot.track ? `${slot.track} · ` : '';
    head.textContent = `${trackPrefix}${slot.slot} · ${slot.plugin} — ${slot.error ?? `${matches.length}${query ? ` of ${slot.params.length}` : ''} params`}`;
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
      logLine(`params for ${s.track} slot ${s.slot} (${s.plugin}): ${s.error}`, true);
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
// browser (and .synth()/.fx() autocomplete) without requiring a manual rescan.
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
// Sidebar tabs (session | files) + pattern file manager. Pattern files are whole editor
// buffers saved server-side (~/.poptart/patterns/<name>.js) via /api/patterns*: save the
// current buffer under a name, click a saved pattern to load it, rename/delete to organize.
// ---------------------------------------------------------------------------------------------

const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sessionTab = document.getElementById('sessionTab');
const filesTab = document.getElementById('filesTab');
const settingsTab = document.getElementById('settingsTab');
const audioDeviceSelect = document.getElementById('audioDeviceSelect');
const fileNameInput = document.getElementById('fileNameInput');
const fileSaveBtn = document.getElementById('fileSaveBtn');
const fileList = document.getElementById('fileList');
const consoleFooter = document.getElementById('console');
const consoleToggle = document.getElementById('consoleToggle');

for (const btn of document.querySelectorAll('.side-tab')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.side-tab')) b.classList.toggle('active', b === btn);
    sessionTab.classList.toggle('hidden', btn.dataset.tab !== 'session');
    filesTab.classList.toggle('hidden', btn.dataset.tab !== 'files');
    settingsTab.classList.toggle('hidden', btn.dataset.tab !== 'settings');
    if (btn.dataset.tab === 'files') refreshPatternFiles();
    if (btn.dataset.tab === 'settings') refreshAudioDevices();
  });
}

// ---------------------------------------------------------------------------------------------
// Settings tab - audio output device. Devices come with channel counts (what .o(n) wraps
// against); changing the selection restarts the engine server-side, so playing tracks stop
// and the user re-evaluates.
// ---------------------------------------------------------------------------------------------

async function refreshAudioDevices() {
  try {
    const { devices, selected } = await api('GET', '/api/audioDevices');
    audioDeviceSelect.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    const sysDefault = devices.find((d) => d.isDefault);
    def.textContent = sysDefault ? `system default (${sysDefault.name})` : 'system default';
    audioDeviceSelect.appendChild(def);
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.name;
      opt.textContent = `${d.name} · ${d.channels} ch`;
      audioDeviceSelect.appendChild(opt);
    }
    // A saved device that's since been unplugged falls back to "" - the server already plays
    // on the system default in that case.
    audioDeviceSelect.value = selected ?? '';
    if (audioDeviceSelect.value !== (selected ?? '')) audioDeviceSelect.value = '';
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

audioDeviceSelect.addEventListener('change', async () => {
  const device = audioDeviceSelect.value || null;
  const label = device ?? 'the system default';
  audioDeviceSelect.disabled = true;
  engineStatus.textContent = 'restarting engine…';
  engineStatus.className = 'status';
  logLine(`switching audio output to ${label} - restarting the engine…`);
  try {
    await api('POST', '/api/audioDevice', { device });
    stopHighlighting();
    playing = false;
    transport = { ...transport, paused: true, baseCycle: 0 }; // server froze its clock too
    logLine(`audio output is now ${label} - re-evaluate (Cmd/Ctrl+Enter) to resume playback`);
  } catch (e) {
    logLine(e.message ?? String(e), true);
  } finally {
    audioDeviceSelect.disabled = false;
    refreshStatus().catch(() => {});
  }
});

function renderPatternFiles(patterns) {
  fileList.innerHTML = '';
  if (!patterns.length) {
    fileList.textContent = 'no saved patterns yet - name the current buffer above and hit save';
    return;
  }
  for (const p of patterns) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.title = 'click to load into the editor';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = p.name;
    row.appendChild(name);

    const when = document.createElement('span');
    when.className = 'dim';
    when.textContent = new Date(p.mtime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    row.appendChild(when);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'small';
    renameBtn.textContent = '✎';
    renameBtn.title = 'rename';
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      renamePatternFile(p.name);
    };
    row.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'small';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'delete';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deletePatternFile(p.name);
    };
    row.appendChild(deleteBtn);

    row.onclick = () => loadPatternFile(p.name);
    fileList.appendChild(row);
  }
}

async function refreshPatternFiles() {
  try {
    const { patterns } = await api('GET', '/api/patterns');
    renderPatternFiles(patterns);
  } catch (e) {
    fileList.textContent = 'failed to list patterns';
    logLine(e.message ?? String(e), true);
  }
}

async function savePatternFile() {
  const name = fileNameInput.value.trim();
  if (!name) {
    logLine('give the pattern a name before saving', true);
    fileNameInput.focus();
    return;
  }
  try {
    await api('POST', '/api/patterns/save', { name, code: cm.getValue() });
    logLine(`saved pattern "${name}"`);
    refreshPatternFiles();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function loadPatternFile(name) {
  try {
    const { code } = await api('POST', '/api/patterns/load', { name });
    cm.setValue(code);
    foldConfigBlobs();
    fileNameInput.value = name; // so re-saving after edits goes to the same file
    logLine(`loaded pattern "${name}" - Cmd/Ctrl+Enter to play it`);
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function renamePatternFile(name) {
  const to = prompt(`rename "${name}" to:`, name)?.trim();
  if (!to || to === name) return;
  try {
    await api('POST', '/api/patterns/rename', { from: name, to });
    if (fileNameInput.value.trim() === name) fileNameInput.value = to;
    logLine(`renamed pattern "${name}" to "${to}"`);
    refreshPatternFiles();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function deletePatternFile(name) {
  if (!confirm(`delete pattern "${name}"?`)) return;
  try {
    await api('POST', '/api/patterns/delete', { name });
    logLine(`deleted pattern "${name}"`);
    refreshPatternFiles();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

fileSaveBtn.addEventListener('click', savePatternFile);
fileNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') savePatternFile();
});

// ---------------------------------------------------------------------------------------------
// Minimizable sidebar + console - collapsed state persists per browser.
// ---------------------------------------------------------------------------------------------

function initCollapsible(el, toggleBtn, storageKey, labels) {
  const apply = (collapsed) => {
    el.classList.toggle('collapsed', collapsed);
    toggleBtn.textContent = collapsed ? labels.collapsed : labels.open;
    localStorage.setItem(storageKey, collapsed ? '1' : '');
  };
  toggleBtn.addEventListener('click', () => apply(!el.classList.contains('collapsed')));
  apply(!!localStorage.getItem(storageKey));
}

initCollapsible(sidebar, sidebarToggle, 'poptart-sidebar-collapsed', { open: '»', collapsed: '«' });
initCollapsible(consoleFooter, consoleToggle, 'poptart-console-collapsed', { open: '▾', collapsed: '▴' });

// ---------------------------------------------------------------------------------------------
// Themes: presets are palette blocks in style.css (`:root[data-theme="…"]`); the theme editor
// lets you build a "custom" theme on top of whichever preset is active - every color is a CSS
// variable, so edits are just inline overrides on <html>, persisted to localStorage (and
// re-applied pre-paint by index.html).
// ---------------------------------------------------------------------------------------------

const PRESET_THEMES = ['poptart', 'blueberry', 'matcha', 'paper'];
const CUSTOM_KEY = 'poptart-custom-theme';
const CUSTOM_BASE_KEY = 'poptart-custom-base';

const THEME_VARS = [
  ['--bg', 'background'],
  ['--bg-raised', 'raised bg'],
  ['--bg-panel', 'panel bg'],
  ['--border', 'border'],
  ['--text', 'text'],
  ['--text-dim', 'dim text'],
  ['--accent', 'accent'],
  ['--ok', 'ok / ready'],
  ['--err', 'error'],
  ['--warn', 'warning'],
  ['--selection', 'selection'],
  ['--linenumber', 'line numbers'],
  ['--syn-string', 'syntax: strings'],
  ['--syn-number', 'syntax: numbers'],
  ['--syn-keyword', 'syntax: keywords'],
  ['--syn-variable', 'syntax: variables'],
  ['--syn-property', 'syntax: properties'],
  ['--syn-comment', 'syntax: comments'],
];

const themeSelect = document.getElementById('themeSelect');
const themeEditBtn = document.getElementById('themeEditBtn');
const themePanel = document.getElementById('themePanel');
const themeVarsEl = document.getElementById('themeVars');
const themeResetBtn = document.getElementById('themeReset');
const themeCloseBtn = document.getElementById('themeClose');

function savedCustomTheme() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY)) ?? null;
  } catch {
    return null;
  }
}

function rebuildThemeOptions() {
  themeSelect.innerHTML = '';
  for (const t of PRESET_THEMES) themeSelect.add(new Option(t, t));
  if (savedCustomTheme()) themeSelect.add(new Option('custom', 'custom'));
}

function applyTheme(name) {
  const root = document.documentElement;
  // Clear any custom inline overrides first, then re-apply if picking the custom theme.
  for (const [v] of THEME_VARS) root.style.removeProperty(v);
  if (name === 'custom') {
    const custom = savedCustomTheme() ?? {};
    root.dataset.theme = localStorage.getItem(CUSTOM_BASE_KEY) ?? 'poptart';
    for (const [v, value] of Object.entries(custom)) root.style.setProperty(v, value);
  } else {
    root.dataset.theme = name;
  }
  localStorage.setItem('poptart-theme', name);
  themeSelect.value = name;
  if (!themePanel.classList.contains('hidden')) populateThemeInputs();
}

// Computed styles come back as rgb(r, g, b); <input type="color"> wants #rrggbb.
function cssColorToHex(color) {
  const m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color.trim());
  if (!m) return color.trim(); // already hex (inline overrides are stored as hex)
  const hex = (n) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

function populateThemeInputs() {
  const computed = getComputedStyle(document.documentElement);
  themeVarsEl.innerHTML = '';
  for (const [varName, label] of THEME_VARS) {
    const row = document.createElement('label');
    row.className = 'theme-var-row';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = cssColorToHex(computed.getPropertyValue(varName));
    input.addEventListener('input', () => setCustomVar(varName, input.value));
    row.append(span, input);
    themeVarsEl.appendChild(row);
  }
}

function setCustomVar(varName, value) {
  // First edit forks the current preset into the custom theme: snapshot every variable so the
  // custom theme is complete and stable even if the base preset later changes.
  let custom = savedCustomTheme();
  if (!custom || themeSelect.value !== 'custom') {
    const computed = getComputedStyle(document.documentElement);
    custom = Object.fromEntries(THEME_VARS.map(([v]) => [v, cssColorToHex(computed.getPropertyValue(v))]));
    localStorage.setItem(CUSTOM_BASE_KEY, document.documentElement.dataset.theme ?? 'poptart');
  }
  custom[varName] = value;
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  rebuildThemeOptions();
  localStorage.setItem('poptart-theme', 'custom');
  themeSelect.value = 'custom';
  document.documentElement.style.setProperty(varName, value);
  // Make sure all snapshot values are applied (first edit only sets one inline var otherwise).
  for (const [v, val] of Object.entries(custom)) document.documentElement.style.setProperty(v, val);
}

themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
themeEditBtn.addEventListener('click', () => {
  themePanel.classList.toggle('hidden');
  if (!themePanel.classList.contains('hidden')) populateThemeInputs();
});
themeCloseBtn.addEventListener('click', () => themePanel.classList.add('hidden'));
themeResetBtn.addEventListener('click', () => {
  localStorage.removeItem(CUSTOM_KEY);
  const base = localStorage.getItem(CUSTOM_BASE_KEY) ?? 'poptart';
  localStorage.removeItem(CUSTOM_BASE_KEY);
  rebuildThemeOptions();
  applyTheme(PRESET_THEMES.includes(base) ? base : 'poptart');
});

rebuildThemeOptions();
{
  const saved = localStorage.getItem('poptart-theme') ?? 'poptart';
  const valid = saved === 'custom' ? !!savedCustomTheme() : PRESET_THEMES.includes(saved);
  themeSelect.value = valid ? saved : 'poptart';
  // index.html already applied the theme pre-paint; this just syncs the picker.
}

// ---------------------------------------------------------------------------------------------

evalBtn.addEventListener('click', doEval);
stopBtn.addEventListener('click', doStop);
scanBtn.addEventListener('click', doScan);

refreshStatus().then((loaded) => {
  if (loaded) loadKnownPlugins();
});
