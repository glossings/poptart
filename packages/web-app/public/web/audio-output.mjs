// Which device the page plays to.
//
// A page can play to any output the system has: the browser lists them (enumerateDevices) and
// an AudioContext can be pointed at one (setSinkId). Two things stand in the way, and both are
// the browser's rather than ours:
//
//   - Until the page has been allowed to use a microphone, the browser lists outputs without
//     names - one anonymous entry per kind - so there is nothing to show but "system default".
//     Asking for the microphone once, and closing it again at once, is the only way a page has
//     to learn the names. That is a prompt somebody has to agree to, so it is offered as a menu
//     entry that says what it will ask for rather than done behind their back.
//   - Not every browser can move an AudioContext. Chrome and Edge can; where the method is
//     missing the menu says so and stays on the default.
//
// Switching is instant here: the context carries on and only its destination moves, so unlike
// the desktop nothing restarts and nothing stops playing.
//
// The choice is remembered in this browser only (it is a fact about this machine, and a device
// id means nothing on another one) - by id, and by name as a fallback for when the browser has
// handed out new ids.
//
// THE HEADPHONE CUE goes one of two ways, the engine's cue routes (see web-engine's
// desk-audio.mjs):
//
//   - a PAIR of the output the page plays to: channels 3/4 of a four-output interface, or the
//     headphone jack of a controller that presents itself as one device with four outputs. One
//     context, one clock, no added delay - the way the desktop's cue works.
//   - a SECOND DEVICE: the headphones as an output of their own (a second interface, a USB
//     headset). The cue is carried there by a second audio context pointed at that device - or,
//     in a browser whose contexts cannot be pointed anywhere but whose media elements can, by a
//     media element. Two devices are two clocks: the cue arrives tens of milliseconds late and
//     drifts, which is fine for pre-listening a track and no good for anything else.
//
// A browser that can do neither on the output it has - two channels, and no way to name a second
// device - says so on the menu, and the cue buttons are drawn off.

const PREF_KEY = 'poptart.audioOutput';
const CUE_PREF_KEY = 'poptart.audioCue';

/** The pseudo-entries a browser lists beside the real devices, which are not devices of their own. */
const ALIASES = new Set(['default', 'communications']);

