// A device that is late by design - a spectral pitch shifter hears a whole analysis window before
// it can answer - has its track's notes played that much early, so what comes out of it lands on
// the beat. The engine says how late each slot is (slotLatencies); the scheduler moves the notes
// and looks that much further ahead, so each one still reaches the engine a full lookahead before
// it is sent to sound.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Scheduler, Transport } from './src/scheduler.mjs';
import { mini } from './src/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function engineWith(latencies, sent) {
  return {
    getTime: () => Date.now() / 1000,
    createTrack() {}, loadInstrument() {}, loadEffect() {}, unloadEffect() {},
    noteOn(tid, note, vel, at) { sent.push({ note, at, sentAt: Date.now() / 1000 }); },
    noteOff() {}, setParam() {},
    ...(latencies ? { slotLatencies: () => latencies } : {}),
  };
}

async function play(latencies) {
  const sent = [];
  const engine = engineWith(latencies, sent);
  const transport = new Transport(engine.getTime, { cps: 0.5, paused: true });
  transport.stop();
  const sig = mini('60 62 64 65');
  sig.instrument = 'X';
  sig.fxChain = ['Shift'];
  sig.channel = {};
  const sch = new Scheduler(engine, { transport, trackId: 't' });
  sch.setPattern(sig);
  // Started ahead of now, as play-from-stop starts it, so the first window is not a catch-up.
  const startSec = engine.getTime() + 0.3;
  transport.start(startSec);
  sch.start(0);
  await sleep(1400);
  sch.stop();
  transport.dispose();
  return { sent, startSec, sch };
}

test('a late device has its track\'s notes played early by exactly its delay', async () => {
  const { sent, startSec } = await play([0, 0.12]);
  assert.ok(sent.length >= 2, `notes played: ${JSON.stringify(sent)}`);
  // One note every half second (four to a two-second cycle), each 0.12 s before its grid slot.
  sent.forEach((e, k) => {
    const grid = startSec + k * 0.5;
    assert.ok(Math.abs(e.at - (grid - 0.12)) < 1e-6, `note ${k}: sent to sound at ${e.at}, its slot is ${grid}`);
  });
});

test('an early note still reaches the engine well before it is due', async () => {
  const { sent } = await play([0, 0.12]);
  for (const e of sent) {
    // A tick is 30 ms, so a note can be found up to that much inside the window; the rest of the
    // lookahead is the lead it travels with.
    assert.ok(e.at - e.sentAt > 0.08, `a note went out only ${((e.at - e.sentAt) * 1000).toFixed(1)} ms before it was due`);
  }
});

test('nothing moves where nothing is late, or where the engine cannot say', async () => {
  for (const latencies of [[0, 0], null]) {
    const { sent, startSec } = await play(latencies);
    sent.forEach((e, k) => assert.ok(Math.abs(e.at - (startSec + k * 0.5)) < 1e-6, `note ${k} moved: ${e.at}`));
  }
});

test('a slot is early by its own delay and that of every slot after it', () => {
  const transport = new Transport(() => 0, { cps: 0.5, paused: true });
  const engine = engineWith([0, 0.12, 0, 0.05], []);
  const sch = new Scheduler(engine, { transport, trackId: 't' });
  // Slot 0 (the instrument, and so every note) is heard through the whole chain; slot 2, after
  // the shifter, only through the 0.05 s device behind it; past the chain, nothing.
  const comp = sch._compensation();
  const want = [0.17, 0.17, 0.05, 0.05, 0];
  comp.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `slot ${i}: ${v}, want ${want[i]}`));
  transport.dispose();
});
