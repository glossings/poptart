# Packaging plan

How poptart gets from "clone the repo and read the Troubleshooting section" to "download a dmg
and double-click". Staged so each step ships value on its own; Sonic Pi (which bundles a full
SuperCollider inside its app) is the existence proof for the end state.

## Where the install pain actually is

Everything hard about installing poptart is "get three things onto disk in the right places":

1. **Node 20+** — fine for developers, a blocker for musicians.
2. **SuperCollider** — one `brew install --cask supercollider`, but with footguns (stale
   `sclang` symlinks on PATH, orphaned processes holding ports/devices).
3. **The VSTPlugin server extension** — the worst step today: find the right build on
   git.iem.at, download, unzip a subfolder into a hidden Extensions directory.

The stages below eliminate these in reverse order of difficulty.

## Stage 0 — security hardening (prerequisite for wider distribution) ✅

The server evals arbitrary JS by design (`/api/evaluate`), so anything that widens the
audience must first make sure only the user's own browser can reach it:

- **Bind loopback, not all interfaces.** `server.listen(PORT)` with no host bound `0.0.0.0`,
  i.e. anyone on the same Wi-Fi could execute code on the machine. Now binds `127.0.0.1`
  (override with `POPTART_HOST` — a deliberate non-loopback bind prints a warning and relaxes
  the checks below, for people who genuinely want a LAN jam).
- **Host-header allowlist** (`localhost` / `127.0.0.1` / `[::1]`) against DNS rebinding, where
  a malicious page's domain resolves to 127.0.0.1 and reaches the API from the browser.
- **Origin check on POSTs** against drive-by cross-origin requests from web pages (CORS blocks
  *reading* responses, not *sending* requests — and `/api/evaluate` does its damage on send).

Implemented in `packages/web-app/request-guard.js` (unit-tested pure logic) + `server.js`.

## Stage 1 — clone-and-run with first-run setup ✅ (this round)

Target install experience:

```sh
brew install --cask supercollider   # the one remaining manual step
git clone <repo> && cd poptart
npm install
npm run dev                          # first run auto-installs VSTPlugin, then boots
```

What the first-run setup (`packages/osc-engine/setup.js`, run by the server before booting the
engine) does:

- **SC detection** (already existed): standard install paths + `POPTART_SCLANG`. If missing,
  print the exact install command instead of a boot failure.
- **VSTPlugin auto-install**: if the extension isn't in the platform Extensions dir, download
  the pinned release for this platform/arch, verify its SHA-256, and unzip `sc/VSTPlugin`
  into place. Notes:
  - The `/uploads/...` links shown on git.iem.at release pages 404 in their displayed form;
    the working shape is `https://git.iem.at/-/project/485/uploads/<hash>/<file>`
    (485 = vstplugin project id).
  - URLs **and checksums** are pinned in `setup.js`, not scraped — protects against link rot
    and against a compromised/repointed download turning everyone's audio engine into an
    attacker's binary. Bumping the VSTPlugin version = edit one table (recipe in `setup.js`).
  - The upstream macOS binaries are not notarized, but that only matters for browser
    downloads: quarantine xattrs are added by browsers, not by Node/curl downloads, so the
    auto-install path sidesteps Gatekeeper. (Setup still strips the xattr defensively.)
  - Install failure is a warning, not a hard stop — the engine's existing boot diagnostics
    name the problem, and manual install (SETUP.md) always remains possible.
