// The env() editor's reads and code edits. Double-clicking `env` opens a picture of the envelope,
// and every change made there is written back into that call's own `{ attack, decay, ... }`
// object, so the code stays the one source of truth. Pure string-in/edit-out, like samplerctl.mjs:
// the browser applies the edits to CodeMirror, and the tests never need a DOM.
//
// Only a bare numeric literal is the editor's to rewrite. Anything else in a setting's place - a
// pattern string, a variable, `0.1 * 2` - is shown and left alone, the way the shape editor
// carries a patterned rate. An argument that is not an object literal at all (`env(opts)`) is
// read-only throughout. A setting the object does not have is added to it, after the last entry,
// in the layout the object is already written in. A `.curve(c)` chained on the call wins over the
// object's `curve`, as it does when the signal is built, so that is where a curve edit goes.

import { codeMask } from './labels.mjs';
import { formatCtl } from './samplerctl.mjs';

/** What each setting is when the call leaves it out - env() reads these, see signal.mjs. */
export const ENV_DEFAULTS = Object.freeze({ attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2, curve: -4 });

/** The settings the editor draws and writes, in the order it writes new ones. */
export const ENV_KEYS = Object.freeze(Object.keys(ENV_DEFAULTS));

const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const KEY_RE = /^(?:([A-Za-z_$][\w$]*)|"([^"\\]*)"|'([^'\\]*)')/;

const CODE = 0;
const STR = 1;
const COMMENT = 2;

/**
 * What each character of `code` is: code, inside a string, or inside a comment. labels.mjs's mask
 * says code-or-not; the object parse below also needs to tell a string VALUE (which is a setting)
 * from a comment (which is not), so it keeps its own three-way reading of the same rules.
 */
function lex(code) {
  const kind = new Uint8Array(code.length);
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') kind[i++] = COMMENT;
      i--;
    } else if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? code.length : end + 2;
      while (i < stop) kind[i++] = COMMENT;
      i--;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      kind[i] = STR;
      let j = i + 1;
      for (; j < code.length; j++) {
        kind[j] = STR;
        if (code[j] === '\\') { kind[++j] = STR; continue; }
        if (code[j] === ch) break;
      }
      i = j;
    }
  }
  return kind;
}

