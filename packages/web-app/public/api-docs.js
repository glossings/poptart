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
//   desc  what it does and what its arguments mean
//   eg    optional one-line example
//   call  false for names that are values rather than functions (macro1..8), so completing
//         one inserts the bare name instead of `name(`
//
// Writing a desc: it is shown on its own, so it must stand alone - never "same as x()" or "see
// y()". Plain and neutral: no capitals for emphasis, no selling, no implementation details, no
// underscore names (users never type those). Say what the arguments mean and their units.
// Short: one sentence saying what it is, plus at most the one fact the signature can't give
// (units, a range, what an argument means). How it works, gestures and edge cases belong in the
// guide pages, not here.

// The waveform LFOs share their rate wording, so every entry says it in full.
const LFO_RATE = 'rate is passes per cycle, or "0.5hz".';

const API_DOCS = {
  // ----------------------------------------------------------------- pattern sources
  n: {
    kind: 'both',
    sig: 'n(degrees)',
    desc: 'A pattern of scale degrees, mapped to notes by .scale().',
    eg: 'n("0 2 3 <5 7>").scale("F minor")',
  },
  note: {
    kind: 'both',
    sig: 'note(pitches)',
    desc: 'A pattern of pitches, as note names or MIDI numbers (c3 = 60).',
    eg: 'note("c3 e3 g3").synth("Serum 2")',
  },
  s: {
    kind: 'both',
    sig: 's(pack)',
    desc: 'Plays samples by pack name; "pack:n" plays the pack\'s nth file.',
    eg: 's("bd*4, ~ hh ~ hh")',
  },
  se: {
    kind: 'both',
    sig: 'se(path)',
    desc: 'Plays one sample file, by its path in the samples folder.',
    eg: 'se("\'drums/kick 01.wav\'")',
  },
  sr: {
    kind: 'both',
    sig: 'sr(name)',
    desc: 'Plays a recording from the recordings folder, by name.',
    eg: 'sr("bass").slow(8)',
  },
  sp: {
    kind: 'both',
    sig: 'sp(pack)',
    desc: 'Plays samples from a pack whose files you chose by hand.',
    eg: 'sp("kit:0 kit:1 kit:0 kit:2")',
  },
  say: {
    kind: 'both',
    sig: 'say(text, voice)',
    desc: 'Speaks text with a system voice, one word per step; macOS desktop only.',
    eg: 'say("hi my name is", "Whisper")',
  },
  record: {
    kind: 'method',
    sig: 'record({ cycles, name, wrapTail, normalize, take })',
    desc: 'Records a track to an audio file, or a control\'s movement as a loop.',
    eg: '.record({ cycles: 8 })',
  },
  mini: {
    kind: 'builder',
    sig: 'mini(str)',
    desc: 'Parses a mini-notation string into a pattern.',
    eg: 'mini("0 [1 2] <3 4>")',
  },
  Signal: {
    kind: 'builder',
    sig: 'Signal(value)',
    desc: 'Turns a number, string or pattern into a signal; Signal.prototype adds methods.',
    eg: 'Signal.prototype.up = function (k) { return this.add(k); }',
  },
  synth: {
    kind: 'both',
    sig: 'synth(plugin, { label, state })',
    desc: 'Sets the track\'s instrument plugin; label names it for .param() and .wet().',
    eg: 'note("c2*4").synth("Serum 2")',
  },
  pianoroll: {
    kind: 'both',
    sig: 'pianoroll(names)',
    desc: 'Notes drawn in a named piano roll; with no name, the track\'s own.',
    eg: 'lead: pianoroll().synth("Serum 2")',
  },
  clips: {
    kind: 'builder',
    sig: 'clips()',
    desc: 'Notes from the clips painted on this track\'s row in the arrangement.',
    eg: 'kick: clips().s("bd")',
  },

  // ----------------------------------------------------------------- live input
  midikeys: {
    kind: 'builder',
    sig: 'midikeys(device)',
    desc: 'Notes from a MIDI keyboard; call the result with a channel (1-16), or none for all.',
    eg: 'midikeys("KeyStep 32")(1).synth("Serum 2")',
  },
  midicc: {
    kind: 'builder',
    sig: 'midicc(device)',
    desc: 'A MIDI controller as a signal from 0 to 1; call the result with (cc, channel).',
    eg: 'midicc("Twister")(12).range(200, 5000)',
  },
  osc: {
    kind: 'builder',
    sig: 'osc(address, index)',
    desc: 'The latest value at an OSC address, as a signal; index picks the argument, from 0.',
    eg: 'osc("/1/fader3").range(200, 5000)',
  },
  midi: {
    kind: 'both',
    sig: 'midi(source, channel)',
    desc: 'Plays the track from a MIDI device or another track; after .fx(), sends MIDI to it.',
    eg: '.fx("Kickstart").midi("kick")',
  },
  audio: {
    kind: 'both',
    sig: 'audio(source)',
    desc: 'Plays an input, track or bus through this chain; after .fx(), feeds its sidechain.',
    eg: 'audio("drums").fx("Saturn 2")',
  },
  group: {
    kind: 'builder',
    sig: 'group({ ...tracks })',
    desc: 'Mixes the tracks in its braces into one channel.',
    eg: 'kick: group({\n  kickMain: s("mbd*4")\n  kickFill: s("mbd*8")\n}).postgain(0.8)',
  },
  copy: {
    kind: 'both',
    sig: 'copy(track)',
    desc: 'An independent duplicate of another track: notes, controls, instrument and effects.',
    eg: 'kick2: copy("kick").fast(2)',
  },
  pcopy: {
    kind: 'both',
    sig: 'pcopy(track)',
    desc: 'Another track\'s notes only, without its instrument, effects or controls.',
    eg: 'b: pcopy("a").add(note(12))',
  },
  input: {
    kind: 'builder',
    sig: 'input(device?, ch, ch2?)',
    desc: 'A hardware audio input as the track\'s source; channels count from 1.',
    eg: 'input("Scarlett", 1).fx("Pro-Q 4")',
  },
  macro: {
    kind: 'builder',
    sig: 'macro(index)',
    desc: 'A knob in the Macros panel, as a signal from 0 to 1.',
    eg: 'param("Filter 1 Freq", macro(3).range(200, 4000))',
  },

  // ----------------------------------------------------------------- modulators
  sine: { kind: 'builder', sig: 'sine(rate)', desc: `Sine wave from 0 to 1; ${LFO_RATE}`, eg: 'param("Cutoff", sine(0.25).range(200, 5000))' },
  saw: { kind: 'builder', sig: 'saw(rate)', desc: `Sawtooth rising from 0 to 1; ${LFO_RATE}`, eg: 'pan(saw(0.25).range(-1, 1))' },
  isaw: { kind: 'builder', sig: 'isaw(rate)', desc: `Sawtooth falling from 1 to 0; ${LFO_RATE}`, eg: 'gain(isaw(4))' },
  tri: { kind: 'builder', sig: 'tri(rate)', desc: `Triangle wave from 0 to 1 and back; ${LFO_RATE}`, eg: 'gain(tri(0.5).range(0.4, 1))' },
  square: { kind: 'builder', sig: 'square(rate)', desc: `Square wave, 1 then 0 each pass; ${LFO_RATE}`, eg: 'param("Sub On", square(1))' },
  rand: {
    kind: 'builder',
    sig: 'rand({ seed })',
    desc: 'A random value from 0 to 1, fresh for every event.',
    eg: 'begin(rand().seg(8))',
  },
  perlin: {
    kind: 'builder',
    sig: 'perlin(rate)',
    desc: 'Smooth random drift from 0 to 1; rate is roughly new targets per cycle.',
    eg: 'pan(perlin(0.1).range(-0.6, 0.6))',
  },
  lfo: {
    kind: 'builder',
    sig: 'lfo(shape, { rate, mode, phase, glide })',
    desc: 'A modulator that follows a hand-drawn shape, by name.',
    eg: 'lfo("pluck", { rate: 0.5 }).range(200, 5000)',
  },
  env: {
    kind: 'builder',
    sig: 'env({ attack, decay, sustain, release, curve, min, max, retrigger }) | env(source, { attack, release })',
    desc: 'An ADSR envelope on each note, or, given a source, that source\'s level from 0 to 1.',
    eg: 'gain(env("kick", { release: 0.3 }).mul(-1).add(1))',
  },
  dur: {
    kind: 'builder',
    sig: 'dur()',
    desc: 'The length of the current note, in seconds.',
    eg: 's("pad").attack(0.25).release(0.5).envscale(dur())',
  },
  auto: {
    kind: 'builder',
    sig: 'auto(name)',
    desc: 'A named automation lane drawn in the arrangement, as a signal.',
    eg: 'param("Filter 1 Freq", auto("intro").range(200, 8000))',
  },

  // ----------------------------------------------------------------- pattern-of-patterns
  cat: {
    kind: 'builder',
    sig: 'cat(...patterns)',
    desc: 'Plays one pattern per cycle, in turn.',
    eg: 'cat(n("0 2 3"), n("<5 7>")).synth("Serum 2")',
  },
  seq: {
    kind: 'builder',
    sig: 'seq(...patterns)',
    desc: 'Splits each cycle evenly between the patterns, one after another.',
    eg: 'seq(s("bd*4"), s("hh*8"))',
  },
  // ----------------------------------------------------------------- randomness / tempo
  choose: {
    kind: 'builder',
    sig: 'choose(...options)',
    desc: 'Picks one of the options at random; [value, weight] pairs weight them.',
    eg: 'flip(choose("0", ["1", 0.3]))',
  },
  irand: {
    kind: 'builder',
    sig: 'irand(n)',
    desc: 'A random whole number from 0 to n-1.',
    eg: 'begin(irand(16).div(16))',
  },
  setbpm: {
    kind: 'builder',
    sig: 'setbpm(bpm)',
    desc: 'Sets the tempo in beats per minute, 4 beats to a cycle.',
    eg: 'setbpm(140)',
  },
  samples: {
    kind: 'builder',
    sig: 'samples(repo, prefix?)',
    desc: 'Loads sample packs from a public GitHub repository, one per folder; browser only.',
    eg: 'samples("tidalcycles/dirt-samples", "dirt")',
  },
  setscale: {
    kind: 'builder',
    sig: 'setscale(name)',
    desc: 'Sets the key .sc() uses, as "<root> <mode>".',
    eg: 'setscale("F minor")',
  },
  setgroove: {
    kind: 'builder',
    sig: 'setgroove(groove, depth?)',
    desc: 'Sets the swing groove for every track that has none of its own.',
    eg: 'setgroove("clave16")',
  },

  // ----------------------------------------------------------------- music-theory helpers
  noteToMidi: { kind: 'builder', sig: 'noteToMidi(name)', desc: 'Converts a note name to a MIDI number, with c3 = 60.', eg: 'noteToMidi("f#3")' },
  degreeToMidi: { kind: 'builder', sig: 'degreeToMidi(degree, scale)', desc: 'Converts a scale degree to a MIDI number in the given scale.', eg: 'degreeToMidi(2, "F minor")' },
  parseScaleName: { kind: 'builder', sig: 'parseScaleName(scale)', desc: 'Splits a scale name into { rootMidi, intervals }.', eg: 'parseScaleName("Bb mixolydian")' },

  // ----------------------------------------------------------------- chain & channel strip
  fx: {
    kind: 'method',
    sig: 'fx(plugin, { label, state, loop })',
    desc: 'Adds an effect plugin to the end of the chain; label names it for .param() and .wet().',
    eg: '.fx("Delay").fx("Reverb")',
  },
  param: {
    kind: 'method',
    sig: 'param(device?, name, value)',
    desc: 'Sets a parameter by name, on the last plugin in the chain or the named device.',
    eg: '.param("Filter 1 Freq", sine(0.2).range(300, 6000))',
  },
  preset: {
    kind: 'method',
    sig: 'preset(names)',
    desc: 'Switches the last plugin in the chain to a saved preset, by name.',
    eg: '.preset("<init growl>")',
  },
  scale: {
    kind: 'method',
    sig: 'scale(name, keys)',
    desc: 'Maps scale degrees to notes in "<root> <mode>", or snaps notes to that scale.',
    eg: '.scale("<F2:minor Ab2:major>")',
  },
  ji: {
    kind: 'method',
    sig: 'ji(reference, limit)',
    desc: 'Retunes notes to just intonation, against each chord\'s lowest note or a reference.',
    eg: 'note("<[c3,e3,g3] [f3,a3,c4]>").ji()',
  },
  sc: {
    kind: 'method',
    sig: 'sc(octave, keys)',
    desc: 'Maps scale degrees to notes in the key set by setscale(); octave places the root.',
    eg: 'n("0 2 4").sc(3)',
  },
  gain: { kind: 'method', sig: 'gain(value)', desc: 'The track\'s level before its effects; 1 is unity.', eg: '.gain(0.5)' },
  postgain: { kind: 'method', sig: 'postgain(value)', desc: 'The track\'s level after its effects (the mixer fader); 1 is unity.', eg: '.postgain(0.7)' },
  pan: { kind: 'method', sig: 'pan(value)', desc: 'Stereo position, from -1 (left) to 1 (right); 0 is center.', eg: '.pan(sine(0.2).range(-1, 1))' },
  bend: {
    kind: 'method',
    sig: 'bend(semitones, range)',
    desc: 'Pitch bend in semitones for the whole track; range is the plugin\'s bend range.',
    eg: '.bend(sine(0.5).range(-2, 2))',
  },
  bassmono: { kind: 'method', sig: 'bassmono(hz)', desc: 'Makes everything below hz mono, keeping the width above; 0 turns it off.', eg: '.width(1.6).bassmono(120)' },
  width: { kind: 'method', sig: 'width(amount)', desc: 'Stereo width: 0 is mono, 1 unchanged, up to 4 wider.', eg: '.width(0.6).pan(-0.4)' },
  o: { kind: 'method', sig: 'o(pair)', desc: 'The output channel pair the track plays to: .o(1) is channels 1/2, .o(2) is 3/4.', eg: '.o(2)' },
  bus: {
    kind: 'method',
    sig: 'bus(name, amount)',
    desc: 'Sends the signal at this point in the chain to a named bus.',
    eg: '.fx("Delay").bus("feedback").fx("Reverb")',
  },
  dry: { kind: 'method', sig: 'dry(value)', desc: 'The level of the track\'s own output alongside its bus sends, 1 by default.', eg: '.dry(0)' },
  wet: {
    kind: 'method',
    sig: 'wet(device?, value)',
    desc: 'Dry/wet mix of the plugin before it: 1 is fully processed, 0 bypasses it.',
    eg: '.fx("ValhallaRoom").wet(auto("breakdown"))',
  },
  split: {
    kind: 'method',
    sig: 'split(...branches)',
    desc: 'Runs parallel branches, each a function building a chain, and sums them.',
    eg: '.split((x) => x, (x) => x.fx("Reverb"))',
  },
  bands: {
    kind: 'method',
    sig: 'bands(freqs, ...branches)',
    desc: 'Splits the signal into bands at the given frequencies in Hz, one branch per band.',
    eg: '.bands([250], (low) => low, (high) => high.fx("Distort"))',
  },
  bsend: { kind: 'method', sig: 'bsend(name, amount)', desc: 'Sends the track\'s output to a named bus and silences its own output.', eg: '.bsend("reverb")' },
  vel: {
    kind: 'both',
    sig: 'vel(value) | vel',
    desc: 'Note velocity, from 0 to 1; bare vel reads the velocity of the note playing.',
    eg: '.vel("1 0.6 ~ 0.8")',
  },
  clip: {
    kind: 'both',
    sig: 'clip(value)',
    desc: 'How long each note rings, as a multiple of its step.',
    eg: '.clip("<1 4 1>*4")',
  },
  slide: {
    kind: 'both',
    sig: 'slide(value)',
    desc: 'Glides into each note marked 1 from the note before, without a new attack.',
    eg: '.slide("0 0 1 0")',
  },
  octave: {
    kind: 'both',
    sig: 'octave(value)',
    desc: 'Moves each note by whole octaves when it plays: 1 up, -1 down.',
    eg: '.octave("0 1 0 -1")',
  },
  legato: {
    kind: 'method',
    sig: 'legato()',
    desc: 'Holds every note until the next one starts.',
    eg: 'note("c3 ~ eb3 ~ ~ g2 ~ bb2").legato()',
  },
  nudge: {
    kind: 'both',
    sig: 'nudge(value)',
    desc: 'Moves each event off the grid by a fraction of its step; positive is late.',
    eg: '.nudge("0 0.04")',
  },
  swing: {
    kind: 'both',
    sig: 'swing(amount, grid)',
    desc: 'Delays every second slot of the grid by amount, a fraction of a slot (0.5 at most).',
    eg: 's("hh*8").swing(1/3)',
  },
  swinggrid: {
    kind: 'both',
    sig: 'swinggrid(value)',
    desc: 'Swing slots per cycle, 8 by default.',
    eg: '.swing(0.2, 16)',
  },
  swingvel: {
    kind: 'both',
    sig: 'swingvel(amount)',
    desc: 'How much of a groove\'s velocities to apply, from 0 to 1.',
    eg: '.swing(1, "myfeel").swingvel(0.5)',
  },

  // ----------------------------------------------------------------- shaping
  smooth: { kind: 'method', sig: 'smooth(time)', desc: 'Glides to each new value instead of jumping, over time seconds.', eg: 'param("Cutoff", "<0.2 0.8>".smooth(0.2))' },
  range: { kind: 'method', sig: 'range(min, max)', desc: 'Rescales a signal to run from min to max.', eg: '.range(200, 5000)' },
  fast: { kind: 'method', sig: 'fast(factor)', desc: 'Speeds the pattern up by factor.', eg: '.fast("<1 2>")' },
  slow: { kind: 'method', sig: 'slow(factor)', desc: 'Slows the pattern down, stretching it over factor cycles.', eg: '.slow(4)' },
  rate: { kind: 'method', sig: 'rate(rate)', desc: 'Sets a modulator\'s rate: passes per cycle, or "0.5hz" for a fixed speed.', eg: 'sine().rate(0.25)' },
  phase: { kind: 'method', sig: 'phase(offset)', desc: 'Shifts where a modulator starts, as a fraction of one pass.', eg: 'sine(0.5).phase(0.25)' },
  curve: { kind: 'method', sig: 'curve(c)', desc: 'Shapes an envelope\'s segments: negative is exponential, 0 linear, positive bowed.', eg: 'env().curve(-4)' },
  hold: {
    kind: 'both',
    sig: 'hold(trigger)',
    desc: 'Sample-and-hold: keeps the signal\'s value from each trigger until the next.',
    eg: 'rand().hold("1*8")',
  },
  seg: {
    kind: 'both',
    sig: 'seg(n)',
    desc: 'Samples the signal n times per cycle, holding each value for its step.',
    eg: 'rand().seg(8)',
  },
  bits: {
    kind: 'method',
    sig: 'bits(n = 8)',
    desc: 'The last n steps as a binary number from 0 to 1, a step with a note as 1.',
    eg: 'steps("x . x x . . x .").bits().range(0, 7)',
  },
  segment: { kind: 'both', sig: 'segment(n)', desc: 'Samples the signal n times per cycle, holding each value for its step.', eg: 'rand().segment(8)' },
  rib: {
    kind: 'method',
    sig: 'rib(cycle, length)',
    desc: 'Loops length cycles of the pattern, starting at cycle.',
    eg: 'irand(8).rib(0, 2)',
  },
  when: {
    kind: 'method',
    sig: 'when(condition, fn)',
    desc: 'Applies fn wherever condition is nonzero.',
    eg: '.when(rand().gte(0.7), x => x.add(flip(1)))',
  },
  sometimes: {
    kind: 'method',
    sig: 'sometimes(share, fn, { seed })',
    desc: 'Applies fn to a random share of events, from 0 to 1 (0.5 by default).',
    eg: '.sometimes(0.25, x => x.flip(1))',
  },
  as: {
    kind: 'method',
    sig: 'as(spec)',
    desc: 'Reads "a:b:c" values as the named fields, like "note:vel:clip".',
    eg: '"<36:1:4 ~>*8".as("note:vel:clip")',
  },
  degrade: { kind: 'method', sig: 'degrade(prob, seed)', desc: 'Randomly drops events with probability prob, 0.5 by default.', eg: '.degrade(0.3)' },
  mask: {
    kind: 'method',
    sig: 'mask(bool)',
    desc: 'Silences the pattern wherever the boolean pattern is off.',
    eg: '.mask("<1@7 0>")',
  },
  struct: {
    kind: 'both',
    sig: 'struct(bool, grid)',
    desc: 'Takes its rhythm from a boolean pattern and its values from this one.',
    eg: 'note("c3 g3").struct("1 ~ 1 1")',
  },
  advance: {
    kind: 'method',
    sig: 'advance(trigger, grid)',
    desc: 'Steps through this pattern\'s values, one per trigger.',
    eg: 'n("0 4 7").advance(button())',
  },
  elongate: {
    kind: 'method',
    sig: 'elongate(lengths)',
    desc: 'Holds each step for the given number of steps, delaying the steps after it.',
    eg: 'n("0 2 4 7").elongate("1 4 1 2")',
  },
  ply: { kind: 'method', sig: 'ply(reps, fn)', desc: 'Repeats each event reps times within its step; fn changes the nth repeat.', eg: '.ply(3, (x, n) => x.add(n * 12))' },
  echo: { kind: 'method', sig: 'echo(reps, time, fn)', desc: 'Repeats each event reps times, time cycles apart; fn changes the nth repeat.', eg: '.echo(4, 1/8, (x, n) => x.gain(0.6 ** n))' },
  arp: { kind: 'method', sig: 'arp(indices)', desc: 'Plays each chord one note at a time, in the order of the indices.', eg: 'note("[c3,e3,g3]").arp("0 1 2 1")' },
  chord: {
    kind: 'both',
    sig: 'chord(quality)',
    desc: 'Builds a chord on each note: a quality like "m7", or 7 for the key\'s seventh chord.',
    eg: 'n("0 3 4").sc().chord(7)',
  },
  inv: { kind: 'method', sig: 'inv(n)', desc: 'Inverts each chord n times; negative inverts downward.', eg: '.chord("m7").inv("<0 1 2>")' },
  voicing: {
    kind: 'method',
    sig: 'voicing(name)',
    desc: 'Re-voices each chord: close, open, drop2, drop3 or shell.',
    eg: '.chord(7).voicing("drop2")',
  },
  spread: { kind: 'method', sig: 'spread(amount)', desc: 'Widens each chord by amount octaves; negative narrows it.', eg: '.chord("maj9").spread(1)' },
  lead: {
    kind: 'method',
    sig: 'lead(anchor)',
    desc: 'Voice leading: each chord takes the inversion closest to the one before.',
    eg: 'note("<c3 a2 f2 g2>").chord("maj7").lead()',
  },
  bite: {
    kind: 'method',
    sig: 'bite(indices, {grid, len})',
    desc: 'Cuts the pattern into pieces and plays them in the order of the indices.',
    eg: 'n("0 1 2 3 4 5 6 7").bite("<0 12 2 9>*8")',
  },

  fmap: {
    kind: 'method',
    sig: 'fmap(fn)',
    desc: 'Passes every value through fn, keeping the timing.',
    eg: 'n("0 2 4").fmap((v) => v * 2)',
  },
  events: {
    kind: 'method',
    sig: 'events(fn)',
    desc: 'Hands fn each cycle\'s events as a list and plays the list it returns.',
    eg: '.events((es) => es.slice(0, 4))',
  },

  // ----------------------------------------------------------------- arithmetic
  set: {
    kind: 'both',
    sig: 'set(x, ...)',
    desc: 'Replaces each value with x; at the head of a chain, plays its layers together.',
    eg: '.set(vel(0.5))',
  },
  add: { kind: 'both', sig: 'add(x, ...)', desc: 'Adds x to each value; on notes, 2 is two semitones and n(2) two scale steps.', eg: '.add(n("<0 2 -1>"))' },
  sub: { kind: 'both', sig: 'sub(x, ...)', desc: 'Subtracts x from each value.', eg: '.sub(12)' },
  mul: { kind: 'both', sig: 'mul(x, ...)', desc: 'Multiplies each value by x.', eg: '.mul(speed(2))' },
  div: { kind: 'both', sig: 'div(x, ...)', desc: 'Divides each value by x.', eg: 'irand(8).div(8)' },
  mod: { kind: 'both', sig: 'mod(x, ...)', desc: 'Remainder after dividing by x, always positive.', eg: '.mod(12)' },
  round: { kind: 'method', sig: 'round()', desc: 'Rounds each value to the nearest whole number.', eg: 'rand().range(0, 7).round()' },
  abs: { kind: 'method', sig: 'abs()', desc: 'Makes each value positive.', eg: '.abs()' },
  floor: { kind: 'method', sig: 'floor()', desc: 'Rounds each value down to a whole number.', eg: '.floor()' },
  ceil: { kind: 'method', sig: 'ceil()', desc: 'Rounds each value up to a whole number.', eg: '.ceil()' },
  clamp: { kind: 'method', sig: 'clamp(lo, hi)', desc: 'Limits each value to between lo and hi. Both bounds can be patterns.', eg: '.clamp(0, 1)' },
  gte: { kind: 'method', sig: 'gte(x)', desc: '1 where the value is greater than or equal to x, 0 elsewhere.', eg: 'rand().gte(0.7)' },
  gt: { kind: 'method', sig: 'gt(x)', desc: '1 where the value is greater than x, 0 elsewhere.', eg: '.gt(0.5)' },
  lte: { kind: 'method', sig: 'lte(x)', desc: '1 where the value is less than or equal to x, 0 elsewhere.', eg: '.lte(0.5)' },
  lt: { kind: 'method', sig: 'lt(x)', desc: '1 where the value is less than x, 0 elsewhere.', eg: '.lt(0.5)' },
  eq: { kind: 'method', sig: 'eq(x)', desc: '1 where the value equals x, 0 elsewhere.', eg: '.eq(0)' },
  neq: { kind: 'method', sig: 'neq(x)', desc: '1 where the value differs from x, 0 elsewhere.', eg: '.neq(0)' },

  // ----------------------------------------------------------------- sampler controls
  // Each is both a method on a sampler pattern and a top-level control builder, so a combinator
  // can aim at one channel of a pattern it was handed (x.mul(speed("-1"))). At the head of a chain
  // the builder sets its own channel and supplies the trigger grid: speed("2").s("bd") is
  // s("bd").speed("2").
  i: { kind: 'both', sig: 'i(index)', desc: 'Which file of the sample pack to play, counting from 0.', eg: 's("breaks").i("<0 2>")' },
  begin: { kind: 'both', sig: 'begin(pos)', desc: 'Where in the sample playback starts, from 0 (the start) to 1 (the end).', eg: '.begin(irand(16).div(16))' },
  end: { kind: 'both', sig: 'end(pos)', desc: 'Where in the sample playback stops, from 0 (the start) to 1 (the end).', eg: '.end(0.25)' },
  loop: { kind: 'both', sig: 'loop(on)', desc: 'Loops the sample for each event\'s length instead of playing it once.', eg: '.loop()' },
  loopwrap: { kind: 'both', sig: 'loopwrap(mode)', desc: 'What loop() repeats: 0 the whole file, 1 just the begin..end window.', eg: '.loop().loopwrap(1)' },
  loopdir: { kind: 'both', sig: 'loopdir(mode)', desc: 'What loop() does at the edge: 0 restarts, 1 plays back and forth.', eg: '.loop().loopdir(1)' },
  speed: { kind: 'both', sig: 'speed(rate)', desc: 'Playback speed: 2 is an octave up, negative plays backwards from end.', eg: '.speed("<1 -1>")' },
  flip: { kind: 'both', sig: 'flip(on)', desc: 'Plays the sample backwards so it ends on the beat; above 0.5 is on.', eg: '.flip("<0 1>*2")' },
  stretch: { kind: 'both', sig: 'stretch(factor)', desc: 'Time-stretches the sample without changing its pitch: 2 is twice as long.', eg: '.stretch(2)' },
  stretchmode: { kind: 'both', sig: 'stretchmode(mode)', desc: 'How stretching sounds: "clean", or "grain" for overlapping grains.', eg: '.stretch(2).stretchmode("grain")' },
  bank: { kind: 'method', sig: 'bank(name)', desc: 'Plays each sample name from a drum bank: s("bd").bank("808") plays 808_bd.', eg: 's("bd sd").bank("808")' },
  fit: { kind: 'both', sig: 'fit(measures, mode?)', desc: 'Changes speed so the sample lasts exactly measures cycles.', eg: 's("breaks:19").fit()' },
  play: { kind: 'method', sig: 'play()', desc: 'Plays a long sample through, one slice per cycle, wrapping at the end.', eg: 's("files:vocal.wav").fit("stretch").play()' },
  fitmode: { kind: 'both', sig: 'fitmode(mode)', desc: 'How fit() reaches its length: "repitch", or "stretch" to keep the pitch.', eg: '.fit().fitmode("stretch")' },
  slice: { kind: 'both', sig: 'slice(n)', desc: 'Plays the nth slice of a WAV sample, cut at its transients.', eg: '.slice(irand(8))' },
  slices: { kind: 'method', sig: 'slices(set)', desc: 'Where slice() cuts the file: a slice count, a division like "1/8", or a drawn set.', eg: '.slices("1/8").slice("0 3 2 1")' },
  splice: { kind: 'both', sig: 'splice(n, mode?)', desc: 'Plays the nth transient slice, fitted to its event\'s length.', eg: '.splice("<0 1 2>*8")' },
  splicemode: { kind: 'both', sig: 'splicemode(mode)', desc: 'How splice() fits a slice: "repitch", or "stretch" to keep the pitch.', eg: '.splicemode("stretch")' },
  attack: { kind: 'both', sig: 'attack(seconds)', desc: 'Amp envelope attack, in seconds.', eg: '.attack(0.005)' },
  decay: { kind: 'both', sig: 'decay(seconds)', desc: 'Amp envelope decay, in seconds.', eg: '.decay(0.3)' },
  sustain: { kind: 'both', sig: 'sustain(level)', desc: 'Amp envelope sustain level, from 0 to 1.', eg: '.sustain(0.5)' },
  release: { kind: 'both', sig: 'release(seconds)', desc: 'Amp envelope release, in seconds.', eg: '.release(0.1)' },
  att: { kind: 'both', sig: 'att(seconds)', desc: 'Amp envelope attack, in seconds: short for attack().', eg: '.att(0.005)' },
  dec: { kind: 'both', sig: 'dec(seconds)', desc: 'Amp envelope decay, in seconds: short for decay().', eg: '.dec(0.3)' },
  sus: { kind: 'both', sig: 'sus(level)', desc: 'Amp envelope sustain level, from 0 to 1: short for sustain().', eg: '.sus(0.5)' },
  rel: { kind: 'both', sig: 'rel(seconds)', desc: 'Amp envelope release, in seconds: short for release().', eg: '.rel(0.1)' },
  grain: { kind: 'both', sig: 'grain(on)', desc: 'Plays the sample as a stream of short overlapping grains from around begin().', eg: 's("pad").grain().begin(0.3)' },
  grainsize: { kind: 'method', sig: 'grainsize(seconds)', desc: 'Length of each grain, in seconds. Turns grain() on.', eg: '.grainsize(0.08)' },
  grainrate: { kind: 'method', sig: 'grainrate(hz)', desc: 'Grains per second. Turns grain() on.', eg: '.grainrate(40)' },
  grainpan: { kind: 'method', sig: 'grainpan(position)', desc: 'Stereo position of each grain, from -1 to 1.', eg: '.grainpan(rand().range(-0.6, 0.6))' },
  grainshape: { kind: 'method', sig: 'grainshape(shape)', desc: 'Each grain\'s amplitude window, as a drawn shape or a shape name.', eg: '.grainshape("pluck")' },
  envscale: { kind: 'both', sig: 'envscale(factor)', desc: 'Multiplies the amp envelope\'s attack, decay and release times.', eg: '.attack(0.1).envscale(dur())' },
  adsr: { kind: 'method', sig: 'adsr(a, d, s, r)', desc: 'Sets the amp envelope: attack, decay and release in seconds, sustain from 0 to 1.', eg: '.adsr(0.005, 0.2, 0.6, 0.1)' },

  // ----------------------------------------------------------------- inline controls
  slider: {
    kind: 'builder',
    sig: 'slider(value, min?, max?, step?, { width, height }?)',
    desc: 'A slider in the code, as a signal from min to max (0 to 1 by default).',
    eg: 'param("Cutoff", slider(800, 100, 4000))',
  },
  knob: {
    kind: 'builder',
    sig: 'knob(value, min?, max?, step?, { size }?)',
    desc: 'A knob in the code, as a signal from min to max (0 to 1 by default).',
    eg: 'gain(knob(0.8, { size: 40 }))',
  },
  toggle: {
    kind: 'builder',
    sig: 'toggle(on?, { width, height }?)',
    desc: 'A switch in the code: 1 while on, 0 while off.',
    eg: 's("hh*8").gain(toggle(1))',
  },
  button: {
    kind: 'builder',
    sig: 'button({ width, height }?)',
    desc: 'A button in the code: 1 while held, 0 otherwise.',
    eg: 's("bd*4").struct(button())',
  },
  xy: {
    kind: 'builder',
    sig: 'xy(x?, y?, { size }?)',
    desc: 'A two-axis pad; read it with .x and .y, each from 0 to 1.',
    eg: 'const pad = xy(0.3, 0.6)',
  },
  steps: {
    kind: 'builder',
    sig: 'steps(cells, { width, height, mutate }?)',
    desc: 'A row of step cells played as a pattern: x is a hit, . a rest.',
    eg: 's("bd").struct(steps("x . . x . . x ."))',
  },
  sliders: {
    kind: 'builder',
    sig: 'sliders(values, min?, max?, { width, height, mutate, deviation }?)',
    desc: 'A row of bars, one per step, played as their values from min to max.',
    eg: 's("hh*8").vel(sliders("1 0.4 0.7 0.4"))',
  },
  matrix: {
    kind: 'builder',
    sig: 'matrix(rows, { width, height, mutate }?)',
    desc: 'A grid of step cells, one row per name, played as a pattern of the names.',
    eg: 's(matrix({ bd: "x . x .", hh: "x x x x" }))',
  },
  shiftreg: {
    kind: 'builder',
    sig: 'shiftreg(cells, mutate?, { width, height }?)',
    desc: 'A row of step cells read as a shift register: the last 8 steps as binary, 0 to 1.',
    eg: 'n(shiftreg(16).range(0, 7).floor())',
  },
  acid: {
    kind: 'builder',
    sig: 'acid(row, { mutate }?)',
    desc: 'Bars from 0 to 1 with accents, long gates, slides and octaves.',
    eg: 'acid(16).range("F1", "F3").round().synth("Acid")',
  },

  // ----------------------------------------------------------------- inline displays
  scope: {
    kind: 'both',
    sig: 'scope(opts?)',
    desc: 'An oscilloscope of the track, or of the song on a line of its own.',
    eg: 'note("c2 c3").scope()',
  },
  spectrum: {
    kind: 'both',
    sig: 'spectrum(opts?)',
    desc: 'The track\'s spectrum, or the song\'s on a line of its own.',
    eg: 's("bd*4, hh*8").spectrum()',
  },
  waveform: {
    kind: 'both',
    sig: 'waveform(opts?)',
    desc: 'The track\'s level over the last few cycles, or the song\'s on a line of its own.',
    eg: 's("bd*4, ~ sd").waveform({ cycles: 4 })',
  },
  imager: {
    kind: 'both',
    sig: 'imager(opts?)',
    desc: 'The track\'s stereo image, or the song\'s on a line of its own.',
    eg: 'note("c3 e3 g3").imager()',
  },
  meter: {
    kind: 'both',
    sig: 'meter({ width, height }?)',
    desc: 'A level meter of the track, or of the song on a line of its own.',
    eg: 's("bd*4").meter()',
  },
  punchcard: {
    kind: 'both',
    sig: 'punchcard(opts?)',
    desc: 'The pattern\'s events as they will play, or every track\'s on a line of its own.',
    eg: 'note("<c3 e3> g3 [b3 d4]").punchcard()',
  },
  plot: {
    kind: 'method',
    sig: 'plot(opts?)',
    desc: 'The signal\'s value over time, drawn under the line.',
    eg: 'param("Cutoff", sine(0.5).range(200, 2000).plot())',
  },
  chroma: {
    kind: 'both',
    sig: 'chroma(opts?)',
    desc: 'The pitch classes sounding now, on a circle.',
    eg: 'note("<[c3,e3,g3] [a2,c3,e3]>").chroma()',
  },
  color: {
    kind: 'method',
    sig: 'color(name?)',
    desc: 'The track\'s color, as a CSS color name or hex.',
    eg: 's("bd*4").color("tomato")',
  },

  // ----------------------------------------------------------------- debugging
  log: {
    kind: 'method',
    sig: 'log()',
    desc: 'Prints each event the track plays to the console.',
    eg: 's("bd*4").log()',
  },
};

