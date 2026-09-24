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

// The waveform LFOs share their rate/phase wording, so every entry says it in full.
const LFO_RATE = 'rate is passes per cycle and follows the tempo; write it with a unit, like "0.5hz", for a fixed speed. Also accepts { rate, phase }.';

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
  record: {
    kind: 'method',
    sig: 'record({ cycles, name, wrapTail, normalize })',
    desc: 'Marks the track for recording; double-click the name, or press {app+b} inside the block, to open the recorder. cycles is the length (4 by default), name the file name (the track label by default), and wrapTail: true folds the release tail back onto the start, for a track that begins in silence. The finished take is scaled to a −1 dBFS peak; normalize: false keeps the recorded level.',
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
    sig: 'synth(plugin, { state })',
    desc: 'Sets the track\'s instrument plugin, by name. Double-click the name to open the plugin\'s window. The optional state is a captured plugin state to load.',
    eg: 'note("c2*4").synth("Serum 2")',
  },
  pianoroll: {
    kind: 'both',
    sig: 'pianoroll(names)',
    desc: 'Notes drawn in a piano roll; double-click the name to open it. With no name, the roll is named after its track. Names can be patterned: pianoroll("<lead alt>") alternates two rolls. As a method, it plays the roll alongside the notes already in the chain.',
    eg: 'lead: pianoroll().synth("Serum 2")',
  },
  clips: {
    kind: 'builder',
    sig: 'clips()',
    desc: 'A track whose notes come from the clips painted on its row in the arrangement ({app+a}). Each clip holds its own notes, played from the clip\'s start; double-click a clip to draw in it. Copied clips share their notes until you choose "make unique" in the clip\'s menu.',
    eg: 'kick: clips().s("bd")',
  },

  // ----------------------------------------------------------------- live input
  midikeys: {
    kind: 'builder',
    sig: 'midikeys(device)',
    desc: 'Notes from a MIDI keyboard. Call the result with a channel (1-16), or with nothing to hear all channels. Played directly by the audio engine, with no scheduling delay.',
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
    desc: 'The latest value received at an OSC address, as a signal. index picks which argument of the message to read (0 is the first). Listens on port 57160 unless POPTART_OSC_IN_PORT sets another. Silent until the first message arrives.',
    eg: 'osc("/1/fader3").range(200, 5000)',
  },
  midi: {
    kind: 'both',
    sig: 'midi(source, channel)',
    desc: 'As a source: plays the track from a MIDI device or from another track\'s notes. Pitch changes such as .add() and .scale() apply to each incoming note; timing changes such as .fast() and .rev() do not. As a method after .fx(): sends MIDI to that plugin.',
    eg: 'note("c2*8").synth("Serum 2").fx("Kickstart").midi("kick")',
  },
  audio: {
    kind: 'both',
    sig: 'audio(source)',
    desc: 'As a source: runs a hardware input, another track, or a bus through this track\'s chain. It plays whenever its source does, and has no row in the arrangement. As a method after .fx(): feeds that plugin\'s sidechain.',
    eg: 'audio("drums").fx("Saturn 2")',
  },
  group: {
    kind: 'builder',
    sig: 'group({ ...tracks })',
    desc: 'Mixes the tracks inside its braces into one channel. Members no longer play on their own, and .postgain(), .fx() or .bus() on the group apply to all of them. Groups can be nested. Select tracks and press {mod+g} to wrap them. A main: group() with no braces receives every track that is not in another group. Any other group written as name: group() with nothing inside gets its braces added on the next run, with the cursor placed between them.',
    eg: 'kick: group({\n  kickMain: s("mbd*4")\n  kickFill: s("mbd*8")\n}).postgain(0.8)',
  },
  copy: {
    kind: 'both',
    sig: 'copy(track)',
    desc: 'A duplicate of another track: its notes, controls, instrument and effects, as an independent track. As a method, the notes before it replace the copied ones - pianoroll("kickB").copy("kick") plays kick\'s chain with a different roll.',
    eg: 'kick2: copy("kick").fast(2)',
  },
  pcopy: {
    kind: 'both',
    sig: 'pcopy(track)',
    desc: 'Another track\'s notes only, without its instrument, effects, sampler settings or mix controls. As a method, it replaces this chain\'s notes.',
    eg: 'b: pcopy("a").when(rand().gte(0.7), x => x.add(note(12))).synth("Sub Boombass")',
  },
  input: {
    kind: 'builder',
    sig: 'input(device?, ch, ch2?)',
    desc: 'A hardware audio input as the track\'s source. Channels are numbered from 1: one channel plays mono in the center, two make a stereo pair. The optional device picks the interface when a poptart aggregate device is in use.',
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
  square: { kind: 'builder', sig: 'square(rate)', desc: `Square wave: 1 for the first half of each pass, 0 for the second. ${LFO_RATE}`, eg: 'param("Sub On", square(1))' },  rand: {
    kind: 'builder',
    sig: 'rand({ seed })',
    desc: 'A random value from 0 to 1, drawn fresh wherever it is read, so every event gets its own. It has no rate: use .seg(n) or .hold(pattern) to step it evenly. Each rand() is an independent stream; give two the same seed to share one.',
    eg: 'begin(rand().seg(8))',
  },
  perlin: {
    kind: 'builder',
    sig: 'perlin(rate)',
    desc: 'Smooth random drift from 0 to 1. rate is roughly how many new targets it heads for per cycle; write it with a unit, like "0.5hz", for a fixed speed. Also accepts { rate, phase, seed }; each perlin() drifts independently unless given the same seed.',
    eg: 'pan(perlin(0.1).range(-0.6, 0.6))',
  },
  lfo: {
    kind: 'builder',
    sig: 'lfo(shape, { rate, mode, phase, glide })',
    desc: 'A modulator with a hand-drawn shape; double-click the name to open the shape editor. Shape names can be patterned: lfo("<pluck swell>"). rate is passes per cycle, or "0.5hz" for a fixed speed. mode is free (loops continuously), retrigger (restarts on each note) or envelope (plays once per note, then holds). glide smooths the change between patterned shapes, as a fraction of a pass.',
    eg: 'lfo("<pluck swell>", { rate: 0.3, glide: 0.2 }).range(200, 5000)',
  },
  env: {
    kind: 'builder',
    sig: 'env({ attack, decay, sustain, release, curve })',
    desc: 'An ADSR envelope, triggered by the track\'s notes. attack, decay and release are in seconds; sustain is a level from 0 to 1. curve shapes each segment: negative is exponential, 0 is linear, positive bows outward.',
    eg: 'gain(env({ attack: 0.01, release: 0.3 }))',
  },
  dur: {
    kind: 'builder',
    sig: 'dur()',
    desc: 'The length of the current note, in seconds. Read by a sampler control, it is the length of the note being played; anywhere else, the length of the most recent note to start.',
    eg: 's("pad").attack(0.25).release(0.5).envscale(dur())',
  },
  auto: {
    kind: 'builder',
    sig: 'auto(name)',
    desc: 'A named automation lane, as a signal; double-click the name to draw it in the arrangement. Its values are placed on the song\'s bars, so every track reading the lane hears the same value at the same bar. Before the first point it stays at the first point\'s value, and after the last point at the last one\'s.',
    eg: 'param("Filter 1 Freq", auto("intro").range(200, 8000))',
  },

  // ----------------------------------------------------------------- pattern-of-patterns
  cat: {
    kind: 'builder',
    sig: 'cat(...patterns)',
    desc: 'Plays one pattern per cycle, in turn. Patterns keep their place in time while not heard, so each one resumes at the current cycle rather than from its start.',
    eg: 'cat(n("0 2 3"), n("<5 7>")).synth("Serum 2")',
  },
  seq: {
    kind: 'builder',
    sig: 'seq(...patterns)',
    desc: 'Divides each cycle evenly between the patterns, one after another. Each plays at its normal speed during its share, so only part of it is heard.',
    eg: 'seq(s("bd*4"), s("hh*8"))',
  },
  // ----------------------------------------------------------------- randomness / tempo
  choose: {
    kind: 'builder',
    sig: 'choose(...options)',
    desc: 'Picks one of the options at random. Pass [value, weight] pairs to make some likelier than others. The same position always picks the same option, so playback repeats exactly.',
    eg: 'flip(choose("0", ["1", 0.3]))',
  },
  irand: {
    kind: 'builder',
    sig: 'irand(n)',
    desc: 'A random whole number from 0 to n-1, one per cycle. A patterned n such as "8!8" draws once per step instead. The same position always gives the same number.',
    eg: 'begin(irand(16).div(16))',
  },
  setbpm: {
    kind: 'builder',
    sig: 'setbpm(bpm)',
    desc: 'Sets the tempo in beats per minute, with 4 beats to a cycle. Accepts a pattern or signal as well as a number.',
    eg: 'setbpm(140)',
  },
  setscale: {
    kind: 'builder',
    sig: 'setscale(name)',
    desc: 'Sets the key that .sc() uses, as "<root> <mode>". If there is more than one, the last in the buffer applies everywhere.',
    eg: 'setscale("F minor")',
  },

  // ----------------------------------------------------------------- music-theory helpers
  noteToMidi: { kind: 'builder', sig: 'noteToMidi(name)', desc: 'Converts a note name to a MIDI number, with c3 = 60.', eg: 'noteToMidi("f#3")' },
  degreeToMidi: { kind: 'builder', sig: 'degreeToMidi(degree, scale)', desc: 'Converts a scale degree to a MIDI number in the given scale.', eg: 'degreeToMidi(2, "F minor")' },
  parseScaleName: { kind: 'builder', sig: 'parseScaleName(scale)', desc: 'Splits a scale name into { rootMidi, intervals }, for writing your own chord or voicing functions.', eg: 'parseScaleName("Bb mixolydian")' },

  // ----------------------------------------------------------------- chain & channel strip
  fx: {
    kind: 'method',
    sig: 'fx(plugin, { state })',
    desc: 'Adds an effect plugin to the end of the track\'s chain. Double-click the name to open the plugin\'s window; {app+f} inserts one at the cursor. .param() calls after it set this plugin\'s parameters.',
    eg: '.fx("ValhallaRoom").param("Mix", 0.3)',
  },
  param: {
    kind: 'method',
    sig: 'param(name, value)',
    desc: 'Sets a parameter of the last plugin in the chain, by the name the plugin gives it. Names autocomplete inside the quotes. The value is a position from 0 to 1, as a number, pattern or signal; a mapping file can give a plugin parameter real units instead. A browser device\'s switch takes its option\'s name, its on/off takes 0 or 1, and a control that loads a sample takes the sample\'s name, "pack:index" or "pack:file". Given an audio() handle instead, the parameter is wired to that track or bus and follows it at the sample rate; .mul() and .add() on the handle set its gain and offset. Wiring audio onto a parameter is a browser-build feature: the desktop engine reports it on the console and plays the rest of the track as written.',
    eg: '.param("Cutoff", sine(0.2).range(0.3, 0.8))',
  },
  preset: {
    kind: 'method',
    sig: 'preset(names)',
    desc: 'Switches the last plugin in the chain between saved presets, and can be patterned. Preset names belong to their plugin. Double-click the name to create or adjust a preset.',
    eg: '.preset("<init growl>")',
  },
  scale: {
    kind: 'method',
    sig: 'scale(name)',
    desc: 'Maps scale degrees to notes in a scale ("<root> <mode>"), or snaps note pitches into it. Also applies to incoming MIDI notes.',
    eg: '.scale("F minor")',
  },
  sc: {
    kind: 'method',
    sig: 'sc(octave)',
    desc: 'Maps scale degrees to notes in the key set by setscale(). The optional octave places the scale\'s root, and can be patterned.',
    eg: 'n("0 2 4").sc(3)',
  },
  gain: { kind: 'method', sig: 'gain(value)', desc: 'The track\'s input level, before its effects - lower values drive compressors, saturation and reverbs less. 1 is unity. Several .gain() calls multiply together.', eg: '.gain(0.5).gain(env())' },
  postgain: { kind: 'method', sig: 'postgain(value)', desc: 'The track\'s output level, after its effects and before bus sends; this is the fader the mixer moves. 1 is unity. Several .postgain() calls multiply together.', eg: '.postgain(0.7)' },
  pan: { kind: 'method', sig: 'pan(value)', desc: 'Stereo position, from -1 (left) to 1 (right); 0 is center.', eg: '.pan(sine(0.2).range(-1, 1))' },
  bend: {
    kind: 'method',
    sig: 'bend(semitones, range)',
    desc: 'Pitch bend in semitones for the whole track: a sampler repitches, a plugin receives MIDI pitch bend. range is the plugin\'s bend range in semitones (2 by default); samplers ignore it.',
    eg: '.bend(sine(0.5).range(-2, 2))',
  },
  bassmono: { kind: 'method', sig: 'bassmono(hz)', desc: 'Makes everything below hz mono while keeping the stereo width above it; 0 turns it off. The low end keeps its level, only its width is removed.', eg: '.width(1.6).bassmono(120)' },
  width: { kind: 'method', sig: 'width(amount)', desc: 'Stereo width: 0 is mono, 1 is unchanged, and values up to 4 widen. Has no effect on a mono source. Applied before pan. Values above 1 can thin out when played back in mono.', eg: '.width(0.6).pan(-0.4)' },
  o: { kind: 'method', sig: 'o(pair)', desc: 'The output channel pair the track plays to: .o(1) is channels 1/2, .o(2) is 3/4. Wraps around at the "output channels" setting, which is 2 by default.', eg: '.o(2)' },
  bus: {
    kind: 'method',
    sig: 'bus(name, amount)',
    desc: 'Sends the track\'s output to a named bus, which another track plays with audio("name"). The track\'s own output is unaffected. Both arguments can be patterns: a patterned name moves the send between buses, and a rest turns it off.',
    eg: '.bus("reverb", sine().range(0, 0.6))',
  },
  dry: { kind: 'method', sig: 'dry(value)', desc: 'The level of the track\'s own output alongside its bus sends. 1 by default; 0 leaves only the sends.', eg: '.dry(0)' },
  wet: {
    kind: 'method',
    sig: 'wet(value)',
    desc: 'Dry/wet mix for the plugin just before it in the chain: 1 (the default) is fully processed, 0 bypasses it. Accepts any signal, so an effect can fade in and out over a song. Plugins that add latency, such as linear-phase EQs, can sound hollow at in-between values.',
    eg: '.fx("ValhallaRoom").wet(auto("breakdown"))',
  },
  bsend: { kind: 'method', sig: 'bsend(name, amount)', desc: 'Sends the track\'s output to a named bus and silences its own output. Both arguments can be patterns.', eg: '.bsend("reverb")' },
  vel: {
    kind: 'both',
    sig: 'vel(value)',
    desc: 'Note velocity: MIDI velocity for a plugin, volume for a sample. A patterned vel also sets the rhythm, playing a note on every step. In arithmetic it targets velocity: .mul(vel(0.5)) halves it.',
    eg: '.vel("1 0.6 ~ 0.8")',
  },
  clip: {
    kind: 'both',
    sig: 'clip(value)',
    desc: 'How long each note rings, as a multiple of its step: .clip(2) holds every note for two steps. Setting it replaces the current value; in arithmetic it combines: .mul(clip(2)) doubles it.',
    eg: '.clip("<1 4 1>*4")',
  },
  nudge: {
    kind: 'both',
    sig: 'nudge(value)',
    desc: 'Moves each event off the grid by a fraction of its step: positive is late, negative early, up to half a step. Only the timing changes, not the pattern.',
    eg: '.nudge("0 0.04")',
  },
  swing: {
    kind: 'both',
    sig: 'swing(amount, grid)',
    desc: 'Delays every second slot of a grid (8 slots per cycle by default). amount is a fraction of one slot: 1/3 is a triplet shuffle, 0.5 the maximum. A drum machine\'s swing percentage converts as (pct - 50) / 50. Adds to any .nudge(). Write fractions outside quotes, since "1/3" in mini-notation means slow.',
    eg: 's("hh*8").swing(1/3)',
  },
  swinggrid: {
    kind: 'both',
    sig: 'swinggrid(value)',
    desc: 'The number of swing slots per cycle: 8 (eighth notes) by default, 16 for sixteenth notes. Can be patterned.',
    eg: '.swing(0.2, 16)',
  },

  // ----------------------------------------------------------------- shaping
  range: { kind: 'method', sig: 'range(min, max)', desc: 'Rescales a 0 to 1 signal to run from min to max. Both bounds can be patterns or signals.', eg: '.range(200, 5000)' },
  fast: { kind: 'method', sig: 'fast(factor)', desc: 'Speeds the pattern up by factor; a negative factor also reverses it. On a modulator, it multiplies the rate.', eg: '.fast("<1 2>")' },
  slow: { kind: 'method', sig: 'slow(factor)', desc: 'Slows the pattern down, stretching it over factor cycles; a negative factor also reverses it. On a modulator, it divides the rate.', eg: '.slow(4)' },
  rate: { kind: 'method', sig: 'rate(rate)', desc: 'Sets a modulator\'s rate: passes per cycle, following the tempo, or a value with a unit, like "0.5hz", for a fixed speed.', eg: 'sine().rate(0.25)' },
  phase: { kind: 'method', sig: 'phase(offset)', desc: 'Shifts where a modulator starts, as a fraction of one pass: 0.25 starts a quarter of the way through.', eg: 'sine(0.5).phase(0.25)' },
  curve: { kind: 'method', sig: 'curve(c)', desc: 'Shapes an envelope\'s segments: negative is exponential, 0 is linear, positive bows outward.', eg: 'env().curve(-4)' },
  hold: {
    kind: 'method',
    sig: 'hold(trigger)',
    desc: 'Sample-and-hold: takes the signal\'s value at each trigger and keeps it until the next. With no trigger, it holds at the signal\'s own events, or once per cycle.',
    eg: 'rand().hold("1*8")',
  },
  seg: {
    kind: 'method',
    sig: 'seg(n)',
    desc: 'Reads the signal n times per cycle, holding each value for its step, which turns a continuous signal into a rhythm. n can be patterned.',
    eg: 'rand().seg(8)',
  },
  segment: { kind: 'method', sig: 'segment(n)', desc: 'Reads the signal n times per cycle, holding each value for its step, which turns a continuous signal into a rhythm. n can be patterned.', eg: 'rand().segment(8)' },
  rib: {
    kind: 'method',
    sig: 'rib(cycle, length)',
    desc: 'Repeats a stretch of the pattern forever: .rib(14, 2) loops cycles 14 and 15. A fractional length loops part of a cycle.',
    eg: 'irand(8).rib(0, 2)',
  },
  when: {
    kind: 'method',
    sig: 'when(condition, fn)',
    desc: 'Applies fn wherever condition is nonzero. The condition is checked only at the pattern\'s own events and never adds new ones.',
    eg: '.when(rand().gte(0.7), x => x.add(flip(1)))',
  },
  sometimes: {
    kind: 'method',
    sig: 'sometimes(share, fn, { seed })',
    desc: 'Applies fn at a random share of the pattern\'s events: 0.3 is three in ten, and sometimes(fn) alone is one in two. Each call tosses its own coin, so two sometimes() on one track fire independently; give both the same seed to make them agree. Same as when() with a rand() condition.',
    eg: '.sometimes(0.25, x => x.flip(1))',
  },
  as: {
    kind: 'method',
    sig: 'as(spec)',
    desc: 'Reads "a:b:c" values as named fields, so one string can carry pitch, sample choice, velocity and timing. Fields can be note, n, or any control (vel, clip, nudge, i, begin, speed, …). An empty field keeps its default: "38::0.04" leaves the second field unset.',
    eg: '"<36:1:4 ~>*8".as("note:vel:clip")',
  },
  degrade: { kind: 'method', sig: 'degrade(prob, seed)', desc: 'Randomly drops events, with probability prob (0.5 by default). The same events drop on every pass. Mini-notation\'s "?" does the same.', eg: '.degrade(0.3)' },
  mask: {
    kind: 'method',
    sig: 'mask(bool)',
    desc: 'Silences the pattern wherever the boolean pattern is off, without changing its rhythm: events that start while off are dropped, and notes still ringing when it turns off are cut. Off is ~, 0 or f.',
    eg: '.mask("<1@7 0>")',
  },
  struct: {
    kind: 'method',
    sig: 'struct(bool)',
    desc: 'Takes its rhythm from a boolean pattern and its values from this one: each on step plays whatever this pattern holds at that moment.',
    eg: 'note("c3 g3").struct("1 ~ 1 1")',
  },
  ply: { kind: 'method', sig: 'ply(reps, fn)', desc: 'Repeats each event reps times within its own step. The optional (x, n) => pattern changes the nth repeat.', eg: '.ply(3, (x, n) => x.add(n * 12))' },
  echo: { kind: 'method', sig: 'echo(reps, time, fn)', desc: 'Repeats each event reps times, time cycles apart. The optional (x, n) => pattern changes the nth repeat.', eg: '.echo(4, 1/8, (x, n) => x.gain(0.6 ** n))' },
  arp: { kind: 'method', sig: 'arp(indices)', desc: 'Plays each chord one note at a time, in the order of the index pattern. Indices past the top note continue an octave up. On scale degrees, apply .scale() first.', eg: 'note("[c3,e3,g3]").arp("0 1 2 1")' },
  bite: {
    kind: 'method',
    sig: 'bite(indices, {grid, len})',
    desc: 'Rearranges the pattern: a window of len cycles (4 by default) is cut into grid pieces per cycle (8 by default), and each index plays that piece. Fractional indices start partway into a piece; notes keep their written lengths.',
    eg: 'n("0 1 2 3 4 5 6 7").bite("<0 12 2 9>*8")',
  },

  // ----------------------------------------------------------------- arithmetic
  set: {
    kind: 'both',
    sig: 'set(x, ...)',
    desc: 'Replaces each value with x, keeping this pattern\'s rhythm; .set(vel(0.5)) puts 0.5 on the velocity channel. Several arguments, or one that carries its own controls, are layers: each event plays once per layer, edited by it. A bare control inside a layer takes this verb too, and names another with a binop of its own. Under .set() a bare control is pinned: .set(note(30).clip(2), add(note(12)).vel(0.7)) plays a c1 twice as long plus the octave at exactly 0.7. As a top-level call it is that verb for one piece of a layer: .add(note(12).set(vel(0.7))) is the octave at 0.7 rather than 0.7 louder.',
    eg: '.set(note(30).clip(2), add(note(12)).vel(0.7))',
  },
  add: { kind: 'both', sig: 'add(x, ...)', desc: 'Adds x to each value, keeping this pattern\'s rhythm. On notes, .add(2) is two semitones and .add(n(2)) is two steps in the current scale. A stacked value like note("0,7") plays each layer at once. Several arguments, or one that carries its own controls, are layers: each event plays once per layer, edited by it. A bare control inside a layer takes this verb too, and names another with a binop of its own. .add(note(0), note(12).mul(vel(0.7))) plays each note plus its octave at 70% of the velocity. As a top-level call it is that verb for one piece of a layer: .set(note(30), add(note(12))).', eg: '.add(n("<0 2 -1>"))' },
  sub: { kind: 'both', sig: 'sub(x, ...)', desc: 'Subtracts x from each value, keeping this pattern\'s rhythm. On notes, .sub(1) is a semitone and .sub(n(1)) is one step in the current scale. A stacked value plays each layer at once. Several arguments, or one that carries its own controls, are layers: each event plays once per layer, edited by it. A bare control inside a layer takes this verb too, and names another with a binop of its own. As a top-level call it is that verb for one piece of a layer: sub(clip(0.5)).', eg: '.sub(12)' },
  mul: { kind: 'both', sig: 'mul(x, ...)', desc: 'Multiplies each value by x, keeping this pattern\'s rhythm. A stacked value plays each layer at once: .mul(speed("1.1,0.9")) plays two detuned hits. Several arguments, or one that carries its own controls, are layers: each event plays once per layer, edited by it. A bare control inside a layer takes this verb too, and names another with a binop of its own. As a top-level call it is that verb for one piece of a layer: mul(vel(0.7)).', eg: '.mul(speed(2))' },
  div: { kind: 'both', sig: 'div(x, ...)', desc: 'Divides each value by x, keeping this pattern\'s rhythm. Several arguments, or one that carries its own controls, are layers: each event plays once per layer, edited by it. A bare control inside a layer takes this verb too, and names another with a binop of its own. As a top-level call it is that verb for one piece of a layer: div(clip(2)).', eg: 'irand(8).div(8)' },
  mod: { kind: 'both', sig: 'mod(x, ...)', desc: 'Remainder after dividing by x, always positive, keeping this pattern\'s rhythm. On notes, .mod(12) folds into one octave of semitones and .mod(n(7)) into one octave of the current scale. Several arguments, or one that carries its own controls, are layers: each event plays once per layer, edited by it. A bare control inside a layer takes this verb too, and names another with a binop of its own. As a top-level call it is that verb for one piece of a layer: mod(note(12)).', eg: '.mod(12)' },
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
  loop: { kind: 'both', sig: 'loop(on)', desc: 'Loops the sample for the length of each event instead of playing it once, starting from begin(). loop(0) also stops a negative speed from looping.', eg: '.loop()' },
  loopwrap: { kind: 'both', sig: 'loopwrap(mode)', desc: 'Which part of the sample loop() repeats: 0 loops the whole file (begin only sets where playback enters), 1 loops just the begin..end window. Values are rounded and wrap around, so any signal works.', eg: '.loop().loopwrap(1)' },
  loopdir: { kind: 'both', sig: 'loopdir(mode)', desc: 'What loop() does at the edge of its region: 0 restarts from the region\'s start, 1 reverses direction and alternates forward and backward passes. Values are rounded and wrap around, so any signal works.', eg: '.loop().loopdir(1)' },
  speed: { kind: 'both', sig: 'speed(rate)', desc: 'Playback speed: 2 is an octave up and half as long, 0 is silent, and negative plays backwards from end, looping unless loop(0) is set.', eg: '.speed("<1 -1>")' },
  flip: { kind: 'both', sig: 'flip(on)', desc: 'Reverses the sample so it ends on the beat: above 0.5, it plays backwards and is delayed so it reaches begin at the end of the step.', eg: '.flip("<0 1>*2")' },
  stretch: { kind: 'both', sig: 'stretch(factor)', desc: 'Time-stretches the sample without changing its pitch: 2 is twice as long. Works best on rhythmic material.', eg: '.stretch(2)' },
  fit: { kind: 'both', sig: 'fit(measures)', desc: 'Changes playback speed so the sample lasts exactly this many cycles. With no argument, uses the nearest power of two.', eg: 's("breaks:19").fit()' },
  slice: { kind: 'both', sig: 'slice(n)', desc: 'Plays the nth slice of the sample, cut at its detected transients, wrapping past the last. WAV files only.', eg: '.slice(irand(8))' },
  splice: { kind: 'both', sig: 'splice(n, mode?)', desc: 'Plays the nth transient slice, fitted to the length of its event: splice("<0 1 2>*8") plays each slice as an eighth note. Fits by changing speed unless mode is "stretch". With no n, fits the current begin..end window. speed and note apply on top, and fit is ignored.', eg: '.splice("<0 1 2>*8")' },
  splicemode: { kind: 'both', sig: 'splicemode(mode)', desc: 'How splice fits a slice to its event: 0 or "repitch" changes speed and pitch together, 1 or "stretch" keeps the pitch. Values are rounded and wrap around, so any signal works.', eg: '.splice("0 1 2 3").splicemode("stretch")' },
  attack: { kind: 'both', sig: 'attack(seconds)', desc: 'Sampler envelope attack time, in seconds: the fade in from silence at the start of each note.', eg: '.attack(0.005)' },
  decay: { kind: 'both', sig: 'decay(seconds)', desc: 'Sampler envelope decay time, in seconds: the fall from full level to the sustain level.', eg: '.decay(0.3)' },
  sustain: { kind: 'both', sig: 'sustain(level)', desc: 'Sampler envelope sustain level, from 0 to 1.', eg: '.sustain(0.5)' },
  release: { kind: 'both', sig: 'release(seconds)', desc: 'Sampler envelope release time, in seconds: the fade out once the note ends. 0.05 where unset.', eg: '.release(0.1)' },
  grain: { kind: 'both', sig: 'grain(on)', desc: 'Plays the sample as a stream of short overlapping grains cut from around begin(), instead of one pass through it. Above 0.5 is on. The voice sounds for the length of its event and the sampler envelope shapes it as a whole. A begin() with no rhythm of its own, such as an LFO or rand(), is read by every grain as it starts.', eg: 's("pad").grain().begin(saw(0.25).range(0.2, 0.6))' },
  grainsize: { kind: 'method', sig: 'grainsize(seconds)', desc: 'Length of each grain, in seconds. Read as each grain starts, so a signal can change it within a note. Turns grain() on if nothing has set it.', eg: '.grainsize(0.08)' },
  grainrate: { kind: 'method', sig: 'grainrate(hz)', desc: 'Grains per second. The number of grains sounding at once is grainsize() times this. Turns grain() on if nothing has set it.', eg: '.grainrate(40)' },
  grainpan: { kind: 'method', sig: 'grainpan(position)', desc: 'Stereo position of each grain, from -1 (left) to 1 (right), read as the grain starts, so a fast signal places every grain separately. Applied before the track\'s effects. Turns grain() on if nothing has set it.', eg: '.grainpan(rand().range(-0.6, 0.6))' },
  grainshape: { kind: 'method', sig: 'grainshape(shape)', desc: 'The amplitude window of each grain: drawn breakpoints, the name of a shape, or a pattern of names read at each event. Without one, grains take a symmetric bell. Double-click the name to draw it. Turns grain() on if nothing has set it.', eg: '.grainshape("pluck")' },
  envscale: { kind: 'both', sig: 'envscale(factor)', desc: 'Multiplies the sampler envelope\'s attack, decay and release times. Sustain is unchanged. Scaling by the note\'s length makes the envelope stretch with each note.', eg: '.attack(0.1).envscale(dur())' },
  adsr: { kind: 'method', sig: 'adsr(a, d, s, r)', desc: 'Sets the sampler envelope in one call: attack, decay and release in seconds, sustain as a level from 0 to 1. Double-click the name to draw it over the sample.', eg: '.adsr(0.005, 0.2, 0.6, 0.1)' },

  // ----------------------------------------------------------------- debugging
  log: {
    kind: 'method',
    sig: 'log()',
    desc: 'Prints each event the track plays to the console: its start and end in cycles, and the settings sent to the engine. For a sampler this includes the begin/end window, the actual playback rate, and how much audio the window holds.',
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
