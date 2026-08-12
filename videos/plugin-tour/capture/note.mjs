// The exported note.
//
// The MARKDOWN is real: this calls the plugin's own frontends/plugin/export.mjs
// — the same renderNote() the companion's POST /export runs — over a page record
// carrying exactly the two threads the film has just shown being made and filed.
// No sentence in the note is written here; every line of it comes out of the
// exporter, and footage/note.md is that output byte for byte.
//
// There is no application around it. The v1 cut showed the note inside a
// facsimile of Obsidian — a sidebar, a tab strip, a fake window — which was the
// one staged surface in the film and the only thing in it a viewer had to take
// on trust. A note is a document; documents do not need a window drawn around
// them to be believed. What is on screen here is the exporter's own text, set
// as a document, with the path the companion reported along the top.
//
//   node capture/note.mjs        -> footage/note.html  (+ footage/note.md)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOCUS_QUOTE, GREEN_QUOTE } from './page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// store.mjs reads BOTFERENCE_PROJECT_ROOT once, at import — so a throwaway
// workspace has to exist before export.mjs is loaded, or this would read the
// developer's own.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-tour-'));
process.env.BOTFERENCE_PROJECT_ROOT = WORK;
const { renderNote } = await import(path.resolve(ROOT, '../../frontends/plugin/export.mjs'));

const SNIPPET = fs.readFileSync(path.join(HERE, 'fixtures/snippet.py'), 'utf8').trim();
const ts = (n) => new Date(Date.parse('2026-08-12T09:00:00Z') + n * 60000).toISOString();
const me = (t, n) => ({ author: 'angadh', ts: ts(n), text: t });
const bot = (t, n, who = 'claude') => ({ author: who, ts: ts(n), text: t });

export const VAULT_PATH = '/Users/angadh/Vault/Web Clippings/Meditations on Moloch.md';

// The page as the film leaves it: the thread that was already filed when the
// camera started, and the one it made, ran and filed on screen. Both resolved,
// both carrying the written summary the agents sent back.
const PAGE = {
  url: 'https://slatestarcodex.com/2014/07/30/meditations-on-moloch/',
  title: 'Meditations on Moloch',
  site: 'slatestarcodex.com',
  tags: ['coordination', 'to re-read'],
  threads: [
    {
      quote: GREEN_QUOTE,
      resolved: true, resolved_by: 'angadh',
      summary: 'The comment asked whether the arithmetic really is common knowledge, or whether '
        + 'the farms are only assumed to have worked it out. Claude answered that the assumption is '
        + 'doing real work and is worth stating: the trap needs everyone to know that everyone knows. '
        + 'The outcome was that the sentence stays, with "and every owner knows the others can do it '
        + 'too" carrying the load.',
      msgs: [
        me('@claude does this need the "everyone knows that everyone knows" step spelled out?', 0),
        bot('It does, and the sentence already carries it — the second clause is the common-knowledge '
          + 'condition in plain words. Without it the farms are merely selfish; with it they are trapped.', 1),
      ],
    },
    {
      quote: FOCUS_QUOTE,
      resolved: true, resolved_by: 'angadh',
      summary: 'The comment asked whether the lake and an arms race are the same trap. Claude answered '
        + 'that they are — the same defection payoff with no enforceable promise underneath it — and '
        + 'differ only in whether a referee already exists. Codex plotted the spread to show how fast '
        + 'the equilibrium tips once it starts. The outcome was that the paragraph stands and the plot '
        + 'stays in the thread.',
      msgs: [
        me('@claude is this the same trap as arms races?', 20),
        bot('Yes — same shape, shorter fuse.\n\n'
          + 'An arms race is this lake with two farms: each side’s build is the correct answer to the '
          + 'other’s, neither can stop first, and the equilibrium they reach together is worse than the '
          + 'treaty neither can enforce.\n\n'
          + 'The difference is the exit. Fisheries get quotas because the players are few and countable; '
          + 'an arms race has to invent its own referee first.', 21),
        me('@codex plot how defection spreads?', 22),
        {
          author: 'codex', ts: ts(23),
          text: 'Replicator dynamics is the mechanism you are asking about — defectors grow at whatever '
            + 'edge their payoff has over the field:\n\n'
            + '```python\n' + SNIPPET + '\n```\n\n'
            + 'The curve is a logistic. The payoff edge only moves the knee.',
          runs: {
            0: {
              run_id: 'r-2f9c41-0a7b3e', status: 'ok', exit: 0, ms: 214, python: '3.12.4',
              stdout: '', stderr: '', figures: ['figure-01.png'],
            },
          },
        },
      ],
    },
  ],
  page_chat: [],
};

// the exporter's own output, verbatim
const ATTACH = 'attachments/meditations-on-moloch-1.png';
const md = renderNote(PAGE, { author: 'angadh' }, new Date('2026-08-12T09:00:00Z'), 'all',
  // `attach(run_id, figure)` is the copier the companion hands in; in the vault
  // it returns the path the copied figure took, which is what puts a real image
  // in the reading view
  () => ATTACH);

fs.mkdirSync(path.join(ROOT, 'footage'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'footage', 'note.md'), md);
console.log(md);

// ---------------------------------------------------------------------------
// A reading view for exactly the constructs the exporter emits. Nothing here
// decides what the note SAYS; it decides how big it is set.
// ---------------------------------------------------------------------------
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const figDataUrl = 'data:image/png;base64,' +
  fs.readFileSync(path.join(HERE, 'fixtures/figure-01.png')).toString('base64');

