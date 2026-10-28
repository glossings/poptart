'use strict';

// Records n channels from an audio bus of a running test scsynth to a WAV, with a DiskOut synth
// placed after what writes the bus, and reads it back. start() returns stop(), which resolves
// with { frames, channels, at(ch, frame) }.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Synth, Buffer } = require('../server/objects');
const { readWavRaw } = require('../wav');
const { recDef, sendRigDefs } = require('./rig-defs');

async function startRecording(S, bus, channels, { target = null, addAction = 'addToTail' } = {}) {
  await sendRigDefs(S, [recDef(channels)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-record-'));
  const file = path.join(dir, 'rec.wav');
  const buf = Buffer.alloc(S, 65536, channels);
  await buf.ready;
  buf.write(file, 'wav', 'float', 0, 0, true);
  await S.sync();
  const rec = Synth.new(S, `poptart_test_rec${channels}`, ['bus', bus, 'buf', buf.bufnum], target, addAction);
  await S.sync();
  return async () => {
    rec.free();
    buf.close();
    await S.sync();
    buf.free();
    await S.sync();
    const wav = readWavRaw(file);
    fs.rmSync(dir, { recursive: true, force: true });
    const frames = wav ? wav.data.length / wav.channels : 0;
    return { ...wav, frames, at: (ch, i) => wav.data[i * wav.channels + ch] };
  };
}

module.exports = { startRecording };
