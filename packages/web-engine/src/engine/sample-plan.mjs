// What one sampler event plays, worked out before anything is built to play it.
//
// The desktop's engine does this in its playSample (osc-engine's index.js) and sends the answer
// to SuperCollider; this is the same resolution for the browser, rule for rule, so a pattern
// plays the same window at the same rate in both builds. What it resolves:
//
//   - the WINDOW: begin..end of the file, or a slice of it - `.slice(n)` indexing the markers a
//     hand-drawn set carries for this file, or else the file's own transients;
//   - the RATE: speed, times `.fit()` (the whole file lasting the cycles asked, 'auto' being the
//     nearest power of two), times `.splice()` (the window fitted to its own event, by rate or by
//     stretch), times the note's repitch around the anchor, with `.flip()` a sign and a re-anchor;
//   - the LOOP: on for `.loop()`, and by default for a negative speed (the window is a circle);
//     over the whole file or just the window; forward or ping-pong;
//   - the ENVELOPE: attack, decay and release in seconds times `.envscale()`, sustain a level;
//   - and whether the event is CUT at its end, which a sampler event always is when the sound
//     would outlast it.
//
// The one difference from the desktop is the anchor: a pack that records the pitch its files
// are at repitches around that, where the desktop always uses MIDI 60 (see the engine's note on
// rootNote).

export const DEFAULT_RELEASE_SEC = 0.05;

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const wrap = (n, m) => ((n % m) + m) % m;
const mode = (v, count) => {
  const i = Math.round(Number(v));
  return Number.isFinite(i) ? wrap(i, count) : 0;
};

/** Attack, decay and release in seconds, each times .envscale(); unset release is 50 ms. */
export function envelopeSeconds(cfg) {
  const scale = Number.isFinite(cfg.envScale) ? cfg.envScale : 1;
  const secs = (v) => {
    const out = (Number.isFinite(v) ? v : 0) * scale;
    return out > 0 ? out : 0;
  };
  return { attack: secs(cfg.attack), decay: secs(cfg.decay), release: secs(cfg.release ?? DEFAULT_RELEASE_SEC) };
}

/**
 * The plan for one event.
 *
 * `file` is `{ duration, rootNote }`. `slices` is the positions a `.slice()` indexes - the
 * authored marks for this file, or its detected transients - `undefined` while those are still
 * being worked out (the event is skipped, as the desktop skips one), and null where there are
 * none. `authoredFit` is what an authored set says about this file's fit.
 */
export function planSample(file, cfg, onsetSec, offsetSec, opts = {}) {
  // Not a destructuring default: `slices: undefined` means "still being worked out", and a
  // default would quietly turn it into "there are none".
  const { slices, authoredFit = null, anchor = 60 } = opts;
  const amp = cfg.vel ?? 1;
  if (amp <= 0) return { skipped: 'vel 0' };

  let begin = clamp01(cfg.begin ?? 0);
  let end = clamp01(cfg.end ?? 1);
  let noSlices = false;
  if (cfg.slice != null) {
    if (slices === undefined) return { skipped: 'analyzing slices' };
    if (slices?.length) {
      const k = wrap(Math.round(cfg.slice), slices.length);
      begin = slices[k];
      end = slices[k + 1] ?? 1;
    } else {
      noSlices = true;
    }
  }
  if (end < begin) [begin, end] = [end, begin];

  let speed = cfg.speed ?? 1;
  const flip = (cfg.flip ?? 0) > 0.5;
  if (flip) speed *= -1;
  const grain = (cfg.grain ?? 0) > 0.5;
  let stretch = !grain && cfg.stretch > 0 ? cfg.stretch : 1;
  const spanSec = file.duration * (end - begin);
  if (speed === 0 || spanSec <= 0) return { skipped: speed === 0 ? 'speed 0' : 'empty begin..end window' };
  const eventSec = offsetSec - onsetSec;

  const spliced = (cfg.splice ?? 0) > 0.5 && eventSec > 1e-6;
  if (spliced) {
    if (mode(cfg.spliceMode ?? 0, 2) === 1) stretch *= eventSec / spanSec;
    else speed *= spanSec / eventSec;
  }
  const fit = spliced ? null : cfg.fit != null ? cfg.fit : authoredFit ?? null;
  if (fit != null && cfg.secPerCycle > 0) {
    // Fit is a property of the whole file, so a randomized begin does not repitch every hit.
    const measures = file.duration / cfg.secPerCycle;
    const target = fit === 'auto' ? 2 ** Math.round(Math.log2(measures)) : fit;
    if (target > 0) speed *= measures / target;
  }
  if (cfg.note != null) speed *= 2 ** ((cfg.note - (Number.isFinite(file.rootNote) ? file.rootNote : anchor)) / 12);

  const loop = !grain && (cfg.loop ?? (speed < 0 && !flip ? 1 : 0)) ? 1 : 0;
  const windowed = mode(cfg.loopWrap ?? 0, 2) === 1;
  const pingpong = mode(cfg.loopDir ?? 0, 2);
  const loopLo = windowed ? begin : 0;
  const loopHi = windowed ? end : 1;
  const loopEntry = windowed && speed < 0 ? end : begin;

  let durSec = (spanSec * stretch) / Math.abs(speed);
  let onset = onsetSec;
  if (flip && speed < 0 && !loop && !grain) {
    if (durSec > eventSec + 0.005) {
      end = begin + (eventSec * Math.abs(speed)) / stretch / file.duration;
      durSec = eventSec;
    } else {
      onset = offsetSec - durSec;
    }
  }
  const cut = grain || (!loop && durSec > eventSec + 0.005) ? 1 : 0;
  const env = envelopeSeconds(cfg);
  return {
    begin, end, loop, speed, stretch, durSec, cut, amp, ...env,
    sustain: Number.isFinite(cfg.sustain) ? cfg.sustain : 1,
    loopLo, loopHi, loopEntry, pingpong, windowed,
    onsetSec: onset, offsetSec, grain, noSlices,
    fileSec: file.duration,
  };
}

