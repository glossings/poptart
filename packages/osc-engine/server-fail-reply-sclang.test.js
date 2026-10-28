'use strict';

// Does scsynth ever SEND the `/fail` message the engine's only repair hangs on?
//
// sc/poptart.scd listens for it - `OSCdef(\poptartServerFail, …, '/fail', server.addr)` - and that
// listener is the whole of what repairs a polled control whose ramp node has gone: it drops the
// `track[\ramps]` entry so the next poll (30ms) builds a fresh ramp and re-maps the parameter.
// A real set took 14,222 `FAILURE IN SERVER /n_set Node 2422 not found` at ~66/sec with that
// listener loaded - proven loaded by the boot line's `max nodes: 8192` - and produced NONE of its
// three outputs: no repair line, no "the server has no node", no "OUT OF ROOM" (2026-10-05).
//
// So the premise needed checking rather than the search inside `nodeGone`. It needed checking
// because `FAILURE IN SERVER` is not sclang's string at all: it appears nowhere in SCClassLibrary.
// scsynth prints it to its OWN stdout, which Node captures into engine.log - so a log full of
// those lines says only that scsynth noticed, never that sclang was told. No amount of reading
// the engine's logs can separate those two, which is why this boots a server and watches the wire.
//
// Both ways of sending are tried, because they are not the same question. poptart writes every
// polled value inside a TIMESTAMPED bundle (`bundleNow`), and a bundle is unpacked and performed
// on a different path in the server than a message arriving on its own.
//
// Unlike the other *-sclang tests this one needs a REAL-TIME scsynth, hence an audio device, so it
// is skipped (not failed) wherever it cannot get one.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const SRC = fs.readFileSync(SCD, 'utf8');

