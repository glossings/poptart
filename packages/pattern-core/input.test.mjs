// The input() hardware-audio-input source: channel parsing, device-relative resolution against
// the booted device's layout, and what the Scheduler forwards to the engine. The SoundIn feeder
// itself lives in SuperCollider (sc/poptart.scd) and is covered by a manual checklist; here we pin
// the pure logic and the engine calls.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, synth, input, setPatternWarn } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';
import { setAudioInputLayout, audioInputChannelCount, resolveInputChannels } from './src/audio-inputs.mjs';
import { injectLocations } from './src/locations.mjs';

function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const callsTo = (method) => calls.filter((c) => c.method === method);
  return { engine, callsTo };
}

// Collects warnings emitted while `fn` runs, so "warn, don't block sound" is actually asserted
// rather than leaking to the console.
function captureWarnings(fn) {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  try {
    fn();
  } finally {
    setPatternWarn(null);
  }
  return lines;
}

const SCARLETT = { name: 'Scarlett 6i6 USB', inChannels: 6 };
const BUILTIN = { name: 'MacBook Pro Microphone', inChannels: 1 };

test('input() defaults to channels 1 and 2', () => {
  assert.deepEqual(input().inputSource, { io: 'audio', name: 'dev:', hw: { device: null, chans: [1, 2] } });
});

test('input(n) is mono, input(a, b) a stereo pair - stored 1-indexed, as written', () => {
  assert.deepEqual(input(3).inputSource.hw, { device: null, chans: [3] });
  assert.deepEqual(input(5, 6).inputSource.hw, { device: null, chans: [5, 6] });
});

test('input() accepts a non-adjacent pair', () => {
  assert.deepEqual(input(1, 5).inputSource.hw, { device: null, chans: [1, 5] });
});

test('input("device", ...) carries the device name, with and without channels', () => {
  assert.deepEqual(input('Scarlett', 1).inputSource.hw, { device: 'Scarlett', chans: [1] });
  assert.deepEqual(input('Scarlett').inputSource.hw, { device: 'Scarlett', chans: [1, 2] });
  assert.equal(input('Scarlett', 1).inputSource.name, 'dev:Scarlett');
});

test('input() rejects what it cannot wire', () => {
  assert.throws(() => input(0), /numbers from 1/);
  assert.throws(() => input(-2), /numbers from 1/);
  assert.throws(() => input('Scarlett', 1, 2, 3), /at most two channels/);
  assert.throws(() => input(''), /can't be empty/);
});

// --- resolution against the device layout ---

test('absolute channels resolve to 0-indexed, mono flagged with -1', () => {
  setAudioInputLayout([SCARLETT]);
  assert.deepEqual(resolveInputChannels({ device: null, chans: [1] }).chans, [0, -1]);
  assert.deepEqual(resolveInputChannels({ device: null, chans: [3, 4] }).chans, [2, 3]);
});

test('a device name offsets by the channels of everything before it in the layout', () => {
  setAudioInputLayout([BUILTIN, SCARLETT]); // builtin owns channel 1, Scarlett channels 2..7
  assert.equal(audioInputChannelCount(), 7);
  const { chans, warning } = resolveInputChannels({ device: 'Scarlett', chans: [1, 2] });
  assert.deepEqual(chans, [1, 2], 'Scarlett channel 1 is absolute channel 2 (0-indexed: 1)');
  assert.equal(warning, null);
  assert.deepEqual(resolveInputChannels({ device: 'MacBook', chans: [1] }).chans, [0, -1]);
});

test('device matching is a case-insensitive substring, like MIDI device names', () => {
  setAudioInputLayout([BUILTIN, SCARLETT]);
  assert.deepEqual(resolveInputChannels({ device: 'scarlett', chans: [1] }).chans, [1, -1]);
  assert.deepEqual(resolveInputChannels({ device: '6i6', chans: [1] }).chans, [1, -1]);
});

test('an unknown device warns and falls back to absolute rather than going silent', () => {
  setAudioInputLayout([SCARLETT]);
  const { chans, warning } = resolveInputChannels({ device: 'Behringer', chans: [2] });
  assert.deepEqual(chans, [1, -1], 'still playable - treated as absolute channel 2');
  assert.match(warning, /no audio input device matching "Behringer"/);
  assert.match(warning, /Scarlett 6i6 USB/, 'names what IS available');
});

test('a channel past the named device warns without stopping playback', () => {
  setAudioInputLayout([BUILTIN, SCARLETT]);
  const { chans, warning } = resolveInputChannels({ device: 'MacBook', chans: [2] });
  assert.match(warning, /has 1 input channel/);
  assert.deepEqual(chans, [1, -1], 'a resolved channel is still produced');
});

test('a channel past the whole device warns', () => {
  setAudioInputLayout([SCARLETT]);
  const { warning } = resolveInputChannels({ device: null, chans: [9] });
  assert.match(warning, /6 channels/);
});

test('with no layout yet, absolute channels work silently and a name warns', () => {
  setAudioInputLayout([]);
  const abs = resolveInputChannels({ device: null, chans: [3] });
  assert.equal(abs.warning, null, 'absolute numbering needs no layout');
  assert.deepEqual(abs.chans, [2, -1]);
  assert.match(resolveInputChannels({ device: 'Scarlett', chans: [1] }).warning, /no audio device layout yet/);
});

// --- what reaches the engine ---

test('scheduler sends resolved absolute channels as the head source', () => {
  setAudioInputLayout([BUILTIN, SCARLETT]);
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'gtr' });
  sch.setPattern(input('Scarlett', 1).fx('ValhallaRoom'));

  const sent = callsTo('setInputSource');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, ['gtr', 'audio', 'dev:Scarlett', 0, null, [1, -1]]);
});

