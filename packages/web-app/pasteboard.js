'use strict';

// The files on the system clipboard - what "copy" in Finder or a sample service's app put there.
//
// The pack panel's other way in from an app that can't drag into a browser. A drag from such an
// app is a FILE PROMISE (the file is produced when the receiver asks for it), and Chromium's web
// view doesn't register for promises, so the drag never reaches the page at all - no event, no
// note, nothing. "Copy" is the same apps' other route into a DAW, and a copied file sits on the
// general pasteboard as a file URL that any process on the machine may read. So ⌘V on the pack
// list asks this side, which reads the pasteboard natively (a JavaScript-for-Automation script,
// since Node has no pasteboard of its own) and hands back the paths - the files where they live.
//
// macOS only, by nature; elsewhere the answer is simply empty. The script and its parse are kept
// apart from the run, so the parse is tested against captured output (see pasteboard.test.js).

const { execFile } = require('node:child_process');

/**
 * Evaluates to one JSON string: the pasteboard's types and the path of every file URL on it. The
 * script's last expression is what osascript prints to stdout - console.log would go to stderr.
 */
const READ_SCRIPT = `
ObjC.import("AppKit");
const pb = $.NSPasteboard.generalPasteboard;
const out = { types: ObjC.deepUnwrap(pb.types) || [], files: [] };
for (const item of (pb.pasteboardItems.js || [])) {
  const s = item.stringForType("public.file-url");
  if (s.isNil()) continue;
  const url = $.NSURL.URLWithString(s);
  if (!url.isNil() && !url.path.isNil()) out.files.push(ObjC.unwrap(url.path));
}
JSON.stringify(out);
`;

/** Runs the read script; resolves to its stdout. Only ever called on macOS. */
function runReadScript() {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', READ_SCRIPT], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`couldn't read the clipboard: ${err.message}`));
      // Both streams: the JSON is on stdout, but AppKit's chatter on stderr is kept for the parse
      // to skip past rather than trusted to stay on its own side.
      resolve(`${stderr ?? ''}\n${stdout ?? ''}`);
    });
  });
}

/** The script's output as { types, files } - anything unreadable is an empty pasteboard. */
function parsePasteboardOutput(stdout) {
  // The one JSON line is the last one that looks like it, after any AppKit chatter.
  const line = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).findLast((l) => l.startsWith('{'));
  if (!line) return { types: [], files: [] };
  try {
    const parsed = JSON.parse(line);
    return {
      types: Array.isArray(parsed.types) ? parsed.types.map(String) : [],
      files: Array.isArray(parsed.files) ? parsed.files.map(String).filter((p) => p.startsWith('/')) : [],
    };
  } catch {
    return { types: [], files: [] };
  }
}

/**
 * The file paths on the clipboard, plus every type it carries (the clue to what an app put there
 * when it wasn't a file). `run` is the script runner, injected for tests.
 */
async function readPasteboardFiles({ run = runReadScript, platform = process.platform } = {}) {
  if (platform !== 'darwin') return { types: [], files: [] };
  return parsePasteboardOutput(await run());
}

module.exports = { readPasteboardFiles, parsePasteboardOutput, READ_SCRIPT };
