// A sound as the outline a picture of it needs.
//
// Kept instead of the samples themselves because the samples are already where they are played -
// on the audio thread, or in an AudioBuffer - and a second copy of a minute of audio for the sake
// of a two-inch drawing is not a copy worth holding. What a picture actually needs is the loudest
// sample either way per column, which at the width a panel draws IS the waveform rather than an
// approximation of one.

/** How many columns an outline is kept at - about the width a panel draws one in. */
export const OUTLINE_COLUMNS = 256;

/** The peaks of one channel of samples, and how long it runs. */
export function outlineOf(data, sampleRate, columns = OUTLINE_COLUMNS) {
  const samples = data ?? [];
  const per = Math.max(1, Math.floor(samples.length / columns));
  const peaks = [];
  for (let i = 0; i < samples.length; i += per) {
    let lo = 0;
    let hi = 0;
    for (let j = i; j < i + per && j < samples.length; j++) {
      if (samples[j] < lo) lo = samples[j];
      if (samples[j] > hi) hi = samples[j];
    }
    peaks.push([lo, hi]);
  }
  return { peaks, seconds: samples.length / (sampleRate || 48000) };
}
