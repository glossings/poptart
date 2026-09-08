'use strict';

// The arrangement painter is per DECK (public/client.js), and the view controls moved with it.
//
// DJ mode gives the page two panes, each with its own code, its own arrangement and its own song
// clock. Two things follow, and both are what this file guards:
//
//   - The painter is opened AGAINST a deck. Everything it reads and writes goes to that deck's
//     editor (`arCM`), its evaluations go to that deck, and its playhead runs on that deck's clock.
//   - "Which view" was never a question the header could answer once there were two panes, so the
//     header carries DJ mode alone - a mode, on or off - and code | arrange lives on each pane's
//     own head.
//
// All source-shape assertions: the wiring is DOM and layout, which a unit test can't exercise, but
// the wiring going quietly wrong (an edit on deck B written into the main buffer, a re-evaluation
// aimed at the wrong deck mid-mix) is exactly the failure nobody would notice until a set.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

// ---------------------------------------------------------------------------------------------
// Which deck the painter is on
// ---------------------------------------------------------------------------------------------

test('the painter is opened against a deck, and binds to that deck\'s editor', () => {
  const open = grab('openArrangePainter');
  assert.match(open, /function openArrangePainter\(deck = mixModeOn \? djActiveDeck : 'a'\)/,
    'with no deck named it is the one you are working on');
  assert.match(open, /const want = deck === 'b' && mixModeOn && deckBCM \? 'b' : 'a';/,
    'deck B only exists in DJ mode, and only once its editor has been made');
  assert.match(open, /arCM = want === 'b' \? deckBCM : cm;/);
});

test('opening it on the OTHER deck moves it rather than opening a second one', () => {
  const open = grab('openArrangePainter');
  assert.match(open, /if \(arState && arDeck === want\) \{ closeArrangeEditor\(\); return; \}/, 'again = away');
  assert.match(open, /if \(arState\) closeArrangeEditor\(\);/, '...and on the other deck it moves');
});

test('closing puts the binding back on the main buffer, after the jump into the code', () => {
  // The jump lands in the deck that was being arranged (arGotoBlock focuses arCM), so the reset
  // has to come after it or a clip on deck B would take you to the main editor's block instead.
  const close = grab('closeArrangeEditor');
  assert.match(close, /if \(picked\) arGotoBlock\(picked\);\n\s+arDeck = 'a';[^\n]*\n\s+arCM = cm;/);
  assert.match(close, /classList\.remove\('arrange-on', 'arrange-deck-a', 'arrange-deck-b'\)/);
});

test('every buffer read and write in the painter goes through arCM, never cm', () => {
  // One stray `cm.` in here writes deck B's edit into the main buffer mid-mix.
  const at = SRC.indexOf('// The arrangement painter - ctrl+A.');
  assert.ok(at > 0, 'the painter section header moved - this test needs updating');
  const section = SRC.slice(at);
  const strays = [...section.matchAll(/(^|[^\w.$])cm\.(\w+)/g)]
    .map((m) => m[2])
    .filter((fn) => fn !== 'refresh' || false); // no exemptions: closing refreshes arCM too
  assert.deepEqual(strays, [], `the painter still touches cm directly: ${strays.join(', ')}`);
});

test('a write into deck B does not try to refold - that pane has no folds', () => {
  assert.match(SRC, /const arRefold = \(\) => \{ if \(arCM === cm\) refoldAll\(\); \};/);
  // ...and every refold in the painter goes through it: the one call to refoldAll down there is
  // arRefold's own.
  const at = SRC.indexOf('// The arrangement painter - ctrl+A.');
  assert.equal((SRC.slice(at).match(/(^|[^\w.$])refoldAll\(\)/g) ?? []).length, 1);
});

test('the buffer watcher is per editor, and only the bound one speaks', () => {
  // The marker lives in one document; asking the other editor where it is answers about the wrong
  // buffer entirely.
  assert.match(grab('arWatchBuffer'), /if \(!arState \|\| arSuppressClose \|\| arCM !== ed\) return;/);
  assert.match(SRC, /arWatchBuffer\(cm\);/);
  assert.match(SRC, /arWatchBuffer\(deckBCM\);/);
});

// ---------------------------------------------------------------------------------------------
// Evaluating, and the song clock
// ---------------------------------------------------------------------------------------------

test('a painter edit re-evaluates the deck it is on, and leaves the other playing', () => {
  const sched = grab('arScheduleEval');
  assert.match(sched, /const deck = arDeck;/, 'captured at schedule time, not read after the wait');
  assert.match(sched, /if \(deck === 'b'\) evalDeckB\(false\);\n\s+else evaluate\(false\);/);
});