/** One `name = { … };` closure, as the other sclang tests lift theirs. */
function closure(name) {
  const m = SRC.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

/** One `name = [ … ];` assignment, however many lines it runs to. */
function listAssign(name) {
  const m = SRC.match(new RegExp(`^${name} = \\[[\\s\\S]*?\\];$`, 'm'));
  assert.ok(m, `could not find the ${name} list in sc/poptart.scd`);
  return m[0];
}

/**
 * A whole `OSCdef(\key, …);` call, balanced on parentheses - the registration itself, which is
 * the part no test has ever run. Lifted rather than paraphrased on purpose: a stand-in responder
 * written here proved only that a stand-in works (which it does - see the first test).
 */
function oscdef(key) {
  const at = SRC.indexOf(`OSCdef(\\${key},`);
  assert.ok(at >= 0, `could not find the ${key} OSCdef in sc/poptart.scd`);
  let depth = 0;
  for (let i = at; i < SRC.length; i++) {
    if (SRC[i] === '(') depth++;
    else if (SRC[i] === ')' && --depth === 0) return `${SRC.slice(at, i + 1)};`;
  }
  assert.fail(`unbalanced parentheses after ${key}`);
  return '';
}

const LANG_PORT = '57293'; // its own, like every sclang harness here
const SCSYNTH_PORT = 57119; // ...and its own server port, clear of poptart's 57110

/** The harness: boot, kill a node, write to it both ways, report what the responder heard. */
const HARNESS = `(
var server, synth, dead;

server = Server(\\poptartFailTest, NetAddr("127.0.0.1", ${SCSYNTH_PORT}));
// Output only, and the smallest server that will boot: an input channel count a device cannot
// supply is itself a boot failure (see sc/poptart.scd's device notes), and nothing here sounds.
server.options.numInputBusChannels = 0;
server.options.numOutputBusChannels = 2;
server.options.outputStreamsEnabled = "0"; // tests never play through the speakers
server.options.memSize = 8192;

// The responder under test, registered exactly as the engine registers its own.
OSCdef(\\failWatch, { |msg|
    ("SAWFAIL<" ++ msg[1].asString ++ "|"
        ++ msg.copyRange(2, msg.size - 1).collect({ |a| a.asString }).join("~") ++ ">").postln;
}, '/fail', server.addr);

server.waitForBoot {
    SynthDef(\\poptart_failtest, { Out.ar(0, Silent.ar(2) * \\amp.kr(0)) }).add;
    server.sync;
    synth = Synth(\\poptart_failtest, [], server);
    server.sync;
    dead = synth.nodeID;
    ("DEAD<" ++ dead ++ ">").postln;
    // Free it, and let the free land before anything is written to it: from here on, every write
    // below is aimed at a node the server genuinely does not have - the state a stranded ramp is
    // in for the whole life of its track.
    synth.free;
    server.sync;
    0.3.wait;

    "PHASE<bare>".postln;
    server.sendMsg('/n_set', dead, 'amp', 0.0);
    0.6.wait;

    // ...and the way poptart actually sends it: one timestamped bundle, a little in the future.
    "PHASE<bundled>".postln;
    server.sendBundle(0.1, ['/n_set', dead, 'amp', 0.0]);
    0.8.wait;

    "PHASE<end>".postln;
    server.quit;
    0.4.wait;
    0.exit;
};
)
`;

function runHarness(body = HARNESS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-failreply-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, body);
  // Same wrapper as the other sclang harnesses: the failsafe exit is armed BEFORE the harness
  // loads, so a syntax error in it reports instead of idling until the outer timeout. Longer than
  // theirs because this one waits on a real boot.
  const runner = path.join(dir, 'run.scd');
  fs.writeFileSync(runner, `(
SystemClock.sched(40, { "FAILSAFE-EXIT".postln; 0.exit; nil });
thisProcess.interpreter.executeFile(${JSON.stringify(file)});
)
`);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, runner], {
      encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

/** The output between two PHASE markers - what arrived while that one write was outstanding. */
function phase(out, name, next) {
  const from = out.indexOf(`PHASE<${name}>`);
  if (from < 0) return '';
  const to = next ? out.indexOf(`PHASE<${next}>`, from) : -1;
  return out.slice(from, to < 0 ? out.length : to);
}

test('scsynth tells sclang about a write to a node that is gone - bare AND bundled', (t) => {
  const out = runHarness();
  if (!/PHASE<end>/.test(out)) {
    t.skip(`no real-time server here: ${out.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
    return;
  }
  const dead = out.match(/DEAD<(\d+)>/)?.[1];
  assert.ok(dead, 'the harness never reported which node it killed');

  const bare = phase(out, 'bare', 'bundled');
  const bundled = phase(out, 'bundled', 'end');

  // What scsynth PRINTED, per phase. This is the thing engine.log has 14,222 of, and it is only
  // half the story - it is recorded here so a failure says which half actually happened.
  const printed = (s) => /FAILURE IN SERVER/.test(s);
  // ...and what the responder HEARD, which is the half the repair depends on.
  const heard = (s) => new RegExp(`SAWFAIL</n_set\\|[^>]*${dead}`).test(s);

  assert.ok(printed(bare) || heard(bare),
    `scsynth did not react at all to a bare write to freed node ${dead} - the harness is not testing what it thinks`);

  assert.ok(heard(bare),
    `scsynth PRINTED the failure but sent no /fail for a BARE write to freed node ${dead}: `
    + 'the engine\'s repair listens for a message the server never sends');

  assert.ok(heard(bundled),
    `a BARE write is reported to sclang but a BUNDLED one is not - and poptart sends every polled `
    + `value in a timestamped bundle (bundleNow), so the repair can never fire for the case it was `
    + `written for. Freed node ${dead}.`);
});

// --- and now the shipped responder, on a real failure ------------------------------------------
//
// The test above proves the message arrives and that a responder registered that way hears it.
// This one runs the ENGINE'S OWN responder - the `OSCdef(\poptartServerFail, …)` call lifted
// whole out of sc/poptart.scd, over the real `nodeGone`/`nodeFailId`/`outOfRoom` closures and the
// real phrase list - against a node the server has genuinely freed, written to the way poptart
// writes (a timestamped bundle). The only thing faked is `tracks`, which stands in for one track
// holding one polled control on that node, exactly as node-gone-sclang.test.js fakes it.
//
// If this drops the ramp entry, the repair works and a storm in the wild is something else. If it
// does not, this is the gap the 14,222 failures came through - and whatever sclang says about why
// is in the output.

const REAL_HARNESS = `(
var server, synth, dead, tracks;
var nodeGone, nodeGoneSaid, nodeFailId, nodeMissing, nodeOwners, nodeOwns, deadNodes, slotLive;
var outOfRoom, outOfRoomSaid, outOfRoomPhrases;

${closure('nodeGone')}
${closure('nodeFailId')}
${closure('nodeMissing')}
${closure('outOfRoom')}
${closure('nodeOwns')}
${closure('slotLive')}
${listAssign('outOfRoomPhrases')}
// All initialized beside their closures in poptart.scd rather than inside them.
outOfRoomSaid = IdentitySet.new;
nodeGoneSaid = IdentitySet.new;
nodeOwners = IdentityDictionary.new;
deadNodes = IdentitySet.new;
tracks = IdentityDictionary.new;

server = Server(\\poptartFailReal, NetAddr("127.0.0.1", ${SCSYNTH_PORT + 1}));
server.options.numInputBusChannels = 0;
server.options.numOutputBusChannels = 2;
server.options.outputStreamsEnabled = "0"; // tests never play through the speakers
server.options.memSize = 8192;

${oscdef('poptartServerFail')}

server.waitForBoot {
    SynthDef(\\poptart_failtest, { Out.ar(0, Silent.ar(2) * \\amp.kr(0)) }).add;
    server.sync;
    synth = Synth(\\poptart_failtest, [], server);
    server.sync;
    dead = synth.nodeID;
    synth.free;
    server.sync;
    0.3.wait;
    ("DEAD<" ++ dead ++ ">").postln;

    // One track, one polled control, pointed at the node that has just gone - a real Synth object
    // made with basicNew so it answers nodeID without ever having been sent to a server.
    tracks[\\kick] = (ramps: IdentityDictionary.new, group: nil);
    tracks[\\kick][\\ramps][\\slot0_Cutoff] = (
        synth: Synth.basicNew(\\poptart_ramp, server, dead), bus: nil, index: 3, slot: 0);

    // ...written to exactly as rampTo writes: inside a timestamped bundle.
    "PHASE<write>".postln;
    server.sendBundle(0.1, ['/n_set', dead, 'amp', 0.0]);
    1.2.wait;

    ("DROPPED<" ++ tracks[\\kick][\\ramps][\\slot0_Cutoff].isNil ++ ">").postln;
    "PHASE<end>".postln;
    server.quit;
    0.4.wait;
    0.exit;
};
)
`;

test("the engine's own /fail responder drops a stranded ramp, on a real failure", (t) => {
  const out = runHarness(REAL_HARNESS);
  if (!/PHASE<end>/.test(out)) {
    t.skip(`no real-time server here: ${out.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
    return;
  }
  const dead = out.match(/DEAD<(\d+)>/)?.[1];
  assert.ok(dead, 'the harness never reported which node it killed');
  // The write really did fail - otherwise there is nothing for the responder to have heard, and
  // a "pass" below would mean nothing.
  assert.match(out, /FAILURE IN SERVER/,
    `scsynth did not refuse the write to freed node ${dead}: this is not testing a real failure`);
  assert.match(out, /DROPPED<true>/,
    'the shipped responder did not drop the stranded ramp. sclang said: '
    + (out.match(/ERROR[\s\S]{0,400}/)?.[0] ?? out.trim().split('\n').slice(-12).join(' | ')));
});