const SPEAKER = { angadh: 'me', claude: 'claude', codex: 'codex' };

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+):\*\*/g, (_, who) => {
      const k = SPEAKER[who.toLowerCase()];
      return `<strong class="who ${k || ''}">${who}</strong>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function render(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  // frontmatter — the note's own YAML, set as the note actually holds it
  if (lines[0] === '---') {
    const rows = [];
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) rows.push(lines[i]);
    i++;
    out.push('<pre class="front"><code>---\n' + esc(rows.join('\n')) + '\n---</code></pre>');
  }
  let inCode = null, buf = [], list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (; i < lines.length; i++) {
    const L = lines[i];
    if (inCode !== null) {
      if (/^```/.test(L)) { out.push(`<pre class="lang-${inCode}"><code>${esc(buf.join('\n'))}</code></pre>`); inCode = null; buf = []; }
      else buf.push(L);
      continue;
    }
    const fence = /^```(\w*)/.exec(L);
    if (fence) { closeList(); inCode = fence[1] || 'text'; buf = []; continue; }
    if (/^!\[figure/.test(L)) {
      closeList();
      out.push(`<figure><img src="${figDataUrl}" alt="figure"><figcaption>${esc(ATTACH)}</figcaption></figure>`);
      continue;
    }
    if (/^#\s/.test(L)) { closeList(); out.push(`<h1>${inline(L.slice(2))}</h1>`); continue; }
    if (/^##\s/.test(L)) { closeList(); out.push(`<h2>${inline(L.slice(3))}</h2>`); continue; }
    if (/^>\s?/.test(L)) {
      closeList();
      const q = [];
      while (i < lines.length && /^>/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      i--;
      out.push(`<blockquote>${q.map(x => `<p>${inline(x)}</p>`).join('')}</blockquote>`);
      continue;
    }
    if (/^[-*]\s/.test(L)) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(L.replace(/^[-*]\s/, ''))}</li>`);
      continue;
    }
    if (!L.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(L)}</p>`);
  }
  closeList();
  return out.join('\n');
}

const html = `<!doctype html><meta charset="utf-8"><title>${esc(path.basename(VAULT_PATH))}</title>
<style>
  :root { --paper:#fdfaf3; --edge:#e9e2d2; --ink:#262320; --mut:#8b8172; --rule:#e3dac6;
          --me:#2f7d5b; --claude:#c05f3c; --codex:#3a6ea8; }
  * { box-sizing: border-box }
  html, body { margin:0; height:100%; background:var(--edge); color:var(--ink);
    font: 20px/1.58 Georgia, "Iowan Old Style", Charter, ui-serif, serif; }
  .scroll { height:100vh; overflow:hidden; }
  .sheet { max-width:1240px; margin:0 auto; background:var(--paper); min-height:100%;
    padding: 0 78px 76px; box-shadow: 0 0 0 1px rgba(0,0,0,.05), 0 2px 30px rgba(60,50,30,.10); }
  .path { position:sticky; top:0; background:var(--paper); padding:22px 0 15px;
    border-bottom:1px solid var(--rule); margin-bottom:28px;
    font:14.5px/1.4 ui-monospace, "SF Mono", Menlo, monospace; color:var(--mut);
    letter-spacing:.01em; }
  h1 { font-size:42px; line-height:1.16; margin:.35em 0 .6em; font-weight:400; letter-spacing:-.012em }
  h2 { font-size:27px; margin:1.5em 0 .5em; font-weight:400 }
  p { margin:.62em 0 }
  blockquote { border-left:4px solid #cdbf9f; margin:1.25em 0; padding:.1em 0 .1em 22px;
    color:#4d463a; font-style:italic; }
  blockquote p { margin:.18em 0 }
  em { color:#5c5344 }
  strong { font-weight:700 }
  strong.who { font: 700 17px/1.6 ui-sans-serif, system-ui, sans-serif; letter-spacing:.02em; }
  strong.who.me { color:var(--me) } strong.who.claude { color:var(--claude) }
  strong.who.codex { color:var(--codex) }
  code { background:#f1e9d8; border-radius:4px; padding:1px 5px; font-size:16.5px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace }
  pre { background:#f6f0e2; border:1px solid var(--rule); border-radius:8px;
    padding:16px 20px; overflow:hidden; margin:1em 0 }
  pre code { background:none; padding:0; font-size:15px; line-height:1.5 }
  pre.front { background:none; border:0; border-radius:0; padding:0; margin:0 0 4px }
  pre.front code { color:var(--mut); font-size:15.5px; line-height:1.62 }
  figure { margin:1.1em 0 }
  figure img { width:500px; max-width:100%; display:block; background:#fff;
    border:1px solid var(--rule); border-radius:6px }
  figcaption { color:var(--mut); font:13.5px/1.5 ui-monospace, Menlo, monospace; margin-top:8px }
  a { color:#3a6ea8; text-decoration:none }
</style>
<div class="scroll"><div class="sheet">
  <div class="path">${esc(VAULT_PATH)}</div>
  ${render(md)}
</div></div>
`;
fs.writeFileSync(path.join(ROOT, 'footage', 'note.html'), html);
fs.rmSync(WORK, { recursive: true, force: true });
console.error('\n-> footage/note.html + footage/note.md');
