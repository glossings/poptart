'use strict';

// Gives an unsigned macOS build a valid ad-hoc signature (electron-builder's afterPack hook, so
// it happens before the dmg is made).
//
// Without this the app is not merely "unsigned" - it is BROKEN. electron-builder copies Electron's
// own binary, whose arm64 Mach-O carries the linker's ad-hoc signature, and then seals nothing:
// `codesign -v` says "code has no resources but signature indicates they must be present", and
// macOS refuses the app as **"poptart is damaged and can't be opened"** with nothing in System
// Settings to override, because that is a signature *validation* failure and not a Gatekeeper
// policy decision. The only way past it is deleting the quarantine attribute from a terminal.
//
// `codesign --sign -` seals the bundle properly. The signature is still nobody's - Gatekeeper
// still rejects it, which is correct - but it rejects it the ordinary way: "cannot be opened
// because Apple cannot check it", with an Open Anyway button in System Settings > Privacy &
// Security. That is a dialog a musician can get past without a terminal.
//
// Skipped when a real certificate is configured: electron-builder signs properly in that case,
// and this would only be work thrown away (and `--deep`, which this needs for the nested helpers,
// is the wrong tool once entitlements and a hardened runtime are involved).

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // a real identity: not ours to touch
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // eslint-disable-next-line no-console
  console.log(`  • ad-hoc signing  ${path.basename(app)} (no certificate configured)`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'inherit' });
};
