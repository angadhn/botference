/*
 * Figure text editor — LOCAL PREVIEW ONLY.
 *
 * Loaded by _includes/figure-text-editor.html, which renders the <script> tag
 * only under `jekyll serve` in the development environment. This file adds a
 * second gate: it starts only when its tag carries data-fte-local, the page is
 * on a loopback host, and it is the top window. A query parameter cannot turn
 * it on.
 *
 * What it does: an explicit edit mode in which clicking any text in a known
 * figure (SVG labels, HTML labels, walkthrough notes) opens a plain-text field.
 * Applying changes ONE text node's data (never innerHTML), so surrounding
 * formatting is untouched and entered text is never executed. Edits are
 * previews, persisted in localStorage per page, reviewable as a batch, and sent
 * with one "Send changes" button to the Discuss (botference) extension over a
 * versioned window.postMessage protocol. Nothing here writes source: the bots
 * apply each edit to its source file and regenerate exports after receipt.
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
    if (c.tooltip) return 'tooltip for #' + c.tooltip;
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
  var SKIP = 'script, style, textarea, input, select, option, button, title, desc, noscript, template, .fte-ui';

  // Figures this site knows how to trace back to source. `frame` figures are
  // same-origin iframes whose document is the export of a generator; `inline`
  // figures live in a note's own markdown. `context` names the state a dynamic
  // region was showing (a scrolly step, a walkthrough step, an open tooltip),
  // so a preview is re-applied only where it belongs.
  var REGISTRY = [
    {
      id: 'compute-stack', title: 'Compute stack (ground vs orbit)',
      frame: '/assets/imgs/space-data-centers/compute-stack.html', root: '.cs-embed',
      generator: 'assets/imgs/space-data-centers/_build-compute-stack.py',
      exports: ['assets/imgs/space-data-centers/compute-stack.html', 'assets/imgs/space-data-centers/compute-stack.png',
        'assets/imgs/space-data-centers/compute-stack.jpg'],
      context: function (fig, node) {
        if (!closestEl(node, '.cs-card')) return null;
        var a = fig.root.querySelector('.cs-node.is-active');
        return { tooltip: a ? a.id : null };
      },
      source: function (fig, node, ctx) {
        var gen = this.generator;
        if (closestEl(node, '.cs-card')) {
          var field = closestEl(node, 'strong') ? 'title (item 0)' : closestEl(node, 'a') ? 'link label (item 2 of the link tuple)' : 'text (item 1)';
          return { file: gen, locator: 'TIPS["' + (ctx && ctx.tooltip) + '"] ' + field };
        }
        if (closestEl(node, '.cs-hint')) return { file: gen, locator: 'page(): the .cs-hint paragraph' };
        var g = closestEl(node, 'g.cs-node');
        return { file: gen, locator: 'build_svg()' + (g ? ', inside node("' + g.id + '", …)' : ''),
          note: 'T() renders " · " as " ·  " (thin space); match the source text without it.' };
      }
    },
    {
      id: 'ai2040-scrolly', title: 'AI 2040 Plan A scrolly',
      frame: '/assets/imgs/ai-2040/plan-a-scrolly.html', root: '[data-ai2040-embed]',
      generator: 'assets/imgs/ai-2040/_build-scrolly.py',
      exports: ['assets/imgs/ai-2040/plan-a-scrolly.html'],
      exclude: '.ai2040-detail',
      passthrough: '.scrolly-nav, .scrolly-dots button',
      context: function (fig, node) {
        if (!closestEl(node, '.scrolly-card')) return null;
        var dots = Array.prototype.slice.call(fig.root.querySelectorAll('.scrolly-dots button'));
        var i = -1;
        dots.forEach(function (d, j) { if (d.getAttribute('aria-current') === 'true') i = j; });
        var title = i >= 0 ? (dots[i].title || '').replace(/<[^>]*>/g, '') : '';
        return { step: i + 1, of: dots.length, step_index: i, step_title: title };
      },
      source: function (fig, node, ctx) {
        var gen = this.generator, i = ctx ? ctx.step_index : null;
        var card = closestEl(node, '.scrolly-card');
        if (card) {
          var field = closestEl(node, '.card-kicker') ? 'kicker' : closestEl(node, 'h2') ? 'title' :
            closestEl(node, '.card-body') ? 'body' : closestEl(node, '.card-links') ? 'links (label)' : null;
          if (field) return { file: gen, locator: 'scrolly_js STEPS[' + i + '].' + field,
            note: 'title/body are HTML strings; replace only the text, keep the spans.' };
          return { file: gen, locator: 'scrolly_js fillCard(): the generated step hint' };
        }
        if (closestEl(node, '#domainCurves')) return { file: gen, locator: 'layers (the #domainCurves group)' };
        if (closestEl(node, '#workforcePlot')) return { file: gen, locator: 'workforce_layer (the #workforcePlot group)' };
        if (closestEl(node, 'svg') && /AI 2040: Interactive Chart/.test(node.data)) return { file: gen, locator: 'svg_out title replacement' };
        if (closestEl(node, 'svg')) return { file: 'assets/imgs/ai-2040/plan-a-timeline.html',
          locator: 'the timeline SVG (copied verbatim by _build-scrolly.py)', regenerate: gen };
        return { file: gen, locator: 'page template' };
      }
    },
    {
      id: 'epoch-walkthrough', title: 'Epoch chart walkthrough',
      inline: '#epoch-steps', root: '#epoch-steps',
      exclude: '.step-viewer__count, .step-viewer__controls',
      passthrough: '[data-act="prev"], [data-act="next"], [data-act="show-note"], [data-act="hide-note"]',
      context: function (fig, node) {
        if (!closestEl(node, '.step-viewer__note')) return null;
        var c = fig.root.querySelector('.step-viewer__count');
        if (!c || c.hidden) return { step: 'cover' };
        var m = /Step (\d+) of (\d+)/.exec(c.textContent || '');
        return m ? { step: +m[1], of: +m[2] } : { step: null };
      },
      source: function (fig, node, ctx) {
        var file = fig.page.source || '(this note)';
        if (closestEl(node, '.step-viewer__note')) {
          var loc = ctx && ctx.step === 'cover' ? 'cover.note' : 'notes[' + (ctx && ctx.step ? ctx.step - 1 : '?') + ']';
          return { file: file, locator: '<script> walkthrough: ' + loc,
            note: 'A JS string of HTML; replace only the text, keep the tags and escaped quotes.' };
        }
        if (closestEl(node, 'figcaption')) return { file: file, locator: '<figcaption> of #epoch-steps' };
        return { file: file, locator: '#epoch-steps markup' };
      }
    }
  ];

  function closestEl(node, sel) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement || node.parentNode);
    return el && el.closest ? el.closest(sel) : null;
  }
  function isSvg(node) { var el = closestEl(node, '*'); return !!(el && el.namespaceURI === SVG_NS); }
  function eligible(fig, node) {
    if (!node || node.nodeType !== 3 || !node.data.trim()) return false;
    if (!fig.root.contains(node)) return false;
    if (closestEl(node, SKIP)) return false;
    if (fig.spec.exclude && closestEl(node, fig.spec.exclude)) return false;
    return true;
  }
  function eligibleIn(fig, el) {
    var out = [];
    if (!el) return out;
    var w = fig.doc.createTreeWalker(el, 4, null);
    for (var n = w.nextNode(); n; n = w.nextNode()) if (eligible(fig, n)) out.push(n);
    return out;
  }
  function textRects(node) {
    var r = node.ownerDocument.createRange();
    r.selectNodeContents(node);
    return Array.prototype.slice.call(r.getClientRects()).filter(function (b) { return b.width > 0 && b.height > 0; });
  }
  function within(node, x, y) {
    return textRects(node).some(function (b) { return x >= b.left - 3 && x <= b.right + 3 && y >= b.top - 3 && y <= b.bottom + 3; });
  }
  function pickText(fig, x, y, target) {
    var hit = null, doc = fig.doc;
    try {
      if (doc.caretRangeFromPoint) { var r = doc.caretRangeFromPoint(x, y); if (r) hit = r.startContainer; }
      else if (doc.caretPositionFromPoint) { var p = doc.caretPositionFromPoint(x, y); if (p) hit = p.offsetNode; }
    } catch (e) { hit = null; }
    if (hit && eligible(fig, hit) && within(hit, x, y)) return hit;
    var scope = closestEl(target, 'text') || (target && target.nodeType === 1 ? target : closestEl(target, '*'));
    var c = eligibleIn(fig, scope);
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
      var cls = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : '';
      parts.unshift(e.localName + (e.id ? '#' + e.id : cls));
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
    '.fte-ui{--fte-bg:#fffdf6;--fte-ink:#2b2620;--fte-muted:#6f675a;--fte-line:#d8cfbc;--fte-accent:#9a7b52;--fte-ok:#3d6b3a;--fte-bad:#a33b2a;--fte-btn:#2b2620;--fte-btn-ink:#fffdf6;--fte-mark:rgba(216,184,138,.32);',
    'font-family:Baskerville,"Libre Baskerville",Palatino,Georgia,serif;color:var(--fte-ink);font-size:15px;line-height:1.35;box-sizing:border-box}',
    'html[data-theme="dark"] .fte-ui{--fte-bg:#262119;--fte-ink:#ece4d3;--fte-muted:#b0a691;--fte-line:#4a4236;--fte-accent:#c39a68;--fte-ok:#8fc48a;--fte-bad:#ef8f7c;--fte-btn:#ece4d3;--fte-btn-ink:#211d17;--fte-mark:rgba(195,154,104,.28)}',
    '.fte-ui *{box-sizing:border-box}',
    '.fte-ui button{font:inherit;font-size:14px;line-height:1.2;color:var(--fte-ink);background:transparent;border:1px solid var(--fte-line);border-radius:4px;padding:.35rem .65rem;cursor:pointer;min-height:2rem}',
    '.fte-ui button:hover:not(:disabled){border-color:var(--fte-accent)}',
    '.fte-ui button:disabled{opacity:.45;cursor:default}',
    '.fte-ui button:focus-visible{outline:2px solid var(--fte-accent);outline-offset:2px}',
    '.fte-ui .fte-primary{background:var(--fte-btn);color:var(--fte-btn-ink);border-color:var(--fte-btn);font-weight:700}',
    // the site recolours every :focus with !important; keep the editor's own colours (the outline still shows focus)
    '.fte-ui button:focus:not(#fte-x),.fte-ui textarea:focus:not(#fte-x){background:transparent!important;color:var(--fte-ink)!important}',
    '.fte-ui .fte-primary:focus:not(#fte-x){background:var(--fte-btn)!important;color:var(--fte-btn-ink)!important}',
    '.fte-ui .fte-toggle:focus:not(#fte-x){background:var(--fte-bg)!important}',
    '.fte-dock{position:fixed;left:1rem;bottom:1rem;z-index:2147483000;max-width:min(26rem,calc(100vw - 2rem))}',
    '.fte-toggle{background:var(--fte-bg)!important;box-shadow:0 2px 10px rgba(43,38,32,.22);border-radius:999px!important;padding:.45rem .9rem!important}',
    '.fte-badge{display:inline-block;margin-left:.4rem;padding:0 .4rem;border-radius:999px;background:var(--fte-accent);color:var(--fte-btn-ink);font-size:12px;font-weight:700}',
    '.fte-panel{background:var(--fte-bg);border:1px solid var(--fte-line);border-left:4px solid var(--fte-accent);border-radius:4px;box-shadow:0 4px 22px rgba(43,38,32,.25);padding:.7rem .8rem .75rem;width:26rem;max-width:100%}',
    '.fte-panel[hidden],.fte-review[hidden],.fte-toggle[hidden],.fte-pop[hidden]{display:none!important}',
    '.fte-head{display:flex;align-items:baseline;gap:.5rem;margin:0 0 .3rem}',
    '.fte-head strong{font-size:16px}',
    '.fte-head .fte-tag{font-size:12px;font-style:italic;color:var(--fte-muted)}',
    '.fte-head button{margin-left:auto}',
    '.fte-hint{margin:0 0 .5rem;font-size:14px;font-style:italic;color:var(--fte-muted)}',
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
    '.fte-pop{position:fixed;z-index:2147483001;width:min(24rem,calc(100vw - 1.5rem));background:var(--fte-bg);border:1px solid var(--fte-line);border-left:4px solid var(--fte-accent);border-radius:4px;box-shadow:0 4px 22px rgba(43,38,32,.3);padding:.6rem .7rem .65rem}',
    '.fte-pop .fte-where{margin:0 0 .35rem;font-size:12.5px;font-style:italic;color:var(--fte-muted)}',
    '.fte-pop textarea{display:block;width:100%;min-height:2.6rem;resize:vertical;font:inherit;font-size:15px;color:var(--fte-ink);background:transparent;border:1px solid var(--fte-line);border-radius:3px;padding:.35rem .45rem}',
    '.fte-pop textarea:focus{outline:2px solid var(--fte-accent);outline-offset:0}',
    '.fte-pop .fte-orig{margin:.35rem 0 .45rem;font-size:12.5px;color:var(--fte-muted);word-break:break-word}',
    '.fte-pop .fte-row button{min-height:1.9rem}',
    '.fte-pop .fte-keys{margin-right:auto;font-size:12px;color:var(--fte-muted);font-style:italic}',
    '.fte-layer{position:fixed;inset:0;pointer-events:none;z-index:2147482999}',
    '.fte-box{position:fixed;pointer-events:none;border-radius:2px}',
    '.fte-box[data-kind="edited"]{background:var(--fte-mark);border-bottom:2px solid var(--fte-accent)}',
    '.fte-box[data-kind="delivered"]{border-bottom:2px dotted var(--fte-accent)}',
    '.fte-box[data-kind="hover"]{outline:1.5px dashed var(--fte-accent);outline-offset:1px}',
    '.fte-box[data-kind="active"]{outline:2px solid var(--fte-accent);outline-offset:2px}',
    'html.fte-editing [data-fte-root]{outline:2px dashed rgba(154,123,82,.55);outline-offset:4px}',
    // narrow = the VISIBLE width (visualViewport), because a page that overflows sideways
    // widens the layout viewport that fixed positioning and media queries measure
    '.fte-dock.fte-narrow{left:.5rem;right:auto;bottom:.5rem;max-width:none}.fte-narrow .fte-panel{width:auto}.fte-dock.fte-narrow.is-popping{display:none}',
    '.fte-pop.fte-narrow{left:.5rem!important;right:auto!important;top:auto!important;bottom:.5rem!important}'
  ].join('\n');
  var FRAME_CSS = 'html.fte-editing, html.fte-editing *{cursor:text!important}' +
    'html.fte-editing .scrolly-nav, html.fte-editing .scrolly-dots button{cursor:pointer!important}';

  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ------------------------------------------------------------------ editor
  function Editor(win, page) {
    var self = this;
    var doc = win.document;
    this.win = win; this.doc = doc; this.page = page;
    this.figs = [];
    this.editing = false;
    this.store = new Store(safeStorage(win), STORE_PREFIX + win.location.pathname);
    this.bridge = new Bridge(win);
    this.sender = new Sender(this.store, this.bridge, function () { return self.pageInfo(); });
    this.sending = false;
    this.appliedNow = 0;
    this.blocked = [];
    this.buildUi();
    this.bridge.onChange(function () { self.render(); });
    this.discover();
    new win.MutationObserver(function () { self.discover(); }).observe(doc.body, { childList: true, subtree: true });
    win.addEventListener('keydown', function (ev) {
      if (!self.editing || ev.defaultPrevented) return;
      if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && (ev.key === 'z' || ev.key === 'Z') && !closestEl(ev.target, 'textarea, input')) {
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
    REGISTRY.forEach(function (spec) {
      if (spec.inline) {
        var root = doc.querySelector(spec.inline);
        if (root && !self.figFor(root)) self.attach(spec, root, null);
      }
      if (spec.frame) {
        Array.prototype.forEach.call(doc.querySelectorAll('iframe'), function (f) {
          if (f.__fteSpec) return;
          var u; try { u = new URL(f.getAttribute('src') || '', self.win.location.href); } catch (e) { return; }
          if (u.origin !== self.win.location.origin) return;
          // by path, or by an explicit opt-in naming a registry entry (a copied or moved export)
          if (u.pathname !== spec.frame && f.getAttribute('data-figure-editable') !== spec.id) return;
          f.__fteSpec = spec;
          var tryAttach = function () {
            var d; try { d = f.contentDocument; } catch (e) { return; }
            var root = d && d.querySelector(spec.root);
            if (!root) return;
            // one live attachment per frame: the same document is already handled;
            // a reloaded document replaces the old attachment and its observer
            var old = self.figs.filter(function (g) { return g.frame === f; })[0];
            if (old && old.root === root) return;
            if (old) { old.observer.disconnect(); self.figs.splice(self.figs.indexOf(old), 1); }
            self.attach(spec, root, f);
          };
          f.addEventListener('load', tryAttach);
          tryAttach();
        });
      }
    });
    // A future figure can opt in without a registry entry.
    Array.prototype.forEach.call(doc.querySelectorAll('[data-figure-editable]:not(iframe)'), function (root) {
      if (self.figFor(root)) return;
      var id = root.getAttribute('data-figure-editable') || root.id || 'figure';
      self.attach({ id: id, title: root.getAttribute('data-figure-title') || id, root: null,
        source: function (fig) { return { file: root.getAttribute('data-figure-source') || (fig.page.source || '(this page)'), locator: '#' + (root.id || id) }; } }, root, null);
    });
  };
  Editor.prototype.figFor = function (root) { return this.figs.filter(function (f) { return f.root === root; })[0] || null; };

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
      fdoc.documentElement.classList.toggle('fte-editing', this.editing);
    }
    this.block(fwin, fdoc);
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
  Editor.prototype.reconcile = function (fig, initial) {
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
    if (applied) { this.appliedNow += applied; this.render(); }
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
      self.reconcile(fig, false);
    });
  };

  // ------------------------------------------- edit mode: capture all input
  Editor.prototype.block = function (fwin, fdoc) {
    if (this.blocked.indexOf(fwin) >= 0) return;
    this.blocked.push(fwin);
    var self = this;
    var figAt = function (t) {
      if (!t || typeof t.nodeType !== 'number') return null;
      for (var i = 0; i < self.figs.length; i++) { var f = self.figs[i]; if (f.win === fwin && f.root.contains(t)) return f; }
      return null;
    };
    var frameOwned = fwin !== self.win;
    var handler = function (ev) {
      if (!self.editing) return;
      var t = ev.target;
      if (t && t.nodeType === 3) t = t.parentNode;
      if (t && typeof t.nodeType === 'number' && closestEl(t, '.fte-ui')) return;
      var fig = figAt(t);
      if (!fig && !frameOwned) return;
      var pass = fig && fig.spec.passthrough && closestEl(t, fig.spec.passthrough);
      var type = ev.type;
      if (pass && (type === 'click' || type === 'pointerdown' || type === 'pointerup' || type === 'mousedown' || type === 'mouseup')) return;
      if (type === 'keydown') {
        if (pass || !(ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Escape')) return;
      }
      if (type === 'pointermove' || type === 'mousemove') {
        if (fig && ev.pointerType !== 'touch') self.hoverAt(fig, ev.clientX, ev.clientY, ev.target);
      }
      if (type !== 'focus' && type !== 'blur' && type !== 'focusin' && type !== 'focusout' &&
          type !== 'pointermove' && type !== 'mousemove' && type.indexOf('touch') !== 0) ev.preventDefault();
      ev.stopImmediatePropagation();
      if (type === 'click' && fig) self.clickAt(fig, ev.clientX, ev.clientY, ev.target);
    };
    ['click', 'dblclick', 'auxclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup',
      'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
      'pointermove', 'mousemove', 'focus', 'blur', 'focusin', 'focusout', 'keydown', 'submit']
      .forEach(function (type) { fwin.addEventListener(type, handler, true); });
    fwin.addEventListener('scroll', function () { self.paintSoon(); }, true);
  };

  Editor.prototype.setEditing = function (on) {
    var self = this;
    this.editing = !!on;
    this.doc.documentElement.classList.toggle('fte-editing', this.editing);
    this.figs.forEach(function (f) { if (f.frame) f.doc.documentElement.classList.toggle('fte-editing', self.editing); });
    if (!this.editing) { this.closePop(); this.hover = null; }
    if (this.editing && this.bridge.state !== 'ready') this.bridge.hello(true);
    this.render();
    this.loop();
  };

  Editor.prototype.hoverAt = function (fig, x, y, target) {
    var n = pickText(fig, x, y, target);
    this.hover = n ? { fig: fig, node: n } : null;
    this.paintSoon();
  };
  Editor.prototype.clickAt = function (fig, x, y, target) {
    if (this.sending) { this.flash('Wait until this batch is delivered or fails, then edit again.'); return; }
    var n = pickText(fig, x, y, target);
    if (!n) { this.flash('Click directly on the words you want to change.'); return; }
    this.openPop(fig, n);
  };

  // ---------------------------------------------------------------- popover
  Editor.prototype.openPop = function (fig, node) {
    var self = this;
    var shownCore = coreOf(node);
    var key0 = fig.previewed.get(node);
    var rec = key0 ? this.store.active(key0) : null;
    var original = rec ? rec.original : shownCore;
    var d = describe(fig, node, original);
    rec = this.store.active(d.key) || rec;
    this.active = { fig: fig, node: node, desc: d, original: original, rec: rec };
    var p = this.ui.pop;
    var occ = d.element.occurrence.count > 1 ? ' · ' + d.element.occurrence.index + ' of ' + d.element.occurrence.count + ' identical' : '';
    p.where.textContent = fig.spec.title + ' · ' + (d.element.kind === 'svg-text' ? 'SVG label' : 'text') +
      (d.context ? ' · ' + contextLabel(d.context) : '') + occ;
    p.input.value = rec ? rec.replacement : original;
    p.input.rows = Math.min(8, Math.max(2, Math.ceil(p.input.value.length / 42)));
    p.orig.textContent = 'Original: “' + original + '”' + (rec && rec.status === 'delivered' ? ' · delivered as “' + rec.replacement + '”, not yet applied' : '');
    p.revert.hidden = !(rec && rec.status === 'draft');
    p.root.hidden = false;
    this.ui.dock.classList.add('is-popping');
    this.placePop();
    p.input.focus(); p.input.select();
    this.paintSoon();
  };
  Editor.prototype.placePop = function () {
    if (!this.active) return;
    var p = this.ui.pop.root, r = this.nodeBox(this.active.fig, this.active.node);
    if (this.fit() || !r) { p.style.left = ''; p.style.top = ''; return; }
    var w = p.offsetWidth, h = p.offsetHeight, vw = this.win.innerWidth, vh = this.win.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - w - 8));
    var top = r.bottom + 10;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 10);
    p.style.left = left + 'px'; p.style.top = top + 'px';
  };
  // Returns true on a narrow screen, after sizing the dock and popover to what is visible.
  Editor.prototype.fit = function () {
    var vv = this.win.visualViewport, w = Math.round(vv ? vv.width : this.win.innerWidth);
    var narrow = w <= 600;
    [this.ui.dock, this.ui.pop.root].forEach(function (e) {
      e.classList.toggle('fte-narrow', narrow);
      e.style.width = narrow ? (w - 16) + 'px' : '';
    });
    return narrow;
  };
  Editor.prototype.closePop = function () {
    this.active = null;
    if (this.ui) { this.ui.pop.root.hidden = true; this.ui.dock.classList.remove('is-popping'); }
    this.paintSoon();
  };
  Editor.prototype.applyPop = function (revert) {
    var a = this.active; if (!a) return;
    var v = revert ? a.original : this.ui.pop.input.value;
    if (a.desc.element.kind === 'svg-text') v = v.replace(/\s*\n\s*/g, ' ');
    if (v.length > MAX_TEXT) { this.flash('That text is longer than ' + MAX_TEXT + ' characters.'); return; }
    if (!v.trim() && !revert) { this.flash('Empty text is not allowed; type the new words or Cancel.'); return; }
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
    }
    this.closePop();
    this.refreshKey(key);
    this.render();
  };
  Editor.prototype.undo = function () {
    var key = this.store.undo();
    if (key) { this.refreshKey(key); this.flash('Undid the last change.'); }
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
    this.closePop();
    this.sending = true;
    this.render();
    this.sender.send().then(function (res) {
      self.sending = false;
      if (res.kind === 'delivered') self.figs.forEach(function (f) { self.reconcile(f, false); });
      self.render();
    });
  };

  // ---------------------------------------------------------------- overlay
  Editor.prototype.nodeBox = function (fig, node) {
    var rects = textRects(node);
    if (!rects.length) return null;
    var off = { x: 0, y: 0 }, clip = null;
    if (fig.frame) {
      var fr = fig.frame.getBoundingClientRect();
      off = { x: fr.left + fig.frame.clientLeft, y: fr.top + fig.frame.clientTop };
      clip = { left: off.x, top: off.y, right: off.x + fig.frame.clientWidth, bottom: off.y + fig.frame.clientHeight };
    }
    var b = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    rects.forEach(function (r) {
      b.left = Math.min(b.left, r.left + off.x); b.top = Math.min(b.top, r.top + off.y);
      b.right = Math.max(b.right, r.right + off.x); b.bottom = Math.max(b.bottom, r.bottom + off.y);
    });
    if (clip) {
      b.left = Math.max(b.left, clip.left); b.top = Math.max(b.top, clip.top);
      b.right = Math.min(b.right, clip.right); b.bottom = Math.min(b.bottom, clip.bottom);
      if (b.right <= b.left || b.bottom <= b.top) return null;
    }
    return b;
  };
  Editor.prototype.paintSoon = function () {
    var self = this;
    if (this.paintQueued) return;
    this.paintQueued = true;
    this.win.requestAnimationFrame(function () { self.paintQueued = false; self.paint(); });
  };
  Editor.prototype.loop = function () {
    var self = this;
    if (this.looping || !this.editing) return;
    this.looping = true;
    (function tick() {
      if (!self.editing) { self.looping = false; self.paint(); return; }
      self.paint(); self.placePop();
      self.win.setTimeout(function () { self.win.requestAnimationFrame(tick); }, 80);
    })();
  };
  Editor.prototype.paint = function () {
    var self = this, layer = this.ui.layer, boxes = [];
    if (this.editing) {
      this.figs.forEach(function (fig) {
        Object.keys(fig.live).forEach(function (k) {
          var rec = self.store.active(k), n = fig.live[k];
          if (!rec || !n.isConnected) return;
          var b = self.nodeBox(fig, n);
          if (b) boxes.push({ b: b, kind: rec.status === 'draft' ? 'edited' : 'delivered' });
        });
      });
      if (this.hover && this.hover.node.isConnected) { var hb = this.nodeBox(this.hover.fig, this.hover.node); if (hb) boxes.push({ b: hb, kind: 'hover' }); }
      if (this.active && this.active.node.isConnected) { var ab = this.nodeBox(this.active.fig, this.active.node); if (ab) boxes.push({ b: ab, kind: 'active' }); }
    }
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

    var dock = el(d, 'div', 'fte-ui fte-dock');
    dock.setAttribute('role', 'region'); dock.setAttribute('aria-label', 'Figure text editor (local preview)');
    var toggle = el(d, 'button', 'fte-toggle'); toggle.type = 'button';
    var toggleText = el(d, 'span', null, '✎ Edit figure text'); var badge = el(d, 'span', 'fte-badge');
    toggle.appendChild(toggleText); toggle.appendChild(badge);
    var panel = el(d, 'div', 'fte-panel'); panel.hidden = true;
    var head = el(d, 'div', 'fte-head');
    head.appendChild(el(d, 'strong', null, 'Editing figure text'));
    head.appendChild(el(d, 'span', 'fte-tag', 'local preview'));
    var done = el(d, 'button', null, 'Done'); done.type = 'button'; head.appendChild(done);
    var hint = el(d, 'p', 'fte-hint');
    var review = el(d, 'div', 'fte-review'); review.hidden = true;
    var bridge = el(d, 'p', 'fte-bridge'); bridge.setAttribute('aria-live', 'polite');
    var dot = el(d, 'span', 'fte-dot'); var bridgeText = el(d, 'span'); bridge.appendChild(dot); bridge.appendChild(bridgeText);
    var row = el(d, 'div', 'fte-row');
    var undo = el(d, 'button', null, 'Undo'); undo.type = 'button';
    var rev = el(d, 'button', null, 'Review'); rev.type = 'button'; rev.setAttribute('aria-expanded', 'false');
    var send = el(d, 'button', 'fte-primary fte-send', 'Send changes'); send.type = 'button';
    row.appendChild(undo); row.appendChild(rev); row.appendChild(send);
    var result = el(d, 'p', 'fte-result'); result.setAttribute('aria-live', 'polite');
    [head, hint, review, bridge, row, result].forEach(function (x) { panel.appendChild(x); });
    dock.appendChild(panel); dock.appendChild(toggle);
    d.body.appendChild(dock);

    var pop = el(d, 'div', 'fte-ui fte-pop'); pop.hidden = true;
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Edit figure text');
    var where = el(d, 'p', 'fte-where');
    var input = el(d, 'textarea'); input.setAttribute('aria-label', 'Replacement text'); input.spellcheck = true;
    var orig = el(d, 'p', 'fte-orig');
    var prow = el(d, 'div', 'fte-row');
    var keys = el(d, 'span', 'fte-keys', 'Enter applies · Esc cancels');
    var cancel = el(d, 'button', null, 'Cancel'); cancel.type = 'button';
    var revert = el(d, 'button', null, 'Revert'); revert.type = 'button';
    var apply = el(d, 'button', 'fte-primary', 'Apply'); apply.type = 'button';
    [keys, cancel, revert, apply].forEach(function (x) { prow.appendChild(x); });
    [where, input, orig, prow].forEach(function (x) { pop.appendChild(x); });
    d.body.appendChild(pop);

    toggle.addEventListener('click', function () { self.setEditing(true); });
    done.addEventListener('click', function () { self.setEditing(false); });
    undo.addEventListener('click', function () { self.undo(); });
    rev.addEventListener('click', function () { self.reviewOpen = !self.reviewOpen; self.render(); });
    send.addEventListener('click', function () { self.send(); });
    cancel.addEventListener('click', function () { self.closePop(); });
    revert.addEventListener('click', function () { self.applyPop(true); });
    apply.addEventListener('click', function () { self.applyPop(false); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); self.closePop(); }
      else if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); self.applyPop(false); }
    });
    this.win.addEventListener('resize', function () { self.fit(); self.placePop(); self.paintSoon(); });
    if (this.win.visualViewport) this.win.visualViewport.addEventListener('resize', function () { self.fit(); self.placePop(); });
    this.win.addEventListener('scroll', function () { self.placePop(); self.paintSoon(); }, { passive: true });
    this.ui = { dock: dock, toggle: toggle, toggleText: toggleText, badge: badge, panel: panel, hint: hint, review: review,
      bridge: bridge, bridgeText: bridgeText, undo: undo, rev: rev, send: send, result: result, layer: layer,
      pop: { root: pop, where: where, input: input, orig: orig, revert: revert } };
  };

  Editor.prototype.flash = function (msg) {
    var self = this;
    this.flashMsg = msg; this.render();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(function () { self.flashMsg = null; self.render(); }, 3200);
  };

  Editor.prototype.render = function () {
    if (!this.ui) return;
    var u = this.ui, st = this.store, b = this.bridge, self = this;
    var drafts = st.drafts(), delivered = st.delivered();
    var hasFigs = this.figs.length > 0;
    u.dock.hidden = !hasFigs && !drafts.length && !delivered.length;
    u.panel.hidden = !this.editing;
    this.fit();
    u.toggle.hidden = this.editing;
    u.toggleText.textContent = drafts.length ? '✎ Figure text' : '✎ Edit figure text';
    u.badge.textContent = drafts.length ? drafts.length + ' unsent' : '';
    u.badge.hidden = !drafts.length;

    var steppers = this.figs.filter(function (f) { return f.spec.passthrough; }).length;
    u.hint.textContent = this.flashMsg || (this.sending ? 'Sending… editing is paused until the extension answers.' :
      'Click any label or note in a figure to change its words. Links, tooltips and play are paused' +
      (steppers ? '; the step arrows still move between steps.' : '.'));

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
    u.send.title = b.state !== 'ready' ? 'Unavailable until the Discuss extension confirms it can take figure edits' :
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
    if (this.appliedNow) res = (res ? res + ' ' : '') + this.appliedNow + ' earlier edit' + (this.appliedNow === 1 ? ' is' : 's are') + ' now in the source (applied).';
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
    global.FigureTextEditor = {
      version: VERSION,
      enter: function () { editor.setEditing(true); },
      exit: function () { editor.setEditing(false); },
      editor: editor
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
