// Turning a buffer into music, in a browser.
//
// This is the browser's `/api/evaluate`, and it follows the desktop's order of operations
// closely enough that the comments there explain the ones here. The order is not incidental:
// several steps only work because of where they sit, and each of those is noted where it stands.
//
// WHAT IS NOT HERE, and why. There is one performance deck rather than two, because the second
// deck belongs to the DJ side and that stays on the desktop - so a scheduler's key is simply the
// block's label, and every `keyOfBlock` the desktop needs disappears. There is no plugin capture,
// because there are no plugin windows to capture from; no sample-pack definition over a wire,
// because the packs are objects in this process; no MIDI or OSC enable, because neither is wired
// up yet and the engine says so itself. What remains is the pattern language, which is the part
// both builds share and the part that must not differ.

import { createBlockEvaluator, SCALE_BLOCK, TEMPO_BLOCK } from './block-eval.mjs';

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
      return [s, ...(ir.shapePattern ? [ir.shapePattern] : []), ...bounds];
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
        const startShift = patternCore.timeShift(s, sub.noteChannels, at, 1, at);
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
        const endShift = patternCore.timeShift(endStep, sub.noteChannels, endAt, 1, endAt);
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

/**
 * The evaluator, and the state a buffer leaves behind between evaluations.
 *
 * That state is the reason this is a factory rather than a function: a scheduler outlives the
 * evaluation that made it, and so do the engine track ids, the song clock and the definitions
 * the buffer declared. An evaluation that rebuilt them would cut every sound on every keystroke.
 */
