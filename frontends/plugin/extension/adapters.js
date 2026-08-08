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
// gdocsId · gdocsExportUrl · stripDocsSuffix · cleanExport (see
// test/adapters.test.mjs). Everything that touches the world arrives through
// `env` ({fetch, documentTitle}), which defaults to the real globals.
//
// UMD-lite, exactly like anchor.js: `module.exports` under CommonJS (node
// tests), `window.BFPAdapters` in the page. Loaded before content.js in the
// manifest and in test/harness.html.
(function (root) {
  'use strict';

  // ---- pure core ---------------------------------------------------------

  // https://docs.google.com/document/d/<id>/edit?tab=t.0#heading=h.x
  // …and the account-scoped form docs.google.com/document/u/0/d/<id>/edit,
  // which is what a second signed-in profile actually produces.
  const GDOCS_URL = /^https?:\/\/docs\.google\.com\/(?:u\/\d+\/)?document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{8,})(?:[/?#]|$)/;

  // The document id, or null when this is not a Google Doc (a Sheet, a Drive
  // folder, any other site).
  function gdocsId(url) {
    const m = GDOCS_URL.exec(String(url == null ? '' : url).trim());
    return m ? m[1] : null;
  }

  // The plain-text export of a doc. Same-origin on docs.google.com, so a
  // content script can fetch it with the user's own session — which is the
  // whole point: the bots never can.
  function gdocsExportUrl(id) {
    return 'https://docs.google.com/document/d/' + encodeURIComponent(String(id)) + '/export?format=txt';
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

  // A signed-out or permission-denied export can come back 200 with a login
  // page in it. Anything that opens as markup is not a document.
  const LOOKS_HTML = /^\s*(<!doctype html|<html\b|<\?xml)/i;

  // ---- google docs --------------------------------------------------------

  const GDOCS = {
    name: 'gdocs',
    match: url => gdocsId(url),
    create(id, env) {
      const f = (env && env.fetch) || (typeof fetch === 'function' ? fetch : null);
      const docTitle = (env && env.documentTitle) ||
        (() => (typeof document !== 'undefined' ? document.title : ''));
      return {
        name: 'gdocs',
        id,
        // Nothing on the page is a text node, so nothing can be wrapped.
        capabilities: { highlights: false },
        title: () => stripDocsSuffix(docTitle()),
        // DIRECT fetch, not the background {t:'api'} proxy: the proxy exists
        // because the companion serves no CORS headers, and it only ever talks
        // to 127.0.0.1:4189. This request is same-origin on docs.google.com
        // and rides the user's session cookie — it must come from here.
        // Any failure resolves to '' and content.js falls back to the generic
        // extraction; a doc is never worth breaking a turn over.
        async articleText() {
          if (!f) return '';
          try {
            const res = await f(gdocsExportUrl(id), { credentials: 'include' });
            if (!res || !res.ok) return '';
            const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
            if (/text\/html/i.test(ct)) return '';
            const body = await res.text();
            if (LOOKS_HTML.test(body)) return '';
            return cleanExport(body, TEXT_LIMIT);
          } catch {
            return '';
          }
        },
      };
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
    gdocsId, gdocsExportUrl, stripDocsSuffix, cleanExport, TEXT_LIMIT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPAdapters = api;
})(typeof window !== 'undefined' ? window : globalThis);