// The Macros panel's knobs, pre-bound as ready-made signals (macro1..macro8 = macro(1)..macro(8)).
// Values, not functions - `call: false` keeps completion from typing an opening paren after them.
for (let k = 1; k <= 8; k++) {
  API_DOCS[`macro${k}`] = {
    kind: 'builder',
    call: false,
    sig: `macro${k}`,
    desc: `The current value of knob ${k} in the Macros panel, as a signal from 0 to 1.`,
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

// The keys a call's options object takes, each with its own description: what completion offers
// inside `sliders("...", 0, 1, { sp` and what hovering a key written there says. A key is a word of
// the call it is written in - `attack` in env()'s options is not the amp envelope's .attack() -
// so these are looked up by the call (see optionContext), never in API_DOCS.
const CELL_SIZE = {
  width: 'One cell\'s width, in pixels.',
  height: 'One cell\'s height, in pixels.',
  size: 'Both sides of a cell, in pixels.',
};
const LFO_OPTIONS = {
  rate: 'Passes per cycle, or "0.5hz" for a fixed speed; can be a pattern.',
  phase: 'Where in its pass it starts, from 0 to 1.',
};
const BOX_SIZE = {
  width: 'The width, in pixels.',
  height: 'The height, in pixels.',
};
const CURVE_OPTIONS = {
  curve: 'How it moves over its range: "lin", "exp", "pow" or "sym".',
  curveExp: 'How strongly "pow" and "sym" bend, above 0.',
};
const DISPLAY_BOX = {
  width: 'The display\'s width, in pixels.',
  height: 'The display\'s height, in pixels.',
};
const CELL_MUTATE = 'The chance each cell switches every cycle, 0 to 1.';
const OPTION_DOCS = {
  steps: { mutate: CELL_MUTATE, ...CELL_SIZE },
  matrix: { mutate: CELL_MUTATE, ...CELL_SIZE },
  shiftreg: { mutate: CELL_MUTATE, ...CELL_SIZE },
  acid: {
    mutate: 'The chance each step is thrown again every cycle, 0 to 1.',
    width: 'One step\'s width, in pixels.',
  },
  sliders: {
    mutate: 'The chance each bar is thrown again every cycle, 0 to 1.',
    deviation: 'How far a thrown bar lands from where it was, as a standard deviation.',
    width: 'One bar\'s width, in pixels.',
    height: 'One bar\'s height, in pixels.',
    size: 'One bar\'s height, in pixels.',
  },
  record: {
    cycles: 'How many cycles to record, 4 by default.',
    name: 'The file name of a track\'s recording.',
    wrapTail: 'true folds the tail back onto the start, so it loops cleanly.',
    normalize: 'false keeps the recording\'s level as played.',
    take: 'The name of a control\'s recorded movement, kept as a drawn shape.',
  },
  lfo: {
    rate: 'Passes per cycle, or "0.5hz" for a fixed speed; can be a pattern.',
    mode: 'free, retrigger (restarts each note) or envelope (once per note).',
    phase: 'Where in the shape it starts, from 0 to 1.',
    glide: 'How long it takes to move between patterned shapes.',
    smooth: 'How much the drawing is rounded off, from 0 to 1.',
  },
  env: {
    attack: 'Rise time in seconds, at each note\'s start or of a source\'s level.',
    decay: 'The fall from the peak to the sustain level, in seconds.',
    sustain: 'The level held while the note is held, from 0 to 1.',
    release: 'Fall time in seconds, after each note or of a source\'s level.',
    curve: 'Slope shape: negative exponential, 0 straight, positive bowed.',
    retrigger: 'false lets a new note continue from where the last one is.',
    min: 'Where it sits at silence, as .range() sets it. 0 by default.',
    max: 'Where it reaches at full level, as .range() sets it. 1 by default.',
  },
  sine: LFO_OPTIONS,
  saw: LFO_OPTIONS,
  isaw: LFO_OPTIONS,
  tri: LFO_OPTIONS,
  square: LFO_OPTIONS,
  perlin: { ...LFO_OPTIONS, seed: 'Two perlin()s with one seed drift together.' },
  rand: { seed: 'Two rand()s with one seed draw the same values.' },
  sometimes: { seed: 'Two calls with one seed pick the same events.' },
  midi: { note: 'The one MIDI note every event is sent as.' },
  audio: { gain: 'How much of the source is sent, 1 by default.' },
  slider: { ...BOX_SIZE, ...CURVE_OPTIONS, size: 'The slider\'s width, in pixels.' },
  knob: { size: 'The knob\'s diameter, in pixels.', ...CURVE_OPTIONS },
  toggle: { ...BOX_SIZE, size: 'The switch\'s width, in pixels.' },
  button: { ...BOX_SIZE, size: 'The button\'s width, in pixels.' },
  xy: { size: 'The pad\'s side, in pixels.' },
  scope: { ...DISPLAY_BOX, scale: 'Trace magnification, from 0.1 to 16.', window: 'Time shown, in milliseconds, from 2 to 40.' },
  spectrum: { ...DISPLAY_BOX, min: 'The level at the bottom, in dB.', max: 'The level at the top, in dB.' },
  waveform: { ...DISPLAY_BOX, cycles: 'How many cycles are drawn, from 1 to 16.' },
  punchcard: { ...DISPLAY_BOX, cycles: 'How many cycles are drawn, from 1 to 16.' },
  plot: { ...DISPLAY_BOX, cycles: 'How many cycles are drawn, from 1 to 16.', min: 'The value at the bottom.', max: 'The value at the top.' },
  meter: { width: 'The meter\'s width, in pixels.', height: 'The meter\'s height, in pixels.' },
  imager: { size: 'The side of the square, in pixels.' },
  chroma: { size: 'The side of the square, in pixels.' },
};

// The call an options object belongs to and the key being written in it, from `before` - the
// code up to the caret, or up to the start of a word: `{ call, key, method }` when it ends where a
// key goes in an object literal written as an argument of `call(...)` (straight after its `{`, or
// after a comma at the object's own level), else null. `key` is the part of the key already typed.
// Strings and comments are skipped; an object that is not an argument - a block, an arrow body,
// `const o = {` - is not an options object.
function optionContext(before) {
  const src = String(before);
  const key = /[A-Za-z_$][\w$]*$/.exec(src)?.[0] ?? '';
  const end = src.length - key.length;
  const stack = []; // open brackets: { ch, at, prev } - prev: the last code character before it
  let last = ''; // the last code character seen at the current position (not space, not in a string)
  let lastAt = -1;
  for (let i = 0; i < end; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < end && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < end && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < end && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      last = c; lastAt = i;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === '(' || c === '[' || c === '{') stack.push({ ch: c, at: i, prev: last, prevAt: lastAt });
    else if (c === ')' || c === ']' || c === '}') stack.pop();
    last = c; lastAt = i;
  }
  const obj = stack[stack.length - 1];
  const paren = stack[stack.length - 2];
  if (!obj || obj.ch !== '{' || !paren || paren.ch !== '(') return null;
  // An argument: right after the paren or a comma. And a key: right after the brace or a comma.
  if (obj.prev !== '(' && obj.prev !== ',') return null;
  if (last !== '{' && last !== ',') return null;
  const name = /([A-Za-z_$][\w$]*)\s*$/.exec(src.slice(0, paren.at));
  if (!name) return null;
  const method = /\.\s*$/.test(src.slice(0, paren.at - name[0].length));
  return { call: name[1], key, method, written: writtenKeys(src.slice(obj.at + 1, end)) };
}

// The keys already written at the top level of an object's text so far (`body`, after its `{`).
function writtenKeys(body) {
  const keys = [];
  let depth = 0;
  let expectKey = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < body.length && body[i] !== c) { if (body[i] === '\\') i++; i++; }
      expectKey = false;
      continue;
    }
    if (c === '/' && body[i + 1] === '/') { while (i < body.length && body[i] !== '\n') i++; continue; }
    if (c === '/' && body[i + 1] === '*') { i += 2; while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++; i++; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { expectKey = true; continue; }
    if (depth === 0 && expectKey && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
      if (m) keys.push(m[1]);
      expectKey = false;
      if (m) i += m[1].length - 1;
      continue;
    }
    if (!/\s/.test(c)) expectKey = false;
  }
  return keys;
}

// The doc for option `key` of `call`, shaped like lookupDoc's, or null when the call has no such key.
function lookupOptionDoc(call, key, method = false) {
  const desc = OPTION_DOCS[call]?.[key];
  if (!desc) return null;
  const sig = `${call}({ ${key} })`;
  return { name: key, kind: 'option', sig, desc, context: 'option', display: (method ? '.' : '') + sig };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { API_DOCS, BUILDERS, METHODS, lookupDoc, OPTION_DOCS, optionContext, lookupOptionDoc };
}
