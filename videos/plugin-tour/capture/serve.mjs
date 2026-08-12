// A static file server rooted at frontends/plugin — NOT at test/, because
// test/harness.html loads ../extension/* and a docroot one level too deep
// leaves the real extension unreachable and the harness silently inert.
//
// It also owns the only edits this project makes to the plugin: the harness is
// rewritten IN FLIGHT, never on disk. `patchHarness` below is the complete list
// of differences between what the repo holds and what the camera sees.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTICLE_HTML, ARTICLE_CSS, FOCUS_QUOTE, GREEN_QUOTE } from './page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(HERE, '../../../frontends/plugin');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.wasm': 'application/wasm', '.map': 'application/json',
};

// ---------------------------------------------------------------------------
// The harness patches.
//
// Each one is a thing the shipped fixtures cannot stage, rather than a thing
// about the product we would like to be different. Every patch asserts its own
// anchor text, so a harness edit upstream breaks the capture loudly instead of
// filming the wrong page. Nothing here touches extension/ — drawer.js,
// content.js, anchor.js and adapters.js are read off disk unmodified, which is
// what makes every control in the film the shipped one.
// ---------------------------------------------------------------------------
function replaceOnce(src, find, repl, label) {
  const at = src.indexOf(find);
  if (at < 0) throw new Error(`harness patch "${label}" found no anchor — harness.html changed`);
  if (src.indexOf(find, at + 1) >= 0) throw new Error(`harness patch "${label}" anchor is not unique`);
  return src.slice(0, at) + repl + src.slice(at + find.length);
}

/** Replace everything between (and including) two unique markers. */
function replaceRange(src, open, close, repl, label) {
  const a = src.indexOf(open);
  if (a < 0) throw new Error(`harness patch "${label}" found no opening anchor`);
  if (src.indexOf(open, a + 1) >= 0) throw new Error(`harness patch "${label}" opening anchor is not unique`);
  const b = src.indexOf(close, a);
  if (b < 0) throw new Error(`harness patch "${label}" found no closing anchor`);
  return src.slice(0, a) + repl + src.slice(b + close.length);
}

const SNIPPET = fs.readFileSync(path.join(HERE, 'fixtures/snippet.py'), 'utf8').trim();

// ---- what the agents say --------------------------------------------------
// Fixture text either way — the shipped harness carries its own, about a
// different article. These are this film's, and they obey the shipped system
// prompt (frontends/plugin/bridge-system-prompt.md): short, on the quote, and
// no bot ever @-tags the other one.
const CLAUDE_REPLY = [
  'Yes — same shape, shorter fuse.',
  '',
  'An arms race is this lake with two farms: each side’s build is the correct answer to the '
  + 'other’s, neither can stop first, and the equilibrium they reach together is worse than '
  + 'the treaty neither can enforce.',
  '',
  'The difference is the exit. Fisheries get quotas because the players are few and countable; '
  + 'an arms race has to invent its own referee first.',
].join('\n');

const CODEX_REPLY = [
  'Replicator dynamics is the mechanism you are asking about — defectors grow at whatever '
  + 'edge their payoff has over the field:',
  '',
  '```python',
  SNIPPET,
  '```',
  '',
  'The curve is a logistic. The payoff edge only moves the knee.',
].join('\n');

// The written summary the agents send back when the filed card asks for one.
const FOCUS_SUMMARY =
  'The comment asked whether the lake and an arms race are the same trap. Claude answered '
  + 'that they are — the same defection payoff with no enforceable promise underneath it — '
  + 'and differ only in whether a referee already exists. Codex plotted the spread to show '
  + 'how fast the equilibrium tips once it starts. The outcome was that the paragraph stands '
  + 'and the plot stays in the thread.';

