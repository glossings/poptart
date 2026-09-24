// The Mutable Instruments modules poptart ports, and what each one's controls are.
//
// WHICH ONES CAN BE PORTED AT ALL was checked module by module against the published sources on
// 2026-09-22, because the answer is not what the module list suggests:
//
//   Ripples, Shelves, Veils    the repository holds `hardware_design` and nothing else. These
//                              are analog modules; there is no audio DSP to port, and no amount
//                              of build work will produce one.
//   Streams, Frames            digital control over an analog audio path. The firmware is
//                              envelopes and mixing law, not the sound.
//   Marbles, Grids, Stages     control-voltage and trigger generators. Real DSP, but they make
//                              no audio - and poptart's pattern language already does what
//                              Grids does.
//   Beads                      not published. It is not in the repository at all.
//
// What is left is the digital audio modules, which is this list.
//
// Everything here is MIT, copyright Emilie Gillet, verified per file rather than from the
// repository page - the repository declares no license at all, and the grant is in each file's
// own header.

/** Plaits renders at a fixed rate; the wrapper resamples to whatever the page is running at. */
export const PLAITS_RATE = 48000;

/** In registration order, which IS the engine index. See plaits/dsp/voice.cc. */
export const PLAITS_ENGINES = Object.freeze([
  'VA VCF', 'Phase Distortion', 'FM 6-op A', 'FM 6-op B', 'FM 6-op C', 'Wave Terrain',
  'String Machine', 'Chiptune', 'Virtual Analog', 'Waveshaping', 'FM', 'Grain', 'Additive',
  'Wavetable', 'Chord', 'Speech', 'Swarm', 'Noise', 'Particle', 'String', 'Modal',
  'Bass Drum', 'Snare Drum', 'Hi-Hat',
]);

/**
 * The parameters, in the order the shared array carries them.
 *
 * THE ORDER IS THE CONTRACT: the wrapper reads `g_params[n]` by position, so this list and the C
 * that reads it have to agree. Names and ranges are Plaits' own - `harmonics`, `timbre` and
 * `morph` mean something different in every engine, which is the instrument's whole idea, so
 * they are not renamed to something more descriptive that would be wrong in twenty-three cases.
 */
export const PLAITS_PARAMS = Object.freeze([
  {
    id: 'engine',
    name: 'Engine',
    default: 8,
    options: PLAITS_ENGINES,
    rate: 'k',
    group: 'Model',
    description: 'Which synthesis model runs. Every other control means something different in each.',
  },
  { id: 'harmonics', name: 'Harmonics', min: 0, max: 1, default: 0.5, group: 'Model', description: "The first of the three model controls. Broadly: how much material there is - the number of partials, the spread of a chord, the depth of the FM. It means something different in every engine." },
  { id: 'timbre', name: 'Timbre', min: 0, max: 1, default: 0.5, group: 'Model', description: "The second model control. Broadly: brightness, or the balance of what Harmonics set up. It means something different in every engine." },
  { id: 'morph', name: 'Morph', min: 0, max: 1, default: 0.5, group: 'Model', description: "The third model control. Broadly: the character of the waveform itself, often from soft to hard. It means something different in every engine." },
  {
    id: 'blend',
    name: 'Blend',
    min: 0,
    max: 1,
    default: 0,
    group: 'Model',
    description: 'Plaits has two outputs, a main and a variation. Zero is the main one, one is the variation, in between is a mix.',
  },

  {
    id: 'decay',
    name: 'Decay',
    min: 0,
    max: 1,
    default: 0.5,
    group: 'Envelope',
    description: 'How long the internal low-pass gate holds after a note starts.',
  },
  {
    id: 'lpgcolor',
    name: 'LPG Color',
    min: 0,
    max: 1,
    default: 0.5,
    group: 'Envelope',
    description: 'How much the gate closes the tone as well as the level. Zero is a plain volume envelope.',
  },

  { id: 'fmamount', name: 'FM Amount', min: 0, max: 1, default: 0, group: 'Modulation', description: "How far a signal patched into the pitch bends it." },
  { id: 'timbremod', name: 'Timbre Mod', min: 0, max: 1, default: 0, group: 'Modulation', description: "How much a signal patched into Timbre moves it, and which way round." },
  { id: 'morphmod', name: 'Morph Mod', min: 0, max: 1, default: 0, group: 'Modulation', description: "How much a signal patched into Morph moves it, and which way round." },
]);

// Tides was ported and then retired: an lfo() on any control already is what it did. Its
// wrapper is in this file's history and its entry in sources.json says so.

export const PEAKS_VOICES = Object.freeze(['Bass Drum', 'Snare Drum', 'Hi-Hat', 'FM Drum']);

export const PEAKS_PARAMS = Object.freeze([
  {
    id: 'voice',
    name: 'Voice',
    default: 0,
    options: PEAKS_VOICES,
    rate: 'k',
    group: 'Drum',
    description: 'Which of the module\'s four drum models is struck. The four controls below mean something a little different in each.',
  },
  {
    id: 'frequency',
    name: 'Frequency',
    min: 0,
    max: 1,
    default: 0.5,
    group: 'Drum',
    description: 'The pitch of the drum, an octave either way around the note played. The bass drum and the snare reach seven semitones either side of their own center, so a note far from it is heard at the edge of the range.',
  },
  { id: 'punch', name: 'Punch', min: 0, max: 1, default: 0.5, group: 'Drum', description: "How hard the drum is hit: the depth of the pitch sweep at the start and the weight behind it." },
  { id: 'tone', name: 'Tone', min: 0, max: 1, default: 0.5, group: 'Drum', description: "The brightness of the drum - how much top the body and the transient keep." },
  { id: 'decay', name: 'Decay', min: 0, max: 1, default: 0.4, group: 'Drum', description: "How long the drum rings on after it is struck." },
]);

void Generate(int frames) {
  int voice = (int)(g_params[0] + 0.5f);
  if (voice < 0) voice = 0;
  if (voice > 3) voice = 3;

  // The note sets the drum's pitch and the Frequency control moves it from there, an octave
  // either way. Each model reads its frequency word on its own scale - the bass drum and the
  // snare span seven semitones either side of a fixed center, the FM drum six octaves from C1 -
  // so the note is mapped onto each one's own range rather than handed over as a raw fraction,
  // which had a played note doing almost nothing on one drum and running off the end of another.
  const float note = g_note + (g_params[1] - 0.5f) * 24.0f;
  float freq;
  if (voice == 3) {
    freq = (note - 24.0f) / 72.0f;                       // C1 .. C7 across the word
  } else {
    const float center = voice == 0 ? 31.0f : 52.0f;     // the model's own fixed pitch
    freq = 0.5f + (note - center) / 14.0f;               // +-7 semitones across the word
  }
  if (freq < 0.0f) freq = 0.0f;
  if (freq > 1.0f) freq = 1.0f;

  uint16_t p[4] = { ToU16(freq), ToU16(g_params[2]), ToU16(g_params[3]), ToU16(g_params[4]) };
  switch (voice) {
    case 0: g_bass.Configure(p, peaks::CONTROL_MODE_FULL); break;
    case 1: g_snare.Configure(p, peaks::CONTROL_MODE_FULL); break;
    case 2: g_hat.Configure(p, peaks::CONTROL_MODE_FULL); break;
    default: g_fm.Configure(p, peaks::CONTROL_MODE_FULL); break;
  }

  // Whole chunks only, never a short one. The chunk is the module's own audio block and its
  // voices carry state across it; handing one a partial block is not something the hardware ever
  // does. The surplus waits in the fifo and starts the next block. See the same note in Braids,
  // where a short block is not merely wrong but fatal.
  while (frames > 0 && g_fifoCount + kChunk <= kFifo) {
    for (int i = 0; i < kChunk; i++) {
      uint8_t flags = g_high ? peaks::GATE_FLAG_HIGH : peaks::GATE_FLAG_LOW;
      if (g_rising && i == 0) { flags |= peaks::GATE_FLAG_RISING | peaks::GATE_FLAG_HIGH; }
      g_gate[i] = flags;
    }
    g_rising = false;
    switch (voice) {
      case 0: g_bass.Process(g_gate, g_chunk, (size_t)kChunk); break;
      case 1: g_snare.Process(g_gate, g_chunk, (size_t)kChunk); break;
      case 2: g_hat.Process(g_gate, g_chunk, (size_t)kChunk); break;
      default: g_fm.Process(g_gate, g_chunk, (size_t)kChunk); break;
    }
    for (int i = 0; i < kChunk; i++) {
      g_fifo[g_fifoCount++] = (float)g_chunk[i] / 32768.0f;
    }
    frames -= kChunk;
  }
}

}  // namespace

