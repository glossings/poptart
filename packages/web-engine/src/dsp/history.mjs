// A short memory of what a device has been doing, for the pictures that scroll.
//
// A compressor's transfer curve says what the device would do to a level; the thing somebody
// setting one wants to see is what it HAS been doing for the last second - the level coming
// in, the gain being taken off, the pump of a ducker against the beat it is pumping to. That is
// a ring of one number per block, kept on the audio thread where the numbers are, and copied
// out whenever the device is asked to report.

/** How many blocks a ring holds: about two thirds of a second at the usual rate and block size. */
export const HISTORY_BLOCKS = 256;

/**
 * How many blocks a dynamics lane folds into one entry: about four seconds on the lane at the
 * usual rate. At one block an entry the lane was two thirds of a second, which is a close-up of
 * one hit rather than a picture of the pumping.
 */
export const DYNAMICS_BLOCKS_PER_ENTRY = 6;

export class History {
  /**
   * `per` blocks are folded into each entry, keeping the largest of them (`keep: 'max'`), the
   * smallest (`'min'`) or the last - a level wants its peak and a gain reduction its deepest
   * point, so a transient never falls between two entries and vanishes.
   */
  constructor(size = HISTORY_BLOCKS, fill = 0, { per = 1, keep = 'last' } = {}) {
    this.buf = new Float32Array(size).fill(fill);
    this.at = 0;
    this.per = Math.max(1, Math.round(per));
    this.keep = keep;
    this.count = 0;
    this.acc = 0;
    // How many entries have ever been written. A lane uses it to pin each entry to the same pixel
    // column for as long as it is on screen, so the picture moves in whole pixels as it scrolls.
    this.written = 0;
  }

  push(v) {
    if (this.count === 0) this.acc = v;
    else if (this.keep === 'max') this.acc = Math.max(this.acc, v);
    else if (this.keep === 'min') this.acc = Math.min(this.acc, v);
    else this.acc = v;
    this.count += 1;
    if (this.count < this.per) return;
    this.count = 0;
    this.buf[this.at] = this.acc;
    this.at = (this.at + 1) % this.buf.length;
    this.written += 1;
  }

  /**
   * Oldest first, newest last. A fresh array each time, because the answer is posted to
   * another thread - which is why a device builds it only when asked (see Reporter#tick).
   */
  snapshot() {
    const n = this.buf.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.buf[(this.at + i) % n];
    return out;
  }
}
