'use strict';

// The books sclang still keeps for what Node plays itself (sc/poptart.scd's /poptart/direct/*
// handlers and the tell* helpers): the voice ceiling still steals the oldest voice whoever made it,
// the held count follows Node's notes, a hush releases a note Node played by name, and a channel
// control coming to rest is the one ramp value Node is told not to send itself.
//
// Like the other *-sclang tests: the subjects are lifted out of the shipped file, run in a real
// sclang against a stand-in server address that prints what it is sent, and skipped where sclang
// cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = '57374'; // its own, like every sclang harness

const src = () => fs.readFileSync(SCD, 'utf8');
function closure(name) {
  const m = src().match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find ${name} in sc/poptart.scd`);
  return m[0];
}
function handler(name, address) {
  const m = src().match(new RegExp(`^OSCdef\\(\\\\${name}, \\{[\\s\\S]*?^\\}, '${address.replace(/\//g, '\\/')}'\\);$`, 'm'));
  assert.ok(m, `could not find the ${name} handler in sc/poptart.scd`);
  return m[0];
}

function run() {
  const script = `(
var server = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var tracks = IdentityDictionary.new, noteQueues = IdentityDictionary.new, songs = IdentityDictionary.new;
var nodeGoneSaid = IdentitySet.new, deadNodes = IdentitySet.new;
var bundleNow = { |latency, func| func.value };
var slotNode = { |track, slot| track[\\synth] };
var maxVoices = 2, liveVoices = List.new, voiceBorn, voiceDone, voiceCapSaidAt = 0;
var markSounding, noteKey, hushTrack, slotLive, channelDefault, tellRamp, heldBy;
var nodeAddr = (sendMsg: { |self ...m| ("TOLD<" ++ m.join(",") ++ ">").postln });
server.addr = (addr: 1, isLocal: true, hostname: "127.0.0.1", ip: "127.0.0.1", port: 57999,
    sendMsg: { |self ...msg| ("SENT<" ++ msg.join(",") ++ ">").postln },
    sendBundle: { |self, time ...msgs| msgs.do { |msg| ("SENT<" ++ msg.join(",") ++ ">").postln } });
${closure('voiceBorn')}
${closure('markSounding')}
${closure('noteKey')}
${closure('hushTrack')}
${closure('channelDefault')}
${closure('tellRamp')}
${closure('heldBy')}
voiceDone = { |synth| liveVoices.remove(synth) };
slotLive = { |track, slot| true };
${handler('poptartDirectNote', '/poptart/direct/note')}
${handler('poptartDirectVoice', '/poptart/direct/voice')}
${handler('poptartDirectHeld', '/poptart/direct/held')}
tracks[\\kick] = (key: \\kick, held: 0, envs: IdentityDictionary.new,
    voices: Group.basicNew(server, 50), synth: Synth.basicNew(\\x, server, 51),
    loaded: IdentityDictionary[0 -> "plugin"],
    controllers: IdentityDictionary[0 -> (info: (sdkVersion: "VST 3.7"),
        midi: (noteOff: { |self, ch, note| ("RELEASED<" ++ note ++ ">").postln }))],
    sounding: IdentityDictionary.new);
{
    var call = { |name, args| OSCdef(name).func.value([\\x] ++ args) };
    // three voices Node made, two allowed: the first is released early
    call.(\\poptartDirectVoice, [\\kick, 7001, \\poptart_sample_1, 0.05]);
    call.(\\poptartDirectVoice, [\\kick, 7002, \\poptart_sample_1, 5]);
    call.(\\poptartDirectVoice, [\\kick, 7003, \\poptart_sample_1, 5]);
    ("LIVE<" ++ liveVoices.collect(_.nodeID).join(",") ++ ">").postln;
    ("HELD1<" ++ tracks[\\kick][\\held] ++ ">").postln;
    call.(\\poptartDirectHeld, [\\kick, -3]);
    // a note on and its off in five seconds, then a note on with no off yet: a hush releases both
    call.(\\poptartDirectNote, [\\kick, 0, 60, -1]);
    call.(\\poptartDirectNote, [\\kick, 0, 60, 5]);
    call.(\\poptartDirectNote, [\\kick, 0, 64, -1]);
    ("HELD2<" ++ tracks[\\kick][\\held] ++ ">").postln;
    hushTrack.(\\kick, 0);
    // what Node is told about ramps
    tellRamp.(tracks[\\kick], \\slot0_Cutoff, 0, Synth.basicNew(\\r, server, 8001), 0.5);
    tellRamp.(tracks[\\kick], 'slot-1_gain', -1, Synth.basicNew(\\r, server, 8002), 1);
    tellRamp.(tracks[\\kick], 'slot-1_gain', -1, Synth.basicNew(\\r, server, 8002), 0.7);
    tellRamp.(tracks[\\kick], \\slot0_Cutoff, nil, nil, nil);
    // sclang's own held changes are told; a change that changes nothing is not
    heldBy.(tracks[\\kick], -1);
    heldBy.(tracks[\\kick], 1);
}.try({ |e| ("HARNESS ERROR: " ++ e.errorString).postln });
SystemClock.sched(0.3, { ("LIVE2<" ++ liveVoices.collect(_.nodeID).join(",") ++ ">").postln; 0.exit; nil });
)
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-direct-books-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('what Node plays is on sclang\'s books: the ceiling, the held count, a hush and the ramps', (t) => {
  if (!fs.existsSync(resolveSclangPath())) return t.skip('no sclang here');
  const out = run();
  if (!/Welcome to SuperCollider/.test(out)) return t.skip('sclang did not start here');
  assert.ok(!/HARNESS ERROR|ERROR:/.test(out), out);
  // Voice stealing: the oldest of Node's voices is released when a third would pass the ceiling.
  assert.match(out, /SENT<15,7001,gate,0>|SENT<\/n_set,7001,gate,0>/, 'the oldest voice was not released at the ceiling');
  assert.match(out, /LIVE<7002,7003>/);
  assert.match(out, /HELD1<3>/, 'each of Node\'s voices holds the track like one made here');
  // Its own end drops it from the count, as voiceDone does for sclang's voices.
  assert.match(out, /LIVE2<7002,7003>/);
  assert.match(out, /HELD2<1>/, 'Node\'s note on and off did not move the held count');
  // A hush releases what Node played by name - the 60 whose off is still to come and the 64.
  const released = [...out.matchAll(/RELEASED<(\d+)>/g)].map((m) => Number(m[1])).sort();
  assert.deepStrictEqual(released, [60, 64]);
  assert.match(out, /SENT<15,50,gate,0>|SENT<\/n_set,50,gate,0>/, 'the voices group was not released');
  // The ramps: a plugin value and a channel away from rest go direct; at rest it does not.
  assert.match(out, /TOLD<\/poptart\/ids\/ramp,kick,slot0_Cutoff,8001,0,1>/);
  assert.match(out, /TOLD<\/poptart\/ids\/ramp,kick,slot-1_gain,8002,-1,0,1>/, 'a channel at rest must not go direct');
  assert.match(out, /TOLD<\/poptart\/ids\/ramp,kick,slot-1_gain,8002,-1,1,1>/);
  assert.match(out, /TOLD<\/poptart\/ids\/ramp,kick,slot0_Cutoff,0,0,0>/);
  // Held: after the hush it is 0, so -1 changes nothing (not told) and +1 is told.
  const held = [...out.matchAll(/TOLD<\/poptart\/ids\/held,kick,(-?\d+)>/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(held, [1]);
});
