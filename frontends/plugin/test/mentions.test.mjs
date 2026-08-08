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
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

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

console.log(`\nmentions: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail);
