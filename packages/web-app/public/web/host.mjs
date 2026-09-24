// The server, in the page.
//
// The editor talks to poptart over a table of `"METHOD /path"` handlers, through one function
// that does the asking. On the desktop that function is a fetch and the table lives in a Node
// process; here the table lives in this file and the asking is a direct call. Keeping the SHAPE -
// a route table, an async call, a JSON-ish body - is what let the editor stay as it is, and it
// is also what leaves room for the host to move into a worker or a sandboxed frame later without
// the editor noticing.
//
// THREE KINDS OF ROUTE, and the difference is the honest part of this file:
//
//   - Served. The pattern language, the transport, storage, the device catalog. These are the
//     web build, and they do here what they do there.
//   - Answered empty. Things the editor asks about at startup that have no meaning without a
//     desktop: the plugin list, MIDI devices, the tempo-sharing session. An empty answer is
//     correct - there are none - and the editor's own code for "none" is already written.
//   - Refused, by name. Anything that would silently do nothing. A refusal reaches the editor's
//     console with a sentence saying what is missing and why, which is the same rule the engine
//     follows for the things it cannot do.
//
// The last two are listed explicitly rather than falling through a default, so that adding a
// route to the desktop and forgetting it here shows up as an unknown route rather than as a
// feature that quietly does nothing.

// Nothing is imported from the engine package here on purpose. The catalog and the storage are
// handed in, so this file works the same in a test with a stand-in graph as it does in a page,
// and the static build does not have to reproduce a relative path between two packages.

import { registerPacks } from './samples.mjs';

/** What the editor is told when it asks for something this build does not have. */
/**
 * How long a control dragged in the device panel takes to reach where it was put.
 *
 * Longer than the engine's own glide, and for a reason that is about gestures rather than taste:
 * a device reads each parameter once per audio block, so a value in motion is a staircase at the
 * block rate, and what decides whether that staircase is audible is how far the value travels
 * per step. A drag sends a new position every frame, so thirty milliseconds spreads each frame's
 * worth of movement over about a dozen steps instead of three.
 */
const PANEL_GLIDE_SEC = 0.03;

/**
 * Figure kinds that are a picture of what a device is DOING rather than of how it is set. These
 * are redrawn on every live poll whatever is or is not being driven, because nothing on a knob
 * says when they change: a granulator's grains move on their own, and an auto gain works out
 * its own correction.
 */
const LIVE_FIGURES = new Set(['sample', 'meter', 'transfer']);

class Unsupported extends Error {
  constructor(what, why) {
    super(`${what} is not in the browser build${why ? ` - ${why}` : ''}`);
    this.name = 'Unsupported';
    this.unsupported = true;
  }
}

/** Routes that exist on the desktop and have nothing to say here. The value is the empty answer. */
const EMPTY_ANSWERS = {
  // Each of these is the desktop's answer with nothing in it, field for field: the settings
  // tab reads every one of these names, and a missing one is a row that throws while drawing.
  'GET /api/midiDevices': [],
  'GET /api/link': { enabled: false, peers: 0, playing: false, bpm: null, available: false },
  'GET /api/midiClock': { destinations: [], selected: null, active: null },
  'GET /api/audioDevices': {
    devices: [], selected: null, outputChannels: 2, outputChannelChoices: [2], audibleChannels: 2,
    cueAvailable: false, cueSelected: null, cueActive: null,
  },
  'GET /api/audioInputs': { available: false, devices: [], selected: [], names: {}, layout: null, active: null, warning: null },
  'GET /api/recordings': { items: [] },
  'GET /api/songfiles': { entries: [] },
  'GET /api/sampleMap/status': { state: 'off', building: false },
  'GET /api/sampleMap/sources': { sources: [], suggested: '' },
  // The settings tab draws these two rows as the page loads, so they answer rather than refuse.
  // The folder is empty because a page has no disk to hold one, and neither plugin format is
  // preferred because neither is here. Saving either is refused below, where the reason belongs.
  'GET /api/samplesDir': { dir: '', envOverride: false },
  'GET /api/preferVst3': { enabled: false },

  'POST /api/captureEditors': { ok: true },
};

/** Routes that are refused by name, with the reason the editor's console will show. */
const REFUSALS = {
  'POST /api/record': ['recording the master bus', 'not wired up yet'],
  'POST /api/trackRecord/start': ['recording a track', 'not wired up yet'],
  'POST /api/midiRecord/start': ['recording MIDI input', 'MIDI input is not wired up yet'],
  'POST /api/song/load': ['the DJ decks', 'they stay on the desktop'],
  'GET /api/browseDir': ['browsing the file system', 'a page cannot see your disk'],
  'GET /api/findSamples': ['searching your sample folders', 'a page cannot see your disk'],
  'POST /api/locateSample': ['finding a dropped file on disk', 'a page cannot see your disk'],
  'GET /api/pasteboardFiles': ['reading the clipboard for files', 'a page cannot see your disk'],
  'POST /api/sampleMap/rebuild': ['the sample map', 'it stays on the desktop'],
  'POST /api/sampleMap/sources': ['the sample map', 'it stays on the desktop'],
  'POST /api/samplesDir': ['choosing a sample folder', 'a page cannot see your disk'],
  'POST /api/preferVst3': ['choosing between plugin formats', 'there are no plugins to host'],
  'POST /api/previewSlice': ['auditioning a slice', 'the sampler\'s slices are not built yet'],
  'GET /api/sampleFile': ['reading a sample source\'s files', 'the sampler\'s slices are not built yet'],
  'POST /api/patterns/wip/retention': ['expiring old sessions', 'nothing here is deleted on its own'],
  'POST /api/pinned': ['the star library', 'it is kept here but not run yet'],
  'POST /api/pinned/remove': ['the star library', 'it is kept here but not run yet'],
  // The DJ desk is two decks, a crossfader and a song player, none of which is here. Every one
  // of its routes says so rather than half-answering, which would be a desk that never updates.
  'GET /api/mix': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/tempo': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/set': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/gate': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/gateall': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/solo': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/swap': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/clear': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/eject': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/complete': ['the DJ desk', 'it stays on the desktop'],
  'POST /api/mix/midilearn': ['the DJ desk', 'it stays on the desktop'],
};

