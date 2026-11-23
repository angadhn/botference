// sanitize-browser.test.mjs — what the sanitiser writes, read by a REAL browser's HTML parser.
//
//   node --test test/sanitize-browser.test.mjs
//
// A tokenizer that agrees with a browser about what is a tag is not the same as an output a browser parses the way it was written.
// happy-dom is not the parser that matters here, so this runs headless Chrome or Brave (network blocked: no host resolves, every
// request is blocked) over a corpus: the hand-written cases in fixtures/following/sanitize-corpus.json (attribute tricks,
// self-closing slashes, raw-text elements, comments, tables, lists, headings, nesting) plus a seeded fuzz of a few thousand tag
// soups. For each, the sanitiser's output is parsed inside a card (<main><article><div id=b>OUT</div></article><p>page text</p></main>)
// and the DOM must show: nothing of the post outside its own div, its siblings and ancestors where they were, only the kept elements
// and attributes, no link that is not http(s) or mailto. The checks that need no browser (the output is a fixed point of the
// sanitiser; the corpus is clean of raw bidi and control characters) always run; the browser ones are SKIPPED, with a message, when no
// browser is found (set BFP_TEST_BROWSER to its executable).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sanitizeArticle, sanitizeStable } from '../sanitize.mjs';
import { followingPage } from '../following-view.mjs';
import { articleView } from '../views.mjs';
import { followingSettingsOf } from '../following.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'following', 'sanitize-corpus.json'), 'utf8'));
const TAGS = ['p', 'div', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'a href=https://e.test/', 'b', 'i', 'em', 'table', 'tr', 'td', 'th', 'tbody', 'caption', 'h1', 'h2', 'pre',
  'blockquote', 'span', 'section', 'article', 'address', 'ruby', 'rt', 'figure', 'q', 's', 'code', 'small', 'header', 'main', 'colgroup', 'col', 'thead', 'bdo dir=rtl', 'div/', 'a href=https://x.test/y/'];
function fuzz(n, seed = 7) {
  let s = seed; const rnd = k => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % k; };
  const out = [];
  for (let i = 0; i < n; i++) {
    let src = ''; const len = 3 + rnd(12);
    for (let j = 0; j < len; j++) { const r = rnd(10); const t = TAGS[rnd(TAGS.length)]; src += r < 5 ? `<${t}>` : r < 8 ? `</${t.split(/[ /]/)[0]}>` : 'w' + j; }
    out.push(src + 'END');
  }
  return out;
}
const INPUTS = [...CORPUS, ...fuzz(1500)];

test('the corpus is clean of raw bidi and control characters (it is written as escapes)', () => {
  const raw = fs.readFileSync(path.join(HERE, 'fixtures', 'following', 'sanitize-corpus.json'), 'utf8');
  assert.equal(raw.replace(/[\u0020-\u007e\n]/g, '').length, 0, 'every character of the fixture is printable ASCII');
  assert.ok(CORPUS.length >= 100);
});

test('every output is a fixed point of the sanitiser, in both modes (reading it again changes nothing), and sanitizeStable reaches one', () => {
  for (const mode of [{ landmarks: false }, {}]) {
    for (const src of INPUTS) {
      const once = sanitizeArticle(src, mode).html;
      assert.equal(sanitizeArticle(once, mode).html, once, JSON.stringify(src));
      assert.equal(sanitizeStable(src, mode).html, once);
    }
  }
});

test('an unquoted attribute value that ends in a slash does not make an element self-closing (the element is closed)', () => {
  assert.equal(sanitizeArticle('<p>See <a href=https://evil.test/>this</a>.</p><p>More.</p>').html,
    '<p>See <a href="https://evil.test/" rel="noreferrer noopener" target="_blank">this</a>.</p><p>More.</p>');
  assert.equal(sanitizeArticle('<div/>x</div>y').html, '<div>x</div>y');
  assert.equal(sanitizeArticle('<bdo dir=rtl/>x</bdo>y').html, '<bdo dir="rtl/">x</bdo>y');
  assert.equal(sanitizeArticle('<a href=https://x.test/>open').html, '<a href="https://x.test/" rel="noreferrer noopener" target="_blank">open</a>');
  assert.equal(sanitizeArticle('x<br/>y<img src=https://i.test/a.png />z').html.startsWith('x<br>y<img src="https://i.test/a.png"'), true, 'a void element may self-close');
});

