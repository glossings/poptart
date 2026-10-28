'use strict';

// Where the SuperCollider pieces are: scsynth (the server poptart boots), the UGen plugin folders
// it loads and the Extensions folder poptart installs into. poptart's private copy (private-sc.js)
// outranks a system install, as it always has.

const fs = require('node:fs');
const path = require('node:path');
const {
  privateScInstalled, privateResourcesDir, privateExtensionsDir, privateUgenPluginsPath, isPrivateSclang,
} = require('../private-sc');
const { userExtensionsDir } = require('../extensions');

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

function executable(p) {
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The system install's scsynth candidates, in order. */
function knownScsynthLocations() {
  if (process.platform === 'darwin') return ['/Applications/SuperCollider.app/Contents/Resources/scsynth'];
  if (process.platform === 'win32') {
    return ['C:\\Program Files\\SuperCollider\\scsynth.exe', 'C:\\Program Files (x86)\\SuperCollider\\scsynth.exe'];
  }
  return ['/usr/local/bin/scsynth', '/usr/bin/scsynth'];
}

/** scsynth beside a given sclang, in either layout (macOS bundle or one folder). */
function scsynthBeside(sclangPath) {
  if (!sclangPath || !path.isAbsolute(sclangPath)) return null;
  const dir = path.dirname(sclangPath);
  for (const c of [path.join(dir, '..', 'Resources', exe('scsynth')), path.join(dir, exe('scsynth'))]) {
    if (executable(c)) return path.normalize(c);
  }
  return null;
}

/**
 * { scsynthPath, ugenPluginsPath, extensionsDir, isPrivate } for the SuperCollider in use.
 * POPTART_SCSYNTH names the binary outright; POPTART_SCLANG still picks which install (its scsynth).
 */
function locateServer({ sclangPath = null } = {}) {
  const isPrivate = sclangPath ? isPrivateSclang(sclangPath) : (!process.env.POPTART_SCLANG && privateScInstalled());
  let scsynthPath = process.env.POPTART_SCSYNTH || null;
  if (!scsynthPath && isPrivate) {
    const c = path.join(privateResourcesDir(), exe('scsynth'));
    if (executable(c)) scsynthPath = c;
  }
  if (!scsynthPath) scsynthPath = scsynthBeside(sclangPath ?? process.env.POPTART_SCLANG);
  if (!scsynthPath) scsynthPath = knownScsynthLocations().find(executable) ?? null;
  return {
    scsynthPath,
    ugenPluginsPath: isPrivate ? privateUgenPluginsPath() : null,
    extensionsDir: isPrivate ? privateExtensionsDir() : userExtensionsDir(),
    isPrivate,
  };
}

module.exports = { locateServer, knownScsynthLocations, scsynthBeside };
