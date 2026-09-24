// Audio coming IN to the page: the microphones and interface inputs on this machine.
//
// The desktop opens one audio device and numbers its input channels from 1 across it - several
// interfaces combined into one device, when somebody picks more than one in settings. input(3)
// is channel 3 of that; input("Scarlett", 1) is channel 1 of the interface called that. The page
// keeps the same model: the inputs picked in settings are opened one stream each and merged, in
// the order they were picked, into ONE node whose channels are numbered across them - and the
// language is told that layout, so input()'s channel numbers mean what they mean on the desktop.
// With nothing picked, the browser's default input is opened the first time a pattern asks.
//
// THE BROWSER PROCESSES A MICROPHONE FOR SPEECH unless told not to: echo cancellation, noise
// suppression and automatic gain, all on by default, all of which wreck an instrument. Every
// stream here asks for all three off. Whether the browser listens is its own business - Chrome
// does - and the channel count it hands back is too: many browsers give two channels at most,
// whatever the interface has, which the layout then says rather than pretending.
//
// Opening an input is a permission prompt, so nothing here opens at load unless the permission
// was given on an earlier visit.

const PREF_KEY = 'poptart.audioInputs';

export function createAudioInputs({
  context,
  media = globalThis.navigator?.mediaDevices ?? null,
  permissions = globalThis.navigator?.permissions ?? null,
  prefs = safeLocalStorage(),
  // Told the one node carrying every open channel, how many there are, and the layout.
  onChange = () => {},
}) {
  const available = typeof media?.getUserMedia === 'function';
  let selected = readPref(prefs);   // device ids, in the order they were picked
  let open = [];                    // [{ id, name, stream, source, inChannels }]
  let merger = null;
  let opening = null;
  let warning = null;

  async function devices() {
    if (!media?.enumerateDevices) return { list: [], hidden: false };
    const all = (await media.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const hidden = all.length > 0 && all.every((d) => !d.label);
    const list = all
      .filter((d) => d.label && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ uid: d.deviceId, name: d.label }));
    return { list, hidden };
  }

  /** What the settings tab reads: the desktop's answer, with the page's facts in it. */
  async function describe() {
    const { list, hidden } = await devices();
    const names = Object.fromEntries(list.map((d) => [d.uid, d.name]));
    for (const o of open) names[o.id] ??= o.name;
    return {
      available,
      devices: list.map((d) => ({ uid: d.uid, name: d.name, inChannels: open.find((o) => o.id === d.uid)?.inChannels ?? null })),
      selected: [...selected],
      names,
      layout: layout(),
      active: open.length ? open.map((o) => o.name).join(' + ') : null,
      warning: warning ? { message: warning, detail: warning } : null,
      canReveal: available && hidden,
    };
  }

  function layout() {
    return open.map((o) => ({ name: o.name, inChannels: o.inChannels }));
  }

  /** One stream, with the browser's speech processing off. */
  async function openOne(deviceId) {
    const stream = await media.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 32 },
      },
    });
    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    const inChannels = Math.max(1, Number(settings.channelCount) || 2);
    // The default input's label is "Default - <the device>" in Chrome; input("Scarlett") should
    // find it by the device's own name.
    const name = String(track?.label || 'default input').replace(/^Default\s*-\s*/i, '');
    return { id: settings.deviceId ?? deviceId ?? 'default', name, stream, source: context.createMediaStreamSource(stream), inChannels };
  }

  function close() {
    for (const o of open) {
      try { o.source.disconnect(); } catch { /* gone */ }
      for (const t of o.stream.getTracks()) t.stop();
    }
    open = [];
    try { merger?.disconnect(); } catch { /* gone */ }
    merger = null;
  }

  /** Opens `ids` (or the default input, for none) and hands the merged node on. */
  async function openAll(ids) {
    close();
    warning = null;
    const wanted = ids.length ? ids : [null];
    for (const id of wanted) {
      try {
        open.push(await openOne(id));
      } catch (err) {
        warning = `could not open ${id ? 'an audio input' : 'the default audio input'} - ${err?.message ?? err}`;
      }
    }
    const total = open.reduce((n, o) => n + o.inChannels, 0);
    if (total > 0) {
      // Every stream's channels laid end to end: stream one's are 1..n, stream two's follow.
      merger = context.createChannelMerger(Math.min(32, total));
      let at = 0;
      for (const o of open) {
        const split = context.createChannelSplitter(o.inChannels);
        o.source.connect(split);
        for (let c = 0; c < o.inChannels && at < 32; c++, at++) split.connect(merger, c, at);
      }
    }
    onChange(merger, Math.min(32, total), layout());
    return describe();
  }

  /** The inputs picked in settings: opened now, and again on the next visit. */
  async function choose(ids) {
    if (!available) throw new Error('this browser gives a page no audio input');
    selected = [...new Set((ids ?? []).map(String))];
    writePref(prefs, selected);
    return openAll(selected);
  }

  /**
   * A pattern read an input and nothing is open: open what was picked, or the default. Once -
   * a refused permission is not asked again until somebody picks an input in settings.
   */
  function want() {
    if (!available || open.length || opening) return opening;
    opening = openAll(selected).finally(() => { opening = open.length ? null : opening; });
    return opening;
  }

  /** At load: back on the inputs picked last time, but only where that will not prompt. */
  async function restore() {
    if (!available || !selected.length) return null;
    try {
      const state = await permissions?.query?.({ name: 'microphone' });
      if (state?.state !== 'granted') return null;
      await openAll(selected);
      return layout();
    } catch {
      return null;
    }
  }

  return { available, describe, choose, want, restore, close, layout };
}

function readPref(prefs) {
  try {
    const v = JSON.parse(prefs?.getItem(PREF_KEY) ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

function writePref(prefs, ids) {
  try {
    if (ids.length) prefs?.setItem(PREF_KEY, JSON.stringify(ids));
    else prefs?.removeItem(PREF_KEY);
  } catch { /* storage off: lasts for this page */ }
}

function safeLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
