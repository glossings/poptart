// Turning a buffer into music, in a browser.
//
// This is the browser's `/api/evaluate`, and it follows the desktop's order of operations
// closely enough that the comments there explain the ones here. The order is not incidental:
// several steps only work because of where they sit, and each of those is noted where it stands.
//
// WHAT IS NOT HERE, and why. There is no plugin capture, because there are no plugin windows to
// capture from; no sample-pack definition over a wire, because the packs are objects in this
// process. What remains is the pattern language, which is the part both builds share and the
// part that must not differ - and the two decks of the DJ desk, keyed as the desktop keys them.

import { createBlockEvaluator, GROOVE_BLOCK, SCALE_BLOCK, TEMPO_BLOCK } from './block-eval.mjs';

/** Cycles built up front, to surface an error in the buffer rather than in the audio thread. */
const DRY_RUN_CYCLES = 8;

/** Cycles of highlight grid shipped per track, per window. */
export const HL_WINDOW = 32;

/** How far ahead of now a play-from-stop puts the downbeat. The scheduler's own lookahead. */
const START_LEAD_SEC = 0.15;

/**
 * Every signal on a track that can hold a pattern: the note pattern, each parameter modulation,
 * each channel-strip control, and the preset names. Shared by the dry run and the highlight grid
 * so both see the whole track rather than only what it plays.
 */
export function patternSigs(sig) {
  const presets = Object.values(sig.presetPatterns ?? {});
  const params = Object.values(sig.paramSignals ?? {}).map((e) => e.sig);
  return [sig, ...params, ...Object.values(sig.channel ?? {}), ...presets]
    .flatMap((s) => {
      const ir = s?.lfoIR ?? s?.envIR ?? s?.ccIR;
      if (!ir) return [s];
      const bounds = [ir.min, ir.max].filter((b) => b && typeof b === 'object');
      return [s, ...(ir.shapePattern ? [ir.shapePattern] : []), ...(ir.rateSig ? [ir.rateSig] : []), ...bounds];
    })
    .filter(Boolean);
}

/** What a track row lists after "modulating:", qualified where one name appears twice. */
export function paramLabels(sig) {
  const entries = Object.values(sig.paramSignals ?? {});
  const chain = [sig.instrument, ...(sig.fxChain ?? [])];
  const seen = new Map();
  for (const e of entries) seen.set(e.name, (seen.get(e.name) ?? 0) + 1);
  return entries.map((e) => (seen.get(e.name) > 1 && chain[e.slot] ? `${chain[e.slot]} ${e.name}` : e.name));
}

/**
 * The sounding steps of a track over a window of cycles, each tagged with the source spans that
 * made it.
 *
 * The highlighter reads the SAME grid the scheduler plays, which is what makes a transform in
 * the chain light up correctly instead of the editor re-guessing from the text. Both edges are
 * warped where the scheduler warps them, so a swung note flashes with the sound rather than with
 * the grid it sits on.
 */
export function highlightGrid(patternCore, sig, start, end, from, count, clock = null) {
  const sigs = patternSigs(sig).filter((s) => s.stepsForCycle);
  const grid = [];
  const base = Math.max(0, from);
  const sampler = sig.sampler ?? null;
  const samplerKind = sig.samplerKind ?? 'pack';

  // What a sliced sampler step chops, resolved the way the scheduler resolves it: the step's own
  // config first, then the track's channel. Read only by the slice editor, so it rides along only
  // on tracks that actually slice.
  const chopAt = (s, at) => {
    const pick = (key) => {
      const raw = s.cfg?.[key] !== undefined ? s.cfg[key] : sampler[key]?.sample(at, 1, at);
      const v = typeof raw === 'number' ? raw : raw == null ? NaN : Number(raw);
      return Number.isFinite(v) ? Math.round(v) : undefined;
    };
    const slice = pick('slice');
    if (slice === undefined) return null;
    let i = pick('index');
    if (i === undefined && (samplerKind === 'pack' || samplerKind === 'named')) {
      // `s("breaks:19")` carries the index in the value and the scheduler splits it off there,
      // so a chain with no .i() still plays a numbered file. Asked second: an explicit .i() wins.
      const m = /^(.+):(-?\d+)$/.exec(String(s.value));
      if (m) i = Number(m[2]);
    }
    return { slice, ...(i === undefined ? {} : { i }) };
  };

  for (let c = base; c < base + count; c++) {
    const out = [];
    const gates = [];
    for (const sub of sigs) {
      let steps;
      try {
        steps = patternCore.songSteps(sub.stepsForCycle, c, c + 1, clock);
      } catch {
        continue;
      }
      for (const { step: s, cycle, delta } of steps) {
        if (s.value == null) continue;
        const at = cycle + s.start;          // the song position, where every channel is read
        const offset = cycle - delta - c;    // song cycle -> this transport cycle
        const rel = offset + s.start;
        const startShift = patternCore.timeShift(s, sub.noteChannels, at, 1, at, sub.groove);
        // The track's note gates: every onset the engine will actually play. Note-gated shapes
        // reset their phase on these, so the shape editor's playhead has nothing to draw without
        // them. Only the track's own signal carries them.
        if (sub === sig && !s.cont) gates.push(rel + startShift);
        const locs = patternCore
          .stepLocs(s)
          .filter((l) => l[0] >= start && l[1] <= end)
          .map((l) => [l[0] - start, l[1] - start]);
        if (!locs.length) continue;          // a step that lights nothing is not worth shipping
        const soundsTo = patternCore.soundingEnd(s, sub.noteChannels, at, 1, at);
        const endAt = cycle + soundsTo;
        const endStep = patternCore.endEdgeStep(s, endAt - Math.floor(endAt));
        const endShift = patternCore.timeShift(endStep, sub.noteChannels, endAt, 1, endAt, sub.groove);
        const chop = sampler && sub === sig ? chopAt(s, at) : null;
        out.push({
          start: rel + startShift,
          end: offset + soundsTo + endShift,
          ...(s.cont ? { cont: true } : {}),
          ...(chop ? { chop } : {}),
          locs,
        });
      }
    }
    grid.push({ cycle: c, steps: out, ...(gates.length ? { gates: gates.sort((a, b) => a - b) } : {}) });
  }
  return grid;
}

