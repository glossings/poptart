'use strict';

// Track creation must not wait on the server's whole async queue (see sc/poptart.scd, where the
// track's /s_new rides along as the /d_recv completion message).
//
// The bug this guards against: `def.add; server.sync;` blocks until every queued async server
// command has finished, and plugin probing is async server work. On a first run with a few
// hundred plugins that is a quarter of an hour in which no track can be created - awaitTrack
// gives up after five seconds, so patterns play nothing, while auditioning (which makes no
// track) works and hides the cause.
//
// Two things are checked, both offline: that the shipped script still compiles, and that the
// class-library methods the fix leans on exist and behave as assumed in the SuperCollider this
// machine actually has. Skips when there is no working sclang (see the sclang notes).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { sclangStatus } = require('./setup');

const SCRIPT = path.join(__dirname, 'sc', 'poptart.scd');
const PORT = '57294'; // its own, so a parallel harness cannot take it - see the sclang notes

function runSclang(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-trackdef-'));
  const file = path.join(dir, 'run.scd');
  fs.writeFileSync(file, code);
  try {
    return execFileSync(sclangStatus().path, ['-u', PORT, file], { encoding: 'utf8', timeout: 90000 });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mark = (out, tag) => out.match(new RegExp(`${tag}<([^>]*)>`))?.[1] ?? null;

test('the track synth is created by the def\'s completion message, not after a server.sync', () => {
  // Read from the shipped script, so this cannot pass against a copy that has drifted.
  const scd = fs.readFileSync(SCRIPT, 'utf8');
  const block = scd.match(/var def = buildTrackDef[\s\S]*?bendTracks\[synth\.nodeID\] = key;/);
  assert.ok(block, 'the track-creation block moved - re-point this test');
  // Comments out: the one above this block names `server.sync` in order to explain why it is gone.
  const code = block[0].replace(/\/\/[^\n]*/g, '');

  assert.match(code, /Synth\.basicNew\(trackDefName/, 'the node id is taken client-side');
  assert.match(code, /def\.add\(nil, synth\.newMsg\(/, 'and the /s_new is the def\'s completion message');
  assert.doesNotMatch(code, /server\.sync/, 'a sync here waits for the plugin scan too');
  assert.doesNotMatch(code, /Synth\(trackDefName/, 'a bare Synth() would send /s_new before the def landed');
});

test('sclang still compiles the engine script', { skip: !sclangStatus().found }, () => {
  const out = runSclang(`("COMPILED<" ++ thisProcess.interpreter.compileFile("${SCRIPT}").notNil ++ ">").postln; 0.exit;`);
  if (!/Welcome to SuperCollider/.test(out)) return; // no usable sclang on this machine
  assert.strictEqual(mark(out, 'COMPILED'), 'true', out.split('\n').slice(-12).join('\n'));
});

test('SynthDef:add passes a completion message through, and Synth:newMsg builds the /s_new', { skip: !sclangStatus().found }, () => {
  // The whole fix rests on these two, so they are asserted against the real class library rather
  // than assumed from the documentation. No server is booted: a SynthDef's completion message is
  // handed to doSend, and newMsg is pure message-building.
  const out = runSclang(`
    var sent = nil, d = SynthDef(\\poptartTrackDefProbe, { Silent.ar });
    var fake = (
      isLocal: true, addr: nil, name: \\fake,
      sendMsg: { |self ...msg| },
      sendBundle: { |self, time ...msgs| },
    );
    ("ADD_TAKES_MSG<" ++ SynthDef.findMethod(\\add).argNames.includesEqual(\\completionMsg) ++ ">").postln;
    ("NEWMSG_EXISTS<" ++ Synth.findMethod(\\newMsg).notNil ++ ">").postln;
    // basicNew asks the server for nothing, so a node id is available before any def is sent.
    ("NODE_ID_IS_CLIENT_SIDE<" ++ Synth.basicNew(\\poptartTrackDefProbe, Server.default).nodeID.isInteger ++ ">").postln;
    // ...and the message it builds is an /s_new naming that node.
    sent = Synth.basicNew(\\poptartTrackDefProbe, Server.default).newMsg(Server.default.defaultGroup, [\\inBus, 7], \\addToTail);
    // 9 is /s_new's command number - scsynth takes either spelling, and this is the one SC's own
    // completion messages use.
    ("MSG_HEAD<" ++ sent[0] ++ ">").postln;
    ("MSG_NAMES_THE_DEF<" ++ sent.includesEqual(\\poptartTrackDefProbe) ++ ">").postln;
    ("MSG_CARRIES_ARGS<" ++ sent.includesEqual(\\inBus) ++ ">").postln;
    0.exit;
  `);
  if (!/Welcome to SuperCollider/.test(out)) return;
  assert.strictEqual(mark(out, 'ADD_TAKES_MSG'), 'true', 'SynthDef:add has no completionMsg argument in this SuperCollider');
  assert.strictEqual(mark(out, 'NEWMSG_EXISTS'), 'true');
  assert.strictEqual(mark(out, 'NODE_ID_IS_CLIENT_SIDE'), 'true');
  assert.strictEqual(mark(out, 'MSG_HEAD'), '9', '9 is /s_new; the message must create a node, not do something else');
  assert.strictEqual(mark(out, 'MSG_NAMES_THE_DEF'), 'true');
  assert.strictEqual(mark(out, 'MSG_CARRIES_ARGS'), 'true');
});
