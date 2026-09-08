'use strict';

// Unit tests for the track->track MIDI fan-out (the midi("track") head source and the
// .fx(...).midi("track") injector). No engine boot: the OSC sends are captured and the pack
// registry pre-seeded, as in play-sample.test.js.

const { test } = require('node:test');
const assert = require('node:assert');

const { OscEngine } = require('./index.js');

function engine() {
  const e = new OscEngine({ sclangPath: '/usr/bin/false' });
  e.getTime = () => 0; // latencies come out as the raw event times
  e._packs.set('bd', { status: 'ready', files: [{ path: 'bd/a.wav', duration: 0.4, channels: 2 }] });
  const sent = [];
  e._send = (addr, args) => sent.push({ addr, args });
  return { e, sent };
}

const notes = (sent) => sent.filter((m) => m.addr.startsWith('/poptart/note')).map((m) => [m.addr, ...m.args]);

test('a sampler source routes its rhythm, with the off pulled before the next onset', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'kick');
  // Four abutting quarter-note events, as pianoroll("kick").s("bd") makes at 2s/cycle.
  for (let i = 0; i < 4; i++) e.playSample('kick', 'bd', { vel: 0.8, secPerCycle: 2 }, i * 0.5, (i + 1) * 0.5);

  const routed = notes(sent);
  assert.strictEqual(routed.filter(([addr]) => addr === '/poptart/noteOn').length, 4, 'every sample event fires');
  for (let i = 0; i < 4; i++) {
    const [onAddr, , , vel, onLat] = routed[i * 2];
    const [offAddr, , , offLat] = routed[i * 2 + 1];
    assert.strictEqual(onAddr, '/poptart/noteOn');
    assert.strictEqual(offAddr, '/poptart/noteOff');
    assert.strictEqual(vel, 0.8);
    assert.strictEqual(onLat, i * 0.5);
    assert.ok(offLat < (i + 1) * 0.5, `event ${i}: off ${offLat} lands before the next onset`);
    assert.ok(offLat > onLat, `event ${i}: off stays after its own on`);
  }
});

test('a very short sample event still gets a note with positive length', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'kick');
  e.playSample('kick', 'bd', { vel: 1, secPerCycle: 2 }, 1, 1.0005);
  const [[, , , , onLat], [, , , offLat]] = [notes(sent)[0], notes(sent)[1]];
  assert.ok(offLat > onLat, `off ${offLat} stays after on ${onLat}`);
});

test('an injector route reaches its slot on the same edges', () => {
  const { e, sent } = engine();
  e.injectMidi('bass', 2, 'kick');
  e.playSample('kick', 'bd', { vel: 0.5, secPerCycle: 2 }, 0, 0.5);
  const routed = notes(sent);
  assert.deepStrictEqual(routed.map(([addr]) => addr), ['/poptart/noteOnSlot', '/poptart/noteOffSlot']);
  assert.strictEqual(routed[0][2], 2, 'the slot travels with it');
  assert.ok(routed[1][4] < 0.5, 'the slot off is pulled early too');
});

test('a synth source fans out the pitch it played', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'lead');
  e.noteOn('lead', 64, 0.7, 0.25);
  e.noteOff('lead', 64, 0.5);
  const routed = notes(sent).filter(([, id]) => id === 'sub');
  assert.deepStrictEqual(routed, [
    ['/poptart/noteOn', 'sub', 64, 0.7, 0.25],
    ['/poptart/noteOff', 'sub', 64, 0.5],
  ]);
});

test('the sample event\'s own pitch is what the route plays', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'kick');
  // pianoroll("kick").s("bd") with a melodic line: the drawn pitch rides as cfg.note.
  for (const [i, n] of [60, 63, 67].entries()) {
    e.playSample('kick', 'bd', { vel: 1, note: n, secPerCycle: 2 }, i * 0.5, i * 0.5 + 0.25);
  }
  assert.deepStrictEqual(notes(sent).filter(([addr]) => addr === '/poptart/noteOn').map(([, , n]) => n), [60, 63, 67]);
});

test('a drum event - no pitch of its own - still routes as 60', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'kick');
  e.playSample('kick', 'bd', { vel: 1, secPerCycle: 2 }, 0, 0.25);
  assert.strictEqual(notes(sent)[0][2], 60);
});

test('a fractional repitch rounds to the nearest note MIDI can carry', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'kick');
  e.playSample('kick', 'bd', { vel: 1, note: 62.7, secPerCycle: 2 }, 0, 0.25);
  e.playSample('kick', 'bd', { vel: 1, note: 900, secPerCycle: 2 }, 0.5, 0.75);
  assert.deepStrictEqual(notes(sent).filter(([addr]) => addr === '/poptart/noteOn').map(([, , n]) => n), [63, 127]);
});

