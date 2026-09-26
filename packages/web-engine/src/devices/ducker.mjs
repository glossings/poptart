// The Ducker effect: a level dip on every beat, shaped like a compressor pumping to a kick,
// without needing the kick.
//
// The dip runs on the transport's clock - the engine tells every device the tempo and where the
// beat falls - so it is on the grid whatever is playing through it. Played by another track's
// notes (`.fx("Ducker").midi("kick")`) it dips on each note instead, at the note's own sample,
// which is the way to duck to a kick exactly without listening for it. With a sidechain patched
// in (`.audio("kick")`) it triggers on that signal's transients. Either way the shape is the thing: a curve from the dip's floor back up to full over the
// length set, which is what a sidechain compressor's release does with far less to set.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { curveShape } from '../dsp/adsr.mjs';
import { SYNC_OPTIONS, syncedSeconds } from '../dsp/sync.mjs';
import { History } from '../dsp/history.mjs';

export const DUCKER = defineDevice({
  id: 'Ducker',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-ducker',
  description: 'A level dip on the beat, on the notes of a track routed in with .midi(), or on the transients of a sidechained track: the pump of a sidechain compressor, with a shape to draw instead of a detector to fight.',
  channels: { in: 2, out: 2 },
  sidechain: true,
  notes: true,
  params: [
    { id: 'sync', name: 'Sync', default: 8, options: [...SYNC_OPTIONS], rate: 'k',
      description: 'How often the dip happens on the clock. Ignored when notes or a sidechain trigger it instead.' },
    { id: 'amount', name: 'Amount', min: 0, max: 1, default: 0.8,
      description: 'How far the level drops at the dip.' },
    { id: 'length', name: 'Length', min: 0.05, max: 1, default: 0.5,
      description: 'How much of the beat the recovery takes, as a share of the sync division - or in seconds times two when a sidechain triggers it.' },
    { id: 'attack', name: 'Attack', min: 0, max: 50, default: 2, unit: 'ms',
      description: 'How long the drop itself takes. A few milliseconds keeps it from clicking.' },
    { id: 'curve', name: 'Curve', min: -8, max: 8, default: 3, step: 0.5, ui: 'number', rate: 'k',
      description: 'The shape of the recovery: positive starts slow and rises fast, the classic pump; negative snaps back.' },
    { id: 'threshold', name: 'Threshold', min: -60, max: 0, default: -24, unit: 'dB',
      description: 'The level a sidechained signal has to reach to trigger the dip. Notes trigger it whatever their level.' },
  ],
  figures: [
    {
      id: 'dip',
      kind: 'duck',
      title: 'dip',
      description: 'The dip over one beat. While the track plays: the last second of the signal, the gain over it, and the key that triggers it underneath. Drag up for the amount, across for the length.',
      params: { amount: 'amount', length: 'length', attack: 'attack', curve: 'curve', sync: 'sync', threshold: 'threshold' },
      drag: { x: 'length', y: 'amount' },
    },
  ],
});