extern "C" {

void pd_init(double sample_rate) {
  if (!g_ready) {
    g_bass.Init();
    g_snare.Init();
    g_hat.Init();
    g_fm.Init();
    g_ready = true;
  }
  g_ratio = 48000.0 / sample_rate;
  g_fifoCount = 0;
  g_frac = 0.0;
  g_rising = false;
  g_high = false;
}

int pd_param_count() { return 5; }
int pd_max_block() { return ${maxBlock}; }
float* pd_in() { return g_out; }
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_note_on(float note, float velocity) {
  (void)velocity;
  g_note = note;
  g_rising = true;
  g_high = true;
}

void pd_note_off(float note) {
  (void)note;
  g_high = false;
}

void pd_process(int frames) {
  if (!g_ready) return;
  if (frames > ${maxBlock}) frames = ${maxBlock};

  const double span = g_frac + g_ratio * (double)frames;
  const int need = (int)span + 2;
  if (need > g_fifoCount) Generate(need - g_fifoCount);

  for (int i = 0; i < frames; i++) {
    const double pos = g_frac + g_ratio * (double)i;
    int i0 = (int)pos;
    if (i0 + 1 >= g_fifoCount) i0 = g_fifoCount - 2;
    if (i0 < 0) { g_out[i] = 0.0f; g_out[${maxBlock} + i] = 0.0f; continue; }
    const float t = (float)(pos - (double)i0);
    const float v = g_fifo[i0] + (g_fifo[i0 + 1] - g_fifo[i0]) * t;
    g_out[i] = v;
    g_out[${maxBlock} + i] = v;
  }

  const int consumed = (int)span;
  if (consumed > 0 && consumed <= g_fifoCount) {
    for (int i = consumed; i < g_fifoCount; i++) g_fifo[i - consumed] = g_fifo[i];
    g_fifoCount -= consumed;
  }
  g_frac = span - (double)consumed;
}

}
`;
}

/** In enum order, which is the shape index. See braids/settings.h. */
export const BRAIDS_SHAPES = Object.freeze([
  'CSaw', 'Morph', 'Saw Square', 'Sine Triangle', 'Buzz',
  'Square Sub', 'Saw Sub', 'Square Sync', 'Saw Sync', 'Triple Saw', 'Triple Square',
  'Triple Triangle', 'Triple Sine', 'Triple Ring Mod', 'Saw Swarm', 'Saw Comb', 'Toy',
  'Filter LP', 'Filter Peak', 'Filter BP', 'Filter HP', 'VOSIM', 'Vowel', 'Vowel FOF',
  'Harmonics',
  'FM', 'Feedback FM', 'Chaotic FM',
  'Plucked', 'Bowed', 'Blown', 'Fluted', 'Struck Bell', 'Struck Drum', 'Kick', 'Cymbal', 'Snare',
  'Wavetables', 'Wave Map', 'Wave Line', 'Wave Paraphonic',
  'Filtered Noise', 'Twin Peaks Noise', 'Clocked Noise', 'Granular Cloud', 'Particle Noise',
  'Digital Modulation', 'Question Mark',
]);

export const BRAIDS_PARAMS = Object.freeze([
  {
    id: 'shape',
    name: 'Shape',
    default: 2,
    options: BRAIDS_SHAPES,
    rate: 'k',
    group: 'Oscillator',
    description: 'Which of the forty-eight models runs. Timbre and Color mean something different in each.',
  },
  { id: 'timbre', name: 'Timbre', min: 0, max: 1, default: 0.5, group: 'Oscillator', description: "The first of the two model controls. What it does depends entirely on which of the forty-eight models is running." },
  { id: 'color', name: 'Color', min: 0, max: 1, default: 0.5, group: 'Oscillator', description: "The second model control, usually the brighter-or-darker one. It also means something different in each model." },
  {
    id: 'attack',
    name: 'Attack',
    min: 0,
    max: 1,
    default: 0,
    group: 'Envelope',
    description: 'The module\'s own attack-decay envelope, which is what stops a sustained shape droning.',
  },
  { id: 'decay', name: 'Decay', min: 0, max: 1, default: 0.4, group: 'Envelope', description: "The module\u2019s own attack-decay envelope, which is what stops a sustained model droning between notes." },
]);

export function braidsDescriptor(sourceUrl) {
  return {
    id: 'Braids',
    kind: 'synth',
    version: 1,
    description: 'The macro oscillator that came before Plaits: forty-eight models behind two controls, with a simpler character and its own attack-decay envelope.',
    vendor: 'Mutable Instruments',
    license: 'MIT',
    source: sourceUrl,
    build: 'wasm',
    processor: 'poptart-wasm-braids',
    channels: { in: 0, out: 2 },
    params: BRAIDS_PARAMS.map((p) => ({ rate: 'a', ...p })),
  };
}

/**
 * The C that gives Braids the device ABI.
 *
 * It renders sixteen-bit samples at ninety-six kilohertz, so both the format and the rate are
 * converted on the way out. The envelope is the module's own rather than one written here.
 */
export function braidsWrapper(maxBlock) {
  return `// Generated by build/devices/build-devices.mjs - do not edit.
#include "braids/macro_oscillator.h"
#include "braids/envelope.h"

namespace {

braids::MacroOscillator g_osc;
braids::Envelope g_envelope;
bool g_ready = false;
int g_shape = -1;

float g_out[2 * ${maxBlock}];
float g_params[32];

const int kChunk = 24;
int16_t g_chunk[kChunk];
uint8_t g_sync[kChunk];

const int kFifo = 2048;
float g_fifo[kFifo];
int g_fifoCount = 0;
double g_frac = 0.0;
double g_ratio = 1.0;

// Renders at least the asked-for number of samples into the fifo, ALWAYS in whole chunks.
//
// The chunk is the module's own audio block, and a partial one is not a smaller version of it:
// eleven of the forty-eight shapes read past the end of their state when handed a short block,
// which traps the module and takes the voice with it. The module's own main loop never does it -
// the hardware renders a fixed block forever - so neither does this. Whatever a whole chunk
// overshoots by stays in the fifo and is the head of the next block, which is what the fifo is
// for; the cost is at most one chunk of latency and it is constant.
void Generate(int frames) {
  while (frames > 0 && g_fifoCount + kChunk <= kFifo) {
    // One envelope value per chunk, which is what the module's own main loop does.
    const uint32_t env = g_envelope.Render();
    g_osc.Render(g_sync, g_chunk, (size_t)kChunk);
    const float gain = (float)env / 65535.0f;
    for (int i = 0; i < kChunk; i++) {
      g_fifo[g_fifoCount++] = ((float)g_chunk[i] / 32768.0f) * gain;
    }
    frames -= kChunk;
  }
}

}  // namespace