/** The decks a buffer can be evaluated onto: 'a' is the main editor, 'b' the DJ desk's second. */
const DECKS = ['a', 'b'];
const deckName = (deck) => (deck === 'b' ? 'b' : 'a');
/** A scheduler's key: deck A's is the block's label, deck B's "b:<label>" (a label has no ':'). */
export const deckOfKey = (key) => (String(key).includes(':') ? String(key).slice(0, String(key).indexOf(':')) : 'a');

/**
 * The evaluator, and the state a buffer leaves behind between evaluations.
 *
 * That state is the reason this is a factory rather than a function: a scheduler outlives the
 * evaluation that made it, and so do the engine track ids, the song clock and the definitions
 * the buffer declared. An evaluation that rebuilt them would cut every sound on every keystroke.
 *
 * TWO DECKS. A buffer is evaluated onto deck A (the main editor) unless the caller says deck B -
 * the DJ desk's second editor - and everything that keys or scopes by label goes through
 * keyOfBlock, so the two decks' identically named blocks stay separate tracks: deck B's `kick`
 * is "b:kick". Each deck has its own arrangement, its own song facts (the key setscale() left,
 * the tempo setbpm() asked for, the feel setgroove() set) and its own clock. The global scale and
 * feel hold deck A's at rest; deck B's evaluation borrows them and puts them back.
 *
 * `desk` is the DJ desk (desk.mjs), when there is one: the decks' clocks, whether a setbpm()
 * may move the room's tempo, what a new track is born wearing. Without one there is one deck on
 * the room's clock, exactly as before there was a desk.
 */