export function createEvaluator({ patternCore, engine, transport, prebakeDefs = new Map(), log = null, remotePacks = null }) {
  const schedulers = new Map();        // label -> Scheduler
  const trackIds = new Map();          // label -> engine track id
  // The engine keys its tracks by those ids, and every routing name a pattern carries is the
  // LABEL somebody typed - audio("kick"), a group reading its members, a signal patched onto a
  // parameter. Handing it the lookup is what makes those names resolve; without it they warn
  // about a name that is plainly in the buffer. (The desktop does this in its engine wrapper.)
  engine.setTrackResolver?.((label) => trackIds.get(label) ?? label);
  const hlTracks = new Map();          // label -> { sig, start, end, clock }
  const eventLog = [];
  let nextTrackNum = 1;
  let arrangeClock = null;
  let arrangeClips = null;
  let clipsMemo = { src: null, rows: new Map() };

  const say = (line) => {
    eventLog.push(line);
    if (log) log(line);
  };

  /**
   * Engine track ids are minted here and nowhere else. A label that no evaluation has seen
   * passes through as itself, and the engine ignores it the way it ignores anything aimed at a
   * track that does not exist - which is better than allocating a ghost track for a typo.
   */
  function claimTrack(label) {
    let id = trackIds.get(label);
    if (!id) {
      id = `#${nextTrackNum++}`;
      trackIds.set(label, id);
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
  patternCore.setClipsResolver((_deck, label) => {
    const NONE = { clips: [], arranged: false };
    if (!arrangeClips) return NONE;
    if (clipsMemo.src !== arrangeClips) clipsMemo = { src: arrangeClips, rows: new Map() };
    let row = clipsMemo.rows.get(label);
    if (!row) {
      row = { clips: patternCore.clipsOfLabel(arrangeClips, label), arranged: true };
      clipsMemo.rows.set(label, row);
    }
    return row;
  });

  /** Builds a few cycles up front, so a broken pattern reports in the buffer and not mid-set. */
  function dryRun(sig) {
    const cps = transport?.cps ?? 0.5;
    for (const s of patternSigs(sig)) {
      if (s.stepsForCycle) for (let cycle = 0; cycle < DRY_RUN_CYCLES; cycle++) s.stepsForCycle(cycle);
      s.sample?.(0, cps, 0);
    }
  }

  function evaluate(code, { start = true, arrangeFrom = null } = {}) {
    eventLog.length = 0;
    const blocks = patternCore.splitLabeledBlocks(code ?? '');
    if (blocks.length === 0) throw new Error('nothing to evaluate');

    // Rewound before anything is built, so a seeded choose()/irand() is a function of where it
    // sits in the buffer rather than of how many times this page has evaluated. Without it a
    // stop and a replay would come back as a different performance of the same code.
    patternCore.resetRandomSeeds();
    patternCore.setDefOwner('a');
    const definitionsBefore = patternCore.clearRolls('buffer', 'a');
    // Enter with no key in force: the buffer's own setscale is the only thing that sets one, or
    // the last song's key leaks into a song that never asked for one. Kept, for an evaluation
    // that fails to put back: the tracks still playing are still in that key.
    const scaleBefore = patternCore.globalScale();
    patternCore.setGlobalScale(null);

    let sawSetbpm = false;
    const hostBuilders = {
      setbpm: (value) => {
        const v = typeof value === 'string' ? patternCore.mini(value) : value;
        if (typeof v !== 'number' && typeof v?.sample !== 'function') {
          throw new Error('[transport] setbpm() takes a number or a signal (mini string / LFO / pattern)');
        }
        sawSetbpm = true;
        transport.setBpm(v);
        return TEMPO_BLOCK;
      },
      setscale: (name) => {
        patternCore.setGlobalScale(name);
        return SCALE_BLOCK;
      },
      // Sample packs from a repository (remote-packs.mjs). The host reads every samples() in the
      // buffer before evaluating, so by here a literal one has usually been read already; this
      // starts one that was not, such as a name built at run time. A setup line, so it plays
      // nothing and returns nothing.
      samples: (source) => {
        if (!remotePacks) throw new Error('samples() needs the browser build\'s sample loader');
        remotePacks.use(source);
      },
    };
    const evalBlock = createBlockEvaluator(patternCore, { defs: new Map(prebakeDefs), hostBuilders });

    const byLabel = new Map(blocks.map((b) => [b.label, b]));
    patternCore.setCopyResolver((label, seen = new Set()) => {
      if (seen.has(label)) throw new Error(`copy("${label}") is inside itself`);
      const b = byLabel.get(label);
      if (!b) throw new Error(`there is no block called ${JSON.stringify(label)} to copy`);
      seen.add(label);
      try {
        return evalBlock(b.code, b.start);
      } finally {
        seen.delete(label);
      }
    });

    const clipsBefore = arrangeClips;
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

      evaluated = blocks.map((b) => {
        try {
          patternCore.setClipsOwner?.(b.label);
          const value = hoisted.has(b) ? hoisted.get(b) : evalBlock(b.code, b.start);
          const isPattern = value instanceof patternCore.Sig;
          const setupValue = value === TEMPO_BLOCK || value === SCALE_BLOCK || value?.poptartArrangeBlock;
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
      arrangeClips = arrangementClipsOf(evaluated);
      for (const b of evaluated) {
        if (!(b.sig instanceof patternCore.Sig)) continue;
        try {
          dryRun(b.sig);
        } catch (err) {
          throw new Error(`${b.label}: ${err.message ?? err}`);
        }
      }
    } catch (err) {
      // An evaluation that throws applies NOTHING: the tracks still playing must still find the
      // definitions they resolve by name each cycle.
      patternCore.setCopyResolver(null);
      arrangeClips = clipsBefore;
      patternCore.restoreRolls(definitionsBefore, 'buffer', 'a');
      patternCore.setGlobalScale(scaleBefore);
      throw err;
    }
    patternCore.setCopyResolver(null);
    const scale = patternCore.globalScale();
    if (!sawSetbpm) { /* the tempo simply stays where it was */ }

    const built = evaluated.filter((b) => b.sig instanceof patternCore.Sig && !b.sig.isDef);
    const groupTree = patternCore.treeOfBlocks(built);
    const routed = patternCore.routeGroups(built, (label) => label, groupTree);

    // The arrangement pass: with an arrangement in the buffer every track is one of its rows and
    // plays only inside its clips, and a track with no clips is silent - which is what a row you
    // emptied has to mean.
    const arrangements = evaluated.map((b) => b.sig).filter((v) => v?.poptartArrangeBlock);
    if (arrangements.length) {
      const clips = arrangements.flatMap((a) => a.clips);
      const songEnd = patternCore.arrangementEnd(clips);
      const spans = patternCore.arrangementSpans(clips);
      const labels = new Set(built.map((b) => b.label));
      for (const label of spans.keys()) {
        if (!labels.has(label)) say(`[arrange] no block called ${JSON.stringify(label)} - its clips play nothing`);
      }
      const regions = arrangements.flatMap((a) => patternCore.arrangementLoops(a.clips, a.opts));
      const nowCycle = transport.cycleAt(engine.getTime());
      // The clock is a function of the regions alone, so painting clips keeps it and changed
      // regions rebuild it where the old one stands.
      const clockKey = JSON.stringify(regions);
      if (arrangeClock?.key !== clockKey) {
        arrangeClock = arrangeClock
          ? arrangeClock.rebuilt({ regions }, nowCycle)
          : new patternCore.ArrangeClock({ regions });
        arrangeClock.key = clockKey;
      }
      arrangeClock.setEnd(songEnd);
      arrangeClips = clips;

      const stopped = ![...schedulers.values()].some((s) => s.running);
      const from = stopped && arrangeFrom != null && Number.isFinite(Number(arrangeFrom)) ? Number(arrangeFrom) : null;
      if (from != null) {
        const at = arrangeClock.seek(nowCycle, from);
        say(`[arrange] playing from bar ${Math.round(at * 100) / 100}`);
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
        else b.trackClock = new patternCore.ClipClock(arrangeClock, patternCore.clipsOfLabel(clips, b.label));
      }
    } else {
      arrangeClock = null;
      arrangeClips = null;
    }

    // Mute and solo travel down the group tree, and solo travels up it as well: a soloed track is
    // only audible through the groups it mixes into. Mute wins over solo wherever it is written.
    const { isMuted, isSoloed } = patternCore.markerResolver(built, groupTree, routed.routedParents);
    const anySolo = built.some((b) => isSoloed(b) && !isMuted(b));
    const active = built.filter((b) => !isMuted(b) && (!anySolo || isSoloed(b)));

    // Tracks whose label disappeared, or that are now muted or un-soloed, stop.
    for (const [label, sch] of [...schedulers]) {
      if (active.some((b) => b.label === label)) continue;
      sch.stop();
      schedulers.delete(label);
    }

    let scheduleFrom = transport.cycleAt(engine.getTime());
    const starting = active.length > 0 && start !== false && transport.paused;
    const toStart = [];

    for (const b of active) {
      const label = b.label;
      const tid = claimTrack(label);
      let sch = schedulers.get(label);
      engine.createTrack(tid);
      if (!sch) {
        sch = new patternCore.Scheduler(engine, { transport, trackId: tid, label });
        schedulers.set(label, sch);
      } else if (!sch.running && starting) {
        // Play after stop: stop leaves tails ringing on purpose, and the restart is what hushes
        // them, or the tail of the last run plays under the first notes of this one.
        engine.hush(tid);
      }
      sch.setSongClock(b.trackClock ?? arrangeClock);
      sch.setPattern(b.sig);
      if (starting) toStart.push(sch);
      else sch.start(scheduleFrom);
    }

    hlTracks.clear();
    for (const b of active) {
      hlTracks.set(b.label, { sig: b.sig, start: b.start, end: b.end, clock: b.trackClock ?? arrangeClock });
    }
    const gridFrom = Math.floor(transport.cycleAt(transport.getTime()));

    // Every track, playing or not, in the shape the editor's track list reads: the muted ones
    // are drawn with a badge rather than left out, and the chain is `instrument` plus `fxChain`
    // because that is what it concatenates.
    const tracks = built.map((b) => {
      const playing = active.includes(b);
      return {
        label: b.label,
        key: b.label,
        muted: isMuted(b),
        soloed: isSoloed(b),
        active: playing,
        start: b.start,
        end: b.end,
        instrument: b.sig.instrument ?? null,
        fxChain: [...(b.sig.fxChain ?? [])],
        paramNames: paramLabels(b.sig),
        grid: playing ? highlightGrid(patternCore, b.sig, b.start, b.end, gridFrom, HL_WINDOW, b.trackClock ?? arrangeClock) : null,
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
      transport.start(at);
      scheduleFrom = transport.cycleAt(at);
      for (const sch of toStart) sch.start(scheduleFrom);
    }
    tellTempo();

    return {
      cps: transport.cps,
      transport: transportForEditor(),
      scale,
      arrange: arrangeClock ? arrangeClock.snapshot() : null,
      gridFrom,
      gridCount: HL_WINDOW,
      tracks,
      log: [...eventLog],
    };
  }

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
  function transportForEditor() {
    const snap = transport.snapshot();
    const clockOffset = Date.now() / 1000 - engine.getTime();
    // The offset travels too: a free-running ("0.5hz") LFO is anchored on the engine's seconds,
    // and the editor's picture of its phase has to count the same seconds.
    return { ...snap, baseSec: snap.baseSec + clockOffset, clockOffset };
  }

  /** Every clip the buffer's arrangements carry, or null when it has none at all. */
  function arrangementClipsOf(evaluatedBlocks) {
    const found = evaluatedBlocks.map((b) => b.sig).filter((v) => v?.poptartArrangeBlock);
    return found.length ? found.flatMap((a) => a.clips) : null;
  }

  /** A later window of the same grid, for the editor's scroll-ahead. */
  function highlightWindow(from, count) {
    const base = Math.max(0, Math.floor(from));
    const span = Math.min(HL_WINDOW * 4, Math.max(1, Math.floor(count) || HL_WINDOW));
    const tracks = [];
    for (const [label, t] of hlTracks) {
      tracks.push({ label, grid: highlightGrid(patternCore, t.sig, t.start, t.end, base, span, t.clock) });
    }
    return { gridFrom: base, gridCount: span, tracks };
  }

  /** Stops everything and rewinds, which is what the transport's stop means. */
  /**
   * The devices on the grid - a synced delay, a ducker, a beat repeat - hear the tempo and where
   * cycle zero sits on the audio clock, from the transport itself rather than from a copy.
   */
  function tellTempo() {
    if (typeof engine.setTempo !== 'function' || !transport) return;
    engine.setTempo(transport.cps * 240, transport.secAt(0));
  }
  if (transport) transport.onCpsChange = () => tellTempo();

  function stop() {
    for (const sch of schedulers.values()) sch.stop();
    transport.stop();
    arrangeClock?.reset();
    return { transport: transportForEditor() };
  }

  return {
    evaluate,
    highlightWindow,
    stop,
    transportForEditor,
    schedulers,
    trackIds,
    hlTracks,
    get arrangeClock() { return arrangeClock; },
    get arrangeClips() { return arrangeClips; },
    get log() { return [...eventLog]; },
  };
}
