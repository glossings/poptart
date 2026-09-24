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
import { defaultValues, denormalize, findParam } from '../descriptor.mjs';
import { decodeWav, framesOf } from '../dsp/wavfile.mjs';
import { buildMipmaps, powerOfTwoAtLeast, resampleFrame } from '../dsp/tables.mjs';
import { outlineOf } from '../dsp/outline.mjs';
import { MIX_BAND_FREQS, MIX_TRACK_MAX, MixAnalysis, SpectrumTap } from './analysis.mjs';
import { MidiRoutes } from './midi-routes.mjs';
import { detectOnsets, monoOf, planSample, sliceEntryFor } from './sample-plan.mjs';
import { EnvConnection, FeedConnection, LfoConnection } from './modulators.mjs';
import { SUPPORTED_CHANNELS, Track, rampParam, teardownParamConnection } from './track.mjs';

const keyOf = (slot, name) => `${slot}:${name}`;

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
  } = {}) {
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
    this.envelopes = new Map();     // trackId -> Map("slot:name" -> EnvConnection), gated per note
    this.feeds = new Map();         // "device|cc" or "osc:address" -> Set(FeedConnection)
    this._hw = null;                // the open hardware inputs: { node, splitter, channels }
    this._taps = new Map();         // track id ('*' for the master) -> recorder tap
    this._transients = new WeakMap(); // AudioBuffer -> slice starts (undefined while working, null for none)
    this._hwRoutes = new Map();     // "head|track" / "side|track|slot" -> { chans, wire, dispose }
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
    // Where a beat falls on the context's clock: the time cycle zero was at. The devices on the
    // grid count from it.
    this.anchorSec = 0;
    // The meters and plots, built only while the mixer is open.
    this.analysis = new MixAnalysis(ctx, this.master);
  }

  // -- what the mixer reads -----------------------------------------------------------------

  /** The band centers the plots are drawn at, lowest first. */
  mixBandFreqs() {
    return [...MIX_BAND_FREQS];
  }

  /** The most tracks that get an analyzer of their own; past it only the master is drawn. */
  mixTrackMax() {
    return MIX_TRACK_MAX;
  }

  /** Turns the analysis on or off. Off takes every tap out of the graph. */
  setMixMonitor(on) {
    return this.analysis.setMonitor(on);
  }

  /**
   * One reading for the mixer: a level and a band frame per strip, and the same for the master
   * under '*'.
   *
   * `ids` is what the panel is showing, in its own order. Past the budget the tracks get no
   * analyzer at all and only the master is read - which is what `perTrack: false` tells the
   * panel, so it can say why the plots moved rather than appearing to lose the tracks.
   */
  mixRead(ids = []) {
    const wanted = ids.filter((id) => this.tracks.has(id));
    const perTrack = wanted.length <= MIX_TRACK_MAX;
    const sources = new Map();
    sources.set('*', this.master);
    if (perTrack) for (const id of wanted) sources.set(id, this.tracks.get(id).panner);
    const { levels, spec } = this.analysis.read(sources);
    return { on: this.analysis.on, levels, spec, perTrack, perTrackMax: MIX_TRACK_MAX };
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
      track = new Track(this.ctx, trackId, this.master, this.registry);
      this.tracks.set(trackId, track);
      this.modulators.set(trackId, new Map());
      this.envelopes.set(trackId, new Map());
    }
    if (initial) {
      const now = this.getTime();
      for (const [name, value] of Object.entries(initial)) track.setChannel(name, value, now, now);
    }
    return track;
  }

  destroyTrack(trackId) {
    const track = this.tracks.get(trackId);
    if (!track) return;
    this._clearAllModulators(trackId);
    track.dispose();
    this.tracks.delete(trackId);
    this.modulators.delete(trackId);
    this.envelopes.delete(trackId);
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
    const inputs = (descriptor.channels.in > 0 ? 1 : 0) + (descriptor.sidechain ? 1 : 0);
    const node = new this.AudioWorkletNodeCtor(this.ctx, descriptor.processor, {
      numberOfInputs: inputs,
      numberOfOutputs: 1,
      outputChannelCount: [descriptor.channels.out],
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
    const now = this.getTime();
    for (const [id, value] of Object.entries(defaultValues(descriptor))) {
      track.setParamValue(slot, id, value, now, now);
    }
    for (const { method, name, ir } of carried.modulators) this[method](trackId, slot, name, ir);
    for (const { name, source, gain, offset } of carried.connections) this.connectParam(trackId, slot, name, source, gain, offset);
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
      modulators.push({ method: conn.method, name: key.slice(prefix.length), ir: conn.ir });
      this._clearModulator(trackId, slot, key.slice(prefix.length));
    }
    const track = this.tracks.get(trackId);
    const connections = track?.takeConnections(slot) ?? [];
    const sidechain = track?.sidechains.get(slot)?.source ?? null;
    track?.clearSidechain(slot);
    return { modulators, connections, sidechain };
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

  // -- tempo -------------------------------------------------------------------------------

  /**
   * The transport's tempo, for the devices that sync to it - a delay in beats, a ducker in
   * steps. Every processor with a port is told, and a device built later is told on its way
   * in, so nothing has to be re-sent when the buffer is re-evaluated.
   */
  setTempo(bpm, anchorSec = null) {
    if (!(bpm > 0) || !Number.isFinite(bpm)) return;
    this.bpm = bpm;
    if (Number.isFinite(anchorSec)) this.anchorSec = anchorSec;
    for (const track of this.tracks.values()) {
      for (const slot of track.slots.values()) {
        try { slot.built.node?.port?.postMessage?.({ kind: 'tempo', bpm, anchorSec: this.anchorSec }); } catch { /* no port */ }
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

  /** A note on a track's own instrument, and the envelopes it gates - with no routing onward. */
  _playNote(trackId, note, velocity, atTime) {
    const source = this.tracks.get(trackId)?.source;
    if (source?.node?.port) source.node.port.postMessage({ kind: 'noteOn', note, velocity, time: atTime });
    for (const env of this.envelopes.get(trackId)?.values() ?? []) env.gateOn(atTime);
  }

  _stopNote(trackId, note, atTime) {
    const source = this.tracks.get(trackId)?.source;
    if (source?.node?.port) source.node.port.postMessage({ kind: 'noteOff', note, time: atTime });
    for (const env of this.envelopes.get(trackId)?.values() ?? []) env.gateOff(atTime);
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
  }

  // -- the granular sample voice -----------------------------------------------------------------
  //
  // The desktop's poptart_sample_grain, on the main thread: a grain every 1/rate seconds, each a
  // piece of the file `size` long under a window, placed by `pan` and read from the position -
  // the event's begin, or the track's streamed position when the pattern drives it. Size, rate,
  // pan and position are the track's channel controls, READ AS EACH GRAIN STARTS, so a signal on
  // any of them moves grain by grain (see Track#setChannel). A short lookahead timer lays the
  // grains down on the audio clock, so each starts on its sample. Overlapping grains are copies at
  // unrelated phases, so their power adds; the cloud is divided by the square root of half its
  // overlap, as the desktop's is, so a denser or longer grain thickens it without turning it up.

  _playGrains(track, buffer, cfg, { rate, vel, onsetSec, offsetSec, fileSec, from }) {
    const g = track.grain;
    // The event's own values at its onset seed the track, so the first grain does not read
    // whatever the last event left there (the scheduler sends them for exactly this).
    if (Number.isFinite(cfg.grainSize)) g.size = cfg.grainSize;
    if (Number.isFinite(cfg.grainRate)) g.rate = cfg.grainRate;
    if (Number.isFinite(cfg.grainPan)) g.pan = cfg.grainPan;
    const posLive = cfg.grainPosLive === 1;
    const window = this._grainWindow(cfg.grainShape);
    const start = Math.max(this.getTime(), onsetSec);
    const gate = Number.isFinite(offsetSec) ? Math.max(0.001, offsetSec - start) : 1;
    const attack = Math.max(0.0005, cfg.attack ?? 0);
    const release = Math.max(0.015, cfg.release ?? 0.05);
    const end = start + gate + release;

    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(0, start);
    amp.gain.linearRampToValueAtTime(vel, start + attack);
    amp.gain.setValueAtTime(vel, Math.max(start + attack, start + gate));
    amp.gain.linearRampToValueAtTime(0, end);
    amp.connect(track.input);

    const mono = buffer.numberOfChannels === 1;
    let next = start;
    let count = 0;
    const lay = () => {
      const horizon = Math.min(end, this.getTime() + 0.1);
      while (next < horizon) {
        const size = Math.min(4, Math.max(0.002, g.size));
        const density = Math.min(1000, Math.max(0.1, g.rate));
        const pos = Math.min(1, Math.max(0, posLive ? g.pos : from / Math.max(1e-9, fileSec)));
        const level = 1 / Math.sqrt(Math.max(1, size * density * 0.5));
        this._grain(buffer, amp, next, size, pos * fileSec, rate, g.pan, level * (mono ? Math.SQRT2 : 1), window, track);
        next += 1 / density;
        count += 1;
      }
      if (next >= end) { clearInterval(timer); setTimeout(() => { try { amp.disconnect(); } catch { /* gone */ } }, Math.max(0, (end - this.getTime()) * 1000) + 500); }
    };
    const timer = setInterval(lay, 25);
    timer?.unref?.(); // a node test's process need not wait on a cloud whose clock never moves
    lay();
    return { index: cfg.index ?? 0, grain: true, grainSize: g.size, grainRate: g.rate, durSec: gate, fileSec, amp: vel };
  }

  /** One grain: a piece of the file under the window, panned, onto the voice's envelope. */
  _grain(buffer, into, at, size, offsetSec, rate, pan, level, window, track) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    if (track.bendNode) { try { track.bendNode.connect(src.detune); } catch { /* no detune */ } }
    const shape = this.ctx.createGain();
    shape.gain.value = 0;
    try { shape.gain.setValueCurveAtTime(window.map((v) => v * level), at, size); } catch { shape.gain.value = level; }
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.min(1, Math.max(-1, pan));
    src.connect(shape).connect(panner).connect(into);
    // The read wraps within the file: a grain started near the end reads on from the start.
    const offset = ((offsetSec % buffer.duration) + buffer.duration) % buffer.duration;
    src.start(at, offset, size * rate + 0.01);
    src.stop(at + size + 0.005);
    src.onended = () => { try { src.disconnect(); shape.disconnect(); panner.disconnect(); } catch { /* gone */ } };
  }

  /** The window each grain is shaped by: a drawn one, or a Hann bell, as the desktop's default. */
  _grainWindow(shape) {
    const points = 64;
    if (shape && this.shapes?.parseShapePoints && this.shapes?.sampleShape) {
      try {
        const parsed = this.shapes.parseShapePoints(shape);
        if (parsed?.length) return Float32Array.from({ length: points }, (_, i) => Math.max(0, this.shapes.sampleShape(parsed, i / (points - 1))));
      } catch { /* not a shape; the bell */ }
    }
    return Float32Array.from({ length: points }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (points - 1)));
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
    for (const track of this.tracks.values()) this._routeOut(track);
    return want;
  }

  /**
   * Puts a track's output on the pair its `.o()` names, wrapped at the pairs there are - the
   * desktop's `(out - 1) mod pairs`. Pair one is a plain connection; any other goes through a
   * merger onto its two channels.
   */
  _routeOut(track) {
    const pairs = Math.max(1, Math.floor(this.outputChannels / 2));
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

  /** Tells a track's instrument where the bend is, at the time the bend is set for. */
  _bendInstrument(trackId, track, atTime) {
    const source = track.source;
    if (!source?.node?.port) return;
    const descriptor = track.slots.get(0)?.descriptor;
    if (descriptor?.build === 'wasm') {
      if (track.bendSemis) this._warnOnce(`bend:${descriptor.id}`, `[web-engine] "${descriptor.id}" is a ported module that takes its pitch per note, so .bend() does not move it here. The sample voices and the other instruments do bend.`);
      return;
    }
    try { source.node.port.postMessage({ kind: 'bend', semitones: track.bendSemis ?? 0, time: atTime }); } catch { /* gone */ }
  }

  /** Releases everything on a track without cutting what is already sounding. */
  hush(trackId, againSec = 0) {
    const source = this.tracks.get(trackId)?.source;
    if (source?.node?.port) {
      source.node.port.postMessage({ kind: 'allNotesOff', time: this.getTime() });
      if (againSec > 0) source.node.port.postMessage({ kind: 'allNotesOff', time: this.getTime() + againSec });
    }
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
    if (slot === -1) {
      if (!track.setChannel(name, value, atTime, now)) {
        this._warnOnce(`channel:${name}`, `[web-engine] the "${name}" channel control is not implemented in the browser build yet, so it does nothing here. Implemented: ${SUPPORTED_CHANNELS.join(', ')} and wet1..wet20.`);
      }
      if (name === 'bend') this._bendInstrument(trackId, track, atTime);
      if (name === 'out') this._routeOut(track);
      return;
    }
    // A parameter a modulator owns is not ours to set: the modulator is the whole value, and a
    // scalar written over it would fight with the connection until one of them stopped.
    if (this.modulators.get(trackId)?.has(keyOf(slot, name))) return;
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
   * The same breakpoint format `lfo()` takes, sampled with pattern-core's own sampler rather
   * than a second copy of it: a window drawn in the shape editor and a window played by the
   * synth have to be the same curve, and the only way to be sure of that is to have one piece
   * of code that says what the curve is. This runs on the main thread, so the worklet bundle
   * never sees it.
   *
   * Unlike a sample there is nothing to fetch, so the table is posted in the same turn and the
   * control is usable on the next block.
   */
  _loadShapeParam(trackId, slot, filled, param, data, atTime, glide) {
    const now = this.getTime();
    const track = this.tracks.get(trackId);
    filled.loaded ??= new Map();
    const held = filled.loaded.get(data);
    if (held !== undefined) {
      track.setParamValue(slot, param.id, held, atTime, now, glide);
      return;
    }
    const reader = this.shapeReader;
    if (!reader) {
      this._warnOnce('shape-reader', '[web-engine] this build cannot read drawn shapes, so a curve cannot be set here.');
      return;
    }
    if (!reader.looksLikeShapeData(data)) {
      this._warnOnce(`shape:${data}`, `[web-engine] ${JSON.stringify(data)} is not a drawn shape - write breakpoints like "0,0 0.1,1 1,0".`);
      return;
    }
    const points = reader.parseShapePoints(data);
    if (!points.length) {
      this._warnOnce(`shape:${data}`, `[web-engine] ${JSON.stringify(data)} has no points in it.`);
      return;
    }
    const table = new Float32Array(SHAPE_POINTS);
    for (let i = 0; i < SHAPE_POINTS; i++) table[i] = reader.sampleShape(points, i / (SHAPE_POINTS - 1));

    const optionIndex = this._spareOption(filled, param, data);
    if (optionIndex === null) return;
    track.setParamValue(slot, param.id, optionIndex, atTime, now, glide);
    // Kept here as well, for the picture the panel draws of the window.
    (filled.shapes ??= {})[optionIndex] = { name: data, points: [...table] };
    const built = filled.built;
    if (typeof built.loadShape === 'function') built.loadShape(param.id, optionIndex, table);
    else built.node?.port?.postMessage?.({ kind: 'shape', param: param.id, index: optionIndex, table }, [table.buffer]);
  }

  /**
   * The next free slot on an enum's option list, past the descriptor's own entries - and, when
   * they are all taken, the oldest one. Shared by the two things that fill them: a loaded file
   * and a drawn shape.
   */
  _spareOption(filled, param, name) {
    const first = param.options.length;
    const capacity = param.capacity;
    const extras = (filled.extras[param.id] ??= {});
    let optionIndex = -1;
    for (let i = first; i < capacity; i++) if (extras[i] === undefined) { optionIndex = i; break; }
    if (optionIndex < 0) {
      optionIndex = first + ((filled.loadedCount ?? 0) % Math.max(1, capacity - first));
      for (const [other, at] of filled.loaded) if (at === optionIndex) filled.loaded.delete(other);
    }
    filled.loadedCount = (filled.loadedCount ?? 0) + 1;
    filled.loaded.set(name, optionIndex);
    extras[optionIndex] = name;
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
    const track = this.tracks.get(trackId);
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
    const key = keyOf(slot, name);
    const held = this.modulators.get(trackId);
    if (!held) return;
    const existing = held.get(key);
    if (existing) {
      // An in-place update must not restart the shape or re-gate the envelope: the scheduler
      // re-sends a modulator whose range or rate is itself a signal, every tick.
      existing.update(ir);
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
    if (connection instanceof EnvConnection) this.envelopes.get(trackId)?.set(key, connection);
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
      const key = `cc|${(ir.device ?? '').toLowerCase()}|${ir.cc}`;
      if (!this.feeds.has(key)) this.feeds.set(key, new Set());
      this.feeds.get(key).add(conn);
      conn._feedKey = key;
      this.onMidiWanted?.();
      return conn;
    }, 'a midi control', 'setParamCC');
  }

  setParamOSC(trackId, slot, name, ir) {
    this._setModulator(trackId, slot, name, ir, (target) => {
      const conn = new FeedConnection(this.ctx, target, ir);
      const key = `osc|${ir.osc}|${ir.index ?? 0}`;
      if (!this.feeds.has(key)) this.feeds.set(key, new Set());
      this.feeds.get(key).add(conn);
      conn._feedKey = key;
      return conn;
    }, 'an osc message', 'setParamOSC');
  }

  _clearModulator(trackId, slot, name) {
    const key = keyOf(slot, name);
    const held = this.modulators.get(trackId);
    const conn = held?.get(key);
    if (!conn) return;
    conn.stop();
    held.delete(key);
    this.envelopes.get(trackId)?.delete(key);
    if (conn._feedKey) this.feeds.get(conn._feedKey)?.delete(conn);
  }

  clearParamLFO(trackId, slot, name) { this._clearModulator(trackId, slot, name); }
  clearParamEnv(trackId, slot, name) { this._clearModulator(trackId, slot, name); }
  clearParamCC(trackId, slot, name) { this._clearModulator(trackId, slot, name); }
  clearParamOSC(trackId, slot, name) { this._clearModulator(trackId, slot, name); }

  _clearAllModulators(trackId) {
    for (const [key, conn] of this.modulators.get(trackId) ?? []) {
      conn.stop();
      if (conn._feedKey) this.feeds.get(conn._feedKey)?.delete(conn);
      this.envelopes.get(trackId)?.delete(key);
    }
    this.modulators.get(trackId)?.clear();
  }

  /** Swaps a drawn LFO to another of its shapes, at the time asked, keeping its phase. */
  setParamShape(trackId, slot, name, index, atTime) {
    const conn = this.modulators.get(trackId)?.get(keyOf(slot, name));
    if (!(conn instanceof LfoConnection)) return;
    const shapes = conn.ir?.shapes;
    const points = Array.isArray(shapes) ? shapes[index] : null;
    if (points) conn.setShape({ shape: 'custom', points }, atTime);
  }

  /** Puts a free-running LFO back on the grid's phase, which the scheduler does periodically. */
  anchorParamLFO(trackId, slot, name, phase01, atTime) {
    const conn = this.modulators.get(trackId)?.get(keyOf(slot, name));
    if (conn instanceof LfoConnection) conn.anchor(phase01, atTime);
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

  // -- signal patched onto a parameter ------------------------------------------------------

  /**
   * Wires a track's or bus's output onto a parameter, at audio rate.
   *
   * This is what makes phase modulation possible at all: a value the scheduler polls every 30 ms
   * is a sweep, not a modulator. `gain` and `offset` are the `.mul()` and `.add()` that rode in
   * on the handle, and they become a gain node and a constant - there is nothing to sample, so
   * there is nothing to poll. The parameter is a 0..1 position like every other, so a bipolar
   * signal wants `.mul(0.5).add(0.5)` to cover it and a smaller gain to modulate around the
   * middle.
   */
  connectParam(trackId, slot, name, source, gain = 1, offset = 0) {
    const track = this.tracks.get(trackId);
    if (!track) return;
    const key = keyOf(slot, name);
    this.disconnectParam(trackId, slot, name);
    const target = this._targetParam(trackId, slot, name);
    if (!target) return;
    const from = this._sourceNode(source);
    if (!from) {
      this._warnOnce(`source:${source}`, `[web-engine] there is nothing called "${source}" to patch into "${name}".`);
      return;
    }
    const scale = this.ctx.createGain();
    scale.gain.value = gain;
    from.connect(scale);
    scale.connect(target);
    let bias = null;
    if (offset !== 0) {
      bias = this.ctx.createConstantSource();
      bias.offset.value = offset;
      bias.connect(target);
      bias.start();
    }
    // The parameter's own value would ADD to what arrives, so it is zeroed: a connection is the
    // whole value, exactly as a modulator is.
    try { target.value = 0; } catch { /* a param that refuses a direct set */ }
    track.paramConnections.set(key, { scale, bias, from, source, gain, offset });
  }

  disconnectParam(trackId, slot, name) {
    const track = this.tracks.get(trackId);
    const conn = track?.paramConnections.get(keyOf(slot, name));
    if (!conn) return;
    teardownParamConnection(conn);
    track.paramConnections.delete(keyOf(slot, name));
  }

  /**
   * What is patched onto this track's parameters right now, as `"slot:name" -> source|gain|offset`.
   *
   * The engine track outlives the Scheduler that wired it: a label removed and re-added, or a
   * re-evaluation, arrives with an empty record of what it sent and would leave a dropped route
   * playing for good. So a fresh Scheduler asks, and the answer is spelled as the same key it
   * diffs against - which is what lets a route that did not change survive a re-eval without
   * being cut and re-made.
   */
  paramRoutes(trackId) {
    const out = new Map();
    const track = this.tracks.get(trackId);
    for (const [key, conn] of track?.paramConnections ?? []) out.set(key, `${conn.source}|${conn.gain}|${conn.offset}`);
    return out;
  }

  // -- routing -----------------------------------------------------------------------------

  /** A bus is made the first time anything names it, and lives as long as the engine does. */
  _bus(name) {
    let bus = this.buses.get(name);
    if (!bus) {
      bus = this.ctx.createGain();
      this.buses.set(name, bus);
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
  _sourceNode(name) {
    const text = String(name ?? '');
    if (text.startsWith('bus:')) return this._bus(text.slice(4));
    if (text.startsWith('dev:')) return null;         // a hardware input; see setInputSource
    const explicit = text.startsWith('track:');
    const bare = explicit ? text.slice(6) : text;
    // The id the host gave that label, or the name itself - which is what a test that made its
    // tracks by hand passes, and what a host with no resolver leaves it as.
    const id = this.resolveTrack?.(bare) ?? bare;
    const track = this.tracks.get(id) ?? this.tracks.get(bare);
    if (track) return track.panner;
    return explicit ? null : this.buses.get(bare) ?? null;
  }

  setBusSends(trackId, sends) {
    const track = this.tracks.get(trackId);
    if (!track) return;
    // Nothing the scheduler sends from inside a timer may throw: an exception there stops the
    // music rather than dropping one call.
    const wanted = Array.isArray(sends) ? sends.filter((s) => s && s.name) : [];
    for (const [name, node] of track.sends) {
      if (!wanted.some((s) => s.name === name)) {
        try { node.disconnect(); } catch { /* already detached */ }
        track.sends.delete(name);
      }
    }
    const now = this.getTime();
    for (const send of wanted) {
      let node = track.sends.get(send.name);
      if (!node) {
        node = this.ctx.createGain();
        track.panner.connect(node);
        node.connect(this._bus(send.name));
        track.sends.set(send.name, node);
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
    const from = this._sourceNode(name);
    if (!from) {
      this._warnOnce(`head:${name}`, `[web-engine] there is nothing called "${name}" for this track to read.`);
      return;
    }
    this.clearInputSource(trackId);
    from.connect(track.input);
    track._headSource = from;
  }

  clearInputSource(trackId) {
    this.midiRoutes.remove(trackId, 0, this.getTime());
    this._dropHardware(`head|${trackId}`);
    const track = this.tracks.get(trackId);
    if (!track?._headSource) return;
    try { track._headSource.disconnect(track.input); } catch { /* already detached */ }
    track._headSource = null;
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
    const from = this._sourceNode(name);
    if (!from) {
      this._warnOnce(`source:${name}`, `[web-engine] there is nothing called "${name}" to feed into "${filled.descriptor.id}".`);
      return;
    }
    track.setSidechain(slot, from, name, gain);
  }

  clearAudioInject(trackId, slot) {
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
    // not setParam's: a modulator adds to the intrinsic value, which connectParam zeroed, so
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
    for (const key of track.paramConnections.keys()) record(key, 'an audio signal');
    return out;
  }

  /**
   * The device in one slot and everything a panel is drawn from. Null for an empty slot, which
   * is what a double-click on a name the buffer has since changed asks about.
   */
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
   * Plays one sample. The scheduler reads the returned object straight back for its log line, so
   * it is built synchronously - and a reason for NOT playing is a field on it rather than an
   * exception, because a missing sample should cost one quiet line and not the rest of the tick.
   */
  playSample(trackId, pack, cfg = {}, onsetSec, offsetSec) {
    const track = this.createTrack(trackId);
    // A named pack arrives as `sp:<id>` - the scheduler's spelling for a pack the language
    // defines, as against a folder or a recording - and the store keys packs by their bare id.
    const packId = typeof pack === 'string' && pack.startsWith('sp:') ? pack.slice(3) : pack;
    // Routed onward as an on/off pair, whether or not this sample has loaded yet: a kick keys a
    // ducker by being scheduled, not by being heard.
    if (this.midiRoutes.size && (cfg.vel ?? 1) > 0) this.midiRoutes.sampleEvent(trackId, cfg.vel ?? 1, onsetSec, offsetSec, cfg.note ?? null);
    // A recording, by name: sr("bass") arrives as rec:bass.
    const isRec = typeof packId === 'string' && packId.startsWith('rec:');
    const got = isRec
      ? this.samples?.named?.('rec', packId.slice(4)) ?? null
      : this.samples?.get?.(packId, cfg.index ?? 0) ?? null;
    // The store may hand back a bare AudioBuffer, or the buffer with the note it was recorded at.
    const buffer = got?.buffer ?? got;
    if (!buffer) return { skipped: 'source not ready' };
    const rootNote = Number.isFinite(got?.rootNote) ? got.rootNote : SAMPLER_ANCHOR;

    // The slice positions `.slice(n)` indexes: the hand-drawn set's marks for this file where it
    // has some, and the file's own transients otherwise - worked out on first ask, off the tick.
    const key = isRec ? `rec:${packId.slice(4)}.wav` : this.samples?.fileKey?.(packId, cfg.index ?? 0) ?? null;
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
      index: cfg.index ?? 0, begin: plan.begin, end: plan.end, loop: plan.loop, speed: plan.speed, stretch: plan.stretch,
      durSec: plan.durSec, cut: plan.cut, amp: plan.amp, fileSec: plan.fileSec,
      attack: plan.attack, decay: plan.decay, release: plan.release,
      loopWrap: plan.windowed ? 'window' : 'file', loopDir: plan.pingpong ? 'pingpong' : 'forward',
    };

    // .grain(): a cloud of grains read from the file, in place of the file played through.
    if (plan.grain) {
      const fileSec = buffer.duration;
      const from = backwards ? fileSec * (1 - plan.begin) : fileSec * plan.begin;
      return { ...info, ...this._playGrains(track, backwards ?? buffer, cfg, { rate: Math.abs(plan.speed), vel: plan.amp, onsetSec: plan.onsetSec, offsetSec, fileSec, from }) };
    }
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
    if (track.bendNode) { try { track.bendNode.connect(source.detune); } catch { /* no detune */ } }
    if (playFor != null) source.start(start, offset, playFor);
    else source.start(start, offset);
    source.stop(stopAt + 0.005);
    source.onended = () => {
      try { source.disconnect(); amp.disconnect(); } catch { /* already detached */ }
    };
  }

  /**
   * .stretch(): the desktop's warp voice - Warp1's 100 ms Hann grains, eight overlapping, placed
   * with a tenth of a window of random scatter, along a pointer that walks the window (or loops
   * it) at the event's own pace while each grain plays at the rate. So the pitch is the rate's
   * and the length is the stretch's, as on the desktop.
   */
  _playWarp(track, buffer, plan) {
    const fileSec = buffer.duration;
    const size = 0.1;
    const overlaps = 8;
    const density = overlaps / size;
    const start = Math.max(this.getTime(), plan.onsetSec);
    const gateEnd = plan.loop || plan.cut ? Math.max(start, plan.offsetSec) : start + plan.durSec;
    const amp = this.ctx.createGain();
    amp.connect(track.input);
    const end = this._envelope(amp, plan, start, gateEnd);
    const window = this._grainWindow(null);
    const rate = Math.abs(plan.speed);
    // Where the pointer is at a time, 0..1 of the file.
    const span = Math.max(1e-6, plan.end - plan.begin);
    const perSec = (span / Math.max(1e-6, plan.durSec)) * Math.sign(plan.speed);
    const pointer = (t) => {
      const walked = (t - start) * perSec;
      if (!plan.loop) return Math.min(1, Math.max(0, (plan.speed < 0 ? plan.end : plan.begin) + walked));
      const lo = plan.loopLo;
      const width = Math.max(1e-6, plan.loopHi - plan.loopLo);
      const from = plan.loopEntry - lo;
      if (plan.pingpong) {
        const ph = (((from + walked) % (2 * width)) + 2 * width) % (2 * width);
        return lo + (width - Math.abs(ph - width));
      }
      return lo + ((((from + walked) % width) + width) % width);
    };
    const mono = buffer.numberOfChannels === 1;
    let next = start;
    const lay = () => {
      const horizon = Math.min(end, this.getTime() + 0.1);
      while (next < horizon) {
        const scatter = (Math.random() - 0.5) * 0.1 * size;
        // Scatter is kept inside the file: a grain at the very start scattered earlier would
        // otherwise wrap round and read the file's end into the attack.
        const at = Math.min(Math.max(0, fileSec - size * rate), Math.max(0, pointer(next) * fileSec + scatter));
        this._grain(buffer, amp, next, size, at, rate, 0, (2 / overlaps) * (mono ? Math.SQRT2 : 1), window, track);
        next += 1 / density;
      }
      if (next >= end) clearInterval(timer);
    };
    const timer = setInterval(lay, 25);
    timer?.unref?.();
    lay();
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
