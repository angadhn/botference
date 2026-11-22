// studio-paste.test.mjs — the 'studio' export target: markdown for Blygger
// Studio's compose screen.
//
//   node frontends/plugin/test/studio-paste.test.mjs
//
// Nothing here talks to a Studio. The grammar it is held to is Studio's own,
// read from its source (blygger/blygger-studio, src/grammar.ts, src/tk.ts,
// src/comments.ts, src/directives.ts, src/code-ranges.ts); `scan` below is a
// small re-statement of those scanners (their regular expressions, copied), so
// a note that passes it is one those scanners read as intended.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-studio-'));
const { renderStudioPaste, renderTarget, studioProse, studioLeftOut, EXPORT_TARGETS, exportTargetOf, noteToSelf } =
  await import('../studio-paste.mjs');
const { renderNote } = await import('../export.mjs');
const F = await import('./fixtures/export-pages.mjs');
const { me, bot, stamp, webPage, blygPage, gapped, P1, P2, POST_ID, POST_PAGE, ORIGIN } = F;

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + String(detail).slice(0, 900) : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));

const CFG = { author: F.READER };
const POST = { id: POST_ID, version: 2, text: `${P1} ${P2}` };
const studio = (page, cfg = CFG, mode = 'all', opts = { post: POST }) => renderStudioPaste(page, cfg, mode, opts);

