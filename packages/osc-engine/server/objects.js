'use strict';

// Nodes, buses and buffers as objects, with the method names the class library gives them
// (Synth#set, Bus#setn, Buffer#free...), so the engine reads as the code it was ported from.
// Every one of these only sends; nothing here waits unless it returns a promise.

const ADD = { addToHead: 0, addToTail: 1, addBefore: 2, addAfter: 3, addReplace: 4 };

const idOf = (x) => (x && typeof x === 'object' ? (x.nodeID ?? x.index ?? x.bufnum) : x);

/** set/s_new style control pairs, an array value going out as /n_setn's run. */
function splitPairs(args) {
  const plain = [];
  const runs = [];
  for (let i = 0; i + 1 < args.length; i += 2) {
    const k = args[i];
    let v = args[i + 1];
    if (v && typeof v === 'object' && !Array.isArray(v)) v = idOf(v);
    if (Array.isArray(v)) runs.push([k, v.map((x) => Number(idOf(x)))]);
    else plain.push(k, typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  return { plain, runs };
}

class Node {
  constructor(server, nodeID) {
    this.server = server;
    this.nodeID = nodeID ?? server.nextNodeID();
  }

  set(...args) {
    const { plain, runs } = splitPairs(args);
    if (plain.length) this.server.send(['/n_set', this.nodeID, ...plain]);
    for (const [k, vs] of runs) this.server.send(['/n_setn', this.nodeID, k, vs.length, ...vs]);
  }

  setn(name, values) {
    this.server.send(['/n_setn', this.nodeID, name, values.length, ...values]);
  }

  free() {
    this.server.send(['/n_free', this.nodeID]);
  }

  run(flag = true) {
    this.server.send(['/n_run', this.nodeID, flag ? 1 : 0]);
  }

  /** map(name, bus, ...): a control bus (or a plain index) maps /n_mapn, an audio bus /n_mapan. */
  map(...args) {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const name = args[i];
      const bus = args[i + 1];
      if (bus && typeof bus === 'object' && bus.rate === 'audio') {
        this.server.send(['/n_mapan', this.nodeID, name, bus.index, bus.numChannels]);
      } else {
        const index = bus && typeof bus === 'object' ? bus.index : bus;
        const n = bus && typeof bus === 'object' ? bus.numChannels : 1;
        this.server.send(['/n_mapn', this.nodeID, name, index, n]);
      }
    }
  }

  moveBefore(other) { this.server.send(['/n_before', this.nodeID, idOf(other)]); }
  moveAfter(other) { this.server.send(['/n_after', this.nodeID, idOf(other)]); }
  moveToHead(group) { this.server.send(['/g_head', idOf(group), this.nodeID]); }
  moveToTail(group) { this.server.send(['/g_tail', idOf(group), this.nodeID]); }
}

class Group extends Node {
  /** Group.new(server, target, addAction), as the class library's (target defaults to the default group). */
  static new(server, target = null, addAction = 'addToHead') {
    const g = new Group(server);
    const t = target == null ? server.defaultGroup?.nodeID ?? 1 : idOf(target);
    server.send(['/g_new', g.nodeID, ADD[addAction] ?? 0, t]);
    return g;
  }

  static basicNew(server, nodeID) {
    return new Group(server, nodeID);
  }

  static before(target) { return Group.new(target.server, target, 'addBefore'); }
  static after(target) { return Group.new(target.server, target, 'addAfter'); }
  static head(target) { return Group.new(target.server, target, 'addToHead'); }
  static tail(target) { return Group.new(target.server, target, 'addToTail'); }

  freeAll() { this.server.send(['/g_freeAll', this.nodeID]); }
  deepFree() { this.server.send(['/g_deepFree', this.nodeID]); }
}

class Synth extends Node {
  constructor(server, defName, nodeID) {
    super(server, nodeID);
    this.defName = String(defName);
  }

  /** Synth.new: Synth.new(server, def, [name, value...], target, addAction). */
  static new(server, defName, args = [], target = null, addAction = 'addToHead') {
    const s = new Synth(server, defName);
    server.send(s.newMsg(target, args, addAction));
    s._afterNew(args);
    return s;
  }

  static basicNew(defName, server, nodeID) {
    return new Synth(server, defName, nodeID);
  }

  /** The /s_new message for this synth (array args are sent with /n_setn in the same bundle). */
  newMsg(target = null, args = [], addAction = 'addToHead') {
    const t = target == null ? this.server.defaultGroup?.nodeID ?? 1 : idOf(target);
    const { plain } = splitPairs(args);
    return ['/s_new', this.defName, this.nodeID, ADD[addAction] ?? 0, t, ...plain];
  }

  _afterNew(args) {
    const { runs } = splitPairs(args);
    for (const [k, vs] of runs) this.server.send(['/n_setn', this.nodeID, k, vs.length, ...vs]);
  }
}

class Bus {
  constructor(server, rate, index, numChannels) {
    this.server = server;
    this.rate = rate;
    this.index = index;
    this.numChannels = numChannels;
  }

  static audio(server, n = 1) {
    const index = server.audioBuses.alloc(n);
    if (index == null) throw Object.assign(new Error(`no audio buses left for ${n} channel(s)`), { code: 'NO_BUSES' });
    return new Bus(server, 'audio', index, n);
  }

  static control(server, n = 1) {
    const index = server.controlBuses.alloc(n);
    if (index == null) throw Object.assign(new Error(`no control buses left for ${n} channel(s)`), { code: 'NO_BUSES' });
    return new Bus(server, 'control', index, n);
  }

  free() {
    if (this.index == null) return;
    (this.rate === 'audio' ? this.server.audioBuses : this.server.controlBuses).free(this.index);
    this.index = null;
  }

  set(...values) {
    if (this.rate !== 'control') return;
    const msg = ['/c_set'];
    values.forEach((v, i) => msg.push(this.index + i, Number(v)));
    this.server.send(msg);
  }

  setn(values) {
    if (this.rate !== 'control') return;
    this.server.send(['/c_setn', this.index, values.length, ...values.map(Number)]);
  }

  /** Resolves with the bus's values (control rate). */
  get() {
    return this.server.request(['/c_getn', this.index, this.numChannels], '/c_setn', (a) => a[0] === this.index)
      .then((a) => a.slice(2));
  }

  asMap() {
    return this.rate === 'audio' ? `a${this.index}` : `c${this.index}`;
  }
}

class Buffer {
  constructor(server, bufnum) {
    this.server = server;
    this.bufnum = bufnum ?? server.buffers.alloc(1);
    if (this.bufnum == null) throw Object.assign(new Error('no buffer numbers left'), { code: 'NO_BUFFERS' });
    this.numFrames = null;
    this.numChannels = null;
    this.sampleRate = null;
    this.path = null;
  }

  /** Fills numFrames/numChannels/sampleRate from /b_info. */
  query() {
    return this.server.request(['/b_query', this.bufnum], '/b_info', (a) => a[0] === this.bufnum).then((a) => {
      this._info(a);
      return this;
    });
  }

  _info(a) {
    this.numFrames = a[1];
    this.numChannels = a[2];
    this.sampleRate = a[3];
  }

  _await(msg, completion) {
    // The completion /b_query's /b_info is what says the read is done (as Buffer.read does); a
    // failed read still answers it, with 0 frames.
    return new Promise((resolve) => {
      const off = this.server.on('/b_info', (a) => {
        if (a[0] !== this.bufnum) return;
        off();
        this._info(a);
        resolve(this);
      });
      this.server.send([...msg, completion]);
    });
  }

  /** Buffer.read: resolves with the buffer once it is read and queried. */
  static read(server, path, startFrame = 0, numFrames = -1, action = null) {
    const b = new Buffer(server);
    b.path = path;
    const done = b._await(['/b_allocRead', b.bufnum, String(path), startFrame, numFrames], ['/b_query', b.bufnum]);
    if (action) done.then(action);
    b.ready = done;
    return b;
  }

  static readChannel(server, path, startFrame = 0, numFrames = -1, channels = [0], action = null) {
    const b = new Buffer(server);
    b.path = path;
    const done = b._await(['/b_allocReadChannel', b.bufnum, String(path), startFrame, numFrames, ...channels], ['/b_query', b.bufnum]);
    if (action) done.then(action);
    b.ready = done;
    return b;
  }

  static alloc(server, numFrames, numChannels = 1, action = null) {
    const b = new Buffer(server);
    const done = b._await(['/b_alloc', b.bufnum, Math.trunc(numFrames), Math.trunc(numChannels)], ['/b_query', b.bufnum]);
    if (action) done.then(action);
    b.ready = done;
    return b;
  }

  /** Allocates a one-channel (or numChannels) buffer and writes `values` into it, in datagram-sized pieces. */
  static sendCollection(server, values, numChannels = 1, action = null) {
    const frames = Math.ceil(values.length / numChannels);
    const b = Buffer.alloc(server, frames, numChannels);
    b.ready = b.ready.then(async () => {
      await b.setnAll(values);
      await server.sync();
      return b;
    });
    if (action) b.ready.then(action);
    return b;
  }

  /** Writes values from sample 0 in /b_setn runs that each fit one datagram. */
  async setnAll(values, start = 0) {
    const chunk = 1600; // 1600 floats = 6.4KB, under the 9216-byte datagram
    for (let i = 0; i < values.length; i += chunk) {
      const part = values.slice(i, i + chunk).map(Number);
      this.server.send(['/b_setn', this.bufnum, start + i, part.length, ...part]);
    }
  }

  setn(start, values) {
    this.server.send(['/b_setn', this.bufnum, start, values.length, ...values.map(Number)]);
  }

  /** Buffer#write: header 'wav', sample 'float' etc; leaveOpen for DiskOut. */
  write(path, headerFormat = 'wav', sampleFormat = 'float', numFrames = -1, startFrame = 0, leaveOpen = false, completion = null) {
    const msg = ['/b_write', this.bufnum, String(path), headerFormat, sampleFormat, numFrames, startFrame, leaveOpen ? 1 : 0];
    if (completion) msg.push(completion);
    this.server.send(msg);
  }

  close(completion = null) {
    this.server.send(completion ? ['/b_close', this.bufnum, completion] : ['/b_close', this.bufnum]);
  }

  zero() { this.server.send(['/b_zero', this.bufnum]); }

  /** Frees the buffer on the server and gives its number back. */
  free(completion = null) {
    if (this.bufnum == null) return;
    this.server.send(completion ? ['/b_free', this.bufnum, completion] : ['/b_free', this.bufnum]);
    this.server.buffers.free(this.bufnum);
    this.bufnum = null;
  }

  /** Resolves with frames [start, start + count) of the buffer's samples. */
  async getn(start, count) {
    const out = [];
    const chunk = 1600;
    for (let at = start; at < start + count; at += chunk) {
      const n = Math.min(chunk, start + count - at);
      const a = await this.server.request(['/b_getn', this.bufnum, at, n], '/b_setn', (r) => r[0] === this.bufnum && r[1] === at);
      out.push(...a.slice(3));
    }
    return out;
  }
}

module.exports = { Node, Group, Synth, Bus, Buffer, ADD, idOf };