export function patchHarness(src, { plotDataUrl }) {
  let out = src;

  // (1) The page. The film is a reading tool being used on something worth
  //     reading, so it is filmed on a recreation of the Slate Star Codex
  //     reading experience for "Meditations on Moloch" — the masthead, the
  //     cream paper and the serif column. The PROSE is ours: a paraphrase of
  //     the essay's argument with one eight-word quotation, and no author
  //     byline, because none of these sentences are anybody's but this
  //     repository's. See capture/page.mjs.
  out = replaceRange(out, '<article>', '</article>', ARTICLE_HTML, 'the page');
  out = replaceOnce(out, '</style>', ARTICLE_CSS + '\n</style>', 'the page styles');
  out = replaceOnce(out,
    "<title>Botference Web Annotator — harness</title>",
    "<title>Meditations on Moloch | Slate Star Codex</title>",
    'the tab title');

  // (2) The figure a run hands back. The harness ships a 260x150 line chart
  //     drawn by hand; we swap in the PNG that capture/fixtures/snippet.py
  //     actually produced under matplotlib, so the plot on screen is the
  //     output of the code on screen.
  out = replaceOnce(out,
    "const TINY_PNG = 'data:image/png;base64,'",
    `const TINY_PNG = ${JSON.stringify(plotDataUrl)}; const TINY_PNG_UNUSED = 'data:image/png;base64,'`,
    'real matplotlib figure');

  // (3) One figure per run rather than two, and no invented stdout. The harness
  //     prints "drew the chart" for a plotting run; the snippet on screen ends
  //     in plt.show() and prints nothing at all, so the film would be showing
  //     output its own code does not produce. Silence plus a figure is both the
  //     truthful result and the more interesting one — it is the case the
  //     drawer's "✓ ran · 214 ms" status line exists to make visible.
  out = replaceOnce(out,
    "if (/plot|savefig/.test(code)) return { ...base, stdout: 'drew the chart\\n', figures: ['figure-01.png', 'figure-02.png'] };",
    "if (/plot|savefig/.test(code)) return { ...base, stdout: '', figures: ['figure-01.png'] };",
    'single figure, honest stdout');

  // (4) The record. EXACTLY ONE thread exists before the camera rolls: a
  //     resolved one near the top, so a viewer has seen sage green before the
  //     film asks them to notice a highlight turning it. Everything else on
  //     screen is made during the take. The page chat is empty — this cut is
  //     about the margin, and an unopened tab with a conversation already in it
  //     is a second story.
  out = replaceRange(out, '  threads: [\n    { id: \'t-1754500000-a1b2\',', '  ],\n};',
    `  threads: [
    { id: 't-1754500000-a1b2',
      quote: ${JSON.stringify(GREEN_QUOTE)},
      prefix: 'drinks the same clean water and keeps the money.', suffix: '',
      orphaned: false,
      resolved: true, resolved_at: iso(52), resolved_by: 'angadh',
      summary_by: 'claude',
      summary: 'The comment asked whether the arithmetic really is common knowledge, or '
        + 'whether the farms are only assumed to have worked it out. Claude answered that the '
        + 'assumption is doing real work and is worth stating: the trap needs everyone to know '
        + 'that everyone knows. The outcome was that the sentence stays, with "and every owner '
        + 'knows the others can do it too" carrying the load.',
      msgs: [
        { author: 'angadh', ts: iso(64), text: '@claude does this need the "everyone knows that everyone knows" step spelled out?' },
        { author: 'claude', ts: iso(63), text: 'It does, and the sentence already carries it — the second clause is the common-knowledge condition in plain words. Without it the farms are merely selfish; with it they are trapped.' },
      ] },
  ],
  page_chat: [],
};`,
    'one resolved thread, nothing else');

  // (5) A pause before the first token. The shipped fake companion starts
  //     streaming on the same tick as turn-start, so the drawer's working chip
  //     — the spinning per-agent rings that say WHO is thinking — exists for
  //     about one frame. A real turn takes seconds to say its first word. 2.4s
  //     is the low end of what a woken bridge actually costs, and it is the
  //     only timing in the film that is dialled rather than measured.
  out = replaceOnce(out,
    "  const chunks = body.match(/.{1,34}(\\s|$)/g) || [body];\n  let i = 0;\n  const tick = setInterval(() => {",
    "  const chunks = body.match(/.{1,34}(\\s|$)/g) || [body];\n  let i = 0;\n  let tick = null;\n  const pump = () => { tick = setInterval(() => {",
    'thinking dial has time to exist');
  out = replaceOnce(out,
    "    ev({ type: 'chat', kind: 'stream', model, stream_id: streamId, text: chunks[i++] });\n  }, 90);",
    "    ev({ type: 'chat', kind: 'stream', model, stream_id: streamId, text: chunks[i++] });\n  }, 45); };\n  setTimeout(pump, 2400);",
    'stream rate');

  // (5b) …and the same for the written summary. The shipped mock answers in
  //      60ms, so the card's own "summarizing…" state — the placeholder digest,
  //      in italics, with the agents still working on the real paragraph — is
  //      never on screen at all. The real job is a queued agent turn.
  out = replaceOnce(out,
    "      toContent({ t: 'ws', ev: { type: 'page', url: PAGE_URL } });\n    }, 60);",
    "      toContent({ t: 'ws', ev: { type: 'page', url: PAGE_URL } });\n    }, 1400);",
    'the summary takes a turn to write');

  // (6) The two answers, and no tool rows. The shipped CANNED_REPLY and
  //     CANNED_MD are about the harness's own football article; these are about
  //     this page. The tool-activity rows go because a 35-second film has no
  //     room to explain a collapsed disclosure it never opens.
  out = replaceOnce(out,
    "const CANNED_REPLY =\n  'Two things stand out. First, the piece never tests its own claim",
    `const CANNED_REPLY = ${JSON.stringify(CLAUDE_REPLY)};
const CANNED_REPLY_UNUSED =
  'Two things stand out. First, the piece never tests its own claim`,
    'claude answers this page');
  out = replaceOnce(out,
    "const CANNED_MD =\n  'Sources, in order:\\n\\n' +",
    `const CANNED_MD = ${JSON.stringify(CODEX_REPLY)};
const CANNED_MD_UNUSED =
  'Sources, in order:\\n\\n' +`,
    'codex answers with a runnable cell');
  out = replaceOnce(out,
    "      if (model === 'codex') post({ author: model, ts: now(), kind: 'tools', text: TOOLS_A });",
    "      /* tool rows omitted for the film */",
    'no tool rows before the answer');
  out = replaceOnce(out,
    "      if (model === 'codex') post({ author: model, ts: now(), kind: 'tools', text: TOOLS_B });",
    "      /* tool rows omitted for the film */",
    'no tool rows after the answer');

  // (7) The written summary the agents send back when a filed card asks for
  //     one. The harness's belongs to a different fixture article; on screen,
  //     in this film, it would simply be about the wrong thing. Same
  //     three-sentence shape, this page's argument.
  out = replaceOnce(out,
    "      t.summary = 'The comment asked whether the sleeper is really the point. '\n        + 'Claude answered that it is, on that route. The outcome was that the '\n        + 'paragraph stands as written.';",
    `      t.summary = ${JSON.stringify(FOCUS_SUMMARY)};`,
    'on-topic written summary');

  // (8) The page's identity. The record is filed under the essay this page
  //     recreates, which is also where the export note's `url:` line points —
  //     a reader who follows it lands on the real thing rather than on a
  //     fixture hostname.
  out = replaceOnce(out,
    "  : 'https://example.com/sport/the-quiet-machine';",
    "  : 'https://slatestarcodex.com/2014/07/30/meditations-on-moloch/';",
    'page url');
  out = replaceOnce(out,
    "  title: 'The Quiet Machine',\n  site: 'example.com',",
    "  title: 'Meditations on Moloch',\n  site: 'slatestarcodex.com',",
    'page title and site');

  return out;
}

export { FOCUS_QUOTE, GREEN_QUOTE };

export function startServer({ plotDataUrl }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PLUGIN_DIR, rel);
    if (!file.startsWith(PLUGIN_DIR)) { res.writeHead(403).end('no'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      const ext = path.extname(file).toLowerCase();
      let body = buf;
      if (rel === 'test/harness.html') body = Buffer.from(patchHarness(buf.toString('utf8'), { plotDataUrl }), 'utf8');
      res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': body.length });
      res.end(body);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
