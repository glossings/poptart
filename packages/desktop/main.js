'use strict';

// The desktop shell (PACKAGING.md, Stage 2).
//
// This is deliberately thin. poptart is a Node server plus a browser page, so the app is: make
// sure there is a SuperCollider to use, start the server, point a window at it, and shut the
// audio engine down on the way out. Nothing about the UI is Electron-specific, and the page
// stays plain-browser so `npm run dev` keeps working in a normal browser.
//
// Where SuperCollider comes from is Stage 1.5's business, not this file's: the engine already
// knows how to fetch and run a private copy under ~/.poptart/sc (osc-engine/private-sc.js), and
// the app reuses that rather than bundling SuperCollider inside itself. That keeps the download
// small and - because the user's own machine fetches SuperCollider's officially signed build
// instead of us redistributing it - avoids having to re-sign and notarize somebody else's
// binaries. See PACKAGING.md for what is still outstanding before this ships to strangers.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');

// Before anything else is loaded: a `poptart-data` folder beside the app becomes poptart's home
// (portable.js). Several modules work their paths out once, as they load, and the server child
// inherits this environment - so this is the one moment the answer can be given to all of them.
const PORTABLE = require('./portable').portableHome({ isPackaged: app.isPackaged });
if (PORTABLE.dir) process.env.POPTART_HOME = PORTABLE.dir;

const { describeHome } = require('@poptart/osc-engine/home');
const { openDesktopLog, desktopLogPath, reportFileName, writeDiagnosticReport, actionFor } = require('./diagnostics');

const {
  createBootNarrator,
  findFreePort,
  waitForServer,
  fetchEngineStatus,
  startServer,
  stopServer,
} = require('./server-process');

// The engine's own modules, resolved through the workspace exactly as the server resolves them.
const {
  privateScInstalled,
  installPrivateSc,
  scAsset,
  SC_RELEASE,
} = require('@poptart/osc-engine/private-sc');
const { sclangStatus } = require('@poptart/osc-engine/setup');

const LOADING_PAGE = path.join(__dirname, 'loading.html');

let win = null;
let serverChild = null;
let quitting = false;
let desktopLog = null; // ~/.poptart/desktop.log, opened in boot() - see diagnostics.js
const launchedAt = Date.now();
let booted = false; // the editor has replaced the loading page; nothing is left to narrate

// ---------------------------------------------------------------------------------------------
// The loading window
// ---------------------------------------------------------------------------------------------

// The update is written into the page from here, whole, instead of calling a function the page
// defines: loading.html's Content-Security-Policy allows no script of its own (an inline one is
// blocked, which is how the status line came to say "Starting..." for a whole failed boot), and
// executeJavaScript is not subject to it.
// `log: false` is for updates that only echo a server line onto the loading screen: that line
// is in the log already, and a plugin scan produces hundreds of them.
function setStatus(text, { detail = '', failed = false, log = true } = {}) {
  if (log) {
    // eslint-disable-next-line no-console
    console.log(`[poptart] ${text}${detail ? ` - ${detail}` : ''}`);
    desktopLog?.note(`${failed ? 'FAILED: ' : ''}${text}${detail ? ` - ${detail}` : ''}`);
  }
  if (!win || win.isDestroyed()) return;
  const payload = JSON.stringify({ text, detail, failed });
  win.webContents
    .executeJavaScript(
      `(() => {
        const update = ${payload};
        const status = document.getElementById('status');
        if (!status) return; // not the loading page
        status.textContent = update.text;
        document.getElementById('detail').textContent = update.detail;
        document.body.classList.toggle('failed', update.failed);
      })()`,
    )
    .catch(() => {
      // The page may not have finished loading yet; the next update will land, and the log
      // above is the real record either way.
    });
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

async function saveDiagnostics() {
  const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined, {
    title: 'Save diagnostic report',
    defaultPath: path.join(app.getPath('desktop'), reportFileName()),
  });
  if (canceled || !filePath) return;
  desktopLog?.note(`writing a diagnostic report to ${filePath}`);
  try {
    await writeDiagnosticReport({ outFile: filePath, appVersion: app.getVersion() });
    shell.showItemInFolder(filePath);
  } catch (err) {
    dialog.showErrorBox('The report could not be written', err.message);
  }
}

function showLogs() {
  const file = desktopLogPath();
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  else shell.openPath(path.dirname(file));
}

const runAction = { saveDiagnostics, showLogs };

