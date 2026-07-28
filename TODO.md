# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

[ ] see if we can get highlighting to work with string templates
[ ] rand()/perlin() JS sampling is still seconds-based, so a rand demoted into a note-value
  context (n(rand()...), .add(rand())) disagrees between playback and the cps=1 highlighter, and
  isn't deterministic in cycle position. Decide: re-base sampleLfoIR's rand/perlin JS path on
  `pos` (cycle) instead of tSeconds (makes highlighter==playback + deterministic, but changes
  what rand(0.1)'s RATE means in JS and further diverges JS from the native noise UGen). irand()
  already covers the deterministic-integer note-value case, so this is only the continuous LFO path.
[ ] signal in format string
```js
const myInt = rand().mul(8).round()
$: `<
  0 4 ${myInt}
  0 4 ${myInt}
>*8`.as("n").scale("F3 minor")

[ ] ignore labels within comments
```js
/*
$: ...
*/
```

---

## All-signals rewrite — notes to future self (Aria approved this plan)

Big arc: replace the per-control scheduler + `_meta()` side-channels with one uniform
model. A pattern = **continuous value-signal(s) that are point-functions of time** PLUS a
**trigger channel = an edge-structure queried over a span**. The value signals are the only
things that can be point-functions; the trigger is the one thing that can't. Downstream events
cross-product with upstream events; downstream config right-wins over upstream (`.as("a:b").a(x)`
= x overwrites a). `keyboard`/`tap`/`pianoroll` are just builders emitting specific bundles.
Continuous signals default to **streamed / symbolic-IR** (option b) — they keep modulating during
a note as native Tier-2 modulators, NOT sampled-and-frozen at onset. `.hold()` (naked, no arg)
is the universal operator that discretizes any continuous signal (cc/sine/rand) into
"strudel-cycle, updated-at-upstream". No `drift`.

**THE setter classification (Aria's final call — locked):**
- MERGE triggers (cross-product the trigger): arithmetic (`mul`/`add`/…), `s`, anything that
  affects the MIDI note — `n`, `note`, `vel`, `clip` — and `fast`/`slow` + structural
  transforms (`rev`/`ply`/`echo`/`euclid`/`degrade`). A vel change mid-note IS a new strike.
- DON'T merge (value only, modulate synth/fx/channel-strip): `gain`, `pan`, `param`, `dry`, `o`.
  These stream continuously and never retrigger.
- Rule of thumb: does the control describe a per-note MIDI-event property, or a continuous
  track/synth modulation? Former merges, latter samples.

Target types (sketch):
```
Sig      // value: at(t) -> number|string|null. Pure continuous point-function.
Trigger  // edges(cycleSpan) -> [{start,end,cont}] with Frac bounds. cont = tie, not fresh strike.
Bundle   // a $: line: { channels: Map<name,Sig>, trigger: Trigger|null, graph:{instrument,
         //   fxChain,slotStates,busSends,inputSource,keyboardRoute} }
```
`graph` = the never-per-event plugin-graph stuff (which VST, fx order, routes) — stays plain
config; only the signals move into channels. `s` IS a channel (sample name varies per hit);
`synth()`/`fx()` are graph.

Thin walker replaces the scheduler: per tick, `trigger.edges(span)` → for each fresh (`!cont`)
edge sample the note channels (note/vel/clip or sampler config) → noteOn/noteOff/playSample in one
uniform loop, zero per-control branches; separately diff the continuous channels and stream them
via the EXISTING native-modulator installer (that code is good, keep it).

**Migration steps (each stays green):**
- [x] Step 1 — Frac + determinism. DONE. `src/frac.mjs` (exact rational: fromNumber snaps float
      crud back to the intended rational; add/sub/mul/div/floor/mod/eq/lt/key). `rngAtPos(cycle,
      phase,seed)` added to BOTH signal.mjs and mini.mjs (must stay mirrored) — degrade/`?` now
      hash off the canonical phase so a moment reached by two float paths draws identically.
      Clean rationals round-trip to the identical double → existing sequences unchanged.
      Tests: frac.test.mjs.
- [x] Step 2 — Trigger + generalized cross-product. DONE. `intersectSteps` → `crossMerge(base,
      ctlSig, channel?, coerce?)` in signal.mjs: same structural split + cont rule (fresh onset
      unless BOTH sides continue), now also MERGES the control's value onto each overlap under a
      named channel, right-wins (`{...s}` copies then control overwrites). `.vel()` routes through
      it (channel 'vel') so a note step is a real note+vel bundle carrying `step.vel`; velSig still
      rides alongside and is still what the scheduler samples (Step 3 flips the walker to read the
      merged step.vel and retires velSig). Sampler note/config splits keep the pure structural
      form (no channel). Continuous vel (a number/LFO, no grid) no-ops the merge and stays in
      velSig. Tests: crossmerge.test.mjs (value-merge, right-wins, rests, cont rule via slow()
      ties). Scheduler untouched — all 135 pattern-core tests green.
- [x] Step 3 — Persistent note channels. DONE (greenfield semantics via a focused refactor, not a
      separate module - it turned out the old model already WAS the target model everywhere except
      the pitch-swap grid nuke). velSig is gone; vel and clip are `Sig#noteChannels` (a persistent
      {vel,clip} bundle in _meta) that re-merge onto the new trigger when pitch is set later, so
      "<0 1>".as("vel").note("f3") keeps its velocities - the structural bug that blocked the
      deletion. applyNoteChannels/applyClip in signal.mjs; _noteLike re-applies them. The scheduler
      reads velocity uniformly for synth AND sampler via _velAt (merged step.vel wins, else sample
      the vel channel at onset, else default) - so the velSig scheduler branch, the .s()
      velSig→sampler.vel relocation, and vel's slot in _sampleConfigAt all died. gain/pan/param were
      already the streamed-channel model and are untouched. Tests: crossmerge/as/fastslow/pianoroll
      updated to noteChannels; all pattern-core green.
- [x] Step 5 — DONE, and it turned out trivial: velSig was the last per-control scheduler branch,
      so deleting it in Step 3 finished this. The only branch left in _scheduleNoteEdges is the
      inherent sampler-vs-synth track split; every channel-strip/param control already flows through
      the uniform _controlEntries/_pollGenericParams path.
- [~] Step 4 — irand + rib + naked hold DONE (rib-hold-irand.test.mjs). `irand(8)` = a deterministic
      per-cycle random integer keyed on the Frac-snapped cycle position (via rngAtPos), so playback
      and the highlighter agree and it replays identically; exported + wired into the browser/server
      builder lists. `.rib(time,length)` remaps a query `c -> time + ((c-time) mod length)` exactly
      (Frac), looping a band of cycles - `irand(8).rib(0,4)` is a repeating random melody. Naked
      `.hold()` (no arg) freezes a continuous signal to one value per cycle, or borrows a pattern's
      own onsets. STILL OPEN: the continuous rand()/perlin() JS-determinism decision - see the
      seconds-vs-cycle re-basing note at the top of this file.

Constraints (from memory): NO integration tests — unit-test logic, hand Aria a manual checklist,
don't boot server/app. Narrate before bash + batch commands. Scheduler drives MappedEngine (a
hand-forwarding wrapper) not raw OscEngine — new engine methods must be forwarded there or they
silently no-op. Re-eval must actively tear down engine state for removed pattern parts.