test('a raw-text element ignores a slash, as a browser does: <script/> runs on to its end tag and everything inside it is dropped', () => {
  assert.equal(sanitizeArticle('a<script/>alert(1)</script>b').html, 'ab');
  assert.equal(sanitizeArticle('a<style/>p{display:none}</style>b').html, 'ab');
  assert.equal(sanitizeArticle('a<iframe/>x</iframe>b').html, 'ab');
});

test('HTML\'s implied end tags are applied by the sanitiser itself: li, dt/dd, p, headings, tables, links', () => {
  const s = h => sanitizeArticle(h, { landmarks: false }).html;
  assert.equal(s('<ul><li><div><li>x</div></li></ul>AFTER'), '<ul><li><div></div></li><li>x</li></ul>AFTER');
  assert.equal(s('<ul><li>a<li>b</ul>c'), '<ul><li>a</li><li>b</li></ul>c');
  assert.equal(s('<dl><dt>a<dd>b<dt>c</dl>d'), '<dl><dt>a</dt><dd>b</dd><dt>c</dt></dl>d');
  assert.equal(s('<p>a<div>b</div>c'), '<p>a</p><div>b</div>c');
  assert.equal(s('<h1>a<h2>b</h1>c'), '<h1>a</h1><h2>bc</h2>');
  assert.equal(s('<table><tr><td>a<td>b</table>c'), '<table><tr><td>a</td><td>b</td></tr></table>c');
  assert.equal(s('<table>text<tr><td>x</td></tr></table>'), '<table><tr><td>text</td></tr><tr><td>x</td></tr></table>', 'text in a table goes in a cell');
  assert.equal(s('<td>stray</td>after'), 'strayafter', 'a cell with no table is unwrapped');
  assert.equal(s('<a href=https://a.test/>x<a href=https://b.test/>y</a>z').replace(/ rel="noreferrer noopener" target="_blank"/g, ''), '<a href="https://a.test/">x</a><a href="https://b.test/">y</a>z');
  assert.equal(s('<section>a</section><main>b</main><header>c</header><article>d</article><aside>e</aside><footer>f</footer><address>g</address>'), 'abcdefg', 'a followed post emits no page structure');
  assert.equal(sanitizeArticle('<section><h2>Page 1</h2><p>x</p></section>').html, '<section><h2>Page 1</h2><p>x</p></section>', 'a PDF snapshot keeps its sections');
});

