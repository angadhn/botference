// Server-rendered pages for collaborators who do NOT have the extension.
//
// The extension is the annotator; this is the reading room. A guest opens the
// shared URL, sees every highlight with its thread and the page chat, and can
// reply — plain HTML forms posting to the very same /reply endpoint the drawer
// uses, so there is one write path, not two. No build step, no framework, no
// client state: the only script on the page is a dozen lines that reload it
// when the live stream says something changed (and never while you are typing).
//
// Palette matches frontends/review/assets/style.css so the two frontends look
// like one product, dark and light both.
import { escHtml } from './hosted.mjs';
// the library's reserved identity and the page-chat target, from the one place
// that defines them rather than as literals repeated down here
import { LIBRARY_URL, PAGE_CHAT, PAGE_KINDS, inferKind, tagsOf, displayTitle } from './store.mjs';
// the capped-answer marker, from the one place that defines it
import { splitMore } from './more.mjs';

const AGENTS = new Set(['claude', 'codex']);

// A tag's color IS its name: FNV-1a over the lowercased name → a hue, 0..359.
// Duplicated from extension/drawer.js tagHue (the extension/server boundary,
// exactly as normUrl is duplicated): the two copies must agree byte for byte
// or the phone paints a tag one color and the drawer another —
// test/tags.test.mjs holds them together.
export function tagHue(name) {
  const s = String(name == null ? '' : name).trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

const shortTime = ts => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
};

const STYLE = `
:root { --bg:#faf7f0; --fg:#2a2419; --muted:#8a7f6d; --card:#fff; --line:#e7dfd1;
  --accent:#d97757; --accent-hover:#c05f3f; --claude:#d97757; --codex:#4a86c8;
  --quote:#f3ede1;
  /* the resolved tint — anchor.js's HL_BG_DONE, so a green highlight in the
     article view and a filed card in the comments view are the same fact */
  --done:rgba(141,199,146,.42); --done-line:rgba(96,158,108,.85);
  /* the strikeout's own red — off the highlight arc on purpose: a strikeout is
     a different act, not a further state (drawer.css --strike-line) */
  --strike-line:rgba(200,48,48,.95);
  /* tag chips: the hue is the tag's own (--th, from tagHue below); the theme
     owns saturation/lightness so every hue clears contrast on both schemes */
  --tag-fg-l:30%; --tag-bg-l:93%; --tag-line-l:72% }
@media (prefers-color-scheme: dark) {
  :root { --bg:#1a1712; --fg:#e8dfd1; --muted:#9c917e; --card:#241f18;
    --line:rgba(217,119,87,.24); --accent-hover:#e8896d; --quote:#1f1b15;
    --done:rgba(120,180,130,.30); --done-line:rgba(126,196,134,.75);
    --strike-line:rgba(232,96,88,.95);
    --tag-fg-l:80%; --tag-bg-l:20%; --tag-line-l:36% }
}
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif }
main { max-width:44rem; margin:0 auto; padding:2rem 1.1rem 5rem }
a { color:var(--accent); text-decoration:none }
a:hover { text-decoration:underline }
header { border-bottom:1px solid var(--line); padding-bottom:.9rem; margin-bottom:1.6rem }
h1 { font-size:1.35rem; line-height:1.3; margin:0 0 .25rem }
h2 { font-size:.95rem; margin:2rem 0 .7rem; color:var(--muted);
  text-transform:uppercase; letter-spacing:.06em }
.sub { color:var(--muted); font-size:.8rem; margin:0 }
.who { float:right; color:var(--muted); font-size:.75rem }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px;
  padding:.9rem 1rem; margin:0 0 1rem }
blockquote { margin:0 0 .8rem; padding:.35rem 0 .35rem .8rem; background:var(--quote);
  border-left:3px solid var(--accent); border-radius:0 6px 6px 0; font-size:.92rem }
.orphaned { color:var(--muted); font-size:.72rem; margin-left:.4rem }
.msg { border-left:3px solid var(--line); padding:.1rem 0 .1rem .7rem; margin:.7rem 0 }
.msg.claude { border-left-color:var(--claude) }
.msg.codex { border-left-color:var(--codex) }
.msg .by { font-size:.75rem; color:var(--muted) }
.msg .by b { color:var(--fg); font-weight:600 }
.msg pre { margin:.15rem 0 0; font:inherit; white-space:pre-wrap; overflow-wrap:anywhere }
details.tools { margin:.5rem 0 .5rem .7rem; font-size:.8rem; color:var(--muted) }
details.tools pre { white-space:pre-wrap; font-size:.78rem }
details.more { margin:.15rem 0 .35rem }
details.more>summary { font-size:.8rem; color:var(--muted); cursor:pointer; list-style:none }
details.more>summary::-webkit-details-marker { display:none }
details.more>summary::before { content:"▸ "; display:inline-block; transition:transform .15s ease }
details.more[open]>summary::before { content:"▾ " }
details.more pre { margin:.2rem 0 0 .6rem; padding-left:.6rem; border-left:2px solid var(--line) }
form.composer { margin:.9rem 0 0; display:flex; flex-direction:column; gap:.5rem }
/* The pill row over a thread's reply box (reader.js): who the next message is
   for, as a label you can click. Flat and small — the default button on this
   page is a filled accent block, and four of those over a textarea would look
   like four ways to send. */
.routes { display:flex; flex-wrap:wrap; gap:.3rem }
.rpill { padding:.25rem .6rem; font-size:.72rem; border-radius:999px;
  background:transparent; color:var(--muted); border:1px solid var(--line) }
.rpill:hover { background:transparent; color:var(--fg) }
.rpill.on, .rpill.on:hover { color:var(--accent); font-weight:600;
  border-color:var(--accent); background:color-mix(in srgb, var(--accent) 12%, transparent) }
textarea { width:100%; min-height:4.2rem; resize:vertical; padding:.55rem .7rem;
  font:inherit; font-size:.92rem; color:var(--fg); background:var(--bg);
  border:1px solid var(--line); border-radius:8px }
.row { display:flex; align-items:center; gap:.7rem }
button { padding:.4rem 1rem; font-size:.9rem; border:none; border-radius:8px;
  background:var(--accent); color:#fff; cursor:pointer }
button:hover { background:var(--accent-hover) }
.hint { color:var(--muted); font-size:.75rem; margin:0 }
.notice { background:var(--card); border:1px solid var(--accent); border-radius:8px;
  padding:.6rem .8rem; margin:0 0 1.2rem; font-size:.88rem }
.empty { color:var(--muted); font-size:.9rem }
/* resolved threads, on a phone: the same shape as the drawer's — one folded
   line at the foot of the list, each card carrying what the thread settled and
   the thread itself underneath. <details> does all of it; this view has no
   script and does not want one. */
details.resolved-sec { margin:.4rem 0 0; border-top:1px solid var(--line); padding-top:.7rem }
details.resolved-sec > summary { cursor:pointer; color:var(--muted); font-size:.8rem;
  text-transform:uppercase; letter-spacing:.05em; padding:.35rem 0 }
details.resolved-sec > summary:hover { color:var(--fg) }
.card.resolved { background:color-mix(in srgb, var(--done) 45%, var(--card));
  border-color:var(--done-line) }
.card.resolved blockquote { border-left-color:var(--done-line) }
/* A STRUCK passage, in the room the phone reads. The mark is part of what the
   comment SAYS — a deletion suggested and a passage merely pointed at are not
   the same remark — so it travels, and it travels as the same thin red line
   the drawer and the PDF draw. */
blockquote.struck { text-decoration:line-through; text-decoration-color:var(--strike-line);
  text-decoration-thickness:1.5px; border-left-color:var(--strike-line) }
blockquote.struck cite { text-decoration:none }
.struck-note { display:block; margin:-.4rem 0 .7rem; font-size:.78rem; color:var(--strike-line) }
.digest { margin:0 0 .7rem; font-size:.9rem; overflow-wrap:anywhere }
form.resolve { display:inline-block; margin:.6rem 0 0 }
form.resolve button { background:none; color:var(--muted); border:1px solid var(--line);
  padding:.25rem .7rem; font-size:.78rem }
form.resolve button:hover { background:none; color:var(--fg); border-color:var(--done-line) }
ul.pages { list-style:none; margin:0; padding:0 }
ul.pages li { border-bottom:1px solid var(--line); padding:.7rem 0 }
/* article URLs are long and phones are narrow: wrap rather than push the
   whole page sideways */
ul.pages a, ul.pages .meta { overflow-wrap:anywhere }
ul.pages .meta { color:var(--muted); font-size:.76rem }
/* The same two filters the drawer's list has, as plain links: a kind rail and a
   tag rail above the pages. No script, no state — the query string IS the
   filter, so a filtered view is a link somebody can keep. */
.rail { display:flex; flex-wrap:wrap; gap:.35rem; margin:0 0 .9rem }
.rail a { display:inline-block; padding:.2rem .6rem; border:1px solid var(--line);
  border-radius:999px; font-size:.78rem; color:var(--muted) }
.rail a:hover { border-color:var(--accent); color:var(--fg); text-decoration:none }
.rail a.on { color:var(--accent); border-color:var(--accent);
  background:color-mix(in srgb, var(--accent) 12%, transparent) }
.rail.tags a::before { content:"#"; opacity:.55 }
/* a tag's color is its name (tagHue → --th), the same color the drawer gives
   it; selection is a full-strength border, never a different color */
.rail.tags a { color:hsl(var(--th,24) 45% var(--tag-fg-l));
  border-color:hsl(var(--th,24) 40% var(--tag-line-l));
  background:hsl(var(--th,24) 55% var(--tag-bg-l)) }
.rail.tags a:hover { color:hsl(var(--th,24) 45% var(--tag-fg-l));
  border-color:hsl(var(--th,24) 45% var(--tag-fg-l)) }
.rail.tags a.on { color:hsl(var(--th,24) 45% var(--tag-fg-l));
  border-color:hsl(var(--th,24) 50% var(--tag-fg-l));
  background:hsl(var(--th,24) 60% var(--tag-bg-l));
  box-shadow:inset 0 0 0 1px hsl(var(--th,24) 50% var(--tag-fg-l)) }
ul.pages .tags { margin-top:.25rem }
ul.pages .tags a { font-size:.72rem; color:hsl(var(--th,24) 45% var(--tag-fg-l));
  border-bottom:1px dotted hsl(var(--th,24) 40% var(--tag-line-l)) }
ul.pages .tags a::before { content:"#"; opacity:.55 }
/* the owner's own edits to a record: its name, and what it is filed under */
form.meta-edit { display:flex; flex-wrap:wrap; gap:.4rem; margin:.6rem 0 0 }
form.meta-edit input { flex:1 1 12rem; min-width:0; padding:.35rem .55rem; font:inherit;
  font-size:.85rem; color:var(--fg); background:var(--bg);
  border:1px solid var(--line); border-radius:8px }
form.meta-edit button { padding:.3rem .8rem; font-size:.8rem }
/* what a python code block printed when the owner ran it. Read-only here — the
   phone shows results, it never starts them — and owner-only end to end,
   because this is output from a program on somebody's Mac. */
.runs { margin:.5rem 0 .2rem }
.runs .rhead { font-size:.72rem; color:var(--muted); text-transform:uppercase;
  letter-spacing:.06em; margin:0 0 .3rem }
.runs .rhead .bad { color:var(--accent) }
.runs pre { margin:0 0 .4rem; padding:.5rem .6rem; border-radius:8px;
  background:var(--quote); border:1px solid var(--line);
  font:.8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:pre-wrap; overflow-wrap:anywhere; max-height:22rem; overflow:auto }
.runs pre.rerr { color:var(--accent); background:transparent }
.figs { display:flex; flex-wrap:wrap; gap:.4rem }
.figs img { max-width:min(14rem,100%); height:auto; border:1px solid var(--line);
  border-radius:8px; background:#fff; cursor:zoom-in }
`;

