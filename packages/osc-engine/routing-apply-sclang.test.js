'use strict';

// routeApply (sc/poptart.scd) - how a track takes a new layout of its chain: the buses it names
// allocated, an effect's node made the first time a layout names its slot and only moved and
// rewired after that, crossovers and terms made where the layout has them, all in one bundle. The
// thing pinned here above all is the promise the whole design rests on: a change of structure
// never recreates a node that holds a device, so no plugin reloads and no program is lost. Also
// the pieces around it: where a channel control lives (channelTarget) and the neutral values a
// route control's modulator leaves behind (channelDefault).
//
// The closures are lifted out of the shipped file and run in a real sclang against a Server that
// is never booted: its address is a stand-in that prints every message, as hush-sclang.test.js
// does. What it SOUNDS like is routing-sclang.test.js's business.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { userExtensionsDir } = require('./extensions.js');
const { desktopRouting } = require('./route-desktop');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const PORT = '57322'; // its own, like every sclang harness

function lift(name) {
  const m = fs.readFileSync(SCD, 'utf8').match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

async function layouts() {
  const { s, routePlan } = await import(path.join(__dirname, '..', 'pattern-core', 'src', 'index.mjs'));
  const xover = ['frequency', 'Frequency', 0.049];
  const of = (sig) => desktopRouting(routePlan(sig).plan, { count: sig.fxChain.length, crossover: xover });
  return {
    split: of(s('x').split((b) => b.fx('A'), (b) => b.fx('B').postgain(0.5)).fx('C')),
    bands: of(s('x').bands([300], (l) => l.fx('A'), (h) => h.fx('B')).fx('C')),
    line: desktopRouting(null, { count: 3 }),
    send: of(s('x').fx('A').bus('feedback').fx('B').fx('C')),
  };
}

function run(dir, specs) {
  const sclang = resolveSclangPath();
  const conf = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(conf, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${path.join(userExtensionsDir(), 'PoptartDevice.sc')}\n`);
  const q = (v) => JSON.stringify(JSON.stringify(v));
  const script = `(
var srv = Server(\\poptartRouteProbe, NetAddr("127.0.0.1", 57998));
var server = srv, routeNowhere = 1000000, silentBus = (index: 7), unityGainBus = (index: 3);
var nodeOwns = { |id, what| };
var routeApply, routeFree, slotNode, ensureFxNode, routeKrNode, channelTarget, channelDefault;
var sendInput, repointSends, stripPost = { |track| (index: 77) };
var djNode = { |track| track[\\synth] }, bassMonoNode = { |track| track[\\synth] };
var chanIn, cueOffset, buildFxDef, buildXoverDef, trackDef, track, sent = List.new, specs, ids;
srv.addr = (addr: 1, isLocal: true, hostname: "127.0.0.1", ip: "127.0.0.1", port: 57998,
    sendMsg: { |self ...msg| sent.add(msg) }, sendBundle: { |self, time ...msgs| msgs.do { |m| sent.add(m) } },
    // What Server's makeBundle asks of an address: none open yet, and the bundle sent whole.
    hasBundle: false, sendClumpedBundles: { |self, time ...msgs| msgs.do { |m| sent.add(m) } });
${lift('chanIn')}
${lift('buildFxDef')}
${lift('buildXoverDef')}
${lift('routeApply')}
${lift('routeFree')}
${lift('sendInput')}
${lift('repointSends')}
${lift('slotNode')}
${lift('ensureFxNode')}
${lift('routeKrNode')}
${lift('channelTarget')}
${lift('channelDefault')}
trackDef = (fx: buildFxDef.(), xover: buildXoverDef.());
track = (synth: Synth.basicNew(\\poptart_track_shared, srv, 5000), head: Synth.basicNew(\\poptart_head, srv, 4999),
    chain: Group.basicNew(srv, 4000), krGroup: Group.basicNew(srv, 4001), chainIn: (index: 90),
    nodes: IdentityDictionary.new, xovers: IdentityDictionary.new, terms: List.new,
    gains: IdentityDictionary.new, xos: IdentityDictionary.new, scBus: IdentityDictionary.new, wet: IdentityDictionary.new,
    taps: IdentityDictionary[\\bus0 -> Synth.basicNew(\\poptart_tap, srv, 6000)], busSends: ["feedback"], busSendIdx: [0],
    sendIns: Dictionary.new);
specs = [${specs.map(q).join(', ')}].collect(_.parseJSON);
{
    var dump = { |tag| sent.do { |m| (tag ++ "<" ++ m.collect(_.asString).join(" ") ++ ">").postln }; sent.clear };
    var ids = { track[\\nodes].keys.asArray.sort.collect { |k| k.asString ++ "=" ++ track[\\nodes][k].nodeID }.join(",") };
    routeApply.(\\t, track, specs[0]);
    dump.("SPLIT");
    ("NODES-SPLIT<" ++ ids.() ++ ">").postln;
    routeApply.(\\t, track, specs[1]);
    dump.("BANDS");
    ("NODES-BANDS<" ++ ids.() ++ ">").postln;
    ("XOVERS<" ++ track[\\xovers].size ++ ">").postln;
    routeApply.(\\t, track, specs[2]);
    dump.("LINE");
    ("NODES-LINE<" ++ ids.() ++ ">").postln;
    ("XOVERS-AFTER<" ++ track[\\xovers].size ++ ">").postln;
    // A send written inside the chain: its tap reads the bus the layout gives it, then the strip again.
    routeApply.(\\t, track, specs[3]);
    dump.("SEND");
    ("SENDIN<" ++ (sendInput.(track, 0) ? "nil") ++ ">").postln;
    routeApply.(\\t, track, specs[2]);
    dump.("UNSEND");
    ("SENDIN-AFTER<" ++ (sendInput.(track, 0) ? "nil") ++ ">").postln;
    // Where a channel control lives.
    ("AT<" ++ [\\rl2, \\xo1, \\wet2, \\gain, \\postgain].collect { |n|
        var at = channelTarget.(track, n);
        at !? { |a| a[0].nodeID.asString ++ ":" ++ a[1] } ? "nil" }.join(",") ++ ">").postln;
    ("HEAD<" ++ track[\\head].nodeID ++ ">").postln;
    ("WET2<" ++ track[\\nodes][2].nodeID ++ ">").postln;
    ("DEFAULTS<" ++ [channelDefault.("rl5"), channelDefault.("rp5"), channelDefault.("xo3").round(0.0001), channelDefault.("wet2"), channelDefault.("pan")].join(",") ++ ">").postln;
    "APPLY-DONE".postln;
    0.exit;
}.fork(SystemClock);
SystemClock.sched(20, { "APPLY-TIMEOUT".postln; 0.exit; nil });
)
`;
  const file = path.join(dir, 'apply.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(sclang, ['-l', conf, '-u', PORT, file], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('a change of structure moves and rewires a track\'s effects and never recreates one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-route-apply-'));
  try {
    const { split, bands, line, send } = await layouts();
    const text = run(dir, [split, bands, line, send]);
    if (!text.includes('Welcome to SuperCollider')) { t.skip(`sclang did not start here: ${text.trim().split('\n').pop()}`); return; }
    assert.match(text, /APPLY-DONE/, `the harness did not finish:\n${text.split('\n').slice(-25).join('\n')}`);
    // sclang sends the server's commands by number: these are the ones in play.
    const COMMANDS = { 9: '/s_new', 11: '/n_free', 15: '/n_set', 18: '/n_before', 14: '/n_map', 48: '/n_mapn' };
    const tagged = (tag) => [...text.matchAll(new RegExp(`^${tag}<(.*)>$`, 'gm'))]
      .map((m) => m[1].split(' '))
      .map(([cmd, ...rest]) => [COMMANDS[cmd] ?? cmd, ...rest]);
    const one = (tag) => text.match(new RegExp(`^${tag}<(.*)>$`, 'm'))?.[1];
    const made = (msgs, def) => msgs.filter((m) => m[0] === '/s_new' && m[1] === def);

    // The first layout makes the three effects, in a bundle with their terms and their order.
    const first = tagged('SPLIT');
    assert.equal(made(first, 'poptart_fx').length, 3);
    assert.ok(made(first, 'poptart_term').length >= 2, 'the split\'s sum is made of terms');
    assert.ok(first.some((m) => m[0] === '/n_before'), 'and each is placed in signal order');
    const nodes = one('NODES-SPLIT');
    assert.match(nodes, /^1=\d+,2=\d+,3=\d+$/);

    // A split becomes a band split: the same three nodes, moved and pointed at new buses - no
    // effect made again or freed, so nothing a plugin holds is lost.
    const second = tagged('BANDS');
    assert.deepEqual(made(second, 'poptart_fx'), [], 'an effect node was made again');
    assert.equal(one('NODES-BANDS'), nodes, 'an effect node changed');
    const freed = second.filter((m) => m[0] === '/n_free').flatMap((m) => m.slice(1));
    for (const id of nodes.split(',').map((e) => e.split('=')[1])) assert.ok(!freed.includes(id), `effect node ${id} was freed`);
    assert.equal(made(second, 'poptart_xover').length, 1, 'the crossover is made, the engine\'s own');
    assert.equal(one('XOVERS'), '1');
    assert.ok(second.some((m) => m[0] === '/n_before'));
    assert.ok(second.some((m) => m[0] === '/n_set' && m.includes('in') && m.includes('out')), 'and rewired');

    // ...and back to the plain line: still the same nodes; the crossover goes.
    const third = tagged('LINE');
    assert.deepEqual(made(third, 'poptart_fx'), []);
    assert.equal(one('NODES-LINE'), nodes);
    assert.equal(one('XOVERS-AFTER'), '0');

    // A branch level and a crossover frequency are their publishers'; a wet is its effect's own;
    // the input gain is the head's; the rest are the strip's.
    const at = one('AT').split(',');
    assert.match(at[0], /:level$/);
    assert.match(at[1], /:value$/);
    assert.equal(at[2], `${one('WET2')}:wet`);
    assert.equal(at[3], `${one('HEAD')}:gain`);
    assert.equal(at[4], '5000:postgain');
    assert.deepEqual(one('DEFAULTS').split(','), ['1', '0', '0.049', '1', '0']);

    // The send's tap follows the layout: pointed at the bus the send reads, in the same bundle,
    // and back at the strip's output once the layout has no place for it.
    const sendIn = one('SENDIN');
    assert.match(sendIn, /^\d+$/, 'the layout gave the send a bus');
    const tapSets = (msgs) => msgs.filter((m) => m[0] === '/n_set' && m[1] === '6000').map((m) => m[m.indexOf('in') + 1]);
    assert.ok(tapSets(tagged('SEND')).includes(sendIn), 'the tap reads it');
    assert.equal(one('SENDIN-AFTER'), 'nil');
    assert.ok(tapSets(tagged('UNSEND')).includes('77'), 'and the strip again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