extern "C" {

void pd_init(double sample_rate) {
  if (!g_ready) {
    for (int i = 0; i < kChunk; i++) g_sync[i] = 0;
    g_osc.Init();
    g_envelope.Init();
    g_ready = true;
  }
  g_ratio = 96000.0 / sample_rate;
  g_fifoCount = 0;
  g_frac = 0.0;
  g_osc.set_pitch(60 << 7);
  g_osc.set_parameters(0, 0);
}

int pd_param_count() { return 5; }
int pd_max_block() { return ${maxBlock}; }
float* pd_in() { return g_out; }
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_note_on(float note, float velocity) {
  (void)velocity;
  // Pitch is in 1/128ths of a semitone, counted from the same middle C poptart uses.
  g_osc.set_pitch((int16_t)(note * 128.0f));
  g_osc.Strike();
  g_envelope.Trigger(braids::ENV_SEGMENT_ATTACK);
}

void pd_note_off(float note) {
  (void)note;                        // the envelope is attack-decay; there is nothing to release
}

void pd_process(int frames) {
  if (!g_ready) return;
  if (frames > ${maxBlock}) frames = ${maxBlock};

  int shape = (int)(g_params[0] + 0.5f);
  if (shape < 0) shape = 0;
  if (shape >= (int)braids::MACRO_OSC_SHAPE_LAST) shape = (int)braids::MACRO_OSC_SHAPE_LAST - 1;
  // set_shape strikes the oscillator when it changes, so it is only told on a real change.
  if (shape != g_shape) { g_osc.set_shape((braids::MacroOscillatorShape)shape); g_shape = shape; }

  g_osc.set_parameters((int16_t)(g_params[1] * 32767.0f), (int16_t)(g_params[2] * 32767.0f));
  g_envelope.Update((int32_t)(g_params[3] * 127.0f), (int32_t)(g_params[4] * 127.0f));

  const double span = g_frac + g_ratio * (double)frames;
  const int need = (int)span + 2;
  if (need > g_fifoCount) Generate(need - g_fifoCount);

  for (int i = 0; i < frames; i++) {
    const double pos = g_frac + g_ratio * (double)i;
    int i0 = (int)pos;
    if (i0 + 1 >= g_fifoCount) i0 = g_fifoCount - 2;
    if (i0 < 0) { g_out[i] = 0.0f; g_out[${maxBlock} + i] = 0.0f; continue; }
    const float t = (float)(pos - (double)i0);
    const float v = g_fifo[i0] + (g_fifo[i0 + 1] - g_fifo[i0]) * t;
    g_out[i] = v;
    g_out[${maxBlock} + i] = v;
  }

  const int consumed = (int)span;
  if (consumed > 0 && consumed <= g_fifoCount) {
    for (int i = consumed; i < g_fifoCount; i++) g_fifo[i - consumed] = g_fifo[i];
    g_fifoCount -= consumed;
  }
  g_frac = span - (double)consumed;
}

}
`;
}

/**
 * Elements, in the order the shared array carries them.
 *
 * The module has three exciters - a bow, a breath and a mallet - feeding one resonator, and each
 * has a level and a character of its own. That is most of this list, and it is what the hardware
 * puts on its panel.
 */
export const ELEMENTS_PARAMS = Object.freeze([
  {
    id: 'contour',
    name: 'Contour',
    min: 0,
    max: 1,
    default: 0.5,
    group: 'Envelope',
    description: 'The shape of the envelope every exciter follows, from a short pluck to a held swell.',
  },

  { id: 'bowlevel', name: 'Bow Level', min: 0, max: 1, default: 0, group: 'Bow', description: "How hard the resonator is bowed - a continuous exciter, so it sounds for as long as the note is held." },
  { id: 'bowtimbre', name: 'Bow Timbre', min: 0, max: 1, default: 0.5, group: 'Bow', description: "The grain of the bow, from a smooth draw to a scratch." },

  { id: 'blowlevel', name: 'Blow Level', min: 0, max: 1, default: 0, group: 'Blow', description: "How hard the resonator is blown - a noise and particle exciter, between a breath and a wind instrument." },
  { id: 'blowmeta', name: 'Blow Flow', min: 0, max: 1, default: 0.5, group: 'Blow', description: "What the blowing IS, sweeping from a granular stream through noise to a pitched jet." },
  { id: 'blowtimbre', name: 'Blow Timbre', min: 0, max: 1, default: 0.5, group: 'Blow', description: "The brightness of that breath." },

  { id: 'strikelevel', name: 'Strike Level', min: 0, max: 1, default: 0.8, group: 'Strike', description: "How hard the resonator is struck - the percussive exciter, one hit per note." },
  { id: 'strikemeta', name: 'Strike Mallet', min: 0, max: 1, default: 0.5, group: 'Strike', description: "What the mallet is, from a soft particle burst through a hard hit to a sample-like click." },
  { id: 'striketimbre', name: 'Strike Timbre', min: 0, max: 1, default: 0.5, group: 'Strike', description: "The brightness and hardness of that strike." },

  {
    id: 'signature',
    name: 'Signature',
    min: 0,
    max: 1,
    default: 0,
    group: 'Strike',
    description: 'Adds the module\'s own noise and inharmonicity to the exciters, which is what stops it sounding like a clean physical model.',
  },

  { id: 'geometry', name: 'Geometry', min: 0, max: 1, default: 0.4, group: 'Resonator', description: "What the resonator is made of and shaped like, sweeping through plates, strings, bars and tubes. Everything else is heard through this." },
  { id: 'brightness', name: 'Brightness', min: 0, max: 1, default: 0.6, group: 'Resonator', description: "How much high end the resonator keeps." },
  { id: 'damping', name: 'Damping', min: 0, max: 1, default: 0.7, group: 'Resonator', description: "How long it rings on. Near the top it barely decays, which is the drone end of this module." },
  { id: 'position', name: 'Position', min: 0, max: 1, default: 0.3, group: 'Resonator', description: "Where the exciters meet the resonator, which decides which partials are fed and which are missed." },

  { id: 'space', name: 'Space', min: 0, max: 1, default: 0.2, group: 'Output', description: "The reverb built into the module, from a small room to a diffuse wash." },
  {
    id: 'blend',
    name: 'Blend',
    min: 0,
    max: 1,
    default: 0,
    group: 'Output',
    description: 'Elements has two outputs, the resonator and the raw exciter. Zero is the resonator.',
  },
]);

export function elementsDescriptor(sourceUrl) {
  return {
    id: 'Elements',
    kind: 'synth',
    version: 1,
    description: 'A modal resonator with three exciters in front of it: a bow, a breath and a mallet. Monophonic, as the module is.',
    vendor: 'Mutable Instruments',
    license: 'MIT',
    source: sourceUrl,
    build: 'wasm',
    processor: 'poptart-wasm-elements',
    channels: { in: 0, out: 2 },
    params: ELEMENTS_PARAMS.map((p) => ({ rate: 'a', ...p })),
  };
}

/** The C that gives Elements the device ABI. Native rate 32 kHz, so it resamples. */
export function elementsWrapper(maxBlock) {
  return `// Generated by build/devices/build-devices.mjs - do not edit.
