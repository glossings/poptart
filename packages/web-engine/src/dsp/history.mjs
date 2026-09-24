// A short memory of what a device has been doing, for the pictures that scroll.
//
// A compressor's transfer curve says what the device would do to a level; the thing somebody
// setting one wants to see is what it HAS been doing for the last second - the level coming
// in, the gain being taken off, the pump of a ducker against the beat it is pumping to. That is
// a ring of one number per block, kept on the audio thread where the numbers are, and copied
// out whenever the device is asked to report.

/** How many blocks a ring holds: about two thirds of a second at the usual rate and block size. */
export const HISTORY_BLOCKS = 256;

export class History {
  constructor(size = HISTORY_BLOCKS, fill = 0) {
    this.buf = new Float32Array(size).fill(fill);
    this.at = 0;
  }

  push(v) {
    this.buf[this.at] = v;
    this.at = (this.at + 1) % this.buf.length;
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
