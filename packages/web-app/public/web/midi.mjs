// MIDI in the page: the controllers plugged into this machine, through Web MIDI.
//
// What the desktop does in SuperCollider - listen to every source, match one by a fragment of
// its name, send MIDI clock to a destination - done here with the browser's own MIDI access.
//
// ACCESS IS ASKED FOR ONLY WHEN SOMETHING WANTS IT. The browser shows a permission prompt the
// first time a page asks, and most sessions never touch MIDI, so the page asks when a pattern
// names a device (midikeys(), midicc(), midi("dev:…")), when the settings tab lists devices, or
// when a clock destination is chosen - and never at load. Chrome, Edge and Firefox have Web MIDI;
// Safari does not, and there every one of those answers says so.
//
// Names: a port's own name, the way the browser reports it ("Arturia KeyStep 32"). A pattern
// names a device by any fragment of that, case-insensitively - the desktop's rule.
//
// CLOCK OUT sends 24 ticks a beat to one destination, following the transport: timestamped
// ahead on the MIDI system's own clock, so the jitter is the driver's rather than this timer's.
// Ticks flow while the transport is stopped too - a stopped drum machine still wants the tempo -
// and a start, or a jump in the transport's position, relocates the sequencer at the next
// sixteenth: stop, song position, continue, then the tick itself (from the very top, a plain
// start). That is the order the desktop sends, so gear follows either build alike.

const CLOCK_PREF = 'poptart.midiClockOut';
const TICKS_PER_CYCLE = 96;         // 24 a beat, 4 beats a cycle
const CLOCK_LOOKAHEAD_SEC = 0.1;
const CLOCK_WAKE_MS = 20;

/** One MIDI message, as the rest of poptart reads it: 'on'/'off'/'cc', channel 1-16, value 0..1. */
export function parseMidi(bytes) {
  const [status, a = 0, b = 0] = bytes;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  if (type === 0x90) return { kind: b > 0 ? 'on' : 'off', channel, num: a, value: b / 127 };
  if (type === 0x80) return { kind: 'off', channel, num: a, value: b / 127 };
  if (type === 0xb0) return { kind: 'cc', channel, num: a, value: b / 127 };
  return null;
}

