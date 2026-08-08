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
`;

const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><style>${STYLE}</style></head><body>
<main>${body}</main></body></html>`;

const whoBadge = me => `<span class="who">${escHtml(me.handle || 'guest')}${me.owner ? ' · owner' : ''}</span>`;

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

function msgHtml(m) {
  const author = String(m.author || '');
  const cls = AGENTS.has(author) ? ` ${author}` : '';
  if (m.kind === 'tools') {
    return `<details class="tools"><summary>${escHtml(author)} explored</summary>`
      + `<pre>${escHtml(m.text)}</pre></details>`;
  }
  return `<div class="msg${cls}"><div class="by"><b>${escHtml(author)}</b> · ${escHtml(shortTime(m.ts))}</div>`
    + `<pre>${escHtml(m.text)}</pre></div>`;
}

// One composer shape for both kinds of thread. Plain form POST to the JSON
// endpoints (they accept form encoding and answer with a redirect back here),
// so the reading room works with scripting switched off entirely.
function composer(url, key, threadId, label) {
  return `<form class="composer" method="POST" action="/reply">
<input type="hidden" name="url" value="${escHtml(url)}">
<input type="hidden" name="thread_id" value="${escHtml(threadId)}">
<input type="hidden" name="redirect" value="/p/${escHtml(key)}">
<textarea name="text" placeholder="${escHtml(label)}" aria-label="${escHtml(label)}"></textarea>
<div class="row"><button>send</button>
<p class="hint">@claude, @codex or @all to bring in the bots</p></div>
</form>`;
}

export function pageView({ page, key, me, notice }) {
  const threads = (page.threads || []).map((t, i) => `<section class="card" id="${escHtml(t.id)}">
<blockquote>${escHtml(t.quote)}</blockquote>${t.orphaned ? '<span class="orphaned">the quoted text is no longer on the page</span>' : ''}
${(t.msgs || []).map(msgHtml).join('\n')}
${composer(page.url, key, t.id, `reply to comment ${i + 1}…`)}
</section>`).join('\n');
  const chat = (page.page_chat || []).map(msgHtml).join('\n');
  return shell(page.title || page.url, `
<header>${whoBadge(me)}
<h1><a href="${escHtml(page.url)}" rel="noreferrer noopener">${escHtml(page.title || page.url)}</a></h1>
<p class="sub">${escHtml(page.site || '')} · <a href="/pages">all annotated pages</a></p>
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

export function pagesView({ index, me }) {
  const rows = Object.entries(index || {})
    .sort((a, b) => String(b[1].updated_at || '').localeCompare(String(a[1].updated_at || '')))
    .map(([key, row]) => `<li><a href="/p/${escHtml(key)}">${escHtml(row.title || row.url)}</a>
<div class="meta">${escHtml(row.url)} · ${Number(row.threads) || 0} highlight${Number(row.threads) === 1 ? '' : 's'}${row.has_session ? ' · bot chat' : ''} · ${escHtml(shortTime(row.updated_at))}</div></li>`)
    .join('\n');
  return shell('Annotated pages', `
<header>${whoBadge(me)}
<h1>Annotated pages</h1>
<p class="sub">everything highlighted and discussed in this workspace</p>
</header>
${rows ? `<ul class="pages">${rows}</ul>` : '<p class="empty">No pages have been annotated yet.</p>'}`);
}
