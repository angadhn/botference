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
//     capabilities: { highlights,   // false ⇒ no selection pill, no painting
//                     strike,       // true ⇒ the pill gets Adobe's second tool
//                                   //   (a strikeout). PDFs only.
//                     textFallback,// false ⇒ '' from articleText() means "no
//                                   //   text", never "scrape the DOM instead"
//                     reportOrphans },// false ⇒ a lost anchor is badged here
//                                   //   and never POSTed to /orphan
//     identityHref,                 // WHICH PAGE this is, when the address bar
//                                   //   is not it (the PDF viewer). '' ⇒ the
//                                   //   ordinary rule (canonical, else location)
//     site,                         // where it files, when the identity has no
//                                   //   hostname worth the name (a local PDF is
//                                   //   'local pdf', never 'sha256'). '' ⇒ the
//                                   //   identity's hostname, as always
//     fileName,                     // the file on disk this came out of, if any
//                                   //   — recorded for the reader, never a path
//     title(),                      // '' ⇒ fall back to the generic headline
//     articleText(),                // Promise<string>; '' ⇒ generic extraction
//     snapshotHtml(),               // '' ⇒ content.js clones the article itself
//     pageOf(node),                 // 0 ⇒ this anchor has no page number
//     docx() }                      // Promise<base64>; optional attachment
//                                   // ('' = nothing to attach, never an error)
//
// `pick(url, env)` walks the registry and returns the first adapter whose
// match hits, or null for "this is an ordinary page" — content.js then uses
// its own extraction with { highlights: true }. Adding Notion or Office later
// means one entry in REGISTRY and nothing else.
//
// The hard parts are deliberately pure so they run in node:
// gdocsId · gdocsScope · gdocsExportUrl · gdocsExportUrls · accountFromUrls ·
// stripDocsSuffix · cleanExport · looksHtml · looksZip · bytesToBase64 ·
// b64Size (see test/adapters.test.mjs).
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
  //
  // `format` is 'txt' (the prose the bots read) or 'docx' (the same document as
  // a zip, which is the ONLY way the doc's own comment threads travel — a txt
  // export drops them entirely). Anything else is treated as txt rather than
  // put on the wire: this url is validated again in background.js and a typo
  // must not become a request.
  const FORMATS = { txt: 1, docx: 1 };
  function gdocsExportUrl(id, scope, format) {
    const eid = encodeURIComponent(String(id));
    const fmt = FORMATS[format] ? format : 'txt';
    const n = scope && /^\d+$/.test(String(scope.n)) ? String(scope.n) : null;
    if (n === null) return 'https://docs.google.com/document/d/' + eid + '/export?format=' + fmt;
    if (scope.where === 'pre') return 'https://docs.google.com/u/' + n + '/document/d/' + eid + '/export?format=' + fmt;
    return 'https://docs.google.com/document/u/' + n + '/d/' + eid + '/export?format=' + fmt;
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

  const withAuthuser = (id, n, format) =>
    gdocsExportUrl(id, null, format) + '&authuser=' + encodeURIComponent(String(n));

  // Every export url worth trying, in the order to try them: what the page url
  // says first (it is the only one that can be RIGHT rather than guessed),
  // then the page's own hint, then the cascade. Deduped, capped, deterministic.
  function gdocsExportUrls(id, scope, hint, format) {
    const out = [];
    const push = u => { if (u && out.indexOf(u) === -1 && out.length < EXPORT_URL_MAX) out.push(u); };
    push(gdocsExportUrl(id, scope, format));
    if (hint != null && /^\d{1,3}$/.test(String(hint))) push(withAuthuser(id, hint, format));
    for (let n = 0; n <= AUTHUSER_MAX; n++) push(withAuthuser(id, n, format));
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

  // ---- the .docx export (the doc's own comment threads) -------------------
  //
  // A txt export is prose only: every comment, reply and suggestion in the
  // document is dropped. The .docx of the same document is a zip that carries
  // them, so a mention on a Google Doc sends BOTH — the text for reading and
  // the zip for the companion to pull comments out of. Bytes, not text: the
  // body is binary and any string round-trip would corrupt it.
  //
  // 6MB of zip is already an enormous document; past that the attachment is
  // dropped silently rather than made into the reason a message would not send.
  const DOCX_MAX = 6 * 1024 * 1024;

  // A zip — and therefore plausibly a .docx — always opens "PK\x03\x04".
  // A chooser or a sign-in page opens '<', which is exactly what this rejects.
  function looksZip(bytes) {
    if (!bytes || bytes.length < 4) return false;
    return bytes[0] === 0x50 && bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
  }
  // …and the same test on an already-encoded body: 'UEsD' is the base64 of
  // "PK\x03", so the signature survives the encoding the background hands back.
  const B64_ZIP = /^UEsD/;
  // how many bytes a base64 string stands for, without decoding it
  function b64Size(s) {
    const t = String(s == null ? '' : s).replace(/[\r\n]/g, '');
    if (!t) return 0;
    let pad = 0;
    if (t.endsWith('==')) pad = 2; else if (t.endsWith('=')) pad = 1;
    return Math.max(0, Math.floor(t.length * 3 / 4) - pad);
  }

  // Chunked so a multi-megabyte document cannot blow the argument limit of
  // String.fromCharCode (the naive apply(...bytes) dies around 100k).
  const B64_CHUNK = 0x8000;
  function bytesToBase64(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    let s = '';
    for (let i = 0; i < b.length; i += B64_CHUNK) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + B64_CHUNK));
    }
    // btoa is present in browsers, in MV3 workers and in node ≥16
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(b).toString('base64');
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

  // an attempt that asked for BYTES rather than text — same shape, with `b64`
  // (and `size`) where `text` would be. The two lanes below produce it
  // differently: a page fetch has the ArrayBuffer, the background worker has
  // already encoded it (a service worker cannot hand a Uint8Array across
  // sendMessage without it arriving as a plain object).
  const noBytes = async () => ({ ok: false, error: 'no binary transport in this context', gone: true });

  // The transports this world actually has, in the order to try them.
  function transports(env) {
    if (env && typeof env.request === 'function') {
      return [{ name: 'given', run: env.request, bytes: env.requestBytes || noBytes }];
    }
    const out = [];
    const f = (env && env.fetch) || (typeof fetch === 'function' ? fetch : null);
    if (f) {
      out.push({ name: 'page', async bytes(url) {
        let res;
        try { res = await f(url, { credentials: PAGE_CREDENTIALS }); }
        catch (e) { return { ok: false, error: 'fetch threw: ' + peek((e && e.message) || e), gone: true }; }
        if (!res) return { ok: false, error: 'no response', gone: true };
        const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        if (!res.ok) return { ok: false, status: res.status, contentType, error: 'HTTP ' + (res.status == null ? '?' : res.status) };
        if (typeof res.arrayBuffer !== 'function') {
          return { ok: false, status: res.status, contentType, error: 'this response cannot give bytes', gone: true };
        }
        let buf;
        try { buf = await res.arrayBuffer(); }
        catch (e) { return { ok: false, status: res.status, contentType, error: 'the body did not read: ' + peek((e && e.message) || e) }; }
        const bytes = new Uint8Array(buf || 0);
        return { ok: true, status: res.status == null ? 200 : res.status, contentType, bytes, size: bytes.length };
      }, async run(url) {
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
      out.push({ name: 'background', async bytes(url) {
        let r = null;
        try { r = await sendMessage(send, { t: 'gdocs-export', url, want: 'bytes' }); }
        catch (e) { return { ok: false, error: 'the background did not answer: ' + peek((e && e.message) || e), gone: true }; }
        if (noSuchMessage(r)) return { ok: false, error: 'this build has no gdocs-export worker', gone: true };
        if (r.ok && r.b64) return { ok: true, status: r.status || 200, contentType: r.contentType || '', b64: String(r.b64), size: b64Size(r.b64) };
        if (r.ok) return { ok: false, status: r.status, contentType: r.contentType || '', error: 'the worker returned no bytes', gone: true };
        return { ok: false, status: r.status, contentType: r.contentType || '',
                 error: r.error || 'the background could not fetch it' };
      }, async run(url) {
        let r = null;
        try { r = await sendMessage(send, { t: 'gdocs-export', url }); }
        catch (e) { return { ok: false, error: 'the background did not answer: ' + peek((e && e.message) || e), gone: true }; }
        if (noSuchMessage(r)) return { ok: false, error: 'this build has no gdocs-export worker', gone: true };
        if (r.ok) return { ok: true, status: r.status || 200, contentType: r.contentType || '', text: String(r.text || '') };
        return { ok: false, status: r.status, contentType: r.contentType || '',
                 text: r.text || r.peek || '', error: r.error || 'the background could not fetch it' };
      } });
    }
    if (!out.length) {
      out.push({ name: 'none', run: async () => ({ ok: false, error: 'no transport in this context' }), bytes: noBytes });
    }
    for (const lane of out) if (!lane.bytes) lane.bytes = noBytes;
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
        // what sort of document a record made here IS — the companion stores it
        // and the pages list filters by it. The adapter is the only thing that
        // knows for certain, which is why it says so rather than being guessed
        // from the url afterwards.
        kind: 'gdocs',
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
        // The same ladder, asking for the .docx instead — the document's own
        // comment threads, which the txt export throws away. Every failure is
        // silent by design: this is an ATTACHMENT to a message the user has
        // already hit send on, and no comment in a doc is worth refusing to
        // deliver their question over. It says why on docxError, and that is
        // the whole of its complaint.
        //
        // Fresh on every mention: comments are the fastest-moving thing on a
        // doc, and a cached zip would answer yesterday's question.
        async docx() {
          ad.docxError = '';
          ad.docxUrl = '';
          ad.docxAttempts = [];

          let hint = null;
          try { hint = accountFromUrls(accountUrls()); } catch { hint = null; }
          const urls = gdocsExportUrls(id, scope, hint, 'docx');
          ad.docxUrls = urls;

          for (const lane of lanes) {
            for (const url of urls) {
              const r = await lane.bytes(url);
              const status = r && r.status != null ? r.status : '?';
              let why = '';
              if (!r || (!r.ok && !r.error)) why = 'no response';
              else if (!r.ok) why = r.error;
              else if (r.size > DOCX_MAX) {
                // a real document, simply too big to carry — trying another
                // account would only find the same file again
                why = 'the export is ' + Math.round(r.size / 1048576) + 'MB, over the ' +
                  Math.round(DOCX_MAX / 1048576) + 'MB cap';
                ad.docxAttempts.push({ url, status, why, via: lane.name });
                break;
              } else if (!r.size) why = 'HTTP ' + status + ' with an empty body';
              else if (r.b64 ? !B64_ZIP.test(r.b64) : !looksZip(r.bytes)) {
                // the account chooser / sign-in page again, served 200
                why = 'HTTP ' + status + ' but the body is not a .docx zip — signed out, ' +
                  'or this doc belongs to another signed-in account';
              } else {
                const b64 = r.b64 || bytesToBase64(r.bytes);
                ad.docxUrl = url;
                ad.docxVia = lane.name;
                ad.docxBytes = r.size;
                return b64;
              }
              ad.docxAttempts.push({ url, status, why, via: lane.name });
              if (!authShaped(r)) break;
            }
            if (ad.docxUrl) break;
          }
          ad.docxError = ad.docxAttempts.map(a => a.via + ' ' + shortUrl(a.url) + ' → ' + a.why).join(' · ') ||
            'no export url to try';
          return '';
        },
        async articleText() {
          ad.lastError = '';
          ad.usedUrl = '';
          ad.attempts = [];

          // the page's own links know which account it is signed in as, when
          // no url on screen has a /u/<n>/ in it
          let hint = null;
          try { hint = accountFromUrls(accountUrls()); } catch { hint = null; }
          ad.hintedAccount = hint;

          const urls = gdocsExportUrls(id, scope, hint, 'txt');
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

  // ---- web PDFs -----------------------------------------------------------
  //
  // A PDF opened from the web is not a page the extension can annotate: Chrome
  // hands it to its own built-in viewer, which is another extension's document,
  // and no content script of ours will ever run there. So the extension brings
  // its own viewer (pdf/viewer.html + Mozilla PDF.js, vendored) and the
  // navigation is redirected into it — see background.js for the interception
  // and SPEC.md for what it can and cannot catch.
  //
  // That makes this adapter's FIRST job an identity one. The address bar now
  // says chrome-extension://<id>/pdf/viewer.html…, and that address is not the
  // document: it changes with the extension id, it is not what anyone would
  // share, and two machines reading the same PDF would file it twice. The
  // identity is, and stays, the ORIGINAL http(s) url — everything downstream
  // (hello, /page, /thread, /snapshot, the worker's routing table) is given it
  // by `identityHref`, exactly as gdocs owns its own identity rules.
  //
  // Its second job is text. PDF.js paints the page to a canvas and lays a
  // TEXT LAYER of absolutely-positioned spans over it — real text nodes, which
  // is what makes selection, <mark> painting and quote anchoring work
  // unchanged. This adapter reads that layer back out of the DOM (never
  // getTextContent() a second time) so that the article text, the phone
  // snapshot and the anchors are all derived from ONE string. A quote captured
  // here therefore re-locates in the snapshot on a phone, which is the only
  // reason /a/<pageKey> is worth serving for a PDF at all.
  const PDF_VIEWER_PATH = 'pdf/viewer.html';
  const PDF_PAGE_ATTR = 'data-bfp-pdf-page';
  // the marker text the viewer prints above each page, repeated verbatim in the
  // snapshot so both sides read the same string
  const pdfPageLabel = n => 'Page ' + n;

  const httpOnly = u => {
    const s = String(u == null ? '' : u).trim();
    return /^https?:\/\/[^\s]/i.test(s) ? s : null;
  };
  // A local PDF is a source too. `file:` is a document the viewer can render
  // exactly as it renders a web one — what differs is the IDENTITY, and that is
  // the next block's job, not this one's.
  const isFileUrl = u => /^file:\/\/\S/i.test(String(u == null ? '' : u).trim());
  const pdfSrcOk = u => {
    const s = String(u == null ? '' : u).trim();
    return (httpOnly(s) || (isFileUrl(s) ? s : null));
  };

  // ---- the identity of a LOCAL pdf ----------------------------------------
  //
  // A web PDF's identity is its url, and that is the whole of it. A file on
  // this disk has no such thing: `file:///Users/me/Downloads/paper.pdf` is a
  // location, not a name — move it to a shelf, rename it after reading it, sync
  // it to another Mac under a different home directory, and every comment made
  // on it is filed against an address that no longer exists.
  //
  // So a local PDF is identified by WHAT IT IS rather than where it is: the
  // SHA-256 of its bytes, written as a url-shaped pseudo-scheme
  //
  //     bfp-pdf://sha256/<64 lowercase hex>
  //
  // …which every layer already handles, because it is a url. normUrl leaves it
  // byte-identical (no query, no hash, no trailing slash), pageKey is the sha1
  // of that, and store/server/export treat identity as a string and always did.
  // `bfp:` set the precedent (store.LIBRARY_URL); this is the same trick with a
  // scheme of its own so the two can never be confused.
  //
  // What it buys, and what it costs, both stated plainly:
  //   · the same bytes anywhere on any disk are the same page — move it, rename
  //     it, keep two copies;
  //   · EDIT the file (annotate it in Preview, re-download a v2) and the bytes
  //     change, so it is a new page. The old one keeps its comments under the
  //     old hash;
  //   · the same paper read from the web and from disk are two pages, because
  //     one is identified by a url and the other by its bytes.
  // The FILE ITSELF is never read by the companion, never uploaded and never
  // stored: the snapshot a phone reads is the text extract, exactly as it is
  // for a web PDF.
  const PDF_HASH_SCHEME = 'bfp-pdf://sha256/';
  const PDF_HASH_RE = /^bfp-pdf:\/\/sha256\/[0-9a-f]{64}$/;
  const isPdfHashUrl = u => PDF_HASH_RE.test(String(u == null ? '' : u).trim());

  // ---- …and the DURABLE identity: the document's words ---------------------
  //
  // The byte hash met Adobe Acrobat and lost: Acrobat rewrites the file on
  // every save, so one sticky-note annotation re-keyed the page and orphaned
  // its chat. What the reader means by "this paper" is its TEXT — annotations,
  // form fills and metadata edits leave the page text alone — so the durable
  // identity is the SHA-256 of the extracted text, normalized:
  //
  //     bfp-pdf://text/<64 lowercase hex>
  //
  // A scan has no text to hash and keeps the byte-hash identity above. A
  // document whose text actually changed is a NEW page with a fresh chat —
  // deliberately, and with no fuzzy matching. Both spellings are legal
  // local-PDF identities everywhere (isPdfIdentUrl).
  const PDF_TEXT_SCHEME = 'bfp-pdf://text/';
  const PDF_TEXT_RE = /^bfp-pdf:\/\/text\/[0-9a-f]{64}$/;
  const isPdfTextUrl = u => PDF_TEXT_RE.test(String(u == null ? '' : u).trim());
  const isPdfIdentUrl = u => isPdfHashUrl(u) || isPdfTextUrl(u);
  const pdfTextUrl = hex => {
    const h = String(hex == null ? '' : hex).trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(h) ? PDF_TEXT_SCHEME + h : '';
  };

  // The one string the durable identity is a digest of. Built from the SAME
  // lines the snapshot and the anchors are built from (pdfLayerLines: folded,
  // trimmed, empties dropped), which is what lets the companion recompute this
  // hash from a stored snapshot and adopt an old byte-hash record. Page
  // boundaries are deliberately not part of it — the words are the identity,
  // not the pagination — and the final collapse makes the join order the only
  // thing that could vary, which the DOM walk fixes.
  function pdfNormalizedText(pages) {
    const parts = [];
    for (const p of pages || []) {
      for (const l of (p && p.lines) || []) parts.push(l);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  // the site a local PDF files under: 'sha256' is what siteOf() would say about
  // the pseudo-url's hostname, and that is a number, not a place
  const LOCAL_PDF_SITE = 'local pdf';

  // Bytes → lowercase hex. crypto.subtle.digest hands back an ArrayBuffer and
  // there is no hex in the platform, so it is written here — pure, and tested
  // against known vectors, because a hex formatter that drops a leading zero
  // produces a DIFFERENT identity for one file in sixteen.
  function bytesToHex(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    let out = '';
    for (let i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }
  const pdfHashUrl = hex => {
    const h = String(hex == null ? '' : hex).trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(h) ? PDF_HASH_SCHEME + h : '';
  };

  // WHICH PAGE this viewer is showing, given the source it was opened on and
  // whatever identity the viewer published (`window.__BFP_PDF_IDENT`, computed
  // from the bytes before any of the annotator was loaded — see pdf/viewer.js).
  //
  //   http(s) source            → the url, unchanged, exactly as it always was
  //   file: source + a hash     → the pseudo-url (bfp-pdf://text/… for a
  //                               document with words, bfp-pdf://sha256/… for
  //                               a scan — the viewer decided which)
  //   file: source, no hash     → '' — the bytes could not be read, so there is
  //                               NO identity, and the honest thing is to file
  //                               nothing rather than file it under a path or
  //                               under the extension's own address.
  function pdfIdentity(src, published) {
    const web = httpOnly(src);
    if (web) return web;                       // a url identifies itself
    if (isFileUrl(src) && isPdfIdentUrl(published)) return String(published).trim();
    return '';
  }

  // The name of the file on disk, for a local PDF — the one thing about its
  // location worth keeping, because "which of my PDFs is this" is a question
  // the hash cannot answer. Extension included: it is a file name, not a title.
  function pdfFileName(url) {
    if (!isFileUrl(url)) return '';
    let u;
    try { u = new URL(String(url)); } catch { return ''; }
    let last = (u.pathname || '').split('/').filter(Boolean).pop() || '';
    try { last = decodeURIComponent(last); } catch { /* keep it as it came */ }
    return last.replace(/\s+/g, ' ').trim();
  }

  // A url that a plain .pdf link is behind. Extension-only knowledge: the
  // interception rule keys off exactly this shape, and the toolbar fallback
  // uses it to decide whether to say "this does not look like a PDF".
  const PDF_URL = /^https?:\/\/[^?#]*\.pdf(?:[?#]|$)/i;
  const looksPdfUrl = u => PDF_URL.test(String(u == null ? '' : u).trim());

  // The viewer's own address for a given PDF. Encoded, because this is the one
  // we build ourselves and can afford to.
  function pdfViewerUrl(base, src) {
    return String(base == null ? '' : base) + '?src=' + encodeURIComponent(String(src == null ? '' : src));
  }

  // …and the inverse: which PDF a viewer address is showing, or null for "this
  // is not our viewer".
  //
  // TWO spellings, and the reason is the redirect. declarativeNetRequest
  // substitutes the matched url into the target VERBATIM — it cannot
  // percent-encode — so a PDF url with a `&` in its query would be truncated by
  // any `?src=` parse. The rule therefore writes `#raw=<url>` where nothing
  // follows and no decoding is owed. `?src=` stays for the paths that build the
  // url in JavaScript (the toolbar fallback, the tests), where encoding is free.
  function pdfViewerSrc(href) {
    let u;
    try { u = new URL(String(href == null ? '' : href)); } catch { return null; }
    if (!new RegExp('(?:^|/)' + PDF_VIEWER_PATH.replace('.', '\\.') + '$').test(u.pathname)) return null;
    const hash = u.hash ? u.hash.slice(1) : '';
    if (hash.indexOf('raw=') === 0) return pdfSrcOk(hash.slice(4));
    const q = u.search ? u.search.slice(1) : '';
    const at = q.indexOf('src=');
    if (at === -1) return null;
    // everything after the FIRST src= is the url, ampersands and all
    const raw = q.slice(at + 4);
    let dec = raw;
    try { dec = decodeURIComponent(raw); } catch { dec = raw; }
    return pdfSrcOk(dec);
  }

  // The name of the file, for a PDF that carries no /Title of its own —
  // 'https://arxiv.org/pdf/2401.01234v2.pdf' → '2401.01234v2'. Never a guess
  // dressed up as a title: the viewer prefers the document's own metadata and
  // only falls back to this.
  function pdfNameFromUrl(url) {
    let u;
    try { u = new URL(String(url == null ? '' : url)); } catch { return ''; }
    let last = (u.pathname || '').split('/').filter(Boolean).pop() || '';
    try { last = decodeURIComponent(last); } catch { /* keep it as it came */ }
    return last.replace(/\.pdf$/i, '').replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ---- reading the text layer back out ------------------------------------
  // PDF.js emits one <span> per text run and a <br> at every end of line.
  // anchor.js reads the same DOM and folds a <br> to '\n', so lines are the
  // unit both sides agree on: split here, and the snapshot can put the same
  // lines back with <br> and produce a byte-identical normalized string.
  function pdfLayerLines(el) {
    let raw = '';
    (function walk(node) {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { raw += n.data; continue; }
        if (n.nodeType !== 1) continue;
        if (n.nodeName.toUpperCase() === 'BR') { raw += '\n'; continue; }
        walk(n);
      }
    })(el);
    return raw.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  // [{page, lines}] for every page whose text layer exists, in document order.
  // A page still rendering simply is not here yet — the viewer re-asks as each
  // one lands.
  function pdfPagesFromDom(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.querySelectorAll) return [];
    const out = [];
    const nodes = d.querySelectorAll('[' + PDF_PAGE_ATTR + ']');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const n = parseInt(el.getAttribute(PDF_PAGE_ATTR), 10);
      if (!(n > 0)) continue;
      const layer = el.querySelector('.textLayer');
      out.push({ page: n, lines: layer ? pdfLayerLines(layer) : [] });
    }
    return out;
  }

  // What the bots read. Page markers are not decoration: a reply that says
  // "page 4 contradicts page 2" is only possible if the numbers travelled.
  function pdfContextText(pages, limit) {
    const cap = limit || TEXT_LIMIT;
    const parts = [];
    let size = 0;
    for (const p of pages || []) {
      if (!p || !p.lines || !p.lines.length) continue;
      const block = '[' + pdfPageLabel(p.page).toLowerCase() + ']\n' + p.lines.join('\n');
      size += block.length + 2;
      parts.push(block);
      if (size > cap) break;
    }
    return parts.join('\n\n').slice(0, cap).trimEnd();
  }

  // What a phone reads at /a/<pageKey>. Text only — a snapshot of a PDF is its
  // words, not its typesetting — but the words in the order and the line breaks
  // the viewer showed, under the same page markers, so an anchor made on the
  // Mac is findable on the phone and vice versa. The sanitizer on the way in
  // keeps section/h2/p/br and drops everything else, which is exactly this.
  const escPdf = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function pdfSnapshotHtml(pages) {
    const parts = [];
    for (const p of pages || []) {
      if (!p || !p.lines || !p.lines.length) continue;
      parts.push('<section><h2>' + escPdf(pdfPageLabel(p.page)) + '</h2><p>' +
        p.lines.map(escPdf).join('<br>') + '</p></section>');
    }
    return parts.join('\n');
  }

  // Which page a DOM node sits on (1-based), or 0 for "not on a page".
  function pdfPageOfNode(node) {
    for (let n = node; n; n = n.parentNode || n.host) {
      if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute(PDF_PAGE_ATTR)) {
        const v = parseInt(n.getAttribute(PDF_PAGE_ATTR), 10);
        return v > 0 ? v : 0;
      }
    }
    return 0;
  }

  const PDF = {
    name: 'pdf',
    match(url) {
      const src = pdfViewerSrc(url);
      return src ? { src } : null;
    },
    create(hit, env) {
      const src = (hit && hit.src) || String(hit || '');
      const docTitle = (env && env.documentTitle) ||
        (() => (typeof document !== 'undefined' ? document.title : ''));
      const dom = (env && env.doc) || null;
      const pages = () => pdfPagesFromDom(dom);
      // The identity was decided BEFORE any of this was loaded: pdf/viewer.js
      // hashes a local file's bytes and publishes the answer, then injects the
      // annotator. This adapter only ever READS that decision — one place makes
      // it, one place reports it (see pdfIdentity).
      const published = (env && env.identity) ||
        (typeof window !== 'undefined' ? window.__BFP_PDF_IDENT : '') || '';
      const ident = pdfIdentity(src, published);
      const local = isPdfIdentUrl(ident);
      const fileName = pdfFileName(src);

      const ad = {
        name: 'pdf',
        // …and this one is a PDF wherever it came from: the viewer's own url
        // says nothing about it (see `identityHref` below), so the adapter is
        // the only honest source for the record's kind
        kind: 'pdf',
        // the whole point: the record is the DOCUMENT's, not the viewer's —
        // the original url for a web PDF, the hash of the bytes for a local one
        identityHref: ident,
        // …and the site is the identity's, which for a hash is not a place at
        // all: siteOf() would read the pseudo-url's hostname and file the page
        // under "sha256". '' means "use the hostname", exactly as before.
        site: local ? LOCAL_PDF_SITE : '',
        // the one thing about a local file's LOCATION worth keeping: what it is
        // called. It rides POST /page and comes out in the Obsidian note, so a
        // reader can find the file again; the path never leaves this machine.
        fileName: local ? fileName : '',
        local,
        src,
        // the text layer is real text nodes, so everything the extension does
        // to an article works here unchanged
        // …and an orphan here is a local verdict, never a report. A PDF's
        // pages arrive one at a time (and a scan's never do), so "I cannot
        // find it" means "not yet" far more often than it means "gone".
        // …and this is the one document kind with a SECOND tool. A PDF is what
        // gets marked up — Acrobat's highlight and Acrobat's strikeout — and
        // the file can carry both back out as real annotations. An article has
        // nowhere to put a strikeout and nobody expecting one, so its pill
        // keeps the single comment button it has always had.
        capabilities: { highlights: true, strike: true, textFallback: false, reportOrphans: false },
        lastError: '',
        // what the reader is told when there is no text to send — the same
        // sentence the viewer prints over the page itself
        contextNote: 'this PDF has no selectable text (it looks like a scan), so the bots cannot read it',
        // The DOCUMENT's own name — its /Title, else the file name — which the
        // viewer publishes on `window.__BFP_PDF_TITLE`. Deliberately not
        // document.title: once a page can be RENAMED, the tab shows the
        // reader's name for it, and this must keep reporting the scraped one or
        // a rename would be written back as the page's own name and could never
        // be cleared. (document.title is still the fallback, which is what the
        // harness and any future viewer-less caller use.)
        title: () => String(
          (typeof window !== 'undefined' && window.__BFP_PDF_TITLE) || docTitle() || ''
        ).trim() || pdfNameFromUrl(src),
        pageOf(node) { try { return pdfPageOfNode(node); } catch { return 0; } },
        snapshotHtml() { return pdfSnapshotHtml(pages()); },
        async articleText() {
          ad.lastError = '';
          const text = pdfContextText(pages(), TEXT_LIMIT);
          if (text) return text;
          ad.lastError = 'this PDF has no selectable text — it is a scan, and there is no OCR here';
          return '';
        },
      };
      return ad;
    },
  };

  // ---- page identity ------------------------------------------------------
  // WHICH page a document is, when the address bar and the document disagree.
  //
  // A site that rewrites its path with history.pushState as you move through a
  // long article (a section per URL) hands the extension a different address
  // every time you land, and every one of those becomes a page of its own with
  // its own annotations. `<link rel="canonical">` is the document's own answer
  // to "what am I", so prefer it — but only where believing it can merge a
  // splinter back into its parent, and never where it could merge two genuinely
  // different articles.
  //
  // Hence the guards, all of them refusals:
  //   • same origin, http(s) only          — a canonical is not a redirect
  //   • never the bare site root           — "/" is a claim about the site
  //   • the location path must be the canonical path with extra characters
  //     glued onto its LAST segment (/post-slug ← /post-slug-section-3), or
  //     exactly equal to it. A canonical that drops whole path segments
  //     (/2026 ← /2026/01/some-article) is a hub page, and believing it would
  //     collapse a month of reading into one record.
  //
  // Returns the href to treat as this page's identity, or null for "no opinion
  // — use the address bar". normUrl is applied by the caller afterwards, so
  // this function never has to agree with anybody's copy of it.
  const CANON_MIN_PREFIX = 8;             // '/post-sl' — shorter is not a slug
  const trimPath = p => String(p || '').replace(/\/+$/, '');
  function canonicalPageUrl(locationHref, canonicalHref) {
    if (!canonicalHref) return null;
    let loc, can;
    try { loc = new URL(String(locationHref)); } catch { return null; }
    // relative canonicals are legal and common ("/post-slug/")
    try { can = new URL(String(canonicalHref), loc.href); } catch { return null; }
    if (!/^https?:$/.test(loc.protocol) || !/^https?:$/.test(can.protocol)) return null;
    if (can.origin !== loc.origin) return null;
    const cPath = trimPath(can.pathname);
    const lPath = trimPath(loc.pathname);
    if (!cPath) return null;                       // the site root claims everything
    if (cPath === lPath) return can.href;          // the same page, said tidily
    if (cPath.length < CANON_MIN_PREFIX) return null;
    if (!lPath.startsWith(cPath)) return null;
    // what the address bar added must live inside the canonical's last segment
    if (lPath.slice(cPath.length).includes('/')) return null;
    return can.href;
  }

  // ---- registry -----------------------------------------------------------

  const REGISTRY = [GDOCS, PDF];

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
    canonicalPageUrl,
    gdocsId, gdocsScope, gdocsExportUrl, gdocsExportUrls, accountFromUrls,
    stripDocsSuffix, cleanExport, looksHtml, looksZip, bytesToBase64, b64Size,
    TEXT_LIMIT, AUTHUSER_MAX, EXPORT_URL_MAX, PAGE_CREDENTIALS, DOCX_MAX,
    // web PDFs (pure; the DOM readers take a document, so jsdom-free tests
    // hand them a stub)
    looksPdfUrl, pdfViewerUrl, pdfViewerSrc, pdfNameFromUrl, pdfLayerLines,
    pdfPagesFromDom, pdfContextText, pdfSnapshotHtml, pdfPageOfNode,
    pdfPageLabel, PDF_VIEWER_PATH, PDF_PAGE_ATTR,
    // local PDFs: the durable identity is the words; the byte hash is the
    // scan fallback and the fast-path cache key
    isFileUrl, isPdfHashUrl, isPdfTextUrl, isPdfIdentUrl, bytesToHex,
    pdfHashUrl, pdfTextUrl, pdfNormalizedText, pdfIdentity, pdfFileName,
    PDF_HASH_SCHEME, PDF_TEXT_SCHEME, LOCAL_PDF_SITE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPAdapters = api;
})(typeof window !== 'undefined' ? window : globalThis);
