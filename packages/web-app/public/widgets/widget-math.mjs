// The arithmetic behind the editor's inline widgets, kept apart from the drawing so it can be tested
// without a page: where a slider's value lands in the code, which samples a scope draws, where a
// spectrum's columns read, how a punchcard folds its rows. Nothing here touches the DOM.

/** `value` clamped to [min, max] and snapped to `step` (counted from min) when there is one. */
export function snapValue(value, min, max, step = null) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  let v = Math.min(hi, Math.max(lo, Number(value)));
  if (step && step > 0) v = lo + Math.round((v - lo) / step) * step;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * How many decimals a control writes its value with: the step's own, when it has one, else enough
 * to move by about a thousandth of the range - so a 0..1 slider writes 0.42 and a 20..20000 one 440.
 */
export function decimalsFor(min, max, step = null) {
  if (step && step > 0) {
    const s = String(step);
    const dot = s.indexOf('.');
    if (s.includes('e-')) return Math.min(6, Number(s.split('e-')[1]));
    return dot < 0 ? 0 : Math.min(6, s.length - dot - 1);
  }
  const span = Math.abs(max - min) || 1;
  return Math.max(0, Math.min(4, Math.ceil(-Math.log10(span / 1000)) - 1));
}

/** A control's position 0..1 as a value in [min, max] (and back). */
export const valueAt = (t, min, max) => min + (max - min) * Math.min(1, Math.max(0, t));
export const positionOf = (v, min, max) => (max === min ? 0 : Math.min(1, Math.max(0, (v - min) / (max - min))));

