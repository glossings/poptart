'use strict';

// watchPluginEdits + the self-load window (sc/poptart.scd) - auto-pin must not hear its own
// program loads.
//
// Auto-pin watches three plugin callbacks to notice that a slot's sound has drifted from the code
// (see watchPluginEdits). A `readProgram` fires them too: a plugin that redraws when its program
// changes cannot tell a host load from a click in its own preset browser. So every state poptart
// pushed came back as "the user just edited this slot" and was captured again.
//
// On a slot whose preset nothing else plays that only cost a wasted capture - the program came
// back as the code already said it and the editor stopped. Two tracks sharing one preset
//
//   pluck:  ... .fx("Kickstart 2").preset("pluckSC") ...
//   pluck2: ... .fx("Kickstart 2").preset("pluckSC") ...
//
// made it a LOOP: the capture from `pluck` is filed in the shared definition, the next evaluation
// pushes it into `pluck2`'s copy of the plugin (it must - one preset, one sound), that push is
// heard as an edit, and a plugin whose program doesn't round-trip byte-for-byte then writes a
// different state back into the same definition, which goes back to `pluck`, forever (reported
// 2026-08-27, Kickstart 2).
//
// What this guards: a slot is deaf to its plugin from the moment we hand it a program until a
// little after the load lands, and hearing again afterwards.
//
// Like the other *-sclang tests, the source under test is lifted out of the shipped poptart.scd
// and run in a real sclang; skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

