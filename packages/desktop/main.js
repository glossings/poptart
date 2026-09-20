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

const path = require('node:path');
const { app, BrowserWindow, dialog, shell } = require('electron');

const {
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

// ---------------------------------------------------------------------------------------------
// The loading window
// ---------------------------------------------------------------------------------------------

function setStatus(text, { detail = '', failed = false } = {}) {
  if (!win || win.isDestroyed()) return;
  const payload = JSON.stringify({ text, detail, failed });
  win.webContents
    .executeJavaScript(`window.poptartStatus && window.poptartStatus(${payload})`)
    .catch(() => {
      // The page may not have finished loading yet; the next update will land, and the
      // terminal log below is the real record either way.
    });
  // eslint-disable-next-line no-console
  console.log(`[poptart] ${text}${detail ? ` - ${detail}` : ''}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    show: true,
    title: 'poptart',
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
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
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
  setStatus(text, {
    detail: `${detail}\n\nFor a full diagnosis run:  node packages/osc-engine/doctor.js --out doctor.txt`,
    failed: true,
  });
}

// ---------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------

async function boot() {
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
  let lastLines = [];
  serverChild = startServer({
    port,
    onLog: (line, stream) => {
      lastLines = [...lastLines, line].slice(-25);
      process[stream].write(`${line}\n`);
      if (/booting|SuperCollider|VSTPlugin|scanning/i.test(line)) {
        setStatus('Starting the audio engine', { detail: line.replace(/^\[\w+\]\s*/, '') });
      }
    },
    onExit: ({ code }) => {
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
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'The audio engine did not start',
      detail:
        `${reason}\n\npoptart will open, but nothing will make sound until the engine starts. ` +
        'The usual cause is another copy of poptart already running - the two fight over the ' +
        "same ports. You can also restart the engine from the editor's settings tab.",
      buttons: ['Open anyway', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      app.quit();
      return;
    }
  } else {
    setStatus('Ready');
  }
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
