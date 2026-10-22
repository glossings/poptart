'use strict';

// A sample's key, read from its file name: "Psy_Hyp_Lead_Am_140.wav" is in A minor, "pad F# maj"
// in F# major, "Bass - C sharp minor" in C# minor. What the track list shows beside a sampler
// track, in the spelling .scale() takes ("A minor"), so it can go straight into the code.
//
// Names only, never the audio: detecting a key means decoding the whole file, and the track list
// is redrawn on every eval. A name that does not say is "unknown" rather than a guess.
//
// Deliberately strict, since a file name is mostly other words: a key has to be a token of its
// own (between separators), and a lone letter only counts with a mode after it ("C_minor") - "a"
// and "b" are take letters and variations far more often than keys. A flat with no mode ("Eb")
// needs its capital, for the same reason ("ab", "eb" are words).
//
// Loaded as a plain script in the browser (before client.js) and require()d by the tests.

const SAMPLE_KEY_MINOR = new Set(['m', 'min', 'minor', 'mi']);
const SAMPLE_KEY_MAJOR = new Set(['maj', 'major', 'ma', 'M']);

function sampleKeyMode(word) {
  if (word == null) return null;
  if (word === 'M') return 'major'; // the one case-sensitive spelling: "CM" is C major, "Cm" C minor
  const w = word.toLowerCase();
  if (SAMPLE_KEY_MINOR.has(w)) return 'minor';
  if (SAMPLE_KEY_MAJOR.has(w)) return 'major';
  return null;
}

function sampleKeyAccidental(text) {
  if (!text) return '';
  const t = text.toLowerCase();
  if (t === '#' || t === '♯' || t === 'sharp') return '#';
  if (t === 'b' || t === '♭' || t === 'flat') return 'b';
  return null;
}

const SAMPLE_KEY_TOKEN_RE = /^([A-Ga-g])(#|♯|b|♭)?(m|M|mi|min|minor|ma|maj|major)?$/;

/** The key a sample's file name states, as "A minor" / "F# major" / "Eb", or null. */
function keyFromSampleName(name) {
  const base = String(name ?? '').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const tokens = base.split(/[\s_\-.,+()[\]{}]+/).filter(Boolean);
  let found = null;
  for (let k = 0; k < tokens.length; k++) {
    const m = SAMPLE_KEY_TOKEN_RE.exec(tokens[k]);
    if (!m) continue;
    // "am", "em", "gm" are words: the one-letter minor only with a capital note ("Am").
    if (m[3] === 'm' && !m[2] && m[1] !== m[1].toUpperCase()) continue;
    const letter = m[1].toUpperCase();
    let acc = sampleKeyAccidental(m[2]);
    let mode = sampleKeyMode(m[3]);
    let used = 0;
    // "F sharp minor", "C_minor", "Bb major": the accidental and the mode as words of their own.
    if (!m[2] && !m[3]) {
      const next = sampleKeyAccidental(tokens[k + 1]);
      if (next && tokens[k + 1].length > 1) {
        acc = next;
        used = 1;
      }
    }
    if (!m[3]) {
      const after = tokens[k + 1 + used];
      const word = sampleKeyMode(after);
      // a mode WORD here, not the one-letter forms - "C_m" is too thin to call
      if (word && after.length > 1) {
        mode = word;
        used += 1;
      }
    }
    if (!mode) {
      // No mode: only a note with an accidental stands on its own, and a flat only capitalized.
      if (!acc) continue;
      if (acc === 'b' && m[2] === 'b' && m[1] !== letter) continue;
    }
    found = `${letter}${acc}${mode ? ` ${mode}` : ''}`;
    k += used;
  }
  return found; // the last one named: keys sit near the end of a name, after what the sound is
}

const poptartSampleKey = { keyFromSampleName };

if (typeof module !== 'undefined' && module.exports) module.exports = poptartSampleKey;
else globalThis.poptartSampleKey = poptartSampleKey;
