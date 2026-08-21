'use strict';

// The editor's built-in API reference: one entry per userland name, used both as the source of
// the autocomplete word lists AND as the text of the popup's doc panel and the ctrl-hover
// tooltip. Loaded as a plain script before client.js (and required by api-docs.test.js, which
// checks it against the real API surface - pattern-core's exports + Sig.prototype + server.js's
// BUILDER_NAMES - so a builder can't be added without docs, or documented without existing).
//
// Each entry:
//   kind  'builder' (a top-level call), 'method' (after a dot), or 'both'
//   sig   the call signature, written the way you'd type it - no leading dot, the method
//         context adds one (the sampler controls read the same either way, which is the point)
//   desc  one sentence: what it does, in the terms the docs use
//   eg    optional one-line example
//   call  false for names that are values rather than functions (macro1..8), so completing
//         one inserts the bare name instead of `name(`
//
// Keep descriptions to a line - the popup is a reminder, docs.html is the guide.

const API_DOCS = {
  // ----------------------------------------------------------------- pattern sources
  n: {
    kind: 'both',
    sig: 'n(degrees)',
    desc: 'Scale-degree pattern - plain numbers until .scale() turns them into notes. On a sampler it repitches by degree.',
    eg: 'n("0 2 3 <5 7>").scale("F minor")',
  },
  note: {
    kind: 'both',
    sig: 'note(pitches)',
    desc: 'Absolute pitch pattern - note names or MIDI numbers (c5 = 60). On a sampler it repitches the sample.',
    eg: 'note("c3 e3 g3").synth("Serum 2")',
  },
  s: {
    kind: 'both',
    sig: 's(pack)',
    desc: 'Sampler pattern - values are sample-pack names; a ":n" suffix picks the pack\'s nth file.',
    eg: 's("bd*4, ~ hh ~ hh")',
  },
  se: {
    kind: 'both',
    sig: 'se(path)',
    desc: 'Sampler pattern playing one exact file, by its path under the samples folder. Quote anything with a "/" or a space.',
    eg: 'se("\'drums/kick 01.wav\'")',
  },
  sr: {
    kind: 'both',
    sig: 'sr(name)',
    desc: 'Sampler pattern playing a bounce from the recordings folder by name. Pair with .slow(n) to play the whole loop.',
    eg: 'sr("bass").slow(8)',
  },
  record: {
    kind: 'method',
    sig: 'record({ cycles, name, wrapTail })',
    desc: 'Marks a track for bouncing and opens the recorder panel when you double-click the name - or press ctrl+b in any block.',
    eg: 'note("c2 eb2").synth("Serum 2").record({ cycles: 8 })',
  },
  mini: {
    kind: 'builder',
    sig: 'mini(str)',
    desc: 'Parses a mini-notation string into a pattern - what every "…" literal in pattern position already becomes.',
    eg: 'mini("0 [1 2] <3 4>")',
  },
  Signal: {
    kind: 'builder',
    sig: 'Signal(value)',
    desc: 'Wraps a number, string or pattern as a signal. Signal.prototype is where userland adds its own methods.',
    eg: 'Signal.prototype.up = function (k) { return this.add(k); }',
  },
  synth: {
    kind: 'both',
    sig: 'synth(plugin, { state })',
    desc: 'The track\'s instrument plugin, by name. Double-click the synth name to open its own editor window. Optional captured state restores its saved patch (the track panel\'s pin button writes it).',
    eg: 'note("c2*4").synth("Serum 2")',
  },
  pianoroll: {
    kind: 'builder',
    sig: 'pianoroll(notes, { grid, len, start, mode })',
    desc: 'A note pattern drawn on an interactive roll - double-click the name to open it. Rolls can be named and patterned: pianoroll("<lead alt>"). grid is cells per cycle, and the loop window is len cells from start. Every note carries a pitch and a sample index ("24:3,0,1" is the pack\'s fourth file at c2), so a roll can sequence a pack by file; mode: "index" only says which of the two the editor draws on.',
    eg: 'lead: pianoroll().synth("Serum 2")',
  },

  // ----------------------------------------------------------------- live input
  keyboard: {
    kind: 'builder',
    sig: 'keyboard()',
    desc: 'Play a track live from the computer keyboard - home row = white keys, row above = black, z/x octave, c/v velocity.',
    eg: 'keyboard().synth("Serum 2")',
  },
  tap: {
    kind: 'builder',
    sig: 'tap()',
    desc: 'Like keyboard(), but every key is a fixed-pitch hit at the current velocity - the whole keyboard as one pad.',
    eg: 'tap().n("0").s("clap")',
  },
  midikeys: {
    kind: 'builder',
    sig: 'midikeys(device)',
    desc: 'A MIDI keyboard as a live note source; the result takes a channel (omit for all 16). Routed engine-side, so no scheduler latency.',
    eg: 'midikeys("KeyStep 32")(1).synth("Serum 2")',
  },
  midicc: {
    kind: 'builder',
    sig: 'midicc(device)',
    desc: 'A MIDI controller as a signal source; the result takes (cc, channel) and gives a continuous 0..1 signal.',
    eg: 'midicc("Twister")(12).range(200, 5000)',
  },
  midi: {
    kind: 'both',
    sig: 'midi(source, channel)',
    desc: 'As a source: play this track from a MIDI device or another track\'s notes. As a method after an .fx(): inject MIDI into that plugin.',
    eg: 'note("c2*8").synth("Serum 2").fx("Kickstart").midi("kick")',
  },
  audio: {
    kind: 'both',
    sig: 'audio(source)',
    desc: 'As a source: run a hardware input, another track, or a .bus() sum through this chain. As a method after an .fx(): feed that plugin\'s sidechain.',
    eg: 'audio("drums").fx("Saturn 2")',
  },
  input: {
    kind: 'builder',
    sig: 'input(device?, ch, ch2?)',
    desc: 'A hardware audio input as a track source. Channels are numbered from 1, as on the interface; one is mono and lands centred, two make a stereo pair. The optional device name picks which interface\'s channels those are (only meaningful with a poptart aggregate - see settings). Pass it to .audio() after an .fx() to sidechain off a live input.',
    eg: 'input("Scarlett", 1).fx("Pro-Q 4")',
  },
  macro: {
    kind: 'builder',
    sig: 'macro(index)',
    desc: 'The live 0..1 value of a knob in the Macros panel, as a signal. macro1..macro8 are the same thing, pre-bound.',
    eg: 'param("Filter 1 Freq", macro(3).range(200, 4000))',
  },

  // ----------------------------------------------------------------- modulators
  sine: { kind: 'builder', sig: 'sine({ rate, phase })', desc: 'Sine LFO, 0..1, rate in Hz. Callable as sine(0.3) for the rate alone; .range(lo, hi) rescales.', eg: 'param("Cutoff", sine(0.3).range(200, 5000))' },
  saw: { kind: 'builder', sig: 'saw({ rate, phase })', desc: 'Falling sawtooth LFO, 0..1. Same options as sine().', eg: 'pan(saw(0.25).range(-1, 1))' },
  tri: { kind: 'builder', sig: 'tri({ rate, phase })', desc: 'Triangle LFO, 0..1. Same options as sine().', eg: 'gain(tri(0.5).range(0.4, 1))' },
  square: { kind: 'builder', sig: 'square({ rate, phase })', desc: 'Square LFO, 0..1 - a hard alternation. Same options as sine().', eg: 'param("Sub On", square(1))' },
  ramp: { kind: 'builder', sig: 'ramp({ rate, phase })', desc: 'Rising 0→1 each period. Same options as sine().', eg: 'param("Sweep", ramp(0.1))' },
  rand: {
    kind: 'builder',
    sig: 'rand({ seed })',
    desc: 'Uniform random 0..1 - an independent draw at every position it is read, so each event sampling it gets its own coin. No rate: unsmoothed noise has no speed of its own, only the rhythm you read it on, so pace it with .seg(8) or .hold("1*8") - or use perlin() for smooth drift with a rate. Each rand() is its own stream.',
    eg: 'begin(rand().seg(8))',
  },
  perlin: { kind: 'builder', sig: 'perlin({ rate, seed })', desc: 'Fractal value noise (fBm) - the smooth one: organic drift with one new target per period, where rand() draws afresh every read. Independently seeded like rand().', eg: 'pan(perlin(0.1).range(-0.6, 0.6))' },
  lfo: {
    kind: 'builder',
    sig: 'lfo(shape, { rate, mode, phase, glide })',
    desc: 'A hand-drawn modulator - double-click the lfo name to open the shape editor. Shapes can be named and patterned: lfo("<pluck swell>"). rate is passes per cycle, or "0.5hz" to run free of the tempo. Modes: free, retrigger (per note), envelope (once per note).',
    eg: 'lfo("<pluck swell>", { rate: 0.3, glide: 0.2 }).range(200, 5000)',
  },
  env: {
    kind: 'builder',
    sig: 'env({ attack, decay, sustain, release, curve })',
    desc: 'An ADSR retriggered by the track\'s own notes - times in seconds, sustain 0..1, curve < 0 scoops.',
    eg: 'gain(env({ attack: 0.01, release: 0.3 }))',
  },

  // ----------------------------------------------------------------- pattern-of-patterns
  cat: {
    kind: 'builder',
    sig: 'cat(...patterns)',
    desc: 'Alternates whole patterns, one per cycle. They keep running underneath - cat only picks which you hear.',
    eg: 'cat(n("0 2 3"), n("<5 7>")).synth("Serum 2")',
  },
  seq: {
    kind: 'builder',
    sig: 'seq(...patterns)',
    desc: 'Splits each cycle evenly between whole patterns. Like cat but within the cycle; they are not squeezed to fit.',
    eg: 'seq(s("bd*4"), s("hh*8"))',
  },
  // ----------------------------------------------------------------- randomness / tempo
  choose: {
    kind: 'builder',
    sig: 'choose(...options)',
    desc: 'Picks one option per draw; pass [value, weight] pairs to bias it. Deterministic per cycle position, so replays match.',
    eg: 'flip(choose("0", ["1", 0.3]))',
  },
  irand: {
    kind: 'builder',
    sig: 'irand(n)',
    desc: 'A deterministic random integer in 0..n-1, one per cycle. A subdividing bound ("8!8") gives it that structure.',
    eg: 'begin(irand(16).div(16))',
  },
  setbpm: {
    kind: 'builder',
    sig: 'setbpm(bpm)',
    desc: 'Sets the global tempo, read as 4 beats per cycle. Takes a pattern or signal, not just a number.',
    eg: 'setbpm(140)',
  },
  setscale: {
    kind: 'builder',
    sig: 'setscale(name)',
    desc: 'Sets the key every .sc() reads. Hoisted, so the last one in the buffer re-keys the whole buffer.',
    eg: 'setscale("F minor")',
  },

  // ----------------------------------------------------------------- music-theory helpers
  noteToMidi: { kind: 'builder', sig: 'noteToMidi(name)', desc: 'Note name → MIDI number ("c4" → 48), the c5 = 60 convention. Plain helper, handy inside your own methods.', eg: 'noteToMidi("f#3")' },
  degreeToMidi: { kind: 'builder', sig: 'degreeToMidi(degree, scale)', desc: 'Scale degree → MIDI number, the conversion .scale() does per value.', eg: 'degreeToMidi(2, "F minor")' },
  parseScaleName: { kind: 'builder', sig: 'parseScaleName(scale)', desc: 'A scale name → { rootMidi, intervals } - the raw material for writing your own chord/voicing helpers.', eg: 'parseScaleName("Bb mixolydian")' },

  // ----------------------------------------------------------------- chain & channel strip
  fx: {
    kind: 'method',
    sig: 'fx(plugin, { state })',
    desc: 'Appends an effect to the track\'s chain, after the instrument and any earlier .fx(). Double-click the fx name to open its own editor window. Later .param() calls target it.',
    eg: '.fx("ValhallaRoom").param("Mix", 0.3)',
  },
  param: {
    kind: 'method',
    sig: 'param(name, value)',
    desc: 'Sets a plugin parameter by its real VST name (autocompletes inside the quotes) on whatever is last in the chain.',
    eg: '.param("Filter 1 Freq", sine(0.2).range(300, 6000))',
  },
  preset: {
    kind: 'method',
    sig: 'preset(names)',
    desc: 'Swaps the last plugin in the chain between named whole-state presets. Names belong to their plugin, so every slot in a chain can have its own `disco`. Double-click `preset` to shape one by ear.',
    eg: '.preset("<init growl>")',
  },
  scale: {
    kind: 'method',
    sig: 'scale(name)',
    desc: 'Reads degrees as a scale ("<root> <mode>"), or quantizes an absolute note pattern into it. Also snaps live MIDI notes.',
    eg: '.scale("F minor")',
  },
  sc: {
    kind: 'method',
    sig: 'sc(octave)',
    desc: 'The setscale() key, applied like .scale(). The optional octave places the scale\'s root; patterns welcome.',
    eg: 'n("0 2 4").sc(3)',
  },
  gain: { kind: 'method', sig: 'gain(value)', desc: 'Track output gain after the whole chain, 1 = unity. Chains multiply, so a level and a modulator compose.', eg: '.gain(0.5).gain(env())' },
  pan: { kind: 'method', sig: 'pan(value)', desc: 'Stereo pan, -1 (left) .. 1 (right), 0 = center.', eg: '.pan(sine(0.2).range(-1, 1))' },
  width: { kind: 'method', sig: 'width(amount)', desc: 'Stereo width (mid/side): 0 mono, 1 untouched, up to 4 = 400%. Scales the difference between the channels, so a mono source has nothing to widen. Applied before pan, so you can narrow a wide sound and then place it. Past 1 costs mono compatibility - watch the mixer\'s stereo image.', eg: '.width(0.6).pan(-0.4)' },
  o: { kind: 'method', sig: 'o(pair)', desc: 'Which stereo output pair the track plays to - .o(1) is channels 1/2, .o(2) is 3/4. Wraps at the "output channels" setting, which is 2 unless you raise it - so by default every .o(n) is channels 1/2.', eg: '.o(2)' },
  bus: {
    kind: 'method',
    sig: 'bus(name, amount)',
    desc: 'Aux send: mixes this track\'s output into a named bus that another track reads with audio("name"). Doesn\'t touch the dry signal.',
    eg: '.bus("reverb", 0.3)',
  },
  dry: { kind: 'method', sig: 'dry(value)', desc: 'How much dry signal still reaches the track\'s own output, 1 by default. .dry(0) leaves only the bus sends.', eg: '.dry(0)' },
  bsend: { kind: 'method', sig: 'bsend(name, amount)', desc: 'Bus send with the dry killed - exactly .bus(name, amount).dry(0).', eg: '.bsend("reverb")' },
  vel: {
    kind: 'both',
    sig: 'vel(value)',
    desc: 'Per-note velocity (MIDI velocity, or sample volume). A patterned vel also gives the track structure - each step retriggers and gates. As an operand it aims at that channel: .mul(vel(0.5)) halves whatever velocity is in force. At the head of a chain it triggers too - vel("1!4").s("bd") is s("bd").vel("1!4").',
    eg: '.vel("1 0.6 ~ 0.8")',
  },
  clip: {
    kind: 'both',
    sig: 'clip(value)',
    desc: 'Multiplies each note\'s ringing duration - .clip(2) holds every note for twice its step. Setting it replaces whatever clip was in force; as an operand it composes, so "0:2".as("n:clip").mul(clip(2)) rings for four steps.',
    eg: '.clip("<1 4 1>*4")',
  },
  nudge: {
    kind: 'both',
    sig: 'nudge(value)',
    desc: 'Plays each event off its grid position, as a fraction of its own step width - positive is late, negative early, clamped at half a step. The note keeps its written place in the pattern; only the timestamp moves. Also a field in .as("note:nudge"), where "38::0.04" pushes one hit and leaves the rest alone.',
    eg: '.nudge("0 0.04")',
  },
  swing: {
    kind: 'both',
    sig: 'swing(amount, grid)',
    desc: 'Delays the offbeats of a grid of `grid` slots per cycle (8 by default) and leaves the onbeats alone. `amount` is how far, as a fraction of one slot: 1/3 is the classic triplet shuffle, 0.5 the most there is. A drum machine\'s percentage is (pct - 50) / 50, so 66% is 1/3. Adds to whatever .nudge() is in force rather than replacing it. Write fractions as JS - inside a mini string "1/3" is the slow operator.',
    eg: 's("hh*8").swing(1/3)',
  },
  swinggrid: {
    kind: 'both',
    sig: 'swinggrid(value)',
    desc: 'How many slots swing divides the cycle into - 8 (eighths) by default, 16 for a sixteenth-note shuffle. Usually passed as swing\'s second argument; its own channel so it can be patterned.',
    eg: '.swing(0.2, 16)',
  },

  // ----------------------------------------------------------------- shaping
  range: { kind: 'method', sig: 'range(min, max)', desc: 'Rescales a 0..1 signal into [min, max]. Bounds may themselves be patterns or signals.', eg: '.range(200, 5000)' },
  fast: { kind: 'method', sig: 'fast(factor)', desc: 'Squeezes the pattern into 1/factor of the time; negative plays it in reverse. On an LFO it multiplies the rate.', eg: '.fast("<1 2>")' },
  slow: { kind: 'method', sig: 'slow(factor)', desc: 'Stretches the pattern over `factor` cycles - the inverse of .fast(). Negative reverses too.', eg: '.slow(4)' },
  rate: { kind: 'method', sig: 'rate(hz)', desc: 'Sets an LFO\'s rate in Hz absolutely (unlike .fast(), which multiplies it).', eg: 'sine().rate(0.25)' },
  phase: { kind: 'method', sig: 'phase(cycles)', desc: 'Offsets an LFO\'s starting phase, in cycles.', eg: 'sine(0.5).phase(0.25)' },
  curve: { kind: 'method', sig: 'curve(c)', desc: 'Envelope curve for env(): negative scoops (exponential-ish), 0 is linear, positive bulges.', eg: 'env().curve(-4)' },
  hold: {
    kind: 'method',
    sig: 'hold(trigger)',
    desc: 'Sample-and-hold: freezes this signal at each trigger onset until the next. Bare .hold() uses the signal\'s own onsets, or one value per cycle.',
    eg: 'rand().hold("1*8")',
  },
  seg: {
    kind: 'method',
    sig: 'seg(n)',
    desc: 'Re-reads the signal on an even grid of n steps per cycle - what gives a structureless signal structure. n may be patterned.',
    eg: 'rand().seg(8)',
  },
  segment: { kind: 'method', sig: 'segment(n)', desc: 'Strudel\'s other spelling of .seg(n).', eg: 'rand().segment(8)' },
  rib: {
    kind: 'method',
    sig: 'rib(cycle, length)',
    desc: 'Loops a band of cycles forever (Strudel\'s ribbon) - .rib(14, 2) replays cycles 14-15. Fractional lengths loop a sub-cycle window.',
    eg: 'irand(8).rib(0, 2)',
  },
  when: {
    kind: 'method',
    sig: 'when(condition, fn)',
    desc: 'Applies fn to the pattern wherever condition is nonzero. The condition is read by the incoming events - sampled at the onsets the pattern already has, never adding triggers of its own - so seg(8) before it means eight reads a bar, and one hit a bar means one.',
    eg: '.when(rand().gte(0.7), x => x.add(flip(1)))',
  },
  as: {
    kind: 'method',
    sig: 'as(spec)',
    desc: 'Reads "a:b:c" tokens as named fields - note, n, i, vel, clip, nudge - so one string carries pitch, sample choice, dynamics and feel together. Empty fields keep their defaults, so "38::0.04" sets only the last one.',
    eg: '"<36:1:4 ~>*8".as("note:vel:clip")',
  },
  degrade: { kind: 'method', sig: 'degrade(prob, seed)', desc: 'Randomly drops events (default 50%), deterministic per cycle. The mini-notation "?" postfix is the same operation.', eg: '.degrade(0.3)' },
  ply: { kind: 'method', sig: 'ply(reps, fn)', desc: 'Retriggers each event `reps` times; the optional (x, n) => signal transforms each repetition.', eg: '.ply(3, (x, n) => x.add(n * 12))' },
  echo: { kind: 'method', sig: 'echo(reps, time, fn)', desc: 'Repeats each event `reps` times, `time` cycles apart; the optional (x, n) => signal shapes each copy.', eg: '.echo(4, 1/8, (x, n) => x.gain(0.6 ** n))' },
  arp: { kind: 'method', sig: 'arp(indices)', desc: 'Spreads each chord over the index pattern - indices past the top wrap up an octave. Apply .scale() first on degrees.', eg: 'note("[c3,e3,g3]").arp("0 1 2 1")' },

  // ----------------------------------------------------------------- arithmetic
  add: { kind: 'method', sig: 'add(x)', desc: 'Adds, keeping the left side\'s structure. On a control pattern it reaches into that channel. A `,`-stacked right side sounds every layer at once - .add(note("0,7")) keeps each note and adds its fifth alongside.', eg: '.add(note("0,7"))' },
  sub: { kind: 'method', sig: 'sub(x)', desc: 'Subtracts, keeping the left side\'s structure. A `,`-stacked right side sounds every layer at once.', eg: '.sub(12)' },
  mul: { kind: 'method', sig: 'mul(x)', desc: 'Multiplies, keeping the left side\'s structure. A `,`-stacked right side sounds every layer at once - .mul(speed("1.1,0.9")) is two hits, detuned apart.', eg: '.mul(speed(2))' },
  div: { kind: 'method', sig: 'div(x)', desc: 'Divides, keeping the left side\'s structure.', eg: 'irand(8).div(8)' },
  mod: { kind: 'method', sig: 'mod(x)', desc: 'Modulo (always positive), keeping the left side\'s structure.', eg: '.mod(12)' },
  round: { kind: 'method', sig: 'round()', desc: 'Rounds each value to the nearest integer.', eg: 'rand().range(0, 7).round()' },
  abs: { kind: 'method', sig: 'abs()', desc: 'Absolute value of each value.', eg: '.abs()' },
  floor: { kind: 'method', sig: 'floor()', desc: 'Rounds each value down to the integer below.', eg: '.floor()' },
  ceil: { kind: 'method', sig: 'ceil()', desc: 'Rounds each value up to the integer above.', eg: '.ceil()' },
  clamp: { kind: 'method', sig: 'clamp(lo, hi)', desc: 'Bounds each value into [lo, hi]. Both bounds take patterns too.', eg: '.clamp(0, 1)' },
  gte: { kind: 'method', sig: 'gte(x)', desc: 'Greater-or-equal test → 1 where true, 0 where false - the usual gate for .when().', eg: 'rand().gte(0.7)' },
  gt: { kind: 'method', sig: 'gt(x)', desc: 'Greater-than test → 1 where true, 0 where false.', eg: '.gt(0.5)' },
  lte: { kind: 'method', sig: 'lte(x)', desc: 'Less-or-equal test → 1 where true, 0 where false.', eg: '.lte(0.5)' },
  lt: { kind: 'method', sig: 'lt(x)', desc: 'Less-than test → 1 where true, 0 where false.', eg: '.lt(0.5)' },
  eq: { kind: 'method', sig: 'eq(x)', desc: 'Equality test → 1 where equal, 0 elsewhere.', eg: '.eq(0)' },
  neq: { kind: 'method', sig: 'neq(x)', desc: 'Inequality test → 1 where different, 0 elsewhere.', eg: '.neq(0)' },

  // ----------------------------------------------------------------- sampler controls
  // Each is both a method on a sampler pattern and a top-level control builder, so a combinator
  // can aim at one channel of a pattern it was handed (x.mul(speed("-1"))). At the head of a chain
  // the builder sets its own channel and supplies the trigger grid: speed("2").s("bd") is
  // s("bd").speed("2").
  i: { kind: 'both', sig: 'i(index)', desc: 'Which sample of the pack to play, 0-based (the same thing as the ":n" suffix).', eg: 's("breaks").i("<0 2>")' },
  begin: { kind: 'both', sig: 'begin(pos)', desc: 'Playback start position within the sample, 0..1.', eg: '.begin(irand(16).div(16))' },
  end: { kind: 'both', sig: 'end(pos)', desc: 'Playback end position within the sample, 0..1.', eg: '.end(0.25)' },
  loop: { kind: 'both', sig: 'loop(on)', desc: 'Loops the sample for the event instead of one-shot, entering at begin(); loopwrap() picks the region and loopdir() how it turns over. loop(0) also opts a negative speed out of looping.', eg: '.loop()' },
  loopwrap: { kind: 'both', sig: 'loopwrap(mode)', desc: 'Which region a loop() runs round - 0 = the whole file, so begin() is only where playback enters and it carries on past the end from 0; 1 = the begin..end window itself (what a slice() loop wants). Values round to the nearest mode and wrap, so any signal works: loopwrap(rand().range(0, 2)).', eg: '.loop().loopwrap(1)' },
  loopdir: { kind: 'both', sig: 'loopdir(mode)', desc: 'How a loop() turns over at the edge of its region - 0 = jump back to the near edge, 1 = pingpong, turning around so it bounces back and forth. Values round to the nearest mode and wrap, so any signal works: loopdir(irand(2)).', eg: '.loop().loopdir(1)' },
  speed: { kind: 'both', sig: 'speed(rate)', desc: 'Playback rate off begin() - 2 is an octave up and half as long, 0 is silent, negative walks backwards and wraps round to end(), so it loops unless you say loop(0).', eg: '.speed("<1 -1>")' },
  flip: { kind: 'both', sig: 'flip(on)', desc: 'Plays the region backwards into the beat: over 0.5 it reverses speed() as one pass and delays the voice so it lands on begin() at the step\'s end.', eg: '.flip("<0 1>*2")' },
  stretch: { kind: 'both', sig: 'stretch(factor)', desc: 'Granular timestretch (2 = twice as long at the same pitch). Best on rhythmic material.', eg: '.stretch(2)' },
  fit: { kind: 'both', sig: 'fit(measures)', desc: 'Repitches the sample to last exactly this many cycles; bare .fit() picks the nearest power of two.', eg: 's("breaks:19").fit()' },
  slice: { kind: 'both', sig: 'slice(n)', desc: 'Plays the nth detected transient slice, wrapping past the last. WAV samples only.', eg: '.slice(irand(8))' },
  attack: { kind: 'both', sig: 'attack(mult)', desc: 'Sampler envelope attack, as a multiple of the played duration.', eg: '.attack(0.1)' },
  decay: { kind: 'both', sig: 'decay(mult)', desc: 'Sampler envelope decay, as a multiple of the played duration.', eg: '.decay(0.3)' },
  sustain: { kind: 'both', sig: 'sustain(level)', desc: 'Sampler envelope sustain level, 0..1 (a level, not a time).', eg: '.sustain(0.5)' },
  release: { kind: 'both', sig: 'release(mult)', desc: 'Sampler envelope release, as a multiple of the played duration.', eg: '.release(0.5)' },
  adsr: { kind: 'method', sig: 'adsr(a, d, s, r)', desc: 'Sets all four sampler envelope controls at once.', eg: '.adsr(0.05, 0.2, 0.6, 0.4)' },

  // ----------------------------------------------------------------- debugging
  log: {
    kind: 'method',
    sig: 'log()',
    desc: 'Prints every event this track fires to the console - onset and end in cycles, plus the config the engine resolved (a sampler line shows the begin/end window, the real rate, and how much audio the window holds against the event\'s length).',
    eg: 's("breaks:35").fit().begin("<0 0.75>").log()',
  },
};

