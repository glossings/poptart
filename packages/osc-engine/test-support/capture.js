'use strict';

// Records a stereo bus of a running test scsynth to a WAV for a while, with the engine's own
// poptart_rec_disk (DiskOut), and reads it back. Put it after whatever writes the bus.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Synth, Buffer } = require('../server/objects');
const { readWavRaw } = require('../wav');

/** { at(ch, frame), frames, channels, data } of `seconds` of audio bus `bus`. */
async function captureBus(S, bus, seconds, { target = null, addAction = 'addToTail' } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-capture-')), 'bus.wav');
  const buf = Buffer.alloc(S, 65536, 2);
  await buf.ready;
  buf.write(file, 'wav', 'float', 0, 0, true);
  await S.sync();
  const rec = Synth.new(S, 'poptart_rec_disk', ['bus', bus, 'buf', buf.bufnum], target, addAction);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  rec.free();
  buf.close();
  await S.sync();
  buf.free();
  await S.sync();
  const wav = readWavRaw(file);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  const frames = wav ? wav.data.length / wav.channels : 0;
  return { ...wav, frames, at: (ch, i) => wav.data[i * wav.channels + ch] };
}

module.exports = { captureBus };
