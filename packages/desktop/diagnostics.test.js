'use strict';

// Tests for the desktop diagnostics (diagnostics.js): the report a user is asked to send. The
// cases that matter are the unhappy ones - the report exists for broken installs, so it has to
// come out whole when doctor cannot run at all.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { writeDiagnosticReport, reportFileName, actionFor, ACTIONS, openDesktopLog } = require('./diagnostics');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-diagnostics-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const scratch = () => fs.mkdtempSync(path.join(tmp, `case-${n++}-`));

function logs(dir) {
  const desktopLogFile = path.join(dir, 'desktop.log');
  const engineLogFile = path.join(dir, 'engine.log');
  fs.writeFileSync(desktopLogFile, 'server: listening\nFAILED: The audio engine did not start\n');
  fs.writeFileSync(engineLogFile, 'sclang: compile done\n');
  return { desktopLogFile, engineLogFile };
}

test('doctor runs as the app\'s own binary in plain-Node mode, and its report leads', async () => {
  const dir = scratch();
  const outFile = path.join(dir, 'report.txt');
  let call = null;
  const execFileFn = (execPath, args, opts, done) => {
    call = { execPath, args, opts };
    fs.writeFileSync(args[2], 'poptart doctor - the report body\n');
    done(null, '', '');
  };
  const result = await writeDiagnosticReport({
    outFile, appVersion: '9.9.9', execPath: '/app/poptart', doctorEntry: '/app/doctor.js', env: { HOME: '/h' }, execFileFn, ...logs(dir),
  });
  assert.deepStrictEqual(call.args, ['/app/doctor.js', '--out', outFile]);
  assert.strictEqual(call.execPath, '/app/poptart');
  assert.strictEqual(call.opts.env.ELECTRON_RUN_AS_NODE, '1', 'otherwise the binary opens a second app window');
  assert.strictEqual(call.opts.env.HOME, '/h');
  assert.ok(call.opts.timeout > 0, 'a wedged sclang probe must not hang the report forever');
  assert.strictEqual(result.doctorOk, true);
  const report = fs.readFileSync(outFile, 'utf8');
  assert.match(report, /^poptart desktop 9\.9\.9 - /);
  assert.ok(report.indexOf('the report body') < report.indexOf('--- desktop log'));
  assert.match(report, /FAILED: The audio engine did not start/);
  assert.doesNotMatch(report, /--- engine log/, 'doctor already includes the engine log');
});

test('when doctor cannot run, the report says why and still carries both logs', async () => {
  const dir = scratch();
  const outFile = path.join(dir, 'report.txt');
  const execFileFn = (execPath, args, opts, done) => done(new Error('spawn ENOENT'), '', 'no such file');
  const result = await writeDiagnosticReport({ outFile, execPath: '/gone', doctorEntry: '/gone.js', env: {}, execFileFn, ...logs(dir) });
  assert.strictEqual(result.doctorOk, false);
  const report = fs.readFileSync(outFile, 'utf8');
  assert.match(report, /doctor could not run[\s\S]*spawn ENOENT[\s\S]*no such file/);
  assert.match(report, /FAILED: The audio engine did not start/);
  assert.match(report, /--- engine log[\s\S]*compile done/);
});

test('missing logs are reported as empty, not thrown', async () => {
  const dir = scratch();
  const outFile = path.join(dir, 'report.txt');
  const execFileFn = (execPath, args, opts, done) => done(new Error('nope'), '', '');
  await writeDiagnosticReport({
    outFile, execPath: '/x', doctorEntry: '/x.js', env: {}, execFileFn,
    desktopLogFile: path.join(dir, 'absent.log'), engineLogFile: path.join(dir, 'absent-too.log'),
  });
  assert.match(fs.readFileSync(outFile, 'utf8'), /--- desktop log[^\n]*\n\(empty\)/);
});

test('the desktop log rotates like the engine log and survives an unwritable home', () => {
  const dir = scratch();
  const file = path.join(dir, 'desktop.log');
  let log = openDesktopLog({ file });
  log.write('first run\n');
  log.close();
  log = openDesktopLog({ file });
  log.note('second run');
  log.close();
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /first run/);
  assert.match(fs.readFileSync(file, 'utf8'), /^\[\d{4}-.*\] second run\n$/);
  // A log that cannot be opened (its folder is a file) writes nowhere instead of throwing.
  fs.writeFileSync(path.join(dir, 'a-file'), '');
  const nowhere = openDesktopLog({ file: path.join(dir, 'a-file', 'desktop.log') });
  assert.strictEqual(nowhere.path, null);
  assert.doesNotThrow(() => nowhere.write('x'));
});

test('report names sort by time', () => {
  assert.strictEqual(reportFileName(new Date(2026, 8, 5, 7, 3)), 'poptart-diagnostics-2026-09-05-0703.txt');
});

test('only the two known action URLs are actions, and loading.html uses exactly those', () => {
  assert.strictEqual(actionFor(ACTIONS.saveDiagnostics), 'saveDiagnostics');
  assert.strictEqual(actionFor('poptart://show-logs/'), 'showLogs', 'a browser may normalize a trailing slash on');
  assert.strictEqual(actionFor('poptart://quit'), null);
  assert.strictEqual(actionFor('https://example.com/poptart://show-logs'), null);
  const page = fs.readFileSync(path.join(__dirname, 'loading.html'), 'utf8');
  const hrefs = [...page.matchAll(/href="(poptart:[^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(hrefs, Object.values(ACTIONS).sort());
  assert.doesNotMatch(page, /<script/, 'the page\'s own policy blocks it; main.js writes the status in');
});
