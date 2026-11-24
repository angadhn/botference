// hubbind.js — which post a selection on the companion's own Hub page belongs to.
//
// The Hub's Feed shows each followed post's text in place, and marks each text with where it really lives:
//   data-blyg-page     the post's canonical page address (its page record's key)
//   data-blyg-origin   the blyg's identity origin
//   data-blyg-id       the post's 26-character id
//   data-blyg-version  the version held
// A selection inside one of those belongs to THAT post's page record, not to the Hub's address, and its identity is the item
// document's (the companion made the markup from it).
//
// WHERE THIS IS HONOURED, and nowhere else. A web page could write the same attributes and claim to be somebody else's post, so a
// binding is read ONLY on the companion's own Hub pages: the page's origin must be the origin of a companion address the extension
// is configured with, and its path /hub or /following; or the page is one of the owner's HOSTED Hub pages listed in the extension's
// options (config.js hosted_hubs: https, the exact origin and path, nothing else on that origin). On any other page, bindingOf
// answers null and the extension behaves exactly as it always did. No network, no DOM beyond reading attributes: it runs in node (test/hubbind.test.mjs).
(function (root) {
  'use strict';

  const ID_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
  const HUB_PATH = /^\/(?:hub|following)\/?$/;
  const BINDING_VERDICTS = Object.freeze(['none', 'one', 'cross']);

  // the page is one of the companion's Hub pages (same origin as a configured companion address, and a Hub path), or exactly one of
  // the owner's listed hosted Hub pages (https, the same origin and the same path; a trailing slash is not part of the path)
  function isHubPage(pageUrl, companionBases, hostedHubs) {
    let u;
    try { u = new URL(String(pageUrl)); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const listed = (hostedHubs || []).some(h => {
      let x;
      try { x = new URL(String(h)); } catch { return false; }
      return x.protocol === 'https:' && u.protocol === 'https:' && x.origin === u.origin
        && x.pathname.replace(/\/+$/, '') === u.pathname.replace(/\/+$/, '') && x.pathname.replace(/\/+$/, '') !== '';
    });
    if (listed) return true;
    if (!HUB_PATH.test(u.pathname)) return false;
    return (companionBases || []).some(b => { try { return new URL(String(b)).origin === u.origin; } catch { return false; } });
  }

  const webUrl = v => { try { const u = new URL(String(v || '')); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : (node.parentElement || null);
  }
  // the nearest bound element above `node`, with its attributes checked; null when there is none or they are not valid
  function bound(node) {
    const el = elementOf(node);
    const holder = el && el.closest ? el.closest('[data-blyg-page]') : null;
    if (!holder) return null;
    const page = webUrl(holder.getAttribute('data-blyg-page'));
    const origin = webUrl(holder.getAttribute('data-blyg-origin'));
    const id = String(holder.getAttribute('data-blyg-id') || '');
    const version = Number(holder.getAttribute('data-blyg-version'));
    if (!page || !origin || !origin.endsWith('/') || !ID_RE.test(id) || !Number.isInteger(version) || version < 1) return null;
    return { page, origin, id, version, element: holder };
  }

  /** The binding at `node` on this page, or null (any page that is not a companion Hub page, or a node outside any post's text). */
  function bindingOf(node, pageUrl, companionBases, hostedHubs) {
    if (!isHubPage(pageUrl, companionBases, hostedHubs)) return null;
    const b = bound(node);
    return b ? { page: b.page, origin: b.origin, id: b.id, version: b.version } : null;
  }

  /**
   * What a selection (a Range) is, on this page:
   *   none — not inside any post's text, or not a Hub page: the extension treats it as it always has
   *   one  — inside one post's text: { binding }
   *   cross — it begins in one post and ends in another (or in none): refused
   */
  function selectionBinding(range, pageUrl, companionBases, hostedHubs) {
    if (!range || !isHubPage(pageUrl, companionBases, hostedHubs)) return { verdict: 'none', binding: null };
    const a = bound(range.startContainer), b = bound(range.endContainer);
    if (!a && !b) return { verdict: 'none', binding: null };
    if (!a || !b || a.element !== b.element) return { verdict: 'cross', binding: null };
    return { verdict: 'one', binding: { page: a.page, origin: a.origin, id: a.id, version: a.version } };
  }

  const api = { BINDING_VERDICTS, isHubPage, bindingOf, selectionBinding };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPHubBind = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
