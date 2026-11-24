// config.js — WHERE the companion is, and WHO we are to it.
//
// Round 5: the companion may be somewhere other than this machine. Three
// settings decide everything about the wire, all of them in
// chrome.storage.local and all of them editable on the options page:
//
//   bfp:companion   base url of the companion   (default http://127.0.0.1:4189)
//   bfp:password    shared password; '' = a local companion with no auth
//   bfp:handle      display name/handle this browser signs its messages with
//
// Loaded by background.js (importScripts), by options.html (a plain script
// tag), and as a content script ahead of drawer.js and content.js (for the
// connection's one list of modes and words, CONN_MODES, and the figure-edit
// batch's, FTE_STATES). Nothing in here touches the network or the DOM, and nothing in here
// reads chrome.* except the two explicit storage helpers at the bottom — so
// the whole file runs in node, which is where test/adapters.test.mjs unit-tests
// it (normalizeBase · wsUrlFor · authHeaders · sanitizeHandle · isLocal).
//
// The single rule the rest of the extension relies on: a password turns the
// companion into a MULTI-USER one. Then, and only then, every request carries
// `Authorization: Bearer <password>` + `x-plugin-handle: <handle>`, and the WS
// carries the same two as query params (a WebSocket cannot send headers).
// No cookies are involved in either direction, and no new host permission is
// needed for a remote https companion — the hosted companion answers the CORS
// preflight itself, which is what grants the background worker's fetch.
(function (root) {
  'use strict';

  const DEFAULT_BASE = 'http://127.0.0.1:4189';
  // A new client must never send a draft request as ordinary chat to an old
  // companion. Unknown dedicated routes fail visibly instead of summoning a
  // general-purpose artifact builder with the wrong output directory.
  function commandRoute(method, route, body) {
    if (String(method).toUpperCase() !== 'POST') return route;
    const text = route === '/thread' ? body?.msg?.text : body?.text;
    if (!/^\/draft-blog(?:\s|$)/i.test(String(text || '').trim())) return route;
    return route === '/reply' ? '/draft-blog' : route === '/thread' ? '/draft-blog/thread' : route;
  }
  function commandError(route, status) {
    return (route === '/draft-blog' || route === '/draft-blog/thread') && status === 404
      ? 'The running Discuss companion does not support this draft command. Restart or update the companion, then retry. Nothing was sent to the bots.'
      : '';
  }

  // ── is the extension in touch with the companion? ─────────────────────────
  // ONE list of modes, and ONE set of words for them, for every layer that
  // keeps or shows the connection: the worker's live socket (background.js
  // wsState), the drawer's header dot and its notices (drawer.js D.conn), and
  // what content.js relays between them. Nothing else names these states.
  //   'connecting' — not known yet, or trying again
  //   'connected'  — the companion answered
  //   'offline'    — it did not (after a couple of quick second chances, for
  //                  the drawer; the socket simply closed, for the worker)
  //   'reload'     — the extension was updated under this tab: nothing here
  //                  can reach the companion until the tab is reloaded. Final.
  //   'signin'     — the companion sits behind Cloudflare Access and this browser has not
  //                  signed in (or its sign-in ran out): the answer was Cloudflare's, not the
  //                  companion's. Not an outage: the drawer offers one button that opens the
  //                  companion's address in a tab, and everything resumes once signed in.
  const CONN_MODES = Object.freeze(['connecting', 'connected', 'offline', 'reload', 'signin']);
  // …the words shown for each (the header dot), and the two notices built on them
  const CONN_WORDS = Object.freeze({
    connecting: 'connecting…', connected: 'connected', offline: 'companion offline', reload: 'reload this tab',
    signin: 'sign-in needed',
  });
  const CONN_NOTICE = Object.freeze({
    offline: 'Companion offline — the plugin needs its local server:',
    reload: 'Discuss was updated — reload this tab to reconnect.',
    signin: 'Sign-in needed — this companion asks you to sign in first.',
  });
  // …and every way it changes, with the modes each move may start from:
  //   retry  — connecting|connected|offline → connecting (a fresh try)
  //   reach  — connecting|connected|offline → connected
  //   fail   — connecting|connected → offline
  //   unload — any → reload
  //   deny   — anything but reload → signin (the answer was Cloudflare's sign-in, not the companion's)
  //   (a signin tab is also left by retry and reach; a dropped socket does not leave it, so fail does not start from it)
  const CONN_MOVES = Object.freeze({
    retry: ['connecting', 'connected', 'offline', 'signin'],
    reach: ['connecting', 'connected', 'offline', 'signin'],
    fail: ['connecting', 'connected'],
    deny: ['connecting', 'connected', 'offline', 'signin'],
    unload: CONN_MODES,
  });
  const CONN_TO = { retry: 'connecting', reach: 'connected', fail: 'offline', deny: 'signin', unload: 'reload' };
  const canConnMove = (mode, move) => !!CONN_MOVES[move] && CONN_MOVES[move].indexOf(mode) !== -1;
  // Pure: (mode, move) → mode. An unknown move, or one from a mode it does not
  // start from, throws — callers that hear from the outside world ask
  // canConnMove first and drop the move (a late answer after a reload, say).
  function connMove(mode, move) {
    if (!CONN_MOVES[move]) throw new Error('connection: no such move ' + move);
    if (!canConnMove(mode, move)) throw new Error('connection: cannot ' + move + ' while ' + mode);
    return CONN_TO[move];
  }

  // ── a figure-edit batch on its way into the chat ──────────────────────────
  // The blog's figure-text editor hands content.js a batch of edits
  // (content.js fteSend). Each batch keeps ONE value, `state`, one of
  // FTE_STATES, changed only by fteBatchMove; the worker's ledger
  // (background.js fteLedger) stores the same word, so a batch survives this
  // script being reloaded. Shared here because both of them keep it.
  //   'inflight' — being routed / posted now
  //   'acked'    — it became a chat message (or was all written into the
  //                post); `ack` is what the editor was told. Final.
  //   'failed'   — the companion refused it or did not answer; may be sent again
  // …and every way it changes ('none' = no batch yet; never stored):
  //   send — none | failed | inflight → inflight  (inflight: a send whose
  //          script was reloaded mid-way; the one still running in THIS
  //          script is joined, never sent twice — content.js checks `mine`)
  //   ack  — inflight → acked, `arg` = the ack
  //   fail — inflight → failed
  // A ledger entry from before this list was named used these same three
  // words; anything else reads as 'failed' (fteState), which may be resent.
  const FTE_STATES = Object.freeze(['inflight', 'acked', 'failed']);
  const FTE_MOVES = Object.freeze({
    send: Object.freeze(['none', 'inflight', 'failed']),
    ack: Object.freeze(['inflight']),
    fail: Object.freeze(['inflight']),
  });
  const FTE_TO = { send: 'inflight', ack: 'acked', fail: 'failed' };
  // (an 'acked' entry that lost its ack has nothing to answer with, so it too
  // reads as 'failed' and may be sent again — fteFindPosted keeps that from
  // posting the same text twice)
  const fteState = e => (!e ? 'none'
    : FTE_STATES.indexOf(e.state) === -1 || (e.state === 'acked' && !e.ack) ? 'failed' : e.state);
  const canFteMove = (e, move) => !!FTE_MOVES[move] && FTE_MOVES[move].indexOf(fteState(e)) !== -1;
  // The one way it changes. `send` makes the batch afresh from `arg` (its
  // fields) and returns it; ack / fail change `e` in place and return it. An
  // unknown move, or one from the wrong state, throws.
  function fteBatchMove(e, move, arg) {
    if (!FTE_MOVES[move]) throw new Error('figure-edit batch: no such move ' + move);
    if (!canFteMove(e, move)) throw new Error('figure-edit batch: cannot ' + move + ' while ' + fteState(e));
    if (move === 'send') return Object.assign({}, arg || {}, { state: FTE_TO.send, ack: null });
    e.state = FTE_TO[move];
    if (move === 'ack') e.ack = arg || null;
    return e;
  }

  // ── is this page a Blygger post? ──────────────────────────────────────────
  // ONE list of what Discuss knows about the page's blyg status, shared by the
  // drawer (D.blyg.mode, moved only by its blygSet) and the companion
  // (blyg.mjs: a page record's status and a highlight's stamp use these same
  // words). Nothing else names these states.
  //   'unknown'      — nobody has asked yet (a fresh page, or a record made
  //                    before Discuss knew about Blygger)
  //   'checking'     — the companion is asking the page's site right now
  //   'blyg'         — this page is one post of a blyg, identified and verified
  //   'blyg-site'    — this page belongs to a blyg but is not one post (its
  //                    front page, an index, a collection)
  //   'not-a-blyg'   — the site answered, and it is not a blyg
  //   'check-failed' — the question could not be answered (offline, refused,
  //                    too slow, malformed, or did not verify); may be asked again
  const BLYG_MODES = Object.freeze(['unknown', 'checking', 'blyg', 'blyg-site', 'not-a-blyg', 'check-failed']);
  const BLYG_SETTLED = Object.freeze(['blyg', 'blyg-site', 'not-a-blyg', 'check-failed']);
  // …and where each may go next. An answer arrives only while checking, or
  // straight from 'unknown' when the companion already holds one for this
  // page. A settled answer is replaced only by asking again (→ 'checking'),
  // never by another answer out of nowhere. Any mode may go back to 'unknown':
  // the tab moved to another page without reloading.
  const BLYG_MOVES = Object.freeze({
    unknown: Object.freeze(['checking'].concat(BLYG_SETTLED)),
    checking: Object.freeze(['unknown'].concat(BLYG_SETTLED)),
    blyg: Object.freeze(['unknown', 'checking']),
    'blyg-site': Object.freeze(['unknown', 'checking']),
    'not-a-blyg': Object.freeze(['unknown', 'checking']),
    'check-failed': Object.freeze(['unknown', 'checking']),
  });
  const canBlygMove = (from, to) => !!BLYG_MOVES[from] && BLYG_MOVES[from].indexOf(to) !== -1;
  // Pure: (mode, next) → next. A mode that is not named, or a move the table
  // does not allow, throws; callers hearing from the outside world (a late
  // answer for a page the tab has left) ask canBlygMove first and drop it.
  function blygMove(from, to) {
    if (BLYG_MODES.indexOf(to) === -1) throw new Error('blyg status: no such mode ' + to);
    if (!canBlygMove(from, to)) throw new Error('blyg status: cannot go from ' + from + ' to ' + to);
    return to;
  }

  // ── Publish as blyg: what the DRAWER is showing ───────────────────────────
  // One field (D.pub.view), one of PUB_VIEWS, moved only by pubMove's table. The RUN itself lives on the companion
  // (blyg-run.mjs RUN_MODES: drafted, preparing, planning, planned, applying, applied, publishing, published, failed_<step>,
  // cancelled, abandoned, interrupted_<mode>); this list is the drawer's own, and pubViewOf says which view a run's mode is shown in.
  //   closed      nothing is open
  //   choosing    the owner is choosing a scope ("just this comment", "this and the ones above")
  //   starting    the start request is out (the note is being written)
  //   waiting     a run was found that this drawer did not start (a reload, another tab): one button to review it
  //   working     prepare (when the owner set one) or plan is running
  //   confirming  the note and the plan are on screen; Publish or Cancel
  //   running     apply, then publish, are running
  //   done        published
  //   problem     a refusal, a failed step, or an interrupted run: what happened, and what may be done
  const PUB_VIEWS = Object.freeze(['closed', 'choosing', 'starting', 'waiting', 'working', 'confirming', 'running', 'done', 'problem']);
  const PUB_MOVES = Object.freeze({
    closed: Object.freeze(['choosing', 'waiting']),
    choosing: Object.freeze(['starting', 'problem', 'closed']),
    starting: Object.freeze(['working', 'problem']),
    waiting: Object.freeze(['closed', 'working', 'confirming', 'running', 'done', 'problem']),
    working: Object.freeze(['confirming', 'running', 'problem', 'closed']),
    confirming: Object.freeze(['running', 'problem', 'closed']),
    running: Object.freeze(['done', 'problem', 'closed']),
    done: Object.freeze(['closed']),
    problem: Object.freeze(['closed', 'working', 'running']),
  });
  const canPubMove = (from, to) => !!PUB_MOVES[from] && PUB_MOVES[from].indexOf(to) !== -1;
  function pubMove(from, to) {
    if (PUB_VIEWS.indexOf(to) === -1) throw new Error('publish view: no such view ' + to);
    if (!canPubMove(from, to)) throw new Error('publish view: cannot go from ' + from + ' to ' + to);
    return to;
  }
  // the companion's run mode → the view it is shown in
  const PUB_VIEW_OF = Object.freeze({ idle: 'closed', drafted: 'working', preparing: 'working', planning: 'working', planned: 'confirming', applying: 'running',
    applied: 'running', publishing: 'running', published: 'done', cancelled: 'closed', abandoned: 'closed',
    // a failed or interrupted run, whichever step (the step is part of the mode's name): 'problem'
    failed_prepare: 'problem', failed_plan: 'problem', failed_apply: 'problem', failed_publish: 'problem',
    interrupted_drafted: 'problem', interrupted_preparing: 'problem', interrupted_planning: 'problem', interrupted_planned: 'problem',
    interrupted_applying: 'problem', interrupted_applied: 'problem', interrupted_publishing: 'problem', interrupted_unknown: 'problem' });
  // `confirm` ('never' | 'always', the companion's setting as carried on the run): with 'never' the run does not stop at
  // `planned`, so that moment is still "running", not a confirmation to press
  const pubViewOf = (mode, confirm) => (mode === 'planned' && confirm === 'never' ? 'running' : (PUB_VIEW_OF[mode] || 'problem'));
  // The operations the drawer may ask of the companion for a publish, and nothing else: the worker forwards these and only
  // these (the generic `api` message refuses every /blyg-publish and /blyg-home path). `offer`: 'grants' = a successful answer
  // opens this tab's one-use offer; 'needs' = the worker forwards it only while the tab holds an offer, and spends it.
  const BLYG_PUBLISH_OPS = Object.freeze({
    start: Object.freeze({ method: 'POST', path: '/blyg-publish/start', offer: 'grants', body: ['url', 'thread_id', 'scope', 'confirm'] }),
    run: Object.freeze({ method: 'GET', path: '/blyg-publish/run', offer: 'none', body: [] }),
    resume: Object.freeze({ method: 'GET', path: '/blyg-publish/run', offer: 'grants', body: [] }),
    confirm: Object.freeze({ method: 'POST', path: '/blyg-publish/confirm', offer: 'needs', body: ['run', 'token'] }),
    retry: Object.freeze({ method: 'POST', path: '/blyg-publish/retry', offer: 'needs', body: ['run', 'token'] }),
    continue: Object.freeze({ method: 'POST', path: '/blyg-publish/continue', offer: 'needs', body: ['run', 'token', 'stop'] }),
    cancel: Object.freeze({ method: 'POST', path: '/blyg-publish/cancel', offer: 'none', body: ['run', 'token'] }),
    abandon: Object.freeze({ method: 'POST', path: '/blyg-publish/abandon', offer: 'none', body: ['run', 'token'] }),
  });
  const BLYG_PUBLISH_SCOPES = Object.freeze(['one', 'above']);

  // ── whether an exported note is a RESPONSE to its page ─────────────────
  // Blygger's "stub" (spec §10.6). One field on the page record,
  // export_response, one of RESPONSE_MODES. The reader's explicit choice, once
  // made on a page, is what counts. Until then the default comes from the
  // page: a note made from a Blygger post's own page is nearly always a reply
  // to it, so there it is 'response'; everywhere else 'not-a-response'. The
  // default is derived, never stored, and derived HERE only: the companion's
  // export and draft and the drawer's export chooser all call responseOf.
  // `liveBlygMode` is the drawer's own blyg check (BLYG_MODES), which can know
  // the page is a post a moment before the record says so.
  const RESPONSE_MODES = Object.freeze(['not-a-response', 'response']);
  function responseOf(page, liveBlygMode) {
    if (page && RESPONSE_MODES.indexOf(page.export_response) !== -1) return page.export_response;
    const post = (page && page.blyg && page.blyg.status === 'blyg') || liveBlygMode === 'blyg';
    return page && post ? 'response' : 'not-a-response';
  }

  // ── where an exported note goes ────────────────────────────────────────
  // The export has two TARGETS, named here once for the companion (which
  // renders them, studio-paste.mjs renderTarget) and the drawer (which offers
  // them):
  //   'vault'  — the note written into the owner's Obsidian vault, with YAML
  //              front matter that only the owner's own site reads. The
  //              default, and what every export wrote before there was a choice.
  //   'studio' — markdown for pasting into Blygger Studio's compose screen: no
  //              front matter, Studio's own grammar. Copied to the clipboard,
  //              never written to disk, sent nowhere.
  // An unknown name is refused (exportTargetOf says so), never guessed.
  const EXPORT_TARGETS = Object.freeze(['vault', 'studio']);
  const DEFAULT_EXPORT_TARGET = 'vault';
  function exportTargetOf(value) {
    if (value === undefined || value === null || value === '') return { target: DEFAULT_EXPORT_TARGET, refused: '' };
    if (EXPORT_TARGETS.indexOf(value) !== -1) return { target: value, refused: '' };
    return { target: DEFAULT_EXPORT_TARGET,
      refused: 'export target ' + JSON.stringify(String(value)).slice(0, 60) + ' is not one of ' + EXPORT_TARGETS.join(', ') };
  }

  // ── Following: the settings of the private reading feed ────────────────────
  // Named values, each with a default and a range, kept in the companion's
  // config.json under these exact keys. A value that is missing, not a whole
  // number or out of range is NOT used: the default stands and followingSettingsOf
  // says which key was refused, so a hand-edit never makes the companion
  // refresh every second or hold a million items. `my_origins` is a list of
  // blyg origins (web addresses) that are the reader's own, which is what
  // "responses to me" means; each is normalised to the WHATWG form with a
  // trailing slash, anything that is not an http(s) address is refused.
  const FOLLOWING_NUMBERS = Object.freeze({
    following_refresh_minutes: Object.freeze({ dflt: 30, min: 5, max: 1440, what: 'minutes between refreshes' }),
    following_max_items_per_blyg: Object.freeze({ dflt: 200, min: 10, max: 2000, what: 'unread items held per blyg' }),
    following_max_items_total: Object.freeze({ dflt: 2000, min: 50, max: 20000, what: 'unread items held in all' }),
    following_unread_target: Object.freeze({ dflt: 50, min: 1, max: 500, what: 'unread posts a refresh tries to have in the Feed (it reads further back in each blyg to reach it)' }),
    following_run_seconds: Object.freeze({ dflt: 60, min: 5, max: 600, what: 'seconds one refresh may take' }),
    following_run_requests: Object.freeze({ dflt: 200, min: 5, max: 2000, what: 'requests one refresh may make' }),
    following_feed_clip_words: Object.freeze({ dflt: 300, min: 50, max: 2000, what: 'words a post may have before the Feed clips it (a fragment is never clipped)' }),
    following_barely_changed_percent: Object.freeze({ dflt: 2, min: 0, max: 20, what: 'percent of a post that may change and still count as barely changed (0 = identical words only)' }),
  });
  // …and three more. `following_barely_changed_percent` is the reader-local threshold of
  // spec 13.2 for "a barely changed version" (0 = only an identical content_hash is
  // maintenance); it is never advertised anywhere. `inbox_api_url` (https only) and
  // `inbox_token_file` (an absolute path; the token is the file's first line and is never
  // kept in settings) name the owner's own mentions inbox.
  const MY_ORIGINS_MAX = 100;
  function inboxUrlOf(raw) {
    if (raw === undefined || raw === null || raw === '') return { value: '', refused: false };
    let u;
    try { u = new URL(String(raw).trim()); } catch { return { value: '', refused: true }; }
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || String(raw).length > 500) return { value: '', refused: true };
    return { value: u.href, refused: false };
  }
  function tokenFileOf(raw) {
    if (raw === undefined || raw === null || raw === '') return { value: '', refused: false };
    const s = String(raw).trim();
    if (!/^(\/|[A-Za-z]:[\\/])/.test(s) || /[\u0000-\u001f]/.test(s) || s.length > 1000) return { value: '', refused: true };
    return { value: s, refused: false };
  }
  function originOf(raw) {
    let u;
    try { u = new URL(String(raw == null ? '' : raw).trim()); } catch { return ''; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.search = ''; u.hash = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.href;
  }
  // → { settings: {every key above, my_origins}, refused: [key, …] }
  function followingSettingsOf(cfg) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const settings = {};
    const refused = [];
    for (const k of Object.keys(FOLLOWING_NUMBERS)) {
      const spec = FOLLOWING_NUMBERS[k];
      const v = c[k];
      if (v === undefined || v === null || v === '') { settings[k] = spec.dflt; continue; }
      if (typeof v === 'number' && Number.isInteger(v) && v >= spec.min && v <= spec.max) settings[k] = v;
      else { settings[k] = spec.dflt; refused.push(k); }
    }
    const list = c.my_origins === undefined || c.my_origins === null ? [] : c.my_origins;
    const mine = [];
    if (!Array.isArray(list)) refused.push('my_origins');
    else {
      for (const o of list.slice(0, MY_ORIGINS_MAX)) {
        const n = originOf(o);
        if (!n) { if (refused.indexOf('my_origins') === -1) refused.push('my_origins'); continue; }
        if (mine.indexOf(n) === -1) mine.push(n);
      }
      if (list.length > MY_ORIGINS_MAX && refused.indexOf('my_origins') === -1) refused.push('my_origins');
    }
    settings.my_origins = mine;
    const th = tokenFileOf(c.hub_theme_dir); settings.hub_theme_dir = th.value; if (th.refused) refused.push('hub_theme_dir');
    const iu = inboxUrlOf(c.inbox_api_url); settings.inbox_api_url = iu.value; if (iu.refused) refused.push('inbox_api_url');
    const tf = tokenFileOf(c.inbox_token_file); settings.inbox_token_file = tf.value; if (tf.refused) refused.push('inbox_token_file');
    return { settings, refused };
  }

  // ── how long a request to the companion may take ──────────────────────────
  // Every one-shot request has a limit; none may wait for ever. Most are a
  // read or a small write on this machine and answer in milliseconds, so 30s
  // is already a companion that is not answering. The few below do real work
  // before they answer (a recording to transcribe, a commit, an export, a
  // preview build, a search, a chat copied into the council …) and get three
  // minutes. The live event socket is not a request: it is checked by its
  // heartbeat instead (background.js SOCKET_SILENT_MS).
  const REQUEST_MS = 30000;
  const SLOW_REQUEST_MS = 180000;
  const SLOW_ROUTES = ['/transcribe', '/tidy', '/publish', '/export', '/suggest-preview', '/suggest-accept',
    '/suggest-accept-all', '/lasso', '/summarize', '/project-create', '/project-chat',
    '/continue-in-council', '/pdf-annotations', '/page-image', '/snapshot', '/send-review',
    '/make-artifact', '/run', '/fte-route', '/blog-page', '/blog-image', '/files', '/relay',
    '/fresh', '/delete-page', '/page-chat-new', '/page-chat-open', '/question', '/question-revise',
    '/model', '/effort', '/key-mode', '/draft-blog', '/draft-blog/thread'];
  const routeOf = p => String(p || '').split('?')[0];
  const requestLimitMs = (method, path) =>
    (SLOW_ROUTES.indexOf(routeOf(path)) !== -1 ? SLOW_REQUEST_MS : REQUEST_MS);
  // …and, when one runs out, what it was, in the reader's words: the line the
  // drawer shows says WHAT did not go through, and that it can be tried again
  const REQUEST_WHAT = {
    'POST /reply': 'your message', 'POST /thread': 'your comment', 'POST /draft-blog': 'your message',
    'POST /draft-blog/thread': 'your comment', 'POST /edit': 'your edit', 'POST /delete': 'the delete',
    'POST /interrupt': 'the stop', 'POST /resolve': 'resolving the comment', 'POST /tick': 'the tick',
    'POST /export': 'the export', 'POST /export-studio': 'the copy for Blygger Studio', 'POST /transcribe': 'the dictation', 'POST /run': 'running the code',
    'POST /publish': 'the publish', 'POST /send-review': 'sending the review', 'POST /page': 'saving this page',
    'POST /snapshot': 'saving the page text', 'POST /rename-page': 'the rename', 'POST /tag-page': 'the tag',
    'POST /delete-page': 'the delete', 'POST /model': 'the model change', 'POST /effort': 'the effort change',
    'GET /page': 'loading this page', 'GET /index': 'loading your pages', 'GET /lasso': 'the search',
  };
  function requestWhat(method, path) {
    const m = String(method || 'GET').toUpperCase();
    return REQUEST_WHAT[m + ' ' + routeOf(path)] || (m === 'GET' ? 'loading that' : 'that change');
  }
  // "Your message did not go through — the companion took too long. Try again."
  function timeoutLine(method, path) {
    const w = requestWhat(method, path);
    return w.charAt(0).toUpperCase() + w.slice(1) + ' did not go through — the companion took too long. Try again.';
  }

  // bfp:pdf is the one setting here that is not about the wire: whether a web
  // PDF is opened in Discuss's own viewer (so it can be annotated) or left to
  // the browser's. Stored the same way as the rest because it is read in the
  // same two places — the worker, which installs the redirect rule, and the
  // options page, which is where it is turned off.
  const KEYS = { base: 'bfp:companion', password: 'bfp:password', handle: 'bfp:handle', learned: 'bfp:learned-auth',
                 pdf: 'bfp:pdf', readerUrl: 'bfp:reader-url', onboarding: 'bfp:reader-onboarding' };
  // absent means on: an extension installed before this existed should still
  // open PDFs in the viewer, because that is the feature
  const readBool = (v, dflt) => (v === undefined || v === null ? !!dflt : !!v);

  // Control characters are stripped everywhere rather than escaped: these
  // values end up in HTTP headers and in a WS query string, and a stray \r\n
  // in a password field must never be able to write a header of its own.
  const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim();

  // EXACTLY the companion's own rule (server: lowercase, [^\\w-] -> '-', <=40).
  // It has to be exact, because the name the SERVER stamps on a message is what
  // the drawer compares against to decide whether that message is the reader's
  // own: "Mira K" typed on the options page must become the same "mira-k" the
  // server stores, or the edit affordance would vanish from your own comments.
  // It also happens to make the handle header-safe (latin-1, no control
  // characters, no line breaks, nothing to inject with).
  const HANDLE_MAX = 40;
  function sanitizeHandle(raw) {
    return clean(raw).toLowerCase().replace(/[^\w-]/g, '-').slice(0, HANDLE_MAX);
  }

  const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];

  // '  companion.example.com/plugin/  ' → 'https://companion.example.com/plugin'
  // A bare host:port that IS this machine keeps http (nobody runs TLS on
  // 127.0.0.1); anything else is assumed to be a real host and gets https,
  // because a password typed into a cleartext field is the one mistake this
  // function can prevent. Junk (a file: url, an empty box) comes back '' and
  // callers fall back to the default.
  function normalizeBase(raw) {
    let s = clean(raw);
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)) {
      const host = s.split('/')[0].split(':')[0].toLowerCase();
      s = (LOCAL_HOSTS.indexOf(host) !== -1 ? 'http://' : 'https://') + s;
    }
    let u;
    try { u = new URL(s); } catch { return ''; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname) return '';
    // query and hash are not part of a base; a trailing slash is not either,
    // because every path in the API already starts with one
    const path = u.pathname.replace(/\/+$/, '');
    return u.protocol + '//' + u.host + path;
  }

  function isLocal(base) {
    const b = normalizeBase(base) || DEFAULT_BASE;
    let u;
    try { u = new URL(b); } catch { return false; }
    return LOCAL_HOSTS.indexOf(u.hostname.toLowerCase()) !== -1;
  }

  // http→ws, https→wss, same host, same path prefix, `/ws` on the end. The
  // credentials ride as query params because the WebSocket constructor cannot
  // set headers — the same two values the fetches send as headers.
  function wsUrlFor(base, password, handle) {
    const b = normalizeBase(base) || DEFAULT_BASE;
    let u;
    try { u = new URL(b + '/ws'); } catch { return ''; }
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const pw = clean(password);
    if (pw) {
      u.searchParams.set('auth', pw);
      const h = sanitizeHandle(handle);
      if (h) u.searchParams.set('handle', h);
    }
    return u.toString();
  }

  // No password ⇒ a local single-user companion that wants no headers at all.
  function authHeaders(password, handle) {
    const pw = clean(password);
    if (!pw) return {};
    const out = { Authorization: 'Bearer ' + pw };
    const h = sanitizeHandle(handle);
    if (h) out['x-plugin-handle'] = h;
    return out;
  }

  // ── which reader the feed icon opens ───────────────────────────────────────
  // `reader_url` (bfp:reader-url): empty, or an absolute https address (http only for this machine: localhost, 127.0.0.1, [::1]). Empty,
  // the default, means the companion's own Hub (/hub on the configured companion address); set, it is a reader the person already has
  // (a Blygger Studio's reading page, say) and the feed icon and the options link open THAT in a new tab.
  //   READER_MODES  companion-hub — the Hub on the companion
  //                 external      — the address in reader_url
  // …decided in one function, readerTarget. Which of them was CHOSEN is remembered as a named onboarding state:
  //   ONBOARDING    unasked  — nothing chosen yet (the default)
  //                 hub      — "use the built-in Hub" was chosen
  //                 external — "I already read blygs somewhere" was chosen (and an address saved)
  // …moved only by onboardingMove. What the icon does on a click is one of READER_ACTIONS, worked out by readerAction:
  //   choose        — nothing is set, nothing chosen, and the Hub follows no blyg yet: ask which reader, rather than open an empty page
  //   open-hub      — open the companion's Hub
  //   open-external — open reader_url
  const READER_MODES = Object.freeze(['companion-hub', 'external']);
  const ONBOARDING = Object.freeze(['unasked', 'hub', 'external']);
  const ONBOARDING_MOVES = Object.freeze({
    'choose-hub': Object.freeze({ unasked: 'hub', hub: 'hub', external: 'hub' }),
    'choose-external': Object.freeze({ unasked: 'external', hub: 'external', external: 'external' }),
    forget: Object.freeze({ unasked: 'unasked', hub: 'unasked', external: 'unasked' }),
  });
  const READER_ACTIONS = Object.freeze(['choose', 'open-hub', 'open-external']);
  // → { value, refused }: value '' for empty or refused
  function readerUrlOf(raw) {
    const s = clean(raw);
    if (!s) return { value: '', refused: false };
    let u;
    try { u = new URL(s); } catch { return { value: '', refused: true }; }
    if (u.username || u.password) return { value: '', refused: true };
    if (u.protocol === 'https:') return { value: u.href, refused: false };
    if (u.protocol === 'http:' && LOCAL_HOSTS.indexOf(u.hostname.toLowerCase()) !== -1) return { value: u.href, refused: false };
    return { value: '', refused: true };
  }
  const onboardingOf = v => (ONBOARDING.indexOf(v) === -1 ? 'unasked' : v);
  function onboardingMove(state, move) {
    const table = ONBOARDING_MOVES[move];
    if (!table) throw new Error('reader onboarding: no such move ' + move);
    if (ONBOARDING.indexOf(state) === -1 || !Object.prototype.hasOwnProperty.call(table, state)) throw new Error('reader onboarding: cannot ' + move + ' while ' + state);
    return table[state];
  }
  // → { mode, url }: where the feed icon (and the options page's link) goes
  function readerTarget(cfg) {
    const ext = readerUrlOf(cfg && cfg.reader_url).value;
    return ext ? { mode: 'external', url: ext } : { mode: 'companion-hub', url: httpUrl((cfg && cfg.base) || DEFAULT_BASE, '/hub') };
  }
  // WHO MAY CHANGE THE READER. A web page can reach the drawer's controls (its shadow root is open) and a content script cannot tell a
  // click from a page's pretend one by the message alone, so a reader choice is accepted only for a chooser the background itself offered
  // (answering a click on the feed icon that really was the person's), in that one tab, once, within a few minutes. The options page is
  // the other way to change it and needs no such offer (it writes storage itself). offers(): offer(tab) · valid(tab) · spend(tab).
  const OFFER_MS = 5 * 60 * 1000;
  function createOffers(now) {
    const clock = typeof now === 'function' ? now : Date.now;
    const open = new Map();   // tab id -> the moment its offer lapses
    return {
      offer: tab => { if (tab !== null && tab !== undefined) open.set(tab, clock() + OFFER_MS); },
      valid: tab => open.has(tab) && open.get(tab) > clock(),
      spend: tab => { const ok = open.has(tab) && open.get(tab) > clock(); open.delete(tab); return ok; },
    };
  }
  // What the options page saves for what was typed in the reader box: an address is the external reader (and was chosen), an empty box
  // is the companion's Hub (and was chosen); anything else is refused and nothing changes. → { ok, reader_url, reader_onboarding, error }
  function readerChoiceFrom(raw, onboarding) {
    const v = readerUrlOf(raw);
    if (v.refused) return { ok: false, error: 'That is not an address I can open: use https (http only for this computer), or leave it empty for the built-in Hub.' };
    return { ok: true, reader_url: v.value, reader_onboarding: onboardingMove(onboardingOf(onboarding), v.value ? 'choose-external' : 'choose-hub') };
  }
  // `followed`: how many blygs the companion's Hub follows (null when it could not be asked)
  function readerAction(cfg, followed) {
    if (readerTarget(cfg).mode === 'external') return 'open-external';
    if (onboardingOf(cfg && cfg.reader_onboarding) === 'unasked' && followed === 0) return 'choose';
    return 'open-hub';
  }

  // ── a companion behind Cloudflare Access ──────────────────────────────────
  // The person signs in once in an ordinary tab at the companion's address; Cloudflare sets its cookie for that host and the
  // browser sends it on the extension's requests when they say credentials 'include' (the manifest's host permission is what lets
  // the worker do that). A request that is not signed in is answered by Cloudflare with a redirect to its login page, which a
  // manual-redirect fetch reports as 'opaqueredirect': never followed, never read.
  //   requestInit(base)  the fetch options a remote companion needs; none for this machine
  //   replyKind(...)     what an answer IS, one of REPLY_KINDS:
  //     'data'    the companion's own answer (also its own refusals, which have words of their own)
  //     'signin'  not the companion's: a redirect, Cloudflare's page, or the companion's own "sign-in required" (401 with signin:true)
  //     'refused' signed in but not allowed (Cloudflare's own 403 page): signing in again will not help
  const REPLY_KINDS = Object.freeze(['data', 'signin', 'refused']);
  const requestInit = base => (isLocal(base) ? {} : { credentials: 'include', redirect: 'manual' });
  function replyKind(res, text) {
    const status = Number(res && res.status) || 0;
    if (res && (res.type === 'opaqueredirect' || (status >= 300 && status < 400))) return 'signin';
    const ctype = String((res && res.contentType) || '').toLowerCase();
    const body = String(text == null ? '' : text);
    const htmlBody = /^\s*<(?:!doctype|html|head|body)/i.test(body);
    if (ctype.indexOf('application/json') !== -1) {
      if (status === 401) { try { if (JSON.parse(body).signin === true) return 'signin'; } catch (_) { /* not ours */ } }
      return 'data';
    }
    // not JSON: the companion's API never answers an API call with a page. Cloudflare does.
    if (ctype.indexOf('text/html') !== -1 || htmlBody) {
      if (status === 403) return 'refused';
      if (status === 200 || status === 401) return 'signin';
    }
    return 'data';
  }
  // what GET /auth-mode said: 'password' | 'access' | 'either', or '' when unknown. A sign-in answer means Access is in front.
  function authModeOf(res, text) {
    const kind = replyKind(res, text);
    if (kind === 'signin') return 'access';
    if (kind !== 'data' || Number(res && res.status) !== 200) return '';
    try { const a = JSON.parse(String(text)).auth; return a === 'password' || a === 'access' || a === 'either' ? a : ''; } catch (_) { return ''; }
  }
  const showPasswordField = mode => mode !== 'access';
  // WHAT THIS COMPANION USES, and so whether the saved password may be sent to it: ONE list, one move function, one record per address.
  //   unknown   not asked yet: no password is sent
  //   asking    GET /auth-mode is under way (without a password)
  //   unclear   asked, and the answer was not the companion's own (a captive portal, a proxy, an http hop): no password is sent; it is
  //             asked again once the wait is over (`ask` leaves this mode; the worker says when)
  //   password  the companion itself answered, and it is not Access (password or either): the password is sent
  //   access    the companion itself said Access: the password is never sent again
  // Only an answer the companion gave ITSELF moves the mode (companionAnswer): JSON from the companion, never a bare redirect or a page.
  // 'access' is the only mode written down (KEYS.learned, for that address) and no answer lowers it: it is left only by `forget`, which
  // is the person's own Save on the options page. A password companion is therefore never locked out by something in the way.
  const COMPANION_MODES = Object.freeze(['unknown', 'asking', 'unclear', 'password', 'access']);
  const COMPANION_MOVES = Object.freeze({
    ask: { from: ['unknown', 'unclear'], to: 'asking' },
    sayPassword: { from: ['asking'], to: 'password' },
    sayAccess: { from: ['unknown', 'asking', 'unclear', 'password'], to: 'access' },
    unclear: { from: ['asking'], to: 'unclear' },
    forget: { from: COMPANION_MODES, to: 'unknown' },
  });
  const canCompanionMove = (mode, move) => !!COMPANION_MOVES[move] && COMPANION_MOVES[move].from.indexOf(mode) !== -1;
  function companionMove(mode, move) {
    if (!COMPANION_MOVES[move]) throw new Error('companion: no such move ' + move);
    if (!canCompanionMove(mode, move)) throw new Error('companion: cannot ' + move + ' while ' + mode);
    return COMPANION_MOVES[move].to;
  }
  // what an answer says the companion uses: 'access' | 'password' | 'unclear'. Only the companion's own JSON counts.
  function companionAnswer(res, text) {
    const status = Number(res && res.status) || 0;
    if (!/application\/json/i.test(String((res && res.contentType) || '')) || status >= 500 || status < 200) return 'unclear';
    let d = null;
    try { d = JSON.parse(String(text)); } catch (_) { return 'unclear'; }
    if (!d || typeof d !== 'object') return 'unclear';
    if (status === 401 && d.signin === true) return 'access';
    if (status === 200 && d.auth === 'access') return 'access';
    return 'password';   // its own answer, and not Access (password, either, or an older companion that has no /auth-mode)
  }
  const learnedOf = (rec, base) => (rec && rec.mode === 'access' && rec.base === (normalizeBase(base) || DEFAULT_BASE) ? 'access' : '');
  // the password that may be sent: this machine's companion gets it as always; a remote one only once it has said it uses one
  const passwordToSend = (cfg, mode) => ((cfg && isLocal(cfg.base)) || mode === 'password' ? clean(cfg && cfg.password) : '');

  const httpUrl = (base, path) =>
    (normalizeBase(base) || DEFAULT_BASE) + String(path == null ? '' : path);

  // ---- storage (the only chrome.* in this file) ---------------------------
  function readConfig(area) {
    const store = area || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
    const fallback = { base: DEFAULT_BASE, password: '', handle: '', auth_learned: '', pdf: true, reader_url: '', reader_onboarding: 'unasked' };
    if (!store) return Promise.resolve(fallback);
    return new Promise(resolve => {
      try {
        store.get([KEYS.base, KEYS.password, KEYS.handle, KEYS.learned, KEYS.pdf, KEYS.readerUrl, KEYS.onboarding], r => {
          const got = r || {};
          resolve({
            base: normalizeBase(got[KEYS.base]) || DEFAULT_BASE,
            password: clean(got[KEYS.password]),
            handle: sanitizeHandle(got[KEYS.handle]),
            auth_learned: learnedOf(got[KEYS.learned], got[KEYS.base]),
            pdf: readBool(got[KEYS.pdf], true),
            reader_url: readerUrlOf(got[KEYS.readerUrl]).value,
            reader_onboarding: onboardingOf(got[KEYS.onboarding]),
          });
        });
      } catch { resolve(fallback); }
    });
  }

  function writeConfig(cfg, area) {
    const store = area || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
    const out = {
      [KEYS.base]: normalizeBase(cfg && cfg.base) || DEFAULT_BASE,
      [KEYS.password]: clean(cfg && cfg.password),
      [KEYS.handle]: sanitizeHandle(cfg && cfg.handle),
      [KEYS.pdf]: readBool(cfg && cfg.pdf, true),
      [KEYS.readerUrl]: readerUrlOf(cfg && cfg.reader_url).value,
      [KEYS.onboarding]: onboardingOf(cfg && cfg.reader_onboarding),
    };
    if (!store) return Promise.resolve(out);
    return new Promise(resolve => {
      try { store.set(out, () => resolve(out)); } catch { resolve(out); }
    });
  }

  function rememberAccess(base, area) {
    const store = area || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
    const rec = { base: normalizeBase(base) || DEFAULT_BASE, mode: 'access' };
    if (!store) return Promise.resolve(rec);
    return new Promise(resolve => { try { store.set({ [KEYS.learned]: rec }, () => resolve(rec)); } catch { resolve(rec); } });
  }
  function forgetAccess(area) {
    const store = area || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
    if (!store) return Promise.resolve();
    return new Promise(resolve => { try { store.remove(KEYS.learned, () => resolve()); } catch { resolve(); } });
  }

  const api = {
    DEFAULT_BASE, KEYS, HANDLE_MAX,
    normalizeBase, wsUrlFor, authHeaders, sanitizeHandle, isLocal, httpUrl,
    readConfig, writeConfig,
    commandRoute, commandError,
    REPLY_KINDS, requestInit, replyKind, authModeOf, showPasswordField, passwordToSend, learnedOf, rememberAccess, forgetAccess,
    COMPANION_MODES, COMPANION_MOVES, canCompanionMove, companionMove, companionAnswer,
    CONN_MODES, CONN_WORDS, CONN_NOTICE, CONN_MOVES, connMove, canConnMove,
    FTE_STATES, FTE_MOVES, fteState, fteBatchMove, canFteMove,
    BLYG_MODES, BLYG_SETTLED, BLYG_MOVES, canBlygMove, blygMove,
    RESPONSE_MODES, responseOf,
    PUB_VIEWS, PUB_MOVES, canPubMove, pubMove, pubViewOf, BLYG_PUBLISH_OPS, BLYG_PUBLISH_SCOPES,
    EXPORT_TARGETS, DEFAULT_EXPORT_TARGET, exportTargetOf,
    READER_MODES, ONBOARDING, ONBOARDING_MOVES, READER_ACTIONS, readerUrlOf, onboardingOf, onboardingMove, readerChoiceFrom, readerTarget, readerAction, createOffers, OFFER_MS,
    FOLLOWING_NUMBERS, MY_ORIGINS_MAX, followingSettingsOf, originOf,
    REQUEST_MS, SLOW_REQUEST_MS, requestLimitMs, requestWhat, timeoutLine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPConfig = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