- **Preflight for known footguns**, replacing the SETUP.md troubleshooting section with checks:
  a symlinked `sclang` shadowing the real one (breaks class-library resolution), and orphaned
  `sclang`/`scsynth` processes holding ports or the audio device (warn + name the pkill,
  don't kill — it could be a deliberately open SC IDE).

## Stage 1.5 ✅ — a private SuperCollider, fetched by setup

Setup can now fetch SuperCollider itself, making poptart clone → run with zero manual steps and
nothing installed system-wide. `packages/osc-engine/private-sc.js` holds all of it: the pinned
release, the install, the generated class-library config and the consent rules. `doctor.js`
reports what it resolved, `private-sc.test.js` verifies it, and the resolution order and
Extensions destination are threaded through `index.js` and `setup.js`.

- **A private copy, not a system install.** The target is `~/.poptart/sc/<version>/`, not
  `/Applications` or `Program Files`: no admin rights, no Homebrew, nothing for an existing SC
  install (or its IDE) to collide with, and uninstalling is deleting one folder. SC needs no
  installer on either desktop platform - the macOS dmg holds a self-contained
  `SuperCollider.app` (sclang, scsynth, class library and UGens all inside the bundle), and
  every release ships a `win64.zip` next to the Windows installer (3.14.1: 250 MB universal
  dmg, 139 MB zip). Linux has no official binaries, so it stays on the package manager.
- **Private Extensions too.** Two things write into the user's SC Extensions folder today:
  `setup.js` (VSTPlugin) and `extensions.js` (the keylock UGen). With a private SC both go to
  `~/.poptart/sc/Extensions/` instead, and sclang is spawned with `-l <generated
  sclang_conf.yaml>` - `excludeDefaultPaths: true`, `includePaths` = the private copy's
  `SCClassLibrary` plus the private Extensions - while scsynth gets the matching
  `ugenPluginsPath` (the copy's own `plugins` dir plus the private Extensions; setting it
  replaces the defaults, so both must be listed). This is the same isolation Stage 2 needs, so
  Stage 2 reuses it rather than building its own.
  - What it removes from SETUP.md's troubleshooting: broken files in the user's Extensions
    folder, a VSTPlugin build that doesn't match the SC it sits under, and the stale `sclang`
    symlink (a private copy is resolved by full path, never through PATH).
  - What it does not remove: sclang still runs the user's own `startup.scd` before poptart's
    script, and `-l` has no say over that. Confirmed in 3.14.1's `Platform.sc` —
    `loadStartupFiles` reads `userConfigDir +/+ "startup.scd"` unconditionally, and
    `userConfigDir` is a primitive over the home directory. So it stays a preflight warning.
  - **Confirmed, not assumed** (2026-09-20, macOS, against the real 3.14.1 artifacts):
    `excludeDefaultPaths: true` does drop the user Extensions — the test's canary is that a
    machine with VSTPlugin installed in `~/Library/.../Extensions` boots the private sclang and
    gets `nil` for `\VSTPlugin.asClass`, then resolves it once the same extension is installed
    privately. Paths with spaces survive: the config is written in single-quoted YAML, where
    the only escape is `''`, so a space is a space and a Windows backslash is not an escape
    (double quotes would have mangled `C:\Users\…`). Also confirmed: `ugenPluginsPath` becomes
    scsynth's `-U`, which *replaces* the default search, so the list must carry the SC build's
    own `plugins` directory as well as ours.
- **How it gets verified.** Everything short of sound is checkable without a person, and is:
  `private-sc.test.js` runs the real download → checksum → unpack → generate conf → spawn
  `sclang -l` sequence into a temp directory with a space in its name and asserts the class
  library compiled from the private copy, that the machine's own Extensions are invisible, and
  that VSTPlugin resolves once installed privately. It is opt-in via `POPTART_SC_INSTALL_TEST=1`
  so an ordinary `npm test` doesn't pull 139–250 MB; `.github/workflows/private-sc.yml` sets it
  and runs the job on `windows-latest` and `macos-latest` (free on a public repo), which is what
  makes the Windows half buildable without a Windows machine to hand. Runners have no audio
  device, so the last step stays human on each platform: boot the engine from the private copy,
  scan, play a plugin, open its editor. `doctor.js` writes the resolved paths, the generated
  conf, the Extensions listing and sclang's own report to one file, keeping that to a single
  round trip.
- **Resolution order** becomes `POPTART_SCLANG` → private copy → PATH → standard install
  location. An existing system SC keeps working untouched; the private copy only exists once
  someone has opted into the download.
- **A portable folder falls out of this.** Once every SC path is private, a no-install
  poptart is the same layout with Node's official zip/tarball beside it (Node also runs from
  any folder) and a launch script that points `POPTART_SCLANG` and the per-directory
  variables in SETUP.md inside the folder. No Electron and no signing of our own, which makes
  it the cheap answer for someone who can't or won't install system-wide, well short of
  Stage 2.
