'use strict';

// Notes and parameter changes land on time even while sclang is busy (direct.js).
//
// A real-time scsynth, booted from a small sclang harness on ports of its own. Every event is played
// twice: a REFERENCE voice, sent straight to scsynth before anything starts, and the voice under
// test, sent a lookahead early the way the scheduler sends it - either the old way (an OSCdef that
// does what bundleNow does) or the direct way (DirectPath, as the engine uses it). Half the events
// have sclang busy for 200ms just before they are sent, longer than the 150ms lookahead. The onset
// difference against the reference is the timing error. A parameter (/n_set onto a synth, as a
// ramp's target is moved) is measured the same way; /n_set lands on a block edge, so it is allowed
// up to a block early and no later.
//
// Needs an audio device, like server-fail-reply-sclang.test.js: skipped (not failed) without one.
// Nothing sounds - the voices write to private buses.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const osc = require('osc');

const { resolveSclangPath } = require('./index.js');
const { DirectPath } = require('./direct');
const { readWavRaw } = require('./wav.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = 57371;
const SCSYNTH_PORT = 57372;
const NODE_PORT = 57373;
const LOOKAHEAD = 0.15; // DEFAULT_LOOKAHEAD_SEC in the scheduler
const BLOCK_SEC = 0.2;
const SPACING = 0.3;
const EVENTS = 40; // ten per condition
const CONDITIONS = ['old', 'old+blocked', 'direct', 'direct+blocked'];
const RECORD_SEC = 0.4 + EVENTS * SPACING + 1;

const sampleDef = () => {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^        SynthDef\(\("poptart_sample_" \+\+ nc\)\.asSymbol, \{[\s\S]*?^        \}\)\.add;$/m);
  assert.ok(m, 'could not find the one-shot sampler SynthDef in sc/poptart.scd');
  return m[0].replace(/\.add;$/, '').replace(/\bnc\b/g, '1');
};

function harness(recPath) {
  return `(
var server, toStereo, sampleDef, dc, rec, nodeAddr = NetAddr("127.0.0.1", ${NODE_PORT});
toStereo = { |sig| sig ! 2 };
sampleDef = ${sampleDef()};
server = Server(\\poptartDirectTiming, NetAddr("127.0.0.1", ${SCSYNTH_PORT}));
server.options.numInputBusChannels = 0;
server.options.numOutputBusChannels = 2;
server.options.outputStreamsEnabled = "0"; // tests never play through the speakers
server.options.blockSize = 256;
server.options.memSize = 65536;
fork { 120.wait; "FAILSAFE".postln; server.quit; 0.exit };
server.waitForBoot {
    sampleDef.add;
    // ch 0-1 the voice under test, 2-3 the reference, 4 the parameter
    SynthDef(\\poptart_timing_rec, { |buf| RecordBuf.ar(In.ar(64, 5), buf, loop: 0, doneAction: 2) }).add;
    SynthDef(\\poptart_timing_param, { |target = 0| Out.ar(68, Select.ar(target > 0.5, [DC.ar(0), DC.ar(1)])) }).add;
    dc = Buffer.alloc(server, 48000, 1);
    rec = Buffer.alloc(server, (server.sampleRate * ${RECORD_SEC}).asInteger, 5);
    server.sync;
    dc.fill(0, 48000, 1);
    server.sync;
    // The old path: what bundleNow does with a note's latency.
    OSCdef(\\old, { |msg|
        var lat = msg[1].asFloat;
        server.makeBundle(if (lat > 0.001) { lat } { nil }, { Synth(sampleDef.name, msg.copyToEnd(2), server, \\addToHead) });
    }, '/t/old');
    OSCdef(\\oldSet, { |msg|
        var lat = msg[1].asFloat;
        server.makeBundle(if (lat > 0.001) { lat } { nil }, { server.sendMsg(\\n_set, msg[2].asInteger, \\target, msg[3].asFloat) });
    }, '/t/oldSet');
    OSCdef(\\block, { |msg| var t = Main.elapsedTime; while { (Main.elapsedTime - t) < msg[1] } { } }, '/t/block');
    OSCdef(\\done, {
        fork {
            rec.write(${JSON.stringify(recPath)}, "wav", "float");
            server.sync;
            nodeAddr.sendMsg('/t/written');
            0.2.wait;
            server.quit;
            0.5.wait;
            0.exit;
        };
    }, '/t/done');
    ("READY<" ++ server.pid ++ ">").postln;
    nodeAddr.sendMsg('/t/ready', server.sampleRate, dc.bufnum, rec.bufnum, server.clientID);
};
)
`;
}

