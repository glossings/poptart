// Triggers from things that are not step patterns: the rising edges of a 0/1 signal, and the
// presses of a drawn button() - what .struct() and .advance() take their rhythm from when they are
// handed a signal rather than a rhythm.
//
// Either way an edge becomes a trigger on the NEXT step of a grid (sixteen a cycle unless the call
// says otherwise), so a press is in time however it was played, and two edges inside one step are
// one trigger. Each trigger lasts its step.
//
//   - A signal (square(), a drawn shape, a recorded button take) is read for its edges where it is
//     asked, so the same cycle always has the same triggers and a seek lands where it should.
//   - A live button is pressed in real time, after the scheduler may already have sent the step
//     the press is nearest. A press is kept with the moment it happened, and the first time a
//     scheduler reads the button after that it is given the first step that scheduler has not sent
//     yet - and keeps it, so every later read agrees on where it went.
//
// Nothing here knows about Sig: signal.mjs asks for edges and steps, widgets.mjs feeds presses.

import { parseCells, toggleCell, restRow } from './widget-calls.mjs';

/** Steps per cycle a trigger lands on when the call names no grid: sixteenths. */
export const TRIGGER_GRID = 16;

// How far past a step, as a fraction of a step, an edge can sit and still count as that step: a
// press written into a shape with its x rounded is not pushed onto the step after.
const STEP_TOL = 1e-3;

// How finely a signal is read for its edges, in readings per step. An edge is found at the first
// reading at or after it, so a reading falls on every step and a pulse narrower than a reading
// can slip between two of them.
const READS_PER_STEP = 16;

/** A grid argument as steps per cycle: a positive whole number, TRIGGER_GRID when not given. */
export function triggerGrid(grid) {
  if (grid == null) return TRIGGER_GRID;
  const n = Math.round(Number(grid));
  if (!Number.isFinite(n) || n < 1) throw new Error(`[signal] a trigger grid is a number of steps per cycle, like 16 (got ${JSON.stringify(grid)})`);
  return n;
}

/** The step (an index on the grid) an edge at cycle position `pos` triggers on: the next one. */
export function triggerStep(pos, grid) {
  return Math.ceil(pos * grid - STEP_TOL);
}

/**
 * The rising edges of `read(pos)` - where it crosses 0.5 going up - at positions in [from, to),
 * read READS_PER_STEP times a step. A reading that is not a number counts as 0.
 */
export function sampledEdges(read, from, to, grid) {
  const per = grid * READS_PER_STEP;
  const high = (i) => {
    const v = Number(read(i / per));
    return Number.isFinite(v) && v >= 0.5;
  };
  const out = [];
  const first = Math.ceil(from * per - 1e-9);
  let was = high(first - 1);
  for (let i = first; i / per < to; i++) {
    const now = high(i);
    if (now && !was) out.push(i / per);
    was = now;
  }
  return out;
}

/**
 * The stretches where a shape's breakpoints sit at 0.5 or above, as [x0, x1] pairs over 0..1 in
 * order. A straight segment crosses where its line does; a step (two breakpoints at one x) crosses
 * there.
 */
