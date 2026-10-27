// A DJ deck's song, on its track: the player (see devices/song-reader.mjs) and the keylock.
//
// KEYLOCK is the player's read repitched - a faster rate is a higher pitch, as on a record - and
// then shifted back down by the same interval, which leaves the tempo moved and the key where it
// was. The shifter is the ported Signalsmith Stretch the Shift device is (its pitch half), and the
// desktop does exactly the same thing with Rubber Band. The shifter hears a whole analysis window
// before it says anything, so it is late by a fixed amount (SONG_LATENCY_SEC, measured at 0.12 s
// at every rate it runs at).
//
// So the plain path is made exactly as late, by a delay of the same length, and every song is
// heard that long after its player reads it. That is the trade: switching keylock on or off is
// a crossfade between two paths carrying the same moment of the song - no jump, no player swap -
// and in return everything the player is told has to be told that much early. The desk does
// that: it keeps its playhead model in HEARD time, and sends the player each event at the heard
// time less this latency (see the desk's song section).

import { normalize } from '../descriptor.mjs';

/** How long after the player reads a sample it is heard, on either path. The shifter's latency. */
export const SONG_LATENCY_SEC = 0.12;

/** The crossfade between the plain and the keylocked path. */
const KEYLOCK_XFADE_SEC = 0.03;

/** The transposition that undoes a playback rate: twelve semitones an octave, downward. */
export const keylockSemitones = (rate) => (rate > 0 ? -12 * Math.log2(rate) : 0);

export class SongPlayer {
  /**
   * @param engine the WebAudioEngine (for its context, its device builder and its warnings)
   * @param track  the track the song plays on: the player is its source
   */
  constructor(engine, track) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.track = track;
    const Ctor = engine.AudioWorkletNodeCtor;
    if (!Ctor) throw new Error('[web-engine] this build has no AudioWorkletNode, so it cannot play a song');
    this.node = new Ctor(this.ctx, 'poptart-song', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.addEventListener?.('processorerror', (event) => {
      engine._warnOnce(`processorerror:song:${track.id}`, `[web-engine] the song player failed on the audio thread${event?.message ? ` - ${event.message}` : ''}`);
    });
    this.delay = this.ctx.createDelay(1);
    this.delay.delayTime.value = SONG_LATENCY_SEC;
    this.plain = this.ctx.createGain();
    this.plain.gain.value = 1;
    this.keyed = this.ctx.createGain();
    this.keyed.gain.value = 0;
    this.node.connect(this.delay);
    this.delay.connect(this.plain);
    this.plain.connect(track.input);
    this.keyed.connect(track.input);
    this.shift = null;          // built the first time keylock is wanted
    this.keylock = false;
    this.rate = 1;
    this.queries = new Map();
    this.nextQuery = 1;
    this.node.port.onmessage = (event) => {
      const m = event.data;
      if (m?.kind !== 'pos') return;
      this.queries.get(m.id)?.(m);
      this.queries.delete(m.id);
    };
  }

  post(message, transfer) {
    try { this.node.port.postMessage(message, transfer ?? []); } catch { /* torn down */ }
  }

  /** Hands the song to the player: `planes` are 16-bit channels, transferred rather than copied. */
  load({ planes, frames }) {
    this.post({ kind: 'load', planes, frames }, planes.map((p) => p.buffer));
  }

  start(pos, rate, at, keylock) {
    this.rate = rate;
    this.setKeylock(!!keylock, at);
    this._pitch(rate, at);
    this.post({ kind: 'start', pos, rate, time: at });
  }

  seek(pos, at) { this.post({ kind: 'seek', pos, time: at }); }

  setRate(rate, at) {
    this.rate = rate;
    this._pitch(rate, at);
    this.post({ kind: 'rate', rate, time: at });
  }

  pause(at) { this.post({ kind: 'pause', time: at }); }

  stop(at, release) { this.post({ kind: 'stop', time: at, release }); }

  /** Crossfades onto the keylocked path, or back off it. */
  setKeylock(on, at) {
    if (on === this.keylock) return;
    if (on && !this._buildShift()) return;
    this.keylock = on;
    const now = this.ctx.currentTime;
    const when = Math.max(now, at ?? now);
    for (const [g, v] of [[this.keyed.gain, on ? 1 : 0], [this.plain.gain, on ? 0 : 1]]) {
      try {
        g.cancelScheduledValues(when);
        g.setValueAtTime(g.value, when);
        g.linearRampToValueAtTime(v, when + KEYLOCK_XFADE_SEC);
      } catch { g.value = v; }
    }
  }

  _buildShift() {
    if (this.shift) return true;
    const descriptor = this.engine.registry?.get?.('Shift');
    if (!descriptor) {
      this.engine._warnOnce('keylock:none', '[web-engine] keylock needs the Shift device, which this build does not have - the deck plays repitched');
      return false;
    }
    if (!this.engine.deviceModules?.get?.('Shift')) {
      this.engine._warnOnce('keylock:wasm', '[web-engine] keylock needs the Shift device\'s compiled part, which did not load - the deck plays repitched');
      return false;
    }
    let built;
    try {
      built = this.engine._buildDevice(descriptor);
    } catch (err) {
      this.engine._warnOnce('keylock:build', `[web-engine] keylock could not start - ${err?.message ?? err}`);
      return false;
    }
    const param = (id) => built.node.parameters?.get?.(id) ?? null;
    const spec = (id) => descriptor.params.find((p) => p.id === id);
    // Everything transposed back - partials above a tonality limit would keep the repitched
    // frequency, which is the one thing keylock is there to undo - and the formants with it.
    const tonality = param('tonality');
    if (tonality) tonality.value = normalize(spec('tonality'), 0);
    const formant = param('formant');
    if (formant) formant.value = normalize(spec('formant'), 0);
    this.shift = { built, pitch: param('pitch'), spec: spec('pitch') };
    this.node.connect(built.node);
    built.node.connect(this.keyed);
    this._pitch(this.rate, this.ctx.currentTime);
    return true;
  }

  _pitch(rate, at) {
    const p = this.shift?.pitch;
    if (!p) return;
    const value = normalize(this.shift.spec, keylockSemitones(rate));
    try { p.setValueAtTime(value, Math.max(this.ctx.currentTime, at ?? 0)); } catch { p.value = value; }
  }

  /** Where the player's read is right now and at what rate - for checking, not for the model. */
  query() {
    const id = this.nextQuery++;
    return new Promise((resolve) => {
      this.queries.set(id, resolve);
      this.post({ kind: 'query', id });
      setTimeout(() => { if (this.queries.delete(id)) resolve(null); }, 500);
    });
  }

  dispose() {
    this.post({ kind: 'free' });
    this.post({ kind: 'dispose' });
    this.shift?.built?.dispose?.();
    for (const n of [this.node, this.delay, this.plain, this.keyed]) {
      try { n.disconnect(); } catch { /* already detached */ }
    }
  }
}
