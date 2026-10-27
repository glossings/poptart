// What the DJ desk needs from the audio graph beyond each track's own stage: the headphone cue,
// the headphone section's two knobs, and the decks' meters.
//
// THE CUE. Every track's stage sends its cue (or, for a monitored track, all of itself) into one
// stereo bus. The headphone section - the desktop's \poptart_headphones - blends that with the
// main mix and sets the level:
//
//   mix    0 = the cued decks only, 1 = the main mix only. Both are at full through the middle,
//          as on a hardware cue mix, so centered is the cue laid over the room.
//   level  the headphone volume, 0..1 on a squared law (the knob's travel reads as loudness),
//          1 = unity - nothing here can push the headphones past what the tracks sent.
//
// Where the result goes is a ROUTE, and there are two:
//
//   - a PAIR of the output the page already plays to (channels 3/4 of a four-output interface,
//     the jack on the front of a controller). Same device, same clock, no added delay. The
//     tracks' `.o(n)` then wraps below that pair, so nothing can be played into the headphones
//     by a pattern - the desktop caps its play channels at the cue offset for the same reason.
//   - a NODE somebody else carries away: the host hands in a stream destination and plays it on
//     a second device (see audio-output.mjs). Two devices are two clocks - tens of milliseconds
//     late and drifting apart - which is fine for pre-listening and nothing else.
//
// Without a route the cue still sums and goes nowhere, which is what a monitored track sounds
// like on a desktop with no cue pair: not heard.
//
// THE METERS. Each track reports its stage's output (post trim, EQ and filter, pre fader) into
// its deck's meter, the point the desktop's deck meters tap; a deck's level is read from there
// with its band balance, the way a song's file-analyzed waveform is colored. The master is read
// from the master. All of it is built only while the desk is open.

/** The band corners the deck meters' color split uses - the desktop's deck meter, and wav.js's. */
const BAND_LOW_HZ = 200;
const BAND_HIGH_HZ = 2000;
const METER_FFT = 2048;

export class DeskAudio {
  constructor(ctx, master) {
    this.ctx = ctx;
    this.master = master;
    const stereo = (node) => {
      node.channelCount = 2;
      node.channelCountMode = 'explicit';
      node.channelInterpretation = 'speakers';
      return node;
    };
    this.cueBus = stereo(ctx.createGain());
    this.deckMeters = [stereo(ctx.createGain()), stereo(ctx.createGain())];
    this.level = 1;
    this.mix = 0;
    this.cueAmt = ctx.createGain();
    this.mainAmt = ctx.createGain();
    this.hpLevel = stereo(ctx.createGain());
    this.cueBus.connect(this.cueAmt);
    this.cueAmt.connect(this.hpLevel);
    this.mainAmt.connect(this.hpLevel);
    this.out = this.hpLevel;            // the headphone signal, wherever the route takes it
    this.route = null;                  // { pair } | { node } | null
    this._routeNodes = [];
    this._mainNodes = [];
    this.outputChannels = 2;
    this._applyKnobs(true);
    this._wireMain();
    this.meters = null;
  }

  // -- the headphone section ------------------------------------------------------------------

  setHeadphones(level, mix) {
    if (Number.isFinite(level)) this.level = Math.min(1, Math.max(0, level));
    if (Number.isFinite(mix)) this.mix = Math.min(1, Math.max(0, mix));
    this._applyKnobs(false);
  }

  _applyKnobs(now) {
    const m = this.mix;
    const set = (param, v) => {
      if (now) { param.value = v; return; }
      const t = this.ctx.currentTime;
      try {
        param.cancelScheduledValues?.(t);
        param.setValueAtTime(param.value, t);
        param.linearRampToValueAtTime(v, t + 0.05);
      } catch { param.value = v; }
    };
    set(this.cueAmt.gain, Math.min(1, (1 - m) * 2));
    set(this.mainAmt.gain, Math.min(1, m * 2));
    set(this.hpLevel.gain, this.level * this.level);
  }

  /** The cue pair this route plays on, or null - what the tracks' `.o()` must wrap below. */
  get cuePair() {
    return this.route?.pair ?? null;
  }

  /**
   * The main mix as one stereo pair, for the headphones' mix knob: every output but the cue
   * pair, the even channels summed to the left and the odd to the right, the way the master
   * meter sums them. Re-wired when the output's channel count or the cue pair changes.
   */
  _wireMain() {
    for (const node of this._mainNodes) { try { node.disconnect(); } catch { /* gone */ } }
    try { this.master.disconnect(this.mainAmt); } catch { /* not connected */ }
    this._mainNodes = [];
    const n = this.outputChannels;
    if (n <= 2) {
      this.master.connect(this.mainAmt);
      return;
    }
    const split = this.ctx.createChannelSplitter(n);
    const merge = this.ctx.createChannelMerger(2);
    this.master.connect(split);
    const skip = this.cuePair;
    for (let c = 0; c < n; c++) {
      if (skip != null && Math.floor(c / 2) === skip) continue;
      split.connect(merge, c, c % 2);
    }
    merge.connect(this.mainAmt);
    this._mainNodes = [split, merge];
  }

