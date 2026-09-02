// mentions.test.mjs — unit tests for the @-handle autocomplete in
// frontends/plugin/extension/drawer.js: which token the caret is sitting in
// (mentionToken) and which handles that token offers (mentionCandidates).
//
//   node frontends/plugin/test/mentions.test.mjs
//
// Both are pure — no DOM, no drawer instance — which is why the menu's
// behaviour can be pinned down here instead of only in the browser harness.
// No framework. Exit code is the number of failures.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const D = require(path.join(here, '..', 'extension', 'drawer.js'));
// the routing pin at the foot of this file imports chat.mjs, which pulls in
// store.mjs, which resolves a workspace at import time — a throwaway keeps even
// an accidental write out of the live .botference
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-mentions-'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, 'got  ' + g + '\n      want ' + w);
}

// `text|` marks where the caret is, so every case below reads as the thing a
// person actually did
function at(marked) {
  const caret = marked.indexOf('|');
  return D.mentionToken(marked.replace('|', ''), caret < 0 ? marked.length : caret);
}
const AGENTS = ['claude', 'codex'];

// ---- 1. the token under the caret ------------------------------------------
{
  eq('a bare @ opens it', at('@|'), { start: 0, end: 1, query: '' });
  eq('…and typing filters it', at('@cl|'), { start: 0, end: 3, query: 'cl' });
  eq('a mention mid-sentence counts — mentions work anywhere',
    at('as I said, @co|'), { start: 11, end: 14, query: 'co' });
  eq('the caret has to be IN the token', at('@claude | and then'), null);
  eq('…and only the part before it is the query',
    at('@cla|ude'), { start: 0, end: 4, query: 'cla' });
  eq('after a newline is still the start of a word',
    at('first line\n@|'), { start: 11, end: 12, query: '' });
  eq('after an opening bracket too', at('(@cod|'), { start: 1, end: 5, query: 'cod' });

  // the whole point of the word-boundary rule: things people type on purpose
  eq('an email address is not a mention', at('write to ada@exa|'), null);
  eq('…however far into it the caret is', at('ada@e|xample.com'), null);
  eq('a handle glued to a word is not one either', at('re@ply|'), null);
  eq('no @ at all', at('claude|'), null);
  eq('an @ the caret has moved away from', at('@claude and then some|'), null);

  // degenerate input must not throw
  eq('empty text', D.mentionToken('', 0), null);
  eq('null text', D.mentionToken(null, 0), null);
  eq('a caret past the end is clamped', D.mentionToken('@co', 99), { start: 0, end: 3, query: 'co' });
  eq('a negative caret is clamped', D.mentionToken('@co', -5), null);
}

// ---- 2. which handles are offered ------------------------------------------
{
  eq('everything, plus @all, before anything is typed',
    D.mentionCandidates(AGENTS, ''), ['claude', 'codex', 'all']);
  eq('a prefix filters', D.mentionCandidates(AGENTS, 'c'), ['claude', 'codex']);
  eq('…case-insensitively', D.mentionCandidates(AGENTS, 'CO'), ['codex']);
  eq('…down to one', D.mentionCandidates(AGENTS, 'cod'), ['codex']);
  eq('@all is reachable by typing it', D.mentionCandidates(AGENTS, 'al'), ['all']);
  eq('nothing matches: the menu has nothing to show and closes',
    D.mentionCandidates(AGENTS, 'zzz'), []);

  // the agents are never hardcoded — whatever the companion names is what the
  // menu offers, and @all is the only constant
  eq('an unfamiliar roster is offered as it is',
    D.mentionCandidates(['gemini', 'llama'], ''), ['gemini', 'llama', 'all']);
  eq('no agents known at all still offers @all',
    D.mentionCandidates([], ''), ['all']);
  eq('null roster', D.mentionCandidates(null, ''), ['all']);
  eq('a roster that already contains "all" does not repeat it',
    D.mentionCandidates(['claude', 'all'], ''), ['claude', 'all']);
  eq('blank entries are dropped', D.mentionCandidates(['claude', '', null], ''), ['claude', 'all']);
  eq('handles are matched in lower case', D.mentionCandidates(['Claude'], 'c'), ['claude']);
}