#include "elements/dsp/part.h"

namespace {

elements::Part g_part;
elements::PerformanceState g_state;
uint16_t g_reverb[32768];
bool g_ready = false;

float g_out[2 * ${maxBlock}];
float g_params[32];

const int kFifo = 2048;
float g_fifo[kFifo];
int g_fifoCount = 0;
double g_frac = 0.0;
double g_ratio = 1.0;

float g_silence[elements::kMaxBlockSize];

void Generate(int frames) {
  float main[elements::kMaxBlockSize];
  float aux[elements::kMaxBlockSize];
  while (frames > 0) {
    int n = frames > (int)elements::kMaxBlockSize ? (int)elements::kMaxBlockSize : frames;
    g_part.Process(g_state, g_silence, g_silence, main, aux, (size_t)n);
    const float blend = g_params[15];
    for (int i = 0; i < n; i++) {
      if (g_fifoCount >= kFifo) break;
      g_fifo[g_fifoCount++] = main[i] + (aux[i] - main[i]) * blend;
    }
    frames -= n;
  }
}

}  // namespace

extern "C" {

void pd_init(double sample_rate) {
  if (!g_ready) {
    for (size_t i = 0; i < elements::kMaxBlockSize; i++) g_silence[i] = 0.0f;
    g_part.Init(g_reverb);
    // The firmware seeds this from the chip's unique id so that two modules differ slightly.
    // A fixed seed is the right call here for the reason the random import is fixed: a song
    // should render the same way twice.
    uint32_t seed[3] = { 0x1234567u, 0x89abcdeu, 0xf012345u };
    g_part.Seed(seed, 3);
    g_ready = true;
  }
  g_ratio = 32000.0 / sample_rate;
  g_fifoCount = 0;
  g_frac = 0.0;

  g_state.gate = false;
  g_state.note = 48.0f;
  g_state.modulation = 0.0f;
  g_state.strength = 0.5f;
}

int pd_param_count() { return 16; }
int pd_max_block() { return ${maxBlock}; }
float* pd_in() { return g_out; }
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_note_on(float note, float velocity) {
  g_state.note = note;
  g_state.strength = velocity;
  g_state.gate = true;
}

void pd_note_off(float note) {
  (void)note;                        // monophonic, as the module is
  g_state.gate = false;
}

void pd_process(int frames) {
  if (!g_ready) return;
  if (frames > ${maxBlock}) frames = ${maxBlock};

  elements::Patch* p = g_part.mutable_patch();
  p->exciter_envelope_shape = g_params[0];
  p->exciter_bow_level = g_params[1];
  p->exciter_bow_timbre = g_params[2];
  p->exciter_blow_level = g_params[3];
  p->exciter_blow_meta = g_params[4];
  p->exciter_blow_timbre = g_params[5];
  p->exciter_strike_level = g_params[6];
  p->exciter_strike_meta = g_params[7];
  p->exciter_strike_timbre = g_params[8];
  p->exciter_signature = g_params[9];
  p->resonator_geometry = g_params[10];
  p->resonator_brightness = g_params[11];
  p->resonator_damping = g_params[12];
  p->resonator_position = g_params[13];
  p->space = g_params[14];
  // Not on the module's panel either; these are what its firmware leaves them at.
  p->resonator_modulation_frequency = 0.5f;
  p->resonator_modulation_offset = 0.1f;
  p->reverb_diffusion = 0.625f;
  p->reverb_lp = 0.7f;
  p->modulation_frequency = 0.5f;

  const double span = g_frac + g_ratio * (double)frames;
  const int need = (int)span + 2;
  if (need > g_fifoCount) Generate(need - g_fifoCount);

  for (int i = 0; i < frames; i++) {
    const double pos = g_frac + g_ratio * (double)i;
    int i0 = (int)pos;
    if (i0 + 1 >= g_fifoCount) i0 = g_fifoCount - 2;
    if (i0 < 0) { g_out[i] = 0.0f; g_out[${maxBlock} + i] = 0.0f; continue; }
    const float t = (float)(pos - (double)i0);
    const float v = g_fifo[i0] + (g_fifo[i0 + 1] - g_fifo[i0]) * t;
    g_out[i] = v;
    g_out[${maxBlock} + i] = v;
  }

  const int consumed = (int)span;
  if (consumed > 0 && consumed <= g_fifoCount) {
    for (int i = consumed; i < g_fifoCount; i++) g_fifo[i - consumed] = g_fifo[i];
    g_fifoCount -= consumed;
  }
  g_frac = span - (double)consumed;
}

}
`;
}

/**
 * The carrier settings, which are FOUR and not six.
 *
 * It is tempting to read these off `OscillatorShape` in warps/dsp/parameters.h, which lists five
 * waveforms, and offer external plus all five. The module does not: its own panel cycles this
 * through `(carrier_shape + 1) & 3` (warps/ui.cc), so the range is 0 to 3. The reason is in
 * modulator.cc, which derives TWO oscillator shapes from this one setting - `carrier_shape - 1`
 * for cross-modulation and `carrier_shape + 1` for the vocoder - against a table of five. At 4
 * or 5 the vocoder's index runs off the end of that table, and anywhere near the vocoder end of
 * the algorithm knob the module traps and the track goes silent for good.
 *
 * Named for what the cross-modulation half does, because that is the whole of the knob's range
 * except the top. In the vocoder these are saw, pulse and noise instead.
 */
/**
 * Warps' controls, as poptart offers them.
 *
 * The module's own carrier oscillator is NOT among them. It runs whether or not anything is
 * coming in, so an effect set to use it drones through every rest in the pattern - which is not
 * something an effect may do. A cross-modulator needs a second signal and poptart already has a
 * way to give an effect one: `.audio("other")` on the effect patches a track into its sidechain,
 * and that is the carrier. With nothing patched the carrier is silence, and the algorithms that
 * multiply by it are silent, which is the honest answer rather than a tone nobody asked for.
 */
export const WARPS_PARAMS = Object.freeze([
  {
    id: 'algorithm',
    name: 'Algorithm',
    min: 0,
    max: 1,
    default: 0,
    group: 'Cross Modulation',
    description: 'Sweeps through the cross-modulation algorithms in order: crossfade, fold, analog ring modulation, digital ring modulation, exclusive or, compare, then above three quarters a vocoder whose release lengthens toward the top. In between two of them is a blend of both.',
  },
  {
    id: 'timbre',
    name: 'Timbre',
    min: 0,
    max: 1,
    default: 0.5,
    group: 'Cross Modulation',
    description: 'What the chosen algorithm does with its one control. Depth, fold amount, or the vocoder\'s formant shift, depending.',
  },
  {
    id: 'drive1',
    name: 'Carrier Drive',
    min: 0,
    max: 1,
    default: 0.5,
    group: 'Cross Modulation',
    description: 'Level into the module for the sidechained carrier.',
  },
  {
    id: 'drive2',
    name: 'Track Drive',
    min: 0,
    max: 1,
    default: 0.5,
    group: 'Cross Modulation',
    description: 'Level into the module for this track, which is the modulator.',
  },
]);

export function warpsDescriptor(sourceUrl) {
  return {
    id: 'Warps',
    kind: 'fx',
    version: 1,
    description: 'Cross-modulation: ring modulation, folding, comparison and a vocoder, blended into one another. It takes two signals - this track is the modulator, and .audio("other") patches in the track that is the carrier. With nothing patched in, the algorithms that multiply the two are silent.',
    vendor: 'Mutable Instruments',
    license: 'MIT',
    source: sourceUrl,
    build: 'wasm',
    processor: 'poptart-wasm-warps',
    channels: { in: 2, out: 2 },
    sidechain: true,
    params: WARPS_PARAMS.map((p) => ({ rate: 'a', ...p })),
  };
}

/**
 * The C that gives Warps the device ABI.
 *
 * No resampling here, unlike the other modules: Warps takes its rate at Init and adapts, so it
 * runs at whatever the page does. It works in sixteen-bit frames, which is what the module's
 * codec handed it, so the conversion either side is the wrapper's.
 *
 * The block IS cut, and to the module's own size exactly. Its buffers hold kMaxBlockSize (96)
 * frames and Process() checks nothing, so a larger block overruns them - that was the "Warps
 * latches on one silent block" bug. And its vocoder's filter bank decimates its bands by
 * factors of the block length, so a block that is not the module's is a vocoder that plays
 * noise: cut into halves of 64, everything above three quarters on the algorithm knob was
 * garbage. So the input queues up and the module is fed whole 96-frame blocks, one block of
 * latency, the same shape the other modules' fifos have.
 *
 * The channels: the module's first input is the carrier and its second the modulator. poptart
 * feeds the TRACK to the modulator input and the sidechain - or nothing, when the carrier is
 * the module's own oscillator - to the carrier input, which is the arrangement a single track
 * can use: a sound modulated against a tone, or against another track.
 */
export function warpsWrapper(maxBlock) {
  return `// Generated by build/devices/build-devices.mjs - do not edit.
