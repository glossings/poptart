#!/usr/bin/env node
'use strict';

// `npm start` for the desktop app (and `npm run desktop` from the repository root): make sure
// Electron is installed and runnable - installing or repairing it if not, see ensure-electron.js
// - then launch the app. One command on a fresh checkout, on every platform.

const { spawn } = require('node:child_process');
const { ensureElectron } = require('./ensure-electron');

let binary;
try {
  binary = ensureElectron();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[poptart] could not start the desktop app: ${err.message}`);
  process.exit(1);
}

// ELECTRON_RUN_AS_NODE turns the Electron binary into a plain Node and no window ever opens. It
// leaks in from terminals hosted inside Electron-based editors, so it is dropped here; main.js
// sets it again, deliberately, for the server child only.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Electron warns about any page that allows eval, and evaluating code is what poptart does. The
// warning never shows in a packaged build; from source it is only noise in the console.
env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

const child = spawn(binary, [__dirname, ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