// Off macOS, Electron's default menu bar takes the whole alt family: alt on its own focuses it and
// alt+F/E/V/W/H open its menus. alt is where poptart's own chords live on those platforms (see
// public/chords.js), and alt+F inserts an effect - so the menu would eat it before the page saw the
// key. Nothing in that default menu is reachable any other way except reload and devtools, and this
// window has no use for either. macOS keeps its menu: the application menu is where cmd+Q and the
// editing accelerators live there, and the app's chords are on ctrl anyway.
if (process.platform !== 'darwin') {
  Menu.setApplicationMenu(null);
} else {
  // The default menu, role for role, with the two diagnostics items where a Mac user looks for
  // them. Off macOS there is no menu to put them in; the failure screen carries them everywhere.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          { label: 'Save Diagnostic Report…', click: () => saveDiagnostics() },
          { label: 'Show Log Files', click: () => showLogs() },
        ],
      },
    ]),
  );
}

// macOS: no title bar of the system's own. The window's close/minimize/zoom buttons float over
// the page's header instead, so the app has one top bar in its own colors rather than a system
// strip above it. The page is not told: it stays a plain browser page (npm run dev), and the few
// rules this needs are injected from here - room for the buttons at the header's left, and the
// header as the handle the window is dragged by. Its controls are excluded from that handle, or
// they would stop receiving clicks; the name stays part of it, like a title. The logo chip is
// hidden while the buttons are showing: a fourth small rounded shape beside three reads as one
// of them. In full screen the buttons go, and the header is the browser's again, chip and all.
const MAC_TITLE_BAR = process.platform === 'darwin';
const TRAFFIC_LIGHTS = { x: 16, y: 18 }; // vertically centered in the editor's ~52px header
const MAC_TITLE_BAR_CSS = `
  header { -webkit-app-region: drag; }
  header > * { -webkit-app-region: no-drag; }
  header > .logo, header > h1 { -webkit-app-region: drag; }
  html:not(.poptart-fullscreen) header { padding-left: 94px; }
  html:not(.poptart-fullscreen) header > .logo { display: none; }
`;

function syncFullScreenClass() {
  if (!win || win.isDestroyed()) return;
  // In full screen the buttons are gone, and so is the reason for the room left for them.
  win.webContents
    .executeJavaScript(`document.documentElement.classList.toggle('poptart-fullscreen', ${win.isFullScreen()})`)
    .catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    show: true,
    title: 'Poptart',
    ...(MAC_TITLE_BAR ? { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS } : {}),
    webPreferences: {
      // The page is our own server's, but it also evaluates user code and can load plugin
      // metadata; there is no reason for it to reach Node, so it doesn't.
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  });
  win.loadFile(LOADING_PAGE);
  // Links to documentation and plugin vendors belong in the user's browser, not in a window
  // with no address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const action = actionFor(url);
    if (action) runAction[action]();
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (MAC_TITLE_BAR) {
    // Injected CSS belongs to the document, so it goes in again on every load.
    win.webContents.on('did-finish-load', () => {
      win?.webContents.insertCSS(MAC_TITLE_BAR_CSS).catch(() => {});
      syncFullScreenClass();
    });
    win.on('enter-full-screen', syncFullScreenClass);
    win.on('leave-full-screen', syncFullScreenClass);
  }
  win.on('closed', () => {
    win = null;
  });
  return win;
}

// ---------------------------------------------------------------------------------------------
// SuperCollider
// ---------------------------------------------------------------------------------------------

// The GUI equivalent of setup.js's y/N prompt: there is no terminal to ask in, so ask here.
// Nothing is downloaded without this answer (see private-sc.js's consentToInstall).
async function ensureSuperCollider() {
  if (sclangStatus().found) return true;

  const asset = scAsset();
  if (!asset) {
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'SuperCollider is required',
      detail:
        `poptart has no SuperCollider build pinned for ${process.platform}-${process.arch}. ` +
        'Install SuperCollider with your package manager, then start poptart again.',
      buttons: ['Quit'],
    });
    return false;
  }

  const megabytes = Math.round(asset.bytes / 1e6);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    message: 'poptart needs SuperCollider',
    detail:
      `SuperCollider is the audio engine poptart plays through. It is not installed on this ` +
      `machine.\n\npoptart can download its own private copy (${megabytes} MB). It goes in your ` +
      'home folder, nothing is installed system-wide, no administrator password is needed, and ' +
      'removing it later means deleting one folder.',
    buttons: [`Download (${megabytes} MB)`, 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;

  setStatus('Downloading SuperCollider', { detail: `${megabytes} MB - this happens only once` });
  try {
    await installPrivateSc({
      log: {
        log: (line) => setStatus('Downloading SuperCollider', { detail: String(line).replace(/^\[poptart\]\s*/, '') }),
        warn: (line) => setStatus('Downloading SuperCollider', { detail: String(line) }),
      },
    });
  } catch (err) {
    showFailure('SuperCollider could not be installed', err.message);
    return false;
  }
  setStatus(`SuperCollider ${SC_RELEASE.version} installed`);
  return privateScInstalled();
}

