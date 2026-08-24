// The article view's client: the drawer, reduced to what a phone needs.
//
// This is the ONLY annotator UI that is not the extension. It runs on a
// server-rendered snapshot of the article (sanitize.mjs) under a strict CSP,
// and it deliberately reuses the extension's own anchor.js — served from
// /assets/anchor.js — rather than reimplementing anchoring. That is the whole
// trick behind "a highlight made on the phone shows up on the Mac": both sides
// store {quote, prefix, suffix} produced by the same buildAnchor, and both
// re-find it with the same locate(). The snapshot is a copy of the prose, so
// the offsets differ; the anchor does not.
//
// No framework, no build step, one file. Everything it needs about the page
// arrives in the #bfp-data island; everything it changes goes through the very
// same JSON endpoints the extension posts to, so there is one write path.
(function () {
  'use strict';
  var A = window.BFPAnchor;
  var D = JSON.parse(document.getElementById('bfp-data').textContent);
  var art = document.getElementById('bfp-article');
  var sheet = document.getElementById('bfp-sheet');
  var sheetBody = sheet.querySelector('.body');
  var sheetHead = sheet.querySelector('.h');
  var pill = document.getElementById('bfp-pill');
  if (!A || !art) return;

  var index = null;              // anchor.js text index over the snapshot
  var open = null;               // {kind:'thread'|'page'|'new', id, anchor}
  var busy = {};                 // target -> a live wait/working note
  var AGENTS = { claude: 1, codex: 1 };
  var MENTION = /@(claude|codex|all)\b/i;
  // WHO THE NEXT MESSAGE IN A THREAD IS FOR — the pill row over the reply box,
  // the phone's half of the drawer's own. Same rule, same words on the wire
  // (`route` on /thread and /reply), and the same reason: a thread is a
  // conversation with somebody, and once the reader has addressed one, retyping
  // "@claude" every turn — or watching the turn become a note when they forget
  // — is the thing that made threads tiring. Unset here means "ask the thread"
  // (stickyRouteOf below), which is also what the companion decides on its own
  // for any client that sends no route at all.
  var ROUTES = { none: 'Note', claude: 'Claude', codex: 'Codex', all: 'All' };
  var picked = {};               // target -> a pill the reader clicked

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // The "▸ more" marker, byte for byte as the drawer and the companion carry
  // it (extension/drawer.js, ../more.mjs): a bot leads with the capped answer
  // and puts the rest after one `<!--more-->` line. Pinned by test/more.test.mjs.

  // ⟦more⟧ begin — byte-identical in extension/drawer.js and reader.js
  var MORE_MARK = /^[ \t]*<!--[ \t]*more[ \t]*-->[ \t]*$/i;
  function splitMore(raw) {
    var s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    if (s.indexOf('<!--') === -1) return { head: s, more: '' };
    var lines = s.split('\n');
    var fence = '', at = -1, tail = [];
    for (var i = 0; i < lines.length; i++) {
      var f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(lines[i]);
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1].charAt(0) === fence.charAt(0) && f[1].length >= fence.length) fence = '';
      } else if (!fence && MORE_MARK.test(lines[i])) {
        if (at < 0) at = i;
        continue;
      }
      if (at >= 0) tail.push(lines[i]);
    }
    if (at < 0) return { head: s, more: '' };
    var head = lines.slice(0, at).join('\n').replace(/\s+$/, '');
    var more = tail.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
    if (!head) return { head: more, more: '' };
    return { head: head, more: more };
  }
  function stripMore(raw) {
    var p = splitMore(raw);
    return p.more ? p.head + '\n\n' + p.more : p.head;
  }
  // ⟦more⟧ end

  function post(path, body) {
    return fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
  }

  // ---- painting ----------------------------------------------------------
  function repaint() {
    (D.threads || []).forEach(function (t) { A.unpaint(t.id); });
    index = A.buildTextIndex(art);
    (D.threads || []).forEach(function (t) {
      var hit = A.locate(index.raw, t);
      if (!hit.ok) return;                       // orphaned here: still listed
      // green for a thread the reader has filed, yellow for one still open —
      // the same two tints anchor.js paints in the drawer, because this view
      // paints with the very same code
      A.paintOffsets(index, hit.start, hit.end, t.id, !!t.resolved);
    });
    // the index is stale the moment we split text nodes to paint into them
    index = A.buildTextIndex(art);
  }

  // ---- the sheet ---------------------------------------------------------
  // What a ```python block printed when the owner ran it, on the Mac. Read-only
  // here: a phone shows results, it never starts them (the Run button lives in
  // the drawer, next to the machine it would run on). Owner-only end to end —
  // a guest sees the message and no output at all, because the output came off
  // somebody's own computer.
  function figSrc(run, name) {
    return '/run-figure?key=' + encodeURIComponent(D.key)
      + '&run=' + encodeURIComponent(run) + '&name=' + encodeURIComponent(name);
  }
  function runsHtml(m) {
    if (!D.me || !D.me.owner || !m.runs) return '';
    var html = '';
    Object.keys(m.runs).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (i) {
      var r = m.runs[i] || {};
      var bad = r.status && r.status !== 'ok';
      var figs = (r.figures || []).map(function (name, n) {
        return '<img src="' + esc(figSrc(r.run_id, name)) + '" alt="figure ' + (n + 1)
          + '" loading="lazy" data-fig="' + esc(figSrc(r.run_id, name)) + '">';
      }).join('');
      html += '<div class="runs"><p class="rhead">block ' + (Number(i) + 1) + ' · ran'
        + (r.python ? ' on python ' + esc(r.python) : '')
        + (bad ? ' · <span class="bad">' + esc(r.status === 'error' ? 'exit ' + r.exit : r.status) + '</span>' : '')
        + '</p>'
        + (String(r.stdout || '').trim() ? '<pre>' + esc(r.stdout) + '</pre>' : '')
        + (String(r.stderr || '').trim() ? '<pre class="rerr">' + esc(r.stderr) + '</pre>' : '')
        + (figs ? '<div class="figs">' + figs + '</div>' : '')
        + '</div>';
    });
    return html;
  }
  function msgHtml(m) {
    if (m.kind === 'tools') {
      return '<details class="tools"><summary>' + esc(m.author) + ' explored</summary><pre>'
        + esc(m.text) + '</pre></details>';
    }
    var cls = AGENTS[m.author] ? ' ' + m.author : '';
    // a capped answer keeps its long half behind a <details>, exactly as the
    // server-rendered page view draws it (views.mjs msgHtml) — same marker,
    // same shape, so a thread reads the same whichever way it is opened
    var cut = splitMore(m.text);
    var body = cut.more
      ? '<pre>' + esc(cut.head) + '</pre>'
        + '<details class="more"><summary>more</summary><pre>' + esc(cut.more) + '</pre></details>'
      : '<pre>' + esc(m.text) + '</pre>';
    return '<div class="msg' + cls + '"><div class="by"><b>' + esc(m.author) + '</b></div>'
      + body + runsHtml(m) + '</div>';
  }

  // the lightbox: a plot at thumbnail size is a picture of a plot, not a plot
  var light = document.getElementById('bfp-light');
  function openLight(src) {
    if (!light) return;
    light.innerHTML = '<img src="' + esc(src) + '" alt="figure">';
    light.classList.add('open');
  }
  function closeLight() {
    if (!light) return;
    light.classList.remove('open');
    light.innerHTML = '';
  }
  if (light) {
    light.addEventListener('click', closeLight);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && light.classList.contains('open')) closeLight();
    });
    document.addEventListener('click', function (e) {
      var img = e.target && e.target.closest && e.target.closest('img[data-fig]');
      if (!img) return;
      e.preventDefault();
      openLight(img.getAttribute('data-fig'));
    });
  }
  function threadById(id) {
    var list = D.threads || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  // The tag a message's own words carry, as a pill name: the strict rule the
  // companion routes by (chat.routePrefix) — one bot named is that bot's, @all
  // or both named is the room's, nothing named is nothing.
  function routeWordOf(text) {
    var found = String(text || '').match(/@(claude|codex|all)\b/gi) || [];
    var tags = [];
    for (var i = 0; i < found.length; i++) {
      var h = found[i].slice(1).toLowerCase();
      if (tags.indexOf(h) === -1) tags.push(h);
    }
    if (!tags.length) return '';
    return (tags.indexOf('all') >= 0 || tags.length > 1) ? 'all' : tags[0];
  }
  // A thread's settled address: the LAST message the reader wrote in it, by
  // what it said or by the `route` the companion stamped on it when a pill said
  // it instead. Bot messages and `tools` narration are not the reader talking.
  // (chat.stickyRoute, on the phone.)
  function stickyRouteOf(msgs) {
    for (var i = (msgs || []).length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (!m || m.kind === 'tools' || AGENTS[String(m.author || '').toLowerCase()]) continue;
      return routeWordOf(m.text) || String(m.route || '').replace(/^@/, '').trim() || 'none';
    }
    return 'none';
  }
  function routeNow(target, msgs) {
    return picked[target] || stickyRouteOf(msgs);
  }
  function routesHtml(target, msgs) {
    var now = routeNow(target, msgs);
    var html = '<div class="routes" role="group" aria-label="who this message is for">';
    for (var k in ROUTES) {
      if (!Object.prototype.hasOwnProperty.call(ROUTES, k)) continue;
      html += '<button type="button" class="rpill' + (k === now ? ' on' : '')
        + '" data-route="' + k + '" aria-pressed="' + (k === now) + '">' + ROUTES[k] + '</button>';
    }
    return html + '</div>';
  }
  // `msgs` present = a comment thread, which is where the pills belong; page
  // chat has a routing rule of its own and gets the composer it always had.
  function composerHtml(placeholder, target, msgs) {
    return '<form class="composer" id="bfp-form">'
      + (msgs ? routesHtml(target, msgs) : '')
      + '<textarea name="text" placeholder="'
      + esc(placeholder) + '" aria-label="' + esc(placeholder) + '"></textarea>'
      + '<div class="row"><button type="submit">send</button>'
      + '<p class="hint">@claude, @codex or @all to bring in the bots</p></div></form>';
  }
  function waitLabel(w) {
    if (w === 'bridge_starting') return '◐ waking the agents…';
    if (w === 'busy') return '◐ queued behind another chat…';
    return '◐ working…';
  }

  function render() {
    if (!open) { sheet.classList.remove('open'); return; }
    var html = '', label = '', target = open.id;
    if (open.kind === 'new') {
      label = 'new comment';
      html = '<blockquote>' + esc(open.anchor.quote) + '</blockquote>'
        + composerHtml('what about this?…', 'new', []);
      target = 'new';
    } else if (open.kind === 'page') {
      label = 'page chat';
      html = (D.page_chat || []).map(msgHtml).join('') + composerHtml('ask about this page…');
      target = '__page__';
    } else {
      var t = threadById(open.id);
      if (!t) { open = null; sheet.classList.remove('open'); return; }
      label = t.resolved ? 'resolved comment' : 'comment';
      // a quote off a PDF carries its page: the same attribution the export
      // writes, in the same words
      html = '<blockquote>' + esc(t.quote)
        + (t.page > 0 ? '<cite> — p. ' + esc(String(t.page)) + '</cite>' : '') + '</blockquote>'
        + (t.orphaned ? '<span class="orphaned">the quoted text is no longer on the page</span>' : '')
        // a filed thread leads with what it settled, exactly as its card does
        // in the drawer and in the comments view
        + (t.resolved && t.summary ? '<p class="digest">' + esc(t.summary) + '</p>' : '')
        + (t.msgs || []).map(msgHtml).join('') + composerHtml('reply…', t.id, t.msgs || []);
    }
    if (busy[target]) html += '<div class="chip">' + esc(busy[target]) + '</div>';
    sheetHead.textContent = label;
    sheetBody.innerHTML = html;
    sheet.classList.add('open');
    var form = document.getElementById('bfp-form');
    if (form) {
      form.addEventListener('submit', onSend);
      // clicking a pill only says where the next message goes: the draft in the
      // box (and the caret in it) survive, so the row is repainted in place
      form.addEventListener('click', function (e) {
        var b = e.target && e.target.closest && e.target.closest('.rpill');
        if (!b) return;
        e.preventDefault();
        picked[open.kind === 'new' ? 'new' : open.id] = b.dataset.route;
        var row = b.parentNode;
        var all = row.querySelectorAll('.rpill');
        for (var i = 0; i < all.length; i++) {
          var on = all[i] === b;
          all[i].classList.toggle('on', on);
          all[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      });
    }
  }

  function onSend(e) {
    e.preventDefault();
    var ta = e.target.querySelector('textarea');
    var text = String(ta.value || '').trim();
    if (!text) return;
    var mode = open.kind;
    var target = mode === 'new' ? 'new' : (mode === 'page' ? '__page__' : open.id);
    // Where this one goes: a tag in the words, else the pill, else the thread's
    // own address. Page chat sends no route at all — its rule is elsewhere.
    var t0 = (mode === 'new' || mode === 'page') ? null : threadById(open.id);
    var route = mode === 'page' ? ''
      : (routeWordOf(text) || routeNow(target, (t0 && t0.msgs) || []));
    ta.value = '';
    // a message with a bot's name on it is a message a bot is about to answer,
    // however that name got there
    if (MENTION.test(text) || (route && route !== 'none')) busy[target] = waitLabel();
    if (route) picked[target] = route;
    render();
    var req = mode === 'new'
      ? post('/thread', {
        url: D.url, quote: open.anchor.quote, prefix: open.anchor.prefix,
        suffix: open.anchor.suffix, page: open.anchor.page || undefined,
        msg: { text: text }, route: route || undefined,
      })
      : post('/reply', { url: D.url, thread_id: target, text: text,
        route: route || undefined });
    req.then(function (r) {
      if (r.status !== 200 || !r.json.ok) {
        busy[target] = (r.json && r.json.error) || 'could not send that';
        render();
        return;
      }
      if (r.json.queued) busy[target] = waitLabel(r.json.wait);
      else if (r.json.reason) busy[target] = r.json.reason;
      else delete busy[target];
      // the new thread's real id is the server's, not ours
      if (mode === 'new' && r.json.thread) {
        // the address the reader picked for the first comment is the thread's
        if (picked.new) picked[r.json.thread.id] = picked.new;
        delete picked.new;
        open = { kind: 'thread', id: r.json.thread.id };
      }
      refetch();
    }).catch(function () {
      busy[target] = 'could not reach the companion';
      render();
    });
  }

  // ---- the record --------------------------------------------------------
  function refetch() {
    return fetch('/page?url=' + encodeURIComponent(D.url), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (p) {
        if (!p || p.page === null) return;
        D.threads = p.threads || [];
        D.page_chat = p.page_chat || [];
        repaint();
        render();
      }).catch(function () { });
  }

  // ---- selection -> a new highlight --------------------------------------
  // "Page 12" is a heading in the snapshot of a PDF and nothing at all in the
  // snapshot of an article, so this answers 0 for every page that has no pages.
  var PAGE_HEAD = /^page\s+(\d{1,5})$/i;
  function pageOfNode(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    var sec = el && el.closest ? el.closest('section') : null;
    var h = sec && sec.querySelector ? sec.querySelector('h2') : null;
    var m = h && PAGE_HEAD.exec(String(h.textContent || '').trim());
    return m ? Number(m[1]) : 0;
  }

  function hidePill() { pill.hidden = true; }
  function onSelect() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hidePill();
    var r = sel.getRangeAt(0);
    if (!art.contains(r.commonAncestorContainer)) return hidePill();
    if (!String(sel).trim()) return hidePill();
    var box = r.getBoundingClientRect();
    pill.style.left = (box.left + box.width / 2) + 'px';
    pill.style.top = (box.top + window.scrollY) + 'px';
    pill.hidden = false;
  }
  pill.addEventListener('click', function () {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var off = A.offsetsFromRange(index, sel.getRangeAt(0));
    var anchor = A.buildAnchor(index.raw, off.start, off.end);
    hidePill();
    sel.removeAllRanges();
    if (!anchor.quote) return;
    // A snapshot of a PDF is per-page sections under a "Page N" heading, and
    // the sanitizer keeps the words while dropping every attribute — so the
    // heading IS the page number, and reading it back is how a highlight made
    // on a phone carries the same "p. 12" one made on the Mac does.
    anchor.page = pageOfNode(sel.getRangeAt(0).startContainer);
    open = { kind: 'new', anchor: anchor };
    render();
  });
  document.addEventListener('selectionchange', function () { setTimeout(onSelect, 0); });

  // ---- taps --------------------------------------------------------------
  art.addEventListener('click', function (e) {
    var mark = e.target.closest && e.target.closest('mark[data-bfp]');
    if (!mark) return;
    e.preventDefault();
    open = { kind: 'thread', id: mark.getAttribute('data-bfp') };
    render();
  });
  document.getElementById('bfp-chat').addEventListener('click', function () {
    open = { kind: 'page' };
    render();
  });
  document.getElementById('bfp-close').addEventListener('click', function () {
    open = null;
    render();
  });

  // ---- export (owner only) ------------------------------------------------
  var exportBtn = document.getElementById('bfp-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      open = null;
      sheetHead.textContent = 'export to obsidian';
      sheetBody.innerHTML = '<button class="pill" data-mode="all">Everything</button> '
        + '<button class="pill" data-mode="comments">Comments only</button>'
        + '<p class="hint">one note per page — re-exporting replaces it</p>';
      sheet.classList.add('open');
      Array.prototype.forEach.call(sheetBody.querySelectorAll('button[data-mode]'), function (b) {
        b.addEventListener('click', function () {
          sheetBody.innerHTML = '<p class="hint">exporting…</p>';
          post('/export', { url: D.url, mode: b.getAttribute('data-mode') }).then(function (r) {
            sheetBody.innerHTML = '<p class="hint">' + esc(r.json && r.json.ok
              ? 'written to ' + r.json.path : (r.json && r.json.error) || 'export failed') + '</p>';
          });
        });
      });
    });
  }

  // ---- live --------------------------------------------------------------
  // Same events the drawer listens to, same meaning. The refetch is the
  // authority; the events only say when to do one.
  try {
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://')
      + location.host + '/ws');
    ws.onmessage = function (e) {
      var d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (!d || d.url !== D.url) return;
      if (d.type === 'page') return void refetch();
      if (d.type !== 'chat') return;
      var target = d.target === '__page__' ? '__page__' : d.target;
      if (d.kind === 'turn-start') { busy[target] = '◐ agents are working…'; render(); return; }
      if (d.kind === 'error') { busy[target] = d.error || 'the agents errored'; render(); return; }
      if (d.kind === 'reply' || d.kind === 'turn-end') {
        delete busy[target];
        refetch();
      }
    };
  } catch (_) { }

  repaint();
})();
