// Which sample a sampler track plays, read off its pattern without playing it - what the track
// list names beside a chain like `s("psyhyp:9").fit()`, which has no instrument to show.
//
// Mirrors the scheduler's own dispatch (see Scheduler#_tick's sampler branch and _sampleConfigAt):
// a bare name is a folder pack, "sp:" a named one, "file:"/"rec:" one exact file; the two packs take
// an index suffix ("bd:4"), and an explicit .i() wins over it. Kept beside it rather than shared
// because the scheduler's version is on the hot path and this one is not - a change to either
// spelling has to be made in both.

/**
 * The distinct sources a sampler track plays in its first `cycles` cycles, in the order they
 * first sound: [{ ref (the engine's spelling), index, fit ('auto' | measures | null) }]. Empty for
 * a track that is not a sampler, or plays nothing that soon.
 */
export function sampleSourcesOf(sig, { cycles = 1, max = 8 } = {}) {
  const sampler = sig?.sampler;
  if (!sampler || typeof sig.stepsForCycle !== 'function') return [];
  const kind = sig.samplerKind ?? 'pack';
  const num = (raw) => {
    const v = typeof raw === 'number' ? raw : raw == null ? NaN : Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };
  const at = (key, step, cycle) => {
    if (step.cfg?.[key] !== undefined) return num(step.cfg[key]);
    const src = sampler[key];
    if (!src || typeof src.sample !== 'function') return undefined;
    try {
      return num(src.sample(cycle, 1, cycle));
    } catch {
      return undefined;
    }
  };
  const out = [];
  const seen = new Set();
  for (let c = 0; c < cycles && out.length < max; c++) {
    let steps = [];
    try {
      steps = sig.stepsForCycle(c) ?? [];
    } catch {
      continue; // a pattern that throws here throws in the scheduler too, and says so there
    }
    for (const step of [...steps].sort((x, y) => x.start - y.start)) {
      if (step.value == null || step.value === '~') continue;
      const onset = Number.isFinite(step.start) ? step.start : c;
      let ref = String(step.value);
      let index = at('index', step, onset);
      if (kind === 'pack' || kind === 'named') {
        const m = /^(.+):(-?\d+)$/.exec(ref);
        if (m) {
          ref = m[1];
          if (index === undefined) index = Number(m[2]);
        }
        if (kind === 'named') ref = `sp:${ref}`;
      } else {
        ref = `${kind === 'rec' ? 'rec' : 'file'}:${ref}`;
      }
      index = Math.round(index ?? 0);
      let fit = null;
      if (at('splice', step, onset) > 0.5) fit = null; // a splice fits each chop to its event instead
      else if (sampler.fit === 'auto') fit = 'auto';
      else fit = at('fit', step, onset) ?? null;
      const id = `${ref}\n${index}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ref, index, fit });
      if (out.length >= max) break;
    }
  }
  return out;
}

/**
 * How long a sample of `durationSec` lasts once `.fit()` has set its rate, in cycles - the
 * engine's arithmetic (OscEngine#playSample, and sample-plan.mjs in the browser): the whole file
 * is made to last `fit` cycles, or with 'auto' the power of two nearest its natural length.
 * Without a fit it is the natural length. Null when either length is unknown.
 */
export function fittedCycles(durationSec, secPerCycle, fit = null) {
  if (!(durationSec > 0) || !(secPerCycle > 0)) return null;
  const measures = durationSec / secPerCycle;
  if (fit === 'auto') return 2 ** Math.round(Math.log2(measures));
  if (Number.isFinite(fit) && fit > 0) return fit;
  return measures;
}
