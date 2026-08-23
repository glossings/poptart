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
  }

  // Called on every eval, per track, with [instrument, ...fxChain]; also reload mapping files
  // so editing a mapping JSON mid-session takes effect on the next eval, livecoding-style.
  setChain(trackId, chain) {
    this.chains.set(trackId, chain);
    this.mappings = loadMappings();
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
    this.engine.setParam(trackId, slot, name, spec ? toNormalized(value, spec) : value, targetTime);
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

  // --- pass-throughs ---
  start(...a) { return this.engine.start(...a); }
  stop(...a) { return this.engine.stop(...a); }
  getTime(...a) { return this.engine.getTime(...a); }
  version(...a) { return this.engine.version(...a); }
  scanPlugins(...a) { return this.engine.scanPlugins(...a); }
  getKnownPlugins(...a) { return this.engine.getKnownPlugins(...a); }
  createTrack(...a) { return this.engine.createTrack(...a); }
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
  defineSamplePacks(...a) { return this.engine.defineSamplePacks(...a); }
  record(...a) { return this.engine.record(...a); }
  enableMidi(...a) { return this.engine.enableMidi(...a); }
  setMidiNotes(...a) { return this.engine.setMidiNotes(...a); }
  clearMidiNotes(...a) { return this.engine.clearMidiNotes(...a); }
  // Signal routing (midi()/audio() source builders and .midi()/.audio() injectors). Plain
  // pass-throughs - no parameter mapping involved, but the scheduler feature-detects each of
  // these (typeof engine.X === 'function'), so they must exist on the wrapper to be reached.
  setInputSource(...a) { return this.engine.setInputSource(...a); }
  clearInputSource(...a) { return this.engine.clearInputSource(...a); }
  setBusSends(...a) { return this.engine.setBusSends(...a); }
  clearBusSends(...a) { return this.engine.clearBusSends(...a); }
  injectAudio(...a) { return this.engine.injectAudio(...a); }
  clearAudioInject(...a) { return this.engine.clearAudioInject(...a); }
  injectMidi(...a) { return this.engine.injectMidi(...a); }
  clearMidiInject(...a) { return this.engine.clearMidiInject(...a); }
}

module.exports = { MappedEngine, loadMappings, toNormalized, toRealWorld };
