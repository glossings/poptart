// A control's curve: how its 0..1 position maps onto its range. The same four curves a device
// descriptor has (web-engine's descriptor.mjs), so a knob() drawn in the code for a device control
// turns the way the control's own knob does: `exp` is the ratio sweep a frequency wants, `pow`
// bends a range so one end gets more travel, `sym` is `pow` from the middle out.

export const CURVES = ['lin', 'exp', 'pow', 'sym'];

/** The 0..1 position of `v` on `{ min, max, curve, curveExp }`. */
export function positionOnCurve(spec, v) {
  const { min, max } = spec;
  const k = spec.curveExp ?? 2;
  if (max === min) return 0;
  const x = Math.min(Math.max(Number(v), Math.min(min, max)), Math.max(min, max));
  let t;
  if (spec.curve === 'exp') t = Math.log(x / min) / Math.log(max / min);
  else if (spec.curve === 'pow') t = Math.pow((x - min) / (max - min), 1 / k);
  else if (spec.curve === 'sym') {
    const u = (x - (min + max) / 2) / ((max - min) / 2);
    t = (1 + Math.sign(u) * Math.pow(Math.abs(u), 1 / k)) / 2;
  } else t = (x - min) / (max - min);
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
}

/** The value at position `t` (0..1) on `{ min, max, curve, curveExp }`. */
export function valueOnCurve(spec, t) {
  const { min, max } = spec;
  const k = spec.curveExp ?? 2;
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  if (spec.curve === 'exp') return min * Math.pow(max / min, x);
  if (spec.curve === 'pow') return min + (max - min) * Math.pow(x, k);
  if (spec.curve === 'sym') {
    const u = 2 * x - 1;
    return (min + max) / 2 + ((max - min) / 2) * Math.sign(u) * Math.pow(Math.abs(u), k);
  }
  return min + (max - min) * x;
}
