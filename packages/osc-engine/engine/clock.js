'use strict';

// The host clock's mirror and what hangs off it: every open plugin's emulated transport, MIDI
// clock out, and the desk's talk-back port - poptart.scd's clock section and /poptart/setTempo.
//
// The tick train itself runs on the MIDI worker's thread (../server/midi-clock.js), handed the
// mirror as state on every move, so the engine's own loop being busy cannot make a tick late. Its
// clock is hrSec, which every thread of the process reads alike, and so is the mirror's here.

const { hrSec, clockNextTick } = require('../server/midi-clock');

/**
 * A TempoClock: beats run at `tempo` per second from an anchor, a tempo change keeps the beat
 * position continuous, and setting the beats moves the anchor. `onChange` hears every move, so a
 * routine waiting for a beat can re-time its wait as a TempoClock's queue would.
 */
class MirrorClock {
  constructor(now, tempo = 2, onChange = () => {}) {
    this._now = now;
    this.tempo = tempo;
    this._b0 = 0;
    this._t0 = now();
    this._onChange = onChange;
  }

  get beats() {
    return this._b0 + (this._now() - this._t0) * this.tempo;
  }

  set beats(b) {
    this._b0 = b;
    this._t0 = this._now();
    this._onChange();
  }

  setTempo(t) {
    const b = this.beats;
    this._b0 = b;
    this._t0 = this._now();
    this.tempo = t;
    this._onChange();
  }

  /** The moment (on its clock) beat `b` falls on at the current tempo. */
  timeOfBeat(b) {
    return this._t0 + (b - this._b0) / this.tempo;
  }

  /** The anchor, as the ticker takes it. */
  anchor() {
    return { tempo: this.tempo, b0: this._b0, t0: this._t0 };
  }
}

