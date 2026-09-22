# Changelog

What changed in each release, newest first.

## 0.1.2 - 2026-09-22

### Fixed

- Fix sampler onset drift
- Fix bug where tracks could fail to load and be unrecoverable
- Don't send notes to a plugin that is loading
- Fix sample pack and organizer paths on Windows

## 0.1.1 - 2026-09-22

### Added

- Allow mp3 as a file format for samples and songs

### Fixed

- Fix scsynth continuing to play on Windows after an app shutdown or crash

## 0.1.0 - 2026-09-22

First release. Poptart is like a livecoding environment, a CDJ, and a DAW had a baby.

- **Your real VST plugins** as instruments and effects, with their knobs addressed by name and
  modulated live from inside the audio engine via hand-drawn LFOs and envelopes.
- **Piano rolls**, with tools to help you write rhythms, harmonies, and melodies.
- **An arrangement view and a mixer.**
- **Two DJ decks**, with a crossfader, keylock, a filter, and headphone cue.
- **A sampler**, with chops and granular playback.
- **A sample map**: your whole library laid out by how the samples sound, so the ones like the
  one you're using are the ones beside it.
- **Recording, both ways**: play your MIDI keys into a piano roll, or bounce a track to a file
  and play it straight back as a sample. Hardware inputs work as a track's source too.
- **A snippet browser**: save a block of code and drop it into any song - the rolls, shapes, and
  presets it needs come along automatically.
- **MIDI in and out, MIDI clock out, OSC in, and Ableton Link**, for your hardware and the other
  apps on the network.

### Which file

| | |
| --- | --- |
| **Windows** | `poptart-0.1.0-setup.exe` |
| **Windows, portable** | `poptart-0.1.0-portable-x64.zip` - unpack it anywhere and Poptart keeps everything in the `poptart-data` folder inside it, rather than in your user folder. For an external drive, or two setups that do not share anything. |
| **macOS, Apple Silicon** | `poptart-0.1.0-arm64.dmg` |
| **macOS, Intel** | `poptart-0.1.0-x64.dmg` |

Both platforms will warn you about an app they have not seen before.

- **macOS**: Poptart is not signed by a registered Apple developer yet, so it will refuse to open
  the first time. Drag Poptart to your Applications folder, then open **System Settings → Privacy
  & Security**, scroll down to **Security**, and click **Open Anyway** next to the message about
  Poptart. Once only.
- **Windows**: SmartScreen will say it protected your PC. **More info → Run anyway.**

### The first run takes a while

Poptart needs [SuperCollider](https://supercollider.github.io) to make sound, and sets it up for
you. If you do not already have it, Poptart asks first and then downloads its own private copy
(140-250 MB) into its data folder - nothing is installed system-wide, no administrator password,
and deleting one folder undoes it. The extension that hosts plugins is fetched the same way.

Then it scans your plugins. That is a few seconds on a small collection and **fifteen to twenty
minutes on a large collection**, once per machine. The editor works while it runs and the plugin list fills in as it goes, but `.synth()` and
`.fx()` names will not resolve until it finishes.

### Where to start

Type out a pattern or use the default one provided to you. Inside `.synth()` you can begin
typing to see an autocompletion of your available plugins. Same for effects, under `.fx()`. Then press **eval**, and open **docs ↗** for a more in-depth introduction. `SETUP.md` covers where files live, every setting, and how to troubleshoot issues.

### Known gaps

- **No AudioUnit support.** VST2 and VST3 only - in practice nearly every AU also ships a VST3.
- **Windows** has no Ableton Link, and the DJ decks' keylock uses its rougher fallback rather than
  the native pitch shifter.
- **The Intel Mac build is untested.** CI produces it; nobody has run it on an Intel machine.
- **No Linux build.** SuperCollider publishes no Linux binaries, so Linux runs from source with
  SuperCollider installed from your package manager.

If something goes wrong: **Help → Save Diagnostic Report** on macOS, or the link on Poptart's own
error screen, writes one file with everything Poptart decided and why - that is the thing to
attach to a report. The same information is in `desktop.log` and `engine.log` in Poptart's data
folder (`~/.poptart`, or `%USERPROFILE%\.poptart` on Windows).