/** A number literal as written in code, or null for anything else. */
export function literalNumber(text) {
  const t = String(text ?? '').trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** A string literal's content span within `text` ("..." or '...'), or null when it is not one. */
export function stringContent(text) {
  const t = String(text ?? '');
  if (t.length < 2) return null;
  const q = t[0];
  if ((q !== '"' && q !== "'" && q !== '`') || t[t.length - 1] !== q) return null;
  return { from: 1, to: t.length - 1, text: t.slice(1, -1) };
}

/**
 * Where a scope starts drawing: the latest rising zero crossing that still leaves `span` samples
 * after it, so a periodic signal stands still; the latest window when there is none (noise, DC).
 */
export function scopeTrigger(samples, span) {
  const n = samples.length;
  const last = n - span;
  if (last <= 0) return 0;
  for (let i = last; i > 0; i--) {
    if (samples[i - 1] < 0 && samples[i] >= 0) return i;
  }
  return last;
}

/**
 * A spectrum's columns: for each of `width` columns spread log-wise over [lo, hi] Hz, the loudest
 * bin it covers (in dB). `db` is per bin from 0 Hz, `binHz` apart.
 */
export function spectrumColumns(db, binHz, width, lo = 20, hi = 20000) {
  const out = new Float32Array(width);
  const ratio = hi / lo;
  const top = db.length - 1;
  for (let x = 0; x < width; x++) {
    const f0 = lo * ratio ** (x / width);
    const f1 = lo * ratio ** ((x + 1) / width);
    let a = Math.floor(f0 / binHz);
    let b = Math.ceil(f1 / binHz);
    a = Math.max(1, Math.min(top, a));
    b = Math.max(a, Math.min(top, b));
    let peak = -Infinity;
    for (let k = a; k <= b; k++) if (db[k] > peak) peak = db[k];
    out[x] = Number.isFinite(peak) ? peak : -140;
  }
  return out;
}

/** Peak and RMS as decibels (full scale = 0), floored at `floor`. */
export const toDb = (x, floor = -90) => (x > 0 ? Math.max(floor, 20 * Math.log10(x)) : floor);

/**
 * A goniometer's picture of a stereo frame: each pair as a point with mono straight up and the
 * sides out to the left and right (x = side, y = mid, both in -1..1), plus the correlation of the
 * two channels, -1 (out of phase) .. 1 (mono).
 */
export function imagerPoints(l, r) {
  const n = Math.min(l.length, r.length);
  const pts = new Float32Array(n * 2);
  let lr = 0;
  let ll = 0;
  let rr = 0;
  const k = Math.SQRT1_2;
  for (let i = 0; i < n; i++) {
    const a = l[i];
    const b = r[i];
    pts[i * 2] = (b - a) * k;
    pts[i * 2 + 1] = (a + b) * k;
    lr += a * b;
    ll += a * a;
    rr += b * b;
  }
  const den = Math.sqrt(ll * rr);
  return { pts, correlation: den > 1e-9 ? lr / den : 0 };
}

const NOTE_LETTERS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** A note name (c3, f#2, eb4 - c3 is 60) or a MIDI number as MIDI, or null. */
export function midiOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = /^([a-gA-G])([#sb]*)(-?\d+)?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  let pc = NOTE_LETTERS[m[1].toLowerCase()];
  for (const ch of m[2]) pc += ch === 'b' ? -1 : 1;
  const octave = m[3] === undefined ? 3 : Number(m[3]);
  return 60 + (octave - 3) * 12 + pc;
}

const PITCH_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** The pitch class (0 = c) of a note value, or null for something that is not a pitch. */
export function pitchClassOf(value) {
  const m = midiOf(value);
  if (m === null) return null;
  return ((Math.round(m) % 12) + 12) % 12;
}

export const pitchName = (pc) => PITCH_NAMES[((pc % 12) + 12) % 12];

/** A value as a punchcard row label: a note name for a MIDI number, else the value itself. */
export function valueLabel(value, asNote = false) {
  if (typeof value === 'number' && asNote) {
    const m = Math.round(value);
    return `${pitchName(m)}${Math.floor(m / 12) - 2}`;
  }
  return String(value);
}

/**
 * The rows a punchcard folds its events onto: every distinct value in them, numbers lowest at the
 * bottom (index 0) and words in the order they first play. `Map(value -> row)` plus the count.
 */
export function punchcardRows(events) {
  const nums = new Set();
  const words = [];
  for (const e of events) {
    const v = e[2];
    if (typeof v === 'number') nums.add(v);
    else if (!words.includes(v)) words.push(v);
  }
  const order = [...[...nums].sort((a, b) => a - b), ...words];
  return { rows: new Map(order.map((v, i) => [v, i])), count: order.length };
}

/** The [min, max] a plot draws, from its data, padded so a flat line sits mid-height. */
export function plotRange(values, min = null, max = null) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (min !== null && Number.isFinite(min)) lo = min;
  if (max !== null && Number.isFinite(max)) hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi - lo < 1e-9) return [lo - 0.5, hi + 0.5];
  const pad = (hi - lo) * 0.08;
  return [min !== null ? lo : lo - pad, max !== null ? hi : hi + pad];
}

/** The cell a cycle position is on, in a row of `count` cells that spans one cycle. */
export function cellAt(pos, count) {
  if (!count) return -1;
  const phase = pos - Math.floor(pos);
  return Math.min(count - 1, Math.floor(phase * count));
}

/** Smooths a column toward its new reading: up at once, down by `release` dB per frame. */
export function decay(prev, next, release = 1.5) {
  if (!prev || prev.length !== next.length) return Float32Array.from(next);
  const out = new Float32Array(next.length);
  for (let i = 0; i < next.length; i++) out[i] = next[i] >= prev[i] ? next[i] : Math.max(next[i], prev[i] - release);
  return out;
}

/**
 * A spectrum's level axis over [lo, hi] dB, `height` pixels tall: a line every 12 dB (the mixer's
 * spectrum's grid), and a label every 12 or, where those would crowd, every 24. Fixed by the range
 * and the height alone, so nothing on the axis moves while the levels do.
 */
export function spectrumTicks(lo, hi, height) {
  const span = Math.max(1e-9, hi - lo);
  const lines = [];
  for (let db = Math.floor(hi / 12) * 12; db >= lo; db -= 12) if (db <= hi) lines.push(db);
  const every = (12 / span) * height >= 14 ? 12 : 24;
  return { lines, labels: lines.filter((db) => db % every === 0) };
}

/** Where `hz` sits across a spectrum `width` wide, on its log axis from `lo` to `hi` Hz. */
export const freqX = (hz, width, lo = 20, hi = 20000) => (Math.log(hz / lo) / Math.log(hi / lo)) * width;

/** A frequency as an axis names it: 100, 1k, 10k - the device windows' spelling. */
export const freqLabel = (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

/**
 * The size a corner drag leaves a widget at. `axis` is which way the size runs: 'x' (a width),
 * 'y' (a height) or 'xy' (a square, or a grid of them - whichever way the hand went further). The
 * drag scales the whole widget, so a grid of 16 cells dragged 32px wider grows each cell by 2.
 */
export function draggedSize(size0, box, dx, dy, axis, { min, max }) {
  const fx = box.width > 0 ? (box.width + dx) / box.width : 1;
  const fy = box.height > 0 ? (box.height + dy) / box.height : 1;
  const f = axis === 'x' ? fx : axis === 'y' ? fy : Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
  return Math.round(Math.min(max, Math.max(min, size0 * f)));
}

/**
 * The `{ width, height }` a corner drag leaves a box widget at: each side scaled by how far the
 * hand went along it, against the box it started from, and clamped to its own range. `size0` is
 * the size in the call's units (a cell's side, a bar's width), `box` the drawn box in pixels.
 */
export function draggedBox(size0, box, dx, dy, ranges) {
  const fx = box.width > 0 ? (box.width + dx) / box.width : 1;
  const fy = box.height > 0 ? (box.height + dy) / box.height : 1;
  const clamp = (r, v) => Math.round(Math.min(r.max, Math.max(r.min, v)));
  return { width: clamp(ranges.width, size0.width * fx), height: clamp(ranges.height, size0.height * fy) };
}

// The level meter's scale: the desk's channel meters' (client.js MIX_METER_DB, mixMeterColor), so
// a meter in the code reads like the ones on the desk.
export const METER_DB = Object.freeze({ min: -42, max: 6 });
export const meterColor = (db) => (db >= -3 ? '#f85149' : db >= -9 ? '#d29922' : '#3fb950');
/** A meter taller than it is wide stands up, like the desk's; otherwise it lies along the line. */
export const meterVertical = (width, height) => height > width;
/** The desk's dB ticks that fit a vertical meter `height` px tall, at least `gap` px apart. */
export function meterTicks(height, gap = 10) {
  const all = [6, 0, -6, -12, -18, -24, -36];
  const span = METER_DB.max - METER_DB.min;
  const out = [];
  let last = -Infinity;
  for (const db of all) {
    const y = (1 - (db - METER_DB.min) / span) * height;
    if (y - last >= gap) {
      out.push(db);
      last = y;
    }
  }
  return out;
}

/** Whether cell `index` of `count` starts a new beat - a gap before it, every four of a row of fours. */
export const beatStart = (index, count) => index > 0 && count % 4 === 0 && count > 4 && index % 4 === 0;

// ---------------------------------------------------------------------------- track colors

/** `#rgb`/`#rrggbb` (alpha ignored) as [r, g, b] 0..255, or null. */
export function parseHex(hex) {
  const t = String(hex ?? '').trim().toLowerCase();
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/.exec(t);
  if (m) return [m[1], m[2], m[3]].map((x) => parseInt(x + x, 16));
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/.exec(t);
  return m ? [m[1], m[2], m[3]].map((x) => parseInt(x, 16)) : null;
}

function rgbToHsl([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Whether a theme's background is a light one (its lightness past the middle). */
export const isLightBg = (bg) => (rgbToHsl(parseHex(bg) ?? [0, 0, 0])[2] > 0.5);

/**
 * The colors tracks without a .color() take, from the theme: `n` hues stepped round the wheel by
 * the golden angle from the accent's own, so neighbors stay apart, each at a lightness that reads
 * on the theme's background - lighter on a dark one, darker on a light one.
 */
export function trackPalette(accent, bg, n = 12) {
  const [h0, s0] = rgbToHsl(parseHex(accent) ?? [255, 122, 156]);
  const light = isLightBg(bg);
  const s = Math.min(0.85, Math.max(0.5, s0));
  const l = light ? 0.42 : 0.68;
  return Array.from({ length: n }, (_, k) => hslToHex((h0 + k * 137.508) % 360, s, l));
}

/** A track name's place in the palette: FNV-1a over its characters, the same on every evaluation. */
export function nameHash(name) {
  let h = 0x811c9dc5;
  for (const ch of String(name ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The color a track is drawn in: its .color() when the browser can draw it (`isColor`), else its
 * name's own from the palette, else `fallback` (a display that belongs to no track).
 */
export function resolveTrackColor(track, palette, { isColor = () => true, fallback = null } = {}) {
  if (track?.color && isColor(track.color)) return track.color;
  if (track?.label && palette?.length) return palette[nameHash(track.label) % palette.length];
  return fallback;
}

// ---------------------------------------------------------------------------- the color picker

/** A hex color as [hue 0..360, saturation 0..1, lightness 0..1], or null. */
export function hexToHsl(hex) {
  const rgb = parseHex(hex);
  return rgb ? rgbToHsl(rgb) : null;
}

/** [hue 0..360 (any turn), saturation 0..1, lightness 0..1] as "#rrggbb". */
export function hslHex(h, s, l) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return hslToHex(((h % 360) + 360) % 360, clamp(s), clamp(l));
}

/** WCAG's relative luminance of a hex color, 0 (black) to 1 (white). */
export function luminance(hex) {
  const [r, g, b] = (parseHex(hex) ?? [0, 0, 0]).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG's contrast ratio of two colors, 1 (the same) to 21 (black on white). */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The contrast WCAG asks of a graphic against what it is drawn on (its non-text minimum). */
export const MIN_GRAPHIC_CONTRAST = 3;

/**
 * `hex` with its lightness moved away from the background's - lighter on a dark theme, darker on a
 * light one - just far enough to stand `min` apart from `bg`; as it was when it already does. Hue
 * and saturation are kept, so a suggestion stays the color it was worked out as.
 */
export function fitToBackground(hex, bg, min = MIN_GRAPHIC_CONTRAST) {
  const hsl = hexToHsl(hex);
  if (!hsl || contrastRatio(hex, bg) >= min) return hsl ? hslHex(...hsl) : hex;
  const [h, s, l0] = hsl;
  const dir = isLightBg(bg) ? -1 : 1;
  let best = hslHex(h, s, l0);
  for (let l = l0; l >= 0 && l <= 1; l += dir * 0.01) {
    best = hslHex(h, s, l);
    if (contrastRatio(best, bg) >= min) return best;
  }
  return best;
}

/** `hex` turned `deg` round the color wheel, its saturation and lightness kept. */
export function rotateHue(hex, deg) {
  const hsl = hexToHsl(hex);
  return hsl ? hslHex(hsl[0] + deg, hsl[1], hsl[2]) : null;
}

/** Hue distance round the wheel, 0..180. */
const hueApart = (a, b) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
};

/**
 * `count` hues as far as they can be from every one of `hues`: each in the middle of the widest gap
 * left round the wheel, the gap then split by it - the hues a song has not used yet. With no hues
 * at all, `from` and its even spacing.
 */
export function openHues(hues, count, from = 0) {
  const taken = [...hues].map((h) => ((h % 360) + 360) % 360);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (!taken.length) {
      const h = ((from % 360) + 360) % 360;
      taken.push(h);
      out.push(h);
      continue;
    }
    const sorted = [...taken].sort((a, b) => a - b);
    let best = { gap: -1, at: 0 };
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const b = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360;
      if (b - a > best.gap + 1e-9) best = { gap: b - a, at: (a + (b - a) / 2) % 360 };
    }
    taken.push(best.at);
    out.push(best.at);
  }
  return out;
}

/**
 * The palette tab's suggestions for one track, as groups `{ key, label, colors }` in the order they
 * are shown. The hues are this track's turned round the wheel - neighbors either side, the opposite,
 * the two either side of the opposite, the two that make three equal steps - and the hues the
 * song's other tracks leave open. Every one is drawn at the song's own saturation and lightness
 * (the mean of the other tracks', this track's when it is alone), kept to the range the theme's
 * automatic colors use, then moved just far enough from the theme's background to read on it (see
 * fitToBackground). Last come the colors the song uses now, this track's among them, as they are.
 *
 * `base` is this track's color, `others` the other tracks' colors, `bg` the theme's background.
 */
export function colorSuggestions(base, others = [], bg = '#0e0f13') {
  const baseHsl = hexToHsl(base) ?? [0, 0.6, 0.6];
  const song = others.map(hexToHsl).filter(Boolean);
  const mean = (i) => (song.length ? song.reduce((a, c) => a + c[i], 0) / song.length : baseHsl[i]);
  const s = Math.min(0.85, Math.max(0.5, mean(1)));
  const l = Math.min(0.75, Math.max(0.35, mean(2)));
  const h0 = baseHsl[0];
  const at = (deg) => fitToBackground(hslHex(h0 + deg, s, l), bg);
  const uniq = (list) => [...new Set(list.map((c) => String(c).toLowerCase()))];
  const otherHues = song.filter((c) => c[1] > 0.08).map((c) => c[0]);
  const groups = [
    { key: 'neighbors', label: 'neighbors', colors: uniq([-60, -30, 30, 60].map(at)) },
    { key: 'opposite', label: 'opposite', colors: uniq([180].map(at)) },
    { key: 'split', label: 'split opposite', colors: uniq([150, 210].map(at)) },
    { key: 'triad', label: 'three-way', colors: uniq([120, 240].map(at)) },
    {
      key: 'open',
      label: 'unused hues',
      colors: uniq(openHues([h0, ...otherHues], 4, h0 + 180).map((h) => fitToBackground(hslHex(h, s, l), bg))),
    },
    { key: 'song', label: 'in this song', colors: uniq([base, ...others].filter((c) => parseHex(c))) },
  ];
  return groups.filter((g) => g.colors.length);
}

/**
 * Where a hue and saturation sit on a color wheel of `radius` centered on (0, 0): the hue is the
 * angle (red to the right, turning clockwise on screen), the saturation the distance out.
 */
export function wheelPoint(h, s, radius) {
  const a = (h * Math.PI) / 180;
  const r = Math.min(1, Math.max(0, s)) * radius;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

/** The hue and saturation at (x, y) from the wheel's center - wheelPoint undone, the rim clamped. */
export function wheelAt(x, y, radius) {
  const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const s = radius > 0 ? Math.min(1, Math.hypot(x, y) / radius) : 0;
  return { h, s };
}

/** `list` with `hex` put first and any earlier copy of it dropped, kept to `max` entries. */
export function rememberColor(list, hex, max) {
  const c = String(hex).toLowerCase();
  return [c, ...list.filter((x) => x !== c)].slice(0, max);
}

/**
 * The recent picks kept in `storage` under `key` (a hex list), newest first - an empty list when
 * storage is missing, throws, or holds something else.
 */
export function readRecentColors(storage, key, max) {
  try {
    const raw = storage?.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).map((c) => c.toLowerCase()).slice(0, max) : [];
  } catch {
    return [];
  }
}

/** Keeps `list` in `storage` under `key`; says whether it could (private windows and blocked storage throw). */
export function writeRecentColors(storage, key, list) {
  try {
    storage?.setItem(key, JSON.stringify(list));
    return !!storage;
  } catch {
    return false;
  }
}

/**
 * The bands the displays behind the code share: one each, the editor's height split evenly in the
 * order they were written, as `{ y, height }` in CSS pixels (whole pixels, the last taking the rest).
 */
export function backgroundBands(count, height) {
  if (count <= 0) return [];
  const each = Math.floor(height / count);
  return Array.from({ length: count }, (_, i) => ({ y: i * each, height: i === count - 1 ? height - i * each : each }));
}
