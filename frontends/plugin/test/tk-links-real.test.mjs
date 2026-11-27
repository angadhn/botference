// tk-links-real.test.mjs — OPT-IN SMOKE TEST WITH REAL MODEL CALLS (short `claude -p` and `codex exec` runs on the owner's
// subscriptions), through the companion's own code (tkgaps askForGap, oneshot runOneShot) inside the real wrappers: a passage asked for
// a backlink with a made-up catalogue of three posts, one that asks for no link, one without a catalogue, and notes runs that read a
// made-up notes folder (Claude with its own tools, Codex through the notes reader). Skipped unless BOTFERENCE_REAL_SMOKE=1:
//
//   BOTFERENCE_REAL_SMOKE=1 node --test test/tk-links-real.test.mjs
//
// Run it before merging a change to the passage prompt, tk-links.mjs, oneshot.mjs or a wrapper: the stub tests cannot see a real
// model's reading of the prompt, the CLI's sign-in, or what the wrapper refuses a real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as O from '../oneshot.mjs';
import * as G from '../tkgaps.mjs';
import * as L from '../tk-links.mjs';

const on = process.env.BOTFERENCE_REAL_SMOKE === '1' && process.platform === 'darwin';
const skip = !on && 'set BOTFERENCE_REAL_SMOKE=1 (macOS) to run real `claude -p` and `codex exec` passages';
const WITHIN_MS = 90000;
const ID = n => `0123456789abcdefghjkmnpqr${n}`;
const POSTS = [
  { name: 'Harbour cranes', title: 'Harbour cranes and tides', id: ID('s'), date: '2026-03-01', tags: ['essays', 'ports'], excerpt: 'Why a crane waits for the tide before it lifts: the harbour is a clock.', file: 'published/Harbour cranes.md' },
  { name: 'short-lighthouse', id: ID('t'), date: '2026-02-01', excerpt: 'A short post about a lighthouse keeper who counted ships.', file: 'published/short-lighthouse.md' },
  { name: 'Ferry timetables', title: 'Ferry timetables', id: ID('v'), date: '2026-01-01', excerpt: 'How a timetable is a promise a town makes to itself.', file: 'published/Ferry timetables.md' },
];
const catalogueAt = top => ({ ...L.validateCatalogue(JSON.stringify({ posts: POSTS })), top });
const page = { url: 'https://page.example/tides', title: 'A page about tides' };
const wikilinks = text => [...String(text).matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim());

async function passage(agent, instruction, { catalogue = null, caps = 'web', roots = [] } = {}) {
  const gap = { id: 'g0', kind: 'ask', agent, instruction, mode: 'pending' };
  const t = Date.now();
  const r = await G.askForGap({ gap, msgText: `Ports run on tides.\n/tk-${agent} ${instruction}`, page, agent, caps, roots, catalogue,
    ask: (prompt, o) => O.runOneShot(o.agent, prompt, { caps: o.caps, roots: o.roots, effort: 'low' }) });
  const ms = Date.now() - t;
  console.log(`${agent} [${caps}${catalogue ? ', catalogue' : ''}] ${ms} ms: ${JSON.stringify(r.mode === 'failed' ? r.reason : r.text)} links=${JSON.stringify(r.links || null)}`);
  assert.equal(r.mode, 'filled-by-agent', r.reason);
  assert.ok(ms < WITHIN_MS, `${ms} ms`);
  return r;
}

for (const agent of ['claude', 'codex']) {
  test(`REAL ${agent}: asked for a backlink, it links to the right post of the catalogue, by its exact name`, { skip, timeout: 200000 }, async () => {
    const r = await passage(agent, 'use a backlink to my essay on harbour cranes to explain this, in two sentences', { catalogue: catalogueAt('') });
    assert.deepEqual([...new Set(wikilinks(r.text))], ['Harbour cranes']);
    assert.equal(r.links.catalogue, 'catalogue');
    assert.ok(r.links.kept >= 1 && r.links.reduced === 0, JSON.stringify(r.links));
  });
  test(`REAL ${agent}: not asked for a link, it writes none, catalogue or not`, { skip, timeout: 200000 }, async () => {
    const r = await passage(agent, 'say in one short sentence why ports depend on tides', { catalogue: catalogueAt('') });
    assert.deepEqual(wikilinks(r.text), []);
    assert.deepEqual(r.links, { catalogue: 'catalogue', kept: 0, reduced: 0 });
  });
  test(`REAL ${agent}: a plain passage without a catalogue still answers quickly`, { skip, timeout: 200000 }, async () => {
    const r = await passage(agent, 'say in one short sentence that this is a test passage');
    assert.equal(r.links, undefined);
  });
  test(`REAL ${agent}: a notes run reads the published post's own file, links only to the catalogue post, and never to the private note`, { skip, timeout: 240000 }, async () => {
    const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-real-links-')));
    fs.mkdirSync(path.join(top, 'published'));
    fs.mkdirSync(path.join(top, 'private'));
    fs.writeFileSync(path.join(top, 'published', 'Harbour cranes.md'), '# Harbour cranes and tides\n\nThe made-up harbour of Quillmouth has seventeen cranes, and each waits for the tide.\n');
    fs.writeFileSync(path.join(top, 'private', 'Crane diary.md'), 'A private diary note about cranes: the foreman is called Osric Vantongeren.\n');
    try {
      const r = await passage(agent, 'use a backlink to my essay on harbour cranes and explain, from the essay itself, how many cranes the harbour has; one or two sentences',
        { catalogue: catalogueAt(top), caps: 'web+notes', roots: [top] });
      assert.match(r.text, /seventeen|17/i, 'it read the post in full');
      assert.deepEqual([...new Set(wikilinks(r.text))], ['Harbour cranes']);
      assert.ok(!/Crane diary/i.test(r.text), 'the private note is never linked or named as a link');
      assert.ok(r.links.kept >= 1 && r.links.reduced === 0, JSON.stringify(r.links));
      assert.ok(['notes', 'both'].includes(r.used), `used ${r.used}`);
      assert.deepEqual(fs.readdirSync(top).sort(), ['private', 'published'], 'nothing was written');
    } finally { fs.rmSync(top, { recursive: true, force: true }); }
  });
}