// ---- the browser --------------------------------------------------------------
function findBrowser() {
  const candidates = [process.env.BFP_TEST_BROWSER, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  return candidates.find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || '';
}
const BROWSER = findBrowser();

// runs in the page: the structural checks, over every output
const PAGE_CHECK = `(function(){
  var KEEP = new Set('p br hr h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote pre code kbd samp em strong i b u s strike del ins sub sup small mark span div a img figure figcaption table thead tbody tfoot tr th td caption colgroup col time abbr cite q ruby rt rp bdi bdo wbr'.split(' '));
  var LAND = new Set('main header footer section article aside address'.split(' '));
  var ATT = {a:'href title rel target',img:'src alt width height loading decoding referrerpolicy',td:'colspan rowspan',th:'colspan rowspan scope',col:'span',colgroup:'span',time:'datetime',abbr:'title',q:'cite',blockquote:'cite',ol:'start reversed type',li:'value'};
  var D = JSON.parse(document.getElementById('d').textContent), bad = [];
  D.forEach(function (c, n) {
    ['card', 'template'].forEach(function (mode) {
      var out = c.out, why = [];
      var html = '<!doctype html><html><body><main id="m"><article id="a"><div id="b">' + (mode === 'template' ? '<template id="t">' + out + '</template>' : out) +
        '</div></article><p id="after">PAGEMARK_A</p></main><footer id="f">PAGEMARK_F</footer></body></html>';
      var d = new DOMParser().parseFromString(html, 'text/html');
      var m = d.getElementById('m'), a = d.getElementById('a'), b = d.getElementById('b'), after = d.getElementById('after'), f = d.getElementById('f');
      if (!m || !a || !b || !after || !f) why.push('structure lost');
      else {
        if (m.parentElement !== d.body || f.parentElement !== d.body) why.push('page moved');
        if (a.parentElement !== m || after.parentElement !== m) why.push('card moved');
        if (b.parentElement !== a || a.children.length !== 1) why.push('body moved');
        if (m.children.length !== 2 || d.body.children.length !== 2) why.push('extra root');
        var root = mode === 'template' ? d.getElementById('t').content : b;
        var nodes = root.querySelectorAll('*');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i], t = el.localName;
          if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') why.push('ns ' + t);
          if (!KEEP.has(t) && !(c.land && LAND.has(t)) && t !== 'tbody') why.push('el ' + t);
          if (!c.land && LAND.has(t)) why.push('landmark ' + t);
          for (var k = 0; k < el.attributes.length; k++) {
            var at = el.attributes[k];
            if (!(at.name === 'lang' || at.name === 'dir' || (ATT[t] || '').split(' ').indexOf(at.name) >= 0)) why.push('attr ' + t + '.' + at.name);
            if (['href', 'src', 'cite'].indexOf(at.name) >= 0 && !/^(https?:\\/\\/|mailto:)/i.test(at.value)) why.push('url ' + at.value);
          }
          if (t === 'a' && !(el.getAttribute('rel') === 'noreferrer noopener' && el.getAttribute('target') === '_blank')) why.push('a without rel');
          if (t === 'a' && el.querySelector('a')) why.push('a in a');
        }
        if (mode === 'card' && (d.querySelectorAll('script,iframe,form,style,link,meta,base,object,embed,svg,math').length)) why.push('dangerous element');
        if (mode === 'card' && /PAGEMARK_/.test(b.textContent)) why.push('page text inside the post');
        // nothing may have been reconstructed or inserted OUTSIDE the post's own div (an unclosed link is re-opened by the parser around
        // whatever text comes next): the card has its five elements and the page's text sits directly in them
        if (mode === 'card') {
          if (d.body.querySelectorAll('*').length !== 5 + b.querySelectorAll('*').length) why.push('elements outside the post');
          if (after.children.length || f.children.length) why.push('element wrapped around page text');
        }
      }
      if (why.length) bad.push({ n: n, mode: mode, why: why.slice(0, 4), src: c.src.slice(0, 120), out: out.slice(0, 160) });
    });
  });
  return { checked: D.length, bad: bad.length, sample: bad.slice(0, 8) };
})()`;

async function browserEval(pageHtml, expression, wait = 1500) {
  const WebSocket = createRequire(path.join(HERE, '..', '..', '..', 'tests', 'x.js'))('ws');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-sanitize-browser-'));
  const file = path.join(dir, 'corpus.html');
  fs.writeFileSync(file, pageHtml);
  const port = 9400 + Math.floor(Math.random() * 400);
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, 'profile')}`,
    '--host-resolver-rules=MAP * ~NOTFOUND', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    let tabs;
    for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.length) break; } catch { /* not up yet */ } await sleep(250); }
    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let id = 0; const pend = new Map();
    ws.on('message', m => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); } });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable'); await send('Network.enable'); await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    await send('Page.navigate', { url: 'file://' + file });
    await sleep(wait);
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    ws.close();
    return r.result && r.result.value;
  } finally {
    const gone = new Promise(r => br.once('exit', r));
    br.kill();
    await Promise.race([gone, sleep(3000)]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const browserCheck = cases => browserEval(`<!doctype html><meta charset="utf-8"><script id="d" type="application/json">${JSON.stringify(cases).replace(/</g, '\\u003c')}</script>`, PAGE_CHECK);

// the whole Hub page: every hostile post in its own card, parsed by the browser WITH the page's script run (which moves each text out of
// its inert <template>): the posts stay in their cards, the cards in the list, the list and the settings form in the page's own column
const FEED_CHECK = `(function(){
  var bad = [], list = document.getElementById('hub-posts'), main = document.querySelector('main.hub-main');
  var entries = list ? list.children.length : -1;
  document.querySelectorAll('.hub-entry').forEach(function (e, n) {
    if (e.parentElement !== list) bad.push('card ' + n + ' moved');
    if (e.querySelectorAll('.hub-entry-body').length !== 1) bad.push('card ' + n + ' body count ' + e.querySelectorAll('.hub-entry-body').length);
    var body = e.querySelector('.hub-entry-body');
    if (body && body.parentElement !== e) bad.push('card ' + n + ' body moved');
    if (/END/.test(body ? body.textContent : '') !== window.__HAS[n]) bad.push('card ' + n + ' text lost or invented');
    e.querySelectorAll('button[data-act], a').forEach(function (b) { if (body && body.contains(b) && b.dataset && b.dataset.act && !b.matches('[data-act=more]') && !b.matches('[data-act=read]')) bad.push('card ' + n + ' action inside text'); });
  });
  ['settings-form', 'follow-form', 'import-form', 'hub-search'].forEach(function (id) { var el = document.getElementById(id); if (!el || !main.contains(el) || el.closest('.hub-entry')) bad.push(id + ' displaced'); });
  if (document.querySelectorAll('main').length !== 1) bad.push('main count ' + document.querySelectorAll('main').length);
  if (document.querySelectorAll('script:not([src]):not([type])').length !== 1) bad.push('script count');
  return { entries: entries, expected: window.__EXPECTED, bad: bad.length, sample: bad.slice(0, 8) };
})()`;
const rec = (n, id) => ({ key: 'k' + n, origin: 'https://alpha.example.test/notes/', id, kind: 'thread', version: 1, created: '2026-11-01T00:00:00Z', updated: '2026-11-0' + (1 + n % 8) + 'T00:00:00Z',
  title: 'Post ' + n, excerpt: 'x', author: 'a', read: 'new', identity: 'unverified', page: 'https://alpha.example.test/notes/t/' + id + '/', blyg_title: 'B', blyg_label: 'B',
  body_state: 'whole', body_rest: '', reading: '1 min', history: [], pinned_list: [], threads: [] });
for (const [label, mode] of [['the Feed', 'feed'], ['a post read here', 'article']]) {
  test(`a real browser parses ${label} with every hostile post in place: cards, list, column and forms where they belong`, { skip: BROWSER ? false : 'no Chrome or Brave found (set BFP_TEST_BROWSER to run the browser-parser corpus check)', timeout: 120000 }, async () => {
    const posts = INPUTS.slice(0, 400);
    let html, expression;
    if (mode === 'feed') {
      const entries = posts.map((src, n) => ({ head: { ...rec(n, String(n).padStart(26, '0')), body_head: sanitizeStable(src + 'END', { landmarks: false }).html }, members: [] }));
      const data = { view: 'feed', filter: 'all', counts: { all: entries.length, new: entries.length, threads: 0, fragments: 0, responses: 0 }, tabs: { feed: entries.length, mentions: 0, mentions_unseen: 0, background: 0 },
        run: { state: 'idle' }, schedule: { mode: 'off' }, last_run: null, entries, blygs: [], background: [], mentions: [], inbox: { state: 'off', never_verified: [] }, entry_total: entries.length, limit: 1000 };
      html = followingPage({ data, settings: followingSettingsOf({}).settings, nonce: 'N' }).replace(/<script src="\/assets\/anchor\.js"[^>]*><\/script>/, '');
      expression = `window.__EXPECTED = ${entries.length}; window.__HAS = ${JSON.stringify(entries.map(e => e.head.body_head.includes('END')))}; ${FEED_CHECK}`;
      const r = await browserEval(html, expression, 2500);
      assert.equal(r.entries, r.expected, 'every post has its card in the list');
      assert.equal(r.bad, 0, JSON.stringify(r.sample, null, 1));
      console.log(`  browser Feed: ${r.entries} cards, ${r.bad} breakouts`);
    } else {
      let bad = 0; const sample = [];
      // the post's own page: the text is in the article, the reader's controls are outside it and not inside a link. One browser, one
      // iframe per post (its scripts run, which puts the post's text in place).
      // (a post that sanitises to nothing has no readable copy: the view says so and has no article, which is not a breakout)
      posts.splice(0, posts.length, ...posts.filter(src => sanitizeStable(src + 'END', { landmarks: false }).html.trim()));
      const pages = posts.slice(0, 150).map(src => articleView({ page: { url: 'https://alpha.example.test/notes/t/x/', title: 'T', threads: [], page_chat: [] }, key: 'abc', me: { handle: 'o', owner: true },
        snapshot: sanitizeStable(src + 'END', { landmarks: false }).html, info: null, nonce: 'N', hub: { blyg_title: 'B', version: 1, kind: 'thread', pinned: [] } })
        .replace(/<script src="[^"]*"[^>]*><\/script>/g, ''));
      const has = pages.map((p, n) => sanitizeStable(posts[n] + 'END', { landmarks: false }).html.includes('END'));
      const check = `(async function(){
        var P = JSON.parse(document.getElementById('d').textContent), HAS = ${JSON.stringify(has)}, bad = [];
        for (var n = 0; n < P.length; n++) {
          var f = document.createElement('iframe'); f.srcdoc = P[n]; document.body.appendChild(f);
          await new Promise(function (r) { f.onload = r; });
          await new Promise(function (r) { setTimeout(r, 20); });
          var d = f.contentDocument, a = d.getElementById('bfp-article'), why = [];
          if (!a || /END/.test(a.textContent) !== HAS[n]) why.push('text lost or invented');
          ['bfp-pill', 'bfp-light', 'bfp-sheet', 'bfp-chat', 'bfp-export'].forEach(function (id) { var el = d.getElementById(id); if (!el || (a && a.contains(el)) || el.closest('a')) why.push(id + ' displaced'); });
          if (d.querySelectorAll('article').length !== 1) why.push('article count');
          if (d.querySelectorAll('header.hubhead').length !== 1) why.push('header');
          if (why.length) bad.push({ n: n, why: why.slice(0, 4) });
          f.remove();
        }
        return { bad: bad.length, sample: bad.slice(0, 6) };
      })()`;
      const r = await browserEval(`<!doctype html><meta charset="utf-8"><script id="d" type="application/json">${JSON.stringify(pages).replace(/</g, '\\u003c')}</script>`, check, 800);
      bad = r.bad; sample.push(...r.sample);
      assert.equal(bad, 0, JSON.stringify(sample, null, 1));
      console.log(`  browser article view: ${pages.length} posts, ${bad} breakouts`);
    }
  });
}

for (const [label, mode] of [['a followed post (landmarks unwrapped)', { landmarks: false }], ['a capture (landmarks kept)', {}]]) {
  test(`a real browser parses the output of ${label} with nothing moved, nothing escaping its card, nothing outside the allow-list`, { skip: BROWSER ? false : 'no Chrome or Brave found (set BFP_TEST_BROWSER to run the browser-parser corpus check)', timeout: 120000 }, async () => {
    const cases = INPUTS.map(src => ({ src, out: sanitizeStable(src, mode).html, land: !mode.landmarks === false ? true : false }));
    for (const c of cases) c.land = mode.landmarks !== false;
    const r = await browserCheck(cases);
    assert.ok(r && r.checked === INPUTS.length, 'the browser checked every input');
    assert.equal(r.bad, 0, 'breakouts and violations: ' + JSON.stringify(r.sample, null, 1));
    console.log(`  browser corpus (${label}): ${r.checked} inputs, ${r.bad} breakouts`);
  });
}
