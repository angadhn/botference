// following-view.mjs — the Following page the companion serves (GET /following).
//
// EVERYTHING FROM A REMOTE DOCUMENT IS TEXT. A blyg's title, a post's title,
// author, excerpt and addresses are somebody else's words: each is passed
// through cleanText (no control or bidirectional-override characters, bounded)
// and then HTML-escaped wherever it is written into this page. Nothing remote
// is ever put in a URL the page links to: the Open link carries only the post's
// key (hex), and the companion redirects it to the post's own page. The one
// script on the page is fixed text; it reads values from data- attributes (which
// are escaped) and builds anything it learns from the companion with
// textContent, never innerHTML.
//
// A reader's posts are not re-rendered here: an excerpt and a link, nothing more.
import { escHtml } from './hosted.mjs';
import { FILTERS, FILTER_LABELS, VIEWS, READ_STATES, cleanText, FOLLOWING_NUMBERS, INBOX_STATES, formatDate } from './following.mjs';

const t = (v, n = 300) => escHtml(cleanText(typeof v === 'string' ? v : String(v ?? ''), n));
// Dates are shown in the viewer's own style ("Nov 22, 2026" or "22 Nov 2026", set by their Accept-Language), never changing what is
// stored. The locale of the page being rendered is set once per render (rendering is synchronous).
let LOCALE = 'en-US';
const day = v => escHtml(formatDate(v, LOCALE) || '');
const when = v => escHtml(formatDate(v, LOCALE, true) || cleanText(String(v || ''), 40));
// An address as a person reads it: host and a clipped path, the whole of it in the title (a tooltip). Every part escaped.
const shortUrl = (u, n = 38) => {
  try {
    const x = new URL(String(u));
    const path = (x.pathname + x.search).replace(/\/$/, '');
    return path.length > n ? x.host + path.slice(0, n) + '\u2026' : x.host + path;
  } catch { return cleanText(String(u || ''), n); }
};
const addr = (u, n) => `<span class="addr" title="${t(String(u || ''), 500)}">${t(shortUrl(u, n), 120)}</span>`;

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#222;--mut:#6b6b6b;--line:#ddd;--card:#fff;--acc:#1b5fb4;--new:#b4361b}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e6e6e6;--mut:#9a9a9a;--line:#333;--card:#1e1e1e;--acc:#7db3f5;--new:#f0866a}}
*{box-sizing:border-box;min-width:0}html,body{max-width:100%;overflow-x:hidden}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
main{max-width:56rem;margin:0 auto;padding:1rem}
@media (min-width:1100px){main{margin:0 auto 0 clamp(1rem,3vw,3rem);max-width:50rem}}
h1{font-size:1.4rem;margin:.2rem 0}h2{font-size:1.05rem;margin:1.5rem 0 .4rem}
a{color:var(--acc)}.mut{color:var(--mut);font-size:.88em}.addr{overflow-wrap:anywhere}
nav.filters{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0}
nav.filters a{padding:.2rem .6rem;border:1px solid var(--line);border-radius:1rem;text-decoration:none;color:var(--fg)}
nav.filters a[aria-current=page]{background:var(--acc);color:var(--bg);border-color:var(--acc)}
article.entry{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:.7rem .9rem;margin:.6rem 0}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:.2rem .7rem}.title{font-weight:600;margin:.3rem 0;font-size:1.05rem}
.title a{color:inherit;text-decoration:none}.title a:hover{text-decoration:underline}
.hub-entry-actions{align-items:center}button.tick,button.star,button.untick{white-space:nowrap;min-height:2.25rem}
[data-tick=sending] button.tick,[data-tick=sending] button.star,[data-tick=sending] button.untick{opacity:.6;cursor:progress}
.aline{display:flex;flex-wrap:wrap;align-items:center;gap:.2rem .7rem;padding:.4rem .2rem;border-bottom:1px solid var(--line)}
.aline .title{margin:0;font-size:1em;flex:1 1 14rem}
.caught-up{padding:.8rem 1rem;border:1px solid var(--line);border-radius:.5rem;background:var(--card)}
.dot{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;background:var(--new)}
.kind{font-size:.7em;letter-spacing:.06em;text-transform:uppercase;padding:0 .4rem;border:1px solid var(--line);border-radius:.3rem;color:var(--mut)}
.vlines{margin:.3rem 0;font-size:.88em;color:var(--mut)}.vlines div{margin:.1rem 0}
.hub-entry-body{margin:.4rem 0;overflow-wrap:anywhere}.hub-entry-body img{max-width:100%;height:auto}
.hub-entry-body pre{overflow-x:auto;white-space:pre-wrap}.hub-entry-body table{display:block;overflow-x:auto}
.hub-quote,.hub-entry-body blockquote{margin:.6rem 0;padding:.3rem .8rem;border-left:3px solid var(--line);border-radius:.2rem;color:var(--mut)}
.rest[hidden]{display:none}.moremsg{margin-top:.2rem}
.acts{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem}.acts.right{justify-content:flex-end;align-items:center}
.src{margin-top:.4rem;font-size:.85em}
button,.btn{font:inherit;padding:.15rem .6rem;border:1px solid var(--line);border-radius:.3rem;background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none}
button.link{border:0;background:none;color:var(--acc);padding:0}
details.menu{position:relative;display:inline-block}details.menu summary{list-style:none;cursor:pointer;padding:.15rem .6rem;border:1px solid var(--line);border-radius:.3rem;background:var(--card)}
details.menu summary::-webkit-details-marker{display:none}
details.menu .pop{position:absolute;right:0;z-index:5;display:flex;flex-direction:column;gap:.3rem;padding:.4rem;margin-top:.2rem;background:var(--card);border:1px solid var(--line);border-radius:.3rem;min-width:8rem}
ul.history{margin:.3rem 0;padding-left:1.1rem}
details.unfollow{display:block}details.unfollow[open]{flex-basis:100%}details.unfollow summary{display:inline-block}
details.unfollow .pop{position:static;margin-top:.4rem;min-width:0;max-width:28rem}details.unfollow .pop button{text-align:left}
.badge{font-size:.78em;padding:0 .4rem;border:1px solid var(--line);border-radius:.6rem}
.warn{color:var(--new)}input[type=search]{width:100%;font:inherit;padding:.4rem .6rem;border:1px solid var(--line);border-radius:.3rem;background:var(--card);color:var(--fg)}
table{border-collapse:collapse;width:100%}td,th{padding:.25rem .4rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
input[type=text],input[type=url],input[type=number],textarea{font:inherit;padding:.25rem .4rem;border:1px solid var(--line);border-radius:.3rem;background:var(--card);color:var(--fg);max-width:100%}
input[type=url],input[type=text]{width:100%}textarea{width:100%;min-height:5rem}label{display:block;margin:.3rem 0}#msg{min-height:1.4em}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
#hub-pill{position:absolute;z-index:20;box-shadow:0 2px 10px rgba(0,0,0,.25);border-radius:999px;padding:.25rem .8rem}
.hub-composer{margin:.4rem 0;padding:.5rem;border:1px solid var(--line);border-radius:.4rem;background:var(--card)}
.hub-composer blockquote{margin:0 0 .4rem;font-size:.9em;color:var(--mut)}.hub-composer button{margin:.3rem .4rem 0 0}
@media (max-width:560px){
  table.blygs,table.blygs tbody,table.blygs tr,table.blygs td{display:block;width:100%}table.blygs thead{display:none}
  table.blygs tr{border:1px solid var(--line);border-radius:.5rem;padding:.5rem .6rem;margin:.5rem 0;background:var(--card)}
  table.blygs td{border:0;padding:.1rem 0}table.blygs td.b-state::before{content:"State: "}table.blygs td.b-posts::before{content:"Posts: "}
  table.blygs td.b-acts{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.4rem}
  .acts.right{justify-content:flex-start}
}
`;

const VIEW_LABELS = Object.freeze({ feed: 'Feed', mentions: 'Mentions', background: 'Background', starred: 'Starred', archive: 'Archive' });
// The read button and the star of one post, under its text (in its row of actions). Their labels say what a press does.
const readBtn = (k, parts) => `<button type="button" class="tick" data-act="tick" data-key="${k}" aria-label="Mark as read: move to Archive${parts ? ` (and its ${parts} part${parts === 1 ? '' : 's'})` : ''}">\u2713 Read${parts ? ` (and its ${parts} part${parts === 1 ? '' : 's'})` : ''}</button>`;
export const starBtn = (k, star) => (star === 'starred'
  ? `<button type="button" class="star" data-act="unstar" data-key="${k}" aria-pressed="true" aria-label="Starred: remove star">\u2605 Starred</button>`
  : `<button type="button" class="star" data-act="star" data-key="${k}" aria-pressed="false" aria-label="Star: come back to it later">\u2606 Star</button>`);
// What each backfill mode (following.mjs BACKFILL_MODES) says in the Following table. A paused mode names its reason.
const BACKFILL_WORDS = Object.freeze({ unknown: '', more: 'more to fetch', caught_up: 'caught up',
  paused_bad_documents: 'reading back is paused: this blyg served documents that could not be used. New posts are still fetched.' });
// The unfollow choice: two buttons, each saying what it does (no browser confirm box: the open panel is the confirmation)
const unfollowChoice = origin => `<details class="menu unfollow"><summary>Unfollow</summary><div class="pop">
  <button type="button" data-act="unfollow" data-origin="${escHtml(origin)}">Stop following</button>
  <span class="mut">Its posts leave the Hub. The list of posts you have read there is kept, so if you follow it again they do not come back as unread.</span>
  <button type="button" data-act="unfollow-forget" data-origin="${escHtml(origin)}">Stop following and forget what I have read there</button>
  <span class="mut">The list goes too: if you follow it again, every post is unread again.</span></div></details>`;
const INBOX_WORDS = Object.freeze({ off: 'no inbox is set', pending: 'not asked yet', ok: 'up to date', unauthorised: 'the inbox refused the token', unreachable: 'the inbox could not be reached', paused: 'paused: Blygger checks are off', unreadable: 'the inbox answered something this page cannot read' });
const openBtn = (key, label = 'Open') => `<button type="button" class="btn" data-act="open" data-key="${escHtml(key)}">${escHtml(label)}</button>`;

// One version line: "V4 Nov 20, 2026: the changelog note" (escaped, clipped; "no note" when empty), and a pinned mark that opens that
// version's page (by key and number, through the companion) only when the page can be told from what is held.
function vline(h, v) {
  const mark = v.mark === 'link' ? ` <button type="button" class="badge" data-act="open-pin" data-key="${escHtml(h.key)}" data-version="${Number(v.version)}">pinned</button>`
    : v.mark === 'plain' ? ' <span class="badge">pinned</span>' : '';
  return `<div>V${Number(v.version)} ${day(v.at)}: ${v.note ? t(v.note, 200) : '<span class="mut">no note</span>'}${mark}</div>`;
}
// up to the three most recent versions, then "and N earlier, in history"
function versions(h) {
  if (!h.history || h.history.length < 2) return '';
  const recent = h.history.slice(0, 3), older = h.history.slice(3);
  const hist = older.length ? `<details><summary class="mut">and ${older.length} earlier, in history</summary>${older.map(v => vline(h, v)).join('')}</details>` : '';
  return `<div class="vlines">${recent.map(v => vline(h, v)).join('')}${hist}</div>`;
}
// the post's own text, in place: as much as the Feed shows (the head), the rest behind "more"; a truncated body says where the rest is
function bodyOf(h) {
  if (!h.body_head) return h.excerpt ? `<div class="hub-entry-body"><p>${t(h.excerpt, 300)}</p></div>` : '';
  const quote = x => x.replace(/<blockquote/g, '<blockquote class="hub-quote"');
  // each piece of a post's text travels inside an inert <template> (a browser cannot let anything in it close the page's own
  // elements) and the page's nonced script moves it into place
  const more = h.body_rest ? `<div class="rest" hidden><template>${quote(h.body_rest)}</template></div><button type="button" class="link" data-act="more">more</button>` : '';
  const trunc = h.body_state === 'truncated' ? `<div class="moremsg"><button type="button" class="link" data-act="read" data-key="${escHtml(h.key)}">Read here for the rest</button></div>` : '';
  return `<div class="hub-entry-body" data-blyg-page="${t(h.page, 500)}" data-blyg-origin="${t(h.origin, 500)}" data-blyg-id="${t(h.id, 40)}" data-blyg-version="${Number(h.version) || 1}"><template>${quote(h.body_head)}</template>${more}${trunc}</div>`;
}
function entry(e) {
  const h = e.head;
  const resp = h.in_response_to ? `<div class="mut">in response to ${t(h.in_response_to.label, 160)}</div>` : '';
  const ident = h.identity === 'disagrees'
    ? `<div class="warn">When this post was opened its page disagreed with this list: ${t(h.identity_note || 'it names another post', 300)}. Discuss used its own check there.</div>` : '';
  const folded = e.members.length
    ? `<div class="mut">${e.members.length} published together, <a href="/hub?view=background">in Background</a></div>` : '';
  const pins = (h.pinned_list || []).length ? `<div class="mut">pinned: ${h.pinned_list.map(n => `v${Number(n)}`).join(', ')}</div>` : '';
  const k = escHtml(h.key);
  const title = h.title ? `<div class="title hub-entry-title"><a href="#e-${k}" data-act="read" data-key="${k}">${t(h.title, 200)}</a></div>` : '';
  const menu = h.read === 'opened' ? `<details class="menu"><summary aria-label="more actions">\u22ef</summary><div class="pop"><button type="button" data-act="renew" data-key="${k}">Mark new</button></div></details>` : '';
  const edited = h.read === 'edited' ? `<span class="badge hub-edited" title="${h.read_version ? `you had read version ${Number(h.read_version)}` : 'you had read an earlier version'}">edited since you read it</span>` : '';
  // the keys of the parts folded under this post as shown: a tick of it sends them, and the companion archives those still folded
  const members = e.members.map(m => escHtml(m.key)).join(' ');
  return `<article class="entry hub-entry read-${escHtml(h.read)}" id="e-${k}" data-key="${k}"${members ? ` data-members="${members}"` : ''}>
    <div class="meta mut hub-entry-meta">${h.read === 'new' || h.read === 'edited' ? '<span class="dot" title="unread"></span>' : ''}${edited}<span class="kind">${t(h.kind, 20)}</span><strong>${t(h.blyg_label || h.origin, 160)}</strong>${h.author ? `<span>${t(h.author, 120)}</span>` : ''}
      <span>${day(h.shown_at || h.updated || h.created)}</span><span>${t(h.reading || '', 20)}</span><span>v${Number(h.version) || 1}${h.versions_note ? ` \u00b7 ${t(h.versions_note, 30)}` : ''}</span>${h.maintenance ? `<span>${Number(h.maintenance)} maintenance</span>` : ''}</div>
    ${versions(h)}${pins}${title}${resp}${bodyOf(h)}${ident}${folded}
    <div class="src">${h.page ? `<button type="button" class="link" data-act="open" data-key="${k}" title="open the original">${addr(h.page)}</button>` : ''}${h.opens_on ? ` <span class="mut">(on ${t(h.opens_on, 80)})</span>` : ''}</div>
    <div class="acts right hub-entry-actions"><button type="button" data-act="respond" data-key="${k}">Respond</button><button type="button" data-act="read" data-key="${k}">Read here</button><button type="button" data-act="open" data-key="${k}">Open original</button>${readBtn(k, e.members.length)}${starBtn(k, h.star)}${menu}</div></article>`;
}

// An Archive line: an Unread button that puts it back in the Feed, kind, blyg, title or first words, dates, Open original. NO text of the post.
// A post held there with a newer wording (archived_changed) says "edited again" and offers Mark read (keep it read, at the newer version).
function archiveLine(l) {
  const k = escHtml(l.key);
  const again = l.read === 'archived_changed';
  return `<div class="aline hub-archive-line${again ? ' hub-archive-changed' : ''}" data-key="${k}"><button type="button" class="untick" data-act="untick" data-key="${k}" aria-label="Unread: move back to the Feed">Unread</button>
    <span class="kind">${t(l.kind, 20)}</span><strong>${t(l.blyg_label || l.origin, 160)}</strong>
    <span class="title">${l.title ? t(l.title, 200) : '<span class="mut">(no title)</span>'}</span>
    ${again ? `<span class="badge warn" title="there is a version ${Number(l.newer_version) || ''} you have not read; untick to read it">edited again</span>` : ''}
    <span class="mut">${day(l.updated || l.created)}${l.archived_at ? `, read ${day(l.archived_at)}` : ''}</span>
    ${l.page ? `<button type="button" class="link" data-act="open" data-key="${k}" title="${t(l.page, 500)}">Open original</button>` : ''}${again ? `<button type="button" class="link" data-act="mark-read" data-key="${k}">Mark read</button>` : ''}</div>`;
}
// A Starred line: like an Archive line (no text of the post), with when it was starred, and where the post is now.
const WHERE_WORDS = Object.freeze({ feed: 'unread, in your Feed', archive: 'read, in the Archive', withdrawn: 'withdrawn', gone: 'no longer held here', unfollowed: 'its blyg is not followed now' });
function starredLine(l) {
  const k = escHtml(l.key);
  const where = l.where === 'feed' ? `<a href="/hub#e-${k}">${WHERE_WORDS.feed}</a>` : escHtml(WHERE_WORDS[l.where] || '');
  return `<div class="aline hub-starred-line" data-key="${k}"><span class="kind">${t(l.kind, 20)}</span><strong>${t(l.blyg_label || l.origin, 160)}</strong>
    <span class="title">${l.title ? t(l.title, 200) : '<span class="mut">(no title)</span>'}</span>
    <span class="mut">${day(l.updated || l.created)}${l.starred_at ? `, starred ${day(l.starred_at)}` : ''}${where ? `, ${where}` : ''}</span>
    ${l.page ? `<button type="button" class="link" data-act="open" data-key="${k}" title="${t(l.page, 500)}">Open original</button>` : ''}<button type="button" class="link star" data-act="unstar" data-key="${k}" aria-label="Remove star">Remove star</button></div>`;
}
function starredPane(data) {
  return `<p class="mut">Posts you starred to come back to. A star is yours alone: nothing about it is sent to any blyg. It stays when you mark a post read.</p>
    <section aria-label="starred" id="hub-starred">${data.starred.length ? data.starred.map(starredLine).join('') : '<p class="mut">Nothing starred yet. Star a post in the Feed to keep it here.</p>'}</section>`;
}
function archivePane(data) {
  const q = data.archive_query || '';
  const more = data.archive_total > data.archive.length
    ? `<p class="mut">${data.archive.length} of ${Number(data.archive_total)} shown. <a href="/hub?view=archive&amp;${q ? `q=${encodeURIComponent(q)}&amp;` : ''}n=${Math.min(1000, data.archive.length + 50)}">show more</a></p>` : '';
  return `<p class="mut">Posts you ticked as read. Only a small record of each is kept, not its text; press Unread on one to bring it back to the Feed (it is fetched again).</p>
    <form method="get" action="/hub" role="search"><input type="hidden" name="view" value="archive"><input type="search" name="q" value="${escHtml(q)}" placeholder="search titles and blygs" aria-label="search the Archive"></form>
    ${(data.archive_notices || []).map(n => `<p class="warn hub-mass-edit">${t(n.blyg_title || n.origin, 160)} changed ${Number(n.held)} posts you had read. They stay here, marked "edited again", and come back to the Feed a few at a time.</p>`).join('')}
    <section aria-label="archive" id="hub-archive">${data.archive.length ? data.archive.map(archiveLine).join('') : `<p class="mut">${q ? 'Nothing in the Archive matches that.' : 'Nothing archived yet. Tick a post in the Feed when you have read it.'}</p>`}</section>${more}`;
}

function backgroundEntry(b) {
  if (b.type === 'mention') return mentionCard(b.mention, b.reason);
  const p = b.post;
  const gone = p.kind === 'withdrawn';
  return `<article class="entry" id="e-${escHtml(p.key)}"><div class="meta mut"><span class="badge">${t(b.reason, 60)}</span><span>${t(p.blyg_title || p.origin, 160)}</span>
    ${p.author ? `<span>${t(p.author, 120)}</span>` : ''}<span>${day(p.shown_at || p.updated)}</span><span class="badge">${t(p.kind, 20)}</span><span>v${Number(p.version) || 1}</span></div>
    ${b.burst_head_title ? `<div class="mut">under ${t(b.burst_head_title, 160)}</div>` : ''}
    ${gone ? '<div class="mut">This post was withdrawn; nothing of it is kept.</div>' : `${p.title ? `<div class="title">${t(p.title, 200)}</div>` : ''}<div class="excerpt">${t(p.excerpt, 300)}</div>`}
    ${gone ? '' : `<div class="acts">${openBtn(p.key, p.opens_on ? `Open (on ${cleanText(p.opens_on, 80)})` : 'Open')}</div>`}</article>`;
}

function mentionCard(m, reason) {
  const what = [m.action, m.version ? `v${Number(m.version)}` : ''].filter(Boolean).join(' ');
  const acts = [];
  if (m.source_url) acts.push(openBtn(m.key, 'Open'));
  if (m.feed_key) acts.push(`<a class="btn" href="/hub?view=feed#e-${escHtml(m.feed_key)}">In your feed</a>`);
  if (m.read === 'unseen') acts.push(`<button type="button" data-act="mention-seen" data-key="${escHtml(m.key)}">Mark seen</button>`);
  return `<article class="entry read-${m.read === 'unseen' ? 'new' : 'seen'}" data-key="${escHtml(m.key)}">
    <div class="meta mut"><span class="badge">${t(reason, 60)}</span><span>${t(m.who || 'someone', 160)}</span>${m.blyg_title ? `<span>${t(m.blyg_title, 160)}</span>` : ''}
      ${what ? `<span>${t(what, 80)}</span>` : ''}${m.at ? `<span>${when(m.at)}</span>` : ''}${m.read === 'unseen' ? '<span class="badge">unseen</span>' : ''}</div>
    ${m.passage ? `<blockquote class="excerpt">${t(m.passage, 600)}</blockquote>` : ''}
    ${m.source_url ? `<div class="mut">${addr(m.source_url)}</div>` : ''}
    <div class="acts">${acts.join('')}</div>
    <details><summary class="mut">details</summary><pre>${escHtml(m.raw || '')}</pre></details></article>`;
}

function mentionsPane(data) {
  const box = data.inbox;
  const warn = box.token_warning ? `<p class="warn">${t(box.token_warning, 300)}</p>` : '';
  const line = `${warn}<p class="mut">Your inbox: ${escHtml(INBOX_WORDS[box.state] || box.state)}${box.error ? ` (${t(box.error, 200)})` : ''}${box.generated_at ? `; generated ${when(box.generated_at)}` : ''}.
    ${box.blocked_count ? `${Number(box.blocked_count)} blocked. ` : ''}${data.tabs.mentions_unseen ? `<button type="button" data-act="mention-seen-all">Mark all seen</button>` : ''}</p>`;
  const verified = data.mentions.filter(m => m.reason !== 'plain mention (lower class)');
  const plain = data.mentions.filter(m => m.reason === 'plain mention (lower class)');
  const groups = new Map();
  for (const m of verified) { const k = m.post_url || m.post_title || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const body = [...groups.values()].map(list => `<section><h2>${t(list[0].post_title || list[0].post_url || 'A post of yours', 200)}</h2>
      ${list[0].post_url ? `<div class="mut">${addr(list[0].post_url)}</div>` : ''}${list.map(m => mentionCard(m, m.reason)).join('')}</section>`).join('');
  const nv = box.never_verified_count
    ? `<p class="mut">${Number(box.never_verified_count)} accepted, never verified${box.never_verified.length ? `: ${box.never_verified.map(x => t(x, 160)).join('; ')}` : ''}.</p>` : '';
  return `${line}${body || (box.state === 'off' ? '<p class="mut">Set an inbox below to see responses to your posts here.</p>' : '<p class="mut">No responses yet.</p>')}
    ${plain.length ? `<h2>Plain mentions</h2><p class="mut">A lower class: the source is not a blyg post and was checked only by its link.</p>${plain.map(m => mentionCard(m, m.reason)).join('')}` : ''}${nv}
    <p class="mut">Notices (links and reposts) are in <a href="/hub?view=background">Background</a>.</p>`;
}

const SCRIPT = `
(function(){
  // The "more" control of a long post: ONE field (data-more on the post's text), one of MORE_MODES, changed here only.
  var MORE_MODES=['collapsed','expanded'];
  function setMore(box,mode){
    if(MORE_MODES.indexOf(mode)<0)throw new Error('more: no such mode '+mode);
    box.dataset.more=mode;
    var rest=box.querySelector('.rest'),btn=box.querySelector('button[data-act=more]');
    if(rest)rest.hidden=mode==='collapsed';
    if(btn)btn.textContent=mode==='collapsed'?'more':'less';
  }
  // The comment composer of the Feed: ONE mode in one field, one of COMPOSER_MODES, moved only through composerMove, which refuses
  // a move that is not in the table (a second press of Save while saving does nothing). The mode is also shown on <html>
  // (data-hub-composer) so a theme or a test can see it.
  var COMPOSER_MODES=['idle','composing','saving'];
  var COMPOSER_MOVES={idle:['composing'],composing:['composing','saving','idle'],saving:['composing','idle']};
  var composer={mode:'idle'};
  function composerMove(to){
    if(COMPOSER_MODES.indexOf(to)<0||COMPOSER_MOVES[composer.mode].indexOf(to)<0)throw new Error('composer: cannot go from '+composer.mode+' to '+to);
    composer.mode=to;document.documentElement.setAttribute('data-hub-composer',to);
  }
  // the posts' texts, delivered inert, are put in place first
  document.querySelectorAll('.hub-entry-body template').forEach(function(t){t.parentNode.insertBefore(t.content,t);t.remove();});
  var msg=document.getElementById('msg');
  function say(s,bad){msg.textContent=s;msg.className=bad?'warn':'mut';}
  // every request answers, never rejects: a Hub that cannot be reached (the fetch itself fails) is {ok:false} too, so each
  // mode that waits on an answer (a row sending, a top-up or refresh asked) comes back to a resting state
  function post(path,body){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})})
    .then(function(r){return r.json().catch(function(){return {ok:false,error:'HTTP '+r.status};});},
      function(){return {ok:false,error:'could not reach the Hub'};});}
  function done(r,okText){if(r&&r.ok){say(okText||'done');setTimeout(function(){location.reload();},400);}else say((r&&r.error)||'failed',true);}
  document.addEventListener('click',function(ev){
    var b=ev.target.closest&&ev.target.closest('button[data-act]');if(!b)return;
    var a=b.dataset.act;
    if(a==='open'){var w=window.open('about:blank','_blank');if(w){try{w.opener=null;}catch(e){}}
      return post('/following/open',{key:b.dataset.key}).then(function(r){
        if(r&&r.ok&&r.url){if(w){w.location.href=r.url;}else say('Allow pop-ups for this page to open posts.',true);}
        else{if(w)w.close();say((r&&r.error)||'failed',true);}});}
    if(a==='open-pin'){var w2=window.open('about:blank','_blank');if(w2){try{w2.opener=null;}catch(e){}}
      return post('/following/open',{key:b.dataset.key,version:Number(b.dataset.version)}).then(function(r){
        if(r&&r.ok&&r.url){if(w2){w2.location.href=r.url;}else say('Allow pop-ups for this page to open posts.',true);}
        else{if(w2)w2.close();say((r&&r.error)||'failed',true);}});}
    if(a==='read'||a==='respond'){var rk=b.dataset.key,resp=a==='respond';say('opening…');
      return post('/following/read-here',{key:rk}).then(function(r){
        if(r&&r.ok&&r.url){location.href=r.url+(resp?'#respond':'');}else say((r&&r.error)||'failed',true);});}
    if(a==='more'){var box=b.closest('.hub-entry-body');if(box)setMore(box,box.dataset.more==='expanded'?'collapsed':'expanded');return;}
    if(a==='renew')return post('/following/read',{key:b.dataset.key,move:'renew'}).then(function(r){done(r);});
    if(a==='mark-read')return post('/following/read',{key:b.dataset.key,move:'tick'}).then(function(r){done(r,'kept as read');});
    if(a==='tick'||a==='untick'||a==='star'||a==='unstar')return rowAct(b,a);
    if(a==='tick-all'){var ticks=[];document.querySelectorAll('#hub-posts .hub-entry').forEach(function(e){if(!e.hidden)ticks.push({key:e.dataset.key,members:membersOf(e)});});
      if(!ticks.length)return;
      if(!confirm('Mark the '+ticks.length+' post'+(ticks.length===1?'':'s')+' shown as read (move them to the Archive)?'))return;
      // 100 a request (the Hub takes no more at once), one request after another
      var total=0,parts=0,i=0;
      var next=function(){if(i>=ticks.length){done({ok:true},'archived '+total+(parts?', and '+parts+' parts':''));return;}
        var batch=ticks.slice(i,i+100);i+=100;
        return post('/following/read',{ticks:batch}).then(function(r){if(!(r&&r.ok)){say((r&&r.error)||'failed',true);return;}total+=Number(r.archived)||0;parts+=Number(r.parts)||0;return next();});};
      return next();}
    if(a==='mention-seen')return post('/following/mention-read',{key:b.dataset.key}).then(function(r){done(r);});
    if(a==='mention-seen-all')return post('/following/mention-read',{all:true}).then(function(r){done(r);});
    if(a==='pause'||a==='resume')return post('/following/state',{origin:b.dataset.origin,move:a}).then(function(r){done(r);});
    if(a==='retry')return post('/following/state',{origin:b.dataset.origin,move:'retry'}).then(function(r){done(r,'reading it again');});
    if(a==='unfollow'||a==='unfollow-forget')return post('/following/unfollow',{origin:b.dataset.origin,forget:a==='unfollow-forget'}).then(function(r){done(r,'unfollowed');});
    if(a==='refresh'){if(fetchMode!=='idle'){say('already reading; a moment',true);return;}fetchMove('refreshing');say('refreshing…');
      return post('/following/refresh',{}).then(function(r){fetchMove('idle');
      if(r&&r.ok&&r.started===false)say(r.reason,true);else done(r,'refreshed');});}
  });
  // Read (Feed), Unread (Archive) and the star: a button each in the row of actions, handled here and nowhere else. A post's own
  // text is inert and cannot hold one (the sanitiser removes buttons, ids and classes), and a control inside a post's text is ignored.
  function membersOf(row){var m=row&&row.dataset&&row.dataset.members;return m?m.split(' ').filter(Boolean):[];}
  function count(name,d){document.querySelectorAll('[data-n="'+name+'"]').forEach(function(n){n.textContent=String(Math.max(0,(Number(n.textContent)||0)+d));});}
  // A row's request (Read, Unread, a star): ONE field (data-tick on the row), one of ROW_MODES, moved only by rowMove, which refuses
  // a move not in the table: a second press while the first is being sent does nothing. No button is disabled: the mode is the
  // field, and aria-busy only shows it.
  var ROW_MODES=['ready','sending'];
  var ROW_MOVES={ready:['sending'],sending:['ready']};
  function rowMove(row,to){var from=row.dataset.tick||'ready';
    if(ROW_MODES.indexOf(to)<0||ROW_MOVES[from].indexOf(to)<0)throw new Error('row: cannot go from '+from+' to '+to);
    row.dataset.tick=to;row.setAttribute('aria-busy',to==='sending'?'true':'false');}
  // What the page is asking the Hub to fetch: ONE field (data-hub-fetch on <html>), one of FETCH_MODES, moved only by
  // fetchMove. A top-up (after a tick) and Refresh now are never asked twice at once, and never queued: the second is skipped.
  var FETCH_MODES=['idle','refreshing','topping_up'];
  var FETCH_MOVES={idle:['refreshing','topping_up'],refreshing:['idle'],topping_up:['idle']};
  var fetchMode='idle';document.documentElement.setAttribute('data-hub-fetch','idle');
  function fetchMove(to){if(FETCH_MODES.indexOf(to)<0||FETCH_MOVES[fetchMode].indexOf(to)<0)throw new Error('fetch: cannot go from '+fetchMode+' to '+to);
    fetchMode=to;document.documentElement.setAttribute('data-hub-fetch',to);}
  function topUp(){if(fetchMode!=='idle')return;fetchMove('topping_up');say('reading further back…');
    post('/following/topup',{}).then(function(r2){fetchMove('idle');
      if(r2&&r2.ok&&r2.started&&Number(r2.new)>0)location.reload();else say('');},function(){fetchMove('idle');say('');});}
  function starLabel(b,on){b.dataset.act=on?'unstar':'star';b.setAttribute('aria-pressed',on?'true':'false');
    if(b.classList.contains('link')){b.textContent=on?'Remove star':'Star again';b.setAttribute('aria-label',on?'Remove star':'Star again');return;}
    b.textContent=on?'\u2605 Starred':'\u2606 Star';b.setAttribute('aria-label',on?'Starred: remove star':'Star: come back to it later');}
  function rowAct(b,a){
    if(b.closest('.hub-entry-body'))return;
    var row=b.closest('article,.aline');if(!row||(row.dataset.tick||'ready')!=='ready')return;
    rowMove(row,'sending');
    var body=a==='tick'?{key:b.dataset.key,move:'tick',members:membersOf(row)}:{key:b.dataset.key,move:a};
    if(a==='untick')say('putting it back in the Feed\u2026');
    return post('/following/read',body).then(function(r){
      rowMove(row,'ready');
      if(!(r&&r.ok)){say((r&&r.error)||'failed',true);return;}
      if(a==='unstar'&&row.classList.contains('hub-starred-line')){row.remove();count('starred',-1);say('star removed');return;}
      if(a==='star'||a==='unstar'){starLabel(b,a==='star');count('starred',a==='star'?1:-1);say(a==='star'?'starred':'star removed');return;}
      var parts=Number(r.parts)||0;
      row.remove();count('feed',a==='untick'?1:-1);count('archive',a==='untick'?-1:1+parts);
      say(a==='untick'?'back in the Feed':parts?'archived, and its '+parts+' part'+(parts===1?'':'s'):'');
      // the Feed fell below its target and a blyg has more queued: one top-up (never two at once, never queued)
      if(a==='tick'&&r.topup)topUp();
    });
  }
  var search=document.getElementById('hub-search');
  if(search)search.addEventListener('input',function(){var q=search.value.trim().toLowerCase();
    document.querySelectorAll('#hub-posts .hub-entry').forEach(function(e){e.hidden=!!q&&e.textContent.toLowerCase().indexOf(q)<0;});});
  document.getElementById('follow-form').addEventListener('submit',function(ev){ev.preventDefault();
    say('looking for the blyg…');post('/following/follow',{url:this.url.value}).then(function(r){done(r,'followed');});});
  var preview=document.getElementById('preview');
  document.getElementById('import-form').addEventListener('submit',function(ev){ev.preventDefault();
    say('reading…');preview.textContent='';
    post('/following/import-preview',{url:this.url.value,text:this.text.value}).then(function(r){
      if(!r||!r.ok){say((r&&r.error)||'failed',true);return;}
      say('');var p=r.preview,form=document.createElement('form');
      var h=document.createElement('p');h.textContent=p.add.length?('Would add '+p.add.length+' (tick what to follow):'):'Nothing new to add.';form.appendChild(h);
      p.add.forEach(function(a,i){var l=document.createElement('label'),c=document.createElement('input');c.type='checkbox';c.checked=true;c.dataset.i=i;
        l.appendChild(c);l.appendChild(document.createTextNode(' '+(a.title||a.origin)+' — '+a.origin));form.appendChild(l);});
      if(p.already.length){var al=document.createElement('p');al.className='mut';al.textContent='Already followed: '+p.already.length;form.appendChild(al);}
      p.skipped.forEach(function(s){var d=document.createElement('div');d.className='mut';d.textContent='Skipped '+(s.title||s.url)+': '+s.reason;form.appendChild(d);});
      if(p.add.length){var go=document.createElement('button');go.type='submit';go.textContent='Follow the ticked ones';form.appendChild(go);
        form.addEventListener('submit',function(e2){e2.preventDefault();var pick=[];
          form.querySelectorAll('input[type=checkbox]').forEach(function(c){if(c.checked)pick.push(p.add[Number(c.dataset.i)]);});
          post('/following/import-confirm',{entries:pick}).then(function(r2){done(r2,'added');});});}
      preview.appendChild(form);});});
  document.getElementById('settings-form').addEventListener('submit',function(ev){ev.preventDefault();var f=this,b={};
    f.querySelectorAll('input[data-num]').forEach(function(i){b[i.name]=Number(i.value);});
    b.my_origins=f.my_origins.value.split(/\\n/).map(function(s){return s.trim();}).filter(Boolean);
    b.inbox_api_url=f.inbox_api_url.value.trim();b.hub_theme_dir=f.hub_theme_dir.value.trim();b.inbox_token_file=f.inbox_token_file.value.trim();
    post('/following/settings',b).then(function(r){done(r,'saved');});});
  // ---- respond from the Feed: a selection inside ONE post's text is a highlight on that post's page record ----
  var A=window.BFPAnchor,TJ=document.getElementById('hub-threads');
  if(A&&TJ){
    var T={};try{T=JSON.parse(TJ.textContent)||{};}catch(e){T={};}
    var bodyOf=function(n){var el=n&&(n.nodeType===1?n:n.parentElement);return el&&el.closest?el.closest('.hub-entry-body[data-blyg-page]'):null;};
    var paint=function(){document.querySelectorAll('.hub-entry-body[data-blyg-page]').forEach(function(b){
      var ent=b.closest('.hub-entry'),ts=(ent&&T[ent.dataset.key])||[];
      ts.forEach(function(t){A.unpaint(t.id);});
      ts.forEach(function(t){var idx=A.buildTextIndex(b),hit=A.locate(idx.raw,t);if(hit.ok)A.paintOffsets(idx,hit.start,hit.end,t.id,false);});});};
    paint();
    var pill=document.createElement('button');pill.type='button';pill.id='hub-pill';pill.textContent='Comment';pill.hidden=true;document.body.appendChild(pill);
    var hide=function(){pill.hidden=true;};
    // with the Discuss extension on this page the extension owns the selection (it marks the page), so only one Comment is offered
    var onSel=function(){if(document.documentElement.hasAttribute('data-bfp-extension'))return hide();var sel=window.getSelection();if(!sel||sel.isCollapsed||!sel.rangeCount)return hide();
      var r=sel.getRangeAt(0),a=bodyOf(r.startContainer),b=bodyOf(r.endContainer);
      if(!a&&!b)return hide();
      if(a!==b){hide();say('A comment belongs to one post: keep the selection inside one.',true);return;}
      if(!String(sel).trim())return hide();
      var box=r.getBoundingClientRect();pill.style.left=Math.max(8,box.left+box.width/2-30)+'px';pill.style.top=(box.top+window.scrollY-34)+'px';pill.hidden=false;};
    document.addEventListener('selectionchange',function(){setTimeout(onSel,0);});
    pill.addEventListener('mousedown',function(e){e.preventDefault();});
    pill.addEventListener('click',function(){
      var sel=window.getSelection();if(!sel||!sel.rangeCount)return;var r=sel.getRangeAt(0),b=bodyOf(r.startContainer);
      if(!b||b!==bodyOf(r.endContainer)){say('A comment belongs to one post: keep the selection inside one.',true);return;}
      var idx=A.buildTextIndex(b),off=A.offsetsFromRange(idx,r),anchor=A.buildAnchor(idx.raw,off.start,off.end);
      hide();sel.removeAllRanges();if(!anchor.quote)return;
      var ent=b.closest('.hub-entry'),old=ent.querySelector('.hub-composer');if(old)old.remove();
      document.querySelectorAll('.hub-composer').forEach(function(c){c.remove();});
      composerMove('composing');
      var box=document.createElement('div');box.className='hub-composer';
      var q=document.createElement('blockquote');q.textContent=anchor.quote;box.appendChild(q);
      var ta=document.createElement('textarea');ta.placeholder='Your comment on this passage';box.appendChild(ta);
      var go=document.createElement('button');go.type='button';go.textContent='Save comment';var no=document.createElement('button');no.type='button';no.textContent='Cancel';
      box.appendChild(go);box.appendChild(no);b.parentNode.insertBefore(box,b.nextSibling);ta.focus();
      no.addEventListener('click',function(){if(composer.mode==='composing'){box.remove();composerMove('idle');}});
      go.addEventListener('click',function(){var text=ta.value.trim();if(!text||composer.mode!=='composing')return;
        composerMove('saving');go.disabled=true;
        var fail=function(m){composerMove('composing');go.disabled=false;say(m,true);};
        post('/following/hold',{origin:b.dataset.blygOrigin,id:b.dataset.blygId}).then(function(h){
          if(!h||!h.ok){fail((h&&h.error)||'could not keep that post');return;}
          return post('/thread',{url:h.url,quote:anchor.quote,prefix:anchor.prefix,suffix:anchor.suffix,msg:{text:text}}).then(function(t){
            if(t&&t.ok&&t.thread){(T[ent.dataset.key]=T[ent.dataset.key]||[]).push({id:t.thread.id,quote:anchor.quote,prefix:anchor.prefix,suffix:anchor.suffix});
              box.remove();composerMove('idle');paint();say('Saved. It is also kept on the page of that post: see Read here.');}
            else fail((t&&t.error)||'could not save that');});}).catch(function(){fail('could not reach the companion');});});});
  }
})();
`;

/**
 * The page. `data` is following.view()'s answer; `settings` the validated settings; `refused` the keys the stored
 * config had wrong; `nonce` the Content-Security-Policy nonce of this response (the one script and the one style carry it).
 */
export function followingPage({ data, settings, refused = [], notice = '', nonce = '', locale = 'en-US', theme = { state: 'none', reason: '' } }) {
  LOCALE = locale;
  const tabs = VIEWS.map(v => {
    const n = data.tabs[v];
    const extra = v === 'mentions' && data.tabs.mentions_unseen ? ` <span class="badge">${Number(data.tabs.mentions_unseen)} unseen</span>` : '';
    return `<a href="/hub${v === 'feed' ? '' : `?view=${v}`}"${v === data.view ? ' aria-current="page"' : ''}>${escHtml(VIEW_LABELS[v])} (<span data-n="${escHtml(v)}">${Number(n) || 0}</span>)${extra}</a>`;
  }).join('');
  const nav = FILTERS.map(f => `<a href="/hub${f === 'all' ? '' : `?filter=${f}`}"${f === data.filter ? ' aria-current="page"' : ''}>${escHtml(FILTER_LABELS[f])} (${Number(data.counts[f]) || 0})</a>`).join('');
  const last = data.last_run;
  const lastLine = last ? `Last refresh ${when(last.at)}: ${Number(last.new)} new${last.backfilled ? ` (${Number(last.backfilled)} read back from earlier)` : ''}, ${Number(last.edited)} edited, ${Number(last.requests)} requests${last.deferred ? `, ${Number(last.deferred)} deferred` : ''}${last.refused ? `, ${Number(last.refused)} refused` : ''}.` : 'Not refreshed yet.';
  const blygs = data.blygs.map(b => `<tr><td class="b-name">${t(b.title || b.origin, 160)}<div class="mut">${addr(b.origin, 60)}</div>${b.last_error ? `<div class="warn">${t(b.last_error, 300)}</div>` : ''}</td>
      <td class="b-state"><span class="badge">${t(b.state, 20)}</span>${b.state === 'unreachable' ? `<div class="mut">${Number(b.failures)} failures</div>` : ''}${BACKFILL_WORDS[b.backfill] ? `<div class="${String(b.backfill).startsWith('paused_') ? 'warn' : 'mut'} b-backfill">${escHtml(BACKFILL_WORDS[b.backfill])}${b.bad_documents ? ` (${Number(b.bad_documents)} of them)` : ''}</div>` : ''}${String(b.backfill).startsWith('paused_') ? `<button type="button" data-act="retry" data-origin="${escHtml(b.origin)}" title="forget the documents it could not use, and read its list again">Retry</button>` : ''}</td><td class="b-posts">${Number(b.items)} unread${b.archived ? `<div class="mut">${Number(b.archived)} archived</div>` : ''}</td>
      <td class="b-acts">${b.state === 'paused' || b.state === 'gone' || b.state === 'unreachable' ? `<button type="button" data-act="resume" data-origin="${escHtml(b.origin)}">${b.state === 'unreachable' ? 'Retry' : 'Resume'}</button>` : ''}
        ${b.state === 'active' || b.state === 'unreachable' ? `<button type="button" data-act="pause" data-origin="${escHtml(b.origin)}">Pause</button>` : ''}
        ${unfollowChoice(b.origin)}</td></tr>`).join('');
  const nums = Object.entries(FOLLOWING_NUMBERS).map(([k, spec]) => `<label>${escHtml(spec.what)} <input type="number" data-num name="${escHtml(k)}" min="${spec.min}" max="${spec.max}" value="${Number(settings[k])}"> <span class="mut">(${spec.min} to ${spec.max})</span></label>`).join('');
  const pane = data.view === 'mentions' ? mentionsPane(data)
    : data.view === 'archive' ? archivePane(data)
    : data.view === 'starred' ? starredPane(data)
    : data.view === 'background'
      ? `<p class="mut">What should not interrupt reading: withdrawn posts, posts folded into a burst, versions with no new words, posts of paused blygs, and notices (links and reposts) from your inbox. A post comes back to the Feed when it gets a real new version.</p>
         ${data.background.length ? data.background.map(backgroundEntry).join('') : '<p class="mut">Nothing here.</p>'}`
      : `<nav class="filters" aria-label="filter">${nav}</nav>
         <input type="search" id="hub-search" placeholder="search every word" aria-label="search every word on this page">
         <section aria-label="posts" id="hub-posts">${data.entries.length ? data.entries.map(entry).join('')
           : data.read_all ? '<p class="caught-up" role="status">You have read everything from the blygs you follow.</p>'
           : data.blygs.length ? '<p class="mut">Nothing unread here. A refresh reads further back in the blygs you follow.</p>'
           : '<p class="mut">Nothing here yet. Follow a blyg below, then Refresh now.</p>'}</section>
         ${data.entry_total > data.entries.length ? `<p class="mut">${data.entries.length} of ${Number(data.entry_total)} shown (search covers these). <a href="/hub?${data.filter === 'all' ? '' : `filter=${escHtml(data.filter)}&amp;`}n=${Math.min(1000, (Number(data.limit) || 100) + 100)}">show more</a></p>` : ''}
         ${data.tabs.background ? `<p class="mut"><a href="/hub?view=background">${Number(data.tabs.background)} in Background</a></p>` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hub — Discuss</title><style nonce="${escHtml(nonce)}">${CSS}</style>${theme.state === 'ok' ? '<link rel="stylesheet" href="/hub/theme/hub.css">' : ''}</head><body class="hub"><main class="hub-main">
<p class="mut"><a href="/pages">All annotated pages</a></p>
<h1>Hub</h1>
<p class="mut">Blygs you read. Only you see this, and nothing about your reading is sent to any blyg. ${escHtml(lastLine)} ${data.schedule.mode === 'scheduled' ? `Refreshes every ${Number(settings.following_refresh_minutes)} minutes.` : 'Not refreshing on a timer.'}</p>
${notice ? `<p class="warn">${t(notice, 300)}</p>` : ''}${refused.length ? `<p class="warn">These settings were not valid and the defaults are used: ${t(refused.join(', '), 300)}.</p>` : ''}
<div class="acts"><button type="button" data-act="refresh">Refresh now</button>${data.view === 'feed' && data.entries.length ? '<button type="button" data-act="tick-all">Mark all read</button>' : ''}<span id="msg" role="status"></span></div>
<nav class="filters hub-tabs" aria-label="views">${tabs}</nav>
${pane}
<h2>Following</h2>
<p class="mut">The blygs you follow. Add one, import a blogroll, or change the settings below.</p>
<table class="blygs"><thead><tr><th>Blyg</th><th>State</th><th>Posts</th><th></th></tr></thead><tbody>${blygs || '<tr><td colspan="4" class="mut">None yet.</td></tr>'}</tbody></table>
<h2>Follow a blyg</h2>
<form id="follow-form"><label>Any address on it (a post, its front page) <input type="url" name="url" required size="48" placeholder="https://"></label><button type="submit">Follow</button></form>
<h2>Import a blogroll</h2>
<form id="import-form"><p class="mut">An OPML blogroll, or a blygger.com directory (blygs.json). Nothing is added until you confirm it.</p>
<label>Address of the document <input type="url" name="url" size="48" placeholder="https://"></label>
<label>…or paste it here <textarea name="text"></textarea></label><button type="submit">Show what would be added</button></form><div id="preview"></div>
<h2>Settings</h2>
<form id="settings-form" class="hub-settings">${nums}<label>Your own blygs (one address per line): posts that answer or quote them are listed under "Responses to me"
<textarea name="my_origins">${settings.my_origins.map(o => escHtml(o)).join('\n')}</textarea></label>
<label>Mentions inbox address (https) <input type="url" name="inbox_api_url" size="48" value="${escHtml(settings.inbox_api_url)}" placeholder="https://"></label>
<label>Token file (an absolute path; its first line is the token, which is never kept here) <input type="text" name="inbox_token_file" size="48" value="${escHtml(settings.inbox_token_file)}"></label>
${data.inbox.token_warning ? `<p class="warn">${t(data.inbox.token_warning, 300)}</p>` : ''}
<label>Theme folder (an absolute path to a folder with hub.css and, if you like, fonts) <input type="text" name="hub_theme_dir" size="48" value="${escHtml(settings.hub_theme_dir || '')}"></label>
<p class="mut">Theme: ${t(theme.state, 20)}${theme.reason ? ` (${t(theme.reason, 200)})` : ''}</p>
<button type="submit">Save settings</button></form>
<p class="mut">Where a post is: ${READ_STATES.map(s => escHtml(s)).join(', ')}. Inbox states: ${INBOX_STATES.map(s => escHtml(s)).join(', ')}.</p>
</main>${data.view === 'feed' ? `<script type="application/json" id="hub-threads" nonce="${escHtml(nonce)}">${JSON.stringify(Object.fromEntries(data.entries.map(e => [e.head.key, e.head.threads || []]))).replace(/</g, String.fromCharCode(92) + 'u003c')}</script>
<script src="/assets/anchor.js" nonce="${escHtml(nonce)}"></script>` : ''}<script nonce="${escHtml(nonce)}">${SCRIPT}</script></body></html>`;
}
