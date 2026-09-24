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

const PREF_KEY = 'poptart.audioOutput';

/** The pseudo-entries a browser lists beside the real devices, which are not devices of their own. */
const ALIASES = new Set(['default', 'communications']);

export function createAudioOutputs({ context, media = globalThis.navigator?.mediaDevices ?? null, prefs = safeLocalStorage() }) {
  const canMove = typeof context?.setSinkId === 'function';
  let selectedId = '';
  let selectedName = null;

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
    const { list, hidden } = await devices();
    return {
      devices: list.map((d) => ({ name: d.name, channels: null, isDefault: d.isDefault })),
      selected: selectedName,
      outputChannels: 2,
      outputChannelChoices: [2],
      audibleChannels: 2,
      cueAvailable: false,
      cueSelected: null,
      cueActive: null,
      // The browser build's own two facts: whether the names need a permission first, and
      // whether this browser can move the output at all.
      canReveal: hidden && typeof media?.getUserMedia === 'function',
      canChoose: canMove,
      warning: canMove ? null : 'this browser cannot choose an audio output, so the page plays to the system default',
    };
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

  return { describe, choose, reveal, restore, get selectedId() { return selectedId; } };
}

function safeLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
