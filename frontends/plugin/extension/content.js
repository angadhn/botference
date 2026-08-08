// content.js — the page side of the Botference Web Annotator.
//
// Dormant by default (SPEC): on document_idle it asks the background whether
// this normUrl is in the cached /index. Annotated pages wake up and restore
// their highlights; everything else stays completely inert until the toolbar
// button is clicked or the reader selects text for the first time.
//
// Owns: selection UX, article extraction, highlight painting (via anchor.js),
// the drawer host (via drawer.js) and every call to the background's API proxy.
// It never fetches anything itself — see the contract at the top of background.js.
(function () {
  'use strict';

  if (window.__bfpLoaded) return;
  window.__bfpLoaded = true;

  const Anchor = window.BFPAnchor;
  const Drawer = window.BFPDrawer;
  if (!Anchor || !Drawer) return;

  // ---- normUrl: must match background.js and the companion's store.mjs ----
  const STRIP_PARAM = /^(utm_[^=]*|fbclid|gclid)$/i;
  function normUrl(u) {
    try {
      const url = new URL(String(u));
      url.hash = '';
      const keep = [];
      for (const [k, v] of url.searchParams) if (!STRIP_PARAM.test(k)) keep.push([k, v]);
      url.search = '';
      for (const [k, v] of keep) url.searchParams.append(k, v);
      let s = url.toString().replace(/\?$/, '');
      if (s.endsWith('/') && !/^[a-z]+:\/\/[^/]+\/$/i.test(s)) s = s.slice(0, -1);
      return s;
    } catch {
      return String(u || '').split('#')[0];
    }
  }

  const URL_NOW = normUrl(location.href);
  const HOSTNAME = location.hostname.replace(/^www\./, '');
  const MENTION = /@(claude|codex|all)\b/i;
  const PAGE_TARGET = '__page__';

  let active = false;
  let PAGE = null;        // the /page record
  let orphans = {};       // threadId -> bool
  let locs = {};          // threadId -> {start,end}
  let pendingSel = null;  // {quote,prefix,suffix,start,end} awaiting the 💬 click
  let drawer = null;
  let sentArticleText = false;

  // ---- background API proxy ----------------------------------------------
  function bg(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, r => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) return resolve({ ok: false, error: err.message });
          resolve(r || { ok: false, error: 'no response from background' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }
  const api = (method, path, body) => bg({ t: 'api', method, path, body });

  // ---- article extraction (SPEC) ------------------------------------------
  const collapse = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function headline() {
    for (const sel of ['article h1', 'main h1', 'h1']) {
      const h = document.querySelector(sel);
      if (h && collapse(h.textContent)) return collapse(h.textContent);
    }
    const og = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
    if (og && collapse(og.getAttribute('content'))) return collapse(og.getAttribute('content'));
    const t = collapse(document.title);
    // strip a trailing " - Site" / " | Site" / " — Site" suffix, but only when
    // what follows is short enough to be a site name and not part of the head
    const m = t.match(/^(.{8,}?)\s+[|–—·-]\s+[^|–—·]{1,45}$/);
    return (m && m[1]) || t || location.hostname;
  }

  // The prose container: <article>, else <main>, else whichever element holds
  // the most direct <p> text — the standard "largest text block" heuristic.
  function articleRoot() {
    const direct = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]');
    if (direct) return direct;
    const score = new Map();
    for (const p of document.querySelectorAll('p')) {
      const len = (p.textContent || '').trim().length;
      if (len < 40) continue;
      const parent = p.parentElement;
      if (!parent) continue;
      score.set(parent, (score.get(parent) || 0) + len);
    }
    let best = null, bestLen = 0;
    for (const [el, len] of score) if (len > bestLen) { best = el; bestLen = len; }
    return best || document.body;
  }

  function articleText() {
    const el = articleRoot();
    return collapse(el.innerText || el.textContent).slice(0, 6000);
  }

  // ---- anchoring / painting ------------------------------------------------
  function freshIndex() { return Anchor.buildTextIndex(document.body); }

  // Unpaint everything, re-locate every thread against clean text, then paint
  // one at a time. Painting splits text nodes (so the index goes stale) but
  // never changes the page's concatenated text, so the offsets stay valid.
  function reanchorAll() {
    if (!PAGE) return;
    const threads = PAGE.threads || [];
    // RECONCILE, not just add: a thread can vanish from the record between two
    // refetches — deleted here, deleted in another tab, or emptied of its last
    // message (which deletes the thread server-side). Unpainting only the ids
    // we still know about would leave those highlights stranded on the page
    // forever, so sweep every painted id and drop the ones with no thread.
    const live = Object.create(null);
    for (const t of threads) live[t.id] = true;
    live.__new__ = true;                       // handled explicitly just below
    for (const id of Anchor.paintedIds()) if (!live[id]) Anchor.unpaint(id);
    for (const id of Object.keys(locs)) if (!live[id]) delete locs[id];
    for (const id of Object.keys(orphans)) if (!live[id]) delete orphans[id];

    for (const t of threads) Anchor.unpaint(t.id);
    Anchor.unpaint('__new__');

    let index = freshIndex();
    const nextOrphans = {};
    locs = {};
    for (const t of threads) {
      const r = Anchor.locate(index.raw, t);
      if (r.ok) { locs[t.id] = { start: r.start, end: r.end }; nextOrphans[t.id] = false; }
      else nextOrphans[t.id] = true;
    }
    for (const t of threads) {
      if (nextOrphans[t.id]) continue;
      Anchor.paintOffsets(index, locs[t.id].start, locs[t.id].end, t.id);
      index = freshIndex();
    }
    // repaint the provisional highlight if a new comment is being composed
    if (pendingSel) {
      Anchor.paintOffsets(index, pendingSel.start, pendingSel.end, '__new__');
      index = freshIndex();
    }

    // tell the server only about anchors whose verdict actually changed
    for (const t of threads) {
      const was = !!t.orphaned, now = !!nextOrphans[t.id];
      if (was !== now) {
        t.orphaned = now;
        api('POST', '/orphan', { url: URL_NOW, thread_id: t.id, orphaned: now });
      }
    }
    orphans = nextOrphans;
    if (drawer) drawer.setOrphans(orphans);
  }

  // Where a new anchor sits in the visual order of the page: every already
  // anchored thread that starts at or before it comes first. Orphans keep
  // whatever slot they already had.
  function pageOrderIndex(start) {
    let i = 0;
    for (const t of (PAGE && PAGE.threads) || []) {
      const l = locs[t.id];
      if (l && l.start <= start) i++;
      else if (!l) i++; // orphaned/unlocated: never jump ahead of it
    }
    return i;
  }

  // ---- page load / refresh --------------------------------------------------
  async function loadPage() {
    const r = await api('GET', '/page?url=' + encodeURIComponent(URL_NOW));
    // reaching the companion at all is the connection signal the user cares
    // about; the WS `conn` broadcasts refine it from there
    if (drawer) drawer.setConn(!!r.ok);
    if (!r.ok) return null;
    const rec = (r.data && r.data.page !== undefined) ? r.data.page : r.data;
    PAGE = rec && rec.url ? rec : { url: URL_NOW, title: headline(), site: HOSTNAME, threads: [], page_chat: [] };
    PAGE.threads = PAGE.threads || [];
    PAGE.page_chat = PAGE.page_chat || [];
    if (PAGE.session_id) sentArticleText = true;
    reanchorAll();
    if (drawer) drawer.setPage(PAGE);
    bg({ t: 'badge', count: PAGE.threads.length });
    return PAGE;
  }

  async function activate(openTab) {
    if (!active) {
      active = true;
      drawer = makeDrawer();
      drawer.mount();
      drawer.setPage({ url: URL_NOW, title: headline(), site: HOSTNAME, threads: [], page_chat: [] });
      // upsert the page shell so the server knows this page's real headline
      api('POST', '/page', { url: URL_NOW, title: headline(), site: HOSTNAME });
      bg({ t: 'hello', url: location.href }).then(r => { if (r && r.ok) drawer.setConn(!!r.connected); });
      await loadPage();
    }
    if (openTab !== false) drawer.open();
    return drawer;
  }

  // ---- drawer wiring ---------------------------------------------------------
  function makeDrawer() {
    return Drawer.create({
      hostname: HOSTNAME,
      author: 'angadh',
      theme: window.__BFP_THEME || null,
      cssUrl: (chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('drawer.css') : 'drawer.css',

      onSelect: () => commitSelection(),

      onSave: async ({ quote, prefix, suffix, text }) => {
        const body = { url: URL_NOW, quote, prefix, suffix, msg: { text } };
        // page order is the extension's knowledge, not the server's: tell it
        // where in the stack this thread belongs (companion honours `index`)
        if (pendingSel) body.index = pageOrderIndex(pendingSel.start);
        if (MENTION.test(text) && !sentArticleText) { body.article_text = articleText(); sentArticleText = true; }
        const r = await api('POST', '/thread', body);
        if (!r.ok) return { ok: false, error: r.error };
        const thread = (r.data && r.data.thread) || null;
        if (thread) {
          Anchor.rekey('__new__', thread.id);
          if (pendingSel) locs[thread.id] = { start: pendingSel.start, end: pendingSel.end };
          orphans[thread.id] = false;
          PAGE.threads = PAGE.threads || [];
          if (!PAGE.threads.some(t => t.id === thread.id)) PAGE.threads.push(thread);
          drawer.setPage(PAGE);
          drawer.setOrphans(orphans);
          drawer.focus(thread.id);
        }
        pendingSel = null;
        bg({ t: 'badge', count: (PAGE.threads || []).length });
        loadPage();
        return { ok: true, queued: r.data && r.data.queued, position: r.data && r.data.position, thread_id: thread && thread.id };
      },

      onCancelNew: () => { Anchor.unpaint('__new__'); pendingSel = null; },

      onReply: async (threadId, text) => {
        const body = { url: URL_NOW, thread_id: threadId, text };
        if (MENTION.test(text) && !sentArticleText) { body.article_text = articleText(); sentArticleText = true; }
        const r = await api('POST', '/reply', body);
        if (!r.ok) return { ok: false, error: r.error };
        const msg = r.data && r.data.msg;
        if (msg) {
          const list = threadId === PAGE_TARGET
            ? PAGE.page_chat
            : ((PAGE.threads || []).find(t => t.id === threadId) || {}).msgs;
          if (list && !list.some(m => m.ts === msg.ts)) list.push(msg);
          drawer.setPage(PAGE);
        }
        return { ok: true, queued: r.data && r.data.queued, position: r.data && r.data.position };
      },

      onEdit: async (threadId, ts, text) => {
        const r = await api('POST', '/edit', { url: URL_NOW, thread_id: threadId, ts, text });
        if (!r.ok) return { ok: false, error: r.error };
        await loadPage();
        return { ok: true };
      },

      onDelete: async (threadId, ts) => {
        const body = { url: URL_NOW, thread_id: threadId };
        if (ts) body.ts = ts;
        const r = await api('POST', '/delete', body);
        if (!r.ok) return { ok: false, error: r.error };
        if (!ts) Anchor.unpaint(threadId);
        await loadPage();
        return { ok: true };
      },

      onExport: async () => {
        const r = await api('POST', '/export', { url: URL_NOW });
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, path: r.data && r.data.path };
      },

      // model picker (gear popover). The companion answers with the bridge's
      // real option lists; `options:null` means the bridge has not started yet,
      // which the drawer renders as a disabled row rather than an error.
      onModels: async () => {
        const r = await api('GET', '/models');
        if (!r.ok) return { ok: false, error: r.error };
        const d = r.data || {};
        return { ok: true, current: d.current || {}, options: d.options || null, bridge: d.bridge || '' };
      },
      onSetModel: async (agent, model) => {
        const r = await api('POST', '/model', { agent, model });
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, queued: r.data && r.data.queued };
      },

      onInterrupt: () => api('POST', '/interrupt', { url: URL_NOW }),
      onReconnect: () => bg({ t: 'reconnect' }),
      onJump: id => Anchor.scrollTo(id),
      onFocus: id => {
        for (const t of (PAGE && PAGE.threads) || []) Anchor.setFocus(t.id, t.id === id);
      },
      onClose: () => { Anchor.unpaint('__new__'); pendingSel = null; },
    });
  }

  // ---- selection UX -----------------------------------------------------------
  // walk up through shadow boundaries too (parentNode is null on a shadow root,
  // so fall through to its host)
  function inOurUI(node) {
    for (let n = node; n; n = n.parentNode || n.host) {
      if (n.id === 'bfp-root') return true;
    }
    return false;
  }

  function selectionRect(sel) {
    try {
      const r = sel.getRangeAt(sel.rangeCount - 1).getClientRects();
      const last = r[r.length - 1];
      if (last && (last.width || last.height)) return last;
      const b = sel.getRangeAt(0).getBoundingClientRect();
      return b;
    } catch { return null; }
  }

  document.addEventListener('mouseup', e => {
    if (drawer && inOurUI(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !String(sel).trim()) {
        if (drawer && !pendingSel) drawer.hideSel();
        return;
      }
      if (sel.anchorNode && inOurUI(sel.anchorNode)) return;
      const rect = selectionRect(sel);
      if (!rect) return;
      // first selection on a dormant page is itself the activation gesture
      const ready = active ? Promise.resolve(drawer) : activate(false);
      ready.then(d => {
        if (!d) return;
        d.showSel(rect.right + 6, rect.bottom + 8);
      });
    }, 0);
  }, true);

  document.addEventListener('mousedown', e => {
    if (drawer && !inOurUI(e.target)) drawer.hideSel();
  }, true);

  // 💬 clicked: freeze the anchor, paint it provisionally, open the composer
  function commitSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const index = freshIndex();
    const { start, end } = Anchor.offsetsFromRange(index, sel.getRangeAt(0));
    if (end <= start) return;
    const a = Anchor.buildAnchor(index.raw, start, end);
    if (!a.quote) return;

    Anchor.unpaint('__new__');
    pendingSel = { ...a, start, end };
    Anchor.paintOffsets(index, start, end, '__new__');
    sel.removeAllRanges();
    drawer.hideSel();
    drawer.beginNew(a);
  }

  // click a highlight → open the drawer at that thread
  document.addEventListener('click', e => {
    const mark = e.target && e.target.closest && e.target.closest('mark.bfp-hl');
    if (!mark) return;
    const id = mark.getAttribute('data-bfp');
    if (!id || id === '__new__') return;
    e.preventDefault();
    activate().then(d => {
      d.open('comments');
      d.focus(id);
      const card = d.shadow && d.shadow.querySelector('.card[data-thread="' + id.replace(/"/g, '\\"') + '"]');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, true);

  // Esc closes the drawer wherever the focus is
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawer && drawer.isOpen()) { drawer.close(); }
  }, true);

  // ---- background messages -----------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.t === 'toggle') {
      if (!active) activate();
      else drawer.toggle();
      sendResponse({ ok: true });
      return;
    }
    if (msg.t === 'conn') {
      if (drawer) drawer.setConn(!!msg.connected);
      sendResponse({ ok: true });
      return;
    }
    if (msg.t === 'ws') {
      const ev = msg.ev || {};
      if (ev.type === 'page') { if (active) loadPage(); }
      else if (drawer) drawer.onEvent(ev);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: 'unknown' });
  });

  // ---- boot ---------------------------------------------------------------------
  function boot() {
    bg({ t: 'hello', url: location.href }).then(r => {
      if (!r || !r.ok) return;
      if (r.known) {
        // an annotated page: wake up and restore the highlights, but do not
        // barge in — the drawer stays shut until asked for
        activate(false).then(d => d && d.setConn(!!r.connected));
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  // exposed for test/harness.html
  window.__bfp = {
    activate, loadPage, reanchorAll, headline, articleText, normUrl,
    get drawer() { return drawer; },
    get page() { return PAGE; },
  };
})();
