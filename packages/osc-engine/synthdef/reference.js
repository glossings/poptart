'use strict';

// Reference .scsyndef files from sclang itself, for synthdef-sclang.test.js: the def-building
// code is LIFTED OUT of sc/poptart.scd by pattern (not copied), run under sclang with no server,
// and every def's asBytes written to a file. Test-only.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ENGINE = path.join(__dirname, '..');
const SCD = path.join(ENGINE, 'sc', 'poptart.scd');
const PORT = 57531;

function lift(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${what} in sc/poptart.scd`);
  return m[0];
}

/** The pieces of poptart.scd that build defs, as sclang source. */
function liftedSource() {
  const src = fs.readFileSync(SCD, 'utf8');
  const fn = (name) => lift(src, new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'), name);
  const lines = src.split('\n');
  const from = lines.findIndex((l) => /^\s*\[\\sine, \\tri, \\saw/.test(l));
  const to = lines.findIndex((l, i) => i > from && l.includes('SynthDef(\\poptart_xokr'));
  if (from < 0 || to < 0) throw new Error('could not find the boot defs in sc/poptart.scd');
  const probe = lift(src, /SynthDef\(\\poptart_rbprobe, \{[\s\S]*?\n\s*\}\)/, 'poptart_rbprobe');
  const view = lift(src, /^viewTap\[\\buildDefs\] = \{[\s\S]*?^\};$/m, 'viewTap[\\buildDefs]');
  return {
    functions: [...['chanIn', 'djIsolator', 'buildHeadDef', 'buildFxDef', 'buildXoverDef', 'buildTrackDef', 'buildDjDef',
      'buildTapDef', 'buildBassMonoDef', 'buildMixDef', 'mixBank', 'exprSynthDef'].map(fn), view].join('\n'),
    boot: lines.slice(from, to + 1).join('\n'),
    probe,
  };
}

const sym = (s) => `'${s}'`;

/**
 * One sclang function body per config. A config: {key, numOutputBusChannels, cueOffset,
 * nativeDevices, spectrum, pitchShift, mixFreqs, exprs: [{name, tree, outKind, rates}]}.
 * Extensions a config leaves out are taken away by rewriting `\Class.asClass` to nil.
 */
function configBlock(cfg, lifted, outDir) {
  let text = `${lifted.functions}\n${lifted.boot}\nif (\\PoptartPitchShift.asClass.notNil) { defs.add(${lifted.probe}) };\n`;
  if (!cfg.nativeDevices) text = text.replaceAll('\\PoptartDevice.asClass', 'nil');
  if (!cfg.spectrum) text = text.replaceAll('\\PoptartSpectrum.asClass', 'nil');
  if (!cfg.pitchShift) text = text.replaceAll('\\PoptartPitchShift.asClass', 'nil');
  // every `}).add;` of the lifted source lands in `defs` instead of on a server
  text = text.replace(/\}\)\.add;/g, '}) !? { |d| defs.add(d) };');
  const exprs = (cfg.exprs ?? []).map((e) => `[${sym(e.name)}, ${JSON.stringify(JSON.stringify(e.tree))}, ${sym(e.outKind)}, ${e.rates ? `[${e.rates.map((r) => `\\${r}`).join(', ')}]` : 'nil'}]`);
  const dir = path.join(outDir, cfg.key);
  fs.mkdirSync(dir, { recursive: true });
  return `{
var server = (options: (numOutputBusChannels: ${cfg.numOutputBusChannels}));
var cueOffset = ${cfg.cueOffset ?? 'nil'};
var lfoDefName = { |shape, audio| ("poptart_lfo_" ++ shape ++ if (audio) { "_ar" } { "" }).asSymbol };
var trackDefName = { |key| ("poptart_track_" ++ key).asSymbol };
var bendPollHz = 100, grainMaxOverlap = 128, mixBandFreqs;
var chanIn, djIsolator, buildHeadDef, buildFxDef, buildXoverDef, buildTrackDef, buildDjDef, buildTapDef, buildBassMonoDef;
var buildMixDef, mixBank, exprSynthDef, viewTap = ();
var defs = List.new, dir = ${JSON.stringify(dir)};
${text}
[buildHeadDef.(), buildFxDef.(), buildXoverDef.(), buildTrackDef.(\\shared), buildDjDef.(), buildTapDef.(), buildBassMonoDef.()].do { |d| defs.add(d) };
viewTap[\\buildDefs].();
${cfg.mixFreqs ? `buildMixDef.([${cfg.mixFreqs.join(', ')}]);` : ''}
[${exprs.join(',\n')}].do { |e| defs.add(exprSynthDef.(e[0], e[1].parseJSON, e[2], e[3])) };
defs.do { |d|
    var md = d.metadata ? ();
    File.use(dir +/+ d.name ++ ".scsyndef", "wb", { |f| f.putAll(d.asBytes) });
    [\\vstplugins, \\poptartDevices].do { |k|
        md[k] !? { |p| p.keysValuesDo { |id, desc| if (id.isKindOf(Symbol)) { ("SLOT<${cfg.key}|" ++ d.name ++ "|" ++ k ++ "|" ++ id ++ "|" ++ desc.index ++ ">").postln } } };
    };
};
("CONFIG-DONE<${cfg.key}|" ++ defs.size ++ ">").postln;
}.value;
`;
}

function sclangConf(dir, extensionsDir) {
  const file = path.join(dir, 'sclang_conf.yaml');
  const include = [path.join(ENGINE, 'native', 'devices'), path.join(ENGINE, 'native', 'rubberband')];
  const exclude = [path.join(extensionsDir, 'poptart'), path.join(extensionsDir, 'PoptartDevice.sc'), path.join(extensionsDir, 'PoptartPitchShift.sc')];
  fs.writeFileSync(file, `includePaths:\n${include.map((p) => `  - ${p}\n`).join('')}excludePaths:\n${exclude.map((p) => `  - ${p}\n`).join('')}`);
  return file;
}

/**
 * Runs sclang once over every config. Returns {text, slots} where slots[key][name] =
 * {vstplugins: {id: index}, poptartDevices: {id: index}}; the files land in <outDir>/<key>/.
 */
function renderReferences({ sclang, outDir, configs, extensionsDir }) {
  const lifted = liftedSource();
  const script = `(
${configs.map((c) => `try {\n${configBlock(c, lifted, outDir)}} { |err| ("CONFIG-FAILED<${c.key}|" ++ err.errorString ++ ">").postln };`).join('\n')}
"ALL-DONE".postln;
0.exit;
)
`;
  const file = path.join(outDir, 'reference.scd');
  fs.writeFileSync(file, script);
  let text;
  try {
    text = execFileSync(sclang, ['-l', sclangConf(outDir, extensionsDir), '-u', String(PORT), file], {
      encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const slots = {};
  for (const m of text.matchAll(/^SLOT<([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|(\d+)>$/gm)) {
    const [, key, name, kind, id, index] = m;
    ((slots[key] ??= {})[name] ??= {})[kind] = { ...(slots[key][name][kind] ?? {}), [id]: Number(index) };
  }
  return { text, slots };
}

module.exports = { renderReferences, liftedSource };
