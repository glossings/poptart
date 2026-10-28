'use strict';

// What the editor's inline audio displays read - `.scope()`, `.spectrum()`, `.waveform()`,
// `.imager()` and `.meter()` - on the desktop engine.
//
// A VIEW TAP is a copy of one track's post-fader output (or of the master) kept in scsynth for as
// long as a display of it is on screen: a stereo ring buffer of its most recent samples, the ring's
// write position on a control bus, and - when a spectrum wants it - an FFT frame in a buffer of its
// own. sclang builds and frees them (see the view-tap section of sc/poptart.scd, or
// engine/view-taps.js on the node engine) and says where they are; reading them is done from HERE,
// straight from scsynth with /b_getn and /c_get, rather than having sclang forward every frame. sclang is the one thread every note passes through, and a
// display redrawn twenty-five times a second has no business in its queue. scsynth answers a
// /b_getn between two audio blocks in a few microseconds and replies to whoever asked.
//
// The cost on the audio thread is small and bounded: per tap, one bus read, a phasor, a buffer
// write and (for a spectrum) one 2048-point FFT every 1024 samples, for each track a display asks
// for, plus the master. Taps exist only while the editor is polling for them (see web-app's widgets
// section, which arms and disarms them), so a closed editor costs nothing.

/** How often the taps are read while armed: a little faster than the editor draws them. */
const POLL_MS = 40;

// Every request for a ring is cut into reads of this many floats: a reply carries its values plus a
// type tag per value, and two of these sit well under the ~9 KB a local UDP datagram may be on macOS.
const READ_CHUNK = 1024;

const round4 = (x) => Math.round(x * 1e4) / 1e4;
// A scope sample needs no more: the tallest display is a few hundred pixels.
const round3 = (x) => Math.round(x * 1e3) / 1e3;

class ViewTaps {
  /**
   * `sendSc(address, args)` reaches sclang; `sendScsynth(packet, port)` sends straight to scsynth on
   * its own port, whose replies come back to this process's socket and are handed to handle().
   */
  constructor({ sendSc, sendScsynth, now = () => Date.now() }) {
    this.sendSc = sendSc;
    this.sendScsynth = sendScsynth;
    this.now = now;
    this.taps = new Map(); // key ('*' or a track id) -> tap state, once sclang has said where it is
    this.byBuf = new Map(); // bufnum -> { tap, role: 'ring' | 'fft' }
    this.byBus = new Map(); // control bus index -> tap
    this.wanted = ''; // what sclang was last asked for, as sent
    this.timer = null;
    this.tick = 0;
  }

  /**
   * Arm the taps for `list` - `[{ id, fft }]`, where `id` is an engine track id or '*' for the
   * master - and disarm every other. Returns `{ armed, over }`: every id is armed, and `over` is
   * always empty (kept for callers). Idempotent: asking again for the same set sends nothing.
   */
  arm(list = []) {
    const seen = new Set();
    const armed = [];
    const over = [];
    const args = [];
    for (const want of list) {
      const id = String(want.id);
      if (seen.has(id)) continue;
      seen.add(id);
      armed.push(id);
      args.push(id, want.fft ? 1 : 0);
    }
    const key = args.join(' ');
    if (key !== this.wanted) {
      this.wanted = key;
      this.sendSc('/poptart/viewTaps', args);
    }
    for (const id of [...this.taps.keys()]) if (!seen.has(id) || over.includes(id)) this._forget(id);
    this._schedule();
    return { armed, over };
  }

  /** Forget everything without telling sclang - the engine it would tell is gone (a restart). */
  reset() {
    clearInterval(this.timer);
    this.timer = null;
    this.taps.clear();
    this.byBuf.clear();
    this.byBus.clear();
    this.wanted = '';
  }

  /** Ask sclang for the same taps again: after an engine restart it has none. */
  resend() {
    const was = this.wanted;
    this.wanted = '';
    if (was) this.sendSc('/poptart/viewTaps', was.split(' ').map((v, i) => (i % 2 ? Number(v) : v)));
    this.wanted = was;
  }

  /**
   * The latest frame of every armed tap: `{ [id]: { scope, spec, level } }`. `scope` is
   * `{ rate, l, r }`, the ring's samples oldest first at `rate` per second; `spec` is `{ binHz, db }`,
   * decibels per FFT bin from 0 Hz, where a full-scale sine reads 0; `level` is the peak and RMS of
   * each side of the scope window. A tap whose first frame has not arrived is absent.
   */
  read() {
    const out = {};
    for (const [id, tap] of this.taps) {
      const frame = {};
      if (tap.scope) {
        frame.scope = tap.scope;
        frame.level = tap.level;
      }
      if (tap.spec) frame.spec = tap.spec;
      if (Object.keys(frame).length) out[id] = frame;
    }
    return out;
  }