#include "warps/dsp/modulator.h"

namespace {

warps::Modulator g_modulator;
bool g_ready = false;

float g_in[2 * ${maxBlock}];
float g_out[2 * ${maxBlock}];
float g_params[32];

const int kBlock = (int)warps::kMaxBlockSize;
const int kFifo = 1024;
// The track (modulator) and the sidechain (carrier) waiting to be rendered, and the module's
// output waiting to be read: a block's worth of latency, constant.
float g_inMod[kFifo], g_inCar[kFifo];
int g_inCount = 0;
float g_outL[kFifo], g_outR[kFifo];
int g_outCount = 0;
warps::ShortFrame g_frames[kBlock];

short ToShort(float v) {
  float x = v * 32768.0f;
  if (x > 32767.0f) x = 32767.0f;
  if (x < -32768.0f) x = -32768.0f;
  return (short)x;
}

}  // namespace

extern "C" {

void pd_init(double sample_rate) {
  if (!g_ready) {
    g_modulator.Init((float)sample_rate);
    g_ready = true;
  }
  g_modulator.set_bypass(false);
  g_modulator.set_easter_egg(false);
  g_inCount = 0;
  g_outCount = 0;
  // A block of silence ahead, so the first output block has something to read.
  for (int i = 0; i < kBlock; i++) { g_outL[g_outCount] = 0.0f; g_outR[g_outCount] = 0.0f; g_outCount++; }
}

int pd_param_count() { return 4; }
int pd_max_block() { return ${maxBlock}; }
float* pd_in() { return g_in; }
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_process(int frames) {
  if (!g_ready) return;
  if (frames > ${maxBlock}) frames = ${maxBlock};

  warps::Parameters* p = g_modulator.mutable_parameters();
  // The algorithm knob runs across the whole list rather than picking one, which is the module's
  // own behavior: halfway between two algorithms is audibly both.
  p->modulation_algorithm = g_params[0];
  p->modulation_parameter = g_params[1];
  p->channel_drive[0] = g_params[2];
  p->channel_drive[1] = g_params[3];
  // Always the external carrier. The module's own oscillator is a tone that plays whether or not
  // anything is coming in, and an effect that sounds through the rests is not one - see
  // WARPS_PARAMS. Leaving it at zero also keeps the carrier index away from a table of function
  // pointers it is read out of two different ways, which is what used to trap the module near the
  // vocoder end of the algorithm knob.
  p->carrier_shape = 0;
  p->note = 48.0f;
  p->frequency_shift_pot = 0.0f;
  p->frequency_shift_cv = 0.0f;
  p->phase_shift = 0.0f;

  // Queue the input: the track is the modulator (the module's second channel), the sidechain
  // the carrier (its first).
  for (int i = 0; i < frames && g_inCount < kFifo; i++) {
    g_inMod[g_inCount] = g_in[i];
    g_inCar[g_inCount] = g_in[${maxBlock} + i];
    g_inCount++;
  }
  // Render whole blocks while there is input for them and room for what they make.
  while (g_inCount >= kBlock && g_outCount + kBlock <= kFifo) {
    for (int i = 0; i < kBlock; i++) {
      g_frames[i].l = ToShort(g_inCar[i]);
      g_frames[i].r = ToShort(g_inMod[i]);
    }
    g_modulator.Process(g_frames, g_frames, (size_t)kBlock);
    for (int i = 0; i < kBlock; i++) {
      g_outL[g_outCount] = (float)g_frames[i].l / 32768.0f;
      g_outR[g_outCount] = (float)g_frames[i].r / 32768.0f;
      g_outCount++;
    }
    for (int i = kBlock; i < g_inCount; i++) { g_inMod[i - kBlock] = g_inMod[i]; g_inCar[i - kBlock] = g_inCar[i]; }
    g_inCount -= kBlock;
  }
  // Hand out what is ready. The main output is the modulated signal; the module's aux output is
  // the carrier alone, which is not what a track wants on its right channel.
  for (int i = 0; i < frames; i++) {
    float v = i < g_outCount ? g_outL[i] : 0.0f;
    g_out[i] = v;
    g_out[${maxBlock} + i] = v;
  }
  const int used = frames < g_outCount ? frames : g_outCount;
  for (int i = used; i < g_outCount; i++) { g_outL[i - used] = g_outL[i]; g_outR[i - used] = g_outR[i]; }
  g_outCount -= used;
}

}
`;
}

/** In enum order. See clouds/dsp/granular_processor.h. */
export const CLOUDS_MODES = Object.freeze(['Granular', 'Stretch', 'Looping Delay', 'Spectral']);

export const CLOUDS_PARAMS = Object.freeze([
  {
    id: 'mode',
    name: 'Mode',
    default: 0,
    options: CLOUDS_MODES,
    rate: 'k',
    group: 'Buffer',
    description: 'Granular scatters grains; stretch holds and smears; looping delay is a delay you can freeze; spectral rebuilds the sound from its own spectrum.',
  },
  { id: 'position', name: 'Position', min: 0, max: 1, default: 0.5, group: 'Buffer', description: "Where in the recorded buffer the grains are read from. Hold it still and the sound freezes there; sweep it and the buffer is scrubbed." },
  { id: 'size', name: 'Size', min: 0, max: 1, default: 0.5, group: 'Buffer', description: "How long each grain is, from a click to most of a second. Short grains read as texture, long ones as the sound itself." },
  {
    id: 'density',
    name: 'Density',
    min: 0,
    max: 1,
    default: 0.75,
    group: 'Buffer',
    // Not centered, and deliberately: this control is bipolar around the middle - below it grains
    // are scattered at random, above it they are regular, and AT it none are triggered at all.
    // Resting there would make a fully wet Clouds silent until somebody moved something.
    description: 'How often a grain is thrown. The middle is silence; below it they come at random, above it in step.',
  },
  { id: 'texture', name: 'Texture', min: 0, max: 1, default: 0.5, group: 'Buffer', description: "The shape of the window each grain is played through, from soft and smooth to hard-edged and clicky." },
  {
    id: 'pitch',
    name: 'Pitch',
    min: -24,
    max: 24,
    default: 0,
    unit: 'st',
    group: 'Buffer',
    description: 'How far the grains are transposed, in semitones.',
  },
  {
    id: 'freeze',
    name: 'Freeze',
    min: 0,
    max: 1,
    default: 0,
    step: 1,
    group: 'Buffer',
    description: 'Stops writing into the buffer, so what is already in it is all there is to play with.',
  },
  { id: 'drywet', name: 'Mix', min: 0, max: 1, default: 0.5, group: 'Output', description: "The untouched signal against the cloud." },
  { id: 'spread', name: 'Stereo Spread', min: 0, max: 1, default: 0.5, group: 'Output', description: "How far grains are panned either way." },
  { id: 'feedback', name: 'Feedback', min: 0, max: 1, default: 0, group: 'Output', description: "How much of the output is written back into the buffer, which is how a cloud builds on itself rather than only on what is played in." },
  { id: 'reverb', name: 'Reverb', min: 0, max: 1, default: 0, group: 'Output', description: "The reverb built into the module, after the grains." },
]);

export function cloudsDescriptor(sourceUrl) {
  return {
    id: 'Clouds',
    kind: 'fx',
    version: 1,
    description: 'A granular processor: it keeps a few seconds of what went through it and plays that back as grains, or stretches it, or rebuilds it from its spectrum.',
    vendor: 'Mutable Instruments',
    license: 'MIT',
    source: sourceUrl,
    build: 'wasm',
    processor: 'poptart-wasm-clouds',
    channels: { in: 2, out: 2 },
    params: CLOUDS_PARAMS.map((p) => ({ rate: 'a', ...p })),
  };
}

/**
 * The C that gives Clouds the device ABI.
 *
 * Clouds runs at its own rate and holds its buffer in samples, so both the input and the output
 * are resampled around it - which is also what the module itself does, since its codec ran at a
 * different rate from its processor.
 *
 * The buffers are the module's own sizes. They are the whole point of the effect: how many
 * seconds of sound it has to work with is how large they are.
 */
export function cloudsWrapper(maxBlock) {
  return `// Generated by build/devices/build-devices.mjs - do not edit.
