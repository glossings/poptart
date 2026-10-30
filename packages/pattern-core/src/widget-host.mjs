// The host's half of the editor's inline widgets - one implementation for both builds: the desktop
// server and the browser's in-page host each make one of these and route three requests to it.
//
//   afterEval(...)  what an evaluation's /api/evaluate answer says about its widgets: every input
//                   control with what the code set it to, and every display with what it draws -
//                   the data, for the displays worked out from a pattern (punchcard, plot, chroma)
//   window(...)     the next stretch of that data, as the editor's clock nears the end of what it
//                   holds (GET /api/widgets/window - the highlight grid's top-up, for displays)
//   frames(...)     the latest audio frames for the displays of sound (GET /api/widgets/frames).
//                   Polling it is also what keeps the engine's taps armed: they come down a few
//                   seconds after the editor stops asking - a closed tab costs the engine nothing.
//   set(...)        a control moved (POST /api/widgets/set)
//
// The engine side is two calls every engine implements: viewTaps(list) arms the taps and
// viewRead() hands back their latest frames (see osc-engine/view-taps.js and the web engine's
// view-taps.mjs).

import { displayWindow, displayNow, setWidgetValue } from './widgets.mjs';

/** Cycles of display data shipped with an evaluation and with each top-up. */
export const WIDGET_WINDOW = 16;

/** How long the taps stay armed after the last frames request. */
export const WIDGET_TAP_IDLE_MS = 4000;

/**
 * `engine()` is the engine (or null while it is down); `engineId(deck, key)` the engine's id for a
 * track key; `cycleNow(deck)` and `cps()` the deck's clock, for a live plot's trace.
 */
