// feedbind.js — which post a selection on a blyg's HOME FEED (a page listing many posts) sits in, as the page's markup CLAIMS it.
//
// A highlight made on a blyg's home page belongs to the post it sits in, as if it were made on the post's own page: a quote by
// reference and a response to that post. The markup only CLAIMS which post; any page can write the same markup, so nothing here is
// believed by itself: the companion verifies a claim (POST /blyg/bind: the blyg's own item document for that id, read from the same
// web origin as the page, must hold the selected passage as its text) and only a verified binding is used. Otherwise the extension
// does exactly what it always did.
//
// WHAT IS READ. The protocol names no marker for "an item shown on an HTML page" (§5.8 gives a post's own page a JSON alternate link;
// a front page has only its <link rel="blyg">), so the generic rule is:
//   the post  — the nearest enclosing <article> (or [data-blyg-id] item wrapper) that links, on the page's own web origin, to a path
//               whose last segment is a 26-character post id; links marked as the post's own (a.permalink, rel~=bookmark, .u-url,
//               .read-more a) first, then the others in page order; at most MAX_CANDIDATES ids, each verified in turn
//   a quote   — a selection inside a <blockquote class="blyg-transclusion" data-blyg-id …> (the spec's own wire token, §10.3) is first
//               claimed for the QUOTED post (at data-blyg-origin, or the page's own blyg when it has none), then for the post around it
// On a post's own page (its address names the id) nothing is claimed: the page is the post already.
//
// THE VERDICT, named once (the same words as hubbind.js): none (not inside a post, or not a feed) | one (inside one post: its
// candidates) | cross (it begins in one post and ends in another, or in none). No network, no DOM beyond reading; runs in node.
(function (root) {
  'use strict';

  const ID_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
  const FEED_VERDICTS = Object.freeze(['none', 'one', 'cross']);
  const MAX_CANDIDATES = 3;
  const OWN_LINKS = 'a.permalink[href], a[rel~="bookmark"][href], a.u-url[href], .read-more a[href]';

  const elementOf = node => (!node ? null : node.nodeType === 1 ? node : (node.parentElement || null));
  // the id a link names, when it is on the page's own web origin and its path's last segment is an id
  function idOf(href, pageUrl) {
    let u, p;
    try { u = new URL(String(href), pageUrl); p = new URL(String(pageUrl)); } catch { return ''; }
    if (u.origin !== p.origin || !/^https?:$/.test(u.protocol)) return '';
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return ID_RE.test(last) ? last : '';
  }
  const pageIds = pageUrl => { try { return new URL(String(pageUrl)).pathname.split('/').filter(s => ID_RE.test(s)); } catch { return []; } };
  const webOrigin = v => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) && u.href.endsWith('/') && u.href === String(v) ? u.href : ''; } catch { return ''; } };

  // the post an element sits in: { element, ids } or null
  function postAt(el, pageUrl) {
    for (let a = el && el.closest ? el.closest('article, [data-blyg-item]') : null; a; a = a.parentElement && a.parentElement.closest ? a.parentElement.closest('article, [data-blyg-item]') : null) {
      const ids = [];
      const add = link => {
        if (link.closest('blockquote.blyg-transclusion') && link.closest('blockquote.blyg-transclusion') !== a.closest('blockquote.blyg-transclusion')) return;
        const id = idOf(link.getAttribute('href'), pageUrl);
        if (id && ids.indexOf(id) === -1) ids.push(id);
      };
      a.querySelectorAll(OWN_LINKS).forEach(add);
      a.querySelectorAll('a[href]').forEach(add);
      if (ids.length) return { element: a, ids: ids.slice(0, MAX_CANDIDATES) };
    }
    return null;
  }
  // the quoted post an element sits in (a baked transclusion), or null
  function quotedAt(el) {
    const q = el && el.closest ? el.closest('blockquote.blyg-transclusion[data-blyg-id]') : null;
    if (!q) return null;
    const id = String(q.getAttribute('data-blyg-id') || '');
    if (!ID_RE.test(id)) return null;
    const raw = q.getAttribute('data-blyg-origin');
    const origin = raw === null ? '' : webOrigin(raw);
    if (raw !== null && !origin) return null;
    return { element: q, id, origin };
  }

  /**
   * What a selection (a Range) claims on this page: { verdict, candidates } with candidates in the order to try, each
   * { id, origin } (origin '' = the page's own blyg). none and cross carry no candidates.
   */
  function selectionPost(range, pageUrl) {
    if (!range) return { verdict: 'none', candidates: [] };
    const s = elementOf(range.startContainer), e = elementOf(range.endContainer);
    const a = postAt(s, pageUrl), b = postAt(e, pageUrl);
    if (!a && !b) return { verdict: 'none', candidates: [] };
    if (!a || !b || a.element !== b.element) return { verdict: 'cross', candidates: [] };
    // on a post's own page the page is the post: nothing is claimed
    const own = pageIds(pageUrl);
    if (a.ids.some(id => own.indexOf(id) !== -1)) return { verdict: 'none', candidates: [] };
    const out = [];
    const qa = quotedAt(s), qb = quotedAt(e);
    if (qa && qb && qa.element === qb.element) out.push({ id: qa.id, origin: qa.origin });
    for (const id of a.ids) if (!out.some(c => c.id === id && !c.origin)) out.push({ id, origin: '' });
    return { verdict: 'one', candidates: out.slice(0, MAX_CANDIDATES + 1) };
  }

  const api = { FEED_VERDICTS, MAX_CANDIDATES, idOf, selectionPost };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPFeedBind = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