- **No signing needed if we download instead of redistribute.** SC's official macOS releases
  are Developer-ID-signed and notarized *by the SC project*. If the user's machine fetches the
  pinned release dmg from SC's GitHub (checksummed, like the VSTPlugin flow), Gatekeeper is
  satisfied by SC's signature — no $99/yr Apple fee, no notarization pipeline on our side.
  This may make Stage 2's hardest part unnecessary.
- **Same trick works on Windows**: SmartScreen only screens files carrying the Mark of the
  Web, which browsers apply and Node's fetch does not — so programmatically fetched SC
  binaries would run without warnings (only the standard one-click firewall prompt for
  scsynth). poptart already runs on Windows from a standard SC install (`sclang.exe` found in
  `Program Files`, pinned win64 VSTPlugin build), so the zip is the same binaries in a
  different folder.
- **Consent, because it is a 139-250 MB download.** Nothing is fetched on a script's own
  initiative: `POPTART_INSTALL_SC` settles it outright (`1` installs even when a system SC
  exists, `0` never), otherwise an interactive terminal is asked y/N, and with no terminal and
  no variable the answer is no — with the variable named, so it can be made yes. An existing
  SuperCollider is left alone by default; the private copy is for people who don't have one or
  can't install one.
- **Old copies are cleaned up on a version bump**, and only then: after a new install has been
  verified runnable, sibling version directories are deleted. Nothing sweeps in the background,
  so there is always a working copy at the moment anything is removed. Two guards — only
  directories named like a version are candidates, which is what keeps the shared (deliberately
  unversioned) `Extensions` folder safe, and a copy `POPTART_SCLANG` points at is never touched.
- **Windows gaps closed along the way.** Orphan reaping was a silent no-op on Windows: it reads
  a pid's command name to make sure a recycled pid isn't killed by mistake, and did that with
  `ps`, which Windows has not got — so every reap answered "not ours" for a live scsynth.
  `tasklist` is the equivalent and is now used on win32, in both the reaper and setup's
  preflight. This matters more under the desktop shell, where Windows cannot deliver the SIGINT
  that shuts the engine down gracefully.

## Stage 2 (in progress) — the dmg: Electron

The "double-click and you're livecoding" build. No research risk — Sonic Pi has proven every
piece — but real distribution mechanics.

**What exists** (`packages/desktop/`): the shell itself. `main.js` makes sure there is a
SuperCollider, starts `packages/web-app/server.js` unchanged as a child process on a free
loopback port, and points a `BrowserWindow` at it; `server-process.js` holds the supervision
(port, readiness, shutdown) and is unit-tested; `loading.html` is what the window shows while
the engine comes up. The package is deliberately **outside** the npm workspaces so a plain
`npm install` doesn't pull ~200 MB of Electron on people who only want `npm run dev`.

**Packaging** starts from `stage.js`, which assembles the folder electron-builder is pointed
at: electron-builder collects modules from package.json `dependencies` (a workspace root has
none) and a Windows installer cannot carry the workspace symlinks, so the app is staged as a
flat, symlink-free folder of git-tracked files plus the exact third-party modules installed in
the repository. An unpacked, unsigned macOS arm64 app has been built from it and inspected -
contents, icon, `Info.plist`, every `require` resolved under the packed runtime. Its first
launch failed exactly where expected: packed into an asar archive, the engine handed sclang a
script path that exists only to Electron's patched `fs`, and `asarUnpack` does not help because
nothing rewrites a `__dirname` path to `app.asar.unpacked`. The app is now packaged unarchived
(`asar: false`), and the engine fails at once with the right cause when sclang cannot read its
script, where it used to wait out the boot timeout and blame the user's `startup.scd`.

**What does not exist yet**: any actual installer (no dmg or NSIS build has been run), and
nothing is signed.

**Diagnostics** (`packages/desktop/diagnostics.js`): a packaged app has no terminal, so the shell
writes its own status lines and everything the server prints to `~/.poptart/desktop.log`, beside
the `engine.log` sclang's output already goes to. "Save Diagnostic Report…" - in the Help menu on
macOS, and as a link on the failure screen on every platform - runs `doctor.js` as a child of
the app's own binary and appends the desktop log, producing one file to send. It always produces
that file, including when doctor itself cannot run.