// A CATALOGUE OF THE SIZE OF A REAL SITE: about 120 made-up notes, most of them pages that are no Blygger item; the one asked for is
// a page, old, and near the end of the list.
const SUBJECTS = ['canal locks', 'salt pans', 'rope walks', 'signal towers', 'dry docks', 'ice houses', 'toll bridges', 'lime kilns', 'net lofts', 'pilot boats',
  'grain silos', 'buoy tenders', 'sluice gates', 'chain ferries', 'fog horns', 'slipways', 'coal staithes', 'tide tables', 'breakwaters', 'customs sheds'];
const ANGLES = ['a short history of', 'what I got wrong about', 'notes on', 'the economics of', 'why nobody maintains', 'a walk around'];
const BIG = SUBJECTS.flatMap((subject, i) => ANGLES.map((angle, j) => {
  const n = i * ANGLES.length + j;
  const blyg = n % 6 === 0;
  return { name: `${angle} ${subject}`.replace(/^./, c => c.toUpperCase()), kind: blyg ? 'blyg' : 'page', ...(blyg ? { id: `0123456789abcdefghjkmn${String(n).padStart(4, '0').replace(/[0-9]/g, d => 'abcdefghjk'[d])}` } : {}),
    title: `${angle} ${subject}`.replace(/^./, c => c.toUpperCase()), date: `20${String(25 - Math.floor(n / 12)).padStart(2, '0')}-0${(n % 9) + 1}-1${n % 9}`, tags: ['essays'],
    excerpt: `This made-up essay is ${angle} ${subject}, with enough opening words to look like the start of a real piece of writing about them and their keepers.` };
}));
BIG.splice(113, 0, { name: 'Tidal mills', kind: 'page', title: 'Tidal mills of the estuary', date: '2016-03-02', tags: ['essays'],
  excerpt: 'A mill that grinds twice a day, when the pond the tide filled is let out again through the wheel.' });
for (const agent of ['claude', 'codex']) {
  test(`REAL ${agent}: with about 120 notes in the catalogue, it links to the one page that fits, by its exact name`, { skip, timeout: 240000 }, async () => {
    const catalogue = { ...L.validateCatalogue(JSON.stringify({ posts: BIG })), top: '' };
    assert.equal(catalogue.posts.length, 121);
    const given = L.promptCatalogue(catalogue, { caps: 'web' });
    console.log(`catalogue in the prompt: ${given.posts.length} notes, ${Buffer.byteLength(JSON.stringify(given.posts))} bytes, first words cut to ${given.excerpt}`);
    assert.equal(given.posts.length, 121, 'every note is offered');
    const r = await passage(agent, 'use a backlink to my essay on tidal mills to explain this, in two sentences', { catalogue });
    assert.deepEqual([...new Set(wikilinks(r.text))], ['Tidal mills']);
    assert.ok(r.links.kept >= 1 && r.links.reduced === 0, JSON.stringify(r.links));
  });
}

test('REAL codex: a web search works inside the wrapper', { skip, timeout: 200000 }, async () => {
  const t = Date.now();
  const r = await O.runOneShot('codex', 'Search the web for the capital of Iceland and answer in one short sentence.', { caps: 'web', effort: 'low' });
  console.log(`codex web search ${Date.now() - t} ms: ${JSON.stringify(r.text || r.error)} ${JSON.stringify(r.sources && r.sources.web)}`);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.sources.web.some(s => s.startsWith('search: ')), JSON.stringify(r.sources));
});
