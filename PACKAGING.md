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
    name the problem, and manual install (README) always remains possible.
- **Preflight for known footguns**, replacing the README troubleshooting section with checks:
  a symlinked `sclang` shadowing the real one (breaks class-library resolution), and orphaned
  `sclang`/`scsynth` processes holding ports or the audio device (warn + name the pkill,
  don't kill — it could be a deliberately open SC IDE).

## Stage 1.5 (parked, 2026-07-30) — auto-install SuperCollider too

Considered and deliberately not built yet: setup could also download SuperCollider itself,
making macOS truly clone → run with zero manual steps. Recorded here because the reasoning
changes how Stage 2 should be approached if it ever happens:

- **No signing needed if we download instead of redistribute.** SC's official macOS releases
  are Developer-ID-signed and notarized *by the SC project*. If the user's machine fetches the
  pinned release dmg from SC's GitHub (checksummed, like the VSTPlugin flow), Gatekeeper is
  satisfied by SC's signature — no $99/yr Apple fee, no notarization pipeline on our side.
  This may make Stage 2's hardest part unnecessary.
- **Same trick works on Windows**: SmartScreen only screens files carrying the Mark of the
  Web, which browsers apply and Node's fetch does not — so programmatically fetched SC
  binaries would run without warnings (only the standard one-click firewall prompt for
  scsynth). But poptart has never been run on Windows, so the install mechanics are ~20% of
  the risk there; don't advertise Windows support until someone has actually booted it once.
- **Why parked**: current audience is terminal-comfortable, and setup already prints the exact
  `brew install --cask supercollider` command when SC is missing — one manual step, zero
  maintenance. Also, silently dropping a ~150MB app from a dev script needs a consent prompt
  (y/N in terminal or `POPTART_INSTALL_SC=1`), which is design work.
- **Un-park trigger** (same as Stage 2's): someone who won't open a terminal wants poptart —
  a workshop, a musician friend, a residency. Then build this (macOS-first, `/Applications`
  as target) before reaching for Electron.

## Stage 2 — the dmg: Electron + bundled SuperCollider

The "double-click and you're livecoding" build. No research risk — Sonic Pi has proven every
piece — but real distribution mechanics:

- **Electron shell.** The web-app is a plain Node server + browser page, which is the easy
  case: main process runs `server.js` basically unchanged, window loads `localhost`. Keep the
  page browser-compatible (no Electron-only APIs in the UI) so `npm run dev` in a browser
  keeps working for development.
- **Bundle SC in `Resources/`**: `sclang`, `scsynth`, class library, plugins dir, plus a
  bundled `sclang_conf.yaml` whose include paths point at a bundled Extensions folder with
  VSTPlugin already in it. `POPTART_SCLANG`-style override already exists, so pointing the
  engine at the bundled copy is small. This *removes* whole failure classes (symlinks,
  version mismatches, manual Extensions surgery) because we control every path.
- **Signing & notarization (the genuinely annoying part — and not optional).** Since macOS
  Sequoia there is no right-click → Open bypass for unsigned apps; users must dig through
  System Settings → Privacy & Security → "Open Anyway", which is *worse* UX than the
  terminal flow. An unsigned dmg is therefore pointless: ship Stage 2 signed or not at all.
  Apple Developer ID ($99/yr),
  notarize in CI, sign every bundled binary (sclang, scsynth, VSTPlugin.scx, dylibs) with
  hardened runtime. **scsynth needs the `com.apple.security.cs.disable-library-validation`
  entitlement** — loading arbitrary third-party VSTs is the whole point, and without it a
  signed scsynth refuses plugins signed by other teams (or unsigned).
- **Small gotchas**: if scsynth boots with audio inputs, macOS requires a mic-permission
  prompt + `NSMicrophoneUsageDescription` in the bundle (or boot with 0 inputs by default);
  kill child sclang/scsynth on app quit so orphans can't accumulate; dmg + signing also avoids
  app-translocation weirdness that plagues unzipped apps.
- **CI matrix**: electron-builder handles dmg + Windows NSIS; pipeline fetches the right
  SC + VSTPlugin builds per platform/arch (macOS arm64 + x64 at minimum).
- **Licensing is clear**: SC and VSTPlugin are GPLv3, poptart is AGPL-3.0 — redistribution of
  the binaries is fine as long as source is available (it is).

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
  and get mirrored. Needs a `files` whitelist first so `tmp/`, personal mappings, or local
  paths don't ship; the workspace layout needs a package to own the `bin` that npx runs.
- **Supply-chain obligations**: 2FA on the npm account, ideally provenance publishing from
  CI. (Checksum-pinned VSTPlugin downloads: already done in Stage 1.)
- **Soft cost**: an npx-able package reads as "supported software" — more users, more issue
  reports, semver expectations. The clone flow self-selects for people who accept the
  side-project frame; that's a legitimate reason to stay clone-only for a while.
