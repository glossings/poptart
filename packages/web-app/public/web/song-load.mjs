// Putting a song on a DJ deck: read it from the music folder, decode it, make it playable, and
// have it measured.
//
// MEMORY is the whole design. decodeAudioData hands back 32-bit floats for the whole file at the
// context's rate - a ten-minute stereo track is about 230 MB - and a browser has no way to decode
// a compressed file in pieces: its streaming decoder (WebCodecs) takes frames, not files, so
// decoding an mp3 or an m4a in chunks would mean writing a demuxer for every container first. So
// the file is decoded whole, once, and immediately packed into 16-bit planes - half the size -
// in slices, yielding between them so the page's thread (which schedules the notes) is never held
// for long. The float copy is dropped as soon as the planes exist, and the planes go to the
// analysis worker and then to the audio thread by transfer, never copied. What a loaded deck
// costs the page is the planes, held by the player: ~115 MB for those ten minutes, two decks'
// worth at most. The decode itself briefly needs the floats as well, one song at a time.
//
// Sixteen bits is the resolution nearly every song file is mastered to, and what the player reads
// with a four-point interpolation; the desktop caches a decoded song as 32-bit floats on disk,
// which a page has no disk for.

import { decodeAudio } from './audio-decode.mjs';

/** How many samples are packed between yields: about a second of stereo audio at 48 kHz. */
const PACK_SLICE = 1 << 17;

const yieldToPage = () => new Promise((r) => setTimeout(r, 0));

/** A decoded buffer as 16-bit planes, one per channel (a mono file is one plane). */
export async function packPlanes(buffer, { slice = PACK_SLICE, pause = yieldToPage } = {}) {
  const frames = buffer.length;
  const planes = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const src = buffer.getChannelData(c);
    const out = new Int16Array(frames);
    for (let at = 0; at < frames; at += slice) {
      const to = Math.min(frames, at + slice);
      for (let i = at; i < to; i++) {
        const v = src[i] * 32767;
        out[i] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : Math.round(v);
      }
      if (to < frames) await pause();
    }
    planes.push(out);
  }
  return planes;
}

/** The analysis worker, started on the first song. */
function songWorker(warn) {
  let worker = null;
  let seq = 0;
  const jobs = new Map();
  const start = () => {
    if (worker) return worker;
    worker = new Worker(new URL('./song-worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = jobs.get(data.id);
      if (!job) return;
      if (data.kind === 'wave') job.wave?.(data);
      else if (data.kind === 'facts') { jobs.delete(data.id); job.facts?.(data.facts); }
      else if (data.kind === 'error') { jobs.delete(data.id); job.fail?.(new Error(data.error)); }
    };
    worker.onerror = (event) => {
      warn(`[songs] the song analysis stopped - ${event?.message ?? 'the worker failed'}`);
      for (const job of jobs.values()) job.fail?.(new Error('the song analysis stopped'));
      jobs.clear();
      worker = null;
    };
    return worker;
  };
  return {
    /** The waveform and the planes back, then the facts: { wave: Promise, planes: Promise, facts: Promise }. */
    prepare(planes, sampleRate, frames, bpmHint) {
      const w = start();
      const id = ++seq;
      const settle = {};
      const back = new Promise((resolve, reject) => Object.assign(settle, { wave: resolve, waveFail: reject }));
      const facts = new Promise((resolve, reject) => Object.assign(settle, { facts: resolve, factsFail: reject }));
      facts.catch(() => {}); // a song whose analysis fails still plays; the desk says so
      jobs.set(id, {
        wave: settle.wave,
        facts: settle.facts,
        fail: (err) => { settle.waveFail(err); settle.factsFail(err); },
      });
      w.postMessage({ id, kind: 'prepare', planes, sampleRate, frames, bpmHint }, planes.map((p) => p.buffer));
      return { back, facts };
    },
    /** The facts alone, from planes handed over for good. */
    measure(planes, sampleRate, frames, bpmHint) {
      const w = start();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        jobs.set(id, { facts: resolve, fail: reject });
        w.postMessage({ id, kind: 'measure', planes, sampleRate, frames, bpmHint }, planes.map((p) => p.buffer));
      });
    },
  };
}

/**
 * Where the decks' songs come from (the music folder) and how they are made playable.
 *
 * @param deps.context  the audio context, whose decoder and rate a song is decoded at
 * @param deps.folder   the music folder (music-folder.mjs)
 * @param deps.readTags (File) -> its own tags, { title, artist, album, bpm, key } (the desktop's
 *                      tag reader - see osc-engine's song-tags-core.mjs)
 */
export function createSongSource({ context, folder, readTags = null, warn = () => {} }) {
  const worker = songWorker(warn);
  const tagsOf = async (file) => {
    try { return readTags ? await readTags(file) : null; } catch { return null; }
  };

  async function decode(path) {
    const file = await folder.file(path);
    const bytes = await file.arrayBuffer();
    let buffer;
    try {
      buffer = await decodeAudio(context, bytes);
    } catch (err) {
      throw new Error(`this browser cannot decode "${file.name}"${err?.message ? ` - ${err.message}` : ''}`);
    }
    return { file, buffer };
  }

  return {
    async load(path, { bpmHint = null } = {}) {
      const decoded = await decode(path);
      const { file } = decoded;
      const { sampleRate, length: frames, numberOfChannels: channels } = decoded.buffer;
      const packed = await packPlanes(decoded.buffer);
      // From here the page holds no float copy of the song: the decoded buffer is let go before
      // the planes go to the worker and back, rather than for as long as that takes.
      decoded.buffer = null;
      const { back, facts } = worker.prepare(packed, sampleRate, frames, bpmHint);
      const { planes, wave } = await back;
      return {
        planes,
        frames,
        sampleRate,
        channels,
        title: file.name.replace(/\.[^.]+$/, ''),
        tags: await tagsOf(file),
        wave: Promise.resolve(wave),
        facts,
      };
    },
    /**
     * Measures a song from its file: its tempo, beatgrid, key and transients - a re-fit around a
     * typed tempo, the grid itself again, or the library's pass over the collection. Packed and
     * measured the way a load is, so the page is never held for a whole song.
     */
    async measure(path, { bpmHint = null } = {}) {
      const decoded = await decode(path);
      const { sampleRate, length: frames } = decoded.buffer;
      const packed = await packPlanes(decoded.buffer);
      decoded.buffer = null;
      return worker.measure(packed, sampleRate, frames, bpmHint);
    },
    /** A file's own tags, read from the folder without decoding anything. */
    async tags(path) {
      return tagsOf(await folder.file(path));
    },
  };
}