export function createAudioOutputs({
  context,
  media = globalThis.navigator?.mediaDevices ?? null,
  prefs = safeLocalStorage(),
  // The engine whose headphone cue this routes (see the engine's setCueRoute). Absent, there is
  // no cue to route.
  engine = null,
  // How a second device is reached: a constructor for a second context, and a media element
  // maker for a browser that can point those but not contexts. Handed in for a test.
  AudioContextCtor = globalThis.AudioContext ?? null,
  makeElement = () => (typeof globalThis.Audio === 'function' ? new globalThis.Audio() : null),
}) {
  const canMove = typeof context?.setSinkId === 'function';
  let selectedId = '';
  let selectedName = null;
  // The cue as routed now: { kind: 'pair', pair } or { kind: 'device', id, name, ctx?, element?,
  // dest }, or null.
  let cue = null;
  const contextsMove = typeof AudioContextCtor?.prototype?.setSinkId === 'function';
  const elementsMove = typeof globalThis.HTMLMediaElement?.prototype?.setSinkId === 'function';
  const canSecondDevice = !!engine && typeof context?.createMediaStreamDestination === 'function' && (contextsMove || elementsMove);
  const maxChannels = () => Math.max(2, Number(context?.destination?.maxChannelCount) || 2);
  const cuePairList = () => {
    if (!engine) return [];
    const out = [];
    for (let p = 1; p < Math.floor(maxChannels() / 2); p++) out.push(p);
    return out;
  };

  const readPref = () => {
    try { return JSON.parse(prefs?.getItem(PREF_KEY) ?? 'null'); } catch { return null; }
  };
  const writePref = (value) => {
    try {
      if (value) prefs?.setItem(PREF_KEY, JSON.stringify(value));
      else prefs?.removeItem(PREF_KEY);
    } catch { /* a private window, or storage turned off: the choice lasts for this page */ }
  };

  /** The outputs the browser will name, and whether it is hiding the names. */
  async function devices() {
    if (!media?.enumerateDevices) return { list: [], hidden: false, defaultName: null };
    const all = (await media.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    // Unnamed entries are the browser withholding the list, not devices called nothing.
    const hidden = all.length > 0 && all.every((d) => !d.label);
    const alias = all.find((d) => d.deviceId === 'default');
    // Chrome names its default entry "Default - <the device>".
    const defaultName = alias?.label ? alias.label.replace(/^Default\s*-\s*/i, '') : null;
    const list = all
      .filter((d) => d.label && !ALIASES.has(d.deviceId))
      .map((d) => ({ id: d.deviceId, name: d.label, isDefault: d.label === defaultName }));
    return { list, hidden, defaultName };
  }

  /** What the settings tab reads: the desktop's answer, filled in with what this browser has. */
  async function describe() {
    const { list, hidden, defaultName } = await devices();
    const pairs = cuePairList();
    const outputName = selectedName ?? defaultName ?? 'this output';
    const cueAvailable = pairs.length > 0 || canSecondDevice;
    return {
      devices: list.map((d) => ({ name: d.name, channels: null, isDefault: d.isDefault })),
      selected: selectedName,
      outputChannels: 2,
      outputChannelChoices: [2],
      audibleChannels: 2,
      cueAvailable,
      cueSelected: cue?.kind === 'device' ? cue.name : cue?.kind === 'pair' ? outputName : null,
      cuePair: cue?.kind === 'pair' ? cue.pair : null,
      cuePairs: { device: pairs.length ? outputName : null, pairs },
      // Which device an audition is pointed at while the desk is up: the cue's device, when the
      // cue is one. A pair is not something an audition's own context can be pointed at.
      cuePreviewDevice: cue?.kind === 'device' ? cue.name : null,
      cueActive: cue ? (cue.kind === 'pair' ? `${outputName} · channels ${cue.pair * 2 + 1}/${cue.pair * 2 + 2}` : cue.name) : null,
      // Only devices the cue can actually be sent to are offered as such.
      cueDevices: canSecondDevice,
      cueWarning: cueAvailable
        ? null
        : 'the headphone cue needs an output with four channels, or a browser that can play to a second output (Chrome, Edge, Firefox) - this one can do neither',
      // The browser build's own two facts: whether the names need a permission first, and
      // whether this browser can move the output at all.
      canReveal: hidden && typeof media?.getUserMedia === 'function',
      canChoose: canMove,
      warning: canMove ? null : 'this browser cannot choose an audio output, so the page plays to the system default',
    };
  }

  /** Takes the cue off whatever device it was carried to. */
  function closeSecondDevice() {
    if (cue?.kind !== 'device') return;
    try { cue.ctx?.close?.(); } catch { /* already closed */ }
    try { if (cue.element) { cue.element.pause?.(); cue.element.srcObject = null; } } catch { /* gone */ }
  }

  /**
   * Routes the headphone cue: `pair` (from 1) on this output, a second `device` by name, or
   * neither for no cue. Instant - nothing restarts.
   */
  async function chooseCue({ device = null, pair = 0 } = {}) {
    if (!engine) throw new Error('this page has no headphone cue to route');
    const pairs = cuePairList();
    const { list } = await devices();
    const outputName = selectedName ?? list.find((d) => d.isDefault)?.name ?? 'this output';
    const onPair = pair > 0 && (!device || device === outputName || device === 'this output');
    if (!device && !onPair) {
      closeSecondDevice();
      cue = null;
      engine.setCueRoute(null);
      writeCuePref(null);
      return { ...(await describe()), active: null, warning: null };
    }
    if (onPair) {
      if (!pairs.includes(pair)) throw new Error(`this output has no channels ${pair * 2 + 1}/${pair * 2 + 2}`);
      closeSecondDevice();
      engine.setCueRoute({ pair });
      cue = { kind: 'pair', pair };
      writeCuePref({ kind: 'pair', pair });
      const now = await describe();
      return { ...now, active: now.cueActive, warning: null };
    }
    if (!canSecondDevice) throw new Error('this browser cannot play to a second output - Chrome, Edge and Firefox can');
    const found = list.find((d) => d.name === device);
    if (!found) throw new Error(`there is no audio output called "${device}" any more`);
    if (found.id === selectedId) throw new Error(`"${device}" is the output the page already plays to - choose one of its channel pairs, or a second device`);
    closeSecondDevice();
    const routed = await openSecondDevice(found);
    engine.setCueRoute({ node: routed.dest });
    cue = { kind: 'device', id: found.id, name: found.name, ...routed };
    writeCuePref({ kind: 'device', id: found.id, name: found.name });
    return { ...(await describe()), active: found.name, warning: null };
  }

  /**
   * The cue carried to another device: a stream out of this context, played by a second context
   * (or a media element) pointed at that device. Same sample rate, so nothing is resampled
   * between the two but the clocks' own difference.
   */
  async function openSecondDevice(found) {
    const dest = context.createMediaStreamDestination();
    if (contextsMove) {
      const ctx = new AudioContextCtor({ latencyHint: 'interactive', sampleRate: context.sampleRate });
      await ctx.setSinkId(found.id);
      ctx.createMediaStreamSource(dest.stream).connect(ctx.destination);
      // A context made outside a gesture starts suspended; the next touch of the page wakes it.
      if (ctx.state === 'suspended') resumeOnGesture(() => ctx.resume());
      return { dest, ctx };
    }
    const element = makeElement();
    if (!element) throw new Error('this browser has no way to play to a second output');
    element.srcObject = dest.stream;
    await element.setSinkId(found.id);
    try { await element.play(); } catch { resumeOnGesture(() => element.play()); }
    return { dest, element };
  }

  function writeCuePref(value) {
    try {
      if (value) prefs?.setItem(CUE_PREF_KEY, JSON.stringify(value));
      else prefs?.removeItem(CUE_PREF_KEY);
    } catch { /* storage off: the cue lasts for this page */ }
  }

  /** The cue chosen last time, routed again where it still can be. Quietly none if not. */
  async function restoreCue() {
    let saved = null;
    try { saved = JSON.parse(prefs?.getItem(CUE_PREF_KEY) ?? 'null'); } catch { saved = null; }
    if (!saved || !engine) return null;
    try {
      if (saved.kind === 'pair') return (await chooseCue({ pair: saved.pair })).active;
      const { list } = await devices();
      const found = list.find((d) => d.id === saved.id) ?? list.find((d) => d.name === saved.name);
      return found ? (await chooseCue({ device: found.name })).active : null;
    } catch {
      return null;
    }
  }

  /** Points the context at a device by name, or at the system default for null. */
  async function choose(name) {
    if (!canMove) throw new Error('this browser cannot choose an audio output - Chrome and Edge can');
    if (!name) {
      await context.setSinkId('');
      selectedId = '';
      selectedName = null;
      writePref(null);
      return describe();
    }
    const { list } = await devices();
    const found = list.find((d) => d.name === name);
    if (!found) throw new Error(`there is no audio output called "${name}" any more`);
    await context.setSinkId(found.id);
    selectedId = found.id;
    selectedName = found.name;
    writePref({ id: found.id, name: found.name });
    // A cue carried to the device the page now plays to would play twice there.
    if (cue?.kind === 'device' && cue.id === found.id) await chooseCue({});
    return describe();
  }

  /**
   * Asks for the microphone for an instant, only so the browser will name the outputs. Nothing
   * is recorded: every track the answer carries is stopped before this returns.
   */
  async function reveal() {
    if (typeof media?.getUserMedia !== 'function') throw new Error('this browser will not list its audio outputs');
    const stream = await media.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return describe();
  }

  /** Back on the device chosen last time, if it is still here. Quietly the default if not. */
  async function restore() {
    const saved = readPref();
    if (!saved || !canMove) return null;
    try {
      const { list } = await devices();
      const found = list.find((d) => d.id === saved.id) ?? list.find((d) => d.name === saved.name);
      if (!found) return null;
      await context.setSinkId(found.id);
      selectedId = found.id;
      selectedName = found.name;
      return found.name;
    } catch {
      return null;
    }
  }

  return { describe, choose, reveal, restore, chooseCue, restoreCue, get selectedId() { return selectedId; } };
}

/** Runs `fn` on the next touch of the page - the only time a browser lets audio start. */
function resumeOnGesture(fn) {
  if (typeof globalThis.addEventListener !== 'function') return;
  const events = ['pointerdown', 'keydown', 'touchstart'];
  const wake = () => {
    Promise.resolve(fn()).then(() => {
      for (const e of events) globalThis.removeEventListener(e, wake);
    }).catch(() => {});
  };
  for (const e of events) globalThis.addEventListener(e, wake, { passive: true });
}

function safeLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
