'use strict';

// Param expressions, the bookkeeping half: installExpr / clearExpr / exprRun and the paramTarget
// every handler maps a control through (sc/poptart.scd, lifted as one block, so the source under
// test is the shipped one). What has to hold:
//
//   - an expression on a device's control is mapped onto it as an audio bus; on a plugin
//     parameter as a control bus, with the parameter's value read first so a clear puts it back;
//   - its source inputs are wired as audio routes on the leaf names "~i~name";
//   - a tree that differs only in its constants keeps the same synth and the same SynthDef;
//     a different shape builds one more def and retires the old synth;
//   - a leaf call (an LFO, a ramp) aimed at "~i~name" feeds that input, even before the
//     expression exists, and the expression picks it up when it is built;
//   - a clear unmaps, restores, unwires the sources and forgets the inputs;
//   - installs and clears for one control run in order, and a failing one does not stall the rest.
//
// The server is never booted: synths and buses are made against an address nobody answers, so
// nothing is sent anywhere that matters. Skipped, not failed, where sclang cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { userExtensionsDir } = require('./extensions.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

function lift() {
  const src = fs.readFileSync(SCD, 'utf8');
  const from = src.indexOf('// --- what a param call is aimed at');
  const to = src.indexOf('// How deep each track sits (key -> depth)');
  assert.ok(from > 0 && to > from, 'the param expression section is not where this test expects it in poptart.scd');
  // No server answers here, so there is nothing to sync with.
  return src.slice(from, to).replace(/server\.sync;/g, '');
}

const MOCK_CLASS = `
PETestCtl {
    var <>log, <>info, <>native;
    *new { |native = true| ^super.new.init(native) }
    init { |n| native = n; log = List.new; info = (level: 4, cutoff: 3) }
    respondsTo { |sel| ^if ((sel == \\mapAudio) or: { sel == \\unmapAudio }) { native } { super.respondsTo(sel) } }
    map { |index, bus| log.add([\\map, index, bus.isKindOf(Bus).if({ bus.index }, { bus })]) }
    unmap { |index| log.add([\\unmap, index]) }
    mapAudio { |index, bus, gain, offset| log.add([\\mapAudio, index, bus.isKindOf(Bus).if({ bus.index }, { bus }), gain, offset]) }
    unmapAudio { |index| log.add([\\unmapAudio, index]) }
    get { |index, action| log.add([\\get, index]); action.value(0.25) }
    set { |index, value| log.add([\\set, index, value]) }
}
`;

