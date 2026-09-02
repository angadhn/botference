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
//   capabilities.textFallback
//                            false ⇒ '' from articleText() is FINAL. A scanned
//                            PDF has text nodes (so highlights stay on) and no
//                            text in them; scraping the DOM instead would send
//                            the viewer's own chrome to the bots.
//   identityHref             WHICH PAGE this document is. The PDF viewer's
//                            address is chrome-extension://…/pdf/viewer.html
//                            and the record must be the PDF's own url, so the
//                            adapter says so and IDENT_HREF obeys it — ahead of
//                            <link rel=canonical> and ahead of location.
//   site / fileName          where it FILES, when the identity has no hostname
//                            worth having (a local PDF is identified by the
//                            hash of its bytes, so it files under 'local pdf'
//                            and records the name of the file it came from).
//   snapshotHtml()           the phone-readable copy, where cloning the article
//                            is not how you get one (a PDF's prose is PDF.js's
//                            text layer).
//   pageOf(node)             1-based page number for an anchor made at `node`;
//                            0 = this document has no pages.
//   capabilities.reportOrphans
//                            false ⇒ an anchor this page cannot find is badged
//                            locally and NOT reported. A PDF renders page by
//                            page, so "not found" usually means "not yet".
//
// No adapter = the default: highlights on, extraction as it always was.
(async function () {
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
  const MENTION = /@(claude|codex|all)\b/i;
  const PAGE_TARGET = '__page__';

  // ── NOTHING IS ANNOTATED AT A PATH ─────────────────────────────────────────
  // Granting this extension "Allow access to file URLs" — which local PDFs ask
  // for — also makes `<all_urls>` match `file:` documents, and this script would
  // then run on them. It must not.
  //
  // A path is not an identity: `file:///Users/me/Downloads/paper.pdf` says where
  // something is this morning, and a record filed under it is stranded the
  // moment the file is moved or renamed. That is the whole reason a local PDF is
  // identified by the SHA-256 of its bytes instead, computed in the extension's
  // own viewer (pdf/viewer.js), which is a chrome-extension:// page and reaches
  // this line with the hash already decided.
  //
  // It is also load-bearing for how a local PDF gets INTO that viewer. Chrome's
  // built-in PDF viewer is an iframe inside an otherwise empty top-level
  // document whose address is the file: url — a document this script happily
  // runs in. If it answers the toolbar's `{t:'toggle'}` there, the background's
  // "no content script answered, so this must be the browser's own PDF viewer"
  // fallback never fires, and clicking the button files the empty shell under
  // the path instead of opening the document. Both halves are fixed by not
  // being there. (`__BFP_HREF` is test/harness.html naming its own address, in
  // an isolated world the page cannot reach — the same escape it already uses
  // to pretend to be a site it is not.)
  //
  // ── …EXCEPT A PROJECT ARTIFACT ─────────────────────────────────────────
  // One kind of local file IS a page, and its path IS its identity: the HTML a
  // council chat wrote into its own project folder
  // (`<council>/projects/<id>/index.html`). Those files are regenerated in
  // place by design — the bots rewrite them and the reader reloads the tab —
  // so a content hash would strand every annotation at the next build, which
  // is the failure the hash exists to prevent arriving from the other
  // direction. The path is what is stable here, and the companion is the only
  // thing that can tell such a file from an ordinary local one: it looks for a
  // council root above it (project.json + work/ + projects/) and a project
  // folder the file sits inside. See workspace.mjs and SPEC.md.
  //
  // Two guards stand ahead of that question, and both are about the PDF shell
  // described above — it must never be asked for a document this script has no
  // business in. Chrome's built-in viewer is an HTML shell whose contentType is
  // the PDF's, wrapping a single <embed>; either test alone would do, and both
  // are free.
  const FILE_DOC = /^file:/i.test(location.href) && typeof window.__BFP_HREF !== 'string';
  // ── …AND THE SAME ARTIFACT SERVED BY THE COUNCIL'S OWN WEB UI ──────────
  // A bot links the file it wrote into the chat as `/files/<rel>`, so the
  // reader often meets the artifact at an http(s) address instead — and it is
  // the same document, which has to mean the same Discuss page. Only the
  // companion can say so: the origin has to be one the reader has named as
  // their council (workspace.mjs: an unlisted origin serving the same path is
  // an ordinary web page, because the bytes on screen are whatever it sent).
  //
  // The PATH PREFIX is what decides whether to ask at all. `/files/` is the
  // council server's one route for workspace files, and every other web page
  // in the world must stay exactly as cheap as it was — no companion
  // round-trip on any load, which is the whole reason this is a prefix test in
  // the page and not a question asked everywhere.
  const FILES_DOC = !FILE_DOC && /^https?:/i.test(HREF) && (() => {
    try { return new URL(HREF).pathname.startsWith('/files/'); } catch { return false; }
  })();
  // {root, project_id, project_title, rel, path, confirmed, ident_href?} — the
  // companion's answer, or test/harness.html naming its own (the same
  // isolated-world escape as __BFP_HREF: a content script's window is not the
  // page's).
  let PROJECT = (window.__BFP_PROJECT && typeof window.__BFP_PROJECT === 'object')
    ? window.__BFP_PROJECT : null;
  if (FILE_DOC) {
    if ((document.contentType || 'text/html') !== 'text/html') return;
    if (document.querySelector('body > embed[type="application/pdf"]')) return;
    // The only await in this file's boot, and only ever on a file: document —
    // or, since the council-web view, an http page under `/files/`. An async
    // function body runs synchronously until its first await, so every other
    // page still wires itself up in one turn exactly as before.
    PROJECT = await askProjectPage(location.href);
    if (!PROJECT) return;
  } else if (FILES_DOC && !PROJECT) {
    // A `no` here is not the end of the page, unlike above: an http document
    // that is not an artifact is still an ordinary web page and gets the
    // ordinary treatment.
    PROJECT = await askProjectPage(HREF);
  }

  // GET /project-page, asked before anything else in this file exists — so it
  // cannot use bg() (which stamps IDENT_HREF, still in its temporal dead zone
  // at this point) and talks to the worker itself. A companion that is off,
  // older than this feature, or belongs to somebody else all answer the same
  // way as "no": nothing attaches. Function declaration, so the gate above can
  // call it from further up the file.
  function askProjectPage(href) {
    return new Promise(resolve => {
      let done = false;
      const answer = art => { if (!done) { done = true; resolve(art); } };
      // a worker that never answers must not leave the page half-booted
      setTimeout(() => answer(null), 8000);
      try {
        chrome.runtime.sendMessage(
          { t: 'api', method: 'GET', path: '/project-page?url=' + encodeURIComponent(href) },
          r => {
            void chrome.runtime.lastError;
            const art = r && r.ok && r.data && r.data.artifact;
            // a root the reader has already refused stays refused: the drawer
            // asked once, and once is the whole promise
            answer(art && !art.declined ? art : null);
          },
        );
      } catch { answer(null); }
    });
  }

  // ---- the site adapter (see the header) ----------------------------------
  const SITE = (Adapters && Adapters.pick(HREF)) || null;
  const CAPS = Object.assign({ highlights: true, textFallback: true, reportOrphans: true },
                             (SITE && SITE.capabilities) || {});
  // What sort of document this is — the adapter's word, because it is the only
  // thing that knows (a PDF is a PDF whatever url the viewer wears). No
  // adapter means an ordinary web article, which is the honest default and the
  // overwhelmingly common case. It rides every POST /page, and the companion
  // stores it on the record so the pages list can be filtered by it.
  const PAGE_KIND = (SITE && SITE.kind) || 'article';

  // ---- which page this is -------------------------------------------------
  // Decided at load, and RE-DECIDED on a client-side navigation — see
  // rebindIdentity() far below. This used to be a one-shot const on the
  // reasoning that "a real navigation reloads the content script", which is
  // true of a link and false of a single-page app: Medium, Substack and their
  // like swap one article for the next with history.pushState, the document is
  // never torn down, this script is never re-injected, and an identity frozen
  // at load is then the PREVIOUS article's — which is how a comment gets filed
  // under the piece the reader was reading ten minutes ago.
  //
  // What is NOT re-decided is the site: an SPA route change stays on the site
  // it started on, so the adapter, its capabilities, the page kind and the
  // hostname are all still true. And where an ADAPTER or a project artifact
  // owns the identity, the address bar was never the identity in the first
  // place, so nothing about a route change there means anything.
  //
  // The one thing that must not become several records is the opposite case: a
  // site that rewrites its path per SECTION of one article. That is what
  // `Adapters.canonicalPageUrl` is for, and it is applied to the new address
  // exactly as it was to the first one — so /post-slug-section-3 still
  // collapses onto /post-slug and only a genuinely different document rebinds.
  //
  // The document's own `<link rel="canonical">` wins where it is safe to
  // believe (adapters.js: same origin, never the site root, and only ever a
  // parent whose slug the address bar has extended) — that is what merges
  // /post-slug-section-3 back into /post-slug. A site adapter owns its own
  // identity rules (Google Docs), so canonical is not consulted there.
  // Read afresh every time identity is decided: an SPA rewrites its canonical
  // link on the way past, and reading the old one back would defeat the point.
  function readCanonical(href) {
    if (SITE || !Adapters || !Adapters.canonicalPageUrl) return '';
    let el = null;
    try { el = document.querySelector('link[rel~="canonical"]'); } catch { el = null; }
    // .href resolves relative values against the document; the attribute is the
    // fallback for a harness that builds the element by hand
    const raw = el ? (el.href || el.getAttribute('href') || '') : '';
    return Adapters.canonicalPageUrl(href, raw) || '';
  }
  let CANONICAL_HREF = readCanonical(HREF);
  // Everything the extension sends — hello, /page, /thread, /reply, /snapshot,
  // the routing key on every background message — comes from these two and
  // nothing else.
  //
  // An adapter outranks all of it. The PDF viewer's address is
  // chrome-extension://<id>/pdf/viewer.html… and that is emphatically not the
  // document: it moves with the extension id, it is nobody's link, and the
  // record has to be the PDF's own url or the same paper read on two machines
  // becomes two records. `identityHref` is how an adapter says so.
  // …and a project artifact outranks even an adapter, because the companion has
  // just told us what document this is. `ident_href` is set only when the
  // ADDRESS IS NOT THE IDENTITY — the artifact reached through the council's
  // web UI at `/files/<rel>`, whose identity is the file: url of the same file
  // on this disk. Same mechanism as the PDF viewer's `identityHref`, same
  // reason: one document must not become two records because it was reached
  // two ways. Everything downstream (hello, /page, /thread, /reply, the
  // worker's routing table) already comes from this line and nothing else, so
  // the council-web tab and the file: tab address one record.
  // The address bar, live. HREF is where this script was injected and stays
  // that, because the adapter and the project lookup were decided from it; this
  // is what the reader is looking at NOW, which after a pushState is not the
  // same thing. (The harness pins its own address with __BFP_HREF and may move
  // it, exactly as a browser moves location.href.)
  const liveHref = () => (typeof window.__BFP_HREF === 'string' && window.__BFP_HREF) || location.href;
  const identityFor = href => (PROJECT && PROJECT.ident_href)
    || (SITE && SITE.identityHref) || readCanonical(href) || href;
  let IDENT_HREF = (PROJECT && PROJECT.ident_href)
    || (SITE && SITE.identityHref) || CANONICAL_HREF || HREF;
  let URL_NOW = normUrl(IDENT_HREF);
  // …and NOTHING is ever filed under the extension's own address. That is not a
  // page: it moves with the extension id, it is nobody's link, and a record
  // under it would be found again by nobody. It can only happen where an
  // adapter failed to establish an identity — a local PDF whose bytes could not
  // be read (pdf/viewer.js refuses to load this script at all in that case) —
  // and the honest response to "I do not know what document this is" is to do
  // nothing whatsoever.
  if (/^(?:chrome|moz)-extension:/i.test(IDENT_HREF)) return;
  // …and the site is the identity's site, never the viewer's: the drawer
  // remembers its last tab per hostname, and the record files under one. An
  // adapter may name it outright, which is what a local PDF needs: its identity
  // is `bfp-pdf://text/…` (or `…sha256/…` for a scan) and the hostname of
  // either is the name of an algorithm, not a place.
  // …and a project artifact has no hostname at all (a file: url's is empty),
  // so it files under — and remembers its drawer tab under — the project that
  // made it. Which is the honest answer to "where is this page from".
  const HOSTNAME = (PROJECT && PROJECT.project_id) || (SITE && SITE.site) || (() => {
    try { return new URL(IDENT_HREF).hostname.replace(/^www\./, ''); }
    catch { return location.hostname.replace(/^www\./, ''); }
  })();
  // The file a local PDF came out of, if it came out of one. Recorded so the
  // Obsidian note can name it — the hash identifies the document, but only the
  // file name tells a reader which of their PDFs it was. The PATH is never sent.
  const FILE_NAME = (SITE && SITE.fileName) || '';

  // ---- pages that carry their own margin commenting ------------------------
  // Some pages the reader opens are already a review surface: the review
  // engine's own build (`frontends/review/build.mjs`) and the review-doc
  // skill's single-file `*.review.html` both paint their own highlights and
  // pop their own "💬 Comment" pill on selection. Two selection UIs fighting
  // over one drag is the worst of both.
  //
  // ONE OF THEM HAS TO WIN, AND WITH THE PLUGIN INSTALLED IT IS OURS. On such
  // a page Discuss KEEPS the margin and the page's own selection pill is put
  // away — the reader's comments then land where the bots, send-review and the
  // project chat already are, instead of in a second record that knows nothing
  // about any of them. The rule the reader stated is an if/else, and this is
  // it: if the plugin is here, the plugin's comment button; otherwise the
  // page's own.
  //
  // Nobody else is affected. A visitor without the extension gets the page's
  // built-in commenting exactly as the page ships it — the suppression is a
  // stylesheet this content script injects into a page it is running in, so a
  // plugin-less reader never sees it and the file on disk is untouched.
  //
  // WHAT IS SUPPRESSED IS ONLY THE SELECTION AFFORDANCE. The engines' toolbars
  // — "+ General comment", "Copy feedback", "Export", "Send to Claude", the
  // resolved filter — are how the reader works with the comments that already
  // exist there, and none of them is a second answer to a drag. They stay.
  //
  // THE MARKER. One querySelector, at attach time, structural, and never
  // guessed from the url (a review build is served from anywhere):
  //
  //   body[data-docid] > #selpop      the review-doc single file: its docid on
  //                                   the body, its own selection pill a direct
  //                                   child of it
  //   body[data-slug] > aside#margin  the review engine's build: its section
  //                                   slug on the body, its comment rail a
  //                                   direct child of it
  //
  // Both halves must hit for either alternative to match, and both require the
  // body-level data attribute AND the engine's own commenting element as a
  // DIRECT child of body. An ordinary prose page has neither; a page with a
  // stray `#margin` or a CMS's `data-slug` has only one.
  const REVIEW_UI_MARKER = 'body[data-docid] > #selpop, body[data-slug] > aside#margin';
  const HOSTS_REVIEW_UI = (() => {
    try { return !!document.querySelector(REVIEW_UI_MARKER); } catch { return false; }
  })();
  // The selection-triggered pills the two engines raise on a drag, and nothing
  // else of theirs. `#selpop` is review-doc's; `#sel-pill` and `#sel-pop` are
  // the review engine's. Both engines show theirs by clearing an inline
  // `display`/`hidden`, and a stylesheet rule marked !important outranks both.
  const PAGE_SEL_UI = '#selpop, #sel-pill, #sel-pop';
  const SUPPRESS_STYLE_ID = 'bfp-page-sel-off';

  // …and the reader gets the last word, once per page. The drawer's Comments
  // tab carries the switch; the answer lives in chrome.storage.local under
  // this page's identity, so it holds across reloads and applies to nothing
  // else. Unknown until storage answers — and unknown means the DEFAULT, which
  // is that Discuss keeps the margin: that is the whole point of installing it.
  // `let`, not `const`: these are keyed by the identity, and the identity moves
  // when the reader does (rebindIdentity)
  let PAGE_COMMENTS_KEY = 'bfp:page-comments:' + URL_NOW;
  // true = the reader asked for the page's own commenting back on this page
  let pageOwnsMargin = false;
  // The single question everything else asks: is Discuss's margin commenting
  // switched off on this page right now? Only ever true where the page has its
  // own AND the reader has handed it back.
  const standDown = () => HOSTS_REVIEW_UI && pageOwnsMargin;

  // Put the page's own selection pill away — or give it back. A stylesheet
  // rather than an inline style or a removal, so nothing of the page's DOM is
  // touched: the engine can go on showing and hiding an element that simply
  // does not paint, and undoing the whole thing is removing one node.
  function suppressPageSelUI(on) {
    try {
      const have = document.getElementById(SUPPRESS_STYLE_ID);
      if (!on) { if (have) have.remove(); return; }
      if (have) return;
      const st = document.createElement('style');
      st.id = SUPPRESS_STYLE_ID;
      st.textContent = PAGE_SEL_UI + '{display:none !important}';
      (document.head || document.documentElement).appendChild(st);
    } catch { /* a page that will not take a stylesheet keeps both pills */ }
  }

  let active = false;
  let PAGE = null;        // the /page record
  // Does the companion hold a record for this page? Nothing is POSTed anywhere
  // until it does, and it only comes to hold one when the reader ACTS — a
  // saved comment, a page-chat message, an export. Visiting, activating, even
  // selecting text writes NOTHING: the library must be an archive of reading,
  // not a browsing history. True only once GET /page answered with a record.
  let registered = false;
  let orphans = {};       // threadId -> bool
  let locs = {};          // threadId -> {start,end}
  // threadId -> {was, unique, long} for a READY thread whose passage a bot
  // rewrote: what the wording used to be, and whether the new wording sits
  // somewhere unambiguous enough to show the change inline. Rebuilt from the
  // record on every re-anchor, so it can never outlive the state it describes.
  let tracks = {};
  // The reader's switch for the on-page markup. ON is the default — the whole
  // point is that the change is visible without being asked for — and the
  // answer is per page, because "show me the edits" is a thing about the draft
  // in front of them and not a mood.
  let trackChanges = true;
  let TRACK_KEY = 'bfp:track-changes:' + URL_NOW;
  // in-flight /reanchor ids: a repaint storm must not post the same durable
  // re-anchor a dozen times
  const reanchoring = Object.create(null);
  let pendingSel = null;  // {quote,prefix,suffix,start,end,mark} awaiting the pill's click
  // …and the passage the pill's QUESTION tool took, which never becomes a
  // thread and so is never painted, never anchored and never stored: it lives
  // exactly as long as the round trip that files the card.
  let pendingQ = null;
  // A thread's mark kind, the node-side twin of store.markOf: 'strike' where
  // the record says so, 'highlight' for everything else — which is every
  // thread made before the second tool existed, and every thread on an
  // ordinary article, where there is no second tool.
  const markOf = t => (t && t.mark === 'strike' ? 'strike' : 'highlight');
  let drawer = null;
  // The first-turn context travels once per page and the companion only ever
  // uses it on the session-creating turn (chat.mjs: `first: !sid`). Two
  // separate facts decide whether to send it, and neither implies the other:
  let sentArticleText = false;   // this tab has already put it on the wire
  let pageHasSession = false;    // the record already carries a session_id
  // The library record — the same relationship to the drawer that PAGE has,
  // for a page nobody is standing on. Null until the Pages view asks for it (or
  // until the first message brings it into being).
  let LIBRARY = null;
  const LIBRARY_URL = 'bfp://library';
  const isLibraryUrl = u => String(u || '') === LIBRARY_URL;
  // the drawer's own name for the library conversation (its state maps are
  // keyed by target, and '__page__' already means the page you are standing on)
  const LIBRARY_TARGET = '__library__';
  // A message's address for /run and /run-cancel: which record it is in, which
  // thread, and — because a timestamp is an address and not an identity — who
  // wrote it (store.resolveMsg does the rest).
  const runAddr = (target, ts, author) => ({
    url: target === LIBRARY_TARGET ? LIBRARY_URL : URL_NOW,
    thread_id: target === LIBRARY_TARGET ? PAGE_TARGET : target,
    ts, author,
  });
  function pushLibraryMsg(msg) {
    if (!LIBRARY) LIBRARY = { url: LIBRARY_URL, title: 'Library', site: '', threads: [], page_chat: [] };
    if (!LIBRARY.page_chat) LIBRARY.page_chat = [];
    // idempotent: a {deduped:true} answer echoes the message already stored
    if (!LIBRARY.page_chat.some(m => m.ts === msg.ts && m.author === msg.author)) {
      LIBRARY.page_chat.push(msg);
    }
    if (drawer) drawer.setLibrary(LIBRARY);
  }
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

  // ---- the extension was reloaded out from under this tab -----------------
  //
  // Reloading the extension ORPHANS every content script already running. The
  // JavaScript keeps executing perfectly — its closures, its DOM, its timers —
  // but the chrome.* bridge it was injected with is gone, and every call
  // through it now throws "Extension context invalidated". Those throws are
  // uncaught (they come out of callbacks and out of getURL), so a tab left
  // open across a reload fills its console with red on a page whose reader is
  // simply reading. That is what this section exists to stop.
  //
  // There is nothing to repair from here: a content script cannot re-inject
  // itself, and only a reload of the tab puts a live one back. So the only
  // honest behaviour is to notice ONCE, say so ONCE, and go quiet.
  const RELOAD_NOTE = 'Discuss was updated — reload this tab to reconnect.';
  // Chrome's own wording, in the two spellings it has used.
  const isContextGone = e =>
    /extension context (?:was )?invalidated/i.test(String((e && e.message) || e || ''));

  // The whole rule as a factory with nothing of chrome in it, so it can be
  // driven by a test that has no extension to invalidate:
  //   probe()    — is the extension still ours?
  //   say(text)  — where the one line goes
  //   stop()     — whatever should stop running once it is not
  // `run(fn, fallback)` is the only entry point. It answers `fallback` when the
  // context is gone (before the call, or during it) and RETHROWS anything that
  // is not a context invalidation — a blanket catch here would quietly bury
  // ordinary bugs, which is a worse console than the one being fixed.
  function makeContextGuard(probe, say, stop) {
    let gone = false;
    function lose() {
      if (gone) return;                   // once, and only once
      gone = true;
      // at info: this is news about the extension, not a fault in the page,
      // and the reader is not being asked to do anything urgent
      try { say(RELOAD_NOTE); } catch (_) { /* nowhere to say it */ }
      try { if (stop) stop(); } catch (_) { /* already falling over */ }
    }
    return {
      run(fn, fallback) {
        if (gone || !probe()) { lose(); return fallback; }
        try { return fn(); }
        catch (e) {
          if (!isContextGone(e)) throw e;
          lose();
          return fallback;
        }
      },
      // for the places that already have their own broad catch (a port that
      // fails mid-respawn is not this) and only want the verdict
      saw(e) { if (isContextGone(e)) lose(); return gone; },
      lose,
      get gone() { return gone; },
    };
  }

  // The idiom. An orphaned script still HAS a chrome.runtime object; what it no
  // longer has is an id — reading it answers undefined, or throws, and both
  // answers mean the same thing.
  function extensionAlive() {
    try { return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id); }
    catch (_) { return false; }
  }
  const GUARD = makeContextGuard(
    extensionAlive,
    m => { try { console.info('[botference] ' + m); } catch (_) { /* no console */ } },
    // everything that would go on asking a runtime that is not there stops,
    // so the one line stays one line
    () => {
      if (waitTimer) clearInterval(waitTimer);
      if (portTimer) clearTimeout(portTimer);
      waitTimer = null;
      portTimer = null;
      port = null;
    });
  const alive = (fn, fallback) => GUARD.run(fn, fallback);
  // chrome.runtime.getURL that cannot throw. '' means "no extension any more",
  // and every caller has something sensible to do with that.
  const extUrl = p => alive(
    () => (chrome.runtime.getURL ? chrome.runtime.getURL(p) : ''), '');

  // ---- background API proxy ----------------------------------------------
  function bg(msg) {
    return new Promise(resolve => {
      if (GUARD.gone || !extensionAlive()) {
        GUARD.lose();
        return resolve({ ok: false, error: RELOAD_NOTE });
      }
      try {
        // page_url rides on everything: the worker's routing table is memory
        // only, and this is what puts this tab back in it after a respawn
        chrome.runtime.sendMessage({ ...msg, page_url: IDENT_HREF }, r => {
          // the callback runs later, and "later" is long enough for the
          // extension to have been reloaded underneath it
          const err = alive(() => chrome.runtime.lastError, null);
          if (err) {
            GUARD.saw(err);
            return resolve({ ok: false, error: err.message });
          }
          resolve(r || { ok: false, error: 'no response from background' });
        });
      } catch (e) {
        GUARD.saw(e);
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
      if (drawer) {
        drawer.setAuthor(AUTHOR);
        // …and whether this browser is the OWNER here, which is what decides
        // if the pages list offers to rename and tag. The companion is the
        // authority (GET /whoami, behind the background's cache); anything
        // less than a plain yes leaves the controls out.
        drawer.setOwner(!!(r && r.ok && r.is_owner));
      }
      return AUTHOR;
    }).catch(() => AUTHOR);
    return identity;
  }

  // ---- may a code block be run here? --------------------------------------
  // Asked once, of the companion, because only the companion knows both halves:
  // whether the feature is switched on in config.json and whether this browser
  // is the OWNER (a guest is refused, and never sees the button in the first
  // place). Anything other than a plain yes leaves it off — an older companion
  // has no /run, and a 403 is an answer.
  let runAsked = null;
  function runReady() {
    if (runAsked) return runAsked;
    runAsked = api('GET', '/run').then(r => {
      const on = !!(r && r.ok && r.data && r.data.enabled);
      if (drawer) drawer.setCanRun(on);
      return on;
    }).catch(() => false);
    return runAsked;
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
    const og = (() => {
      const el = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
      return (el && collapse(el.getAttribute('content'))) || '';
    })();
    for (const sel of ['article h1', 'main h1', 'h1']) {
      const all = document.querySelectorAll(sel);
      if (!all.length) continue;
      // "the first <h1>" is only the article's name on a page that has ONE.
      // Plenty of long pieces use h1 for their section headings too (appendices,
      // chapters), and there the first one in document order is as likely to be
      // "Appendix A" as the title — which is how a record ends up filed under a
      // heading nobody would recognise. The page's own og:title is the honest
      // answer in that case, because it exists to answer exactly this question.
      if (all.length > 1 && og) return og;
      const t = collapse(all[0].textContent);
      if (t) return t;
    }
    if (og) return og;
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
    return withoutWasMarkup(() => collapse(el.innerText || el.textContent).slice(0, 6000));
  }

  // Read the page as it stands, not as it stood. `innerText` is a rendering of
  // what is laid out, so our struck old wording would ride into it — and the
  // one thing the bots must never be handed is a draft with the sentences a
  // change removed still sitting in it, unmarked. buildTextIndex skips the
  // markup structurally; innerText has no such door, so the nodes are hidden
  // for the length of the read and put back before anything can paint.
  function withoutWasMarkup(fn) {
    let hidden = [];
    try { hidden = [...document.querySelectorAll('del.bfp-was')]; } catch { hidden = []; }
    for (const n of hidden) n.style.setProperty('display', 'none', 'important');
    try { return fn(); }
    finally { for (const n of hidden) n.style.removeProperty('display'); }
  }

  // ---- the article, as a thing a phone can read ---------------------------
  // A readable copy of the prose, sent to the companion so /a/<key> can show
  // the page — with its highlights — to someone who never visited it. The
  // companion sanitizes whatever arrives (sanitize.mjs is the authority, since
  // it must be safe against any client at all); this pass exists to keep the
  // payload small and honest: our own marks come out, the obvious junk comes
  // out, and every link is made absolute while we still know what page we are.
  const SNAP_MAX = 3 * 1024 * 1024;
  const SNAP_JUNK = 'script,style,iframe,noscript,svg,canvas,video,audio,form,button,'
    + 'input,select,textarea,link,meta,template,object,embed,nav,footer';

  function snapshotHtml() {
    // An adapter may own the capture too. A PDF has no article element to
    // clone — its prose lives in PDF.js's text layer, absolutely positioned
    // span by span — so the PDF adapter hands back the words under the same
    // page markers the viewer shows, which is what makes an anchor made here
    // findable on the phone.
    if (SITE && typeof SITE.snapshotHtml === 'function') {
      let html = '';
      try { html = String(SITE.snapshotHtml() || ''); } catch (_) { html = ''; }
      return html.length > SNAP_MAX ? '' : html;
    }
    let root;
    try { root = articleRoot(); } catch (_) { return ''; }
    if (!root) return '';
    let clone;
    try { clone = root.cloneNode(true); } catch (_) { return ''; }
    try {
      // our own highlight marks are UNWRAPPED, never removed: they wrap the
      // very text the anchors point at, so deleting them would delete the
      // sentence the comment is about
      clone.querySelectorAll('mark.bfp-hl').forEach((m) => {
        const parent = m.parentNode;
        if (!parent) return;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
      });
      // …and our TRACK-CHANGES markup is REMOVED outright, which is the
      // opposite call and the right one: the struck old wording is a sentence
      // that is not in the document any more. Unwrapping it would put a
      // deleted passage back into the prose the phone reads and the bots are
      // sent, where nothing marks it as gone.
      clone.querySelectorAll('del.bfp-was').forEach(n => n.remove());
      clone.querySelectorAll('#bfp-root').forEach(n => n.remove());
      clone.querySelectorAll(SNAP_JUNK).forEach(n => n.remove());
      // relative URLs mean nothing on the companion's hostname
      clone.querySelectorAll('a[href]').forEach((a) => {
        try { a.setAttribute('href', a.href); } catch (_) { }
      });
      clone.querySelectorAll('img[src]').forEach((i) => {
        try { i.setAttribute('src', i.src); } catch (_) { }
      });
    } catch (_) { /* a partial clean is still worth sending */ }
    const html = clone.innerHTML || '';
    return html.length > SNAP_MAX ? '' : html;
  }

  // Sent on the same cadence the article TEXT is: once when this page first
  // gets an annotation, and thereafter only when the prose actually changed.
  // Awaitable, because the FIRST send on a page waits for it (the record and
  // the snapshot must both be on disk before the message that may summon the
  // bots — planSteps reads hasSnapshot when the turn is planned); every later
  // call is fire-and-forget, and a failure only rearms the hash. A snapshot
  // failing never blocks a message: the promise always resolves.
  // A capture can race the parser: an annotation sent while the body is still
  // streaming in files the header + table of contents and calls it the page
  // (80000hours problem profiles reproduce this — scripts mid-body stall the
  // parse long enough to comment). Wait, bounded, for the load event before
  // any capture; on a page that never settles, the 4s timeout lets the send
  // proceed with what exists and the hash gates re-send when the prose lands.
  const pageSettled = document.readyState === 'complete'
    ? Promise.resolve()
    : new Promise((resolve) => {
        window.addEventListener('load', resolve, { once: true });
        setTimeout(resolve, 4000);
      });
  let lastSnapHash = null;
  function snapshotNow() { return pageSettled.then(sendSnapshot); }
  function sendSnapshot() {
    let html = '';
    try { html = snapshotHtml(); } catch (_) { return Promise.resolve(); }
    if (!html) return Promise.resolve();
    const h = hashText(html);
    if (h === lastSnapHash) return Promise.resolve();
    lastSnapHash = h;
    return api('POST', '/snapshot', { url: URL_NOW, html })
      .then((r) => { if (!r || !r.ok) lastSnapHash = null; })
      .catch(() => { lastSnapHash = null; });
  }
  // fire and forget: a snapshot is never worth delaying a comment for
  function maybeSnapshot() { snapshotNow(); }

  // --- a picture of the page, for the bots -------------------------------
  // The snapshot carries the WORDS of this document and a figure is not words.
  // A reader who highlights "Figure 3: mean drift by cohort" and asks what the
  // plot actually shows is asking about the one thing no extract has ever
  // held — and the bots, having only the caption, said so or, worse, guessed.
  // The viewer is drawing that page anyway, so it renders it to an image
  // (`__BFP_PDF.capture`) and it goes beside the snapshot, where the turn
  // names it (chat.mjs figureBlock).
  //
  // Same cadence and the same reason as the snapshot: it lands BEFORE the
  // message that may summon, because the turn is planned against what is on
  // disk. It is not only for mentions — the summon may come hours later from
  // the phone, with this tab long closed, and a page nobody captured then is a
  // page nobody can capture at all.
  //
  // Content-keyed at both ends: the same page rendered again hashes the same
  // here and is not sent, and a send that gets through writes nothing on the
  // companion if the bytes match. A failure rearms and never blocks anything.
  const shotHashes = new Map();
  const CAPTURE_MS = 6000;
  function capturePage(n) {
    const page = Math.floor(Number(n) || 0);
    const V = (typeof window !== 'undefined' && window.__BFP_PDF) || null;
    if (!(page > 0) || !V || typeof V.capture !== 'function') return Promise.resolve();
    let shot;
    try { shot = V.capture(page); } catch (_) { return Promise.resolve(); }
    // never let a slow render hold a comment: the picture is worth waiting a
    // moment for and worth nothing at all if it costs the reader their send
    return Promise.race([
      Promise.resolve(shot).then((s) => {
        if (!s || !s.data) return;
        const h = hashText(String(s.ext || '') + ':' + s.data);
        if (shotHashes.get(page) === h) return;
        shotHashes.set(page, h);
        return api('POST', '/page-image',
          { url: URL_NOW, page, ext: s.ext || 'png', data: s.data })
          .then((r) => { if (!r || !r.ok) shotHashes.delete(page); })
          .catch(() => { shotHashes.delete(page); });
      }).catch(() => { shotHashes.delete(page); }),
      new Promise((resolve) => setTimeout(resolve, CAPTURE_MS)),
    ]);
  }
  // which page of the document a thread is anchored to, as the record has it
  function pageOfThread(threadId) {
    const t = (PAGE && (PAGE.threads || []).find(x => x.id === threadId)) || null;
    return (t && t.page > 0) ? t.page : 0;
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
      // Two ways an adapter can mean "and there is no honest fallback": a page
      // whose text is not in the DOM at all (Google Docs' canvas), and one
      // whose text is in the DOM but is not there (a scanned PDF, where the
      // generic extraction would hand the bots the viewer's own chrome).
      if (!CAPS.highlights || CAPS.textFallback === false) {
        if (drawer) drawer.setWarning(SITE.contextNote || CONTEXT_FAIL_NOTE);
        return '';
      }
    }
    // same parser race as the snapshot: don't read the DOM mid-stream
    await pageSettled;
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
  // `route` is the composer's pill (or the thread's sticky address): a message
  // with no @-mention in it that is going to a bot anyway. It summons, so it
  // needs the page in front of the bot exactly as a tagged message does.
  async function mentionContext(text, route) {
    if (!MENTION.test(text) && !(route && route !== 'none')) return null;
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
    // The snapshot rides the same cadence as the page text: every mention
    // re-reads the article, so every mention is also a chance to notice the
    // prose moved under an existing conversation. Its own hash gate makes a
    // repeat cheap, so this is safe to call on each one.
    maybeSnapshot();
    if (!ctx || !ctx.article_text) return;
    sentArticleText = true;
    lastContextHash = ctx.hash;
  }

  // ---- anchoring / painting ------------------------------------------------
  function freshIndex() { return Anchor.buildTextIndex(document.body); }

  // Unpaint everything, re-locate every thread against clean text, then paint
  // one at a time. Painting splits text nodes but never changes the page's
  // concatenated text, so the offsets stay valid — and paintOffsets now mends
  // the index in place as it splits, so ONE index serves the whole sweep. It
  // used to be rebuilt from the whole document between every two highlights,
  // which is what made a long document with many threads unopenable.
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
      tracks = {};
      for (const t of threads) orphans[t.id] = true;
      if (drawer) drawer.setOrphans(orphans);
      if (drawer) drawer.setTrackChanges({ on: trackChanges, threads: [] });
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

    // the struck old wording comes down BEFORE the index is built: it is
    // skipped by buildTextIndex anyway, but a re-anchor that rebuilds it from
    // the record is the only thing allowed to decide it is still there
    Anchor.unpaintWas(null);
    for (const t of threads) Anchor.unpaint(t.id);
    Anchor.unpaint('__new__');

    const index = freshIndex();
    const nextOrphans = {};
    locs = {};
    tracks = {};
    for (const t of threads) {
      const r = Anchor.locate(index.raw, t);
      if (r.ok) {
        locs[t.id] = { start: r.start, end: r.end }; nextOrphans[t.id] = false;
        // Already re-anchored on an earlier visit: the record's own anchor is
        // the NEW wording and `prior_quote` is what it replaced, so the change
        // is still the thing to show here — and it survives a reload, another
        // tab and another machine, which is what made it worth storing.
        noteTrack(t, r, t.prior_quote);
        continue;
      }
      // THE PASSAGE IS GONE. Which is exactly what a change that rewrote it
      // looks like — and if a bot said what it now reads, the page can be
      // asked about THAT instead of leaving the thread stranded.
      const moved = relocateRewritten(t, index.raw);
      if (moved) {
        locs[t.id] = { start: moved.start, end: moved.end }; nextOrphans[t.id] = false;
        noteTrack(t, moved, t.prior_quote || t.quote);
        makeDurable(t, moved, index.raw);
      } else nextOrphans[t.id] = true;
    }
    for (const t of threads) {
      if (nextOrphans[t.id]) continue;
      // a resolved thread is painted green from the record, so a page reloaded
      // months later still shows at a glance which passages were dealt with —
      // and one a bot has answered but the reader has not yet filed is painted
      // amber, so the same glance says which passages are waiting on them
      Anchor.paintOffsets(index, locs[t.id].start, locs[t.id].end, t.id,
        t.resolved ? true : (t.addressed ? 'ready' : false), markOf(t));
    }
    // repaint the provisional highlight if a new comment is being composed
    if (pendingSel) {
      Anchor.paintOffsets(index, pendingSel.start, pendingSel.end, '__new__', false, pendingSel.mark);
    }

    // Tell the server only about anchors whose verdict actually changed — and
    // only where a local verdict is worth anything.
    //
    // A PDF arrives page by page: an anchor on page 40 is unfindable until page
    // 40's text layer lands, and a tab closed halfway through would otherwise
    // leave the record saying "orphaned" about a passage that is perfectly
    // there. A scan is the same story told all at once. So a document whose
    // adapter says `reportOrphans:false` keeps its verdicts LOCAL — the drawer
    // badges what it cannot show, and the record is left alone.
    for (const t of threads) {
      const was = !!t.orphaned, now = !!nextOrphans[t.id];
      if (was !== now) {
        t.orphaned = now;
        if (CAPS.reportOrphans !== false) {
          api('POST', '/orphan', { url: URL_NOW, thread_id: t.id, orphaned: now });
        }
      }
    }
    orphans = nextOrphans;
    if (drawer) drawer.setOrphans(orphans);
    paintTrackChanges();
  }

  // ---- track changes, on the page -----------------------------------------
  //
  // THE PROBLEM. A bot rewrites the passage a comment is about. The old
  // wording is no longer on the page, so the highlight orphans; the card can
  // draw a before→after because the bot quoted the new wording back, but the
  // page itself shows only the new text, unmarked. The reader re-reading their
  // own draft has no bearing at all on where the change landed.
  //
  // THE ANSWER, in two halves. The highlight moves onto the new wording (so
  // the thread has a place again, and clicking it opens the thread through the
  // machinery that was already there), and the wording it REPLACED is shown
  // struck through immediately before it — Word's idiom, and the same idiom
  // the card's diff already uses.
  //
  // WHERE IT FIRES: here, on the first successful LOCATE, and not at the
  // choke point that sets `addressed`. The companion has no DOM; it can only
  // know that a bot CLAIMED a new wording, never that the wording is really on
  // the page. Re-anchoring on the claim would rewrite a thread's anchor on the
  // strength of a sentence — and could destroy an anchor that still matched.
  // So the page proves it first, and only then is it written down. A locate
  // that fails changes nothing and the thread stays orphaned exactly as it did
  // before any of this existed.
  const WHY_AMBIGUOUS = 'this passage was rewritten — the new wording appears more '
    + 'than once here, so the change is shown in the comment rather than inline';
  const WHY_LONG = 'this passage was rewritten — too long to show the old wording '
    + 'inline, so the change is shown in the comment';

  // Ask the page about the wording a bot said the passage NOW reads. Only for
  // a thread the bots have answered and the reader has not filed: an open
  // thread has had no claim made about it, and a filed one is finished.
  function relocateRewritten(t, raw) {
    if (!t || !t.addressed || t.resolved) return null;
    const now = Anchor.newWording(t);
    if (!now) return null;
    // the OLD context still applies: a rewrite replaces the passage, not the
    // paragraph around it, so prefix/suffix are exactly what disambiguates
    const r = Anchor.locate(raw, { quote: now, prefix: t.prefix, suffix: t.suffix });
    if (!r.ok) return null;
    return { start: r.start, end: r.end, unique: !!r.unique, quote: now };
  }

  // What this thread's inline markup should say, if anything. `was` is the
  // wording that left; there is nothing to show without one.
  function noteTrack(t, r, was) {
    if (!t.addressed || t.resolved) return;
    was = String(was || '').trim();
    if (!was) return;
    const now = String(t.quote || '');
    tracks[t.id] = {
      was,
      unique: r.unique !== false,
      // Cap sanity: passages are prose spans, not pages. Past this the inline
      // markup stops being a change and becomes a second copy of the document
      // sitting in the middle of the first one.
      long: was.length > Anchor.WAS_MAX || now.length > Anchor.WAS_MAX,
    };
  }

  // Write the re-anchor down. Owner-only server-side; a guest's companion
  // simply refuses and the tab keeps its local re-anchor for this visit, which
  // is the harmless direction.
  function makeDurable(t, moved, raw) {
    if (reanchoring[t.id]) return;
    reanchoring[t.id] = true;
    const a = Anchor.buildAnchor(raw, moved.start, moved.end);
    api('POST', '/reanchor', {
      url: URL_NOW, thread_id: t.id,
      quote: a.quote, prefix: a.prefix, suffix: a.suffix,
    }).then(r => {
      delete reanchoring[t.id];
      if (!r || !r.ok) return;
      const saved = r.data && r.data.thread;
      if (!saved) return;
      // fold the companion's answer straight in rather than refetching: the
      // record is the same object the drawer is rendering
      const live = ((PAGE && PAGE.threads) || []).find(x => x.id === t.id);
      if (live) {
        live.prior_quote = saved.prior_quote;
        live.quote = saved.quote;
        live.prefix = saved.prefix;
        live.suffix = saved.suffix;
        live.orphaned = false;
        if (drawer) drawer.setPage(PAGE);
      }
    }).catch(() => { delete reanchoring[t.id]; });
  }

  // Sync every `.bfp-was` on the page with `tracks` and the reader's switch.
  // One sweep, both directions, so there is no path by which markup outlives
  // the state that justified it — resolving, "not done", a refetch and the
  // toggle all end up here.
  function paintTrackChanges() {
    const showing = Object.create(null);
    if (trackChanges) {
      for (const id of Object.keys(tracks)) {
        if (orphans[id]) continue;
        showing[id] = tracks[id];
      }
    }
    for (const id of Anchor.wasIds()) if (!showing[id]) Anchor.unpaintWas(id);
    for (const id of Object.keys(tracks)) if (!showing[id]) Anchor.markInserted(id, false);
    for (const id of Object.keys(showing)) {
      const info = showing[id];
      // Ambiguous or oversized: the highlight still moved (the thread has a
      // place again) but the old wording is not put inline, and the mark says
      // why for anyone who hovers it.
      if (!info.unique || info.long) {
        Anchor.unpaintWas(id);
        Anchor.markInserted(id, true, info.long ? WHY_LONG : WHY_AMBIGUOUS);
        continue;
      }
      if (!Anchor.paintWas(id, info.was)) Anchor.markInserted(id, true, WHY_LONG);
    }
    if (drawer) drawer.setTrackChanges({ on: trackChanges, threads: Object.keys(tracks) });
  }

  // The switch itself, thrown from the drawer's Comments tab. Persisted per
  // page, exactly like the margin switch: the default (ON) stores nothing, so
  // a page nobody has an opinion about costs no storage at all.
  function setTrackChanges(want) {
    trackChanges = !!want;
    try {
      if (!trackChanges) chrome.storage.local.set({ [TRACK_KEY]: true });
      else if (chrome.storage.local.remove) chrome.storage.local.remove(TRACK_KEY);
      else chrome.storage.local.set({ [TRACK_KEY]: false });
    } catch { /* the choice still holds for this page view */ }
    paintTrackChanges();
  }

  // …read back at boot. A stored value means the reader turned it OFF here.
  function loadTrackChanges() {
    if (!extensionAlive()) return;
    try {
      chrome.storage.local.get(TRACK_KEY, r => {
        if (!r || !r[TRACK_KEY]) return;
        trackChanges = false;
        paintTrackChanges();
      });
    } catch { /* no storage: the markup shows, which is the default */ }
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

  // ---- is the companion there? ---------------------------------------------
  //
  // Two different facts used to be one flag, and the cheaper one kept winning.
  // "The companion answered" is an HTTP fact. "The live stream is up" is a
  // WebSocket fact, and a worker that has just been woken has not opened its
  // socket yet — so `hello` answers `connected:false` while every request is
  // working perfectly. That answer could land AFTER a successful GET /page and
  // overwrite it, which is how a healthy companion drew the full
  // "Companion offline" banner: a permanent verdict from a transient probe.
  // It showed up mostly on PDFs because opening one is a fresh extension page,
  // which is a fresh worker wake far more often than a tab on an article is.
  //
  // So: only HTTP may say "offline", and only after it has been given a couple
  // of quick second chances; the socket may only ever say "yes". The drawer
  // already has the soft state for the in-between — `connKnown:false` renders
  // "connecting…" rather than a banner — and this keeps it there.
  const CONN_GRACE = 2;                     // failures tolerated before the verdict
  const CONN_RETRY_MS = [700, 2000];        // …each one chased up, quickly
  let connFails = 0;
  let connRetries = 0;

  function connHttp(ok) {
    if (ok) {
      connFails = 0;
      connRetries = 0;
      if (drawer) drawer.setConn(true);
      return;
    }
    connFails++;
    if (connFails > CONN_GRACE) {
      // genuinely unreachable, and now it is worth saying so
      if (drawer) drawer.setConn(false);
      return;
    }
    // still in grace: say nothing, and go and look again rather than waiting
    // for the reader to press something
    const wait = CONN_RETRY_MS[Math.min(connRetries, CONN_RETRY_MS.length - 1)];
    connRetries++;
    setTimeout(() => { if (active) loadPage(); }, wait);
  }

  // A socket coming up is proof the companion is there; a socket being down is
  // not proof of anything at all, so it never sets the banner.
  function connSocket(up) {
    if (up) { connFails = 0; connRetries = 0; if (drawer) drawer.setConn(true); }
  }

  // ---- what this page is CALLED --------------------------------------------
  // `title` is what the page called itself; `custom_title` is what the reader
  // renamed it to, and the reader wins — the companion's own displayTitle()
  // rule, applied on this side so that every surface the extension draws (the
  // drawer's header, the viewer's top bar, the tab) agrees with the archive.
  // The scraped title keeps travelling underneath on POST /page, which is why
  // a rename can never be undone by a revisit.
  const displayTitle = rec =>
    (rec && (rec.custom_title || rec.title || rec.url)) || '';
  const titleWatchers = [];
  let lastAnnouncedTitle = null;
  function announceTitle() {
    const t = PAGE ? displayTitle(PAGE) : '';
    if (t === lastAnnouncedTitle) return;
    lastAnnouncedTitle = t;
    for (const cb of titleWatchers) { try { cb(t); } catch (_) { /* a watcher is not the page */ } }
  }

  // ---- page load / refresh --------------------------------------------------
  async function loadPage() {
    const r = await api('GET', '/page?url=' + encodeURIComponent(URL_NOW));
    // reaching the companion at all is the connection signal the user cares
    // about; the WS `conn` broadcasts only ever confirm it (see connHttp)
    connHttp(!!r.ok);
    if (!r.ok) return null;
    const rec = (r.data && r.data.page !== undefined) ? r.data.page : r.data;
    // a real record on the companion is the ONLY thing that marks this page
    // registered — page:null means it has never been acted on, and nothing
    // may be POSTed for it until it is
    registered = !!(rec && rec.url);
    const base = rec && rec.url
      ? rec
      : { url: URL_NOW, title: headline(), site: HOSTNAME, threads: [], page_chat: [] };
    // The drawer draws whatever it is handed, so it is handed the name the
    // reader chose — but on a COPY. Overwriting `title` on the record itself
    // would destroy the page's own name in place, and clearing a rename has to
    // be able to fall back to it. (The arrays are shared deliberately: the rest
    // of this file appends to PAGE.threads and means the record.)
    PAGE = Object.assign({}, base, { own_title: base.title, title: displayTitle(base) });
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
    // a rename arrives as a `page` event, which lands here — so this is also
    // where everything else that shows a name finds out about it
    announceTitle();
    bg({ t: 'badge', count: PAGE.threads.length });
    // …and the review round, if one is running. The strip is fed by broadcast,
    // which by definition says nothing about what happened before this tab was
    // listening — so a tab that woke up (or reloaded, or resynced after the
    // socket dropped) mid-round asks. Owner-only on the companion, so a guest
    // simply gets nothing and the strip stays down.
    loadRound();
    // …and whether this page is a draft of the reader's OWN SITE, served
    // locally out of a repo they have registered (blog.mjs). Asked here rather
    // than at boot, and only once the drawer is up, because the answer is only
    // ever used to draw a card: an ordinary web page must not cost a companion
    // round-trip merely for being looked at.
    loadBlog();
    // …and how much of the FILE's own margin is still outside this record. It
    // is recomputed from the record every load, which is what takes the import
    // card down the moment the last annotation lands.
    syncPdfImport();
    return PAGE;
  }

  // ---- the comments the PDF itself carried ---------------------------------
  //
  // pdf/viewer.js reads the file's own annotations — Acrobat highlights,
  // Preview sticky notes, an /IRT reply chain — and calls in here with them.
  // This file does two things with that list and nothing else: works out how
  // many of them this page has NOT already taken in, and posts them when the
  // reader says so.
  //
  // WHAT MAKES IT IDEMPOTENT is the same thing that makes the review mirror
  // idempotent: every annotation carries an `origin` id (a hash of the page,
  // the place, the author and the words — pdf/annots.js), the companion files
  // threads under it, and this side subtracts what is already filed. So a
  // paper reopened for the twentieth time offers nothing, with no state kept
  // anywhere about having offered before.
  let pdfAnnotList = [];
  function pdfOriginIds() {
    const seen = Object.create(null);
    const take = o => { if (o && o.system === 'pdf-annot' && o.id) seen[o.id] = true; };
    for (const t of (PAGE && PAGE.threads) || []) {
      take(t.origin);
      for (const m of t.msgs || []) take(m.origin);
    }
    for (const m of (PAGE && PAGE.page_chat) || []) take(m.origin);
    return seen;
  }
  // …counting a comment as pending if EITHER it or any of its replies is not
  // here yet: a supervisor who answered their own note after the first import
  // has said something new, and it should be offered.
  function pdfPending() {
    const have = pdfOriginIds();
    return pdfAnnotList.filter(a =>
      !have[a.id] || (a.replies || []).some(r => r && r.id && !have[r.id]));
  }
  // …and the answer is only handed over when it has CHANGED. loadPage calls
  // this every time, and an ordinary article (which is most pages, most of the
  // time) has nothing to say here — a render per page load for a document with
  // no annotations in it would be a cost paid by everybody for a feature only
  // PDFs use.
  let lastPdfSync = '0/0/0';   // the answer for an ordinary page: never sent
  function syncPdfImport() {
    if (!drawer) return;
    const state = pdfAnnotList.length + '/' + pdfPending().length
      + '/' + (window.__BFP_PDF && window.__BFP_PDF.exportAnnotated ? '1' : '0');
    if (state === lastPdfSync) return;
    lastPdfSync = state;
    drawer.setPdfAnnots({
      total: pdfAnnotList.length,
      pending: pdfPending().length,
      // writing back needs the viewer (it has the bytes and the geometry);
      // an ordinary article, or a PDF in the browser's own viewer, has none
      canExport: !!(window.__BFP_PDF && window.__BFP_PDF.exportAnnotated),
    });
  }
  // the viewer's one call in
  function pdfAnnotsArrived(list) {
    pdfAnnotList = Array.isArray(list) ? list : [];
    syncPdfImport();
  }

  // Deliberately not awaited by loadPage: the round is a nicety and must never
  // hold up the record every other thing on the page is waiting for.
  async function loadRound() {
    if (!drawer) return;
    const r = await api('GET', '/round?url=' + encodeURIComponent(URL_NOW));
    if (!drawer) return;
    drawer.setRound((r && r.ok && r.data && r.data.round) || null);
  }

  // The draft behind a locally-served page of the reader's own site.
  //
  // Same shape as loadRound and for the same reasons: not awaited by loadPage
  // (the record must not wait on a nicety), owner-only on the companion (the
  // answer is an absolute path on this machine, so a guest gets nothing and
  // the card stays down), and null for every page that is not one — which is
  // every page in the world except the reader's own site on localhost.
  //
  // The harness names its own with __BFP_BLOG, the same isolated-world escape
  // __BFP_PROJECT uses: a content script's window is not the page's.
  async function loadBlog() {
    if (!drawer) return;
    if (window.__BFP_BLOG && typeof window.__BFP_BLOG === 'object') {
      drawer.setBlog(window.__BFP_BLOG);
      return;
    }
    const r = await api('GET', '/blog-page?url=' + encodeURIComponent(URL_NOW));
    if (!drawer) return;
    drawer.setBlog((r && r.ok && r.data && r.data.blog) || null);
  }

  // The document arrived in pieces, and the pieces are still coming.
  //
  // An article is complete at document_idle; a PDF is not. pdf/viewer.js
  // renders page by page, and each text layer that lands is more text to anchor
  // to and possibly a better name for the record (the file name gives way to
  // the document's own /Title). So the viewer calls this, debounced, as it
  // fills its own DOM in: re-locate everything, and tell the companion the
  // title only when it actually changed — a POST per page would broadcast a
  // `page` event per page to every tab.
  let lastPostedTitle = '';
  // The one /page upsert, shared by every path allowed to send it: the refresh
  // of a record that already exists, and the act that brings one into being.
  // WHERE THIS PAGE CAME FROM, when the page itself says so. A project
  // artifact the bots made out of an annotated page is told to write the source
  // into its own <head> (workspace.artifactTurn), so the way back is in the
  // document rather than in a table somewhere: copy the file, open it from
  // anywhere, and it still knows. Two metas, read on every visit like the title
  // is, and absent on every other page in the world.
  const sourceMeta = () => {
    const get = n => {
      const el = document.querySelector(`meta[name="${n}"]`);
      return el ? String(el.getAttribute('content') || '').trim() : '';
    };
    const url = get('bfp-source');
    return url ? { source_url: url.slice(0, 2000), source_title: get('bfp-source-title').slice(0, 300) } : {};
  };
  function postPage() {
    lastPostedTitle = headline();
    return api('POST', '/page', { url: URL_NOW, title: lastPostedTitle, site: HOSTNAME,
      kind: PAGE_KIND, file_name: FILE_NAME, ...sourceMeta() });
  }
  // The record-earning gate. Every action that writes about this page — a
  // thread, a reply, an export — awaits this first, so the record exists (with
  // its real title, site, kind and file name) before the action lands. On an
  // already-registered page it is free.
  async function ensureRegistered() {
    // THE LAST GATE ON THE INVARIANT. Every write — a new thread, a reply, a
    // page-chat message, an export — comes through here first, so this is the
    // one place that can promise the url about to go on the wire is the
    // document in front of the reader. The listeners above should have caught
    // the navigation a quarter of a second after it happened; a router that
    // sneaks past all three of them still cannot sneak past a send.
    rebindIdentity();
    if (registered) return { ok: true };
    const r = await postPage();
    if (r && r.ok) registered = true;
    return r || { ok: false, error: 'the companion did not answer' };
  }
  async function refresh() {
    // The DOM changing under us is the SPA's own tell, and refresh is what the
    // page-mutation watcher calls. Without this, the title read fresh from the
    // NEW article would be posted over the OLD article's record — the quiet
    // half of the same bug, and the one that renames a page you never touched.
    rebindIdentity();
    reanchorAll();
    if (!active) return null;
    // an unregistered page posts NOTHING — the title travels with the act that
    // eventually earns the record (postPage reads headline() fresh)
    if (!registered) return PAGE;
    const title = headline();
    if (title && title !== lastPostedTitle) {
      await postPage();
      return loadPage();
    }
    return PAGE;
  }

  // EVERYTHING THIS TAB BELIEVES ABOUT THE PAGE IT IS ON, PUT DOWN.
  //
  // Two callers, one meaning. Deleting the page you are standing on leaves
  // every highlight a mark with no thread behind it, and the record must not
  // resurrect on the next visit — only on the next ACT. A single-page app
  // swapping one article for the next means the same thing about a different
  // page: what is painted belongs to a document that is no longer on screen.
  // Unpainted here rather than on the next refetch, because the drawer's own
  // reset cannot reach into the page.
  function forgetPage() {
    for (const t of (PAGE && PAGE.threads) || []) Anchor.unpaint(t.id);
    for (const id of Anchor.paintedIds()) Anchor.unpaint(id);
    pendingSel = null;
    locs = {};
    orphans = {};
    tracks = {};
    PAGE = { url: URL_NOW, title: headline(), site: HOSTNAME, threads: [], page_chat: [] };
    // the conversation is gone (or was never this page's), so the first-turn
    // context is armed again
    pageHasSession = false;
    sentArticleText = false;
    lastContextHash = null;
    // …and so is the record itself, and its snapshot: the next act sends a
    // fresh one rather than writing this document's text over another's
    registered = false;
    lastSnapHash = null;
    lastPostedTitle = '';
    if (drawer) { drawer.setPage(PAGE); drawer.setOrphans({}); }
    bg({ t: 'badge', count: 0 });
  }

  // ---- a single-page app moved the reader ----------------------------------
  // THE INVARIANT: a message is filed under the document the reader is looking
  // at when they send it. On the ordinary web that is free — a link tears the
  // document down and this script is injected again into the next one. On an
  // SPA it is not free at all: `history.pushState` swaps the article without
  // reloading anything, and every url this tab puts on the wire afterwards is
  // the url of an article that left the screen.
  //
  // So the identity is re-decided, through the very same funnel that decided it
  // at load — the canonical link re-read, `Adapters.canonicalPageUrl` applied
  // again, normUrl applied again — and NOTHING here special-cases a site. A
  // route change that resolves to the identity we already hold (a section
  // anchor, a query the site added, a canonical that still points at this
  // article) changes nothing and returns false; that is the case this must not
  // break, and it is the case the old `const` was written to protect.
  //
  // When it IS a different document, this tab stops being the old page's: what
  // is painted is unpainted, the record is dropped, the per-page storage keys
  // move, and `hello` re-keys the tab in the worker so the bots' replies are
  // delivered to the page they belong to. Then the new page is loaded exactly
  // as a fresh injection would have loaded it — dormant unless the companion
  // says it is annotated, because activation is still not an act.
  //
  // Returns whether the identity actually moved, which is what the harness
  // asserts on.
  function rebindIdentity() {
    // where an adapter or a project artifact owns the identity, the address bar
    // never was the identity, so a route change says nothing about it
    if (PROJECT || SITE) return false;
    const href = liveHref();
    const ident = identityFor(href);
    if (!ident || /^(?:chrome|moz)-extension:/i.test(ident)) return false;
    const next = normUrl(ident);
    if (!next || next === URL_NOW) return false;
    CANONICAL_HREF = readCanonical(href);
    IDENT_HREF = ident;
    URL_NOW = next;
    PAGE_COMMENTS_KEY = 'bfp:page-comments:' + URL_NOW;
    TRACK_KEY = 'bfp:track-changes:' + URL_NOW;
    AUTOOPEN_KEY = 'bfp-autoopen:' + URL_NOW;
    forgetPage();
    // The reader's per-page switches are THIS page's, not the last one's —
    // both of them. Each is reset to its default and then re-read for the new
    // address, exactly as it would be on a fresh boot.
    //
    // `loadPageComments` used to be missing here, and only that one: the key
    // moved with the identity and was then never consulted, so after an SPA
    // route change "let the page keep its own commenting" stayed at whatever
    // the PREVIOUS document had answered. Narrow in practice (this function
    // returns early wherever a project or an adapter owns the identity, and a
    // review surface is rarely a single-page app) but it was an answer the
    // reader gave about one document being applied to another.
    trackChanges = true;
    loadTrackChanges();
    // the BARE variable, not setPageOwnsMargin: the setter persists, and
    // persisting "no" here would erase the new page's stored answer a tick
    // before loadPageComments went to read it. This is what boot does.
    pageOwnsMargin = false;
    loadPageComments();
    bg({ t: 'hello', url: IDENT_HREF }).then(r => {
      if (!r || !r.ok) return;
      // already awake: stay awake, and re-anchor against the new record
      if (active) { loadPage().then(() => connSocket(!!r.connected)); return; }
      if (r.known) activate(false).then(() => connSocket(!!r.connected));
    });
    return true;
  }

  // pushState and replaceState are the only two ways an SPA can change the
  // address without an event of its own, so they are wrapped — narrowly, and
  // never swallowing the site's own call. popstate covers Back and Forward.
  // Everything is deferred a tick: a framework's router rewrites the address
  // first and the document (and its canonical link) a moment later, and reading
  // the identity between the two would read half a navigation.
  function watchSpaNavigation() {
    let pending = 0;
    const later = () => {
      clearTimeout(pending);
      pending = setTimeout(() => { try { rebindIdentity(); } catch { /* never the page's problem */ } }, 250);
    };
    try {
      const h = window.history;
      for (const name of ['pushState', 'replaceState']) {
        const orig = h[name];
        if (typeof orig !== 'function') continue;
        h[name] = function (...args) {
          const out = orig.apply(this, args);
          later();
          return out;
        };
      }
    } catch { /* a page that will not be wrapped still gets popstate */ }
    window.addEventListener('popstate', later);
    // …and a last resort for a router that does neither: the title changing
    // under us is the loudest signal an article has been replaced.
    try {
      const head = document.querySelector('head');
      if (head && window.MutationObserver) {
        const mo = new MutationObserver(() => { if (liveHref() !== IDENT_HREF) later(); });
        mo.observe(head, { childList: true, subtree: true });
      }
    } catch { /* the two listeners above are the load-bearing half */ }
  }

  async function activate(openTab) {
    if (!active) {
      active = true;
      whoami();
      drawer = makeDrawer();
      drawer.mount();
      runReady();
      drawer.setPage({ url: URL_NOW, title: headline(), site: HOSTNAME, threads: [], page_chat: [] });
      // `connected` here is the SOCKET, which a freshly woken worker has not
      // opened yet — so it may confirm, never deny (see connHttp/connSocket)
      bg({ t: 'hello', url: IDENT_HREF }).then(r => { if (r && r.ok) connSocket(!!r.connected); });
      await loadPage();
      // a page that already earned its record gets the scraped title, kind and
      // file name refreshed on every visit, exactly as before; a page that
      // never did gets NOTHING posted — activation is not an act. The reload
      // behind the upsert is what lands the corrected title in the header
      // (the adapter's headline beating a stale scraped one) without waiting
      // on the broadcast.
      if (registered) postPage().then(r => { if (r && r.ok) loadPage(); });
    }
    if (openTab !== false) drawer.open();
    return drawer;
  }

  // ---- staying in step with the companion ----------------------------------
  // Every live update reaches this page through the extension's service
  // worker, and an MV3 worker is a disposable thing: Chrome retires one
  // whenever it likes, and the replacement reconnects the socket perfectly
  // while having never heard of this tab. Its routing table is empty, so the
  // reply the bots wrote a minute ago is delivered nowhere, and the drawer
  // sits under a comment saying "queued…" until the page is reloaded. That is
  // exactly the bug this section exists to make impossible.
  //
  // So the page stops treating the event stream as the only truth:
  //   • a port to the worker, reconnected whenever it dies — reconnecting
  //     STARTS a worker, and re-registers this tab with it
  //   • a resync (one GET /page) on every reconnect, on every socket that
  //     comes back, and whenever the tab is looked at again
  //   • after a send, two scheduled checks: if nothing has arrived by then,
  //     ask the record directly
  //
  // None of it is user-visible. A worker respawn is routine; the only evidence
  // of one should be that the drawer is right anyway.
  const PORT_NAME = 'bfp';
  const PORT_RETRY_MS = 800;
  const PING_MS = 20000;                  // keeps a worker warm while a tab is open
  const RESYNC_MIN_MS = 1500;             // never refetch more often than this
  const WAIT_TICK_MS = 4000;              // how often a waiting page looks up
  const SEND_CHECKS_MS = [4000, 10000];   // the safety net after a send
  const WAIT_POLLS_MAX = 30;              // …and then it stops asking (~2 min)
  const TURN_QUIET_MS = 45000;            // a running turn nobody has heard from
  let port = null;
  let portTimer = null;
  let waitTimer = null;
  let lastEventAt = Date.now();           // anything at all arriving from the worker
  let lastPingAt = 0;
  let lastResyncAt = 0;
  let resyncing = null;
  let waitPolls = 0;
  let eventErrorsSeen = 0;                // events the drawer had to throw away
  const resyncLog = [];                   // why we refetched, for test/harness.html

  // One refetch, throttled and de-duplicated: several reasons to distrust the
  // stream can land in the same second and they all want the same GET.
  function resync(why) {
    if (!active) return Promise.resolve(null);
    if (resyncing) return resyncing;
    if (Date.now() - lastResyncAt < RESYNC_MIN_MS) return Promise.resolve(null);
    lastResyncAt = Date.now();
    resyncLog.push(String(why || ''));
    if (resyncLog.length > 20) resyncLog.shift();
    resyncing = Promise.resolve(loadPage()).catch(() => null)
      .then(p => { resyncing = null; return p; });
    return resyncing;
  }

  function connectPort() {
    if (port || GUARD.gone) return;
    if (!extensionAlive()) { GUARD.lose(); return; }
    if (!chrome.runtime.connect) return;
    // a connect can fail for reasons that are none of our business (a worker
    // mid-respawn), which is why this catch stays broad — but a reloaded
    // extension is not one of them, and it is the one worth naming
    try { port = chrome.runtime.connect({ name: PORT_NAME }); }
    catch (e) { GUARD.saw(e); port = null; }
    if (!port) { if (!GUARD.gone) schedulePort(); return; }
    port.onMessage.addListener(msg => {
      lastEventAt = Date.now();
      if (msg && msg.t === 'pong') return;
      handleWorkerMsg(msg, () => {});
    });
    port.onDisconnect.addListener(() => {
      // the worker we were talking to is gone. Reconnecting wakes a new one;
      // the resync is for whatever it never got the chance to tell us.
      port = null;
      schedulePort();
      resync('worker-gone');
    });
    lastPingAt = Date.now();
    pingPort();
  }
  function schedulePort() {
    if (portTimer || GUARD.gone) return;
    portTimer = setTimeout(() => { portTimer = null; connectPort(); }, PORT_RETRY_MS);
  }
  function pingPort() {
    if (!port) return;
    // IDENT_HREF, not HREF: this is what re-registers the tab in the worker's
    // routing table, so it has to be the page's identity or events for it are
    // delivered to nobody. (Two documents where they differ: a canonical
    // splinter, and the PDF viewer, whose address is not the PDF.)
    try { port.postMessage({ t: 'ping', url: IDENT_HREF }); }
    catch (e) { GUARD.saw(e); port = null; schedulePort(); }
  }

  // The tab was put away and brought back: whatever happened meanwhile, it
  // happened to a page nobody was looking at.
  function liveness(why) {
    connectPort();
    pingPort();
    lastPingAt = Date.now();
    if (active) resync(why);
  }

  // A send is the one moment we KNOW an answer is owed, which makes it the one
  // moment worth spending requests on. Two checks, then it stops: if the pipe
  // is healthy the events have long since arrived and these are no-ops.
  function watchSend() {
    const sentAt = Date.now();
    for (const ms of SEND_CHECKS_MS) {
      setTimeout(() => {
        if (!active || !drawer) return;
        if (lastEventAt > sentAt) return;        // the stream is alive; nothing to do
        if (!drawer.isWaiting()) return;         // nothing is outstanding any more
        resync('after-send');
      }, ms);
    }
  }

  function startLiveness() {
    connectPort();
    if (waitTimer) return;
    waitTimer = setInterval(() => {
      const now = Date.now();
      connectPort();
      if (now - lastPingAt >= PING_MS) { lastPingAt = now; pingPort(); }
      if (!active || !drawer) return;
      // a page that is waiting on the bots and hearing nothing looks it up —
      // but not for ever: a companion that has genuinely stopped answering is
      // not worth a request every few seconds until the tab is closed
      if (drawer.isWaiting() && now - lastEventAt > WAIT_TICK_MS) {
        if (waitPolls < WAIT_POLLS_MAX) { waitPolls++; resync('waiting'); }
      } else {
        waitPolls = 0;
      }
      // …and a turn still marked running long after the last word about it had
      // its ending lost in transit. The chip comes down; the record is already
      // whatever the resync made it.
      for (const t of drawer.quietTurns(TURN_QUIET_MS)) drawer.endTurn(t);
    }, WAIT_TICK_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) liveness('visible');
  }, false);
  window.addEventListener('focus', () => liveness('focus'), false);

  // ---- KaTeX fonts live in the PAGE document, not the shadow root ------------
  // @font-face rules inside a shadow root DO NOT REGISTER — the fonts are never
  // fetched and every formula in the drawer falls back to the page's serif. So
  // the font declarations, and only those, are linked into the page's own
  // document (katex-fonts.css); katex.min.css itself stays in the shadow root
  // with the rest of the drawer's styling, where it cannot leak out.
  //
  // This is the page's DOM, which is why it lives here rather than in
  // drawer.js. A chrome-extension: <link> is exempt from the page's CSP as
  // long as the file is web-accessible, the same way drawer.css already is.
  //
  // This is also the first thing an orphaned content script tends to reach:
  // it is on the activate path, and getURL on a dead context THROWS rather
  // than answering. Hence extUrl — no href, no link, no uncaught error.
  const FONTS_ID = 'bfp-katex-fonts';
  function ensureMathFonts() {
    if (document.getElementById(FONTS_ID)) return;
    const href = extUrl('vendor/katex/katex-fonts.css');
    if (!href) return;
    const link = document.createElement('link');
    link.id = FONTS_ID;
    link.rel = 'stylesheet';
    link.href = href;
    (document.head || document.documentElement).appendChild(link);
  }

  // ---- drawer wiring ---------------------------------------------------------
  function makeDrawer() {
    ensureMathFonts();
    return Drawer.create({
      hostname: HOSTNAME,
      // the handle this browser signs with; refined by whoami() the moment the
      // background answers (drawer.setAuthor)
      author: AUTHOR,
      // what this site can actually do (see the adapter note at the top):
      // {highlights:false} turns off the selection pill and opens on Page chat
      capabilities: CAPS,
      // …and whether this page carries a review UI of its own, which is a
      // property of the DOM rather than of the site (see REVIEW_UI_MARKER).
      // The drawer says so where the comments would be and carries the switch.
      reviewHost: { hosts: HOSTS_REVIEW_UI, pageOwns: pageOwnsMargin },
      onPageComments: want => setPageOwnsMargin(want),
      // …and the reader's switch for the on-page track changes: the struck old
      // wording beside a passage a bot rewrote. Default ON, per page.
      trackChanges: trackChanges,
      onTrackChanges: want => setTrackChanges(want),
      // the pages list needs to know which row is the page it is being shown
      // on; normUrl is ours, not the drawer's, so it is handed over with it
      currentUrl: URL_NOW,
      normUrl,
      // which council project this page came out of, if it came out of one:
      // the header says so, and the Page chat tab becomes that project's chat
      // archive rather than one conversation about one page
      project: PROJECT,
      theme: window.__BFP_THEME || null,
      // Whenever the drawer (re-)attaches itself to a page that rearranged the
      // document under it, the fonts link goes back with it. Mounting is not
      // once — and neither is this: the same React hydration that deletes
      // #bfp-root deletes the <link> out of <head>, and math that had been
      // rendering in KaTeX quietly fell back to the page's serif for the life
      // of the tab. ensureMathFonts is by-id idempotent, so this costs a
      // lookup on the ordinary path.
      onAttach: () => ensureMathFonts(),
      cssUrl: extUrl('drawer.css') || 'drawer.css',
      // the rest of KaTeX's stylesheet, inside the shadow root (see above)
      katexCssUrl: extUrl('vendor/katex/katex.min.css') || 'vendor/katex/katex.min.css',

      onSelect: kind => commitSelection(kind),

      onSave: async ({ quote, prefix, suffix, text, route, mark }) => {
        // The act that earns the record. Order matters on the first one:
        // record, then snapshot, then the message — so a mention's turn is
        // planned against a page whose full text is already on disk.
        const wasNew = !registered;
        const reg = await ensureRegistered();
        if (!reg.ok) return failure(reg);
        if (wasNew) await snapshotNow();
        // …and the picture of the page this comment is on, before the message
        // that may summon: a caption's thread is exactly the one that needs it
        if (pendingSel && pendingSel.page > 0) await capturePage(pendingSel.page);
        // `mark` rides only when it is not the default, so an article's payload
        // is byte-for-byte the one it always was
        const body = { url: URL_NOW, quote, prefix, suffix, msg: { text },
          ...(mark === 'strike' ? { mark } : {}), ...(route ? { route } : {}) };
        // page order is the extension's knowledge, not the server's: tell it
        // where in the stack this thread belongs (companion honours `index`)
        if (pendingSel) body.index = pageOrderIndex(pendingSel.start);
        // …and which page of the document it came off, where that is a thing
        // this document has. Absent everywhere else, so nothing about an
        // article's payload changes.
        if (pendingSel && pendingSel.page > 0) body.page = pendingSel.page;
        // an empty answer is NOT sent as an empty field: no article_text at
        // all, and the flag stays down so the next mention tries again
        const ctx = await mentionContext(text, route);
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
        // this page is now annotated, so it is worth being able to read it
        // from a phone: capture the article the first time and on every change
        maybeSnapshot();
        loadPage();
        watchSend();
        // `reason` = saved, but the bots will not run for this sender (a guest
        // with no bot access, or a companion started --no-agents). The drawer
        // shows it at the composer; the comment itself is safe.
        return { ok: true, queued: r.data && r.data.queued, position: r.data && r.data.position,
                 // why it is waiting, in the companion's words (bridge_starting
                 // | busy): the drawer turns it into the line by the composer
                 wait: r.data && r.data.wait,
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
      onReply: async (threadId, text, route) => {
        // the first-ever message on a page can be a page-chat question: the
        // same record-then-snapshot-then-message order as onSave
        const wasNew = !registered;
        const reg = await ensureRegistered();
        if (!reg.ok) return failure(reg);
        if (wasNew) await snapshotNow();
        // a reply into a thread that sits on page N is a turn about page N: if
        // that page was never captured (this thread was made before the viewer
        // could, or on the phone), this is the moment it can be
        await capturePage(pageOfThread(threadId));
        const body = { url: URL_NOW, thread_id: threadId, text, ...(route ? { route } : {}) };
        const ctx = await mentionContext(text, route);
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
          // writing into a thread REOPENS it (the companion's appendMsg does
          // this for every write, wherever it came from) — so the highlight
          // goes back to yellow now, with the message, rather than a round
          // trip later when the `page` broadcast lands
          const t = (PAGE.threads || []).find(x => x.id === threadId);
          if (t && t.resolved) { delete t.resolved; Anchor.markResolved(threadId, false); }
          // …and it is no longer "ready for review" either: the reader has
          // just asked something new here, so whatever a bot claimed about
          // this thread a moment ago is stale (store.appendMsg says the same
          // thing server-side; this is the optimistic half of it)
          if (t && t.addressed) { delete t.addressed; Anchor.markAddressed(threadId, false); }
          drawer.setPage(PAGE);
        } else if (r.data && r.data.deduped) {
          // deduped with nothing echoed: the record is the only truth left
          await loadPage();
        }
        watchSend();
        return { ok: true, queued: r.data && r.data.queued, position: r.data && r.data.position,
                 wait: r.data && r.data.wait,
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

      // ---- running a ```python block ------------------------------------
      // The drawer names a conversation and a message; the address on the wire
      // is a url plus a thread, and the library's url is not this page's. No
      // code is ever sent: the companion runs what it already has stored, which
      // is the only version anybody has read.
      onRun: async (target, ts, author, block) => {
        const r = await api('POST', '/run', { ...runAddr(target, ts, author), block_index: block });
        if (!r.ok) return failure(r);
        return { ok: true, run: r.data && r.data.run, stored: !!(r.data && r.data.stored) };
      },
      onRunCancel: async (target, ts, author, block) => {
        const r = await api('POST', '/run-cancel', { ...runAddr(target, ts, author), block_index: block });
        if (!r.ok) return failure(r);
        return { ok: true, cancelled: !!(r.data && r.data.cancelled) };
      },
      // A figure is served under the same owner-only gate as the run, so it
      // cannot be an <img src> in somebody else's page: the bytes come back
      // through the background worker as a data: url.
      onRunFigure: async (target, runId, name) => {
        const url = target === LIBRARY_TARGET ? LIBRARY_URL : URL_NOW;
        const r = await api('GET', '/run-figure?url=' + encodeURIComponent(url)
          + '&run=' + encodeURIComponent(runId) + '&name=' + encodeURIComponent(name) + '&as=json');
        if (!r.ok) return failure(r);
        return { ok: true, data_url: r.data && r.data.data_url };
      },

      onEdit: async (threadId, ts, text) => {
        const r = await api('POST', '/edit', { url: URL_NOW, thread_id: threadId, ts, text });
        if (!r.ok) return failure(r);
        await loadPage();
        return { ok: true };
      },

      // Resolve / reopen. The highlight is repainted BEFORE the round trip:
      // the drawer has already moved the card optimistically, and a yellow
      // highlight sitting under a card that says "resolved" for half a second
      // is exactly the flicker a reader sweeping down a list would notice. A
      // refusal puts the colour back.
      onResolve: async (threadId, resolved) => {
        Anchor.markResolved(threadId, !!resolved);
        // filing a thread ends its track changes with it: the reader has
        // looked at the change, and a struck sentence beside a sage highlight
        // would be the page still asking a question that has been answered.
        // (Resolving CLEARS `addressed` server-side, and reopening clears it
        // too, so a reopened thread comes back yellow and unmarked — the
        // markup returns when a bot next claims something about it.)
        const keptTrack = tracks[threadId];
        if (resolved) { delete tracks[threadId]; paintTrackChanges(); }
        const r = await api('POST', '/resolve', { url: URL_NOW, thread_id: threadId, resolved: !!resolved });
        if (!r.ok) {
          Anchor.markResolved(threadId, !resolved);
          if (keptTrack) { tracks[threadId] = keptTrack; paintTrackChanges(); }
          return failure(r);
        }
        await loadPage();
        return { ok: true, thread: r.data && r.data.thread,
                 summarizing: !!(r.data && r.data.summarizing) };
      },
      // Highlight ⇄ strikethrough on a thread that already exists. The reader
      // discussed a passage and decided it should come out; the mark is a field,
      // so this is one write and nothing else on the record moves. Repainted
      // BEFORE the round trip for the same reason resolve is — the passage is
      // what they are looking at — and put back on a refusal.
      onSetMark: async (threadId, mark) => {
        const want = mark === 'strike';
        Anchor.markStruck(threadId, want);
        const r = await api('POST', '/mark', { url: URL_NOW, thread_id: threadId, mark: want ? 'strike' : 'highlight' });
        if (!r.ok) { Anchor.markStruck(threadId, !want); return failure(r); }
        await loadPage();
        return { ok: true, thread: r.data && r.data.thread };
      },
      // A bot suggested the passage should go and the reader agreed. This does
      // NOT convert the discussion: it mints a strikeout of the reader's own on
      // the same passage (server.mjs /strike-from), so the discussion can be
      // deleted afterwards and the co-author receives a clean red line signed by
      // the reader. No optimistic paint — the new thread has an id only the
      // companion can mint, and loadPage paints it the moment it lands.
      onStrikeFrom: async (threadId, note, fromMsg, fromIdx, passage, pageNo) => {
        const r = await api('POST', '/strike-from',
          { url: URL_NOW, thread_id: threadId, note: note || '', from_msg: fromMsg || '',
            // WHICH suggestion inside that reply (one reply may carry three),
            // and the passage the bot named for itself where it named one
            from_idx: Number(fromIdx) || 0, passage: passage || '',
            // …and the PAGE that wording is on, when the discussion concluded
            // that the change belongs somewhere else in the document. The door
            // checks it again against that page's own text — this is a request,
            // not a permission.
            page: Number(pageNo) || 0 });
        if (!r.ok) return failure(r);
        await loadPage();
        return { ok: true, thread: r.data && r.data.thread,
                 deduped: !!(r.data && r.data.deduped),
                 // …and the third thing a confirm can do: rewrite the note on
                 // the strike this discussion already produced, rather than
                 // mint one. The drawer says which happened; the reader should
                 // never have to work it out from the card.
                 updated: !!(r.data && r.data.updated) };
      },
      // ---- suggested edits to a blog post -------------------------------
      // A bot proposed a change to the markdown behind this page and the
      // reader answered. Accept is the only thing in this extension that
      // causes a file on the reader's disk to change, and it carries no path:
      // the companion resolves which file this page renders from, so the most
      // a request can ever ask for is "the change proposed on this page".
      //
      // `loadPage()` after each, because the card's state lives on the record
      // — and the RELOAD, when one is coming, arrives on its own through the
      // usual `blog-files` event, exactly as it does for a turn's own edit.
      onSuggestAccept: async (threadId, ts, id) => {
        const r = await api('POST', '/suggest-accept', {
          url: URL_NOW, ...(threadId === PAGE_TARGET ? {} : { thread_id: threadId }), ts, id,
        });
        if (!r.ok) return failure(r);
        await loadPage();
        return { ok: true, card: r.data && r.data.card, applied: !!(r.data && r.data.applied) };
      },
      onSuggestReject: async (threadId, ts, id) => {
        const r = await api('POST', '/suggest-reject', {
          url: URL_NOW, ...(threadId === PAGE_TARGET ? {} : { thread_id: threadId }), ts, id,
        });
        if (!r.ok) return failure(r);
        await loadPage();
        return { ok: true, card: r.data && r.data.card };
      },
      // A whole sweep, in document order, stopping at the first passage that
      // cannot be placed. The answer is a tally rather than a card, because
      // that is what the reader needs to read after pressing one button over
      // ten changes.
      onSuggestAcceptAll: async (threadId, ts) => {
        const r = await api('POST', '/suggest-accept-all', {
          url: URL_NOW, ...(threadId === PAGE_TARGET ? {} : { thread_id: threadId }), ts,
        });
        if (!r.ok) return failure(r);
        await loadPage();
        return { ok: true,
                 applied: (r.data && r.data.applied) || 0,
                 left: (r.data && r.data.left) || 0,
                 stopped: (r.data && r.data.stopped) || null };
      },
      // ---- the question vault ------------------------------------------
      // "Make a question of this." Either a thread (the card-head ?, or a
      // bot's own offer confirmed) or a bare selection with no thread on it at
      // all — the pill's third tool, which is the case that has no id to send
      // and sends the passage instead. Nothing is painted on the page: a
      // question is not a mark on the document, it is a note in the reader's
      // own memory, and drawing a highlight for one would be a lie about what
      // the page now carries.
      onMakeQuestion: async (threadId, extra) => {
        const sel = (!threadId && pendingQ) ? pendingQ : null;
        const r = await api('POST', '/question', {
          url: URL_NOW,
          ...(threadId ? { thread_id: threadId } : {}),
          ...(sel ? { quote: sel.quote, page: sel.page } : {}),
          ...(extra && extra.from_msg ? { from_msg: extra.from_msg } : {}),
          ...(extra && extra.hint ? { hint: extra.hint } : {}),
        });
        pendingQ = null;
        if (!r.ok) return failure(r);
        return { ok: true, card: r.data && r.data.card,
                 queued: !!(r.data && r.data.queued),
                 reason: (r.data && r.data.reason) || '' };
      },
      // …and the other thing a confirm can do: REWRITE a card this discussion
      // already filed, rather than add a second one beside it. The corrected
      // card lives on the record (the reply the chip sits under), so this
      // carries pointers only — which thread, which reply — and the companion
      // reads the card it already parsed and checked.
      onQuestionRevise: async (threadId, fromMsg) => {
        const r = await api('POST', '/question-revise',
          { url: URL_NOW, thread_id: threadId, from_msg: fromMsg || '' });
        if (!r.ok) return failure(r);
        return { ok: true, card: r.data && r.data.card, revised: true };
      },
      // "They are not the same question" — the reader's veto on the duplicate
      // hint, pinned on both cards so it is never offered again.
      onQuizKeep: async (id, other) => {
        const r = await api('POST', '/quiz-keep', { id, other });
        return r.ok ? { ok: true } : failure(r);
      },
      // Two answers in one request: how many are due across the WHOLE bank
      // (the door's only number — one vault, every page) and which threads on
      // THIS page have minted a memory, which is the card-side half of the
      // link the quiz draws in the other direction.
      onQuestionCounts: async () => {
        const r = await api('GET', '/questions?page=' + encodeURIComponent(URL_NOW));
        if (!r.ok) return failure(r);
        return { ok: true, counts: (r.data && r.data.counts) || {},
                 threads: (r.data && r.data.threads) || {},
                 pageCounts: (r.data && r.data.page_counts) || {} };
      },
      // ---- the Memorize tab ---------------------------------------------
      // What this page (or a project it is filed in) has put in the vault,
      // and what of it is due. The big bank lives at its own address and is
      // for revising CONCEPTS; this is for revising the page you are still
      // standing on, which is why the scope is never "everything".
      onMemoryCards: async ({ scope } = {}) => {
        const r = await api('GET', '/memory?url=' + encodeURIComponent(URL_NOW)
          + (scope ? '&scope=' + encodeURIComponent(scope) : ''));
        if (!r.ok) return failure(r);
        return { ok: true, ...(r.data || {}) };
      },
      // Answering, through the SAME endpoint the scriptless quiz posts to:
      // one SM-2 record on disk, written by one place, whichever surface the
      // reader happened to answer on.
      onQuizAnswer: async (id, choice) => {
        const r = await api('POST', '/quiz-answer', { id, choice });
        if (!r.ok) return failure(r);
        return { ok: true, card: r.data && r.data.card, correct: !!(r.data && r.data.correct) };
      },
      // The two ways a card leaves the rotation, from the drawer. Parking it
      // keeps everything (phase 2 hands it back to the bots to rewrite);
      // discarding is the reader saying this was not worth remembering after
      // all, and the row goes.
      onQuizFlag: async id => {
        const r = await api('POST', '/quiz-flag', { id });
        return r.ok ? { ok: true } : failure(r);
      },
      onQuizDiscard: async id => {
        const r = await api('POST', '/quiz-delete', { id });
        return r.ok ? { ok: true } : failure(r);
      },
      // The quiz is a page in the reading room, not a panel in here — the
      // reader reviews on a phone, and this drawer cannot follow them there.
      // So the button is a door, and this opens it.
      onOpenQuiz: () => { bg({ t: 'open-here', path: '/quiz' }); },
      // "not done" — the reader's answer to a thread the bots claimed handled.
      // Only the clearing direction exists here: marking a thread ADDRESSED is
      // what a bot's reply landing in it does, server-side, and is never a
      // click. Same optimistic repaint as resolve, for the same reason.
      onNotDone: async threadId => {
        Anchor.markAddressed(threadId, false);
        const r = await api('POST', '/addressed',
          { url: URL_NOW, thread_id: threadId, addressed: false });
        if (!r.ok) { Anchor.markAddressed(threadId, true); return failure(r); }
        await loadPage();
        return { ok: true, thread: r.data && r.data.thread };
      },
      // "ask again" for a filed thread's paragraph — queued, never awaited:
      // the answer arrives as a `page` event whenever the job drains
      onSummarize: async threadId => {
        const r = await api('POST', '/summarize', { url: URL_NOW, thread_id: threadId });
        if (!r.ok) return failure(r);
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

      // `mode` is the reader's choice from the crystal's chooser: 'comments'
      // (highlights and their own notes, no bot conversation) or 'all'. An
      // absent mode is 'all', which is what /export has always written.
      onExport: async mode => {
        // asking for a note in the vault is an act too: a record on disk is
        // what backs the note, so exporting earns one
        const reg = await ensureRegistered();
        if (!reg.ok) return failure(reg);
        const r = await api('POST', '/export', { url: URL_NOW, mode });
        if (!r.ok) return failure(r);
        return { ok: true, path: r.data && r.data.path, mode: r.data && r.data.mode };
      },

      // ---- the PDF's own comments, in ------------------------------------
      // The reader has pressed import. Same order as every other first act on
      // a page: the record, then the snapshot, then the words — so a bot
      // summoned into one of these threads later reads a page whose full text
      // is already on disk.
      //
      // Only what is PENDING is sent. The companion would skip the rest by
      // itself (that is what `origin` is for), but a re-import of a
      // sixty-comment manuscript should not be sixty comments crossing the
      // wire to be thrown away.
      onPdfImport: async () => {
        const list = pdfPending();
        if (!list.length) return { ok: true, created: 0, appended: 0 };
        const wasNew = !registered;
        const reg = await ensureRegistered();
        if (!reg.ok) return failure(reg);
        if (wasNew) await snapshotNow();
        const r = await api('POST', '/pdf-annotations', {
          url: URL_NOW, title: headline(), site: HOSTNAME, kind: PAGE_KIND,
          file_name: FILE_NAME, annots: list,
        });
        if (!r.ok) return failure(r);
        // the record is the truth about what landed: refetch it, which also
        // paints the new highlights and recomputes the pending count
        await loadPage();
        maybeSnapshot();
        bg({ t: 'badge', count: ((PAGE && PAGE.threads) || []).length });
        return { ok: true, created: (r.data && r.data.created) || 0,
                 appended: (r.data && r.data.appended) || 0,
                 skipped: (r.data && r.data.skipped) || 0 };
      },

      // ---- …and out: the discussion, written into a copy of the PDF -------
      // The whole job is the viewer's — it holds the bytes and the only
      // geometry on this machine that knows where a quote is in PDF
      // coordinates. Nothing is uploaded and nothing is written beside the
      // original: the copy goes through the browser's own downloader.
      onPdfExport: async () => {
        const V = window.__BFP_PDF;
        if (!V || !V.exportAnnotated) return { ok: false, error: 'this page is not a PDF in the Discuss viewer' };
        try { return await V.exportAnnotated(); }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
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

      // ---- naming and filing a page --------------------------------------
      // Both are owner-only on the companion, and the drawer only draws the
      // controls for an owner — this is the same refusal arriving as ordinary
      // text if anything gets past both.
      onRenamePage: async (url, title) => {
        const r = await api('POST', '/rename-page', { url, title });
        if (!r.ok) return failure(r);
        return { ok: true, title: (r.data && r.data.title) || title };
      },
      onTagPage: async (url, tags) => {
        const r = await api('POST', '/tag-page', { url, tags });
        if (!r.ok) return failure(r);
        return { ok: true, tags: (r.data && r.data.tags) || [] };
      },

      // ---- the project behind a project artifact page ---------------------
      // Only ever called on a page that HAS a project (the drawer draws none
      // of this otherwise). All four are owner-only on the companion: the
      // answers are absolute paths on this machine.
      //
      // The reader's one-time answer about a council root. `false` is a real
      // answer and is kept: the drawer never asks about that folder again, and
      // the next load of a page inside it does not attach at all.
      onConfirmRoot: async confirm => {
        const r = await api('POST', '/council-root',
          { root: PROJECT && PROJECT.root, confirm: !!confirm });
        if (!r.ok) return failure(r);
        if (PROJECT) PROJECT.confirmed = !!confirm;
        return { ok: true, state: (r.data && r.data.state) || '' };
      },
      // ---- the draft behind a locally-served page of the reader's site ----
      // The one-time answer about a blog repo — the same contract, the same
      // consequence and the same wording as a council root: what hangs off a
      // yes is a bridge child spawned with that directory writable.
      //
      // There is deliberately no `onPublish` beside it. The reader's website
      // repository is theirs: Discuss edits working files and stops there, and
      // the companion has no route to ask for anything else (blog.mjs).
      onConfirmBlogRoot: async confirm => {
        const r = await api('POST', '/blog-root',
          { root: (drawer && drawer.blogRoot && drawer.blogRoot()) || '', confirm: !!confirm });
        if (!r.ok) return failure(r);
        loadBlog();
        return { ok: true, state: (r.data && r.data.state) || '' };
      },
      onProjectSessions: async () => {
        const r = await api('GET', '/project-sessions?url=' + encodeURIComponent(URL_NOW));
        if (!r.ok) return failure(r);
        const d = r.data || {};
        return { ok: true, sessions: d.sessions || [], current: d.current || null,
                 project_id: d.project_id || '', project_title: d.project_title || '' };
      },
      // Opening a past chat (or starting a fresh one) is a move of this page's
      // `session_id`, which is already the whole of the resume machinery — so
      // the answer is a page record like any other and lands the same way.
      onOpenSession: async sid => {
        await ensureRegistered();
        const r = await api('POST', '/project-chat',
          { url: URL_NOW, title: headline(), ...(sid ? { sid } : { new: true }) });
        if (!r.ok) return failure(r);
        await loadPage();
        return { ok: true, session_id: (r.data && r.data.session_id) || null };
      },
      // The whole margin review, handed to the bots as one page-chat turn.
      // The companion composes the digest (it holds the threads); the drawer
      // only asks. Reloading the record afterwards is what puts the digest —
      // a real message, deliberately visible — into the pane.
      onSendReview: async () => {
        await ensureRegistered();
        const r = await api('POST', '/send-review', { url: URL_NOW });
        if (!r.ok) return failure(r);
        await loadPage();
        const d = r.data || {};
        // `threads` names the threads the round queued a turn against, so the
        // drawer can put a queued spinner on each of their cards
        return { ok: true, sent: d.sent || 0, omitted: d.omitted || 0, total: d.total || 0,
                 queued: d.queued, threads: Array.isArray(d.threads) ? d.threads : [],
                 reason: d.reason };
      },

      // ---- filing THIS page under a council project ----------------------
      // Different from everything above it: this page is not a project
      // artifact and never becomes one. It stays where it is, on its own
      // lane, with no write scope — filing is a READ, and what it changes is
      // what the bots are told before they answer.
      onProjects: async () => {
        const r = await api('GET', '/projects?url=' + encodeURIComponent(URL_NOW));
        if (!r.ok) throw new Error(failure(r).error);
        const d = r.data || {};
        return { projects: d.projects || [], filed: d.filed || [] };
      },
      onFileProject: async (root, id, attach) => {
        // the record has to exist before it can be filed — a page the reader
        // has never commented on is a shell the companion has not been asked
        // to make yet
        await ensureRegistered();
        const r = await api('POST', '/page-projects',
          { url: URL_NOW, root, id, attach: attach !== false });
        if (!r.ok) throw new Error(failure(r).error);
        await loadPage();
        return { filed: (r.data && r.data.filed) || [] };
      },
      // ---- and starting a project that does not exist yet -----------------
      // The one act in this drawer that writes inside the reader's council: a
      // new `projects/<id>/` with a PROJECT.md, a row on the portfolio, and
      // this page filed in it. Only ever from a click — a bot may OFFER it
      // (`file-in: new "…"`) and can do nothing about it.
      onCreateProject: async (title, root, why) => {
        await ensureRegistered();
        const r = await api('POST', '/project-create', { url: URL_NOW, title, root, why });
        if (!r.ok) throw new Error(failure(r).error);
        await loadPage();
        const d = r.data || {};
        return { ok: true, id: d.id, title: d.title, filed: d.filed || [] };
      },
      // ---- and putting one on the reader's own website --------------------
      // A project artifact, copied into their site repo, committed and pushed.
      // The companion does all three; the drawer only asks and reports.
      onPublish: async (target) => {
        const r = await api('POST', '/publish', { url: URL_NOW, target: target || '' });
        if (!r.ok) return failure(r);
        await loadPage();
        return { ok: true, ...(r.data || {}) };
      },

      // ---- and having a page MADE out of this one -------------------------
      // One turn on the project's own lane, which is the only place anything
      // may be written. The answer comes back into page chat like any other
      // turn, so there is nothing to render from here but what the companion
      // said about the ask itself.
      onMakeArtifact: async (root, id, brief) => {
        await ensureRegistered();
        const r = await api('POST', '/make-artifact', { url: URL_NOW, root, id, brief });
        if (!r.ok) return failure(r);
        await loadPage();
        const d = r.data || {};
        return { ok: true, route: d.route, queued: d.queued, reason: d.reason };
      },

      // ---- the library --------------------------------------------------
      // One conversation about the whole archive, on a reserved url no tab can
      // ever be showing (store.mjs owns the definition). It is an ordinary page
      // chat to every endpoint here — the url is simply not this one.
      onLibrary: async () => {
        const r = await api('GET', '/page?url=' + encodeURIComponent(LIBRARY_URL));
        if (!r.ok) return failure(r);
        const d = r.data;
        LIBRARY = (d && d.url) ? d : null;
        return { ok: true, page: LIBRARY };
      },
      onLibraryReply: async text => {
        const r = await api('POST', '/reply',
          { url: LIBRARY_URL, thread_id: PAGE_TARGET, text });
        if (!r.ok) return failure(r);
        const d = r.data || {};
        if (d.msg) pushLibraryMsg(d.msg);
        return { ok: true, queued: d.queued, position: d.position,
                 wait: d.wait, reason: d.reason, deduped: d.deduped };
      },
      onExportPage: async (url, mode) => {
        const r = await api('POST', '/export', { url, mode });
        if (!r.ok) return failure(r);
        return { ok: true, path: r.data && r.data.path, mode: r.data && r.data.mode };
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
        if (mine) forgetPage();
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
        // `keys` is status only ({claude:'set'|'unset', …, modes:{…}}) and is
        // passed through undefined-as-undefined: a companion too old to have
        // it must leave the billing switches out, not show them empty
        return { ok: true, current: d.current || {}, options: d.options || null,
                 status: d.status || null, bridge: d.bridge || '',
                 effort: d.effort || null, verbosity: d.verbosity || '',
                 keys: d.keys };
      },
      // Both are stored preferences: they can be set with the agents asleep and
      // are imposed at the next wake. `applies` says whether the running bridge
      // was told just now or the setting is waiting for one — the drawer says
      // which in the same line it confirms the choice.
      onSetModel: async (agent, model) => {
        const r = await api('POST', '/model', { agent, model });
        if (!r.ok) return failure(r);
        return { ok: true, queued: r.data && r.data.queued, applies: r.data && r.data.applies };
      },
      onSetEffort: async (agent, level) => {
        const r = await api('POST', '/effort', { agent, level });
        if (!r.ok) return failure(r);
        return { ok: true, queued: r.data && r.data.queued, applies: r.data && r.data.applies };
      },
      onSetVerbosity: async level => {
        const r = await api('POST', '/verbosity', { level });
        if (!r.ok) return failure(r);
        return { ok: true, queued: r.data && r.data.queued };
      },
      // Which auth an agent bills. The companion applies it at the next bridge
      // spawn and tells us whether that is now or after the running turn.
      onSetKeyMode: async (agent, mode) => {
        const r = await api('POST', '/key-mode', { agent, mode });
        if (!r.ok) return failure(r);
        return { ok: true, applies: r.data && r.data.applies };
      },
      // The drawer can ask WHICH auth to bill, but never for the key itself:
      // this panel is injected into whatever page you are reading and its DOM
      // is that page's DOM, so a key is typed on the extension's own options
      // page and nowhere else. `agent` is a hint the options page uses to focus
      // that agent's field — only the background can open it.
      onOpenOptions: agent => bg({ t: 'open-options', agent }),
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
      // The quote clicked: go to the mark. On a PDF the mark may be on a page
      // that has not been rendered yet — a strikeout minted for page 2 out of a
      // discussion on page 13 — and then there is nothing painted to scroll to.
      // Falling back to the PAGE puts the reader in front of the words; the
      // paint arrives with the render, a moment later, and lands under their eye
      // rather than nowhere.
      onJump: id => {
        if (Anchor.scrollTo(id)) return true;
        const t = ((PAGE && PAGE.threads) || []).find(x => x && x.id === id);
        const n = Number(t && t.page) || 0;
        if (!n) return false;
        const attr = (window.BFPAdapters && window.BFPAdapters.PDF_PAGE_ATTR)
          || 'data-bfp-pdf-page';
        const box = document.querySelector('[' + attr + '="' + n + '"]');
        if (!box || !box.scrollIntoView) return false;
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // …and once the page has rendered and content.js has painted it, take
        // the reader the last few lines to the mark itself
        setTimeout(() => Anchor.scrollTo(id), 600);
        return true;
      },
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
    // …and the same where the reader has handed this page's margin back to
    // the page's own commenting: the drag belongs to its pill, not ours
    if (standDown()) return;
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
    if (drawer && !inOurUI(e.target)) { drawer.hideSel(); drawer.hidePicks(); }
  }, true);

  // The pill clicked: freeze the anchor, paint it provisionally, open the
  // composer. `kind` is which of the pill's tools was pressed — 'strike' on a
  // PDF's second button, 'highlight' everywhere else (and on every article,
  // where the pill has only ever had the one).
  function commitSelection(kind) {
    if (!CAPS.highlights) return;
    // THE THIRD TOOL, and the one that makes no mark. "Make a question of
    // this" is not an annotation: nothing is written onto the document, no
    // thread is opened and no composer appears, because the reader's part in
    // it is over the moment they click. The passage is taken off the selection
    // and handed to the drawer, which hands it to the companion.
    if (kind === 'question') {
      const s = window.getSelection();
      if (!s || s.isCollapsed) return;
      const idx = freshIndex();
      const off = Anchor.offsetsFromRange(idx, s.getRangeAt(0));
      if (off.end <= off.start) return;
      const anchor = Anchor.buildAnchor(idx.raw, off.start, off.end);
      if (!anchor.quote) return;
      const pageNo = (SITE && typeof SITE.pageOf === 'function')
        ? (() => { try { return SITE.pageOf(s.getRangeAt(0).startContainer) | 0; } catch { return 0; } })()
        : 0;
      pendingQ = { quote: anchor.quote, page: pageNo };
      s.removeAllRanges();
      drawer.hideSel();
      drawer.makeQuestion();
      return;
    }
    const mark = (kind === 'strike' && CAPS.strike) ? 'strike' : 'highlight';
    if (standDown()) return;   // no new threads where the page owns the margin
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const index = freshIndex();
    const { start, end } = Anchor.offsetsFromRange(index, sel.getRangeAt(0));
    if (end <= start) return;
    const a = Anchor.buildAnchor(index.raw, start, end);
    if (!a.quote) return;

    // Where in the document this passage is, when the document has pages. A
    // PDF's "p. 12" is half of what a quote MEANS, and it is knowable only
    // here, at the moment of selection, from the DOM the selection was made
    // in. Everything else about the anchor is unchanged: a page number is an
    // extra field on the payload, never a second way of finding the text.
    const page = (SITE && typeof SITE.pageOf === 'function')
      ? (() => { try { return SITE.pageOf(sel.getRangeAt(0).startContainer) | 0; } catch { return 0; } })()
      : 0;

    Anchor.unpaint('__new__');
    pendingSel = { ...a, start, end, page, mark };
    Anchor.paintOffsets(index, start, end, '__new__', false, mark);
    sel.removeAllRanges();
    drawer.hideSel();
    drawer.beginNew({ ...a, mark });
  }

  // click a highlight → open the drawer at that thread
  document.addEventListener('click', e => {
    // …and the struck old wording beside a rewritten one opens the same
    // thread: to the reader it is one thing — the change — and half of it
    // being inert would be a small betrayal of that.
    const mark = e.target && e.target.closest
      && e.target.closest('mark.bfp-hl, del.bfp-was[data-bfp]');
    if (!mark) return;
    const id = mark.getAttribute('data-bfp');
    if (!id || id === '__new__') return;
    e.preventDefault();
    // …and where SEVERAL markings lie on this spot — the reader's own strike
    // painted over the discussion that produced it is the ordinary case — the
    // click cannot mean one of them, so it asks. `marksAtPoint` answers from
    // the paint at (x, y), nearest-fitting first; anything shorter than two
    // ids is not a choice and falls through to the click this has always been.
    const at = Anchor.marksAtPoint(e.target, e.clientX, e.clientY);
    if (at.length > 1) {
      activate().then(d => { if (d) d.showPicks(e.clientX, e.clientY, at); });
      return;
    }
    activate().then(d => {
      d.open('comments');
      d.focus(id);
      d.scrollToThread(id);
    });
  }, true);

  // Esc closes the drawer wherever the focus is
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !drawer) return;
    // one layer at a time: the overlap chooser, then an open lightbox (a figure
    // from a code-block run), then the drawer. The first two are up whether or
    // not the panel is — a chooser can be opened on a dormant page — so they
    // are asked before the drawer's own state is.
    if (drawer.picksOpen && drawer.picksOpen()) { drawer.hidePicks(); return; }
    if (drawer.isOpen() && !drawer.escape()) { drawer.close(); }
  }, true);

  // ---- the bots changed this project's files ------------------------------
  // A project artifact is REGENERATED in place — that is what the project is
  // for — and a browser has no idea a local file moved underneath it. So when
  // a turn ends and the companion reports that something under the project
  // changed (`project-files`, server.mjs), the tab does one of two things:
  //
  //   this page's own file changed  → reload it. The reader asked for a
  //       rewrite and is otherwise left reading the version that no longer
  //       exists. The drawer's state survives it as far as it survives any
  //       reload: the record is on the companion (threads, chat, drafts the
  //       composer has saved), and the tab re-attaches and re-opens.
  //   only siblings changed         → a line in the page chat, and NOTHING
  //       else. Reloading a page whose bytes did not change would throw away
  //       the reader's scroll position, selection and half-typed comment to
  //       show them exactly what they were already looking at.
  //
  // No loop is possible: a reload starts no turn, and only a turn-end emits
  // this event.
  let lastFilesAt = '';
  function onProjectFiles(ev) {
    if (!PROJECT || !ev || ev.project_id !== PROJECT.project_id) return;
    if (normUrl(ev.url || '') !== URL_NOW) return;
    // the same event arriving twice (SSE and the socket both up) must not
    // reload twice
    if (ev.at && ev.at === lastFilesAt) return;
    lastFilesAt = ev.at || '';
    if (ev.page_changed) { reloadForArtifact(); return; }
    if (!drawer) return;
    const n = ev.count || 0;
    drawer.note(null, `the bots changed ${n} file${n === 1 ? '' : 's'} in this project — not this page`);
  }

  // …and the same thing for a blog draft. Different event, same two outcomes:
  // the post the reader is reading was rewritten (or a picture in it was
  // placed) → reload, because jekyll has already rebuilt the page underneath
  // them; anything else in the repo moved → a line in the chat and nothing
  // else, because reloading a page whose bytes did not change would throw
  // away their scroll position to show them what they are already looking at.
  //
  // No PROJECT test here: a blog page is an ordinary web page that happens to
  // have a source file, so the url is the whole of the match.
  let lastBlogFilesAt = '';
  function onBlogFiles(ev) {
    if (!ev || normUrl(ev.url || '') !== URL_NOW) return;
    if (ev.at && ev.at === lastBlogFilesAt) return;   // SSE and the socket both up
    lastBlogFilesAt = ev.at || '';
    if (ev.page_changed) { reloadForArtifact(); return; }
    if (!drawer) return;
    const n = ev.count || 0;
    drawer.note(null, `the bots changed ${n} file${n === 1 ? '' : 's'} in this site — not this post`);
  }

  // The reload, behind one name so the harness can watch it happen without
  // taking the test page down with it. Same seam as __BFP_HREF/__BFP_PROJECT:
  // set __BFP_NO_RELOAD and the reloads are counted instead of performed.
  function reloadForArtifact() {
    if (window.__BFP_NO_RELOAD) { reloadsAsked++; return; }
    try { location.reload(); } catch (_) { /* nothing else to try */ }
  }
  let reloadsAsked = 0;

  // ---- background messages -----------------------------------------------------
  alive(() => chrome.runtime.onMessage.addListener(
    (msg, sender, sendResponse) => handleWorkerMsg(msg, sendResponse)), null);

  // The same handling whichever pipe carried it — tabs.sendMessage or the port.
  function handleWorkerMsg(msg, sendResponse) {
    if (!msg) return;
    lastEventAt = Date.now();
    // a worker that has just started asking who is out here: answering is what
    // puts this tab back in its routing table
    if (msg.t === 'whereami') {
      sendResponse({ ok: true, url: IDENT_HREF, active });
      return;
    }
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
      // the socket opening is proof; the socket dropping is not — the
      // companion is very often still answering, and the reconnect is ours
      connSocket(!!msg.connected);
      // a socket that has just come back cannot say what it missed while it
      // was down, so the record is asked instead of assumed
      if (msg.connected && msg.resumed) resync('socket-resumed');
      sendResponse({ ok: true });
      return;
    }
    if (msg.t === 'ws') {
      const ev = msg.ev || {};
      // an event that cannot be handled is not allowed to end the stream: the
      // drawer swallows the throw, this catches anything left, and either way
      // the record is asked what really happened
      try {
        if (ev.type === 'council-root') {
          // the reader answered the confirmation in ANOTHER tab; every page
          // under that root stops asking (or starts working) at once
          if (PROJECT && PROJECT.root === ev.root) {
            PROJECT.confirmed = ev.state === 'yes';
            if (drawer) drawer.setProject(PROJECT);
          }
        } else if (ev.type === 'project-files') {
          // the bots changed something under this project during the turn that
          // has just ended (server.mjs reportProjectChanges)
          onProjectFiles(ev);
        } else if (ev.type === 'blog-files') {
          // …and the same thing for a draft of the reader's own site: the
          // markdown behind THIS page was rewritten, jekyll has rebuilt it by
          // now, and the tab is looking at the old rendering
          onBlogFiles(ev);
        } else if (ev.type === 'blog-root') {
          // the reader answered the confirmation in another tab
          loadBlog();
        } else if (ev.type === 'page') {
          // the library's record changed (somebody asked it something from
          // another tab, or the phone): re-read that, not this page
          if (isLibraryUrl(ev.url)) {
            if (drawer) drawer.refreshLibrary();
          } else if (active) loadPage();
          // the pages list is a live view of /index; a no-op unless it is up
          if (drawer) drawer.refreshPages();
        } else if (drawer) {
          drawer.onEvent(ev);
          if (drawer.eventErrors() > eventErrorsSeen) {
            eventErrorsSeen = drawer.eventErrors();
            resync('event-failed');
          }
        }
      } catch (e) {
        console.warn('[botference] event handling failed:', (e && e.message) || e);
        resync('event-threw');
      }
      sendResponse({ ok: true });
      return;
    }
    // A message this page does not understand is answered by SAYING NOTHING,
    // and that is a correction rather than a shrug.
    //
    // On an ordinary web page this script only ever hears tabs.sendMessage, so
    // an "unknown" reply cost nothing. But the PDF viewer is an EXTENSION PAGE,
    // and chrome.runtime.sendMessage from one extension page is delivered to
    // every OTHER extension context — including this same script running in a
    // second viewer tab. Chrome gives the caller whichever listener answers
    // first, so a viewer tab left open would answer its neighbour's `hello`
    // with `{ok:false, error:'unknown'}` before the service worker could reply,
    // and that neighbour would then sit dormant on a page it has annotations
    // for. Not answering leaves the channel to the worker, which is whose
    // question it was.
  }

  // ---- boot ---------------------------------------------------------------------
  // One-shot: a row clicked in another tab's pages list left a flag for this
  // normUrl, which means the user asked for this page's drawer even though
  // they have not clicked anything here. Consume it (delete first, so a crash
  // between here and open() cannot leave the flag armed forever) and open.
  let AUTOOPEN_KEY = 'bfp-autoopen:' + URL_NOW;
  function consumeAutoOpen() {
    if (!extensionAlive()) { GUARD.lose(); return; }
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

  // The reader's standing answer to "which margin owns this page", read once
  // at boot and only where the question arises at all — an ordinary page never
  // touches storage for this. A stored `true` hands the page its own
  // commenting back; anything else leaves Discuss holding the margin, which is
  // both the default and the state we booted in.
  //
  // The suppression is applied SYNCHRONOUSLY at boot, before storage answers,
  // because the page's pill must not flash up on the reader's first drag while
  // a callback is still in flight. If the stored answer turns out to be "the
  // page's", it is given back a tick later — which is the harmless direction.
  function loadPageComments() {
    if (!HOSTS_REVIEW_UI) return;
    suppressPageSelUI(true);
    if (!extensionAlive()) return;
    try {
      chrome.storage.local.get(PAGE_COMMENTS_KEY, r => {
        if (!r || !r[PAGE_COMMENTS_KEY]) return;
        setPageOwnsMargin(true);
      });
    } catch { /* no storage: Discuss keeps the margin, which is the default */ }
  }

  // The switch itself, thrown from the drawer's Comments tab. Persisted first
  // (it is a per-page preference, not a session mood), then applied: exactly
  // one of the two pills is live afterwards, and a composer already open on a
  // selection is withdrawn rather than left floating over a page that has just
  // stopped taking new Discuss comments.
  function setPageOwnsMargin(want) {
    pageOwnsMargin = !!want;
    try {
      if (pageOwnsMargin) chrome.storage.local.set({ [PAGE_COMMENTS_KEY]: true });
      else if (chrome.storage.local.remove) chrome.storage.local.remove(PAGE_COMMENTS_KEY);
      else chrome.storage.local.set({ [PAGE_COMMENTS_KEY]: false });
    } catch { /* the choice still holds for this page view */ }
    // the page's own pill comes back exactly when ours goes away, and vice
    // versa: there is never a drag with two answers to it, or none
    suppressPageSelUI(HOSTS_REVIEW_UI && !pageOwnsMargin);
    if (drawer) {
      if (standDown()) {
        drawer.hideSel();
        if (pendingSel) drawer.cancelNew();
      }
      drawer.setReviewHost({ hosts: HOSTS_REVIEW_UI, pageOwns: pageOwnsMargin });
    }
  }

  function boot() {
    watchSpaNavigation();
    consumeAutoOpen();
    loadPageComments();
    loadTrackChanges();
    startLiveness();
    bg({ t: 'hello', url: IDENT_HREF }).then(r => {
      if (!r || !r.ok) return;
      // A project artifact is never dormant. The dormancy rule exists because
      // <all_urls> puts this script on the whole web and almost none of it is
      // annotated; a page the reader's own council wrote, opened deliberately
      // from their own project folder, is the opposite case — the chat behind
      // it already exists and the drawer is how they get at it. It still does
      // not barge in: activate(false) restores the highlights and leaves the
      // drawer shut until asked for, exactly as an annotated page does.
      if (PROJECT) {
        activate(false).then(() => connSocket(!!r.connected));
        return;
      }
      if (r.known) {
        // an annotated page: wake up and restore the highlights, but do not
        // barge in — the drawer stays shut until asked for
        activate(false).then(() => connSocket(!!r.connected));
        return;
      }
      // A text-identified local PDF whose record still sits under its old
      // byte-hash identity is not in the index yet, so `known` says no — but
      // one GET /page is exactly what ADOPTS it (the companion migrates on
      // read). Ask once rather than sit dormant on a paper that has a chat;
      // for a never-annotated PDF the answer is page:null, a read creates
      // nothing, and dormant is right.
      if (/^bfp-pdf:\/\/text\//.test(URL_NOW)) {
        api('GET', '/page?url=' + encodeURIComponent(URL_NOW)).then(pr => {
          const rec = pr && pr.ok
            ? (pr.data && pr.data.page !== undefined ? pr.data.page : pr.data) : null;
          if (rec && rec.url) activate(false).then(() => connSocket(!!r.connected));
        });
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  // exposed for test/harness.html
  window.__bfp = {
    activate, loadPage, reanchorAll, refresh, headline, articleText, normUrl, hashText,
    snapshotHtml, displayTitle,
    // pdf/viewer.js's one call in: the comments the FILE arrived with. Also
    // the harness's way to stage them without a PDF.
    pdfAnnots: pdfAnnotsArrived,
    get pdfImport() {
      return { total: pdfAnnotList.length, pending: pdfPending().length };
    },
    // What this page is CALLED, and a subscription to it changing. pdf/viewer.js
    // draws its own top bar and has no other way to hear about a rename, which
    // arrives as an ordinary `page` event and lands in loadPage().
    onTitle(cb) {
      if (typeof cb !== 'function') return;
      titleWatchers.push(cb);
      if (PAGE) { try { cb(displayTitle(PAGE)); } catch (_) { /* not the page's problem */ } }
    },
    get title() { return PAGE ? displayTitle(PAGE) : ''; },
    site: SITE, caps: CAPS,
    // a page that carries its own review commenting: what the marker said,
    // which margin owns the page now, whether the page's own selection pill is
    // suppressed, and the switch itself
    reviewHost: {
      marker: REVIEW_UI_MARKER,
      pageSelUI: PAGE_SEL_UI,
      get hosts() { return HOSTS_REVIEW_UI; },
      get pageOwns() { return pageOwnsMargin; },
      get standDown() { return standDown(); },
      get suppressed() { return !!document.getElementById(SUPPRESS_STYLE_ID); },
      set: setPageOwnsMargin,
      load: loadPageComments,
    },
    // the page identity this document settled on at load, and whether the
    // document's own canonical link is what decided it
    // getters, because a single-page app moves all three under the reader
    get url() { return URL_NOW; },
    get identHref() { return IDENT_HREF; },
    get canonical() { return CANONICAL_HREF; },
    // the SPA rebind, driven directly by test/harness.html
    rebindIdentity,
    // the council project behind this page, or null — what decides that a
    // file: document is a page at all (see the gate at the top)
    get project() { return PROJECT; },
    // how many times a `project-files` event asked this tab to reload, when
    // __BFP_NO_RELOAD holds the reload back (the harness)
    get reloads() { return reloadsAsked; },
    // the extension-reload guard. The FACTORY, not this page's instance: a
    // test drives its own over a fake chrome, because tripping the real one
    // would take the rest of the page down with it — which is exactly what it
    // is for.
    contextGuard: { make: makeContextGuard, isContextGone, note: RELOAD_NOTE,
                    get lost() { return GUARD.gone; } },
    // the liveness machinery, observable so the harness can drive a dead
    // worker and assert that the page converges anyway
    liveness: { resync, connectPort, watchSend, get log() { return resyncLog.slice(); },
                get connected() { return !!port; } },
    // what the companion was last told the page said — the harness asserts the
    // changed/unchanged decision against it rather than inferring it
    get contextHash() { return lastContextHash; },
    // the two halves of the first-turn-context rule, observable so the harness
    // can assert the escape hatch instead of trusting it
    get sentContext() { return sentArticleText; },
    get sessionKnown() { return pageHasSession; },
    // does the companion hold a record for this page yet? — the lazy-persistence
    // rule, observable so the harness can assert a visit wrote nothing
    get registered() { return registered; },
    get drawer() { return drawer; },
    get page() { return PAGE; },
  };
})();