export function createWidgetHost({ engine, engineId = (_deck, key) => key, cycleNow = () => 0, cps = () => 0.5, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const decks = {
    a: { views: [], polled: 0 },
    b: { views: [], polled: 0 },
  };
  let idleTimer = null;
  let armedKey = '';
  let lastArm = { armed: [], over: [] };

  /**
   * The evaluate answer's `widgets` for `deck`. `taken` is takeWidgets()'s, `blocks` the evaluated
   * blocks that became tracks ({ label, start, end }), `keyOf(label)` a track's key, `clockOf(block)`
   * the song clock it plays by. A display of sound shows the track whose block its call sits in, or
   * the master when it is written on its own; a display written somewhere that is no track's has
   * nothing to show and says so.
   */
  function afterEval(deck, taken, blocks, { keyOf = (l) => l, clockOf = () => null, from = 0, count = WIDGET_WINDOW } = {}) {
    const d = decks[deck === 'b' ? 'b' : 'a'];
    const owner = (at) => blocks.find((b) => at >= b.start && at < b.end) ?? null;
    // Every track, in the order written: what a punchcard() or chroma() behind the code draws.
    const tracks = blocks.filter((b) => b.sig && b.label).map((b) => ({ label: b.label, sig: b.sig, clock: clockOf(b) }));
    d.views = taken.views.map((v) => {
      if (v.background) return { ...v, target: v.audio ? '*' : null, clock: null, tracks: v.audio ? null : tracks };
      const block = v.sig ? owner(v.at) : null;
      const target = v.audio ? (v.sig ? (block ? keyOf(block.label) : null) : '*') : (block ? keyOf(block.label) : null);
      // The track it is drawn for: its name and its .color(), for the editor to color it by.
      return { ...v, target, clock: block ? clockOf(block) : null, label: block?.label ?? null, color: block?.sig?.trackColor ?? null };
    });
    rearm();
    return {
      from,
      count,
      inputs: taken.inputs.map(({ input: _i, ...w }) => w),
      // The `.record(` calls that record a control's movement (see motion.mjs).
      records: taken.records ?? [],
      views: d.views.map((v) => reportOf(v, from, count)),
    };
  }

  function reportOf(v, from, count) {
    const out = { at: v.at, kind: v.kind, opts: v.opts, target: v.target };
    if (v.background) out.background = true;
    else out.track = { label: v.label ?? null, color: v.color ?? null };
    if (!v.audio) out.data = safeWindow(v, from, count);
    return out;
  }

  // A display's data for [from, from + count). Behind the code, a punchcard or chroma draws every
  // track: `{ tracks: [{ label, color, events, notes }] }`, one per track in the order written.
  function safeWindow(v, from, count) {
    if (v.tracks) {
      return {
        tracks: v.tracks.map((t) => {
          const one = safeWindow({ kind: v.kind, sig: t.sig, clock: t.clock }, from, count);
          return { label: t.label, color: t.sig.trackColor ?? null, events: one?.events ?? [], notes: !!one?.notes };
        }),
      };
    }
    try {
      return displayWindow(v, from, count, { clock: v.clock, cps: cps() });
    } catch {
      return null;
    }
  }

  /** The pattern displays' data for transport cycles [from, from + count) on `deck`. */
  function window(deck, from, count = WIDGET_WINDOW) {
    const d = decks[deck === 'b' ? 'b' : 'a'];
    const base = Math.max(0, Math.floor(Number(from) || 0));
    const n = Math.min(WIDGET_WINDOW * 4, Math.max(1, Math.floor(Number(count) || WIDGET_WINDOW)));
    return {
      from: base,
      count: n,
      views: d.views.filter((v) => !v.audio).map((v) => ({ at: v.at, data: safeWindow(v, base, n) })),
    };
  }

  // What the engine should tap: every display of sound on a deck the editor has asked about lately,
  // merged per track - a spectrum anywhere on a track asks its tap for the transform as well.
  function wants(now) {
    const list = new Map();
    for (const deck of ['a', 'b']) {
      const d = decks[deck];
      if (now - d.polled > WIDGET_TAP_IDLE_MS) continue;
      for (const v of d.views) {
        if (!v.audio || !v.target) continue;
        const id = v.target === '*' ? '*' : engineId(deck, v.target);
        if (id == null) continue;
        const was = list.get(id);
        list.set(id, { id, fft: (was?.fft ?? false) || v.kind === 'spectrum', deck, key: v.target });
      }
    }
    return [...list.values()];
  }

  let armedEngine = null;
  function rearm(now = Date.now()) {
    const eng = engine();
    if (!eng || typeof eng.viewTaps !== 'function') return;
    // A restarted engine is a new one, holding none of the taps the last one was given.
    if (eng !== armedEngine) {
      armedEngine = eng;
      armedKey = '';
    }
    const list = wants(now);
    const key = list.map((w) => `${w.id}:${w.fft ? 1 : 0}`).join(' ');
    if (key === armedKey) return;
    armedKey = key;
    try {
      lastArm = eng.viewTaps(list.map(({ id, fft }) => ({ id, fft }))) ?? { armed: [], over: [] };
    } catch {
      lastArm = { armed: [], over: [] };
    }
  }

  function scheduleIdle() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      rearm(Date.now() + WIDGET_TAP_IDLE_MS * 2); // nobody has asked for a while: every deck is idle
    }, WIDGET_TAP_IDLE_MS + 100);
    idleTimer?.unref?.();
  }

  /**
   * The latest audio frames of `deck`'s displays, keyed by what they show (a track key, or '*'),
   * plus `over` - the keys past the engine's tap budget, which draw nothing - and `now`, a live
   * plot's current value by its call's position.
   */
  function frames(deck) {
    const which = deck === 'b' ? 'b' : 'a';
    const d = decks[which];
    const now = Date.now();
    d.polled = now;
    rearm(now);
    scheduleIdle();
    const eng = engine();
    const raw = eng && typeof eng.viewRead === 'function' ? safeRead(eng) : {};
    const out = {};
    const over = [];
    const overIds = new Set((lastArm.over ?? []).map(String));
    // Only what the target's displays draw goes back: the level always (it is four numbers), the
    // samples for a scope or an imager, the transform for a spectrum. On the desktop this answer is
    // JSON on the event loop the scheduler runs on, twenty-five times a second.
    const needs = new Map();
    for (const v of d.views) {
      if (!v.audio || !v.target) continue;
      const n = needs.get(v.target) ?? { scope: false, spec: false };
      if (v.kind === 'scope' || v.kind === 'imager') n.scope = true;
      if (v.kind === 'spectrum') n.spec = true;
      needs.set(v.target, n);
    }
    for (const [target, need] of needs) {
      const id = target === '*' ? '*' : engineId(which, target);
      if (id == null) continue;
      if (overIds.has(String(id))) {
        over.push(target);
        continue;
      }
      const f = raw[id];
      if (!f) continue;
      out[target] = {
        ...(f.level ? { level: f.level } : {}),
        ...(need.scope && f.scope ? { scope: f.scope } : {}),
        ...(need.spec && f.spec ? { spec: f.spec } : {}),
      };
    }
    const live = {};
    const pos = cycleNow(which);
    for (const v of d.views) {
      if (v.kind !== 'plot' || !v.sig || !v.sig.widgetLive) continue;
      live[v.at] = displayNow(v, pos, cps());
    }
    return { frames: out, over, now: live, at: now };
  }

  function safeRead(eng) {
    try {
      return eng.viewRead() ?? {};
    } catch {
      return {};
    }
  }

  /** A control moved: `value` and `lit` as setWidgetValue takes them. */
  function set(deck, at, value, lit) {
    return setWidgetValue(deck, at, value, lit);
  }

  return { afterEval, window, frames, set };
}
