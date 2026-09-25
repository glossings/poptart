// Signalsmith Stretch, as a pitch shifter.
//
// The library does pitch shifting and time stretching together, and only one of those is an
// effect: a track's time is the scheduler's, so stretching it here would fight the clock. What
// is exposed is the pitch side, which runs with input and output the same length.
//
// Its controls are in real units - semitones and hertz - rather than the 0..1 the other ported
// devices use, because the library's own arguments are in those units and a shift of "0.58" is
// not a thing anybody means.

export const STRETCH_PARAMS = Object.freeze([
  {
    id: 'pitch',
    name: 'Pitch',
    min: -24,
    max: 24,
    default: 0,
    unit: 'st',
    group: 'Shift',
    description: 'Transposition in semitones. Whole numbers are the musical intervals; in between is a detune.',
  },
  {
    id: 'formant',
    name: 'Formant',
    min: -12,
    max: 12,
    default: 0,
    unit: 'st',
    group: 'Shift',
    description: 'Moves the resonances without moving the pitch. Set it against the pitch to keep a voice from sounding like a chipmunk.',
  },
  {
    id: 'tonality',
    name: 'Tonality Limit',
    min: 0,
    max: 16000,
    default: 8000,
    unit: 'Hz',
    // Linear, where a frequency control would usually be exponential: zero is a real setting
    // here and means "transpose all of it", and an exponential curve cannot reach zero.
    group: 'Shift',
    description: 'Above this, partials keep their own frequency rather than being transposed, which is what keeps sibilance from shifting with the note. Zero transposes everything.',
  },
]);

export function stretchDescriptor(sourceUrl) {
  return {
    id: 'Shift',
    kind: 'fx',
    version: 1,
    description: 'Pitch shifting that keeps time, with separate control of the formants.',
    vendor: 'Signalsmith Audio',
    license: 'MIT',
    source: sourceUrl,
    build: 'wasm',
    processor: 'poptart-wasm-shift',
    channels: { in: 2, out: 2 },
    // Pitch and formant are a-rate so a signal can be patched onto them - a vibrato written as
    // `.param("Pitch", lfo(...))` is the obvious thing to want. The value is still read once a
    // block, as every parameter here is; the tonality limit is not worth modulating at all.
    params: STRETCH_PARAMS.map((p) => ({ ...p, rate: p.id === 'tonality' ? 'k' : 'a' })),
  };
}
