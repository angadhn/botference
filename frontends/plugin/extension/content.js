// content.js — the page side of the Botference Web Annotator.
//
// Dormant by default (SPEC): on document_idle it asks the background whether
// this normUrl is in the cached /index. Annotated pages wake up and restore
// their highlights; everything else stays completely inert until the toolbar
// button is clicked or the reader selects text for the first time.
//
// Owns: selection UX, article extraction, highlight painting (via anchor.js),
// the drawer host (via drawer.js) and every call to the background's API proxy.
// It never fetches the COMPANION itself — see the contract at the top of
// background.js. (A site adapter may fetch its own origin directly; see below.)
//
// ── SITE ADAPTERS (adapters.js) ────────────────────────────────────────────
// Boot consults window.BFPAdapters.pick(href): the first adapter whose url
// matcher hits replaces parts of this file's behaviour for that site.
//
//   capabilities.highlights  false ⇒ nothing on the page can be wrapped in a
//                            <mark>, so: no 💬 selection pill, no provisional
//                            or restored painting, the drawer opens on Page
//                            chat and its Comments tab is disabled. Threads
//                            that already exist for such a page still render
//                            in the drawer, unpainted, badged orphan — and the
//                            server is NOT told (the anchor is not lost, this
//                            page simply cannot show it).
//   title()                  headline for the page record; '' falls through to
//                            the generic <h1>/og:title/document.title rule.
//   articleText()            Promise<string> of first-turn context; '' (any
//                            failure) falls through to the generic extraction
//                            — EXCEPT where highlights are off, because a page
//                            whose text is not in the DOM has no honest
//                            fallback: the generic extraction would scrape the
//                            app's chrome (menus, tab titles) and hand it to
//                            the bots as "the document". There we send no
//                            article_text at all and warn the user instead.
//                            Adapters may fetch their OWN origin directly —
//                            Google Docs' text only exists behind the user's
//                            session, which the background proxy (companion
//                            only) and the bots can never reach.
//
// No adapter = the default: highlights on, extraction as it always was.
(function () {
  'use strict';

  if (window.__bfpLoaded) return;
  window.__bfpLoaded = true;

  const Anchor = window.BFPAnchor;
  const Drawer = window.BFPDrawer;
  const Adapters = window.BFPAdapters || null;
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

  // The address this content script considers itself to be on. Always
  // location.href in a browser; test/harness.html sets __BFP_HREF so a site
  // adapter can be exercised without being on that site. (Not a hole: a
  // content script's `window` is its own isolated world — the page it runs on
  // cannot reach this, exactly as with __BFP_THEME.)
  const HREF = (typeof window.__BFP_HREF === 'string' && window.__BFP_HREF) || location.href;
  const URL_NOW = normUrl(HREF);
  const HOSTNAME = (() => {
    try { return new URL(HREF).hostname.replace(/^www\./, ''); }
    catch { return location.hostname.replace(/^www\./, ''); }
  })();
  const MENTION = /@(claude|codex|all)\b/i;
  const PAGE_TARGET = '__page__';

  // ---- the site adapter (see the header) ----------------------------------
  const SITE = (Adapters && Adapters.pick(HREF)) || null;
  const CAPS = Object.assign({ highlights: true }, (SITE && SITE.capabilities) || {});

  let active = false;
  let PAGE = null;        // the /page record
  let orphans = {};       // threadId -> bool
  let locs = {};          // threadId -> {start,end}
  let pendingSel = null;  // {quote,prefix,suffix,start,end} awaiting the 💬 click
  let drawer = null;
  // The first-turn context travels once per page and the companion only ever
  // uses it on the session-creating turn (chat.mjs: `first: !sid`). Two
  // separate facts decide whether to send it, and neither implies the other:
  let sentArticleText = false;   // this tab has already put it on the wire
  let pageHasSession = false;    // the record already carries a session_id
  const needContext = () => !sentArticleText && !pageHasSession;
  // …and once a session DOES exist, the page can still change under it — a
  // live Google Doc changes between two questions about it. Every
  // mention-bearing message re-reads the page and compares this hash, so a
  // rewritten document travels again (marked as a change) and an untouched one
  // never does. Memory only: a reload re-reads the page anyway.
  let lastContextHash = null;

  // FNV-1a plus the length. Not a checksum of record — just enough that two
  // different documents cannot look identical to a 32-bit comparison.
  function hashText(s) {
    const str = String(s == null ? '' : s);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16) + ':' + str.length;
  }

  // A promise that is not allowed to hold up a message the user has already
  // sent. Used for the doc attachment: late is the same as absent.
  function withTimeout(p, ms, fallback) {
    return Promise.race([
      Promise.resolve(p).catch(() => fallback),
      new Promise(res => setTimeout(() => res(fallback), ms)),
    ]);
  }
  const DOCX_TIMEOUT = 10000;

  // A burned first turn cannot be retried: after the session exists the page
  // text is never attached again. So when the adapter cannot read the
  // document, saying nothing is not an option — the bots would answer
  // confidently about a page they never saw.
  const CONTEXT_FAIL_NOTE =
    'couldn’t read the document text — the bots won’t see the page contents (reload the tab to retry)';

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

  // A shared companion has an OWNER and it has guests. Owner-only endpoints
  // (export, delete-page, the model/effort/verbosity/relay controls) answer 403
  // to everybody else, and every one of those calls has a place to show a
  // sentence — so the status is turned into that sentence here, once, instead
  // of each call site failing silently in its own way.
  // The companion's own sentences are the message wherever it wrote one
  // ("owner only — ask the owner to do that", "not your message", "that name is
  // the owner's here — pick another"); this only supplies words for a bare
  // status with no body to speak for it.
  const OWNER_ONLY = 'owner only — this companion belongs to someone else';
  function failure(r) {
    const said = String((r && r.error) || '').trim();
    const bare = !said || /^HTTP \d+$/.test(said);
    if (r && r.status === 403 && bare) return { ok: false, error: OWNER_ONLY };
    return { ok: false, error: said || 'the companion did not answer' };
  }

  // ---- who we are ---------------------------------------------------------
  // The handle configured on the options page, or (a local companion, nothing
  // configured) whatever /health calls the owner. It decides which messages the
  // drawer offers to edit — on a shared page the authors are other people's
  // handles, and "mine" can no longer be a constant.
  // Asked once, and only on a page that has actually woken up — a dormant tab
  // has nobody to be.
  const DEFAULT_AUTHOR = 'angadh';
  let AUTHOR = DEFAULT_AUTHOR;
  let identity = null;
  function whoami() {
    if (identity) return identity;
    identity = bg({ t: 'identity' }).then(r => {
      const h = (r && r.ok && r.handle) ? String(r.handle).trim() : '';
      if (h) AUTHOR = h;
      if (drawer) drawer.setAuthor(AUTHOR);
      return AUTHOR;
    }).catch(() => AUTHOR);
    return identity;
  }

  // ---- article extraction (SPEC) ------------------------------------------
  const collapse = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function headline() {
    if (SITE && SITE.title) {
      let t = '';
      try { t = collapse(SITE.title()); } catch { t = ''; }
      if (t) return t;
    }
    return genericHeadline();
  }

  function genericHeadline() {
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

  function genericArticleText() {
    const el = articleRoot();
    return collapse(el.innerText || el.textContent).slice(0, 6000);
  }

  // First-turn context. An adapter gets first refusal — it may have to fetch
  // the real document from its own origin — and anything it cannot produce
  // (non-200, network, signed out, an account chooser served 200) comes back
  // ''. Awaited at the two call sites below, before the POST.
  //
  // What happens next depends on whether this page HAS text in the DOM:
  //   highlights on  → the generic extraction still runs (an adapter is an
  //                    optimisation there, not the only way in)
  //   highlights off → nothing. Google Docs paints to a canvas, so the generic
  //                    extraction returns the app's chrome — a menu bar and a
  //                    tab title dressed up as the document. That is worse
  //                    than no context, because it reads like context. Send
  //                    none, log why, and put a warning where the user types.
  async function articleText() {
    if (SITE && SITE.articleText) {
      let t = '';
      try {
        t = await SITE.articleText();
      } catch (e) {
        if (!SITE.lastError) SITE.lastError = 'threw: ' + String((e && e.message) || e);
      }
      if (t) {
        if (drawer) drawer.setWarning('');
        return t;
      }
      console.warn('[botference] ' + (SITE.name || 'adapter') + ' could not read this page: ' +
        (SITE.lastError || 'no text') + ' — ' + (SITE.exportUrl || HREF));
      if (!CAPS.highlights) {
        if (drawer) drawer.setWarning(CONTEXT_FAIL_NOTE);
        return '';
      }
    }
    return genericArticleText();
  }

  // The document's own comment threads, which only the .docx export carries
  // (the txt export drops them). Adapter-only and best-effort in every
  // direction: no adapter, no docx() method, a failed fetch or an oversized
  // document all come back '' and the message goes out without it.
  async function docxB64() {
    if (!SITE || typeof SITE.docx !== 'function') return '';
    const b64 = await withTimeout(SITE.docx(), DOCX_TIMEOUT, '');
    if (!b64) {
      console.warn('[botference] ' + (SITE.name || 'adapter') + ' sent no document comments: ' +
        (SITE.docxError || 'no docx'));
    }
    return b64 || '';
  }

  // Everything a mention-bearing message carries about the page ITSELF, decided
  // fresh every time one is sent:
  //
  //   no session yet   → the first-turn context, exactly as before (once)
  //   session + changed→ the page text again, flagged `article_changed` so the
  //                      companion can say "the document has been edited"
  //   session + same   → nothing; the bots already have this text
  //
  // The hash is returned rather than stored: it is only committed once the
  // POST it travelled on actually succeeded (see the two call sites).
  async function mentionContext(text) {
    if (!MENTION.test(text)) return null;
    const out = {};
    const t = await articleText();
    if (t) {
      const h = hashText(t);
      if (needContext()) { out.article_text = t; out.hash = h; }
      else if (pageHasSession && h !== lastContextHash) {
        out.article_text = t; out.article_changed = true; out.hash = h;
      }
    }
    const dx = await docxB64();
    if (dx) out.docx_b64 = dx;
    return out;
  }

  function applyContext(body, ctx) {
    if (!ctx) return body;
    if (ctx.article_text) body.article_text = ctx.article_text;
    if (ctx.article_changed) body.article_changed = true;
    if (ctx.docx_b64) body.docx_b64 = ctx.docx_b64;
    return body;
  }

  // Only a message the companion actually accepted counts as having delivered
  // the page: a failed POST must leave the next mention carrying it again.
  function commitContext(ctx) {
    if (!ctx || !ctx.article_text) return;
    sentArticleText = true;
    lastContextHash = ctx.hash;
  }

  // ---- anchoring / painting ------------------------------------------------
  function freshIndex() { return Anchor.buildTextIndex(document.body); }

  // Unpaint everything, re-locate every thread against clean text, then paint
  // one at a time. Painting splits text nodes (so the index goes stale) but
  // never changes the page's concatenated text, so the offsets stay valid.
  function reanchorAll() {
    if (!PAGE) return;
    const threads = PAGE.threads || [];
    // A site with no wrappable text (Google Docs' canvas): there is nothing to
    // paint and nothing to re-locate. Threads that exist anyway — annotated
    // before an adapter existed, or by a future adapter that loses highlights —
    // stay in the drawer as orphans. The verdict is local only: /orphan is
    // never posted, because the anchor is not lost, this page just cannot
    // show it.
    if (!CAPS.highlights) {
      locs = {};
      orphans = {};
      for (const t of threads) orphans[t.id] = true;
      if (drawer) drawer.setOrphans(orphans);
      return;
    }
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
    // The escape hatch for a burned turn: suppression follows the RECORD, not
    // a memory of having tried. A mention that never got as far as creating a
    // session leaves session_id null — the bots never received the page — so
    // the next load arms the context again rather than treating the lost turn
    // as the first one.
    pageHasSession = !!PAGE.session_id;
    reanchorAll();
    if (drawer) drawer.setPage(PAGE);
    bg({ t: 'badge', count: PAGE.threads.length });
    return PAGE;
  }

  async function activate(openTab) {
    if (!active) {
      active = true;
      whoami();
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
      // the handle this browser signs with; refined by whoami() the moment the
      // background answers (drawer.setAuthor)
      author: AUTHOR,
      // what this site can actually do (see the adapter note at the top):
      // {highlights:false} turns off the selection pill and opens on Page chat
      capabilities: CAPS,
      // the pages list needs to know which row is the page it is being shown
      // on; normUrl is ours, not the drawer's, so it is handed over with it
      currentUrl: URL_NOW,
      normUrl,
      theme: window.__BFP_THEME || null,
      cssUrl: (chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('drawer.css') : 'drawer.css',

      onSelect: () => commitSelection(),

      onSave: async ({ quote, prefix, suffix, text }) => {
        const body = { url: URL_NOW, quote, prefix, suffix, msg: { text } };
        // page order is the extension's knowledge, not the server's: tell it
        // where in the stack this thread belongs (companion honours `index`)
        if (pendingSel) body.index = pageOrderIndex(pendingSel.start);
        // an empty answer is NOT sent as an empty field: no article_text at
        // all, and the flag stays down so the next mention tries again
        const ctx = await mentionContext(text);
        applyContext(body, ctx);
        const r = await api('POST', '/thread', body);
        if (!r.ok) return failure(r);
        commitContext(ctx);
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
        // `reason` = saved, but the bots will not run for this sender (a guest
        // with no bot access, or a companion started --no-agents). The drawer
        // shows it at the composer; the comment itself is safe.
        return { ok: true, queued: r.data && r.data.queued, position: r.data && r.data.position,
                 reason: r.data && r.data.reason, deduped: !!(r.data && r.data.deduped),
                 thread_id: thread && thread.id };
      },

      onCancelNew: () => { Anchor.unpaint('__new__'); pendingSel = null; },

      // The message is already on screen (the drawer appended it optimistically
      // before this ran), so everything here is reconciliation: the companion's
      // own copy of the message replaces the pending one.
      //
      // {deduped:true} is the companion saying "I already had this" — the retry
      // of a send whose answer got lost, or a double-submit that beat the
      // client's own guard. It is a SUCCESS, and the msg it echoes is the
      // existing one: the `ts` check below is what keeps it from being appended
      // a second time.
      onReply: async (threadId, text) => {
        const body = { url: URL_NOW, thread_id: threadId, text };
        const ctx = await mentionContext(text);
        applyContext(body, ctx);
        const r = await api('POST', '/reply', body);
        if (!r.ok) return failure(r);
        commitContext(ctx);
        const msg = r.data && r.data.msg;
        if (msg) {
          const list = threadId === PAGE_TARGET
            ? PAGE.page_chat
            : ((PAGE.threads || []).find(t => t.id === threadId) || {}).msgs;
          if (list && !list.some(m => m.ts === msg.ts)) list.push(msg);
          drawer.setPage(PAGE);
        } else if (r.data && r.data.deduped) {
          // deduped with nothing echoed: the record is the only truth left
          await loadPage();
        }
        return { ok: true, queued: r.data && r.data.queued, position: r.data && r.data.position,
                 reason: r.data && r.data.reason, deduped: !!(r.data && r.data.deduped) };
      },

      // A checkbox in a bot's markdown checklist was clicked. The companion
      // owns the text — it rewrites the "- [ ]" in the stored message and
      // answers with the whole new body, which the drawer renders back over
      // its optimistic toggle. Nothing is persisted client-side: a refetch of
      // /page shows the same state because the state IS the message text.
      onTick: async (threadId, ts, index, checked) => {
        const r = await api('POST', '/tick', {
          url: URL_NOW, thread_id: threadId, ts, index, checked: !!checked,
        });
        if (!r.ok) return failure(r);
        return { ok: true, text: r.data && typeof r.data.text === 'string' ? r.data.text : null };
      },

      onEdit: async (threadId, ts, text) => {
        const r = await api('POST', '/edit', { url: URL_NOW, thread_id: threadId, ts, text });
        if (!r.ok) return failure(r);
        await loadPage();
        return { ok: true };
      },

      onDelete: async (threadId, ts) => {
        const body = { url: URL_NOW, thread_id: threadId };
        if (ts) body.ts = ts;
        const r = await api('POST', '/delete', body);
        if (!r.ok) return failure(r);
        if (!ts) Anchor.unpaint(threadId);
        await loadPage();
        return { ok: true };
      },

      onExport: async () => {
        const r = await api('POST', '/export', { url: URL_NOW });
        if (!r.ok) return failure(r);
        return { ok: true, path: r.data && r.data.path };
      },

      // ---- the pages library -------------------------------------------
      // /index is the companion's map of every page it holds a record for.
      // Fetched fresh through the proxy rather than read off the background's
      // cache: this list is the whole point of the view, and it is cheap.
      onPages: async () => {
        const r = await api('GET', '/index');
        if (!r.ok) return failure(r);
        const d = r.data;
        return { ok: true, index: (d && typeof d === 'object' && d.ok !== false) ? d : {} };
      },
      // opening another page is a tab operation, so only the background can do
      // it — it also arms the one-shot auto-open flag that page will consume
      onOpenPage: url => bg({ t: 'open-page', url }),
      onExportPage: async url => {
        const r = await api('POST', '/export', { url });
        if (!r.ok) return failure(r);
        return { ok: true, path: r.data && r.data.path };
      },
      // Deleting a page takes its bot session with it (`delete_session`) — a
      // page's chat is the page, and leaving an orphaned botference session
      // behind is exactly the litter this view exists to clear. A refusal
      // (409: a turn is running for it) comes back as ordinary text for the
      // row to show.
      //
      // Deleting the page you are STANDING ON is the interesting case: the
      // record is gone, so every highlight it painted is now a mark with no
      // thread behind it. Unpaint them here, not on the next refetch — the
      // drawer's own reset cannot reach into the page.
      onDeletePage: async url => {
        const r = await api('POST', '/delete-page', { url, delete_session: true });
        if (!r.ok) return failure(r);
        const mine = normUrl(url) === URL_NOW;
        if (mine) {
          for (const t of (PAGE && PAGE.threads) || []) Anchor.unpaint(t.id);
          for (const id of Anchor.paintedIds()) Anchor.unpaint(id);
          pendingSel = null;
          locs = {};
          orphans = {};
          PAGE = { url: URL_NOW, title: headline(), site: HOSTNAME, threads: [], page_chat: [] };
          // the conversation is gone, so the first-turn context is armed again
          pageHasSession = false;
          sentArticleText = false;
          lastContextHash = null;
          if (drawer) { drawer.setPage(PAGE); drawer.setOrphans({}); }
          bg({ t: 'badge', count: 0 });
        }
        return { ok: true, session_deleted: !!(r.data && r.data.session_deleted), current: mine };
      },

      // agents popover (behind the gear). The companion answers with the
      // bridge's real option lists and context gauges; the all-null shape
      // (`options:null, status:null, bridge:"stopped"`) means the bridge has
      // simply not started yet, which the drawer renders as "asleep" rather
      // than as an error. `status` is absent on an older companion — the
      // drawer then just omits the gauges.
      // `effort` is the same shape as models ({current, options}) and is null
      // for the same reason — the bridge has not spoken yet. `verbosity` is a
      // companion-level preference, so it is a bare string and survives a
      // sleeping bridge.
      onModels: async () => {
        const r = await api('GET', '/models');
        if (!r.ok) return failure(r);
        const d = r.data || {};
        return { ok: true, current: d.current || {}, options: d.options || null,
                 status: d.status || null, bridge: d.bridge || '',
                 effort: d.effort || null, verbosity: d.verbosity || '' };
      },
      onSetModel: async (agent, model) => {
        const r = await api('POST', '/model', { agent, model });
        if (!r.ok) return failure(r);
        return { ok: true, queued: r.data && r.data.queued };
      },
      onSetEffort: async (agent, level) => {
        const r = await api('POST', '/effort', { agent, level });
        if (!r.ok) return failure(r);
        return { ok: true, queued: r.data && r.data.queued };
      },
      onSetVerbosity: async level => {
        const r = await api('POST', '/verbosity', { level });
        if (!r.ok) return failure(r);
        return { ok: true, queued: r.data && r.data.queued };
      },
      // 409 "agents are idle — nothing to relay" is an ordinary answer here,
      // not a transport failure: hand the text back for the popover to show.
      onRelay: async agent => {
        const r = await api('POST', '/relay', { agent });
        if (!r.ok) return failure(r);
        return { ok: true, queued: r.data && r.data.queued };
      },

      // owner-only on a shared companion: a refusal has to reach the chip the
      // user clicked, not disappear into a fire-and-forget
      onInterrupt: async () => {
        const r = await api('POST', '/interrupt', { url: URL_NOW });
        if (!r.ok) return failure(r);
        return { ok: true };
      },
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
    // no highlights on this site: selecting text is just selecting text
    if (!CAPS.highlights) return;
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
    if (!CAPS.highlights) return;
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
    // a row in another tab's pages list asked for this page, and this tab was
    // already loaded (so nothing would have read the storage flag)
    if (msg.t === 'autoopen') {
      activate().then(d => d && d.open());
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
      if (ev.type === 'page') {
        if (active) loadPage();
        // the pages list is a live view of /index; a no-op unless it is up
        if (drawer) drawer.refreshPages();
      } else if (drawer) drawer.onEvent(ev);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: 'unknown' });
  });

  // ---- boot ---------------------------------------------------------------------
  // One-shot: a row clicked in another tab's pages list left a flag for this
  // normUrl, which means the user asked for this page's drawer even though
  // they have not clicked anything here. Consume it (delete first, so a crash
  // between here and open() cannot leave the flag armed forever) and open.
  const AUTOOPEN_KEY = 'bfp-autoopen:' + URL_NOW;
  function consumeAutoOpen() {
    try {
      chrome.storage.local.get(AUTOOPEN_KEY, r => {
        if (!r || r[AUTOOPEN_KEY] == null) return;
        try {
          if (chrome.storage.local.remove) chrome.storage.local.remove(AUTOOPEN_KEY);
          else chrome.storage.local.set({ [AUTOOPEN_KEY]: null });
        } catch { /* ignore */ }
        activate().then(d => d && d.open());
      });
    } catch { /* no storage: the drawer simply stays shut */ }
  }

  function boot() {
    consumeAutoOpen();
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
    activate, loadPage, reanchorAll, headline, articleText, normUrl, hashText,
    site: SITE, caps: CAPS,
    // what the companion was last told the page said — the harness asserts the
    // changed/unchanged decision against it rather than inferring it
    get contextHash() { return lastContextHash; },
    // the two halves of the first-turn-context rule, observable so the harness
    // can assert the escape hatch instead of trusting it
    get sentContext() { return sentArticleText; },
    get sessionKnown() { return pageHasSession; },
    get drawer() { return drawer; },
    get page() { return PAGE; },
  };
})();