export class DuckerProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.bpm = 120;
    this.anchorSec = 0;
    this.elapsed = null;      // seconds since the last trigger, or null before the first
    this.gain = 1;
    this.lastBeat = -1;
    this.armed = true;
    this.env = 0;
    this.frames = 0;
    this.keyed = false;
    this.audioKeyed = false;
    // Notes routed in with .midi(): while a route is set, notes are the only trigger, and the
    // clock stops dipping on its own. `pending` is note-on times not yet reached, oldest first.
    this.noteRouted = false;
    this.pending = [];
    this.hit = 0;             // a marker for the picture: one at a note, falling away after it
    // The last second, one entry a block: the gain the dip left it at, the loudest the output
    // got, and the key's envelope - what the panel draws the dip over.
    // Two blocks an entry: about three beats at 120, enough to see the pump repeat.
    this.gains = new History(undefined, 1, { per: 2, keep: 'min' });
    this.peaks = new History(undefined, 0, { per: 2, keep: 'max' });
    this.keys = new History(undefined, 0, { per: 2, keep: 'max' });
    this.blockSec = 128 / sampleRate;
  }

  setTempo(bpm, anchorSec = null) {
    this.bpm = bpm;
    if (anchorSec != null) this.anchorSec = anchorSec;
  }

  /** A route of notes was set or cleared (see the engine's injectMidi). */
  setNoteRoute(on) {
    this.noteRouted = !!on;
    if (!this.noteRouted) this.pending.length = 0;
  }

  /**
   * A note from the routed track: the dip starts at the note's time. Kept in order, because a
   * scheduler sends a lookahead ahead and two notes can arrive in one message burst.
   */
  noteOn(_note, velocity, time) {
    if (!(velocity > 0)) return;
    this.noteRouted = true;
    const t = Number.isFinite(time) ? time : 0;
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1] > t) i -= 1;
    this.pending.splice(i, 0, t);
    if (this.pending.length > 64) this.pending.shift();
  }

  noteOff() { /* the dip is a shape in time, not a gate: an off changes nothing */ }

  process(inputs, outputs, count, params, sidechain, timeSec = null) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sync = Math.round(at(params.sync, 0));
    const period = syncedSeconds(sync, this.bpm, 0.5);
    const curve = at(params.curve, 0);
    const keyed = !!(sidechain && sidechain[0]);
    const byNotes = this.noteRouted && !keyed;
    this.keyed = keyed || byNotes;
    this.audioKeyed = keyed;
    const start = timeSec ?? this.frames / this.sampleRate;
    const sr = this.sampleRate;
    let peak = 0;
    const attackK = 1 - Math.exp(-1 / Math.max(1, at(params.attack, 0) * 0.001 * sr));
    const threshold = Math.pow(10, at(params.threshold, 0) / 20);
    const releaseK = 1 - Math.exp(-1 / (0.05 * sr));
    for (let i = 0; i < count; i++) {
      // Where this sample sits on the clock: a trigger fires when the beat index changes.
      if (byNotes) {
        // A note at or before this sample starts the dip here. Anything that arrived late
        // lands at the first sample it can.
        const now = start + i / sr;
        while (this.pending.length && this.pending[0] <= now) {
          this.pending.shift();
          this.elapsed = 0;
          this.hit = 1;
        }
        this.hit -= this.hit * releaseK;
      } else if (keyed) {
        const key = Math.abs(sidechain[0][i]);
        this.env += (key - this.env) * (key > this.env ? 0.5 : releaseK);
        if (this.armed && this.env > threshold) { this.elapsed = 0; this.armed = false; }
        if (this.env < threshold * 0.5) this.armed = true;
      } else {
        const t = (timeSec ?? this.frames / sr) - this.anchorSec;
        const beat = Math.floor(t / period);
        if (beat !== this.lastBeat) { this.elapsed = this.lastBeat < 0 ? null : 0; this.lastBeat = beat; }
      }
      this.frames += 1;
      const amount = at(params.amount, i);
      const length = at(params.length, i) * (keyed ? 2 : period);
      let target = 1;
      if (this.elapsed != null) {
        const x = Math.min(1, this.elapsed / Math.max(0.001, length));
        target = 1 - amount * (1 - curveShape(x, curve));
        this.elapsed += 1 / sr;
      }
      // Down at the attack, up at the shape's own pace.
      this.gain += (target - this.gain) * (target < this.gain ? attackK : 1);
      const g = this.gain;
      const l = (inL ? inL[i] : 0) * g;
      const r = (inR ? inR[i] : 0) * g;
      outL[i] = l;
      if (outR !== outL) outR[i] = r;
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (a > peak) peak = a;
    }
    // The key's envelope follows the sidechain, and a NaN from it would hold every trigger off
    // for good. The same for the gain, which smooths toward its target from where it was.
    if (!Number.isFinite(this.env)) this.env = 0;
    if (!Number.isFinite(this.gain)) this.gain = 1;
    this.gains.push(this.gain);
    this.peaks.push(peak);
    this.keys.push(keyed ? this.env : byNotes ? this.hit : 0);
    this.blockSec = (count / sr) * 2;
  }

  /** The last second of the dip, the signal under it and the key driving it, for the picture. */
  report() {
    return {
      history: { gain: this.gains.snapshot(), out: this.peaks.snapshot(), key: this.keyed ? this.keys.snapshot() : null, end: this.gains.written, blockSec: this.blockSec },
      keyed: this.keyed,
      // What is triggering it, for the picture's label: 'notes', 'audio' or 'clock'.
      trigger: this.audioKeyed ? 'audio' : this.noteRouted ? 'notes' : 'clock',
    };
  }
}