export function createHost({
  patternCore,
  engine,
  transport,
  evaluator,
  storage,
  samples,
  catalog,
  panel = null,
  // The wavetable frames a `wavetable` figure is drawn from, as a function so the hundred
  // milliseconds of harmonic sums are not paid by a build that never opens a device window.
  tables = null,
  // Reading a file as a stack of wavetable frames, for the browser's preview. Handed in like
  // the panel is, so this file keeps knowing nothing about where a device comes from.
  wavetables = null,
  builtIn = [],
  builtInUrl = null,
  library = { packs: [], problems: [] },
  version = '0.1.1-web',
}) {
  const macroNames = {};

  /**
   * The devices in the shape the editor's plugin browser and its `synth("`/`fx("` completion
   * read - on the desktop that list comes from the plugin scan, and here it is the catalog. The
   * format is what the browser prints beside each name.
   */
  function devicesAsPlugins() {
    return catalog.list().map((d) => ({ name: d.id, format: 'built in', isInstrument: d.kind === 'synth' }));
  }

  /** Every pack the page knows, built-in first, each with where its files are. */
  function allPacks() {
    const out = [];
    for (const m of builtIn) out.push({ manifest: m, urlFor: builtInUrl });
    for (const m of library.packs) out.push({ manifest: m, urlFor: library.urlFor ?? null });
    return out;
  }

  /** Where one file of a pack is served from, or null when the pack is not known here. */
  function fileUrlOf(packId, index) {
    const found = allPacks().find((p) => p.manifest.id === packId);
    const entry = found?.manifest.files[index];
    if (!found || !entry || !found.urlFor) return null;
    return found.urlFor(packId, entry.file);
  }

  /**
   * What a figure needs and a knob does not: the frames a wavetable picture draws, and the rate a
   * response curve is computed at. The tables are the shared built-in set, which is the same set
   * the synth in the audio thread is reading - a picture of a different copy would be a picture of
   * a different sound.
   */
  const figureOpts = (state = null, report = null) => ({
    // The shipped tables, then whatever this slot loaded into the spare slots: a loaded file's
    // frames are kept on the engine side for exactly this picture.
    tables: tables ? withLoadedTables(tables(), state?.tables) : null,
    // And the outline of any file loaded as audio rather than as a table.
    waves: state?.waves ?? null,
    // ...and any curve somebody drew for a control that takes one.
    shapes: state?.shapes ?? null,
    extras: state?.extras ?? null,
    // What the processor says it is doing right now, where it has been asked - the grains a
    // granulator has in the air. Only the live poll has one; a panel being built has not.
    report,
    sampleRate: engine.sampleRate ?? engine.context?.sampleRate ?? undefined,
  });

  /**
   * A table's frames small enough to draw and to send: a stack of a few dozen outlines, not a
   * megabyte of samples. Frames past the first few dozen are skipped evenly rather than
   * truncated, so the shape of the WHOLE table is what shows.
   */
  function drawableStack(frames) {
    const MAX_DRAWN = 48;
    const POINTS = 96;
    const step = Math.max(1, Math.ceil(frames.length / MAX_DRAWN));
    const stack = [];
    for (let f = 0; f < frames.length; f += step) {
      const frame = frames[f];
      const out = new Array(POINTS);
      for (let i = 0; i < POINTS; i++) out[i] = frame[Math.floor((i / POINTS) * frame.length)];
      stack.push(out);
    }
    return stack;
  }

  /**
   * The names a control that takes a sample can be pointed at, on the control itself.
   *
   * A wavetable control's list is the wavetable folder, which is a setting rather than part of
   * the device - so the device cannot carry it and the panel is where the two meet. Picking one
   * is an ordinary edit: it loads the file into a slot and writes the name into the code.
   */
  /**
   * Every control on a built panel, wherever it is drawn: in a section's own row, or on the
   * heading of a figure that took it over (a table control is drawn on the picture of the
   * table). Anything asking "what is this control's list" has to look in both places.
   */
  function widgetsOf(built) {
    const fromFigures = (figures) => figures.flatMap((f) => f.widgets ?? []);
    return [
      ...built.sections.flatMap((s) => [...s.widgets, ...fromFigures(s.figures)]),
      ...fromFigures(built.figures),
    ];
  }

  function withLoadable(built) {
    for (const widget of widgetsOf(built)) {
      if (widget.takes !== 'sample') continue;
      // Which pack a file added from the picker lands in: a table goes to the wavetable folder,
      // anything played goes in with the other added files.
      widget.pack = widget.sampleAs === 'wavetable' ? 'wt' : 'files';
    }
    return built;
  }

  function withLoadedTables(shipped, loaded) {
    if (!loaded) return shipped;
    const out = [...shipped];
    for (const [index, table] of Object.entries(loaded)) out[Number(index)] = table;
    return out;
  }

  /** A device's parameters in the shape the params panel and autocomplete expect. */
  function paramsOf(deviceId) {
    const descriptor = catalog.get(deviceId);
    if (!descriptor) return [];
    return descriptor.params.map((p, index) => ({
      name: p.name, label: p.unit, index, id: p.id, min: p.min, max: p.max,
      default: p.default, ui: p.ui, options: p.options ? [...p.options] : null, rate: p.rate,
    }));
  }

  // ---- a device edited by hand -----------------------------------------------------------------
  //
  // Turning a knob in a device window is the same gesture as turning one in a plugin's own window
  // on the desktop, so it is filed the same way: the device's whole state is captured and the
  // editor writes it into the code under a name, as a `_preset(...)` definition with a
  // `.preset("name")` on the chain (see the editor's auto-pin section). Nothing is written per
  // control. A synth is a couple of dozen settings, and a window of knobs that each wrote their
  // own `.param()` call buried the pattern under a paragraph of numbers - and none of it could be
  // swapped, because a sound scattered across thirty calls has no name to swap.
  //
  // `conf` is the other half, and the reason it still exists: while it is on for a track, a
  // finished gesture writes the `.param()` call after all. That is the one somebody wants when
  // they are about to pattern a single control rather than save a sound.
  //
  // A capture happens WHEN THE WINDOW CLOSES, and never while it is open. That is the whole
  // difference from the desktop, and it is not a compromise - it is the thing a page can do that
  // a plugin host cannot. A plugin never says when you are finished with it, so the desktop has
  // to guess with a debounce, and every guess that fires mid-session writes the code, re-
  // evaluates, and pushes the state it captured a moment ago back over the knob now under your
  // hand. Here the window IS ours: closing it is the end of the edit, said out loud, so one
  // capture is taken, once, with nothing to fight.
  const dirty = new Map();      // "label|slot" -> { label, slot, preset } touched, not yet taken
  const captured = new Map();   // "label|slot" -> the edit the next poll drains
  let captureSeq = 0;
  let conf = null;              // { label, touched: Map } while a track is configuring

  // Slots whose window is open, and which therefore belong to your hands rather than to the
  // pattern. While one is held, nothing pushes a WHOLE PROGRAM into it - a `.preset("<a b>")`
  // coming round, a preset re-sent by an evaluation - because the sound in there is one nothing
  // else has yet: you made it a moment ago and the capture of it is still on its way to the code.
  // Without this the slot audibly flips to the old sound for a cycle and then back. Nothing else
  // stops: the notes play, the modulators run, every other track carries on.
  const heldByHand = new Set(); // "label|slot"

  function holdSlot(label, slot, on) {
    const key = `${label}|${slot}`;
    const scheduler = evaluator.schedulers?.get(label);
    if (on) {
      heldByHand.add(key);
      scheduler?.holdPluginState?.(slot, true);
      return;
    }
    if (!heldByHand.delete(key)) return;
    scheduler?.holdPluginState?.(slot, false);
    // What the slot holds now is whatever your hands left, which is not what the pattern last
    // sent - so the next swap loads rather than being skipped as already there.
    scheduler?.forgetAppliedState?.(slot);
  }

  /** "I am back in the code": every window's slot goes back to its pattern. */
  function releaseHeldSlots() {
    for (const key of [...heldByHand]) {
      const at = key.lastIndexOf('|');
      holdSlot(key.slice(0, at), Number(key.slice(at + 1)), false);
    }
  }

  /**
   * One finished gesture: a `.param()` call if that track is configuring, and otherwise a note
   * that this slot has been edited. Nothing is read out of the device here - see takeCapture.
   */
  function noteDeviceEdit(label, slot, param, arg) {
    if (conf?.label === label) {
      conf.touched.set(`${slot}:${param.id}`, { slot, name: param.name, id: param.id, value: arg });
      return;
    }
    const key = `${label}|${slot}`;
    if (dirty.has(key)) return;
    dirty.set(key, {
      label,
      slot,
      // Which named preset this slot was playing when the edit STARTED: the capture belongs in
      // that definition rather than in a new one, or shaping one preset by ear would file the
      // result under whichever name came round while you were working.
      preset: evaluator.schedulers?.get(label)?.livePreset?.(slot) ?? null,
    });
  }

  /**
   * Reads an edited slot's device and queues the capture for the editor's next poll. Called when
   * the window closes, and on a flush - anything about to write the buffer out somewhere it has
   * to be true (a save, an export, a share link) takes what is in the device now.
   */
  async function takeCapture(label, slot) {
    const key = `${label}|${slot}`;
    const edit = dirty.get(key);
    if (!edit) return;
    dirty.delete(key);
    const tid = evaluator.trackIds.get(label) ?? label;
    const state = engine.deviceState(tid, slot);
    if (!state) return;
    const held = await engine.getPluginState?.(tid, slot);
    if (!held) return;
    captured.set(key, {
      trackId: label,
      slot,
      plugin: state.descriptor.id,
      preset: edit.preset,
      state: held,
      seq: ++captureSeq,
      // A capture of one of our devices carries every setting it has, so the `.param()` calls
      // that set those same controls are now a second, quieter copy of the preset - and the one
      // that wins, since a polled control is re-sent every tick. The editor drops them.
      replacesParams: true,
    });
  }

  /** Every slot with an edit still in it, taken now. */
  const takeAllCaptures = () => Promise.all([...dirty.values()].map(({ label, slot }) => takeCapture(label, slot)));

  const routes = {
    // ---- what the editor asks before anything else -------------------------------------------

    'GET /api/status': async () => ({
      loaded: true,
      error: null,
      scale: patternCore.globalScale(),
      scan: null,
      build: 'web',
      version,
    }),

    // The knob bank: one row per macro, named as the desktop names them.
    'GET /api/macros': async () => ({
      macros: Array.from({ length: patternCore.MACRO_COUNT }, (_, i) => ({
        index: i + 1,
        value: patternCore.macroValue(i + 1),
        name: macroNames[i + 1] || `Macro ${i + 1}`,
      })),
    }),
    'POST /api/macros/set': async (body) => {
      patternCore.setMacro(Number(body.index), Number(body.value));
      return {};
    },
    'POST /api/macros/name': async (body) => {
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 1 || index > patternCore.MACRO_COUNT) {
        throw new Error(`macro index must be 1..${patternCore.MACRO_COUNT}`);
      }
      const name = String(body.name ?? '').trim().slice(0, 24);
      macroNames[index] = name;
      return { name: name || `Macro ${index}` };
    },

    // ---- playing ------------------------------------------------------------------------------

    'POST /api/evaluate': async (body) => evaluator.evaluate(body.code ?? '', {
      start: body.start,
      arrangeFrom: body.arrangeFrom,
    }),

    'POST /api/stop': async () => evaluator.stop(),

    'GET /api/highlight': async (_body, query) => evaluator.highlightWindow(
      Number(query.get('from') ?? 0),
      Number(query.get('count') ?? 32),
    ),

    'GET /api/arrange': async () => ({ arrange: evaluator.arrangeClock?.snapshot() ?? null }),

    'POST /api/arrangeEnd': async () => {
      // The deck ran off the end of its arrangement. Stopping is the whole behavior; there is no
      // song deck here to pause alongside it. `ended` is what the editor waits for before it
      // lands its own stop - without it, it asks again every quarter second.
      const result = evaluator.stop();
      return { ended: true, ...result, arrange: evaluator.arrangeClock?.snapshot() ?? null };
    },
    'POST /api/arrangeUnlock': async () => {
      // app+L: let a looping region go. The clock answers with what it released, if anything.
      const clock = evaluator.arrangeClock;
      if (!clock) return { released: null, arrange: null };
      const released = clock.release(transport.cycleAt(engine.getTime()));
      return { released, arrange: clock.snapshot() };
    },

    'POST /api/keyNote': async (body) => {
      const tid = evaluator.trackIds.get(body.trackId) ?? body.trackId;
      const at = engine.getTime();
      if (body.isOn) engine.noteOn(tid, Number(body.note), body.vel ?? 1, at);
      else engine.noteOff(tid, Number(body.note), at);
      return { ok: true };
    },
    'POST /api/previewNote': async (body) => routes['POST /api/keyNote'](body),

    // Nothing typed at the keyboard is logged here yet, so a capture finds no events.
    'POST /api/liveNotes': async () => {
      const now = transport.cycleAt(engine.getTime());
      return { events: [], now, transport: evaluator.transportForEditor() };
    },

    // ---- the pattern language's own registries -------------------------------------------------

    // What the pickers list. A library definition's contents ride along - a pack's files, a slice
    // set's markers, an automation's points - because unlike a buffer's they are nowhere in the
    // code the editor can read.
    'GET /api/rolls': async () => {
      const inLibrary = (p) => (p.library ? 'prebake' : null);
      return {
        rolls: patternCore.rollIds(),
        shapes: patternCore.shapeIds(),
        presets: patternCore.presetIds(),
        packs: patternCore.packIds().map((p) => ({ ...p, files: patternCore.lookupPack(p.id, inLibrary(p))?.files ?? [] })),
        sliceSets: patternCore.sliceSetIds().map((p) => ({ ...p, set: patternCore.lookupSlices(p.id, inLibrary(p)) ?? [] })),
        autos: patternCore.autoIds().map((p) => ({ ...p, points: patternCore.lookupAuto(p.id, inLibrary(p)) ?? [] })),
        pinned: [],
      };
    },
    'POST /api/liveRoll': async (body) => {
      const id = body?.id;
      if (typeof id !== 'number' && typeof id !== 'string') throw new Error('liveRoll needs the roll id');
      patternCore.liveRoll(id, String(body.notes ?? ''), body.opts ?? {});
      return { ok: true };
    },
    'POST /api/liveAuto': async (body) => ({ ok: patternCore.liveAuto(body.id, body.points) !== undefined }),
    'POST /api/liveSlices': async (body) => ({ ok: patternCore.liveSlices(body.id, body.set) !== undefined }),

    // ---- devices --------------------------------------------------------------------------------

    'POST /api/params': async (body) => ({ params: paramsOf(body.plugin ?? body.device) }),

    'GET /api/chainParams': async () => {
      // Every device on every playing track, with its parameters - one row per slot, which is
      // what the editor's parameter autocomplete and the params panel are built from.
      const slots = [];
      for (const [label, t] of evaluator.hlTracks) {
        const chain = [t.sig.instrument, ...(t.sig.fxChain ?? [])];
        chain.forEach((id, slot) => {
          if (id) slots.push({ track: label, slot, plugin: id, params: paramsOf(id) });
        });
      }
      return { slots };
    },

    // A double-click on a synth("…")/fx("…") name. On the desktop this opens the plugin's own
    // window and the answer says nothing; here there is no window to open, so the answer IS the
    // window: the panel generated from the device's descriptor, which the editor draws. That is
    // what tells the two builds apart at the one place they differ - an answer carrying a panel.
    'POST /api/showEditor': async (body) => {
      if (!panel) throw new Unsupported('opening a device window', 'this host was built without a panel');
      const label = String(body?.trackId ?? '');
      const slot = Number(body?.slot ?? 0);
      const tid = evaluator.trackIds.get(label) ?? label;
      const state = engine.deviceState(tid, slot);
      if (!state) throw new Error(`there is no device in slot ${slot} of "${label}" - evaluate the buffer and try again`);
      // The processor starts reporting where its controls are, so a control something else is
      // driving is drawn where it is rather than where it was set. Stopped when the window closes.
      engine.watchDevice?.(tid, slot, true);
      // The window is up, so the slot is yours until it closes (see holdSlot).
      holdSlot(label, slot, true);
      return {
        panel: withLoadable(panel.buildPanel(state.descriptor, state.values, state.driven, figureOpts(state))),
        trackId: label,
        slot,
      };
    },

    // The window closed: the processor can stop reporting.
    'POST /api/deviceWatch': async (body) => {
      const label = String(body?.trackId ?? '');
      const slot = Number(body?.slot ?? 0);
      const tid = evaluator.trackIds.get(label) ?? label;
      // The window closing is the end of the edit, so this is where the sound is read out of the
      // device - before the hold is lifted, so nothing can have pushed a program in first.
      if (!body?.on) {
        await takeCapture(label, slot);
        holdSlot(label, slot, false);
      }
      return { ok: !!engine.watchDevice?.(tid, slot, !!body?.on) };
    },

    // Where the driven controls of an open window are right now, and the pictures they move.
    // Polled by the editor while a window with something driven in it is open; the values come
    // from the processor's own reports, which is the only place a modulated control can be read.
    'POST /api/deviceLive': async (body) => {
      const label = String(body?.trackId ?? '');
      const slot = Number(body?.slot ?? 0);
      const tid = evaluator.trackIds.get(label) ?? label;
      const state = engine.deviceState(tid, slot);
      const live = state ? engine.liveValues?.(tid, slot) : null;
      if (!state || !live) return { values: null, figures: [] };
      const report = engine.liveReport?.(tid, slot) ?? null;
      const driven = [...state.driven.keys()];
      const values = {};
      for (const id of driven) {
        const p = panel.findParam(state.descriptor, id);
        if (p) values[id] = { value: live[id], position: panel.normalize(p, live[id]), text: panel.formatValue(p, live[id], state.extras?.[id] ?? null) };
      }
      const merged = { ...state.values, ...live };
      const opts = figureOpts(state, report);
      // A figure is redrawn where one of its parameters is being driven - and, whatever is
      // driving anything, where the picture is of what the device is DOING rather than of how it
      // is set. A granulator's grains move with nothing on a knob at all.
      const figures = (state.descriptor.figures ?? [])
        .filter((f) => LIVE_FIGURES.has(f.kind) || Object.values(f.params).some((id) => state.driven.has(id)))
        .map((f) => panel.figuresFor(state.descriptor, Object.values(f.params).find((id) => state.driven.has(id)) ?? Object.values(f.params)[0], merged, opts))
        .flat();
      const seen = new Set();
      return { values, figures: figures.filter((f) => (seen.has(f.id) ? false : seen.add(f.id))) };
    },

    // A knob moved in that panel. The gesture sends a 0..1 position and this turns it into a
    // real value on the parameter's own curve, because the units and the curve belong to the
    // descriptor and the panel should not have to carry a second copy of them. What comes back
    // is what to print under the knob and what to write in the code, so that a value set live
    // and a value written down can never disagree about how the same number is spelled.
    'POST /api/deviceParam': async (body) => {
      if (!panel) throw new Unsupported('setting a device parameter', 'this host was built without a panel');
      const label = String(body?.trackId ?? '');
      const slot = Number(body?.slot ?? 0);
      const tid = evaluator.trackIds.get(label) ?? label;
      const state = engine.deviceState(tid, slot);
      if (!state) throw new Error(`there is no device in slot ${slot} of "${label}"`);
      // A gesture that moves TWO controls at once - an equalizer vertex, which is a frequency
      // and a gain and has no business picking one of them per frame. Each is set the way a
      // single one would be, and the answer carries the pictures of all of them once.
      if (Array.isArray(body?.params)) {
        const done = [];
        for (const one of body.params) done.push(await routes['POST /api/deviceParam']({ ...one, trackId: label, slot, commit: false }));
        if (body.commit) {
          for (const one of body.params) {
            const p = panel.findParam(state.descriptor, String(one.id ?? ''));
            const after = engine.deviceState(tid, slot);
            if (p) noteDeviceEdit(label, slot, p, panel.paramArgFor(state.descriptor, p.id, after.values[p.id], after.extras));
          }
        }
        const seen = new Set();
        return { batch: done, figures: done.flatMap((r) => r.figures ?? []).filter((f) => (seen.has(f.id) ? false : seen.add(f.id))) };
      }
      const id = String(body?.id ?? '');
      const found = panel.findParam(state.descriptor, id);
      if (!found) throw new Error(`"${state.descriptor.id}" has no parameter called ${JSON.stringify(id)}`);
      // A file named for a parameter that takes one, or a curve drawn for a parameter that takes
      // one, is handed to the engine as written: it loads or samples it and points the control
      // at the slot it landed in. Everything else lands as a value.
      if (typeof body.sample === 'string' && (found.takes === 'sample' || found.takes === 'shape')) {
        engine.setParam(tid, slot, found.id, body.sample, engine.getTime(), 0);
        // The file is read and cut into frames after the call returns, so the answer waits for
        // it: a panel that drew the table straight away would draw the empty slot it was on a
        // moment ago, and the picture would sit there stale until something else redrew it.
        await engine.sampleSettled?.(tid, slot);
        const after = engine.deviceState(tid, slot);
        const value = after.values[found.id];
        if (body?.commit) noteDeviceEdit(label, slot, found, panel.paramArgFor(state.descriptor, found.id, value, after.extras));
        return {
          id: found.id, value, position: panel.normalize(found, value), name: found.name,
          text: panel.formatValue(found, value, after.extras?.[found.id] ?? null),
          arg: panel.paramArgFor(state.descriptor, found.id, value, after.extras),
          options: widgetsOf(panel.buildPanel(state.descriptor, after.values, after.driven, figureOpts(after))).find((w) => w.id === found.id)?.options ?? null,
          figures: panel.figuresFor ? panel.figuresFor(state.descriptor, found.id, after.values, figureOpts(after)) : [],
        };
      }
      const value = body.position === undefined
        ? panel.clampParam(found, Number(body.value))
        : panel.valueFromPosition(state.descriptor, found.id, body.position);
      // A control being dragged moves for as long as the gesture does, and a device reads each
      // parameter once per block - so the value is glided over a few blocks rather than stepped,
      // or the staircase is heard as a buzz over the sound. A setting that picks between named
      // states is stepped instead: gliding through an enum sweeps the ones in between.
      const stepped = !!(found.options || found.step || found.ui === 'toggle');
      // The engine takes what `.param()` takes: a position for a sweep, an index for a choice.
      const arg = found.options ? Math.round(value) : found.ui === 'toggle' ? (value >= 0.5 ? 1 : 0) : panel.normalize(found, value);
      engine.setParam(tid, slot, found.id, arg, engine.getTime(), stepped ? 0 : PANEL_GLIDE_SEC);
      // The end of a gesture. What a finished gesture is WRITTEN as is decided in one place, so
      // that a knob, a number box and a drag on a picture all behave the same (see noteDeviceEdit).
      if (body?.commit) noteDeviceEdit(label, slot, found, panel.paramArgFor(state.descriptor, found.id, value, state.extras));
      return {
        id: found.id,
        value,
        position: panel.normalize(found, value),
        text: panel.formatValue(found, value, state.extras?.[found.id] ?? null),
        // The argument, not the whole call: the editor overwrites the argument of a `.param()`
        // that is already there rather than appending a second one.
        name: found.name,
        arg: panel.paramArgFor(state.descriptor, found.id, value, state.extras),
        // The pictures this parameter appears in, redrawn - a wavetable's waveform, a filter's
        // response, an envelope's curve. Only the ones that name it: a drag sends a parameter per
        // frame, and answering with all of them would rebuild a table stack to move a cutoff.
        figures: panel.figuresFor
          ? panel.figuresFor(state.descriptor, found.id, { ...state.values, [found.id]: value }, figureOpts(state))
          : [],
      };
    },

    // What has been captured since the last poll, for the editor to write into the code. The
    // editor polls this twice a second whatever else is happening, so it is also where the
    // scheduler's `.log()` lines are drained - which is why it answers rather than refusing even
    // when nothing here ever captures anything.
    'POST /api/pluginEdits': async (body) => {
      // About to write the buffer out somewhere it has to be true - a save, an export, a share
      // link. A window still open holds an edit that is not in the code yet, so take it now.
      if (body?.flush) await takeAllCaptures();
      const edits = [...captured.values()];
      captured.clear();
      // Nothing pending: capturing a parameter map is instant and interrupts nothing, so there is
      // never a gesture waiting for a quiet moment the way a plugin's is. The holds are drawn on
      // the code, so an open window shows which `.preset(...)` name it is keeping still.
      const holds = [...heldByHand].map((key) => {
        const at = key.lastIndexOf('|');
        const label = key.slice(0, at);
        const slot = Number(key.slice(at + 1));
        return { trackId: label, slot, preset: evaluator.schedulers?.get(label)?.livePreset?.(slot) ?? null, why: 'hand' };
      });
      // Never anything pending: an edit is taken the moment its window closes, which is now, so
      // there is no held gesture for the editor to warn about the way there is on the desktop.
      return { edits, logs: [], pending: 0, holds };
    },

    // A click in the buffer: every open window's slot goes back to its pattern (see holdSlot).
    'POST /api/releaseEditors': async () => {
      await takeAllCaptures();
      releaseHeldSlots();
      return { released: true };
    },

    // Turn "conf" capture on or off for a track: while it is on, a finished gesture in that
    // track's device windows writes a `.param()` call instead of being captured into a preset.
    // Only one track at a time, which is the desktop's rule too.
    'POST /api/confMode': async (body) => {
      const label = String(body?.trackId ?? '');
      conf = body?.on ? { label, touched: new Map() } : null;
      return { on: !!body?.on, trackId: label };
    },

    // Drain what was touched since the last poll, latest value per control, so a knob swept
    // between two polls lands once at the position it ended on.
    'POST /api/confPending': async (body) => {
      const label = String(body?.trackId ?? '');
      if (conf?.label !== label) return { active: false, params: [] };
      const params = [...conf.touched.values()];
      conf.touched.clear();
      return { active: true, params };
    },

    // On the desktop these are the plugin scan. Here the answer is the same either way and a
    // "rescan" costs nothing, but it has to answer with the list: the editor replaces what it
    // knows with whatever comes back, so an empty answer would empty the browser and the
    // completion behind it.
    'GET /api/knownPlugins': async () => devicesAsPlugins(),
    'POST /api/scanPlugins': async () => ({ plugins: devicesAsPlugins(), crashed: [] }),

    // ---- the mixer's meters and plots -----------------------------------------------------------
    //
    // The desk polls the status about ten times a second while it is open, and the poll carries
    // which strips it is showing - so a folded group hands its analyzers back to its members.
    // Nothing is analyzed until the panel says so: every tap is built on the first poll after
    // monitoring goes on and thrown away when it goes off.

    'POST /api/mixer/monitor': async (body) => ({ on: engine.setMixMonitor?.(!!body?.on) ?? false }),

    'GET /api/mixer/status': async (_body, query) => {
      const asked = String(query.get('strips') ?? '').split(',').filter(Boolean);
      const labels = [...evaluator.hlTracks.keys()];
      // An empty list is the first poll, before the strips are built: everything playing.
      const shown = asked.length ? asked.filter((l) => labels.includes(l)) : labels;
      const read = engine.mixRead?.(shown.map((l) => evaluator.trackIds.get(l) ?? l))
        ?? { on: false, levels: {}, spec: {}, perTrack: true, perTrackMax: 0 };
      // Back into the labels the desk knows: the engine keys everything by track id, and '*' is
      // the master, which is nobody's track.
      const byLabel = (held) => {
        const out = {};
        for (const label of shown) {
          const value = held[evaluator.trackIds.get(label) ?? label];
          if (value !== undefined) out[label] = value;
        }
        if (held['*'] !== undefined) out['*'] = held['*'];
        return out;
      };
      return {
        on: read.on,
        tracks: labels,
        levels: byLabel(read.levels),
        spec: byLabel(read.spec),
        bandFreqs: engine.mixBandFreqs?.() ?? [],
        perTrack: read.perTrack,
        perTrackMax: read.perTrackMax,
        transport: evaluator.transportForEditor(),
      };
    },

    // ---- sample packs -----------------------------------------------------------------------------

    // The sounds tab's list, in the shape the desktop's folder scan produces: a name and the
    // files in index order, so a row can copy `s("pack:idx")`. `root` is the folder the desktop
    // tells somebody to fill when there is nothing here; there is no folder in this build.
    'GET /api/samples': async () => ({
      root: '',
      packs: [
        ...allPacks().map(({ manifest }) => ({
          name: manifest.id,
          files: manifest.files.map((f) => f.file),
          loaded: samples.has(manifest.id),
        })),
        // The files somebody added to this browser: one-offs under `files`, a wavetable folder
        // under `wt`. Listed only once there is something in them.
        ...(samples.addedPacks?.() ?? []).filter((m) => m.files.length).map((m) => ({
          name: m.id,
          files: m.files.map((f) => f.file),
          loaded: true,
        })),
      ],
      problems: library.problems,
    }),
    // A file added from the page - a wavetable, an impulse response, a sample - kept in this
    // browser's store under the `files` pack and answered with the name a `.param()` or `s()`
    // reaches it by.
    'POST /api/files/add': async (body) => {
      if (typeof samples.addFile !== 'function') throw new Unsupported('adding a file', 'this host has no file store');
      const name = String(body?.name ?? '').trim();
      if (!name) throw new Error('a file needs a name');
      if (!(body?.bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(body?.bytes)) throw new Error('a file needs its bytes');
      const pack = String(body?.pack ?? 'files');
      // A caller reading a whole folder passes `defer`, and finishes with /api/files/flush. Both
      // the manifest write and the registration below are O(the pack), so doing them per file is
      // quadratic - which a two-thousand-table library is large enough to feel.
      const defer = body?.defer === true;
      const added = await samples.addFile(name, body.bytes, pack, { defer });
      // Registered again so the language resolves the new name: `sp("wt:2")` and a table named in
      // a `.param()` both go through the pack the same way.
      if (!defer && patternCore?._pack && samples.addedPack) registerPacks(patternCore, [samples.addedPack(pack)]);
      return { ref: added.ref, index: added.index, name: added.name };
    },
    // The end of such a batch: the manifest written once and the pack registered once.
    'POST /api/files/flush': async (body) => {
      const pack = String(body?.pack ?? 'files');
      const manifest = (await samples.flushPack?.(pack)) ?? samples.addedPack?.(pack) ?? null;
      if (manifest && patternCore?._pack) registerPacks(patternCore, [manifest]);
      return { pack, count: manifest?.files.length ?? 0 };
    },
    // What is in one of those packs - the wavetable folder's files, for the table control's list
    // and for the settings row that says how many are kept.
    'GET /api/files': async (_body, query) => {
      const pack = String(query.get('pack') ?? 'files');
      const manifest = samples.addedPack?.(pack) ?? null;
      return {
        pack,
        files: manifest ? manifest.files.map((f) => f.file) : [],
        // What this pack is costing the browser, so the settings row can say so rather than
        // leaving somebody to guess what a folder of two thousand files did to their quota.
        ...(await samples.packSize?.(pack) ?? { count: 0, bytes: 0 }),
      };
    },

    /**
     * One file drawn as the wavetable it would become: the frames, small, for the browser to
     * show before anything is loaded into a device.
     *
     * Cut here rather than in the device, and without the band-limited pyramid: a picture needs
     * the frames and nothing else, and building the pyramid for a file somebody is only looking
     * at would be a second of work per click.
     */
    'POST /api/wavetablePreview': async (body) => {
      if (!wavetables) throw new Unsupported('previewing a wavetable', 'this host was built without the table reader');
      const ref = String(body?.ref ?? '');
      const at = ref.indexOf(':');
      // A name with no pack in front of it is one of the device's own tables, which is not a
      // file at all - it is drawn from the frames the synth itself reads.
      if (at < 0) {
        const table = (tables?.() ?? []).find((t) => t?.name === ref);
        if (!table) throw new Error(`there is no table called ${JSON.stringify(ref)}`);
        const frames = table.mips.map((m) => m[0]);
        return { ref, name: ref, frameCount: table.frameCount, frameLength: frames[0].length, stack: drawableStack(frames) };
      }
      if (at === 0) throw new Error(`${JSON.stringify(ref)} is not a file - write "pack:name"`);
      const pack = ref.slice(0, at);
      const index = samples.indexOf?.(pack, ref.slice(at + 1));
      if (index == null) throw new Error(`there is no file called ${JSON.stringify(ref)} here`);
      const bytes = await samples.bytes?.(pack, index);
      if (!bytes) throw new Error(`${JSON.stringify(ref)} could not be read`);
      const wav = wavetables.decodeWav(bytes);
      let mono = wav.channels[0];
      if (wav.channels.length > 1) {
        mono = new Float32Array(wav.channels[0].length);
        for (const c of wav.channels) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / wav.channels.length;
      }
      const frames = wavetables.framesOf(mono, wav.frameLength ?? 2048);
      return { ref, name: ref.slice(at + 1), frameCount: frames.length, frameLength: frames[0].length, sampleRate: wav.sampleRate, stack: drawableStack(frames) };
    },
    /**
     * One file drawn as its waveform, for the picker's preview of a sample.
     *
     * Peaks rather than samples: the picture is a couple of hundred columns wide and the file may
     * be minutes long, so what is sent is the loudest sample either way per column - which is
     * what a waveform IS at that width, not an approximation of one.
     */
    'POST /api/samplePreview': async (body) => {
      const ref = String(body?.ref ?? '');
      const at = ref.indexOf(':');
      if (at <= 0) throw new Error(`${JSON.stringify(ref)} is not a file - write "pack:name"`);
      const pack = ref.slice(0, at);
      const index = samples.indexOf?.(pack, ref.slice(at + 1));
      if (index == null) throw new Error(`there is no file called ${JSON.stringify(ref)} here`);
      // A pack the page has only registered is downloaded here. The picker can wait for it; the
      // engine, which asks inside a tick, cannot - which is why this is a route of its own.
      await samples.ready?.(pack);
      const held = samples.get?.(pack, index);
      if (!held?.buffer) throw new Error(`${JSON.stringify(ref)} could not be read`);
      const buffer = held.buffer;
      const COLUMNS = 220;
      const channels = buffer.numberOfChannels ?? 1;
      const data = buffer.getChannelData ? buffer.getChannelData(0) : (buffer.channels?.[0] ?? []);
      const per = Math.max(1, Math.floor(data.length / COLUMNS));
      const peaks = [];
      for (let i = 0; i + 1 < data.length; i += per) {
        let lo = 0;
        let hi = 0;
        for (let j = i; j < i + per && j < data.length; j++) {
          if (data[j] < lo) lo = data[j];
          if (data[j] > hi) hi = data[j];
        }
        peaks.push([lo, hi]);
      }
      return { ref, name: ref.slice(at + 1), channels, seconds: buffer.duration ?? data.length / (buffer.sampleRate || 48000), peaks };
    },

    'POST /api/files/clear': async (body) => {
      if (typeof samples.clearPack !== 'function') throw new Unsupported('forgetting files', 'this host has no file store');
      const pack = String(body?.pack ?? 'files');
      await samples.clearPack(pack);
      if (patternCore?._pack && samples.addedPack) registerPacks(patternCore, [samples.addedPack(pack)]);
      return { ok: true };
    },
    // A row held down in that list. The desktop streams the bytes from this path; a page has
    // nothing to stream from, so the answer is where the file already is and the editor fetches
    // it from there.
    'GET /api/sampleAudio': async (_body, query) => {
      const pack = query.get('pack');
      const index = Number(query.get('i') ?? 0);
      const url = fileUrlOf(pack, index);
      if (!url) throw new Error(`there is no sample ${JSON.stringify(`${pack}:${index}`)} here`);
      return { url };
    },
    // The `se("` completion walks a samples folder on disk. There is no folder here, so the
    // listing is empty and the popup simply stays shut.
    'GET /api/sampleFiles': async () => ({ root: '', dirs: [], files: [] }),

    // ---- storage --------------------------------------------------------------------------------

    'GET /api/patterns': async (_body, query) => storage.listAll(query.get('q') ?? ''),
    'POST /api/patterns/save': async (body) => {
      // What leaves this store carries its captured state in full, so the file is the whole
      // patch and opens on a machine that has never seen this browser.
      const { code, missing } = await storage.hydrateForExport(body.code ?? '');
      await storage.writePattern(body.name, code);
      return { ok: true, missing };
    },
    'POST /api/patterns/load': async (body) => {
      const code = await storage.readPattern(body.name);
      if (code == null) throw new Error(`there is no pattern called ${JSON.stringify(body.name)}`);
      return storage.dehydrateOnLoad(code);
    },
    'POST /api/patterns/delete': async (body) => {
      await storage.deletePattern(body.name);
      return { ok: true };
    },
    'POST /api/patterns/rename': async (body) => {
      await storage.renamePattern(body.from, body.to);
      return { ok: true };
    },

    // The playlists. A write answers with what was kept, which the editor takes as its copy.
    'GET /api/library': async () => storage.readLibrary(),
    'POST /api/library': async (body) => storage.writeLibrary(body),

    // Sessions are never expired here: nothing in this store is deleted on its own.
    'GET /api/patterns/wip/retention': async (_body, query) => ({
      months: 0,
      preview: { months: Number(query.get('months') ?? 0), sessions: 0, bytes: 0 },
    }),

    'POST /api/patterns/wip/save': async (body) => {
      await storage.writeWip(body.id, (await storage.dehydrateOnLoad(body.code ?? '')).code);
      return { ok: true };
    },
    'POST /api/patterns/wip/load': async (body) => {
      const code = await storage.readWip(body.id);
      if (code == null) throw new Error('that session is not here');
      return { code };
    },
    'POST /api/patterns/wip/delete': async (body) => {
      await storage.deleteWip(body.id);
      return { ok: true };
    },

    'POST /api/snapshot': async (body) => ({ id: await storage.putSnapshot(body.code ?? '') }),
    // A snapshot that is gone is `code: null`, which the editor reads as a pruned link and says
    // so; an error here would read as a broken page instead.
    'GET /api/snapshot': async (_body, query) => ({ code: (await storage.getSnapshot(query.get('id'))) ?? null }),

    'GET /api/snippets': async (_body, query) => ({ snippets: await storage.listSnippets(query.get('q') ?? '') }),
    'POST /api/snippets/save': async (body) => {
      await storage.writeSnippet(body.name, body.code ?? '');
      return { ok: true };
    },
    'POST /api/snippets/delete': async (body) => {
      await storage.deleteSnippet(body.name);
      return { ok: true };
    },
    'POST /api/snippets/rename': async (body) => {
      await storage.renameSnippet(body.from, body.to);
      return { ok: true };
    },
    // The star library and the prebake are STORED here and not yet RUN (see the TODO's web
    // entry). Each of these says so in the field the editor reads, rather than answering as if
    // it had done the work: a definition that resolves to nothing says why, a pin is refused
    // by name below, and a saved prebake reports that it was kept and not evaluated.
    'POST /api/snippets/resolveDefs': async (body) => ({
      defs: (Array.isArray(body?.want) ? body.want : []).map((w) => ({
        kind: String(w?.kind ?? ''), id: String(w?.id ?? ''), scope: String(w?.scope ?? ''),
        code: null, why: 'the library is not run in the browser build yet',
      })),
    }),

    'GET /api/pinned': async () => ({ defs: [], code: (await storage.readPinned()) ?? '' }),

    'GET /api/prebake': async () => ({ code: (await storage.readPrebake()) ?? '' }),
    'POST /api/prebake': async (body) => {
      await storage.writePrebake(body.code ?? '');
      return { ok: true, errors: ['kept, but the browser build does not run the prebake yet'] };
    },

    'POST /api/blobs/hydrate': async (body) => storage.hydrateForExport(body.code ?? ''),
    'POST /api/blobs/dehydrate': async (body) => storage.dehydrateOnLoad(body.code ?? ''),
    'GET /api/blobs/stat': async (_body, query) => {
      const state = await storage.getBlob(query.get('id'));
      return { bytes: state == null ? null : state.length };
    },

    // ---- carrying work in and out ------------------------------------------------------------------

    'GET /api/export': async () => storage.exportAll(),
    'POST /api/import': async (body) => storage.importAll(body.bundle, { overwrite: !!body.overwrite }),

    // ---- leases the desktop's panels take ------------------------------------------------------------

    // A mixer drag asks to hold a channel value while it lasts. Refused by name, which the
    // editor already handles: it drops the hold and lets the rest of the drag write code.
    'POST /api/channelHold': async (body) => ({ held: body?.value ?? null, why: 'the browser build does not hold a channel; the drag writes code instead' }),
    'POST /api/presetHold': async () => ({ why: 'presets are not held in the browser build' }),
  };

  for (const [key, answer] of Object.entries(EMPTY_ANSWERS)) {
    routes[key] = async () => structuredClone(answer);
  }
  for (const [key, [what, why]] of Object.entries(REFUSALS)) {
    routes[key] = async () => { throw new Unsupported(what, why); };
  }

  /**
   * What the editor calls in place of a request.
   *
   * The signature is the editor's own `api(method, path, body)`, and the contract is the same:
   * resolve with the answer, reject with an Error whose message is worth showing. A route that
   * does not exist rejects by name rather than resolving empty, because a typo in a path that
   * quietly returned nothing is a feature that appears to work and does not.
   */
  async function call(method, path, body = null) {
    const [pathname, search = ''] = String(path).split('?');
    const handler = routes[`${method} ${pathname}`];
    if (!handler) throw new Error(`no route for ${method} ${pathname} in the browser build`);
    return handler(body, new URLSearchParams(search));
  }

  return { call, routes, Unsupported };
}

export { Unsupported };
