'use strict';

// Browser UI: CodeMirror editor with poptart-aware autocomplete (real VST parameter names
// inside `.param("…")`, plugin names inside `.synth("…")`/`.fx("…")`, method/builder names
// elsewhere), live playback highlighting of mini-notation (the atom currently sounding lights
// up, Strudel-style), a searchable params panel, plugin browser, an interactive theme editor,
// and transport - all over the same fetch('/api/…') endpoints. No build step: CodeMirror 5 is
// loaded as plain scripts from /vendor/codemirror/, and pattern-core's own mini parser + label
// splitter are imported as ESM from /pattern-core/ (both served by server.js), so the browser
// computes exactly the same steps the server plays.

const playBtn = document.getElementById('playBtn');
const updateBtn = document.getElementById('updateBtn');
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

const BUILDERS = [
  'Signal', 'n', 'note', 'mini', 's', 'synth', 'sine', 'saw', 'tri', 'square', 'ramp', 'rand', 'lfo', 'env', 'midicc', 'midikeys', 'setbpm',
  'macro', ...Array.from({ length: 8 }, (_, i) => `macro${i + 1}`),
];
const METHODS = [
  'scale', 'synth', 'fx', 'param', 'gain', 'pan', 'o', 'vel', 'clip', 'range', 'fast', 'rate', 'phase', 'curve',
  'add', 'sub', 'mul', 'div', 'mod', 'round', 'abs', 'floor', 'ceil', 'clamp',
  'gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'when', 'hold', 'as',
  'i', 'n', 'note', 'begin', 'end', 'loop', 'speed', 'stretch', 'fit', 'slice',
];

// The sublime keymap supplies the expected editing chords (Cmd/Ctrl-/ comment, Cmd/Ctrl-D
// select-next, etc.); extraKeys layers transport + VS Code-style line moving/duplication
// (Alt-Up/Down move, Shift-Alt-Up/Down copy) on top and wins on conflicts.

// VS Code-style copy line up/down: always duplicates the full lines touched by each
// selection (sublime's duplicateLine instead splices the selected region in place).
// A selection ending at column 0 doesn't include that final line, matching VS Code.
function selectionLineSpan(cm, sel) {
  const from = sel.from(), to = sel.to();
  let endLine = to.line;
  if (endLine > from.line && to.ch === 0) endLine--;
  return { startLine: from.line, endLine };
}

function copyLines(cm, dir) {
  cm.operation(() => {
    const sels = cm.listSelections();
    const edits = [];
    const newSels = [];
    let offset = 0;
    for (const sel of sels) {
      const { startLine, endLine } = selectionLineSpan(cm, sel);
      const nLines = endLine - startLine + 1;
      const text = cm.getRange(
        CodeMirror.Pos(startLine, 0),
        CodeMirror.Pos(endLine, cm.getLine(endLine).length)
      );
      if (dir === 'down') {
        // Insert the copy above; the original slides down and stays selected,
        // which reads as "cursor follows the copy below".
        edits.push({ pos: CodeMirror.Pos(startLine, 0), text: text + '\n' });
        offset += nLines;
        newSels.push({
          anchor: CodeMirror.Pos(sel.anchor.line + offset, sel.anchor.ch),
          head: CodeMirror.Pos(sel.head.line + offset, sel.head.ch),
        });
      } else {
        // Insert the copy below; selection stays on the upper (original) lines.
        edits.push({
          pos: CodeMirror.Pos(endLine, cm.getLine(endLine).length),
          text: '\n' + text,
        });
        newSels.push({
          anchor: CodeMirror.Pos(sel.anchor.line + offset, sel.anchor.ch),
          head: CodeMirror.Pos(sel.head.line + offset, sel.head.ch),
        });
        offset += nLines;
      }
    }
    for (let i = edits.length - 1; i >= 0; i--) {
      cm.replaceRange(edits[i].text, edits[i].pos, edits[i].pos, '+copyLine');
    }
    cm.setSelections(newSels);
    cm.scrollIntoView();
  });
}

