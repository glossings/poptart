// DeckClock - a deck's own clock riding the shared one (see scheduler.mjs). What is asserted:
// synced it reads exactly what the room reads through every move the room makes; a bend moves its
// place and the place stays moved; a jog steps it and announces itself; unsynced it keeps its own
// tempo while the room does what it likes; and Scheduler#relocate carries a window across a jog.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Transport, DeckClock, Scheduler } from './src/scheduler.mjs';

function rig({ cps = 0.5 } = {}) {
  let t = 100;
  const room = new Transport(() => t, { cps, paused: true });
  const deck = new DeckClock(room);
  return { room, deck, advance: (dt) => { t += dt; }, now: () => t };
}
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

test('a synced deck clock reads what the room reads, through starts, tempo moves and shifts', () => {
  const { room, deck, advance, now } = rig();
  assert.equal(deck.paused, true);
  room.start(now() + 0.15); // a start a lookahead ahead, as play-from-stop makes it
  assert.equal(deck.paused, false);
  advance(2);
  assert.equal(deck.cycleAt(now()), room.cycleAt(now()));
  room.setCps(0.6);
  advance(1);
  room.shiftCycles(0.01);
  advance(1);
  room.startAt(now(), 12.5); // a rebase of a running clock
  advance(1);
  assert.equal(deck.cps, room.cps);
  near(deck.cycleAt(now()), room.cycleAt(now()), 'position');
  assert.equal(deck.deviates, false);
  room.stop();
  assert.equal(deck.paused, true);
  assert.equal(deck.cycleAt(now()), 0);
  deck.dispose();
});

test('a bend runs the deck fast while held, and the place it gained stays', () => {
  const { room, deck, advance, now } = rig();
  room.start();
  deck.setBend(0.04);
  near(deck.cps, room.cps * 1.04, 'bent tempo');
  advance(1);
  deck.setBend(0);
  assert.equal(deck.cps, room.cps);
  near(deck.offset, 0.5 * 0.04, 'gained');
  advance(10);
  room.setCps(0.7); // the room moving takes the deck with it, offset and all
  advance(10);
  near(deck.offset, 0.5 * 0.04, 'kept');
  assert.equal(deck.deviates, true);
  deck.align();
  assert.equal(deck.deviates, false);
  deck.dispose();
});

test('a jog steps the deck alone and announces a rebase', () => {
  const { room, deck, advance, now } = rig();
  const kinds = [];
  deck.onStateChange = (k) => kinds.push(k);
  deck.jog(0.25); // paused: no place to move
  room.start();
  advance(3);
  const roomAt = room.cycleAt(now());
  deck.jog(0.25);
  deck.jog(-0.5);
  assert.equal(room.cycleAt(now()), roomAt);
  near(deck.offset, -0.25, 'offset');
  assert.deepEqual(kinds, ['rebase', 'rebase']);
  deck.dispose();
});

test('unsynced, the deck keeps its own tempo - setbpm times the fader - and the room passes it by', () => {
  const { room, deck, advance, now } = rig();
  let told = 0;
  deck.onCpsChange = () => { told++; };
  deck.setFreeBpm(140);
  deck.setFreeMult(1.03);
  assert.equal(deck.cps, room.cps, 'synced: its own tempo only waits');
  room.start();
  deck.setSync(false);
  near(deck.cps * 240, 140 * 1.03, 'own tempo');
  advance(4);
  const before = deck.cycleAt(now());
  told = 0;
  room.setCps(0.8);
  room.shiftCycles(0.3);
  assert.equal(told, 0);
  assert.equal(deck.cycleAt(now()), before);
  near(deck.cps * 240, 140 * 1.03, 'still its own');
  deck.setSync(true); // only the tempo changes hands: nothing jumps
  near(deck.cycleAt(now()), before, 'no jump');
  assert.equal(deck.cps, 0.8);
  deck.dispose();
});

test('the room moving a synced deck does not announce twice: the room speaks for both', () => {
  const { room, deck } = rig();
  let told = 0;
  deck.onCpsChange = () => { told++; };
  room.setCps(0.6);
  assert.equal(deck.cps, 0.6);
  assert.equal(told, 0);
  deck.setBend(0.04); // its own move is its own to announce
  assert.equal(told, 1);
  deck.dispose();
});

test('a deck starting under a running room at another tempo comes in on the room\'s place', () => {
  const { room, deck, advance, now } = rig();
  room.start();
  deck.setFreeBpm(90);
  deck.setSync(false);
  advance(7);
  assert.notEqual(deck.cycleAt(now()), room.cycleAt(now()));
  deck.align();
  near(deck.cycleAt(now()), room.cycleAt(now()), 'aligned');
  near(deck.cps * 240, 90, 'tempo untouched');
  deck.dispose();
});

test('a signal tempo is sampled on the deck\'s own cycles', () => {
  const { room, deck } = rig();
  const seen = [];
  deck.setSync(false);
  deck.setFreeBpm({ sample: (sec, cps, cycle) => { seen.push(cycle); return 150; } });
  near(deck.cps * 240, 150, 'tempo');
  assert.equal(seen.length, 1);
  deck.dispose(); // and the poll goes with it
  assert.equal(room._followers.size, 0);
});

test('Scheduler#relocate carries the window across a jog, both ways', () => {
  const { room, deck, now } = rig();
  const engine = { getTime: now };
  const sch = new Scheduler(engine, { transport: deck, trackId: '#1' });
  sch.relocate(0.25); // stopped: nothing to carry
  assert.equal(sch._scheduledUntilCycle, 0);
  room.start();
  sch.start(4);
  sch.relocate(0.25);
  assert.equal(sch._scheduledUntilCycle, 4.25);
  sch.relocate(-0.5);
  assert.equal(sch._scheduledUntilCycle, 3.75);
  sch.stop();
  deck.dispose();
});
