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

const AGENTS = new Set(['claude', 'codex']);
const shortTime = ts => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
};

const STYLE = `
:root { --bg:#faf7f0; --fg:#2a2419; --muted:#8a7f6d; --card:#fff; --line:#e7dfd1;
  --accent:#d97757; --accent-hover:#c05f3f; --claude:#d97757; --codex:#4a86c8;
  --quote:#f3ede1 }
@media (prefers-color-scheme: dark) {
  :root { --bg:#1a1712; --fg:#e8dfd1; --muted:#9c917e; --card:#241f18;
    --line:rgba(217,119,87,.24); --accent-hover:#e8896d; --quote:#1f1b15 }
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
form.composer { margin:.9rem 0 0; display:flex; flex-direction:column; gap:.5rem }
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
ul.pages .tags { margin-top:.25rem }
ul.pages .tags a { font-size:.72rem; color:var(--muted); border-bottom:1px dotted var(--line) }
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

const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><style>${STYLE}</style></head><body>
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
  return `<div class="msg${cls}"><div class="by"><b>${escHtml(author)}</b> · ${escHtml(shortTime(m.ts))}</div>`
    + `<pre>${escHtml(m.text)}</pre>${runsHtml(m, ctx)}</div>`;
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

export function pageView({ page, key, me, notice, snapshot }) {
  const ctx = { key, owner: !!(me && me.owner) };
  const threads = (page.threads || []).map((t, i) => `<section class="card" id="${escHtml(t.id)}">
<blockquote>${escHtml(t.quote)}${Number(t.page) > 0 ? `<cite> — p. ${Number(t.page)}</cite>` : ''}</blockquote>${t.orphaned ? '<span class="orphaned">the quoted text is no longer on the page</span>' : ''}
${(t.msgs || []).map(m => msgHtml(m, ctx)).join('\n')}
${composer(page.url, key, t.id, `reply to comment ${i + 1}…`)}
</section>`).join('\n');
  const chat = (page.page_chat || []).map(m => msgHtml(m, ctx)).join('\n');
  const name = displayTitle(page);
  const tags = tagsOf(page);
  return shell(name, `
<header>${whoBadge(me)}
<h1><a href="${escHtml(page.url)}" rel="noreferrer noopener">${escHtml(name)}</a></h1>
<p class="sub">${escHtml(page.site || '')} · <a href="/pages">all annotated pages</a>${snapshot ? ` · <a href="/a/${escHtml(key)}">read the article ›</a>` : ''}</p>
${tags.length ? `<div class="rail tags">${tags.map(t => `<a href="/pages?tag=${encodeURIComponent(t)}">${escHtml(t)}</a>`).join('')}</div>` : ''}
${me && me.owner ? metaEdit(page, key) : ''}
</header>
${notice ? `<div class="notice">${escHtml(notice)}</div>` : ''}
<h2>comments${(page.threads || []).length ? '' : ' — none yet'}</h2>
${threads || '<p class="empty">Nothing highlighted on this page yet.</p>'}
<h2>page chat</h2>
<section class="card">
${chat || '<p class="empty">No general discussion of this page yet.</p>'}
${composer(page.url, key, '__page__', 'ask about this page…')}
</section>
${liveScript(page.url)}`);
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
<title>${escHtml(displayTitle(page))}</title>
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
const filterHref = (kind, tag) => {
  const q = new URLSearchParams();
  if (kind) q.set('kind', kind);
  if (tag) q.set('tag', tag);
  const s = q.toString();
  return '/pages' + (s ? `?${s}` : '');
};
const railLink = (href, label, on) =>
  `<a href="${escHtml(href)}"${on ? ' class="on" aria-current="true"' : ''}>${escHtml(label)}</a>`;

export function pagesView({ index, me, snapshots, library, libraryKey, kind = '', tag = '' }) {
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
        t, t.toLowerCase() === wantTag.toLowerCase())).join('')}</div>` : '';
  const rows = kept
    // A row whose article we hold opens the article itself; one we do not
    // still opens its conversation, which is all there has ever been.
    .map(([key, row]) => `<li><a href="${has(key) ? '/a/' : '/p/'}${escHtml(key)}">${escHtml(row.title || row.url)}</a>
<div class="meta">${escHtml(row.url)} · ${escHtml(KIND_LABEL[rowKind(row)].replace(/s$/, '').toLowerCase())} · ${Number(row.threads) || 0} highlight${Number(row.threads) === 1 ? '' : 's'}${row.has_session ? ' · bot chat' : ''} · ${escHtml(shortTime(row.updated_at))}${has(key) ? ` · <a href="/p/${escHtml(key)}">comments</a>` : ''}</div>${
  rowTags(row).length ? `<div class="meta tags">${rowTags(row).map(t => `<a href="${escHtml(filterHref(wantKind, t))}">${escHtml(t)}</a>`).join(' ')}</div>` : ''
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
<p class="sub">everything highlighted and discussed in this workspace</p>
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