#include "clouds/dsp/granular_processor.h"

namespace {

clouds::GranularProcessor g_processor;
uint8_t g_large[118784];
uint8_t g_small[65536 - 128];
bool g_ready = false;
int g_mode = -1;

float g_in[2 * ${maxBlock}];
float g_out[2 * ${maxBlock}];
float g_params[32];

const int kChunk = 32;
clouds::ShortFrame g_chunk[kChunk];

// Input waiting to be consumed at the module's rate, and output waiting to be read at the page's.
const int kFifo = 2048;
float g_inL[kFifo], g_inR[kFifo];
int g_inCount = 0;
double g_inFrac = 0.0;
float g_outL[kFifo], g_outR[kFifo];
int g_outCount = 0;
double g_outFrac = 0.0;
// Two ratios, and they are not the same number. Going IN, one module frame costs
// host/32000 frames of what arrived; coming OUT, one host frame costs 32000/host frames of what
// the module made. Using one for both is a pitch error in whichever direction it is wrong.
double g_down = 1.0;     // host frames consumed per module frame
double g_ratio = 1.0;    // module frames consumed per host frame

short ToShort(float v) {
  float x = v * 32768.0f;
  if (x > 32767.0f) x = 32767.0f;
  if (x < -32768.0f) x = -32768.0f;
  return (short)x;
}

}  // namespace

extern "C" {

void pd_init(double sample_rate) {
  if (!g_ready) {
    g_processor.Init(g_large, sizeof(g_large), g_small, sizeof(g_small));
    g_ready = true;
  }
  g_ratio = 32000.0 / sample_rate;
  g_down = sample_rate / 32000.0;
  g_inCount = 0;
  g_outCount = 0;
  g_inFrac = 0.0;
  g_outFrac = 0.0;
}

int pd_param_count() { return 11; }
int pd_max_block() { return ${maxBlock}; }
float* pd_in() { return g_in; }
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_process(int frames) {
  if (!g_ready) return;
  if (frames > ${maxBlock}) frames = ${maxBlock};

  int mode = (int)(g_params[0] + 0.5f);
  if (mode < 0) mode = 0;
  if (mode >= (int)clouds::PLAYBACK_MODE_LAST) mode = (int)clouds::PLAYBACK_MODE_LAST - 1;
  // Only on a change: switching mode rebuilds what the buffer means.
  if (mode != g_mode) { g_processor.set_playback_mode((clouds::PlaybackMode)mode); g_mode = mode; }

  clouds::Parameters* p = g_processor.mutable_parameters();
  p->position = g_params[1];
  p->size = g_params[2];
  p->density = g_params[3];
  p->texture = g_params[4];
  p->pitch = g_params[5];
  p->freeze = g_params[6] >= 0.5f;
  p->dry_wet = g_params[7];
  p->stereo_spread = g_params[8];
  p->feedback = g_params[9];
  p->reverb = g_params[10];
  p->trigger = false;
  p->gate = false;

  // The module's firmware calls this from its main loop, outside the audio callback, as often as
  // the loop goes round: it is what lays out the buffer, acts on a mode change and - in the
  // stretch mode - runs the correlator that lines the next window up, a few candidates per call.
  // Once per block starved that search, so it is called several times per block here.
  for (int k = 0; k < 6; k++) g_processor.Prepare();

  // Down to the module's rate, through it, and back up to the page's.
  for (int i = 0; i < frames && g_inCount < kFifo; i++) {
    g_inL[g_inCount] = g_in[i];
    g_inR[g_inCount] = g_in[${maxBlock} + i];
    g_inCount++;
  }

  while (g_outCount < frames + 2) {
    if (g_outCount + kChunk >= kFifo) break;
    // One chunk of input at the module's rate, read out of what has arrived at the page's.
    const double span = g_inFrac + g_down * (double)kChunk;
    if ((int)span + 2 > g_inCount) break;
    for (int i = 0; i < kChunk; i++) {
      const double pos = g_inFrac + g_down * (double)i;
      int i0 = (int)pos;
      const float t = (float)(pos - (double)i0);
      const float l = g_inL[i0] + (g_inL[i0 + 1] - g_inL[i0]) * t;
      const float r = g_inR[i0] + (g_inR[i0 + 1] - g_inR[i0]) * t;
      g_chunk[i].l = ToShort(l);
      g_chunk[i].r = ToShort(r);
    }
    const int consumed = (int)span;
    if (consumed > 0 && consumed <= g_inCount) {
      for (int i = consumed; i < g_inCount; i++) { g_inL[i - consumed] = g_inL[i]; g_inR[i - consumed] = g_inR[i]; }
      g_inCount -= consumed;
    }
    g_inFrac = span - (double)consumed;

    g_processor.Process(g_chunk, g_chunk, (size_t)kChunk);
    for (int i = 0; i < kChunk; i++) {
      g_outL[g_outCount] = (float)g_chunk[i].l / 32768.0f;
      g_outR[g_outCount] = (float)g_chunk[i].r / 32768.0f;
      g_outCount++;
    }
  }

  // And read that back out at the page's rate.
  const double span = g_outFrac + g_ratio * (double)frames;
  for (int i = 0; i < frames; i++) {
    const double pos = g_outFrac + g_ratio * (double)i;
    int i0 = (int)pos;
    if (i0 + 1 >= g_outCount) { g_out[i] = 0.0f; g_out[${maxBlock} + i] = 0.0f; continue; }
    const float t = (float)(pos - (double)i0);
    g_out[i] = g_outL[i0] + (g_outL[i0 + 1] - g_outL[i0]) * t;
    g_out[${maxBlock} + i] = g_outR[i0] + (g_outR[i0 + 1] - g_outR[i0]) * t;
  }
  const int used = (int)span;
  if (used > 0 && used <= g_outCount) {
    for (int i = used; i < g_outCount; i++) { g_outL[i - used] = g_outL[i]; g_outR[i - used] = g_outR[i]; }
    g_outCount -= used;
  }
  g_outFrac = span - (double)used;
}

}
`;
}

/** In enum order, which is the model index. See rings/dsp/part.h. */
export const RINGS_MODELS = Object.freeze([
  'Modal', 'Sympathetic String', 'String', 'FM Voice', 'Quantised Sympathetic', 'String and Reverb',
]);

export const RINGS_PARAMS = Object.freeze([
  {
    id: 'model',
    name: 'Model',
    default: 0,
    options: RINGS_MODELS,
    rate: 'k',
    group: 'Resonator',
    description: 'Which resonator is struck. The last two are the module\'s own extended models.',
  },
  { id: 'structure', name: 'Structure', min: 0, max: 1, default: 0.35, group: 'Resonator', description: "What the resonator IS: the ratio of its partials, from a string through a bar to a bell. This is the control that decides whether it sounds struck or bowed material." },
  { id: 'brightness', name: 'Brightness', min: 0, max: 1, default: 0.5, group: 'Resonator', description: "How much high end the resonator keeps, and how hard the exciter hits it." },
  { id: 'damping', name: 'Damping', min: 0, max: 1, default: 0.5, group: 'Resonator', description: "How long the resonator rings on after it is struck." },
  { id: 'position', name: 'Position', min: 0, max: 1, default: 0.25, group: 'Resonator', description: "Where along the resonator it is struck. Near the middle is round and fundamental-heavy; near the end is thin and full of odd partials." },
  {
    id: 'polyphony',
    name: 'Polyphony',
    min: 1,
    max: 4,
    default: 1,
    step: 1,
    rate: 'k',
    group: 'Resonator',
    description: 'How many notes can ring at once. More voices means each one is thinner, which is the module\'s own trade.',
  },
  {
    id: 'blend',
    name: 'Blend',
    min: 0,
    max: 1,
    default: 0,
    group: 'Resonator',
    description: 'Rings has two outputs, odd and even. Zero is the first, one is the second.',
  },
]);

export function ringsDescriptor(sourceUrl) {
  return {
    id: 'Rings',
    kind: 'synth',
    version: 1,
    description: 'A resonator, struck by its own exciter. Six models from a plain modal bar to a string with a reverb behind it.',
    vendor: 'Mutable Instruments',
    license: 'MIT',
    source: sourceUrl,
    build: 'wasm',
    processor: 'poptart-wasm-rings',
    channels: { in: 0, out: 2 },
    params: RINGS_PARAMS.map((p) => ({ rate: 'a', ...p })),
  };
}

/**
 * The C that gives Rings the device ABI.
 *
 * It is an instrument here rather than an effect, driven by its own exciter: poptart's effects
 * have no pitch to resonate at, and `synth("Rings")` played from a pattern is the thing somebody
 * writing a part actually wants. Resonating a track's audio is the other half of the module and
 * is not exposed yet.
 */
export function ringsWrapper(maxBlock) {
  return `// Generated by build/devices/build-devices.mjs - do not edit.
