// pubtoast.js — the notice that a post published in the background is live, or needs the owner's attention.
//
// Drawn by the content script on the tab the owner is looking at, whether or not the drawer is open: a small box in a CLOSED
// shadow root (a page's script cannot read it, fill it or press it), fixed to the corner, above the page. What it says comes from
// the worker (config.js pubNoticeOf): a fixed sentence, and for a live post the address the COMPANION recorded (http(s) only,
// never page text). Its buttons act only on a TRUSTED click (a page's dispatchEvent is not one; and it cannot reach the root to
// dispatch anything) whose point is on this box (a page that covers it with something of its own gets nothing: the click is
// refused, and the owner can use the keyboard: every control is a real button or link, Escape dismisses). A live notice goes
// after about ten seconds; one that needs attention stays until dismissed.
(function (root) {
  'use strict';
  const LIVE_MS = 10000;
  const CSS = `:host{all:initial}
.box{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:min(360px,calc(100vw - 32px));box-sizing:border-box;
 font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#2a2419;background:#fffdf8;
 border:1px solid #e3d9c6;border-left:3px solid #2f8f5b;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.18);padding:10px 12px;
 display:flex;gap:10px;align-items:flex-start;opacity:1;transition:opacity .4s}
.box.attention{border-left-color:#c0563a}
.box.going{opacity:0}
.mark{flex:none;font-weight:700;color:#2f8f5b}.attention .mark{color:#c0563a}
.body{flex:1;min-width:0}.say{margin:0 0 6px}
.acts{display:flex;gap:8px;flex-wrap:wrap}
a,button{font:inherit;font-size:13px;cursor:pointer;border-radius:7px;padding:3px 10px;border:1px solid #d8ccb5;background:#fff;color:#2a2419;text-decoration:none}
a.primary,button.primary{background:#d97757;border-color:#d97757;color:#fff}
.x{flex:none;border:none;background:none;padding:0 2px;font-size:16px;line-height:1;color:#8a7f6d}
:focus-visible{outline:2px solid #d97757;outline-offset:2px}
@media (prefers-color-scheme:dark){.box{color:#e8dfd1;background:#241f18;border-color:#4a4134}a,button{background:#2e281f;color:#e8dfd1;border-color:#4a4134}.x{color:#9c917e}.box{border-left-color:#3fae72}.box.attention{border-left-color:#d4694c}}`;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const safeLink = u => { try { const x = new URL(String(u || '')); return (x.protocol === 'https:' || x.protocol === 'http:') && !x.username && !x.password ? x.href : ''; } catch (_) { return ''; } };

  /**
   * Show one notice. → { host, close }. `notice`: { kind: 'live' | 'attention', run, sentence, link }. `onOpen(notice)`: the owner
   * asked for the steps; `onDone(notice)`: dismissed or acted on; `onShown(notice)`: it is on screen. `isTrusted(e)` for tests.
   */
  function show(notice, { doc = document, isTrusted = e => !!(e && e.isTrusted === true), onOpen = () => {}, onDone = () => {}, onShown = () => {}, liveMs = LIVE_MS } = {}) {
    const old = doc.querySelector('bfp-pub-notice');
    if (old) old.remove();
    const host = doc.createElement('bfp-pub-notice');
    const shadow = host.attachShadow({ mode: 'closed' });
    const live = notice.kind === 'live';
    const link = live ? safeLink(notice.link) : '';
    const st = doc.createElement('style');
    st.textContent = CSS;
    shadow.appendChild(st);
    const box = doc.createElement('div');
    box.className = 'box ' + (live ? 'live' : 'attention');
    box.setAttribute('role', live ? 'status' : 'alert');
    box.setAttribute('aria-live', live ? 'polite' : 'assertive');
    box.innerHTML = `<span class="mark" aria-hidden="true">${live ? '✓' : '!'}</span><div class="body"><p class="say">${esc(notice.sentence)}</p>`
      + `<div class="acts">${live ? (link ? `<a class="primary" data-act="open-post" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open your post</a>` : '')
        : '<button class="primary" type="button" data-act="open-steps">Show what happened</button>'}</div></div>`
      + '<button class="x" type="button" data-act="dismiss" aria-label="Dismiss" title="Dismiss">×</button>';
    shadow.appendChild(box);
    (doc.documentElement || doc.body).appendChild(host);
    // the toast's modes, in one list and one field: shown -> closing, never back (the `going` class is drawn from it)
    const TOAST_MODES = ['shown', 'closing'];
    let mode = TOAST_MODES[0];
    let timer = 0;
    const close = (done = true) => {
      if (mode !== 'shown') return;
      mode = 'closing';
      clearTimeout(timer);
      box.classList.add('going');
      setTimeout(() => host.remove(), 400);
      if (done) onDone(notice);
    };
    // a click counts only when it is the owner's AND lands on this box (not on something the page laid over it); the keyboard
    // (Enter or Space on a focused control: a click with no pointer position) always reaches the control it is on
    const onThis = e => {
      if (!isTrusted(e)) return false;
      const keyboard = !e.clientX && !e.clientY;
      if (keyboard) return true;
      try { const top = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(e.clientX, e.clientY)[0] : host; return top === host; } catch (_) { return false; }
    };
    box.addEventListener('click', e => {
      const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el) return;
      if (!onThis(e)) { e.preventDefault(); return; }
      const act = el.getAttribute('data-act');
      if (act === 'dismiss') close();
      else if (act === 'open-steps') { onOpen(notice); close(); }
      else if (act === 'open-post') close();   // the link itself opens the post (the browser's own navigation)
    });
    box.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    if (live) timer = setTimeout(() => close(), liveMs);
    onShown(notice);
    return { host, close, box };
  }
  const api = { show, LIVE_MS };
  root.BFPPubToast = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