// ---- Studio's scanners, restated ---------------------------------------------
// ID_ALPHABET is the 26-character Crockford-style set; DIRECTIVE_LINE is
// grammar.ts's `^\s*!\[\[(id)(?:[ \t]*\|((?:(?!\]\])[^\n])*))?\]\]\s*$`.
const ID = '[0-9abcdefghjkmnpqrstvwxyz]{26}';
const DIRECTIVE_LINE = new RegExp(`^\\s*!\\[\\[(${ID})(?:[ \\t]*\\|((?:(?!\\]\\])[^\\n])*))?\\]\\]\\s*$`);
const LINK_INLINE = new RegExp(`(?<!!)\\[\\[(${ID})(?:[ \\t]*\\|((?:(?!\\]\\])[^\\n])*))?\\]\\]`, 'g');
// code: fenced blocks and same-line backtick spans (code-ranges.ts, simplified)
function withoutCode(text) {
  let fence = false;
  return text.split('\n').map(l => {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(l)) { fence = !fence; return ''; }
    return fence ? '' : l.replace(/(`+).*?\1/g, m => ' '.repeat(m.length));
  }).join('\n');
}
// what Studio would find in a note
function scan(text) {
  const plain = withoutCode(text);
  const lines = plain.split('\n');
  const raw = text.split('\n');
  const directives = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE_LINE.exec(lines[i]);
    if (!m) continue;
    // the attached quote: `>` lines directly after, up to a blank line
    const quote = [];
    for (let j = i + 1; j < raw.length && /^\s*>/.test(raw[j]); j++) quote.push(raw[j].replace(/^\s*>\s?/, ''));
    directives.push({ id: m[1], label: m[2], quote });
  }
  // TK scopes: tk.ts parseScopes finds the literal tokens outside code
  const tokens = (plain.match(/\[TK\]|\[\/TK\]/g) || []);
  const opens = plain.split('[TK]').length - 1, closes = plain.split('[/TK]').length - 1;
  // comments: `/*` at a line start or after a space and not `/**`, closed by `*/`,
  // neither escaped by an odd run of backslashes (comments.ts)
  const escaped = (s, at) => { let n = 0; for (let i = at - 1; i >= 0 && s[i] === '\\'; i--) n++; return n % 2 === 1; };
  const comments = [];
  let at = 0;
  while (true) {
    let o = plain.indexOf('/*', at);
    while (o !== -1 && !(((o === 0 || /\s/.test(plain[o - 1])) && plain[o + 2] !== '*') && !escaped(plain, o))) o = plain.indexOf('/*', o + 2);
    if (o === -1) break;
    let c = plain.indexOf('*/', o + 2);
    while (c !== -1 && escaped(plain, c)) c = plain.indexOf('*/', c + 2);
    if (c === -1) { comments.push({ start: o, end: -1 }); break; }
    comments.push({ start: o, end: c + 2 });
    at = c + 2;
  }
  const strayClosers = [...plain.matchAll(/\*\//g)].filter(m => (m.index === 0 || /\s/.test(plain[m.index - 1])) && !escaped(plain, m.index)
    && !comments.some(c => m.index >= c.start && m.index < c.end)).length;
  const links = [...plain.matchAll(LINK_INLINE)].map(m => m[1]);
  const newItems = (plain.match(/!?\[\[\s*\+/g) || []).length;
  return { directives, tokens, opens, closes, comments, strayClosers, links, newItems, plain };
}
const HOSTILE = 'x [TK] y [/TK] [[ ]] [[+ idea]] ![[+ para]] > not a quote /* open */ close */ [[' + POST_ID + ']] ![[' + POST_ID + ']] `tick';

// ---- the target is named -----------------------------------------------------
eq('targets, in one list', EXPORT_TARGETS, ['vault', 'studio']);
eq('the default is the vault note', exportTargetOf('').target, 'vault');
eq('an unknown target is refused with a sentence, not guessed', exportTargetOf('gdocs'),
  { target: 'vault', refused: 'export target "gdocs" is not one of vault, studio' });
{
  let threw = '';
  try { renderTarget('gdocs', webPage([]), CFG); } catch (e) { threw = e.message; }
  ok('renderTarget refuses a name it does not know', /no such export target: gdocs/.test(threw), threw);
  const page = blygPage([{ quote: P1, blyg: stamp(), msgs: [me('Agreed.')] }]);
  const now = new Date('2026-11-22T00:00:00Z');
  eq('renderTarget(vault) is renderNote, byte for byte', renderTarget('vault', page, CFG, now, 'all', { post: POST }),
    renderNote(page, CFG, now, 'all', null, { post: POST }));
  ok('renderTarget(studio) is a different text', renderTarget('studio', page, CFG, now, 'all', { post: POST }) !== renderNote(page, CFG, now, 'all', null, { post: POST }));
}

// ---- a partial quote of a post, with its version ---------------------------------
{
  const out = studio(blygPage([{ quote: P1, blyg: stamp(), msgs: [] }]));
  eq('the directive, and the passage directly under it with no blank line', out.split('\n\n').pop(),
    `![[${POST_ID} | On Scheduling]]\n> ${P1}\n`);
  ok('no front matter, no title, no HTML comment', !/^---/m.test(out) && !/^# /m.test(out) && !out.includes('<!--'), out);
  ok('the version Discuss checked is named, in a note to yourself', new RegExp(`/\\* Discuss checked the quotes below word for word against version 2 of ${POST_PAGE.replace(/[./]/g, '\\$&')}`).test(out), out);
  ok('…and never in the directive: Studio has no version syntax (an @vN line is refused at publish)', !/@v\d/.test(out) && !out.includes(`${POST_ID}@`), out);
  const s = scan(out);
  eq('Studio finds exactly one directive, with the passage as its quote', s.directives.map(d => [d.id, d.label.trim(), d.quote]), [[POST_ID, 'On Scheduling', [P1]]]);
  eq('…one comment, closed, no stray closer, no TK, no new item', [s.comments.length, s.comments.every(c => c.end > 0), s.strayClosers, s.tokens.length, s.newItems], [1, true, 0, 0, 0]);
  const money = studio(blygPage([{ quote: 'costs $5 and $10 each', blyg: stamp(), msgs: [] }, { quote: 'web $x$ words', msgs: [] }]));
  ok('a $ in a passage or a web quote is written \\$, so two of them are never a formula', money.includes('> costs \\$5 and \\$10 each') && money.includes('> web \\$x\\$ words'), money);
  const two = studio(blygPage([{ quote: `${P1}\n\n${P2}`, blyg: stamp(), msgs: [] }]));
  ok('a two-paragraph passage has an empty > line between paragraphs', two.includes(`> ${P1}\n>\n> ${P2}`), two);
  const miss = studio(blygPage([{ quote: P2, blyg: stamp({ passage: { match: false, nearest: P1 } }), msgs: [] }]));
  ok('a passage that is not word for word is never a directive', scan(miss).directives.length === 0 && miss.includes(`> ${P2}`), miss);
  ok('…and the reason is a private note, with the nearest exact passage', /\/\* Not quoted by reference: .*nearest exact passage/.test(miss), miss);
  const older = studio(blygPage([{ quote: P1, blyg: stamp({ version: 1 }), msgs: [] }]), CFG, 'all', { post: { ...POST, text: 'nothing alike' } });
  ok('a highlight made on an older version that the current one lost is a plain quote, with the reason', scan(older).directives.length === 0 && /version 1 of the post and is not in version 2/.test(older), older);
}

// ---- a whole post --------------------------------------------------------------
{
  const out = studio(blygPage([], [], { export_response: 'response' }));
  const s = scan(out);
  eq('a response with no highlights quotes the whole post: a bare directive', s.directives.map(d => [d.id, d.quote]), [[POST_ID, []]]);
  ok('…and not a stub of any other kind of markup', !/blyg_stub_of|stub_of/.test(out), out);
  eq('a note that is not a response never quotes the whole post by itself (that would repost it)',
    scan(studio(blygPage([], [me('chat')]))).directives.length, 0);
}

// ---- a quote from an ordinary page ----------------------------------------------
{
  const out = studio(webPage([{ quote: 'a plain claim', msgs: [] }]));
  eq('a plain blockquote with the source as a link inside it', out,
    '> a plain claim\n>\n> — [A Story](https://news.example.com/story)\n');
  eq('no directive, no comment', [scan(out).directives.length, scan(out).comments.length], [0, 0]);
  const pdf = studio({ url: 'bfp-pdf://sha256/abcd', title: 'A Paper', threads: [{ quote: 'words', page: 3, msgs: [] }], page_chat: [] });
  ok('a PDF on this disk gets no link (no local address reaches the paste)', pdf === '> words\n> — p. 3\n', pdf);
  const struck = studio(webPage([{ quote: 'old', mark: 'strike', msgs: [me('why')] }]));
  ok('a strike keeps its reason above and says suggested deletion', struck.startsWith('why\n\n> ~~old~~\n> *suggested deletion*'), struck);
  const odd = studio(webPage([{ quote: 'q', msgs: [] }], [], { title: 'Notes [draft] */ /* [[+ x]]', url: 'https://x.example.com/a_(b)*c' }));
  const so = scan(odd);
  ok('a hostile title and address cannot reach the grammar', so.comments.length === 0 && so.strayClosers === 0 && so.newItems === 0 && !/\]\(https:\/\/x\.example\.com\/a_\(/.test(odd), odd);
}

// ---- the reader's words and the quote, in comment_order -----------------------------
{
  const page = () => blygPage([{ quote: P1, blyg: stamp(), msgs: [me('My opening.'), bot('An answer.'), me('My reply.')] }]);
  const first = studio(page(), { ...CFG, comment_order: 'comment-first' }).split('\n\n').filter(p => !p.startsWith('/*'));
  eq('comment-first: opening words, quote, then the rest of the thread', first.map(p => p.split('\n')[0].slice(0, 22)),
    ['My opening.', `![[${POST_ID} | On Sc`.slice(0, 22), '[TK]impyrt=An answer.[', 'My reply.']);
  const quoteFirst = studio(page(), { ...CFG, comment_order: 'quote-first' }).split('\n\n').filter(p => !p.startsWith('/*'));
  eq('quote-first: the quote, then the whole thread', quoteFirst.map(p => p.split('\n')[0].slice(0, 12)),
    [`![[${POST_ID}`.slice(0, 12), 'My opening.', '[TK]impyrt=A', 'My reply.']);
  ok('blank lines separate the reader\'s words from the quote on both sides', !/My opening\.\n!\[\[/.test(studio(page())) && !/\n> .*\nMy opening/.test(studio(page(), { ...CFG, comment_order: 'quote-first' })));
  // the reader's words end in a list: Studio's directive is line-based, and a
  // blank line separates it, so no HTML comment is needed (and none is written)
  const listy = studio(blygPage([{ quote: P1, blyg: stamp(), msgs: [me('Reasons:\n- one\n- two')] }]));
  ok('words ending in a list: a blank line, no <!-- -->', listy.includes('- two\n\n![[') && !listy.includes('<!--'), listy);
}

// ---- a response (a stub) ----------------------------------------------------------------
{
  const out = studio(blygPage([{ quote: P1, blyg: stamp(), msgs: [me('A reply.')] }], [], { export_response: 'response' }));
  ok('the first line names the post to stub, with id, address and the version read', out.startsWith(`/* STUB THIS POST: ${POST_PAGE} (id ${POST_ID}, version 2 as you read it).`), out.split('\n')[0]);
  ok('…and says plainly that Studio cannot take it from pasted text', /Studio cannot take a stub from pasted text/.test(out.split('\n')[0]));
  eq('the first line is a note to yourself, so it never publishes', [scan(out).comments[0].start, scan(out).comments.length], [0, 2]);
  const seen = studio({ ...blygPage([{ quote: P1, blyg: stamp({ version: 1 }), msgs: [] }], [], { export_response: 'response' }) }, CFG, 'all', { post: { ...POST, version: 2 } });
  ok('the version stubbed is the one the reader read, not the latest check', /version 1 as you read it/.test(seen), seen.split('\n')[0]);
  const w = studio(webPage([{ quote: 'x', msgs: [me('re')] }], [], { export_response: 'response' }));
  ok('a response to an ordinary page says so, and gives the link Studio itself prefills for a feed entry',
    w.startsWith('/* RESPONSE TO: https://news.example.com/story.') && w.includes('\n\n[A Story](https://news.example.com/story)\n\n'), w);
  const nope = studio({ url: 'bfp-pdf://sha256/abcd', title: 'P', threads: [{ quote: 'q', msgs: [] }], page_chat: [], export_response: 'response' });
  ok('a response is only written where it can name a target (not a PDF on this disk)', !/STUB|RESPONSE TO/.test(nope), nope);
  const quoteFirst = studio(blygPage([{ quote: P1, blyg: stamp(), msgs: [me('A reply.')] }], [], { export_response: 'response' }), { ...CFG, comment_order: 'quote-first' });
  eq('quote-first: the response starts with the whole post, then the passage', scan(quoteFirst).directives.map(d => d.quote.length), [0, 1]);
}

// ---- text that must not break the grammar ---------------------------------------------------
{
  const out = studio(blygPage([{ quote: `${P1} ${HOSTILE.replace(/\n/g, ' ')}`, blyg: stamp({ passage: { match: false } }),
    msgs: [me(HOSTILE), bot(HOSTILE), { author: 'guest', ts: 'g', text: HOSTILE, origin: 'review' }] },
  { quote: HOSTILE + '\n> second line', msgs: [] }], []));
  const s = scan(out);
  eq('hostile text mid-line is never a directive line', s.directives.length, 0);
  eq('no TK token outside code but the one scope the agent\'s words are in', [s.opens, s.closes], [1, 1]);
  eq('no comment opens or closes except by Discuss\'s own notes', [s.strayClosers, s.comments.every(c => c.end > 0)], [0, true]);
  ok('no [[+ or ![[+ anywhere: nothing here makes a new item', s.newItems === 0, out);
  ok('no [[id]] link from a guest\'s or a web page\'s words', !/\[\[7c9wk/.test(out.split('guest:')[1] || ''), out);
  ok('the page\'s own > lines stay inside their blockquote', /\n> > second line/.test(out), out);
  // each hazard alone, in the reader's own words
  for (const [name, text, check] of [
    ['[TK] in prose', 'a [TK] b', s2 => s2.opens === 0 && s2.closes === 0],
    ['[/TK] in prose', 'a [/TK] b', s2 => s2.closes === 0],
    ['an opened comment', 'start /* never closed', s2 => s2.comments.length === 0],
    ['a stray closer', 'a */ b', s2 => s2.strayClosers === 0],
    ['/*/ and /**/', 'a /*/ b /**/ c', s2 => s2.comments.length === 0 && s2.strayClosers === 0],
    ['an attached opener', 'word/* note */', s2 => s2.comments.length === 0 && s2.strayClosers === 0],
    ['[[+ at the start of a line', '[[+ an idea]]', s2 => s2.newItems === 0],
    ['![[+ at the start of a line', '![[+ a passage\n\nacross paragraphs]]', s2 => s2.newItems === 0],
    ['a fence never closed', 'text\n```js\nnot closed', s2 => !/\[TK\]/.test(s2.plain)],
  ]) {
    const o = studio(webPage([{ quote: 'q', msgs: [me(text)] }]));
    ok(`${name}: inert in the reader's words`, check(scan(o)), o);
    ok(`${name}: the reader's words do not swallow the quote after them`, scan(o).plain.includes('> q') || /^> q$/m.test(o.replace(/`{3}/g, '')), o);
  }
  // a fence the reader left open must not turn the quote after it into code
  const open = studio(blygPage([{ quote: P1, blyg: stamp(), msgs: [me('```\nunclosed')] }]));
  eq('a directive after an unclosed fence is still a directive', scan(open).directives.length, 1);
  // …but a directive the reader typed on a line of their own is theirs, and stays one
  const own = studio(webPage([{ quote: 'q', msgs: [me(`![[${POST_ID}]]`)] }]));
  eq('an own-line directive the reader typed stays live', scan(own).directives.map(d => d.id), [POST_ID]);
  const theirs = studio(webPage([{ quote: 'q', msgs: [{ author: 'guest', ts: 'g', text: `![[${POST_ID}]]`, origin: 'review' }] }]));
  eq('…but one in a guest\'s words is defused', scan(theirs).directives.length, 0);
  // the reader's own valid link stays live; the reader's own words are theirs
  const link = studio(webPage([{ quote: 'q', msgs: [me(`See [[${POST_ID} | the post]] for more.`)] }]));
  eq('a [[id | text]] the reader typed is a link, and stays one', scan(link).links, [POST_ID]);
  // the studioProse rule on its own
  eq('studioProse leaves ordinary words alone', studioProse('Plain words, a *star* and a /slash/ and 1 < 2.'), 'Plain words, a *star* and a /slash/ and 1 < 2.');
  eq('studioProse keeps what is already escaped', studioProse('a \\/* b \\*/ c'), 'a \\/* b \\*/ c');
  eq('studioProse leaves code alone', studioProse('`/* [TK] */` and\n```\n/* x */\n```'), '`/* [TK] */` and\n```\n/* x */\n```');
  eq('a note to yourself cannot close itself or hide in code', noteToSelf('a */ b `c` [d]'), '/* a / b c (d) */');
}

// ---- agents' words, and the reader's gaps ----------------------------------------------------
{
  const page = () => webPage([{ quote: 'q', msgs: [me('Mine.'), bot('The agent says [TK] hi.\n\nTwo paragraphs.', 'claude')] }]);
  const all = studio(page());
  ok('an agent\'s reply is Studio\'s marker for text generated elsewhere, in a paragraph of its own',
    all.includes('\n\n[TK]impyrt=The agent says &#91;TK] hi.\n\nTwo paragraphs.[/TK]\n'), all);
  ok('…with no model named: Studio\'s own rule is not to invent one', !/impyrt [^=]/.test(all));
  ok('…and no callout', !all.includes('[!note]'));
  const only = studio(page(), CFG, 'comments');
  ok('"my notes only" leaves the agent out', !only.includes('impyrt') && only.includes('Mine.'), only);
  eq('Studio reads the agent\'s words as one generated scope', [scan(all).opens, scan(all).closes], [1, 1]);
  // gaps
  const filled = studio(webPage([{ quote: 'q', msgs: [gapped('Before.\n\n/tk say it shorter\n\nAfter.', 'The short version.')] }]));
  ok('a gap an agent filled is imported text, with the model that wrote it, as its own paragraph',
    filled.startsWith('Before.\n\n[TK]impyrt claude-test-1=The short version.[/TK]\n\nAfter.\n\n> q'), filled);
  const failed = webPage([{ quote: 'q', msgs: [gapped('Before /tk(a word) after.', '', { mode: 'failed', reason: 'timed out', instruction: 'a word' })] }]);
  ok('a gap that was not filled stays Studio\'s own ungenerated form, for Studio to generate',
    studio(failed).startsWith('Before [TK] a word [/TK] after.'), studio(failed));
  const omitted = studio(webPage([{ quote: 'q', msgs: [gapped('x\n\n/tk say it shorter\n\ny', 'secret')] }]), { ...CFG, gap_export: 'omit' }, 'comments');
  ok('gap_export omit, in "my notes only", writes no agent text', !omitted.includes('secret') && omitted.includes('[TK] say it shorter [/TK]'), omitted);
  const mine = webPage([{ quote: 'q', msgs: [gapped('x\n\n/tk say it shorter\n\ny', 'my own now', { mode: 'adopted-by-reader' })] }]);
  ok('a passage the reader made theirs is plain words, undisclosed', studio(mine).startsWith('x\n\nmy own now\n\ny') && !studio(mine).includes('impyrt'), studio(mine));
  // the 'scope' form, as the owner's own site gets it, is exactly as before (golden test), and cannot be the paste
  ok('the vault note still writes Studio\'s own filled scope, not impyrt',
    renderNote(webPage([{ quote: 'q', msgs: [gapped('x\n\n/tk say it shorter\n\ny', 'T')] }]), { ...CFG, gap_style: 'studio' }, new Date(0)).includes('[TK] say it shorter [=]T[/TK]'));
}

// ---- what is not copied, and where nothing exists -------------------------------------------
{
  eq('the library has nothing to paste', studio({ url: 'bfp://library', title: 'Library', threads: [], page_chat: [me('x')] }), '');
  eq('an empty page pastes nothing', studio(webPage([])), '');
  eq('the page chat is said to be left out', studioLeftOut(webPage([], [me('q'), bot('a')]), 'all'), ['the page chat was not copied']);
  eq('…unless it is not in this export anyway', studioLeftOut(webPage([], [me('q')]), 'comments'), []);
  ok('the page chat is not in the paste', !studio(webPage([{ quote: 'q', msgs: [] }], [me('chatter')])).includes('chatter'));
  ok('an origin is not in the paste', !studio(blygPage([{ quote: P1, blyg: stamp(), msgs: [] }])).includes(`${ORIGIN}items`));
}

console.log(`studio-paste: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(fail ? 1 : 0);
