// A DJ deck's song, on its track: the player (see devices/song-reader.mjs).
//
// KEYLOCK is the reader's own: with it on, the song is read through the keylock (dsp/keylock.mjs),
// which moves the tempo and leaves the key where it was - the same stretcher the desktop's
// PoptartKeylock UGen runs. It reads the song itself and adds no latency, so a moment is heard
// when it is timed for whether keylock is on or off, and switching is a crossfade between the two
// reads at the playhead.
//
// Every time the player is given is when the moment is HEARD.

export class SongPlayer {
  /**
   * @param engine the WebAudioEngine (for its context and its warnings)
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
    this.node.connect(track.input);
    this.keylock = false;
    this.playing = false;
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
    this.keylock = !!keylock;
    this.post({ kind: 'start', pos, rate, time: at, keylock: this.keylock });
    this.playing = true;
  }

  seek(pos, at) { this.post({ kind: 'seek', pos, time: at }); }

  setRate(rate, at) {
    this.rate = rate;
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

  /** Crossfades onto the keylocked read, or back off it, at the playhead. */
  setKeylock(on, at) {
    if (!!on === this.keylock) return;
    this.keylock = !!on;
    this.post({ kind: 'keylock', on: this.keylock, time: at });
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
    this.post({ kind: 'free' });
    this.post({ kind: 'dispose' });
    try { this.node.disconnect(); } catch { /* already detached */ }
  }
}
