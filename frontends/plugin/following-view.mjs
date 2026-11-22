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
import { FILTERS, FILTER_LABELS, VIEWS, READ_STATES, cleanText, FOLLOWING_NUMBERS, INBOX_STATES } from './following.mjs';

const t = (v, n = 300) => escHtml(cleanText(typeof v === 'string' ? v : String(v ?? ''), n));
const day = v => t(String(v || '').slice(0, 10), 10);

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#222;--mut:#6b6b6b;--line:#ddd;--card:#fff;--acc:#1b5fb4;--new:#b4361b}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e6e6e6;--mut:#9a9a9a;--line:#333;--card:#1e1e1e;--acc:#7db3f5;--new:#f0866a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:56rem;margin:0 auto;padding:1rem}
h1{font-size:1.4rem;margin:.2rem 0}h2{font-size:1.05rem;margin:1.5rem 0 .4rem}
a{color:var(--acc)}.mut{color:var(--mut);font-size:.88em}
nav.filters{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0}
nav.filters a{padding:.2rem .6rem;border:1px solid var(--line);border-radius:1rem;text-decoration:none;color:var(--fg)}
nav.filters a[aria-current=page]{background:var(--acc);color:var(--bg);border-color:var(--acc)}
article.entry{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:.7rem .9rem;margin:.6rem 0}
article.entry.read-new{border-left:4px solid var(--new)}
.meta{display:flex;flex-wrap:wrap;gap:.2rem .8rem}.title{font-weight:600;margin:.2rem 0}
.excerpt{margin:.3rem 0;overflow-wrap:anywhere}.acts{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.4rem}
button,.btn{font:inherit;padding:.15rem .6rem;border:1px solid var(--line);border-radius:.3rem;background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none}
ul.burst{margin:.4rem 0 0 .2rem;padding-left:1rem;border-left:2px solid var(--line);list-style:none}
ul.burst li{margin:.3rem 0}.badge{font-size:.78em;padding:0 .4rem;border:1px solid var(--line);border-radius:.6rem}
.warn{color:var(--new)}table{border-collapse:collapse;width:100%}td,th{padding:.25rem .4rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
input[type=text],input[type=url],input[type=number],textarea{font:inherit;padding:.25rem .4rem;border:1px solid var(--line);border-radius:.3rem;background:var(--card);color:var(--fg);max-width:100%}
textarea{width:100%;min-height:5rem}label{display:block;margin:.3rem 0}#msg{min-height:1.4em}
`;

const VIEW_LABELS = Object.freeze({ feed: 'Feed', mentions: 'Mentions', background: 'Background' });
const INBOX_WORDS = Object.freeze({ off: 'no inbox is set', pending: 'not asked yet', ok: 'up to date', unauthorised: 'the inbox refused the token', unreachable: 'the inbox could not be reached' });
const openBtn = (key, label = 'Open') => `<button type="button" class="btn" data-act="open" data-key="${escHtml(key)}">${escHtml(label)}</button>`;

function entry(e) {
  const h = e.head;
  const resp = h.in_response_to ? `<div class="mut">in response to ${t(h.in_response_to.label, 160)}</div>` : '';
  const ident = h.identity === 'disagrees'
    ? `<div class="warn">When this post was opened its page disagreed with this list: ${t(h.identity_note || 'it names another post', 300)}. Discuss used its own check there.</div>` : '';
  const folded = e.members.length
    ? `<div class="mut">${e.members.length} published together, <a href="/following?view=background">in Background</a></div>` : '';
  const acts = [openBtn(h.key, h.opens_on ? `Open (on ${cleanText(h.opens_on, 80)})` : 'Open')];
  if (h.read === 'new') acts.push(`<button type="button" data-act="see" data-key="${escHtml(h.key)}">Mark seen</button>`);
  return `<article class="entry read-${escHtml(h.read)}" id="e-${escHtml(h.key)}" data-key="${escHtml(h.key)}">
    <div class="meta mut"><span>${t(h.blyg_title || h.origin, 160)}</span>${h.author ? `<span>${t(h.author, 120)}</span>` : ''}
      <span>${day(h.shown_at || h.updated || h.created)}</span><span class="badge">${t(h.kind, 20)}</span><span>v${Number(h.version) || 1}</span>
      ${h.versions_note ? `<span>${t(h.versions_note, 30)}</span>` : ''}<span class="badge">${t(h.read, 20)}</span>${h.maintenance ? `<span class="mut">${Number(h.maintenance)} maintenance</span>` : ''}</div>
    ${h.title ? `<div class="title">${t(h.title, 200)}</div>` : ''}${resp}
    <div class="excerpt">${t(h.excerpt, 300)}</div>${ident}${folded}
    <div class="acts">${acts.join('')}</div></article>`;
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
  if (m.feed_key) acts.push(`<a class="btn" href="/following?view=feed#e-${escHtml(m.feed_key)}">In your feed</a>`);
  if (m.read === 'unseen') acts.push(`<button type="button" data-act="mention-seen" data-key="${escHtml(m.key)}">Mark seen</button>`);
  return `<article class="entry read-${m.read === 'unseen' ? 'new' : 'seen'}" data-key="${escHtml(m.key)}">
    <div class="meta mut"><span class="badge">${t(reason, 60)}</span><span>${t(m.who || 'someone', 160)}</span>${m.blyg_title ? `<span>${t(m.blyg_title, 160)}</span>` : ''}
      ${what ? `<span>${t(what, 80)}</span>` : ''}${m.at ? `<span>${t(m.at, 40)}</span>` : ''}${m.read === 'unseen' ? '<span class="badge">unseen</span>' : ''}</div>
    ${m.passage ? `<blockquote class="excerpt">${t(m.passage, 600)}</blockquote>` : ''}
    ${m.source_url ? `<div class="mut">${t(m.source_url, 300)}</div>` : ''}
    <div class="acts">${acts.join('')}</div>
    <details><summary class="mut">details</summary><pre>${escHtml(m.raw || '')}</pre></details></article>`;
}

function mentionsPane(data) {
  const box = data.inbox;
  const line = `<p class="mut">Your inbox: ${escHtml(INBOX_WORDS[box.state] || box.state)}${box.error ? ` (${t(box.error, 200)})` : ''}${box.generated_at ? `; generated ${t(box.generated_at, 40)}` : ''}.
    ${box.blocked_count ? `${Number(box.blocked_count)} blocked. ` : ''}${data.tabs.mentions_unseen ? `<button type="button" data-act="mention-seen-all">Mark all seen</button>` : ''}</p>`;
  const verified = data.mentions.filter(m => m.reason !== 'plain mention (lower class)');
  const plain = data.mentions.filter(m => m.reason === 'plain mention (lower class)');
  const groups = new Map();
  for (const m of verified) { const k = m.post_url || m.post_title || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const body = [...groups.values()].map(list => `<section><h2>${t(list[0].post_title || list[0].post_url || 'A post of yours', 200)}</h2>
      ${list[0].post_url ? `<div class="mut">${t(list[0].post_url, 300)}</div>` : ''}${list.map(m => mentionCard(m, m.reason)).join('')}</section>`).join('');
  const nv = box.never_verified_count
    ? `<p class="mut">${Number(box.never_verified_count)} accepted, never verified${box.never_verified.length ? `: ${box.never_verified.map(x => t(x, 160)).join('; ')}` : ''}.</p>` : '';
  return `${line}${body || (box.state === 'off' ? '<p class="mut">Set an inbox below to see responses to your posts here.</p>' : '<p class="mut">No responses yet.</p>')}
    ${plain.length ? `<h2>Plain mentions</h2><p class="mut">A lower class: the source is not a blyg post and was checked only by its link.</p>${plain.map(m => mentionCard(m, m.reason)).join('')}` : ''}${nv}
    <p class="mut">Notices (links and reposts) are in <a href="/following?view=background">Background</a>.</p>`;
}

const SCRIPT = `
(function(){
  var msg=document.getElementById('msg');
  function say(s,bad){msg.textContent=s;msg.className=bad?'warn':'mut';}
  function post(path,body){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})})
    .then(function(r){return r.json().catch(function(){return {ok:false,error:'HTTP '+r.status};});});}
  function done(r,okText){if(r&&r.ok){say(okText||'done');setTimeout(function(){location.reload();},400);}else say((r&&r.error)||'failed',true);}
  document.addEventListener('click',function(ev){
    var b=ev.target.closest&&ev.target.closest('button[data-act]');if(!b)return;
    var a=b.dataset.act;
    if(a==='open'){var w=window.open('about:blank','_blank');if(w){try{w.opener=null;}catch(e){}}
      return post('/following/open',{key:b.dataset.key}).then(function(r){
        if(r&&r.ok&&r.url){if(w){w.location.href=r.url;}else say('Allow pop-ups for this page to open posts.',true);}
        else{if(w)w.close();say((r&&r.error)||'failed',true);}});}
    if(a==='see')return post('/following/read',{key:b.dataset.key,move:'see'}).then(function(r){done(r);});
    if(a==='seen-all')return post('/following/read',{all:true}).then(function(r){done(r);});
    if(a==='mention-seen')return post('/following/mention-read',{key:b.dataset.key}).then(function(r){done(r);});
    if(a==='mention-seen-all')return post('/following/mention-read',{all:true}).then(function(r){done(r);});
    if(a==='pause'||a==='resume')return post('/following/state',{origin:b.dataset.origin,move:a}).then(function(r){done(r);});
    if(a==='unfollow'){if(!confirm('Stop following this blyg and forget its posts here?'))return;
      return post('/following/unfollow',{origin:b.dataset.origin}).then(function(r){done(r);});}
    if(a==='refresh'){say('refreshing…');b.disabled=true;return post('/following/refresh',{}).then(function(r){b.disabled=false;
      if(r&&r.ok&&r.started===false)say(r.reason,true);else done(r,'refreshed');});}
  });
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
    b.inbox_api_url=f.inbox_api_url.value.trim();b.inbox_token_file=f.inbox_token_file.value.trim();
    post('/following/settings',b).then(function(r){done(r,'saved');});});
})();
`;

/**
 * The page. `data` is following.view()'s answer; `settings` the validated settings; `refused` the keys the stored
 * config had wrong; `nonce` the Content-Security-Policy nonce of this response (the one script and the one style carry it).
 */
export function followingPage({ data, settings, refused = [], notice = '', nonce = '' }) {
  const tabs = VIEWS.map(v => {
    const n = v === 'feed' ? data.tabs.feed : v === 'mentions' ? data.tabs.mentions : data.tabs.background;
    const extra = v === 'mentions' && data.tabs.mentions_unseen ? ` <span class="badge">${Number(data.tabs.mentions_unseen)} unseen</span>` : '';
    return `<a href="/following${v === 'feed' ? '' : `?view=${v}`}"${v === data.view ? ' aria-current="page"' : ''}>${escHtml(VIEW_LABELS[v])} (${Number(n) || 0})${extra}</a>`;
  }).join('');
  const nav = FILTERS.map(f => `<a href="/following${f === 'all' ? '' : `?filter=${f}`}"${f === data.filter ? ' aria-current="page"' : ''}>${escHtml(FILTER_LABELS[f])} (${Number(data.counts[f]) || 0})</a>`).join('');
  const last = data.last_run;
  const lastLine = last ? `Last refresh ${t(last.at, 30)}: ${Number(last.new)} new, ${Number(last.edited)} edited, ${Number(last.requests)} requests${last.deferred ? `, ${Number(last.deferred)} deferred` : ''}${last.refused ? `, ${Number(last.refused)} refused` : ''}.` : 'Not refreshed yet.';
  const blygs = data.blygs.map(b => `<tr><td>${t(b.title || b.origin, 160)}<div class="mut">${t(b.origin, 300)}</div>${b.last_error ? `<div class="warn">${t(b.last_error, 300)}</div>` : ''}</td>
      <td><span class="badge">${t(b.state, 20)}</span>${b.state === 'unreachable' ? `<div class="mut">${Number(b.failures)} failures</div>` : ''}</td><td>${Number(b.items)}</td>
      <td>${b.state === 'paused' || b.state === 'gone' || b.state === 'unreachable' ? `<button type="button" data-act="resume" data-origin="${escHtml(b.origin)}">${b.state === 'unreachable' ? 'Retry' : 'Resume'}</button>` : ''}
        ${b.state === 'active' || b.state === 'unreachable' ? `<button type="button" data-act="pause" data-origin="${escHtml(b.origin)}">Pause</button>` : ''}
        <button type="button" data-act="unfollow" data-origin="${escHtml(b.origin)}">Unfollow</button></td></tr>`).join('');
  const nums = Object.entries(FOLLOWING_NUMBERS).map(([k, spec]) => `<label>${escHtml(spec.what)} <input type="number" data-num name="${escHtml(k)}" min="${spec.min}" max="${spec.max}" value="${Number(settings[k])}"> <span class="mut">(${spec.min} to ${spec.max})</span></label>`).join('');
  const pane = data.view === 'mentions' ? mentionsPane(data)
    : data.view === 'background'
      ? `<p class="mut">What should not interrupt reading: withdrawn posts, posts folded into a burst, versions with no new words, posts of paused blygs, and notices (links and reposts) from your inbox. A post comes back to the Feed when it gets a real new version.</p>
         ${data.background.length ? data.background.map(backgroundEntry).join('') : '<p class="mut">Nothing here.</p>'}`
      : `<nav class="filters" aria-label="filter">${nav}</nav>
         <section aria-label="posts">${data.entries.length ? data.entries.map(entry).join('') : '<p class="mut">Nothing here yet. Follow a blyg below, then Refresh now.</p>'}</section>
         ${data.tabs.background ? `<p class="mut"><a href="/following?view=background">${Number(data.tabs.background)} in Background</a></p>` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Following — Discuss</title><style nonce="${escHtml(nonce)}">${CSS}</style></head><body><main>
<p class="mut"><a href="/pages">All annotated pages</a></p>
<h1>Following</h1>
<p class="mut">Blygs you read. Only you see this, and nothing about your reading is sent to any blyg. ${escHtml(lastLine)} ${data.schedule.mode === 'scheduled' ? `Refreshes every ${Number(settings.following_refresh_minutes)} minutes.` : 'Not refreshing on a timer.'}</p>
${notice ? `<p class="warn">${t(notice, 300)}</p>` : ''}${refused.length ? `<p class="warn">These settings were not valid and the defaults are used: ${t(refused.join(', '), 300)}.</p>` : ''}
<div class="acts"><button type="button" data-act="refresh">Refresh now</button><button type="button" data-act="seen-all">Mark all seen</button><span id="msg" role="status"></span></div>
<nav class="filters" aria-label="views">${tabs}</nav>
${pane}
<h2>Followed blygs</h2>
<table><thead><tr><th>Blyg</th><th>State</th><th>Posts</th><th></th></tr></thead><tbody>${blygs || '<tr><td colspan="4" class="mut">None yet.</td></tr>'}</tbody></table>
<h2>Follow a blyg</h2>
<form id="follow-form"><label>Any address on it (a post, its front page) <input type="url" name="url" required size="48" placeholder="https://"></label><button type="submit">Follow</button></form>
<h2>Import a blogroll</h2>
<form id="import-form"><p class="mut">An OPML blogroll, or a blygger.com directory (blygs.json). Nothing is added until you confirm it.</p>
<label>Address of the document <input type="url" name="url" size="48" placeholder="https://"></label>
<label>…or paste it here <textarea name="text"></textarea></label><button type="submit">Show what would be added</button></form><div id="preview"></div>
<h2>Settings</h2>
<form id="settings-form">${nums}<label>Your own blygs (one address per line): posts that answer or quote them are listed under "Responses to me"
<textarea name="my_origins">${settings.my_origins.map(o => escHtml(o)).join('\n')}</textarea></label>
<label>Mentions inbox address (https) <input type="url" name="inbox_api_url" size="48" value="${escHtml(settings.inbox_api_url)}" placeholder="https://"></label>
<label>Token file (an absolute path; its first line is the token, which is never kept here) <input type="text" name="inbox_token_file" size="48" value="${escHtml(settings.inbox_token_file)}"></label>
<button type="submit">Save settings</button></form>
<p class="mut">Read states: ${READ_STATES.map(s => escHtml(s)).join(', ')}. Inbox states: ${INBOX_STATES.map(s => escHtml(s)).join(', ')}.</p>
</main><script nonce="${escHtml(nonce)}">${SCRIPT}</script></body></html>`;
}