#include "rings/dsp/part.h"
#include "rings/dsp/patch.h"
#include "rings/dsp/performance_state.h"

namespace {

rings::Part g_part;
rings::Patch g_patch;
rings::PerformanceState g_state;
uint16_t g_reverb[32768];
bool g_ready = false;
int g_model = -1;
int g_poly = -1;

float g_out[2 * ${maxBlock}];
float g_params[32];

const int kFifo = 2048;
float g_fifo[kFifo];
int g_fifoCount = 0;
double g_frac = 0.0;
double g_ratio = 1.0;

float g_silence[rings::kMaxBlockSize];

void Generate(int frames) {
  float out[rings::kMaxBlockSize];
  float aux[rings::kMaxBlockSize];
  while (frames > 0) {
    int n = frames > (int)rings::kMaxBlockSize ? (int)rings::kMaxBlockSize : frames;
    g_part.Process(g_state, g_patch, g_silence, out, aux, (size_t)n);
    // A strum is an edge, not a level: it is consumed by the render that sees it.
    g_state.strum = false;
    const float blend = g_params[6];
    for (int i = 0; i < n; i++) {
      if (g_fifoCount >= kFifo) break;
      g_fifo[g_fifoCount++] = out[i] + (aux[i] - out[i]) * blend;
    }
    frames -= n;
  }
}

}  // namespace

extern "C" {

void pd_init(double sample_rate) {
  if (!g_ready) {
    for (size_t i = 0; i < rings::kMaxBlockSize; i++) g_silence[i] = 0.0f;
    g_part.Init(g_reverb);
    g_ready = true;
  }
  g_ratio = ${PLAITS_RATE}.0 / sample_rate;
  g_fifoCount = 0;
  g_frac = 0.0;

  g_patch.structure = 0.35f;
  g_patch.brightness = 0.5f;
  g_patch.damping = 0.5f;
  g_patch.position = 0.25f;

  g_state.strum = false;
  g_state.internal_exciter = true;   // played from a sequencer, not patched into a modular
  g_state.internal_strum = false;    // the note edge is the strum
  g_state.internal_note = false;
  g_state.tonic = 12.0f;
  g_state.note = 48.0f;
  g_state.fm = 0.0f;
  g_state.chord = 0;
  g_part.set_polyphony(1);
  g_part.set_model(rings::RESONATOR_MODEL_MODAL);
  g_part.set_bypass(false);
}

int pd_param_count() { return 7; }
int pd_max_block() { return ${maxBlock}; }
float* pd_in() { return g_out; }
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_note_on(float note, float velocity) {
  (void)velocity;
  // Rings counts its pitch from the same middle C poptart does, split into a tonic and an
  // offset; keeping the tonic where the module rests puts the note where it was written.
  g_state.note = note - 12.0f;
  g_state.strum = true;
}

void pd_note_off(float note) {
  (void)note;                        // a struck resonator rings out; there is nothing to release
}

void pd_process(int frames) {
  if (!g_ready) return;
  if (frames > ${maxBlock}) frames = ${maxBlock};

  int model = (int)(g_params[0] + 0.5f);
  if (model < 0) model = 0;
  if (model >= (int)rings::RESONATOR_MODEL_LAST) model = (int)rings::RESONATOR_MODEL_LAST - 1;
  g_patch.structure = g_params[1];
  g_patch.brightness = g_params[2];
  g_patch.damping = g_params[3];
  g_patch.position = g_params[4];
  int poly = (int)(g_params[5] + 0.5f);
  if (poly < 1) poly = 1;
  if (poly > rings::kMaxPolyphony) poly = rings::kMaxPolyphony;

  // ONLY ON A REAL CHANGE. Both of these mark the part dirty, which rebuilds the resonators, and
  // set_polyphony does it whether or not the number moved. Calling them every block - which is
  // the obvious thing to write - rebuilt the resonator between every pair of blocks, so a struck
  // string was a click with no ring after it.
  if (model != g_model) { g_part.set_model((rings::ResonatorModel)model); g_model = model; }
  if (poly != g_poly) { g_part.set_polyphony(poly); g_poly = poly; }

  const double span = g_frac + g_ratio * (double)frames;
  const int need = (int)span + 2;
  if (need > g_fifoCount) Generate(need - g_fifoCount);

  for (int i = 0; i < frames; i++) {
    const double pos = g_frac + g_ratio * (double)i;
    int i0 = (int)pos;
    if (i0 + 1 >= g_fifoCount) i0 = g_fifoCount - 2;
    if (i0 < 0) { g_out[i] = 0.0f; g_out[${maxBlock} + i] = 0.0f; continue; }
    const float t = (float)(pos - (double)i0);
    const float v = g_fifo[i0] + (g_fifo[i0 + 1] - g_fifo[i0]) * t;
    g_out[i] = v;
    g_out[${maxBlock} + i] = v;
  }

  const int consumed = (int)span;
  if (consumed > 0 && consumed <= g_fifoCount) {
    for (int i = consumed; i < g_fifoCount; i++) g_fifo[i - consumed] = g_fifo[i];
    g_fifoCount -= consumed;
  }
  g_frac = span - (double)consumed;
}

}
`;
}

export function plaitsDescriptor(sourceUrl) {
  return {
    id: 'Plaits',
    kind: 'synth',
    version: 1,
    description: 'A macro oscillator with twenty-four synthesis models behind three controls, plus its own low-pass gate. Monophonic, as the module is.',
    vendor: 'Mutable Instruments',
    license: 'MIT',
    source: sourceUrl,
    build: 'wasm',
    processor: 'poptart-wasm-plaits',
    channels: { in: 0, out: 2 },
    params: PLAITS_PARAMS.map((p) => ({ rate: 'a', ...p })),
  };
}

/**
 * The C that gives Plaits poptart's device ABI.
 *
 * Two things here are not in the effect wrappers. It takes NOTES, because it is an instrument;
 * and it RESAMPLES, because its pitch constants are written against a fixed rate and a page
 * running at anything else would play it out of tune. The resampling is linear, which is honest
 * about what it is: at the rate ratios a browser actually produces - usually one to one, at
 * worst forty-four against forty-eight - it is a small correction rather than the sound.
 */
export function plaitsWrapper(maxBlock) {
  return `// Generated by build/devices/build-devices.mjs - do not edit.
