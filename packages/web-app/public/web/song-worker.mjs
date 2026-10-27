// A DJ deck's song analysis, off the page's thread: the waveform the pane draws, and the tempo,
// beatgrid, key and transients the deck syncs and snaps by. The maths is the desktop's own - its
// waveform pass (wave-core.mjs) and its song facts (song-detect-core.mjs) - so a song measures the
// same in both builds. Decoding stays on the page, which is the only place that has
// decodeAudioData; what arrives here is the song as 16-bit planes.
//
// One message per job, two answers: the waveform comes back first WITH the planes (transferred
// back, not copied, since the page hands them on to the player), and the facts follow once the
// grid fit is done, which on a long track is the slow half.

import { waveformOf } from '/osc-engine/wave-core.mjs';
import { songFactsOf } from '/osc-engine/song-detect-core.mjs';
import { detectOnsets } from '/web-engine/src/engine/sample-plan.mjs';

const SCALE = 1 / 32768;

/** The planes mixed to one channel, which is what the song facts read. */
function monoOf(planes, frames) {
  const out = new Float32Array(frames);
  const k = SCALE / planes.length;
  for (const plane of planes) for (let i = 0; i < frames; i++) out[i] += plane[i] * k;
  return out;
}

function facts(mono, sampleRate, bpmHint) {
  const onsetFracs = detectOnsets(mono, sampleRate);
  return { ...songFactsOf(mono, sampleRate, { bpmHint, onsetFracs }), bpmHint };
}

self.onmessage = ({ data }) => {
  const { id, kind } = data;
  try {
    if (kind === 'prepare') {
      const { planes, sampleRate, frames, bpmHint = null } = data;
      const wave = waveformOf({ sampleRate, frames, planes, scale: SCALE });
      const mono = monoOf(planes, frames);
      self.postMessage({ id, kind: 'wave', wave, planes }, planes.map((p) => p.buffer));
      self.postMessage({ id, kind: 'facts', facts: facts(mono, sampleRate, bpmHint) });
      return;
    }
    if (kind === 'measure') {
      const mono = monoOf(data.planes, data.frames);
      self.postMessage({ id, kind: 'facts', facts: facts(mono, data.sampleRate, data.bpmHint ?? null) });
      return;
    }
    throw new Error(`unknown song job "${kind}"`);
  } catch (err) {
    self.postMessage({ id, kind: 'error', error: err?.message ?? String(err) });
  }
};
