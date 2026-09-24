// A radix-2 FFT, here for one job: band-limiting a wavetable frame.
//
// A frame loaded from a file holds whatever harmonics its author put in it, up to half its
// length. Played back at a high note those harmonics fold over the Nyquist rate and come back
// as inharmonic noise, which is the thing that makes a naive wavetable oscillator sound cheap.
// The fix is to keep several copies of every frame with progressively fewer harmonics and read
// whichever one is safe at the pitch being played - and making those copies means going to the
// frequency domain, dropping the bins above a limit, and coming back.
//
// Nothing here is a general-purpose FFT: input lengths are powers of two (a wavetable frame is
// always one), and the transform runs at load time, never per sample.

/** In-place bit-reversal permutation, the reordering a radix-2 transform starts from. */
function bitReverse(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
}

/**
 * In-place complex FFT. `inverse` runs the transform the other way and scales by 1/n, so
 * `fft(re, im); fft(re, im, true)` returns the input.
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n !== im.length) throw new Error('[web-engine] fft(): real and imaginary parts must be the same length');
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`[web-engine] fft(): length must be a power of two, got ${n}`);

  bitReverse(re, im);

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/**
 * The harmonic content of one cycle: amplitude and phase per harmonic, index 0 being DC.
 * Only the harmonics below the halfway bin are meaningful - above that a real signal's spectrum
 * is the mirror of what is below.
 */
export function harmonicsOf(frame) {
  const n = frame.length;
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  fft(re, im);
  const count = n / 2;
  const amp = new Float64Array(count);
  const phase = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    amp[k] = Math.hypot(re[k], im[k]) / n;
    phase[k] = Math.atan2(im[k], re[k]);
  }
  return { amp, phase };
}

/**
 * A copy of one cycle with every harmonic above `maxHarmonic` removed.
 *
 * Both halves of the spectrum are zeroed together (bin k and bin n-k are the same harmonic seen
 * twice), which is what keeps the result real. DC is kept: a frame with an offset is somebody's
 * choice, and removing it here would change the waveform rather than band-limit it.
 */
export function bandLimit(frame, maxHarmonic) {
  const n = frame.length;
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  fft(re, im);
  const keep = Math.max(0, Math.min(n / 2 - 1, Math.floor(maxHarmonic)));
  for (let k = keep + 1; k <= n / 2; k++) {
    re[k] = 0; im[k] = 0;
    const mirror = n - k;
    if (mirror > k && mirror < n) { re[mirror] = 0; im[mirror] = 0; }
  }
  fft(re, im, true);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i];
  return out;
}

/**
 * Builds one cycle from a harmonic series: `amplitudeOf(k)` for harmonic k (1 is the
 * fundamental), optionally with a phase per harmonic.
 *
 * This is how the shipped tables are made. Summing the series directly rather than sampling an
 * ideal shape matters: sampling an ideal square at 2048 points folds its harmonics above the
 * 1024th back down into the table, so the "perfect" waveform arrives already aliased and no
 * amount of band-limiting afterwards can get it back out.
 */
export function fromHarmonics(length, count, amplitudeOf, phaseOf = null) {
  const out = new Float32Array(length);
  const limit = Math.min(count, length / 2 - 1);
  for (let k = 1; k <= limit; k++) {
    const a = amplitudeOf(k);
    if (!a) continue;
    const ph = phaseOf ? phaseOf(k) : 0;
    const step = (2 * Math.PI * k) / length;
    for (let i = 0; i < length; i++) out[i] += a * Math.sin(step * i + ph);
  }
  return out;
}