// ---- 3. completing writes over exactly the token ---------------------------
{
  // what the drawer does with the two together: replace [start, end) with the
  // finished handle and a trailing space
  const complete = (marked, handle) => {
    const caret = marked.indexOf('|');
    const text = marked.replace('|', '');
    const t = D.mentionToken(text, caret);
    return text.slice(0, t.start) + '@' + handle + ' ' + text.slice(t.end);
  };
  eq('a half-typed handle is completed in place',
    complete('@cl|', 'claude'), '@claude ');
  eq('…mid-sentence, leaving the rest of the line alone',
    complete('so @co| — what do you think?', 'codex'),
    'so @codex  — what do you think?');
  eq('…and a bare @ completes too', complete('@|', 'all'), '@all ');
}

// ---- the routing rule, in all three runtimes --------------------------------
//
// `@claude`/`@codex`/`@all` decides who a message is for, and the rule is
// written three times: chat.routePrefix in the companion, routeWordOf in the
// drawer, routeWordOf in reader.js for the phone. Three runtimes justify three
// copies — the extension cannot import from the server and the phone's script
// has no build step — but unlike the "▸ more" trio and the tagHue pair, nothing
// held them together, and the contracts had already begun to disagree (the
// author test `isBot` had a word boundary in two of the three, so "claudette"
// was a bot to the drawer alone).
//
// So: one table of messages, run through the drawer's copy and the companion's,
// and reader.js's source pinned against the drawer's.
{
  const chat = await import(path.join(here, '..', 'chat.mjs'));

  // what each copy must say about the same sentence
  const rows = [
    ['@claude what is this?', 'claude'],
    ['@codex you have a look', 'codex'],
    ['@all — both of you', 'all'],
    ['@claude @codex both of you', 'all'],
    ['@codex @claude, order does not matter', 'all'],
    ['@claude @claude twice is once', 'claude'],
    ['a note to myself', ''],
    ['', ''],
    ['mail me at me@claudeco.example', ''],       // \b: not a tag
    ['@claudette is a person', ''],
    ['ask @Claude, capitalised', 'claude'],
    ['mid-sentence @codex still counts', 'codex'],
  ];
  for (const [text, want] of rows) {
    eq('route: drawer — ' + JSON.stringify(text), D.routeWordOf(text), want);
    eq('route: companion — ' + JSON.stringify(text),
      chat.routePrefix(text), want ? '@' + want + ' ' : '');
  }

  // …and the phone's copy is the drawer's. `var` and the indexed loop are
  // reader.js's ES5 house style, which is the only licensed difference: the
  // comparison normalises the declaration keyword and the whitespace, and
  // nothing else.
  const blockOf = file => {
    const src = fs.readFileSync(file, 'utf8');
    const a = src.indexOf('⟦route⟧ begin'), b = src.indexOf('⟦route⟧ end');
    if (a < 0 || b < 0) return null;
    return src.slice(src.indexOf('function routeWordOf', a), b)
      .replace(/\b(?:const|let|var)\b/g, 'X')
      .replace(/\s+/g, ' ').trim();
  };
  const drawer = blockOf(path.join(here, '..', 'extension', 'drawer.js'));
  const reader = blockOf(path.join(here, '..', 'reader.js'));
  ok('route: both files carry the sentinelled block', !!drawer && !!reader);
  ok('route: reader.js’s copy is the drawer’s, statement for statement',
    drawer === reader,
    'drawer  ' + drawer + '\n      reader  ' + reader
    + '\n      they have drifted — fix the copy, do not fix the test');

  // the author test the routing hangs off, which is the one that HAD drifted
  ok('route: “claudette” is nobody’s bot, in either runtime',
    D.isBot('claudette') === false && chat.isBotAuthor('claudette') === false);
  ok('route: …and claude still is', D.isBot('claude') && chat.isBotAuthor('claude (sonnet)'));
}

// ---- the kind names, in both runtimes ---------------------------------------
// The drawer names a document's kind and so does the phone's reading room, and
// the two had drifted: views.mjs derived its singular from its plural
// (`PDFs` → `pdf`) where the drawer had always written `PDF`. Same document,
// two names, depending which screen you were on.
{
  const views = await import(path.join(here, '..', 'views.mjs'));
  eq('kinds: the singular names agree', views.KIND_NAME, D.KIND_NAME);
  eq('kinds: …and the plural ones, in the same order',
    D.KINDS.map(([k, label]) => [k, label]),
    [['article', 'Articles'], ['pdf', 'PDFs'], ['gdocs', 'Docs']]);
}

fs.rmSync(process.env.BOTFERENCE_PROJECT_ROOT, { recursive: true, force: true });

console.log(`\nmentions: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail);
