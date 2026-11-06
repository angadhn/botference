/*
 * Figure text editor — LOCAL PREVIEW ONLY.
 *
 * Loaded by _includes/figure-text-editor.html, which renders the <script> tag
 * only under `jekyll serve` in the development environment. This file adds a
 * second gate: it starts only when its tag carries data-fte-local, the page is
 * on a loopback host, and it is the top window. A query parameter cannot turn
 * it on.
 *
 * What it does: there is no mode and no button. Hovering editable text shows a
 * faint dotted outline. In a figure that declares itself (see "figure
 * declarations" below: SVG labels, HTML labels, step notes, tooltips), a click on plain text edits it in place; Enter applies and
 * Escape cancels. Links, buttons and all page text (title, headings, prose,
 * captions, callouts) keep their normal clicks and selection: a small ✎ at the
 * end of the hovered text edits them instead. Tooltips stay open while the
 * pointer is in them or their text is being edited.
 * Applying changes ONE text node's data (never innerHTML), so surrounding
 * formatting is untouched and entered text is never executed. Edits are
 * previews, persisted in localStorage per page, reviewable as a batch in a tray
 * that appears once an edit exists, and sent with one "Send changes" button to
 * the Discuss (botference) extension over a versioned window.postMessage
 * protocol. Nothing here writes source (markdown included): the bots apply each
 * edit to its source file and regenerate exports after receipt.
 *
 * Wire protocol and plugin-side contract:
 *   .botference/plugin/artifacts/figure-editor-plugin-handoff.md
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var CHANNEL = 'botference.figure-edits';
  var PROTOCOL = 1;
  var SCHEMA = 'botference.figure-edits/1';
  var CAPABILITY = 'figure-edits.send';
  var STORE_PREFIX = 'figure-text-editor:v1:';
  var MAX_EDITS = 100;
  var MAX_TEXT = 2000;
  var MAX_BYTES = 60000;
  var LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

  function isLoopbackHost(host) { return LOOPBACK.test(String(host || '')); }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function same(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
  function hex(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
  function randomHex(n) {
    var c = global.crypto;
    if (c && c.getRandomValues) { var a = new Uint8Array(n); c.getRandomValues(a); return hex(a); }
    var s = ''; while (s.length < n * 2) s += Math.floor(Math.random() * 16).toString(16); return s;
  }
  function rid(prefix) { return prefix + '-' + randomHex(6); }
  // A content fingerprint (not security): decides whether a retry is the SAME batch.
  function fingerprint(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }
  function sha256(text) {
    var c = global.crypto;
    if (!c || !c.subtle || typeof TextEncoder === 'undefined') return Promise.resolve(null);
    return c.subtle.digest('SHA-256', new TextEncoder().encode(text))
      .then(function (b) { return hex(new Uint8Array(b)); }, function () { return null; });
  }
  function splitWs(s) { var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s); return { lead: m[1], core: m[2], trail: m[3] }; }

  // ------------------------------------------------------------------ store
  // One record per (figure, element, context) and status. Drafts are the unsent
  // batch; delivered records wait for the bots to change the source; a record
  // whose replacement is found in a fresh render is "applied" and dropped.
  function Store(storage, key) {
    this.storage = storage; this.key = key;
    var s = null;
    try { s = JSON.parse(storage.getItem(key) || 'null'); } catch (e) { s = null; }
    if (!s || s.v !== 1) s = { v: 1, edits: [], undo: [], outbox: null, applied: [] };
    // a reload in the middle of a send: the batch may or may not have arrived;
    // sending again reuses its id, so the extension can tell it is a retry
    if (s.outbox && s.outbox.state === 'sending') {
      s.outbox.state = 'failed';
      s.outbox.error = { code: 'interrupted', message: 'The page reloaded before an acknowledgement arrived.', retryable: true };
    }
    this.state = s;
  }
  Store.prototype.save = function () {
    try { this.storage.setItem(this.key, JSON.stringify(this.state)); return true; } catch (e) { return false; }
  };
  Store.prototype.find = function (key, status) {
    return this.state.edits.filter(function (e) { return e.key === key && e.status === status; })[0] || null;
  };
  Store.prototype.active = function (key) { return this.find(key, 'draft') || this.find(key, 'delivered'); };
  Store.prototype.drafts = function () { return this.state.edits.filter(function (e) { return e.status === 'draft'; }); };
  Store.prototype.delivered = function () { return this.state.edits.filter(function (e) { return e.status === 'delivered'; }); };
  Store.prototype.forFigure = function (fid) {
    var self = this, keys = {};
    this.state.edits.forEach(function (e) { if (e.figure.id === fid) keys[e.key] = true; });
    return Object.keys(keys).map(function (k) { return self.active(k); });
  };
  Store.prototype._setDraft = function (key, rec) {
    this.state.edits = this.state.edits.filter(function (e) { return !(e.key === key && e.status === 'draft'); });
    if (rec) this.state.edits.push(rec);
  };
  // rec: a full draft record, or null to drop the draft for rec's key
  Store.prototype.putDraft = function (key, rec) {
    var before = this.find(key, 'draft');
    this._setDraft(key, rec);
    this.state.undo.push({ key: key, before: clone(before), after: clone(rec) });
    if (this.state.undo.length > 200) this.state.undo.shift();
    this.save();
  };
  Store.prototype.undo = function () {
    var u = this.state.undo.pop();
    if (!u) return null;
    this._setDraft(u.key, u.before);
    this.save();
    return u.key;
  };
  Store.prototype.markDelivered = function (ids, ack) {
    var self = this, at = new Date().toISOString();
    var keys = [];
    this.state.edits.forEach(function (e) {
      if (e.status === 'draft' && ids.indexOf(e.edit_id) >= 0) keys.push(e.key);
    });
    // a new delivery supersedes an older delivered record for the same element
    this.state.edits = this.state.edits.filter(function (e) {
      return !(e.status === 'delivered' && keys.indexOf(e.key) >= 0);
    });
    this.state.edits.forEach(function (e) {
      if (e.status === 'draft' && ids.indexOf(e.edit_id) >= 0) {
        e.status = 'delivered';
        e.delivery = { batch_id: ack.batch_id, at: at, message_ts: ack.accepted.message_ts,
          destination: ack.destination };
      }
    });
    this.state.undo = this.state.undo.filter(function (u) { return keys.indexOf(u.key) < 0; });
    this.state.outbox = null;
    this.save();
    return keys;
  };
  Store.prototype.markApplied = function (key) {
    var rec = this.active(key);
    this.state.edits = this.state.edits.filter(function (e) { return e.key !== key; });
    this.state.undo = this.state.undo.filter(function (u) { return u.key !== key; });
    if (rec) {
      this.state.applied.push({ figure: rec.figure.id, original: rec.original, replacement: rec.replacement, at: new Date().toISOString() });
      if (this.state.applied.length > 50) this.state.applied.shift();
    }
    this.save();
  };
  Store.prototype.discardDrafts = function () {
    var self = this;
    this.drafts().forEach(function (d) { self.putDraft(d.key, null); });
  };

  // ------------------------------------------------------------------ batch
  function editForWire(e) {
    return {
      edit_id: e.edit_id, figure: e.figure, element: e.element, context: e.context,
      source: e.source, original: e.original, replacement: e.replacement, baseline: e.baseline,
      supersedes: e.supersedes || null, captured_at: e.captured_at
    };
  }
  function contentPrint(drafts) {
    return fingerprint(JSON.stringify(drafts.map(function (d) {
      return [d.key, d.original, d.replacement, d.baseline];
    }).sort()));
  }
  function stamp(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T' + p(d.getUTCHours()) + p(d.getUTCMinutes());
  }
  function buildBatch(drafts, page, batchId) {
    return {
      schema: SCHEMA, batch_id: batchId, created_at: new Date().toISOString(),
      editor: { version: VERSION },
      page: page,
      note: 'Browser previews only: nothing has been written to source. Apply each edit to its source file, regenerate the listed exports, and report any edit that could not be placed.',
      edits: drafts.map(editForWire)
    };
  }
  function contextLabel(c) {
    if (!c) return '';
    if (c.step === 'cover') return 'cover (before step 1)';
    if (c.step != null) return 'step ' + c.step + (c.of ? ' of ' + c.of : '') + (c.step_title ? ' (“' + c.step_title + '”)' : '');
    if (c.tooltip) return 'tooltip ' + c.tooltip;
    return JSON.stringify(c);
  }
  function renderMessage(batch) {
    var lines = [];
    var n = batch.edits.length;
    lines.push('Figure text edits from the local preview: ' + n + ' edit' + (n === 1 ? '' : 's') +
      ' on ' + (batch.page.title || batch.page.path) + ' (batch ' + batch.batch_id + ').');
    lines.push('These are browser previews only. Please apply each to its source, regenerate the exports, and tell me any you could not place.');
    lines.push('');
    batch.edits.forEach(function (e, i) {
      var where = e.figure.title + ' · ' + (e.element.kind === 'svg-text' ? 'SVG label' : 'text') +
        (e.element.nearest_id ? ' in #' + e.element.nearest_id : '') +
        (e.context ? ' · ' + contextLabel(e.context) : '') +
        (e.element.occurrence && e.element.occurrence.count > 1 ? ' · occurrence ' + e.element.occurrence.index + ' of ' + e.element.occurrence.count : '');
      lines.push((i + 1) + '. ' + where);
      lines.push('   “' + e.original + '” → “' + e.replacement + '”');
      lines.push('   source: ' + e.source.file + (e.source.locator ? ' — ' + e.source.locator : ''));
    });
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(batch, null, 1));
    lines.push('```');
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ bridge
  function validInbound(ev, win) {
    if (!ev || !win || ev.source !== win) return null;
    if (ev.origin !== win.location.origin) return null;
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.channel !== CHANNEL || d.v !== PROTOCOL || d.from !== 'extension') return null;
    if (typeof d.type !== 'string' || typeof d.request_id !== 'string') return null;
    return d;
  }
  function validDestination(d) {
    return !!(d && typeof d === 'object' && typeof d.label === 'string' && d.label &&
      typeof d.url === 'string' && d.url && typeof d.thread_id === 'string' && d.thread_id);
  }
  function validAck(d) {
    return !!(d.accepted && (typeof d.accepted.message_ts === 'string' || typeof d.accepted.message_ts === 'number') &&
      validDestination(d.destination));
  }

  // The page's side of the protocol. `win` is the top window: the extension's
  // content script lives there (top frame only), and figure iframes never post.
  function Bridge(win, opts) {
    opts = opts || {};
    var self = this;
    var timers = opts.timers || {
      set: function (f, ms) { return win.setTimeout(f, ms); },
      clear: function (id) { win.clearTimeout(id); }
    };
    var t = { hello: 1000, helloTries: 8, received: 1500, resends: 2, ack: 45000 };
    for (var k in (opts.timeouts || {})) t[k] = opts.timeouts[k];
    this.state = 'unavailable';
    this.reason = 'Waiting for the Discuss extension to answer.';
    this.destination = null;
    this.extension = null;
    var listeners = [], helloId = null, helloTimer = null, helloTries = 0, pending = null;
    function emit() { listeners.forEach(function (f) { try { f(self); } catch (e) { /* listener bug */ } }); }
    function post(msg) {
      msg.channel = CHANNEL; msg.v = PROTOCOL; msg.from = 'page';
      win.postMessage(msg, win.location.origin);
    }
    this.onChange = function (f) { listeners.push(f); };
    this.hello = function (fresh) {
      if (fresh) helloTries = 0;
      helloId = rid('hello'); helloTries++;
      post({ type: 'hello', request_id: helloId, page: { url: win.location.href }, editor: { version: VERSION, capabilities: [CAPABILITY] } });
      timers.clear(helloTimer);
      helloTimer = timers.set(function () {
        if (self.state === 'unavailable' && helloTries < t.helloTries) self.hello();
      }, t.hello * Math.min(helloTries, 4));
    };
    function finish(kind, d) {
      var p = pending; if (!p) return;
      pending = null; timers.clear(p.timer);
      if (kind === 'ack') p.resolve(d); else p.reject(d);
    }
    function onMessage(ev) {
      var d = validInbound(ev, win);
      if (!d) return;
      if (d.type === 'ready') { helloTries = 0; self.hello(); return; }
      if (d.type === 'hello-ack') {
        if (d.request_id !== helloId) return;
        timers.clear(helloTimer);
        var caps = Array.isArray(d.capabilities) ? d.capabilities : [];
        if (caps.indexOf(CAPABILITY) < 0 || !validDestination(d.destination)) {
          self.state = 'unavailable'; self.destination = null;
          self.reason = str(d.message) || 'The extension answered, but it has no chat to send figure edits to.';
        } else {
          self.state = 'ready'; self.destination = d.destination;
          self.extension = d.extension && typeof d.extension === 'object' ? d.extension : null; self.reason = '';
        }
        emit(); return;
      }
      if (!pending || d.request_id !== pending.request_id || d.batch_id !== pending.batch_id) return;
      if (d.type === 'received') {
        pending.received = true; timers.clear(pending.timer);
        pending.timer = timers.set(function () {
          finish('error', { code: 'timeout', message: 'The extension took the batch, but no acknowledgement came back.', retryable: true });
        }, t.ack);
        return;
      }
      if (d.type === 'ack') { if (validAck(d)) finish('ack', d); return; }
      if (d.type === 'error') {
        if (d.code === 'destination_changed' || d.code === 'no_destination') { self.state = 'unavailable'; self.destination = null; emit(); self.hello(); }
        finish('error', { code: str(d.code) || 'error', message: str(d.message) || 'The extension refused the batch.', retryable: d.retryable !== false });
      }
    }
    win.addEventListener('message', onMessage);
    this.busy = function () { return !!pending; };
    // Post one batch; resolves with the ack, rejects with {code,message,retryable}.
    // Retransmits the SAME request (same request_id and batch_id) while nothing
    // has acknowledged receipt; the extension treats a repeat as a duplicate.
    this.send = function (batch, text) {
      if (self.state !== 'ready') return Promise.reject({ code: 'unavailable', message: self.reason || 'The Discuss extension is not connected.', retryable: true });
      if (pending) return Promise.reject({ code: 'busy', message: 'A batch is already being sent.', retryable: true });
      return new Promise(function (resolve, reject) {
        var p = pending = { batch_id: batch.batch_id, request_id: rid('send'), resolve: resolve, reject: reject, received: false, sends: 0, timer: null };
        var msg = { type: 'send', request_id: p.request_id, batch_id: batch.batch_id, expect_destination: clone(self.destination), batch: batch, text: text };
        (function transmit() {
          if (pending !== p || p.received) return;
          p.sends++;
          post(clone(msg));
          p.timer = timers.set(function () {
            if (pending !== p || p.received) return;
            if (p.sends <= t.resends) transmit();
            else finish('error', { code: 'no_response', message: 'The extension did not answer the send.', retryable: true });
          }, t.received);
        })();
      });
    };
  }

  // Orchestrates one Send click: batch id reuse, delivery bookkeeping, and
  // keeping every draft when anything goes wrong.
  function Sender(store, bridge, pageInfo) {
    this.store = store; this.bridge = bridge; this.page = pageInfo;
    this.last = null; // {kind:'delivered', ack, count} | {kind:'failed', error}
  }
  Sender.prototype.prepare = function () {
    var drafts = this.store.drafts();
    if (!drafts.length) return { error: { code: 'empty', message: 'There are no unsent edits.', retryable: false } };
    if (drafts.length > MAX_EDITS) return { error: { code: 'too_large', message: 'Send at most ' + MAX_EDITS + ' edits at once.', retryable: false } };
    var print = contentPrint(drafts);
    var ob = this.store.state.outbox;
    var batchId = ob && ob.print === print ? ob.batch_id : 'fte-' + stamp(new Date()) + '-' + randomHex(4);
    var batch = buildBatch(drafts, this.page(), batchId);
    if (ob && ob.batch_id === batchId && ob.created_at) batch.created_at = ob.created_at;
    var text = renderMessage(batch);
    if (text.length > MAX_BYTES) return { error: { code: 'too_large', message: 'This batch is too large to send in one message; send fewer edits.', retryable: false } };
    return { batch: batch, text: text, print: print, ids: drafts.map(function (d) { return d.edit_id; }) };
  };
  Sender.prototype.send = function () {
    var self = this, st = this.store;
    var prep = this.prepare();
    if (prep.error) { this.last = { kind: 'failed', error: prep.error }; return Promise.resolve(this.last); }
    var prev = st.state.outbox;
    st.state.outbox = { batch_id: prep.batch.batch_id, print: prep.print, created_at: prep.batch.created_at,
      attempts: (prev && prev.batch_id === prep.batch.batch_id ? prev.attempts : 0) + 1, state: 'sending', error: null };
    st.save();
    return this.bridge.send(prep.batch, prep.text).then(function (ack) {
      if (ack.batch_id !== prep.batch.batch_id) throw { code: 'mismatch', message: 'An acknowledgement named a different batch.', retryable: true };
      st.markDelivered(prep.ids, ack);
      self.last = { kind: 'delivered', ack: ack, count: prep.ids.length };
      return self.last;
    }).catch(function (err) {
      err = err && err.code ? err : { code: 'error', message: String((err && err.message) || err), retryable: true };
      if (st.state.outbox && st.state.outbox.batch_id === prep.batch.batch_id) {
        st.state.outbox.state = 'failed'; st.state.outbox.error = err; st.save();
      }
      self.last = { kind: 'failed', error: err };
      return self.last;
    });
  };

  var Core = {
    VERSION: VERSION, CHANNEL: CHANNEL, PROTOCOL: PROTOCOL, SCHEMA: SCHEMA, CAPABILITY: CAPABILITY,
    isLoopbackHost: isLoopbackHost, validInbound: validInbound, Store: Store, Bridge: Bridge,
    Sender: Sender, buildBatch: buildBatch, renderMessage: renderMessage
  };
  global.FigureTextEditorCore = Core;

  // ======================================================================
  // Browser part. Everything below needs a DOM and runs only after the gates.
  // ======================================================================

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SKIP = 'script, style, textarea, input, select, option, title, desc, noscript, template, .fte-ui';
  // text inside these is never click-to-edit: it keeps its click and shows a ✎
  var LINKISH = 'a, button, summary, [role="link"]';
  var WORDY = /[\p{L}\p{N}]/u;

  // The note's own text: title, headings, prose, captions, callouts. Never
  // click-to-edit (clicks, links and selection keep working); a ✎ edits it.
  var PAGE_TEXT = {
    id: 'page-text', title: 'Page text', page: 'main article',
    exclude: 'time, .byline, .article-tags, nav, .note-present, form, iframe, svg, canvas, #webmentions, .giscus, ' +
      '#companion-music-link, [class*="newsletter"], [class*="paywall"], .reversefootnote',
    source: function (fig, node) {
      var file = fig.page.source || '(this page)';
      var block = closestEl(node, 'h1, h2, h3, h4, h5, h6, p, li, figcaption, td, th, dt, dd, .callout-title, .subtitle, .featured-note') ||
        closestEl(node, '*');
      var tag = block.localName, where;
      if (tag === 'h1' && block === fig.root.querySelector('h1')) where = 'front matter: title';
      else if (block.classList.contains('subtitle')) where = 'front matter: subtitle';
      else if (block.classList.contains('featured-note')) where = 'front matter: featured';
      else if (block.classList.contains('callout-title')) where = 'callout title (the > [!type] line)';
      else if (closestEl(block, '.callout-content')) where = 'callout body (lines starting with >), ' + tag;
      else if (tag === 'figcaption') where = 'figure caption (HTML in the markdown)';
      else where = 'markdown body, ' + (/^h\d$/.test(tag) ? 'heading' : tag === 'li' ? 'list item' : tag === 'td' || tag === 'th' ? 'table cell' : 'paragraph');
      var heading = null;
      Array.prototype.forEach.call(fig.root.querySelectorAll('h2, h3, h4'), function (h) {
        if (h !== block && (h.compareDocumentPosition(block) & 4)) heading = h.textContent.replace(/\s+/g, ' ').trim();
      });
      var text = block.textContent.replace(/\s+/g, ' ').trim();
      return { file: file, locator: where + (heading && where.indexOf('front matter') < 0 ? ', under “' + heading + '”' : ''),
        block: text.length > 300 ? text.slice(0, 300) + '…' : text, heading: heading,
        note: 'Rendered from markdown: find original inside this block in the file and replace only those words (markdown syntax may sit between them in source). The browser never edits the markdown.' };
    }
  };

  // ------------------------------------------------- figure declarations
  // This file names no figure. Each figure declares itself, in its own file,
  // with one JSON object:
  //   · a generated export shown in a same-origin iframe carries
  //       <meta name="figure-editor" content="{…}">  (HTML-escaped JSON)
  //   · a figure written into a note carries
  //       <script type="application/json" data-figure-editor>{…}</script>
  //     whose root is `root` (a selector in the page) or else the script's parent.
  // Fields (all optional but id):
  //   id, title       — names used in the batch (figure.id / figure.title)
  //   root            — selector of the figure's root element in its document
  //   generator       — the file that writes the export; exports: files it writes
  //   file            — default source file (else: generator for an export,
  //                     the note itself for an inline figure)
  //   exclude         — selector of text that is never editable (controls, nav)
  //   context: [rule] — the first rule whose `when` contains the text names the
  //                     state it is showing, so a preview re-applies only there:
  //       {when, tooltip: {active: sel, attr}}         → {tooltip}
  //       {when, step: {items: sel, current, title_attr}} → {step, of, step_index, step_title}
  //       {when, counter: {el: sel, pattern, hidden}}  → {step, of} (or `hidden` while hidden)
  //   source: [rule]  — the first rule that matches gives the edit's source:
  //       {when: sel, text: regex on the text, ctx: {key: value},
  //        file, locator, note, regenerate}
  //     `locator` and `note` fill {ctx.key}, {ctx.key-N} (a number minus N, or ?)
  //     and {match.attr} (an attribute of the element `when` matched).
  function parseDecl(json) {
    var d = null;
    try { d = JSON.parse(json || 'null'); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id || d.id === PAGE_TEXT.id) return null;
    return d;
  }
  function qs(root, sel) { try { return sel ? root.querySelector(sel) : null; } catch (e) { return null; } }
  function qsa(root, sel) { try { return sel ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; } catch (e) { return []; } }
  function within_(node, sel) { try { return closestEl(node, sel); } catch (e) { return null; } }
  function matches(el, sel) { try { return !!(el && el.matches && el.matches(sel)); } catch (e) { return false; } }

  function contextOf(decl, fig, node) {
    var rules = Array.isArray(decl.context) ? decl.context : [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i] || {};
      if (!r.when || !within_(node, r.when)) continue;
      if (r.tooltip) {
        var a = qs(fig.root, r.tooltip.active);
        return { tooltip: a ? a.getAttribute(r.tooltip.attr || 'id') : null };
      }
      if (r.step) {
        var items = qsa(fig.root, r.step.items), at = -1;
        items.forEach(function (d, j) { if (matches(d, r.step.current || '[aria-current="true"]')) at = j; });
        var title = at >= 0 ? (items[at].getAttribute(r.step.title_attr || 'title') || '').replace(/<[^>]*>/g, '') : '';
        return { step: at + 1, of: items.length, step_index: at, step_title: title };
      }
      if (r.counter) {
        var c = qs(fig.root, r.counter.el);
        if (!c || c.hidden) return clone(r.counter.hidden || null);
        var m = null;
        try { m = new RegExp(r.counter.pattern || '(\\d+)\\D+(\\d+)').exec(c.textContent || ''); } catch (e) { m = null; }
        return m ? { step: +m[1], of: +m[2] } : { step: null };
      }
      return null;
    }
    return null;
  }
  function fill(tpl, ctx, matchEl) {
    if (typeof tpl !== 'string') return tpl;
    return tpl.replace(/\{ctx\.(\w+)(?:-(\d+))?\}/g, function (_, k, minus) {
      var v = ctx ? ctx[k] : null;
      if (minus) return typeof v === 'number' && v ? String(v - +minus) : '?';
      return String(v);
    }).replace(/\{match\.([\w-]+)\}/g, function (_, k) {
      return (matchEl && matchEl.getAttribute(k)) || '';
    });
  }
  function sourceOf(decl, fig, node, ctx) {
    var file = decl.file || (fig.frame && (decl.generator || fig.baseline.generator)) || fig.page.source || '(this note)';
    var rules = Array.isArray(decl.source) ? decl.source : [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i] || {}, hit = null;
      if (r.when) { hit = within_(node, r.when); if (!hit) continue; }
      if (r.text) { var ok = false; try { ok = new RegExp(r.text).test(node.data); } catch (e) { ok = false; } if (!ok) continue; }
      if (r.ctx && !Object.keys(r.ctx).every(function (k) { return ctx && same(ctx[k], r.ctx[k]); })) continue;
      var out = { file: r.file || file, locator: fill(r.locator || '', ctx, hit) };
      if (r.regenerate) out.regenerate = r.regenerate;
      if (r.note) out.note = fill(r.note, ctx, hit);
      return out;
    }
    return { file: file, locator: decl.root || 'figure markup' };
  }
  // A declaration as the editor uses it (the same shape PAGE_TEXT has).
  function specOf(decl) {
    return {
      id: decl.id, title: typeof decl.title === 'string' && decl.title ? decl.title : decl.id,
      generator: typeof decl.generator === 'string' ? decl.generator : null,
      exports: Array.isArray(decl.exports) ? decl.exports.filter(function (x) { return typeof x === 'string'; }) : [],
      exclude: typeof decl.exclude === 'string' ? decl.exclude : null,
      context: function (fig, node) { return contextOf(decl, fig, node); },
      source: function (fig, node, ctx) { return sourceOf(decl, fig, node, ctx); }
    };
  }
  // Every figure a document declares: [{spec, root}]
  function declaredIn(doc) {
    var out = [];
    qsa(doc, 'meta[name="figure-editor"]').forEach(function (m) {
      var d = parseDecl(m.getAttribute('content'));
      var root = d && (d.root ? qs(doc, d.root) : doc.body);
      if (root) out.push({ spec: specOf(d), root: root });
    });
    qsa(doc, 'script[type="application/json"][data-figure-editor]').forEach(function (s) {
      var d = parseDecl(s.textContent);
      var root = d && (d.root ? qs(doc, d.root) : s.parentElement);
      if (root) out.push({ spec: specOf(d), root: root });
    });
    return out;
  }

  function closestEl(node, sel) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement || node.parentNode);
    return el && el.closest ? el.closest(sel) : null;
  }
  function isSvg(node) { var el = closestEl(node, '*'); return !!(el && el.namespaceURI === SVG_NS); }
  function eligible(fig, node) {
    if (!node || node.nodeType !== 3 || !WORDY.test(node.data)) return false;
    if (!fig.root.contains(node)) return false;
    if (closestEl(node, SKIP)) return false;
    if (fig.spec.exclude && within_(node, fig.spec.exclude)) return false;
    // text inside a nested figure belongs to that figure, not to the page
    if (closestEl(node, '[data-fte-root]') !== fig.root) return false;
    return true;
  }
  function modeOf(fig, node) { return fig.spec.page || closestEl(node, LINKISH) ? 'icon' : 'click'; }
  function eligibleIn(fig, el) {
    var out = [];
    if (!el) return out;
    var w = fig.doc.createTreeWalker(el, 4, null);
    for (var n = w.nextNode(); n; n = w.nextNode()) if (eligible(fig, n)) out.push(n);
    return out;
  }
  // the line boxes of a text node's words (its leading/trailing spaces excluded)
  function textRects(node) {
    var r = node.ownerDocument.createRange(), ws = splitWs(node.data);
    r.setStart(node, ws.lead.length); r.setEnd(node, ws.lead.length + ws.core.length);
    return Array.prototype.slice.call(r.getClientRects()).filter(function (b) { return b.width > 0 && b.height > 0; });
  }
  function within(node, x, y) {
    return textRects(node).some(function (b) { return x >= b.left - 3 && x <= b.right + 3 && y >= b.top - 3 && y <= b.bottom + 3; });
  }
  function inRect(b, x, y) { return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom; }
  function pickText(fig, x, y, target) {
    var hit = null, doc = fig.doc;
    try {
      if (doc.caretRangeFromPoint) { var r = doc.caretRangeFromPoint(x, y); if (r) hit = r.startContainer; }
      else if (doc.caretPositionFromPoint) { var p = doc.caretPositionFromPoint(x, y); if (p) hit = p.offsetNode; }
    } catch (e) { hit = null; }
    if (hit && eligible(fig, hit) && within(hit, x, y)) return hit;
    // SVG text often has no caret position: look among the target's own text
    var scope = closestEl(target, 'text') || (target && target.nodeType === 1 ? target : closestEl(target, '*'));
    var c = eligibleIn(fig, scope);
    if (c.length > 40) return null;
    for (var i = 0; i < c.length; i++) if (within(c[i], x, y)) return c[i];
    return null;
  }
  function nonEmptyTextChildren(el) {
    return Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3 && n.data.trim(); });
  }
  function anchorOf(fig, el) {
    var a = el.closest('[id]');
    while (a && !fig.root.contains(a)) a = null;
    if (a && a !== fig.root && fig.doc.querySelectorAll('[id="' + a.id.replace(/"/g, '') + '"]').length === 1) return a;
    return fig.root;
  }
  function relSelector(from, el) {
    var parts = [];
    while (el && el !== from) {
      var p = el.parentElement; if (!p) return null;
      parts.unshift('*:nth-child(' + (Array.prototype.indexOf.call(p.children, el) + 1) + ')');
      el = p;
    }
    if (el !== from) return null;
    return parts.length ? ':scope > ' + parts.join(' > ') : ':scope';
  }
  function humanPath(fig, el) {
    var parts = [];
    for (var e = el; e && e !== fig.root && parts.length < 5; e = e.parentElement) {
      var names = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(function (c) { return c && c !== 'fte-hot'; }) : [];
      parts.unshift(e.localName + (e.id ? '#' + e.id : names.length ? '.' + names[0] : ''));
    }
    return parts.join(' > ');
  }
  function siblingText(node, dir) {
    var s = '';
    for (var n = node[dir]; n && s.length < 60; n = n[dir]) s = dir === 'previousSibling' ? (n.textContent || '') + s : s + (n.textContent || '');
    s = s.replace(/\s+/g, ' ').trim();
    return dir === 'previousSibling' ? s.slice(-40) : s.slice(0, 40);
  }
  function coreOf(node) { return splitWs(node.data).core; }

  // Everything needed to find this text again, in the browser and in source.
  function describe(fig, node, originalCore) {
    var el = node.parentElement || node.parentNode;
    var anchor = anchorOf(fig, el);
    var ctx = fig.spec.context ? fig.spec.context(fig, node) : null;
    var twins = eligibleIn(fig, fig.root).filter(function (n) {
      var k = fig.previewed.get(n);
      var shown = k ? fig.originals.get(n) : coreOf(n);
      return shown === originalCore && same_(fig, n, ctx);
    });
    var element = {
      kind: isSvg(node) ? 'svg-text' : 'html-text',
      tag: el.localName,
      anchor_id: anchor === fig.root ? null : anchor.id,
      selector: relSelector(anchor, el),
      text_index: nonEmptyTextChildren(el).indexOf(node),
      path: humanPath(fig, el),
      nearest_id: (el.closest('[id]') && fig.root.contains(el.closest('[id]'))) ? el.closest('[id]').id : null,
      occurrence: { index: twins.indexOf(node) + 1, count: twins.length },
      before: siblingText(node, 'previousSibling'),
      after: siblingText(node, 'nextSibling')
    };
    var key = fig.spec.id + '|' + (element.anchor_id || '') + '|' + element.selector + '|' + element.text_index + '|' + JSON.stringify(ctx);
    return { key: key, element: element, context: ctx };
  }
  function same_(fig, n, ctx) { return same(fig.spec.context ? fig.spec.context(fig, n) : null, ctx); }

  function resolve(fig, rec) {
    var e = rec.element, anchor = fig.root;
    if (e.anchor_id) { anchor = fig.doc.getElementById(e.anchor_id); if (!anchor || !fig.root.contains(anchor)) anchor = null; }
    var ok = function (n) {
      if (!n || !eligible(fig, n)) return false;
      if (!same_(fig, n, rec.context)) return false;
      var c = coreOf(n);
      return c === rec.original || c === rec.replacement;
    };
    if (anchor && e.selector) {
      var el = null;
      try { el = e.selector === ':scope' ? anchor : anchor.querySelector(e.selector); } catch (err) { el = null; }
      if (el) { var n = nonEmptyTextChildren(el)[e.text_index]; if (ok(n)) return n; }
    }
    // the element moved (a walkthrough note re-docked, a re-render): fall back
    // to the original text, disambiguated by occurrence within the same context
    var cands = eligibleIn(fig, fig.root).filter(function (n) {
      return same_(fig, n, rec.context) && (coreOf(n) === rec.original || fig.previewed.get(n) === rec.key);
    });
    if (cands.length === 1) return cands[0];
    if (e.occurrence && cands.length === e.occurrence.count) return cands[e.occurrence.index - 1] || null;
    return null;
  }

  // ------------------------------------------------------------------ styles
  var CSS = [
    '.fte-ui{--fte-bg:#fffdf6;--fte-ink:#2b2620;--fte-muted:#6f675a;--fte-line:#d8cfbc;--fte-accent:#9a7b52;--fte-ok:#3d6b3a;--fte-bad:#a33b2a;--fte-btn:#2b2620;--fte-btn-ink:#fffdf6;--fte-mark:rgba(216,184,138,.32);--fte-hover:rgba(154,123,82,.7);',
    'font-family:Baskerville,"Libre Baskerville",Palatino,Georgia,serif;color:var(--fte-ink);font-size:15px;line-height:1.35;box-sizing:border-box}',
    'html[data-theme="dark"] .fte-ui{--fte-bg:#262119;--fte-ink:#ece4d3;--fte-muted:#b0a691;--fte-line:#4a4236;--fte-accent:#c39a68;--fte-ok:#8fc48a;--fte-bad:#ef8f7c;--fte-btn:#ece4d3;--fte-btn-ink:#211d17;--fte-mark:rgba(195,154,104,.28);--fte-hover:rgba(214,178,128,.75)}',
    '.fte-ui *{box-sizing:border-box}',
    '.fte-ui[hidden],.fte-ui [hidden]{display:none!important}',
    '.fte-ui button{font:inherit;font-size:14px;line-height:1.2;color:var(--fte-ink);background:transparent;border:1px solid var(--fte-line);border-radius:4px;padding:.35rem .65rem;cursor:pointer;min-height:2rem}',
    '.fte-ui button:hover:not(:disabled){border-color:var(--fte-accent)}',
    '.fte-ui button:disabled{opacity:.45;cursor:default}',
    '.fte-ui button:focus-visible{outline:2px solid var(--fte-accent);outline-offset:2px}',
    '.fte-ui .fte-primary{background:var(--fte-btn);color:var(--fte-btn-ink);border-color:var(--fte-btn);font-weight:700}',
    // the site recolours every :focus with !important; keep the editor's own colours (the outline still shows focus)
    '.fte-ui button:focus:not(#fte-x),.fte-ui textarea:focus:not(#fte-x){background:transparent!important;color:var(--fte-ink)!important}',
    '.fte-ui .fte-primary:focus:not(#fte-x){background:var(--fte-btn)!important;color:var(--fte-btn-ink)!important}',
    '.fte-ui.fte-field textarea:focus:not(#fte-x){background:var(--fte-bg)!important}',
    '.fte-ui.fte-pencil:focus:not(#fte-x){background:var(--fte-bg)!important;color:var(--fte-accent)!important}',
    '.fte-dock{position:fixed;left:1rem;bottom:1rem;z-index:2147483000;width:26rem;max-width:calc(100vw - 2rem)}',
    '.fte-panel{background:var(--fte-bg);border:1px solid var(--fte-line);border-left:4px solid var(--fte-accent);border-radius:4px;box-shadow:0 4px 22px rgba(43,38,32,.25);padding:.6rem .8rem .7rem}',
    '.fte-head{display:flex;align-items:baseline;gap:.5rem;margin:0 0 .35rem}',
    '.fte-head strong{font-size:16px}',
    '.fte-head .fte-tag{font-size:12px;font-style:italic;color:var(--fte-muted)}',
    '.fte-bridge{display:flex;gap:.45rem;align-items:baseline;margin:0 0 .55rem;font-size:13.5px}',
    '.fte-dot{flex:0 0 auto;width:.6rem;height:.6rem;border-radius:50%;background:var(--fte-muted);transform:translateY(.05rem)}',
    '.fte-bridge[data-state="ready"] .fte-dot{background:var(--fte-ok)}',
    '.fte-row{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap}',
    '.fte-row .fte-send{margin-left:auto}',
    '.fte-result{margin:.55rem 0 0;font-size:13.5px}',
    '.fte-result:empty{display:none}',
    '.fte-result[data-kind="delivered"]{color:var(--fte-ok)}',
    '.fte-result[data-kind="failed"]{color:var(--fte-bad)}',
    '.fte-review{max-height:min(46vh,24rem);overflow:auto;margin:0 0 .6rem;padding:.1rem .1rem .1rem 0;border-top:1px solid var(--fte-line)}',
    '.fte-review h3{margin:.55rem 0 .3rem;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--fte-muted)}',
    '.fte-item{margin:0 0 .5rem;padding:0 0 .45rem;border-bottom:1px dotted var(--fte-line);font-size:13.5px}',
    '.fte-item .fte-where{color:var(--fte-muted);font-style:italic;font-size:12.5px}',
    '.fte-item del{color:var(--fte-bad);text-decoration-thickness:1px}',
    '.fte-item ins{color:var(--fte-ok);text-decoration:none;font-weight:600}',
    '.fte-item .fte-itemrow{display:flex;gap:.5rem;align-items:flex-start;justify-content:space-between}',
    '.fte-item button{padding:.15rem .45rem;min-height:1.6rem;font-size:12.5px}',
    '.fte-empty{font-size:13.5px;color:var(--fte-muted);font-style:italic;margin:.4rem 0}',
    // in-place field: sits exactly over the text it replaces
    '.fte-field{position:fixed;z-index:2147483001;line-height:1.25}',
    '.fte-field textarea{display:block;width:100%;margin:0;resize:none;overflow:hidden;padding:1px 4px;border:0;border-radius:2px;background:var(--fte-bg);color:var(--fte-ink);outline:2px solid var(--fte-accent);outline-offset:0;box-shadow:0 2px 14px rgba(43,38,32,.28);line-height:1.25}',
    '.fte-field .fte-keys{display:block;width:max-content;max-width:min(30rem,100%);margin-top:5px;padding:1px 6px;border-radius:2px;background:var(--fte-bg);font-size:12px;font-style:italic;color:var(--fte-muted);box-shadow:0 1px 5px rgba(43,38,32,.18)}',
    '.fte-pencil{position:fixed;z-index:2147483002;width:17px;height:17px;min-height:0!important;padding:0!important;border-radius:50%!important;border:1px solid var(--fte-accent)!important;background:var(--fte-bg)!important;color:var(--fte-accent)!important;font-size:11px!important;line-height:15px!important;text-align:center;box-shadow:0 1px 4px rgba(43,38,32,.22);cursor:pointer}',
    '.fte-toast{position:fixed;left:50%;bottom:1rem;transform:translateX(-50%);z-index:2147483003;max-width:min(32rem,calc(100vw - 2rem));background:var(--fte-bg);border:1px solid var(--fte-line);border-left:4px solid var(--fte-accent);border-radius:4px;box-shadow:0 4px 18px rgba(43,38,32,.25);padding:.4rem .7rem;font-size:14px}',
    '.fte-layer{position:fixed;inset:0;pointer-events:none;z-index:2147482999}',
    '.fte-box{position:fixed;pointer-events:none;border-radius:2px}',
    '.fte-box[data-kind="edited"]{background:var(--fte-mark);border-bottom:2px solid var(--fte-accent)}',
    '.fte-box[data-kind="delivered"]{border-bottom:2px dotted var(--fte-accent)}',
    '.fte-box[data-kind="hover"]{outline:1px dotted var(--fte-hover);outline-offset:1px}',
    '.fte-hot{cursor:text!important}'
  ].join('\n');
  var FRAME_CSS = '.fte-hot, .fte-hot *{cursor:text!important}';

  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function norm(t) { if (t && t.nodeType === 3) t = t.parentNode; return t && typeof t.nodeType === 'number' ? t : null; }

  // ------------------------------------------------------------------ editor
  // No mode: on the local preview the editor is always listening. Hover shows
  // what can change; a click on plain figure text edits it in place; links,
  // buttons and all page text get a ✎ instead, so their clicks (and prose
  // selection, which the Discuss extension uses) are left alone.
  function Editor(win, page) {
    var self = this;
    var doc = win.document;
    this.win = win; this.doc = doc; this.page = page;
    this.figs = [];
    this.listened = [];
    this.held = [];
    this.hover = null; this.field = null; this.pressed = null; this.pointer = null;
    this.store = new Store(safeStorage(win), STORE_PREFIX + win.location.pathname);
    this.bridge = new Bridge(win);
    this.sender = new Sender(this.store, this.bridge, function () { return self.pageInfo(); });
    this.sending = false;
    this.buildUi();
    this.bridge.onChange(function () { self.render(); });
    this.listen(win);
    this.discover();
    new win.MutationObserver(function () { self.discover(); }).observe(doc.body, { childList: true, subtree: true });
    win.addEventListener('keydown', function (ev) {
      if (ev.defaultPrevented || !self.store.state.undo.length || self.field) return;
      if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && (ev.key === 'z' || ev.key === 'Z') &&
          !closestEl(norm(ev.target), 'textarea, input, select, [contenteditable]')) {
        ev.preventDefault(); self.undo();
      }
    });
    this.bridge.hello();
    this.render();
  }
  function safeStorage(win) {
    try { var s = win.localStorage; s.setItem('fte-probe', '1'); s.removeItem('fte-probe'); return s; }
    catch (e) { var m = {}; return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } }; }
  }

  Editor.prototype.pageInfo = function () {
    var p = this.page || {};
    return { url: this.win.location.href, path: this.win.location.pathname, title: p.title || this.doc.title,
      source: p.source || null, source_sha256: /^[0-9a-f]{64}$/.test(p.sourceSha256 || '') ? p.sourceSha256 : null,
      built_at: p.builtAt || null };
  };

  // -------------------------------------------------------- figure discovery
  Editor.prototype.discover = function () {
    var self = this, doc = this.doc;
    var page = doc.querySelector(PAGE_TEXT.page);
    if (page && !this.figFor(page)) this.attach(PAGE_TEXT, page, null);
    // figures written into this page
    declaredIn(doc).forEach(function (x) { if (!self.figFor(x.root)) self.attach(x.spec, x.root, null); });
    // same-origin iframes whose document declares a figure
    Array.prototype.forEach.call(doc.querySelectorAll('iframe'), function (f) {
      if (f.__fteSeen) return;
      var u; try { u = new URL(f.getAttribute('src') || '', self.win.location.href); } catch (e) { return; }
      if (u.origin !== self.win.location.origin) return;
      f.__fteSeen = true;
      var tryAttach = function () {
        var d; try { d = f.contentDocument; } catch (e) { return; }
        if (!d) return;
        var found = declaredIn(d);
        // one live attachment per declared root: the same document is already
        // handled; a reloaded document replaces the old attachments and observers
        var old = self.figs.filter(function (g) { return g.frame === f; });
        if (old.length && old.every(function (g) { return g.root.ownerDocument === d; })) return;
        old.forEach(function (g) { g.observer.disconnect(); self.figs.splice(self.figs.indexOf(g), 1); });
        found.forEach(function (x) { self.attach(x.spec, x.root, f); });
      };
      f.addEventListener('load', tryAttach);
      tryAttach();
    });
  };
  Editor.prototype.figFor = function (root) { return this.figs.filter(function (f) { return f.root === root; })[0] || null; };
  // the innermost figure containing t (the walkthrough sits inside the page text)
  Editor.prototype.figAt = function (w, t) {
    if (!t) return null;
    var best = null;
    this.figs.forEach(function (f) { if (f.win === w && f.root.contains(t) && (!best || best.root.contains(f.root))) best = f; });
    return best;
  };
  Editor.prototype.frameOf = function (w) {
    for (var i = 0; i < this.figs.length; i++) if (this.figs[i].win === w && this.figs[i].frame) return this.figs[i].frame;
    return null;
  };

  Editor.prototype.attach = function (spec, root, frame) {
    var self = this;
    var fdoc = root.ownerDocument, fwin = fdoc.defaultView;
    var fig = { spec: spec, root: root, frame: frame, doc: fdoc, win: fwin, page: this.pageInfo(),
      previewed: new WeakMap(), originals: new WeakMap(), live: {}, missing: {}, baseline: null, applying: false };
    fig.page.source = (this.page && this.page.source) || null;
    root.setAttribute('data-fte-root', spec.id);
    if (frame) frame.setAttribute('data-fte-root', spec.id);
    this.figs.push(fig);
    if (frame) {
      var st = fdoc.createElement('style'); st.className = 'fte-ui'; st.textContent = FRAME_CSS;
      fdoc.head.appendChild(st);
    }
    this.listen(fwin);
    // baseline: the generator digest the export carries, plus a digest of
    // exactly what was rendered (taken before any preview touches it)
    var rendered = root.outerHTML;
    var meta = fdoc.querySelector('meta[name="figure-source"]');
    fig.baseline = { rendered_sha256: null, generator: meta ? meta.getAttribute('content') : null,
      generator_sha256: meta ? meta.getAttribute('data-sha256') : null,
      inputs: Array.prototype.map.call(fdoc.querySelectorAll('meta[name="figure-input"]'), function (m) {
        return { path: m.getAttribute('content'), sha256: m.getAttribute('data-sha256') }; }),
      document: frame ? new URL(frame.src).pathname : fig.page.path,
      page_source_sha256: frame ? null : fig.page.source_sha256, captured_at: new Date().toISOString() };
    sha256(rendered).then(function (h) { fig.baseline.rendered_sha256 = h; });
    fig.observer = new fwin.MutationObserver(function () { if (!fig.applying) self.reconcile(fig, false); });
    fig.observer.observe(root, { childList: true, subtree: true, characterData: true });
    this.reconcile(fig, true);
    this.render();
  };

  // Re-apply previews after a re-render, and notice edits the source now has.
  Editor.prototype.reconcile = function (fig) {
    var self = this, applied = 0;
    fig.applying = true;
    fig.live = {}; fig.missing = {};
    this.store.forFigure(fig.spec.id).forEach(function (rec) {
      var n = resolve(fig, rec);
      if (!n) { fig.missing[rec.key] = true; return; }
      var ws = splitWs(n.data);
      if (ws.core === rec.replacement && fig.previewed.get(n) !== rec.key && rec.replacement !== rec.original) {
        // the page itself now says what we asked for: the bots applied it
        self.store.markApplied(rec.key); applied++; return;
      }
      if (ws.core !== rec.replacement) {
        fig.originals.set(n, ws.core);
        n.data = ws.lead + rec.replacement + ws.trail;
      }
      fig.previewed.set(n, rec.key);
      fig.live[rec.key] = n;
    });
    fig.observer && fig.observer.takeRecords();
    fig.applying = false;
    if (applied) { this.toast(applied + ' earlier edit' + (applied === 1 ? ' is' : 's are') + ' now in the source (applied).'); this.render(); }
    if (Object.keys(fig.live).length) this.loop();
  };
  Editor.prototype.revertNode = function (fig, key) {
    var n = fig.live[key];
    if (!n) return;
    fig.applying = true;
    var o = fig.originals.get(n);
    if (o != null) { var ws = splitWs(n.data); n.data = ws.lead + o + ws.trail; }
    fig.previewed.delete(n); fig.originals.delete(n);
    delete fig.live[key];
    fig.observer.takeRecords();
    fig.applying = false;
  };
  Editor.prototype.refreshKey = function (key) {
    var self = this;
    this.figs.forEach(function (fig) {
      if (key.indexOf(fig.spec.id + '|') !== 0) return;
      self.revertNode(fig, key);
      self.reconcile(fig);
    });
  };

  // ------------------------------------------------------------ input wiring
  // Capture-phase listeners on the top window and every figure frame. They
  // stop an event only when it is a press on plain figure text (which edits
  // it), or, inside the frame a field or ✎ belongs to, a pointer-leave/blur
  // that would close the tooltip being edited. Everything else passes.
  Editor.prototype.listen = function (w) {
    if (this.listened.indexOf(w) >= 0) return;
    this.listened.push(w);
    var self = this;
    w.addEventListener('mousemove', function (ev) { self.onMove(w, ev); }, true);
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'].forEach(function (type) {
      w.addEventListener(type, function (ev) { self.onPress(w, ev); }, true);
    });
    ['pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
      'focus', 'blur', 'focusin', 'focusout'].forEach(function (type) {
      w.addEventListener(type, function (ev) { self.onPassive(w, ev); }, true);
    });
    w.addEventListener('scroll', function () { self.paintSoon(); }, true);
  };
  Editor.prototype.isUi = function (t) { return !!(t && t.ownerDocument === this.doc && closestEl(t, '.fte-ui')); };
  Editor.prototype.toTop = function (w, x, y) {
    if (w === this.win) return { x: x, y: y };
    var f = this.frameOf(w);
    if (!f) return null;
    var r = f.getBoundingClientRect();
    return { x: x + r.left + f.clientLeft, y: y + r.top + f.clientTop };
  };

  Editor.prototype.onMove = function (w, ev) {
    if (this.replaying) return;
    this.pointer = this.toTop(w, ev.clientX, ev.clientY);
    this.releaseHeld(w);
    if (this.field || this.sending) return;
    if (ev.buttons) { this.setHover(null); return; }
    var t = norm(ev.target);
    if (this.isUi(t)) { if (closestEl(t, '.fte-pencil')) this.keepHover(); else this.setHover(null); return; }
    var fig = this.figAt(w, t);
    var n = fig ? pickText(fig, ev.clientX, ev.clientY, t) : null;
    if (n && fig.spec.page) {
      // a selection in progress belongs to the reader (and to Discuss)
      var sel = w.getSelection && w.getSelection();
      if (sel && !sel.isCollapsed) { this.setHover(null); return; }
    }
    if (n) this.setHover({ fig: fig, node: n, mode: modeOf(fig, n) });
    else this.hoverLeaveSoon();
  };

  Editor.prototype.onPress = function (w, ev) {
    if (this.replaying) return;
    var type = ev.type, t = norm(ev.target);
    if (this.isUi(t)) return;
    if (type === 'pointerdown' || (type === 'mousedown' && !this.pointerSeen)) {
      if (type === 'pointerdown') this.pointerSeen = true;
      // a press anywhere else applies the open field, then acts as usual
      if (this.field) this.commitField(true);
      this.pressed = null;
      if (ev.button !== 0 || this.sending || (ev.pointerType && ev.pointerType !== 'mouse')) return;
      var fig = this.figAt(w, t);
      var n = fig && !fig.spec.page ? pickText(fig, ev.clientX, ev.clientY, t) : null;
      if (n && modeOf(fig, n) === 'click') this.pressed = { fig: fig, node: n, w: w };
    }
    var pr = this.pressed;
    if (!pr || pr.w !== w) return;
    // the press is on plain figure text: it edits, so the figure never sees it
    if (type !== 'pointerdown' && type !== 'pointerup') ev.preventDefault(); // mousedown: no focus, no selection
    ev.stopImmediatePropagation();
    if (type === 'click') { this.pressed = null; this.openField(pr.fig, pr.node); }
    else if (type === 'dblclick') this.pressed = null;
  };

  // Hold back what would close a tooltip whose text is being edited (or whose
  // link's ✎ the pointer is travelling to): the field and the ✎ live in the
  // top document, so reaching them makes the frame think the pointer left.
  Editor.prototype.onPassive = function (w, ev) {
    if (this.replaying || w === this.win) return;
    var f = this.field, h = this.hover;
    var leave = /(leave|out)$/.test(ev.type), t = ev.target && ev.target.nodeType === 1 ? ev.target : null;
    if (f && f.fig.win === w) {
      if (leave && t) this.hold(w, t, ev);
      ev.stopImmediatePropagation();
      return;
    }
    if (h && h.mode === 'icon' && h.fig.win === w && leave && t && !ev.relatedTarget) {
      this.hold(w, t, ev);
      ev.stopImmediatePropagation();
    }
  };
  Editor.prototype.hold = function (w, t, ev) {
    if (this.held.length > 60) this.held.shift();
    this.held.push({ w: w, el: t, type: ev.type, bubbles: ev.bubbles });
  };
  // Replay held leave events once the pointer is truly outside their element
  // (and not on the ✎ or field). Called on every move and when a field closes.
  Editor.prototype.releaseHeld = function (fromWin) {
    if (!this.held.length || this.field) return;
    var self = this, p = this.pointer, keep = [];
    var onPencil = p && !this.ui.pencil.hidden && inRect(this.ui.pencil.getBoundingClientRect(), p.x, p.y);
    this.held.forEach(function (x) {
      if (!x.el.isConnected) return;
      var inside = p && self.pointInEl(x.w, x.el, p);
      if (x.w === fromWin) { if (!inside) self.replay(x); return; } // the frame is tracking the pointer again
      if (onPencil || inside) keep.push(x); else self.replay(x);
    });
    this.held = keep;
  };
  Editor.prototype.pointInEl = function (w, elm, p) {
    var o = this.toTop(w, 0, 0); if (!o) return false;
    var r = elm.getBoundingClientRect();
    return inRect({ left: r.left + o.x, right: r.right + o.x, top: r.top + o.y, bottom: r.bottom + o.y }, p.x, p.y);
  };
  Editor.prototype.replay = function (x) {
    var w = x.w, C = /^pointer/.test(x.type) ? w.PointerEvent : w.MouseEvent;
    this.replaying = true;
    try { x.el.dispatchEvent(new C(x.type, { bubbles: x.bubbles, cancelable: false, view: w, pointerType: 'mouse' })); } catch (e) { /* gone */ }
    this.replaying = false;
  };

  // ------------------------------------------------------------------ hover
  Editor.prototype.setHover = function (h) {
    clearTimeout(this.leaveTimer); this.leaveTimer = null;
    var old = this.hover;
    if (old && h && old.node === h.node) return;
    if (old && old.hot) old.hot.classList.remove('fte-hot');
    this.hover = h;
    if (h && h.mode === 'click' && h.node.parentElement) { h.hot = h.node.parentElement; h.hot.classList.add('fte-hot'); }
    this.paintSoon();
    if (h) this.loop();
  };
  Editor.prototype.keepHover = function () { clearTimeout(this.leaveTimer); this.leaveTimer = null; };
  Editor.prototype.hoverLeaveSoon = function () {
    var self = this;
    if (!this.hover || this.leaveTimer) return;
    this.leaveTimer = setTimeout(function () { self.leaveTimer = null; self.setHover(null); }, 250);
  };

  // ------------------------------------------------------- in-place editing
  Editor.prototype.openField = function (fig, node) {
    if (this.sending) { this.toast('Wait until this batch is delivered or fails, then edit again.'); return; }
    if (this.field) this.closeField();
    var key0 = fig.previewed.get(node);
    var rec = key0 ? this.store.active(key0) : null;
    var original = rec ? rec.original : coreOf(node);
    var d = describe(fig, node, original);
    rec = this.store.active(d.key) || rec;
    this.setHover(null);
    this.field = { fig: fig, node: node, desc: d, original: original, rec: rec };
    var f = this.ui.field, box = this.nodeBox(fig, node);
    var pe = node.parentElement, cs = fig.win.getComputedStyle(pe);
    var size = isSvg(node) ? Math.max(12, Math.round(((box ? box.bottom - box.top : 16)) * 0.8)) : (parseFloat(cs.fontSize) || 16);
    f.input.style.fontFamily = cs.fontFamily; f.input.style.fontWeight = cs.fontWeight;
    f.input.style.fontStyle = cs.fontStyle; f.input.style.fontSize = size + 'px';
    f.input.value = coreOf(node);
    f.keys.textContent = 'Enter applies · Esc cancels' + (original !== f.input.value ? ' · original: “' + original + '”' : '') +
      (rec && rec.status === 'delivered' ? ' · sent, not yet applied' : '');
    f.root.hidden = false;
    this.placeField(true);
    f.input.focus(); f.input.select();
    this.loop();
  };
  Editor.prototype.placeField = function (resize) {
    var a = this.field; if (!a) return;
    if (!a.node.isConnected || !textRects(a.node).length) {
      this.closeField();
      this.toast('That text left the screen (the figure moved on), so the edit was cancelled.');
      return;
    }
    var b = this.nodeBox(a.fig, a.node);
    if (!b) return; // scrolled out of its frame for now: keep the last position
    var root = this.ui.field.root, input = this.ui.field.input;
    var vw = this.win.innerWidth;
    var w = Math.min(Math.max(b.right - b.left + 40, 160), vw - 16);
    root.style.width = w + 'px';
    root.style.left = Math.max(8, Math.min(b.left - 5, vw - w - 8)) + 'px';
    root.style.top = Math.max(4, b.top - 3) + 'px';
    if (resize) { input.style.height = 'auto'; input.style.height = (input.scrollHeight + 2) + 'px'; }
  };
  Editor.prototype.closeField = function () {
    if (!this.field) return;
    this.field = null;
    this.ui.field.root.hidden = true;
    this.releaseHeld(null);
    this.paintSoon();
  };
  // fromOutside: the reader clicked elsewhere; apply if valid, otherwise drop
  Editor.prototype.commitField = function (fromOutside) {
    var a = this.field; if (!a) return;
    var v = this.ui.field.input.value.replace(/\s*\n\s*/g, ' ');
    if (v.length > MAX_TEXT || !v.trim()) {
      var why = v.trim() ? 'That text is longer than ' + MAX_TEXT + ' characters' : 'Empty text is not allowed';
      if (fromOutside) { this.closeField(); this.toast(why + '; the edit was cancelled.'); }
      else this.toast(why + '; type the new words or press Esc.');
      return;
    }
    var key = a.desc.key, cur = this.store.find(key, 'draft'), del = this.store.find(key, 'delivered');
    var base = del ? del.replacement : a.original;
    var fig = a.fig;
    if (v === base) {
      if (cur) this.store.putDraft(key, null);
    } else if (!cur || cur.replacement !== v) {
      var rec = {
        edit_id: cur ? cur.edit_id : rid('e'), key: key, status: 'draft',
        figure: { id: fig.spec.id, title: fig.spec.title, kind: fig.frame ? 'iframe' : 'inline',
          document: fig.baseline.document, generator: fig.spec.generator || null, exports: fig.spec.exports || [] },
        element: a.desc.element, context: a.desc.context,
        source: (fig.spec.source || function () { return {}; }).call(fig.spec, fig, a.node, a.desc.context),
        original: a.original, replacement: v, baseline: clone(fig.baseline),
        supersedes: del ? { edit_id: del.edit_id, batch_id: del.delivery.batch_id, replacement: del.replacement } : null,
        captured_at: cur ? cur.captured_at : new Date().toISOString(), updated_at: new Date().toISOString()
      };
      this.store.putDraft(key, rec);
      if (this.bridge.state !== 'ready') this.bridge.hello(true);
    }
    this.closeField();
    this.refreshKey(key);
    this.render();
  };
  Editor.prototype.undo = function () {
    var key = this.store.undo();
    if (key) { this.refreshKey(key); this.toast('Undid the last change.'); }
    this.render();
  };
  Editor.prototype.revertKey = function (key) {
    this.store.putDraft(key, null);
    this.refreshKey(key);
    this.render();
  };

  // ---------------------------------------------------------------- sending
  Editor.prototype.send = function () {
    var self = this;
    if (this.sending || this.bridge.state !== 'ready' || !this.store.drafts().length) return;
    if (this.field) this.commitField(true);
    this.sending = true;
    this.setHover(null);
    this.render();
    this.sender.send().then(function (res) {
      self.sending = false;
      if (res.kind === 'delivered') self.figs.forEach(function (f) { self.reconcile(f); });
      self.render();
    });
  };

  // ---------------------------------------------------------------- overlay
  // A text node's line boxes in top-window coordinates, clipped to its frame.
  Editor.prototype.nodeRects = function (fig, node) {
    var off = { x: 0, y: 0 }, clip = null;
    if (fig.frame) {
      var fr = fig.frame.getBoundingClientRect();
      off = { x: fr.left + fig.frame.clientLeft, y: fr.top + fig.frame.clientTop };
      clip = { left: off.x, top: off.y, right: off.x + fig.frame.clientWidth, bottom: off.y + fig.frame.clientHeight };
    }
    var out = [];
    textRects(node).forEach(function (r) {
      var b = { left: r.left + off.x, top: r.top + off.y, right: r.right + off.x, bottom: r.bottom + off.y };
      if (clip) {
        b.left = Math.max(b.left, clip.left); b.top = Math.max(b.top, clip.top);
        b.right = Math.min(b.right, clip.right); b.bottom = Math.min(b.bottom, clip.bottom);
        if (b.right <= b.left || b.bottom <= b.top) return;
      }
      out.push(b);
    });
    return out;
  };
  Editor.prototype.nodeBox = function (fig, node) {
    var rects = this.nodeRects(fig, node);
    if (!rects.length) return null;
    var b = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    rects.forEach(function (r) {
      b.left = Math.min(b.left, r.left); b.top = Math.min(b.top, r.top);
      b.right = Math.max(b.right, r.right); b.bottom = Math.max(b.bottom, r.bottom);
    });
    return b;
  };
  Editor.prototype.paintSoon = function () {
    var self = this;
    if (this.paintQueued) return;
    this.paintQueued = true;
    this.win.requestAnimationFrame(function () { self.paintQueued = false; self.paint(); });
  };
  Editor.prototype.busyPainting = function () {
    return !!(this.hover || this.field || this.figs.some(function (f) { return Object.keys(f.live).length; }));
  };
  // Figures animate (scrolly, walkthrough), so marks are re-placed on a slow tick
  // while anything is drawn; the tick stops when nothing is.
  Editor.prototype.loop = function () {
    var self = this;
    if (this.looping) return;
    this.looping = true;
    (function tick() {
      self.paint(); self.placeField(false);
      if (!self.busyPainting()) { self.looping = false; return; }
      self.win.setTimeout(function () { self.win.requestAnimationFrame(tick); }, 90);
    })();
  };
  Editor.prototype.paint = function () {
    var self = this, layer = this.ui.layer, boxes = [];
    this.figs.forEach(function (fig) {
      Object.keys(fig.live).forEach(function (k) {
        var rec = self.store.active(k), n = fig.live[k];
        if (!rec || !n.isConnected) return;
        if (self.field && self.field.node === n) return;
        self.nodeRects(fig, n).slice(0, 40).forEach(function (b) {
          boxes.push({ b: b, kind: rec.status === 'draft' ? 'edited' : 'delivered' });
        });
      });
    });
    var h = this.hover, pencil = this.ui.pencil, showPencil = false;
    if (h && !this.field && h.node.isConnected) {
      var rs = this.nodeRects(h.fig, h.node);
      rs.slice(0, 40).forEach(function (b) { boxes.push({ b: b, kind: 'hover' }); });
      if (h.mode === 'icon' && rs.length) {
        // raised at the end of the words, like a superscript, so it never covers the next word
        var last = rs[rs.length - 1], vw = this.win.innerWidth;
        var left = last.right + 1;
        if (left + 18 > vw) left = last.right - 18;
        pencil.style.left = left + 'px';
        pencil.style.top = (last.top - 9) + 'px';
        showPencil = true;
      }
    }
    pencil.hidden = !showPencil;
    while (layer.children.length < boxes.length) layer.appendChild(el(this.doc, 'div', 'fte-box'));
    Array.prototype.forEach.call(layer.children, function (d, i) {
      var x = boxes[i];
      if (!x) { d.style.display = 'none'; return; }
      d.style.display = ''; d.setAttribute('data-kind', x.kind);
      d.style.left = (x.b.left - 1) + 'px'; d.style.top = (x.b.top - 1) + 'px';
      d.style.width = (x.b.right - x.b.left + 2) + 'px'; d.style.height = (x.b.bottom - x.b.top + 2) + 'px';
    });
  };

  // --------------------------------------------------------------------- UI
  Editor.prototype.buildUi = function () {
    var self = this, d = this.doc;
    var style = el(d, 'style', 'fte-ui'); style.textContent = CSS; d.head.appendChild(style);
    var layer = el(d, 'div', 'fte-ui fte-layer'); layer.setAttribute('aria-hidden', 'true'); d.body.appendChild(layer);

    // the review tray: only shown once at least one edit exists
    var dock = el(d, 'div', 'fte-ui fte-dock'); dock.hidden = true;
    dock.setAttribute('role', 'region'); dock.setAttribute('aria-label', 'Text edits (local preview)');
    var panel = el(d, 'div', 'fte-panel');
    var head = el(d, 'div', 'fte-head');
    var title = el(d, 'strong', null, 'Text edits');
    var tag = el(d, 'span', 'fte-tag', 'local preview');
    head.appendChild(title); head.appendChild(tag);
    var review = el(d, 'div', 'fte-review'); review.hidden = true;
    var bridge = el(d, 'p', 'fte-bridge'); bridge.setAttribute('aria-live', 'polite');
    var dot = el(d, 'span', 'fte-dot'); var bridgeText = el(d, 'span'); bridge.appendChild(dot); bridge.appendChild(bridgeText);
    var row = el(d, 'div', 'fte-row');
    var undo = el(d, 'button', null, 'Undo'); undo.type = 'button';
    var rev = el(d, 'button', null, 'Review'); rev.type = 'button'; rev.setAttribute('aria-expanded', 'false');
    var send = el(d, 'button', 'fte-primary fte-send', 'Send changes'); send.type = 'button';
    row.appendChild(undo); row.appendChild(rev); row.appendChild(send);
    var result = el(d, 'p', 'fte-result'); result.setAttribute('aria-live', 'polite');
    [head, review, bridge, row, result].forEach(function (x) { panel.appendChild(x); });
    dock.appendChild(panel);
    d.body.appendChild(dock);

    // the in-place field
    var field = el(d, 'div', 'fte-ui fte-field'); field.hidden = true;
    var input = el(d, 'textarea'); input.setAttribute('aria-label', 'Replacement text'); input.spellcheck = true; input.rows = 1;
    var keys = el(d, 'span', 'fte-keys');
    field.appendChild(input); field.appendChild(keys);
    d.body.appendChild(field);

    // the ✎ for links, buttons and page text
    var pencil = el(d, 'button', 'fte-ui fte-pencil', '✎'); pencil.type = 'button'; pencil.hidden = true;
    pencil.setAttribute('aria-label', 'Edit this text'); pencil.title = 'Edit this text';
    d.body.appendChild(pencil);

    var toast = el(d, 'div', 'fte-ui fte-toast'); toast.hidden = true; toast.setAttribute('role', 'status');
    d.body.appendChild(toast);

    undo.addEventListener('click', function () { self.undo(); });
    rev.addEventListener('click', function () { self.reviewOpen = !self.reviewOpen; self.render(); });
    send.addEventListener('click', function () { self.send(); });
    // keep the reader's selection and focus where they are
    pencil.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
    pencil.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      var h = self.hover; if (h && h.node.isConnected) self.openField(h.fig, h.node);
    });
    input.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); self.closeField(); }
      else if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); self.commitField(false); }
    });
    input.addEventListener('input', function () { self.placeField(true); });
    this.win.addEventListener('resize', function () { self.placeField(false); self.paintSoon(); });
    this.ui = { dock: dock, title: title, tag: tag, review: review, bridge: bridge, bridgeText: bridgeText,
      undo: undo, rev: rev, send: send, result: result, layer: layer, pencil: pencil, toastEl: toast,
      field: { root: field, input: input, keys: keys } };
  };

  Editor.prototype.toast = function (msg) {
    var t = this.ui.toastEl;
    t.textContent = msg; t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(function () { t.hidden = true; }, 3600);
  };

  Editor.prototype.render = function () {
    if (!this.ui) return;
    var u = this.ui, st = this.store, b = this.bridge, self = this;
    var drafts = st.drafts(), delivered = st.delivered();
    u.dock.hidden = !drafts.length && !delivered.length;
    u.tag.textContent = 'local preview' + (drafts.length ? ' · ' + drafts.length + ' unsent' : '');

    u.bridge.setAttribute('data-state', b.state);
    u.bridgeText.textContent = b.state === 'ready'
      ? 'Discuss extension connected · sends to “' + b.destination.label + '”'
      : 'Send unavailable: ' + (b.reason || 'the Discuss extension has not answered.') + ' Edits are kept in this browser.';

    u.undo.disabled = !st.state.undo.length || this.sending;
    u.rev.textContent = 'Review' + (drafts.length + delivered.length ? ' (' + (drafts.length + delivered.length) + ')' : '');
    u.rev.setAttribute('aria-expanded', String(!!this.reviewOpen));
    var ob = st.state.outbox;
    var retry = ob && ob.state === 'failed' && ob.print === contentPrint(drafts);
    u.send.textContent = this.sending ? 'Sending…' : retry ? 'Send changes (retry)' : 'Send changes';
    u.send.disabled = this.sending || b.state !== 'ready' || !drafts.length;
    u.send.title = b.state !== 'ready' ? 'Unavailable until the Discuss extension confirms it can take text edits' :
      !drafts.length ? 'No unsent edits' : 'Send ' + drafts.length + ' edit' + (drafts.length === 1 ? '' : 's') + ' to the chat as one batch';

    var res = '', kind = '';
    var last = this.sender.last;
    if (this.sending) { res = 'Sending ' + drafts.length + ' edit' + (drafts.length === 1 ? '' : 's') + ' (batch ' + (ob ? ob.batch_id : '') + ')…'; kind = 'sending'; }
    else if (ob && ob.state === 'failed') {
      res = 'Not delivered: ' + (ob.error ? ob.error.message : 'unknown error') + ' All edits are kept' +
        (retry ? '; Send changes retries the same batch (' + ob.batch_id + ').' : '; the batch changed, so the next send is a new batch.');
      kind = 'failed';
    } else if (last && last.kind === 'failed') { res = 'Not sent: ' + last.error.message; kind = 'failed'; }
    else if (last && last.kind === 'delivered') {
      res = 'Delivered to “' + last.ack.destination.label + '” (message ' + last.ack.accepted.message_ts + (last.ack.deduped ? ', already there' : '') +
        '). Not applied yet: the bots still change the source and rebuild; previews stay until then.' +
        (typeof last.ack.reason === 'string' && last.ack.reason ? ' Note from the chat: ' + last.ack.reason : '');
      kind = 'delivered';
    } else if (delivered.length) {
      res = delivered.length + ' delivered edit' + (delivered.length === 1 ? ' is' : 's are') + ' waiting for the bots to apply and rebuild.';
      kind = 'delivered';
    }
    u.result.textContent = res; u.result.setAttribute('data-kind', kind);

    u.review.hidden = !this.reviewOpen;
    if (this.reviewOpen) this.renderReview(drafts, delivered);
    this.paintSoon();
  };

  Editor.prototype.renderReview = function (drafts, delivered) {
    var self = this, d = this.doc, box = this.ui.review;
    while (box.firstChild) box.removeChild(box.firstChild);
    var item = function (rec, canRevert) {
      var it = el(d, 'div', 'fte-item');
      var top = el(d, 'div', 'fte-itemrow');
      var w = el(d, 'span', 'fte-where', rec.figure.title + (rec.context ? ' · ' + contextLabel(rec.context) : '') +
        (self.figs.some(function (f) { return f.missing[rec.key]; }) ? ' · not on screen now' : ''));
      top.appendChild(w);
      if (canRevert) {
        var rb = el(d, 'button', null, 'Revert'); rb.type = 'button';
        rb.addEventListener('click', function () { self.revertKey(rec.key); });
        top.appendChild(rb);
      }
      it.appendChild(top);
      var line = el(d, 'div');
      line.appendChild(el(d, 'del', null, rec.original));
      line.appendChild(d.createTextNode(' → '));
      line.appendChild(el(d, 'ins', null, rec.replacement));
      it.appendChild(line);
      if (rec.status === 'delivered') it.appendChild(el(d, 'span', 'fte-where', 'Delivered ' + rec.delivery.at.slice(11, 16) + ' UTC to “' + rec.delivery.destination.label + '”, batch ' + rec.delivery.batch_id + ' · not applied yet'));
      box.appendChild(it);
    };
    box.appendChild(el(d, 'h3', null, 'Unsent (' + drafts.length + ')'));
    if (!drafts.length) box.appendChild(el(d, 'p', 'fte-empty', 'No unsent edits.'));
    drafts.forEach(function (r) { item(r, !self.sending); });
    if (delivered.length) {
      box.appendChild(el(d, 'h3', null, 'Delivered, waiting to be applied (' + delivered.length + ')'));
      delivered.forEach(function (r) { item(r, false); });
    }
    if (drafts.length && !this.sending) {
      var disc = el(d, 'button', null, this.confirmDiscard ? 'Click again to discard all unsent' : 'Discard all unsent');
      disc.type = 'button';
      disc.addEventListener('click', function () {
        if (!self.confirmDiscard) { self.confirmDiscard = true; self.render(); return; }
        self.confirmDiscard = false;
        var keys = self.store.drafts().map(function (r) { return r.key; });
        self.store.discardDrafts();
        keys.forEach(function (k) { self.refreshKey(k); });
        self.render();
      });
      box.appendChild(disc);
    }
  };

  // ------------------------------------------------------------------ gates
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  var script = document.currentScript;
  if (!script || !script.hasAttribute('data-fte-local')) return;
  if (!isLoopbackHost(window.location.hostname)) return;
  if (window.top !== window) return;
  function boot() {
    var editor = new Editor(window, global.FigureTextEditorPage || {});
    global.FigureTextEditor = { version: VERSION, editor: editor };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
