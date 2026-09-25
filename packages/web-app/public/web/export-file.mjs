// The export file, written and read in pieces.
//
// An export is one JSON document (format 'poptart-store-1', see storage.mjs exportAll), and with
// audio in it that document can be larger than the longest string a browser will make: a
// wavetable folder is a couple of thousand files, base64 adds a third, and JSON.stringify of the
// whole thing - or JSON.parse of the whole file on the way back - failed with the tab's memory
// rather than producing a file.
//
// So the document is written as a list of parts, each audio file on a line of its own, and read
// back line by line. What is on disk is still one ordinary JSON document.

/** Where the audio's bytes start. Everything before it is small and is parsed whole. */
const BYTES_OPEN = '"bytes":{\n';
const BYTES_CLOSE = '\n}}}';

/**
 * The file as Blob parts. Nothing larger than one audio file's base64 is ever one string.
 */
export function exportParts(bundle) {
  const bytes = bundle?.audio?.bytes;
  if (!bytes || typeof bytes !== 'object') return [JSON.stringify(bundle)];
  const { bytes: _left, ...audioRest } = bundle.audio;
  const { audio: _audio, ...rest } = bundle;
  // `audio` last, and `bytes` last within it, so the head closes exactly where the lines begin.
  const head = JSON.stringify({ ...rest, audio: { ...audioRest, bytes: {} } });
  if (!head.endsWith('"bytes":{}}}')) throw new Error('the export did not come out in the expected order');
  const parts = [`${head.slice(0, -'{}}}'.length)}{\n`];
  const keys = Object.keys(bytes);
  keys.forEach((key, i) => {
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(bytes[key])}${i < keys.length - 1 ? ',\n' : ''}`);
  });
  parts.push(BYTES_CLOSE);
  return parts;
}

/**
 * An export file back into the object storage.importAll takes.
 *
 * A file with audio in it is read as a stream of lines. One without - a single short line, which
 * is what exportParts writes when there is no audio - is parsed whole.
 */
export async function readExport(file) {
  const lines = [];
  let pending = '';
  let first = true;
  let lined = false;
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += value;
    // The first line decides: only a file this module wrote ends its first line at the bytes.
    if (first) {
      const nl = pending.indexOf('\n');
      if (nl === -1) {
        if (pending.length > 64 * 1024 * 1024) break; // one enormous line: not ours, parse whole
        continue;
      }
      first = false;
      lined = pending.slice(0, nl + 1).endsWith(BYTES_OPEN);
      if (!lined) break;
    }
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      lines.push(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
  }
  if (!lined) {
    reader.cancel().catch(() => {});
    return JSON.parse(await file.text());
  }
  lines.push(pending);

  // Line one is the head with its bytes left open; the last line closes them.
  const [head, ...rest] = lines;
  const tail = rest.pop();
  if (tail !== '}}}') throw new SyntaxError('the export ends early');
  const bundle = JSON.parse(`${head}}}}`);
  const bytes = bundle.audio.bytes;
  for (const line of rest) {
    const entry = JSON.parse(`{${line.endsWith(',') ? line.slice(0, -1) : line}}`);
    Object.assign(bytes, entry);
  }
  return bundle;
}
