'use strict';

// poptart's SynthDefs, built in Node (no sclang). See ARCHITECTURE.md, "SynthDefs without sclang".
//
//   defsFor(options)              every fixed def: [{name, bytes, meta, def}]
//   mixDefsFor(freqs, options)    the mixer's analysis + meter defs for these band centers
//   exprDef(tree, {outKind, rates}) a param-expression def: {name, bytes, meta, consts, inputs, ...}
//   loadMessages(defs, {dir})     /d_recv and /d_load messages that put `def`s on a server
//   writeDefsDir(dir, defs)       .scsyndef files + defs.json (each def's meta)
//   writeConfigDir(config)        the same for one engine configuration
//
// options: {numOutputBusChannels, cueOffset, nativeDevices, spectrum, pitchShift} - see
// defs.js resolveOptions for the defaults.

const D = require('./defs.js');
const E = require('./expr.js');
const L = require('./load.js');

const entry = (def) => ({ name: def.name, bytes: def.asBytes(), meta: L.defMeta(def), def });

function defsFor(options = {}) {
  return D.fixedDefs(options).map(entry);
}

function mixDefsFor(freqs, options = {}) {
  return D.mixDefs(freqs, options).map(entry);
}

/**
 * The defs for one configuration, written out: <outDir>/<name>.scsyndef per def and
 * <outDir>/defs.json. config: {outDir, numOutputBusChannels, cueOffset, mixFreqs, only} as
 * the engine has it, plus {nativeDevices, spectrum, pitchShift} for the extensions sclang
 * would have found installed. Returns the defs.json object.
 */
function writeConfigDir(config) {
  const defs = [...D.fixedDefs(config), ...(config.mixFreqs && config.mixFreqs.length ? D.mixDefs(config.mixFreqs, config) : [])];
  const only = config.only ? new Set(config.only.map(String)) : null;
  return L.writeDefsDir(config.outDir, only ? defs.filter((d) => only.has(d.name)) : defs);
}

function exprDef(tree, opts = {}) {
  const made = E.exprDef(tree, opts);
  return { ...made, meta: L.defMeta(made.def) };
}

module.exports = {
  defsFor, mixDefsFor, exprDef, writeConfigDir,
  exprRates: E.exprRates, exprShape: E.exprShape, exprConsts: E.exprConsts, exprInputs: E.exprInputs,
  loadMessages: L.loadMessages, writeDefsDir: L.writeDefsDir, defMeta: L.defMeta,
  resolveOptions: D.resolveOptions, MAX_DATAGRAM: L.MAX_DATAGRAM,
};
