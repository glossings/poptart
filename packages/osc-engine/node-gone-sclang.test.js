'use strict';

// What happens when scsynth says it has no such node (sc/poptart.scd's nodeGone / nodeFailId).
//
// scsynth ANSWERS a command it could not carry out, with /fail - the same message it prints as
// "FAILURE IN SERVER". For most commands that answer is just a diagnosis: a note aimed at a track
// that has already gone happens once, and nothing is owed.
//
// One of them repeats. A polled control re-sends its value every poll interval (30ms) and rampTo
// moves the SAME ramp synth every time, creating one only when it has none - so a ramp node that
// is not on the server becomes ~33 failed writes a second, with that parameter frozen wherever
// its bus was left, for as long as the track lives. One real session had 8576 of them on a single
// node across 4.4 minutes, in complete silence; the only other trace was the failed /n_free when
// the track was finally destroyed (found 2026-10-05 from ~/.poptart/desktop.log).
//
// So the server is taken at its word: the entry pointing at that node is dropped, and the next
// poll rebuilds the ramp. What is pinned here is that dropping really happens (the repair is
// "rampTo finds the key empty", so the key has to actually be gone), that it is reported, and
// that the id is read out of whichever shape the /fail reply takes.
//
// Like the other *-sclang tests: the subject is lifted out of the shipped poptart.scd, run in a
// real sclang, and skipped (not failed) where sclang cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = '57290'; // its own, like every sclang harness: only ten are tried from 57120 up

