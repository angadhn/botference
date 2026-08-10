// pdfrules.js — the decisions behind the web-PDF redirect, with no browser in
// them.
//
// background.js owns the declarativeNetRequest calls; this file owns the
// thinking, so that the two questions that actually caused bugs can be asked in
// node:
//
//   pdfRulePlan()    does the redirect rule need writing at all? A worker wakes
//                    for every hello and every event, and rewriting a rule on
//                    each wake is churn — and the write is the only moment the
//                    rule could be missing. So: read the store, and when it
//                    already says the right thing, do nothing.
//   bypassExpired()  has the one-shot "open it in the browser instead" allow
//                    rule outlived its minute? This is the one that shipped
//                    broken: the deadline lived in a setTimeout inside an MV3
//                    worker, the worker was retired inside the minute (it has a
//                    30-second alarm; it is retired constantly), and the allow
//                    rule — which persists, on disk, enforced with no worker at
//                    all — stayed for ever. That url then always opened in the
//                    browser's own viewer, which is what "PDFs don't open
//                    consistently" looked like from the outside.
//
// UMD-lite, exactly like config.js: `module.exports` under CommonJS (node
// tests), `self.BFPPdfRules` in the worker (importScripts).
(function (root) {
  'use strict';

  const PDF_RULE_ID = 1;
  const PDF_BYPASS_ID = 2;
  const PDF_BYPASS_MS = 60000;
  const PDF_VIEWER_PATH = 'pdf/viewer.html';

  // RE2 (declarativeNetRequest's engine), so the case-insensitivity is spelled
  // out rather than flagged: a rule that only caught lowercase `.pdf` would be
  // a coin toss. Fragments never reach the network stack, so none is matched.
  const PDF_REGEX = '^https?://[^#]*\\.[pP][dD][fF](?:$|\\?[^#]*$)';
  const looksPdfUrl = u => /^https?:\/\/[^?#]*\.pdf(?:[?#]|$)/i.test(String(u || ''));

  const reEscape = s => String(s).replace(/[.^$|()[\]{}*+?\\]/g, '\\$&');

  const viewerUrlFor = (base, u) =>
    String(base || '') + '?src=' + encodeURIComponent(String(u || ''));

  // The redirect writes the matched url VERBATIM after `#raw=` because DNR has
  // no encoder; `?src=` is the encoded spelling we build ourselves.
  function redirectRule(viewerUrl) {
    return {
      id: PDF_RULE_ID,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: String(viewerUrl) + '#raw=\\0' } },
      condition: { regexFilter: PDF_REGEX, resourceTypes: ['main_frame'] },
    };
  }

  function allowRule(url) {
    return {
      id: PDF_BYPASS_ID,
      priority: 2,
      action: { type: 'allow' },
      condition: { regexFilter: '^' + reEscape(url) + '$', resourceTypes: ['main_frame'] },
    };
  }

  // Field-by-field, because a rule read back out of the store is a copy and
  // never the object that was put in.
  function sameRule(a, b) {
    if (!a || !b) return false;
    const ra = (a.action && a.action.redirect) || {};
    const rb = (b.action && b.action.redirect) || {};
    return a.id === b.id && a.priority === b.priority &&
      !!a.action && !!b.action && a.action.type === b.action.type &&
      ra.regexSubstitution === rb.regexSubstitution &&
      !!a.condition && !!b.condition &&
      a.condition.regexFilter === b.condition.regexFilter &&
      (a.condition.resourceTypes || []).join() === (b.condition.resourceTypes || []).join();
  }

  // null = nothing to do. Otherwise {remove:[ids], add:[rules]} for ONE atomic
  // updateDynamicRules call.
  function pdfRulePlan(existing, on, want) {
    const have = (existing || []).find(r => r && r.id === PDF_RULE_ID) || null;
    if (!on) return have ? { remove: [PDF_RULE_ID], add: [] } : null;
    if (sameRule(have, want)) return null;
    return { remove: [PDF_RULE_ID], add: [want] };
  }

  // A bypass with no url, no deadline, an unreadable deadline, or a deadline in
  // the past is litter and must be swept. Anything unparseable counts as
  // expired: the failure that matters is a rule that stays too long, never one
  // that goes too early (the redirect simply happens again).
  function bypassExpired(v, now) {
    if (!v || !v.url) return true;
    const until = Number(v.until);
    return !Number.isFinite(until) || Number(now) >= until;
  }

  // WHICH PAGE a tab is showing, when the tab is showing our viewer: the
  // address bar says chrome-extension://…/pdf/viewer.html and the page is a
  // PDF. (adapters.js has the content-script copy; a service worker cannot
  // import a content script, so the two rules live here and are tested here.)
  function tabPageUrl(raw, viewerUrl) {
    const u = String(raw || '');
    if (!viewerUrl || !u.startsWith(String(viewerUrl))) return u;
    const hash = u.indexOf('#raw=');
    if (hash !== -1) return u.slice(hash + 5);
    const at = u.indexOf('?src=');
    if (at !== -1) {
      try { return decodeURIComponent(u.slice(at + 5).split('#')[0]); } catch { return u; }
    }
    return u;
  }

  const api = {
    PDF_RULE_ID, PDF_BYPASS_ID, PDF_BYPASS_MS, PDF_VIEWER_PATH, PDF_REGEX,
    looksPdfUrl, reEscape, viewerUrlFor, redirectRule, allowRule,
    sameRule, pdfRulePlan, bypassExpired, tabPageUrl,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPPdfRules = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
