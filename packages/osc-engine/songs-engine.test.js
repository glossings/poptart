'use strict';

// The song decks on a real scsynth (engine/songs.js): the player defs build at both channel counts,
// and a deck's song is loaded, played, paused, seeked, stopped and freed through the engine's
// '/poptart/song*' handlers as OscEngine sends them - its position reported back tagged with the
// track, a keylocked start included.
//
// Needs scsynth and an audio device; skipped without them. Nothing sounds: the track is born with
// dry 0 and the audio is read off its input bus.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const synthdef = require('./synthdef');
const { bootEngine, skipReason, toldWhen } = require('./test-support/scsynth');
const { captureBus } = require('./test-support/capture');
const { writeWav } = require('./wav.js');
const { locateServer } = require('./server/locate');
const { extensionFlags } = require('./server/defs');

const SECTIONS = ['tracks', 'routing', 'loads', 'ids', 'notes', 'songs'];
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const peakOf = (cap, ch = 0) => {
  let p = 0;
  for (let i = 0; i < cap.frames; i++) p = Math.max(p, Math.abs(cap.at(ch, i)));
  return p;
};

async function trackOf(E, key) {
  for (let i = 0; i < 100; i++) {
    const t = E.tracks.get(key);
    if (E.isTrack(t)) return t;
    await wait(0.02);
  }
  throw new Error(`track ${key} was never built`);
}

test('the song players build mono and stereo, plain and keylocked', () => {
  for (const pitchShift of [true, false]) {
    const names = synthdef.defsFor({ ...extensionFlags(locateServer().extensionsDir), pitchShift }).map((d) => d.name);
    for (const n of ['poptart_song_1', 'poptart_song_2', 'poptart_songwarp_1', 'poptart_songwarp_2']) {
      assert.ok(names.includes(n), `${n} is missing (pitch shifter ${pitchShift ? 'on' : 'off'})`);
    }
  }
});

test('a deck loads, plays, pauses, seeks, stops and frees its song', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-songs-'));
  const { S, E, told, quit } = await bootEngine({ port: 57477, sections: SECTIONS });
  try {
    // Two seconds of 0.5, then two of 0.25: where a seek lands is audible as a level.
    const SR = 48000;
    const data = new Float32Array(4 * SR);
    data.fill(0.5, 0, 2 * SR);
    data.fill(0.25, 2 * SR);
    const song = path.join(dir, 'song.wav');
    writeWav(song, { sampleRate: SR, channels: 1, data });

    E.dispatch('/poptart/createTrack', ['deck', 'dry', 0]);
    const track = await trackOf(E, 'deck');
    await S.sync();

    E.dispatch('/poptart/songLoad', [7, 'deck', song]);
    const reply = await toldWhen(told, '/poptart/songLoad.reply', (a) => a[0] === 7, 10000);
    const shape = JSON.parse(fs.readFileSync(reply.args[1], 'utf8'));
    fs.rmSync(reply.args[1], { force: true });
    assert.deepEqual({ frames: shape.frames, channels: shape.channels, sampleRate: shape.sampleRate },
      { frames: 4 * SR, channels: 1, sampleRate: SR });

    E.dispatch('/poptart/songStart', ['deck', 0, 1, 0.05, 0]);
    await wait(0.15);
    let cap = await captureBus(S, track.inBus.index, 0.3, { target: track.group });
    assert.ok(Math.abs(peakOf(cap) - 0.5) < 0.01, `playing: peak ${peakOf(cap)}`);
    const pos = await toldWhen(told, '/poptart/songPos', (a) => a[0] === 'deck', 2000);
    assert.ok(pos.args[1] >= 0 && pos.args[1] < 2, `position ${pos.args[1]}`);

    // Paused, the player runs at rate 0: its position stands still.
    E.dispatch('/poptart/songSet', ['deck', 'run', 0, 0]);
    await wait(0.2);
    const mark = told.length;
    await wait(1.2);
    const held = told.slice(mark).filter((m) => m.address === '/poptart/songPos' && m.args[0] === 'deck').map((m) => m.args[1]);
    assert.ok(held.length >= 2 && held.every((v) => Math.abs(v - held[0]) < 1e-4), `paused, the position moved: ${held}`);
    E.dispatch('/poptart/songSet', ['deck', 'run', 1, 0]);

    // Into the quieter half.
    E.dispatch('/poptart/songSeek', ['deck', 2.5, 0]);
    await wait(0.1);
    cap = await captureBus(S, track.inBus.index, 0.2, { target: track.group });
    assert.ok(Math.abs(peakOf(cap) - 0.25) < 0.01, `after the seek: peak ${peakOf(cap)}`);

    // A stop releases the player (declicked) and keeps the buffer for the next start.
    E.dispatch('/poptart/songStop', ['deck', 0]);
    await wait(0.2);
    cap = await captureBus(S, track.inBus.index, 0.2, { target: track.group });
    assert.ok(peakOf(cap) < 1e-4, `stopped: peak ${peakOf(cap)}`);
    assert.ok(E.songs.get('deck')?.buf, 'the buffer went with the stop');

    // Keylocked: the shifter's player, on the same buffer, reporting its heard position.
    const before = told.length;
    E.dispatch('/poptart/songStart', ['deck', 1, 1, 0.1, 1]);
    await wait(0.4);
    cap = await captureBus(S, track.inBus.index, 0.3, { target: track.group });
    assert.ok(peakOf(cap) > 0.2, `keylocked: peak ${peakOf(cap)}`);
    await toldWhen(told.slice(before), '/poptart/songPos', (a) => a[0] === 'deck', 2000);

    // Freed: the player goes and so does the song.
    E.dispatch('/poptart/songFree', ['deck']);
    assert.equal(E.songs.has('deck'), false);
    await wait(0.4);
    cap = await captureBus(S, track.inBus.index, 0.2, { target: track.group });
    assert.ok(peakOf(cap) < 1e-4, `freed: peak ${peakOf(cap)}`);
  } finally {
    await quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
