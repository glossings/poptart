'use strict';

// The id allocators: one for nodes, and a block allocator each for audio buses, control buses and
// buffers. Everything on the server gets its number here, so no two parts of the engine can hand
// out the same one.

/**
 * First-fit allocator over [lo, hi) with neighbors joined on free, the shape of the class
 * library's ContiguousBlockAllocator. Blocks are kept as a sorted list of free runs.
 */
class BlockAllocator {
  constructor(lo, hi) {
    this.lo = lo;
    this.hi = hi;
    this._free = hi > lo ? [{ start: lo, size: hi - lo }] : [];
    this._used = new Map(); // start -> size
  }

  /** The first index of a run of `n`, or null when no run that long is left. */
  alloc(n = 1) {
    n = Math.max(1, Math.trunc(n));
    for (let i = 0; i < this._free.length; i++) {
      const run = this._free[i];
      if (run.size < n) continue;
      const start = run.start;
      if (run.size === n) this._free.splice(i, 1);
      else { run.start += n; run.size -= n; }
      this._used.set(start, n);
      return start;
    }
    return null;
  }

  /** Gives a run back. Freeing an index twice, or one never handed out, does nothing. */
  free(start) {
    const size = this._used.get(start);
    if (size == null) return;
    this._used.delete(start);
    let i = 0;
    while (i < this._free.length && this._free[i].start < start) i++;
    this._free.splice(i, 0, { start, size });
    const next = this._free[i + 1];
    if (next && start + size === next.start) {
      this._free[i].size += next.size;
      this._free.splice(i + 1, 1);
    }
    const prev = this._free[i - 1];
    if (prev && prev.start + prev.size === start) {
      prev.size += this._free[i].size;
      this._free.splice(i, 1);
    }
  }

  isUsed(start) {
    return this._used.has(start);
  }

  get usedCount() {
    let n = 0;
    for (const s of this._used.values()) n += s;
    return n;
  }
}

/**
 * Node ids, counted upward from `lo` and wrapped at `hi`, as the class library's NodeIDAllocator
 * does: an id is not handed out again until the count has gone all the way round, so a late
 * message to a node that has just ended cannot land on a new one.
 */
class NodeIdAllocator {
  constructor(lo = 1000, hi = 0x3FFFFFFF) {
    this.lo = lo;
    this.hi = hi;
    this._next = lo;
  }

  alloc() {
    const id = this._next;
    this._next = this._next >= this.hi ? this.lo : this._next + 1;
    return id;
  }
}

module.exports = { BlockAllocator, NodeIdAllocator };