// One line every view here carries: the same braid the extension wears in the
// toolbar, so a tab of /pages is recognisable beside a tab of anything else —
// and so nothing asks for /favicon.ico and gets a 404 in the log.
export const FAVICON_LINK = '<link rel="icon" type="image/png" href="/favicon.ico">';

// `extra` is one page's own stylesheet, appended to the shared one rather than
// dropped into the body: a view with a look of its own (the quiz) still gets
// the palette, the shell and the viewport from the same place as every other.
const shell = (title, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>${FAVICON_LINK}<style>${STYLE}${extra}</style></head><body>
<main>${body}</main></body></html>`;

const whoBadge = me => `<span class="who">${escHtml(me.handle || 'guest')}${me.owner ? ' · owner' : ''}`
  + ` · <a href="/signout">sign out</a></span>`;

// Reload when this page changes underneath the reader — but never mid-sentence:
// a composer with text in it (or the focus) postpones the reload until it is
// clear. Falls back to a static page if WebSocket is unavailable.
const liveScript = url => `<script>
(function(){
  var URL_=${JSON.stringify(String(url))}, timer=null;
  function busy(){var t=document.getElementsByTagName('textarea');
    for(var i=0;i<t.length;i++){if(t[i].value.trim()||t[i]===document.activeElement)return true}return false}
  function later(){clearTimeout(timer);timer=setTimeout(function(){busy()?later():location.reload()},1500)}
  try{
    var ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
    ws.onmessage=function(e){var d;try{d=JSON.parse(e.data)}catch(_){return}
      if(d&&d.url===URL_&&(d.type==='page'||(d.type==='chat'&&d.kind!=='stream')))later()};
  }catch(_){}
})();
</script>`;

// A code block's results, read-only. `ctx` is {key, owner}: without an owner
// nothing is drawn at all — a run's output is whatever a program printed on the
// owner's own machine, and that is not a thing to hand to the room. Figures are
// served by /run-figure under the same owner-only gate, and are links as well
// as pictures so a tap gets the readable size with no script on this page.
export { splitMore };

export function runsHtml(m, ctx) {
  if (!ctx || !ctx.owner || !m || !m.runs || typeof m.runs !== 'object') return '';
  const out = [];
  for (const i of Object.keys(m.runs).sort((a, b) => Number(a) - Number(b))) {
    const r = m.runs[i] || {};
    const bad = r.status && r.status !== 'ok';
    const figs = (r.figures || []).map((name, n) => {
      const src = `/run-figure?key=${encodeURIComponent(ctx.key)}&run=${encodeURIComponent(r.run_id)}`
        + `&name=${encodeURIComponent(name)}`;
      return `<a href="${src}"><img src="${src}" alt="figure ${n + 1}" loading="lazy"></a>`;
    }).join('');
    out.push(`<div class="runs">`
      + `<p class="rhead">block ${escHtml(String(Number(i) + 1))} · ran${r.python ? ` on python ${escHtml(r.python)}` : ''}`
      + `${bad ? ` · <span class="bad">${escHtml(r.status === 'error' ? `exit ${r.exit}` : r.status)}</span>` : ''}</p>`
      + (String(r.stdout || '').trim() ? `<pre>${escHtml(r.stdout)}</pre>` : '')
      + (String(r.stderr || '').trim() ? `<pre class="rerr">${escHtml(r.stderr)}</pre>` : '')
      + (figs ? `<div class="figs">${figs}</div>` : '')
      + `</div>`);
  }
  return out.join('');
}

function msgHtml(m, ctx) {
  const author = String(m.author || '');
  const cls = AGENTS.has(author) ? ` ${author}` : '';
  if (m.kind === 'tools') {
    return `<details class="tools"><summary>${escHtml(author)} explored</summary>`
      + `<pre>${escHtml(m.text)}</pre></details>`;
  }
  // A capped answer with a longer version behind it: the head reads as the
  // whole reply and the tail sits under a <details> — no script needed, which
  // is the reading room's whole rule. The marker itself is never shown.
  const cut = splitMore(m.text);
  const body = cut.more
    ? `<pre>${escHtml(cut.head)}</pre>`
      + `<details class="more"><summary>more</summary><pre>${escHtml(cut.more)}</pre></details>`
    : `<pre>${escHtml(m.text)}</pre>`;
  return `<div class="msg${cls}"><div class="by"><b>${escHtml(author)}</b> · ${escHtml(shortTime(m.ts))}</div>`
    + `${body}${runsHtml(m, ctx)}</div>`;
}

// One composer shape for both kinds of thread. Plain form POST to the JSON
// endpoints (they accept form encoding and answer with a redirect back here),
// so the reading room works with scripting switched off entirely.
// `back` is where the 303 lands afterwards — the page's own view unless the
// caller says otherwise (the library has no page view to return to).
function composer(url, key, threadId, label, back) {
  return `<form class="composer" method="POST" action="/reply">
<input type="hidden" name="url" value="${escHtml(url)}">
<input type="hidden" name="thread_id" value="${escHtml(threadId)}">
<input type="hidden" name="redirect" value="${escHtml(back || `/p/${key}`)}">
<textarea name="text" placeholder="${escHtml(label)}" aria-label="${escHtml(label)}"></textarea>
<div class="row"><button>send</button>
<p class="hint">@claude, @codex or @all to bring in the bots</p></div>
</form>`;
}

// Naming a page and filing it, from a phone. Owner-only — these are the same
// owner-only routes the drawer posts to — and form posts, like every other
// write in the reading room, so the whole view still needs no script.
function metaEdit(page, key) {
  const back = `/p/${escHtml(key)}`;
  const field = (action, name, value, label, hint) => `<form class="meta-edit" method="POST" action="${action}">
<input type="hidden" name="url" value="${escHtml(page.url)}">
<input type="hidden" name="redirect" value="${back}">
<input type="text" name="${name}" value="${escHtml(value)}" aria-label="${escHtml(label)}" placeholder="${escHtml(hint)}">
<button>${escHtml(label)}</button>
</form>`;
  return field('/rename-page', 'title', page.custom_title || '', 'rename', 'the page’s own name')
    + field('/tag-page', 'tags', tagsOf(page).join(', '), 'tags', 'comma, separated, tags');
}

// Resolve / reopen from a phone: one button, one form post, no script — the
// same /resolve the drawer calls, in the reading room's only dialect.
const resolveForm = (page, key, t) => `<form class="resolve" method="POST" action="/resolve">
<input type="hidden" name="url" value="${escHtml(page.url)}">
<input type="hidden" name="thread_id" value="${escHtml(t.id)}">
<input type="hidden" name="redirect" value="/p/${escHtml(key)}">
<input type="hidden" name="resolved" value="${t.resolved ? '' : '1'}">
<button>${t.resolved ? '↺ reopen' : '✓ resolve'}</button>
</form>`;

const threadCard = (page, key, ctx, t, i) => `<section class="card${t.resolved ? ' resolved' : ''}" id="${escHtml(t.id)}">
<blockquote${t.mark === 'strike' ? ' class="struck"' : ''}>${escHtml(t.quote)}${Number(t.page) > 0 ? `<cite> — p. ${Number(t.page)}</cite>` : ''}</blockquote>${t.mark === 'strike' ? '<span class="struck-note">a suggested deletion — this passage is struck through in the document</span>' : ''}${t.orphaned ? '<span class="orphaned">the quoted text is no longer on the page</span>' : ''}
${t.resolved && t.summary ? `<p class="digest">${escHtml(t.summary)}</p>` : ''}
${(t.msgs || []).map(m => msgHtml(m, ctx)).join('\n')}
${resolveForm(page, key, t)}
${composer(page.url, key, t.id, `reply to comment ${i + 1}…`)}
</section>`;

// WHO IS IN THIS MARGIN, for a reader with no extension. The drawer's
// commenter pills, as the only thing this scriptless view can be: a rail of
// LINKS, `?by=<handle>`, exactly as the archive filters by kind and tag. A
// filtered margin is therefore a link somebody can send.
//
// Deliberately uncoloured, unlike the drawer's pills. In the drawer a person's
// pill wears that person's own colour because their messages already do; here
// nothing is coloured by author, and inventing a second per-name hash for one
// rail would paint the same handle two different colours across the two
// surfaces — which is the bug the tag hue is duplicated byte-for-byte to avoid.
const inThread = (t, key) => (t.msgs || [])
  .some(m => m && m.kind !== 'tools' && String(m.author || '').toLowerCase() === key);
export function commentersOf(threads) {
  const seen = new Map();
  for (const t of threads || []) {
    for (const m of (t.msgs || [])) {
      if (!m || m.kind === 'tools' || !m.author) continue;
      const k = String(m.author).toLowerCase();
      if (!seen.has(k)) seen.set(k, { key: k, name: String(m.author), threads: new Set() });
      seen.get(k).threads.add(t.id);
    }
  }
  return [...seen.values()].map(c => ({ key: c.key, name: c.name, count: c.threads.size }));
}

export function pageView({ page, key, me, notice, snapshot, by = '' }) {
  const ctx = { key, owner: !!(me && me.owner) };
  const everyThread = page.threads || [];
  const who = String(by || '').toLowerCase();
  const roster = commentersOf(everyThread);
  // A name nobody has written under is not quietly ignored: it filters to
  // nothing and the empty state says so, with the way back. Same answer the
  // drawer gives — a link that shows everyone when it promised one person is
  // the more confusing of the two failures.
  const on = who;
  const all = on ? everyThread.filter(t => inThread(t, on)) : everyThread;
  // the same shape as the drawer: what still wants you, then everything you
  // have dealt with, folded away under one line. <details> is the whole of the
  // interaction — this view has no script and is not getting one.
  const threads = all.map((t, i) => (t.resolved ? '' : threadCard(page, key, ctx, t, i))).join('\n');
  const doneList = all.map((t, i) => (t.resolved ? threadCard(page, key, ctx, t, i) : '')).join('\n');
  const doneCount = all.filter(t => t.resolved).length;
  const resolved = doneCount
    ? `<details class="resolved-sec"><summary>Resolved (${doneCount})</summary>\n${doneList}\n</details>`
    : '';
  const chat = (page.page_chat || []).map(m => msgHtml(m, ctx)).join('\n');
  const name = displayTitle(page);
  const tags = tagsOf(page);
  return shell(name, `
<header>${whoBadge(me)}
<h1>${/^https?:/i.test(page.url)
  // …and a page whose identity is not an address is not a link. The library and
  // a local PDF (identified by the hash of its bytes) both live here, and a
  // heading that cannot be followed should not pretend it can be.
  ? `<a href="${escHtml(page.url)}" rel="noreferrer noopener">${escHtml(name)}</a>`
  : escHtml(name)}</h1>
<p class="sub">${escHtml(page.site || '')} · <a href="/pages">all annotated pages</a>${snapshot ? ` · <a href="/a/${escHtml(key)}">read the article ›</a>` : ''}</p>
${tags.length ? `<div class="rail tags">${tags.map(t => `<a href="/pages?tag=${encodeURIComponent(t)}" style="--th:${tagHue(t)}">${escHtml(t)}</a>`).join('')}</div>` : ''}
${me && me.owner ? metaEdit(page, key) : ''}
</header>
${notice ? `<div class="notice">${escHtml(notice)}</div>` : ''}
<h2>comments${everyThread.length ? '' : ' — none yet'}</h2>
${roster.length > 1 ? `<div class="rail by">`
  + railLink(`/p/${key}`, `All (${everyThread.length})`, !on)
  + roster.map(c => railLink(`/p/${key}?by=${encodeURIComponent(c.key)}`,
    `${c.name} (${c.count})`, c.key === on)).join('')
  + `</div>` : ''}
${threads.trim() || (on
  ? `<p class="empty">Nothing from ${escHtml(on)} on this page. <a href="/p/${escHtml(key)}">show everyone</a></p>`
  : (all.length
    ? '<p class="empty">Every comment on this page is resolved.</p>'
    : '<p class="empty">Nothing highlighted on this page yet.</p>'))}
${resolved}
<h2>page chat</h2>
<section class="card">
${chat || '<p class="empty">No general discussion of this page yet.</p>'}
${composer(page.url, key, '__page__', 'ask about this page…')}
</section>
${liveScript(page.url)}`);
}

// --- the quiz: the question vault, asked back ------------------------------
//
// It lives HERE, in the reading room, and not in the drawer — which is the
// whole point of putting it here. Review happens on a phone, on a train, away
// from the Mac the extension is installed on; the drawer cannot be there and
// this page can. It is scriptless like everything else in this room: one card,
// options that are form posts, the query string for state. With JavaScript off
// it works exactly the same, which on a train is not a hypothetical.
//
// THE READER'S ONLY DECISION IS WHICH PASSAGE BECAME A QUESTION. There is no
// setting on this page and there is not going to be one: not the format (the
// bot picks it), not the interval (SM-2 picks it), not the order (the schedule
// picks it). The filter chips are a way of LOOKING at one bank, never a way of
// filing anything into decks.
// ---- the look -------------------------------------------------------------
//
// The reading room is a LIST and reads like one: dense, sans, functional. This
// page is a single question at a time, met on a phone at the end of a day, and
// it is the only page here whose whole job is to be READ and answered. So it
// gets a look of its own — not a second product, a second register of the same
// one: the palette is the plugin's own (the clay --accent the drawer and the
// braid wear, the warm ivory ground), and everything added on top of it is
// typographic.
//
//   TYPE.  The question is set in a serif, large, with room around it — the
//   one sentence on the page that is being read rather than operated. No web
//   font is fetched: this page must work on a train with a bad connection and
//   scripting off, and Georgia (with the platform serifs behind it) is on
//   every device that will ever open it. Everything else stays in the
//   reading room's own sans, so the machinery never competes with the sentence.
//
//   COLOUR.  Right is a calm green — a confirmation, not a fanfare. Wrong is
//   WARM (a deep clay-amber), deliberately not the strikeout's red: a red line
//   in this product means "this passage should come out", a verdict is not a
//   correction, and being wrong in your own memory is the ordinary business of
//   remembering rather than an error. Both are defined for each scheme rather
//   than derived, so dark is designed and not inverted.
const QUIZ_STYLE = `
:root {
  --q-ground:#f8f4ea;              /* one shade warmer than the room's ivory */
  --q-card:#fffdf7;
  --q-line:#e6dcc9;
  --q-line-soft:rgba(148,132,105,.22);
  --q-shadow:0 1px 2px rgba(80,60,30,.05), 0 8px 24px -12px rgba(80,60,30,.18);
  --q-shadow-lift:0 1px 2px rgba(80,60,30,.06), 0 10px 22px -10px rgba(190,110,70,.28);
  --q-right:#2f7d55; --q-right-bg:rgba(85,160,115,.13); --q-right-line:rgba(60,140,95,.55);
  --q-warm:#a8552e;  --q-warm-bg:rgba(200,110,60,.11);  --q-warm-line:rgba(190,110,65,.5);
  --q-serif:Georgia,"Iowan Old Style","Palatino Linotype",Palatino,"Times New Roman",serif }
@media (prefers-color-scheme: dark) {
  :root {
    --q-ground:#191510; --q-card:#221d16; --q-line:rgba(217,119,87,.20);
    --q-line-soft:rgba(217,175,140,.14);
    --q-shadow:0 1px 2px rgba(0,0,0,.35), 0 10px 26px -14px rgba(0,0,0,.7);
    --q-shadow-lift:0 1px 2px rgba(0,0,0,.4), 0 12px 26px -12px rgba(217,119,87,.28);
    --q-right:#86c9a0; --q-right-bg:rgba(110,190,140,.14); --q-right-line:rgba(120,195,150,.45);
    --q-warm:#e79b70;  --q-warm-bg:rgba(224,140,90,.12);   --q-warm-line:rgba(224,140,90,.42) }
}
body { background:var(--q-ground) }
main { max-width:46rem; padding:2.4rem 1.15rem 6rem }
/* ---- the identity mark: this page is its own address (memorizer.botference.com)
   and wears its own name, in the braid the extension and the reading room
   already wear. Small, quiet, and a link home. */
header.qhead { border:0; padding:0; margin:0 0 1.8rem }
.qhead h1 { margin:0; font-size:1rem; font-weight:400 }
.qhead .who { float:none; display:block; text-align:right; font-size:.72rem; margin:0 0 .5rem }
.mark .wm { white-space:nowrap }
.mark { display:flex; align-items:center; gap:.55rem; color:var(--fg) }
.mark:hover { text-decoration:none; color:var(--accent) }
.mark img { width:26px; height:26px; border-radius:7px; flex:0 0 auto }
.mark .wm { font:600 1.02rem/1 var(--q-serif); letter-spacing:.01em }
.mark .wm i { font-style:normal; color:var(--muted); font-weight:400 }
.qhead .sub { margin:.55rem 0 0; font-size:.78rem }
/* ---- the rail, in this page's register: quieter chips, wider gaps */
.rail { gap:.4rem; margin:0 0 1.1rem }
.rail a { padding:.28rem .7rem; font-size:.76rem; background:var(--q-card);
  border-color:var(--q-line) }
.rail .n { opacity:.55; font-variant-numeric:tabular-nums }
/* "you have got this one wrong before" — a dot in the warm colour, never the
   ✗ the reading room uses: an ✗ beside a count reads as a way to dismiss the
   chip, and there is nothing here to dismiss. The title says the number. */
.rail a.weak::after { content:"●"; margin-left:.3rem; font-size:.5em;
  vertical-align:.35em; color:var(--q-warm) }
.score { color:var(--muted); font-size:.76rem; margin:0 0 1.1rem;
  letter-spacing:.02em; font-variant-numeric:tabular-nums }
.score b { color:var(--fg); font-weight:600 }
/* ---- THE TWO COLUMNS.
   On a wide screen the question stays where it is and everything the answer
   brought with it — the why, the passage it came from, who wrote the card —
   sits BESIDE it, as margin notes sit beside a manuscript. That is not a
   decoration: this product is built on comments in a margin, and the guidance
   about a question belongs in the same place as the guidance about a sentence.
   The column is reserved in every state, so revealing an answer never moves
   the question the reader is still looking at.
   On a phone there is no margin, so the same cards STACK under the options —
   met in reading order (question, your answer, why, where it came from) with
   the action bar pinned to the bottom of the screen, because 'next' has to be
   under the thumb while the eye is still on the explanation. */
.qwrap { display:grid; gap:1rem; align-items:start }
@media (min-width:62rem) {
  main { max-width:70rem }
  .qwrap { grid-template-columns:minmax(0,1fr) 21rem; gap:1.6rem;
    grid-template-areas:"card margin" "acts margin" }
  .qcard { grid-area:card } .qmargin { grid-area:margin } .qacts { grid-area:acts }
  .qmargin { position:sticky; top:1.6rem }
}
.qcard { background:var(--q-card); border:1px solid var(--q-line); border-radius:16px;
  padding:1.6rem 1.5rem 1.35rem; margin:0; box-shadow:var(--q-shadow) }
@media (max-width:30rem) { .qcard { padding:1.25rem 1.05rem 1.1rem } }
.qq { font:1.34rem/1.42 var(--q-serif); margin:0 0 1.35rem; overflow-wrap:anywhere;
  letter-spacing:.005em }
@media (min-width:62rem) { .qq { font-size:1.5rem } }
/* One tap per answer, and a target big enough to hit without looking. The
   options are the only buttons on this page that are not accent-filled: four
   filled blocks would read as four ways to send rather than four answers. */
form.opt { margin:0 0 .55rem }
form.opt button, .optrow { display:flex; width:100%; text-align:left; gap:.75rem;
  align-items:baseline; padding:.8rem .95rem; font:inherit; font-size:.95rem;
  line-height:1.45; color:var(--fg); background:transparent;
  border:1px solid var(--q-line); border-radius:12px; cursor:pointer;
  transition:border-color .12s ease, background .12s ease, box-shadow .12s ease }
form.opt button:hover { background:var(--q-card); border-color:var(--accent);
  box-shadow:var(--q-shadow-lift) }
form.opt button:active { transform:translateY(1px) }
.optrow { cursor:default; margin:0 0 .55rem }
.optrow.right { border-color:var(--q-right-line); background:var(--q-right-bg) }
.optrow.wrong { border-color:var(--q-warm-line); background:var(--q-warm-bg) }
/* the letter, in a ring: an index, never a fifth thing to press */
.ol { flex:0 0 1.55rem; height:1.55rem; display:inline-flex; align-items:center;
  justify-content:center; border-radius:50%; border:1px solid var(--q-line-soft);
  color:var(--muted); font-size:.72rem; font-weight:600; letter-spacing:.03em;
  align-self:flex-start; margin-top:-.05rem }
.optrow.right .ol { color:var(--q-right); border-color:var(--q-right-line) }
.optrow.wrong .ol { color:var(--q-warm); border-color:var(--q-warm-line) }
/* the verdict is a small line ABOVE the question, not a banner over it: the
   card the reader is looking at is still the question */
.verdict { font-size:.72rem; font-weight:600; margin:0 0 .8rem;
  text-transform:uppercase; letter-spacing:.1em; display:flex; align-items:center; gap:.4rem }
.verdict.right { color:var(--q-right) }
.verdict.wrong { color:var(--q-warm) }
/* ---- the margin cards. One label, one thing said. The hairline down the left
   is the manuscript-margin idiom the drawer uses for a thread. */
.mcard { background:var(--q-card); border:1px solid var(--q-line); border-left:2px solid var(--q-line-soft);
  border-radius:4px 12px 12px 4px; padding:.85rem .95rem; margin:0 0 .75rem;
  box-shadow:var(--q-shadow) }
.mcard h3 { margin:0 0 .45rem; font-size:.66rem; font-weight:600; color:var(--muted);
  text-transform:uppercase; letter-spacing:.11em }
.mcard p { margin:0; font-size:.88rem; line-height:1.55; overflow-wrap:anywhere }
.mcard.why { border-left-color:var(--accent) }
.mcard.why p { font-family:var(--q-serif); font-size:.95rem }
.mcard.src { border-left-color:var(--q-line-soft) }
.mcard.src blockquote { margin:0 0 .55rem; font:.86rem/1.55 var(--q-serif);
  padding:.1rem 0 .1rem .7rem; background:transparent; border-left:2px solid var(--q-warm-line);
  border-radius:0; color:var(--fg) }
.mcard.src cite { color:var(--muted); font-style:normal; font-size:.8rem }
.mcard .meta { color:var(--muted); font-size:.75rem; line-height:1.6; overflow-wrap:anywhere }
/* who wrote the card. The rule stays neutral — the one cool colour on this
   page would be the only thing on it that is not the plugin's own clay — and
   the bot's name carries its own colour instead, as it does in the drawer. */
.mcard.bot { border-left-color:var(--q-line-soft) }
.mcard.bot .who-wrote { font-size:.8rem; color:var(--muted) }
.mcard.bot .who-wrote b { color:var(--fg); font-weight:600 }
.mcard.bot .who-wrote b.claude { color:var(--claude) }
.mcard.bot .who-wrote b.codex { color:var(--codex) }
.mcard.attn { border-left-color:var(--q-warm) }
.mcard.attn p { color:var(--muted) }
/* ---- the action bar. On a phone it is pinned to the bottom of the screen so
   'next' stays under the thumb while the eye is still on the explanation. */
.qacts { display:flex; flex-wrap:wrap; align-items:center; gap:.7rem; margin:.9rem 0 0 }
.qacts form { margin:0 }
.qacts .flag button, .qacts .del button { background:none; color:var(--muted);
  border:1px solid var(--q-line); border-radius:999px; padding:.4rem .85rem; font-size:.76rem }
.qacts .flag button:hover, .qacts .del button:hover { color:var(--q-warm);
  border-color:var(--q-warm-line); background:none }
.qacts a.next { display:inline-block; padding:.5rem 1.3rem; border-radius:999px;
  background:var(--accent); color:#fff; font-size:.88rem; font-weight:600;
  letter-spacing:.01em; box-shadow:var(--q-shadow-lift) }
.qacts a.next:hover { background:var(--accent-hover); text-decoration:none }
@media (max-width:61.99rem) {
  /* the pinned bar is the foot of the page on a phone, so the page does not
     also need a foot of its own under it */
  main { padding-bottom:2rem }
  .qacts.pinned { position:sticky; bottom:0; margin:1rem -1.15rem 0;
    padding:.7rem 1.15rem calc(.7rem + env(safe-area-inset-bottom));
    background:color-mix(in srgb, var(--q-ground) 92%, transparent);
    backdrop-filter:blur(8px); border-top:1px solid var(--q-line-soft) }
}
/* ---- THE QUIET WAY BACK, on every card and not only a wrong one.
   The full source block is the wrong answer's own business — quote, page
   number, every link — because a bot wrote the card and a reader who has just
   been told they are wrong is owed the paragraph. This is the other, smaller
   need: 'where did this come from?', asked at any moment, answered without
   losing the sitting — hence a new window. It resolves against the live store
   at render time and simply is not drawn when the page it came from is gone.
   Same register as the drawer's own 'from a discussion · view'. */
.trace { margin:1rem 0 0; padding:.7rem 0 0; border-top:1px solid var(--q-line-soft);
  font-size:.75rem; color:var(--muted); text-align:right }
.trace a { color:var(--muted); border-bottom:1px solid var(--q-line-soft) }
.trace a:hover { color:var(--accent); border-bottom-color:var(--accent); text-decoration:none }
/* the receipt for a card just taken out of the rotation: one line, on the very
   next page, because parking a card and discarding it are different acts and a
   click that answers with a blank next question says neither */
.beat { margin:0 0 1rem; padding:.55rem .85rem; border-radius:10px;
  background:var(--q-card); border:1px solid var(--q-line);
  border-left:2px solid var(--accent); color:var(--muted); font-size:.8rem }
.qempty { text-align:center; padding:2.6rem 1.2rem }
.qempty .qq { margin:0 0 .5rem; font-size:1.18rem }
.qempty .score { margin:0 }
.qbad { border-color:var(--q-warm-line) }
.qbad .meta { color:var(--q-warm) }
`;

const OPT_LETTER = ['A', 'B', 'C', 'D', 'E'];

// WHERE IT CAME FROM — never optional on a wrong answer, and a margin card
// here: the page, the passage, and, where the card came out of an argument,
// the thread that produced it. `home` is the reading room's own origin, which
// is empty (relative) everywhere except on the vault's own hostname, where the
// reading room is a different address entirely.
function sourceHtml(card, read, home = '', trace = null) {
  const s = card.source || {};
  const key = String(s.page_key || '');
  const where = read && key ? `${home}/a/${key}` : (key ? `${home}/p/${key}` : '');
  // …and the conversation, only while there IS one: `trace` has already asked
  // the live record whether that thread survives, and a card whose discussion
  // the reader deleted must not offer a link into nothing.
  const thread = (trace && trace.thread && s.thread_id) ? `${home}/p/${key}#${s.thread_id}` : '';
  return `<section class="mcard src">
<h3>where it came from</h3>
${s.quote ? `<blockquote>${escHtml(s.quote)}${Number(s.page) > 0 ? `<cite> — p. ${Number(s.page)}</cite>` : ''}</blockquote>` : ''}
<p class="meta">${where ? `<a href="${escHtml(where)}">${escHtml(s.title || 'the page')}</a>` : escHtml(s.title || '')}${
  s.site ? ` · ${escHtml(s.site)}` : ''}${thread ? ` · <a href="${escHtml(thread)}">the conversation</a>` : ''}${
  /^https?:/i.test(String(s.url || '')) ? ` · <a href="${escHtml(s.url)}" rel="noreferrer noopener">original</a>` : ''}</p>
</section>`;
}

// THE QUIET WAY BACK, on every card in every state.
//
// The block above is what a WRONG answer is owed. This is the small, always
// available version of the same fact — one muted line, opened in a new window
// so that following it does not cost the sitting. `trace` is resolved by the
// caller against the live store (server.mjs traceOf) and comes in three
// states, which is the whole of the contract: the discussion that produced the
// card if it is still there, the page if only that survives, and NOTHING at
// all if the page itself is gone. A card's thread id is a soft link by design
// — the same design `from_thread` has on a strikeout — so a dangling one drops
// the affordance rather than offering a dead link.
function traceHtml(trace) {
  if (!trace || !trace.href) return '';
  const what = trace.thread ? 'from a discussion' : 'from a page you read';
  return `<p class="trace">${escHtml(what)} · <a href="${escHtml(trace.href)}" target="_blank"`
    + ` rel="noopener noreferrer" title="${escHtml(trace.title || 'the source')} — opens in a new window">trace ↗</a></p>`;
}

const scopeFields = scope => `<input type="hidden" name="project" value="${escHtml(scope.project || '')}">`
  + `<input type="hidden" name="tag" value="${escHtml(scope.tag || '')}">`;

const quizHref = (scope, extra = {}) => {
  const q = new URLSearchParams();
  if (scope.project) q.set('project', scope.project);
  if (scope.tag) q.set('tag', scope.tag);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  const s = q.toString();
  return `/quiz${s ? `?${s}` : ''}`;
};

export function quizView({ me, card, reveal, session, counts, facets, scope = {},
                           read = false, trace = null, home = '', gone = '' }) {
  const sc = { project: scope.project || '', tag: scope.tag || '' };
  // The rail: one bank, seen from an angle. Each chip carries how many of that
  // topic are due, and wears a ✗ where the reader has lapsed on it — which is
  // the cheapest honest answer to "where am I weak".
  const chip = (kind, row) => {
    const on = sc[kind] === row.id;
    const to = quizHref(kind === 'project'
      ? { project: on ? '' : row.id, tag: sc.tag }
      : { project: sc.project, tag: on ? '' : row.id });
    const cls = [on ? 'on' : '', row.lapses ? 'weak' : ''].filter(Boolean).join(' ');
    // the ✗ is the only analytics here and it is one number: how many times
    // this topic has been got wrong. It says where to revise deliberately.
    const why = `${row.due} due of ${row.count}`
      + (row.lapses ? ` · got wrong ${row.lapses} time${row.lapses === 1 ? '' : 's'}` : '');
    return `<a href="${escHtml(to)}"${cls ? ` class="${cls}"` : ''}${on ? ' aria-current="true"' : ''}`
      + ` title="${escHtml(why)}"${kind === 'tag' ? ` style="--th:${tagHue(row.id)}"` : ''}>${escHtml(row.id)}`
      + `<span class="n"> ${row.due}</span></a>`;
  };
  const projects = (facets && facets.projects) || [];
  const tags = (facets && facets.tags) || [];
  const rail = (projects.length || tags.length)
    ? `<div class="rail">${railLink(quizHref({}), `Everything (${counts.due})`, !sc.project && !sc.tag)}`
      + projects.map(p => chip('project', p)).join('') + `</div>`
      + (tags.length ? `<div class="rail tags">${tags.map(t => chip('tag', t)).join('')}</div>` : '')
    : '';
  const score = session && session.asked
    ? `<p class="score"><b>${session.right}</b> right · <b>${session.wrong}</b> wrong · ${session.left} left in this sitting</p>`
    : `<p class="score"><b>${counts.due}</b> due${counts.live ? ` of ${counts.live}` : ''}${
      counts.pending ? ` · ${counts.pending} being written` : ''}${
      counts.failed ? ` · ${counts.failed} failed` : ''}${
      counts.flagged ? ` · ${counts.flagged} flagged` : ''}</p>`;

  // The failures, if any: a generation that went wrong is a row the reader can
  // see and remove, never a click that silently did nothing. It is a margin
  // card like everything else that is ABOUT the sitting rather than in it.
  const broken = (((counts.failed || 0) + (counts.flagged || 0)) > 0 && !reveal)
    ? `<section class="mcard attn"><h3>needs attention</h3><p>${
      counts.failed ? `${counts.failed} question${counts.failed === 1 ? '' : 's'} could not be written` : ''}${
      counts.failed && counts.flagged ? ' and ' : ''}${
      counts.flagged ? `${counts.flagged} you flagged as wrong` : ''}. They are out of the rotation.</p></section>`
    : '';

  let card_, margin, acts;
  if (reveal && card) {
    const right = !!reveal.correct;
    card_ = `<section class="qcard">
<p class="verdict ${right ? 'right' : 'wrong'}"><span aria-hidden="true">${right ? '✓' : '✗'}</span> ${
  right ? 'right' : 'not quite'}</p>
<p class="qq">${escHtml(card.question)}</p>
${(card.options || []).map((o, i) => {
      const cls = i === card.answer ? ' right' : (i === reveal.choice ? ' wrong' : '');
      return `<div class="optrow${cls}"><span class="ol">${OPT_LETTER[i] || ''}</span><span>${escHtml(o)}</span></div>`;
    }).join('\n')}
${traceHtml(trace)}</section>`;
    // THE MARGIN. On a wide screen these sit beside the question, which stays
    // exactly where it was; on a phone they stack under it, in the order they
    // are read — why first, then the passage it was made from.
    margin = `<aside class="qmargin">
${card.why ? `<section class="mcard why"><h3>why</h3><p>${escHtml(card.why)}</p></section>` : ''}
${sourceHtml(card, read, home, trace)}
${card.model || card.hint ? `<section class="mcard bot"><h3>the card</h3>
${card.hint ? `<p>${escHtml(card.hint)}</p>` : ''}
${card.model ? `<p class="who-wrote">written by <b class="${
  card.model === 'codex' ? 'codex' : 'claude'}">${escHtml(card.model)}</b></p>` : ''}</section>` : ''}
</aside>`;
    // TWO WAYS A CARD LEAVES, and they are different acts. "Seems wrong"
    // PARKS it — out of rotation, everything kept, waiting to be rewritten,
    // because a bot wrote this and the reader disagreeing is a complaint about
    // the card and not about the passage they chose to remember. "Discard"
    // DROPS it: this was not worth remembering after all, and the row goes for
    // good. Both sit well under the answer, quiet, so that nothing here
    // competes with reading the explanation.
    acts = `<div class="qacts pinned"><a class="next" href="${escHtml(quizHref(sc))}">next ›</a>
<form class="flag" method="POST" action="/quiz-flag">${scopeFields(sc)}
<input type="hidden" name="id" value="${escHtml(card.id)}">
<button>seems wrong</button></form>
<form class="del" method="POST" action="/quiz-delete">${scopeFields(sc)}
<input type="hidden" name="id" value="${escHtml(card.id)}">
<button title="drop this question for good — it leaves the vault">discard</button></form></div>`;
  } else if (card) {
    card_ = `<section class="qcard">
<p class="qq">${escHtml(card.question)}</p>
${(card.options || []).map((o, i) => `<form class="opt" method="POST" action="/quiz-answer">${scopeFields(sc)}
<input type="hidden" name="id" value="${escHtml(card.id)}">
<input type="hidden" name="choice" value="${i}">
<button><span class="ol">${OPT_LETTER[i] || ''}</span><span>${escHtml(o)}</span></button></form>`).join('\n')}
${traceHtml(trace)}</section>`;
    // The margin column is RESERVED even with nothing in it, so that answering
    // does not shift the question the reader is still looking at.
    margin = `<aside class="qmargin">${broken}</aside>`;
    acts = '';
  } else {
    // Nothing due is the ordinary, healthy state of a vault, and it should read
    // as one — not as an error and not as an invitation to go and make work.
    const filtered = !!(sc.project || sc.tag);
    const line = (filtered && !counts.total) ? 'Nothing filed under this filter.'
      : (counts.live && !counts.due) ? 'Nothing due. Everything you have filed is still fresh.'
        : (counts.total ? 'Nothing due under this filter.'
          : 'No questions yet. Highlight something worth remembering and press ? in the drawer.');
    card_ = `<section class="qcard qempty"><p class="qq">${line}</p>
<p class="score">${counts.live} question${counts.live === 1 ? '' : 's'} in the vault${
  counts.pending ? ` · ${counts.pending} being written` : ''}.${
  filtered ? ` <a href="${escHtml(quizHref({}))}">show everything ›</a>` : ''}</p></section>`;
    margin = `<aside class="qmargin">${broken}</aside>`;
    acts = '';
  }

  // The name of the thing, in the braid the drawer and the reading room wear.
  // This page has an address of its own (memorizer.botference.com) and is the
  // only surface here that is a product rather than a view of the workspace.
  return shell('Memorizer — botference', `
<header class="qhead">${whoBadge(me)}
<h1><a class="mark" href="${escHtml(home || '/')}"><img src="/favicon.ico" alt="" width="26" height="26">
<span class="wm">memorize<i> · botference</i></span></a></h1>
<p class="sub">what you asked to be reminded of · <a href="${escHtml(home)}/pages">the reading room</a></p>
</header>
${rail}
${gone ? `<p class="beat">${gone === 'discarded'
    ? 'Discarded — that question has left the vault.'
    : 'Parked — that card stops being asked until it is rewritten.'}</p>` : ''}
${score}
<div class="qwrap">
${card_}
${margin}
${acts}
</div>`, QUIZ_STYLE);
}

// --- the article view: the review-doc experience, for any article ---------
// /p/<key> is the conversation; this is the PAGE, with the highlights painted
// where they were made. The prose is the sanitized snapshot the extension
// captured (sanitize.mjs); the painting, the anchoring and the making of new
// highlights are all done in the browser by the extension's OWN anchor.js,
// served from /assets — so a highlight made on a phone is the same kind of
// object, anchored by the same code, as one made in the drawer on the Mac.
const ARTICLE_STYLE = `
/* a phone is the point of this view: nothing may push the page sideways */
html, body { max-width:100%; overflow-x:hidden }
.bar { position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:.6rem;
  max-width:100%; padding:.55rem .8rem; background:var(--card);
  border-bottom:1px solid var(--line) }
.bar .t { flex:1 1 auto; min-width:0; font-weight:600; font-size:.9rem;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.bar a, .bar button.link { flex:0 0 auto; color:var(--accent); background:none; border:none;
  padding:0; font:inherit; font-size:.8rem; cursor:pointer; white-space:nowrap }
.bar button.pill { flex:0 0 auto; padding:.25rem .6rem; font-size:.78rem; border-radius:999px }
article { max-width:min(42rem, 100%); margin:0 auto; padding:1.2rem 1.1rem 60vh;
  overflow-wrap:anywhere }
article img { max-width:100%; height:auto }
article pre { overflow-x:auto }
article table { display:block; overflow-x:auto; border-collapse:collapse }
article td, article th { border:1px solid var(--line); padding:.3rem .5rem }
article h1,article h2,article h3 { line-height:1.25 }
#bfp-pill { position:fixed; z-index:20; transform:translate(-50%,-115%);
  padding:.35rem .75rem; border-radius:999px; box-shadow:0 2px 10px rgba(0,0,0,.25) }
#bfp-sheet { position:fixed; left:0; right:0; bottom:0; z-index:30; max-height:72vh;
  display:flex; flex-direction:column; background:var(--card);
  border-top:1px solid var(--line); border-radius:14px 14px 0 0;
  box-shadow:0 -4px 24px rgba(0,0,0,.22); transform:translateY(101%);
  transition:transform .18s ease }
#bfp-sheet.open { transform:translateY(0) }
#bfp-sheet .head { display:flex; align-items:center; gap:.6rem; padding:.7rem .9rem .4rem }
#bfp-sheet .head .h { flex:1; font-size:.8rem; color:var(--muted);
  text-transform:uppercase; letter-spacing:.06em }
#bfp-sheet .body { overflow-y:auto; padding:0 .9rem .9rem }
#bfp-sheet blockquote { font-size:.88rem }
.chip { display:inline-block; font-size:.75rem; color:var(--muted); margin:.4rem 0 0 }
.x { background:none; border:none; color:var(--muted); font-size:1.2rem; cursor:pointer; padding:0 .2rem }
.none { padding:2.5rem 1.1rem; text-align:center; color:var(--muted) }
.none p { max-width:26rem; margin:0 auto .6rem }
/* a plot is unreadable at thumbnail size on a phone: tapping one fills the
   screen with it, and anything (tap, Esc, back) closes it again */
#bfp-light { position:fixed; inset:0; z-index:40; display:none; align-items:center;
  justify-content:center; padding:1rem; background:rgba(0,0,0,.82) }
#bfp-light.open { display:flex }
#bfp-light img { max-width:100%; max-height:100%; background:#fff; border-radius:6px }
`;

const jsonScript = (id, data, nonce) =>
  `<script type="application/json" id="${id}" nonce="${escHtml(nonce)}">`
  + JSON.stringify(data).replace(/</g, '\\u003c') + '</script>';

export function articleView({ page, key, me, snapshot, info, nonce }) {
  const n = escHtml(nonce);
  const head = `<div class="bar"><a href="/pages">‹ pages</a>
<span class="t">${escHtml(displayTitle(page))}</span>
<button class="pill" id="bfp-chat">chat</button>
${me.owner ? '<button class="pill" id="bfp-export">export</button>' : ''}
<a href="/p/${escHtml(key)}">list</a></div>`;

  // A page annotated before snapshots existed has no article to show. Say so
  // in one line, offer the conversation, and name the one thing that fixes it.
  const body = snapshot
    ? `<article id="bfp-article">${snapshot}</article>`
    : `<div class="none"><p>No readable copy of this article has been captured yet, so there
is nothing to mark up here.</p><p>Open it once on the Mac with the extension running and the
companion will keep a copy — after that this page works from anywhere.</p>
<p><a href="/p/${escHtml(key)}">read the comments instead ›</a></p></div>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(displayTitle(page))}</title>${FAVICON_LINK}
<style nonce="${n}">${STYLE}${ARTICLE_STYLE}</style></head><body>
${head}${body}
<button id="bfp-pill" hidden>comment</button>
<div id="bfp-light" role="dialog" aria-label="figure"></div>
<div id="bfp-sheet" aria-live="polite"><div class="head"><span class="h"></span>
<button class="x" id="bfp-close" aria-label="close">×</button></div>
<div class="body"></div></div>
${jsonScript('bfp-data', {
    url: page.url, key, me: { handle: me.handle, owner: !!me.owner },
    threads: page.threads || [], page_chat: page.page_chat || [],
    snapshot: !!snapshot, captured_at: (info && info.captured_at) || null,
  }, nonce)}
${snapshot ? `<script src="/assets/anchor.js" nonce="${n}"></script>
<script src="/assets/reader.js" nonce="${n}"></script>` : ''}
</body></html>`;
}

// The reading room's filters are the query string, and nothing else: ?kind=pdf,
// ?tag=quantum, or both. That keeps this page scriptless (a filter survives
// with JavaScript off), makes a filtered archive a link worth sending, and
// matches the drawer's chips one for one.
const KIND_LABEL = { article: 'Articles', pdf: 'PDFs', gdocs: 'Docs' };
export const rowKind = row =>
  (PAGE_KINDS.includes(String(row && row.kind)) ? row.kind : inferKind(row && row.url));
const rowTags = row => (Array.isArray(row && row.tags) ? row.tags : []);
// WHERE a row's document is, in the slot that usually holds a url. A local
// PDF's identity is the hash of its bytes — 64 characters that mean nothing to
// anybody, and deliberately say nothing about where the file is — so the row
// says the one true thing about its whereabouts instead.
export const rowAddress = url =>
  (/^bfp-pdf:/i.test(String(url || '')) ? 'on your Mac' : String(url || ''));
const filterHref = (kind, tag) => {
  const q = new URLSearchParams();
  if (kind) q.set('kind', kind);
  if (tag) q.set('tag', tag);
  const s = q.toString();
  return '/pages' + (s ? `?${s}` : '');
};
// `hue` is only ever set for tag links: a tag wears its own color everywhere
const railLink = (href, label, on, hue) =>
  `<a href="${escHtml(href)}"${on ? ' class="on" aria-current="true"' : ''}`
  + `${hue == null ? '' : ` style="--th:${hue}"`}>${escHtml(label)}</a>`;

export function pagesView({ index, me, snapshots, library, libraryKey, kind = '', tag = '', due = 0 }) {
  const has = k => !!(snapshots && snapshots.has && snapshots.has(k));
  const wantKind = PAGE_KINDS.includes(String(kind)) ? String(kind) : '';
  const wantTag = String(tag || '').trim();
  // The library is a conversation, not a page you can visit — it is the thread
  // at the top of this view, so it never appears as a row in the list below it.
  const all = Object.entries(index || {})
    .filter(([, row]) => row && row.url !== LIBRARY_URL)
    .sort((a, b) => String(b[1].updated_at || '').localeCompare(String(a[1].updated_at || '')));
  const kept = all.filter(([, row]) =>
    (!wantKind || rowKind(row) === wantKind)
    && (!wantTag || rowTags(row).some(t => t.toLowerCase() === wantTag.toLowerCase())));
  const counts = new Map();
  for (const [, row] of all) counts.set(rowKind(row), (counts.get(rowKind(row)) || 0) + 1);
  const kinds = PAGE_KINDS.filter(k => counts.has(k) || wantKind === k);
  const kindRail = kinds.length > 1
    ? `<div class="rail">${railLink(filterHref('', wantTag), `All (${all.length})`, !wantKind)}`
      + kinds.map(k => railLink(filterHref(k, wantTag), `${KIND_LABEL[k]} (${counts.get(k) || 0})`, wantKind === k)).join('')
      + `</div>` : '';
  const tagNames = new Map();
  for (const [, row] of all) {
    for (const t of rowTags(row)) if (!tagNames.has(t.toLowerCase())) tagNames.set(t.toLowerCase(), t);
  }
  const tagRail = tagNames.size
    ? `<div class="rail tags">${[...tagNames.values()].sort((a, b) => a.localeCompare(b))
      .map(t => railLink(filterHref(wantKind, t.toLowerCase() === wantTag.toLowerCase() ? '' : t),
        t, t.toLowerCase() === wantTag.toLowerCase(), tagHue(t))).join('')}</div>` : '';
  const rows = kept
    // A row whose article we hold opens the article itself; one we do not
    // still opens its conversation, which is all there has ever been.
    .map(([key, row]) => `<li><a href="${has(key) ? '/a/' : '/p/'}${escHtml(key)}">${escHtml(row.title || row.url)}</a>
<div class="meta">${escHtml(rowAddress(row.url))} · ${escHtml(KIND_LABEL[rowKind(row)].replace(/s$/, '').toLowerCase())} · ${Number(row.threads) || 0} highlight${Number(row.threads) === 1 ? '' : 's'}${row.has_session ? ' · bot chat' : ''} · ${escHtml(shortTime(row.updated_at))}${has(key) ? ` · <a href="/p/${escHtml(key)}">comments</a>` : ''}</div>${
  rowTags(row).length ? `<div class="meta tags">${rowTags(row).map(t => `<a href="${escHtml(filterHref(wantKind, t))}" style="--th:${tagHue(t)}">${escHtml(t)}</a>`).join(' ')}</div>` : ''
}</li>`)
    .join('\n');
  // the same conversation the drawer shows above its own list, with the phone's
  // form-post composer instead of the optimistic one — reading it needs no
  // rights beyond seeing this page, and asking follows the ordinary grant rules
  const libCtx = { key: libraryKey || '', owner: !!(me && me.owner) };
  const chat = (library && (library.page_chat || []).map(m => msgHtml(m, libCtx)).join('\n')) || '';
  const lib = `<h2>library</h2>
<section class="card">
${chat || '<p class="empty">Nothing asked about the archive yet.</p>'}
${composer(LIBRARY_URL, libraryKey || '', PAGE_CHAT, 'ask about everything you’ve read…', '/pages')}
</section>`;
  return shell('Botference Discuss', `
<header>${whoBadge(me)}
<h1>Botference Discuss</h1>
<p class="sub">everything highlighted and discussed in this workspace${
  // The quiz is the owner's own memory, so it is advertised to nobody else —
  // and it says how many are waiting, because "6 due" is the only thing that
  // ever gets anybody to open it.
  me && me.owner ? ` · <a href="/quiz">quiz${due ? ` (${due} due)` : ''} ›</a>` : ''}</p>
</header>
${lib}
<h2>pages${wantKind || wantTag ? ` — ${kept.length} of ${all.length}` : ''}</h2>
${kindRail}${tagRail}
${rows ? `<ul class="pages">${rows}</ul>`
    : (all.length
      ? `<p class="empty">Nothing here under this filter — <a href="/pages">show everything</a>.</p>`
      : '<p class="empty">No pages have been annotated yet.</p>')}
${liveScript(LIBRARY_URL)}`);
}