test("an injector's explicit note outranks the event's pitch", () => {
  const { e, sent } = engine();
  e.injectMidi('bass', 1, 'kick', 36);
  e.playSample('kick', 'bd', { vel: 1, note: 67, secPerCycle: 2 }, 0, 0.25);
  assert.strictEqual(notes(sent)[0][3], 36);
});

test('an injector with no { note } follows the source event\'s pitch too', () => {
  const { e, sent } = engine();
  e.injectMidi('bass', 1, 'kick');
  e.playSample('kick', 'bd', { vel: 1, note: 67, secPerCycle: 2 }, 0, 0.25);
  e.playSample('kick', 'bd', { vel: 1, secPerCycle: 2 }, 0.5, 0.75); // no pitch -> the ducker note
  assert.deepStrictEqual(
    notes(sent).filter(([addr]) => addr === '/poptart/noteOnSlot').map(([, , , n]) => n),
    [67, 60],
  );
});

test('a transposed source plays the shifted pitch on both edges', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'kick', 0, null, null, -24); // midi("kick").sub(note(24))
  e.playSample('kick', 'bd', { vel: 1, note: 60, secPerCycle: 2 }, 0, 0.25);
  assert.deepStrictEqual(notes(sent).map(([addr, , n]) => [addr, n]), [
    ['/poptart/noteOn', 36],
    ['/poptart/noteOff', 36],
  ]);
});

test('a transpose off the ends of the keyboard clips instead of wrapping', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'kick', 0, null, null, -80);
  e.playSample('kick', 'bd', { vel: 1, note: 36, secPerCycle: 2 }, 0, 0.25);
  assert.strictEqual(notes(sent)[0][2], 0);
});

test('a synth source is transposed the same way', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'lead', 0, null, null, 12);
  e.noteOn('lead', 60, 1, 0);
  e.noteOff('lead', 60, 0.5);
  assert.deepStrictEqual(notes(sent).filter(([, id]) => id === 'sub').map(([, , n]) => n), [72, 72]);
});

test('.scale() on a TRACK source quantizes the routed notes, as it does on a device', () => {
  const { e, sent } = engine();
  const cMinor = [0, 2, 3, 5, 7, 8, 10];
  e.setInputSource('sub', 'midi', 'lead', 0, cMinor);
  for (const n of [61, 64, 66]) { // c#, e, f# -> nearest minor degree, ties downward
    e.noteOn('lead', n, 1, 0);
  }
  assert.deepStrictEqual(notes(sent).filter(([, id]) => id === 'sub').map(([, , n]) => n), [60, 63, 65]);
});

test('transpose happens before the scale, so the scale has the last word', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'lead', 0, [0, 2, 3, 5, 7, 8, 10], null, -13);
  e.noteOn('lead', 60, 1, 0); // 60 - 13 = 47 (b) -> nearest c-minor degree below is 46 (a#)
  assert.strictEqual(notes(sent).filter(([, id]) => id === 'sub')[0][2], 46);
});

test('an injector route is untouched by either - it carries neither', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'kick', 0, null, null, -24);
  e.injectMidi('bass', 1, 'kick');
  e.playSample('kick', 'bd', { vel: 1, note: 60, secPerCycle: 2 }, 0, 0.25);
  assert.strictEqual(notes(sent).find(([addr]) => addr === '/poptart/noteOnSlot')[3], 60);
});

// --- dynamic pitch-op routes (noteMap) ---

test('a noteMap route samples the map at each note time', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'lead', 0, null, null, 0, (n, sec) => n + (sec < 0.5 ? 0 : 7));
  e.noteOn('lead', 60, 1, 0.25);
  e.noteOff('lead', 60, 0.4);
  e.noteOn('lead', 60, 0.75);
  e.noteOff('lead', 60, 0.9);
  assert.deepStrictEqual(
    notes(sent).filter(([, id]) => id === 'sub').map(([addr, , n]) => [addr.slice(9), n]),
    [['noteOn', 60], ['noteOff', 60], ['noteOn', 67], ['noteOff', 67]],
  );
});

test('a note-off releases the pitch its ON played, even if the map has moved on', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'lead', 0, null, null, 0, (n, sec) => n + Math.floor(sec * 12));
  e.noteOn('lead', 60, 1, 0.2); // maps to 62
  e.noteOff('lead', 60, 0.9); // a fresh mapping HERE would say 70 - and hang the 62
  const routed = notes(sent).filter(([, id]) => id === 'sub');
  assert.deepStrictEqual(routed.map(([addr, , n]) => [addr.slice(9), n]), [['noteOn', 62], ['noteOff', 62]]);
});

