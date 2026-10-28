// The audio routes between tracks and buses, and the delay that lets a feedback loop sound.
//
// The desktop orders its tracks by depth and drops the edge that closes a loop, so that read
// comes a block late (trackLevels in poptart.scd). Browsers differ on a loop with no DelayNode
// in it: Firefox mutes it, as the spec says, and Chrome plays it a render quantum late on an edge
// of its own choosing. So the edge that closes each loop, chosen as the desktop chooses it (a
// depth-first walk upstream from each track in turn, where an edge back onto the walk closes the
// loop), gets a DelayNode set to 0. Both then make it one render quantum, the browser's block:
// Firefox by holding a delay in a loop to that minimum, Chrome by breaking the loop there.
//
// A vertex is `t:<track id>` or `b:<bus name>`; null is a source outside the graph (a hardware
// input), which can close no loop.

export class RouteGraph {
  /**
   * @param ctx    the audio context
   * @param order  the track vertices in the order the walk starts from them
   */
  constructor(ctx, order = () => []) {
    this.ctx = ctx;
    this.order = order;
    this.edges = new Set();
  }

  /** Connects `from` to `to` as an edge from `src` to `dst`, delayed if it closes a loop. */
  link(from, to, { src = null, dst = null, output = 0, input = 0 } = {}) {
    const edge = { from, to, src, dst, output, input, delay: null, live: true };
    edge.unlink = () => this.unlink(edge);
    this._wire(edge);
    this.edges.add(edge);
    this.refresh();
    return edge;
  }

  unlink(edge) {
    if (!edge?.live) return;
    edge.live = false;
    this.edges.delete(edge);
    this._unwire(edge);
    this.refresh();
  }

  /** Drops every edge into or out of a vertex that is going away. */
  dropVertex(vertex) {
    let dropped = false;
    for (const edge of [...this.edges]) {
      if (edge.src !== vertex && edge.dst !== vertex) continue;
      edge.live = false;
      this.edges.delete(edge);
      this._unwire(edge);
      dropped = true;
    }
    if (dropped) this.refresh();
  }

  /** The edges that close a loop, found as the desktop finds them. */
  closingEdges() {
    const into = new Map();
    for (const edge of this.edges) {
      if (edge.src == null || edge.dst == null) continue;
      if (!into.has(edge.dst)) into.set(edge.dst, []);
      into.get(edge.dst).push(edge);
    }
    const back = new Set();
    const done = new Set();
    const walking = new Set();
    const visit = (v) => {
      walking.add(v);
      for (const edge of into.get(v) ?? []) {
        if (walking.has(edge.src)) back.add(edge);
        else if (!done.has(edge.src)) visit(edge.src);
      }
      walking.delete(v);
      done.add(v);
    };
    for (const v of this.order()) if (!done.has(v)) visit(v);
    // A loop through vertices no track reaches cannot happen (every loop holds a track), but a
    // walk from the rest keeps the graph cycle-free whatever is handed in.
    for (const v of into.keys()) if (!done.has(v)) visit(v);
    return back;
  }

  /** Puts the delay on each edge that closes a loop and takes it off each one that no longer does. */
  refresh() {
    const back = this.closingEdges();
    for (const edge of this.edges) {
      const want = back.has(edge);
      if (want === !!edge.delay) continue;
      this._unwire(edge);
      edge.delay = want ? this._delay() : null;
      this._wire(edge);
    }
  }

  _delay() {
    // Room for the one quantum a browser holds it to, at any sample rate.
    const node = this.ctx.createDelay(0.05);
    node.delayTime.value = 0;
    return node;
  }

  _wire(edge) {
    try {
      if (edge.delay) {
        edge.from.connect(edge.delay, edge.output);
        edge.delay.connect(edge.to, 0, edge.input);
      } else {
        edge.from.connect(edge.to, edge.output, edge.input);
      }
    } catch { /* a node already torn down */ }
  }

  _unwire(edge) {
    if (edge.delay) {
      try { edge.from.disconnect(edge.delay, edge.output); } catch { /* not connected */ }
      try { edge.delay.disconnect(); } catch { /* not connected */ }
      return;
    }
    try { edge.from.disconnect(edge.to, edge.output, edge.input); } catch { /* not connected */ }
  }
}
