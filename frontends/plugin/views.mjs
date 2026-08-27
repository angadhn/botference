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
const QUIZ_STYLE = `
.qcard { background:var(--card); border:1px solid var(--line); border-radius:12px;
  padding:1.1rem 1.1rem 1rem; margin:0 0 1rem }
.qq { font-size:1.12rem; line-height:1.45; margin:0 0 1rem; overflow-wrap:anywhere }
/* One tap per answer, and a target big enough to hit without looking. The
   options are the only buttons on this page that are not accent-filled: four
   filled blocks would read as four ways to send rather than four answers. */
form.opt { margin:0 0 .5rem }
form.opt button, .optrow { display:flex; width:100%; text-align:left; gap:.6rem;
  align-items:baseline; padding:.7rem .85rem; font:inherit; font-size:.95rem;
  color:var(--fg); background:var(--card); border:1px solid var(--line);
  border-radius:10px; cursor:pointer }
form.opt button:hover { background:var(--quote); border-color:var(--accent) }
.optrow { cursor:default; margin:0 0 .5rem }
.optrow.right { border-color:var(--done-line); background:color-mix(in srgb, var(--done) 40%, var(--card)) }
.optrow.wrong { border-color:var(--strike-line);
  background:color-mix(in srgb, var(--strike-line) 10%, var(--card)) }
.ol { flex:0 0 1.1rem; color:var(--muted); font-size:.8rem; font-weight:600 }
.optrow.right .ol, .optrow.wrong .ol { color:inherit }
.verdict { font-size:1rem; font-weight:600; margin:0 0 .7rem }
.verdict.right { color:var(--done-line) }
.verdict.wrong { color:var(--strike-line) }
.why { margin:.2rem 0 1rem; font-size:.94rem; overflow-wrap:anywhere }
/* WHERE IT CAME FROM — never optional. A bot wrote this card and the reader
   may not believe it; the passage it was made from, and the conversation it
   came out of, are one tap away from every answer. */
.src { border-top:1px solid var(--line); padding-top:.8rem; margin-top:.4rem }
.src blockquote { font-size:.86rem; margin:0 0 .5rem }
.src .meta { color:var(--muted); font-size:.76rem; overflow-wrap:anywhere }
.qacts { display:flex; flex-wrap:wrap; align-items:center; gap:.6rem; margin:1rem 0 0 }
.qacts form { margin:0 }
.qacts .flag button, .qacts .del button { background:none; color:var(--muted);
  border:1px solid var(--line); padding:.35rem .8rem; font-size:.78rem }
.qacts .flag button:hover, .qacts .del button:hover { color:var(--strike-line);
  border-color:var(--strike-line); background:none }
.qacts a.next { display:inline-block; padding:.4rem 1.1rem; border-radius:8px;
  background:var(--accent); color:#fff; font-size:.9rem }
.qacts a.next:hover { background:var(--accent-hover); text-decoration:none }
.score { color:var(--muted); font-size:.78rem }
.score b { color:var(--fg); font-weight:600 }
.rail .n { opacity:.7 }
.rail a.weak::after { content:" ✗" ; color:var(--strike-line); opacity:.9 }
.qbad { border-color:var(--strike-line) }
.qbad .meta { color:var(--strike-line) }
`;

const OPT_LETTER = ['A', 'B', 'C', 'D', 'E'];

// The one line under every card, and the reason the feature can be trusted at
// all: the page, the passage, and — where the card came out of an argument —
// the thread that produced it.
function sourceHtml(card, read) {
  const s = card.source || {};
  const key = String(s.page_key || '');
  const where = read && key ? `/a/${key}` : (key ? `/p/${key}` : '');
  const thread = s.thread_id ? `/p/${key}#${s.thread_id}` : '';
  return `<div class="src">
${s.quote ? `<blockquote>${escHtml(s.quote)}${Number(s.page) > 0 ? `<cite> — p. ${Number(s.page)}</cite>` : ''}</blockquote>` : ''}
<p class="meta">${where ? `<a href="${escHtml(where)}">${escHtml(s.title || 'the page')}</a>` : escHtml(s.title || '')}${
  s.site ? ` · ${escHtml(s.site)}` : ''}${thread ? ` · <a href="${escHtml(thread)}">the conversation</a>` : ''}${
  /^https?:/i.test(String(s.url || '')) ? ` · <a href="${escHtml(s.url)}" rel="noreferrer noopener">original</a>` : ''}${
  card.model ? ` · written by ${escHtml(card.model)}` : ''}</p>
</div>`;
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

export function quizView({ me, card, reveal, session, counts, facets, scope = {}, read = false }) {
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

  let body;
  if (reveal && card) {
    const right = !!reveal.correct;
    body = `<section class="qcard">
<p class="verdict ${right ? 'right' : 'wrong'}">${right ? '✓ Right' : '✗ Not quite'}</p>
<p class="qq">${escHtml(card.question)}</p>
${(card.options || []).map((o, i) => {
      const cls = i === card.answer ? ' right' : (i === reveal.choice ? ' wrong' : '');
      return `<div class="optrow${cls}"><span class="ol">${OPT_LETTER[i] || ''}</span><span>${escHtml(o)}</span></div>`;
    }).join('\n')}
${card.why ? `<p class="why">${escHtml(card.why)}</p>` : ''}
${sourceHtml(card, read)}
<div class="qacts"><a class="next" href="${escHtml(quizHref(sc))}">next ›</a>
<form class="flag" method="POST" action="/quiz-flag">${scopeFields(sc)}
<input type="hidden" name="id" value="${escHtml(card.id)}">
<button>this card seems wrong</button></form></div>
</section>`;
  } else if (card) {
    body = `<section class="qcard">
<p class="qq">${escHtml(card.question)}</p>
${(card.options || []).map((o, i) => `<form class="opt" method="POST" action="/quiz-answer">${scopeFields(sc)}
<input type="hidden" name="id" value="${escHtml(card.id)}">
<input type="hidden" name="choice" value="${i}">
<button><span class="ol">${OPT_LETTER[i] || ''}</span><span>${escHtml(o)}</span></button></form>`).join('\n')}
</section>`;
  } else {
    // Nothing due is the ordinary, healthy state of a vault, and it should read
    // as one — not as an error and not as an invitation to go and make work.
    body = `<section class="qcard"><p class="qq">${counts.due === 0 && counts.live
      ? 'Nothing due. Everything you have filed is still fresh.'
      : (counts.total
        ? 'Nothing due under this filter.'
        : 'No questions yet. Highlight something worth remembering and press ? in the drawer.')}</p>
<p class="score">${counts.live} question${counts.live === 1 ? '' : 's'} in the vault${
  counts.pending ? ` · ${counts.pending} being written` : ''}.</p></section>`;
  }

  // The failures, if any: a generation that went wrong is a row the reader can
  // see and remove, never a click that silently did nothing.
  const broken = (((counts.failed || 0) + (counts.flagged || 0)) > 0 && !reveal)
    ? `<h2>needs attention</h2><p class="empty">${counts.failed} question${counts.failed === 1 ? '' : 's'} could not be written`
      + `${counts.flagged ? ` and ${counts.flagged} you flagged as wrong` : ''}. They are out of the rotation.</p>`
    : '';

  return shell('Quiz', `
<header>${whoBadge(me)}
<h1>Quiz</h1>
<p class="sub">what you asked to be reminded of · <a href="/pages">all annotated pages</a></p>
</header>
${rail}
${score}
${body}
${broken}`, QUIZ_STYLE);
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
