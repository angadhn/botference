// The exported note, in Obsidian.
//
// THE MARKDOWN IS REAL. This calls the plugin's own frontends/plugin/export.mjs
// — the same renderNote() the companion's POST /export runs — over a page record
// carrying exactly the two threads the film has just shown being made and filed.
// No sentence in the note is written here; every line of it comes out of the
// exporter, and footage/note.md is that output byte for byte. Even the figure's
// path is the exporter's: store.mjs's pageKey() is imported and asked, so the
// attachment is named the same sha1 the companion would name it.
//
// THE APPLICATION AROUND IT IS A FACSIMILE, and is drawn here. The v1 cut had
// one; the v2 cut dropped it on the argument that a document needs no window
// drawn around it to be believed. That was wrong in one specific way: the claim
// this beat makes is not "here is a document", it is "this ends up in your
// vault", and a vault is a place. So the note is set inside a recreation of
// Obsidian's dark reading view — the ribbon, the file tree with this note
// highlighted and the copied figure sitting in attachments/, the tab strip, the
// properties block, Inter at a readable line width, One Dark syntax colours in
// the code cell, the word count in the status bar. Nothing in the frame asserts
// anything about the product; it is the room the exporter's output is read in.
//
//   node capture/note.mjs        -> footage/note.html  (+ footage/note.md)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOCUS_QUOTE, GREEN_QUOTE, PAGE_URL, PAGE_TITLE, PAGE_SITE } from './page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLUGIN = path.resolve(ROOT, '../../frontends/plugin');

// store.mjs reads BOTFERENCE_PROJECT_ROOT once, at import — so a throwaway
// workspace has to exist before export.mjs is loaded, or this would read the
// developer's own.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-tour-'));
process.env.BOTFERENCE_PROJECT_ROOT = WORK;
const { renderNote, sanitizeTitle, ATTACH_DIR } = await import(path.join(PLUGIN, 'export.mjs'));
const { pageKey } = await import(path.join(PLUGIN, 'store.mjs'));

const SNIPPET = fs.readFileSync(path.join(HERE, 'fixtures/snippet.py'), 'utf8').trim();
const ts = (n) => new Date(Date.parse('2026-08-12T09:00:00Z') + n * 60000).toISOString();
const me = (t, n) => ({ author: 'angadh', ts: ts(n), text: t });
const bot = (t, n, who = 'claude') => ({ author: who, ts: ts(n), text: t });

// Where the companion puts it: <vault>/<export_folder>/<sanitised title>.md,
// with export_folder defaulting to 'Web Clippings' (store.mjs DEFAULT_CONFIG).
export const NOTE_NAME = sanitizeTitle(PAGE_TITLE);
export const VAULT = '/Users/angadh/Vault';
export const VAULT_FOLDER = 'Web Clippings';
export const VAULT_PATH = `${VAULT}/${VAULT_FOLDER}/${NOTE_NAME}.md`;

// …and what it calls the figure it copies in beside it: attachments/<pageKey>-1.png,
// the page's sha1, asked of the plugin's own store rather than invented.
const ATTACH = `${ATTACH_DIR}/${pageKey(PAGE_URL)}-1.png`;

