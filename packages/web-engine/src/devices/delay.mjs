// The Delay effect: a stereo delay line with feedback, a filter in the loop and tempo sync.
//
// The time is in seconds or in beats, and a sync setting other than `free` wins: the engine
// tells every device the tempo, so a synced delay follows setbpm() and a free one does not. A
// change of length is glided rather than jumped, which pitches the tail for a moment the way a
// tape delay does and never clicks.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { OnePole } from '../dsp/filters.mjs';
import { DelayLine } from '../dsp/reverb.mjs';
import { SYNC_OPTIONS, syncedSeconds } from '../dsp/sync.mjs';

const DELAY_MAX_SEC = 4;

export const DELAY = defineDevice({
  id: 'Delay',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-delay',
  description: 'A stereo delay with feedback and a lowpass in the loop, in seconds or synced to the tempo, with a ping-pong mode.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'sync', name: 'Sync', default: 0, options: [...SYNC_OPTIONS], rate: 'k',
      description: 'A division of the beat overrides the time control and follows the tempo. Free reads the time control.' },
    { id: 'time', name: 'Time', min: 0.001, max: DELAY_MAX_SEC, default: 0.375, unit: 's', curve: 'exp',
      active: { param: 'sync', is: 'free' },
      description: 'The delay in seconds, when the sync is free.' },
    { id: 'feedback', name: 'Feedback', min: 0, max: 1.1, default: 0.4,
      description: 'Above one the loop runs away, and the soft clip in it is all that holds it.' },
    { id: 'tone', name: 'Tone', min: 200, max: 20000, default: 8000, unit: 'Hz', curve: 'exp',
      description: 'A lowpass inside the feedback loop, so each repeat is darker than the last.' },
    { id: 'pingpong', name: 'Ping Pong', min: 0, max: 1, default: 0, ui: 'toggle', rate: 'k',
      description: 'Bounces the repeats between the sides.' },
    { id: 'spread', name: 'Spread', min: 0, max: 1, default: 0, unit: '',
      description: 'Offsets the right channel\'s time from the left\'s, for width without ping-pong.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.35 },
  ],
  figures: [
    {
      id: 'echoes',
      kind: 'echoes',
      title: 'echoes',
      description: 'The repeats one hit makes: when each lands, on the beat grid, and how loud. Left above the line, right below; a ping-pong alternates. Drag up for the feedback.',
      params: { time: 'time', feedback: 'feedback', sync: 'sync', pingpong: 'pingpong', spread: 'spread' },
      drag: { y: 'feedback' },
    },
  ],
});

const clipTail = (x) => (x > 2 ? 1 : x < -2 ? -1 : x - (x * x * x) / 12);

export class DelayProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.lines = [new DelayLine(Math.ceil(sampleRate * DELAY_MAX_SEC) + 4), new DelayLine(Math.ceil(sampleRate * DELAY_MAX_SEC) + 4)];
    this.tones = [new OnePole(sampleRate), new OnePole(sampleRate)];
    this.length = [0, 0];       // the delay each channel is actually at, in samples
    this.bpm = 120;
    this.lastTone = -1;
  }

  setTempo(bpm) { this.bpm = bpm; }

  reset() {
    for (const l of this.lines) l.reset();
    for (const t of this.tones) t.reset();
  }

  process(inputs, outputs, count, params) {
    const sync = Math.round(at(params.sync, 0));
    const seconds = Math.min(DELAY_MAX_SEC, Math.max(0.001, syncedSeconds(sync, this.bpm, at(params.time, 0))));
    const pingpong = at(params.pingpong, 0) >= 0.5;
    const spread = at(params.spread, 0);
    const targetL = seconds * this.sampleRate;
    // The right side sits later by the spread, up to half again the time.
    const targetR = Math.min(DELAY_MAX_SEC * this.sampleRate - 2, targetL * (1 + 0.5 * spread));
    const tone = at(params.tone, 0);
    if (tone !== this.lastTone) { for (const t of this.tones) t.glideTo(tone, count); this.lastTone = tone; }
    // The length approaches its target over about twenty milliseconds, which is a glide and not a
    // jump; a set that sweeps the time hears a pitch bend, as it would from a tape.
    const k = 1 - Math.exp(-1 / (0.02 * this.sampleRate));

    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const [lineL, lineR] = this.lines;
    const [toneL, toneR] = this.tones;
    let lenL = this.length[0] || targetL;
    let lenR = this.length[1] || targetR;

    for (let i = 0; i < count; i++) {
      lenL += (targetL - lenL) * k;
      lenR += (targetR - lenR) * k;
      const fb = at(params.feedback, i);
      const mix = at(params.mix, i);
      const dryL = inL ? inL[i] : 0;
      const dryR = inR ? inR[i] : 0;
      const readL = lineL.readLinear(lenL);
      const readR = lineR.readLinear(lenR);
      // Ping-pong feeds each side's repeat into the other line; a plain delay feeds it back
      // into its own. The input enters on the left in ping-pong, so the first repeat is right.
      const fedL = clipTail(toneL.next(pingpong ? readR : readL) * fb);
      const fedR = clipTail(toneR.next(pingpong ? readL : readR) * fb);
      if (pingpong) {
        lineL.write((dryL + dryR) * 0.5 + fedL);
        lineR.write(fedR);
      } else {
        lineL.write(dryL + fedL);
        lineR.write(dryR + fedR);
      }
      outL[i] = dryL + (readL - dryL) * mix;
      if (outR !== outL) outR[i] = dryR + (readR - dryR) * mix;
    }
    this.length[0] = lenL;
    this.length[1] = lenR;
    if (!Number.isFinite(outL[count - 1])) this.reset();
  }
}