const TREE = JSON.stringify({ k: 'op', op: 'add', a: [
  { k: 'op', op: 'mul', a: [{ k: 'in', i: 0, rate: 'ar', source: 'src' }, { k: 'const', v: 0.5 }] },
  { k: 'op', op: 'mul', a: [{ k: 'in', i: 1, rate: 'kr' }, { k: 'const', v: 0.25 }] },
] });
const TREE_NUMBERS = TREE.replace('0.5', '0.8');
const TREE_SHAPE = JSON.stringify({ k: 'op', op: 'mul', a: [{ k: 'in', i: 1, rate: 'kr' }, { k: 'const', v: 2 }] });

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-pexpr-'));
  fs.writeFileSync(path.join(dir, 'PETestCtl.sc'), MOCK_CLASS);
  const conf = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(conf, `includePaths:\n  - ${dir}\nexcludePaths:\n  - ${path.join(userExtensionsDir(), 'PoptartDevice.sc')}\n`);
  const q = (s) => JSON.stringify(s);
  const script = `(
var exprLeaf, busIndexOf, paramTarget, reassertAudioDrivers, awaitTarget;
var exprDefs, exprKey, exprsOf, exprFeedsOf, exprFeed, exprFeedArgs, exprShape, exprConsts, exprInputs;
var exprSynthDef, installExpr, clearExpr, exprQueue, reassertExprs, exprRun;
var server, tracks, awaitLoaded, resolveParamIndex, channelDefault, nodeOwns;
var wireParamRoute, unwireParamRoute, dropRamp, freeModulatorLater;
var wired = List.new, unwired = List.new, freed = List.new, native, plugin, t1, t2, say, e, first, order;
server = Server(\\poptartPETest, NetAddr("127.0.0.1", 57998));
exprDefs = Dictionary.new;
exprQueue = IdentityDictionary.new;
native = PETestCtl(true);
plugin = PETestCtl(false);
t1 = (synth: Synth.basicNew(\\x, server, 1000), group: Group.basicNew(server, 100),
    controllers: [native], loaded: ["Noise"], envs: IdentityDictionary.new);
t2 = (synth: Synth.basicNew(\\x, server, 1001), group: Group.basicNew(server, 101),
    controllers: [plugin], loaded: ["Serum 2"], envs: IdentityDictionary.new);
tracks = IdentityDictionary.new;
tracks[\\t1] = t1; tracks[\\t2] = t2;
awaitLoaded = { |track, slot| true };
resolveParamIndex = { |info, name| info[name.asSymbol] };
channelDefault = { |name| 0 };
nodeOwns = { |id, what| };
wireParamRoute = { |key, slot, name, src, gain, offset| wired.add([key, slot, name, src]) };
unwireParamRoute = { |key, slot, name| unwired.add([key, slot, name]) };
dropRamp = { |key, track, rampKey| };
freeModulatorLater = { |key, group, synth, bus| freed.add(synth) };
say = { |tag, value| (tag ++ "<" ++ value.asCompileString ++ ">").postln };
${lift()}
Routine {
    // 1. A leaf call before the expression exists is held for it.
    paramTarget.(t1, 0, "~1~level")[\\map].(77);
    say.("HELD", exprFeedArgs.(t1, 0, "level", [(i: 1)]));
    // 2. Installed on a device's control: mapped as an audio bus, its source wired on the leaf.
    installExpr.(\\t1, t1, 0, "level", ${q(TREE)});
    e = exprsOf.(t1)[\\slot0_level];
    first = e[\\synth];
    say.("DEVICE", [e[\\outKind], native.log.collect { |l| l[0] }.asArray, native.log.last[1], native.log.last[2] == e[\\out].index]);
    say.("WIRED", wired.asArray);
    say.("DEFS", exprDefs.size);
    // 3. Only the numbers changed: same synth, same def, nothing re-wired.
    wired.clear;
    installExpr.(\\t1, t1, 0, "level", ${q(TREE_NUMBERS)});
    say.("NUMBERS", [exprsOf.(t1)[\\slot0_level][\\synth] === first, exprDefs.size, wired.size, freed.size]);
    // 4. Another shape: a new def, a new synth, the old one retired, the source unwired.
    installExpr.(\\t1, t1, 0, "level", ${q(TREE_SHAPE)});
    say.("SHAPE", [exprsOf.(t1)[\\slot0_level][\\synth] === first, exprDefs.size, freed.includes(first), unwired.asArray]);
    // 5. A leaf call now reaches the running expression's input record.
    paramTarget.(t1, 0, "~1~level")[\\mapAudio].(88);
    say.("FEED", exprFeedArgs.(t1, 0, "level", [(i: 1)]));
    // 6. Cleared: off the control, back on the value last set, the inputs forgotten.
    native.log.clear; unwired.clear;
    clearExpr.(\\t1, t1, 0, "level");
    say.("CLEARED", [native.log.collect { |l| l[0] }.asArray, exprsOf.(t1)[\\slot0_level].isNil, exprFeedsOf.(t1).size]);
    // 7. On a plugin parameter: a control bus, the value read first, and put back on the clear.
    installExpr.(\\t2, t2, 0, "cutoff", ${q(TREE_SHAPE)});
    say.("PLUGIN", [exprsOf.(t2)[\\slot0_cutoff][\\outKind], plugin.log.collect { |l| l[0] }.asArray]);
    plugin.log.clear;
    clearExpr.(\\t2, t2, 0, "cutoff");
    say.("PLUGCLEAR", plugin.log.asArray);
    // 8. One control's jobs run in order, and a failing one does not stall the next.
    order = List.new;
    exprRun.(\\t1, 0, "level", { 0.1.wait; order.add(1) });
    exprRun.(\\t1, 0, "level", { order.add(2); nil.foo });
    exprRun.(\\t1, 0, "level", { order.add(3) });
    0.5.wait;
    say.("ORDER", [order.asArray, exprQueue.size]);
    "DONE".postln;
    0.exit;
}.play(AppClock);
SystemClock.sched(20, { "TIMEOUT".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-l', conf, '-u', '57302', file], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

function tag(out, name) {
  const m = new RegExp(`${name}<(.*)>`).exec(out);
  assert.ok(m, `no ${name} line in:\n${out.split('\n').slice(-25).join('\n')}`);
  return m[1];
}

test('expressions install, update in place, rebuild on a new shape, feed their leaves, clear and queue as the engine expects', (t) => {
  const out = run();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.ok(out.includes('DONE'), `the harness did not finish:\n${out.split('\n').slice(-30).join('\n')}`);
  assert.strictEqual(tag(out, 'HELD'), "['k1', 77, 'a1', -1]");
  assert.strictEqual(tag(out, 'DEVICE'), "['device', ['mapAudio'], 4, true]");
  assert.strictEqual(tag(out, 'WIRED'), "[['t1', 0, \"~0~level\", \"src\"]]");
  assert.strictEqual(tag(out, 'DEFS'), '1');
  assert.strictEqual(tag(out, 'NUMBERS'), '[true, 1, 0, 0]');
  assert.strictEqual(tag(out, 'SHAPE'), "[false, 2, true, [['t1', 0, \"~0~level\"]]]");
  assert.strictEqual(tag(out, 'FEED'), "['k1', 77, 'a1', 88]");
  assert.strictEqual(tag(out, 'CLEARED'), "[['unmapAudio', 'get', 'set'], true, 0]");
  assert.strictEqual(tag(out, 'PLUGIN'), "['plugin', ['get', 'map']]");
  assert.strictEqual(tag(out, 'PLUGCLEAR'), "[['unmap', 3], ['set', 3, 0.25]]");
  assert.strictEqual(tag(out, 'ORDER'), '[[1, 2, 3], 0]');
});
