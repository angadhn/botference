// A static file server rooted at frontends/plugin — NOT at test/, because
// test/harness.html loads ../extension/* and a docroot one level too deep
// leaves the real extension unreachable and the harness silently inert.
//
// It has a SECOND root behind it: capture/site/, the mirror of angadh.com made
// by capture/mirror-site.mjs. Anything the plugin dir does not have is looked
// for there, under the same path the real site serves it from — so /styles.css,
// /fonts/et-book/…, /assets/imgs/WiP1/… and /favicons/… all resolve exactly as
// they do on the live site, and the page under the drawer needs no rewriting to
// be the real page.
//
// It also owns the only edits this project makes to the plugin: the harness is
// rewritten IN FLIGHT, never on disk. `patchHarness` below is the complete list
// of differences between what the repo holds and what the camera sees.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTICLE_HTML, ARTICLE_CSS, FOCUS_QUOTE, GREEN_QUOTE, SITE_DIR,
  SITE_STYLESHEETS, SITE_SCRIPTS, PAGE_URL, PAGE_TITLE, PAGE_SITE,
} from './page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(HERE, '../../../frontends/plugin');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
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
//
// The ARITHMETIC in Claude's answer is real and checkable, which is the whole
// reason this passage was chosen. Artificial gravity is w^2 r; the post's wheel
// is 75 m across, so r = 37.5 m:
//     2 rpm -> 1.65 m/s^2 = 0.17 g   (the Moon, 0.17 g)
//     3 rpm -> 3.70 m/s^2 = 0.38 g   (Mars, 0.38 g — not the Moon)
//     5 rpm -> 10.3 m/s^2 = 1.05 g   (Earth-like: the post is right here)
// A margin comment that catches a real slip in a real sentence is the strongest
// case the product has, and it is the case this film happens to have.
const CLAUDE_REPLY = [
  'Not quite — that one is Mars.',
  '',
  'Artificial gravity is ω²r, and a 75 m wheel gives r = 37.5 m:',
  '',
  '- 5 rpm → 10.3 m/s² = 1.05 g. Earth-like, as you have it.',
  '- 3 rpm → 3.70 m/s² = 0.38 g, which is Mars (0.38 g), not the Moon (0.17 g).',
  '',
  'Lunar gravity on this wheel wants about 2 rpm — still well inside the comfort '
  + 'range you link to, so the design survives; it is the label that slips.',
].join('\n');

const CODEX_REPLY = [
  'Here is ω²r swept over radius, with the three rates and the Moon/Mars/Earth '
  + 'levels drawn in, and your wheel marked:',
  '',
  '```python',
  SNIPPET,
  '```',
  '',
  'The 37.5 m line crosses 3 rpm at 0.38 g and 5 rpm just over 1 g.',
].join('\n');

// The written summary the agents send back when the filed card asks for one.
const FOCUS_SUMMARY =
  'The comment asked whether 3 rpm on a 75 metre wheel really gives lunar gravity. '
  + 'Claude worked ω²r at r = 37.5 m and answered that it does not: 3 rpm lands on '
  + '0.38 g, which is Mars, while the Moon wants about 2 rpm — the 5 rpm Earth-like '
  + 'figure is right. Codex plotted gravity against radius for all three rates with '
  + 'the wheel marked. The outcome was that the sentence needs Mars-like in place of '
  + 'lunar, or 2 rpm in place of 3.';

// The thread that was already filed before the camera rolled. Same passage,
// two sentences earlier: what "too fast" actually means in rpm.
const GREEN_SUMMARY =
  'The comment asked what "too fast" is in numbers. Claude answered that the '
  + 'comfort ceiling sits around 4–6 rpm and that almost nobody is troubled below '
  + '2, because the discomfort comes from turning your head across the spin axis '
  + 'rather than from the spin itself. The outcome was that the sentence stays as '
  + 'written and the Globus range one line down carries the number.';

