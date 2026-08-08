// adapters.js — site adapters for the Botference Web Annotator.
//
// The extension assumes a static article: real text nodes to extract, real
// text nodes to wrap in <mark>. Some sites are not that. Google Docs paints
// its document to a <canvas>, so there is nothing to extract and nothing to
// highlight — and the bots cannot fetch the url themselves either (auth + an
// app shell rather than the document).
//
// An adapter is the per-site answer to those two questions:
//
//   { name,                         // for logs/tests only
//     capabilities: { highlights }, // false ⇒ no selection pill, no painting
//     title(),                      // '' ⇒ fall back to the generic headline
//     articleText() }               // Promise<string>; '' ⇒ generic extraction
//
// `pick(url, env)` walks the registry and returns the first adapter whose
// match hits, or null for "this is an ordinary page" — content.js then uses
// its own extraction with { highlights: true }. Adding Notion or Office later
// means one entry in REGISTRY and nothing else.
//
// The hard parts are deliberately pure so they run in node:
// gdocsId · gdocsScope · gdocsExportUrl · gdocsExportUrls · accountFromUrls ·
// stripDocsSuffix · cleanExport · looksHtml (see test/adapters.test.mjs).
// Everything that touches the world arrives through `env`
// ({request, send, fetch, documentTitle, accountUrls}), which defaults to the
// real globals.
//
// ── WHO ACTUALLY MAKES THE REQUEST ─────────────────────────────────────────
// The background service worker, not this script. A content script's fetch is
// issued in the PAGE's context in Chromium: it rides the page's
// `connect-src`, and Google Docs ships a strict CSP that blocks
// docs.google.com/…/export outright — silently, as a network error. The worker
// has host_permissions for docs.google.com, no page CSP, and the user's
// cookies, so the export goes out from there via {t:'gdocs-export', url}
// (see background.js's contract block). A direct fetch() stays as the
// fallback for any world without the worker — the harness, and node.
//
// An adapter that fails says why on `lastError` (every attempt: status code
// and a peek at the body, joined). content.js logs it and — on a site whose
// text is not in the DOM at all — warns the user, because scraping the app's
// chrome instead would send menu bars to the bots as "the document".
//
// UMD-lite, exactly like anchor.js: `module.exports` under CommonJS (node
// tests), `window.BFPAdapters` in the page. Loaded before content.js in the
// manifest and in test/harness.html.
(function (root) {
  'use strict';

  // ---- pure core ---------------------------------------------------------

  // https://docs.google.com/document/d/<id>/edit?tab=t.0#heading=h.x
  // …and BOTH account-scoped forms a second signed-in profile produces:
  //   docs.google.com/document/u/1/d/<id>/edit   (the Docs app's own links)
  //   docs.google.com/u/1/document/d/<id>/edit   (links out of Drive)
  const GDOCS_URL = /^https?:\/\/docs\.google\.com\/(?:u\/(\d+)\/)?document\/(?:u\/(\d+)\/)?d\/([A-Za-z0-9_-]{8,})(?:[/?#]|$)/;

  const gdocsMatch = url => GDOCS_URL.exec(String(url == null ? '' : url).trim());

  // The document id, or null when this is not a Google Doc (a Sheet, a Drive
  // folder, any other site).
  function gdocsId(url) {
    const m = gdocsMatch(url);
    return m ? m[3] : null;
  }

  // Which signed-in account this tab is scoped to — and where the /u/<n>/ sat,
  // because both spellings above are real and each is one Google itself
  // served. {n:'1', where:'pre'|'post'}, or null for an unscoped url.
  function gdocsScope(url) {
    const m = gdocsMatch(url);
    if (!m) return null;
    if (m[1] != null) return { n: m[1], where: 'pre' };
    if (m[2] != null) return { n: m[2], where: 'post' };
    return null;
  }

  // The plain-text export of a doc, ON THE SAME ACCOUNT AS THE PAGE — fetched
  // with the user's own session, which is the whole point: the bots never can.
  //
  // The account prefix is not cosmetic. The bare /document/d/<id>/export is
  // served by the DEFAULT account (u/0); when the doc belongs to a second
  // profile that url does not 404, it answers 200 with an account chooser —
  // the silent failure that put Docs UI junk in the bots' context. Echoing the
  // page's own /u/<n>/ back keeps the request on the session that can read it.
  //
  // No `&id=` rider: on this route the id is already in the path (the `?id=`
  // form belongs to the older /document/export endpoint), and one url is one
  // fewer thing to be wrong.
  function gdocsExportUrl(id, scope) {
    const eid = encodeURIComponent(String(id));
    const n = scope && /^\d+$/.test(String(scope.n)) ? String(scope.n) : null;
    if (n === null) return 'https://docs.google.com/document/d/' + eid + '/export?format=txt';
    if (scope.where === 'pre') return 'https://docs.google.com/u/' + n + '/document/d/' + eid + '/export?format=txt';
    return 'https://docs.google.com/document/u/' + n + '/d/' + eid + '/export?format=txt';
  }

  // ---- which account, when the url does not say --------------------------
  //
  // The live failure after the scoping fix: page urls with NO /u/<n>/ in them
  // at all, on a machine with several signed-in Google accounts. The account
  // there is chosen by COOKIE, not by url, so the doc can belong to a
  // non-default account while every url on screen looks unscoped. `authuser=N`
  // is the query-string equivalent of /u/N/ and overrides that cookie.
  //
  // Two ways to find N, cheapest first:
  //   1. ask the page. Docs writes its own account into its own chrome: the
  //      home button links to /document/u/<n>/, and the account widgets carry
  //      ?authuser=<n>. Those are written by the app for the account it is
  //      signed in as — exactly the number the bare export url is missing.
  //   2. failing that, cascade 0..4 and keep the first answer that is a
  //      document rather than a chooser.
  const AUTHUSER_IN_QUERY = /[?&]authuser=(\d{1,3})(?:&|$)/;
  const ACCOUNT_IN_PATH = /^(?:https?:\/\/docs\.google\.com)?\/(?:u\/(\d{1,3})\/|document\/u\/(\d{1,3})\/)/;

  // First account index any of these urls admits to, or null. Pure: the DOM
  // walk that collects the urls lives in `env.accountUrls`.
  function accountFromUrls(urls) {
    for (const raw of urls || []) {
      const s = String(raw == null ? '' : raw);
      const q = AUTHUSER_IN_QUERY.exec(s);
      if (q) return q[1];
      const p = ACCOUNT_IN_PATH.exec(s);
      if (p) return p[1] != null ? p[1] : p[2];
    }
    return null;
  }

  // 0..4 covers every account a person is plausibly signed into at once; each
  // attempt is one cheap GET on a route the background worker validates.
  const AUTHUSER_MAX = 4;
  // the primary (what the page url itself says) plus that cascade
  const EXPORT_URL_MAX = 2 + AUTHUSER_MAX;

  const withAuthuser = (id, n) =>
    gdocsExportUrl(id, null) + '&authuser=' + encodeURIComponent(String(n));

  // Every export url worth trying, in the order to try them: what the page url
  // says first (it is the only one that can be RIGHT rather than guessed),
  // then the page's own hint, then the cascade. Deduped, capped, deterministic.
  function gdocsExportUrls(id, scope, hint) {
    const out = [];
    const push = u => { if (u && out.indexOf(u) === -1 && out.length < EXPORT_URL_MAX) out.push(u); };
    push(gdocsExportUrl(id, scope));
    if (hint != null && /^\d{1,3}$/.test(String(hint))) push(withAuthuser(id, hint));
    for (let n = 0; n <= AUTHUSER_MAX; n++) push(withAuthuser(id, n));
    return out;
  }

  // "Q3 narrative - Google Docs" → "Q3 narrative". Only a real trailing
  // suffix is removed; a document actually called "Notes on Google Docs"
  // keeps its name.
  const DOCS_SUFFIX = /\s*[-–—]\s*Google\s+Docs\s*$/i;
  function stripDocsSuffix(title) {
    return String(title == null ? '' : title).replace(DOCS_SUFFIX, '').trim();
  }

  // The companion caps the first-turn context at 6000 chars server-side; we
  // send up to this and let it cap, so a longer window costs no client change.
  const TEXT_LIMIT = 12000;

  // Export bodies arrive with a UTF-8 BOM and CRLF line endings; blank runs
  // are the doc's own paragraph spacing and are worth keeping (the text is
  // read by a model, not laid out), but three or more do nothing.
  function cleanExport(text, limit) {
    let s = String(text == null ? '' : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    s = s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    // the cut itself can land on a paragraph break — never send the dangle
    return s.slice(0, limit || TEXT_LIMIT).trimEnd();
  }

  // A signed-out, permission-denied or WRONG-ACCOUNT export comes back 200
  // with a page in it: a login form, an account chooser, an error shell. The
  // export of a real document is text/plain and never opens with a tag, so
  // anything that does is a failure whatever the status line claimed.
  //
  // Deliberately blunt — a leading '<' anywhere is enough, and <html appearing
  // early is enough — because the cost of misreading a doc that genuinely
  // starts with '<' is one visible warning, while the cost of missing a
  // chooser is a burned first turn nobody was told about.
  const OPENS_AS_MARKUP = /^\s*</;
  const HAS_HTML_TAG = /<html[\s>/]|<!doctype\s+html/i;
  function looksHtml(body) {
    let s = String(body == null ? '' : body);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return OPENS_AS_MARKUP.test(s) || HAS_HTML_TAG.test(s.slice(0, 4096));
  }

  // enough of a failed body to recognise it in a console line, on one line
  const peek = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 80);
  // …and enough of a url: the ids are 40+ chars of noise in a log line
  const shortUrl = u => String(u == null ? '' : u).replace(/\/d\/[^/]+\//, '/d/…/');

  // ---- transport ----------------------------------------------------------
  // One attempt, normalised to {ok, status, contentType, text, error, via}
  // whatever carried it. Two transports, tried in this order:
  //
  //   'page'  fetch() from the content script with credentials:'same-origin'.
  //           THE ONE THAT WORKS, and the mode matters more than anything else
  //           in this file. /export does not serve the document itself: it
  //           302s to doc-XX-XX-docstext.googleusercontent.com with a `dat=`
  //           auth token in the query, and THAT response carries
  //           `Access-Control-Allow-Origin: *`. A wildcard ACAO is illegal for
  //           a credentialed request, so credentials:'include' made the browser
  //           reject the redirect and the fetch threw "Failed to fetch" —
  //           which is precisely how a private doc silently produced no text.
  //           'same-origin' still sends cookies on the FIRST hop
  //           (docs.google.com — same origin as the page, and that is what
  //           authorises minting the tokened url), and omits them on the
  //           cross-origin hop, where the `dat=` token is the authorisation
  //           and the wildcard is then perfectly legal.
  //
  //   'background'  {t:'gdocs-export'} to the service worker (contract in
  //           background.js). Cookies must be 'include' there — the worker's
  //           origin is the extension, so 'same-origin' would send none at all
  //           — and CORS is satisfied by host_permissions, which is why they
  //           list googleusercontent.com as well as docs.google.com. Kept as
  //           the fallback for any environment where the page fetch cannot
  //           run at all (a strict page CSP: a content script's requests ride
  //           the page's connect-src in Chromium).
  //
  // `env.request` overrides both outright — that is how the tests drive it.
  const hasRuntime = () => {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
    } catch { return false; }
  };

  function sendMessage(send, msg) {
    return new Promise((resolve, reject) => {
      try {
        const r = send(msg, reply => {
          const err = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || null;
          if (err) return reject(new Error(err.message || 'sendMessage failed'));
          resolve(reply);
        });
        // a promise-returning sendMessage (some shims, and MV3 without a
        // callback) resolves through here instead
        if (r && typeof r.then === 'function') r.then(resolve, reject);
      } catch (e) { reject(e); }
    });
  }

  // an answer that means "this world has no worker for it", not "the fetch
  // failed" — the only case that may fall through to a direct fetch
  const noSuchMessage = r => !r || (r.ok === false && /unknown message|no response/i.test(String(r.error || '')));

  // The credentials mode is load-bearing on the page transport — see above.
  const PAGE_CREDENTIALS = 'same-origin';

  // The transports this world actually has, in the order to try them.
  function transports(env) {
    if (env && typeof env.request === 'function') {
      return [{ name: 'given', run: env.request }];
    }
    const out = [];
    const f = (env && env.fetch) || (typeof fetch === 'function' ? fetch : null);
    if (f) {
      out.push({ name: 'page', async run(url) {
        let res;
        try { res = await f(url, { credentials: PAGE_CREDENTIALS }); }
        catch (e) { return { ok: false, error: 'fetch threw: ' + peek((e && e.message) || e) }; }
        if (!res) return { ok: false, error: 'no response' };
        const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        let text = '';
        try { text = await res.text(); }
        catch (e) { return { ok: false, status: res.status, contentType, error: 'the body did not read: ' + peek((e && e.message) || e) }; }
        if (!res.ok) return { ok: false, status: res.status, contentType, text, error: 'HTTP ' + (res.status == null ? '?' : res.status) };
        return { ok: true, status: res.status == null ? 200 : res.status, contentType, text };
      } });
    }
    const send = (env && env.send) || (hasRuntime() ? chrome.runtime.sendMessage.bind(chrome.runtime) : null);
    if (send) {
      out.push({ name: 'background', async run(url) {
        let r = null;
        try { r = await sendMessage(send, { t: 'gdocs-export', url }); }
        catch (e) { return { ok: false, error: 'the background did not answer: ' + peek((e && e.message) || e), gone: true }; }
        if (noSuchMessage(r)) return { ok: false, error: 'this build has no gdocs-export worker', gone: true };
        if (r.ok) return { ok: true, status: r.status || 200, contentType: r.contentType || '', text: String(r.text || '') };
        return { ok: false, status: r.status, contentType: r.contentType || '',
                 text: r.text || r.peek || '', error: r.error || 'the background could not fetch it' };
      } });
    }
    if (!out.length) out.push({ name: 'none', run: async () => ({ ok: false, error: 'no transport in this context' }) });
    return out;
  }

  // Failures worth trying another account for. A chooser (HTML) is the obvious
  // one; 401/403/404 are the same story told with a status line — this account
  // cannot see this document. Anything else (a 500, a dead network) is not
  // about WHICH account, so cascading would only make five of the same
  // mistake.
  function authShaped(r) {
    if (!r) return false;
    if (r.ok) return true;                      // ok-but-HTML is decided by the caller
    return r.status === 401 || r.status === 403 || r.status === 404;
  }

  // ---- google docs --------------------------------------------------------

  const GDOCS = {
    name: 'gdocs',
    match(url) {
      const m = gdocsMatch(url);
      return m ? { id: m[3], scope: gdocsScope(url) } : null;
    },
    create(hit, env) {
      const id = hit && hit.id !== undefined ? hit.id : hit;   // tolerate a bare id
      const scope = (hit && hit.scope) || null;
      const lanes = transports(env);
      const docTitle = (env && env.documentTitle) ||
        (() => (typeof document !== 'undefined' ? document.title : ''));
      // The page's own links, for the account hint. Capped and attribute-only:
      // this runs on every first mention and must never be a DOM crawl.
      const accountUrls = (env && env.accountUrls) || function () {
        if (typeof document === 'undefined' || !document.querySelectorAll) return [];
        const out = [];
        const nodes = document.querySelectorAll('a[href], link[href], img[src], iframe[src]');
        for (let i = 0; i < nodes.length && out.length < 40; i++) {
          const v = nodes[i].getAttribute('href') || nodes[i].getAttribute('src') || '';
          if (v && /authuser=\d|\/u\/\d{1,3}\//.test(v)) out.push(v);
        }
        return out;
      };

      const ad = {
        name: 'gdocs',
        id,
        scope,
        // what the page url itself says — the first url tried, and the one
        // quoted in logs
        exportUrl: gdocsExportUrl(id, scope),
        usedUrl: '',      // the one that actually answered with a document
        attempts: [],     // [{url, status, why}] for the last articleText()
        // why the last articleText() came back empty — read by content.js for
        // the console line and the user-facing warning
        lastError: '',
        // Nothing on the page is a text node, so nothing can be wrapped.
        capabilities: { highlights: false },
        title: () => stripDocsSuffix(docTitle()),
        // The ladder, in full:
        //
        //   page fetch, the url the page url implies
        //     └ HTML back? → the authuser cascade, same transport
        //   background fetch, the same ladder again
        //     └ …only reached when the page transport could not run at all
        //       (a CSP-blocked request, a fetch that threw)
        //   '' + every attempt on lastError → content.js warns the user
        //
        // Every failure still resolves to '' — but it also SAYS SO on
        // lastError, and content.js no longer papers over it with a scrape of
        // the Docs UI. On this site '' means "no context", not "use the DOM".
        async articleText() {
          ad.lastError = '';
          ad.usedUrl = '';
          ad.attempts = [];

          // the page's own links know which account it is signed in as, when
          // no url on screen has a /u/<n>/ in it
          let hint = null;
          try { hint = accountFromUrls(accountUrls()); } catch { hint = null; }
          ad.hintedAccount = hint;

          const urls = gdocsExportUrls(id, scope, hint);
          ad.exportUrls = urls;

          for (const lane of lanes) {
            for (const url of urls) {
              const r = await lane.run(url);
              const status = r && r.status != null ? r.status : '?';
              let why = '';
              if (!r || (!r.ok && !r.error)) why = 'no response';
              else if (!r.ok) why = r.error;
              else if (/text\/html/i.test(r.contentType || '') || looksHtml(r.text)) {
                // the account chooser / sign-in page, served 200
                why = 'HTTP ' + status + ' but the body is HTML — signed out, or this ' +
                  'doc belongs to another signed-in account: ' + peek(r.text);
              } else {
                const text = cleanExport(r.text, TEXT_LIMIT);
                if (text) { ad.usedUrl = url; ad.usedVia = lane.name; return text; }
                why = 'HTTP ' + status + ' with an empty body';
              }
              ad.attempts.push({ url, status, why, via: lane.name });
              // another account is only worth trying when THIS one was refused;
              // a 500 or a dead network is not a question of which account, and
              // cascading would just make the same mistake five times
              if (!authShaped(r)) break;
            }
            if (ad.usedUrl) break;
          }
          ad.lastError = ad.attempts.map(a => a.via + ' ' + shortUrl(a.url) + ' → ' + a.why).join(' · ') ||
            'no export url to try';
          return '';
        },
      };
      return ad;
    },
  };

  // ---- registry -----------------------------------------------------------

  const REGISTRY = [GDOCS];

  function pick(url, env) {
    for (const a of REGISTRY) {
      let m;
      try { m = a.match(url); } catch { m = null; }
      if (m) return a.create(m, env);
    }
    return null;
  }

  const api = {
    pick, REGISTRY,
    // pure, for the node tests
    gdocsId, gdocsScope, gdocsExportUrl, gdocsExportUrls, accountFromUrls,
    stripDocsSuffix, cleanExport, looksHtml,
    TEXT_LIMIT, AUTHUSER_MAX, EXPORT_URL_MAX, PAGE_CREDENTIALS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPAdapters = api;
})(typeof window !== 'undefined' ? window : globalThis);