#include "plaits/dsp/voice.h"
#include "stmlib/utils/buffer_allocator.h"

namespace {

// The module's own working memory. Plaits allocates every engine's buffers out of one block at
// startup and never again, which is why the number is upstream's rather than a guess.
char g_block[16384];

plaits::Voice g_voice;
plaits::Patch g_patch;
plaits::Modulations g_mods;
bool g_ready = false;

float g_out[2 * ${maxBlock}];
float g_params[32];

// Generated at the module's own rate, waiting to be read out at the page's.
const int kFifo = 2048;
float g_fifo[kFifo];
int g_fifoCount = 0;
double g_frac = 0.0;
double g_ratio = 1.0;

void Generate(int frames) {
  plaits::Voice::Frame tmp[plaits::kMaxBlockSize];
  while (frames > 0) {
    int n = frames > (int)plaits::kMaxBlockSize ? (int)plaits::kMaxBlockSize : frames;
    g_voice.Render(g_patch, g_mods, tmp, (size_t)n);
    const float blend = g_params[4];
    for (int i = 0; i < n; i++) {
      if (g_fifoCount >= kFifo) break;
      const float a = (float)tmp[i].out / 32768.0f;
      const float b = (float)tmp[i].aux / 32768.0f;
      g_fifo[g_fifoCount++] = a + (b - a) * blend;
    }
    frames -= n;
  }
}

}  // namespace

extern "C" {

void pd_init(double sample_rate) {
  if (!g_ready) {
    stmlib::BufferAllocator allocator(g_block, sizeof(g_block));
    g_voice.Init(&allocator);
    g_ready = true;
  }
  g_ratio = ${PLAITS_RATE}.0 / sample_rate;
  g_fifoCount = 0;
  g_frac = 0.0;

  g_patch.note = 48.0f;
  g_patch.harmonics = 0.5f;
  g_patch.timbre = 0.5f;
  g_patch.morph = 0.5f;
  g_patch.frequency_modulation_amount = 0.0f;
  g_patch.timbre_modulation_amount = 0.0f;
  g_patch.morph_modulation_amount = 0.0f;
  g_patch.engine = 8;
  g_patch.decay = 0.5f;
  g_patch.lpg_colour = 0.5f;

  g_mods.engine = 0.0f;
  g_mods.note = 0.0f;
  g_mods.frequency = 0.0f;
  g_mods.harmonics = 0.0f;
  g_mods.timbre = 0.0f;
  g_mods.morph = 0.0f;
  g_mods.trigger = 0.0f;
  g_mods.level = 0.0f;
  g_mods.frequency_patched = false;
  g_mods.timbre_patched = false;
  g_mods.morph_patched = false;
  // Both patched: a note is a gate into the low-pass gate, and its velocity is the level. With
  // these false the module free-runs, which is right on a modular and wrong behind a sequencer.
  g_mods.trigger_patched = true;
  g_mods.level_patched = true;
}

int pd_param_count() { return 10; }
int pd_max_block() { return ${maxBlock}; }
float* pd_in() { return g_out; }        // no input; never read
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_note_on(float note, float velocity) {
  // Plaits counts middle C as 60 the way poptart does, so the number passes straight through.
  g_patch.note = note;
  g_mods.trigger = 1.0f;
  g_mods.level = velocity;
}

void pd_note_off(float note) {
  (void)note;                            // monophonic: the last note on is the one sounding
  g_mods.trigger = 0.0f;
  g_mods.level = 0.0f;
}

void pd_process(int frames) {
  if (!g_ready) return;
  if (frames > ${maxBlock}) frames = ${maxBlock};

  g_patch.engine = (int)(g_params[0] + 0.5f);
  g_patch.harmonics = g_params[1];
  g_patch.timbre = g_params[2];
  g_patch.morph = g_params[3];
  g_patch.decay = g_params[5];
  g_patch.lpg_colour = g_params[6];
  g_patch.frequency_modulation_amount = g_params[7];
  g_patch.timbre_modulation_amount = g_params[8];
  g_patch.morph_modulation_amount = g_params[9];

  const double span = g_frac + g_ratio * (double)frames;
  const int need = (int)span + 2;
  if (need > g_fifoCount) Generate(need - g_fifoCount);

  for (int i = 0; i < frames; i++) {
    const double pos = g_frac + g_ratio * (double)i;
    int i0 = (int)pos;
    if (i0 + 1 >= g_fifoCount) i0 = g_fifoCount - 2;
    if (i0 < 0) { g_out[i] = 0.0f; g_out[${maxBlock} + i] = 0.0f; continue; }
    const float t = (float)(pos - (double)i0);
    const float v = g_fifo[i0] + (g_fifo[i0 + 1] - g_fifo[i0]) * t;
    g_out[i] = v;
    g_out[${maxBlock} + i] = v;          // mono, as the module is
  }

  const int consumed = (int)span;
  if (consumed > 0 && consumed <= g_fifoCount) {
    for (int i = consumed; i < g_fifoCount; i++) g_fifo[i - consumed] = g_fifo[i];
    g_fifoCount -= consumed;
  }
  g_frac = span - (double)consumed;
}

}
`;
}