test('a map returning null silences the note - and its off is silent too, not a stray release', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'lead', 0, null, null, 0, (n, sec) => (sec < 0.5 ? n : null));
  e.noteOn('lead', 60, 1, 0.25);
  e.noteOff('lead', 60, 0.4);
  e.noteOn('lead', 60, 0.75); // rested
  e.noteOff('lead', 60, 0.9);
  assert.strictEqual(notes(sent).filter(([, id]) => id === 'sub').length, 2, 'one on/off pair, nothing for the rest');
});

test('a sampler source runs the map on its event pitch', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'kick', 0, null, null, 0, (n, sec) => n - 24);
  e.playSample('kick', 'bd', { vel: 1, note: 60, secPerCycle: 2 }, 0, 0.25);
  assert.deepStrictEqual(notes(sent).map(([, , n]) => n), [36, 36]);
});

test('tearing a route down releases what it still holds', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'lead', 0, null, null, 0, (n) => n + 5);
  e.noteOn('lead', 60, 1, 0.1);
  e.clearInputSource('sub');
  const offs = notes(sent).filter(([addr]) => addr === '/poptart/noteOff');
  assert.deepStrictEqual(offs.map(([, id, n]) => [id, n]), [['sub', 65]], 'the held mapped note is released');
});

// --- defer mode: a hardware device with a dynamic map loops through Node ---

function noteInMsg(track, note, vel, on) {
  return { address: '/poptart/midiNoteIn', args: [{ value: track }, { value: note }, { value: vel }, { value: on }] };
}

test('a dynamic device route defers: raw midiRoute to sclang, notes answered from Node', () => {
  const { e, sent } = engine();
  const seen = [];
  e.onMidiNoteIn = (track, note, vel, on) => seen.push([track, note, on]);
  e.setInputSource('sub', 'midi', 'dev:KeyStep', 0, null, null, 0, (n) => n + 7);

  const route = sent.find((m) => m.addr === '/poptart/midiRoute');
  assert.strictEqual(route.args[5], 1, 'defer flag set');
  assert.strictEqual(route.args[3], '', 'no static scale - Node owns the chain');

  e._handleMessage(noteInMsg('sub', 60, 0.8, 1));
  e._handleMessage(noteInMsg('sub', 60, 0.8, 0));
  const routed = notes(sent);
  assert.deepStrictEqual(routed.map(([addr, , n]) => [addr.slice(9), n]), [['noteOn', 67], ['noteOff', 67]]);
  assert.deepStrictEqual(seen, [['sub', 67, true], ['sub', 67, false]], 'record hears the note as it sounds');
});

test('a STATIC device route does not defer - it keeps the direct sclang path', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'dev:KeyStep', 0, [0, 3, 7], null, -12);
  const route = sent.find((m) => m.addr === '/poptart/midiRoute');
  assert.strictEqual(route.args[5], 0, 'no defer');
  assert.strictEqual(route.args[4], -12, 'transpose rides to sclang');
  assert.strictEqual(route.args[3], '0,3,7');
  // and an incoming note edge passes through to observers untouched
  const seen = [];
  e.onMidiNoteIn = (t, n, v, on) => seen.push(n);
  e._handleMessage(noteInMsg('sub', 48, 0.5, 1));
  assert.deepStrictEqual(seen, [48]);
  assert.strictEqual(notes(sent).length, 0, 'Node answers nothing - sclang already played it');
});

test('clearing a deferred route releases its held notes', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'dev:KeyStep', 0, null, null, 0, (n) => n + 7);
  e._handleMessage(noteInMsg('sub', 60, 0.8, 1));
  e.clearInputSource('sub');
  const offs = notes(sent).filter(([addr]) => addr === '/poptart/noteOff');
  assert.deepStrictEqual(offs.map(([, id, n]) => [id, n]), [['sub', 67]]);
});

test('re-evaling a deferred route keeps sounding notes resolvable', () => {
  const { e, sent } = engine();
  e.setInputSource('sub', 'midi', 'dev:KeyStep', 0, null, null, 0, (n) => n + 7);
  e._handleMessage(noteInMsg('sub', 60, 0.8, 1)); // sounds as 67
  e.setInputSource('sub', 'midi', 'dev:KeyStep', 0, null, null, 0, (n) => n + 2); // re-eval, new map
  e._handleMessage(noteInMsg('sub', 60, 0.8, 0)); // the off still finds 67
  const offs = notes(sent).filter(([addr]) => addr === '/poptart/noteOff');
  assert.deepStrictEqual(offs.map(([, , n]) => n), [67]);
});