/**
 * What a hand-drawn slice set says about one file: `{ marks, fit }`, or null. A bare list applies
 * to whatever is playing; a map only where it has an entry for the file. The same few lines as
 * pattern-core's slices.mjs and the desktop's samples.js, which must agree.
 */
export function sliceEntryFor(set, key) {
  if (!set) return null;
  const raw = Array.isArray(set) ? set : typeof set === 'object' ? set[key] : null;
  if (raw == null) return null;
  const marks = Array.isArray(raw) ? raw : Array.isArray(raw.marks) ? raw.marks : [];
  const fit = Array.isArray(raw) ? null : normalizeFit(raw.fit);
  if (!marks.length && fit == null) return null;
  return { marks: marks.length ? marks : null, fit };
}

function normalizeFit(fit) {
  if (fit == null || fit === '' || fit === false) return null;
  if (fit === 'auto' || fit === true) return 'auto';
  const n = Number(fit);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---- transients ---------------------------------------------------------------------------------
//
// The desktop's detector (osc-engine's samples.js detectOnsets): half-wave-rectified energy flux
// with an adaptive local threshold - a simple onset detector for slicing drum loops.

const HOP = 256;
const MIN_GAP_SEC = 0.05;
const FLUX_RATIO = 2;
const FLUX_FLOOR = 0.005;

/** Slice starts, 0..1, for mono samples. The first is always the file's start. */
export function detectOnsets(samples, sampleRate, { sensitivity = 1 } = {}) {
  const strictness = 1 / Math.min(8, Math.max(1 / 8, Number(sensitivity) || 1));
  const nHops = Math.floor(samples.length / HOP);
  if (nHops < 4) return [0];
  const rms = new Float32Array(nHops);
  for (let h = 0; h < nHops; h++) {
    let e = 0;
    for (let i = h * HOP; i < (h + 1) * HOP; i++) e += samples[i] * samples[i];
    rms[h] = Math.sqrt(e / HOP);
  }
  const flux = new Float32Array(nHops);
  for (let h = 1; h < nHops; h++) flux[h] = Math.max(0, rms[h] - rms[h - 1]);
  const radius = Math.max(2, Math.round((0.185 * sampleRate) / HOP));
  const minGapHops = Math.max(1, Math.round((MIN_GAP_SEC * sampleRate) / HOP));
  let peak = 0;
  for (const v of rms) if (v > peak) peak = v;
  const floor = peak * 0.02;
  const onsets = [0];
  let lastOnset = -minGapHops;
  for (let h = 1; h < nHops; h++) {
    if (flux[h] <= 0 || rms[h] < floor) continue;
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, h - radius); k < Math.min(nHops, h + radius + 1); k++) { sum += flux[k]; count++; }
    const isPeak = flux[h] >= flux[h - 1] && flux[h] >= (flux[h + 1] ?? 0);
    if (isPeak && flux[h] > (sum / count) * FLUX_RATIO * strictness + peak * FLUX_FLOOR * strictness && h - lastOnset >= minGapHops) {
      onsets.push((Math.max(0, h - 1) * HOP) / samples.length);
      lastOnset = h;
    }
  }
  if (onsets.length > 1 && onsets[1] < 0.002) onsets.splice(1, 1);
  return onsets;
}

/** A decoded buffer's channels mixed to one, which is what the detector reads. */
export function monoOf(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const channels = buffer.numberOfChannels ?? 1;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i] / channels;
  }
  return out;
}
