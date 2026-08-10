// export.test.mjs — what each export mode puts in the Obsidian note.
//
//   node frontends/plugin/test/export.test.mjs
//
// 'all' is the export as it has always been, and one of the assertions below
// is that it is byte-for-byte unchanged. 'comments' is the reading without the
// conversation: no bot messages, and none of your own that were addressed to a
// bot — but ALWAYS the highlight, even when nothing is left underneath it.
// No framework. Exit code is the number of failures.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The run directories a result points at live under BOTFERENCE_PROJECT_ROOT,
// which store.mjs reads once, at import. So the workspace is made first and the
// module loaded after — a static import would have read the developer's own.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-export-'));
process.env.BOTFERENCE_PROJECT_ROOT = ROOT;
const { renderNote, keptMsgs, exportMode, exportPage, withRuns, runNote, ATTACH_DIR } =
  await import('../export.mjs');
const { pageKey, runDir } = await import('../store.mjs');

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

// ---- 4. what a code block printed goes into the note with it ---------------
// A result belongs under the fence it came out of, and its figures belong in
// the vault: a note that linked into .botference/plugin/runs/ would go blank
// the first time the block was re-run.
{
  const RUN = {
    run_id: 'r-abc123-0f0f0f', status: 'ok', exit: 0, ms: 210, python: '3.12.4',
    stdout: 'mean 3.4\n', stderr: '', figures: ['figure-01.png'],
  };
  const src = 'Here is the sum:\n\n```python\nprint(3.4)\n```\n\nand that is that.';
  const attach = () => 'attachments/k-1.png';

  const woven = withRuns(src, { 0: RUN }, attach);
  ok('the result follows the fence it came out of',
    /```\n\n```text\nmean 3\.4\n```/.test(woven), woven);
  ok('…and the prose after it survives', woven.endsWith('and that is that.'), woven);
  ok('…with the figure as a markdown image', woven.includes('![figure 1](attachments/k-1.png)'), woven);
  eq('a message with no runs is returned untouched', withRuns(src, {}, attach), src);
  eq('…and so is one whose runs field is missing', withRuns(src, null, attach), src);

  // the right fence of several
  const two = '```js\nnope\n```\n\n```python\nprint(1)\n```';
  const both = withRuns(two, { 1: RUN }, attach);
  ok('a result lands under block #1 and not block #0',
    both.indexOf('mean 3.4') > both.indexOf('print(1)'), both);
  ok('…and the untouched block is untouched', both.includes('```js\nnope\n```\n\n```python'), both);

  ok('a clean run says nothing about its exit status', !/exit/.test(runNote(RUN, attach)), runNote(RUN, attach));
  const bad = runNote({ ...RUN, status: 'error', exit: 1, stderr: 'Traceback\n' }, attach);
  ok('a failed one says what the exit was', bad.includes('**exit 1**'), bad);
  ok('…and keeps stderr, marked as stderr', /\*stderr\*/.test(bad) && bad.includes('Traceback'), bad);
  ok('a timeout says it timed out', runNote({ ...RUN, status: 'timeout' }, attach).includes('**timed out**'));
  ok('output containing a fence does not break out of its block',
    runNote({ ...RUN, stdout: '```\nnot a fence\n```' }, attach).includes('````text'));
  ok('with nowhere to copy a figure the note counts them instead of faking a link',
    runNote(RUN, null).includes('*1 figure*'), runNote(RUN, null));

  // ---- the modes ----------------------------------------------------------
  const page = () => ({
    url: 'https://example.org/piece', title: 'The Quiet Machine', site: 'example.org',
    threads: [
      { quote: 'a number worth checking',
        msgs: [{ author: 'angadh', ts: '1', text: src, runs: { 0: RUN } }] },
      { quote: 'and one the bots did',
        msgs: [{ author: 'angadh', ts: '2', text: '@claude work it out' },
               { author: 'claude', ts: '3', text: src, runs: { 0: { ...RUN, stdout: 'bot ran this\n' } } }] },
    ],
    page_chat: [],
  });
  const all = renderNote(page(), CFG, NOW, 'all', attach);
  ok('everything mode carries both results', all.includes('mean 3.4') && all.includes('bot ran this'), all);
  const comments = renderNote(page(), CFG, NOW, 'comments', attach);
  ok('comments-only keeps the result of a note you wrote yourself',
    comments.includes('mean 3.4'), comments);
  ok('…and drops the bot\'s result with the bot\'s message',
    !comments.includes('bot ran this'), comments);
  ok('…and the question you put to the bot is still gone', !comments.includes('work it out'), comments);
}

// ---- 5. the figures really are copied into the vault -----------------------
{
  const URL = 'https://example.org/plots';
  const key = pageKey(URL);
  const dir = runDir(key, 'r-abc123-0f0f0f');
  fs.mkdirSync(dir, { recursive: true });
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
  fs.writeFileSync(path.join(dir, 'figure-01.png'), PNG);
  fs.writeFileSync(path.join(dir, 'figure-02.png'), PNG);
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-vault-'));
  const cfg = { author: 'angadh', vault_path: vault, export_folder: 'Web Clippings' };
  const withFigs = figures => ({
    url: URL, title: 'Plots', site: 'example.org', page_chat: [],
    threads: [{ quote: 'the chart', msgs: [{ author: 'angadh', ts: '1',
      text: '```python\nplot()\n```',
      runs: { 0: { run_id: 'r-abc123-0f0f0f', status: 'ok', ms: 5, figures } } }] }],
  });
  const attDir = path.join(vault, 'Web Clippings', ATTACH_DIR);

  const file = exportPage(withFigs(['figure-01.png', 'figure-02.png']), cfg);
  const note = fs.readFileSync(file, 'utf8');
  ok('both figures are linked from the note',
    note.includes(`![figure 1](${ATTACH_DIR}/${key}-1.png)`) &&
    note.includes(`![figure 2](${ATTACH_DIR}/${key}-2.png)`), note);
  ok('…and both are really in the vault',
    fs.existsSync(path.join(attDir, `${key}-1.png`)) &&
    fs.existsSync(path.join(attDir, `${key}-2.png`)));
  eq('…byte for byte', fs.readFileSync(path.join(attDir, `${key}-1.png`)).toString('hex'), PNG.toString('hex'));

  // re-exporting a page that now has ONE figure must not leave the second
  // copy lying in the vault: the attachments are part of the replacement
  exportPage(withFigs(['figure-01.png']), cfg);
  ok('a re-export replaces the copies rather than accumulating them',
    fs.existsSync(path.join(attDir, `${key}-1.png`)) &&
    !fs.existsSync(path.join(attDir, `${key}-2.png`)),
    fs.readdirSync(attDir).join(', '));

  const gone = exportPage({ ...withFigs(['nothing.png']) }, cfg);
  ok('a figure whose file has been deleted is counted, never linked to nothing',
    /\*1 figure\*/.test(fs.readFileSync(gone, 'utf8')), fs.readFileSync(gone, 'utf8'));
}

console.log(`\nexport: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail);
