'use strict';

// Offline renders through scsynth's NRT mode, with no sclang: a score of [seconds, message] built
// here, defs from ../synthdef (or made in the test with ugen()), and the WAV read back. For a
// question about what a def does to a signal - no audio device, no server to boot.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const osc = require('osc');
const G = require('../synthdef/graph');
const { locateServer } = require('../server/locate');
const { message } = require('../server/server');
const { readWavRaw } = require('../wav');

/** A UGen class the encoder does not carry, for a test's own source and reader defs. */
function ugen(name, defaults, Base = G.PureUGen) {
  const C = { [name]: class extends Base {} }[name];
  C.ar = (...args) => C.multiNew('audio', ...defaults.map((d, i) => (args[i] === undefined ? d : args[i])));
  C.kr = (...args) => C.multiNew('control', ...defaults.map((d, i) => (args[i] === undefined ? d : args[i])));
  return C;
}

const timeTag = (sec) => {
  const whole = Math.floor(sec);
  return { raw: [whole, Math.round((sec - whole) * 4294967296)] };
};

/**
 * Renders `score` ([[seconds, [address, ...args]], ...], defs as ['/d_recv', def] with a SynthDef
 * object) for `duration` seconds. Returns { data, channels, frames, at(ch, i) }, or null with
 * `why` when scsynth is not here.
 */
function renderNRT(score, { duration, sampleRate = 48000, outChannels = 2, inChannels = 0, extra = [] } = {}) {
  const loc = locateServer();
  if (!loc.scsynthPath) return { data: null, why: 'no scsynth on this machine' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-nrt-'));
  try {
    const items = score.map(([t, m], i) => ({ t, i, m })).sort((a, b) => a.t - b.t || a.i - b.i);
    items.push({ t: duration, i: items.length, m: ['/c_set', 0, 0] });
    const parts = [];
    for (const { t, m } of items) {
      const msg = m[0] === '/d_recv' && m[1] && typeof m[1].asBytes === 'function' ? ['/d_recv', m[1].asBytes()] : m;
      const bytes = Buffer.from(osc.writePacket({ timeTag: timeTag(t), packets: [message(msg)] }, { metadata: true }));
      const size = Buffer.alloc(4);
      size.writeInt32BE(bytes.length);
      parts.push(size, bytes);
    }
    const cmd = path.join(dir, 'score.osc');
    fs.writeFileSync(cmd, Buffer.concat(parts));
    const out = path.join(dir, 'out.wav');
    const args = ['-N', cmd, '_', out, String(sampleRate), 'WAV', 'float',
      '-o', String(outChannels), '-i', String(inChannels), ...extra];
    if (loc.ugenPluginsPath) args.push('-U', loc.ugenPluginsPath.join(path.delimiter));
    let text = '';
    try {
      text = execFileSync(loc.scsynthPath, args, { encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    const wav = fs.existsSync(out) ? readWavRaw(out) : null;
    if (!wav) return { data: null, why: `the render failed:\n${text.split('\n').slice(-12).join('\n')}`, text };
    const frames = wav.data.length / wav.channels;
    return { ...wav, frames, text, at: (ch, i) => wav.data[i * wav.channels + ch] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { renderNRT, ugen, G };