const cm = CodeMirror.fromTextArea(document.getElementById('editor'), {
  mode: { name: 'javascript' },
  theme: 'poptart',
  keyMap: 'sublime',
  lineNumbers: true,
  matchBrackets: true,
  autoCloseBrackets: true,
  viewportMargin: Infinity,
  extraKeys: {
    'Cmd-Enter': () => evaluate(true),
    'Ctrl-Enter': () => evaluate(true),
    'Cmd-.': doStop,
    'Ctrl-.': doStop,
    'Shift-Alt-Down': (cm) => copyLines(cm, 'down'),
    'Shift-Alt-Up': (cm) => copyLines(cm, 'up'),
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
    evaluate(true);
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

// First string literal in [from, to): its unescaped content and the index just past its closing
// quote, or null. Used by conf's param upsert to read a .param("name", ...) call's name.
function firstStringLiteral(code, from, to) {
  for (let i = from; i < to; i++) {
    const q = code[i];
    if (q !== '"' && q !== "'") continue;
    let s = '';
    for (let j = i + 1; j < to; j++) {
      if (code[j] === '\\') { s += code[j + 1]; j++; }
      else if (code[j] === q) return { content: s, end: j + 1 };
      else s += code[j];
    }
    return null;
  }
  return null;
}

// Finds an existing `.param("name", <value>)` call for `name` within [from, to) and returns the
// character range of its value argument (after the separator comma, up to the close paren), so
// conf can overwrite the value in place instead of appending a duplicate. null if not present.
function findParamCall(code, from, to, name) {
  const re = /\.param\s*\(/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(code)) && m.index < to) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0 || close > to) continue;
    const lit = firstStringLiteral(code, open + 1, close);
    if (!lit || lit.content !== name) continue;
    let i = lit.end;
    while (i < close && code[i] !== ',') i++;
    if (code[i] !== ',') continue;
    return { valueStart: i + 1, valueEnd: close };
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

// ---------------------------------------------------------------------------------------------
// "conf" (configure) capture, Ableton-style: toggle it on for a track, then every knob you move
// in that track's plugin editor windows is dropped into the code as .param("Name", value). The
// server coalesces the touched parameters (latest value per param) and we poll for them; each is
// inserted right after its slot's synth()/.fx() call (so it targets that plugin) or, if a
// .param("Name", ...) for it already exists in the block, overwrites that value in place.
// ---------------------------------------------------------------------------------------------

let confSession = null; // { trackLabel, timer } while a track is configuring

async function toggleConf(trackLabel, btn) {
  if (confSession && confSession.trackLabel === trackLabel) {
    await stopConf();
    return;
  }
  await stopConf(); // only one track configures at a time
  try {
    await api('POST', '/api/confMode', { trackId: trackLabel, on: true });
  } catch (e) {
    logLine(e.message ?? String(e), true);
    return;
  }
  confSession = { trackLabel, timer: setInterval(() => pollConf().catch(() => {}), 200) };
  btn?.classList.add('conf-active');
  logLine(`conf on for "${trackLabel}" - move knobs in its plugin windows and they drop into the code (click conf again to finish)`);
}

async function stopConf() {
  if (!confSession) return;
  const { trackLabel, timer } = confSession;
  clearInterval(timer);
  confSession = null;
  try { await pollConf(trackLabel); } catch {} // final drain of anything touched since the last poll
  try { await api('POST', '/api/confMode', { trackId: trackLabel, on: false }); } catch {}
  document.querySelectorAll('.conf-active').forEach((b) => b.classList.remove('conf-active'));
}

async function pollConf(labelOverride) {
  const trackLabel = labelOverride ?? confSession?.trackLabel;
  if (!trackLabel) return;
  const { active, params } = await api('POST', '/api/confPending', { trackId: trackLabel });
  for (const p of params ?? []) upsertParam(trackLabel, p.slot, p.name, p.value);
  // active:false on a session we think is live means the server restarted out from under it -
  // stop and say so instead of silently polling a dead session with the button still lit.
  // (Not on the final-drain call from stopConf, which passes labelOverride and expects this.)
  if (!active && !labelOverride && confSession?.trackLabel === trackLabel) {
    await stopConf();
    logLine('conf: the server lost this capture session (restarted?) - click conf again to re-arm it', true);
  }
}

function upsertParam(trackLabel, slot, name, value) {
  if (!labelsMod) return;
  const code = cm.getValue();
  const block = labelsMod.splitLabeledBlocks(code).find((b) => b.label === trackLabel);
  if (!block) return;
  // Overwrite an existing .param() for this name, else insert one targeting the touched slot.
  const existing = findParamCall(code, block.start, block.end, name);
  if (existing) {
    cm.replaceRange(` ${value}`, cm.posFromIndex(existing.valueStart), cm.posFromIndex(existing.valueEnd));
    return;
  }
  const call = findChainCall(code, block.start, block.end, slot);
  if (!call) {
    logLine(`conf: couldn't find slot ${slot}'s call in "${trackLabel}" - re-evaluate and try again`, true);
    return;
  }
  cm.replaceRange(`.param(${JSON.stringify(name)}, ${value})`, cm.posFromIndex(call.closeParen + 1));
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

// Give each parameter its address string - the plain name, or "Name#index" when the plugin
// reuses that name (Diva's three "Frequency"), so completing/copying it targets the exact one.
// Duplicate detection is per param list (a name collides only within its own plugin).
function withParamAddrs(params) {
  const counts = new Map();
  for (const p of params) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return params.map((p) => ({ ...p, addr: counts.get(p.name) > 1 ? `${p.name}#${p.index}` : p.name }));
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
    ? withParamAddrs(entry.params).map((p) => ({ key: p.addr, param: p }))
    : chainSlots.flatMap((s) => withParamAddrs(s.params).map((p) => ({ key: p.addr, param: p, plugin: s.plugin })));
  const completions = rankedMatches(pool, typed, 80).map((item) => ({
    text: item.param.addr,
    displayText:
      item.param.addr +
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

// Authoritative clock state comes back from each /api/evaluate: cyclePos isn't simply
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

// Walk every atom value string in a parsed mini AST (skipping rests). Used to bound how far
// back highlighting has to look for a clip-stretched tail.
function walkAtomValues(node, fn) {
  if (!node) return;
  if (node.type === 'atom') {
    if (node.value != null) fn(node.value);
    return;
  }
  if (node.items) for (const it of node.items) walkAtomValues(it.node, fn);
  if (node.item) walkAtomValues(node.item, fn);
}

// Numeric value of a mini number-pattern at absolute cycle-time t - the clip control read at an
// event's onset, matching signal.mjs's `.clip("<1 4 1>")` (structure stays with the note).
function sampleNumberPattern(ast, t) {
  const c = Math.floor(t);
  const ph = t - c;
  let steps;
  try {
    steps = miniMod.getStepsForCycle(ast, c);
  } catch {
    return NaN;
  }
  for (const s of steps) {
    if (s.value != null && ph >= s.start && ph < s.end) return Number(s.value);
  }
  return NaN;
}

// clip elongates a step's duration - the noteOff, and here the highlight, lasts longer than the
// step's own slot. Two client-visible sources, mirroring signal.mjs: the `clip` field of a
// trailing `.as(spec)` (per-atom `:N` suffix), and a trailing `.clip(N)` / `.clip("pat")`. The
// literal owns whichever of those immediately follows it in the chain; a method taking a string
// argument in between (`.scale("min")`) hides a later `.clip`, which then just isn't stretched.
function detectClip(masked, litEnd, ast) {
  const tail = masked.slice(litEnd, litEnd + 400);
  let asIndex = -1;
  let clipConst = null;
  let clipAst = null;

  const asM = /^[^"'`\n]*?\.as\(\s*(["'])([^"'`]*)\1\s*\)/.exec(tail);
  if (asM) asIndex = asM[2].split(':').map((f) => f.trim().toLowerCase()).indexOf('clip');

  const clipM = /^[^"'`\n]*?\.clip\(\s*(?:(["'])([^"'`]*)\1|([-\d.]+))\s*\)/.exec(tail);
  if (clipM) {
    if (clipM[3] != null) clipConst = Number(clipM[3]);
    else {
      try {
        clipAst = miniMod.parseMini(clipM[2]);
      } catch {
        clipAst = null;
      }
    }
  }

  if (asIndex < 0 && clipConst == null && !clipAst) return null;

  // Bound the per-tick look-back at the largest multiplier the pattern can produce (a step is at
  // most one cycle wide, so ceil(maxMult) cycles of tail, plus a margin), capped for safety.
  let maxMult = 1;
  const consider = (v) => {
    const n = Number(v);
    if (!Number.isNaN(n) && n > maxMult) maxMult = n;
  };
  if (asIndex >= 0) walkAtomValues(ast, (val) => consider(String(val).split(':')[asIndex]));
  if (clipConst != null) consider(clipConst);
  if (clipAst) walkAtomValues(clipAst, consider);

  return { asIndex, clipConst, clipAst, maxCycles: Math.min(32, Math.ceil(maxMult) + 1) };
}

// The duration multiplier for one step under a region's clip descriptor (1 = unchanged).
function clipMultiplier(clip, step, cycle) {
  let m = 1;
  if (clip.asIndex >= 0) {
    const part = String(step.value).split(':')[clip.asIndex];
    const v = Number(part);
    if (part !== undefined && part !== '' && v > 0 && !Number.isNaN(v)) m *= v;
  }
  if (clip.clipConst != null) {
    if (clip.clipConst > 0 && !Number.isNaN(clip.clipConst)) m *= clip.clipConst;
  } else if (clip.clipAst) {
    const v = sampleNumberPattern(clip.clipAst, cycle + (step.start + step.end) / 2);
    if (v > 0 && !Number.isNaN(v)) m *= v;
  }
  return m;
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
    const clip = detectClip(masked, lit.end, ast);
    patternRegions.push({ marker: cm.markText(from, to, {}), ast, clip, lastKey: '', marks: [] });
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

  for (const r of patternRegions) {
    const range = r.marker.find();
    if (!range) continue; // the string was deleted from the buffer

    // Work in absolute cycle-time so a clip-stretched event that rings past the cycle boundary
    // stays lit: an onset in an earlier cycle keeps its atom highlighted until its stretched end.
    // Without clip, maxCycles is 0 - this collapses to "steps of the current cycle", as before.
    // A step's location can recur (chords, or the same alt element revisited), so dedupe by loc.
    const locs = new Map();
    const maxK = r.clip ? r.clip.maxCycles : 0;
    for (let k = 0; k <= maxK; k++) {
      const cyc = cycle - k;
      if (cyc < 0) break; // nothing played before cycle 0 - no tail to inherit
      let steps;
      try {
        steps = miniMod.getStepsForCycle(r.ast, cyc);
      } catch {
        continue;
      }
      for (const s of steps) {
        if (s.value == null || !s.loc) continue;
        // Only true onsets stretch; `cont` tails already carry their remaining length.
        const mult = r.clip && !s.cont ? clipMultiplier(r.clip, s, cyc) : 1;
        const absStart = cyc + s.start;
        const absEnd = cyc + s.start + (s.end - s.start) * mult;
        if (cyclePos >= absStart && cyclePos < absEnd) locs.set(s.loc.join('-'), s.loc);
      }
    }

    const key = [...locs.keys()].sort().join(',');
    if (key === r.lastKey) continue; // same atoms still sounding - don't churn marks
    r.lastKey = key;
    for (const mk of r.marks) mk.clear();
    const base = cm.indexFromPos(range.from);
    r.marks = [...locs.values()].map((loc) =>
      cm.markText(cm.posFromIndex(base + loc[0]), cm.posFromIndex(base + loc[1]), {
        className: 'cm-playing',
      })
    );
  }
}
setInterval(() => {
  highlightTick();
  updatePhraseViz();
  updateRecButton();
}, 33);

function stopHighlighting() {
  playing = false;
  updateTransportButtons();
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
  if (applied) evaluate(true);
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
    const confBtn = document.createElement('button');
    confBtn.className = 'small conf-btn';
    confBtn.textContent = 'conf';
    confBtn.title = "configure: capture knobs you touch in this track's plugin (ui) windows into .param(...) calls in the code";
    if (confSession && confSession.trackLabel === t.label) confBtn.classList.add('conf-active');
    confBtn.onclick = () => toggleConf(t.label, confBtn);
    head.appendChild(confBtn);
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

// Reflect play state on the single Play/Stop toggle button (see the transport TODO): it reads
// "▶ play" when stopped and turns into "■ stop" once playing.
function updateTransportButtons() {
  playBtn.innerHTML = playing ? '■ stop' : '▶ play';
  playBtn.classList.toggle('is-playing', playing);
  playBtn.title = playing ? 'Cmd/Ctrl + .' : 'Cmd/Ctrl + Enter';
}

// The one code-evaluation path. `start: true` (Play) un-freezes the clock so playback (re)starts
// from cycle 0; `start: false` (Update) leaves the clock alone - a running performance is
// re-patched seamlessly, a stopped one just reloads the patterns without making sound. Either
// way the params panel, autocomplete, and highlighting regions refresh.
async function evaluate(start) {
  const code = cm.getValue();
  try {
    const result = await api('POST', '/api/evaluate', { code, start });
    transport = result.transport ?? { cps: result.cps ?? transport.cps, baseSec: 0, baseCycle: 0, paused: !start };
    renderTracks(result);
    setupHighlighting(code, result.tracks);
    foldConfigBlobs();
    if (start) playing = true; // Update keeps the current play state; Play begins it
    const nActive = result.tracks.filter((t) => t.active).length;
    logLine(`${start ? 'playing' : 'updated'} (${nActive}/${result.tracks.length} pattern(s))`);
    loadChainParams();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
  updateTransportButtons();
}

// Play button: state-aware. Playing -> stop; stopped -> evaluate and start.
function togglePlay() {
  if (playing) doStop();
  else evaluate(true);
}

async function doStop() {
  if (recState) cancelMidiRecord(true);
  const result = await api('POST', '/api/stop');
  if (result.transport) transport = result.transport; // frozen at cycle 0
  stopHighlighting();
  updateTransportButtons();
  logLine('stopped');
}

// ---------------------------------------------------------------------------------------------
// Macros panel - a bank of knobs exposed to evaluated code as macro1..macroN (0..1 signals).
// The values live server-side in pattern-core's macro store (that's what the scheduler polls);
// these knobs are just the write side, streaming moves over POST /api/macros/set.
// ---------------------------------------------------------------------------------------------

const macroBank = document.getElementById('macroBank');

async function initMacros() {
  let macros;
  try {
    ({ macros } = await api('GET', '/api/macros'));
  } catch (e) {
    macroBank.textContent = `macros unavailable: ${e.message}`;
    return;
  }
  macroBank.innerHTML = '';
  for (const m of macros) macroBank.appendChild(macroKnob(m));
}

// One knob: vertical drag turns it (shift = fine), scroll nudges it, double-click resets to 0.
// Double-clicking the name opens an inline rename (empty = back to "Macro N").
function macroKnob(m) {
  const root = document.createElement('div');
  root.className = 'macro';

  const knob = document.createElement('div');
  knob.className = 'macro-knob';
  const num = document.createElement('span');
  num.className = 'macro-num';
  num.textContent = m.index;
  knob.appendChild(num);

  const nameEl = document.createElement('div');
  nameEl.className = 'macro-name';
  nameEl.title = 'double-click to rename';
  root.append(knob, nameEl);

  let value = m.value;
  let name = m.name;

  const paint = () => {
    knob.style.setProperty('--v', value);
    knob.title = `${name} = ${value.toFixed(2)}  ·  macro${m.index} in code  ·  double-click resets`;
    nameEl.textContent = name;
  };
  paint();

  // A drag streams values; keep at most one POST in flight and always land on the final one.
  let inFlight = false;
  let dirty = false;
  const push = async () => {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    const sent = value;
    try {
      await api('POST', '/api/macros/set', { index: m.index, value: sent });
    } catch (e) {
      logLine(`macro ${m.index}: ${e.message}`, true);
    }
    inFlight = false;
    if (dirty) {
      dirty = false;
      if (value !== sent) push();
    }
  };

  const setValue = (v) => {
    value = Math.min(1, Math.max(0, v));
    paint();
    push();
  };

  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startV = value;
    const onMove = (ev) => {
      const pxPerSweep = ev.shiftKey ? 1200 : 160; // px of vertical drag for the full 0..1 sweep
      setValue(startV + (startY - ev.clientY) / pxPerSweep);
    };
    const onUp = () => {
      knob.removeEventListener('pointermove', onMove);
      knob.removeEventListener('pointerup', onUp);
      knob.removeEventListener('pointercancel', onUp);
    };
    knob.addEventListener('pointermove', onMove);
    knob.addEventListener('pointerup', onUp);
    knob.addEventListener('pointercancel', onUp);
  });

  knob.addEventListener('dblclick', () => setValue(0));

  knob.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      setValue(value - Math.sign(e.deltaY) * (e.shiftKey ? 0.002 : 0.02));
    },
    { passive: false },
  );

  nameEl.addEventListener('dblclick', () => {
    const input = document.createElement('input');
    input.className = 'macro-name-input';
    input.value = name;
    input.maxLength = 24;
    input.spellcheck = false;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      try {
        const res = await api('POST', '/api/macros/name', { index: m.index, name: input.value });
        name = res.name;
      } catch (e) {
        logLine(`macro ${m.index}: ${e.message}`, true);
      }
      paint();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') {
        done = true;
        paint();
      }
    });
    input.addEventListener('blur', commit);
  });

  return root;
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
    // addr disambiguates reused names ("Frequency#95") so the copied string targets exactly the
    // clicked parameter; searching still matches on it (the base name is a substring of the addr).
    const matches = withParamAddrs(slot.params).filter((p) => !query || p.addr.toLowerCase().includes(query));
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
      name.textContent = p.addr;
      row.appendChild(name);
      if (p.label) {
        const label = document.createElement('span');
        label.className = 'dim';
        label.textContent = p.label;
        row.appendChild(label);
      }
      row.onclick = () => copyText(p.addr, 'param');
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
// Samples browser (sounds tab) - the packs under the samples root (folders of audio files; see
// osc-engine's samples.js). A file's position in its pack is its sampler index, so file rows
// copy `s("pack:idx")` and pack headers copy `s("pack")`. Reloaded every time the tab opens,
// so packs added on disk mid-session show up.
// ---------------------------------------------------------------------------------------------

const sampleSearch = document.getElementById('sampleSearch');
const sampleList = document.getElementById('sampleList');
const samplesCount = document.getElementById('samplesCount');

const MAX_SAMPLE_ROWS = 300;
let samplePacks = null; // null until the first load, then [{ name, files }]
let samplesRootDir = '';

// Sample preview (auditioning). Plays the actual file the sounds browser lists - fetched from
// /api/sampleAudio by the same pack/index that `s("pack:i")` uses - through Web Audio, so a
// click both copies the pattern and lets you hear what it plays. The AudioContext is created
// lazily on the first click (a user gesture, which browsers require to start audio), and each
// new preview stops the previous one so rapid clicking doesn't stack overlapping sounds.
let previewCtx = null;
let previewSource = null; // the currently-playing BufferSourceNode, if any
let previewRow = null; // the row element marked 'previewing', so we can clear it when it ends
let previewGen = 0; // bumped on every press, so a slow fetch/decode from an older press is dropped
let previewHeld = false; // true between pointerdown and release - hold-to-preview gate

// Release anywhere ends the audition, even if the pointer drifted off the row first. Also
// cancels a press that's released before its fetch/decode has started playing (see previewSample).
window.addEventListener('pointerup', () => { previewHeld = false; stopPreview(); });

function stopPreview() {
  if (previewSource) {
    try { previewSource.stop(); } catch {}
    previewSource = null;
  }
  if (previewRow) {
    previewRow.classList.remove('previewing');
    previewRow = null;
  }
}

async function previewSample(pack, i, row) {
  stopPreview();
  const gen = ++previewGen;
  previewHeld = true;
  previewCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (previewCtx.state === 'suspended') previewCtx.resume().catch(() => {});
  try {
    const res = await fetch(`/api/sampleAudio?pack=${encodeURIComponent(pack)}&i=${i}`);
    if (!res.ok) throw new Error(`preview failed: ${res.status}`);
    const buf = await previewCtx.decodeAudioData(await res.arrayBuffer());
    // Drop this press if a newer one superseded it, or the button was already released.
    if (gen !== previewGen || !previewHeld) return;
    const src = previewCtx.createBufferSource();
    src.buffer = buf;
    src.connect(previewCtx.destination);
    src.onended = () => { if (src === previewSource) stopPreview(); };
    previewSource = src;
    previewRow = row;
    row?.classList.add('previewing');
    src.start();
  } catch (e) {
    if (gen === previewGen) { stopPreview(); logLine(e.message ?? String(e), true); }
  }
}

function renderSamples() {
  const query = sampleSearch.value.trim().toLowerCase();
  sampleList.innerHTML = '';
  if (!samplePacks?.length) {
    samplesCount.textContent = '';
    sampleList.textContent = samplePacks
      ? `no sample packs found - put folders of audio files in ${samplesRootDir}`
      : 'loading…';
    return;
  }

  samplesCount.textContent = `${samplePacks.reduce((sum, p) => sum + p.files.length, 0)}`;

  let shown = 0;
  let matched = 0;
  for (const pack of samplePacks) {
    const packMatches = pack.name.toLowerCase().includes(query);
    // Indexes must be positions in the full pack, not the filtered view - attach before filtering.
    const files = pack.files
      .map((name, i) => ({ name, i }))
      .filter((f) => !query || packMatches || f.name.toLowerCase().includes(query));
    if (!files.length) continue;
    matched += files.length;
    if (shown >= MAX_SAMPLE_ROWS) continue; // keep counting for the more-note, stop rendering

    const head = document.createElement('div');
    head.className = 'slot-head sample-pack-head';
    head.title = 'click to copy';
    head.textContent = `${pack.name} · ${pack.files.length}`;
    head.onclick = () => copyText(`s("${pack.name}")`, 'pack');
    sampleList.appendChild(head);

    for (const f of files) {
      if (shown >= MAX_SAMPLE_ROWS) break;
      const row = document.createElement('div');
      row.className = 'param-row sample-row';
      row.title = 'hold to preview · click copies';
      const name = document.createElement('span');
      name.textContent = f.name;
      row.appendChild(name);
      const idx = document.createElement('span');
      idx.className = 'dim';
      idx.textContent = `:${f.i}`;
      row.appendChild(idx);
      // Hold-to-preview: audition starts on press and stops on release (so a long sample
      // doesn't play to the end), while the plain click still copies the pattern.
      row.onpointerdown = (e) => {
        if (e.button !== 0) return; // left button only
        copyText(`s("${pack.name}:${f.i}")`, 'sample');
        previewSample(pack.name, f.i, row);
      };
      sampleList.appendChild(row);
      shown++;
    }
  }

  if (matched > shown) {
    const more = document.createElement('div');
    more.className = 'more-note';
    more.textContent = `…${matched - shown} more — refine the filter to see them`;
    sampleList.appendChild(more);
  }
  if (!matched) sampleList.textContent = 'no samples match';
}

async function loadSamples() {
  try {
    const { root, packs } = await api('GET', '/api/samples');
    samplesRootDir = root;
    samplePacks = packs;
  } catch (e) {
    samplePacks = [];
    logLine(e.message ?? String(e), true);
  }
  renderSamples();
}

sampleSearch.addEventListener('input', renderSamples);

// ---------------------------------------------------------------------------------------------
// Sidebar tabs (session | sounds | files | settings) + pattern file manager. Pattern files are
// whole editor buffers saved server-side (~/.poptart/patterns/<name>.js) via /api/patterns*:
// save the current buffer under a name, click a saved pattern to load it, rename/delete to
// organize.
// ---------------------------------------------------------------------------------------------

const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sessionTab = document.getElementById('sessionTab');
const soundsTab = document.getElementById('soundsTab');
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
    soundsTab.classList.toggle('hidden', btn.dataset.tab !== 'sounds');
    filesTab.classList.toggle('hidden', btn.dataset.tab !== 'files');
    settingsTab.classList.toggle('hidden', btn.dataset.tab !== 'settings');
    if (btn.dataset.tab === 'sounds') loadSamples();
    if (btn.dataset.tab === 'files') refreshPatternFiles();
    if (btn.dataset.tab === 'settings') { refreshAudioDevices(); refreshSamplesDir(); }
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
    updateTransportButtons();
    transport = { ...transport, paused: true, baseCycle: 0 }; // server froze its clock too
    logLine(`audio output is now ${label} - re-evaluate (Cmd/Ctrl+Enter) to resume playback`);
  } catch (e) {
    logLine(e.message ?? String(e), true);
  } finally {
    audioDeviceSelect.disabled = false;
    refreshStatus().catch(() => {});
  }
});

// Sample-library folder. The saved folder is what `s(...)` reads packs from; when
// POPTART_SAMPLES_DIR is set in the environment it overrides this, so the field goes read-only
// and says so.
const samplesDirInput = document.getElementById('samplesDirInput');
const samplesDirSave = document.getElementById('samplesDirSave');
const samplesDirReset = document.getElementById('samplesDirReset');
const samplesDirNote = document.getElementById('samplesDirNote');

async function refreshSamplesDir() {
  try {
    const { dir, envOverride } = await api('GET', '/api/samplesDir');
    samplesDirInput.value = dir;
    samplesDirInput.disabled = envOverride;
    samplesDirSave.disabled = envOverride;
    samplesDirReset.disabled = envOverride;
    samplesDirNote.textContent = envOverride
      ? 'set by POPTART_SAMPLES_DIR - unset it to edit here'
      : '';
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function saveSamplesDir(dir) {
  try {
    const res = await api('POST', '/api/samplesDir', { dir });
    samplesDirInput.value = res.dir;
    logLine(`sample library folder is now ${res.dir}`);
    loadSamples().catch(() => {}); // refresh the sounds browser against the new root
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

samplesDirSave.addEventListener('click', () => saveSamplesDir(samplesDirInput.value.trim() || null));
samplesDirReset.addEventListener('click', () => saveSamplesDir(null));
samplesDirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveSamplesDir(samplesDirInput.value.trim() || null); }
});

// Folder picker - a server-side directory browser (the server and browser are the same machine,
// and browsers can't hand back a real filesystem path). Navigate into subfolders, up via ".."
// or the path field, and "use this folder" saves the current path as the sample library.
const dirPickerBackdrop = document.getElementById('dirPickerBackdrop');
const dirPickerPath = document.getElementById('dirPickerPath');
const dirPickerList = document.getElementById('dirPickerList');
const dirPickerNote = document.getElementById('dirPickerNote');
const dirPickerUse = document.getElementById('dirPickerUse');
const dirPickerClose = document.getElementById('dirPickerClose');
const samplesDirBrowse = document.getElementById('samplesDirBrowse');
let dirPickerCurrent = '';

async function browseTo(pathArg) {
  dirPickerNote.textContent = '';
  try {
    const { path, parent, dirs } = await api('GET', `/api/browseDir?path=${encodeURIComponent(pathArg ?? '')}`);
    dirPickerCurrent = path;
    dirPickerPath.value = path;
    dirPickerList.innerHTML = '';
    if (parent) {
      const up = document.createElement('div');
      up.className = 'dir-row dir-up';
      up.textContent = '↑ ..';
      up.addEventListener('click', () => browseTo(parent));
      dirPickerList.appendChild(up);
    }
    for (const name of dirs) {
      const row = document.createElement('div');
      row.className = 'dir-row';
      row.textContent = name;
      row.addEventListener('click', () => browseTo(`${path}/${name}`));
      dirPickerList.appendChild(row);
    }
    if (!dirs.length) {
      const empty = document.createElement('div');
      empty.className = 'dir-empty';
      empty.textContent = 'no subfolders here';
      dirPickerList.appendChild(empty);
    }
  } catch (e) {
    dirPickerNote.textContent = e.message ?? String(e);
  }
}

function openDirPicker() {
  dirPickerBackdrop.classList.remove('hidden');
  browseTo(samplesDirInput.value.trim() || null);
}
function closeDirPicker() { dirPickerBackdrop.classList.add('hidden'); }

samplesDirBrowse.addEventListener('click', openDirPicker);
dirPickerClose.addEventListener('click', closeDirPicker);
dirPickerBackdrop.addEventListener('click', (e) => { if (e.target === dirPickerBackdrop) closeDirPicker(); });
dirPickerPath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); browseTo(dirPickerPath.value.trim()); }
});
dirPickerUse.addEventListener('click', () => {
  samplesDirInput.value = dirPickerCurrent;
  closeDirPicker();
  saveSamplesDir(dirPickerCurrent || null);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dirPickerBackdrop.classList.contains('hidden')) closeDirPicker();
});

