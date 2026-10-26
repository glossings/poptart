'use strict';

// Audio patched onto a parameter, the sclang half: wireParamRoute / unwireParamRoute /
// applyParamRoute and the route's place in trackLevels (sc/poptart.scd). What has to hold:
//
//   - a route onto one of poptart's own devices maps the source's feed onto the control, with
//     the gain and offset it rode in on, and orders the source ahead of the track that reads it;
//   - unpatching takes the control off the bus, puts it back on the value last set, releases
//     the source's feed, and the order relaxes again;
//   - a plugin's slot cannot take one - it is warned about once, not connected, and held;
//   - a route dropped before its wiring got going (two evaluations in a row) never lands;
//   - a named bus works as a source the way a track does.
//
// The closures are lifted out of poptart.scd and run against mocks, so the source under test is
// the shipped one. The mock controller is a class (written into the class path for the run)
// rather than an Event, because an Event cannot stand in for `set` - Event already has one.
// Skipped, not failed, where sclang cannot run.

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
  const from = src.indexOf('paramRouteKey = {');
  const to = src.indexOf('// How deep each track sits (key -> depth)');
  assert.ok(from > 0 && to > from, 'the parameter route closures are not where this test expects them in poptart.scd');
  const levels = src.match(/^trackLevels = \{[\s\S]*?^\};$/m);
  assert.ok(levels, 'trackLevels is not in poptart.scd any more');
  return `${src.slice(from, to)}\n${levels[0]}`;
}