function showFailure(text, detail) {
  setStatus(text, { detail, failed: true });
}

// ---------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------

async function boot() {
  desktopLog = openDesktopLog();
  desktopLog.note(`poptart desktop ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform}-${process.arch}, packaged: ${app.isPackaged})`);
  const dataFolder = describeHome();
  desktopLog.note(`data folder: ${dataFolder.dir}${PORTABLE.dir ? ' (portable: found beside the app)' : dataFolder.why ? ` (${dataFolder.why})` : ''}`);
  if (PORTABLE.declined) desktopLog.note(PORTABLE.declined);
  createWindow();

  if (!(await ensureSuperCollider())) {
    if (!win || win.isDestroyed()) app.quit();
    return;
  }

  setStatus('Starting the poptart server');
  let port;
  try {
    port = await findFreePort();
  } catch (err) {
    return showFailure('Could not open a local port', err.message);
  }

  // If the server dies during startup, stop waiting immediately rather than sitting out the
  // whole timeout - the log lines it printed on the way down are the actual diagnosis.
  const died = new AbortController();
  const narrate = createBootNarrator();
  let lastLines = [];
  serverChild = startServer({
    port,
    onLog: (line, stream) => {
      lastLines = [...lastLines, line].slice(-25);
      process[stream].write(`${line}\n`);
      // Seconds since launch on every line: a boot that stalls leaves no other trace of WHERE
      // the time went, and "it hung for a minute" was all the first such report could say.
      desktopLog?.write(`[+${((Date.now() - launchedAt) / 1000).toFixed(1).padStart(5)}s] ${line}\n`);
      const update = booted ? null : narrate(line);
      if (update) setStatus(update.text, { detail: update.detail, log: false });
    },
    onExit: ({ code, signal }) => {
      desktopLog?.note(`the server exited (code ${code}, signal ${signal})`);
      serverChild = null;
      if (quitting) return;
      died.abort(`the poptart server exited (code ${code})`);
      showFailure(`The poptart server stopped (exit code ${code})`, lastLines.join('\n'));
    },
  });

  try {
    await waitForServer(port, { signal: died.signal });
  } catch (err) {
    return showFailure('The poptart server did not start', `${err.message}\n\n${lastLines.join('\n')}`);
  }

  // The server answering is not the same as poptart being able to make a sound. Ask before
  // claiming to be ready - otherwise a failed engine boot shows a window that looks fine and
  // silently plays nothing, with the real reason scrolled off a terminal nobody is reading.
  const status = await fetchEngineStatus(port);
  if (status && !status.loaded) {
    const reason = status.error ?? 'no reason given';
    setStatus('The audio engine did not start', { detail: reason, failed: true });
    // The dialog is modal, so it covers the failure screen's own links - and off macOS there is
    // no Help menu to find the report in once it is dismissed. The report is therefore one of
    // its buttons; saving one brings the question back rather than answering it.
    let response;
    do {
      ({ response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: 'The audio engine did not start',
        detail:
          `${reason}\n\npoptart will open, but nothing will make sound until the engine starts. ` +
          'The usual cause is another copy of poptart already running - the two fight over the ' +
          "same ports. You can also restart the engine from the editor's settings tab.",
        buttons: ['Open anyway', 'Save diagnostic report…', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      }));
      if (response === 1) await saveDiagnostics();
    } while (response === 1);
    if (response !== 0) {
      app.quit();
      return;
    }
  } else {
    setStatus('Ready');
  }
  booted = true;
  if (win && !win.isDestroyed()) win.loadURL(`http://127.0.0.1:${port}/`);
}

// One window, and closing it means quitting: poptart with no window would leave scsynth holding
// the audio device with nothing driving it, which is worse than the macOS convention is good.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
  if (quitting || !serverChild) return;
  // Stopping the engine cleanly takes a moment (sclang has to tell scsynth to quit), so hold
  // the quit open for it rather than orphaning the audio server.
  event.preventDefault();
  quitting = true;
  stopServer(serverChild).finally(() => {
    serverChild = null;
    app.quit();
  });
});

// A second copy would fight the first for the audio device and the engine's ports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(boot);
}