// ---------------------------------------------------------------------------------------------
// Prebake editor - a modal CodeMirror over ~/.poptart/prebake.js (settings tab -> "edit
// prebake…"). Saving writes the file and re-runs it server-side, so edits apply without a
// restart; per-block errors come back and show in the footer. Its own CodeMirror is created
// lazily on first open (and refreshed then, since it's laid out while hidden).
// ---------------------------------------------------------------------------------------------

const prebakeBackdrop = document.getElementById('prebakeBackdrop');
const prebakeEditBtn = document.getElementById('prebakeEditBtn');
const prebakeSaveBtn = document.getElementById('prebakeSave');
const prebakeCloseBtn = document.getElementById('prebakeClose');
const prebakeNote = document.getElementById('prebakeNote');
const PREBAKE_HINT = 'saved to ~/.poptart/prebake.js · ⌘S / ⌘↵ to save';
let prebakeCM = null;

function ensurePrebakeCM() {
  if (!prebakeCM) {
    prebakeCM = CodeMirror.fromTextArea(document.getElementById('prebakeEditor'), {
      mode: { name: 'javascript' },
      theme: 'poptart',
      keyMap: 'sublime',
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      viewportMargin: Infinity,
      extraKeys: {
        'Cmd-Enter': savePrebake,
        'Ctrl-Enter': savePrebake,
        'Cmd-S': savePrebake,
        'Ctrl-S': savePrebake,
      },
    });
  }
  return prebakeCM;
}

