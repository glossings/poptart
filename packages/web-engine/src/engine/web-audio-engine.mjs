// The browser engine: a Web Audio implementation of the interface pattern-core's Scheduler
// drives, in place of the OSC engine that talks to SuperCollider.
//
// The interface is documented at the top of scheduler.mjs and the contract is small but exact:
// everything is fire-and-forget except getTime(), every timed call carries an ABSOLUTE time on
// getTime()'s clock, and a note is identified by its pitch rather than by any handle - a
// note-off names a number, and matching it to what is sounding is the engine's problem.
//
// Two things make this easier here than it was there. getTime() is the AudioContext's own clock,
// so a scheduled time needs no conversion into a latency and no correction for drift between two
// clocks. And a parameter is an AudioParam, so a modulator is a connection rather than a message
// - which is what lets `.param("Osc 1 Phase", audio("mod"))` be a real patch cable.
//
// WHAT IS NOT HERE IN V1, and warns rather than failing silently: MIDI input routes, hardware
// audio input, and the channel-strip controls beyond gain, postgain, pan, dry and the per-slot
// wet. Each warns once, names what it dropped, and the rest of the track plays - a userland
// mistake warns and keeps playing, and so should a gap in the engine.

import { catalog as defaultCatalog } from '../catalog.mjs';
import { buildNodeDevice } from '../devices/builtins.mjs';
import { CROSSOVER } from '../devices/crossover.mjs';
import { defaultValues, denormalize, findParam, normalize } from '../descriptor.mjs';
import { decodeWav, framesOf } from '../dsp/wavfile.mjs';
import { buildMipmaps, powerOfTwoAtLeast, resampleFrame } from '../dsp/tables.mjs';
import { outlineOf } from '../dsp/outline.mjs';
import { compileExpr, exprConsts, exprInputCount, exprInputs, exprShape } from '../dsp/expr.mjs';
import { ViewTaps } from './view-taps.mjs';

// How long a sample name may stay unknown before it is said to be (see _unknownSource).
const UNKNOWN_SOURCE_GRACE_MS = 2000;
import { MIX_BAND_FREQS, MixAnalysis, SpectrumTap } from './analysis.mjs';
import { MidiRoutes } from './midi-routes.mjs';
import { detectOnsets, monoOf, planSample, sliceEntryFor } from './sample-plan.mjs';
import { EnvConnection, FeedConnection, LfoConnection } from './modulators.mjs';
import { GRAIN_CHANNEL_FIELDS, SUPPORTED_CHANNELS, Track, rampParam } from './track.mjs';
import { DeskAudio } from './desk-audio.mjs';
import { SONG_LATENCY_SEC, SongPlayer } from './song-player.mjs';
import { RouteGraph } from './route-graph.mjs';

const keyOf = (slot, name) => `${slot}:${name}`;

// An input of a parameter expression is addressed like a parameter of its own: `~i~name` is input
// i of the expression on `name`, on the same slot. Polled values and modulators aimed at it drive
// the input exactly as they would drive the parameter (see setParamExpr).
const LEAF_RE = /^~(\d+)~([\s\S]*)$/;
function leafOf(name) {
  const m = LEAF_RE.exec(String(name ?? ''));
  return m ? { i: Number(m[1]), name: m[2] } : null;
}

/**
 * The note a sample plays at unrepitched, when its pack does not say what pitch it holds.
 *
 * Sixty is c3 in poptart's spelling, and it is the same anchor the desktop sampler uses. The two
 * have to agree: a song written on one and played on the other would otherwise be in a different
 * key, which is the kind of difference nobody thinks to check for.
 */
const SAMPLER_ANCHOR = 60;

/** The tempo a device is told before the transport has said anything. */
const DEFAULT_BPM = 120;

/**
 * Splits `"pack:key"` into its pack and the file it names - by index or by name. A name is
 * matched with or without its extension, so `"files:kick"` finds `kick.wav`.
 */
export function parseSampleRef(ref) {
  const text = String(ref ?? '').trim();
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const pack = text.slice(0, at).trim();
  const key = text.slice(at + 1).trim();
  if (!pack || !key) return null;
  return { pack: pack.startsWith('sp:') ? pack.slice(3) : pack, key };
}

// A captured program is an opaque base64 string wherever it comes from - a plugin's own bytes on
// the desktop, a parameter map here. That is not decoration: the editor writes one into the code
// as a `_preset(...)` definition and folds it down to a chip, and it knows a program by the shape
// of it. A device that filed its state as readable JSON instead would put a paragraph of escaped
// quotes across the buffer where every other captured sound is one word wide.

/** JSON to the blob a preset definition holds. */
function encodeState(json) {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** And back. A state that is plainly JSON is taken as it is, so one typed by hand still loads. */
function decodeState(text) {
  const s = String(text).trim();
  if (s.startsWith('{')) return s;
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** How many points a drawn shape is sampled into before it reaches a device. */
const SHAPE_POINTS = 256;

/**
 * Reversed copies of sample buffers, so a negative speed plays backwards.
 *
 * A buffer source cannot do this itself. The spec allows a negative playbackRate, but no browser
 * renders one - it goes silent - while the desktop sampler is a PlayBuf, which reads backwards
 * natively. So a song written with `speed("-1")` has to be played here by reversing the audio and
 * reading it forwards, with the window mirrored to match.
 *
 * Keyed weakly on the buffer the store handed out, so a reversed copy lives exactly as long as
 * the sample it came from and every later event on that sample reuses it rather than copying a
 * few megabytes again per note.
 */
const reversedBuffers = new WeakMap();

function reversedBuffer(ctx, buffer) {
  const had = reversedBuffers.get(buffer);
  if (had) return had;
  if (typeof buffer.getChannelData !== 'function' || typeof ctx.createBuffer !== 'function') return null;
  const copy = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const from = buffer.getChannelData(ch);
    const to = copy.getChannelData(ch);
    for (let i = 0, j = from.length - 1; j >= 0; i++, j--) to[i] = from[j];
  }
  reversedBuffers.set(buffer, copy);
  return copy;
}

const pingPongBuffers = new WeakMap();

/**
 * A loop window forwards and then backwards, as one buffer - what a ping-pong loop plays, since
 * a buffer source can only loop one way. Cached per buffer and window.
 */
function pingPongBuffer(ctx, buffer, lo, hi) {
  if (typeof buffer.getChannelData !== 'function' || typeof ctx.createBuffer !== 'function') return null;
  const key = `${lo}:${hi}`;
  let byWindow = pingPongBuffers.get(buffer);
  if (!byWindow) pingPongBuffers.set(buffer, (byWindow = new Map()));
  if (byWindow.has(key)) return byWindow.get(key);
  const from = Math.floor(lo * buffer.length);
  const to = Math.max(from + 2, Math.floor(hi * buffer.length));
  const n = to - from;
  const out = ctx.createBuffer(buffer.numberOfChannels, n * 2, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < n; i++) { dst[i] = src[from + i] ?? 0; dst[2 * n - 1 - i] = src[from + i] ?? 0; }
  }
  const made = { buffer: out, span: n / buffer.sampleRate };
  byWindow.set(key, made);
  return made;
}

export class WebAudioEngine {
  /**
   * @param {BaseAudioContext} ctx
   * @param {object} options
   *   `registry`  - the device catalog to resolve names against (defaults to the shipped one)
   *   `samples`   - the host's decoded sample store: { get(pack, index) -> AudioBuffer|null },
   *                 optionally with indexOf(pack, key) and bytes(pack, index) for the devices
   *                 that load a file whole
   *   `warn`      - where a "this engine cannot do that" line goes; defaults to the console
   *   `AudioWorkletNode` - the constructor to build worklet devices with; defaults to the
   *                 global one. Named so a test can hand in a stand-in, since there is no Web
   *                 Audio outside a browser and booting one to check the wiring would prove less
   *                 than reading it does.
   */
  constructor(ctx, {
    registry = defaultCatalog,
    samples = null,
    warn = null,
    AudioWorkletNode = null,
    // deviceId -> WebAssembly.Module, for the devices whose DSP is compiled. Handed in rather
    // than loaded here because loading is asynchronous and building a device is not.
    deviceModules = null,
    // How a drawn curve is read: pattern-core's own parser and sampler, for the controls that
    // take one (see _loadShapeParam). Handed in rather than imported for the same reason the
    // sample store is - this package is the engine adapter and depends on nothing but the
    // browser, and the page is where the two meet. A window drawn in the shape editor and a
    // window played by a synth have to be the same curve, which is only true if there is one
    // piece of code that says what the curve is.
    shapes = null,
    // How long a route naming a track or bus that does not exist yet waits before it is said to
    // name nothing (see _route). Long enough for one evaluation to build every track in it.
    routeWaitMs = 2000,
  } = {}) {
    this.routeWaitMs = routeWaitMs;
    this.ctx = ctx;
    this.registry = registry;
    this.samples = samples;
    this.shapeReader = shapes;
    this.deviceModules = deviceModules;
    this.AudioWorkletNodeCtor = AudioWorkletNode ?? globalThis.AudioWorkletNode;
    // eslint-disable-next-line no-console
    this.warn = warn ?? ((line) => console.warn(line));

    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    // How many output channels the page plays to - two until somebody asks for more, and never
    // more than the device takes. `.o(n)` picks a stereo pair among them, wrapping at the count.
    this.outputChannels = 2;

    this.tracks = new Map();        // trackId -> Track
    this.buses = new Map();         // bus name -> GainNode
    this.modulators = new Map();    // trackId -> Map("slot:name" -> connection)
    this.exprs = new Map();         // trackId -> Map("slot:name" -> parameter expression, see setParamExpr)
    this.envelopes = new Map();     // trackId -> Map("slot:name" -> EnvConnection), gated per note
    this.feeds = new Map();         // "device|cc" or "osc:address" -> Set(FeedConnection)
    this.held = new Map();          // trackId -> how many of its notes are held, which gates its env()s
    this.sounding = new Map();      // trackId -> Map("slot:note" -> the time its off is due; Infinity until sent)
    this.voices = new Map();        // trackId -> Set of sample voices still to finish (see _voice)
    this._hw = null;                // the open hardware inputs: { node, splitter, channels }
    this._taps = new Map();         // track id ('*' for the master) -> recorder tap
    this._transients = new WeakMap(); // AudioBuffer -> slice starts (undefined while working, null for none)
    this._hwRoutes = new Map();     // "head|track" / "side|track|slot" -> { chans, wire, dispose }
    this._waiting = new Map();      // "head|track" / "side|track|slot" / "param|track|slot:name" -> { name, wire }
    this.warned = new Set();
    this.workletsReady = false;
    // Label to track id. A pattern names another track the way somebody wrote it - audio("kick")
    // - and this engine keys its tracks by the id the host made for that label, so without
    // something in between every cross-track route finds nothing and warns about a name that is
    // plainly right there in the buffer. The desktop puts this in the wrapper around its engine;
    // here the host installs it directly. See setTrackResolver.
    this.resolveTrack = null;
    // Notes from one track played on another: `midi("a")` as a track's source, and `.midi("a")`
    // into an effect that takes notes. See midi-routes.mjs, which has the desktop's rules.
    this.midiRoutes = new MidiRoutes({
      deliver: (on, trackId, slot, note, velocity, atTime) => this._deliverRouted(on, trackId, slot, note, velocity, atTime),
      resolve: (name) => this.resolveTrack?.(name) ?? name,
    });
    this.bpm = DEFAULT_BPM;
    this.trackTempo = new Map();    // trackId -> { bpm, anchorSec } for a deck on a clock of its own
    // Where a beat falls on the context's clock: the time cycle zero was at. The devices on the
    // grid count from it.
    this.anchorSec = 0;
    // The meters and plots, built only while the mixer is open.
    this.analysis = new MixAnalysis(ctx, this.master);
    // The DJ desk's half of the graph: the headphone cue and the deck meters (see desk-audio.mjs).
    this.desk = new DeskAudio(ctx, this.master);
    this.songs = new Map();         // trackId -> SongPlayer, for a track a DJ deck plays a song on
    // Every route between tracks and buses, so a feedback loop gets the delay it needs to sound.
    this.routes = new RouteGraph(ctx, () => [...this.tracks.keys()].map((id) => `t:${id}`));
    // ...and what the editor's inline displays read (.scope(), .spectrum(), ...), while they are drawn.
    this.views = new ViewTaps(ctx, (id) => (id === '*' ? this.master : this.tracks.get(id)?.panner ?? null));
  }

  // -- what the editor's inline displays read ---------------------------------------------------

  /**
   * Arm a view tap on each of `list` - `[{ id, fft }]`, a track id or '*' for the master, `fft`
   * when a spectrum is drawn of it - and drop the rest. Returns `{ armed, over }`; see view-taps.mjs.
   */
  viewTaps(list) {
    return this.views.arm(list);
  }

  /** The latest frame of every armed view tap: `{ [id]: { scope, level, spec? } }`. */
  viewRead() {
    return this.views.read();
  }


  // -- what the mixer reads -----------------------------------------------------------------

  /** The band centers the plots are drawn at, lowest first. */
  mixBandFreqs() {
    return [...MIX_BAND_FREQS];
  }

  /** Turns the analysis on or off. Off takes every tap out of the graph. */
  setMixMonitor(on) {
    return this.analysis.setMonitor(on);
  }

  /**
   * One reading for the mixer: a level and a band frame per strip, and the same for the master
   * under '*'.
   *
   * `ids` is what the panel is showing, in its own order; each gets an analyzer of its own.
   */
  mixRead(ids = []) {
    const wanted = ids.filter((id) => this.tracks.has(id));
    const sources = new Map();
    sources.set('*', this.master);
    for (const id of wanted) sources.set(id, this.tracks.get(id).panner);
    const { levels, spec } = this.analysis.read(sources);
    return { on: this.analysis.on, levels, spec };
  }

  /** The scheduling clock. Every timed argument the scheduler passes is on this. */
  getTime() {
    return this.ctx.currentTime;
  }

  /**
   * The rate the context actually runs at, which is the hardware's and not a number we choose.
   *
   * Exposed because the figures are drawn from the same DSP that plays: a response curve prewarps
   * its frequencies by the sample rate, so a curve computed at an assumed 48 kHz and played at
   * 44.1 marks the corner in the wrong place - a few percent low down, several near the top.
   */
  get sampleRate() {
    return this.ctx.sampleRate;
  }

  version() {
    return '0.1.2-web';
  }

  /**
   * A name the sample store has never heard of - `s("zz")`, a matrix() row naming a sound that
   * is not here - plays nothing, and says so once. Only once it has stayed unknown for a moment:
   * a pack read from a repository has no manifest until its fetch lands, and a name in it is not
   * a mistake for that second.
   */
  _unknownSource(name) {
    if (typeof name !== 'string' || !name || typeof this.samples?.knows !== 'function') return;
    if (/^(?:file|rec|say):/.test(name) || this.samples.knows(name)) return;
    this._unknownSince ??= new Map();
    const now = Date.now();
    const since = this._unknownSince.get(name) ?? now;
    this._unknownSince.set(name, since);
    if (now - since >= UNKNOWN_SOURCE_GRACE_MS) {
      this._warnOnce(`source:${name}`, `[web-engine] there is no sound called ${JSON.stringify(name)} here - it plays nothing.`);
    }
  }