/** A `name = { ... };` closure out of the shipped file, whole. */
function extractClosure(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find ${name} in sc/poptart.scd`);
  return m[0];
}

function runSclang(dir, script) {
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

/**
 * Run the harness, or null when sclang never got going - which is the difference between "sclang
 * disagreed" (a failure worth reporting) and "there is no working SuperCollider here" (a skip).
 * The welcome banner is the only reliable sign it started; a sandboxed sclang aborts before it.
 */
function sclangSaid(dir, script) {
  try {
    if (!fs.existsSync(resolveSclangPath())) return null;
  } catch {
    return null;
  }
  const out = runSclang(dir, script);
  return /Welcome to SuperCollider/.test(out) ? out : null;
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-nodegone-'));
}

/**
 * The two closures, over a fake `tracks` holding one polled control on node 4242 - and a stand-in
 * for a Synth that answers nodeID, which is all either closure asks of one.
 */
function harness(body) {
  return `
var tracks = IdentityDictionary.new;
var nodeGone, nodeGoneSaid, nodeFailId, nodeMissing, nodeOwners, nodeOwns, deadNodes, slotLive;
var outOfRoom, outOfRoomSaid, outOfRoomPhrases;
${extractClosure('nodeGone')}
${extractClosure('nodeFailId')}
${extractClosure('nodeMissing')}
${extractClosure('outOfRoom')}
outOfRoomPhrases = ["out of real time memory", "too many nodes",
    "exceeded number of interconnect buffers", "alloc failed", "too many buffers"];
outOfRoomSaid = IdentitySet.new;
${extractClosure('nodeOwns')}
${extractClosure('slotLive')}
// All initialized beside their closures in poptart.scd rather than inside them.
nodeGoneSaid = IdentitySet.new;
nodeOwners = IdentityDictionary.new;
deadNodes = IdentitySet.new;
// Real Synth objects, by node id, made WITHOUT sending anything to a server (basicNew) - the
// closure asks a ramp's synth for its nodeID and nothing else, and an Event standing in for one
// does not answer that (it reads as nil, which quietly matches nothing).
tracks[\\kick] = (ramps: IdentityDictionary.new, group: nil);
tracks[\\kick][\\ramps][\\slot0_Cutoff] = (synth: Synth.basicNew(\\poptart_ramp, nil, 4242), bus: Bus.new(\\control, 7, 1), index: 3, slot: 0);
tracks[\\kick][\\ramps][\\slot1_Drive] = (synth: Synth.basicNew(\\poptart_ramp, nil, 9999), bus: Bus.new(\\control, 8, 1), index: 4, slot: 1);
// Inside a try, so an error in the body still reaches the exit below: without it sclang sits
// there until the harness times out, and every failure costs a minute to find out about.
{
${body}
}.try({ |e| ("HARNESS ERROR: " ++ e.errorString).postln });
0.exit;
`;
}

const SAY = (label, value) => `("${label}=" ++ (${value})).postln;`;

test('a failed write to a ramp drops it, so the next poll rebuilds it', (t) => {
  const out = sclangSaid(scratch(), harness(`
nodeGone.(4242);
${SAY('dropped', 'tracks[\\kick][\\ramps][\\slot0_Cutoff].isNil')}
${SAY('keptOther', 'tracks[\\kick][\\ramps][\\slot1_Drive].notNil')}
`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.match(out, /dropped=true/, 'the dead ramp is still in the dict - rampTo will go on setting it forever');
  assert.match(out, /keptOther=true/, 'an unrelated ramp was taken down with it');
  // The report is a plain warning, which is what makes it visible in the desktop log at all.
  const warned = out.match(/WARNING: poptart: kick's polled control slot0_Cutoff[^\n]*/g) ?? [];
  assert.equal(warned.length, 1, 'the repair has to be reported - this failure was silent for 4 minutes');
  assert.match(warned[0], /4242/, 'the report names the node');
  assert.match(warned[0], /rebuilding/, '...and says what it did about it');
});

test('a node nobody holds is reported once and not once per message', (t) => {
  const out = sclangSaid(scratch(), harness(`
30.do { nodeGone.(777) };
10.do { nodeGone.(888) };
`));
  if (out === null) return t.skip('no working SuperCollider here');
  // Two nodes, two lines. A storm of identical lines is its own kind of invisible, and this is
  // called from a reply that can arrive thirty times a second.
  const warned = out.match(/WARNING: poptart: the server has no node \d+/g) ?? [];
  assert.equal(warned.length, 2, 'an unknown node is being reported on every message, not once');
});

test('nothing is dropped, or said, for a nil id', (t) => {
  const out = sclangSaid(scratch(), harness(`
nodeGone.(nil);
${SAY('intact', 'tracks[\\kick][\\ramps].size')}
`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.match(out, /intact=2/);
  assert.ok(!/WARNING: poptart: (the server has no node|kick)/.test(out),
    'an unreadable reply must not be reported as a missing node');
});

test('the node id is read out of either shape of /fail reply', (t) => {
  const out = sclangSaid(scratch(), harness(`
${SAY('inText', 'nodeFailId.(["/fail", "/n_set", "Node 7961 not found"])')}
${SAY('asArg', 'nodeFailId.(["/fail", "/n_set", "Node not found", 7961])')}
${SAY('bothAgree', 'nodeFailId.(["/fail", "/n_set", "Node 7961 not found"]) == 7961')}
${SAY('none', 'nodeFailId.(["/fail", "/n_set", "wat"]).isNil')}
`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.match(out, /inText=7961/, 'the id in the reason text is the shape scsynth actually sends');
  assert.match(out, /asArg=7961/);
  assert.match(out, /bothAgree=true/);
  assert.match(out, /none=true/, 'a reply with no id in it has to read as nil, not as node 0');
});

test('the /fail listener is there, and reads the node commands', (t) => {
  // Which family each command belongs to - repaired, attributed, or neither - is pinned at the
  // bottom of this file; this only checks the listener is there and reads the node commands.
  const src = fs.readFileSync(SCD, 'utf8');
  const at = src.indexOf('OSCdef(\\poptartServerFail');
  assert.ok(at > 0, 'the /fail listener is gone from poptart.scd');
  const body = src.slice(at, src.indexOf('}, \'/fail\'', at));
  assert.match(body, /"\/n_set"/);
  assert.ok(!body.includes('"/n_free"'), 'a failed /n_free is the teardown saying the node already went');
});

test('a modulator dropped on purpose is not reported as a surprise', () => {
  // The deferred free above this in poptart.scd exists BECAUSE notes already in flight were gated
  // from a timestamped bundle and will write to the node after it goes - that is documented and
  // expected, and reporting each one would bury the failures nobody expected. Source-shape,
  // because the call sits in a SystemClock routine inside the real engine.
  const src = fs.readFileSync(SCD, 'utf8');
  const at = src.indexOf('freeModulatorLater = {');
  assert.ok(at > 0, 'freeModulatorLater is gone from poptart.scd');
  const body = src.slice(at, src.indexOf('\n};', at));
  assert.match(body, /nodeGoneSaid\.add\(sy\.nodeID\)/,
    'a deliberately dropped modulator has to be accounted for, or nodeGone reports every note after it');
  assert.match(body, /nodeGoneSaid\.size > \d+/, 'and the bookkeeping has to stay bounded over a long set');
});

// --- the commands that cannot be repaired, only attributed -------------------------------------
//
// A plugin write is a /u_cmd at the TRACK SYNTH's node, because a plugin lives inside that synth.
// A synth created into a group that has already gone is a /s_new naming the GROUP. Neither can be
// put right - the event is already late, the group is already gone - so what they owe is an
// explanation, and the explanation has to survive the track entry that would have given it.
//
// A bounded burst of these is expected (the scheduler sends a lookahead ahead in timestamped
// bundles, so a teardown leaves everything queued for it to arrive and fail). Expected or not,
// N bare node numbers is noise - and noise is exactly what let 8576 real failures pass unnoticed.

test('a failure names whose node it was, even for a track that has gone', (t) => {
  const out = sclangSaid(scratch(), harness(`
nodeOwns.(5523, "bass's track synth, which its plugins live in");
nodeOwns.(3794, "kick's group");
nodeMissing.("/u_cmd", 5523);
nodeMissing.("/s_new", 3794);
`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.match(out, /no node 5523 \(bass's track synth[^)]*\)/, 'a plugin write has to name its track');
  assert.match(out, /no node 3794 \(kick's group\)/, 'and a failed creation has to name the group\'s owner');
  assert.match(out, /\/u_cmd could not be delivered/, 'and which command it was');
});

test('a node nothing has a record of says so rather than pretending', (t) => {
  const out = sclangSaid(scratch(), harness(`nodeMissing.("/u_cmd", 111);`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.match(out, /no node 111 \(nothing poptart has a record of\)/);
});

test('once per node, not once per message in flight', (t) => {
  const out = sclangSaid(scratch(), harness(`20.do { nodeMissing.("/u_cmd", 5523) };`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.equal((out.match(/no node 5523/g) ?? []).length, 1);
});

test('a plugin on a node the server has lost is not written to again', (t) => {
  // The other half of "quiet": the FIRST failure teaches it, and the rest of the burst is never
  // sent. slotLive is the gate every plugin note and parameter write passes through.
  const out = sclangSaid(scratch(), harness(`
tracks[\\kick][\\loaded] = [\\serum, nil];
tracks[\\kick][\\synth] = Synth.basicNew(\\x, nil, 5523);
${SAY('liveBefore', 'slotLive.(tracks[\\kick], 0)')}
nodeMissing.("/u_cmd", 5523);
${SAY('liveAfter', 'slotLive.(tracks[\\kick], 0)')}
${SAY('emptySlot', 'slotLive.(tracks[\\kick], 1)')}
`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.match(out, /liveBefore=true/, 'a loaded plugin on a live node is writable');
  assert.match(out, /liveAfter=false/, 'the node is gone - nothing else should be sent at it');
  assert.match(out, /emptySlot=false/, 'an empty slot was never writable');
});

test('the repairable family and the attributable family are kept apart', () => {
  const src = fs.readFileSync(SCD, 'utf8');
  const at = src.indexOf('OSCdef(\\poptartServerFail');
  // Comments stripped first: poptart.scd explains the identity trap below in prose directly above
  // the code that avoids it, and a bare text search finds the explanation and calls it the bug.
  const code = src.slice(at, src.indexOf('}, \'/fail\'', at)).replace(/\/\/[^\n]*/g, '');
  assert.match(code, /includes\(cmd\)\) \{\s*nodeGone\./s, '/n_set is repaired');
  assert.match(code, /'\/u_cmd', '\/s_new'.*nodeMissing/s, '/u_cmd and /s_new are attributed');
  assert.ok(!/['"]\/n_free['"]/.test(code), 'a failed /n_free is the teardown saying so, and needs neither');
  // ...and both families spelled as SYMBOLS. Collection:includes compares by IDENTITY, so a
  // String literal array matches nothing however equal it looks, and the whole responder becomes
  // a silent no-op - which is what it was, through 14,222 failures, until 2026-10-05. Pinned here
  // in the text as well as at runtime (server-fail-reply-sclang.test.js) because the text is
  // where it is easy to write it back the wrong way round.
  assert.ok(!/#\["/.test(code), 'a String literal array can never match here: includes is identity');
  assert.match(code, /msg\[1\]\.asSymbol/, 'the command name arrives as a Symbol and is compared as one');
});

// --- the server running out of room ------------------------------------------------------------
//
// The failure this family was hiding. scsynth's real-time memory defaulted to 8MB (poptart never
// set it) and a long set exhausted it: `/s_new out of real time memory`, over and over. Past that
// point nothing can be created at all - no note plays, no plugin opens - and it never recovers,
// because nothing hands the memory back.
//
// It was also invisible to everything above, because the reason carries NO node number: nodeFailId
// answers nil and both the repair and the attribution pass it by. And each failed creation still
// consumed a node id, which poptart then wrote to for the life of whatever held it - which is
// where 8576 failed writes to one node came from. This is the cause; those were the symptom.

test('running out of room is reported, loudly and once per reason', (t) => {
  const out = sclangSaid(scratch(), harness(`
40.do { outOfRoom.("/s_new", "out of real time memory") };
outOfRoom.("/s_new", "too many nodes");
`));
  if (out === null) return t.skip('no working SuperCollider here');
  const said = out.match(/OUT OF ROOM[^\n]*/g) ?? [];
  assert.equal(said.length, 2, 'one line per reason - forty identical ones is the noise it replaces');
  assert.match(said[0], /out of real time memory/);
  assert.match(said[0], /Restart the engine/, 'the only answer is a restart, so it has to say so');
  assert.match(said[1], /too many nodes/);
});

test('it is checked before anything goes looking for a node', (t) => {
  // The reason has no number in it, so the node paths cannot help - and if they ran first they
  // would report a nil id and say nothing at all, which is how this stayed invisible.
  const src = fs.readFileSync(SCD, 'utf8');
  const at = src.indexOf('OSCdef(\\poptartServerFail');
  const body = src.slice(at, src.indexOf('}, \'/fail\'', at));
  const room = body.indexOf('outOfRoom.(');
  const node = body.indexOf('nodeGone.(');
  assert.ok(room > 0 && node > 0, 'both branches have to be there');
  assert.ok(room < node, 'the out-of-room check has to come first');
  assert.match(body, /\.containsi\(phrase\)/, 'matched on the reason text, which is all scsynth sends');
});

test('the allocations poptart asks for are its own, not the stock defaults', () => {
  // 8192 KB of real-time memory and a 1024-node table are SuperCollider's defaults, sized for a
  // handful of oscillators. A plugin host with per-event sampler voices is not that, and the
  // failure mode is silent: it stops making sound and says nothing.
  const src = fs.readFileSync(SCD, 'utf8');
  const mem = src.match(/server\.options\.memSize = (\d+);/);
  assert.ok(mem, 'memSize is unset again - scsynth will run on 8MB and a long set will exhaust it');
  assert.ok(Number(mem[1]) >= 65536, `memSize is ${mem[1]}KB, which is not enough headroom for a set`);
  const nodes = src.match(/server\.options\.maxNodes = (\d+);/);
  assert.ok(nodes, 'maxNodes is unset again');
  assert.ok(Number(nodes[1]) > 1024, 'maxNodes is back at the stock default');
});
