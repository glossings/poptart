'use strict';

// What a packaged app owes someone it has just failed: a record of what happened, and one thing
// to send. Started from a terminal the app narrates itself; started from the Dock that narration
// went nowhere, and the only advice on the failure screen was a `node ...doctor.js` command for
// people who, by construction, have neither node nor the repository.
//
// Two pieces, both Electron-free so they can be tested:
//
// - The desktop log, ~/.poptart/desktop.log: the shell's own status lines and everything the
//   server prints, beside the engine.log sclang's output already goes to (same writer, so the
//   same rotation and size cap - see osc-engine/engine-log.js).
// - The diagnostic report: doctor.js's report with the tail of the desktop log appended. doctor
//   runs as a child, exactly as the server does (the app's own binary as plain Node), not inside
//   the main process - it spawns sclang and blocks while it waits, which must not freeze a window.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { poptartHome } = require('@poptart/osc-engine/home');
const { openEngineLog, tailEngineLog, engineLogPath } = require('@poptart/osc-engine/engine-log');

const DOCTOR_TIMEOUT_MS = 90000; // doctor's sclang probe compiles the class library; be generous

function desktopLogPath({ dir = poptartHome() } = {}) {
  return path.join(dir, 'desktop.log');
}

/** Open (and rotate) the desktop log. Never throws; see openEngineLog. */
function openDesktopLog({ file = desktopLogPath() } = {}) {
  return openEngineLog({ file });
}

/** `poptart-diagnostics-2026-09-21-1604.txt`: sorts by time, says what it is in a downloads folder. */
function reportFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `poptart-diagnostics-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.txt`;
}

function runDoctor({ outFile, execPath, doctorEntry, env, execFileFn }) {
  return new Promise((resolve) => {
    execFileFn(
      execPath,
      [doctorEntry, '--out', outFile],
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: DOCTOR_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => resolve(err ? { ok: false, reason: `${err.message}\n${stderr || ''}`.trim() } : { ok: true }),
    );
  });
}

/**
 * Write the diagnostic report to `outFile`. Always produces a file: if doctor itself fails, that
 * failure is the first thing in the report, and the logs still follow - a broken install is the
 * case this exists for, so it cannot depend on the install being sound.
 *
 * @param {object} opts
 * @param {string} opts.outFile
 * @param {string} [opts.appVersion]
 * @returns {Promise<{ file: string, doctorOk: boolean }>}
 */
async function writeDiagnosticReport({
  outFile,
  appVersion = 'unknown',
  execPath = process.execPath,
  doctorEntry = require.resolve('@poptart/osc-engine/doctor.js'),
  env = process.env,
  execFileFn = execFile,
  desktopLogFile = desktopLogPath(),
  engineLogFile = engineLogPath(),
} = {}) {
  const doctor = await runDoctor({ outFile, execPath, doctorEntry, env, execFileFn });
  let report = '';
  try {
    report = doctor.ok ? fs.readFileSync(outFile, 'utf8') : '';
  } catch {
    // doctor said it succeeded and left nothing behind; the sections below still get written
  }
  const sections = [
    `poptart desktop ${appVersion} - ${process.platform}-${process.arch}`,
    doctor.ok ? report.trimEnd() : `--- doctor could not run ---\n${doctor.reason}`,
    `--- desktop log (${desktopLogFile}) ---\n${tailEngineLog({ file: desktopLogFile, lines: 400 }) || '(empty)'}`,
  ];
  // doctor includes the engine log when it runs; without doctor, include it here.
  if (!doctor.ok) sections.push(`--- engine log (${engineLogFile}) ---\n${tailEngineLog({ file: engineLogFile, lines: 400 }) || '(empty)'}`);
  fs.writeFileSync(outFile, `${sections.join('\n\n')}\n`);
  return { file: outFile, doctorOk: doctor.ok };
}

// The failure screen and the Help menu ask for these by URL (loading.html's links, main.js's
// window-open handler): the page has no script and no Electron API, and needs neither for this.
const ACTIONS = {
  saveDiagnostics: 'poptart://save-diagnostics',
  showLogs: 'poptart://show-logs',
};

function actionFor(url) {
  return Object.keys(ACTIONS).find((name) => ACTIONS[name] === String(url).replace(/\/$/, '')) ?? null;
}

module.exports = { desktopLogPath, openDesktopLog, reportFileName, writeDiagnosticReport, actionFor, ACTIONS };