  /** Says a thing this engine cannot do, once per distinct thing. */
  _warnOnce(key, line) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(line);
  }

  // -- tracks ------------------------------------------------------------------------------

  /**
   * Idempotent, as the scheduler requires - it calls this on every evaluation. `initial` is the
   * channel state a track has to wear from its first sample (the performance mixer's "born
   * silent"), which on the desktop side has to ride the creation because a plain set sent while
   * the track is still being built is dropped. Here the graph exists the moment it is built, so
   * the values are simply applied.
   */
  createTrack(trackId, initial = null) {
    let track = this.tracks.get(trackId);
    if (!track) {
      track = new Track(this.ctx, trackId, this.master, this.registry, this.desk);
      // A .bands() crossover: the engine's own device, never a slot of the track's chain.
      track.makeCrossover = () => this._buildDevice(CROSSOVER);
      this.tracks.set(trackId, track);
      this.modulators.set(trackId, new Map());
      this.envelopes.set(trackId, new Map());
      this._wakeRoutes();
    }
    if (initial) {
      const now = this.getTime();
      for (const [name, value] of Object.entries(initial)) track.setChannel(name, value, now, now);
    }
    return track;
  }

  /**
   * Takes a track down completely: everything wired into it and everything it started, not only
   * its own nodes. What is left behind here makes no sound and raises no error - a bus still
   * feeding a gain nobody reads, a bend constant running for the life of the page, a route that
   * plays notes into an id a later track may be given - so the whole list is spelled out.
   */
  destroyTrack(trackId) {
    const track = this.tracks.get(trackId);
    if (!track) return;
    const now = this.getTime();
    this._clearAllModulators(trackId);
    for (const rec of this.exprs.get(trackId)?.values() ?? []) this._disposeExpr(trackId, rec, false);
    this.exprs.delete(trackId);
    for (const key of [...this._waiting.keys()]) if (key.split('|')[1] === trackId) this._waiting.delete(key);
    // What reads into it: the head input (a bus, another track, a hardware input) and the
    // hardware routes into its sidechains.
    this.clearInputSource(trackId);
    for (const key of [...this._hwRoutes.keys()]) {
      if (key.startsWith(`side|${trackId}|`)) this._dropHardware(key);
    }
    // The routes played INTO it are dropped, and what they hold released; notes it routed into
    // other tracks are released there, since the offs that would have ended them come from here.
    for (const route of this.midiRoutes.routes.filter((r) => r.targetTrackId === trackId)) {
      this.midiRoutes.remove(trackId, route.slot, now);
    }
    this.midiRoutes.releaseFrom(trackId, now);
    // A record-panel meter or a bounce in progress on it.
    const tap = this._taps.get(trackId);
    if (tap) {
      for (const take of tap.takes.values()) take.reject(new Error(`track "${trackId}" was removed`));
      tap.takes.clear();
      tap.metering = false;
      this._untapIfIdle(trackId);
    }
    for (const voice of this.voices.get(trackId) ?? []) voice.release(now, 0.005);
    this.songFree(trackId);
    track.dispose();
    for (const node of track._outNodes ?? []) { try { node.disconnect(); } catch { /* gone */ } }
    this.tracks.delete(trackId);
    this.modulators.delete(trackId);
    this.envelopes.delete(trackId);
    this.held.delete(trackId);
    this.sounding.delete(trackId);
    this.voices.delete(trackId);
    this.routes.dropVertex(`t:${trackId}`);
    // Last, once the name no longer answers: what it fed goes back to waiting for it.
    this._orphanRoutesFrom(trackId, track.panner);
  }

  // -- devices -----------------------------------------------------------------------------

  /**
   * Builds the node graph for one device. A stock-node device is wired here; anything else is an
   * AudioWorkletNode named by its descriptor, which must already have been registered (see
   * `loadWorklets`).
   */
  _buildDevice(descriptor) {
    if (descriptor.build === 'nodes') return buildNodeDevice(descriptor, this.ctx);
    if (!this.AudioWorkletNodeCtor) {
      throw new Error('[web-engine] this build has no AudioWorkletNode, so it cannot host the devices poptart wrote itself');
    }
    // A ported device's DSP is a compiled binary rather than JavaScript, and the processor
    // cannot fetch it: a constructor may not await, and a worklet has no network. So the page
    // compiles each one before any device is built and the module rides in with the options -
    // a WebAssembly.Module is structured-cloneable, which is what makes that possible.
    let wasmModule = null;
    if (descriptor.build === 'wasm') {
      wasmModule = this.deviceModules?.get?.(descriptor.id) ?? null;
      if (!wasmModule) {
        this._warnOnce(
          `wasm:${descriptor.id}`,
          `[web-engine] the compiled part of "${descriptor.id}" was not loaded, so it passes silence. It is public/devices/${descriptor.id}.wasm.`,
        );
      }
    }
    const inputs = (descriptor.channels.in > 0 ? 1 : 0) + (descriptor.sidechain || descriptor.channels.key ? 1 : 0);
    const outputs = descriptor.channels.outputs ?? 1;
    const node = new this.AudioWorkletNodeCtor(this.ctx, descriptor.processor, {
      numberOfInputs: inputs,
      numberOfOutputs: outputs,
      outputChannelCount: Array.from({ length: outputs }, () => descriptor.channels.out),
      processorOptions: {
        descriptor: descriptor.id,
        version: descriptor.version,
        sampleRate: this.ctx.sampleRate,
        bpm: this.bpm,
        anchorSec: this.anchorSec,
        ...(wasmModule ? { module: wasmModule } : {}),
      },
    });
    // A processor that throws - in its constructor or inside process() - is silent from then
    // on, and the browser tells nobody but this listener. Without it a device that dies on
    // the rendering thread is indistinguishable from one that was never asked to play.
    if (typeof node.addEventListener === 'function') {
      node.addEventListener('processorerror', (event) => {
        this._warnOnce(
          `processorerror:${descriptor.id}`,
          `[web-engine] "${descriptor.id}" failed on the audio thread and is silent until the page is reloaded${event?.message ? ` - ${event.message}` : ''}. Its worklet is public/worklets/${descriptor.build === 'wasm' ? 'poptart-wasm' : descriptor.kind === 'synth' ? 'poptart-synths' : 'poptart-effects'}.js.`,
        );
      });
    }
    return {
      node,
      input: node,
      output: node,
      params: Object.fromEntries(
        descriptor.params
          .filter((p) => p.rate === 'a' && node.parameters?.get?.(p.id))
          .map((p) => [p.id, node.parameters.get(p.id)]),
      ),
      set(id, value) {
        const param = node.parameters?.get?.(id);
        if (param) param.value = value;
        else node.port?.postMessage?.({ kind: 'param', id, value });
      },
      dispose() {
        // A processor is kept alive for as long as it returns true from process(), whether or
        // not anything is still connected to it. Disconnecting a node is therefore NOT how a
        // device is reclaimed: a replaced synth would go on rendering its voices, unheard, for
        // the life of the page, and a set that swaps devices a few times an hour would end it
        // with dozens of them. Telling the processor to stop is the only way out, so it is told
        // first and unwired second.
        try { node.port?.postMessage?.({ kind: 'dispose' }); } catch { /* no port to tell */ }
        try { node.disconnect(); } catch { /* already detached */ }
      },
    };
  }

  _load(trackId, deviceId, slot, kind) {
    const track = this.createTrack(trackId);
    const descriptor = this.registry.get(deviceId);
    if (!descriptor) {
      this._warnOnce(`missing:${deviceId}`, `[web-engine] there is no device called "${deviceId}" in this build, so ${kind === 'synth' ? 'the track' : 'that slot'} is silent.`);
      track.clearSlot(slot);
      return null;
    }
    if (descriptor.kind !== kind) {
      this._warnOnce(`kind:${deviceId}`, `[web-engine] "${descriptor.id}" is ${descriptor.kind === 'synth' ? 'an instrument' : 'an effect'}, so it cannot go where ${kind === 'synth' ? 'an instrument' : 'an effect'} belongs.`);
      return null;
    }
    const existing = track.slots.get(slot);
    if (existing?.descriptor.id === descriptor.id && existing.descriptor.version === descriptor.version) return existing;
    // Whatever was driving the old device's parameters is taken down BEFORE the new one is
    // built and put back afterwards, by name: a `.param("Cutoff", lfo(…))` written against
    // the slot follows a device swap, and a name the new device does not have warns the way an
    // unknown name always does. The scheduler does not re-send an unchanged modulator on a
    // re-evaluation, so a swap that dropped them would leave them dropped.
    const carried = this._takeSlot(trackId, slot);
    // A device that cannot be built costs that device and nothing else. It throws from deep in
    // the browser - an unregistered processor name, a worklet that did not load - and the call
    // above it is the scheduler's setPattern, in the middle of an evaluation: letting it out
    // takes down every track in the buffer over one bad slot, and says so in a sentence about
    // a processor rather than about a device somebody named.
    let built;
    try {
      built = this._buildDevice(descriptor);
    } catch (err) {
      this._warnOnce(
        `build:${descriptor.id}`,
        `[web-engine] "${descriptor.id}" could not be built, so ${kind === 'synth' ? 'this track has no instrument' : 'that slot is empty'} - ${err?.message ?? err}`,
      );
      track.clearSlot(slot);
      return null;
    }
    const placed = track.setSlot(slot, descriptor, built);
    this._listen(trackId, slot, placed);
    // A device built on a track whose deck runs at its own tempo starts at that tempo.
    const own = this.trackTempo.get(trackId);
    if (own) { try { built.node?.port?.postMessage?.({ kind: 'tempo', ...own }); } catch { /* no port */ } }
    const now = this.getTime();
    for (const [id, value] of Object.entries(defaultValues(descriptor))) {
      track.setParamValue(slot, id, value, now, now);
    }
    for (const { method, name, ir } of carried.modulators) this[method](trackId, slot, name, ir);
    for (const rec of this.exprs.get(trackId)?.values() ?? []) {
      if (rec.slot === slot && rec.node) this._attachExprOutput(trackId, rec);
    }
    if (carried.sidechain) this.injectAudio(trackId, slot, carried.sidechain);
    return placed;
  }

  /**
   * Hears what a processor says back: the positions it last read, while a panel watches it.
   * Kept on the slot, so the answer to "where is that control right now" is a lookup.
   */
  _listen(trackId, slot, placed) {
    const port = placed.built.node?.port;
    if (!port || typeof port.addEventListener !== 'function' && !('onmessage' in port)) return;
    const handler = (event) => {
      const message = event?.data;
      if (message?.kind !== 'values') return;
      if (message.values) placed.live = message.values;
      // What the device is DOING, as opposed to where its controls are: a granulator's grains.
      placed.report = message.report ?? null;
    };
    if (typeof port.addEventListener === 'function') port.addEventListener('message', handler);
    else port.onmessage = handler;
    if (typeof port.start === 'function') port.start();
  }

  /**
   * Takes everything driving one slot out of the graph and says what it was: the modulators
   * (with the method that programmed each, so it can be programmed again), the signals patched
   * onto parameters, and the sidechain feeding it.
   */
  _takeSlot(trackId, slot) {
    const prefix = `${slot}:`;
    const modulators = [];
    for (const [key, conn] of [...(this.modulators.get(trackId) ?? [])]) {
      if (!key.startsWith(prefix)) continue;
      // An expression's inputs belong to the expression, not to the device: they stay as they are.
      if (leafOf(key.slice(prefix.length))) continue;
      modulators.push({ method: conn.method, name: key.slice(prefix.length), ir: conn.ir });
      this._clearModulator(trackId, slot, key.slice(prefix.length));
    }
    const track = this.tracks.get(trackId);
    // An expression on the slot lets go of the old device's parameter and is pointed at the new
    // one's once it is built.
    for (const rec of this.exprs.get(trackId)?.values() ?? []) {
      if (rec.slot !== slot || !rec.node) continue;
      try { rec.node.disconnect(); } catch { /* not connected */ }
      rec.target = null;
    }
    const sidechain = track?.sidechains.get(slot)?.source ?? null;
    track?.clearSidechain(slot);
    return { modulators, sidechain };
  }

  loadInstrument(trackId, deviceId) {
    this._load(trackId, deviceId, 0, 'synth');
  }

  loadEffect(trackId, deviceId, position) {
    this._load(trackId, deviceId, position, 'fx');
  }

  unloadEffect(trackId, slot) {
    if (!this.tracks.has(trackId)) return;
    this._takeSlot(trackId, slot);
    this.tracks.get(trackId).clearSlot(slot);
  }

  /**
   * Wires a track's chain by a routing plan - the branches of .split() and the bands of .bands()
   * (pattern-core's route.mjs) - or back to the plain line with null. One track either way: the
   * branch devices are this track's slots (each crossover of a .bands() a Crossover device), and
   * the levels and pans are its channel controls (rl/rp), driven by setParam and the modulators
   * like the rest of the strip.
   */
  setRouting(trackId, plan) {
    const track = this.createTrack(trackId);
    try {
      track.setRouting(plan && typeof plan === 'object' ? plan : null);
    } catch (err) {
      // A plan this build cannot wire costs the branches, not the track: it plays as a line.
      this._warnOnce(`routing:${trackId}`, `[web-engine] the branches on this track could not be wired (${err?.message ?? err}), so its effects play one after another.`);
      track.setRouting(null);
    }
  }

  // -- tempo -------------------------------------------------------------------------------

  /**
   * The transport's tempo, for the devices that sync to it - a delay in beats, a ducker in
   * steps. Every processor with a port is told, and a device built later is told on its way
   * in, so nothing has to be re-sent when the buffer is re-evaluated.
   */
  setTempo(bpm, anchorSec = null, scope = null) {
    if (!(bpm > 0) || !Number.isFinite(bpm)) return;
    // `scope` narrows the message to some tracks: { only: [ids] } is a DJ deck whose clock has left
    // the room's (sync off, a jog), told its own tempo - and kept, so a device built on one of its
    // tracks later starts at it - and { except: [ids] } is the room's tempo for everybody else.
    // Without one, it is the room's for every track, as it always was.
    const only = scope?.only ? new Set(scope.only) : null;
    const except = scope?.except ? new Set(scope.except) : null;
    const anchor = Number.isFinite(anchorSec) ? anchorSec : this.anchorSec;
    if (only) {
      for (const id of only) this.trackTempo.set(id, { bpm, anchorSec: anchor });
    } else {
      this.bpm = bpm;
      this.anchorSec = anchor;
      for (const id of [...this.trackTempo.keys()]) if (!except?.has(id)) this.trackTempo.delete(id);
    }
    for (const [id, track] of this.tracks) {
      if (only ? !only.has(id) : except?.has(id)) continue;
      for (const slot of track.slots.values()) {
        try { slot.built.node?.port?.postMessage?.({ kind: 'tempo', bpm, anchorSec: anchor }); } catch { /* no port */ }
      }
    }
  }

  // -- notes -------------------------------------------------------------------------------

  /**
   * A note on, at an absolute time. The offset the synth worklet wants is in samples from the
   * start of the block it lands in, which is what keeps a part from walking against the grid by
   * up to a block - so the conversion happens here, once, rather than in every device.
   */
  noteOn(trackId, note, velocity, atTime) {
    this._playNote(trackId, note, velocity, atTime);
    // Then onward, to every track and effect this one's notes are routed into.
    if (this.midiRoutes.size) this.midiRoutes.noteEdge(trackId, note, velocity, atTime, true);
  }

  noteOff(trackId, note, atTime) {
    this._stopNote(trackId, note, atTime);
    if (this.midiRoutes.size) this.midiRoutes.noteEdge(trackId, note, 0, atTime, false);
  }

  /**
   * A note on a track's own instrument, and the modulators it plays - with no routing onward.
   *
   * The env()s follow the desktop's held-note count: the gate opens on the first held note and
   * closes when the last one ends, so a chord does not start releasing at its first note-off.
   * The note-gated lfo() shapes restart on every note.
   */
  _playNote(trackId, note, velocity, atTime) {
    const source = this.tracks.get(trackId)?.source;
    if (source?.node?.port) source.node.port.postMessage({ kind: 'noteOn', note, velocity, time: atTime });
    this._markSounding(trackId, 0, note, Infinity);
    const held = this.held.get(trackId) ?? 0;
    this.held.set(trackId, held + 1);
    // One that retriggers starts its attack again on every note, from wherever it had got to.
    for (const env of this.envelopes.get(trackId)?.values() ?? []) if (held === 0 || env.ir?.retrigger) env.gateOn(atTime);
    for (const conn of this.modulators.get(trackId)?.values() ?? []) {
      if (conn instanceof LfoConnection) conn.gate(atTime);
    }
  }

  _stopNote(trackId, note, atTime) {
    const source = this.tracks.get(trackId)?.source;
    if (source?.node?.port) source.node.port.postMessage({ kind: 'noteOff', note, time: atTime });
    this._markSounding(trackId, 0, note, atTime);
    const held = Math.max(0, (this.held.get(trackId) ?? 0) - 1);
    this.held.set(trackId, held);
    if (held === 0) for (const env of this.envelopes.get(trackId)?.values() ?? []) env.gateOff(atTime);
  }

  /**
   * Remembers when a note a device was sent is due to end - Infinity until its off is sent - so a
   * hush can release by name everything still to end, including notes sent a lookahead early that
   * have not begun. The desktop keeps the same table (markSounding in poptart.scd).
   */
  _markSounding(trackId, slot, note, offAt) {
    let notes = this.sounding.get(trackId);
    if (!notes) this.sounding.set(trackId, (notes = new Map()));
    const now = this.getTime();
    for (const [key, at] of notes) if (at < now) notes.delete(key);
    notes.set(`${slot}:${note}`, offAt === Infinity || Number.isFinite(offAt) ? offAt : now);
  }

  /**
   * A routed note arriving at its sink: slot 0 is the track's instrument, played as its own notes
   * are; any other slot is an effect that takes notes, which is told directly. A routed note is
   * not routed again - a chain of routes would be a second scheduler, and the desktop does not
   * do it either.
   */
  _deliverRouted(on, trackId, slot, note, velocity, atTime) {
    if (slot === 0) {
      if (on) this._playNote(trackId, note, velocity, atTime);
      else this._stopNote(trackId, note, atTime);
      return;
    }
    const port = this.tracks.get(trackId)?.slots.get(slot)?.built?.node?.port;
    try { port?.postMessage(on ? { kind: 'noteOn', note, velocity, time: atTime } : { kind: 'noteOff', note, time: atTime }); } catch { /* no port */ }
    if (port) this._markSounding(trackId, slot, note, on ? Infinity : atTime);
  }

  // -- the granular sample voice -----------------------------------------------------------------
  //
  // The desktop's poptart_sample_grain: a grain every 1/rate seconds, each a piece of the file
  // `size` long under a window, placed by `pan` and read from the position - the event's begin, or
  // the track's position control when the pattern drives it. One worklet per event lays the
  // grains on the audio thread, on their sample (see devices/grain-cloud.mjs). Size, rate, pan and
  // position are the track's grain constants (Track#grainControl), wired into the voice's
  // parameters, so a grain reads a signal on any of them as it starts.

  _playGrains(track, buffer, cfg, plan, offsetSec) {
    const Ctor = this.AudioWorkletNodeCtor;
    if (!Ctor) {
      this._warnOnce('grains', '[web-engine] this build has no AudioWorkletNode, so .grain() cannot play.');
      return { skipped: 'no worklets' };
    }
    const mods = this.modulators.get(track.id);
    const start = Math.max(this.getTime(), plan.onsetSec);
    // The event's own values at its onset seed the track, so the first grain does not read
    // whatever the last event left there (the scheduler sends them for exactly this).
    for (const [name, field] of [['grainsize', 'grainSize'], ['grainrate', 'grainRate'], ['grainpan', 'grainPan']]) {
      if (!Number.isFinite(cfg[field]) || mods?.has(keyOf(-1, name))) continue;
      track.grain[GRAIN_CHANNEL_FIELDS[name]] = cfg[field];
      const ctl = track.grainControl(name);
      try { ctl.offset.setValueAtTime(cfg[field], start); } catch { ctl.offset.value = cfg[field]; }
    }
    const gateEnd = Number.isFinite(offsetSec) ? Math.max(start + 0.001, offsetSec) : start + 1;
    const amp = this.ctx.createGain();
    const end = this._envelope(amp, plan, start, gateEnd);
    const made = this._cloudVoice(track, amp, start, plan, {
      ...this._grainFile(buffer),
      begin: plan.begin,
      posLive: cfg.grainPosLive === 1,
      // Signed: a negative speed reads each grain backwards. Scaled from the file's rate.
      rate: plan.speed * (buffer.sampleRate / this.ctx.sampleRate),
      start,
      end: end + 0.005,
      table: this._grainTable(cfg.grainShape),
    }, true);
    if (!made) return { skipped: 'grains failed' };
    const g = track.grain;
    return { index: cfg.index ?? 0, grain: true, grainSize: g.size, grainRate: g.rate, durSec: gateEnd - start, fileSec: buffer.duration, amp: plan.amp };
  }

  /**
   * One worklet voice of grains (a .grain() cloud, or the .stretch() warp), on its envelope `amp`
   * into the track. `controls` wires the track's grain constants in. Returns the node, or null.
   */
  _cloudVoice(track, amp, start, plan, processorOptions, controls = false) {
    const Ctor = this.AudioWorkletNodeCtor;
    let node;
    try {
      if (!Ctor) throw new Error('this build has no AudioWorkletNode');
      node = new Ctor(this.ctx, 'poptart-grains', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        // Every control arrives from a constant wired in below, which adds to these.
        parameterData: { size: 0, density: 0, pan: 0, pos: 0, detune: 0 },
        processorOptions,
      });
    } catch (err) {
      this._warnOnce('grains:build', `[web-engine] a grain voice could not start - ${err?.message ?? err}`);
      return null;
    }
    const wired = [];
    const plug = (from, id) => {
      const param = node.parameters?.get?.(id);
      if (!from || !param) return;
      from.connect(param);
      wired.push([from, param]);
    };
    if (controls) {
      plug(track.grainControl('grainsize'), 'size');
      plug(track.grainControl('grainrate'), 'density');
      plug(track.grainControl('grainpan'), 'pan');
      plug(track.grainControl('grainpos'), 'pos');
    }
    // The bend, in cents, from the constant the track holds.
    plug(track.bendCents ?? null, 'detune');
    node.connect(amp);
    amp.connect(track.input);
    const post = (m) => { try { node.port.postMessage(m); } catch { /* gone */ } };
    let voice = null;
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      voice?.finished();
      for (const [from, param] of wired) { try { from.disconnect(param); } catch { /* gone */ } }
      try { node.disconnect(); } catch { /* gone */ }
      try { amp.disconnect(); } catch { /* gone */ }
    };
    voice = this._voice(track, {
      amp,
      start,
      release: plan.release,
      // A hush ends the voice once its fade is over (at once for one not begun).
      onRelease: () => {
        const now = this.getTime();
        post({ kind: 'end', time: start > now ? now : now + Math.max(0.015, Number(plan.release) || 0) + 0.01 });
      },
    });
    node.port.onmessage = (event) => { if (event.data?.kind === 'ended') finish(); };
    node.addEventListener?.('processorerror', () => {
      this._warnOnce('processorerror:grains', '[web-engine] a grain voice failed on the audio thread');
      finish();
    });
    return node;
  }

  /**
   * What a grain voice is told about its file: its id, and the samples themselves the first time
   * (copied once onto the audio thread, and dropped there once the page lets the buffer go).
   */
  _grainFile(buffer) {
    this._grainIds ??= new WeakMap();
    this._grainDrops ??= [];
    this._grainGone ??= typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry((id) => this._grainDrops.push(id))
      : null;
    const drop = this._grainDrops.length ? this._grainDrops.splice(0) : undefined;
    let id = this._grainIds.get(buffer);
    if (id != null) return { file: id, ...(drop ? { drop } : {}) };
    this._grainSerial = (this._grainSerial ?? 0) + 1;
    id = this._grainSerial;
    this._grainIds.set(buffer, id);
    this._grainGone?.register(buffer, id);
    const channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
    return { file: id, id, channels, ...(drop ? { drop } : {}) };
  }

  /** A drawn grain window as the desktop builds one (1024 points), or null for the Hann bell. */
  _grainTable(shape) {
    const reader = this.shapeReader;
    if (!shape || !reader?.sampleShape) return null;
    let points = null;
    try {
      points = Array.isArray(shape) ? shape : reader.parseShapePoints?.(String(shape)) ?? null;
    } catch { points = null; }
    if (!points?.length) return null;
    const frames = 1024;
    const table = new Float32Array(frames);
    for (let i = 0; i < frames; i++) table[i] = Math.max(0, reader.sampleShape(points, i / (frames - 1)));
    return table;
  }



  // -- multichannel output ------------------------------------------------------------------------

  /** The channel counts this output can be set to: pairs, up to what the device takes. */
  outputChannelChoices() {
    const max = Math.max(2, Math.min(32, Number(this.ctx.destination?.maxChannelCount) || 2));
    const out = [];
    for (let n = 2; n <= max; n += 2) out.push(n);
    return out;
  }

  /**
   * Plays to `n` output channels (even, and no more than the device has). Past two the master
   * and the destination count their channels discretely - channel 3 is the third output, not a
   * surround speaker - and every track is rewired onto the pair its `.o()` names.
   */
  setOutputChannels(n) {
    const choices = this.outputChannelChoices();
    const want = choices.includes(Number(n)) ? Number(n) : choices.filter((c) => c <= Number(n)).pop() ?? 2;
    this.outputChannels = want;
    const discrete = want > 2;
    try {
      this.ctx.destination.channelCount = want;
      this.ctx.destination.channelCountMode = 'explicit';
      this.ctx.destination.channelInterpretation = discrete ? 'discrete' : 'speakers';
      this.master.channelCount = want;
      this.master.channelCountMode = discrete ? 'explicit' : 'max';
      this.master.channelInterpretation = discrete ? 'discrete' : 'speakers';
    } catch (err) {
      this._warnOnce(`channels:${want}`, `[web-engine] the output would not take ${want} channels - ${err?.message ?? err}`);
    }
    this.desk.setOutputChannels(want);
    for (const track of this.tracks.values()) this._routeOut(track);
    return want;
  }

  /**
   * Puts a track's output on the pair its `.o()` names, wrapped at the pairs there are - the
   * desktop's `(out - 1) mod pairs`. Pair one is a plain connection; any other goes through a
   * merger onto its two channels.
   */
  _routeOut(track) {
    // A headphone cue on a pair of this output takes that pair and everything above it out of
    // `.o()`'s reach, so a pattern cannot play into somebody's headphones.
    const cue = this.desk?.cuePair;
    const all = Math.floor(this.outputChannels / 2);
    const pairs = Math.max(1, cue != null ? Math.min(cue, all) : all);
    const pair = ((((Math.round(track.outValue ?? 1) - 1) % pairs) + pairs) % pairs);
    if (track._outPair === pair) return;
    try { track.dryGain.disconnect(); } catch { /* not connected */ }
    for (const node of track._outNodes ?? []) { try { node.disconnect(); } catch { /* gone */ } }
    track._outNodes = null;
    if (pair === 0) {
      track.dryGain.connect(this.master);
    } else {
      const split = this.ctx.createChannelSplitter(2);
      const merge = this.ctx.createChannelMerger(this.outputChannels);
      track.dryGain.connect(split);
      split.connect(merge, 0, pair * 2);
      split.connect(merge, 1, pair * 2 + 1);
      merge.connect(this.master);
      track._outNodes = [split, merge];
    }
    track._outPair = pair;
  }

  /**
   * Releases everything on a track without cutting what is already sounding - the desktop's
   * hushTrack. The instrument, and any effect played by notes, has every note still to end
   * released by name - notes sent a lookahead early and not begun included - with all-notes-off
   * behind that as a net. The env()s' gate closes as it does when the last note ends. The sample
   * voices release at their own release, and one sent early that has not begun never does. The
   * notes this track was routing into other tracks are released there, since the offs that would
   * have ended them will not come. `againSec` repeats the by-name release that far on, for notes
   * that begin after the first one.
   */
  hush(trackId, againSec = 0) {
    const track = this.tracks.get(trackId);
    if (!track) return;
    const now = this.getTime();
    const due = [];
    for (const [key, offAt] of this.sounding.get(trackId) ?? []) {
      if (offAt <= now) continue;
      const cut = key.indexOf(':');
      due.push({ slot: Number(key.slice(0, cut)), note: Number(key.slice(cut + 1)) });
    }
    this.sounding.get(trackId)?.clear();
    const release = (at) => {
      for (const { slot, note } of due) {
        try { track.slots.get(slot)?.built?.node?.port?.postMessage({ kind: 'noteOff', note, time: at }); } catch { /* no port */ }
      }
    };
    try { track.source?.node?.port?.postMessage({ kind: 'allNotesOff', time: now }); } catch { /* no port */ }
    release(now);
    if (againSec > 0) release(now + againSec);
    for (const env of this.envelopes.get(trackId)?.values() ?? []) env.gateOff(now);
    this.held.set(trackId, 0);
    for (const voice of [...(this.voices.get(trackId) ?? [])]) voice.release(now);
    this.midiRoutes.releaseFrom(trackId, now);
  }

  /**
   * Keeps a sample voice on its track's list until it has finished, so a hush can release it.
   * `amp` is the voice's level, `start` when it begins, `release` its own release time, `sources`
   * what to stop once the release is over and `onRelease` anything else to call off - a grain
   * cloud's timer.
   */
  _voice(track, { amp, start, release = 0, sources = [], onRelease = null }) {
    let live = this.voices.get(track.id);
    if (!live) this.voices.set(track.id, (live = new Set()));
    const voice = {
      finished: () => live.delete(voice),
      release: (now, floor = null) => {
        if (!live.delete(voice)) return;
        onRelease?.();
        const g = amp.gain;
        if (start > now) {
          // Sent a lookahead early and not begun: it is silenced before it starts.
          try { g.cancelScheduledValues(now); g.setValueAtTime(0, now); } catch { g.value = 0; }
          for (const src of sources) { try { src.stop(now); } catch { /* already stopped */ } }
          return;
        }
        const fade = floor ?? Math.max(0.015, Number(release) || 0);
        try {
          if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(now);
          else { const v = g.value; g.cancelScheduledValues(now); g.setValueAtTime(v, now); }
          g.linearRampToValueAtTime(0, now + fade);
        } catch { g.value = 0; }
        for (const src of sources) { try { src.stop(now + fade + 0.005); } catch { /* already stopped */ } }
      },
    };
    live.add(voice);
    return voice;
  }

  // -- parameters --------------------------------------------------------------------------

  /**
   * Sets a parameter from what `.param()` was given: a 0..1 position, an enum label or index,
   * or - for a parameter that takes one - the name of a sample to load into the device.
   */
  setParam(trackId, slot, name, value, atTime, glide) {
    const track = this.tracks.get(trackId);
    if (!track) return;
    const now = this.getTime();
    // A parameter a modulator owns is not ours to set: the modulator is the whole value, and a
    // scalar written over it would fight with the connection until one of them stopped. The same
    // for a channel control one drives (bend - see _targetParam).
    if (this.modulators.get(trackId)?.has(keyOf(slot, name))) return;
    // A value for one of an expression's inputs, in whatever units the expression reads it in.
    const leaf = this._leafTarget(trackId, slot, name);
    if (leaf !== undefined) {
      if (leaf) rampParam(leaf, Number(value) || 0, atTime, now, glide);
      return;
    }
    if (this._exprOwns(trackId, slot, name)) return;
    // `@amp.decay`: the instrument's own amp envelope, in seconds (or a level, for sustain), from
    // .attack()/.decay()/.sustain()/.release()/.envscale() on a synth.
    if (typeof name === 'string' && name.startsWith('@amp.')) {
      const device = track.slots.get(slot)?.descriptor;
      const param = findParam(device, name);
      if (!param) {
        this._warnOnce(`amp:${trackId}:${slot}:${name}`, `[web-engine] ${device?.name ?? 'this instrument'} has no amp envelope ${name.slice(5)}, so .${name.slice(5) === 'scale' ? 'envscale' : name.slice(5)}() does nothing on it.`);
        return;
      }
      name = param.id;
      value = normalize(param, Number(value));
    }
    if (slot === -1) {
      if (!track.setChannel(name, value, atTime, now)) {
        this._warnOnce(`channel:${name}`, `[web-engine] the "${name}" channel control is not implemented in the browser build yet, so it does nothing here. Implemented: ${SUPPORTED_CHANNELS.join(', ')} and wetN for each effect.`);
      }
      if (name === 'out') this._routeOut(track);
      return;
    }
    const result = track.setParam(slot, name, value, atTime, now, glide);
    if (result === true) return;
    const filled = track.slots.get(slot);
    const device = filled?.descriptor;
    if (result === false) {
      if (device) this._warnOnce(`param:${device.id}:${name}`, `[web-engine] "${device.id}" has no parameter called "${name}".`);
      return;
    }
    // The device has the parameter but could not take the value as given.
    const param = findParam(device, name);
    if (param.takes === 'sample' && typeof value === 'string') {
      this._loadSampleParam(trackId, slot, filled, param, value, atTime, glide);
      return;
    }
    if (param.takes === 'shape' && typeof value === 'string') {
      this._loadShapeParam(trackId, slot, filled, param, value, atTime, glide);
      return;
    }
    this._warnOnce(
      `value:${device.id}:${param.id}:${String(value)}`,
      `[web-engine] "${param.name}" on ${device.id} cannot take ${JSON.stringify(value)} - ${param.options ? `it is one of ${param.options.map((o) => JSON.stringify(o)).join(', ')}` : 'it takes a number from 0 to 1'}.`,
    );
  }

  /**
   * Takes a drawn curve on a parameter that accepts one, samples it, and points the parameter
   * at the table.
   *
   * A curve arrives as a NAME - a `_shape(...)` definition in the buffer, the same thing an
   * lfo() names, so `.param("Mode", "<grit soft>")` patterns between drawn curves the way
   * lfo("<a b>") does - or as the breakpoints themselves. A name is looked up every time it is
   * set and re-sampled when its definition has changed, into the slot the name already holds:
   * redrawing a curve edits it in place rather than filling the menu with copies.
   *
   * Sampled with pattern-core's own sampler rather than a second copy of it: a curve drawn in
   * the shape editor and a curve played by the device have to be the same curve, and the only
   * way to be sure of that is to have one piece of code that says what the curve is. This runs
   * on the main thread, so the worklet bundle never sees it.
   *
   * Unlike a sample there is nothing to fetch, so the table is posted in the same turn and the
   * control is usable on the next block.
   */
  _loadShapeParam(trackId, slot, filled, param, data, atTime, glide) {
    const now = this.getTime();
    const track = this.tracks.get(trackId);
    const reader = this.shapeReader;
    if (!reader) {
      this._warnOnce('shape-reader', '[web-engine] this build cannot read drawn shapes, so a curve cannot be set here.');
      return;
    }
    let points;
    let name = null;
    let key = data; // what the loaded table is filed under: a name AND its points, or the points
    if (reader.looksLikeShapeData(data)) {
      points = reader.parseShapePoints(data);
    } else {
      const defined = reader.lookupShape?.(data) ?? null;
      if (!defined) {
        this._warnOnce(`shape:${data}`, `[web-engine] there is no shape called ${JSON.stringify(data)} - draw one from the device's panel, or define it with _shape(${JSON.stringify(data)}, "0,0 0.5,1 1,0").`);
        return;
      }
      name = data;
      points = defined;
      key = `${data}=${JSON.stringify(defined)}`;
    }
    filled.loaded ??= new Map();
    const held = filled.loaded.get(key);
    if (held !== undefined) {
      track.setParamValue(slot, param.id, held, atTime, now, glide);
      return;
    }
    if (!points.length) {
      this._warnOnce(`shape:${data}`, `[web-engine] ${JSON.stringify(data)} has no points in it.`);
      return;
    }
    // A name keeps the slot it already has, so a redraw replaces the curve rather than adding one.
    filled.named ??= new Map(); // name -> { index, param }: the slot each named curve holds
    let optionIndex = name != null ? filled.named.get(name)?.index : undefined;
    if (optionIndex === undefined) {
      optionIndex = this._spareOption(filled, param, key);
      if (optionIndex === null) return;
      for (const [other, at] of filled.named) if (at.index === optionIndex) filled.named.delete(other);
      if (name != null) filled.named.set(name, { index: optionIndex, param });
    } else {
      for (const [other, at] of filled.loaded) if (at === optionIndex) filled.loaded.delete(other);
      filled.loaded.set(key, optionIndex);
    }
    // The option's label is the name where there is one - what the menu shows and the code says.
    filled.extras[param.id][optionIndex] = name ?? data;
    // The table first, the control second: the other way round the device spent a block on a
    // slot with no table in it yet, which it can only play as a hard clip - a spike of harmonics
    // and a crack, every time a curve was picked.
    this._postShapeTable(filled, param, optionIndex, name ?? 'drawn', name ?? data, points);
    track.setParamValue(slot, param.id, optionIndex, atTime, now, glide);
  }

  /**
   * Re-reads every named curve a device holds against the shape definitions as they stand now,
   * and re-samples the ones whose definition changed - into the slot they already hold, and
   * WITHOUT moving any control onto them. Called after each evaluation: a redrawn shape has to
   * reach a device that is on it even when nothing sets the control again, which on a stopped
   * transport nothing does.
   */
  refreshNamedShapes() {
    const reader = this.shapeReader;
    if (!reader?.lookupShape) return;
    for (const track of this.tracks.values()) {
      for (const filled of track.slots.values()) {
        for (const [name, { index, param }] of filled.named ?? []) {
          const points = reader.lookupShape(name);
          if (!points?.length) continue;
          const key = `${name}=${JSON.stringify(points)}`;
          if (filled.loaded?.get(key) === index) continue;
          for (const [other, at] of filled.loaded) if (at === index) filled.loaded.delete(other);
          filled.loaded.set(key, index);
          this._postShapeTable(filled, param, index, name, name, points);
        }
      }
    }
  }

  /** Samples `points` into a table and hands it to the device's slot `index` for `param`. */
  _postShapeTable(filled, param, index, name, data, points) {
    const reader = this.shapeReader;
    const table = new Float32Array(SHAPE_POINTS);
    for (let i = 0; i < SHAPE_POINTS; i++) table[i] = reader.sampleShape(points, i / (SHAPE_POINTS - 1));
    (filled.shapes ??= {})[index] = { name, data, points: [...table] };
    const built = filled.built;
    if (typeof built.loadShape === 'function') built.loadShape(param.id, index, table);
    else built.node?.port?.postMessage?.({ kind: 'shape', param: param.id, index, table }, [table.buffer]);
  }

  /**
   * The next free slot on an enum's option list, past the descriptor's own entries. There is no
   * last one: the list grows by what is loaded. Shared by the two things that fill it: a loaded
   * file and a drawn shape.
   */
  _spareOption(filled, param, name) {
    const first = param.options.length;
    // Every control that loads into the same store (its bank - the Wavetable's two oscillators
    // read one set of tables) shares that store's slots, and lists what is in them.
    const bank = param.bank ?? param.id;
    const sharing = filled.descriptor.params.filter((p) => (p.bank ?? p.id) === bank);
    const extrasOf = (p) => (filled.extras[p.id] ??= {});
    let optionIndex = first;
    while (sharing.some((p) => extrasOf(p)[optionIndex] !== undefined)) optionIndex++;
    filled.loaded.set(name, optionIndex);
    for (const p of sharing) extrasOf(p)[optionIndex] = name;
    return optionIndex;
  }


  /**
   * Loads a sample into a device, on a parameter that takes one, and points the parameter at it.
   *
   * The reference is resolved to one of the parameter's spare option slots at once, so the
   * control has a value from this call on and the pattern's poll re-sending the same string every
   * tick costs a lookup. The bytes arrive afterwards: the store is asked for them, and what it
   * gives is posted to the processor as plain channels of samples at the file's own rate - a
   * wavetable is cut into frames on that side, an impulse response is used whole. Until then the
   * slot plays whatever it was playing, which is the same rule a pack that has not downloaded
   * yet follows.
   */
  _loadSampleParam(trackId, slot, filled, param, ref, atTime, glide) {
    const now = this.getTime();
    const track = this.tracks.get(trackId);
    filled.loaded ??= new Map();
    const held = filled.loaded.get(ref);
    if (held !== undefined) {
      track.setParamValue(slot, param.id, held, atTime, now, glide);
      return;
    }
    const parsed = parseSampleRef(ref);
    if (!parsed) {
      this._warnOnce(`ref:${ref}`, `[web-engine] ${JSON.stringify(ref)} is not a sample - write "pack:index" or "pack:file".`);
      return;
    }
    const index = this._sampleIndex(parsed.pack, parsed.key);
    if (index === null) {
      this._warnOnce(`ref:${ref}`, `[web-engine] there is no sample called ${JSON.stringify(ref)} here.`);
      return;
    }
    // The next spare slot on the option list, past the descriptor's own entries. When the list
    // is full the oldest loaded one is taken, which is what a song that walks through a folder of
    // tables would want rather than a refusal.
    const extras = (filled.extras[param.id] ??= {});
    const optionIndex = this._spareOption(filled, param, ref);
    extras[optionIndex] = `${parsed.pack}:${parsed.key}`;
    track.setParamValue(slot, param.id, optionIndex, atTime, now, glide);

    const post = (payload) => {
      const built = filled.built;
      if (typeof built.loadSample === 'function') built.loadSample(param.id, optionIndex, payload);
      else built.node?.port?.postMessage?.({ kind: 'sample', param: param.id, index: optionIndex, ...payload });
    };
    const settled = this._sampleChannels(parsed.pack, index)
      .then(async (payload) => {
        if (!payload) {
          this._warnOnce(`ref:${ref}`, `[web-engine] ${JSON.stringify(ref)} has not loaded, so "${param.name}" keeps what it had.`);
          return;
        }
        // The slot may have been refilled while the bytes were on their way.
        if (track.slots.get(slot) !== filled) return;
        if (param.sampleAs === 'wavetable') {
          const table = await this._wavetableOf(payload);
          if (track.slots.get(slot) !== filled) return;
          // The frames are kept here too, for the picture the panel draws of the table.
          (filled.tables ??= {})[optionIndex] = { name: extras[optionIndex], frameCount: table.mips.length, mips: table.mips.map((m) => [m[0]]), names: null };
          post({ name: extras[optionIndex], mips: table.mips });
          return;
        }
        // The outline is kept here too, for the picture the panel draws of the file - the same
        // reason a wavetable's frames are. Peaks rather than samples: a picture is a couple of
        // hundred columns wide however long the file is.
        (filled.waves ??= {})[optionIndex] = { name: extras[optionIndex], ...outlineOf(payload.channels?.[0], payload.sampleRate) };
        post({ name: extras[optionIndex], ...payload });
      })
      .catch((err) => this._warnOnce(`ref:${ref}`, `[web-engine] ${JSON.stringify(ref)} could not be read - ${err?.message ?? err}`));
    // What a caller waits on when it wants to DRAW the thing that is loading: a panel asked to
    // show the table it just pointed a control at would otherwise draw the empty slot, since
    // reading a file and cutting it into frames takes longer than answering the request does.
    filled.loading = settled.finally(() => { if (filled.loading === settled) filled.loading = null; });
  }

  /**
   * Resolves once whatever one slot is loading has landed, or at once when nothing is. Never
   * rejects: a file that could not be read has already been reported, and a caller waiting to
   * redraw a panel should redraw it either way.
   */
  sampleSettled(trackId, slot) {
    const filled = this.tracks.get(trackId)?.slots.get(slot);
    return Promise.resolve(filled?.loading ?? null).catch(() => null);
  }

  /**
   * A file as a wavetable: the channels summed, cut into frames of the length it declares, each
   * frame brought to a power of two, and the band-limited pyramid built for every frame - here,
   * in pieces, yielding between them, so a file of hundreds of frames costs the page a moment
   * of work rather than the audio thread a dropout.
   */
  async _wavetableOf({ channels, frameLength }) {
    let mono = channels[0];
    if (channels.length > 1) {
      mono = new Float32Array(channels[0].length);
      for (const c of channels) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / channels.length;
    }
    const raw = framesOf(mono, frameLength ?? 2048);
    const length = powerOfTwoAtLeast(raw[0].length);
    const mips = [];
    for (let i = 0; i < raw.length; i++) {
      const frame = raw[i].length === length ? raw[i] : resampleFrame(raw[i], length);
      mips.push(buildMipmaps(frame));
      if (i % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { mips };
  }

  /** Which file of a pack a key names: an index, or a file name with or without its extension. */
  _sampleIndex(pack, key) {
    const store = this.samples;
    if (typeof store?.indexOf === 'function') {
      const found = store.indexOf(pack, key);
      if (found !== null && found !== undefined) return found;
    }
    const n = Number(key);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  /**
   * One sample as channels of floats at its own rate, from the store's bytes when it keeps them
   * and from its decoded audio when it does not. Null when the store has nothing for it.
   */
  async _sampleChannels(pack, index) {
    const store = this.samples;
    if (!store) return null;
    if (typeof store.bytes === 'function') {
      const bytes = await store.bytes(pack, index);
      if (bytes) {
        try {
          const wav = decodeWav(bytes);
          return { sampleRate: wav.sampleRate, channels: wav.channels, frameLength: wav.frameLength };
        } catch {
          // Not a WAV - an mp3, say. The decoded audio below still serves for anything that is
          // not a wavetable.
        }
      }
    }
    const got = store.get?.(pack, index);
    const buffer = got?.buffer ?? got;
    if (!buffer?.getChannelData) return null;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(Float32Array.from(buffer.getChannelData(c)));
    return { sampleRate: buffer.sampleRate, channels, frameLength: null };
  }

  /** The AudioParam a modulator or a connection should drive, or null with a warning. */
  _targetParam(trackId, slot, name) {
    const leaf = this._leafTarget(trackId, slot, name);
    if (leaf !== undefined) return leaf;
    const track = this.tracks.get(trackId);
    if (slot === -1) {
      // A channel control is driven in its own units, as a set value is: gain as a level, pan
      // from -1 to 1, bend in semitones, bass mono in Hz (see Track#driveChannel).
      const param = track?.driveChannel(name, this.getTime()) ?? null;
      if (!param && track) {
        this._warnOnce(
          `channel-mod:${name}`,
          `[web-engine] the "${name}" channel control cannot be driven by an lfo(), env(), midicc() or osc(), so nothing is connected to it.`,
        );
      }
      return param;
    }
    const filled = track?.slots.get(slot);
    if (!filled) return null;
    const found = filled.paramFor(name);
    if (!found) {
      this._warnOnce(`param:${filled.descriptor.id}:${name}`, `[web-engine] "${filled.descriptor.id}" has no parameter called "${name}".`);
      return null;
    }
    // The DESCRIPTOR decides this, not whether an AudioParam happens to exist. A worklet
    // declares its block-rate parameters as AudioParams too, so they can be connected to - they
    // would just be read once a block, which is not modulation at audio rate and is not what
    // `.param(name, audio(...))` promises. Asking the node instead of the descriptor let that
    // through in a browser while the tests, whose stand-in left k-rate params out, saw a warning.
    if (found.param.rate !== 'a' || !found.audioParam) {
      this._warnOnce(
        `target:${filled.descriptor.id}:${name}`,
        `[web-engine] "${name}" on ${filled.descriptor.id} cannot be driven at audio rate, so nothing is connected to it.`,
      );
      return null;
    }
    return found.audioParam;
  }

  _setModulator(trackId, slot, name, ir, make, kind, method) {
    ir = this._reachOf(trackId, slot, name, ir);
    const key = keyOf(slot, name);
    const held = this.modulators.get(trackId);
    if (!held) return;
    const existing = held.get(key);
    if (existing && existing.method !== method) this._clearModulator(trackId, slot, name);
    else if (existing) {
      // A re-send goes to the connection, which decides what changed: the scheduler re-sends every
      // modulator after each evaluation, and one whose range or rate is a signal every tick, and
      // neither may restart the shape or re-gate the envelope. What it listens to may have moved,
      // though - another controller, another address - so a feed is filed again under its key.
      existing.update(ir);
      if (existing._feedKey) this._fileFeed(existing, this._feedKeyOf(method, existing.ir));
      return;
    }
    const target = this._targetParam(trackId, slot, name);
    if (!target) return;
    const connection = make(target);
    // What is moving this parameter, in the words the panel says it in, and the method that
    // programmed it, so a device swap can program it again. Recorded here rather than asked of
    // the connection afterwards, because two of the four kinds are the same class.
    connection.kind = kind;
    connection.method = method;
    held.set(key, connection);
    if (connection instanceof EnvConnection) {
      this.envelopes.get(trackId)?.set(key, connection);
      // Born open when notes are already held, as the desktop's env synth is.
      if ((this.held.get(trackId) ?? 0) > 0) connection.gateOn(this.getTime());
    }
  }

  /**
   * A modulator's range as it reaches an enum that takes files: across the list as it stands -
   * the shipped entries and every one loaded after them - rather than the shipped list alone,
   * which is all a 0..1 position on the control spans (see defineParam's open controls).
   */
  _reachOf(trackId, slot, name, ir) {
    const filled = this.tracks.get(trackId)?.slots.get(slot);
    const param = filled && findParam(filled.descriptor, name);
    if (!param?.open || !param.options || !ir) return ir;
    const loaded = Object.keys(filled.extras?.[param.id] ?? {}).map(Number).filter(Number.isInteger);
    const top = Math.max(param.options.length - 1, ...loaded);
    const factor = top / (param.max - param.min);
    if (factor === 1) return ir;
    return { ...ir, min: (ir.min ?? 0) * factor, max: (ir.max ?? 1) * factor };
  }

  /** The feeds table's key for what a midicc() or osc() modulator listens to. */
  _feedKeyOf(method, ir) {
    return method === 'setParamOSC'
      ? `osc|${ir.osc}|${ir.index ?? 0}`
      : `cc|${String(ir.device ?? '').toLowerCase()}|${ir.cc}`;
  }

  /** Files a feed connection under a key, taking it out from under the one it had. */
  _fileFeed(conn, key) {
    if (conn._feedKey === key) return;
    if (conn._feedKey) this.feeds.get(conn._feedKey)?.delete(conn);
    if (!this.feeds.has(key)) this.feeds.set(key, new Set());
    this.feeds.get(key).add(conn);
    conn._feedKey = key;
  }

  setParamLFO(trackId, slot, name, ir) {
    this._setModulator(trackId, slot, name, ir, (target) => new LfoConnection(this.ctx, target, ir), 'an lfo', 'setParamLFO');
  }

  setParamEnv(trackId, slot, name, ir) {
    this._setModulator(trackId, slot, name, ir, (target) => new EnvConnection(this.ctx, target, ir), 'an envelope', 'setParamEnv');
  }

  setParamCC(trackId, slot, name, ir) {
    this._setModulator(trackId, slot, name, ir, (target) => {
      const conn = new FeedConnection(this.ctx, target, ir);
      this._fileFeed(conn, this._feedKeyOf('setParamCC', ir));
      this.onMidiWanted?.();
      return conn;
    }, 'a midi control', 'setParamCC');
  }

  setParamOSC(trackId, slot, name, ir) {
    this._setModulator(trackId, slot, name, ir, (target) => {
      const conn = new FeedConnection(this.ctx, target, ir);
      this._fileFeed(conn, this._feedKeyOf('setParamOSC', ir));
      return conn;
    }, 'an osc message', 'setParamOSC');
  }

  _clearModulator(trackId, slot, name) {
    const key = keyOf(slot, name);
    const held = this.modulators.get(trackId);
    const conn = held?.get(key);
    if (!conn) return;
    const left = conn.stop();
    this._recordLeft(trackId, slot, name, left);
    held.delete(key);
    const track = this.tracks.get(trackId);
    if (slot === -1 && track && !leafOf(name)) {
      const now = this.getTime();
      // A bend is left where it rests, not where the modulator stopped: a pattern that dropped its
      // lfo() on bend should not stay out of tune by wherever the sweep happened to be. Anything
      // the pattern bends by now arrives on the next poll.
      if (name === 'bend') {
        track.bendSemis = 0;
        rampParam(track.bendSource().offset, 0, now, now);
      } else if (Number.isFinite(left)) {
        // Every other channel control stays where the modulator had it, and is SET there, so the
        // track's own record of it agrees - the grains read it, bass mono decides off it whether
        // it is on at all.
        track.setChannel(name, left, now, now);
      }
    }
    this.envelopes.get(trackId)?.delete(key);
    if (conn._feedKey) this.feeds.get(conn._feedKey)?.delete(conn);
  }

  /**
   * A cleared modulator leaves its parameter on the position it had reached (see LfoConnection's
   * stop), and the slot's record of the control is brought into line with it - that record is
   * what a panel prints and a preset captures, and it would otherwise still say whatever was set
   * before the modulator took over.
   */
  _recordLeft(trackId, slot, name, position) {
    if (!Number.isFinite(position)) return;
    const found = this.tracks.get(trackId)?.slots.get(slot)?.paramFor(name);
    if (found?.param && found.audioParam) {
      this.tracks.get(trackId).slots.get(slot).values[found.param.id] = denormalize(found.param, Math.max(0, position));
    }
  }

  /** The pattern is about to drive a plugin parameter by poll (see Track#holdParam). */
  holdParam(trackId, slot, name) {
    if (leafOf(name)) return;
    this.tracks.get(trackId)?.holdParam(slot, name);
  }

  /** ...and is done with it: back to what it was before (see Track#releaseParam). */
  releaseParam(trackId, slot, name, atTime, glide) {
    const track = this.tracks.get(trackId);
    if (!track || this.modulators.get(trackId)?.has(keyOf(slot, name))) return;
    if (leafOf(name) || this._exprOwns(trackId, slot, name)) return;
    track.releaseParam(slot, name, atTime, this.getTime(), glide);
  }

  clearParamLFO(trackId, slot, name) { this._clearModulator(trackId, slot, name); }
  clearParamEnv(trackId, slot, name) { this._clearModulator(trackId, slot, name); }
  clearParamCC(trackId, slot, name) { this._clearModulator(trackId, slot, name); }
  clearParamOSC(trackId, slot, name) { this._clearModulator(trackId, slot, name); }

  _clearAllModulators(trackId) {
    for (const [key, conn] of this.modulators.get(trackId) ?? []) {
      conn.stop();   // the track is going, so there is no record to bring into line
      if (conn._feedKey) this.feeds.get(conn._feedKey)?.delete(conn);
      this.envelopes.get(trackId)?.delete(key);
    }
    this.modulators.get(trackId)?.clear();
  }

  /**
   * Swaps a drawn LFO to another of its shapes at the time asked. The new shape starts from its
   * beginning, as the desktop's does and as the scheduler's phase anchors count; in the
   * note-gated modes it waits for the next note (see LfoConnection#swapTo).
   */
  setParamShape(trackId, slot, name, index, atTime, rateHz = null) {
    const conn = this.modulators.get(trackId)?.get(keyOf(slot, name));
    if (conn instanceof LfoConnection) conn.swapTo(index, atTime, rateHz);
  }

  /**
   * Puts a free-running LFO back on the grid's phase, which the scheduler does periodically. A
   * patterned rate also names the rate it runs at from then on: its changes arrive this way.
   */
  anchorParamLFO(trackId, slot, name, phase01, atTime, rateHz = null) {
    const conn = this.modulators.get(trackId)?.get(keyOf(slot, name));
    if (conn instanceof LfoConnection) conn.anchor(phase01, atTime, rateHz);
  }

  /** The host feeds a MIDI continuous controller in; every parameter watching it follows. */
  feedCC(device, cc, unit, atTime) {
    for (const conn of this.feeds.get(`cc|${String(device ?? '').toLowerCase()}|${cc}`) ?? []) conn.feed(unit, atTime);
  }

  /**
   * A controller from a device by its full name: every midicc() whose device is a fragment of
   * that name - the desktop's matching rule - and whose channel is this one, or unset.
   */
  _feedCCFrom(deviceName, channel, cc, unit, atTime) {
    const name = String(deviceName).toLowerCase();
    for (const [key, conns] of this.feeds) {
      if (!key.startsWith('cc|')) continue;
      const cut = key.lastIndexOf('|');
      if (Number(key.slice(cut + 1)) !== cc) continue;
      const want = key.slice(3, cut);
      if (want && !name.includes(want)) continue;
      for (const conn of conns) {
        const ch = conn.ir?.channel;
        if (ch && ch !== channel) continue;
        conn.feed(unit, atTime);
      }
    }
  }

  /** The host feeds an OSC message in. */
  feedOsc(address, index, unit, atTime) {
    for (const conn of this.feeds.get(`osc|${address}|${index ?? 0}`) ?? []) conn.feed(unit, atTime);
  }

  // -- parameter expressions ----------------------------------------------------------------

  /**
   * Installs the expression a `.param()` value became - `audio("a").mul(lfo())`, two sources
   * summed, `env().mul(lfo())` - on (slot, name). One worklet node per expression evaluates the
   * tree every sample (dsp/expr.mjs) and drives the parameter, which it then owns outright, as a
   * modulator does. Its inputs are of two kinds: another track or a bus, wired here by name, and
   * everything else, which arrives as ordinary parameter calls on the leaf name `~i~name` (see
   * _leafTarget) - so an lfo(), an env() or a polled pattern feeding an expression is programmed
   * exactly as it would be on a parameter of its own.
   *
   * A tree that differs from the running one only in its constants is taken in place, without a
   * rebuild: a knob turned in the code or the panel moves the value and cuts nothing.
   */
  setParamExpr(trackId, slot, name, tree) {
    if (!this.tracks.has(trackId)) return;
    const rec = this._exprRecord(trackId, slot, name);
    const json = JSON.stringify(tree);
    if (rec.node && rec.json === json) return;
    try {
      compileExpr(tree);
    } catch (err) {
      this._warnOnce(`expr:${trackId}:${rec.key}`, `[web-engine] the value given to "${name}" could not be built (${err?.message ?? err}), so it is left where it was.`);
      return;
    }
    const shape = exprShape(tree);
    if (rec.node && rec.shape === shape) {
      rec.node.port?.postMessage?.({ consts: exprConsts(tree) });
      rec.tree = tree;
      rec.json = json;
      return;
    }
    let node;
    try {
      if (!this.AudioWorkletNodeCtor) throw new Error('this build has no AudioWorkletNode');
      node = new this.AudioWorkletNodeCtor(this.ctx, 'poptart-expr', {
        numberOfInputs: exprInputCount(tree),
        numberOfOutputs: 1,
        outputChannelCount: [1],
        // Every input is read as one channel, and a stereo source is folded to it as (L + R) / 2 -
        // what the desktop's devices make of a pair patched onto a control.
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { tree },
      });
    } catch (err) {
      this._warnOnce(`expr-build:${trackId}:${rec.key}`, `[web-engine] the value given to "${name}" needs the effects worklet, which is not loaded (${err?.message ?? err}), so it is left where it was.`);
      return;
    }
    // Whatever drove the parameter before is taken off: the expression is its whole value now.
    this._clearModulator(trackId, slot, name);
    this._detachExprInputs(trackId, rec);
    const old = rec.node;
    rec.node = node;
    rec.tree = tree;
    rec.json = json;
    rec.shape = shape;
    rec.wired = new Set();
    for (const leaf of exprInputs(tree)) {
      const i = Number(leaf.i) | 0;
      if (rec.wired.has(i)) continue;
      rec.wired.add(i);
      if (leaf.source != null) this._wireExprSource(trackId, rec, i, String(leaf.source));
      else this._exprInput(rec, i).connect(node, 0, i);
    }
    if (old) this._retireExprNode(old);
    this._attachExprOutput(trackId, rec);
  }

  /** Takes the expression off (slot, name); the parameter goes back to the value last set on it. */
  clearParamExpr(trackId, slot, name) {
    const held = this.exprs.get(trackId);
    const rec = held?.get(keyOf(slot, name));
    if (!rec) return;
    this._disposeExpr(trackId, rec, true);
    held.delete(rec.key);
  }

  /**
   * What expressions this track's parameters carry, as `"slot:name" -> the tree as set` - the
   * spelling the scheduler diffs against, so a fresh Scheduler on a track that outlived its old
   * one leaves an unchanged expression running instead of rebuilding it.
   */
  paramExprs(trackId) {
    const out = new Map();
    for (const [key, rec] of this.exprs.get(trackId) ?? []) if (rec.json != null) out.set(key, rec.json);
    return out;
  }

  /** Whether an installed expression owns this parameter, so nothing else may set it. */
  _exprOwns(trackId, slot, name) {
    return this.exprs.get(trackId)?.get(keyOf(slot, name))?.json != null;
  }

  _exprRecord(trackId, slot, name) {
    if (!this.exprs.has(trackId)) this.exprs.set(trackId, new Map());
    const held = this.exprs.get(trackId);
    const key = keyOf(slot, name);
    let rec = held.get(key);
    if (!rec) {
      rec = { key, slot, name, tree: null, json: null, shape: null, node: null, wired: new Set(), inputs: new Map(), sources: new Map(), target: null, rest: undefined };
      held.set(key, rec);
    }
    return rec;
  }

  /**
   * The parameter a leaf name stands for: the offset of the constant feeding that input. Made on
   * first use, by whichever arrives first - the expression or a call aimed at one of its inputs -
   * so a modulator programmed a moment before its expression lands is already in place when it
   * does. Undefined for a name that is not a leaf; null when there is no track to hold it.
   */
  _leafTarget(trackId, slot, name) {
    const leaf = leafOf(name);
    if (!leaf) return undefined;
    if (!this.tracks.has(trackId)) return null;
    return this._exprInput(this._exprRecord(trackId, slot, leaf.name), leaf.i).offset;
  }

  _exprInput(rec, i) {
    let source = rec.inputs.get(i);
    if (!source) {
      source = this.ctx.createConstantSource();
      source.offset.value = 0;
      source.start();
      rec.inputs.set(i, source);
      if (rec.node && rec.wired.has(i) && !this._exprSourceAt(rec, i)) source.connect(rec.node, 0, i);
    }
    return source;
  }

  _exprSourceAt(rec, i) {
    return exprInputs(rec.tree).some((leaf) => (Number(leaf.i) | 0) === i && leaf.source != null);
  }

  _wireExprSource(trackId, rec, i, name) {
    const node = rec.node;
    this._route(`expr|${trackId}|${rec.key}|${i}`, name, (from) => {
      if (rec.node !== node) return;   // rebuilt while this waited
      rec.sources.set(i, { from, name, edge: this._link(from, node, trackId, i) });
    }, `source:${name}`, `[web-engine] there is nothing called "${name}" to patch into "${rec.name}".`);
  }

  /** Unplugs every input from the running node, and forgets the routes still waiting for one. */
  _detachExprInputs(trackId, rec) {
    for (const key of [...this._waiting.keys()]) {
      if (key.startsWith(`expr|${trackId}|${rec.key}|`)) this._waiting.delete(key);
    }
    if (!rec.node) return;
    for (const source of rec.inputs.values()) { try { source.disconnect(rec.node); } catch { /* not connected */ } }
    for (const { edge } of rec.sources.values()) edge.unlink();
    rec.sources.clear();
  }

  _retireExprNode(node) {
    try { node.disconnect(); } catch { /* already detached */ }
    try { node.port?.postMessage?.({ kind: 'dispose' }); } catch { /* no port to tell */ }
  }

  /**
   * Points the expression at the parameter it drives, which may have changed under it - a device
   * swapped into the slot, or loaded only now. The parameter's own value is zeroed, because what
   * arrives at an AudioParam adds to it.
   */
  _attachExprOutput(trackId, rec) {
    if (!rec.node) return;
    try { rec.node.disconnect(); } catch { /* not connected */ }
    const target = this._targetParam(trackId, rec.slot, rec.name);
    rec.target = target;
    if (!target) return;
    if (rec.slot === -1 && rec.rest === undefined) rec.rest = target.value;
    try { target.cancelScheduledValues(this.getTime()); } catch { /* nothing scheduled */ }
    try { target.value = 0; } catch { /* a param that refuses a direct set */ }
    rec.node.connect(target);
  }

  /** Takes an expression down, and with `restore` puts its parameter back where it was last set. */
  _disposeExpr(trackId, rec, restore) {
    this._detachExprInputs(trackId, rec);
    for (const source of rec.inputs.values()) {
      try { source.stop(); } catch { /* never started */ }
      try { source.disconnect(); } catch { /* already detached */ }
    }
    rec.inputs.clear();
    if (rec.node) this._retireExprNode(rec.node);
    rec.node = null;
    rec.json = null;
    const target = rec.target;
    rec.target = null;
    if (!restore || !target) return;
    if (rec.slot === -1) {
      if (Number.isFinite(rec.rest)) { try { target.value = rec.rest; } catch { /* refuses a direct set */ } }
      return;
    }
    const filled = this.tracks.get(trackId)?.slots.get(rec.slot);
    const found = filled?.paramFor(rec.name);
    if (found?.audioParam) {
      try { found.audioParam.value = normalize(found.param, filled.values[found.param.id]); } catch { /* refuses a direct set */ }
    }
  }

  // -- routing -----------------------------------------------------------------------------

  /** A bus is made the first time anything names it, and lives as long as the engine does. */
  _bus(name) {
    let bus = this.buses.get(name);
    if (!bus) {
      bus = this.ctx.createGain();
      this.buses.set(name, bus);
      this._wakeRoutes();
    }
    return bus;
  }

  /**
   * Installs the label-to-track-id lookup. The host knows which id it gave each label and this
   * engine does not, so every routing name a pattern carries - `audio("kick")`, a group reading
   * its members, a signal patched onto a parameter - passes through here on its way to a node.
   */
  setTrackResolver(fn) {
    this.resolveTrack = typeof fn === 'function' ? fn : null;
  }

  /**
   * Resolves a routing name - a bus, or another track - to the node that carries its output.
   *
   * A bare name is a TRACK first and a bus second, which is the same order the desktop resolves
   * in: somebody who has written a track called `kick` means that track.
   */
  _sourceNode(name, reader = null) {
    const text = String(name ?? '');
    if (text.startsWith('bus:')) return this._bus(text.slice(4));
    if (text.startsWith('dev:')) return null;         // a hardware input; see setInputSource
    const explicit = text.startsWith('track:');
    const bare = explicit ? text.slice(6) : text;
    // The id the host gave that label, or the name itself - which is what a test that made its
    // tracks by hand passes, and what a host with no resolver leaves it as.
    const id = this.resolveTrack?.(bare) ?? bare;
    const found = this.tracks.has(id) ? id : this.tracks.has(bare) ? bare : null;
    // A track reading its own name means the bus of that name, as on the desktop.
    if (found != null && found !== reader) return this.tracks.get(found).panner;
    return explicit && found == null ? null : this.buses.get(bare) ?? null;
  }

  /** The vertex a source node is in the route graph: a track's output or a bus. */
  _vertexOf(node) {
    for (const [id, track] of this.tracks) if (track.panner === node) return `t:${id}`;
    for (const [name, bus] of this.buses) if (bus === node) return `b:${name}`;
    return null;
  }

  /** Wires a route from another track or bus into `to`, a node of track `trackId`. */
  _link(from, to, trackId, input = 0) {
    return this.routes.link(from, to, { src: this._vertexOf(from), dst: `t:${trackId}`, input });
  }

  /**
   * Wires a route from the node `name` resolves to - now if it is there, or as soon as it is.
   *
   * The scheduler builds a buffer's tracks in the order they are written, so a track reading one
   * written BELOW it - `.fx("Ducker").audio("kick")` above `kick:` - names a track that does not
   * exist yet. It will a moment later, in the same evaluation, and the scheduler does not send a
   * route twice, so failing here would lose it for good. The route waits instead, and is only
   * said to name nothing if nothing has answered to the name once the evaluation has had time to
   * finish.
   */
  _route(key, name, wire, warnKey, warning) {
    this._waiting.delete(key);
    const from = this._sourceNode(name, key.split('|')[1]);
    if (from) {
      wire(from);
      return;
    }
    const waiting = { name, wire };
    this._waiting.set(key, waiting);
    const timer = setTimeout(() => {
      if (this._waiting.get(key) === waiting) this._warnOnce(warnKey, warning);
    }, this.routeWaitMs);
    timer?.unref?.();
  }

  /** Wires every waiting route whose source has arrived. */
  _wakeRoutes() {
    for (const [key, waiting] of [...this._waiting]) {
      const from = this._sourceNode(waiting.name, key.split('|')[1]);
      if (!from) continue;
      this._waiting.delete(key);
      waiting.wire(from);
    }
  }

  /**
   * Puts every route fed by a track that is going away back to waiting for its name, so the same
   * label written again - the line deleted and undone, the track renamed and named back - feeds
   * them again. Left as they were, they would hang off a node that no longer carries anything.
   */
  _orphanRoutesFrom(sourceId, panner) {
    for (const [id, track] of this.tracks) {
      if (id === sourceId) continue;
      for (const [slot, held] of [...track.sidechains]) {
        if (held.from !== panner) continue;
        const { source, gain } = held;
        track.clearSidechain(slot);
        this._route(`side|${id}|${slot}`, source, (from) => track.setSidechain(slot, from, source, gain, this._linker(id)),
          `source:${source}`, `[web-engine] there is nothing called "${source}" to feed into slot ${slot}.`);
      }
      if (track._headSource === panner && track._headName) {
        const name = track._headName;
        track._headEdge?.unlink();
        track._headEdge = null;
        track._headSource = null;
        this._route(`head|${id}`, name, (from) => this._wireHead(id, track, from, name),
          `head:${name}`, `[web-engine] there is nothing called "${name}" for this track to read.`);
      }
    }
    for (const [id, held] of this.exprs) {
      if (id === sourceId) continue;
      for (const rec of held.values()) {
        for (const [i, { from, name, edge }] of [...rec.sources]) {
          if (from !== panner) continue;
          edge.unlink();
          rec.sources.delete(i);
          this._wireExprSource(id, rec, i, name);
        }
      }
    }
  }

  setBusSends(trackId, sends) {
    const track = this.tracks.get(trackId);
    if (!track) return;
    // Nothing the scheduler sends from inside a timer may throw: an exception there stops the
    // music rather than dropping one call.
    const wanted = Array.isArray(sends) ? sends.filter((s) => s && s.name) : [];
    for (const [name, node] of track.sends) {
      if (!wanted.some((s) => s.name === name)) {
        node._edge?.unlink();
        try { node.disconnect(); } catch { /* already detached */ }
        track.sends.delete(name);
      }
    }
    const now = this.getTime();
    for (const send of wanted) {
      let node = track.sends.get(send.name);
      if (!node) {
        // Born at its level, not at unity: a send connected first and ramped down after would
        // put the whole track into the bus for the length of the ramp.
        node = this.ctx.createGain();
        node.gain.value = send.amount ?? 1;
        track.sendFader.connect(node); // post-fader, and a monitored track feeds no bus (see Track's DJ stage)
        node._edge = this.routes.link(node, this._bus(send.name), { src: `t:${trackId}`, dst: `b:${send.name}` });
        track.sends.set(send.name, node);
        continue;
      }
      rampParam(node.gain, send.amount ?? 1, now, now);
    }
    track._sendOrder = wanted.map((s) => s.name);
  }

  setBusSendAmount(trackId, index, amount, atTime) {
    const track = this.tracks.get(trackId);
    const name = track?._sendOrder?.[index];
    const node = name ? track.sends.get(name) : null;
    if (node) rampParam(node.gain, amount, atTime, this.getTime());
  }

  clearBusSends(trackId) {
    this.setBusSends(trackId, []);
  }

  /**
   * The track's head input: a bus it reads (which is how a group reads its members), or a
   * hardware input.
   *
   * The scheduler deliberately does not re-send an audio head input it has already sent, because
   * re-wiring cuts the signal - and for a group row that signal is the whole track.
   */
  setInputSource(trackId, io, name, channel, scalePcs, hwChans, transpose, noteMap) {
    const track = this.createTrack(trackId);
    if (io === 'midi') {
      // Another track's notes, or a MIDI device's, played on this one's instrument through the
      // source's pitch ops. A device is heard once the host has MIDI access (see midiIn).
      this.midiRoutes.add(name, trackId, 0, { transpose, pcs: scalePcs, noteMap, channel });
      if (String(name).startsWith('dev:')) this.onMidiWanted?.();
      return;
    }
    if (String(name).startsWith('dev:')) {
      // A hardware input: two of its channels (or one, heard in both sides) as this track's head.
      this.clearInputSource(trackId);
      this._hwRoutes.set(`head|${trackId}`, { chans: hwChans ?? [0, 1], wire: (node) => {
        node.connect(track.input);
        track._headSource = node;
      } });
      this._wireHardware(`head|${trackId}`);
      return;
    }
    this.clearInputSource(trackId);
    this._route(`head|${trackId}`, name, (from) => this._wireHead(trackId, track, from, name),
      `head:${name}`, `[web-engine] there is nothing called "${name}" for this track to read.`);
  }

  _wireHead(trackId, track, from, name) {
    track._headEdge = this._link(from, track.input, trackId);
    track._headSource = from;
    track._headName = name;
  }

  /** What a track's sidechain wires a route from another track or bus with. */
  _linker(trackId) {
    return (from, to) => this._link(from, to, trackId);
  }

  clearInputSource(trackId) {
    this._waiting.delete(`head|${trackId}`);
    this.midiRoutes.remove(trackId, 0, this.getTime());
    this._dropHardware(`head|${trackId}`);
    const track = this.tracks.get(trackId);
    if (!track?._headSource) return;
    if (track._headEdge) track._headEdge.unlink();
    else { try { track._headSource.disconnect(track.input); } catch { /* already detached */ } }
    track._headEdge = null;
    track._headSource = null;
    track._headName = null;
  }

  // -- the recorder -----------------------------------------------------------------------------
  //
  // A tap on a track's output (see devices/recorder.mjs): a meter while a record panel is open,
  // and a capture of an exact window on the context's clock for a bounce. `onRecLevel` hears the
  // meter; `recordTrack` answers with the frames.

  _tapFor(key, source) {
    let tap = this._taps.get(key);
    if (tap) return tap;
    let node;
    try {
      node = new this.AudioWorkletNodeCtor(this.ctx, 'poptart-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    } catch (err) {
      this._warnOnce('recorder', `[web-engine] the recorder could not start - ${err?.message ?? err}`);
      return null;
    }
    source.connect(node);
    tap = { node, source, metering: false, takes: new Map(), serial: 0 };
    node.port.onmessage = (event) => {
      const m = event.data;
      if (m?.kind === 'level') this.onRecLevel?.(key, m.peak, m.rms);
      else if (m?.kind === 'chunk') tap.takes.get(m.id)?.chunks.push([m.l, m.r]);
      else if (m?.kind === 'done') {
        const take = tap.takes.get(m.id);
        tap.takes.delete(m.id);
        take?.resolve(joinChunks(take.chunks, this.ctx.sampleRate));
        this._untapIfIdle(key);
      }
    };
    this._taps.set(key, tap);
    return tap;
  }

  _untapIfIdle(key) {
    const tap = this._taps.get(key);
    if (!tap || tap.metering || tap.takes.size) return;
    try { tap.node.port.postMessage({ kind: 'dispose' }); } catch { /* gone */ }
    try { tap.source.disconnect(tap.node); } catch { /* gone */ }
    this._taps.delete(key);
  }

  /** Opens or closes a track's meter - what an open record panel costs. */
  tapTrack(trackId, on) {
    const track = this.tracks.get(trackId);
    if (on) {
      if (!track) return false;
      const tap = this._tapFor(trackId, track.panner);
      if (!tap) return false;
      tap.metering = true;
      tap.node.port.postMessage({ kind: 'meter', on: true });
      return true;
    }
    const tap = this._taps.get(trackId);
    if (!tap) return false;
    tap.metering = false;
    try { tap.node.port.postMessage({ kind: 'meter', on: false }); } catch { /* gone */ }
    this._untapIfIdle(trackId);
    return true;
  }

  /**
   * Captures a track's output from `startSec` to `endSec` on the context's clock. Resolves with
   * `{ sampleRate, channels: 2, frames, left, right }`; `cancel()` on the promise drops the take.
   * The master is recorded the same way, as the track id '*'.
   */
  recordTrack(trackId, startSec, endSec) {
    const source = trackId === '*' ? this.master : this.tracks.get(trackId)?.panner;
    if (!source) return Promise.reject(new Error(`there is no track "${trackId}" to record`));
    const tap = this._tapFor(trackId, source);
    if (!tap) return Promise.reject(new Error('the recorder could not start'));
    const id = ++tap.serial;
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    tap.takes.set(id, { chunks: [], resolve: settle.resolve, reject: settle.reject });
    tap.node.port.postMessage({ kind: 'record', id, start: startSec, end: endSec });
    promise.cancel = () => {
      const take = tap.takes.get(id);
      if (!take) return;
      tap.takes.delete(id);
      try { tap.node.port.postMessage({ kind: 'cancel' }); } catch { /* gone */ }
      take.reject(new Error('cancelled'));
      this._untapIfIdle(trackId);
    };
    return promise;
  }

  // -- hardware audio input -------------------------------------------------------------------
  //
  // The host opens the input devices (see the page's audio-input.mjs) and hands in ONE node
  // carrying all of their channels in layout order - the same "one device, channels numbered
  // across it" model the desktop's combined device has, which is what input()'s channel numbers
  // were resolved against. Each route takes its channels off that node through a splitter and a
  // pair merger of its own. A route set before the host has an input to give waits for one, and
  // asks for it: input(1) with nothing chosen opens the browser's default microphone.

  /** The node carrying every open input channel, in layout order, and how many there are. */
  setHardwareInput(node, channels) {
    if (this._hw) { try { this._hw.splitter.disconnect(); this._hw.node.disconnect(this._hw.splitter); } catch { /* gone */ } }
    this._hw = null;
    if (node && channels > 0) {
      const splitter = this.ctx.createChannelSplitter(Math.max(1, Math.min(32, channels)));
      node.connect(splitter);
      this._hw = { node, splitter, channels };
    }
    for (const key of this._hwRoutes.keys()) this._wireHardware(key);
  }

  /** Wires one route to the open input, rebuilding its channel picker; waits if there is none. */
  _wireHardware(key) {
    const route = this._hwRoutes.get(key);
    if (!route) return;
    route.dispose?.();
    route.dispose = null;
    if (!this._hw) { this.onAudioInputWanted?.(); return; }
    const [a, b] = route.chans;
    const pick = this.ctx.createChannelMerger(2);
    const max = this._hw.channels - 1;
    const left = Math.min(max, Math.max(0, a));
    const right = b == null || b < 0 ? left : Math.min(max, b);
    if (a > max || (b != null && b > max)) {
      this._warnOnce(`hw:${a}:${b}`, `[web-engine] the open audio inputs have ${this._hw.channels} channel${this._hw.channels === 1 ? '' : 's'}, so input channel ${Math.max(a, b ?? 0) + 1} reads channel ${max + 1} instead.`);
    }
    this._hw.splitter.connect(pick, left, 0);
    this._hw.splitter.connect(pick, right, 1);
    route.wire(pick);
    const splitter = this._hw.splitter;
    route.dispose = () => {
      try { splitter.disconnect(pick); } catch { /* gone */ }
      try { pick.disconnect(); } catch { /* gone */ }
    };
  }

  _dropHardware(key) {
    const route = this._hwRoutes.get(key);
    route?.dispose?.();
    this._hwRoutes.delete(key);
  }

  /** `midikeys("Keystep")`: a MIDI device plays this track's instrument live. */
  setMidiNotes(trackId, device, channel = 0, scalePcs = null, transpose = 0, noteMap = null) {
    this.midiRoutes.add(`dev:${device}`, trackId, 0, { transpose, pcs: scalePcs, noteMap, channel });
    this.onMidiWanted?.();
  }

  clearMidiNotes(trackId) {
    const route = this.midiRoutes.routes.find((r) => r.targetTrackId === trackId && r.slot === 0);
    if (route?.name.startsWith('dev:')) this.midiRoutes.remove(trackId, 0, this.getTime());
  }

  /**
   * One message from a MIDI device, as the host's Web MIDI listener parsed it. `kind` is 'on',
   * 'off' or 'cc'; `channel` 1-16; `value` a note's velocity or a controller's value, both 0..1.
   * Played now - live input never goes through the lookahead, so its latency is the driver's.
   */
  midiIn(device, kind, channel, num, value, atTime = this.getTime()) {
    if (kind === 'cc') { this._feedCCFrom(device, channel, num, value, atTime); return; }
    if (kind !== 'on' && kind !== 'off') return;
    const isOn = kind === 'on' && value > 0;
    this.midiRoutes.deviceEdge(device, channel, num, isOn ? value : 0, atTime, isOn, (trackId, slot, note, velocity, on) => {
      // What an instrument actually played, for the live log - capture and MIDI record.
      if (slot === 0) this.onLiveNote?.(trackId, note, velocity, on);
    });
  }

  /**
   * Feeds another track or bus into an effect's second input - the carrier of a cross-modulator,
   * the key of a ducker, the modulator of a vocoder. Only a device that declares a sidechain has
   * one; on any other the call warns by name and the effect plays as written.
   */
  injectAudio(trackId, slot, name, gain = 1, hwChans = null) {
    const track = this.tracks.get(trackId);
    const filled = track?.slots.get(slot);
    if (!track || !filled) return;
    if (!filled.descriptor.sidechain) {
      this._warnOnce(`inject:${filled.descriptor.id}`, `[web-engine] "${filled.descriptor.id}" has no sidechain input, so .audio() into it does nothing.`);
      return;
    }
    if (String(name).startsWith('dev:')) {
      // A hardware input into the sidechain: a voice keying a ducker, a mic into a compressor.
      this._dropHardware(`side|${trackId}|${slot}`);
      this._hwRoutes.set(`side|${trackId}|${slot}`, { chans: hwChans ?? [0, 1], wire: (node) => track.setSidechain(slot, node, name, gain) });
      this._wireHardware(`side|${trackId}|${slot}`);
      return;
    }
    this._route(`side|${trackId}|${slot}`, name, (from) => track.setSidechain(slot, from, name, gain, this._linker(trackId)),
      `source:${name}`, `[web-engine] there is nothing called "${name}" to feed into "${filled.descriptor.id}".`);
  }

  clearAudioInject(trackId, slot) {
    this._waiting.delete(`side|${trackId}|${slot}`);
    this._dropHardware(`side|${trackId}|${slot}`);
    this.tracks.get(trackId)?.clearSidechain(slot);
  }

  /**
   * Plays an effect from another track's notes - `.fx("Ducker").midi("kick")`. Only an effect
   * that declares it takes notes can be played; any other says so by name and plays as written.
   * `note` pins the pitch the route plays, where the call gave one.
   */
  injectMidi(trackId, slot, name, note = null) {
    const filled = this.tracks.get(trackId)?.slots.get(slot);
    if (!filled) return;
    if (String(name).startsWith('dev:')) this.onMidiWanted?.();
    if (slot > 0 && !filled.descriptor.notes) {
      const takers = this.registry?.list?.('fx')?.filter((d) => d.notes).map((d) => d.id) ?? [];
      this._warnOnce(`inject-midi:${filled.descriptor.id}`, `[web-engine] "${filled.descriptor.id}" is not played by notes, so .midi() into it does nothing.${takers.length ? ` Effects that are: ${takers.join(', ')}.` : ''}`);
      return;
    }
    this.midiRoutes.add(name, trackId, slot, { note });
    try { filled.built.node?.port?.postMessage({ kind: 'noteRoute', on: true }); } catch { /* no port */ }
  }

  clearMidiInject(trackId, slot) {
    this.midiRoutes.remove(trackId, slot, this.getTime());
    const filled = this.tracks.get(trackId)?.slots.get(slot);
    try { filled?.built.node?.port?.postMessage({ kind: 'noteRoute', on: false }); } catch { /* no port */ }
  }

  // -- device state ------------------------------------------------------------------------

  /**
   * A device's "program" is its parameter map in real units, so a preset is JSON rather than an
   * opaque blob. Returning a resolved promise keeps the scheduler's contract - it treats the
   * result as a promise of whether the state landed - without pretending there is anything
   * asynchronous about setting a few numbers.
   */
  setPluginState(trackId, slot, state, atTime) {
    const track = this.tracks.get(trackId);
    if (!track?.slots.has(slot)) return Promise.resolve(false);
    let parsed;
    try {
      parsed = typeof state === 'string' ? JSON.parse(decodeState(state)) : state;
    } catch {
      this._warnOnce(`state:${trackId}:${slot}`, '[web-engine] that preset is not something a browser device can read, so the slot keeps its current settings.');
      return Promise.resolve(false);
    }
    const values = parsed?.params ?? parsed;
    if (!values || typeof values !== 'object') return Promise.resolve(false);
    const now = this.getTime();
    const files = parsed?.files ?? {};
    // A parameter something else is driving is not a preset's to set, for the same reason it is
    // not setParam's: a modulator adds to the intrinsic value, which it zeroed, so
    // writing the captured number back would offset the modulation by it and squash it against
    // the top of the range. The rest of the preset lands; these keep their modulator.
    const driven = this.drivenParams(trackId, slot);
    const skipped = [];
    for (const [id, value] of Object.entries(values)) {
      // A control pointed at a file is restored from the file's NAME below, not from the option
      // slot it happened to sit in when the preset was taken.
      if (id in files) continue;
      if (driven.has(id)) { skipped.push(id); continue; }
      track.setParamValue(slot, id, value, atTime ?? now, now);
    }
    if (skipped.length) {
      this._warnOnce(
        `state-driven:${trackId}:${slot}:${skipped.join(',')}`,
        `[web-engine] the preset does not set ${skipped.join(', ')} - ${skipped.length === 1 ? 'it is' : 'they are'} driven by ${[...new Set(skipped.map((id) => driven.get(id)))].join(' and ')}, which stays in charge.`,
      );
    }
    for (const [id, ref] of Object.entries(files)) this.setParam(trackId, slot, id, ref, atTime ?? now, 0);
    return Promise.resolve(true);
  }

  getPluginState(trackId, slot) {
    const track = this.tracks.get(trackId);
    const filled = track?.slots.get(slot);
    if (!filled) return Promise.resolve(null);
    // Which file each control that takes one is pointed at. Written as the reference it was
    // loaded from rather than as an option index: the index is wherever THIS device put the file
    // this time round, and a preset restored into a fresh one would point at an empty slot.
    const files = {};
    for (const p of filled.descriptor.params) {
      if (!p.takes) continue;
      const ref = filled.extras?.[p.id]?.[Math.round(filled.values[p.id])];
      if (ref) files[p.id] = ref;
    }
    return Promise.resolve(encodeState(JSON.stringify({
      device: filled.descriptor.id,
      version: filled.descriptor.version,
      params: { ...filled.values },
      files,
    })));
  }

  cancelPluginState() { /* a parameter map lands at once; there is nothing in flight to cancel */ }

  /**
   * What is driving each parameter of one slot, as `paramId -> a phrase naming the source`.
   *
   * A driven parameter is not a panel's to set: the modulator is the whole value, and a scalar
   * written over it would be fought over until one of them stopped - which is why setParam
   * ignores one. So the panel draws these read-only, and it has to be able to say what is
   * moving them rather than leaving a knob that mysteriously does nothing.
   *
   * Connections are keyed by the name the pattern used, which may be a parameter's id or its
   * display name, so each key is resolved back to an id before it is reported.
   */
  drivenParams(trackId, slot) {
    const out = new Map();
    const track = this.tracks.get(trackId);
    const descriptor = track?.slots.get(slot)?.descriptor;
    if (!descriptor) return out;
    const prefix = `${slot}:`;
    const record = (key, what) => {
      if (!key.startsWith(prefix)) return;
      const name = key.slice(prefix.length);
      const found = findParam(descriptor, name);
      if (found) out.set(found.id, what);
    };
    for (const [key, conn] of this.modulators.get(trackId) ?? []) record(key, conn.kind ?? 'a modulator');
    for (const [key, rec] of this.exprs.get(trackId) ?? []) if (rec.json != null) record(key, 'a combination of signals');
    return out;
  }

  /**
   * The device in one slot and everything a panel is drawn from. Null for an empty slot, which
   * is what a double-click on a name the buffer has since changed asks about.
   */
  /**
   * How late each slot of a track's chain is, in seconds, by slot index: what a device declares
   * as its `latencySec` (a spectral shifter's analysis window). The scheduler plays notes early
   * by the sum, so a device that is late by design still lands on the beat. An empty slot is 0.
   */
  /** The highest effect slot the track has filled: as far as a fresh Scheduler has to empty. */
  effectSlots(trackId) {
    return Math.max(0, ...(this.tracks.get(trackId)?.slots.keys() ?? []));
  }

  slotLatencies(trackId) {
    const out = [];
    for (const [index, filled] of this.tracks.get(trackId)?.slots ?? []) out[index] = filled.descriptor.latencySec ?? 0;
    return Array.from(out, (v) => v ?? 0);
  }

  deviceState(trackId, slot) {
    const filled = this.tracks.get(trackId)?.slots.get(slot);
    if (!filled) return null;
    return {
      descriptor: filled.descriptor,
      values: { ...filled.values },
      driven: this.drivenParams(trackId, slot),
      extras: filled.extras,
      tables: filled.tables ?? null,
      // The tempo, for the pictures drawn on the clock: a synced delay's repeats land where the
      // beats are, and only the engine knows where those are.
      bpm: this.bpm,
      // The outlines of whatever it is playing: files this slot loaded, and - for a device built
      // from stock nodes - whatever it synthesized for itself (a convolver's impulse).
      waves: (filled.waves || filled.built.outlines) ? { ...filled.built.outlines, ...filled.waves } : null,
      shapes: filled.shapes ?? null,
    };
  }

  /**
   * Turns a processor's reporting on or off. While it is on, `liveValues` answers with where
   * each control actually is - which for a control under a modulator is the only way to know.
   */
  watchDevice(trackId, slot, on) {
    const filled = this.tracks.get(trackId)?.slots.get(slot);
    if (!filled) return false;
    try { filled.built.node?.port?.postMessage?.({ kind: 'watch', on: !!on }); } catch { /* no port */ }
    // A device that draws an equalizer curve gets an analyser on its output for as long as its
    // window is open, and not a moment longer: the curve is drawn over what the signal actually
    // is (see SpectrumTap), and an FFT per frame is worth paying for a picture being looked at.
    const wantsSpectrum = (filled.descriptor.figures ?? []).some((f) => f.kind === 'eq');
    if (on && wantsSpectrum && !filled.spectrum && filled.built.node) {
      try { filled.spectrum = new SpectrumTap(this.ctx, filled.built.node); } catch { filled.spectrum = null; }
    }
    if (!on) {
      filled.live = null;
      filled.report = null;
      filled.spectrum?.dispose();
      filled.spectrum = null;
    }
    return true;
  }

  /**
   * The real value each of one slot's controls was last read at by its processor, or null when
   * the processor is not reporting. A control nothing is moving reads exactly what was set.
   */
  liveValues(trackId, slot) {
    const filled = this.tracks.get(trackId)?.slots.get(slot);
    if (!filled?.live) return null;
    const out = {};
    for (const p of filled.descriptor.params) {
      const pos = filled.live[p.id];
      out[p.id] = pos === undefined ? filled.values[p.id] : denormalize(p, pos);
    }
    return out;
  }

  /**
   * What a watched device last said it was doing, beyond where its controls are - or null. The
   * shape is the device's own; only a granulator has one so far, and it reports its grains.
   */
  liveReport(trackId, slot) {
    const filled = this.tracks.get(trackId)?.slots.get(slot);
    if (!filled) return null;
    const report = filled.report ?? null;
    if (!filled.spectrum) return report;
    // The spectrum rides on the report, as decibels below full scale per band, at the mixer's
    // band centers - so a picture can draw it down the same frequency axis as its curve.
    const db = filled.spectrum.bands();
    return { ...(report ?? {}), spectrum: filled.spectrum.freqs.map((hz, i) => ({ hz, db: db[i] })) };
  }

  /** Every parameter of one slot, in the shape the params panel and autocomplete expect. */
  getParams(trackId, slot) {
    const filled = this.tracks.get(trackId)?.slots.get(slot);
    if (!filled) return Promise.resolve([]);
    return Promise.resolve(filled.descriptor.params.map((p, index) => ({
      name: p.name, label: p.unit, index, id: p.id, min: p.min, max: p.max, default: p.default, ui: p.ui,
      options: p.options ? [...p.options] : null, rate: p.rate,
    })));
  }

  // -- samples -----------------------------------------------------------------------------

  /**
   * The pack `.bank()` makes of a pack name: s("bd").bank("808") plays the pack "808_bd". A bank
   * with no pack of that name here warns once and plays the pack the pattern named. Only a plain
   * pack name takes a bank; a recording or anything else namespaced is played as written.
   */
  _bankPack(pack, bank) {
    const name = String(bank ?? '').trim();
    if (!name || typeof pack !== 'string' || pack.includes(':')) return pack;
    const banked = `${name}_${pack}`;
    const known = this.samples?.knows ? this.samples.knows(banked) : this.samples?.get?.(banked, 0) != null;
    if (known) return banked;
    this._warnOnce(`bank:${banked}`, `[web-engine] .bank(${JSON.stringify(name)}): there is no "${banked}" pack - playing "${pack}".`);
    return pack;
  }

  /**
   * Plays one sample. The scheduler reads the returned object straight back for its log line, so
   * it is built synchronously - and a reason for NOT playing is a field on it rather than an
   * exception, because a missing sample should cost one quiet line and not the rest of the tick.
   */
  playSample(trackId, pack, cfg = {}, onsetSec, offsetSec) {
    const track = this.createTrack(trackId);
    // A named pack arrives as `sp:<id>` - the scheduler's spelling for a pack the language
    // defines, as against a folder or a recording - and the store keys packs by their bare id.
    const named = typeof pack === 'string' && pack.startsWith('sp:') ? pack.slice(3) : pack;
    const packId = cfg.bank != null && named === pack ? this._bankPack(pack, cfg.bank) : named;
    // Routed onward as an on/off pair, whether or not this sample has loaded yet: a kick keys a
    // ducker by being scheduled, not by being heard.
    if (this.midiRoutes.size && (cfg.vel ?? 1) > 0) this.midiRoutes.sampleEvent(trackId, cfg.vel ?? 1, onsetSec, offsetSec, cfg.note ?? null);
    // Spoken text (say()) is rendered by the desktop's system voices, which a browser can't reach.
    if (typeof packId === 'string' && packId.startsWith('say:')) {
      this._warnOnce('say', '[web-engine] say() plays in the desktop app only - the browser has no way to render the system voices into a sample.');
      return { skipped: 'say() is desktop only' };
    }
    // A recording, by name: sr("bass") arrives as rec:bass.
    const isRec = typeof packId === 'string' && packId.startsWith('rec:');
    // One file of a pack by its name: s("files:loop.wav") plays the file of that name, matched as
    // a device's sample control matches it (see _sampleIndex).
    const byName = !isRec && typeof packId === 'string' && !packId.startsWith('file:') ? parseSampleRef(packId) : null;
    const source = byName ? byName.pack : packId;
    const index = byName ? this._sampleIndex(byName.pack, byName.key) : cfg.index ?? 0;
    // A name the store can't place yet may be in a pack that has not loaded: asking for its first
    // file starts that load, so the name plays once it is in.
    if (byName && index == null) this.samples?.get?.(source, 0);
    const got = isRec
      ? this.samples?.named?.('rec', packId.slice(4)) ?? null
      : index == null ? null : this.samples?.get?.(source, index) ?? null;
    // The store may hand back a bare AudioBuffer, or the buffer with the note it was recorded at.
    const buffer = got?.buffer ?? got;
    if (!buffer) {
      this._unknownSource(isRec ? null : source);
      return { skipped: 'source not ready' };
    }
    const rootNote = Number.isFinite(got?.rootNote) ? got.rootNote : SAMPLER_ANCHOR;

    // The slice positions `.slice(n)` indexes: the hand-drawn set's marks for this file where it
    // has some, and the file's own transients otherwise - worked out on first ask, off the tick.
    const key = isRec ? `rec:${packId.slice(4)}.wav` : this.samples?.fileKey?.(source, index) ?? null;
    const authored = cfg.slices ? sliceEntryFor(cfg.slices, key) ?? sliceEntryFor(cfg.slices, key?.split('/').pop()) : null;
    const slices = cfg.slice != null ? authored?.marks ?? this._transientsOf(buffer) : null;
    const plan = planSample({ duration: buffer.duration, rootNote }, { ...cfg }, onsetSec, offsetSec, { slices, authoredFit: authored?.fit ?? null, anchor: SAMPLER_ANCHOR });
    if (plan.skipped) return { skipped: plan.skipped };
    if (plan.noSlices) this._warnOnce(`slices:${key}`, `[web-engine] .slice(): no transients were found in ${key ?? packId} - playing the whole sample.`);

    const backwards = plan.speed < 0 ? reversedBuffer(this.ctx, buffer) : null;
    if (plan.speed < 0 && !backwards) {
      this._warnOnce(`reverse:${packId}`, `[web-engine] "${packId}" cannot be played backwards here, so a negative speed plays it forwards.`);
    }
    const info = {
      index, begin: plan.begin, end: plan.end, loop: plan.loop, speed: plan.speed, stretch: plan.stretch,
      durSec: plan.durSec, cut: plan.cut, amp: plan.amp, fileSec: plan.fileSec,
      attack: plan.attack, decay: plan.decay, release: plan.release,
      loopWrap: plan.windowed ? 'window' : 'file', loopDir: plan.pingpong ? 'pingpong' : 'forward',
    };

    // .grain(): a cloud of grains read from the file, in place of the file played through.
    if (plan.grain) return { ...info, ...this._playGrains(track, buffer, cfg, plan, offsetSec) };
    // .stretch() other than one: the window played at its own pace with the pitch held.
    if (plan.stretch !== 1) {
      this._playWarp(track, buffer, plan);
      return info;
    }
    // A recording cut as a held note carries a sustain loop: honored when nothing else asked for a
    // loop and the note is played forwards, so a held key keeps sounding instead of running out.
    const sustain = !plan.loop && plan.speed > 0 && got?.loop ? got.loop : null;
    this._playPlain(track, buffer, backwards, plan, sustain);
    return sustain ? { ...info, sustainLoop: true } : info;
  }

  /** An event's amplitude: attack to full, decay to sustain, held to the gate, then released. */
  _envelope(amp, plan, start, gateEnd) {
    const attack = Math.max(0.0005, plan.attack);
    const release = Math.max(0.015, plan.release);
    const sus = Math.min(1, Math.max(0, plan.sustain)) * plan.amp;
    amp.gain.setValueAtTime(0, start);
    amp.gain.linearRampToValueAtTime(plan.amp, start + attack);
    if (plan.decay > 0) amp.gain.linearRampToValueAtTime(sus, start + attack + plan.decay);
    const held = plan.decay > 0 ? sus : plan.amp;
    const holdFrom = Math.max(start + attack + plan.decay, gateEnd);
    amp.gain.setValueAtTime(gateEnd > start + attack + plan.decay ? held : held, holdFrom);
    amp.gain.linearRampToValueAtTime(0, holdFrom + release);
    return holdFrom + release;
  }

  /** The file read straight through at a rate: a one-shot, a loop, or a ping-pong loop. */
  _playPlain(track, buffer, backwards, plan, sustain = null) {
    const fileSec = buffer.duration;
    const rate = Math.abs(plan.speed);
    const reverse = backwards !== null;
    // Positions in the buffer actually read: a backwards event reads the reversed copy, so every
    // position is mirrored into it.
    const at = (p) => (reverse ? fileSec * (1 - p) : fileSec * p);
    const source = this.ctx.createBufferSource();
    let offset;
    let playFor = null;
    if (plan.loop && plan.pingpong) {
      // Ping-pong: the loop window forwards and then backwards, as one buffer looped whole.
      const pp = pingPongBuffer(this.ctx, buffer, plan.loopLo, plan.loopHi);
      if (pp) {
        source.buffer = pp.buffer;
        source.loop = true;
        const entry = Math.min(plan.loopHi, Math.max(plan.loopLo, plan.loopEntry));
        const into = (entry - plan.loopLo) * fileSec;
        offset = plan.speed < 0 ? pp.span * 2 - into : into;
      }
    }
    if (offset === undefined) {
      source.buffer = backwards ?? buffer;
      if (plan.loop) {
        source.loop = true;
        const lo = at(reverse ? plan.loopHi : plan.loopLo);
        const hi = at(reverse ? plan.loopLo : plan.loopHi);
        source.loopStart = Math.min(lo, hi);
        source.loopEnd = Math.max(lo, hi);
        offset = at(plan.loopEntry);
      } else {
        offset = at(reverse ? plan.end : plan.begin);
        playFor = fileSec * (plan.end - plan.begin);
      }
    }
    source.playbackRate.value = rate;
    // A sustain loop: the attack plays once, then the loop section repeats until the note ends.
    const sustained = sustain && sustain.end <= buffer.length && sustain.end > sustain.start;
    if (sustained) {
      source.loop = true;
      source.loopStart = sustain.start / buffer.sampleRate;
      source.loopEnd = sustain.end / buffer.sampleRate;
      playFor = null;
    }

    const amp = this.ctx.createGain();
    source.connect(amp);
    amp.connect(track.input);
    const start = Math.max(this.getTime(), plan.onsetSec);
    // Loops play to the gate; a one-shot to the gate or its own end, whichever comes first.
    const gateEnd = plan.loop || plan.cut || sustained ? Math.max(start, plan.offsetSec) : start + plan.durSec;
    const stopAt = this._envelope(amp, plan, start, gateEnd);
    const bend = track.bendCents ?? null;
    if (bend) { try { bend.connect(source.detune); } catch { /* no detune */ } }
    if (playFor != null) source.start(start, offset, playFor);
    else source.start(start, offset);
    source.stop(stopAt + 0.005);
    const voice = this._voice(track, { amp, start, release: plan.release, sources: [source] });
    source.onended = () => {
      voice.finished();
      try { source.disconnect(); amp.disconnect(); } catch { /* already detached */ }
      // Disconnecting the voice's outputs leaves the bend constant's connection INTO it, and with
      // it a reference to every voice the track ever played.
      if (bend) { try { bend.disconnect(source.detune); } catch { /* never connected */ } }
    };
  }

  /**
   * .stretch(): the desktop's warp voice - Warp1's 100 ms Hann grains, eight overlapping, each a
   * tenth longer or shorter at random, along a pointer that walks the window (or loops it) at the
   * event's own pace while each grain plays at the rate. So the pitch is the rate's and the length
   * is the stretch's, as on the desktop. Laid on the audio thread (see devices/grain-cloud.mjs).
   */
  _playWarp(track, buffer, plan) {
    const start = Math.max(this.getTime(), plan.onsetSec);
    const gateEnd = plan.loop || plan.cut ? Math.max(start, plan.offsetSec) : start + plan.durSec;
    const amp = this.ctx.createGain();
    const end = this._envelope(amp, plan, start, gateEnd);
    this._cloudVoice(track, amp, start, plan, {
      ...this._grainFile(buffer),
      mode: 'warp',
      rate: Math.abs(plan.speed) * (buffer.sampleRate / this.ctx.sampleRate),
      speed: plan.speed,
      begin: plan.begin,
      end01: plan.end,
      durSec: plan.durSec,
      loop: !!plan.loop,
      loopLo: plan.loopLo,
      loopHi: plan.loopHi,
      loopEntry: plan.loopEntry,
      pingpong: !!plan.pingpong,
      start,
      end: end + 0.005,
    });
  }


  /** A file's transient slice starts, worked out once and off the tick: undefined until then. */
  _transientsOf(buffer) {
    if (this._transients.has(buffer)) return this._transients.get(buffer);
    this._transients.set(buffer, undefined);
    setTimeout(() => {
      try {
        this._transients.set(buffer, typeof buffer.getChannelData === 'function' ? detectOnsets(monoOf(buffer), buffer.sampleRate) : null);
      } catch {
        this._transients.set(buffer, null);
      }
    }, 0);
    return undefined;
  }

  /** The master level, which the host uses for its own fade in and out. */
  setMasterGain(value, atTime) {
    rampParam(this.master.gain, value, atTime, this.getTime());
  }

  // -- the DJ desk ------------------------------------------------------------------------------

  /** The headphone section's two knobs (see desk-audio.mjs). */
  setHeadphones(level, mix) {
    this.desk.setHeadphones(Number(level), Number(mix));
  }

  /**
   * Where the headphone cue plays: `{ pair }` - a stereo pair of this output, from 0 - or
   * `{ node }`, a node the host carries to another device, or null for nowhere. A pair past the
   * output's channels widens the output to reach it, if the device has the channels.
   */
  setCueRoute(route) {
    if (route && Number.isInteger(route.pair)) {
      const need = (route.pair + 1) * 2;
      if (this.outputChannels < need) {
        if (this.setOutputChannels(need) < need) throw new Error(`this output has no channels ${need - 1}/${need}`);
      }
    }
    this.desk.setRoute(route);
    for (const track of this.tracks.values()) this._routeOut(track);
  }

  /** The cue's route as plain data: the pair it is on, or whether it goes to another device. */
  cueRoute() {
    const r = this.desk.route;
    return r ? (r.pair != null ? { pair: r.pair } : { device: true }) : null;
  }

  /** The headphone signal itself, for a host that carries it to another device. */
  get cueOutput() {
    return this.desk.out;
  }

  /**
   * A track's send into the DJ FX unit: `bus` names the bus the deck's return reads ('' parks
   * it), `level` how far the unit is switched in (see Track#setFxSend - an insert, not an aux).
   */
  setFxSend(trackId, bus, level) {
    const track = this.tracks.get(trackId);
    if (!track) return;
    track.setFxSend(bus ? this._bus(bus) : null, level, this.getTime(),
      (from, to) => this.routes.link(from, to, { src: `t:${trackId}`, dst: `b:${bus}` }));
  }

  /** The deck meters exist only while somebody is looking at them. */
  deckMeters(on) {
    this.desk.setMeters(!!on);
  }

  /** One reading of the deck meters and the master - null while they are off. */
  deckLevels() {
    return this.desk.read();
  }

  // -- songs on a DJ deck ----------------------------------------------------------------------

  /** The most a song is ever late: how far ahead a timed change has to be sent (see song-player.mjs). */
  get songLatency() {
    return SONG_LATENCY_SEC;
  }

  /** How soon from now a change to this track's song can be heard: 0 unless keylock is on. */
  songLead(trackId) {
    return this.songs.get(trackId)?.lead ?? 0;
  }

  _song(trackId) {
    let player = this.songs.get(trackId);
    if (!player) {
      const track = this.createTrack(trackId);
      player = new SongPlayer(this, track);
      this.songs.set(trackId, player);
    }
    return player;
  }

  /**
   * Puts a decoded song on a track: `planes` are its channels as 16-bit samples at this
   * context's rate, handed over (transferred) rather than copied. Replaces any song it held.
   */
  songLoad(trackId, { planes, frames }) {
    this._song(trackId).load({ planes, frames });
    return { sampleRate: this.ctx.sampleRate, frames, channels: planes.length };
  }

  // Every time is when the change is heard, no sooner than songLead from now.
  songStart(trackId, pos, rate, at, keylock = false) { this._song(trackId).start(pos, rate, at, keylock); }
  songRate(trackId, rate, at) { this.songs.get(trackId)?.setRate(rate, at); }
  songSeek(trackId, pos, at) { this.songs.get(trackId)?.seek(pos, at); }
  songPause(trackId, at) { this.songs.get(trackId)?.pause(at); }
  songStop(trackId, at, release) { this.songs.get(trackId)?.stop(at, release); }
  songKeylock(trackId, on, at) { this.songs.get(trackId)?.setKeylock(!!on, at); }
  songQuery(trackId) { return this.songs.get(trackId)?.query() ?? Promise.resolve(null); }

  /** Lets a track's song go: the player stops and the song's memory is released. */
  songFree(trackId) {
    const player = this.songs.get(trackId);
    if (!player) return;
    player.dispose();
    this.songs.delete(trackId);
  }

  async stop() {
    this.analysis.setMonitor(false);
    for (const id of [...this.tracks.keys()]) this.destroyTrack(id);
    for (const bus of this.buses.values()) {
      try { bus.disconnect(); } catch { /* already detached */ }
    }
    this.buses.clear();
  }
}

/** A take's chunks as one pair of channels. */
function joinChunks(chunks, sampleRate) {
  const frames = chunks.reduce((n, [l]) => n + l.length, 0);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let at = 0;
  for (const [l, r] of chunks) { left.set(l, at); right.set(r, at); at += l.length; }
  return { sampleRate, channels: 2, frames, left, right };
}