export function patchHarness(src, { plotDataUrl }) {
  let out = src;

  // (1) The page's stylesheet, and then the three lines the shoot adds on top
  //     of it. Both go AFTER the harness's own <style> so the site's rules win
  //     the ties — the harness styles a fixture article, and this is not one.
  //
  //     This runs BEFORE the article is swapped in, because the mirrored markup
  //     carries style blocks of its own and the </style> anchor has to still be
  //     the harness's only one when it is matched.
  //
  //     The harness's own fixture-article rules go first, because they are not
  //     overridden by the site's: the cascade works per PROPERTY, and the site
  //     never states `article { max-width }` (its column is set on <body>), so
  //     `article { max-width: 40rem }` survives underneath a 1408px stylesheet
  //     and squeezes the post into a 450px ribbon. Deleting the block is the
  //     honest fix — those rules exist to style a fixture this page replaces.
  out = replaceRange(out,
    '  article { max-width: 40rem; margin: 0 auto; padding: 2.5rem 1.2rem 6rem }',
    "  article .byline { font: 13px ui-sans-serif, system-ui, sans-serif; color: var(--pmuted);\n    text-transform: uppercase; letter-spacing: .06em; margin: 0 0 2rem }",
    '  /* the harness fixture-article rules are dropped: this page brings its own\n'
    + '     stylesheet, and these would fight it property by property */',
    'drop the fixture article styling');

  out = replaceOnce(out, '</style>',
    '</style>\n'
    + SITE_STYLESHEETS.map(h => `<link rel="stylesheet" href="${h}">`).join('\n') + '\n'
    + `<style>${ARTICLE_CSS}</style>\n`
    + SITE_SCRIPTS.map(s => `<script src="${s}" defer></script>`).join('\n'),
    'the page styles');

  out = replaceOnce(out,
    '<title>Botference Web Annotator — harness</title>',
    `<title>${PAGE_TITLE} — Angadh Nanjangud</title>`,
    'the tab title');

  // (2) The page. Not a recreation: capture/mirror-site.mjs saved the live
  //     post's own post-JavaScript markup and every byte it loads, and
  //     capture/site/ is served as its docroot. See capture/page.mjs.
  out = replaceRange(out, '<article>', '</article>', ARTICLE_HTML, 'the page');

  // (3) The figure a run hands back. The harness ships a 260x150 line chart
  //     drawn by hand; we swap in the PNG that capture/fixtures/snippet.py
  //     actually produced under matplotlib, so the plot on screen is the
  //     output of the code on screen.
  out = replaceOnce(out,
    "const TINY_PNG = 'data:image/png;base64,'",
    `const TINY_PNG = ${JSON.stringify(plotDataUrl)}; const TINY_PNG_UNUSED = 'data:image/png;base64,'`,
    'real matplotlib figure');

  // (4) One figure per run rather than two, and no invented stdout. The harness
  //     prints "drew the chart" for a plotting run; the snippet on screen ends
  //     in plt.show() and prints nothing at all, so the film would be showing
  //     output its own code does not produce. Silence plus a figure is both the
  //     truthful result and the more interesting one — it is the case the
  //     drawer's "✓ ran · 214 ms" status line exists to make visible.
  out = replaceOnce(out,
    "if (/plot|savefig/.test(code)) return { ...base, stdout: 'drew the chart\\n', figures: ['figure-01.png', 'figure-02.png'] };",
    "if (/plot|savefig/.test(code)) return { ...base, stdout: '', figures: ['figure-01.png'] };",
    'single figure, honest stdout');

  // (5) The record. EXACTLY ONE thread exists before the camera rolls: a
  //     resolved one two sentences above the focus passage, so a viewer has
  //     seen sage green before the film asks them to notice a highlight turning
  //     it. Everything else on screen is made during the take. The page chat is
  //     empty — this cut is about the margin, and an unopened tab with a
  //     conversation already in it is a second story.
  out = replaceRange(out, '  threads: [\n    { id: \'t-1754500000-a1b2\',', '  ],\n};',
    `  threads: [
    { id: 't-1754500000-a1b2',
      quote: ${JSON.stringify(GREEN_QUOTE)},
      prefix: 'comes with a major engineering challenge. ', suffix: '',
      orphaned: false,
      resolved: true, resolved_at: iso(52), resolved_by: 'angadh',
      summary_by: 'claude',
      summary: ${JSON.stringify(GREEN_SUMMARY)},
      msgs: [
        { author: 'angadh', ts: iso(64), text: '@claude how fast is "too fast" — is there a number?' },
        { author: 'claude', ts: iso(63), text: 'The comfort ceiling most of the literature settles on is 4–6 rpm, and almost nobody is troubled below 2. What makes people ill is turning your head across the spin axis, not the spin itself.' },
      ] },
  ],
  page_chat: [],
};`,
    'one resolved thread, nothing else');

  // (6) A pause before the first token. The shipped fake companion starts
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

  // (6b) …and the same for the written summary. The shipped mock answers in
  //      60ms, so the card's own "summarizing…" state — the placeholder digest,
  //      in italics, with the agents still working on the real paragraph — is
  //      never on screen at all. The real job is a queued agent turn.
  out = replaceOnce(out,
    "      toContent({ t: 'ws', ev: { type: 'page', url: PAGE_URL } });\n    }, 60);",
    "      toContent({ t: 'ws', ev: { type: 'page', url: PAGE_URL } });\n    }, 1400);",
    'the summary takes a turn to write');

  // (7) The two answers, and no tool rows. The shipped CANNED_REPLY and
  //     CANNED_MD are about the harness's own football article; these are about
  //     this page. The tool-activity rows go because a 40-second film has no
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

  // (8) The written summary the agents send back when a filed card asks for
  //     one. The harness's belongs to a different fixture article; on screen,
  //     in this film, it would simply be about the wrong thing.
  out = replaceOnce(out,
    "      t.summary = 'The comment asked whether the sleeper is really the point. '\n        + 'Claude answered that it is, on that route. The outcome was that the '\n        + 'paragraph stands as written.';",
    `      t.summary = ${JSON.stringify(FOCUS_SUMMARY)};`,
    'on-topic written summary');

  // (9) The page's identity. The record is filed under the post itself, which
  //     is also where the export note's `url:` line points.
  out = replaceOnce(out,
    "  : 'https://example.com/sport/the-quiet-machine';",
    `  : ${JSON.stringify(PAGE_URL)};`,
    'page url');
  out = replaceOnce(out,
    "  title: 'The Quiet Machine',\n  site: 'example.com',",
    `  title: ${JSON.stringify(PAGE_TITLE)},\n  site: ${JSON.stringify(PAGE_SITE)},`,
    'page title and site');

  return out;
}

export { FOCUS_QUOTE, GREEN_QUOTE };

export function startServer({ plotDataUrl }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // the plugin first, then the mirrored site behind it
    const roots = [PLUGIN_DIR, SITE_DIR];
    const file = roots
      .map(root => path.resolve(root, rel))
      .find((f, i) => f.startsWith(roots[i]) && fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file) { res.writeHead(404).end('not found'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      const ext = path.extname(file).toLowerCase();
      let body = buf;
      if (rel === 'test/harness.html') body = Buffer.from(patchHarness(buf.toString('utf8'), { plotDataUrl }), 'utf8');
      res.writeHead(200, {
        'content-type': TYPES[ext] || 'application/octet-stream',
        'content-length': body.length,
        'accept-ranges': 'bytes',
      });
      res.end(body);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
