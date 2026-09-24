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

    this.tracks = new Map();        // trackId -> Track
    this.buses = new Map();         // bus name -> GainNode
    this.modulators = new Map();    // trackId -> Map("slot:name" -> connection)
    this.envelopes = new Map();     // trackId -> Map("slot:name" -> EnvConnection), gated per note
    this.feeds = new Map();         // "device|cc" or "osc:address" -> Set(FeedConnection)
    this.warned = new Set();
    this.workletsReady = false;
    // Label to track id. A pattern names another track the way somebody wrote it - audio("kick")
    // - and this engine keys its tracks by the id the host made for that label, so without
    // something in between every cross-track route finds nothing and warns about a name that is
    // plainly right there in the buffer. The desktop puts this in the wrapper around its engine;
    // here the host installs it directly. See setTrackResolver.
    this.resolveTrack = null;
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
    const track = this.tracks.get(trackId);
    const source = track?.source;
    if (!source?.node?.port) return;
    source.node.port.postMessage({ kind: 'noteOn', note, velocity, time: atTime });
    for (const env of this.envelopes.get(trackId)?.values() ?? []) env.gateOn(atTime);
  }

  noteOff(trackId, note, atTime) {
    const track = this.tracks.get(trackId);
    const source = track?.source;
    if (source?.node?.port) source.node.port.postMessage({ kind: 'noteOff', note, time: atTime });
    for (const env of this.envelopes.get(trackId)?.values() ?? []) env.gateOff(atTime);
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
      this._warnOnce('midi-in', '[web-engine] MIDI input is not wired up in the browser build yet, so midi() and midikeys() sources are silent here.');
      return;
    }
    const from = this._sourceNode(name);
    if (!from) {
      if (String(name).startsWith('dev:')) {
        this._warnOnce('audio-in', '[web-engine] hardware audio input is not wired up in the browser build yet, so input() is silent here.');
      } else {
        this._warnOnce(`head:${name}`, `[web-engine] there is nothing called "${name}" for this track to read.`);
      }
      return;
    }
    this.clearInputSource(trackId);
    from.connect(track.input);
    track._headSource = from;
  }

  clearInputSource(trackId) {
    const track = this.tracks.get(trackId);
    if (!track?._headSource) return;
    try { track._headSource.disconnect(track.input); } catch { /* already detached */ }
    track._headSource = null;
  }

  setMidiNotes() {
    this._warnOnce('midi-in', '[web-engine] MIDI input is not wired up in the browser build yet, so midikeys() plays nothing here.');
  }

  clearMidiNotes() { /* nothing was ever wired */ }

  /**
   * Feeds another track or bus into an effect's second input - the carrier of a cross-modulator,
   * the key of a ducker, the modulator of a vocoder. Only a device that declares a sidechain has
   * one; on any other the call warns by name and the effect plays as written.
   */
  injectAudio(trackId, slot, name, gain = 1) {
    const track = this.tracks.get(trackId);
    const filled = track?.slots.get(slot);
    if (!track || !filled) return;
    if (!filled.descriptor.sidechain) {
      this._warnOnce(`inject:${filled.descriptor.id}`, `[web-engine] "${filled.descriptor.id}" has no sidechain input, so .audio() into it does nothing.`);
      return;
    }
    if (String(name).startsWith('dev:')) {
      this._warnOnce('audio-in', '[web-engine] hardware audio input is not wired up in the browser build yet, so input() is silent here.');
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
    this.tracks.get(trackId)?.clearSidechain(slot);
  }

  injectMidi() {
    this._warnOnce('inject-midi', '[web-engine] no browser device takes MIDI in yet, so .midi() into a plugin does nothing here.');
  }

  clearMidiInject() { /* nothing was ever wired */ }

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
    return { ...(report ?? {}), spectrum: MIX_BAND_FREQS.map((hz, i) => ({ hz, db: db[i] })) };
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
    // The store may hand back a bare AudioBuffer, or the buffer together with the note it was
    // recorded at. Both spellings are accepted because the rendered packs have no pitch worth
    // naming and the sourced ones do, and requiring the wrapper everywhere would mean inventing
    // a root note for a kick drum.
    // A named pack arrives as `sp:<id>` - the scheduler's spelling for a pack the language
    // defines, as against a folder or a recording - and the store keys packs by their bare id.
    const packId = typeof pack === 'string' && pack.startsWith('sp:') ? pack.slice(3) : pack;
    const got = this.samples?.get?.(packId, cfg.index ?? 0) ?? null;
    const buffer = got?.buffer ?? got;
    if (!buffer) return { skipped: 'source not ready' };
    const rootNote = Number.isFinite(got?.rootNote) ? got.rootNote : SAMPLER_ANCHOR;
    const vel = cfg.vel ?? 1;
    if (vel <= 0) return { skipped: 'silent' };
    const speed = cfg.speed ?? 1;
    if (speed === 0) return { skipped: 'speed 0' };

    const fileSec = buffer.duration;
    const begin = Math.max(0, Math.min(1, cfg.begin ?? 0)) * fileSec;
    const end = Math.max(0, Math.min(1, cfg.end ?? 1)) * fileSec;
    if (end <= begin) return { skipped: 'empty window' };

    // A note repitches around the anchor: with no root note recorded, c3 is the sample as it
    // was recorded, which is the same anchor the desktop sampler uses. A pack that knows what
    // pitch its files are at says so, and then the anchor is that pitch instead - which is what
    // lets a multisampled instrument and a synthesized one-shot both answer to the same note.
    const rate = Math.abs(speed) * (cfg.note != null ? Math.pow(2, (cfg.note - rootNote) / 12) : 1);

    // A negative speed is the sample backwards. The rate is its magnitude either way; the
    // direction is carried by reading a reversed copy, and the window is mirrored into it so
    // that begin and end still name the same piece of sound, entered from the far end.
    // A store that hands back something other than a real buffer cannot be reversed; that plays
    // forwards and says so, because this call answers with a line rather than an exception and a
    // note that does not sound at all is the worse of the two failures.
    const backwards = speed < 0 ? reversedBuffer(this.ctx, buffer) : null;
    if (speed < 0 && !backwards) {
      this._warnOnce(`reverse:${packId}`, `[web-engine] "${packId}" cannot be played backwards here, so a negative speed plays it forwards.`);
    }
    const reverse = backwards !== null;
    const from = reverse ? fileSec - end : begin;
    const to = reverse ? fileSec - begin : end;

    const source = this.ctx.createBufferSource();
    source.buffer = backwards ?? buffer;
    source.playbackRate.value = rate;
    if (cfg.loop) {
      source.loop = true;
      source.loopStart = from;
      source.loopEnd = to;
    }

    const amp = this.ctx.createGain();
    const attack = Math.max(0, cfg.attack ?? 0);
    const release = Math.max(0.001, cfg.release ?? 0.05);
    const start = Math.max(this.getTime(), onsetSec);
    amp.gain.setValueAtTime(attack > 0 ? 0 : vel, start);
    if (attack > 0) amp.gain.linearRampToValueAtTime(vel, start + attack);

    source.connect(amp);
    amp.connect(track.input);

    const windowSec = (to - from) / rate;
    const gateSec = Number.isFinite(offsetSec) ? Math.max(0, offsetSec - start) : windowSec;
    const soundFor = cfg.loop ? gateSec : Math.min(windowSec, gateSec);
    // The gate holds the level until it ends, and the release runs from there - the same
    // envelope the desktop sampler gates. Starting the fade early would cut a sample short by
    // its release and fade it over twice the time asked for.
    const stopAt = start + soundFor;
    amp.gain.setValueAtTime(vel, Math.max(start, stopAt));
    amp.gain.linearRampToValueAtTime(0, stopAt + release);
    source.start(start, from, cfg.loop ? undefined : (to - from));
    source.stop(stopAt + release + 0.005);
    source.onended = () => {
      try { source.disconnect(); amp.disconnect(); } catch { /* already detached */ }
    };

    return {
      index: cfg.index ?? 0,
      begin: cfg.begin ?? 0,
      end: cfg.end ?? 1,
      loop: cfg.loop ?? 0,
      speed,
      durSec: soundFor,
      fileSec,
      amp: vel,
      cut: soundFor < windowSec,
      attack,
      release,
    };
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
