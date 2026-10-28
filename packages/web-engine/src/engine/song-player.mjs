// A DJ deck's song, on its track: the player (see devices/song-reader.mjs) and the keylock.
//
// KEYLOCK is the player's read repitched - a faster rate is a higher pitch, as on a record - and
// then shifted back down by the same interval, which leaves the tempo moved and the key where it
// was. The shifter is the ported Signalsmith Stretch the Shift device is (its pitch half), and the
// desktop does the same thing with Rubber Band. The shifter hears a whole analysis window before
// it says anything, so it is late by a fixed amount (SONG_LATENCY_SEC, measured at 0.12 s at
// every rate it runs at).
//
// Every time the player is given is when the moment is HEARD. With keylock off the song plays
// straight to the track, with nothing in the way and no shifter running. With keylock on, the
// player also reads the song that latency ahead, into the shifter, so the shifter's output lands
// on the same moment the plain read is at. Switching is a crossfade between the two, which carry
// the same moment of the song: no jump, and no drift. Switching on waits for the shifter to have
// heard enough of the read ahead (KEYLOCK_WARM_SEC); switching off is at once, and the shifter is
// let go once it is out of the mix.
//
// So a moment can be heard no sooner than the deck's `lead` from now - none with keylock off, the
// shifter's latency with it on. The desk sends each change for when it is to be heard, and asks
// the lead for anything it does "now" (see the desk's song section).

import { normalize } from '../descriptor.mjs';

/** How late the keylocked path is: the shifter's latency, and the most a song is ever late. */
export const SONG_LATENCY_SEC = 0.12;

/** The crossfade between the plain and the keylocked path. */
const KEYLOCK_XFADE_SEC = 0.03;

/**
 * How long the shifter hears the read ahead before it is listened to: its latency, and as much
 * again for its window to hold only the song and none of the silence before the read began.
 */
export const KEYLOCK_WARM_SEC = SONG_LATENCY_SEC * 2;

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
    this.node = new Ctor(this.ctx, 'poptart-song', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2] });
    this.node.addEventListener?.('processorerror', (event) => {
      engine._warnOnce(`processorerror:song:${track.id}`, `[web-engine] the song player failed on the audio thread${event?.message ? ` - ${event.message}` : ''}`);
    });
    this.plain = this.ctx.createGain();
    this.plain.gain.value = 1;
    this.keyed = this.ctx.createGain();
    this.keyed.gain.value = 0;
    this.node.connect(this.plain, 0);
    this.plain.connect(track.input);
    this.keyed.connect(track.input);
    this.shift = null;          // built while keylock is wanted, let go once it is not
    this.keylock = false;
    this.ahead = false;         // whether the player is reading ahead for the shifter
    this.warmFrom = 0;          // when it started to
    this.playing = false;
    this.rate = 1;
    this.releaseTimer = null;
    this.queries = new Map();
    this.nextQuery = 1;
    this.node.port.onmessage = (event) => {
      const m = event.data;
      if (m?.kind !== 'pos') return;
      this.queries.get(m.id)?.(m);
      this.queries.delete(m.id);
    };
  }

  /** How soon from now a change can be heard: none with keylock off, the shifter's latency on. */
  get lead() {
    return this.keylock ? SONG_LATENCY_SEC : 0;
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
    this.playing = true;
  }

  seek(pos, at) { this.post({ kind: 'seek', pos, time: at }); }

  setRate(rate, at) {
    this.rate = rate;
    this._pitch(rate, at);
    this.post({ kind: 'rate', rate, time: at });
  }

  pause(at) {
    this.playing = false;
    this.post({ kind: 'pause', time: at });
  }

  stop(at, release) {
    this.playing = false;
    this.post({ kind: 'stop', time: at, release });
  }

  /** Crossfades onto the keylocked path, or back off it. */
  setKeylock(on, at) {
    if (on === this.keylock) return;
    const now = this.ctx.currentTime;
    if (!on) {
      this.keylock = false;
      const when = Math.max(now, at ?? now);
      this._fade(false, when);
      clearTimeout(this.releaseTimer);
      this.releaseTimer = setTimeout(() => this._releaseShift(), (when - now + KEYLOCK_XFADE_SEC) * 1000 + 50);
      this.releaseTimer?.unref?.();
      return;
    }
    clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (!this._buildShift()) return;
    this.keylock = true;
    if (!this.ahead) {
      this.post({ kind: 'ahead', on: true, lead: SONG_LATENCY_SEC });
      this.ahead = true;
      this.warmFrom = now;
    }
    // A deck that is not sounding has nothing to wait for: the shifter starts from silence.
    const ready = this.playing ? this.warmFrom + KEYLOCK_WARM_SEC : now;
    this._fade(true, Math.max(now, ready, at ?? now));
  }

  _fade(on, when) {
    for (const [g, v] of [[this.keyed.gain, on ? 1 : 0], [this.plain.gain, on ? 0 : 1]]) {
      try {
        g.cancelScheduledValues(when);
        g.setValueAtTime(g.value, when);
        g.linearRampToValueAtTime(v, when + KEYLOCK_XFADE_SEC);
      } catch { g.value = v; }
    }
  }

  /** Once the keylocked path is out of the mix, the shifter and the read ahead stop. */
  _releaseShift() {
    this.releaseTimer = null;
    if (this.keylock) return;
    if (this.ahead) this.post({ kind: 'ahead', on: false });
    this.ahead = false;
    if (!this.shift) return;
    try { this.node.disconnect(this.shift.built.node); } catch { /* not connected */ }
    this.shift.built.dispose?.();
    this.shift = null;
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
    this.node.connect(built.node, 1);
    built.node.connect(this.keyed);
    this._pitch(this.rate, this.ctx.currentTime + SONG_LATENCY_SEC);
    return true;
  }

  /** The shifter's transposition, from when the read ahead takes the rate (a latency early). */
  _pitch(rate, at) {
    const p = this.shift?.pitch;
    if (!p) return;
    const value = normalize(this.shift.spec, keylockSemitones(rate));
    try { p.setValueAtTime(value, Math.max(this.ctx.currentTime, (at ?? 0) - SONG_LATENCY_SEC)); } catch { p.value = value; }
  }

  /** Where the song is heard right now and at what rate - for checking, not for the model. */
  query() {
    const id = this.nextQuery++;
    return new Promise((resolve) => {
      this.queries.set(id, resolve);
      this.post({ kind: 'query', id });
      setTimeout(() => { if (this.queries.delete(id)) resolve(null); }, 500);
    });
  }

  dispose() {
    clearTimeout(this.releaseTimer);
    this.post({ kind: 'free' });
    this.post({ kind: 'dispose' });
    this.shift?.built?.dispose?.();
    for (const n of [this.node, this.plain, this.keyed]) {
      try { n.disconnect(); } catch { /* already detached */ }
    }
  }
}