// Lift `name = { ... };` from its assignment to its close. A closure written over several lines
// ends at a `};` in column 0 - poptart.scd writes every one of them at the top level, so nothing
// inside one is indented that far - and a one-line closure ends on the line it opened, which has
// to be tried FIRST: `[\s\S]*?^\};$` reads straight past a one-liner and swallows whatever
// closures follow it.
function extract(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const oneLine = src.match(new RegExp(`^${name} = \\{[^\\n]*\\};$`, 'm'));
  const m = oneLine ?? src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

function runSclang() {
  // The tail is the one thing given a value of its own here: how long a plugin may go on redrawing
  // after a load is a judgement call in the engine, and waiting the real one out would only make
  // this slower. What is under test is that there IS a window and that it closes.
  const script = `(
var srv = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var nodeAddr = NetAddr("127.0.0.1", NetAddr.langPort);
var selfLoads = IdentityDictionary.new;
var coldWaitMax = 20;
var selfLoadTail = 0.2;
var slotKey, beginSelfLoad, endSelfLoad, selfLoading, watchPluginEdits;
var edits = 0, params = 0, knob;
// Stands in for the VSTPluginController: watchPluginEdits only ever asks it for the parameter
// names conf mode reports, and for the synth an OSCFunc's argTemplate filters on. Its synth is a
// real (never-created) node on a never-booted server - the argTemplate wants a nodeID and a
// server address, and nothing here ever talks to one.
//
// Built out of know-dictionaries rather than Events: an Event answers .synth with a method of
// its own (it means something in the event-play protocol) and hands back ITSELF, so a plugin
// controller faked as one has no synth at all.
var mkObj = { |pairs|
    var d = IdentityDictionary.new;
    d.know = true;
    pairs.pairsDo { |k, v| d.put(k, v) };
    d;
};
var mkCtl = {
    mkObj.([
        \\synth, Synth.basicNew(\\poptartProbeSynth, srv),
        \\synthIndex, 0,
        \\info, mkObj.([\\parameters, [mkObj.([\\name, "Cutoff"])]])
    ]);
};
var track = (confMode: false, editWatch: Array.newClear(8));
var ctl = mkCtl.value;
var say = { |tag, v| (tag ++ "<" ++ v.asString ++ ">").postln };

${extract('slotKey')}
${extract('beginSelfLoad')}
${extract('endSelfLoad')}
${extract('selfLoading')}
${extract('watchPluginEdits')}

say.("COMPILES", [slotKey, beginSelfLoad, endSelfLoad, selfLoading, watchPluginEdits].every { |f| f.isKindOf(Function) });

OSCdef(\\probeEdited, { edits = edits + 1 }, '/poptart/pluginEdited');
OSCdef(\\probeParam, { params = params + 1 }, '/poptart/paramAutomated');

watchPluginEdits.(track, \\pluck, 1, ctl);

// One knob move in the plugin's own window. Read out of the dictionary by key rather than as
// ctl.parameterAutomated: a know-dictionary CALLS a function it is asked for by name, which is
// how the plugin's own callbacks work and not what fetching one to fire by hand wants.
knob = { ctl[\\parameterAutomated].value(0, 0.5) };

fork {
    // Nothing loading: a knob in the plugin's own window is an edit, and conf mode reports it.
    track[\\confMode] = true;
    say.("IDLE_LOADING", selfLoading.(\\pluck, 1));
    knob.value;
    0.3.wait;
    say.("IDLE_EDITS", edits);
    say.("IDLE_PARAMS", params);

    // A program on its way in: the slot goes deaf, and stays deaf while the load runs.
    beginSelfLoad.(slotKey.(\\pluck, 1));
    say.("LOADING", selfLoading.(\\pluck, 1));
    knob.value;
    0.3.wait;
    say.("LOAD_EDITS", edits);
    say.("LOAD_PARAMS", params);

    // ...and for the tail after it lands, where the redraw the load caused turns up.
    endSelfLoad.(slotKey.(\\pluck, 1));
    say.("TAIL", selfLoading.(\\pluck, 1));
    knob.value;
    0.05.wait;
    say.("TAIL_EDITS", edits);

    // Only THIS slot is deaf - the same plugin on another track is still its own.
    say.("OTHER_SLOT", selfLoading.(\\pluck, 2));
    say.("OTHER_TRACK", selfLoading.(\\pluck2, 1));

    // The tail runs out and the plugin is heard again.
    (selfLoadTail + 0.2).wait;
    say.("AFTER", selfLoading.(\\pluck, 1));
    knob.value;
    0.3.wait;
    say.("AFTER_EDITS", edits);
    say.("AFTER_PARAMS", params);

    // A load that never reports back must not deafen the slot for good: the deadline taken at the
    // start is the failsafe, and it is bounded.
    beginSelfLoad.(slotKey.(\\pluck, 1));
    say.("STUCK_UNTIL", selfLoads[slotKey.(\\pluck, 1)][\\until] - Main.elapsedTime);

    // Two loads on one slot: the first one landing must not open the ears while the second is
    // still writing into the plugin.
    beginSelfLoad.(slotKey.(\\pluck, 3));
    beginSelfLoad.(slotKey.(\\pluck, 3));
    endSelfLoad.(slotKey.(\\pluck, 3));
    say.("NESTED", selfLoading.(\\pluck, 3));
    say.("NESTED_UNTIL", (selfLoads[slotKey.(\\pluck, 3)][\\until] - Main.elapsedTime) > selfLoadTail);
    0.exit;
};
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-selfload-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), [file], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('auto-pin does not hear the programs poptart loads itself', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  // Anchored: every reading is its own line, and an unanchored `LOADING<` would be answered by
  // the tail of `IDLE_LOADING<...>` further up.
  const said = (tag) => out.match(new RegExp(`^${tag}<([^>]*)>`, 'm'))?.[1];

  assert.equal(said('COMPILES'), 'true', `the plugin-edit closures did not compile:\n${out}`);

  // The plugin is heard normally when nothing of ours is going into it.
  assert.equal(said('IDLE_LOADING'), 'false');
  assert.equal(said('IDLE_EDITS'), '1', `a real gesture must reach auto-pin:\n${out}`);
  assert.equal(said('IDLE_PARAMS'), '1', 'and conf mode');

  // The regression: while our own program is going in, nothing is reported.
  assert.equal(said('LOADING'), 'true');
  assert.equal(said('LOAD_EDITS'), '1', `a load of ours is not an edit:\n${out}`);
  assert.equal(said('LOAD_PARAMS'), '1', 'and not a parameter anyone moved');

  // The redraw a load causes arrives after the load reports in, so the window outlives it.
  assert.equal(said('TAIL'), 'true');
  assert.equal(said('TAIL_EDITS'), '1');

  // Scoped to the slot: this is not a global mute on plugin edits.
  assert.equal(said('OTHER_SLOT'), 'false');
  assert.equal(said('OTHER_TRACK'), 'false');

  // ...and it closes.
  assert.equal(said('AFTER'), 'false');
  assert.equal(said('AFTER_EDITS'), '2', `the next knob turn must be heard:\n${out}`);
  assert.equal(said('AFTER_PARAMS'), '2');

  // A load that never lands leaves a bounded window, not a permanent one.
  const stuck = Number(said('STUCK_UNTIL'));
  assert.ok(stuck > 0 && stuck <= 20, `the failsafe window should be bounded, got ${said('STUCK_UNTIL')}`);

  // Overlapping loads: the tail belongs to the last one to land.
  assert.equal(said('NESTED'), 'true');
  assert.equal(said('NESTED_UNTIL'), 'true', 'the first load landing must not open the slot early');
});
