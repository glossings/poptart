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
| The shell (`main.js`) | Written, syntax-checked, **not yet run** — needs Electron installed |
| Packaging (`electron-builder.yml`) | **Draft, never executed.** Treat every path in it as unconfirmed |
| Signing / notarization | Not done. Needs an Apple Developer account — see PACKAGING.md |

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

Read `electron-builder.yml` before trusting the output. Two things about it are worth knowing:

- **The app root is the repository, not this folder.** electron-builder's `files` globs cannot
  reach above the app root, and the server and engine live in sibling packages, so the config
  sets `directories.app: ../..` and names the entry point through `extraMetadata.main`.
- **SuperCollider is not bundled.** The app downloads SuperCollider's own officially signed
  release on first run. That keeps this installer small and means poptart is not redistributing
  and re-signing another project's binaries — which, per PACKAGING.md, may remove the hardest
  part of Stage 2 entirely.

An unsigned macOS build cannot be shipped to other people: since Sequoia there is no
right-click → Open bypass, and the System Settings route is worse than the terminal install it
replaces. Signing is the remaining work, not an optional polish step.