export function createEvaluator({ patternCore, engine, transport, prebakeDefs = new Map(), log = null, remotePacks = null, desk = null }) {
  const schedulers = new Map();        // key -> Scheduler
  const trackIds = new Map();          // key -> engine track id
  // The engine keys its tracks by those ids, and every routing name a pattern carries is the
  // LABEL somebody typed - audio("kick"), a group reading its members, a signal patched onto a
  // parameter. Handing it the lookup is what makes those names resolve; without it they warn
  // about a name that is plainly in the buffer. (The desktop does this in its engine wrapper.)
  engine.setTrackResolver?.((label) => trackIds.get(label) ?? label);
  const hlTracks = new Map();          // key -> { sig, start, end, clock }
  const eventLog = [];
  let nextTrackNum = 1;
  // Each deck's song: its arrangement clock and clips, its monitor takeovers, its song facts and
  // its loop toggle (see setLoops).
  const newDeck = () => ({
    arrangeClock: null,
    arrangeClips: null,
    clipsMemo: { src: null, rows: new Map() },
    // Monitor (`M`) takeovers: which block was being cued (see patternCore.monitorPicker).
    monitorPicker: patternCore.monitorPicker(),
    scale: null,
    groove: null,
    bpm: null,
    // Whether the arrangement's loop regions are armed. On, everywhere but the DJ desk, which
    // opens with them off so a song runs start to end like a record (see setLoops).
    loopsOn: true,
    loopsPinned: false,
  });
  const decks = { a: newDeck(), b: newDeck() };
  const clockOf = (deck) => desk?.clockOf?.(deck) ?? transport;
  // The editor's inline widgets: what each evaluation built and the taps its displays of sound
  // read - the desktop server's own logic, shared through pattern-core (widget-host.mjs).
  const widgets = patternCore.createWidgetHost?.({
    engine: () => engine,
    engineId: (_deck, key) => trackIds.get(key) ?? null,
    cycleNow: (deck) => clockOf(deck).cycleAt(engine.getTime()),
    cps: () => transport.cps,
  }) ?? null;

  const say = (line) => {
    eventLog.push(line);
    if (log) log(line);
  };

  /**
   * Engine track ids are minted here and nowhere else. A label that no evaluation has seen
   * passes through as itself, and the engine ignores it the way it ignores anything aimed at a
   * track that does not exist - which is better than allocating a ghost track for a typo.
   */
  function claimTrack(key) {
    let id = trackIds.get(key);
    if (!id) {
      id = `#${nextTrackNum++}`;
      trackIds.set(key, id);
    }
    return id;
  }

  /**
   * How a clips() head finds what is painted on its row.
   *
   * Installed once and left installed, because resolution is LAZY: the head asks at cycle-build
   * time, which is mostly BETWEEN evaluations, and a resolver torn down after each one would
   * leave every clips() track silent the moment its evaluation finished.
   */
  patternCore.setClipsResolver((deck, label) => {
    const NONE = { clips: [], arranged: false };
    const d = decks[deckName(deck)];
    if (!d.arrangeClips) return NONE;
    if (d.clipsMemo.src !== d.arrangeClips) d.clipsMemo = { src: d.arrangeClips, rows: new Map() };
    let row = d.clipsMemo.rows.get(label);
    if (!row) {
      row = { clips: patternCore.clipsOfLabel(d.arrangeClips, label), arranged: true };
      d.clipsMemo.rows.set(label, row);
    }
    return row;
  });

  /** Builds a few cycles up front, so a broken pattern reports in the buffer and not mid-set. */
  function dryRun(sig, cps) {
    for (const s of patternSigs(sig)) {
      if (s.stepsForCycle) for (let cycle = 0; cycle < DRY_RUN_CYCLES; cycle++) s.stepsForCycle(cycle);
      s.sample?.(0, cps, 0);
    }
  }

  /** Is any of this deck's code playing? */
  const deckRunning = (deck) => [...schedulers].some(([key, sch]) => deckOfKey(key) === deck && sch.running);

  /**
   * The loop toggle's resting position for a deck about to play `regions` (null: no arrangement
   * at all). `on` is what was asked for, and the answer only ever differs by coming back ON: an
   * unarranged song - one region from bar 0 over the whole of it, the shape a fresh arrangement
   * has - loops, because switching its loop off does not make it play like a record, it makes it
   * stop after the eight bars nobody wrote. Once the toggle is pressed, it stays where the press
   * put it.
   */
  function loopsDefault(deck, on, regions, end) {
    if (on !== false || decks[deck].loopsPinned) return on !== false;
    return !regions || patternCore.isWholeSongLoop(regions, end);
  }

  /** A deck's loop toggle. `pinned: false` is a default being set, not a press of the button. */
  function setLoops(deck, on, { pinned = true } = {}) {
    const d = decks[deckName(deck)];
    const clock = d.arrangeClock;
    if (!pinned) on = loopsDefault(deck, on, clock ? clock.regions : null, clock ? clock.end : 0);
    d.loopsPinned = pinned;
    d.loopsOn = on !== false;
    if (clock) {
      const c = clockOf(deck);
      clock.setLoops(d.loopsOn, !c.paused ? c.cycleAt(engine.getTime()) : 0);
    }
    desk?.notify?.();
    return d.loopsOn;
  }

  function evaluate(code, { start = true, arrangeFrom = null, deck: deckIn = 'a', fresh = false, name = null } = {}) {
    eventLog.length = 0;
    const deck = deckName(deckIn);
    const keyOfBlock = (label) => (deck === 'a' ? label : `b:${label}`);
    const d = decks[deck];
    const blocks = patternCore.splitLabeledBlocks(code ?? '');
    if (blocks.length === 0) throw new Error('nothing to evaluate');
    desk?.noteBuffer?.(deck, { name, code });

    // Rewound before anything is built, so a seeded choose()/irand() is a function of where it
    // sits in the buffer rather than of how many times this page has evaluated. Without it a
    // stop and a replay would come back as a different performance of the same code.
    patternCore.resetRandomSeeds();
    patternCore.beginWidgets?.(deck); // the inline widgets this evaluation builds (see widgets)
    patternCore.setDefOwner(deck);
    const definitionsBefore = patternCore.clearRolls('buffer', deck);
    // Enter with no key in force: the buffer's own setscale is the only thing that sets one, or
    // the last song's key leaks into a song that never asked for one. Kept, for an evaluation
    // that fails to put back: the tracks still playing are still in that key.
    const scaleBefore = patternCore.globalScale();
    patternCore.setGlobalScale(null);
    // ...and the same for the buffer's feel (see setgroove below).
    const grooveBefore = patternCore.globalGroove();
    patternCore.restoreGlobalGroove(null);
    // The global scale and feel hold deck A's at rest (every reader outside an evaluation means
    // the main deck's), so a deck B evaluation borrows them and puts deck A's back however it ends.
    const putBackGlobals = () => {
      if (deck === 'a') return;
      patternCore.setGlobalScale(decks.a.scale ?? null);
      patternCore.restoreGlobalGroove(decks.a.groove ?? null);
    };

    let sawSetbpm = false;
    const hostBuilders = {
      // A deck's setbpm() is its NATIVE tempo, always recorded. Only deck A's drives the room's
      // clock, and not even that while the desk holds it - a DJ set's tempo is the desk's, and a
      // buffer's setbpm there is metadata (see the desk's clockHeld).
      setbpm: (value) => {
        const v = typeof value === 'string' ? patternCore.mini(value) : value;
        if (typeof v !== 'number' && typeof v?.sample !== 'function') {
          throw new Error('[transport] setbpm() takes a number or a signal (mini string / LFO / pattern)');
        }
        sawSetbpm = true;
        d.bpm = v;
        if (deck === 'a' && !desk?.clockHeld?.(deck)) transport.setBpm(v);
        return TEMPO_BLOCK;
      },
      setscale: (scaleName) => {
        patternCore.setGlobalScale(scaleName);
        return SCALE_BLOCK;
      },
      // The groove every track plays by where it sets no swing of its own. Global and hoisted on
      // the same terms as setscale: a document has one feel at a time.
      setgroove: (shape, depth) => {
        patternCore.setGlobalGroove(shape, depth === undefined ? 1 : depth);
        return GROOVE_BLOCK;
      },
      // Sample packs from a repository (remote-packs.mjs). The host reads every samples() in the
      // buffer before evaluating, so by here a literal one has usually been read already; this
      // starts one that was not, such as a name built at run time. A setup line, so it plays
      // nothing and returns nothing.
      samples: (source, prefix) => {
        if (!remotePacks) throw new Error('samples() needs the browser build\'s sample loader');
        remotePacks.use(source, prefix);
      },
    };
    const evalBlock = createBlockEvaluator(patternCore, { defs: new Map(prebakeDefs), hostBuilders, miniOff: patternCore.miniOffRanges(code ?? '') });

    // Which row a `clips()` written in this block plays (see pattern-core's clips()). Restores
    // whatever was in force rather than clearing, because these nest: a copy() resolves inside the
    // COPIER's build, and when it is done the copier's own row is the one still being built.
    const asBlock = (b, run) => {
      const was = patternCore.clipsOwnerNow?.() ?? { deck: 'a', label: null };
      patternCore.setClipsOwner?.(deck, b.label);
      try {
        return run();
      } finally {
        patternCore.setClipsOwner?.(was.deck, was.label);
      }
    };

    const byLabel = new Map(blocks.map((b) => [b.label, b]));
    patternCore.setCopyResolver((label, seen = new Set()) => {
      if (seen.has(label)) throw new Error(`copy("${label}") is inside itself`);
      const b = byLabel.get(label);
      if (!b) throw new Error(`there is no block called ${JSON.stringify(label)} to copy`);
      seen.add(label);
      try {
        return asBlock(b, () => evalBlock(b.code, b.start));
      } finally {
        seen.delete(label);
      }
    });

    const clipsBefore = d.arrangeClips;
    let evaluated;
    try {
      // setscale is HOISTED: the last one in the buffer is the key the whole buffer plays in,
      // patterns written above it included. Re-keying a patch mid-set is one edit wherever it is
      // made, rather than an edit that only takes effect downwards.
      const hoisted = new Map();
      for (const b of blocks) {
        if (!patternCore.isBareCallBlock(b.code, 'setscale')) continue;
        try {
          evalBlock(b.code, b.start);
          hoisted.set(b, SCALE_BLOCK);
        } catch {
          // not evaluable up here - it keeps its place in the pass below, and reports there
        }
      }
      // setgroove is hoisted on the same terms - the document's feel applies to the whole document.
      for (const b of blocks) {
        if (!patternCore.isBareCallBlock(b.code, 'setgroove')) continue;
        try {
          evalBlock(b.code, b.start);
          hoisted.set(b, GROOVE_BLOCK);
        } catch {
          // as above
        }
      }

      evaluated = blocks.map((b) => {
        try {
          const value = hoisted.has(b) ? hoisted.get(b) : asBlock(b, () => evalBlock(b.code, b.start));
          const isPattern = value instanceof patternCore.Sig;
          const setupValue = value === TEMPO_BLOCK || value === SCALE_BLOCK || value === GROOVE_BLOCK || value?.poptartArrangeBlock;
          // Only a NAMED block promises sound. Anything anonymous that makes none is a setup
          // block - declarations shared downward, a language extension, a side effect.
          if (!isPattern && !setupValue && !b.label.startsWith('$')) {
            throw new Error('must evaluate to a pattern (e.g. n("0 2 3").scale("F minor").synth("Wavetable"))');
          }
          if (!isPattern && !setupValue && b.kind === 'anon') {
            say(`[blocks] a $: block makes no sound (${b.code.trim().split('\n')[0].slice(0, 40)}) - $: is for a track you didn't name; setup needs no label at all`);
          }
          return { ...b, sig: value };
        } catch (err) {
          throw new Error(`${b.label}: ${err.message ?? err}`);
        }
      });

      // Only now, with every block evaluated, is any cycle built. A pattern resolves the rolls
      // and shapes it NAMES lazily, and the editor writes those definitions at the FOOT of the
      // buffer - so building a cycle inside the pass above would ask for definitions the pass
      // had not reached, and every drawn roll would report itself undefined on every evaluation.
      d.arrangeClips = arrangementClipsOf(evaluated);
      const cps = clockOf(deck)?.cps ?? 0.5;
      for (const b of evaluated) {
        if (!(b.sig instanceof patternCore.Sig)) continue;
        try {
          asBlock(b, () => dryRun(b.sig, cps));
        } catch (err) {
          throw new Error(`${b.label}: ${err.message ?? err}`);
        }
      }
    } catch (err) {
      // An evaluation that throws applies NOTHING: the tracks still playing must still find the
      // definitions they resolve by name each cycle.
      patternCore.setCopyResolver(null);
      patternCore.abandonWidgets?.(); // every control keeps the value it had
      d.arrangeClips = clipsBefore;
      patternCore.restoreRolls(definitionsBefore, 'buffer', deck);
      patternCore.setGlobalScale(scaleBefore);
      patternCore.restoreGlobalGroove(grooveBefore);
      patternCore.setDefOwner('a');
      throw err;
    }
    patternCore.setCopyResolver(null);
    const widgetsBuilt = patternCore.takeWidgets?.() ?? { inputs: [], views: [] };
    patternCore.setDefOwner('a');
    // What setscale() and setgroove() left in force are this deck's; the globals go back to deck A's.
    const scale = (d.scale = patternCore.globalScale());
    const sessionFeel = (d.groove = patternCore.globalGroove());
    putBackGlobals();
    const groove = sessionFeel ? { shape: sessionFeel.text, depth: sessionFeel.depth } : null;
    // A buffer with no setbpm() has the default as its native tempo; the clock itself simply
    // stays where it was.
    if (!sawSetbpm) d.bpm = null;

    const built = evaluated.filter((b) => b.sig instanceof patternCore.Sig && !b.sig.isDef);
    const groupTree = patternCore.treeOfBlocks(built);
    const routed = patternCore.routeGroups(built, keyOfBlock, groupTree);
    // What the desk shows: a track inside a real group is not its own channel - its group's
    // fader, gate and solo take it (see the desk's groupMembers).
    desk?.setGroupMembers?.(deck, [...routed.routedParents]
      .filter(([, parent]) => parent !== patternCore.GROUP_ROOT)
      .map(([label, parent]) => [keyOfBlock(label), keyOfBlock(parent)]));

    // A deck coming in under the desk's clock takes its tempo and place first (see the desk).
    desk?.beforeTracks?.(deck, { start: start !== false, fresh, running: deckRunning(deck) });

    // The arrangement pass: with an arrangement in the buffer every track is one of its rows and
    // plays only inside its clips, and a track with no clips is silent - which is what a row you
    // emptied has to mean.
    const arrangements = evaluated.map((b) => b.sig).filter((v) => v?.poptartArrangeBlock);
    const deckClock = clockOf(deck);
    if (arrangements.length) {
      const clips = arrangements.flatMap((a) => a.clips);
      const songEnd = patternCore.arrangementEnd(clips);
      const spans = patternCore.arrangementSpans(clips);
      const labels = new Set(built.map((b) => b.label));
      for (const label of spans.keys()) {
        if (!labels.has(label)) say(`[arrange] no block called ${JSON.stringify(label)} - its clips play nothing`);
      }
      const regions = arrangements.flatMap((a) => patternCore.arrangementLoops(a.clips, a.opts));
      const nowCycle = deckClock.cycleAt(engine.getTime());
      // An unarranged song loops whatever the desk's default says (see loopsDefault): asked on
      // every evaluation and reported only when it moves.
      const loops = loopsDefault(deck, d.loopsOn, regions, songEnd);
      if (loops !== d.loopsOn) {
        d.loopsOn = loops;
        if (desk?.on?.()) say(`[arrange] deck ${deck.toUpperCase()} is one loop over its whole length, so its regions stay armed - carve it into parts to play it through`);
      }
      // The clock is a function of the regions alone, so painting clips keeps it and changed
      // regions rebuild it where the old one stands.
      const clockKey = JSON.stringify(regions);
      if (d.arrangeClock?.key !== clockKey) {
        d.arrangeClock = d.arrangeClock
          ? d.arrangeClock.rebuilt({ regions }, nowCycle)
          : new patternCore.ArrangeClock({ regions, loopsOn: d.loopsOn });
        d.arrangeClock.key = clockKey;
      }
      d.arrangeClock.setLoops?.(d.loopsOn, nowCycle); // the deck's loop toggle outlives any one clock
      d.arrangeClock.setEnd(songEnd);
      d.arrangeClips = clips;

      // Where this deck's song starts from: the painter's marker, else the top. A deck JOINING a
      // clock the other deck already has running starts its song too, at the room's place in the
      // bar, so the two decks' bar lines agree. Only for a deck that is not already playing - an
      // evaluation mid-song leaves the playhead where it is.
      const stopped = !deckRunning(deck);
      const from = stopped && arrangeFrom != null && Number.isFinite(Number(arrangeFrom)) ? Number(arrangeFrom) : null;
      const joining = !deckClock.paused && stopped;
      if (from != null || joining) {
        const at = d.arrangeClock.seek(nowCycle, (from ?? 0) + (joining ? nowCycle - Math.floor(nowCycle) : 0));
        if (from != null) say(`[arrange] playing from bar ${Math.round(at * 100) / 100}`);
      }

      for (const b of built) {
        const painted = spans.get(b.label);
        // A bare column-0 pattern is setup that happens to make a sound and has no row, so it
        // can never have been emptied on purpose. A group with nothing painted passes through
        // too: its sound is its members, who gate themselves on rows of their own.
        if (!painted && (b.kind === 'bare' || routed.groups.has(b.label))) continue;
        if (patternCore.isRowlessBlock(b)) continue;
        // An ordinary track reads the song through a clock of its own: inside each clip the
        // pattern starts where the clip does, and between them it is not read at all - so that
        // clock is its gate as well. A clips() track and a painted group stay on the deck clock.
        if (b.sig.clipsHead || routed.groups.has(b.label)) b.sig = b.sig._arrangeGate(painted ?? []);
        else b.trackClock = new patternCore.ClipClock(d.arrangeClock, patternCore.clipsOfLabel(clips, b.label));
      }
    } else {
      d.arrangeClock = null;
      d.arrangeClips = null;
      // No arrangement at all: nothing gates these tracks and nothing can stop them, so the
      // toggle reads ON whatever a mix asked for, because that is what the deck is doing.
      if (!d.loopsPinned) d.loopsOn = true;
    }

    // Mute and solo travel down the group tree, and solo travels up it as well: a soloed track is
    // only audible through the groups it mixes into. Mute wins over solo wherever it is written.
    const { isMuted, isSoloed, isMonitored } = patternCore.markerResolver(built, groupTree, routed.routedParents);
    const anySolo = built.some((b) => isSoloed(b) && !isMuted(b));

    // Monitor (`M`): a monitored block is a track of its own (`bass~M`) beside an unmarked one of
    // the same name, and dropping the `M` re-keys it onto the plain name in place of the original
    // (see the desktop server's eval, and patternCore.trackNames).
    const cuedKey = (label) => keyOfBlock(`${label}${patternCore.MONITOR_SUFFIX}`);
    const names = d.monitorPicker.names(built, (label) => schedulers.has(cuedKey(label)));
    const keyOf = (b) => keyOfBlock(names.nameOf(b));
    const keyOfLabel = new Map(built.map((b) => [b.label, keyOf(b)]));
    const active = built.filter((b) => !isMuted(b) && (!anySolo || isSoloed(b)) && !names.shadowed.has(b));
    for (const { from, to } of names.handed.map((label) => ({ from: cuedKey(label), to: keyOfBlock(label) }))) {
      if (!active.some((b) => keyOf(b) === to)) continue;
      const old = schedulers.get(to);
      if (old) old.stop();
      if (trackIds.has(to)) engine.destroyTrack?.(trackIds.get(to));
      rekey(from, to);
    }
    for (const b of active) if (b.monitored) b.sig = patternCore.monitorSig(b.sig);
    const cued = active.filter((b) => b.monitored).map((b) => b.label);
    if (cued.length && !desk?.cueRouted?.()) {
      say(`[${cued.join(', ')}] M plays to the headphone cue, and no cue output is set in the audio settings - not heard`);
    }

    // Tracks whose label disappeared, or that are now muted or un-soloed, stop - within THIS deck
    // only: the other deck's tracks are not in this buffer.
    for (const [key, sch] of [...schedulers]) {
      if (deckOfKey(key) !== deck) continue;
      if (active.some((b) => keyOf(b) === key)) continue;
      sch.stop();
      schedulers.delete(key);
    }

    // A fresh buffer - a file opened into the editor, not an edit of the one playing - takes down
    // every track this deck kept warm for a label the new code never mentions.
    if (fresh) {
      const claimed = new Set(built.map(keyOf));
      for (const key of [...trackIds.keys()]) {
        if (deckOfKey(key) !== deck || claimed.has(key) || desk?.isSongKey?.(key)) continue;
        schedulers.get(key)?.stop();
        schedulers.delete(key);
        dropTrack(key);
      }
    }

    let scheduleFrom = deckClock.cycleAt(engine.getTime());
    const starting = active.length > 0 && start !== false && transport.paused;
    const toStart = [];

    for (const b of active) {
      const key = keyOf(b);
      const tid = claimTrack(key);
      let sch = schedulers.get(key);
      // A new track is born wearing the desk as it stands - a queued deck arrives at the desk's
      // gains, not at full level (see the desk's birthFor).
      desk?.gateNewStem?.(key, deck, !sch);
      engine.createTrack(tid, desk?.birthFor?.(key) ?? null);
      if (!sch) {
        sch = new patternCore.Scheduler(engine, { transport: clockOf(deck), trackId: tid, label: key, deck });
        schedulers.set(key, sch);
      } else if (!sch.running && starting) {
        // Play after stop: stop leaves tails ringing on purpose, and the restart is what hushes
        // them, or the tail of the last run plays under the first notes of this one.
        engine.hush(tid);
      }
      sch.setSongClock(b.trackClock ?? d.arrangeClock);
      sch.setPattern(b.sig);
      desk?.applyTo?.(key);
      if (starting) toStart.push(sch);
      else sch.start(scheduleFrom);
    }

    for (const k of [...hlTracks.keys()]) if (deckOfKey(k) === deck) hlTracks.delete(k);
    for (const b of active) {
      hlTracks.set(keyOf(b), { sig: b.sig, start: b.start, end: b.end, clock: b.trackClock ?? d.arrangeClock });
    }
    const gridFrom = Math.max(0, Math.floor(deckClock.cycleAt(deckClock.getTime())));

    // What a sampler track plays, in the desktop's shape (see trackSampleInfo in server.js): the
    // first file it sounds and its length after .fit(). The length is known once the file has
    // decoded - which a pack played for the first time has not, on its first eval.
    const trackSampleInfo = (sig) => {
      const sources = patternCore.sampleSourcesOf(sig, { cycles: 4 });
      if (!sources.length) return null;
      const { ref, index, fit, bank } = sources[0];
      const out = { ref, index, fit, others: sources.length - 1, file: null, path: null, count: 0, seconds: null, cycles: null };
      // A .bank() pack where there is one, as the engine plays it (web-audio-engine's _bankPack).
      const banked = bank && engine.samples?.knows?.(`${bank}_${ref}`) ? `${bank}_${ref}` : ref;
      let got = null;
      if (ref.startsWith('rec:')) {
        const held = engine.samples?.named?.('rec', ref.slice(4));
        got = held ? { file: `${ref.slice(4)}.wav`, index: 0, count: 1, seconds: (held.buffer ?? held)?.duration ?? null } : null;
      } else {
        got = engine.samples?.describe?.(banked.startsWith('sp:') ? banked.slice(3) : banked, index) ?? null;
      }
      if (!got?.file) return { ...out, count: got?.count ?? 0 };
      return { ...out, ...got, cycles: patternCore.fittedCycles(got.seconds, deckClock.cps > 0 ? 1 / deckClock.cps : 0, fit) };
    };

    // Every track, playing or not, in the shape the editor's track list reads: the muted ones
    // are drawn with a badge rather than left out, and the chain is `instrument` plus `fxChain`
    // because that is what it concatenates. `key` is what the track is called here - deck B's
    // are "b:<label>".
    const tracks = built.map((b) => {
      const playing = active.includes(b);
      return {
        label: b.label,
        key: keyOf(b),
        muted: isMuted(b),
        soloed: isSoloed(b),
        monitored: isMonitored(b),
        shadowed: names.shadowed.has(b),
        active: playing,
        start: b.start,
        end: b.end,
        color: b.sig.trackColor ?? null, // its .color(): how the editor draws it (see client.js's trackColor)
        instrument: b.sig.instrument ?? null,
        fxChain: [...(b.sig.fxChain ?? [])],
        route: patternCore.routeSlots?.(b.sig) ?? null,
        sample: b.sig.sampler ? trackSampleInfo(b.sig) : null,
        paramNames: paramLabels(b.sig),
        grid: playing ? highlightGrid(patternCore, b.sig, b.start, b.end, gridFrom, HL_WINDOW, b.trackClock ?? d.arrangeClock) : null,
      };
    });

    // The clock starts LAST - after every track is set up and every grid is built - so that the
    // synchronous work above does not run while the clock is already moving. Started earlier,
    // everything due by the time the first scheduler could tick reached the engine late and
    // played in one bunch on the downbeat.
    if (starting) {
      // A lookahead ahead of now, so the first cycle's events are scheduled before the clock
      // reaches them. The schedulers open their windows AT that cycle rather than at wherever
      // the clock has got to, which is what keeps the downbeat on the downbeat.
      const at = engine.getTime() + START_LEAD_SEC;
      if (!desk?.transportStart?.(at)) transport.start(at);
      scheduleFrom = deckClock.cycleAt(at);
      for (const sch of toStart) sch.start(scheduleFrom);
    }
    tellTempo();
    desk?.afterEvaluate?.(deck);

    return {
      cps: deckClock.cps,
      transport: transportForEditor(),
      deckTransport: deckClocksForEditor(),
      scale,
      groove, // what setgroove() left in force - the editor's groove control shows it
      arrange: d.arrangeClock ? d.arrangeClock.snapshot() : null,
      deck,
      deckBpm: nativeBpm(deck),
      gridFrom,
      gridCount: HL_WINDOW,
      tracks,
      // The inline widgets: each control with what the code set it to, each display with what it
      // shows - and, for a display worked out from its pattern, the data, from the grid's cycle.
      widgets: widgets?.afterEval(deck, widgetsBuilt, built, {
        keyOf: (label) => keyOfLabel.get(label) ?? keyOfBlock(label),
        clockOf: (b) => b.trackClock ?? d.arrangeClock,
        from: gridFrom,
      }) ?? null,
      log: [...eventLog],
    };
  }

  /**
   * A deck's native tempo as the desk sees it: what its code declared, or the 120 an undeclared
   * buffer plays at. A signal-driven setbpm() has no single number, and reads as null.
   */
  function nativeBpm(deck) {
    const bpm = decks[deckName(deck)].bpm;
    if (typeof bpm === 'number') return bpm;
    return bpm == null ? 120 : null;
  }

  /** The editor computes a clock's position from the wall clock; this one runs on the context's. */
  const clockOffset = () => Date.now() / 1000 - engine.getTime();

  /**
   * The transport as the editor mirrors it.
   *
   * The editor computes the playhead from Date.now() against the snapshot's base time, because
   * on the desktop the engine's clock IS the wall clock. Here the engine's clock is the audio
   * context's own, which starts near zero when the page opens - so a snapshot handed over as is
   * puts the playhead fifty-odd years ahead of the music, and nothing ever lights. The base is
   * moved onto the wall clock here, once, on the way out; every time inside the host stays on
   * the context's clock, which is the one the sound is scheduled on.
   */
  function transportForEditor(clock = transport) {
    if (!clock) return null;
    const snap = clock.snapshot();
    const offset = clockOffset();
    // The offset travels too: a free-running ("0.5hz") LFO is anchored on the engine's seconds,
    // and the editor's picture of its phase has to count the same seconds.
    return { ...snap, baseSec: snap.baseSec + offset, clockOffset: offset };
  }

  /** Both decks' own clocks the same way, where the desk gives them clocks of their own. */
  function deckClocksForEditor() {
    if (!desk?.clockOf) return { a: null, b: null };
    return Object.fromEntries(DECKS.map((dk) => {
      const c = desk.clockOf(dk);
      return [dk, c && c !== transport ? transportForEditor(c) : null];
    }));
  }

  /** Every clip the buffer's arrangements carry, or null when it has none at all. */
  function arrangementClipsOf(evaluatedBlocks) {
    const found = evaluatedBlocks.map((b) => b.sig).filter((v) => v?.poptartArrangeBlock);
    return found.length ? found.flatMap((a) => a.clips) : null;
  }

  /** A later window of the same grid, for the editor's scroll-ahead - one deck's, or every one. */
  function highlightWindow(from, count, deck = null) {
    const base = Math.max(0, Math.floor(from));
    const span = Math.min(HL_WINDOW * 4, Math.max(1, Math.floor(count) || HL_WINDOW));
    const only = deck === 'a' || deck === 'b' ? deck : null;
    const tracks = [];
    for (const [label, t] of hlTracks) {
      if (only && deckOfKey(label) !== only) continue;
      tracks.push({ label, grid: highlightGrid(patternCore, t.sig, t.start, t.end, base, span, t.clock ?? decks[deckOfKey(label)].arrangeClock) });
    }
    return { gridFrom: base, gridCount: span, tracks };
  }

  /**
   * The devices on the grid - a synced delay, a ducker, a beat repeat - hear the tempo and where
   * cycle zero sits on the audio clock, from the transport itself rather than from a copy.
   */
  function tellTempo() {
    if (typeof engine.setTempo !== 'function' || !transport) return;
    // With a desk, a deck on a clock of its own tells its own tracks its own tempo.
    if (desk?.tellTempo) desk.tellTempo();
    else engine.setTempo(transport.cps * 240, transport.secAt(0));
  }
  if (transport) {
    transport.onCpsChange = () => {
      tellTempo();
      desk?.onCpsChange?.(); // rate-locked songs ride the clock through every step of a ramp
    };
  }

  /**
   * Stops playback: one deck's, or with none named, everything. A deck's schedulers stop and its
   * tracks stay warm, and the room's clock runs on for the other deck; only when nothing is left
   * playing anywhere does it become the full stop that rewinds the clock. `hush` takes the
   * deck's voices too rather than letting them ring - an audition ending as the finger comes up.
   */
  function stop(deck = null, { hush = false } = {}) {
    if (deck === 'a' || deck === 'b') {
      for (const [key, sch] of schedulers) {
        if (deckOfKey(key) !== deck) continue;
        sch.stop();
        if (hush) engine.hush?.(trackIds.get(key) ?? key);
      }
      desk?.deckStopped?.(deck);
      const otherPlaying = [...schedulers].some(([key, sch]) => deckOfKey(key) !== deck && sch.running)
        || !!desk?.othersSounding?.(deck);
      if (otherPlaying) {
        desk?.notify?.();
        return { deck, transport: null, deckTransport: deckClocksForEditor() };
      }
    }
    for (const sch of schedulers.values()) sch.stop();
    desk?.allStopped?.();
    transport.stop();
    for (const dk of DECKS) decks[dk].arrangeClock?.reset();
    desk?.notify?.();
    return { transport: transportForEditor(), deckTransport: deckClocksForEditor() };
  }

  /** Forgets a track completely: its scheduler, its engine track and its highlight. */
  function dropTrack(key) {
    schedulers.get(key)?.stop();
    schedulers.delete(key);
    const id = trackIds.get(key);
    if (id) engine.destroyTrack?.(id);
    trackIds.delete(key);
    hlTracks.delete(key);
    desk?.forgetKey?.(key);
  }

  /** Everything filed under `from` answers to `to` from here on. The engine is never touched. */
  function rekey(from, to) {
    const id = trackIds.get(from);
    trackIds.delete(from);
    if (id) trackIds.set(to, id);
    const sch = schedulers.get(from);
    if (sch) {
      schedulers.delete(from);
      schedulers.set(to, sch);
      sch.label = to;
      sch.deck = deckOfKey(to);
    }
    const hl = hlTracks.get(from);
    if (hl) {
      hlTracks.delete(from);
      hlTracks.set(to, hl);
    }
    desk?.rekeyKey?.(from, to);
  }

  /**
   * Empties one deck - a pane loading a different song: its schedulers stop, its tracks are
   * destroyed, and its song facts and definitions go. The other deck is untouched.
   */
  function clearDeck(deck) {
    const dk = deckName(deck);
    for (const key of [...trackIds.keys()]) if (deckOfKey(key) === dk && !desk?.isSongKey?.(key)) dropTrack(key);
    for (const key of [...schedulers.keys()]) if (deckOfKey(key) === dk) dropTrack(key);
    const keepLoops = { loopsOn: decks[dk].loopsOn };
    decks[dk] = { ...newDeck(), ...keepLoops };
    if (dk === 'a') {
      patternCore.setGlobalScale(null); // the resting scale was this deck's fact
      patternCore.restoreGlobalGroove(null); // ...and so was the resting feel
    }
    patternCore.clearRolls('buffer', dk);
  }

  /**
   * Deck B becomes deck A - the end of a mix that keeps the incoming song. Deck A's tracks are
   * destroyed; deck B's are re-keyed to plain labels with nothing in the engine touched, so the
   * music does not blink. Returns the labels promoted.
   */
  function promote() {
    const promoted = [...schedulers.keys()].filter((k) => deckOfKey(k) === 'b');
    for (const key of [...trackIds.keys()]) if (deckOfKey(key) === 'a' && !desk?.isSongKey?.(key)) dropTrack(key);
    for (const key of [...schedulers.keys()]) if (deckOfKey(key) === 'a') dropTrack(key);
    for (const key of promoted) rekey(key, key.slice(key.indexOf(':') + 1));
    for (const key of [...trackIds.keys()]) if (deckOfKey(key) === 'b' && !desk?.isSongKey?.(key)) dropTrack(key);
    decks.a = { ...decks.b, monitorPicker: decks.b.monitorPicker };
    decks.b = newDeck();
    patternCore.setGlobalScale(decks.a.scale ?? null);
    patternCore.restoreGlobalGroove(decks.a.groove ?? null);
    patternCore.clearRolls('buffer', 'a'); // the outgoing song's definitions
    patternCore.adoptDefs?.('b', 'a'); // the promoted song's are the main deck's now
    return promoted.map((k) => k.slice(k.indexOf(':') + 1));
  }

  return {
    evaluate,
    highlightWindow,
    stop,
    transportForEditor,
    deckClocksForEditor,
    schedulers,
    trackIds,
    hlTracks,
    widgets,
    claimTrack,
    dropTrack,
    rekey,
    clearDeck,
    promote,
    setLoops,
    deckRunning,
    nativeBpm,
    facts: (deck) => decks[deckName(deck)],
    arrangeClockOf: (deck) => decks[deckName(deck)].arrangeClock,
    loopsOf: (deck) => decks[deckName(deck)].loopsOn,
    clockOf,
    get arrangeClock() { return decks.a.arrangeClock; },
    get arrangeClips() { return decks.a.arrangeClips; },
    tellTempo,
    get log() { return [...eventLog]; },
  };
}