test('each deck\'s eval sets the playhead clock only when the painter is on it', () => {
  // (evaluate() destructures its options, so grab() can't take it - matched against the whole file.)
  assert.match(SRC, /if \(arDeck === 'a'\) arSetClock\(result\.arrange \?\? null\);/);
  assert.match(grab('evalDeckB'), /if \(arDeck === 'b'\) arSetClock\(result\.arrange \?\? null\);/);
  assert.equal((SRC.match(/arSetClock\(result\.arrange/g) ?? []).length, 2, 'one per deck, no unguarded third');
});

test('deck B honors the painter\'s marker as a start bar, like the main pane', () => {
  assert.match(grab('evalDeckB'),
    /const arrangeFrom = start && transport\.paused && arDeck === 'b' && arState\?\.insert != null/);
  assert.match(grab('evalDeckB'), /deck: 'b', start, arrangeFrom \}/);
});

test('the clock is fetched for the deck being opened, and ctrl+L releases that deck\'s loop', () => {
  assert.match(SRC, /api\('GET', `\/api\/arrange\?deck=\$\{arDeck\}`\)/);
  assert.match(SRC, /arClockSnap = null;\n\s+api\('GET', `\/api\/arrange\?deck=/,
    'a stale clock from the other deck must not be left driving the playhead');
  assert.match(grab('arrangeUnlock'), /deck: arState \? arDeck : \(mixModeOn \? djActiveDeck : 'a'\)/);
  // ...and the server answers per deck, as it has kept the clocks all along
  assert.match(SERVER, /'GET \/api\/arrange': async \(query\) => \(\{[\s\S]{0,200}arrangeClocks\[query\?\.deck === 'b' \? 'b' : 'a'\]/);
});

test('the buffer passes run on the deck being EVALUATED, not the one being painted', () => {
  // Otherwise evaluating the main pane while the painter shows deck B would migrate, rename into
  // and fill deck B's code - and reconcile deck A's tracks into deck B's open panel.
  const on = grab('arOnBuffer');
  assert.match(on, /const ed = deck === 'b' \? deckBCM : cm;/);
  assert.match(on, /if \(arDeck !== deck\) arState = null;/, 'the panel\'s clips belong to one song');
  assert.match(on, /finally \{\n\s+arCM = prevCM;\n\s+arState = prevState;\n\s+arPassDeck = prevPass;\n\s+\}/);
  assert.match(SRC, /arOnBuffer\('a', \(\) => \{\n\s+arMigrateLegacy\(\);\n\s+arFollowHandRenames\(\);/);
  assert.match(SRC, /arOnBuffer\('a', arReconcileTracks\);/);
  assert.match(grab('evalDeckB'), /arSyncBuffer\('b'\);/, 'deck B gets the same passes');
});

test('the hand-rename snapshot is per deck - two decks are two songs', () => {
  // A block that appears in deck B is not a rename of one that left deck A.
  assert.match(SRC, /const arLastBlocks = \{ a: null, b: null \};/);
  const follow = grab('arFollowHandRenames');
  assert.match(follow, /const before = arLastBlocks\[arPassDeck\];/);
  assert.match(follow, /arLastBlocks\[arPassDeck\] = now;/);
});

// ---------------------------------------------------------------------------------------------
// Where the page draws
// ---------------------------------------------------------------------------------------------

test('the page is MOVED into its deck\'s pane, under that pane\'s head', () => {
  // Placing it with flex order instead would mean hiding the whole pane - and the pane's head is
  // where the code | arrange switch is, so that would take away the way back.
  assert.match(grab('openArrangeEditor'),
    /\(arDeck === 'b' \? deckBPaneEl : document\.getElementById\('editorPane'\)\)\.appendChild\(arPanel\);/);
  assert.match(grab('openArrangeEditor'), /classList\.toggle\('arrange-deck-a', arDeck === 'a'\)/);
  assert.match(grab('openArrangeEditor'), /classList\.toggle\('arrange-deck-b', arDeck === 'b'\)/);
});

test('what steps aside is the pane\'s BODY, not the pane', () => {
  assert.match(CSS, /body\.arrange-on\.arrange-deck-a #editorPane > \.CodeMirror,\n\s*body\.arrange-on\.arrange-deck-a #editorPane > \.song-pane,\n\s*body\.arrange-on\.arrange-deck-b #deckBPane > \.CodeMirror,\n\s*body\.arrange-on\.arrange-deck-b #deckBPane > \.song-pane \{\n\s*display: none;\n\}/);
  assert.ok(!/body\.arrange-on #editorPane \{\n\s*display: none;/.test(CSS), 'the whole-pane hide is gone');
  // and the panel is a flex item in a COLUMN now, so it needs a floor of zero to give up height
  assert.match(CSS, /\.arrange-panel \{[\s\S]{0,400}min-height: 0;/);
});

test('entering or leaving DJ mode puts the page away - the layout under it changed', () => {
  assert.match(grab('closeMixMode'), /if \(arState\) closeArrangeEditor\(\);/);
  assert.match(grab('openMixMode'), /if \(arState\) closeArrangeEditor\(\);/);
});

// ---------------------------------------------------------------------------------------------
// The view controls
// ---------------------------------------------------------------------------------------------

test('the header carries DJ mode alone, as a plain lit button', () => {
  assert.match(HTML, /<button id="viewDjBtn"/);
  assert.ok(!/view-switch/.test(HTML), 'the segmented switch is gone entirely - dj is an ordinary button');
  assert.ok(!/viewCodeBtn|viewArrangeBtn/.test(HTML), 'and code | arrange has no chrome at all (ctrl+A flips it)');
  assert.match(SRC, /getElementById\('viewDjBtn'\)\.addEventListener\('click', \(\) => toggleMixMode\(\)\)/);
  assert.match(CSS, /#viewDjBtn\.active \{/);
  // toggleMixMode already went both ways; the button is now simply that toggle
  assert.match(grab('toggleMixMode'), /if \(mixModeOn\) exitDjMode\('restore'\);\n\s+else openMixMode\(\);/);
});

test('deck A\'s head is always on screen; only its DECK chrome waits for DJ mode', () => {
  assert.match(CSS, /#deckAHead \.deck-only \{\n\s*display: none;\n\}/);
  assert.match(CSS, /body\.mix-on #deckAHead \.deck-only \{\n\s*display: inline-flex;\n\}/);
  assert.ok(!/#deckAHead \{\n\s*display: none;/.test(CSS), 'the head itself is no longer hidden');
  // ...so the pane stacks head-over-editor whether or not there are two decks
  assert.match(CSS, /#editorPane \{[\s\S]{0,300}flex-direction: column;/);
  assert.ok(!/body\.mix-on #editorPane \{\n\s*flex-direction: column;/.test(CSS));
});

test('a label inside a group body wears the label color, not the property dim', () => {
  // The JS mode tokenizes `kicks:` inside braces as an object property, which the theme paints
  // dimmer - reading as half-muted. markMemberLabels marks the splitter-confirmed track labels
  // so only real properties (a synth's `state:`) keep the property color.
  assert.match(grab('markMemberLabels'), /if \(b\.parent == null \|\| b\.kind === 'bare'\) continue;/);
  assert.match(grab('updateMutedDim'), /markMemberLabels\(code, blocks\);/);
  assert.match(CSS, /span\.cm-member-label \{\n\s*color: var\(--syn-variable\) !important;/);
});

test('only the dj toggle lights - there is no per-deck switch to reflect any more', () => {
  const reflect = grab('arReflectView');
  assert.match(reflect, /getElementById\('viewDjBtn'\)\.classList\.toggle\('active', mixModeOn\)/);
  assert.ok(!/viewArrangeBtn/.test(reflect), 'nothing else to light');
  assert.ok(!/body\.mix-on #viewArrangeBtn/.test(CSS), 'nothing left to dim either');
});

test('ctrl+A means THIS pane\'s arrangement, in either editor', () => {
  assert.match(SRC, /'Ctrl-A': \(\) => \(arState && arDeck === 'a' \? closeArrangeEditor\(\) : openArrangePainter\('a'\)\)/);
  assert.match(SRC, /'Ctrl-A': \(\) => \(arState && arDeck === 'b' \? closeArrangeEditor\(\) : openArrangePainter\('b'\)\)/);
  // ...and the painter no longer refuses to open during a mix
  assert.ok(!/leave DJ mode first \(ctrl\+D\)/.test(SRC), 'the refusal is gone - that is the whole feature');
});

// ---------------------------------------------------------------------------------------------
// Leaving DJ mode
// ---------------------------------------------------------------------------------------------

test('dropping deck B asks in the app\'s own dialog, naming both outcomes', () => {
  // A native confirm() answers this in a gray system box with "OK" on it, which says nothing about
  // what OK does - and this is the one question that can lose a set's worth of typing.
  const exit = grab('exitDjMode');
  assert.match(exit, /await askDialog\('Leave DJ mode\? Deck B\\'s code is dropped\.', \[/);
  assert.match(exit, /\{ label: 'stay in DJ mode', value: false \}/);
  assert.match(exit, /\{ label: 'leave, drop deck B', value: true, primary: true \}/);
  assert.ok(!/confirm\('Leave DJ mode/.test(SRC), 'the browser dialog is gone');
});
