'use strict';

// Per-plugin real-world unit conversion (200..5000 Hz -> the normalized 0..1 values VST
// parameters actually take). Parameters are always addressed by their real VST names (the
// editor's autocomplete / params panel lists them) - no alias layer.
//
// Mapping files live in <repo>/mappings/*.json, one per plugin, matched by exact plugin name:
//
//   {
//     "plugin": "Serum 2",
//     "params": { "Filter 1 Freq": { "min": 8, "max": 22050, "curve": "log" } }
//   }
//
// Rule, applied per track slot (the plugin loaded there decides which file applies): if a
// parameter has a `params` entry, values for it are interpreted in that entry's real-world
// units and converted to normalized 0..1 (clipped). No entry = values are already normalized
// 0..1.
//
// MappedEngine wraps any engine implementing pattern-core's engine interface and applies that
// rule to setParam/setParamLFO. It also resolves plugin-state chips to files (see setPluginState
// and states.js), because that translation is the same kind of job: turning what the code says
// into what the engine takes. Everything else passes straight through.

const fs = require('node:fs');
const path = require('node:path');


const MAPPINGS_DIR = path.join(__dirname, '..', '..', 'mappings');

function loadMappings() {
  const byPlugin = new Map();
  if (!fs.existsSync(MAPPINGS_DIR)) return byPlugin;
  for (const file of fs.readdirSync(MAPPINGS_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(MAPPINGS_DIR, file), 'utf8'));
      if (m.plugin) byPlugin.set(m.plugin, m);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[poptart] ignoring bad mapping file ${file}: ${e.message}`);
    }
  }
  return byPlugin;
}

function toNormalized(value, spec) {
  const { min, max, curve = 'lin' } = spec;
  const norm = curve === 'log'
    ? Math.log(value / min) / Math.log(max / min)
    : (value - min) / (max - min);
  return Math.min(1, Math.max(0, norm));
}

// Inverse of toNormalized: a normalized 0..1 value back to the mapping's real-world units. Used
// by the "conf" capture (server.js): the plugin reports a touched parameter as normalized, but a
// mapped param's .param() call is authored in real units, so we convert before writing it back.
function toRealWorld(norm, spec) {
  const { min, max, curve = 'lin' } = spec;
  return curve === 'log' ? min * Math.exp(norm * Math.log(max / min)) : min + norm * (max - min);
}

class MappedEngine {
  constructor(engine) {
    this.engine = engine;
    this.mappings = loadMappings();
    this.chains = new Map(); // trackId -> [instrument, ...fx plugin names], set on every eval
    this.resolveTrack = null; // label -> engine track id, installed by the server (setTrackResolver)
    // Where a userland mistake this layer notices is reported: the editor console, installed by
    // the server. Unset (tests, scripts) means say nothing.
    this.warn = null;
    this._warnedWords = new Set(); // "track|slot|name" already reported, cleared on every eval

    // A capability the wrapped engine does not have must not LOOK like one it has.
    //
    // The forwarding rule in this class is "forward everything the scheduler calls", because a
    // method missing here silently does nothing (see the note at the top of param-mapping.test.js).
    // For the handful of calls the scheduler feature-detects with
    // `typeof this.engine.X === 'function'`, forwarding unconditionally is the opposite mistake:
    // the wrapper answers yes on the engine's behalf, the scheduler wires the route, and the
    // forward lands on undefined. That turns "warn once and keep playing" into a TypeError that
    // takes the whole evaluation down. `.param(name, audio("mod"))` on the desktop did exactly
    // that - OscEngine has no connectParam, and it is the only feature-detected call it lacks.
    //
    // So an optional capability is hidden here when the engine underneath cannot do it, which
    // puts the scheduler back on its own refusal path.
    for (const name of MappedEngine.OPTIONAL) {
      if (typeof engine?.[name] !== 'function') this[name] = undefined;
    }
  }

  // Track references INSIDE arguments: audio("kick") / .audio("kick") / .midi("kick") name
  // another track by its label, but the engine knows tracks only by their opaque ids (see
  // server.js's track registry). The server installs the resolver; without one, names pass
  // through untouched (mocks, tests). The rule is syntactic, mirroring osc-engine's own
  // routing-name grammar: "dev:"/"bus:" sources aren't tracks, "track:label" is an explicit
  // track reference, and a bare name is a track (track-first resolution).
  setTrackResolver(fn) {
    this.resolveTrack = fn;
  }

  _trackRef(name, from) {
    if (!this.resolveTrack || name == null) return name;
    const str = String(name);
    if (str.startsWith('dev:') || str.startsWith('bus:')) return name;
    if (str.startsWith('track:')) return `track:${this.resolveTrack(str.slice(6), from)}`;
    // `from` is the referencing track's engine id: the resolver scopes the lookup to that
    // track's deck first, so deck b's audio("kick") means deck b's kick.
    return this.resolveTrack(str, from);
  }

  // Called on every eval, per track, with [instrument, ...fxChain]; also reload mapping files
  // so editing a mapping JSON mid-session takes effect on the next eval, livecoding-style.
  setChain(trackId, chain) {
    this.chains.set(trackId, chain);
    this.mappings = loadMappings();
    // Said once per evaluation rather than once per session: a word fixed and then written
    // again is a new mistake, and the scheduler sends a held value on every step.
    for (const key of this._warnedWords) if (key.startsWith(`${trackId}|`)) this._warnedWords.delete(key);
  }

  removeChain(trackId) {
    this.chains.delete(trackId);
  }

  _spec(trackId, slot, name) {
    const params = this.mappings.get(this.chains.get(trackId)?.[slot])?.params;
    if (!params) return undefined;
    // Accept a "Name#index" disambiguator (see the resolver in poptart.scd): a mapping may key
    // the exact "Name#index" if two same-named params need different units, otherwise the units
    // for the base "Name" apply to whichever one is addressed.
    if (params[name]) return params[name];
    const base = name.replace(/#\d+$/, '');
    return base !== name ? params[base] : undefined;
  }

  // Public view of _spec, for the conf-capture path (server.js) which needs to know whether a
  // touched parameter has real-world units to convert a normalized value back into.
  specFor(trackId, slot, name) {
    return this._spec(trackId, slot, name);
  }

  setParam(trackId, slot, name, value, targetTime) {
    const spec = this._spec(trackId, slot, name);
    // Only a NUMBER is converted. The scheduler passes strings through now (an enum label, which
    // the browser build's devices take), and a word run through toNormalized comes back NaN -
    // which is a number, so it would sail past the engine's own type guard and be sent to sclang.
    // A plugin parameter is a number, so a word can only be a mistake here - the engine drops
    // it, and this says so on the console instead of the track quietly ignoring the line.
    if (typeof value === 'string') {
      const key = `${trackId}|${slot}|${name}`;
      if (!this._warnedWords.has(key)) {
        this._warnedWords.add(key);
        const plugin = this.chains.get(trackId)?.[slot];
        this.warn?.(
          `[param] ${trackId}: "${name}"${plugin ? ` on ${plugin}` : ''} was given the word ${JSON.stringify(value)}. `
          + 'A plugin parameter takes a number - a 0 to 1 position, or real units where a mapping file gives them - so it is left where it was.',
        );
      }
    }
    const mapped = spec && typeof value === 'number' ? toNormalized(value, spec) : value;
    this.engine.setParam(trackId, slot, name, mapped, targetTime);
  }

  setParamLFO(trackId, slot, name, ir) {
    const spec = this._spec(trackId, slot, name);
    const mapped = spec
      ? { ...ir, min: toNormalized(ir.min, spec), max: toNormalized(ir.max, spec) }
      : ir;
    this.engine.setParamLFO(trackId, slot, name, mapped);
  }

  clearParamLFO(trackId, slot, name) {
    this.engine.clearParamLFO(trackId, slot, name);
  }

  // Which shape a patterned lfo("<a b>") is on. An index, not a value, so there is nothing to
  // convert - but like anchorParamLFO it has to be a real method here: the Scheduler
  // feature-detects it on whatever engine it is given, and this wrapper is what it is given.
  setParamShape(trackId, slot, name, index, targetTime) {
    this.engine.setParamShape(trackId, slot, name, index, targetTime);
  }

  // Phase-only, no unit conversion - but it must be a real method (not a missing one): the
  // Scheduler feature-detects anchorParamLFO on whatever engine it's given, and this wrapper
  // is what it's given in production.
  anchorParamLFO(trackId, slot, name, phase01, targetTime) {
    this.engine.anchorParamLFO(trackId, slot, name, phase01, targetTime);
  }

  setParamEnv(trackId, slot, name, ir) {
    const spec = this._spec(trackId, slot, name);
    const mapped = spec
      ? { ...ir, min: toNormalized(ir.min, spec), max: toNormalized(ir.max, spec) }
      : ir;
    this.engine.setParamEnv(trackId, slot, name, mapped);
  }

  clearParamEnv(trackId, slot, name) {
    this.engine.clearParamEnv(trackId, slot, name);
  }

  setParamCC(trackId, slot, name, ir) {
    const spec = this._spec(trackId, slot, name);
    const mapped = spec
      ? { ...ir, min: toNormalized(ir.min, spec), max: toNormalized(ir.max, spec) }
      : ir;
    this.engine.setParamCC(trackId, slot, name, mapped);
  }

  clearParamCC(trackId, slot, name) {
    this.engine.clearParamCC(trackId, slot, name);
  }

  setParamOSC(trackId, slot, name, ir) {
    const spec = this._spec(trackId, slot, name);
    const mapped = spec
      ? { ...ir, min: toNormalized(ir.min, spec), max: toNormalized(ir.max, spec) }
      : ir;
    this.engine.setParamOSC(trackId, slot, name, mapped);
  }

  clearParamOSC(trackId, slot, name) {
    this.engine.clearParamOSC(trackId, slot, name);
  }

  // --- pass-throughs ---
  start(...a) { return this.engine.start(...a); }
  stop(...a) { return this.engine.stop(...a); }
  getTime(...a) { return this.engine.getTime(...a); }
  version(...a) { return this.engine.version(...a); }
  scanPlugins(...a) { return this.engine.scanPlugins(...a); }
  getKnownPlugins(...a) { return this.engine.getKnownPlugins(...a); }
  createTrack(...a) { return this.engine.createTrack(...a); }
  destroyTrack(...a) { return this.engine.destroyTrack(...a); }
  loadInstrument(...a) { return this.engine.loadInstrument(...a); }
  loadEffect(...a) { return this.engine.loadEffect(...a); }
  unloadEffect(...a) { return this.engine.unloadEffect(...a); }
  getParams(...a) { return this.engine.getParams(...a); }
  getPluginState(...a) { return this.engine.getPluginState(...a); }
  setPluginStateFile(...a) { return this.engine.setPluginStateFile(...a); }

  setPluginState(...a) { return this.engine.setPluginState(...a); }
  showPluginEditor(...a) { return this.engine.showPluginEditor(...a); }
  cancelPluginState(...a) { return this.engine.cancelPluginState(...a); }
  setTempo(...a) { return this.engine.setTempo(...a); }
  noteOn(...a) { return this.engine.noteOn(...a); }
  noteOff(...a) { return this.engine.noteOff(...a); }
  playSample(...a) { return this.engine.playSample(...a); }
  songLoad(...a) { return this.engine.songLoad(...a); }
  songStart(...a) { return this.engine.songStart(...a); }
  songSet(...a) { return this.engine.songSet(...a); }
  songSeek(...a) { return this.engine.songSeek(...a); }
  songStop(...a) { return this.engine.songStop(...a); }
  songFree(...a) { return this.engine.songFree(...a); }
  defineSamplePacks(...a) { return this.engine.defineSamplePacks(...a); }
  record(...a) { return this.engine.record(...a); }
  enableMidi(...a) { return this.engine.enableMidi(...a); }
  enableOsc(...a) { return this.engine.enableOsc(...a); }
  setMidiNotes(...a) { return this.engine.setMidiNotes(...a); }
  clearMidiNotes(...a) { return this.engine.clearMidiNotes(...a); }
  hush(...a) { return this.engine.hush(...a); }
  // Signal routing (midi()/audio() source builders and .midi()/.audio() injectors). No
  // parameter mapping involved, but the scheduler feature-detects each of these (typeof
  // engine.X === 'function'), so they must exist on the wrapper to be reached - and the ones
  // that carry a routing name translate track references on the way down (see _trackRef).
  setInputSource(trackId, io, name, ...a) { return this.engine.setInputSource(trackId, io, this._trackRef(name, trackId), ...a); }
  clearInputSource(...a) { return this.engine.clearInputSource(...a); }
  setBusSends(...a) { return this.engine.setBusSends(...a); }
  clearBusSends(...a) { return this.engine.clearBusSends(...a); }
  setBusSendAmount(...a) { return this.engine.setBusSendAmount(...a); }
  injectAudio(trackId, slot, name, ...a) { return this.engine.injectAudio(trackId, slot, this._trackRef(name, trackId), ...a); }
  clearAudioInject(...a) { return this.engine.clearAudioInject(...a); }
  injectMidi(trackId, slot, name, ...a) { return this.engine.injectMidi(trackId, slot, this._trackRef(name, trackId), ...a); }
  clearMidiInject(...a) { return this.engine.clearMidiInject(...a); }
  // Audio patched onto a parameter (.param("Osc 1 Phase", audio("mod"))). The SOURCE is a
  // routing name and is translated like the injectors above; the gain and offset ride on the
  // connection and are already in whatever units the parameter takes, so no mapping applies to
  // them - a connection is wired once and then runs in the audio graph, where there is nothing
  // left to convert per value.
  connectParam(trackId, slot, name, source, ...a) {
    return this.engine.connectParam(trackId, slot, name, this._trackRef(source, trackId), ...a);
  }
  disconnectParam(...a) { return this.engine.disconnectParam(...a); }
  // What the engine already has patched onto this track's parameters, which a fresh Scheduler
  // reads so that a route the new pattern dropped is torn down. Nothing to map: the keys and the
  // route spelling are the scheduler's own, and they come straight back.
  paramRoutes(...a) { return this.engine.paramRoutes(...a); }
}

/**
 * The engine methods the scheduler asks about before it calls them, rather than simply calling.
 *
 * Only these may be hidden by the constructor, and only when the engine underneath lacks them:
 * everything else the scheduler calls outright, so hiding one would be the silent no-op this
 * whole file exists to prevent. Kept in step with the `typeof this.engine.X === 'function'`
 * checks in scheduler.mjs by a test, not by memory.
 */
MappedEngine.OPTIONAL = Object.freeze(['connectParam', 'disconnectParam', 'paramRoutes']);

module.exports = { MappedEngine, loadMappings, toNormalized, toRealWorld };