const enc = (p) => osc.writePacket(p, { metadata: true });
const typed = (v) => (typeof v === 'string' ? { type: 's', value: v } : Number.isInteger(v) ? { type: 'i', value: v } : { type: 'f', value: v });

test('notes and parameter changes land on their sample with sclang busy, and did not before', { timeout: 180000 }, async (t) => {
  const sclang = resolveSclangPath();
  if (!fs.existsSync(sclang)) return t.skip('no sclang here');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-direct-timing-'));
  const recPath = path.join(dir, 'rec.wav');
  fs.writeFileSync(path.join(dir, 'harness.scd'), harness(recPath));
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(NODE_PORT, '127.0.0.1', r));
  const waiters = new Map();
  sock.on('message', (buf) => {
    const m = osc.readPacket(buf, {});
    waiters.get(m.address)?.(m.args);
  });
  const waitFor = (address, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${address} in ${ms}ms`)), ms);
    waiters.set(address, (args) => { clearTimeout(timer); resolve(args); });
  });
  const toLang = (address, args) => sock.send(enc({ address, args: args.map(typed) }), LANG_PORT, '127.0.0.1');
  const toServer = (bytes) => sock.send(bytes, SCSYNTH_PORT, '127.0.0.1');
  let out = '';
  let scsynthPid = null;
  const child = spawn(sclang, ['-u', String(LANG_PORT), path.join(dir, 'harness.scd')], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => {
    out += d;
    const m = String(out).match(/READY<(\d+)>/);
    if (m) scsynthPid = Number(m[1]);
  });
  child.stderr.on('data', (d) => { out += d; });
  const now = () => Date.now() / 1000;
  const d = new DirectPath({ sendRaw: toServer, tell: () => {}, now });
  try {
    let ready;
    try {
      ready = await waitFor('/t/ready', 60000);
    } catch {
      return t.skip(`no real-time server here: ${out.trim().split('\n').slice(-2).join(' | ')}`);
    }
    const [sr, dcBuf, recBuf, clientID] = ready;
    const block = clientID === 31 ? 30 : 31;
    // What sclang tells the engine (see tellTrack in sc/poptart.scd): two "tracks" on the default group.
    d.handle({ address: '/poptart/ids/server', args: [SCSYNTH_PORT, block * 2 ** 26 + 1000, block * 2 ** 26 + 0x03FFFFFF, sr, 0, 80] });
    d.handle({ address: '/poptart/ids/track', args: ['test', 1, 1, 64, 0, 0] });
    d.handle({ address: '/poptart/ids/track', args: ['ref', 1, 1, 66, 0, 0] });

    const T0 = now() + 0.8;
    const recNode = d._allocNode();
    const paramNode = d._allocNode();
    d._sendAt(T0, [
      { address: '/s_new', args: [typed('poptart_timing_param'), typed(paramNode), typed(1), typed(1)] },
      { address: '/s_new', args: [typed('poptart_timing_rec'), typed(recNode), typed(1), typed(1), typed('buf'), typed(recBuf)] },
    ]);
    d.handle({ address: '/poptart/ids/ramp', args: ['test', 'slot0_x', paramNode, 0, 1] });
    const voice = (onsetSec) => ({
      bufnum: dcBuf, channels: 1, begin: 0, end: 1, loop: 0, rate: 1, stretch: 1, dur: 0.03,
      onsetSec, offsetSec: onsetSec + 0.03, amp: 1, cut: 0, atk: 0, dec: 0, sus: 1, rel: 0.005,
    });
    const times = Array.from({ length: EVENTS }, (_, k) => T0 + 0.4 + k * SPACING + Math.random() * (256 / sr));
    // Every reference, up front: nothing at event time can move them.
    for (const tk of times) d.playSample('ref', voice(tk));
    await Promise.all(times.map((tk, k) => new Promise((resolve) => {
      setTimeout(() => {
        const cond = CONDITIONS[k % 4];
        if (cond.endsWith('blocked')) toLang('/t/block', [BLOCK_SEC]);
        const value = k % 2 === 0 ? 1 : 0;
        if (cond.startsWith('direct')) {
          d.playSample('test', voice(tk));
          d.setParam('test', 0, 'x', value, tk);
        } else {
          const lat = Math.max(0, tk - now());
          toLang('/t/old', [lat, 'out', 64, 'buf', dcBuf, 'begin', 0.0, 'end', 1.0, 'rate', 1.0, 'dur', 0.03, 'gate', 1,
            'amp', 1.0, 'atk', 0.0, 'dec', 0.0, 'sus', 1.0, 'rel', 0.005, 'bend', 'c0']);
          toLang('/t/oldSet', [lat, paramNode, value]);
        }
        resolve();
      }, (tk - LOOKAHEAD - now()) * 1000);
    })));
    await new Promise((r) => setTimeout(r, (times.at(-1) - now() + 0.8) * 1000));
    toLang('/t/done', []);
    await waitFor('/t/written', 30000);

    const r = readWavRaw(recPath);
    assert.ok(r, 'unreadable recording');
    const frames = r.data.length / r.channels;
    const at = (ch, i) => r.data[i * r.channels + ch];
    const firstAbove = (ch, from, to, thr) => {
      for (let i = Math.max(0, from); i < Math.min(frames, to); i++) if (Math.abs(at(ch, i)) > thr) return i;
      return -1;
    };
    const edge = (from, to, rising) => {
      for (let i = Math.max(1, from); i < Math.min(frames, to); i++) if ((at(4, i) > 0.5) === rising && (at(4, i - 1) > 0.5) !== rising) return i;
      return -1;
    };
    const stats = Object.fromEntries(CONDITIONS.map((c) => [c, { voice: [], param: [] }]));
    times.forEach((tk, k) => {
      const approx = Math.round((tk - T0) * sr);
      const ref = firstAbove(2, approx - 4096, approx + 4096, 1e-6);
      assert.ok(ref >= 0, `reference voice ${k} never sounded`);
      const got = firstAbove(0, ref - 2048, ref + Math.round((SPACING - 0.02) * sr), 1e-6);
      assert.ok(got >= 0, `voice ${k} never sounded`);
      const step = edge(ref - 2048, ref + Math.round((SPACING - 0.02) * sr), k % 2 === 0);
      assert.ok(step >= 0, `parameter change ${k} never landed`);
      const s = stats[CONDITIONS[k % 4]];
      s.voice.push(got - ref);
      s.param.push(step - (ref - 1)); // the reference's first sounding sample is one past its time
    });
    const ms = (x) => ((x / sr) * 1000).toFixed(2);
    for (const [c, s] of Object.entries(stats)) {
      const span = (xs) => `min ${ms(Math.min(...xs))} / mean ${ms(xs.reduce((a, b) => a + b, 0) / xs.length)} / max ${ms(Math.max(...xs))} ms`;
      t.diagnostic(`${c.padEnd(15)} voice: ${span(s.voice)}   param: ${span(s.param)}`);
    }
    for (const c of ['direct', 'direct+blocked']) {
      assert.deepStrictEqual(stats[c].voice, stats[c].voice.map(() => 0), `${c}: voices off their sample by ${stats[c].voice.join(', ')}`);
      for (const e of stats[c].param) assert.ok(e <= 0 && e > -256, `${c}: a parameter landed ${e} samples from its block`);
    }
    // ...and the busy sclang really did make the old path late, or this measured nothing.
    assert.ok(Math.min(...stats['old+blocked'].voice) > 0.02 * sr, 'a blocked sclang did not delay the old path - the harness is not blocking it');
  } finally {
    sock.close();
    d.stop();
    if (child.exitCode === null) child.kill('SIGKILL');
    if (scsynthPid) try { process.kill(scsynthPid, 'SIGKILL'); } catch { /* gone already */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
