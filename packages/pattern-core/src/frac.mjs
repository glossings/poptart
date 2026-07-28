// Exact rational time. Every position in the pattern language is a rational with a modest
// denominator - structural subdivisions (halves, thirds, euclid hits, ply, nesting) only ever
// divide the cycle by small integers. Floating point cannot represent 1/3 or 1/5 exactly, so two
// code paths that arrive at the *same* musical moment can land on slightly different doubles. The
// deterministic combinators (rand/degrade, and later rib/hold) key their draws off the moment, so
// that drift would read as two different moments - "the same time differentiated from itself".
// Frac keeps time exact so a moment is always the same moment, no matter how it was computed.
//
// Denominators here stay small (structural, < ~1e6) and cycle counts fit comfortably in a double,
// so plain Number integers are enough - no BigInt. Every result is reduced to lowest terms.
//
// This file is dependency-free and runs in both Node and the browser (served at /pattern-core/),
// mirroring mini.mjs. See [[strudel-parity-userland]]; this is our slice of Strudel's Fraction.

function gcd(a, b) {
  a = a < 0 ? -a : a;
  b = b < 0 ? -b : b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export class Frac {
  // Always stored reduced with a positive denominator.
  constructor(num, den = 1) {
    if (den === 0) throw new Error('[frac] zero denominator');
    if (!Number.isInteger(num) || !Number.isInteger(den)) {
      throw new Error(`[frac] non-integer terms: ${num}/${den}`);
    }
    if (den < 0) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den) || 1;
    this.num = num / g;
    this.den = den / g;
  }

  // Recover the exact rational a float was *meant* to be, via a continued-fraction expansion
  // bounded by maxDen. A clean rational round-trips to the identical double (frac(1,3).toNumber()
  // === 1/3), so snapping an already-clean position is a no-op; a position carrying float crud
  // (or produced by a different arithmetic path) snaps back to its intended value. Positions in
  // this system are always rationals of small denominator, so recovery always succeeds.
  static fromNumber(x, maxDen = 1_000_000) {
    if (x instanceof Frac) return x;
    if (!Number.isFinite(x)) throw new Error(`[frac] not finite: ${x}`);
    if (Number.isInteger(x)) return new Frac(x, 1);
    const sign = x < 0 ? -1 : 1;
    let b = Math.abs(x);
    // Convergent recurrence: h_{-2}=0, h_{-1}=1; k_{-2}=1, k_{-1}=0.
    let h0 = 0;
    let h1 = 1;
    let k0 = 1;
    let k1 = 0;
    for (let i = 0; i < 64; i++) {
      const a = Math.floor(b);
      const h2 = a * h1 + h0;
      const k2 = a * k1 + k0;
      if (k2 > maxDen) break;
      h0 = h1;
      h1 = h2;
      k0 = k1;
      k1 = k2;
      const rem = b - a;
      if (rem < 1e-12) break;
      b = 1 / rem;
    }
    return new Frac(sign * h1, k1);
  }

  add(o) {
    o = Frac.fromNumber(o);
    return new Frac(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o) {
    o = Frac.fromNumber(o);
    return new Frac(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o) {
    o = Frac.fromNumber(o);
    return new Frac(this.num * o.num, this.den * o.den);
  }

  div(o) {
    o = Frac.fromNumber(o);
    return new Frac(this.num * o.den, this.den * o.num);
  }

  // Largest integer <= this, as a plain number.
  floor() {
    return Math.floor(this.num / this.den);
  }

  // Non-negative remainder against a positive modulus - the periodic wrap rib()/hold() need:
  // c.mod(len) lands in [0, len) even for negative c. Returns a Frac.
  mod(o) {
    o = Frac.fromNumber(o);
    const q = Math.floor(this.num * o.den / (this.den * o.num));
    return this.sub(o.mul(q));
  }

  eq(o) {
    o = Frac.fromNumber(o);
    return this.num === o.num && this.den === o.den;
  }

  lt(o) {
    o = Frac.fromNumber(o);
    return this.num * o.den < o.num * this.den;
  }

  toNumber() {
    return this.num / this.den;
  }

  // Canonical string key ("1/3") - stable identity for a moment, safe to hash or compare.
  key() {
    return `${this.num}/${this.den}`;
  }
}

/** Shorthand constructor: `frac(1, 3)`, `frac(2)`. */
export function frac(num, den = 1) {
  return new Frac(num, den);
}
