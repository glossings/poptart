// A fractional note is a microtone: the scheduler hands it to the engine as written, and only an
// engine that speaks MIDI rounds it (see the OSC engine's noteOn).

import test from 'node:test';
import assert from 'node:assert/strict';

import { note } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

function notesOf(sig) {
  const ons = [];
  const offs = [];
  const base = {
    getTime: () => 0,
    noteOn: (trackId, midi) => ons.push(midi),
    noteOff: (trackId, midi) => offs.push(midi),
  };
  const engine = new Proxy(base, { get: (t, p) => (p in t ? t[p] : () => {}) });
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(sig);
  sch._scheduleNoteEdges(0, 1, 0);
  return { ons, offs };
}

test('a fractional note reaches the engine unrounded, and its off names the same pitch', () => {
  const { ons, offs } = notesOf(note('47.5 60 60.25'));
  assert.deepEqual(ons, [47.5, 60, 60.25]);
  assert.deepEqual(offs, ons);
});

test('arithmetic on a note keeps its fraction', () => {
  const { ons } = notesOf(note('60 62').add(0.5));
  assert.deepEqual(ons, [60.5, 62.5]);
});
