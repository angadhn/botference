// export.test.mjs — what each export mode puts in the Obsidian note.
//
//   node frontends/plugin/test/export.test.mjs
//
// 'all' is the export as it has always been, and one of the assertions below
// is that it is byte-for-byte unchanged. 'comments' is the reading without the
// conversation: no bot messages, and none of your own that were addressed to a
// bot — but ALWAYS the highlight, even when nothing is left underneath it.
// No framework. Exit code is the number of failures.

import { renderNote, keptMsgs, exportMode } from '../export.mjs';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + String(detail).slice(0, 600) : ''));
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));

const NOW = new Date('2026-08-08T00:00:00Z');
const CFG = { author: 'angadh' };
const me = (t, ts) => ({ author: 'angadh', ts: ts || t, text: t });
const bot = (t, who) => ({ author: who || 'claude', ts: t, text: t });
const tools = () => ({ author: 'claude', ts: 'tl', kind: 'tools', text: 'Explored\n└ Read' });

// One page with every shape in it: a thread of pure notes, a thread that is a
// conversation, a thread whose only message is a question to a bot, and a page
// chat.
const PAGE = () => ({
  url: 'https://example.org/piece',
  title: 'The Quiet Machine',
  site: 'example.org',
  threads: [
    { quote: 'the mood in the stands was flat',
      msgs: [me('This is the line the whole piece hangs on.')] },
    { quote: 'a structural failure of oversight',
      msgs: [me('@claude is this a quote or a paraphrase?'), tools(),
             bot('It reads as a paraphrase.'),
             me('Agreed. Flagging it for the desk.')] },
    { quote: 'eleven games without a win',
      msgs: [me('@codex check this against the table')] },
    { quote: 'a highlight with nothing said about it', msgs: [] },
  ],
  page_chat: [me('@claude one-line summary?'), bot('The team is deliberately unspectacular.')],
});

const note = mode => renderNote(PAGE(), CFG, NOW, mode);

// ---- 1. "everything" is exactly what it was --------------------------------
{
  // the note as it was BEFORE modes existed: renderNote(page, cfg, now)
  const legacy = renderNote(PAGE(), CFG, NOW);
  eq('an absent mode is "everything"', note('all'), legacy);
  eq('…and so is anything unrecognised', note('nonsense'), legacy);
  eq('the mode name normalises', [exportMode(), exportMode('comments'), exportMode('all'), exportMode('x')],
    ['all', 'comments', 'all', 'all']);

  const all = note('all');
  ok('everything keeps the bot answers', all.includes('It reads as a paraphrase.'), all);
  ok('…and the questions put to them', all.includes('@claude is this a quote or a paraphrase?'), all);
  ok('…and the page chat', all.includes('## Page chat'), all);
  ok('…and never the tool rows, in either mode', !all.includes('Explored'), all);
}

// ---- 2. "comments only" is the reading, not the conversation ---------------
{
  const c = note('comments');
  ok('a note of your own survives', c.includes('This is the line the whole piece hangs on.'), c);
  ok('…as does one in a thread that also had bots in it',
    c.includes('Agreed. Flagging it for the desk.'), c);
  ok('a bot answer is gone', !c.includes('It reads as a paraphrase.'), c);
  ok('a question you asked a bot is gone too',
    !c.includes('is this a quote or a paraphrase?'), c);
  ok('…including the one addressed to the other bot',
    !c.includes('check this against the table'), c);
  ok('no tool row survives either', !c.includes('Explored'), c);
  ok('the page chat is not in it at all', !c.includes('## Page chat'), c);
  ok('…nor anything that was said in it',
    !c.includes('The team is deliberately unspectacular.'), c);

  // the point of the mode: the highlights are the annotation
  for (const q of ['the mood in the stands was flat', 'a structural failure of oversight',
                   'eleven games without a win', 'a highlight with nothing said about it']) {
    ok('the highlight survives: “' + q.slice(0, 28) + '…”', c.includes('> ' + q), c);
  }
  ok('a thread whose messages all filtered away is still a quote, alone',
    /> eleven games without a win\n\n> a highlight/.test(c), c);
  ok('the frontmatter and headline are untouched',
    c.startsWith('---\nurl: https://example.org/piece') && c.includes('# The Quiet Machine'), c);
}

// ---- 3. the filter itself ---------------------------------------------------
{
  const msgs = [me('a plain note'), bot('an answer'), me('ask @codex about it'),
                tools(), bot('another answer', 'codex'), me('@all what do you think')];
  eq('everything keeps every message and drops only tool rows',
    keptMsgs(msgs, 'all').map(m => m.text),
    ['a plain note', 'an answer', 'ask @codex about it', 'another answer', '@all what do you think']);
  eq('comments keeps only what you wrote to yourself',
    keptMsgs(msgs, 'comments').map(m => m.text), ['a plain note']);

  // the mention rule is the companion's routing rule, not a second one
  eq('every mention form is caught',
    keptMsgs([me('@claude x'), me('@codex y'), me('@all z'), me('@CLAUDE Z')], 'comments'), []);
  eq('an email address is not a mention and stays',
    keptMsgs([me('write to ada@example.com')], 'comments').map(m => m.text),
    ['write to ada@example.com']);
  eq('a mention mid-sentence still counts',
    keptMsgs([me('and then @codex said no')], 'comments'), []);
  eq('a bot is a bot whatever it wrote',
    keptMsgs([bot('no mention in here at all')], 'comments'), []);
  eq('another person on a shared page is not a bot',
    keptMsgs([{ author: 'ada', ts: '1', text: 'the second paragraph is the weak one' }], 'comments')
      .map(m => m.author), ['ada']);
  eq('empty input', keptMsgs(null, 'comments'), []);
}

console.log(`\nexport: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail);