- **Electron shell.** The web-app is a plain Node server + browser page, which is the easy
  case. Keep the page browser-compatible (no Electron-only APIs in the UI) so `npm run dev` in
  a browser keeps working for development. Two things the shell must not get wrong, both
  covered by tests: the server is forced to `127.0.0.1` regardless of `POPTART_HOST` (it evals
  arbitrary JS — Stage 0), and quitting signals the server so sclang can stop scsynth, rather
  than orphaning the process that holds the audio device.
- **SuperCollider is fetched, not bundled** — Stage 1.5 does this already, so the app reuses it
  instead of embedding a 556 MB `SuperCollider.app`. The user's own machine downloads
  SuperCollider's officially signed release, which keeps the installer small and means we are
  not redistributing and re-signing another project's binaries. The GUI equivalent of the
  terminal's y/N is a dialog on first run. The bundled-SC alternative is still written up below,
  because it is what a fully offline installer would need.
- **Signing & notarization (the genuinely annoying part — and not optional).** Since macOS
  Sequoia there is no right-click → Open bypass for unsigned apps; users must dig through
  System Settings → Privacy & Security → "Open Anyway", which is *worse* UX than the
  terminal flow. An unsigned dmg is therefore pointless: ship Stage 2 signed or not at all.
  Apple Developer ID ($99/yr),
  notarize in CI, sign every bundled binary (sclang, scsynth, VSTPlugin.scx, dylibs) with
  hardened runtime. **scsynth needs the `com.apple.security.cs.disable-library-validation`
  entitlement** — loading arbitrary third-party VSTs is the whole point, and without it a
  signed scsynth refuses plugins signed by other teams (or unsigned).
  - Checked against SC 3.14.1's macOS build: `sclang` and `scsynth` already ship Developer-ID
    signed with hardened runtime, and both carry `disable-library-validation`,
    `allow-unsigned-executable-memory` and the audio-input entitlements. That leaves two
    routes, to be settled in the spike. Embed `SuperCollider.app` untouched and keep it out of
    our signing pass (electron-builder's `signIgnore`), so SC's own signature stands: least
    work, but the app is 556 MB unpacked, 504 MB of it `Frameworks` (the IDE's Qt). Or strip
    the IDE and re-sign what remains with our identity and the same entitlements: smaller
    download, more to get wrong. Unconfirmed: that notarization accepts the first route
    (nested code signed by another team), and how much of `Frameworks` sclang itself needs.
  - poptart's own helpers (`native/bin/poptart-audio`, `native/link/bin/poptart-link`,
    `native/rubberband/bin/PoptartPitchShift.scx`) are universal binaries with ad-hoc
    signatures today; the release build has to sign them with the Developer ID.
- **SuperCollider's Dock icon cannot be suppressed with the official binaries.** sclang is a Qt
  application living inside `SuperCollider.app`, so macOS registers it as a foreground app from
  that bundle's `Info.plist`. Tried and measured (LaunchServices' own report of the process
  type): Qt's `QT_MAC_DISABLE_FOREGROUND_APPLICATION_TRANSFORM` has no effect on a bundled
  executable; `lsappinfo setinfo ... ApplicationType=UIElement` is accepted and ignored; Qt's
  `offscreen` platform plugin is not shipped (only `libqcocoa`); and adding `LSUIElement` to a
  private copy's `Info.plist` leaves sclang's and scsynth's own signatures valid but breaks the
  bundle's seal, after which Gatekeeper refuses to launch sclang at all ("damaged"), and once
  the copy has been launched macOS refuses the edit itself. What remains is not running that
  sclang: Stage 3, or a Qt-less sclang (`SC_QT=OFF`) built, signed and shipped by poptart,
  which gives up "fetched, not bundled" for that one binary.
- **Small gotchas**: if scsynth boots with audio inputs, macOS requires a mic-permission
  prompt + `NSMicrophoneUsageDescription` in the bundle (or boot with 0 inputs by default);
  kill child sclang/scsynth on app quit so orphans can't accumulate; dmg + signing also avoids
  app-translocation weirdness that plagues unzipped apps.
- **CI matrix**: electron-builder handles dmg + Windows NSIS; pipeline fetches the right
  SC + VSTPlugin builds per platform/arch (macOS arm64 + x64 at minimum).
- **Licensing is clear**: SC and VSTPlugin are GPLv3, poptart is AGPL-3.0 — redistribution of
  the binaries is fine as long as source is available (it is).