  /** The output's channel count changed (see the engine's setOutputChannels). */
  setOutputChannels(n) {
    this.outputChannels = n;
    this._wireMain();
    if (this.route?.pair != null) this._wireRoute();
  }

  /**
   * Where the headphones go: `{ pair: p }` for the p-th stereo pair (from 0) of this output,
   * `{ node }` for a node the host carries to another device, null for nowhere.
   */
  setRoute(route) {
    this.route = route && (Number.isInteger(route.pair) || route.node) ? route : null;
    this._wireRoute();
    this._wireMain();
  }

  _wireRoute() {
    for (const node of this._routeNodes) { try { node.disconnect(); } catch { /* gone */ } }
    try { this.out.disconnect(); } catch { /* not connected */ }
    this._routeNodes = [];
    const r = this.route;
    if (!r) return;
    if (r.node) {
      this.out.connect(r.node);
      return;
    }
    const n = this.outputChannels;
    if (r.pair * 2 + 1 >= n) return; // the output does not have that pair (any more)
    const split = this.ctx.createChannelSplitter(2);
    const merge = this.ctx.createChannelMerger(n);
    merge.channelCountMode = 'explicit';
    merge.channelInterpretation = 'discrete';
    this.out.connect(split);
    split.connect(merge, 0, r.pair * 2);
    split.connect(merge, 1, r.pair * 2 + 1);
    merge.connect(this.ctx.destination);
    this._routeNodes = [split, merge];
  }

  // -- the deck meters ------------------------------------------------------------------------

  /** Builds or takes down the meters: they exist only while the desk is open. */
  setMeters(on) {
    if (!!on === !!this.meters) return;
    if (!on) {
      for (const node of this.meters.nodes) { try { node.disconnect(); } catch { /* gone */ } }
      for (const m of this.deckMeters) { try { m.disconnect(); } catch { /* gone */ } }
      try { this.master.disconnect(this.meters.masterSplit); } catch { /* gone */ }
      this.meters = null;
      return;
    }
    const nodes = [];
    const side = (from) => {
      const split = this.ctx.createChannelSplitter(2);
      const pair = [0, 1].map((c) => {
        const a = this.ctx.createAnalyser();
        a.fftSize = METER_FFT;
        a.smoothingTimeConstant = 0;
        split.connect(a, c);
        nodes.push(a);
        return a;
      });
      from.connect(split);
      nodes.push(split);
      return { split, pair };
    };
    const decks = this.deckMeters.map((m) => side(m));
    const master = side(this.master);
    this.meters = { decks, master, masterSplit: master.split, nodes, time: new Float32Array(METER_FFT), freq: null };
  }

  /**
   * One reading: each deck's { p, r, b } - peak, rms and the [low, mid, high] share of its
   * energy - and the master's { p, r }. Null while the meters are off.
   */
  read() {
    const m = this.meters;
    if (!m) return null;
    const level = ({ pair }) => {
      let peak = 0;
      let sum = 0;
      let count = 0;
      for (const a of pair) {
        if (typeof a.getFloatTimeDomainData !== 'function') continue;
        a.getFloatTimeDomainData(m.time);
        let s = 0;
        for (let i = 0; i < m.time.length; i++) {
          const v = m.time[i];
          const abs = v < 0 ? -v : v;
          if (abs > peak) peak = abs;
          s += v * v;
        }
        sum += s;
        count += m.time.length;
      }
      return { p: Math.round(peak * 1000) / 1000, r: count ? Math.round(Math.sqrt(sum / count) * 1000) / 1000 : 0 };
    };
    const bands = ({ pair }) => {
      const acc = [0, 0, 0];
      for (const a of pair) {
        if (typeof a.getFloatFrequencyData !== 'function') continue;
        m.freq ??= new Float32Array(a.frequencyBinCount);
        a.getFloatFrequencyData(m.freq);
        const hzPerBin = this.ctx.sampleRate / METER_FFT;
        for (let i = 1; i < m.freq.length; i++) {
          const db = m.freq[i];
          if (!Number.isFinite(db)) continue;
          const power = 10 ** (db / 10);
          const hz = i * hzPerBin;
          acc[hz < BAND_LOW_HZ ? 0 : hz < BAND_HIGH_HZ ? 1 : 2] += power;
        }
      }
      return bandShare(acc);
    };
    const [a, b] = m.decks;
    // When the sound this reading measured was played, on the engine's clock: an analyser holds
    // the last METER_FFT samples the context rendered, so the middle of that window. The editor
    // places the reading by this rather than by when it arrived (see client.js's djLiveTracePush).
    const t = this.ctx.currentTime - METER_FFT / 2 / this.ctx.sampleRate;
    return {
      a: { ...level(a), b: bands(a), t },
      b: { ...level(b), b: bands(b), t },
      m: level(m.master),
    };
  }
}

/**
 * Three band energies as shares of the total, two decimals - the form the desktop's deck meters
 * and a file's analyzed waveform both use, since one color function reads all three. Silence has
 * no balance and answers all mid, a neutral color.
 */
export function bandShare(acc) {
  const vals = acc.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = vals[0] + vals[1] + vals[2];
  if (total <= 1e-12) return [0, 1, 0];
  return vals.map((v) => Math.round((v / total) * 100) / 100);
}