const MOCK_CLASS = `
PRTestCtl {
    var <>log, <>info, <>native;
    *new { |native = true| ^super.new.init(native) }
    init { |n| native = n; log = List.new; info = (level: 4, cutoff: 3) }
    respondsTo { |sel| ^if ((sel == \\mapAudio) or: { sel == \\unmapAudio }) { native } { super.respondsTo(sel) } }
    mapAudio { |index, bus, gain, offset| log.add([\\mapAudio, index, bus, gain, offset]) }
    unmapAudio { |index| log.add([\\unmapAudio, index]) }
    get { |index, action| action.value(0.25) }
    set { |index, value| log.add([\\set, index, value]) }
}
`;

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-proute-'));
  fs.writeFileSync(path.join(dir, 'PRTestCtl.sc'), MOCK_CLASS);
  const conf = path.join(dir, 'sclang_conf.yaml');
  // Only the mock's folder: none of poptart's classes are needed, and the installed copies are
  // left out so a machine that has run poptart compiles the same library as one that has not.
  fs.writeFileSync(conf, `includePaths:\n  - ${dir}\nexcludePaths:\n  - ${path.join(userExtensionsDir(), 'PoptartDevice.sc')}\n`);
  const script = `(
var paramRoutes, paramRouteKey, wireParamRoute, unwireParamRoute, applyParamRoute, reassertParamRoute, trackLevels;
var tracks, awaitTrack, namedBuses, sidechainByTarget, acquireSourceFeed, releaseSourceFeed, acquireBus, releaseBus;
var reorderTracks, resolveParamIndex, dropRamp, feeds, released, buses, drops, native, plugin, say;
paramRoutes = IdentityDictionary.new;
sidechainByTarget = IdentityDictionary.new;
namedBuses = IdentityDictionary.new;
namedBuses[\\mix] = (bus: 200, refs: 1);
feeds = IdentityDictionary.new; released = List.new; buses = List.new; drops = List.new;
native = PRTestCtl(true);
plugin = PRTestCtl(false);
tracks = IdentityDictionary.new;
tracks[\\src] = (controllers: [nil], loaded: [nil], envs: IdentityDictionary.new);
tracks[\\t1] = (controllers: [native], loaded: ["Noise"], envs: IdentityDictionary.new);
tracks[\\t2] = (controllers: [plugin], loaded: ["Serum 2"], envs: IdentityDictionary.new);
awaitTrack = { |key| tracks[key] };
acquireSourceFeed = { |key, source| feeds[key] = (feeds[key] ? 0) + 1; 100 };
releaseSourceFeed = { |key| released.add(key) };
acquireBus = { |name| buses.add(name.asSymbol); 200 };
releaseBus = { |name| buses.add(("-" ++ name).asSymbol) };
reorderTracks = { };
resolveParamIndex = { |info, name| info[name.asSymbol] };
dropRamp = { |key, track, rampKey| drops.add(rampKey) };
say = { |tag, value| (tag ++ "<" ++ value.asCompileString ++ ">").postln };
${lift()}
Routine {
    var levels;
    // 1. A track source onto a native device's control.
    wireParamRoute.(\\t1, 0, "level", "src", 0.5, 0.25);
    0.2.wait;
    say.("MAPPED", native.log.asArray);
    say.("FEEDS", feeds[\\src]);
    say.("DROPPED", drops.asArray);
    levels = trackLevels.();
    say.("LEVELS", [levels[\\src], levels[\\t1]]);
    // 2. Unpatched: off the bus, back on the value last set, the feed released.
    native.log.clear;
    unwireParamRoute.(\\t1, 0, "level");
    say.("UNMAPPED", native.log.asArray);
    say.("RELEASED", released.asArray);
    say.("LEFT", paramRoutes.size);
    levels = trackLevels.();
    say.("LEVELS2", levels[\\t1]);
    // 3. A plugin's slot: held, warned about, not connected.
    wireParamRoute.(\\t2, 0, "cutoff", "src", 1, 0);
    0.2.wait;
    applyParamRoute.(tracks[\\t2], paramRoutes[paramRouteKey.(\\t2, 0, "cutoff")]);
    say.("PLUGIN", plugin.log.asArray);
    say.("HELD", paramRoutes[paramRouteKey.(\\t2, 0, "cutoff")].notNil);
    unwireParamRoute.(\\t2, 0, "cutoff");
    // 4. Dropped before its wiring ran: never lands.
    native.log.clear;
    feeds.clear;
    wireParamRoute.(\\t1, 0, "level", "src", 1, 0);
    unwireParamRoute.(\\t1, 0, "level");
    0.2.wait;
    say.("SUPERSEDED", [native.log.asArray, feeds[\\src], paramRoutes.size]);
    // 5. A named bus as the source.
    wireParamRoute.(\\t1, 0, "cutoff", "bus:mix", 2, 0);
    0.2.wait;
    say.("BUS", [native.log.asArray, buses.asArray]);
    unwireParamRoute.(\\t1, 0, "cutoff");
    say.("BUSFREED", buses.asArray);
    "DONE".postln;
    0.exit;
}.play(AppClock);
SystemClock.sched(20, { "TIMEOUT".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-l', conf, '-u', '57300', file], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('a parameter route is wired, ordered, refused on a plugin and unwired as the engine expects', (t) => {
  const text = run();
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.ok(text.includes('DONE'), `the harness did not finish:\n${text.split('\n').slice(-30).join('\n')}`);
  const mark = (tag) => {
    const m = new RegExp(`^${tag}<(.*)>$`, 'm').exec(text);
    assert.ok(m, `no ${tag} line in:\n${text.split('\n').slice(-30).join('\n')}`);
    // Compared without whitespace: what matters is the values, not how sclang spaces a list.
    return m[1].replace(/\s+/g, '');
  };
  assert.equal(mark('MAPPED'), '[[\'mapAudio\',4,100,0.5,0.25]]');
  assert.equal(mark('FEEDS'), '1');
  assert.equal(mark('DROPPED'), '[\'slot0_level\']', 'a ramp left by a polled value should go');
  assert.equal(mark('LEVELS'), '[0,1]', 'the source has to run before the track that reads it');
  assert.equal(mark('UNMAPPED'), '[[\'unmapAudio\',4],[\'set\',4,0.25]]');
  assert.equal(mark('RELEASED'), '[\'src\']');
  assert.equal(mark('LEFT'), '0');
  assert.equal(mark('LEVELS2'), '0');
  assert.equal(mark('PLUGIN'), '[]', 'a plugin parameter must not be sent an audio map');
  assert.equal(mark('HELD'), 'true');
  const warnings = text.match(/reaches poptart's own devices only/g) ?? [];
  assert.equal(warnings.length, 1, 'the plugin refusal should be said once, not on every apply');
  assert.equal(mark('SUPERSEDED'), '[[],nil,0]');
  assert.equal(mark('BUS'), '[[[\'mapAudio\',3,200,2,0]],[\'mix\']]');
  assert.equal(mark('BUSFREED'), '[\'mix\',\'-mix\']');
});
