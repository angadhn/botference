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
//     articleText(),                // Promise<string>; '' ⇒ generic extraction
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
    stripDocsSuffix, cleanExport, looksHtml, looksZip, bytesToBase64, b64Size,
    TEXT_LIMIT, AUTHUSER_MAX, EXPORT_URL_MAX, PAGE_CREDENTIALS, DOCX_MAX,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPAdapters = api;
})(typeof window !== 'undefined' ? window : globalThis);