test('a legacy audio("dev:...") string still defaults to channels 1+2', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'gtr' });
  sch.setPattern(note('c2*4').synth('Serum 2'));
  const [call] = callsTo('setInputSource');
  assert.equal(call, undefined, 'an ordinary pattern routes no input');
});

test('.audio(input(n)) sidechains a live input into a plugin', () => {
  setAudioInputLayout([SCARLETT]);
  const sig = note('c2*8').synth('Serum 2').fx('Pro-C 2').audio(input(1));
  assert.deepEqual(sig.audioInjects, [{ slot: 1, name: 'dev:', hw: { device: null, chans: [1] }, gain: 1 }]);

  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(sig);
  assert.deepEqual(callsTo('injectAudio')[0].args, ['bass', 1, 'dev:', 1, [0, -1]]);
});

test('.audio() still takes a plain track name, with no channels', () => {
  const sig = note('c2*8').synth('Serum 2').fx('Pro-C 2').audio('kick');
  assert.deepEqual(sig.audioInjects, [{ slot: 1, name: 'kick', gain: 1 }]);

  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(sig);
  assert.deepEqual(callsTo('injectAudio')[0].args, ['bass', 1, 'kick', 1, null]);
});

test('.audio() rejects a midi() source', () => {
  assert.throws(() => synth('Serum 2').fx('Pro-C 2').audio(note('c2')), /source name/);
});

test('the scheduler warns once per eval, and keeps the track playing', () => {
  setAudioInputLayout([SCARLETT]);
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'gtr' });
  const lines = captureWarnings(() => sch.setPattern(input('Nonexistent', 1).fx('ValhallaRoom')));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no audio input device matching/);
  assert.equal(callsTo('setInputSource').length, 1, 'still routed - a warning never blocks sound');
});

test('re-eval resolves against the CURRENT layout, not the one input() was written under', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'gtr' });
  const pattern = input('Scarlett', 1).fx('ValhallaRoom');

  setAudioInputLayout([SCARLETT]); // Scarlett first: its channel 1 is absolute 0
  sch.setPattern(pattern);
  setAudioInputLayout([BUILTIN, SCARLETT]); // aggregate rebuilt - Scarlett now sits after the mic
  sch.setPattern(pattern);

  const sent = callsTo('setInputSource');
  assert.deepEqual(sent[0].args[5], [0, -1]);
  assert.deepEqual(sent[1].args[5], [1, -1], 'the same pattern follows the new layout');
});

// input()'s first argument is a DEVICE NAME. Without this the editor's transpile would wrap it in
// mini(), turning input("Scarlett", 1) into a pattern lookup and losing the device entirely.
test('the mini transpile leaves input()\'s device name alone', () => {
  assert.equal(injectLocations('input("Scarlett", 1)'), 'input("Scarlett", 1)');
  assert.equal(injectLocations('input("Scarlett", "1")'), 'input("Scarlett", "1")');
  // ...while a real pattern position next door still gets wrapped.
  assert.match(injectLocations('note("c2*4")'), /^note\(mini\("c2\*4", 6\)\)$/);
});

test('teardown: dropping input() on re-eval clears the route', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'gtr' });
  sch.setPattern(input(1).fx('ValhallaRoom'));
  sch.setPattern(note('c2*4').synth('Serum 2')); // input() gone this eval
  assert.equal(callsTo('clearInputSource').length, 1);
});
