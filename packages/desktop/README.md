# @poptart/desktop

The Electron shell — the "download it and double-click" build (PACKAGING.md, Stage 2).

It is deliberately thin. poptart is a Node HTTP server plus a browser page, so this package does
not reimplement any of it:

1. Make sure there is a SuperCollider to play through, fetching poptart's own private copy if
   there isn't (that is Stage 1.5's machinery — `osc-engine/private-sc.js` — not this package's).
2. Start `packages/web-app/server.js`, unchanged, as a child process on a free loopback port.
3. Point a window at it.
4. On quit, signal the server so it can stop the audio engine before the app goes away.

The page stays plain-browser: nothing in the UI uses an Electron API, so `npm run dev` in a
normal browser keeps working exactly as before.

## Status

| Part | State |
| --- | --- |
| Server supervision (`server-process.js`) | Unit-tested (`npm test` here) |
| Self-installing launcher (`start.js`, `ensure-electron.js`) | Unit-tested; the repair path verified against a real broken install on macOS |
| The shell (`main.js`) | Run from packaged builds on macOS and Windows, and through `npm run desktop` |
| Logs and the diagnostic report (`diagnostics.js`) | Unit-tested; the report has been produced by hand on macOS, and the failure screen has been seen on a real Windows first run. Off macOS there is no Help menu, so a running app has no way to reach the report (TODO.md) |
| Portable mode (`portable.js`) | Unit-tested, and detection checked from inside a packed binary; a full session from a `poptart-data` folder is **not yet tried** |
| Staging (`stage.js`) | Unit-tested; run for real against this repository |
| Packaging (`electron-builder.yml`) | The release workflow builds both dmgs, the Windows installer and the portable zip; each has been installed and run by hand on its platform (Intel Mac excepted) |
| Signing / notarization | macOS builds are ad-hoc signed (`build/adhoc-sign.js`), which makes them openable through System Settings but not trusted. Developer ID signing and notarization wait on an Apple Developer account — see PACKAGING.md |

## Running it

```sh
npm run desktop        # from the repository root
```

That is the whole procedure, including the first time. This package is **not** an npm workspace
member, so a plain `npm install` at the repository root does not download Electron (~200 MB) -
nobody who just wants `npm run dev` pays for the desktop build. Instead the launcher
(`start.js` → `ensure-electron.js`) installs Electron the first time the app is asked for, and
launches it.

It also repairs the one install failure seen in practice: Electron's own postinstall can
download its zip and then unpack nothing (its unzip library misbehaving on newer Node versions),
which otherwise surfaces as "Electron failed to install correctly". The launcher notices the
empty install and unpacks the cached download itself, so that error should never reach anyone.
(`npm start --prefix packages/desktop` is the same launcher.)

The sibling packages are not listed as dependencies here, and that is not an oversight: Node
resolves `@poptart/osc-engine` and friends by walking up to the repository's root
`node_modules`, where the workspace links already are. Listing them would make npm try to fetch
them from the public registry instead.

## Building an installer

```sh
npm run pack --prefix packages/desktop    # an unpacked app, fastest way to see it work
npm run dist --prefix packages/desktop    # a dmg / NSIS installer
```

Both run `stage.js` first. Three things are worth knowing:

- **What gets packaged is `stage/`, not the repository.** electron-builder collects
  `node_modules` by walking package.json `dependencies`, and a workspace root has none; the
  workspace packages also resolve by name only through symlinks, which a Windows installer
  cannot carry. So `stage.js` assembles a plain, symlink-free app folder: `web-app` and this
  package keep their places under `packages/`, `osc-engine` and `pattern-core` become real
  folders under `node_modules/@poptart`, and the third-party modules are copied from the
  repository's own `node_modules` - the versions `package-lock.json` pinned, not a fresh
  install.
- **Only files git tracks are staged.** A glob over a package folder ships whatever is lying in
  it, personal files included. Untracked files are left out and listed at the end of the run,
  so a new source file has to be `git add`-ed before a build can see it.
- **SuperCollider is not bundled.** The app downloads SuperCollider's own officially signed
  release on first run. That keeps this installer small and means poptart is not redistributing
  and re-signing another project's binaries — which, per PACKAGING.md, may remove the hardest
  part of Stage 2 entirely.

The icons in `build/` are drawn by `build/make-icon.js` (the favicon's chip, on Apple's icon
grid for macOS and full bleed for Windows); run it again after changing the colors.

An unsigned macOS build cannot be shipped to other people: since Sequoia there is no
right-click → Open bypass, and the System Settings route is worse than the terminal install it
replaces. Signing is the remaining work, not an optional polish step.