export function shapePulses(points) {
  if (!points?.length) return [];
  const on = (p) => p.y >= 0.5;
  const out = [];
  let open = on(points[0]) ? points[0].x : null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (on(a) === on(b)) continue;
    const x = b.x === a.x ? a.x : a.x + ((0.5 - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (on(b)) open = x;
    else {
      out.push([open, x]);
      open = null;
    }
  }
  if (open !== null) out.push([open, points[points.length - 1].x]);
  return out;
}

/**
 * The rising edges of a looping shape - `points` over 0..1, played once every `cycles` cycles in
 * step with the transport - at positions in [from, to). Exact: read off the breakpoints, so a
 * press as short as the shape can hold is still an edge. A pulse running into the loop's end and
 * one starting it are one pulse across the seam, with no edge at 0.
 */
export function shapeEdges(points, cycles, from, to) {
  const pulses = shapePulses(points);
  if (!pulses.length || !(cycles > 0)) return [];
  const wraps = pulses.length && pulses[0][0] <= 0 && pulses[pulses.length - 1][1] >= 1;
  const xs = pulses.map((p) => p[0]).filter((x) => x < 1 && !(x <= 0 && wraps));
  const out = [];
  for (let loop = Math.floor(from / cycles); loop * cycles < to; loop++) {
    for (const x of xs) {
      const pos = (loop + x) * cycles;
      if (pos >= from && pos < to) out.push(pos);
    }
  }
  return out;
}

/**
 * Edges as the triggers of cycle `cycle`: `[{ start, end, value: 1 }]`, one per step at most,
 * `start` a phase in the cycle. `edges` has to reach back a step before the cycle, since an edge
 * there lands on its first step.
 */
export function edgeSteps(edges, cycle, grid) {
  const seen = new Set();
  const out = [];
  for (const edge of edges) {
    // An edge is a position, or `{ at, loc }` when it comes from a cell the highlighter can light.
    const e = typeof edge === 'number' ? edge : edge.at;
    const s = triggerStep(e, grid) - cycle * grid + 0; // never -0
    if (s < 0 || s >= grid || seen.has(s)) continue;
    seen.add(s);
    const step = { start: s / grid, end: (s + 1) / grid, value: 1 };
    if (edge.loc) step.loc = edge.loc;
    out.push(step);
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------
// A live button's presses
// ---------------------------------------------------------------------------------------------

let clock = null; // { now: () => sec, cycleAt: (deck, sec) => cycle | null } - the host's

/** The host's clock, which a press is stamped with (motion.mjs's setMotionClock hands it on). */
export function setPressClock(c) {
  clock = c;
}

// Presses kept per button: enough to cover any lookahead, and the presses of a take being played.
const KEEP_PRESSES = 256;
const KEEP_CYCLES = 32;
// How long a press can wait for its first read, in cycles. A scheduler reads every few tens of
// milliseconds, so anything older was made while nothing was reading the button.
const STALE_CYCLES = 1;

// `${deck}:${at}` -> { deck, down, presses: [{ on, off, steps: Map(grid -> { step, n } | null) }],
// counts: Map(grid -> triggers given out) }
const logs = new Map();
let pressHook = null;
let downHook = null;

/** `fn(key, on, off)` when a button is let go: the press, in cycles on its deck's clock. */
export function onButtonPress(fn) {
  pressHook = fn;
}

/**
 * `fn(key)` when a button goes down; what it answers is kept with the press (see placedPresses) -
 * a recording button's take as it was before this press was laid into it.
 */
export function onButtonDown(fn) {
  downHook = fn;
}

/**
 * A button went down (`down` true) or came up, `agoSec` seconds before now. Stamped on its deck's
 * clock; nothing is kept while the deck is stopped, when a press is nowhere.
 */
export function notePress(key, deck, down, agoSec = 0) {
  if (!clock) return;
  const sec = clock.now() - (Number(agoSec) > 0 ? Number(agoSec) : 0);
  const pos = clock.cycleAt(deck, sec);
  if (!Number.isFinite(pos)) return;
  let log = logs.get(key);
  if (!log) logs.set(key, (log = { deck, down: null, presses: [], counts: new Map() }));
  if (down) {
    if (log.down) return;
    log.down = { on: pos, off: null, steps: new Map(), before: downHook ? downHook(key) : null };
    log.presses.push(log.down);
    while (log.presses.length > KEEP_PRESSES || (log.presses.length > 1 && log.presses[0].on < pos - KEEP_CYCLES)) log.presses.shift();
    return;
  }
  const press = log.down;
  if (!press) return;
  log.down = null;
  press.off = Math.max(press.on, pos);
  if (pressHook) pressHook(key, press.on, press.off);
}

/** Forgets the presses of `deck`'s buttons that are not in `keep` (an evaluation dropped them). */
export function forgetPresses(deck, keep) {
  for (const [key, log] of logs) if (log.deck === deck && !keep.has(key)) logs.delete(key);
}

// The window a scheduler is filling: { deck, from, to } in its transport cycles, and posAt(cycle)
// for where its pattern is at a transport cycle. Set only for the reads that send notes.
let scheduling = null;

/** Runs `fn` as a scheduler's read of the transport window [from, to) - see withPressWindow's use. */
export function withPressWindow(ctx, fn) {
  const was = scheduling;
  scheduling = ctx;
  try {
    return fn();
  } finally {
    scheduling = was;
  }
}

/** The window the scheduler is reading right now (see withPressWindow), or null for any other read. */
export function schedulingWindow() {
  return scheduling;
}

/**
 * The triggers a live button gives cycle `cycle` on `grid`: `[{ start, end, value: 1, n }]`, `n`
 * counting the triggers it has given out on that grid. A press not yet placed is placed by the
 * first scheduler read that sees it, on the first step that read has not sent; two presses
 * placed on one step are one trigger.
 */
export function pressSteps(key, cycle, grid) {
  const log = logs.get(key);
  if (!log) return [];
  if (scheduling && scheduling.deck === log.deck) {
    for (const press of log.presses) {
      if (press.steps.has(grid)) continue;
      // Pressed a while before anything read it (the button was not playing yet): too late to be
      // a trigger, rather than one on whatever step comes next.
      if (press.on < scheduling.from - STALE_CYCLES) {
        press.steps.set(grid, null);
        continue;
      }
      const pos = scheduling.posAt(Math.max(press.on, scheduling.from));
      const step = Math.ceil(pos * grid - 1e-9);
      const taken = log.presses.some((p) => p.steps.get(grid)?.step === step);
      if (taken) {
        press.steps.set(grid, null);
        continue;
      }
      const n = log.counts.get(grid) ?? 0;
      log.counts.set(grid, n + 1);
      press.steps.set(grid, { step, n });
    }
  }
  const out = [];
  for (const press of log.presses) {
    const got = press.steps.get(grid);
    if (!got) continue;
    const s = got.step - cycle * grid;
    if (s >= 0 && s < grid) out.push({ start: s / grid, end: (s + 1) / grid, value: 1, n: got.n, step: got.step });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Every press of a live button placed on `grid` so far, in step order: `[{ step, at, before }]`,
 * `step` the grid index it plays on, `at` an object that stays the same press for as long as it is
 * kept (for a reader to remember what it worked out about it), and `before` what onButtonDown's
 * hook answered for it.
 */
export function placedPresses(key, grid) {
  const log = logs.get(key);
  if (!log) return [];
  const out = [];
  for (const press of log.presses) {
    const got = press.steps.get(grid);
    if (got) out.push({ step: got.step, at: got, before: press.before ?? null });
  }
  return out.sort((a, b) => a.step - b.step);
}

// ---------------------------------------------------------------------------------------------
// Counting triggers from cycle 0
// ---------------------------------------------------------------------------------------------

/**
 * How many triggers come before cycle `c`, counted from cycle 0 (negative before it), given
 * `count(cycle)`. With a `period` - a whole number of cycles after which the triggers repeat - it
 * is worked out from one period, so any cycle costs the same. Without one each cycle from 0 is
 * counted once and remembered: the first read far into a song walks there, and every read after
 * it starts from where that walk got to.
 */
export function createTriggerCounter(count, period = null) {
  if (period != null && Number.isInteger(period) && period >= 1) {
    // Not remembered: a drawn row or a take can change under it, and one period is cheap to count.
    return (c) => {
      const loops = Math.floor(c / period);
      return loops * sumCycles(count, 0, period) + sumCycles(count, loops * period, c);
    };
  }
  const up = [0]; // up[i]: triggers in cycles [0, i)
  const down = [0]; // down[i]: triggers in cycles [-i, 0)
  return (c) => {
    if (c >= 0) {
      while (up.length <= c) up.push(up[up.length - 1] + count(up.length - 1));
      return up[c];
    }
    while (down.length <= -c) down.push(down[down.length - 1] + count(-down.length));
    return -down[-c];
  };
}

function sumCycles(count, from, to) {
  let n = 0;
  for (let c = from; c < to; c++) n += count(c);
  return n;
}

/**
 * Whether a step pattern written as mini-notation `text` has the same triggers every cycle: no
 * alternation, polymeter, random choice or slowing down - nothing that makes one cycle differ
 * from the next.
 */
export function miniSameEveryCycle(text) {
  return typeof text === 'string' && !/[<{|?/%]/.test(text);
}

/** The whole number of cycles a take of `cycles` repeats over, or null. */
export function takePeriod(cycles) {
  if (!(cycles > 0)) return null;
  if (Math.abs(cycles - Math.round(cycles)) < 1e-9) return Math.round(cycles);
  const per = 1 / cycles;
  return Math.abs(per - Math.round(per)) < 1e-9 ? 1 : null;
}

// ---------------------------------------------------------------------------------------------
// A button's take as a row of cells
// ---------------------------------------------------------------------------------------------
//
// A recorded button's take is a steps() row written into its .record() call - `take:
// steps("x . . x ...")` - one cell per step of the grid its presses land on, for the whole length
// of the take: `cycles: 2` on sixteenths is 32 cells. Inside .record() the row is read over the
// take's `cycles`, not squeezed into one cycle as a steps() of its own plays, which is the one
// thing the take's length is there to say. A cell that is on is a press on that step.

// Which buttons are read on which grid, so a take is written at the grid its presses play on.
const grids = new Map(); // button key -> steps per cycle

/** A button is a rhythm on `grid` steps a cycle (what .struct() / .advance() were given). */
export function noteButtonGrid(key, grid) {
  grids.set(key, grid);
}

/** The grid a button's presses play on: the one it was last read on, sixteenths before that. */
export function buttonGrid(key) {
  return grids.get(key) ?? TRIGGER_GRID;
}

/** The row with the cell a press at `on` (in cycles) lands on switched on - a fresh row of `cells` rests when there is none. */
export function rowWithPress(text, on, { cycles, cells }) {
  let row = text;
  let n = row == null ? 0 : parseCells(row).length;
  if (!n) {
    n = Math.max(1, Math.round(cells));
    row = restRow(n);
  }
  const phase = (((on % cycles) + cycles) % cycles) / cycles;
  const i = (((triggerStep(phase, n)) % n) + n) % n; // the next cell, as a live press plays on the next step
  return parseCells(row)[i].on ? row : toggleCell(row, i);
}

/**
 * The presses a row holds, at positions in [from, to): each cell that is on, in a loop of
 * `cycles` cycles. `cells` is the row's on cells as `[{ start, loc }]`, `start` a fraction of the
 * row (a steps() row's own steps, which carry the spans the highlighter lights).
 */
export function rowEdges(cells, cycles, from, to) {
  if (!cells.length || !(cycles > 0)) return [];
  const out = [];
  for (let loop = Math.floor(from / cycles); loop * cycles < to; loop++) {
    for (const c of cells) {
      const at = (loop + c.start) * cycles;
      if (at >= from && at < to) out.push(c.loc ? { at, loc: c.loc } : at);
    }
  }
  return out;
}

/** A row's on cells as rowEdges wants them, read off its text. */
export function rowCells(text) {
  const cells = parseCells(text ?? '');
  return cells.map((c, i) => ({ on: c.on, start: i / cells.length })).filter((c) => c.on);
}

/** A take drawn as a shape (the older form) as a row of `cells`: a cell on for each rise. */
export function shapeAsRow(points, cells) {
  let row = restRow(cells);
  for (const x of shapeEdges(points, 1, 0, 1)) {
    const i = ((triggerStep(x, cells) % cells) + cells) % cells;
    if (!parseCells(row)[i].on) row = toggleCell(row, i);
  }
  return row;
}
