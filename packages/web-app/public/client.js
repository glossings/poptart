'use strict';

// Browser UI: CodeMirror editor with poptart-aware autocomplete (real VST parameter names
// inside `.param("…")`, plugin names inside `.synth("…")`/`.fx("…")`, documented method/builder
// names elsewhere - see api-docs.js, which also feeds the doc panel beside the popup and the
// ctrl-hover tooltip), live playback highlighting of mini-notation (the atom currently sounding lights
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
const LOG_MAX_LINES = 500; // in-app console scrollback (see logLine) - .log() can fill it fast

// pattern-core modules, loaded async at startup; highlighting/label/shape-editor features just
// stay off until they arrive (or if the import fails).
let miniMod = null;
let labelsMod = null;
let shapeMod = null;
let pianorollMod = null;
let notesMod = null; // notes.mjs - pure music-theory helpers piped up to the userland prebake scope
// Resolves once pattern-core is loaded (or failed) - the startup prebake waits on it so a
// top-level noteToMidi()/etc. call in the prebake never races the import.
const coreReady = Promise.all([
  import('/pattern-core/mini.mjs'),
  import('/pattern-core/labels.mjs'),
  import('/pattern-core/shape.mjs'),
  import('/pattern-core/pianoroll.mjs'),
  import('/pattern-core/notes.mjs'),
])
  .then(([m, l, s, pr, nt]) => {
    miniMod = m;
    labelsMod = l;
    shapeMod = s;
    pianorollMod = pr;
    notesMod = nt;
    initLfoEditor();
    initPianorollEditor();
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
  // Newest first, so the tail is what gets dropped. A .log()'d track writes a line per event -
  // tens a second - and this panel is a scrollback, not a record: devtools below keeps the lot.
  while (log.childElementCount > LOG_MAX_LINES) log.lastElementChild.remove();
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

// BUILDERS / METHODS / API_DOCS / lookupDoc come from api-docs.js (loaded just before this
// script): one documented entry per userland name, and the word lists are derived from it.

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
    'Ctrl-Space': () => showPoptartHint(),
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
  // lfo() shape strings and pianoroll() note strings: editor-written data, not code to read, so
  // they always fold - length doesn't matter. An empty string is left alone: there's nothing to
  // hide, and a "⋯" chip would imply content that isn't there.
  const DATA_ARG_TITLES = {
    lfo: 'lfo shape — click to expand, or use the shape editor',
    pianoroll: 'piano roll notes — click to expand, or use the piano roll editor',
  };
  const dataArgRe = /\b(lfo|pianoroll)\s*\(\s*("(?:[^"\\\n]|\\.)*")/g;
  while ((m = dataArgRe.exec(code))) {
    const str = m[2];
    if (str.length <= 2) continue; // "" - already as small as it gets
    const start = m.index + m[0].length - str.length;
    foldSpan(start, start + str.length, '"⋯"', DATA_ARG_TITLES[m[1]]);
  }
}

// String/bracket-aware scan from an opening paren to its matching close; -1 if unbalanced. The one
// call-span scanner in this file - conf's param upsert, the lfo/pianoroll editors, and the MIDI
// recorder's call rewrites all go through it.
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

// ---------------------------------------------------------------------------------------------
// Auto-pin: `synth("Serum 2")` with no state argument means "however the plugin defaults", but
// the moment you touch anything in the plugin's own window that stops being true. The server
// notices the edit, captures the state (debounced - see captureDirtyPlugins), and we write it
// into that slot's synth/fx call as `{ state }`. So the code always describes what you're
// hearing, and it restores on load and shares via the URL like everything else.
// ---------------------------------------------------------------------------------------------

function writePluginState(trackLabel, slot, state) {
  if (!labelsMod) return;
  const code = cm.getValue();
  const block = labelsMod.splitLabeledBlocks(code).find((b) => b.label === trackLabel);
  const call = block && findChainCall(code, block.start, block.end, slot);
  if (!call) {
    // The call was renamed or deleted between the gesture and the capture. Nothing to write to;
    // the next edit in that plugin captures again.
    logLine(`auto-pin: no ${slot === 0 ? 'synth(...)' : '.fx(...)'} call for track "${trackLabel}" slot ${slot} - state not written`, true);
    return;
  }
  // Tagged with a single `+`-prefixed origin so CodeMirror merges consecutive writes into one
  // undo step (same trick as the copy-line edits). Each state is multi-KB, and without this a
  // knob drag would bury your last real edit under a run of blobs in the undo history.
  cm.replaceRange(`, { state: "${state}" }`, cm.posFromIndex(call.afterFirstArg), cm.posFromIndex(call.closeParen), '+autopin');
  foldConfigBlobs();
}

// Deliberately does NOT re-evaluate: the state is already live in the plugin (it came from
// there), so an eval would only push it back and make the plugin reload what it already has.
async function pollPluginEdits() {
  const { edits, logs } = await api('POST', '/api/pluginEdits');
  for (const e of edits ?? []) writePluginState(e.trackId, e.slot, e.state);
  // .log() event lines from the scheduler, which runs server-side - same drain, same 500ms.
  for (const line of logs ?? []) logLine(line);
}

setInterval(() => pollPluginEdits().catch(() => {}), 500);

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

function wordHints(cur, typed, words, context) {
  const pool = words.map((w) => ({ key: w }));
  const completions = rankedMatches(pool, typed, 24).map((item) => {
    const doc = lookupDoc(item.key, context);
    // A value (macro1..8) completes bare; everything else is a call, so type its paren too.
    const text = doc && doc.call === false ? item.key : `${item.key}(`;
    return { text, displayText: text, doc, render: doc ? renderHintRow : undefined };
  });
  return hintResult(cur, typed, completions);
}

// One completion row: name and signature only. The description belongs to the doc panel beside
// the list - repeating it here just widens the popup, and at high zoom the two end up stacked.
function renderHintRow(el, data, completion) {
  const { name, display } = completion.doc;
  const nameEl = document.createElement('span');
  nameEl.className = 'hint-name';
  nameEl.textContent = name;
  el.appendChild(nameEl);
  const args = display.slice(display.indexOf(name) + name.length); // "(factor)", or "" for a value
  if (args) {
    const argsEl = document.createElement('span');
    argsEl.className = 'hint-args';
    argsEl.textContent = args;
    el.appendChild(argsEl);
  }
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

  // After a dot → chain methods; bare word → top-level builders. A dot straight after a digit is
  // the decimal point of a number being typed (`begin(0.3`), not a chain - offering the whole
  // method list there pops a menu over every float you type.
  m = before.match(/(\d?)\.([A-Za-z_]*)$/);
  if (m && !m[1]) return wordHints(cur, m[2], METHODS, 'method');
  m = before.match(/(?:^|[^.\w"'])([A-Za-z_]+)$/);
  if (m) return wordHints(cur, m[1], BUILDERS, 'builder');

  return { list: [], from: cur, to: cur };
}

// Auto-open the hint popup while typing (quotes/parens/word chars, plus spaces so multi-word
// param names like "Filter 1 Freq" keep the popup alive).
cm.on('inputRead', (cm, change) => {
  if (cm.state.completionActive) return;
  const typedChar = change.text[change.text.length - 1].slice(-1);
  if (/[\w"'( ]/.test(typedChar)) {
    showPoptartHint();
  }
});

// ---------------------------------------------------------------------------------------------
// Documentation tooltips - the same api-docs.js entries in two places: a panel beside the
// autocomplete popup describing whichever completion is selected, and a ctrl-hover tooltip over
// any documented name already in the buffer. Both off together via the settings toggle.
// ---------------------------------------------------------------------------------------------

const DOC_TOOLTIPS_KEY = 'poptart-doc-tooltips';
let docTooltipsEnabled = localStorage.getItem(DOC_TOOLTIPS_KEY) !== '0'; // default on

function setDocTooltips(on) {
  docTooltipsEnabled = on;
  localStorage.setItem(DOC_TOOLTIPS_KEY, on ? '1' : '0');
  if (!on) {
    hideHintDoc();
    hideHoverDoc();
  }
}

// Signature / description / example, the shared body of both boxes.
function renderDocBox(el, doc) {
  el.innerHTML = '';
  const sig = document.createElement('div');
  sig.className = 'doc-sig';
  sig.textContent = doc.display;
  const desc = document.createElement('div');
  desc.className = 'doc-desc';
  desc.textContent = doc.desc;
  el.append(sig, desc);
  if (doc.eg) {
    const eg = document.createElement('div');
    eg.className = 'doc-eg';
    eg.textContent = doc.eg;
    el.appendChild(eg);
  }
}

function makeDocBox(className) {
  const el = document.createElement('div');
  el.className = `doc-box ${className}`;
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

// --- the panel beside the completion popup ---

let hintDocEl = null;

function hideHintDoc() {
  if (hintDocEl) hintDocEl.style.display = 'none';
}

// Park the panel next to the hint list, flipping to its left when the window runs out. When the
// window is zoomed far enough that neither side fits the panel at full width, narrow it into the
// roomier side instead of letting it land on top of the list.
function showHintDoc(doc, listEl) {
  if (!hintDocEl) hintDocEl = makeDocBox('doc-box-hint');
  renderDocBox(hintDocEl, doc);
  hintDocEl.style.display = 'block';
  hintDocEl.style.left = '0px'; // measure at a known position before deciding where it goes
  hintDocEl.style.top = '0px';
  hintDocEl.style.maxWidth = '';
  const list = listEl.getBoundingClientRect();
  const gap = 6;
  const roomRight = window.innerWidth - 4 - (list.right + gap);
  const roomLeft = list.left - gap - 4;
  let left;
  const width = hintDocEl.getBoundingClientRect().width;
  if (width <= roomRight) left = list.right + gap;
  else if (width <= roomLeft) left = list.left - gap - width;
  else {
    const squeezed = Math.max(140, Math.max(roomRight, roomLeft));
    hintDocEl.style.maxWidth = `${squeezed}px`;
    left = roomRight >= roomLeft ? list.right + gap : list.left - gap - squeezed;
  }
  const height = hintDocEl.getBoundingClientRect().height; // re-measure: narrowing made it taller
  hintDocEl.style.left = `${Math.max(4, left)}px`;
  hintDocEl.style.top = `${Math.max(4, Math.min(list.top, window.innerHeight - height - 4))}px`;
}

// Wrap a hint source so whichever completion is highlighted shows its docs. Completions without
// a `doc` (param names, plugins, MIDI devices) just leave the panel closed.
function withDocPanel(hintFn) {
  return (...args) => {
    const result = hintFn(...args);
    const attach = (res) => {
      if (!res || !res.list) return res;
      CodeMirror.on(res, 'select', (completion, node) => {
        if (docTooltipsEnabled && completion && completion.doc) showHintDoc(completion.doc, node.parentNode);
        else hideHintDoc();
      });
      CodeMirror.on(res, 'close', hideHintDoc);
      // show-hint only signals "close" when a list is on screen: if the next keystroke narrows the
      // list to nothing it drops the popup silently, and the panel would hang around describing a
      // completion that is no longer offered. "update" fires on the outgoing result either way, and
      // the replacement's "select" re-shows the panel in the same frame, so there's no flicker.
      CodeMirror.on(res, 'update', hideHintDoc);
      return res;
    };
    return result && typeof result.then === 'function' ? result.then(attach) : attach(result);
  };
}

function showPoptartHint() {
  cm.showHint({ hint: withDocPanel(poptartHint), completeSingle: false });
}

// Backstop for the same asymmetry: a completion session that already lost its popup closes without
// signalling its result, so hang the panel's last word on the editor-level event instead.
cm.on('endCompletion', hideHintDoc);

// --- ctrl-hover over a name in the buffer ---

let hoverDocEl = null;
let hoverDocKey = null; // the token the tooltip is currently showing, so a jiggle doesn't rerender

function hideHoverDoc() {
  if (hoverDocEl) hoverDocEl.style.display = 'none';
  hoverDocKey = null;
}

function showHoverDoc(doc, key, tokenBox) {
  if (!hoverDocEl) hoverDocEl = makeDocBox('doc-box-hover');
  // Already open on this very token - moving the pointer within it shouldn't re-measure anything.
  if (hoverDocKey === key && hoverDocEl.style.display === 'block') return;
  renderDocBox(hoverDocEl, doc);
  hoverDocKey = key;
  hoverDocEl.style.display = 'block';
  hoverDocEl.style.left = '0px';
  hoverDocEl.style.top = '0px';
  const box = hoverDocEl.getBoundingClientRect();
  const left = Math.min(tokenBox.left, window.innerWidth - box.width - 4);
  // Below the token by default; above it when the tooltip would fall off the bottom.
  const below = tokenBox.bottom + 6;
  const top = below + box.height <= window.innerHeight - 4 ? below : Math.max(4, tokenBox.top - 6 - box.height);
  hoverDocEl.style.left = `${Math.max(4, left)}px`;
  hoverDocEl.style.top = `${top}px`;
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

// The documented name under the pointer, if any. CodeMirror's coordsChar snaps to the nearest
// character, so the pointer is checked against the token's own box before we call it a hover.
function docAtCoords(clientX, clientY) {
  const pos = cm.coordsChar({ left: clientX, top: clientY }, 'window');
  const line = cm.getLine(pos.line);
  if (line == null) return null;
  let token = cm.getTokenAt(pos, true);
  // getTokenAt returns the token ENDING at pos, so on the left edge of a name we get whatever
  // precedes it (the dot, a space) - look one character right before giving up.
  if ((!token || !IDENTIFIER_RE.test(token.string)) && pos.ch < line.length) {
    token = cm.getTokenAt(CodeMirror.Pos(pos.line, pos.ch + 1), true);
  }
  if (!token || !IDENTIFIER_RE.test(token.string)) return null;
  const startBox = cm.charCoords(CodeMirror.Pos(pos.line, token.start), 'window');
  const endBox = cm.charCoords(CodeMirror.Pos(pos.line, token.end), 'window');
  if (clientY < startBox.top || clientY > startBox.bottom) return null;
  if (clientX < startBox.left || clientX > endBox.left) return null;
  const context = /\.\s*$/.test(line.slice(0, token.start)) ? 'method' : 'builder';
  const doc = lookupDoc(token.string, context);
  return doc ? { doc, key: `${token.string}:${context}`, box: startBox } : null;
}

const editorWrapper = cm.getWrapperElement();
let lastHoverPoint = null; // so holding ctrl without moving the mouse still opens the tooltip

function updateHoverDoc(point, ctrlHeld) {
  lastHoverPoint = point;
  if (!point || !ctrlHeld || !docTooltipsEnabled || cm.state.completionActive) {
    hideHoverDoc();
    return;
  }
  const hit = docAtCoords(point.x, point.y);
  if (!hit) hideHoverDoc();
  else showHoverDoc(hit.doc, hit.key, hit.box);
}

editorWrapper.addEventListener('mousemove', (e) => updateHoverDoc({ x: e.clientX, y: e.clientY }, e.ctrlKey));
editorWrapper.addEventListener('mouseleave', () => updateHoverDoc(null, false));
// Ctrl pressed with the pointer already parked over a name, and released again.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Control') updateHoverDoc(lastHoverPoint, true);
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Control' || !e.ctrlKey) hideHoverDoc();
});
cm.on('scroll', hideHoverDoc); // the code moved out from under the pointer

// ---------------------------------------------------------------------------------------------
// Interactive LFO shape editor - click the `lfo` name in any `lfo(...)` call (just the name: its
// arguments are code you may want to edit by hand) and a Serum-style panel opens: drag breakpoints,
// drag a segment to bend it (curvature), double-click to add/remove points, pick presets, set rate
// + free/retrigger/envelope mode. Every change is serialized straight back into the code as
// `lfo("x,y,c …", { rate, mode })` and re-evaluated (debounced), so the modulation follows the
// shape without a manual ⏎; hand edits to the call flow the other way, back into the open panel.
// The code stays the single source of truth (and shares via the URL hash like everything else).
// ---------------------------------------------------------------------------------------------

const lfoPanel = document.getElementById('lfoPanel');
const lfoCanvas = document.getElementById('lfoCanvas');
const lfoPreset = document.getElementById('lfoPreset');
const lfoRandom = document.getElementById('lfoRandom');
const lfoCloseBtn = document.getElementById('lfoClose');
const lfoRate = document.getElementById('lfoRate');
const lfoMode = document.getElementById('lfoMode');

let lfoState = null; // { marker, callStart, points, rate, mode }
let lfoSuppressCursor = false;
const LFO_EVAL_DEBOUNCE_MS = 150; // quiet time after the last shape edit before it re-evaluates

// The lfo(...) call containing idx, plus whether idx is on the *handle* that opens the editor: the
// `lfo` name itself (or anywhere inside a still-empty `lfo()`, so the panel appears as soon as you
// type the call). Its arguments - the shape string, rate:, mode: - are ordinary code you may want
// to edit by hand, so putting the cursor in them opens nothing. Same rule as pianoroll's.
function findLfoCallAt(code, idx) {
  const re = /\blfo\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    if (idx < m.index || idx > close + 1) continue;
    const onName = idx <= m.index + 'lfo'.length || !code.slice(open + 1, close).trim();
    return { start: m.index, open, close, onName };
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

function closeLfoEditor() {
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
  try {
    cm.replaceRange(text, range.from, range.to);
    // replaceRange collapses the marker - re-pin it over the fresh text
    lfoState.marker.clear();
    const startIdx = cm.indexFromPos(range.from);
    lfoState.marker = cm.markText(range.from, cm.posFromIndex(startIdx + text.length), {});
    lfoState.callStart = startIdx;
  } finally {
    lfoSuppressCursor = false; // never leave it latched: that would wedge the panel shut for good
  }
  lfoScheduleEval();
}

// A shape edit isn't finished until it *sounds*, so every write re-evaluates the buffer - debounced,
// so dragging a breakpoint costs one request, not one per pointerup. evaluate(false) is the "update"
// path: a stopped clock stays stopped, a running one keeps running with the new modulation.
let lfoEvalTimer = null;
function lfoScheduleEval() {
  clearTimeout(lfoEvalTimer);
  lfoEvalTimer = setTimeout(() => { lfoEvalTimer = null; evaluate(false); }, LFO_EVAL_DEBOUNCE_MS);
}

// The reverse direction: the panel re-reads the call whenever it's edited by hand, so tweaking
// `rate:`/`mode:`/the shape string in the code updates the panel instead of being silently reverted
// by the next drag.
function syncLfoFromCode() {
  if (!lfoState || lfoSuppressCursor || !shapeMod) return;
  const range = lfoState.marker.find();
  if (!range) return;
  const text = cm.getRange(range.from, range.to);
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return; // mid-edit, not a whole call right now - wait for the next change
  const parsed = parseLfoCall(text.slice(open + 1, close));
  lfoState.callStart = cm.indexFromPos(range.from);
  lfoState.points = parsed.points;
  lfoState.rate = parsed.rate;
  lfoState.mode = parsed.mode;
  lfoRate.value = parsed.rate;
  lfoMode.value = parsed.mode;
  drawLfoShape();
}

function initLfoEditor() {
  for (const name of Object.keys(shapeMod.SHAPE_PRESETS)) lfoPreset.add(new Option(name, name));

  cm.on('cursorActivity', () => {
    if (lfoSuppressCursor || !shapeMod) return;
    const call = findLfoCallAt(cm.getValue(), cm.indexFromPos(cm.getCursor()));
    if (!call) {
      if (lfoState) closeLfoEditor();
      return;
    }
    if (lfoState && call.start === lfoState.callStart) return; // already editing this call (args included)
    // Inside some other call's arguments - that's plain editing, not a request for the shape editor.
    if (!call.onName) {
      if (lfoState) closeLfoEditor();
      return;
    }
    // No "don't reopen what I dismissed" guard: the name is an explicit handle, so landing on it is
    // always a request to open, and leaving the cursor in the arguments after a ✕ reopens nothing.
    openLfoEditor(call);
  });

  // Clicking the name opens the panel even when the cursor is *already* there: re-clicking the same
  // spot leaves the selection unchanged, and an unchanged selection fires no cursorActivity - which
  // is what made reopening after ✕ feel stuck. (No focus grab, unlike the piano roll: the shape
  // editor has no keyboard shortcuts of its own, so the keys stay where they're useful - the code.)
  cm.on('mousedown', (_cm, e) => {
    if (!shapeMod) return;
    const call = findLfoCallAt(cm.getValue(), cm.indexFromPos(cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window')));
    if (!call?.onName) return;
    if (lfoState && call.start === lfoState.callStart) return;
    openLfoEditor(call);
  });

  cm.on('change', syncLfoFromCode); // hand edits to the open call flow back into the panel

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
  lfoCloseBtn.addEventListener('click', () => closeLfoEditor());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lfoState) closeLfoEditor();
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
// Interactive piano roll editor - click the `pianoroll` name in any `pianoroll(...)` call (just the
// name: its arguments are code the user may want to edit by hand) and an Ableton-style grid opens
// over the editor, with a real piano keyboard down the left edge and a playhead that sweeps the
// steps as it plays. Two tools (pencil draws, arrow marquee-selects); click a note
// to select it (shift-click extends, ctrl/cmd-A selects all), drag to move, drag a note's right
// edge to resize, cmd-drag vertically to set velocity or probability (the vel/prob toggle), cmd-D
// duplicates. Arrow keys nudge the selection (shift = octave / bar), delete removes it, double-
// click erases one. Wheel scrolls pitch, shift-wheel scrolls time, ctrl-wheel (or the −/+ buttons)
// zooms in on fine grids. With 🎧 on, drawing/dragging previews the note through the track's own
// synth; →♪ rewrites the whole roll as an equivalent mini-notation note("…"). Every change is
// serialized straight back into `pianoroll("midi,start,len[,vel[,prob]] …", { steps })` and
// re-evaluated (debounced), so the track plays what's drawn without a manual ⏎; hand edits to the
// call flow the other way, back into the open panel. The code stays the single source of truth,
// exactly like the lfo() shape editor.
// ---------------------------------------------------------------------------------------------

const prPanel = document.getElementById('pianorollPanel');
const prCanvas = document.getElementById('pianorollCanvas');
const prGridSelect = document.getElementById('pianorollGrid');
const prLenInput = document.getElementById('pianorollLen');
const prToolBtn = document.getElementById('pianorollTool');
const prCmdModeBtn = document.getElementById('pianorollCmdMode');
const prZoomOutBtn = document.getElementById('pianorollZoomOut');
const prZoomInBtn = document.getElementById('pianorollZoomIn');
const prPreviewBtn = document.getElementById('pianorollPreview');
const prToMiniBtn = document.getElementById('pianorollToMini');
const prCloseBtn = document.getElementById('pianorollClose');

const PR_W = 560; // logical canvas size (backing store is scaled by devicePixelRatio for crispness)
const PR_TOPBAR = 16; // loop-ruler strip along the top (drag it to set the loop length)
const PR_GRIDH = 384; // piano-grid height below the ruler
const PR_CH = PR_TOPBAR + PR_GRIDH; // full canvas height
const PR_ROWS = 24; // visible semitone rows (2 octaves)
const PR_GUTTER = 54; // left piano-keyboard gutter, px
const PR_DEFAULT_TOP = 72; // top row when a fresh/empty roll opens (c5 = 60 here, so 72 = c6)
const PR_DEFAULT_VEL = 0.8; // velocity of a freshly drawn note
const PR_EDGE_PX = 6; // right-edge grab zone for resizing
const PR_MAX_ZOOM = 24; // deepest horizontal zoom (cells that many times wider than "fit")
const PR_ZOOM_WHEEL = 0.0012; // wheel-zoom sensitivity (smaller = slower); proportional to deltaY
const PR_PITCH_WHEEL = 0.013; // wheel pitch-scroll sensitivity, rows per deltaY unit (smaller = slower)
const PR_BTN_ZOOM = 1.4; // per-click / per-keypress zoom step for the −/+ buttons and cmd ±
const PR_EVAL_DEBOUNCE_MS = 150; // quiet time after the last roll edit before it re-evaluates
const PR_GRID_DIVS = [['1/4', 4], ['1/8', 8], ['1/8T', 12], ['1/16', 16], ['1/16T', 24], ['1/32', 32], ['1/64', 64]];

// Cursors that echo the tool under the pointer (Ableton's pencil / bracket / up-down), as inline
// SVGs so no asset files are needed. The trailing two numbers are the hotspot.
const svgCursor = (svg, x, y, fallback) => `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
const CUR_PENCIL = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M2.5 17.5l1.2-3.2 9-9 2 2-9 9-3.2 1.2z" fill="#fff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"/><path d="M13 4.5l2-2 2 2-2 2z" fill="#7aa2ff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  2, 18, 'crosshair',
);
const CUR_BRACKET = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="20" viewBox="0 0 18 20"><g fill="none" stroke="#111" stroke-width="3"><path d="M5 3H3v14h2"/><path d="M13 3h2v14h-2"/></g><g fill="none" stroke="#fff" stroke-width="1.3"><path d="M5 3H3v14h2"/><path d="M13 3h2v14h-2"/></g></svg>',
  9, 10, 'ew-resize',
);
const CUR_UPDOWN = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="22" viewBox="0 0 16 22"><g fill="#fff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"><path d="M8 1l4 5H9v10h3l-4 5-4-5h3V6H4z"/></g></svg>',
  8, 11, 'ns-resize',
);

let prState = null; // see openPianorollEditor for the full shape (notes, steps, pitchTop, zoom, scroll, sel, tool, cmdMode, trackLabel)
let prSuppressCursor = false;
let prPreviewEnabled = localStorage.getItem('poptartPianorollPreview') !== '0';
let prSounding = null; // midi note currently ringing from a preview (so we can note-off it)
let prTool = localStorage.getItem('poptartPianorollTool') === 'select' ? 'select' : 'draw'; // pencil vs arrow
let prCmdMode = localStorage.getItem('poptartPianorollCmd') === 'prob' ? 'prob' : 'vel'; // what cmd-drag sets
let prRaf = null; // requestAnimationFrame handle for the playhead sweep
let prPlayheadOn = false; // whether the last frame drew a playhead (so we clear it once on stop)
let prPointer = { px: -1, py: -1 }; // last pointer position, for live cursor updates on cmd-key changes
let prRefreshCursor = () => {}; // re-derives the canvas cursor in place (set by initPianorollCanvas)

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12)}`;
const isBlackKey = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

// The pianoroll(...) call containing idx, plus whether idx is on the *handle* that opens the
// editor: the `pianoroll` name itself (or anywhere inside a still-empty `pianoroll()`, so the
// panel appears as soon as you type the call). The arguments - the note string, grid:, len: -
// are ordinary code the user may want to edit, so putting the cursor in them opens nothing.
function findPianorollCallAt(code, idx) {
  const re = /\bpianoroll\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    if (idx < m.index || idx > close + 1) continue;
    const onName = idx <= m.index + 'pianoroll'.length || !code.slice(open + 1, close).trim();
    return { start: m.index, open, close, onName };
  }
  return null;
}

// The label of the block a `pianoroll(...)` call lives in - the engine track we preview through.
function prBlockLabelAt(idx) {
  if (!labelsMod) return null;
  return labelsMod.splitLabeledBlocks(cm.getValue()).find((b) => idx >= b.start && idx <= b.end)?.label ?? null;
}

// --- note preview: play the drawn note through the track's own synth (if the 🎧 toggle is on and
// the track has been evaluated with an instrument). One note at a time; always paired with an off.
function prPreviewSend(note, isOn) {
  if (!prState?.trackLabel) return;
  api('POST', '/api/previewNote', { trackId: prState.trackLabel, note, vel: PR_DEFAULT_VEL, isOn }).catch(() => {});
}
function prPreview(midi) {
  if (!prPreviewEnabled || prSounding === midi) return;
  if (prSounding != null) prPreviewSend(prSounding, false);
  prPreviewSend(midi, true);
  prSounding = midi;
}
function prPreviewOff() {
  if (prSounding == null) return;
  prPreviewSend(prSounding, false);
  prSounding = null;
}

function parsePianorollCall(inner) {
  const strMatch = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/.exec(inner);
  const noteStr = strMatch?.[2] ?? '';
  const int = (re) => { const m = re.exec(inner); return m ? Math.max(1, Math.round(Number(m[1]))) : null; };
  // grid: `grid: N`, the legacy `steps: N`, or a bare-number second arg. len: `len: N`, else a cycle.
  let grid = int(/\bgrid\s*:\s*(\d+)/) ?? int(/\bsteps\s*:\s*(\d+)/);
  if (grid == null) { const bare = /["'`]\s*,\s*(\d+)\s*$/.exec(inner.trim()); if (bare) grid = Math.max(1, Number(bare[1])); }
  if (grid == null) grid = 16;
  const len = int(/\blen\s*:\s*(\d+)/) ?? grid;
  let notes = [];
  try {
    notes = pianorollMod.parsePianoRoll(noteStr);
  } catch {
    // unparseable note string - start from an empty roll
  }
  return { notes, grid, len };
}

function serializePianorollCall({ notes, grid, len }) {
  return `pianoroll("${pianorollMod.serializePianoRoll(notes)}", { grid: ${grid}, len: ${len} })`;
}

// Frame the pitch window so the drawn notes sit centered; default to PR_DEFAULT_TOP for an empty
// roll. Clamped so the whole PR_ROWS window stays within 0..127.
function pitchTopFor(notes) {
  if (!notes.length) return PR_DEFAULT_TOP;
  const lo = Math.min(...notes.map((nt) => nt.midi));
  const hi = Math.max(...notes.map((nt) => nt.midi));
  const center = Math.round((lo + hi) / 2);
  return Math.min(127, Math.max(PR_ROWS - 1, center + Math.floor(PR_ROWS / 2)));
}

// (Re)populate the grid <select> and len field from prState; a non-standard grid gets its own option.
function prSyncGridLenInputs() {
  if (!prState) return;
  const opts = [...PR_GRID_DIVS];
  if (!opts.some(([, n]) => n === prState.grid)) opts.push([String(prState.grid), prState.grid]);
  opts.sort((a, b) => a[1] - b[1]);
  prGridSelect.innerHTML = '';
  for (const [label, n] of opts) prGridSelect.add(new Option(label, String(n)));
  prGridSelect.value = String(prState.grid);
  prLenInput.value = prState.len;
}

function openPianorollEditor(call) {
  const from = cm.posFromIndex(call.start);
  const to = cm.posFromIndex(call.close + 1);
  const inner = cm.getValue().slice(call.open + 1, call.close);
  if (prState?.marker) prState.marker.clear();
  const { notes, grid, len } = parsePianorollCall(inner);
  prState = {
    marker: cm.markText(from, to, {}),
    callStart: call.start,
    notes,
    grid, // granularity: cells per cycle (the *grid multiplier)
    len, // loop length in cells (grid-th notes)
    pitchTop: pitchTopFor(notes),
    zoom: 1, // 1 = the whole rendered width fits; >1 zooms in horizontally with a scroll offset
    scrollCells: 0, // leftmost visible cell when zoomed in
    sel: new Set(), // currently selected note objects (transient; mutated in place, never reserialized)
    trackLabel: prBlockLabelAt(call.start),
  };
  prSyncGridLenInputs();
  prPanel.classList.remove('hidden');
  drawPianoroll();
  if (!prRaf) prRaf = requestAnimationFrame(prPlayheadLoop); // sweep a playhead while it plays
  // Focus isn't taken here: opening by clicking the name hands it to the canvas from the mousedown
  // handler, while opening because the cursor drifted onto the name (arrow keys, or typing a fresh
  // `pianoroll()`) leaves the keyboard in the code, so the panel never steals keys mid-type.
}

function closePianorollEditor() {
  prPreviewOff();
  if (prRaf) { cancelAnimationFrame(prRaf); prRaf = null; }
  if (prState?.marker) prState.marker.clear();
  prState = null;
  prPanel.classList.add('hidden');
}

// Redraw each frame while the transport is running, so the playhead tracks the cycle; when it's
// paused, redraw once to clear the last playhead, then idle (the loop keeps spinning cheaply so it
// picks straight back up when play resumes). currentCyclePos() is the scheduler's own timebase.
function prPlayheadLoop() {
  if (!prState) { prRaf = null; return; }
  if (!transport.paused) drawPianoroll();
  else if (prPlayheadOn) drawPianoroll();
  prRaf = requestAnimationFrame(prPlayheadLoop);
}

function writePianorollCall() {
  if (!prState) return;
  const range = prState.marker.find();
  if (!range) return;
  const text = serializePianorollCall(prState);
  prSuppressCursor = true;
  try {
    cm.replaceRange(text, range.from, range.to);
    // replaceRange collapses the marker - re-pin it over the fresh text (see writeLfoCall)
    prState.marker.clear();
    const startIdx = cm.indexFromPos(range.from);
    prState.marker = cm.markText(range.from, cm.posFromIndex(startIdx + text.length), {});
    prState.callStart = startIdx;
  } finally {
    prSuppressCursor = false; // never leave it latched: that would wedge the panel shut for good
  }
  prScheduleEval();
}

// A roll edit isn't finished until it *sounds*, so every write re-evaluates the buffer - debounced,
// so a drag that touches a dozen notes still costs one request. evaluate(false) is the "update"
// path (the ⏎ shortcut): it keeps the current play state, so drawing while stopped stays stopped.
let prEvalTimer = null;
function prScheduleEval() {
  clearTimeout(prEvalTimer);
  prEvalTimer = setTimeout(() => { prEvalTimer = null; evaluate(false); }, PR_EVAL_DEBOUNCE_MS);
}

// The reverse direction: the panel re-reads the call whenever it's edited by hand, so tweaking
// `grid:`/`len:`/the note string in the code updates the roll instead of being silently reverted
// by the next drag. Notes are only rebuilt when the string actually changed (the parsed objects
// are identity-tracked by the selection), so hand-editing grid/len keeps the selection intact.
function syncPianorollFromCode() {
  if (!prState || prSuppressCursor || !pianorollMod) return;
  const range = prState.marker.find();
  if (!range) return;
  const text = cm.getRange(range.from, range.to);
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return; // mid-edit, not a whole call right now - wait for the next change
  const parsed = parsePianorollCall(text.slice(open + 1, close));
  prState.callStart = cm.indexFromPos(range.from);
  prState.grid = parsed.grid;
  prState.len = parsed.len;
  if (pianorollMod.serializePianoRoll(parsed.notes) !== pianorollMod.serializePianoRoll(prState.notes)) {
    prState.notes = parsed.notes;
    prState.sel.clear(); // the old note objects are gone
  }
  prSyncGridLenInputs();
  drawPianoroll();
}

// --- canvas geometry (logical coordinates; the backing store is scaled by devicePixelRatio) ---
// The grid renders `cols` cells - at least the loop (len) plus a little headroom, and at least one
// cycle (grid) for context. Horizontal zoom widens each cell past the "fit" width and scrolls; the
// pitch axis never zooms. A loop ruler occupies the top PR_TOPBAR px; note rows sit below it.

// Rendered columns: the loop rounded up to its next whole bar, plus a little headroom to drag into.
// Frozen (prState._dragCols) during a loop drag so the cell width - and thus the drag mapping -
// stays put instead of feeding back on itself as len changes.
const prRenderCols = () => (Math.floor(prState.len / prState.grid) + 1) * prState.grid + 4;

function prMetrics() {
  const gridW = PR_W - PR_GUTTER;
  const rowH = PR_GRIDH / PR_ROWS;
  const cols = prState._dragCols ?? prRenderCols();
  const cellW = (gridW / cols) * prState.zoom;
  const visibleCells = gridW / cellW; // = cols / zoom
  const maxScroll = Math.max(0, cols - visibleCells);
  const scroll = Math.min(maxScroll, Math.max(0, prState.scrollCells));
  prState.scrollCells = scroll; // keep state clamped as len/grid/zoom change
  return { W: PR_W, H: PR_CH, gridTop: PR_TOPBAR, gridH: PR_GRIDH, gridW, cols, cellW, rowH, visibleCells, maxScroll, scroll, bottomMidi: prState.pitchTop - PR_ROWS };
}

const prCellToX = (cell, m) => PR_GUTTER + (cell - m.scroll) * m.cellW;
const prMidiToY = (midi, m) => PR_TOPBAR + (prState.pitchTop - midi) * m.rowH;
const prCellFloat = (px, m) => m.scroll + (px - PR_GUTTER) / m.cellW; // fractional cell under px

function prCanvasPos(e) {
  const r = prCanvas.getBoundingClientRect();
  return { px: (e.clientX - r.left) * (PR_W / r.width), py: (e.clientY - r.top) * (PR_CH / r.height) };
}

function prCellAt(px, m) {
  if (px < PR_GUTTER) return null;
  const cell = Math.floor(prCellFloat(px, m));
  return cell >= 0 && cell < m.cols ? cell : null;
}

const prClampCell = (px, m) => Math.max(0, Math.min(m.cols - 1, Math.floor(prCellFloat(px, m))));
// pitchTop is fractional (smooth scroll); the integer note whose lane contains py is ceil(top - rows).
const prMidiAt = (py, m) => Math.ceil(prState.pitchTop - (py - PR_TOPBAR) / m.rowH);

// Topmost note covering (cell, midi) - later notes draw on top, so scan from the end.
function prNoteAt(cell, midi) {
  for (let i = prState.notes.length - 1; i >= 0; i--) {
    const nt = prState.notes[i];
    if (nt.midi === midi && cell >= nt.start && cell < nt.start + nt.len) return i;
  }
  return null;
}

function prRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A literal piano down the left edge - white/black keys, note names, C's called out. Fixed
// key colours (a piano reads the same in any theme); the divider follows the theme.
function drawPianoKeys(ctx, col, m) {
  const { H, gridTop, rowH } = m;
  ctx.textBaseline = 'middle';
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#ececed';
  ctx.fillRect(0, gridTop, PR_GUTTER, H - gridTop);

  ctx.save(); // clip keys/labels to the grid area so partial edge lanes don't spill into the ruler
  ctx.beginPath(); ctx.rect(0, gridTop, PR_GUTTER, H - gridTop); ctx.clip();
  const topM = Math.ceil(prState.pitchTop);
  const botM = Math.floor(prState.pitchTop - PR_ROWS) - 1;

  ctx.textAlign = 'right';
  for (let M = topM; M >= botM; M--) {
    if (isBlackKey(M)) continue;
    const y = prMidiToY(M, m);
    ctx.strokeStyle = 'rgba(0,0,0,0.13)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, y + rowH); ctx.lineTo(PR_GUTTER, y + rowH); ctx.stroke();
    const isC = M % 12 === 0;
    ctx.fillStyle = isC ? '#232327' : '#70707a';
    ctx.fillText(midiName(M), PR_GUTTER - 5, y + rowH / 2 + 0.5);
  }

  const bw = PR_GUTTER * 0.62; // black keys reach ~62% across the gutter
  for (let M = topM; M >= botM; M--) {
    if (!isBlackKey(M)) continue;
    const y = prMidiToY(M, m);
    ctx.fillStyle = '#242429';
    prRoundRect(ctx, -3, y + 1, bw + 3, rowH - 2, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'right';
    ctx.fillText(midiName(M), bw - 4, y + rowH / 2 + 0.5);
  }
  ctx.restore();

  ctx.strokeStyle = col('--border-strong');
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PR_GUTTER + 0.5, 0); ctx.lineTo(PR_GUTTER + 0.5, H); ctx.stroke();
}

// The loop ruler across the top: bar ticks, the loop region [0,len] highlighted, and a grab handle
// at the loop end. Returns the loop-end x so the interaction code can hit-test the handle.
function drawLoopBar(ctx, col, m) {
  const accent = col('--accent');
  ctx.fillStyle = col('--bg-panel');
  ctx.fillRect(0, 0, m.W, PR_TOPBAR);

  const loopEndX = Math.min(m.W, Math.max(PR_GUTTER, prCellToX(prState.len, m)));
  const loopStartX = Math.max(PR_GUTTER, prCellToX(0, m));
  ctx.fillStyle = col('--accent-soft');
  ctx.fillRect(loopStartX, 0, Math.max(0, loopEndX - loopStartX), PR_TOPBAR);

  // bar ticks + numbers (a bar = `grid` cells = one cycle)
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = col('--text-dim');
  for (let c = 0; c <= m.cols; c += prState.grid) {
    const x = prCellToX(c, m);
    if (x < PR_GUTTER - 0.5 || x > m.W + 0.5) continue;
    ctx.strokeStyle = col('--border-strong');
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, PR_TOPBAR); ctx.stroke();
    ctx.fillText(String(c / prState.grid + 1), x + 3, PR_TOPBAR / 2);
  }

  // grab handle at the loop end
  if (loopEndX <= m.W) {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(loopEndX, 0); ctx.lineTo(loopEndX, PR_TOPBAR); ctx.lineTo(loopEndX - 6, PR_TOPBAR / 2);
    ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = col('--border');
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PR_GUTTER, PR_TOPBAR + 0.5); ctx.lineTo(m.W, PR_TOPBAR + 0.5); ctx.stroke();
  return loopEndX;
}

function drawPianoroll() {
  if (!prState || !pianorollMod) return;
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const ctx = prCanvas.getContext('2d');
  ctx.setTransform(prCanvas._dpr || 1, 0, 0, prCanvas._dpr || 1, 0, 0);
  const m = prMetrics();
  const { W, H, gridTop, gridH, rowH } = m;
  ctx.clearRect(0, 0, W, H);

  // grid background + per-note lanes. Iterating integer notes (not fixed rows) lets a fractional
  // pitchTop scroll smoothly - each lane sits at its own y, partial lanes clipped at the edges.
  ctx.fillStyle = col('--bg');
  ctx.fillRect(PR_GUTTER, gridTop, W - PR_GUTTER, gridH);
  const topM = Math.ceil(prState.pitchTop);
  const botM = Math.floor(prState.pitchTop - PR_ROWS) - 1;
  for (let M = topM; M >= botM; M--) {
    const y = prMidiToY(M, m);
    if (isBlackKey(M)) {
      const y0 = Math.max(gridTop, y), y1 = Math.min(H, y + rowH);
      if (y1 > y0) { ctx.fillStyle = col('--hover-bg'); ctx.fillRect(PR_GUTTER, y0, W - PR_GUTTER, y1 - y0); }
    }
    if (y >= gridTop - 0.5 && y <= H + 0.5) {
      ctx.strokeStyle = col('--border');
      ctx.lineWidth = M % 12 === 0 ? 1.2 : 0.5; // heavier at each C (octave boundary)
      ctx.beginPath(); ctx.moveTo(PR_GUTTER, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }
  // vertical lines (visible span only): heaviest at each bar (a cycle = grid cells), medium at beats
  const beat = prState.grid % 4 === 0 ? prState.grid / 4 : prState.grid;
  const c0 = Math.max(0, Math.floor(m.scroll));
  const c1 = Math.min(m.cols, Math.ceil(m.scroll + m.visibleCells));
  for (let c = c0; c <= c1; c++) {
    const x = prCellToX(c, m);
    if (x < PR_GUTTER - 0.5 || x > W + 0.5) continue;
    ctx.strokeStyle = c % prState.grid === 0 ? col('--border-strong') : col('--border');
    ctx.lineWidth = c % prState.grid === 0 ? 1.4 : c % beat === 0 ? 1.1 : 0.5;
    ctx.beginPath(); ctx.moveTo(x, gridTop); ctx.lineTo(x, H); ctx.stroke();
  }
  // dim the region past the loop end (cells >= len are outside the loop)
  const dimX = prCellToX(prState.len, m);
  if (dimX < W) {
    ctx.fillStyle = 'rgba(120,120,130,0.22)';
    ctx.fillRect(Math.max(PR_GUTTER, dimX), gridTop, W - Math.max(PR_GUTTER, dimX), gridH);
  }

  // notes: fill opacity encodes velocity; a dashed outline marks a sub-unity probability; selected
  // notes get a bright solid outline. Rectangles are clipped to the grid when scrolled.
  const accent = col('--accent');
  const selCol = col('--text');
  for (const nt of prState.notes) {
    if (nt.midi > prState.pitchTop + 1 || nt.midi < m.bottomMidi) continue; // +1: keep a partial top lane
    const x = prCellToX(nt.start, m);
    const x2 = prCellToX(nt.start + nt.len, m);
    if (x2 <= PR_GUTTER || x >= W) continue;
    const dx = Math.max(PR_GUTTER + 0.5, x);
    const dx2 = Math.min(W, x2);
    const y = prMidiToY(nt.midi, m);
    const w = Math.max(2, dx2 - dx - 1);
    const selected = prState.sel.has(nt);
    ctx.globalAlpha = 0.4 + 0.6 * nt.vel;
    ctx.fillStyle = accent;
    prRoundRect(ctx, dx + 1, y + 1.5, w, rowH - 3, 3); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? selCol : accent;
    ctx.setLineDash(nt.prob < 1 && !selected ? [3, 2] : []);
    prRoundRect(ctx, dx + 1, y + 1.5, w, rowH - 3, 3); ctx.stroke();
    ctx.setLineDash([]);
  }

  // marquee rubber-band (select tool)
  if (prState.marquee) {
    const r = prState.marquee;
    ctx.fillStyle = col('--accent-soft');
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
  }

  // playhead: sweeps the loop (position = absolute cell mod len) while the transport runs
  prPlayheadOn = false;
  if (!transport.paused) {
    const abs = currentCyclePos() * prState.grid;
    const x = prCellToX(((abs % prState.len) + prState.len) % prState.len, m);
    if (x >= PR_GUTTER && x <= W) {
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(x, gridTop); ctx.lineTo(x, H); ctx.stroke();
      ctx.globalAlpha = 1;
      prPlayheadOn = true;
    }
  }

  drawLoopBar(ctx, col, m);
  drawPianoKeys(ctx, col, m); // last, so it overlays the grid's left edge cleanly
}

// Keep the moved selection within the visible pitch window.
function prScrollTo(notes) {
  if (!notes.length) return;
  const hi = Math.max(...notes.map((n) => n.midi));
  const lo = Math.min(...notes.map((n) => n.midi));
  if (hi > prState.pitchTop) prState.pitchTop = Math.min(127, hi);
  else if (lo < prState.pitchTop - PR_ROWS + 1) prState.pitchTop = Math.max(PR_ROWS - 1, lo + PR_ROWS - 1);
}

// Which cursor the pointer should show at (px,py), given whether a velocity/prob modifier is held.
function prCursorFor(px, py, m, velMod) {
  if (py < PR_TOPBAR) return px >= PR_GUTTER ? 'ew-resize' : 'default'; // loop ruler (drag its end)
  if (px < PR_GUTTER) return 'pointer'; // over the piano keyboard
  const cell = prCellAt(px, m);
  const emptyCursor = prTool === 'draw' ? CUR_PENCIL : 'crosshair'; // pencil draws, arrow marquees
  if (cell == null) return emptyCursor;
  const hit = prNoteAt(cell, prMidiAt(py, m));
  if (hit == null) return emptyCursor;
  const nt = prState.notes[hit];
  if (velMod) return CUR_UPDOWN; // cmd/ctrl over a note = velocity/probability drag
  if (px >= prCellToX(nt.start + nt.len, m) - PR_EDGE_PX) return CUR_BRACKET; // right-edge = length
  return 'move';
}

// Duplicate the selection one block-length to the right (Ableton's cmd-D), selecting the copies.
function prDuplicate() {
  if (!prState.sel.size) return;
  const sel = [...prState.sel];
  const shift = Math.max(1, Math.max(...sel.map((n) => n.start + n.len)) - Math.min(...sel.map((n) => n.start)));
  const copies = sel.map((n) => ({ ...n, start: Math.min(prState.len - 1, n.start + shift) }));
  prState.notes.push(...copies);
  prState.sel = new Set(copies);
  writePianorollCall();
  drawPianoroll();
}

// Horizontal zoom that keeps the cell currently under `anchorPx` pinned to that same screen x, so
// it zooms toward the pointer; anchorPx defaults to the view's center. (scrollCells is clamped in
// prMetrics, so the pin gives way gracefully at the edges.)
function prZoomBy(factor, anchorPx) {
  const m = prMetrics();
  const px = anchorPx ?? PR_GUTTER + m.gridW / 2;
  const cell = prCellFloat(px, m); // the cell under the pointer before zooming
  prState.zoom = Math.min(PR_MAX_ZOOM, Math.max(1, prState.zoom * factor));
  const m2 = prMetrics();
  prState.scrollCells = cell - (px - PR_GUTTER) / m2.cellW; // put that cell back under the pointer
  drawPianoroll();
}

function initPianorollCanvas() {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  prCanvas._dpr = dpr;
  prCanvas.width = PR_W * dpr;
  prCanvas.height = PR_CH * dpr;
  prCanvas.style.width = PR_W + 'px';
  prCanvas.style.height = PR_CH + 'px';
  prCanvas.tabIndex = 0; // focusable, so arrow keys / delete / ctrl-a reach it

  let drag = null; // { kind: 'create'|'move'|'resize'|'vel'|'marquee'|'loop'|'audition', ... }
  const snapshotPos = () => [...prState.sel].map((n) => ({ n, start: n.start, midi: n.midi }));
  const snapshotLen = () => [...prState.sel].map((n) => ({ n, len: n.len }));
  const setCursor = (c) => { if (prCanvas.style.cursor !== c) prCanvas.style.cursor = c; };
  const dragCursor = (d) =>
    ({ vel: CUR_UPDOWN, resize: CUR_BRACKET, move: 'grabbing', create: CUR_PENCIL, marquee: 'crosshair', loop: 'ew-resize', audition: 'pointer' }[d.kind] ?? 'default');

  prCanvas.addEventListener('contextmenu', (e) => { if (prState) e.preventDefault(); }); // ctrl-drag (mac) = velocity, not a menu

  prCanvas.addEventListener('pointerdown', (e) => {
    if (!prState) return;
    prCanvas.focus();
    prCanvas.setPointerCapture(e.pointerId);
    const m = prMetrics();
    const { px, py } = prCanvasPos(e);
    prPointer = { px, py };
    if (py < PR_TOPBAR) { // loop ruler - drag to set the loop length (written on pointerup)
      if (px >= PR_GUTTER) { drag = { kind: 'loop' }; prState._dragCols = m.cols; prState.len = Math.max(1, Math.round(prCellFloat(px, m))); prLenInput.value = prState.len; drawPianoroll(); }
      return;
    }
    const midi = prMidiAt(py, m);
    const cell = prCellAt(px, m);
    if (cell == null) {
      // clicked the piano keyboard - audition that key, don't edit
      if (px < PR_GUTTER && midi <= prState.pitchTop && midi >= m.bottomMidi) { drag = { kind: 'audition' }; prPreview(midi); }
      return;
    }
    const hit = prNoteAt(cell, midi);
    const velMod = e.metaKey || e.ctrlKey; // cmd (mac) / ctrl - velocity or probability drag
    if (hit != null) {
      const nt = prState.notes[hit];
      if (e.shiftKey && !velMod) { // shift-click toggles this note in/out of the selection
        if (prState.sel.has(nt)) prState.sel.delete(nt); else prState.sel.add(nt);
        drawPianoroll();
        return;
      }
      if (!prState.sel.has(nt)) prState.sel = new Set([nt]); // clicking an unselected note selects just it
      if (velMod) {
        drag = { kind: 'vel' };
      } else if (px >= prCellToX(nt.start + nt.len, m) - PR_EDGE_PX) {
        drag = { kind: 'resize', grabCell: cell, orig: snapshotLen() };
      } else {
        drag = { kind: 'move', grabCell: cell, grabMidi: midi, orig: snapshotPos() };
        prPreview(nt.midi);
      }
    } else if (prTool === 'select') {
      // rubber-band select (shift keeps the existing selection as a base)
      drag = { kind: 'marquee', x0: px, y0: py, base: e.shiftKey ? new Set(prState.sel) : new Set() };
      prState.marquee = { x: px, y: py, w: 0, h: 0 };
    } else if (cell < prState.len) { // draw a note (only inside the loop)
      if (!e.shiftKey) prState.sel = new Set();
      const nt = { midi, start: cell, len: 1, vel: PR_DEFAULT_VEL, prob: 1 };
      prState.notes.push(nt);
      prState.sel.add(nt);
      drag = { kind: 'create', note: nt };
      prPreview(midi);
    } else {
      prState.sel = new Set(); // click in the dimmed area past the loop end - just clear selection
    }
    drawPianoroll();
  });

  prCanvas.addEventListener('pointermove', (e) => {
    if (!prState) return;
    const m = prMetrics();
    const { px, py } = prCanvasPos(e);
    prPointer = { px, py };
    if (!drag) { setCursor(prCursorFor(px, py, m, e.metaKey || e.ctrlKey)); return; }
    if (drag.kind === 'loop') {
      prState.len = Math.max(1, Math.round(prCellFloat(px, m)));
      prLenInput.value = prState.len;
    } else if (drag.kind === 'create') {
      drag.note.len = Math.max(1, prClampCell(px, m) - drag.note.start + 1);
    } else if (drag.kind === 'resize') {
      const d = prClampCell(px, m) - drag.grabCell;
      for (const o of drag.orig) o.n.len = Math.max(1, o.len + d);
    } else if (drag.kind === 'move') {
      const cell = prCellAt(px, m);
      if (cell == null) return;
      const dCell = cell - drag.grabCell;
      const dMidi = prMidiAt(py, m) - drag.grabMidi;
      for (const o of drag.orig) {
        o.n.start = Math.min(prState.len - 1, Math.max(0, o.start + dCell));
        o.n.midi = Math.min(127, Math.max(0, o.midi + dMidi));
      }
      if (drag.orig[0]) prPreview(drag.orig[0].n.midi);
    } else if (drag.kind === 'vel') {
      const d = (e.movementY ?? 0) * 0.01;
      for (const n of prState.sel) {
        if (prCmdMode === 'prob') n.prob = Math.min(1, Math.max(0, n.prob - d));
        else n.vel = Math.min(1, Math.max(0, n.vel - d));
      }
    } else if (drag.kind === 'marquee') {
      const xa = Math.min(Math.max(px, PR_GUTTER), PR_W), xb = Math.min(Math.max(drag.x0, PR_GUTTER), PR_W);
      const ya = Math.min(Math.max(py, PR_TOPBAR), PR_CH), yb = Math.min(Math.max(drag.y0, PR_TOPBAR), PR_CH);
      const rx = Math.min(xa, xb), rw = Math.abs(xa - xb), ry = Math.min(ya, yb), rh = Math.abs(ya - yb);
      prState.marquee = { x: rx, y: ry, w: rw, h: rh };
      const c0 = prCellFloat(rx, m), c1 = prCellFloat(rx + rw, m);
      const midiHi = prMidiAt(ry, m), midiLo = prMidiAt(ry + rh, m);
      const inRect = (n) => n.midi >= midiLo && n.midi <= midiHi && n.start < c1 && n.start + n.len > c0;
      prState.sel = new Set([...drag.base, ...prState.notes.filter(inRect)]);
    }
    setCursor(dragCursor(drag));
    drawPianoroll();
  });

  prCanvas.addEventListener('pointerup', (e) => {
    if (drag && prState) {
      if (drag.kind === 'marquee') prState.marquee = null;
      else if (drag.kind !== 'audition') writePianorollCall();
      prState._dragCols = null; // unfreeze the loop-drag column width
    }
    prPreviewOff();
    drag = null;
    try { prCanvas.releasePointerCapture(e.pointerId); } catch {}
    drawPianoroll();
  });

  prCanvas.addEventListener('dblclick', (e) => {
    if (!prState) return;
    const m = prMetrics();
    const { px, py } = prCanvasPos(e);
    const cell = prCellAt(px, m);
    if (cell == null) return;
    const hit = prNoteAt(cell, prMidiAt(py, m));
    if (hit != null) { // double-click a note erases it
      prState.sel.delete(prState.notes[hit]);
      prState.notes.splice(hit, 1);
      writePianorollCall();
      drawPianoroll();
    } else if (prTool === 'select' && cell < prState.len) { // double-click empty in the arrow tool draws a note
      const nt = { midi: prMidiAt(py, m), start: cell, len: 1, vel: PR_DEFAULT_VEL, prob: 1 };
      prState.notes.push(nt);
      prState.sel = new Set([nt]);
      writePianorollCall();
      drawPianoroll();
    }
  });

  prCanvas.addEventListener('wheel', (e) => {
    if (!prState) return;
    e.preventDefault();
    const m = prMetrics();
    const { px } = prCanvasPos(e);
    if (e.ctrlKey || e.metaKey) {
      prZoomBy(Math.exp(-e.deltaY * PR_ZOOM_WHEEL), px); // proportional, pinned to the pointer
      return;
    }
    // Horizontal component (a trackpad left/right swipe or a horizontal wheel), or shift+wheel,
    // pans time - the way to get around once zoomed in. The vertical component scrolls pitch.
    const panCells = e.deltaX + (e.shiftKey ? e.deltaY : 0);
    let changed = false;
    if (panCells) {
      prState.scrollCells += (panCells / 120) * Math.max(1, m.visibleCells * 0.2);
      changed = true;
    }
    if (e.deltaY && !e.shiftKey) {
      // pitch scrolls continuously (pitchTop is fractional), so it glides instead of stepping rows
      prState.pitchTop = Math.min(127, Math.max(PR_ROWS - 1, prState.pitchTop - e.deltaY * PR_PITCH_WHEEL));
      changed = true;
    }
    if (changed) drawPianoroll();
  }, { passive: false });

  prCanvas.addEventListener('keydown', (e) => {
    if (!prState) return;
    const sel = [...prState.sel];
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      prState.sel = new Set(prState.notes);
      drawPianoroll();
    } else if (mod && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      prDuplicate();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!sel.length) return;
      e.preventDefault();
      prState.notes = prState.notes.filter((n) => !prState.sel.has(n));
      prState.sel.clear();
      writePianorollCall();
      drawPianoroll();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (prState.sel.size) { prState.sel.clear(); drawPianoroll(); } else closePianorollEditor();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!sel.length) return;
      e.preventDefault();
      const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      for (const n of sel) n.midi = Math.min(127, Math.max(0, n.midi + step));
      prScrollTo(sel);
      prPreview(Math.max(...sel.map((n) => n.midi)));
      writePianorollCall();
      drawPianoroll();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!sel.length) return;
      e.preventDefault();
      const step = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 4 : 1);
      for (const n of sel) n.start = Math.min(prState.len - 1, Math.max(0, n.start + step));
      writePianorollCall();
      drawPianoroll();
    }
  });
  // keep the cursor in sync when the cmd/ctrl modifier is pressed/released over a note
  // Re-derive the cursor for wherever the pointer already is - the tool or the cmd modifier can
  // change what it should be without the mouse moving at all. The default → real two-step (with a
  // reflow between) forces the change to actually land: browsers hide the pointer while you type,
  // and only a genuine cursor change brings it back before the next mouse move.
  prRefreshCursor = (velMod = false) => {
    if (!prState || prPointer.px < 0 || drag) return;
    const next = prCursorFor(prPointer.px, prPointer.py, prMetrics(), velMod);
    prCanvas.style.cursor = 'default';
    void prCanvas.offsetHeight;
    prCanvas.style.cursor = next;
  };
  const refreshCursor = (e) => prRefreshCursor(e.metaKey || e.ctrlKey);
  prCanvas.addEventListener('keyup', (e) => { prPreviewOff(); refreshCursor(e); });
  prCanvas.addEventListener('keydown', refreshCursor);
  prCanvas.addEventListener('blur', prPreviewOff);
  prCanvas.addEventListener('pointerleave', () => { prPointer = { px: -1, py: -1 }; });
}

function initPianorollEditor() {
  cm.on('cursorActivity', () => {
    if (prSuppressCursor || !pianorollMod) return;
    const call = findPianorollCallAt(cm.getValue(), cm.indexFromPos(cm.getCursor()));
    if (!call) {
      if (prState) closePianorollEditor();
      return;
    }
    if (prState && call.start === prState.callStart) return; // already editing this call (args included)
    // Inside some other call's arguments - that's plain editing, not a request for the roll.
    if (!call.onName) {
      if (prState) closePianorollEditor();
      return;
    }
    // No "don't reopen what I dismissed" guard here (unlike the lfo editor): the name is now an
    // explicit handle, so landing on it is always a request to open, and merely leaving the cursor
    // in the arguments after a ✕ can't reopen anything.
    openPianorollEditor(call);
  });

  // Clicking the name opens the roll even when the cursor is *already* there: re-clicking the same
  // spot leaves the selection unchanged, and an unchanged selection fires no cursorActivity - which
  // is what made reopening after ✕ feel stuck (click elsewhere, then back, to wake it up).
  cm.on('mousedown', (_cm, e) => {
    if (!pianorollMod) return;
    const call = findPianorollCallAt(cm.getValue(), cm.indexFromPos(cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window')));
    if (!call?.onName) return;
    if (!prState || call.start !== prState.callStart) openPianorollEditor(call);
    // Clicking the name is a deliberate "I want the roll now", so give it the keyboard: cmd-A, the
    // arrow keys and delete belong to the notes, not the code buffer. On mouseup, because
    // CodeMirror focuses its own input while handling this mousedown - and only for a plain click,
    // so dragging out from the name to select code still leaves the selection where it belongs.
    window.addEventListener('mouseup', () => {
      if (prState && !cm.somethingSelected()) prCanvas.focus({ preventScroll: true });
    }, { once: true });
  });

  cm.on('change', syncPianorollFromCode); // hand edits to the open call flow back into the panel

  // grid (granularity) and len (loop length in cells) are independent - changing the grid just
  // reinterprets each cell as a coarser/finer note; it doesn't move notes or resize the loop.
  prGridSelect.addEventListener('change', () => {
    if (!prState) return;
    prState.grid = Math.max(1, Math.round(Number(prGridSelect.value) || 16));
    writePianorollCall();
    drawPianoroll();
  });
  prLenInput.addEventListener('change', () => {
    if (!prState) return;
    prState.len = Math.max(1, Math.round(Number(prLenInput.value) || prState.grid));
    prLenInput.value = prState.len;
    writePianorollCall();
    drawPianoroll();
  });

  const reflectTool = () => { prToolBtn.textContent = prTool === 'draw' ? '✏️' : '⬚'; prToolBtn.title = `tool: ${prTool} — click or press B to switch (draw = pencil, select = marquee)`; };
  const toggleTool = () => {
    prTool = prTool === 'draw' ? 'select' : 'draw';
    localStorage.setItem('poptartPianorollTool', prTool);
    reflectTool();
    prRefreshCursor(); // pencil ⇄ crosshair right away, without waiting for the pointer to move
  };
  reflectTool();
  prToolBtn.addEventListener('click', toggleTool);

  const reflectCmdMode = () => { prCmdModeBtn.textContent = prCmdMode; prCmdModeBtn.title = `cmd-drag sets ${prCmdMode === 'vel' ? 'velocity' : 'probability'} — click to switch`; };
  reflectCmdMode();
  prCmdModeBtn.addEventListener('click', () => {
    prCmdMode = prCmdMode === 'vel' ? 'prob' : 'vel';
    localStorage.setItem('poptartPianorollCmd', prCmdMode);
    reflectCmdMode();
  });

  prZoomOutBtn.addEventListener('click', () => prState && prZoomBy(1 / PR_BTN_ZOOM));
  prZoomInBtn.addEventListener('click', () => prState && prZoomBy(PR_BTN_ZOOM));

  const reflectPreview = () => prPreviewBtn.classList.toggle('active', prPreviewEnabled);
  reflectPreview();
  prPreviewBtn.addEventListener('click', () => {
    prPreviewEnabled = !prPreviewEnabled;
    localStorage.setItem('poptartPianorollPreview', prPreviewEnabled ? '1' : '0');
    if (!prPreviewEnabled) prPreviewOff();
    reflectPreview();
  });

  prToMiniBtn.addEventListener('click', () => {
    if (!prState) return;
    const range = prState.marker.find();
    if (!range) return;
    const indent = (cm.getLine(range.from.line).match(/^\s*/)?.[0]) ?? ''; // align continuation lines
    const expr = pianorollMod.pianoRollToMini(prState.notes, { grid: prState.grid, len: prState.len, indent });
    prSuppressCursor = true;
    cm.replaceRange(expr, range.from, range.to);
    closePianorollEditor(); // the pianoroll() call is gone now
    prSuppressCursor = false;
    prScheduleEval(); // the rewrite plays the same notes - keep the running track in step with it
    logLine('piano roll → mini-notation');
  });

  prCloseBtn.addEventListener('click', () => closePianorollEditor());

  // Panel-wide keys while it's open: Escape (when the code has focus - the canvas handles its own),
  // B toggles the tool, and cmd/ctrl +/- zoom the roll (overriding the browser's page zoom).
  //
  // Capture phase, and the code editor deliberately doesn't count as "typing": while the roll is
  // open B belongs to the roll, wherever focus happens to be. Otherwise B typed with focus still in
  // the editor (where it lands after clicking the pianoroll name) went into the buffer instead, and
  // the resulting edit moved the cursor off the name and closed the panel. Only real form fields -
  // the panel's own grid/len inputs - still swallow it.
  const typingInField = () => {
    const el = document.activeElement;
    if (!el || cm.getWrapperElement().contains(el)) return false;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
  };
  document.addEventListener('keydown', (e) => {
    if (!prState) return;
    if (e.key === 'Escape' && document.activeElement !== prCanvas) { closePianorollEditor(); return; }
    if ((e.key === 'b' || e.key === 'B') && !typingInField() && !(e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      e.stopPropagation(); // don't let it reach the code editor as a keystroke
      toggleTool();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_')) {
      e.preventDefault();
      prZoomBy(e.key === '-' || e.key === '_' ? 1 / PR_BTN_ZOOM : PR_BTN_ZOOM);
    }
  }, true);

  initPianorollCanvas();
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
// Playback highlighting is driven by the step grid the SERVER computes from each active track's
// real evaluated Sig (see server.js highlightGrid) - the exact grid the scheduler plays, so every
// transform in the method chain (.fast/.slow/.when/degrade/…) is reflected without the browser
// re-guessing from source text. Each region: an anchor marker at the track's block (highlights are
// placed relative to it, so they survive edits until re-eval), the grid indexed by cycle, and the
// longest ring so lookback catches a stretched/held note still sounding from an earlier cycle.
let patternRegions = []; // { label, anchor, grid: Map<cycle, steps>, maxEnd, lastKey, marks: [] }
let gridFrom = 0; // first cycle covered by every region's grid
let gridTo = 0; // one past the last covered cycle (extended by /api/highlight top-ups)
let gridCount = 32; // window size the server ships (mirrored from the eval response)
let gridFetching = false; // a top-up request is in flight - don't stack another

function clearPatternRegions() {
  for (const r of patternRegions) {
    r.anchor.clear();
    for (const mk of r.marks) mk.clear();
  }
  patternRegions = [];
}

// Builds the per-track highlight regions from an /api/evaluate response: each active track carries
// its grid (sounding steps per cycle, atom spans block-relative) plus its block [start,end], which
// we anchor a marker to so highlights track edits until the next eval. No source-text parsing - the
// server already did the real evaluation.
function setupHighlighting(tracks, from, count) {
  clearPatternRegions();
  gridFrom = from;
  gridTo = from + count;
  gridCount = count;
  gridFetching = false;
  for (const t of tracks) {
    if (!t.active || !t.grid) continue;
    const anchor = cm.markText(cm.posFromIndex(t.start), cm.posFromIndex(t.end), {});
    const region = { label: t.label, anchor, grid: new Map(), maxEnd: 1, lastKey: '', marks: [] };
    ingestGrid(region, t.grid);
    patternRegions.push(region);
  }
}

// Folds a grid window ([{ cycle, steps }]) into a region, tracking the longest step end so the
// look-back in highlightTick reaches a note still ringing from an earlier cycle (clip/tie/echo).
function ingestGrid(region, grid) {
  for (const g of grid) {
    region.grid.set(g.cycle, g.steps);
    for (const s of g.steps) if (s.end > region.maxEnd) region.maxEnd = s.end;
  }
}

// Request the next grid window as the clock nears the end of what we hold - patterns that vary per
// cycle (<…>, r/i, degrade, choice) outrun the initial window. Coarse: one request per window, not
// per frame. Deterministic on the server, so the extension lines up seamlessly.
const GRID_PREFETCH = 8; // cycles of headroom before the covered end that triggers a top-up
function maybePrefetchGrid(cycle) {
  if (gridFetching || patternRegions.length === 0) return;
  if (cycle < gridTo - GRID_PREFETCH) return;
  gridFetching = true;
  const from = gridTo;
  api('GET', `/api/highlight?from=${from}&count=${gridCount}`)
    .then((res) => {
      const byLabel = new Map(res.tracks.map((t) => [t.label, t.grid]));
      // Drop cycles well behind the play head so a set-and-forget pattern doesn't grow the grid
      // forever; kept margin (2 windows) stays clear of the bounded look-back for ringing tails.
      const pruneBefore = res.gridFrom - gridCount * 2;
      for (const r of patternRegions) {
        const grid = byLabel.get(r.label);
        if (grid) ingestGrid(r, grid);
        for (const c of r.grid.keys()) if (c < pruneBefore) r.grid.delete(c);
      }
      gridFrom = Math.max(gridFrom, pruneBefore);
      gridTo = Math.max(gridTo, res.gridFrom + res.gridCount);
    })
    .catch(() => {})
    .finally(() => {
      gridFetching = false;
    });
}

// The transport mirror as a cycle position "now" - the same rebased formula the server uses.
// A paused transport is frozen at baseCycle (0 after a stop / at page load).
function currentCyclePos() {
  if (transport.paused) return transport.baseCycle;
  return transport.baseCycle + (Date.now() / 1000 - transport.baseSec) * transport.cps;
}

function highlightTick() {
  if (!playing || patternRegions.length === 0) return;
  const cyclePos = currentCyclePos();
  const cycle = Math.floor(cyclePos);
  maybePrefetchGrid(cycle);

  for (const r of patternRegions) {
    const range = r.anchor.find();
    if (!range) continue; // the block was deleted from the buffer

    // A step (start/end are cycle fractions) sounds at cyclePos when it falls in [cyc+start,
    // cyc+end). `end` may exceed 1 - a clip-stretched, held, or echoed note rings past its own
    // cycle - so look back far enough (bounded by the region's longest ring) to keep a tail from
    // an earlier cycle lit. Locations recur (chords, revisited alt picks), so dedupe by span.
    const locs = new Map();
    const lookback = Math.min(64, Math.ceil(r.maxEnd));
    for (let k = 0; k <= lookback; k++) {
      const cyc = cycle - k;
      if (cyc < gridFrom) break; // nothing loaded before the window start
      const steps = r.grid.get(cyc);
      if (!steps) continue;
      for (const s of steps) {
        if (cyclePos >= cyc + s.start && cyclePos < cyc + s.end) {
          for (const l of s.locs) locs.set(l[0] + '-' + l[1], l);
        }
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
    const spec = r.noteless ? 'vel:clip' : 'note:vel:clip'; // tap() records note-less
    const replacement = '`' + r.pattern + '`.as("' + spec + '")';
    if (replaceKbCall(r.label, replacement)) {
      applied++;
      logLine(`midi record: wrote ${r.count} ${r.noteless ? 'hit' : 'note'}(s) into "${r.label}"`);
    } else {
      logLine(
        `midi record (${r.label}): no midikeys/kb/keyboard/tap call found to replace - recorded pattern: ${r.pattern.replace(/\n\s*/g, ' ')}`,
        true,
      );
    }
  }
  if (applied) evaluate(true);
}

// Finds the live-keys call in the labeled block and swaps the whole call expression for the
// recorded pattern. Handles the MIDI routes - `midikeys("device")(ch)` directly, or `kb(ch)`
// through a `const kb = midikeys(...)` binding - and the computer-keyboard sources `keyboard()`
// and `tap()` (called directly, no channel). First candidate in the block wins.
function replaceKbCall(label, replacement) {
  if (!labelsMod) return false;
  const code = cm.getValue();
  const block = labelsMod.splitLabeledBlocks(code).find((b) => b.label === label);
  if (!block) return false;

  const spanFrom = (callStart, openParenIdx) => {
    const close = matchParen(code, openParenIdx);
    return close < 0 ? null : [callStart, close + 1];
  };
  const spans = [];

  // Computer-keyboard sources: `keyboard()` / `tap()` used directly (they return a signal, so no
  // trailing channel call like midikeys). Match the whole `keyboard(...)` / `tap(...)` call.
  const kbCall = /(?<![.\w$])(?:keyboard|tap)\s*\(/g;
  let km;
  while ((km = kbCall.exec(code))) {
    if (km.index < block.start || km.index >= block.end) continue;
    const span = spanFrom(km.index, km.index + km[0].length - 1);
    if (span) spans.push(span);
  }

  const direct = /\bmidikeys\s*\(/g;
  let m;
  while ((m = direct.exec(code))) {
    if (m.index < block.start || m.index >= block.end) continue;
    const close1 = matchParen(code, m.index + m[0].length - 1);
    if (close1 < 0) continue;
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
    if (close < 0) return;
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
    if (t.keyboard) {
      const b = badge(`⌨ ${t.keyboard}`, 'badge-solo');
      b.title = kbMode === 'normal'
        ? 'live from the computer keyboard - set the ⌨ dropdown up top to midi or both to play'
        : `live from the computer keyboard (${kbMode} mode)`;
      head.appendChild(b);
    }
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
    setupHighlighting(result.tracks, result.gridFrom ?? 0, result.gridCount ?? 32);
    setKeyboardRoutes(result.keyboardTracks ?? []);
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
  kbForgetHeld(); // the server released our held keys; drop our local view so keyup won't re-off
}

// ---------------------------------------------------------------------------------------------
// Computer-keyboard instrument (keyboard() / tap() tracks). The note source is *here*, in the
// browser (the engine can't read the typing keyboard like a MIDI device), so each eval tells us
// which tracks are keyboard targets and we POST every key edge to /api/keyNote - the server turns
// those into engine.noteOn/noteOff on the track. The #kbMode dropdown gates it: `off` types
// normally (no capture), `midi` plays notes and swallows the keystroke so it doesn't reach the
// editor, `both` does both at once. Held keys are tracked so switching mode, alt-tabbing, or a
// stop releases anything still down instead of leaving a note stuck on.
//
// Layout (à la Ableton/tracker typing keyboards): the home row a s d f g h j k l are the white
// keys and the row above (w e t y u o p) the black keys; z / x shift octave, c / v nudge
// velocity. A tap() track ignores pitch - any other key is a hit at the current velocity on a
// fixed note - so the whole keyboard is one velocity pad.
// ---------------------------------------------------------------------------------------------

const kbModeSelect = document.getElementById('kbMode');
const KB_SEMITONES = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15 };
const KB_BASE_NOTE = 48; // MIDI note the home-row `a` plays at octave shift 0 (C, this package's c5 = 60)
const KB_TAP_NOTE = 24; // fixed pitch a tap() key strikes (C2 - the engine's default note, so a
// live tap and its .as("vel:clip") recording play the same pitch); only velocity/timing matter
const KB_OCT_MIN = -3;
const KB_OCT_MAX = 4;
const KB_CONTROL_KEYS = new Set(['z', 'x', 'c', 'v']); // octave -/+, velocity -/+ (never notes)

let kbMode = localStorage.getItem('poptart-kb-mode') || 'normal';
let kbRoutes = []; // [{ trackId, kind, note }] from the latest eval (note: fixed tap pitch, or null)
let kbOctave = 0; // octave shift in whole octaves (z/x)
let kbVelocity = 0.8; // 0.1..1 (c/v)
const kbHeldKeys = new Map(); // key char -> [{ trackId, note }] currently sounding, for keyup/release

// Set the computer-keyboard instrument mode ('normal' | 'midi' | 'both'), keeping the dropdown,
// persisted state, and held-note bookkeeping in sync. Also invoked by the ctrl+b hotkey.
function setKbMode(mode) {
  kbMode = mode;
  kbModeSelect.value = mode;
  localStorage.setItem('poptart-kb-mode', mode);
  if (mode === 'normal') kbReleaseAll();
  logLine(`computer keyboard: ${mode}${mode !== 'normal' && kbRoutes.length === 0 ? ' (no keyboard()/tap() track yet)' : ''}`);
}

kbModeSelect.value = kbMode;
kbModeSelect.addEventListener('change', () => setKbMode(kbModeSelect.value));

// Called from evaluate() with the eval response's keyboardTracks. Drops held notes for any track
// that is no longer a keyboard target, and nudges the user if they've written keyboard()/tap()
// but left the mode off.
function setKeyboardRoutes(routes) {
  const nextIds = new Set(routes.map((r) => r.trackId));
  for (const [key, held] of [...kbHeldKeys]) {
    const kept = held.filter((h) => nextIds.has(h.trackId));
    if (kept.length !== held.length) {
      for (const h of held) if (!nextIds.has(h.trackId)) kbSend(h.trackId, h.note, false);
      if (kept.length) kbHeldKeys.set(key, kept);
      else kbHeldKeys.delete(key);
    }
  }
  const gained = routes.length > 0 && kbRoutes.length === 0;
  kbRoutes = routes;
  if (gained && kbMode === 'normal') {
    logLine('keyboard()/tap() track ready - pick "⌨ midi" (or "both") up top to play it from your keyboard');
  }
}

function kbSend(trackId, note, isOn) {
  api('POST', '/api/keyNote', { trackId, note, vel: kbVelocity, isOn }).catch(() => {});
}

// Release every currently-held key (send note-offs and forget them). Used on mode change, window
// blur, and losing all keyboard tracks.
function kbReleaseAll() {
  for (const held of kbHeldKeys.values()) for (const { trackId, note } of held) kbSend(trackId, note, false);
  kbHeldKeys.clear();
}

// Forget held keys WITHOUT sending note-offs - for when the server already released them (stop).
function kbForgetHeld() {
  kbHeldKeys.clear();
}

function kbAdjustOctave(delta) {
  const next = Math.max(KB_OCT_MIN, Math.min(KB_OCT_MAX, kbOctave + delta));
  if (next !== kbOctave) {
    kbOctave = next;
    logLine(`keyboard octave ${kbOctave >= 0 ? '+' : ''}${kbOctave}`);
  }
}

function kbAdjustVelocity(delta) {
  const next = Math.max(0.1, Math.min(1, Math.round((kbVelocity + delta) * 100) / 100));
  if (next !== kbVelocity) {
    kbVelocity = next;
    logLine(`keyboard velocity ${kbVelocity.toFixed(2)}`);
  }
}

// Should this keydown be intercepted at all? Not when a non-editor text field has focus (so the
// file-name box, param search, etc. type normally) - the CodeMirror editor itself is fair game.
function kbShouldCapture() {
  const el = document.activeElement;
  if (!el) return true;
  if (el.closest && el.closest('.CodeMirror')) return true;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return false;
  return true;
}

// A tap() track strikes on any single-character key that isn't a reserved control.
function kbIsTapKey(key) {
  return key.length === 1 && !KB_CONTROL_KEYS.has(key);
}

function onKbKeyDown(e) {
  if (kbMode === 'normal' || kbRoutes.length === 0) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // never swallow shortcuts (Cmd+Enter to eval, etc.)
  const key = e.key.toLowerCase();
  if (!kbShouldCapture()) return;

  // In midi mode we swallow every key we act on so it never reaches the editor; both mode lets
  // it through so it plays *and* types. Auto-repeat is dropped (a held key is one sustained note).
  const swallow = () => {
    if (kbMode === 'midi') {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (KB_CONTROL_KEYS.has(key)) {
    if (!e.repeat) {
      if (key === 'z') kbAdjustOctave(-1);
      else if (key === 'x') kbAdjustOctave(1);
      else if (key === 'c') kbAdjustVelocity(-0.1);
      else if (key === 'v') kbAdjustVelocity(0.1);
    }
    swallow();
    return;
  }

  if (e.repeat || kbHeldKeys.has(key)) {
    // Already sounding (OS auto-repeat) - keep swallowing in midi mode, but don't retrigger.
    let anyMapped = false;
    for (const r of kbRoutes) anyMapped = anyMapped || (r.kind === 'tap' ? kbIsTapKey(key) : key in KB_SEMITONES);
    if (anyMapped) swallow();
    return;
  }

  const struck = [];
  for (const r of kbRoutes) {
    let note;
    if (r.kind === 'tap') {
      if (!kbIsTapKey(key)) continue;
      // .note("f3")/.n(...).scale(...) on the track sets the struck pitch (route.note); with none
      // set, fall back to the default pad note.
      note = typeof r.note === 'number' ? r.note : KB_TAP_NOTE;
    } else {
      if (!(key in KB_SEMITONES)) continue;
      // A fixed pitch from .note("f3")/.n(...).scale(...) replaces the played note: every piano key
      // strikes that one note (keyboard().note("f3")). With none set, the key's own pitch plays.
      note = typeof r.note === 'number' ? r.note : KB_BASE_NOTE + kbOctave * 12 + KB_SEMITONES[key];
    }
    kbSend(r.trackId, note, true);
    struck.push({ trackId: r.trackId, note });
  }
  if (struck.length) {
    kbHeldKeys.set(key, struck);
    swallow();
  }
}

// Key-up always releases whatever that key started, regardless of the current mode/focus, so a
// note can never get stuck (mode may have changed while the key was down).
function onKbKeyUp(e) {
  const key = e.key.toLowerCase();
  const held = kbHeldKeys.get(key);
  if (!held) return;
  kbHeldKeys.delete(key);
  for (const { trackId, note } of held) kbSend(trackId, note, false);
  if (kbMode === 'midi') {
    e.preventDefault();
    e.stopPropagation();
  }
}

// Capture phase so we beat CodeMirror to the key and can suppress typing in midi mode.
document.addEventListener('keydown', onKbKeyDown, true);
document.addEventListener('keyup', onKbKeyUp, true);
window.addEventListener('blur', kbReleaseAll); // alt-tab away -> don't leave notes ringing

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
const fileNewBtn = document.getElementById('fileNewBtn');
const fileList = document.getElementById('fileList');
const consoleFooter = document.getElementById('console');
const consoleToggle = document.getElementById('consoleToggle');

// Switch the sidebar to a named tab (also invoked by the ctrl+p hotkey, see the hotkeys section).
function activateTab(name) {
  for (const b of document.querySelectorAll('.side-tab')) b.classList.toggle('active', b.dataset.tab === name);
  sessionTab.classList.toggle('hidden', name !== 'session');
  soundsTab.classList.toggle('hidden', name !== 'sounds');
  filesTab.classList.toggle('hidden', name !== 'files');
  settingsTab.classList.toggle('hidden', name !== 'settings');
  if (name === 'sounds') loadSamples();
  if (name === 'files') refreshPatternFiles();
  if (name === 'settings') { refreshAudioDevices(); refreshSamplesDir(); }
}

for (const btn of document.querySelectorAll('.side-tab')) {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
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

// Editor settings. The docs toggle governs both documentation tooltips - the panel beside the
// autocomplete popup and the ctrl-hover one (see the tooltips section above).
const docTooltipsToggle = document.getElementById('docTooltipsToggle');
docTooltipsToggle.checked = docTooltipsEnabled;
docTooltipsToggle.addEventListener('change', () => setDocTooltips(docTooltipsToggle.checked));

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
    const code = prebakeCM.getValue();
    const { errors } = await api('POST', '/api/prebake', { code });
    // The server ran it for DSL defs; run it in the browser too so any hotkey()/editor calls
    // in the same file take effect immediately (see runUserPrebake).
    runUserPrebake(code);
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

// Start a fresh buffer. Clears the editor and the name field (so the next save creates a new
// file rather than overwriting whatever was last loaded); guarded by a confirm when the current
// buffer has content, since that content isn't saved anywhere yet.
function newPatternFile() {
  if (cm.getValue().trim() && !confirm('start a new pattern? the current editor buffer will be cleared')) return;
  cm.setValue('');
  fileNameInput.value = '';
  logLine('new pattern - write it, then name it above and hit save to keep it');
  cm.focus();
}

fileSaveBtn.addEventListener('click', savePatternFile);
fileNewBtn.addEventListener('click', newPatternFile);
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
  return apply; // so callers (e.g. the ctrl+p hotkey) can drive the collapse programmatically
}

const setSidebarCollapsed = initCollapsible(sidebar, sidebarToggle, 'poptart-sidebar-collapsed', { open: '»', collapsed: '«' });
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
const SAVED_KEY = 'poptart-saved-themes';

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
const themeNameInput = document.getElementById('themeNameInput');
const themeSaveBtn = document.getElementById('themeSaveBtn');

function savedCustomTheme() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY)) ?? null;
  } catch {
    return null;
  }
}

// Named themes the user has saved: { name: { base: presetName, vars: { '--x': '#..' } } }.
function savedThemes() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeSavedThemes(map) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(map));
}

function rebuildThemeOptions() {
  themeSelect.innerHTML = '';
  for (const t of PRESET_THEMES) themeSelect.add(new Option(t, t));
  for (const name of Object.keys(savedThemes()).sort()) themeSelect.add(new Option(name, name));
  // The unsaved working draft sits last, flagged so it reads as ephemeral.
  if (savedCustomTheme()) themeSelect.add(new Option('custom (unsaved)', 'custom'));
}

function applyTheme(name) {
  const root = document.documentElement;
  // Clear any custom inline overrides first, then re-apply for draft or saved themes.
  for (const [v] of THEME_VARS) root.style.removeProperty(v);
  const saved = savedThemes();
  if (name === 'custom') {
    const custom = savedCustomTheme() ?? {};
    root.dataset.theme = localStorage.getItem(CUSTOM_BASE_KEY) ?? 'poptart';
    for (const [v, value] of Object.entries(custom)) root.style.setProperty(v, value);
  } else if (saved[name]) {
    root.dataset.theme = saved[name].base ?? 'poptart';
    for (const [v, value] of Object.entries(saved[name].vars ?? {})) root.style.setProperty(v, value);
  } else {
    root.dataset.theme = name;
  }
  localStorage.setItem('poptart-theme', name);
  themeSelect.value = name;
  updateThemeControls();
  if (!themePanel.classList.contains('hidden')) populateThemeInputs();
}

// The reset button doubles as discard (unsaved draft) / delete (saved theme); save is only
// meaningful when there's a draft to name.
function updateThemeControls() {
  const cur = themeSelect.value;
  const isDraft = cur === 'custom';
  const isSaved = !!savedThemes()[cur];
  themeSaveBtn.disabled = !isDraft;
  themeNameInput.disabled = !isDraft;
  if (isDraft) {
    themeResetBtn.hidden = false;
    themeResetBtn.textContent = 'discard';
    themeResetBtn.title = 'discard unsaved edits and go back to the base theme';
  } else if (isSaved) {
    themeResetBtn.hidden = false;
    themeResetBtn.textContent = 'delete';
    themeResetBtn.title = 'delete this saved theme';
  } else {
    themeResetBtn.hidden = true;
  }
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
  updateThemeControls();
}

// Promote the current colors into a named theme, then clear the working draft.
function saveTheme() {
  const name = themeNameInput.value.trim();
  if (!name) return;
  if (PRESET_THEMES.includes(name) || name === 'custom') {
    logLine(`"${name}" is a reserved name — pick another`, true);
    return;
  }
  const computed = getComputedStyle(document.documentElement);
  const vars = Object.fromEntries(THEME_VARS.map(([v]) => [v, cssColorToHex(computed.getPropertyValue(v))]));
  const base = document.documentElement.dataset.theme ?? 'poptart';
  const map = savedThemes();
  const existed = !!map[name];
  map[name] = { base, vars };
  writeSavedThemes(map);
  localStorage.removeItem(CUSTOM_KEY);
  localStorage.removeItem(CUSTOM_BASE_KEY);
  themeNameInput.value = '';
  rebuildThemeOptions();
  applyTheme(name);
  logLine(existed ? `updated theme "${name}"` : `saved theme "${name}"`);
}

themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
themeEditBtn.addEventListener('click', () => {
  themePanel.classList.toggle('hidden');
  if (!themePanel.classList.contains('hidden')) {
    populateThemeInputs();
    updateThemeControls();
  }
});
themeCloseBtn.addEventListener('click', () => themePanel.classList.add('hidden'));
themeSaveBtn.addEventListener('click', saveTheme);
themeNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveTheme(); }
});
themeResetBtn.addEventListener('click', () => {
  const cur = themeSelect.value;
  if (cur === 'custom') {
    // Discard the unsaved draft, returning to whichever theme it forked from.
    localStorage.removeItem(CUSTOM_KEY);
    const base = localStorage.getItem(CUSTOM_BASE_KEY) ?? 'poptart';
    localStorage.removeItem(CUSTOM_BASE_KEY);
    rebuildThemeOptions();
    applyTheme(PRESET_THEMES.includes(base) || savedThemes()[base] ? base : 'poptart');
  } else if (savedThemes()[cur]) {
    // Delete this saved theme, falling back to its base preset.
    const map = savedThemes();
    const base = map[cur].base ?? 'poptart';
    delete map[cur];
    writeSavedThemes(map);
    rebuildThemeOptions();
    applyTheme(PRESET_THEMES.includes(base) ? base : 'poptart');
    logLine(`deleted theme "${cur}"`);
  }
});

rebuildThemeOptions();
{
  const saved = localStorage.getItem('poptart-theme') ?? 'poptart';
  const valid = saved === 'custom'
    ? !!savedCustomTheme()
    : PRESET_THEMES.includes(saved) || !!savedThemes()[saved];
  themeSelect.value = valid ? saved : 'poptart';
  updateThemeControls();
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

// ---------------------------------------------------------------------------------------------
// Hotkeys - a small dispatcher plus a userland API. Built-in transport/UI chords are registered
// here; everything else is meant to live in the user's prebake, which the browser runs through
// runUserPrebake() (the same file the server runs for DSL defs - browser-only calls like
// hotkey()/editor no-op on the server, DSL builders no-op here). See the `hotkey`, `editor`, and
// the util helpers handed to that sandbox below.
//
// Matching is on event.code (physical key position), so a chord fires regardless of which
// character Shift/AltGr would produce - `cmd+shift+.` matches the `.` key even though the event's
// .key is `>`. Combos are strings like 'cmd+shift+0', 'ctrl+p', 'mod+enter' (mod = cmd on macOS,
// ctrl elsewhere). Modifiers: cmd/meta, ctrl, alt/option, shift, mod.
// ---------------------------------------------------------------------------------------------

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

const KEY_CODE_MAP = {
  '.': 'Period', ',': 'Comma', '/': 'Slash', ';': 'Semicolon', "'": 'Quote',
  '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote',
  enter: 'Enter', return: 'Enter', space: 'Space', tab: 'Tab', esc: 'Escape', escape: 'Escape',
  backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
};

// A combo token -> KeyboardEvent.code, or null if we should fall back to matching event.key.
function keyTokenToCode(tok) {
  if (/^[a-z]$/.test(tok)) return 'Key' + tok.toUpperCase();
  if (/^[0-9]$/.test(tok)) return 'Digit' + tok;
  return KEY_CODE_MAP[tok] ?? null;
}

function comboToSpec(combo) {
  const spec = { meta: false, ctrl: false, shift: false, alt: false, mod: false, code: null, key: null };
  for (const raw of String(combo).toLowerCase().split('+')) {
    const tok = raw.trim();
    if (!tok) continue;
    if (tok === 'cmd' || tok === 'meta' || tok === 'command' || tok === 'win' || tok === 'super') spec.meta = true;
    else if (tok === 'ctrl' || tok === 'control') spec.ctrl = true;
    else if (tok === 'shift') spec.shift = true;
    else if (tok === 'alt' || tok === 'option' || tok === 'opt') spec.alt = true;
    else if (tok === 'mod') spec.mod = true;
    else { spec.code = keyTokenToCode(tok); spec.key = tok; }
  }
  return spec;
}

function specMatches(spec, e) {
  const wantMeta = spec.meta || (spec.mod && IS_MAC);
  const wantCtrl = spec.ctrl || (spec.mod && !IS_MAC);
  if (e.metaKey !== wantMeta) return false;
  if (e.ctrlKey !== wantCtrl) return false;
  if (e.altKey !== spec.alt) return false;
  if (e.shiftKey !== spec.shift) return false;
  if (spec.code) return e.code === spec.code;
  return spec.key != null && e.key.toLowerCase() === spec.key;
}

const builtinHotkeys = []; // app chords - persist for the session
let userHotkeys = []; // registered from the prebake - cleared and rebuilt on every prebake run

function addHotkey(list, combo, handler, label) {
  list.push({ spec: comboToSpec(combo), handler, combo, label });
}

async function runHotkey(hk, e) {
  try {
    await hk.handler(e);
  } catch (err) {
    logLine(`hotkey ${hk.combo}: ${err.message ?? err}`, true);
  }
}

// A blocking modal (prebake editor, folder picker) is open - don't let chords reach through it.
function anyModalOpen() {
  return !prebakeBackdrop.classList.contains('hidden') || !dirPickerBackdrop.classList.contains('hidden');
}

window.addEventListener(
  'keydown',
  (e) => {
    if (e.repeat || anyModalOpen()) return;
    for (const hk of builtinHotkeys) {
      if (specMatches(hk.spec, e)) { e.preventDefault(); e.stopPropagation(); runHotkey(hk, e); return; }
    }
    for (const hk of userHotkeys) {
      if (specMatches(hk.spec, e)) { e.preventDefault(); e.stopPropagation(); runHotkey(hk, e); return; }
    }
  },
  true, // capture, so we beat CodeMirror and can suppress the keystroke
);

// --- built-in chords (Ctrl-based: free on macOS where Cmd owns the browser shortcuts) ---

// ctrl+p - minimize/restore the RHS panel, keeping whatever tab was open.
addHotkey(builtinHotkeys, 'ctrl+p', () => {
  setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
}, 'toggle sidebar');

// ctrl+r - arm/stop MIDI recording (mirrors the ● rec button).
addHotkey(builtinHotkeys, 'ctrl+r', () => (recState ? cancelMidiRecord(true) : startMidiRecord()), 'toggle record');

// ctrl+m - toggle the keyboard/tap instrument between off and midi.
addHotkey(builtinHotkeys, 'ctrl+m', () => setKbMode(kbMode === 'normal' ? 'midi' : 'normal'), 'toggle midi keyboard');

// ---------------------------------------------------------------------------------------------
// Userland API + sandbox. runUserPrebake() executes the prebake source in a function scope where
// the DSL builder names are chainable no-ops (so `const kick = s("bd*4")` doesn't throw here) and
// hotkey()/editor/util helpers are real. This is what lets a single prebake file carry both DSL
// setup (meaningful on the server) and hotkeys/UI code (meaningful in the browser).
// ---------------------------------------------------------------------------------------------

// A chainable no-op: any property access returns a function that returns the same stub, and
// calling it returns the stub too - so arbitrary builder/method chains evaluate without error.
function makeChainStub() {
  const stub = new Proxy(function () {}, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => '' : () => stub),
    apply: () => stub,
  });
  return stub;
}

// editor: a thin, offset-based facade over the main CodeMirror instance, close to Strudel's `repl`
// so ports read the same. Offsets are character indices into the whole document.
const editor = {
  get cm() { return cm; },
  get code() { return cm.getValue(); },
  getCode() { return cm.getValue(); },
  setCode(str) { cm.setValue(str); },
  appendCode(str) {
    const end = cm.posFromIndex(cm.getValue().length);
    cm.replaceRange(str, end);
  },
  insertCode(str, at) {
    const pos = at == null ? cm.getCursor() : cm.posFromIndex(at);
    cm.replaceRange(str, pos);
  },
  replaceCode(str, from, to) {
    cm.replaceRange(str, cm.posFromIndex(from), cm.posFromIndex(to));
  },
  sliceCode(from, to) {
    return cm.getRange(cm.posFromIndex(from), cm.posFromIndex(to));
  },
  getCursorLocation() { return cm.indexFromPos(cm.getCursor()); },
  setCursorLocation(at) { cm.setCursor(cm.posFromIndex(at)); cm.focus(); },
  // { from, to, text } as character offsets; from === to when nothing is selected.
  getSelection() {
    const from = cm.indexFromPos(cm.getCursor('from'));
    const to = cm.indexFromPos(cm.getCursor('to'));
    return { from, to, text: cm.getRange(cm.posFromIndex(from), cm.posFromIndex(to)) };
  },
  focus() { cm.focus(); },
};

// Euclidean rhythm (Bjorklund): `pulses` hits spread as evenly as possible over `steps`,
// returned as a boolean array. Standard livecoding helper the ported hotkeys lean on.
function bjorklund(pulses, steps) {
  pulses = Math.max(0, Math.min(Math.floor(pulses), Math.floor(steps)));
  steps = Math.max(0, Math.floor(steps));
  if (steps === 0) return [];
  if (pulses === 0) return new Array(steps).fill(false);
  let groups = [];
  for (let i = 0; i < pulses; i++) groups.push([true]);
  let remainders = [];
  for (let i = 0; i < steps - pulses; i++) remainders.push([false]);
  while (remainders.length > 1) {
    const n = Math.min(groups.length, remainders.length);
    const nextGroups = [], nextRemainders = [];
    for (let i = 0; i < n; i++) nextGroups.push(groups[i].concat(remainders[i]));
    if (groups.length > n) for (let i = n; i < groups.length; i++) nextRemainders.push(groups[i]);
    else for (let i = n; i < remainders.length; i++) nextRemainders.push(remainders[i]);
    groups = nextGroups;
    remainders = nextRemainders;
  }
  return groups.concat(remainders).flat();
}

// Rotate an array by n (positive = left). Negative and out-of-range n wrap.
function rotate(arr, n) {
  const len = arr.length;
  if (!len) return arr.slice();
  const k = ((n % len) + len) % len;
  return arr.slice(k).concat(arr.slice(0, k));
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// The DSL builder names to stub in the browser sandbox (real on the server). Sourced from the
// same BUILDERS list the autocomplete uses, so new builders are covered automatically.
const PREBAKE_STUB_NAMES = [...new Set(BUILDERS)];

// Names/values handed to every prebake run. Order must stay paired.
function prebakeScope() {
  const names = [];
  const values = [];
  const api = {
    hotkey: (combo, handler) => addHotkey(userHotkeys, combo, handler, 'user'),
    editor,
    repl: editor, // alias so Strudel-style ports read unchanged
    prompt: (msg, def) => Promise.resolve(window.prompt(msg, def == null ? '' : String(def))),
    alert: (msg) => window.alert(msg),
    log: (msg) => logLine(String(msg)),
    bjorklund,
    rotate,
    clamp,
    // Pure music-theory helpers, real here exactly as in patterns/setup (see server.js). Called
    // through notesMod so they track the loaded module; hotkey handlers run well after load, and
    // the startup prebake waits on coreReady, so notesMod is always ready by call time.
    noteToMidi: (name) => notesMod.noteToMidi(name),
    degreeToMidi: (degree, scaleName) => notesMod.degreeToMidi(degree, scaleName),
    parseScaleName: (scaleName) => notesMod.parseScaleName(scaleName),
  };
  for (const [n, v] of Object.entries(api)) { names.push(n); values.push(v); }
  // Each remaining builder is a chainable Proxy: callable (so `s("bd*4")` works), tolerant of
  // property sets (so `Signal.prototype.foo = …` doesn't throw), and every access/call returns a
  // stub. Names the api above already provides for real (the music-theory helpers, which are
  // builders too) keep the real one - and must not be pushed twice, since a duplicate parameter
  // name is a SyntaxError in the strict-mode function the sandbox compiles.
  for (const n of PREBAKE_STUB_NAMES) {
    if (n in api) continue;
    names.push(n);
    values.push(makeChainStub());
  }
  return { names, values };
}

// Clear any hotkeys a previous prebake run registered, then execute `code` in the sandbox. Errors
// are logged, not thrown - a broken prebake must never take the editor down. Called at startup and
// again whenever the prebake is saved.
function runUserPrebake(code) {
  userHotkeys = [];
  if (!code || !code.trim()) return;
  const { names, values } = prebakeScope();
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `"use strict";\n${code}\n//# sourceURL=poptart-prebake.js`);
    fn(...values);
  } catch (err) {
    logLine(`prebake (browser): ${err.message ?? err}`, true);
  }
}

// Load and run the prebake once at startup for its hotkeys/UI side. A missing file is fine. Wait
// on coreReady first so a top-level noteToMidi()/etc. in the prebake sees the loaded notes module.
coreReady
  .then(() => api('GET', '/api/prebake'))
  .then(({ code }) => runUserPrebake(code))
  .catch(() => {});
