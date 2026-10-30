// The Delay effect: a stereo delay line with feedback, a filter in the loop and tempo sync.
//
// The time is in seconds or in beats, and a sync setting other than `free` wins: the engine
// tells every device the tempo, so a synced delay follows setbpm() and a free one does not. A
// change of length is glided rather than jumped, which pitches the tail for a moment the way a
// tape delay does and never clicks.
//
// A chain can run inside the feedback loop (`.fx("Delay", (x) => x.fx("Filter"))`). The repeats
// then leave through the second output, go through the chain on the track, and come back into the
// key input, where the Tone, the Feedback and the soft clip take them as they take the repeats of
// a plain delay, ping-pong included. The way round takes time - a block of the engine's, and the
// delay of any device in the chain - which the engine says with setLoop. The repeats are read
// that much early, so they stay on the grid; a time shorter than the way round is held at it.
// With no chain the device is the plain delay, sample for sample.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { OnePole } from '../dsp/filters.mjs';
import { DelayLine } from '../dsp/reverb.mjs';
import { SYNC_OPTIONS, syncedSeconds, migrateSyncLists } from '../dsp/sync.mjs';

const DELAY_MAX_SEC = 4;

export const DELAY = defineDevice({
  id: 'Delay',
  kind: 'fx',
  version: 2,
  // Version 2 inserted 1/32T and 1/32. into the sync list (see dsp/sync.mjs).
  migrate: migrateSyncLists(['sync']),
  license: 'AGPL-3.0-only',
  processor: 'poptart-delay',
  description: 'A stereo delay with feedback and a lowpass in the loop, in seconds or synced to the tempo, with a ping-pong mode.',
  // The second output and the key are the feedback loop's way out and back in (see above).
  channels: { in: 2, out: 2, key: 2, outputs: 2 },
  loop: true,
  params: [
    { id: 'sync', name: 'Sync', default: 0, options: [...SYNC_OPTIONS], rate: 'k',
      description: 'A division of the beat overrides the time control and follows the tempo. Free reads the time control.' },
    { id: 'time', name: 'Time', min: 0.001, max: DELAY_MAX_SEC, default: 0.375, unit: 's', curve: 'exp',
      active: { param: 'sync', is: 'free' },
      description: 'The delay in seconds, when the sync is free.' },
    { id: 'feedback', name: 'Feedback', min: 0, max: 1, default: 0.4,
      description: 'How much of each repeat goes round again. At one the repeats hold their level, and the soft clip in the loop keeps them from running away.' },
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
      description: 'The repeats one hit makes: when each lands on the beat grid and how loud. Left above the line, right below. Drag up for the feedback.',
      params: { time: 'time', feedback: 'feedback', sync: 'sync', pingpong: 'pingpong', spread: 'spread' },
      drag: { y: 'feedback' },
    },
  ],
});

/**
 * The soft clip on what is fed back, so a feedback near one saturates instead of running away.
 * A cubic with unity slope at zero that flattens out exactly where it meets the clamp: at 1.5
 * it is at 1 with no slope left, so the curve is continuous and never turns back down.
 */
export const clipTail = (x) => (x >= 1.5 ? 1 : x <= -1.5 ? -1 : x - (4 * x * x * x) / 27);

export class DelayProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.lines = [new DelayLine(Math.ceil(sampleRate * DELAY_MAX_SEC) + 4), new DelayLine(Math.ceil(sampleRate * DELAY_MAX_SEC) + 4)];
    this.tones = [new OnePole(sampleRate), new OnePole(sampleRate)];
    this.length = [0, 0];       // the delay each channel is actually at, in samples
    this.bpm = 120;
    this.lastTone = -1;
    this.loopSec = -1;          // how late the loop's chain returns, in seconds; below zero, no loop
  }

  setTempo(bpm) { this.bpm = bpm; }

  /** How late a chain in the feedback loop comes back, in seconds, or below zero for none. */
  setLoop(seconds) { this.loopSec = Number.isFinite(seconds) && seconds >= 0 ? seconds : -1; }

  reset() {
    for (const l of this.lines) l.reset();
    for (const t of this.tones) t.reset();
  }

  process(inputs, outputs, count, params, key = null, time = 0, more = null) {
    if (this.loopSec >= 0) { this.processLoop(inputs, outputs, count, params, key, more); return; }
    // No chain in the loop: nothing goes out of the second output.
    if (more?.[0]) for (const ch of more[0]) ch?.fill(0, 0, count);
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

  /**
   * The delay with a chain in its feedback loop. The same lines, glide and Tone as process(), with
   * the repeat taken out through `more[0]` and brought back in through `key`. The output tap reads
   * the time; the tap that goes out to the chain reads it early by the way round (`loopSec`), so
   * what comes back is written at the time and every repeat after the first lands on the grid. A
   * time shorter than the way round is held at it.
   */
  processLoop(inputs, outputs, count, params, key, more) {
    const sync = Math.round(at(params.sync, 0));
    const seconds = Math.min(DELAY_MAX_SEC, Math.max(0.001, syncedSeconds(sync, this.bpm, at(params.time, 0))));
    const pingpong = at(params.pingpong, 0) >= 0.5;
    const spread = at(params.spread, 0);
    const most = DELAY_MAX_SEC * this.sampleRate - 2;
    const trip = Math.min(most, this.loopSec * this.sampleRate);
    const targetL = Math.max(trip, seconds * this.sampleRate);
    const targetR = Math.max(trip, Math.min(most, seconds * this.sampleRate * (1 + 0.5 * spread)));
    const tone = at(params.tone, 0);
    if (tone !== this.lastTone) { for (const t of this.tones) t.glideTo(tone, count); this.lastTone = tone; }
    const k = 1 - Math.exp(-1 / (0.02 * this.sampleRate));

    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const backL = key?.[0] ?? null;
    const backR = key?.[1] ?? backL;
    const sendL = more?.[0]?.[0] ?? null;
    const sendR = more?.[0]?.[1] ?? null;
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
      const retL = backL ? backL[i] : 0;
      const retR = backR ? backR[i] : 0;
      const fedL = clipTail(toneL.next(pingpong ? retR : retL) * fb);
      const fedR = clipTail(toneR.next(pingpong ? retL : retR) * fb);
      if (pingpong) {
        lineL.write((dryL + dryR) * 0.5 + fedL);
        lineR.write(fedR);
      } else {
        lineL.write(dryL + fedL);
        lineR.write(dryR + fedR);
      }
      // After the write, a tap of one is the sample just written: what goes out now comes back,
      // and is written, `trip` samples later - one length after it was written itself.
      // A length still gliding up to a longer way round reads no nearer than that sample.
      if (sendL) sendL[i] = lineL.readLinear(Math.max(1, lenL - trip + 1));
      if (sendR) sendR[i] = lineR.readLinear(Math.max(1, lenR - trip + 1));
      outL[i] = dryL + (readL - dryL) * mix;
      if (outR !== outL) outR[i] = dryR + (readR - dryR) * mix;
    }
    this.length[0] = lenL;
    this.length[1] = lenR;
    if (!Number.isFinite(outL[count - 1])) this.reset();
  }
}