  /** Consumes the messages that belong to the taps; true when `msg` was one of them. */
  handle(msg) {
    const a = msg.address;
    if (a === '/b_setn') {
      const args = (msg.args ?? []).map((x) => x?.value ?? x);
      const hit = this.byBuf.get(Number(args[0]));
      if (!hit) return true;
      const start = Number(args[1]);
      const count = Number(args[2]);
      const into = hit.role === 'ring' ? hit.tap.ringData : hit.tap.fftData;
      for (let i = 0; i < count && start + i < into.length; i++) into[start + i] = Number(args[3 + i]);
      if (hit.role === 'fft' && start + count >= into.length) this._finishFft(hit.tap);
      return true;
    }
    if (a === '/c_set') {
      const args = (msg.args ?? []).map((x) => x?.value ?? x);
      const tap = this.byBus.get(Number(args[0]));
      if (tap) this._finishRing(tap, Number(args[1]));
      return true;
    }
    if (a === '/poptart/viewTap') {
      // [key, ringBuf, headBus, fftBuf (-1 for none), frames, decim, sampleRate, scsynthPort]
      const [key, ring, head, fft, frames, decim, sr, port] = (msg.args ?? []).map((x) => x?.value ?? x);
      this._adopt(String(key), { ring: Number(ring), head: Number(head), fft: Number(fft), frames: Number(frames), decim: Number(decim), sampleRate: Number(sr), port: Number(port) });
      return true;
    }
    if (a === '/poptart/viewTapGone') {
      const [key] = (msg.args ?? []).map((x) => x?.value ?? x);
      this._forget(String(key));
      return true;
    }
    if (a === '/fail') {
      // A read that raced a tap being freed. Nothing to do: the next arm settles it.
      const [cmd] = (msg.args ?? []).map((x) => x?.value ?? x);
      return cmd === '/b_getn' || cmd === '/c_get';
    }
    return false;
  }

  _adopt(id, where) {
    this._forget(id);
    const tap = {
      id,
      ...where,
      ringData: new Float32Array(where.frames * 2),
      fftData: where.fft >= 0 ? new Float32Array(2048) : null,
      scope: null,
      level: null,
      spec: null,
    };
    this.taps.set(id, tap);
    this.byBuf.set(tap.ring, { tap, role: 'ring' });
    if (tap.fft >= 0) this.byBuf.set(tap.fft, { tap, role: 'fft' });
    this.byBus.set(tap.head, tap);
    this._schedule();
  }

  _forget(id) {
    const tap = this.taps.get(id);
    if (!tap) return;
    this.taps.delete(id);
    if (this.byBuf.get(tap.ring)?.tap === tap) this.byBuf.delete(tap.ring);
    if (tap.fft >= 0 && this.byBuf.get(tap.fft)?.tap === tap) this.byBuf.delete(tap.fft);
    if (this.byBus.get(tap.head) === tap) this.byBus.delete(tap.head);
    this._schedule();
  }

  _schedule() {
    if (this.taps.size && !this.timer) {
      this.timer = setInterval(() => this._poll(), POLL_MS);
      this.timer.unref?.();
    } else if (!this.taps.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _poll() {
    this.tick++;
    for (const tap of this.taps.values()) {
      const total = tap.frames * 2;
      const packets = [];
      for (let start = 0; start < total; start += READ_CHUNK) {
        packets.push({ address: '/b_getn', args: [{ type: 'i', value: tap.ring }, { type: 'i', value: start }, { type: 'i', value: Math.min(READ_CHUNK, total - start) }] });
      }
      // The head last, in the same bundle: scsynth runs a bundle's commands together between two
      // blocks, so the head it reports is where the ring stood when the reads above were taken.
      packets.push({ address: '/c_get', args: [{ type: 'i', value: tap.head }] });
      // ...and the spectrum every other tick, which is as often as it changes enough to see.
      if (tap.fft >= 0 && this.tick % 2 === 0) {
        for (let start = 0; start < 2048; start += READ_CHUNK) {
          packets.push({ address: '/b_getn', args: [{ type: 'i', value: tap.fft }, { type: 'i', value: start }, { type: 'i', value: READ_CHUNK }] });
        }
      }
      try {
        this.sendScsynth({ timeTag: { raw: [0, 1] }, packets }, tap.port);
      } catch {
        // the engine is going down; reset() follows
      }
    }
  }

  _finishRing(tap, head) {
    const frames = tap.frames;
    const newest = ((Math.floor(head) % frames) + frames) % frames;
    const l = new Array(frames);
    const r = new Array(frames);
    let pl = 0;
    let pr = 0;
    let sl = 0;
    let sr = 0;
    for (let i = 0; i < frames; i++) {
      const at = (newest + 1 + i) % frames;
      const a = tap.ringData[at * 2];
      const b = tap.ringData[at * 2 + 1];
      l[i] = round3(a);
      r[i] = round3(b);
      const aa = Math.abs(a);
      const bb = Math.abs(b);
      if (aa > pl) pl = aa;
      if (bb > pr) pr = bb;
      sl += a * a;
      sr += b * b;
    }
    tap.scope = { rate: tap.sampleRate / tap.decim, l, r };
    tap.level = { pl: round4(pl), rl: round4(Math.sqrt(sl / frames)), pr: round4(pr), rr: round4(Math.sqrt(sr / frames)) };
  }

  _finishFft(tap) {
    tap.spec = { binHz: tap.sampleRate / 2048, db: fftDecibels(tap.fftData) };
  }
}

/**
 * Decibels per bin of a frame as scsynth's FFT leaves it: DC and Nyquist first, then a real and
 * an imaginary part per bin. Scaled so a full-scale sine reads 0 dB - a Hann window over N points
 * puts N/4 of a unit sine's amplitude into its bin - which is the scale the browser engine's
 * spectrum is put on as well, so one display reads the same on both.
 */
function fftDecibels(data) {
  const n = data.length;
  const half = n / 2;
  const ref = n / 4;
  const db = new Array(half);
  const dbOf = (mag) => Math.round(Math.max(-140, 20 * Math.log10(Math.max(1e-12, mag) / ref)) * 10) / 10;
  db[0] = dbOf(Math.abs(data[0]));
  for (let k = 1; k < half; k++) {
    const re = data[2 * k];
    const im = data[2 * k + 1];
    db[k] = dbOf(Math.sqrt(re * re + im * im));
  }
  return db;
}

module.exports = { ViewTaps, fftDecibels };
