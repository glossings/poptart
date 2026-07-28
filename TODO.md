# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

[ ] add `irand`, `rand`, `berlin`, `perlin` as signals
[ ] see if we can get highlighting to work with string templates
[ ] double check that random numbers are being sampled by the outside
  pattern (and are deterministic in time)
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
- [ ] Step 3 — Channels, one group at a time: pitch(note/n) → vel/clip → s → gain/pan → param.
      Each group: walker reads it uniformly, then delete its `_meta` field + its scheduler branch.
      This is where the surgical hacks die (the `_noteLike` keyboardRoute branch, the
      velSig→sampler.vel relocation in `.s()` — they exist only because controls live in separate
      side-channels instead of one bundle).
- [ ] Step 4 — naked `.hold()` (borrow upstream trigger structure; cycle boundaries when
      standalone) + `rib(time,length)` = query remap `c -> time + ((c-time) mod length)`, exact
      because Frac. `rand.rib(14,2)` loops a 2-cycle band. rand becomes deterministic edge-sampled
      f(precise Frac time). (Also closes the top-of-file TODO items: rand/perlin/irand as signals,
      deterministic-in-time sampling.)
- [ ] Step 5 — delete the old per-control scheduler branches once every control is a channel.

Decision still open: after step 2 lands, Aria may choose full-rewrite (greenfield `core2` module,
port builders, swap `$:` binding, delete old — tests red until step 5) vs continuing incremental.
Recommended: stay incremental unless step 2 feels like it's fighting the old model.

Constraints (from memory): NO integration tests — unit-test logic, hand Aria a manual checklist,
don't boot server/app. Narrate before bash + batch commands. Scheduler drives MappedEngine (a
hand-forwarding wrapper) not raw OscEngine — new engine methods must be forwarded there or they
silently no-op. Re-eval must actively tear down engine state for removed pattern parts.