/** The bracket closing the one at `open`, counting code only; -1 if it never closes. */
function matchClose(code, kind, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (kind[i] !== CODE) continue;
    const ch = code[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

/** Past whitespace and comments from `i`, stopping at `end`. */
function skipSpace(code, kind, i, end = code.length) {
  while (i < end && (kind[i] === COMMENT || /\s/.test(code[i]))) i++;
  return i;
}

/** Back over whitespace and comments from `end`, stopping at `from`. */
function trimEnd(code, kind, from, end) {
  while (end > from && (kind[end - 1] === COMMENT || /\s/.test(code[end - 1]))) end--;
  return end;
}

/**
 * The env(...) call around `idx`, and whether `idx` is on its name - the handle. Offsets are the
 * document's: `start` is the name, `open`/`close` the parens. A commented-out or quoted `env(` is
 * not a call, and neither is a method of that name (`x.env(`) or a longer word ending in it.
 */
export function findEnvCallAt(code, idx) {
  const text = String(code);
  const isCode = codeMask(text);
  const kind = lex(text);
  const re = /\benv\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (isCode[m.index] !== 1) continue;
    if (m.index > 0 && /[\w$.]/.test(text[m.index - 1])) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(text, kind, open);
    if (close < 0) continue;
    if (idx < m.index || idx > close + 1) continue;
    return { start: m.index, open, close, onName: idx >= m.index && idx <= m.index + 3 };
  }
  return null;
}

/** The top-level entries of the object literal between `open` and `close` (its braces). */
function objectEntries(code, kind, open, close) {
  const entries = [];
  let depth = 0;
  let from = open + 1;
  const push = (to) => {
    const s = skipSpace(code, kind, from, to);
    const e = trimEnd(code, kind, s, to);
    if (e > s) entries.push(entryAt(code, kind, s, e));
  };
  for (let i = open + 1; i < close; i++) {
    if (kind[i] !== CODE) continue;
    const ch = code[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      push(i);
      from = i + 1;
    }
  }
  push(close);
  return entries;
}

/** One `key: value` entry, `from`..`to` trimmed. Shorthand, spreads and methods have no literal. */
function entryAt(code, kind, from, to) {
  const text = code.slice(from, to);
  const entry = { from, to, key: null, valueFrom: null, valueTo: null };
  if (text.startsWith('...')) return entry;
  const k = KEY_RE.exec(text);
  if (!k) return entry;
  entry.key = k[1] ?? k[2] ?? k[3];
  const colon = skipSpace(code, kind, from + k[0].length, to);
  if (code[colon] !== ':') {
    // `{ attack }` reads a variable called attack: a setting, but not a number to rewrite.
    entry.valueFrom = from;
    entry.valueTo = from + k[0].length;
    return entry;
  }
  entry.valueFrom = skipSpace(code, kind, colon + 1, to);
  entry.valueTo = to;
  return entry;
}

/** A setting as written: its text, whether it is a number the editor may rewrite, and where. */
function field(code, from, to, chained = false) {
  const text = code.slice(from, to);
  const literal = NUM_RE.test(text);
  return { text, literal, value: literal ? Number(text) : null, from, to, chained };
}

/**
 * What an env(...) call sets. `call` is findEnvCallAt's answer.
 *
 * `values` holds every setting as a number - the call's own where it writes a literal, the
 * default otherwise - which is what the picture is drawn from. `fields` holds the settings the
 * call writes at all, each with its text and whether it is a literal. `arg` is the argument's
 * shape: none, an object literal, or something opaque the editor cannot see into.
 */
export function readEnvCall(code, call) {
  const text = String(code);
  const kind = lex(text);
  const values = { ...ENV_DEFAULTS };
  const fields = {};
  let arg;
  const a = skipSpace(text, kind, call.open + 1, call.close);
  if (a >= call.close) {
    arg = { kind: 'none' };
  } else {
    const braceClose = text[a] === '{' ? matchClose(text, kind, a) : -1;
    const after = braceClose >= 0 ? skipSpace(text, kind, braceClose + 1, call.close) : -1;
    if (braceClose >= 0 && braceClose < call.close && (after === call.close || text[after] === ',')) {
      const entries = objectEntries(text, kind, a, braceClose);
      const first = entries[0];
      const last = entries[entries.length - 1];
      // Laid out a line to an entry: new ones go on lines of their own, at the indent of the last.
      const multiline = !!first && text.slice(a + 1, first.from).includes('\n');
      const lineStart = last ? text.lastIndexOf('\n', last.from - 1) + 1 : a;
      const lead = last ? text.slice(lineStart, last.from) : '';
      arg = { kind: 'object', open: a, close: braceClose, entries, multiline, indent: /^\s*$/.test(lead) ? lead : '  ' };
      for (const entry of entries) {
        if (!entry.key || !ENV_KEYS.includes(entry.key)) continue;
        fields[entry.key] = field(text, entry.valueFrom, entry.valueTo);
      }
    } else {
      arg = { kind: 'opaque', text: text.slice(a, trimEnd(text, kind, a, call.close)) };
    }
  }

  // A .curve(c) anywhere along the chain the call heads. The last one is the one that plays.
  let i = call.close + 1;
  for (;;) {
    const dot = skipSpace(text, kind, i);
    if (text[dot] !== '.') break;
    const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(dot + 1));
    if (!name) break;
    const paren = skipSpace(text, kind, dot + 1 + name[0].length);
    if (text[paren] !== '(') break;
    const shut = matchClose(text, kind, paren);
    if (shut < 0) break;
    if (name[0] === 'curve') {
      const s = skipSpace(text, kind, paren + 1, shut);
      fields.curve = field(text, s, trimEnd(text, kind, s, shut), true);
    }
    i = shut + 1;
  }

  for (const [key, f] of Object.entries(fields)) if (f.literal) values[key] = f.value;
  return { values, fields, arg };
}

/**
 * The edits that set `set` ({ attack: 0.05, ... }) on the env(...) call `call`, back to front so
 * they apply in order. A literal is rewritten where it stands; a missing setting is added to the
 * object (or an object is written into an empty `env()`); a setting written as anything but a
 * number - or any setting at all of an argument the editor cannot read - is left alone and
 * reported in `skipped`.
 */
export function envCallEdits(code, call, set) {
  const text = String(code);
  const { fields, arg } = readEnvCall(text, call);
  const edits = [];
  const skipped = [];
  const added = [];
  for (const key of ENV_KEYS) {
    if (!(key in set)) continue;
    const num = Number(set[key]);
    if (!Number.isFinite(num)) continue;
    const value = formatCtl(num);
    const f = fields[key];
    if (f) {
      if (f.literal) {
        if (f.text !== value) edits.push({ from: f.from, to: f.to, text: value });
      } else skipped.push(key);
    } else if (arg.kind === 'opaque') {
      skipped.push(key);
    } else {
      added.push(`${key}: ${value}`);
    }
  }
  if (added.length) {
    if (arg.kind === 'none') {
      edits.push({ from: call.open + 1, to: call.close, text: `{ ${added.join(', ')} }` });
    } else if (!arg.entries.length) {
      edits.push({ from: arg.open + 1, to: arg.close, text: ` ${added.join(', ')} ` });
    } else {
      const at = arg.entries[arg.entries.length - 1].to;
      const sep = arg.multiline ? `,\n${arg.indent}` : ', ';
      edits.push({ from: at, to: at, text: added.map((p) => `${sep}${p}`).join('') });
    }
  }
  edits.sort((x, y) => y.from - x.from);
  return { edits, skipped };
}

/** `edits` (back to front, as envCallEdits returns them) applied to `code`. */
export function applyEnvEdits(code, edits) {
  let out = String(code);
  for (const e of edits) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}