function install(E) {
  const now = hrSec;
  const fullName = (d) => `${d.device} ${d.name}`;

  // The mirror: re-anchored by each /poptart/setTempo, so a routine scheduled on it never drifts
  // against the pattern grid.
  E.hostClock = new MirrorClock(now, E.currentTempo / 60, () => E.clockPush());

  // The mirror, to the worker's ticker, while there is a destination to tick.
  E.clockPush = () => {
    if (E.clockOut == null || !E.midiInitialized) return;
    E.midiIO.clockState({ ...E.hostClock.anchor(), running: !!E.clockRunning, latency: E.clockOutLatency });
  };

  /**
   * A MIDIOut to one destination, with the class library's methods (as far as poptart sends
   * them): each message stamped `latency` seconds on, or sent at once with no latency.
   */
  E.midiOutTo = (dest, latency) => ({
    uid: dest.uid,
    latency,
    _send(bytes, at) {
      const t = at == null ? (this.latency > 0 ? now() + this.latency : null) : at + this.latency;
      E.midiIO.send(this.uid, bytes, t);
    },
    midiClock(at) { this._send([0xF8], at); },
    start(at) { this._send([0xFA], at); },
    continue(at) { this._send([0xFB], at); },
    stop(at) { this._send([0xFC], at); },
    songPtr(p, at) { this._send([0xF2, p & 0x7F, (p >> 7) & 0x7F], at); },
    noteOn(chan, num, val) { this._send([0x90 | (chan & 15), num, val]); },
    control(chan, num, val) { this._send([0xB0 | (chan & 15), num, val]); },
  });

  // Where a track's transport is now, in beats: its deck's own clock run forward from where it was
  // last put (frozen while paused), or the host clock's mirror for a track on the host clock.
  E.trackBeats = (key) => {
    const p = E.trackPlace.get(key);
    if (p != null) return p[2] ? p[0] + ((now() - p[1]) * (E.trackTempo.get(key) ?? E.currentTempo) / 60) : p[0];
    return E.hostClock?.beats ?? 0;
  };

  // Re-anchor the mirror. `beats` is the transport's position at now + `latency`, a TempoClock's is
  // NOW: hence the pull-back by tempo * latency. Only re-anchored while the transport runs (paused,
  // Node's position is frozen at 0); the tempo still follows. 'start' and 'rebase' make the tick
  // train relocate at its next sixteenth, 'stop' sends the stop.
  E.hostClockSync = (bpm, beats, latency, playing, event) => {
    const tempo = bpm / 60;
    if (Math.abs(E.hostClock.tempo - tempo) > 1e-9) E.hostClock.setTempo(tempo);
    if (playing) E.hostClock.beats = beats - (tempo * latency);
    E.clockRunning = playing;
    E.clockPush();
    switch (String(event)) {
      case 'start': case 'rebase':
        E.clockLocate = true;
        E.clockTickerStart();
        break;
      case 'stop':
        E.clockOut?.stop();
        break;
      default: break;
    }
  };

  // The index (24 per beat) of the first tick whose sounding moment is after now + lead.
  E.clockNextTick = clockNextTick;

  E.clockTickerStop = () => {
    if (E.clockTicker) E._midiIO?.clockStop();
    E.clockTicker = null;
  };

  // The tick train (../server/midi-clock.js, on the MIDI worker): 24 ticks a beat, each stamped
  // with its beat's moment and sent clockOutLatency before it, so the delivery jitter is the
  // driver's. A pending locate lands on the next sixteenth - stop, song position, continue, tick -
  // or from the very top a plain start. Ticks flow whether or not the transport runs.
  E.clockTickerStart = () => {
    E.clockTickerStop();
    if (E.clockOut == null) return;
    const io = E.midiIO;
    io.clockDest(E.clockOut.uid);
    E.clockPush();
    io.clockStart({ locate: E.clockLocate });
    // The worker holds the locate from here; it is spent on the sixteenth it lands on.
    E.clockLocate = false;
    E.clockTicker = { dest: E.clockOut.uid };
  };

  E.midiDestName = fullName;

  const findDest = async (p) => {
    const find = () => E.midiIO.destinations().find((d) => fullName(d).toLowerCase().includes(p));
    let dest = find();
    if (!dest) { await E.midiIO.list(); dest = find(); } // plugged in since the client came up
    return dest ?? null;
  };

  // Point MIDI clock out at a destination ("" = off), by the case-insensitive substring match
  // midicc() uses. Answers the matched name (null when nothing matched, or off).
  E.midiClockSet = async (name) => {
    const p = String(name).toLowerCase();
    E.clockTickerStop();
    if (E.clockOut) E._midiIO?.clockDest(null);
    E.clockOut = null;
    E.clockOutName = null;
    if (p.length > 0) {
      if (await E.midiEnable()) {
        const dest = await findDest(p);
        if (dest) {
          E.clockOut = E.midiOutTo(dest, E.clockOutLatency);
          E.clockOutName = fullName(dest);
          E.clockLocate = true;
          E.clockTickerStart();
          E.post(`poptart: MIDI clock out to ${E.clockOutName}`);
        }
      }
    } else {
      E.post('poptart: MIDI clock out off');
    }
    return E.clockOutName;
  };

  const destList = () => (E.midiInitialized ? E.midiIO.destinations().map(fullName).join(', ') : '');

  E.on('/poptart/midiClockOut', async (msg) => {
    const requestId = msg[1];
    const name = String(msg[2]);
    const active = await E.midiClockSet(name);
    if (name.length > 0 && active == null) {
      E.replyErr('/poptart/midiClockOut', requestId, `no MIDI destination matching '${name}' - connected: ${destList()}`);
    } else {
      E.replyOk('/poptart/midiClockOut', requestId, E.toJson({ active }));
    }
  });

  // The desk's talk-back port ("" = off), latency 0: a meter is about now.
  E.midiFeedbackSet = async (name) => {
    const p = String(name).toLowerCase();
    E.feedbackOut = null;
    E.feedbackOutName = null;
    if (p.length > 0) {
      if (await E.midiEnable()) {
        const dest = await findDest(p);
        if (dest) {
          E.feedbackOut = E.midiOutTo(dest, 0);
          E.feedbackOutName = fullName(dest);
          E.post(`poptart: MIDI feedback to ${E.feedbackOutName}`);
        }
      }
    } else {
      E.post('poptart: MIDI feedback off');
    }
    return E.feedbackOutName;
  };

  E.on('/poptart/midiFeedback', async (msg) => {
    const requestId = msg[1];
    const name = String(msg[2]);
    const active = await E.midiFeedbackSet(name);
    if (name.length > 0 && active == null) {
      E.replyErr('/poptart/midiFeedback', requestId, `no MIDI destination matching '${name}' - connected: ${destList()}`);
    } else {
      E.replyOk('/poptart/midiFeedback', requestId, E.toJson({ active }));
    }
  });

  // Short messages to that port, as flat quadruples [kind, channel, num, value, ...]: kind 0 is a
  // control change, 1 a note. Silently nothing with no port chosen.
  const clip = (v) => Math.min(127, Math.max(0, v));
  E.on('/poptart/midiOut', (msg) => {
    const out = E.feedbackOut;
    if (out == null) return;
    for (let i = 1; i <= msg.length - 4; i += 4) {
      const kind = Math.trunc(msg[i]);
      const chan = Math.trunc(msg[i + 1]);
      const num = clip(Math.trunc(msg[i + 2]));
      const val = clip(Math.trunc(msg[i + 3]));
      if (kind === 1) out.noteOn(chan, num, val); else out.control(chan, num, val);
    }
  });

  E.on('/poptart/getMidiDestinations', async (msg) => {
    const requestId = msg[1];
    if (await E.midiEnable()) await E.midiIO.list(); // re-read, so gear plugged in since is offered too
    E.replyOk('/poptart/getMidiDestinations', requestId,
      E.toJson(E.midiInitialized ? E.midiIO.destinations().map(fullName) : []));
  });

  E.on('/poptart/setTempo', (msg) => {
    const bpm = Number(msg[1]);
    const beats = Number(msg[2]);
    const latency = Number(msg[3]);
    const playing = msg.length > 4 ? Math.trunc(msg[4]) > 0 : true;
    const event = msg.length > 5 ? String(msg[5]) : 'sync';
    // A deck on a clock of its own: 'except' is the host clock with the listed tracks left out,
    // 'only' another clock's tempo and place for the listed tracks alone - which is not the host
    // clock, so the mirror MIDI clock ticks from is not touched by it.
    const scope = msg.length > 6 ? String(msg[6]) : 'all';
    const listed = msg.length > 7 ? msg.slice(7).map(String) : [];
    if (scope === 'only') {
      for (const key of listed) {
        E.trackTempo.set(key, bpm);
        E.trackPlace.set(key, [beats, now() + latency, playing]);
      }
    } else {
      E.currentTempo = bpm;
      for (const key of [...E.trackTempo.keys()]) {
        if (!listed.includes(key)) { E.trackTempo.delete(key); E.trackPlace.delete(key); }
      }
      E.hostClockSync(bpm, beats, latency, playing, event);
    }
    E.bundleNow(latency, () => {
      for (const [key, track] of E.tracks) {
        if (!E.isTrack(track)) continue;
        if (!(scope === 'all' || listed.includes(key) === (scope === 'only'))) continue;
        for (const [i, id] of track.loaded) {
          if (id == null) continue;
          const ctl = track.controllers.get(i);
          if (ctl) {
            ctl.setTempo(bpm);
            ctl.setTransportPos(beats);
          }
        }
      }
    });
  });
}

module.exports = { install, MirrorClock };