### Cutting a release

Releases are cut by tag, never by push; day-to-day commits build nothing. The only workflow in
the repo today is `private-sc.yml` (Stage 1.5's install check); nothing builds an installer
yet. GitHub Actions has macOS and Windows runners, so neither installer needs a local machine
of that platform to build.

1. A local release script checks for a clean tree, runs the tests, bumps `version` in the
   root and workspace `package.json` files, and drafts the changelog section from the commits
   since the last tag. The commit style (one line, semicolon-separated capability clauses)
   splits mechanically into bullets grouped by leading verb (Add / Fix / Change); the draft
   then gets an editing pass by hand. It stops there, committing nothing.
2. Review, commit, tag `vX.Y.Z`, push the tag.
3. The tag triggers the workflow: build macOS (arm64 + x64) and Windows, sign, notarize,
   attach the installers to a **draft** GitHub Release whose notes are the changelog section.
4. Smoke-test the draft's installers, then publish.

Step 4 cannot be automated away: CI runners have no audio device, so a green build proves the
packaging and nothing about sound. Each platform needs a person with that machine running a
short checklist (installs, boots, scans plugins, a note plays, a VST editor opens) on every
release candidate.

Windows gap to close first: the keylock UGen and the Link helper are built for macOS only
(one binary in each `bin/`), and `poptart-audio` is Swift. Keylock falls back to the SOLA def
and Link disables itself when its helper is absent, so a first Windows installer can ship
without them, but their `build.sh` scripts need Windows counterparts before parity.

### One-time setup outside the repo

- **Apple Developer Program**, $99/yr. Enrolling as an individual puts the account holder's
  legal name in the Developer ID certificate, where `codesign -dv` shows it to anyone who
  looks; enrolling as an organization shows the organization's name instead, but requires a
  legal entity and a D-U-N-S number. Then: create a *Developer ID Application* certificate,
  export it as a `.p12`, create an App Store Connect API key for `notarytool`, and store all
  of it as Actions secrets.
- **Windows signing is optional.** An unsigned installer downloaded through a browser gets the
  SmartScreen "Windows protected your PC" dialog, passable with More info → Run anyway;
  unlike macOS this is an acceptable first release. Removing it means an OV certificate
  (private keys must live on a hardware token or cloud HSM) or a cloud signing service;
  prices and eligibility rules to be checked when it's wanted.
- Actions minutes are free on a public repo; on a private one macOS minutes count tenfold
  against the monthly allowance, which occasional tagged releases still fit inside.

## Stage 3 (someday, optional) — drop sclang, talk to scsynth directly

VSTPlugin can be driven purely via raw scsynth unit commands (`/u_cmd`) — the Pd port does
exactly that with no language runtime. Porting the sclang-side logic (sc/poptart.scd) to Node
would shrink the bundle a lot and delete the class-library-compile failure mode entirely. But
it's a real rewrite of the engine layer, and bundling (Stage 2) makes sclang's fragility
mostly moot — file under "nice someday", not part of the packaging effort.

## npm publishing (optional add-on to Stage 1)

`npx <name>` instead of clone-and-run. Decision deferred; the checklist when we want it:

- **The name `poptart` is taken on npm** (an unrelated tooltip library). Options: scoped
  `@glossing/poptart` (works with npx, always free), a variant like `poptart-live` (checked:
  free), or npm's slow abandoned-name dispute process. Also: "Pop-Tart" is a defended
  Kellogg's trademark — low practical risk for an unmonetized niche tool, but a registry is
  more visible than a repo; know the name sits on someone's mark.
- **Publishing is ~permanent**: free unpublish only within 72h, then versions live forever
  and get mirrored. Needs a `files` allowlist first so `tmp/`, personal mappings, or local
  paths don't ship; the workspace layout needs a package to own the `bin` that npx runs.
- **Supply-chain obligations**: 2FA on the npm account, ideally provenance publishing from
  CI. (Checksum-pinned VSTPlugin downloads: already done in Stage 1.)
- **Soft cost**: an npx-able package reads as "supported software" — more users, more issue
  reports, semver expectations. The clone flow self-selects for people who accept the
  side-project frame; that's a legitimate reason to stay clone-only for a while.