// The page as the film leaves it: the thread that was already filed when the
// camera started, and the one it made, ran and filed on screen. Both resolved,
// both carrying the written summary the agents sent back. Every string here is
// the same string the harness served during the take (capture/serve.mjs).
const PAGE = {
  url: PAGE_URL,
  title: PAGE_TITLE,
  site: PAGE_SITE,
  tags: ['spaceships', 'artificial gravity'],
  threads: [
    {
      quote: GREEN_QUOTE,
      resolved: true, resolved_by: 'angadh',
      summary: 'The comment asked what "too fast" is in numbers. Claude answered that the '
        + 'comfort ceiling sits around 4–6 rpm and that almost nobody is troubled below 2, '
        + 'because the discomfort comes from turning your head across the spin axis rather '
        + 'than from the spin itself. The outcome was that the sentence stays as written and '
        + 'the Globus range one line down carries the number.',
      msgs: [
        me('@claude how fast is "too fast" — is there a number?', 0),
        bot('The comfort ceiling most of the literature settles on is 4–6 rpm, and almost '
          + 'nobody is troubled below 2. What makes people ill is turning your head across '
          + 'the spin axis, not the spin itself.', 1),
      ],
    },
    {
      quote: FOCUS_QUOTE,
      resolved: true, resolved_by: 'angadh',
      summary: 'The comment asked whether 3 rpm on a 75 metre wheel really gives lunar '
        + 'gravity. Claude worked ω²r at r = 37.5 m and answered that it does not: 3 rpm '
        + 'lands on 0.38 g, which is Mars, while the Moon wants about 2 rpm — the 5 rpm '
        + 'Earth-like figure is right. Codex plotted gravity against radius for all three '
        + 'rates with the wheel marked. The outcome was that the sentence needs Mars-like '
        + 'in place of lunar, or 2 rpm in place of 3.',
      msgs: [
        me('@claude 3 rpm on a 75 m wheel — is that really lunar gravity?', 20),
        bot('Not quite — that one is Mars.\n\n'
          + 'Artificial gravity is ω²r, and a 75 m wheel gives r = 37.5 m:\n\n'
          + '- 5 rpm → 10.3 m/s² = 1.05 g. Earth-like, as you have it.\n'
          + '- 3 rpm → 3.70 m/s² = 0.38 g, which is Mars (0.38 g), not the Moon (0.17 g).\n\n'
          + 'Lunar gravity on this wheel wants about 2 rpm — still well inside the comfort '
          + 'range you link to, so the design survives; it is the label that slips.', 21),
        me('@codex plot gravity vs radius at 2, 3 and 5 rpm?', 22),
        {
          author: 'codex', ts: ts(23),
          text: 'Here is ω²r swept over radius, with the three rates and the Moon/Mars/Earth '
            + 'levels drawn in, and your wheel marked:\n\n'
            + '```python\n' + SNIPPET + '\n```\n\n'
            + 'The 37.5 m line crosses 3 rpm at 0.38 g and 5 rpm just over 1 g.',
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
const md = renderNote(PAGE, { author: 'angadh' }, new Date('2026-08-12T09:00:00Z'), 'all',
  // `attach(run_id, figure)` is the copier the companion hands in; in the vault
  // it returns the path the copied figure took, which is what puts a real image
  // in the reading view
  () => ATTACH);

fs.mkdirSync(path.join(ROOT, 'footage'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'footage', 'note.md'), md);
console.log(md);

// ===========================================================================
// The reading view — Obsidian, recreated
// ===========================================================================
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const figDataUrl = 'data:image/png;base64,' +
  fs.readFileSync(path.join(HERE, 'fixtures/figure-01.png')).toString('base64');

// Obsidian bundles Inter and sets it as the default interface AND text font, so
// a facsimile in the system font is a facsimile a user of the app spots at a
// glance. This is the Google-hosted latin subset of the variable face, embedded
// so the render needs no network.
const INTER = 'data:font/woff2;base64,' +
  fs.readFileSync(path.join(HERE, 'fixtures/inter-variable.woff2')).toString('base64');

// ---- Python, coloured the way Obsidian's reading view colours it -----------
// Obsidian ships Prism and a One Dark-derived palette, so a ```python block in
// a note is syntax-highlighted rather than flat. This is a small tokeniser for
// exactly the constructs the snippet contains — enough that the cell in the
// vault looks like the cell in the vault, and no more.
const PY_KEYWORDS = /^(import|from|as|for|in|if|else|elif|return|def|class|and|or|not|while|with|lambda|None|True|False)$/;
const PY_BUILTINS = /^(range|len|list|print|enumerate|zip|str|int|float|dict|set|tuple)$/;

function python(src) {
  const out = [];
  const re = /(#[^\n]*)|(f?"(?:[^"\\]|\\.)*"|f?'(?:[^'\\]|\\.)*')|(\b\d+\.?\d*\b|\B\.\d+\b)|([A-Za-z_][A-Za-z_0-9]*)|(\s+)|([^\sA-Za-z_0-9])/g;
  let m;
  while ((m = re.exec(src))) {
    const [all, comment, str, num, word, ws, punct] = m;
    if (comment) out.push(`<span class="tc">${esc(comment)}</span>`);
    else if (str) out.push(`<span class="ts">${esc(str)}</span>`);
    else if (num) out.push(`<span class="tn">${esc(num)}</span>`);
    else if (word) {
      const after = src.slice(m.index + all.length);
      const cls = PY_KEYWORDS.test(word) ? 'tk'
        : PY_BUILTINS.test(word) ? 'tb'
        : /^\s*\(/.test(after) ? 'tf'
        : null;
      out.push(cls ? `<span class="${cls}">${esc(word)}</span>` : esc(word));
    } else if (ws) out.push(esc(ws));
    else out.push(`<span class="to">${esc(punct)}</span>`);
  }
  return out.join('');
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Obsidian renders **angadh:** as plain bold — no colour, no chat bubble.
    // Naming the speakers is the exporter's doing, and this shows what it did.
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="external-link" href="$2">$1</a>');
}

/** The frontmatter block, as Obsidian's reading view shows it: a properties
 *  table, keys muted with their type icon, tags as pills. */
const ICON = {
  url: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.8"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.8-1.8"/>',
  site: '<path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  saved: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
  tags: '<path d="M12 2H2v10l9.3 9.3a1 1 0 0 0 1.4 0l8.6-8.6a1 1 0 0 0 0-1.4Z"/><circle cx="6.5" cy="6.5" r="1.5"/>',
};
const propIcon = k => `<svg viewBox="0 0 24 24" class="pico">${ICON[k] || ICON.site}</svg>`;

function properties(rows) {
  const cell = (k, v) => {
    if (k === 'tags') {
      const tags = v.replace(/^\[|\]$/g, '').split(',').map(t => t.trim()).filter(Boolean);
      return tags.map(t => `<a class="tag" href="#">#${esc(t)}</a>`).join(' ');
    }
    if (k === 'url') return `<a class="external-link" href="${esc(v)}">${esc(v)}</a>`;
    return esc(v);
  };
  return `<div class="properties">${rows.map(([k, v]) => `
    <div class="prow"><div class="pkey">${propIcon(k)}<span>${esc(k)}</span></div>
    <div class="pval">${cell(k, v)}</div></div>`).join('')}</div>`;
}

function render(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  if (lines[0] === '---') {
    const rows = [];
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const at = lines[i].indexOf(':');
      rows.push([lines[i].slice(0, at), lines[i].slice(at + 1).trim()]);
    }
    i++;
    out.push(properties(rows));
  }
  let inCode = null, buf = [], list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (; i < lines.length; i++) {
    const L = lines[i];
    if (inCode !== null) {
      if (/^```/.test(L)) {
        const body = buf.join('\n');
        out.push(`<pre class="lang-${inCode}"><code>${
          inCode === 'python' ? python(body) : esc(body)}</code></pre>`);
        inCode = null; buf = [];
      } else buf.push(L);
      continue;
    }
    const fence = /^```(\w*)/.exec(L);
    if (fence) { closeList(); inCode = fence[1] || 'text'; buf = []; continue; }
    // An embedded image in Obsidian is the image and nothing else: no caption,
    // no path on screen. The path is in the file tree, where it lives.
    if (/^!\[figure/.test(L)) {
      closeList();
      out.push(`<img class="fig" src="${figDataUrl}" alt="figure 1">`);
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

// ---- the application chrome ------------------------------------------------
const lucide = (d, cls = 'ic') =>
  `<svg viewBox="0 0 24 24" class="${cls}">${d}</svg>`;

const RIBBON = [
  '<path d="M12 5v14M5 12h14"/>',                                        // new note
  '<path d="M4 4h7v7H4zM13 13h7v7h-7z"/><path d="M11 7h2a2 2 0 0 1 2 2v4"/>', // canvas
  '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="11" cy="17" r="2.5"/><path d="M8.2 7.1 15.5 8M8.7 15 16.6 9.6"/>', // graph
  '<path d="M4 5h16M4 12h16M4 19h10"/>',                                 // outline
  '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',          // search
];

const TREE = `
  <div class="row folder open" style="--d:0">${lucide('<path d="M9 6l6 6-6 6"/>', 'chev')}<span>Web Clippings</span></div>
  <div class="row file" style="--d:1"><span>Inflatable stations — WiP draft</span></div>
  <div class="row file" style="--d:1"><span>Rotating wheel stations — sources</span></div>
  <div class="row file active" style="--d:1"><span>${esc(NOTE_NAME)}</span></div>
  <div class="row folder open" style="--d:1">${lucide('<path d="M9 6l6 6-6 6"/>', 'chev')}<span>${esc(ATTACH_DIR)}</span></div>
  <div class="row file attach" style="--d:2"><span>${esc(path.basename(ATTACH))}</span></div>
  <div class="row folder" style="--d:0">${lucide('<path d="M9 6l6 6-6 6"/>', 'chev')}<span>Essays</span></div>
  <div class="row folder" style="--d:0">${lucide('<path d="M9 6l6 6-6 6"/>', 'chev')}<span>Reading list</span></div>
  <div class="row file" style="--d:0"><span>2026-08-12</span></div>
`;

const words = md.trim().split(/\s+/).length;
const chars = md.trim().length;

const html = `<!doctype html><meta charset="utf-8"><title>${esc(NOTE_NAME)} - Vault - Obsidian</title>
<style>
  @font-face { font-family:"Inter"; font-style:normal; font-weight:100 900;
    font-display:block; src:url("${INTER}") format("woff2"); }

  /* Obsidian's dark theme, by its own token names. The base ramp is the one the
     app ships (base-00 #1e1e1e through base-70 #b3b3b3); the accent is the
     default hsl(254, 80%, 68%). */
  :root {
    --base-00:#1e1e1e; --base-05:#212121; --base-10:#242424; --base-20:#262626;
    --base-25:#2a2a2a; --base-30:#363636; --base-35:#3f3f3f; --base-40:#555;
    --base-50:#666; --base-60:#999; --base-70:#b3b3b3;
    --bg-primary:#1e1e1e; --bg-secondary:#161616; --bg-alt:#1a1a1a;
    --text-normal:#dadada; --text-muted:#b3b3b3; --text-faint:#666;
    --accent:#9d85f2; --accent-hover:#b19ff5;
    --divider:#2a2a2a;
    --code-bg:#161616;
    --font-ui:"Inter",-apple-system,"Segoe UI",Roboto,sans-serif;
    --font-text:"Inter",-apple-system,"Segoe UI",Roboto,sans-serif;
    --font-mono:"SFMono-Regular","JetBrains Mono",Menlo,Consolas,monospace;
    --line-width: 880px;
    --text-size: 20px;
  }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:#0d0d0d; color:var(--text-normal);
    font-family: var(--font-ui); -webkit-font-smoothing: antialiased; }

  /* the window */
  .app { position:fixed; inset:0; display:grid;
    grid-template-columns: 48px 296px 1fr; grid-template-rows: 1fr 26px;
    background:var(--bg-secondary); overflow:hidden; }

  /* ---- ribbon ---- */
  .ribbon { grid-row:1/3; background:var(--bg-secondary); display:flex;
    flex-direction:column; align-items:center; padding:74px 0 12px;
    gap:16px; border-right:1px solid var(--divider); }
  .ribbon .sp { flex:1 }
  .ic, .chev, .pico { width:19px; height:19px; fill:none; stroke:currentColor;
    stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
  .ribbon .ic { color:var(--text-faint); }
  .ribbon .ic:first-of-type { color:var(--text-muted); }

  /* macOS window controls, where Obsidian puts them: over the top of the
     sidebar, no title bar of their own */
  .lights { position:fixed; left:20px; top:22px; display:flex; gap:8px; z-index:5 }
  .lights i { width:12px; height:12px; border-radius:50%; display:block }

  /* ---- left sidebar ---- */
  .sidebar { background:var(--bg-secondary); border-right:1px solid var(--divider);
    display:flex; flex-direction:column; padding-top:52px; }
  .sbtabs { display:flex; align-items:center; gap:2px; padding:0 10px 4px; }
  .sbtabs .t { padding:6px; border-radius:5px; color:var(--text-faint); display:flex }
  .sbtabs .t.on { color:var(--text-normal); background:var(--base-25) }
  .sbtabs .sp { flex:1 }
  .navhead { display:flex; justify-content:flex-end; gap:4px; padding:6px 12px 8px; }
  .navhead .t { padding:5px; border-radius:5px; color:var(--text-faint); display:flex }
  .tree { padding:0 8px 10px; font-size:14.5px; line-height:1.45;
    color:var(--text-muted); overflow:hidden; }
  .row { display:flex; align-items:center; gap:5px; height:27px; border-radius:5px;
    padding-left: calc(6px + var(--d) * 19px); padding-right:6px;
    white-space:nowrap; overflow:hidden; }
  .row span { overflow:hidden; text-overflow:ellipsis }
  .row .chev { width:15px; height:15px; flex:none; color:var(--text-faint);
    transform: rotate(0deg); }
  .row.open .chev { transform: rotate(90deg) }
  .row.folder { color:var(--text-muted) }
  .row.file { padding-left: calc(25px + var(--d) * 19px) }
  .row.file.attach { color:var(--text-faint) }
  .row.active { background:var(--base-30); color:var(--text-normal) }

  /* ---- main area ---- */
  .main { display:flex; flex-direction:column; min-width:0; min-height:0;
    overflow:hidden; background:var(--bg-secondary); padding-top:38px; }
  .tabstrip { display:flex; align-items:flex-end; gap:2px; padding:0 8px;
    height:38px; }
  .tab { display:flex; align-items:center; gap:8px; height:34px;
    padding:0 10px 0 12px; border-radius:8px 8px 0 0; font-size:14.5px;
    color:var(--text-faint); max-width:340px; }
  .tab.on { background:var(--bg-primary); color:var(--text-normal) }
  .tab .ic { width:16px; height:16px }
  .tab .x { width:15px; height:15px; opacity:.55 }
  .tab .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .stripsp { flex:1 }
  .stripact { display:flex; gap:10px; align-items:center; padding-bottom:9px;
    color:var(--text-faint) }

  .scroll { flex:1; min-height:0; background:var(--bg-primary); overflow:hidden; }
  .view { max-width:var(--line-width); margin:0 auto; padding:34px 32px 56px; }

  /* ---- the note ---- */
  /* Obsidian's inline title is the FILE NAME, drawn at --h1-size — so a note
     whose body opens with its own "# Heading" shows both, at the same size.
     That is what this exporter's notes look like in the app, and it is what
     this shows. */
  .inline-title { font-family:var(--font-text); font-size:34px; font-weight:700;
    line-height:1.2; letter-spacing:-.015em; color:var(--text-normal);
    margin:0 0 14px; }
  .properties { border-top:1px solid var(--divider); border-bottom:1px solid var(--divider);
    padding:6px 0; margin:0 0 26px; }
  .prow { display:flex; align-items:baseline; gap:12px; padding:5px 0; font-size:16px }
  .pkey { display:flex; align-items:center; gap:7px; width:132px; flex:none;
    color:var(--text-muted) }
  .pkey .pico { width:16px; height:16px; color:var(--text-faint) }
  .pval { color:var(--text-normal); overflow-wrap:anywhere }
  .tag { color:var(--accent); background:rgba(157,133,242,.13); border-radius:12px;
    padding:2px 9px; font-size:14.5px; text-decoration:none; white-space:nowrap }

  .md { font-family:var(--font-text); font-size:var(--text-size); line-height:1.6;
    color:var(--text-normal); }
  .md h1 { font-size:34px; font-weight:700; line-height:1.25; letter-spacing:-.012em;
    margin:1.1em 0 .5em }
  .md h2 { font-size:26px; font-weight:600; margin:1.3em 0 .45em }
  .md p { margin: 0 0 1rem }
  .md strong { font-weight:700; color:#fff }
  .md em { color:var(--text-muted) }
  .md ul { margin:0 0 1rem; padding-left:1.6em }
  .md li { margin:.2em 0 }
  .md blockquote { margin:1rem 0; padding:2px 0 2px 20px;
    border-left:2px solid var(--base-40); color:var(--text-muted) }
  .md blockquote p { margin:.15em 0 }
  .md a.external-link { color:var(--accent); text-decoration:none }
  .md code { font-family:var(--font-mono); font-size:.86em; background:var(--code-bg);
    color:var(--text-muted); padding:1px 5px; border-radius:4px }
  .md pre { background:var(--code-bg); border-radius:8px; padding:16px 18px;
    margin:1rem 0; overflow:hidden }
  .md pre code { font-family:var(--font-mono); font-size:15.5px; line-height:1.55;
    background:none; padding:0; color:var(--text-muted); white-space:pre }
  .md img.fig { display:block; width:100%; border-radius:6px; margin:1rem 0;
    background:#fff }

  /* One Dark, which is what Obsidian's default code colours are drawn from */
  .tk { color:#c678dd } .ts { color:#98c379 } .tn { color:#d19a66 }
  .tf { color:#61afef } .tb { color:#e5c07b } .tc { color:#5c6370 } .to { color:#56b6c2 }

  /* ---- status bar ---- */
  .status { grid-column:2/4; display:flex; justify-content:flex-end; gap:20px;
    align-items:center; padding:0 18px; background:var(--bg-secondary);
    border-top:1px solid var(--divider); color:var(--text-faint); font-size:13px }
</style>
<div class="app">
  <div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>

  <div class="ribbon">
    ${RIBBON.map(d => lucide(d)).join('\n    ')}
    <div class="sp"></div>
    ${lucide('<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>')}
  </div>

  <div class="sidebar">
    <div class="sbtabs">
      <div class="t on">${lucide('<path d="M4 20V6a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/>')}</div>
      <div class="t">${lucide('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>')}</div>
      <div class="t">${lucide('<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z"/>')}</div>
      <div class="sp"></div>
      <div class="t">${lucide('<path d="M9 6l-4 6 4 6"/><path d="M20 4v16"/>')}</div>
    </div>
    <div class="navhead">
      <div class="t">${lucide('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M12 11v6M9 14h6"/>')}</div>
      <div class="t">${lucide('<path d="M4 20V6a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><path d="M12 12v5M9.5 14.5h5"/>')}</div>
      <div class="t">${lucide('<path d="M4 7h11M4 12h8M4 17h5"/><path d="M18 8v9l3-3"/>')}</div>
      <div class="t">${lucide('<path d="M6 9l6-5 6 5"/><path d="M6 15l6 5 6-5"/>')}</div>
    </div>
    <div class="tree">${TREE}</div>
  </div>

  <div class="main">
    <div class="tabstrip">
      <div class="tab on">
        ${lucide('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>')}
        <span class="nm">${esc(NOTE_NAME)}</span>
        ${lucide('<path d="M6 6l12 12M18 6L6 18"/>', 'x')}
      </div>
      <div class="tab"><span class="nm">Reading list</span></div>
      <div class="stripsp"></div>
      <div class="stripact">
        ${lucide('<path d="M12 5v14M5 12h14"/>')}
        ${lucide('<path d="M4 5h16M4 12h16M4 19h16"/>')}
        ${lucide('<path d="M15 6l4 6-4 6"/><path d="M4 4v16"/>')}
      </div>
    </div>
    <div class="scroll" id="scroller">
      <div class="view" id="sheet">
        <div class="inline-title">${esc(NOTE_NAME)}</div>
        <div class="md">${render(md)}</div>
      </div>
    </div>
  </div>

  <div class="status">
    <span>2 backlinks</span><span>${words} words</span><span>${chars} characters</span>
  </div>
</div>
`;
fs.writeFileSync(path.join(ROOT, 'footage', 'note.html'), html);
fs.rmSync(WORK, { recursive: true, force: true });
console.error(`\n-> footage/note.html + footage/note.md`);
console.error(`   vault path: ${VAULT_PATH}`);
console.error(`   attachment: ${ATTACH}`);