function setPrebakeNote(text, isError = false) {
  prebakeNote.textContent = text;
  prebakeNote.classList.toggle('error', isError);
}

async function openPrebake() {
  const editor = ensurePrebakeCM();
  setPrebakeNote('loading…');
  try {
    const { code } = await api('GET', '/api/prebake');
    editor.setValue(code ?? '');
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
  prebakeBackdrop.classList.remove('hidden');
  editor.refresh(); // it was laid out while hidden - size it now that it's visible
  editor.focus();
  editor.setCursor(editor.lineCount(), 0);
  setPrebakeNote(PREBAKE_HINT);
}

function closePrebake() { prebakeBackdrop.classList.add('hidden'); }

async function savePrebake() {
  if (!prebakeCM) return;
  prebakeSaveBtn.disabled = true;
  setPrebakeNote('saving…');
  try {
    const { errors } = await api('POST', '/api/prebake', { code: prebakeCM.getValue() });
    if (errors && errors.length) {
      setPrebakeNote(`saved, but: ${errors.join(' · ')}`, true);
      for (const msg of errors) logLine(`prebake ${msg}`, true);
    } else {
      setPrebakeNote(`saved & ran ✓ · ${PREBAKE_HINT}`);
      logLine('prebake saved & re-run');
    }
  } catch (e) {
    setPrebakeNote(e.message ?? String(e), true);
    logLine(e.message ?? String(e), true);
  } finally {
    prebakeSaveBtn.disabled = false;
  }
}

prebakeEditBtn.addEventListener('click', openPrebake);
prebakeSaveBtn.addEventListener('click', savePrebake);
prebakeCloseBtn.addEventListener('click', closePrebake);
prebakeBackdrop.addEventListener('click', (e) => { if (e.target === prebakeBackdrop) closePrebake(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !prebakeBackdrop.classList.contains('hidden')) closePrebake();
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

const PRESET_THEMES = ['poptart', 'blueberry', 'matcha', 'paper', 'glossing'];
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

playBtn.addEventListener('click', togglePlay);
updateBtn.addEventListener('click', () => evaluate(false));
scanBtn.addEventListener('click', doScan);

refreshStatus().then((loaded) => {
  if (loaded) loadKnownPlugins();
});
initMacros();