export function createWebMidi({
  requestAccess = typeof globalThis.navigator?.requestMIDIAccess === 'function'
    ? (opts) => globalThis.navigator.requestMIDIAccess(opts)
    : null,
  onMessage = () => {},
  // What the clock follows. Handed in because the host has them and this file should not care
  // where a transport comes from.
  transport = null,
  context = null,
  prefs = safeLocalStorage(),
  warn = () => {},
} = {}) {
  let access = null;
  let pending = null;
  let clockOut = null;          // the MIDIOutput clock goes to
  let clockName = null;
  let clockTimer = null;
  let wanted = readPref(prefs);

  const available = typeof requestAccess === 'function';

  /** Asks for access once; every caller after the first waits on the same answer. */
  function enable() {
    if (access) return Promise.resolve(access);
    if (!available) return Promise.reject(new Error('this browser has no MIDI - Chrome, Edge and Firefox do'));
    if (!pending) {
      pending = Promise.resolve(requestAccess({ sysex: false })).then((a) => {
        access = a;
        for (const input of access.inputs.values()) listen(input);
        // A controller plugged in later is listened to as it arrives; one unplugged stops on its own.
        access.onstatechange = (e) => {
          if (e.port?.type === 'input' && e.port.state === 'connected') listen(e.port);
          if (e.port?.type === 'output' && wanted && !clockOut) pointClock(wanted);
        };
        if (wanted) pointClock(wanted);
        return access;
      }, (err) => {
        pending = null;
        throw new Error(`the browser would not give MIDI access - ${err?.message ?? err}`);
      });
    }
    return pending;
  }

  function listen(input) {
    input.onmidimessage = (e) => {
      const msg = parseMidi(e.data);
      if (msg) onMessage(input.name ?? 'MIDI', msg, e.timeStamp);
    };
  }

  const names = (map) => (map ? [...map.values()].filter((p) => p.state !== 'disconnected').map((p) => p.name ?? '') : []);

  /** The inputs' names, asking for access if nobody has yet. */
  async function inputs() {
    await enable();
    return names(access.inputs);
  }

  async function outputs() {
    await enable();
    return names(access.outputs);
  }

  // ---- clock out ------------------------------------------------------------------------------

  /** A time on the audio context's clock as a time on the MIDI system's (performance.now, ms). */
  function midiTime(ctxSec) {
    const stamp = context?.getOutputTimestamp?.();
    if (stamp && Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime)) {
      return stamp.performanceTime + (ctxSec - stamp.contextTime) * 1000;
    }
    return globalThis.performance.now() + (ctxSec - (context?.currentTime ?? 0)) * 1000;
  }

  function pointClock(fragment) {
    stopClock();
    const want = String(fragment ?? '').trim().toLowerCase();
    if (!want || !access) return null;
    const out = [...access.outputs.values()].find((p) => p.state !== 'disconnected' && String(p.name ?? '').toLowerCase().includes(want));
    if (!out) return null;
    clockOut = out;
    clockName = out.name ?? fragment;
    startClock();
    return clockName;
  }

  function startClock() {
    if (!clockOut || !transport || !context) return;
    // The tick train: which tick is next, when it sounds, and whether the transport was running
    // the last time we looked - a change of that is a start or a stop.
    let running = !transport.paused;
    let next = null;          // { k, sec }
    let locate = running;
    const tickSec = () => 60 / (Math.max(1, transport.cps * 240) * 24);
    clockTimer = setInterval(() => {
      const now = context.currentTime;
      const horizon = now + CLOCK_LOOKAHEAD_SEC;
      const playing = !transport.paused;
      if (playing !== running) {
        running = playing;
        if (playing) { locate = true; next = null; } else { send([0xfc], now); }
      }
      if (playing) {
        // On the transport: tick k is cycle k/96. A position that jumped since the last tick
        // (a seek, a restart from the top) relocates, exactly as a start does.
        const k0 = Math.floor(transport.cycleAt(now) * TICKS_PER_CYCLE) + 1;
        if (!next || Math.abs(k0 - next.k) > 2) { if (next) locate = true; next = { k: k0 }; }
        for (;;) {
          const sec = transport.secAt(next.k / TICKS_PER_CYCLE);
          if (!(sec <= horizon)) break;
          const at = Math.max(now, sec);
          if (locate && next.k >= 0 && next.k % 6 === 0) {
            locate = false;
            send([0xfc], at);
            if (next.k === 0) send([0xfa], at);
            else {
              const pos = Math.floor(next.k / 6) % 16384;
              send([0xf2, pos & 0x7f, (pos >> 7) & 0x7f], at);
              send([0xfb], at);
            }
          }
          send([0xf8], at);
          next.k += 1;
        }
      } else {
        // Stopped: ticks at the tempo, from wherever the last one was.
        if (!next || next.sec == null || next.sec < now - 0.5) next = { sec: now };
        while (next.sec <= horizon) {
          send([0xf8], next.sec);
          next.sec += tickSec();
        }
      }
    }, CLOCK_WAKE_MS);
  }

  function send(bytes, ctxSec) {
    try { clockOut?.send(bytes, midiTime(ctxSec)); } catch (err) { warn(`MIDI clock out: ${err?.message ?? err}`); }
  }

  function stopClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
    if (clockOut) { try { clockOut.send([0xfc]); } catch { /* unplugged */ } }
    clockOut = null;
    clockName = null;
  }

  /** Points clock out at a destination by a fragment of its name, or turns it off. */
  async function setClock(fragment) {
    const want = fragment ? String(fragment).trim() : null;
    if (!want) {
      stopClock();
      wanted = null;
      writePref(prefs, null);
      return { selected: null, active: null };
    }
    await enable();
    const active = pointClock(want);
    if (!active) {
      const list = names(access.outputs);
      throw new Error(`no MIDI destination matching "${want}" - connected: ${list.length ? list.join(', ') : 'none'}`);
    }
    wanted = want;
    writePref(prefs, want);
    return { selected: want, active };
  }

  async function clockState() {
    let destinations = [];
    // Listing asks for access, which is a prompt - so only once somebody has asked for MIDI, or
    // chosen a clock before. A settings tab being drawn is not a reason to prompt.
    if (access || wanted) { try { destinations = await outputs(); } catch { /* refused */ } }
    return { destinations, selected: wanted, active: clockName };
  }

  return {
    available,
    get enabled() { return !!access; },
    enable,
    inputs,
    outputs,
    setClock,
    clockState,
    /** Whether a clock is wanted from a previous visit - the host asks for access at boot then. */
    get clockWanted() { return !!wanted; },
    dispose() { stopClock(); },
  };
}

function readPref(prefs) {
  try { return prefs?.getItem(CLOCK_PREF) || null; } catch { return null; }
}

function writePref(prefs, value) {
  try {
    if (value) prefs?.setItem(CLOCK_PREF, value);
    else prefs?.removeItem(CLOCK_PREF);
  } catch { /* storage off: lasts for this page */ }
}

function safeLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
