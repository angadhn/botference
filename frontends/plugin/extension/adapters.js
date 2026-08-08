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
// gdocsId · gdocsScope · gdocsExportUrl · stripDocsSuffix · cleanExport ·
// looksHtml (see test/adapters.test.mjs). Everything that touches the world
// arrives through `env` ({fetch, documentTitle}), which defaults to the real
// globals.
//
// An adapter that fails says why on `lastError` (status code / a peek at the
// body). content.js logs it and — on a site whose text is not in the DOM at
// all — warns the user, because scraping the app's chrome instead would send
// menu bars to the bots as "the document".
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

  // The plain-text export of a doc, ON THE SAME ACCOUNT AS THE PAGE. Same-origin
  // on docs.google.com, so a content script can fetch it with the user's own
  // session — which is the whole point: the bots never can.
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
      const f = (env && env.fetch) || (typeof fetch === 'function' ? fetch : null);
      const docTitle = (env && env.documentTitle) ||
        (() => (typeof document !== 'undefined' ? document.title : ''));
      const ad = {
        name: 'gdocs',
        id,
        scope,
        exportUrl: gdocsExportUrl(id, scope),
        // why the last articleText() came back empty — read by content.js for
        // the console line and the user-facing warning
        lastError: '',
        // Nothing on the page is a text node, so nothing can be wrapped.
        capabilities: { highlights: false },
        title: () => stripDocsSuffix(docTitle()),
        // DIRECT fetch, not the background {t:'api'} proxy: the proxy exists
        // because the companion serves no CORS headers, and it only ever talks
        // to 127.0.0.1:4189. This request is same-origin on docs.google.com
        // and rides the user's session cookie — it must come from here.
        //
        // Every failure still resolves to '' — but it also SAYS SO on
        // lastError, and content.js no longer papers over it with a scrape of
        // the Docs UI. On this site '' means "no context", not "use the DOM".
        async articleText() {
          ad.lastError = '';
          if (!f) { ad.lastError = 'no fetch in this context'; return ''; }
          let res;
          try {
            res = await f(ad.exportUrl, { credentials: 'include' });
          } catch (e) {
            ad.lastError = 'fetch threw: ' + peek((e && e.message) || e);
            return '';
          }
          if (!res) { ad.lastError = 'no response'; return ''; }
          const status = res.status == null ? '?' : res.status;
          if (!res.ok) { ad.lastError = 'HTTP ' + status; return ''; }
          const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
          let body = '';
          try { body = await res.text(); } catch (e) { ad.lastError = 'HTTP ' + status + ' but the body did not read: ' + peek((e && e.message) || e); return ''; }
          if (/text\/html/i.test(ct) || looksHtml(body)) {
            // the account chooser / sign-in page, served 200
            ad.lastError = 'HTTP ' + status + ' but the body is HTML — signed out, or this doc belongs to ' +
              'another signed-in account: ' + peek(body);
            return '';
          }
          const text = cleanExport(body, TEXT_LIMIT);
          if (!text) { ad.lastError = 'HTTP ' + status + ' with an empty body'; return ''; }
          return text;
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
    gdocsId, gdocsScope, gdocsExportUrl, stripDocsSuffix, cleanExport, looksHtml, TEXT_LIMIT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPAdapters = api;
})(typeof window !== 'undefined' ? window : globalThis);
