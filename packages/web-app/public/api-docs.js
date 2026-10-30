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
// Short: what it does and what its arguments take, in a sentence or two where possible. Detail
// that belongs to another name's tooltip goes there, not here.

// The waveform LFOs share their rate/phase wording, so every entry says it in full.
const LFO_RATE = 'rate is passes per cycle, and can be a pattern like "<1 2 4>"; "0.5hz" is a fixed speed. Also accepts { rate, phase }.';

// The binops share their call-form wording the same way.
const BINOP_FORMS = (v) =>
  `.${v}.in(x) keeps this rhythm, .${v}.out(x) takes x's, .${v}.squeeze(x) fits a cycle of x into each event. Extra arguments are layers: each event plays once per layer.`;

const API_DOCS = {
  // ----------------------------------------------------------------- pattern sources
  n: {
    kind: 'both',
    sig: 'n(degrees)',
    desc: 'A pattern of scale degrees. They stay plain numbers until .scale() maps them to notes. On a sampler, each degree repitches the sample.',
    eg: 'n("0 2 3 <5 7>").scale("F minor")',
  },
  note: {
    kind: 'both',
    sig: 'note(pitches)',
    desc: 'A pattern of pitches, as note names or MIDI numbers (c3 = 60). On a sampler, it repitches the sample.',
    eg: 'note("c3 e3 g3").synth("Serum 2")',
  },
  s: {
    kind: 'both',
    sig: 's(pack)',
    desc: 'A sampler pattern. Each value is a sample pack name; add ":n" to play the pack\'s nth file.',
    eg: 's("bd*4, ~ hh ~ hh")',
  },
  se: {
    kind: 'both',
    sig: 'se(path)',
    desc: 'A sampler pattern that plays a single file, given by its path inside the samples folder. Quote paths that contain "/" or spaces.',
    eg: 'se("\'drums/kick 01.wav\'")',
  },
  sr: {
    kind: 'both',
    sig: 'sr(name)',
    desc: 'A sampler pattern that plays a recording from the recordings folder, by name. Add .slow(n) to hear an n-cycle recording in full.',
    eg: 'sr("bass").slow(8)',
  },
  sp: {
    kind: 'both',
    sig: 'sp(pack)',
    desc: 'A sampler pattern over a pack whose files you chose by hand. Double-click the name to build or edit the pack; ":n" or .i(n) plays its nth file.',
    eg: 'sp("kit:0 kit:1 kit:0 kit:2")',
  },
  say: {
    kind: 'both',
    sig: 'say(text, voice)',
    desc: 'Speaks text with a system voice, one word per step. The text is mini-notation, with punctuation kept in its word (i\'m, ok?); attach operators to the word (hi*2). voice is a pattern of voice names. Desktop only, on macOS.',
    eg: 'say("<hi@3 my name is@5 glossing ~@10>", "<Whisper Zarvox>")',
  },
  record: {
    kind: 'method',
    sig: 'record({ cycles, name, wrapTail, normalize, take })',
    desc: 'On a track, records it to audio; double-click the name or press {app+b} in the block to open the recorder. cycles is the length (4 by default), name the file name, wrapTail: true folds the tail onto the start, normalize: false keeps the level. On a knob, slider, toggle, button, xy, midicc, osc or macro, records its movement and loops it; take names the kept shape.',
    eg: 'note("c2 eb2").synth("Serum 2").record({ cycles: 8 })',
  },
  mini: {
    kind: 'builder',
    sig: 'mini(str)',
    desc: 'Parses a mini-notation string into a pattern. Quoted strings in pattern position are parsed this way automatically.',
    eg: 'mini("0 [1 2] <3 4>")',
  },
  Signal: {
    kind: 'builder',
    sig: 'Signal(value)',
    desc: 'Turns a number, string or pattern into a signal. Methods added to Signal.prototype become available on every chain.',
    eg: 'Signal.prototype.up = function (k) { return this.add(k); }',
  },
  synth: {
    kind: 'both',
    sig: 'synth(plugin, { label, state })',
    desc: 'Sets the track\'s instrument plugin. Double-click the name to open its window. label names it for .param() and .wet(); state is a captured plugin state to load.',
    eg: 'note("c2*4").synth("Serum 2")',
  },
  pianoroll: {
    kind: 'both',
    sig: 'pianoroll(names)',
    desc: 'Notes drawn in a piano roll; double-click the name to open it. With no name, the roll takes the track\'s. Names can be patterned: pianoroll("<lead alt>"). As a method, it plays alongside the notes already in the chain.',
    eg: 'lead: pianoroll().synth("Serum 2")',
  },
  clips: {
    kind: 'builder',
    sig: 'clips()',
    desc: 'Notes from the clips painted on this track\'s row in the arrangement ({app+a}); double-click a clip to draw in it. Copied clips share notes until "make unique".',
    eg: 'kick: clips().s("bd")',
  },

  // ----------------------------------------------------------------- live input
  midikeys: {
    kind: 'builder',
    sig: 'midikeys(device)',
    desc: 'Notes from a MIDI keyboard. Call the result with a channel (1-16), or with nothing for all channels.',
    eg: 'midikeys("KeyStep 32")(1).synth("Serum 2")',
  },
  midicc: {
    kind: 'builder',
    sig: 'midicc(device)',
    desc: 'A MIDI controller as a signal from 0 to 1. Call the result with (cc, channel).',
    eg: 'midicc("Twister")(12).range(200, 5000)',
  },
  osc: {
    kind: 'builder',
    sig: 'osc(address, index)',
    desc: 'The latest value received at an OSC address, as a signal. index picks the message argument (0 is the first). Listens on port 57160, or POPTART_OSC_IN_PORT.',
    eg: 'osc("/1/fader3").range(200, 5000)',
  },
  midi: {
    kind: 'both',
    sig: 'midi(source, channel)',
    desc: 'As a source: plays the track from a MIDI device or another track\'s notes; pitch changes apply to them, timing changes do not. After .fx(): sends MIDI to that plugin.',
    eg: 'note("c2*8").synth("Serum 2").fx("Kickstart").midi("kick")',
  },
  audio: {
    kind: 'both',
    sig: 'audio(source)',
    desc: 'As a source: runs a hardware input, another track or a bus through this track\'s chain. After .fx(): feeds that plugin\'s sidechain.',
    eg: 'audio("drums").fx("Saturn 2")',
  },
  group: {
    kind: 'builder',
    sig: 'group({ ...tracks })',
    desc: 'Mixes the tracks in its braces into one channel; .postgain(), .fx() and .bus() on it apply to all of them. {mod+g} wraps the selected tracks. main: group() with no braces takes every track not in another group.',
    eg: 'kick: group({\n  kickMain: s("mbd*4")\n  kickFill: s("mbd*8")\n}).postgain(0.8)',
  },
  copy: {
    kind: 'both',
    sig: 'copy(track)',
    desc: 'An independent duplicate of another track: its notes, controls, instrument and effects. As a method, the notes before it replace the copied ones.',
    eg: 'kick2: copy("kick").fast(2)',
  },
  pcopy: {
    kind: 'both',
    sig: 'pcopy(track)',
    desc: 'Another track\'s notes only, without its instrument, effects or controls. As a method, it replaces this chain\'s notes.',
    eg: 'b: pcopy("a").when(rand().gte(0.7), x => x.add(note(12))).synth("Sub Boombass")',
  },
  input: {
    kind: 'builder',
    sig: 'input(device?, ch, ch2?)',
    desc: 'A hardware audio input as the track\'s source. Channels count from 1: one plays mono, two a stereo pair. device picks the interface when a poptart aggregate device is in use.',
    eg: 'input("Scarlett", 1).fx("Pro-Q 4")',
  },
  macro: {
    kind: 'builder',
    sig: 'macro(index)',
    desc: 'The current value of a knob in the Macros panel, as a signal from 0 to 1.',
    eg: 'param("Filter 1 Freq", macro(3).range(200, 4000))',
  },

  // ----------------------------------------------------------------- modulators
  sine: { kind: 'builder', sig: 'sine(rate)', desc: `Sine wave from 0 to 1. ${LFO_RATE}`, eg: 'param("Cutoff", sine(0.25).range(200, 5000))' },
  saw: { kind: 'builder', sig: 'saw(rate)', desc: `Rising sawtooth: climbs from 0 to 1, then jumps back to 0. ${LFO_RATE}`, eg: 'pan(saw(0.25).range(-1, 1))' },
  isaw: { kind: 'builder', sig: 'isaw(rate)', desc: `Falling sawtooth: drops from 1 to 0, then jumps back to 1. ${LFO_RATE}`, eg: 'gain(isaw(4))' },
  tri: { kind: 'builder', sig: 'tri(rate)', desc: `Triangle wave: rises from 0 to 1 over the first half of each pass and falls back over the second. ${LFO_RATE}`, eg: 'gain(tri(0.5).range(0.4, 1))' },
  square: { kind: 'builder', sig: 'square(rate)', desc: `Square wave: 1 for the first half of each pass, 0 for the second. ${LFO_RATE}`, eg: 'param("Sub On", square(1))' },
  rand: {
    kind: 'builder',
    sig: 'rand({ seed })',
    desc: 'A random value from 0 to 1, fresh for every event. Step it with .seg(n) or .hold(pattern). Give two the same seed to share one stream.',
    eg: 'begin(rand().seg(8))',
  },
  perlin: {
    kind: 'builder',
    sig: 'perlin(rate)',
    desc: 'Smooth random drift from 0 to 1. rate is roughly new targets per cycle, or "0.5hz" for a fixed speed. Also accepts { rate, phase, seed }.',
    eg: 'pan(perlin(0.1).range(-0.6, 0.6))',
  },
  lfo: {
    kind: 'builder',
    sig: 'lfo(shape, { rate, mode, phase, glide })',
    desc: 'A modulator with a hand-drawn shape; double-click the name to draw it. Shape names can be patterned: lfo("<pluck swell>"). rate is passes per cycle or "0.5hz". mode is free, retrigger (restarts each note) or envelope (once per note). glide smooths between patterned shapes.',
    eg: 'lfo("<pluck swell>", { rate: 0.3, glide: 0.2 }).range(200, 5000)',
  },
  env: {
    kind: 'builder',
    sig: 'env({ attack, decay, sustain, release, curve, retrigger }) | env(source, { attack, release })',
    desc: 'With options: an ADSR envelope on each note; double-click the name to draw it. Times in seconds, sustain from 0 to 1, curve negative exponential to positive bowed, retrigger: true restarts it every note. With a source (a track, bus, input or audio signal): that source\'s level from 0 to 1, with attack and release (0.01 and 0.25 by default).',
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
    desc: 'A named automation lane, as a signal; double-click the name to draw it in the arrangement. It holds its first and last values outside the drawn points.',
    eg: 'param("Filter 1 Freq", auto("intro").range(200, 8000))',
  },

  // ----------------------------------------------------------------- pattern-of-patterns
  cat: {
    kind: 'builder',
    sig: 'cat(...patterns)',
    desc: 'Plays one pattern per cycle, in turn. Each resumes where the song is, not from its start.',
    eg: 'cat(n("0 2 3"), n("<5 7>")).synth("Serum 2")',
  },
  seq: {
    kind: 'builder',
    sig: 'seq(...patterns)',
    desc: 'Divides each cycle evenly between the patterns, one after another. Each plays at normal speed, so only part of it is heard.',
    eg: 'seq(s("bd*4"), s("hh*8"))',
  },
  // ----------------------------------------------------------------- randomness / tempo
  choose: {
    kind: 'builder',
    sig: 'choose(...options)',
    desc: 'Picks one of the options at random; [value, weight] pairs weight them. The same position always picks the same option.',
    eg: 'flip(choose("0", ["1", 0.3]))',
  },
  irand: {
    kind: 'builder',
    sig: 'irand(n)',
    desc: 'A random whole number from 0 to n-1, once per cycle, or once per step with a patterned n like "8!8". The same position always gives the same number.',
    eg: 'begin(irand(16).div(16))',
  },
  setbpm: {
    kind: 'builder',
    sig: 'setbpm(bpm)',
    desc: 'Sets the tempo in beats per minute, 4 beats to a cycle. Can be a pattern or signal.',
    eg: 'setbpm(140)',
  },
  samples: {
    kind: 'builder',
    sig: 'samples(repo, prefix?)',
    desc: 'Loads sample packs from a public GitHub repository, one per folder, named after it. "user/repo@branch" picks a branch, tag or commit; a path keeps one folder; prefix goes in front of every pack name. Browser build only.',
    eg: 'samples("tidalcycles/dirt-samples", "dirt")',
  },
  setscale: {
    kind: 'builder',
    sig: 'setscale(name)',
    desc: 'Sets the key .sc() uses, as "<root> <mode>"; the mode can be any tuning .scale() takes. The last one in the buffer applies.',
    eg: 'setscale("F minor")',
  },
  setgroove: {
    kind: 'builder',
    sig: 'setgroove(groove, depth?)',
    desc: 'Sets the groove for every track without its own swing: a groove name, a pattern of names, or a drawn table. depth is how much to apply (1 by default). .swing(0) keeps a track straight. The last one in the buffer applies.',
    eg: 'setgroove("clave16")',
  },

  // ----------------------------------------------------------------- music-theory helpers
  noteToMidi: { kind: 'builder', sig: 'noteToMidi(name)', desc: 'Converts a note name to a MIDI number, with c3 = 60.', eg: 'noteToMidi("f#3")' },
  degreeToMidi: { kind: 'builder', sig: 'degreeToMidi(degree, scale)', desc: 'Converts a scale degree to a MIDI number in the given scale.', eg: 'degreeToMidi(2, "F minor")' },
  parseScaleName: { kind: 'builder', sig: 'parseScaleName(scale)', desc: 'Splits a scale name into { rootMidi, intervals }, for writing your own chord or voicing functions.', eg: 'parseScaleName("Bb mixolydian")' },

  // ----------------------------------------------------------------- chain & channel strip
  fx: {
    kind: 'method',
    sig: 'fx(plugin, { label, state, loop })',
    desc: 'Adds an effect plugin to the end of the chain. Double-click the name to open its window; {app+f} inserts one. label names it for .param() and .wet(). On the Delay, a function builds a chain inside its feedback loop, so every repeat goes through it.',
    eg: '.fx("Delay", (x) => x.fx("Filter")).fx("ValhallaRoom")',
  },
  param: {
    kind: 'method',
    sig: 'param(device?, name, value)',
    desc: 'Sets a parameter of the last plugin in the chain, by name. Name a device first to reach it anywhere: its label, plugin name, or "Name#2" for the second. value is 0 to 1, or real units where the plugin has a mapping, and can be a pattern or signal.',
    eg: '.param("Filter 1 Freq", sine(0.2).range(300, 6000))',
  },
  preset: {
    kind: 'method',
    sig: 'preset(names)',
    desc: 'Switches the last plugin in the chain between its saved presets; can be patterned. Double-click the name to create or adjust one.',
    eg: '.preset("<init growl>")',
  },
  scale: {
    kind: 'method',
    sig: 'scale(name, keys)',
    desc: 'Maps scale degrees to notes in "<root> <mode>", or snaps notes to it, incoming MIDI included. "F2:minor" is the same scale, and patterns: "<F2:minor Ab2:major>". The mode can be a tuning: "31edo", "31edo major", step counts ("31edo 5 5 3 5 5 5 3"), ratios or cents ("9/8 5/4 3/2 2/1"), or a Scala file ("mytuning.scl", desktop only). keys "nearest" plays the tuning\'s pitch nearest each key.',
    eg: '.scale("<F2:minor F2:31edo:major>")',
  },
  ji: {
    kind: 'method',
    sig: 'ji(reference, limit)',
    desc: 'Retunes notes to just intonation: each chord to its own lowest note, or every note to a reference note (patternable). limit is 5 (default) or 7.',
    eg: 'note("<[c3,e3,g3] [f3,a3,c4]>").ji()',
  },
  sc: {
    kind: 'method',
    sig: 'sc(octave, keys)',
    desc: 'Maps scale degrees to notes in the key set by setscale(). octave places the root and can be patterned; .sc("nearest") snaps keys to the nearest pitch.',
    eg: 'n("0 2 4").sc(3)',
  },
  gain: { kind: 'method', sig: 'gain(value)', desc: 'The track\'s level before its effects, so it sets how hard they are driven. 1 is unity; several calls multiply.', eg: '.gain(0.5).gain(env())' },
  postgain: { kind: 'method', sig: 'postgain(value)', desc: 'The track\'s level after its effects: the mixer fader. 1 is unity; several calls multiply.', eg: '.postgain(0.7)' },
  pan: { kind: 'method', sig: 'pan(value)', desc: 'Stereo position, from -1 (left) to 1 (right); 0 is center.', eg: '.pan(sine(0.2).range(-1, 1))' },
  bend: {
    kind: 'method',
    sig: 'bend(semitones, range)',
    desc: 'Pitch bend in semitones for the whole track. range is the plugin\'s bend range (2 by default); samplers ignore it.',
    eg: '.bend(sine(0.5).range(-2, 2))',
  },
  bassmono: { kind: 'method', sig: 'bassmono(hz)', desc: 'Makes everything below hz mono, keeping the width above; 0 turns it off.', eg: '.width(1.6).bassmono(120)' },
  width: { kind: 'method', sig: 'width(amount)', desc: 'Stereo width: 0 is mono, 1 unchanged, up to 4 wider. Applied before pan.', eg: '.width(0.6).pan(-0.4)' },
  o: { kind: 'method', sig: 'o(pair)', desc: 'The output channel pair the track plays to: .o(1) is channels 1/2, .o(2) is 3/4.', eg: '.o(2)' },
  bus: {
    kind: 'method',
    sig: 'bus(name, amount)',
    desc: 'Sends the track to a named bus, which another track plays with audio("name"). Written mid-chain, it taps the signal at that point. Both arguments can be patterns; a rest turns the send off.',
    eg: '.fx("Delay").bus("feedback").fx("Reverb")',
  },
  dry: { kind: 'method', sig: 'dry(value)', desc: 'The level of the track\'s own output alongside its bus sends. 1 by default; 0 leaves only the sends.', eg: '.dry(0)' },
  wet: {
    kind: 'method',
    sig: 'wet(device?, value)',
    desc: 'Dry/wet mix of the plugin before it: 1 (the default) is fully processed, 0 bypasses it. Name a device first to reach it anywhere in the chain.',
    eg: '.fx("ValhallaRoom").wet(auto("breakdown"))',
  },
  split: {
    kind: 'method',
    sig: 'split(...branches)',
    desc: 'Runs parallel branches and sums them. Each branch is a function building a chain; its .postgain() and .pan() set its level and pan. (x) => x is the dry signal.',
    eg: '.split((x) => x, (b) => b.fx("LPG").param("Decay", 0.1)).fx("Reverb")',
  },
  bands: {
    kind: 'method',
    sig: 'bands(freqs, ...branches)',
    desc: 'Splits the signal into bands at the given frequencies in Hz and sums them back, one branch function per band from the lowest: N frequencies take N + 1 branches. Frequencies can be patterns or signals.',
    eg: '.bands([250, 2500], (low) => low, (mid) => mid.fx("Distort"), (high) => high)',
  },
  bsend: { kind: 'method', sig: 'bsend(name, amount)', desc: 'Sends the track\'s output to a named bus and silences its own output. Both arguments can be patterns.', eg: '.bsend("reverb")' },
  vel: {
    kind: 'both',
    sig: 'vel(value)',
    desc: 'Note velocity: MIDI velocity for a plugin, volume for a sample. A patterned vel plays a note on every step.',
    eg: '.vel("1 0.6 ~ 0.8")',
  },
  clip: {
    kind: 'both',
    sig: 'clip(value)',
    desc: 'How long each note rings, as a multiple of its step: .clip(2) holds every note for two steps.',
    eg: '.clip("<1 4 1>*4")',
  },
  legato: {
    kind: 'method',
    sig: 'legato()',
    desc: 'Holds every note until the next one starts, so the line plays connected. Replaces any clip; .mul(clip(0.9)) after it leaves a little air.',
    eg: 'note("c3 ~ eb3 ~ ~ g2 ~ bb2").legato()',
  },
  nudge: {
    kind: 'both',
    sig: 'nudge(value)',
    desc: 'Moves each event off the grid by a fraction of its step: positive is late, negative early, up to half a step.',
    eg: '.nudge("0 0.04")',
  },
  swing: {
    kind: 'both',
    sig: 'swing(amount, grid)',
    desc: 'Delays every second slot of a grid (8 slots per cycle by default). amount is a fraction of a slot: 1/3 is a triplet shuffle, 0.5 the most; a drum machine\'s percentage is (pct - 50) / 50. A groove name in place of the grid swings by that groove, with amount scaling it. Write fractions outside quotes.',
    eg: 's("hh*8").swing(1/3)',
  },
  swinggrid: {
    kind: 'both',
    sig: 'swinggrid(value)',
    desc: 'Swing slots per cycle: 8 (eighth notes) by default, 16 for sixteenths. Can be patterned.',
    eg: '.swing(0.2, 16)',
  },
  swingvel: {
    kind: 'both',
    sig: 'swingvel(amount)',
    desc: 'How much of a groove\'s velocities to apply: 0 none, 1 (the default) as drawn.',
    eg: '.swing(1, "myfeel").swingvel(0.5)',
  },

  // ----------------------------------------------------------------- shaping
  smooth: { kind: 'method', sig: 'smooth(time)', desc: 'Glides to each new value instead of jumping, taking about time seconds. Works on any signal; time can be patterned.', eg: 'param("Cutoff", "<0.2 0.8 0.5>".smooth(0.2))' },
  range: { kind: 'method', sig: 'range(min, max)', desc: 'Rescales a signal to run from min to max: from 0 to 1, or from -1 to 1 for audio. Both bounds can be patterns or signals.', eg: '.range(200, 5000)' },
  fast: { kind: 'method', sig: 'fast(factor)', desc: 'Speeds the pattern up by factor; a negative factor also reverses it. On a modulator, it multiplies the rate, and a patterned factor patterns the rate.', eg: '.fast("<1 2>")' },
  slow: { kind: 'method', sig: 'slow(factor)', desc: 'Slows the pattern down, stretching it over factor cycles; a negative factor also reverses it. On a modulator, it divides the rate.', eg: '.slow(4)' },
  rate: { kind: 'method', sig: 'rate(rate)', desc: 'Sets a modulator\'s rate: passes per cycle, following the tempo, or a value with a unit, like "0.5hz", for a fixed speed. Passes per cycle can be a pattern or signal: .rate("<1 2 4>").', eg: 'sine().rate(0.25)' },
  phase: { kind: 'method', sig: 'phase(offset)', desc: 'Shifts where a modulator starts, as a fraction of one pass: 0.25 starts a quarter of the way through.', eg: 'sine(0.5).phase(0.25)' },
  curve: { kind: 'method', sig: 'curve(c)', desc: 'Shapes an envelope\'s segments: negative is exponential, 0 is linear, positive bows outward.', eg: 'env().curve(-4)' },
  hold: {
    kind: 'both',
    sig: 'hold(trigger)',
    desc: 'Sample-and-hold: takes the signal\'s value at each trigger and keeps it until the next. With no trigger, at its own events, or once per cycle.',
    eg: 'rand().hold("1*8")',
  },
  seg: {
    kind: 'both',
    sig: 'seg(n)',
    desc: 'Reads the signal n times per cycle, holding each value for its step. n can be patterned. At the head of a chain, plays c3 n times a cycle.',
    eg: 'rand().seg(8)',
  },
  segment: { kind: 'both', sig: 'segment(n)', desc: 'Reads the signal n times per cycle, holding each value for its step. n can be patterned. At the head of a chain, plays c3 n times a cycle.', eg: 'rand().segment(8)' },
  rib: {
    kind: 'method',
    sig: 'rib(cycle, length)',
    desc: 'Repeats a stretch of the pattern forever: .rib(14, 2) loops cycles 14 and 15. A fractional length loops part of a cycle.',
    eg: 'irand(8).rib(0, 2)',
  },
  when: {
    kind: 'method',
    sig: 'when(condition, fn)',
    desc: 'Applies fn wherever condition is nonzero, checked at the pattern\'s own events.',
    eg: '.when(rand().gte(0.7), x => x.add(flip(1)))',
  },
  sometimes: {
    kind: 'method',
    sig: 'sometimes(share, fn, { seed })',
    desc: 'Applies fn to a random share of events: 0.3 is three in ten, and sometimes(fn) alone one in two. Give two calls the same seed to make them agree.',
    eg: '.sometimes(0.25, x => x.flip(1))',
  },
  as: {
    kind: 'method',
    sig: 'as(spec)',
    desc: 'Reads "a:b:c" values as named fields: note, n, or any control (vel, clip, nudge, i, begin, speed, …). An empty field keeps its default.',
    eg: '"<36:1:4 ~>*8".as("note:vel:clip")',
  },
  degrade: { kind: 'method', sig: 'degrade(prob, seed)', desc: 'Randomly drops events with probability prob (0.5 by default), the same ones every pass.', eg: '.degrade(0.3)' },
  mask: {
    kind: 'method',
    sig: 'mask(bool)',
    desc: 'Silences the pattern wherever the boolean pattern is off (~, 0 or f), cutting notes still ringing.',
    eg: '.mask("<1@7 0>")',
  },
  struct: {
    kind: 'both',
    sig: 'struct(bool)',
    desc: 'Takes its rhythm from a boolean pattern and its values from this one. At the head of a chain, plays c3 in that rhythm.',
    eg: 'note("c3 g3").struct("1 ~ 1 1")',
  },
  ply: { kind: 'method', sig: 'ply(reps, fn)', desc: 'Repeats each event reps times within its own step. The optional (x, n) => pattern changes the nth repeat.', eg: '.ply(3, (x, n) => x.add(n * 12))' },
  echo: { kind: 'method', sig: 'echo(reps, time, fn)', desc: 'Repeats each event reps times, time cycles apart. The optional (x, n) => pattern changes the nth repeat.', eg: '.echo(4, 1/8, (x, n) => x.gain(0.6 ** n))' },
  arp: { kind: 'method', sig: 'arp(indices)', desc: 'Plays each chord one note at a time, in the order of the index pattern. Indices past the top note continue an octave up. On scale degrees, apply .scale() first.', eg: 'note("[c3,e3,g3]").arp("0 1 2 1")' },
  chord: {
    kind: 'both',
    sig: 'chord(quality)',
    desc: 'Builds a chord on each note. A quality (m, m7, maj7, dom7, m9, sus4, dim, aug, add9), or a number stacking the key\'s thirds: 5 is the triad (default), 7, 9, 11 and 13 taller. The key is the pattern\'s scale, else setscale().',
    eg: 'n("0 3 4").sc().chord(7)',
  },
  inv: { kind: 'method', sig: 'inv(n)', desc: 'Inverts each chord n times, staying in the same register; negative inverts downward.', eg: '.chord("m7").inv("<0 1 2>")' },
  voicing: {
    kind: 'method',
    sig: 'voicing(name)',
    desc: 'Re-voices each chord: close, open (every second note up an octave), drop2, drop3, or shell (root, 3rd and 7th).',
    eg: '.chord(7).voicing("drop2")',
  },
  spread: { kind: 'method', sig: 'spread(amount)', desc: 'Widens each chord by amount octaves at its edges, the inner notes in proportion; negative narrows it.', eg: '.chord("maj9").spread(1)' },
  lead: {
    kind: 'method',
    sig: 'lead(anchor)',
    desc: 'Voice leading: each chord takes the inversion and octave closest to the chord before, staying near anchor (a note) if given.',
    eg: 'note("<c3 a2 f2 g2>").chord("maj7").lead()',
  },
  bite: {
    kind: 'method',
    sig: 'bite(indices, {grid, len})',
    desc: 'Rearranges the pattern: a window of len cycles (4 by default) is cut into grid pieces per cycle (8 by default), and each index plays that piece.',
    eg: 'n("0 1 2 3 4 5 6 7").bite("<0 12 2 9>*8")',
  },

  fmap: {
    kind: 'method',
    sig: 'fmap(fn)',
    desc: 'Passes every value through fn, keeping the timing. Rests stay rests.',
    eg: 'n("0 2 4").fmap((v) => v * 2)',
  },
  events: {
    kind: 'method',
    sig: 'events(fn)',
    desc: 'Hands fn each cycle\'s events as { start, end, value, vel, clip, nudge, controls } and plays what it returns. Events can be changed, dropped or added (start, end and value at minimum), and moved up to a cycle either way.',
    eg: '.events((es) => es.map((e) => ({ ...e, vel: e.vel * 0.8 })))',
  },

  // ----------------------------------------------------------------- arithmetic
  set: {
    kind: 'both',
    sig: 'set(x, ...)',
    desc: `Replaces each value with x; .set(vel(0.5)) sets the velocity. ${BINOP_FORMS('set')}`,
    eg: '.set(note(30).clip(2), add(note(12)).vel(0.7))',
  },
  add: { kind: 'both', sig: 'add(x, ...)', desc: `Adds x to each value. On notes, .add(2) is two semitones and .add(n(2)) two scale steps. ${BINOP_FORMS('add')}`, eg: '.add(n("<0 2 -1>"))' },
  sub: { kind: 'both', sig: 'sub(x, ...)', desc: `Subtracts x from each value. On notes, .sub(1) is a semitone and .sub(n(1)) one scale step. ${BINOP_FORMS('sub')}`, eg: '.sub(12)' },
  mul: { kind: 'both', sig: 'mul(x, ...)', desc: `Multiplies each value by x; .mul(speed("1.1,0.9")) plays two detuned hits. ${BINOP_FORMS('mul')}`, eg: '.mul(speed(2))' },
  div: { kind: 'both', sig: 'div(x, ...)', desc: `Divides each value by x. ${BINOP_FORMS('div')}`, eg: 'irand(8).div(8)' },
  mod: { kind: 'both', sig: 'mod(x, ...)', desc: `Remainder after dividing by x, always positive. On notes, .mod(12) folds into one octave. ${BINOP_FORMS('mod')}`, eg: '.mod(12)' },
  round: { kind: 'method', sig: 'round()', desc: 'Rounds each value to the nearest whole number.', eg: 'rand().range(0, 7).round()' },
  abs: { kind: 'method', sig: 'abs()', desc: 'Makes each value positive.', eg: '.abs()' },
  floor: { kind: 'method', sig: 'floor()', desc: 'Rounds each value down to a whole number.', eg: '.floor()' },
  ceil: { kind: 'method', sig: 'ceil()', desc: 'Rounds each value up to a whole number.', eg: '.ceil()' },
  clamp: { kind: 'method', sig: 'clamp(lo, hi)', desc: 'Limits each value to between lo and hi. Both bounds can be patterns.', eg: '.clamp(0, 1)' },
  gte: { kind: 'method', sig: 'gte(x)', desc: '1 where the value is greater than or equal to x, 0 elsewhere. A patterned x cuts each event where it changes; .gte.in(x) reads it once per event.', eg: 'rand().gte(0.7)' },
  gt: { kind: 'method', sig: 'gt(x)', desc: '1 where the value is greater than x, 0 elsewhere. A patterned x cuts each event where it changes; .gt.in(x) reads it once per event.', eg: '.gt(0.5)' },
  lte: { kind: 'method', sig: 'lte(x)', desc: '1 where the value is less than or equal to x, 0 elsewhere. A patterned x cuts each event where it changes; .lte.in(x) reads it once per event.', eg: '.lte(0.5)' },
  lt: { kind: 'method', sig: 'lt(x)', desc: '1 where the value is less than x, 0 elsewhere. A patterned x cuts each event where it changes; .lt.in(x) reads it once per event.', eg: '.lt(0.5)' },
  eq: { kind: 'method', sig: 'eq(x)', desc: '1 where the value equals x, 0 elsewhere. A patterned x cuts each event where it changes; .eq.in(x) reads it once per event.', eg: '.eq(0)' },
  neq: { kind: 'method', sig: 'neq(x)', desc: '1 where the value differs from x, 0 elsewhere. A patterned x cuts each event where it changes; .neq.in(x) reads it once per event.', eg: '.neq(0)' },

  // ----------------------------------------------------------------- sampler controls
  // Each is both a method on a sampler pattern and a top-level control builder, so a combinator
  // can aim at one channel of a pattern it was handed (x.mul(speed("-1"))). At the head of a chain
  // the builder sets its own channel and supplies the trigger grid: speed("2").s("bd") is
  // s("bd").speed("2").
  i: { kind: 'both', sig: 'i(index)', desc: 'Which file of the sample pack to play, counting from 0.', eg: 's("breaks").i("<0 2>")' },
  begin: { kind: 'both', sig: 'begin(pos)', desc: 'Where in the sample playback starts, from 0 (the start) to 1 (the end).', eg: '.begin(irand(16).div(16))' },
  end: { kind: 'both', sig: 'end(pos)', desc: 'Where in the sample playback stops, from 0 (the start) to 1 (the end).', eg: '.end(0.25)' },
  loop: { kind: 'both', sig: 'loop(on)', desc: 'Loops the sample for each event\'s length instead of playing it once, from begin().', eg: '.loop()' },
  loopwrap: { kind: 'both', sig: 'loopwrap(mode)', desc: 'What loop() repeats: 0 the whole file, 1 just the begin..end window.', eg: '.loop().loopwrap(1)' },
  loopdir: { kind: 'both', sig: 'loopdir(mode)', desc: 'What loop() does at the edge: 0 restarts, 1 plays back and forth.', eg: '.loop().loopdir(1)' },
  speed: { kind: 'both', sig: 'speed(rate)', desc: 'Playback speed: 2 is an octave up, negative plays backwards from end.', eg: '.speed("<1 -1>")' },
  flip: { kind: 'both', sig: 'flip(on)', desc: 'Above 0.5, plays the sample backwards so it ends on the beat.', eg: '.flip("<0 1>*2")' },
  stretch: { kind: 'both', sig: 'stretch(factor)', desc: 'Time-stretches the sample without changing its pitch: 2 is twice as long.', eg: '.stretch(2)' },
  bank: { kind: 'method', sig: 'bank(name)', desc: 'Plays each sample name from a bank of drum packs: s("bd").bank("808") plays 808_bd.', eg: 's("bd*4, [~ sd]*2").bank("808")' },
  fit: { kind: 'both', sig: 'fit(measures, mode?)', desc: 'Changes speed so the sample lasts exactly this many cycles, or the nearest power of two with none. mode is "repitch" (the default) or "stretch" to keep the pitch, and can stand alone: .fit("stretch").', eg: 's("breaks:19").fit()' },
  play: { kind: 'method', sig: 'play()', desc: 'Plays a long sample through, one slice per cycle, wrapping at the end.', eg: 's("files:vocal.wav").fit("stretch").play()' },
  fitmode: { kind: 'both', sig: 'fitmode(mode)', desc: 'How fit() reaches its length: 0 or "repitch" changes pitch with speed, 1 or "stretch" keeps it.', eg: '.fit().fitmode("stretch")' },
  slice: { kind: 'both', sig: 'slice(n)', desc: 'Plays the nth slice of the sample, cut at its detected transients, wrapping past the last. WAV files only.', eg: '.slice(irand(8))' },
  splice: { kind: 'both', sig: 'splice(n, mode?)', desc: 'Plays the nth transient slice fitted to its event: splice("<0 1 2>*8") plays each slice as an eighth note. mode "stretch" keeps the pitch. With no n, fits the begin..end window.', eg: '.splice("<0 1 2>*8")' },
  splicemode: { kind: 'both', sig: 'splicemode(mode)', desc: 'How splice() fits a slice: 0 or "repitch" changes pitch with speed, 1 or "stretch" keeps it.', eg: '.splice("0 1 2 3").splicemode("stretch")' },
  attack: { kind: 'both', sig: 'attack(seconds)', desc: 'Amp envelope attack, in seconds: the fade in at the start of each note.', eg: '.attack(0.005)' },
  decay: { kind: 'both', sig: 'decay(seconds)', desc: 'Amp envelope decay, in seconds: the fall from full level to sustain.', eg: '.decay(0.3)' },
  sustain: { kind: 'both', sig: 'sustain(level)', desc: 'Amp envelope sustain level, from 0 to 1.', eg: '.sustain(0.5)' },
  release: { kind: 'both', sig: 'release(seconds)', desc: 'Amp envelope release, in seconds: the fade out once the note ends (0.05 by default on samples).', eg: '.release(0.1)' },
  grain: { kind: 'both', sig: 'grain(on)', desc: 'Plays the sample as a stream of short overlapping grains from around begin(). Above 0.5 is on. A moving begin(), like an LFO, is read by every grain.', eg: 's("pad").grain().begin(saw(0.25).range(0.2, 0.6))' },
  grainsize: { kind: 'method', sig: 'grainsize(seconds)', desc: 'Length of each grain, in seconds. Turns grain() on.', eg: '.grainsize(0.08)' },
  grainrate: { kind: 'method', sig: 'grainrate(hz)', desc: 'Grains per second. Turns grain() on.', eg: '.grainrate(40)' },
  grainpan: { kind: 'method', sig: 'grainpan(position)', desc: 'Stereo position of each grain, from -1 to 1; a fast signal places every grain separately. Turns grain() on.', eg: '.grainpan(rand().range(-0.6, 0.6))' },
  grainshape: { kind: 'method', sig: 'grainshape(shape)', desc: 'Each grain\'s amplitude window: drawn breakpoints, a shape name, or a pattern of names; a bell by default. Double-click the name to draw it. Turns grain() on.', eg: '.grainshape("pluck")' },
  envscale: { kind: 'both', sig: 'envscale(factor)', desc: 'Multiplies the amp envelope\'s attack, decay and release times; .envscale(dur()) stretches it with each note.', eg: '.attack(0.1).envscale(dur())' },
  adsr: { kind: 'method', sig: 'adsr(a, d, s, r)', desc: 'Sets the amp envelope in one call: attack, decay and release in seconds, sustain from 0 to 1. Double-click the name to draw it over the sample.', eg: '.adsr(0.005, 0.2, 0.6, 0.1)' },

  // ----------------------------------------------------------------- inline controls
  slider: {
    kind: 'builder',
    sig: 'slider(value, min?, max?, step?, { width, height }?)',
    desc: 'A slider in the code, returning its position as a signal. Drag it, with shift for fine steps; the code updates and is heard at once. min and max default to 0 and 1; step snaps it. width and height in pixels.',
    eg: 'param("Cutoff", slider(800, 100, 4000))',
  },
  knob: {
    kind: 'builder',
    sig: 'knob(value, min?, max?, step?, { size }?)',
    desc: 'A knob in the code, returning its position as a signal. Drag up or down, with shift for fine steps; the code updates and is heard at once. min and max default to 0 and 1. size in pixels.',
    eg: 'gain(knob(0.8, { size: 40 }))',
  },
  toggle: {
    kind: 'builder',
    sig: 'toggle(on?, { width, height }?)',
    desc: 'A switch in the code: 1 while on, 0 while off. Clicking it updates the code and is heard at once. width and height in pixels.',
    eg: 's("hh*8").gain(toggle(1))',
  },
  button: {
    kind: 'builder',
    sig: 'button({ width, height }?)',
    desc: 'A button in the code: 1 while held, 0 otherwise. width and height in pixels.',
    eg: 's("bd*4").when(button().gt(0.5), x => x.fast(2))',
  },
  xy: {
    kind: 'builder',
    sig: 'xy(x?, y?, { size }?)',
    desc: 'A two-axis pad under the line, returning x with .x and .y, both 0 to 1. Dragging it updates the code and is heard at once. size in pixels.',
    eg: 'const pad = xy(0.3, 0.6)',
  },
  steps: {
    kind: 'builder',
    sig: 'steps(cells, { width, height }?)',
    desc: 'A row of step cells in place of the call, played as a pattern: x is 1, . ~ - or _ a rest, numbers and words play as written; steps(8) is 8 rests. Click a cell to switch it, right-click to randomize. width and height size a cell.',
    eg: 's("bd").struct(steps("x . . x . . x ."))',
  },
  sliders: {
    kind: 'builder',
    sig: 'sliders(values, min?, max?, { width, height }?)',
    desc: 'A bar per step in place of the call, played as their values. Drag a bar to set it, right-click to randomize. min and max default to 0 and 1; sliders(8) is 8 bars halfway up.',
    eg: 's("hh*8").vel(sliders("1 0.4 0.7 0.4 1 0.4 0.7 0.4"))',
  },
  matrix: {
    kind: 'builder',
    sig: 'matrix(rows, { width, height }?)',
    desc: 'A grid in place of the call, one row per name, played as a pattern of the names. Rows are cells as in steps(), or a count of rests: matrix({ bd: 8 }). Click or drag to switch cells, right-click to randomize.',
    eg: 's(matrix({ bd: "x . . . x . . .", sd: ". . . . x . . .", hh: "x x x x x x x x" }))',
  },

  // ----------------------------------------------------------------- inline displays
  scope: {
    kind: 'both',
    sig: 'scope(opts?)',
    desc: 'An oscilloscope of the track under the line; on a line of its own, of the song, behind the code. Options: width, height, scale, window (ms).',
    eg: 'note("c2 c3").synth("Wavetable").scope({ window: 30 })',
  },
  spectrum: {
    kind: 'both',
    sig: 'spectrum(opts?)',
    desc: 'The track\'s spectrum under the line; on a line of its own, the song\'s, behind the code. Options: width, height, min and max (dB).',
    eg: 's("bd*4, hh*8").spectrum()',
  },
  waveform: {
    kind: 'both',
    sig: 'waveform(opts?)',
    desc: 'The track\'s level over the last few cycles under the line; on a line of its own, the song\'s, behind the code. Options: width, height, cycles.',
    eg: 's("bd*4, ~ sd").waveform({ cycles: 4 })',
  },
  imager: {
    kind: 'both',
    sig: 'imager(opts?)',
    desc: 'The track\'s stereo image under the line; on a line of its own, the song\'s, behind the code. Option: size.',
    eg: 'note("c3 e3 g3").synth("Wavetable").imager()',
  },
  meter: {
    kind: 'both',
    sig: 'meter({ width, height }?)',
    desc: 'A level meter of the track before the call; on a line of its own, the song\'s, behind the code. width and height in pixels; taller than wide, it stands up.',
    eg: 's("bd*4").meter({ width: 12, height: 60 })',
  },
  punchcard: {
    kind: 'both',
    sig: 'punchcard(opts?)',
    desc: 'The pattern\'s events as they will play, under the line; on a line of its own, every track\'s, behind the code. Options: width, height, cycles.',
    eg: 'note("<c3 e3> g3 [b3 d4]").punchcard()',
  },
  plot: {
    kind: 'method',
    sig: 'plot(opts?)',
    desc: 'The signal\'s value over time, under the line. Options: width, height, cycles, min and max.',
    eg: 'param("Cutoff", sine(0.5).range(200, 2000).plot())',
  },
  chroma: {
    kind: 'both',
    sig: 'chroma(opts?)',
    desc: 'The pitch classes sounding now, on a circle under the line; on a line of its own, every track\'s, behind the code. Option: size.',
    eg: 'note("<[c3,e3,g3] [a2,c3,e3]>").chroma()',
  },
  color: {
    kind: 'method',
    sig: 'color(name?)',
    desc: 'The track\'s color in the arrangement, mixer and displays: a CSS color name or hex. Without one, the theme picks by name.',
    eg: 's("bd*4").color("tomato")',
  },

  // ----------------------------------------------------------------- debugging
  log: {
    kind: 'method',
    sig: 'log()',
    desc: 'Prints each event the track plays to the console, with the settings sent to the engine.',
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { API_DOCS, BUILDERS, METHODS, lookupDoc };
}