// The Macros panel's knobs, pre-bound as ready-made signals (macro1..macro8 = macro(1)..macro(8)).
// Values, not functions - `call: false` keeps completion from typing an opening paren after them.
for (let k = 1; k <= 8; k++) {
  API_DOCS[`macro${k}`] = {
    kind: 'builder',
    call: false,
    sig: `macro${k}`,
    desc: `Live 0..1 value of knob ${k} in the Macros panel.`,
    eg: `param("Filter 1 Freq", macro${k}.range(200, 4000))`,
  };
}

// The autocomplete word lists, derived so a name can't be offered without docs (or documented
// without being offered). Insertion order = the order they're declared above.
const BUILDERS = Object.keys(API_DOCS).filter((k) => API_DOCS[k].kind !== 'method');
const METHODS = Object.keys(API_DOCS).filter((k) => API_DOCS[k].kind !== 'builder');

// The doc for `name` used as a method (after a dot) or as a top-level builder. A name documented
// only in the other context still resolves - hovering `.fast` should say something even though
// nothing writes `fast(` at top level - so this is a lookup, not a validity check.
function lookupDoc(name, context) {
  const doc = API_DOCS[name];
  if (!doc) return null;
  const wanted = context === 'method' ? 'method' : 'builder';
  const shown = doc.kind === 'both' || doc.kind === wanted ? wanted : doc.kind;
  return { name, ...doc, context: shown, display: (shown === 'method' ? '.' : '') + doc.sig };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { API_DOCS, BUILDERS, METHODS, lookupDoc };
}
