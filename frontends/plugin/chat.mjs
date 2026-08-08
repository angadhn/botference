// Bridge adapter for the web annotator, adapted from frontends/review/chat.mjs.
// Runs ONE botference_ink_bridge.py child (lazily, on the first @-mention) and
// turns browser comments into bot turns. Each annotated page gets its own
// botference session under project "Plugin pages"; the adapter walks the
// session choreography (/project create → /project open → /new → /rename, or
// /resume for a page seen before) as queued control turns ahead of the user's
// words, using the bridge's `ready` event as the turn boundary.
//
// The bridge is never sent /quit: the child outlives every page, so a second
// annotated page costs a /new, not a process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { HOME, ROOT, PAGE_CHAT, readPage, savePage, findThread, pageWithSession, readConfig } from './store.mjs';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = path.join(PLUGIN, 'bridge-system-prompt.md');
const PROJECT_TITLE = 'Plugin pages';
const PROJECT_ID = 'plugin-pages';
const SESSION_TITLE_MAX = 80;
const ARTICLE_MAX = 6000;
const HISTORY_MAX = 20;
const DOCX_COMMENTS_MAX = 50;
const DOCX_DIGEST_MAX = 4000;
// The bridge's own argparse defaults (--claude-effort high, --openai-effort
// empty). Nothing on the wire ever tells us the live level — the status event
// carries models but not effort — so the companion tracks it from the /effort
// turns it sends, starting from what the child was born with.
export const EFFORT_DEFAULTS = { claude: 'high', codex: null };
// How long a reply should be, as the reader set it in config.json. One line,
// at the end of every envelope: the system prompt defers to it.
const VERBOSITY_LINE = {
  short: 'Reply like a human in a chat: 2-3 crisp sentences, no essay structure, no filler.',
  long: 'Reply conversationally, at most 4-5 sentences.',
};
export const verbosityLine = v => VERBOSITY_LINE[v] || VERBOSITY_LINE.short;
// how long to wait for the `projects` event that names the live session
const SID_WAIT_MS = Number(process.env.PLUGIN_SID_WAIT_MS) || 15000;
const RESUME_WAIT_MS = Number(process.env.PLUGIN_SID_WAIT_MS) || 8000;

export const MENTION_RE = /@(claude|codex|all)\b/i;
export const hasMention = text => MENTION_RE.test(String(text || ''));

// strict routing: a comment that tags exactly one bot is that bot's alone;
// @all (or both tagged) engages the room
export function routePrefix(text) {
  const tags = new Set((String(text || '').match(/@(claude|codex|all)\b/gi) || [])
    .map(s => s.slice(1).toLowerCase()));
  if (!tags.size) return '';
  if (tags.has('all') || tags.size > 1) return '@all ';
  return `@${[...tags][0]} `;
}

// which agents a turn engages — the same rule routePrefix applies, reused so
// the drawer can spin only the agent(s) actually working
export function routedAgents(text) {
  const p = routePrefix(text);
  return p === '@claude ' ? ['claude'] : p === '@codex ' ? ['codex'] : ['claude', 'codex'];
}

// prior msgs of the thread, so a bot that just /resume'd (or was never in this
// thread) still knows what it is replying into
const historyLines = msgs => (msgs || []).slice(-HISTORY_MAX)
  .map(m => `${m.author}: ${String(m.text || '').slice(0, 1000)}`).join('\n');

// The page context rides the envelope twice over: once when the chat is born
// (the bot has never seen this page), and again whenever the reader tells us
// the text moved under them — a live Google Doc being edited between comments
// is the case that forced it. Both are transient; neither is ever persisted.
export function envelope({ url, title, target, text, quote, history,
  articleText, articleChanged, first, docxDigest, verbosity, asker }) {
  const article = String(articleText || '').slice(0, ARTICLE_MAX);
  const ctx = first
    ? `[web page: "${title}" · ${url}]\n${article}\n---\n`
    : (article && articleChanged
      ? `[the page content has been updated since earlier in this chat]\n${article}\n---\n` : '');
  const prior = history && history.length
    ? `Earlier in this thread:\n${historyLines(history)}\n\n` : '';
  // one length instruction per turn, never two: the reader's verbosity setting
  // is the only thing that says how long a reply should be
  const how = verbosityLine(verbosity);
  // On a shared page several people write into one thread, so the turn says
  // WHO is asking (the history lines already carry the others' names). Absent
  // for the owner: their own annotator has always said "the user".
  // (the highlight may be someone else's, so only the WRITING is attributed)
  const who = asker ? String(asker) : 'The user';
  const wrote = asker ? `and ${asker} wrote:` : 'and wrote:';
  const body = target === PAGE_CHAT
    ? `${who} asked about this page:\n${prior}${text}\n\nReply in this turn.\n${how}`
    : `The user highlighted this passage:\n> ${String(quote || '').replace(/\n/g, '\n> ')}\n\n`
      + `${prior}${wrote}\n${text}\n\n`
      + `Your reply text is posted directly into the comment thread.\n${how}`;
  const doc = docxDigest ? `\n[comments on this document]\n${docxDigest}` : '';
  return routePrefix(text) + ctx + body + doc;
}

// --- .docx comment digest -----------------------------------------------
// A .docx is a zip and its review comments live in word/comments.xml. Rather
// than take a dependency for one file we read the zip's central directory
// ourselves; zlib does the only genuinely hard part (raw deflate).
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function zipEntry(buf, name) {
  // the end-of-central-directory record sits at the tail, behind a comment of
  // up to 64KB — there is no other way in than scanning back for it
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error('zip64 archives are not supported here');
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) throw new Error('damaged central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) throw new Error('damaged local header');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      // a zero compressed size means the writer used a data descriptor: take
      // the rest of the file and let the inflater stop where the stream ends
      const raw = buf.subarray(start, csize ? start + csize : buf.length);
      if (method === 0) return raw.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
      throw new Error(`unsupported compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null; // no such part — for comments.xml that just means nobody commented
}

const XML_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITY[e]);

// "author: comment text" lines in document order. Anything unreadable — a
// truncated upload, a zip we can't parse, a part that isn't XML — is logged
// and dropped: a missing digest costs context, a thrown error costs the turn.
export function commentsDigest(buf) {
  let xml = null;
  try { xml = zipEntry(buf, 'word/comments.xml'); }
  catch (e) { console.error(`[docx] ${e.message} — comments ignored`); return ''; }
  if (!xml) return '';
  const lines = [];
  const re = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g;
  let m;
  while ((m = re.exec(xml)) && lines.length < DOCX_COMMENTS_MAX) {
    const author = unxml((/\bw:author="([^"]*)"/.exec(m[1]) || ['', ''])[1]).trim() || 'someone';
    // paragraph and tab boundaries are the only structure worth keeping; every
    // other tag is run/formatting noise between the words
    const text = unxml(m[2].replace(/<\/w:p>|<w:tab\b[^>]*>|<w:br\b[^>]*>/g, ' ').replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ').trim();
    if (text) lines.push(`${author}: ${text}`);
  }
  return lines.join('\n').slice(0, DOCX_DIGEST_MAX);
}

// A bot turn produces TWO room entries: the tool-activity summary
// ("Explored\n└ Fetch https://…") and then the actual answer. botference.py
// emits the first with a stream_id suffixed `:tools` (see _emit_room_entry /
// _tool_summary_display_text) — that suffix is the structural marker, and the
// blocks array is no help (tool summaries parse to the same text/code/diff
// blocks an answer does). Unstreamed responses carry no stream_id at all, so
// the summary's rigid shape is the fallback: "Explored" then branch lines.
export function isToolActivity(ev) {
  if (String(ev.stream_id || '').endsWith(':tools')) return true;
  const lines = String(ev.text || '').split('\n');
  return lines[0].trim() === 'Explored' && lines.length > 1
    && lines.slice(1).every(l => /^\s*[├└]/.test(l));
}

const activeSessionOf = ev => {
  for (const pr of ev.projects || []) for (const s of pr.sessions || []) if (s.active) return s.session_id;
  for (const s of ev.inbox_sessions || []) if (s.active) return s.session_id;
  return null;
};

export function createChat({ onEvent }) {
  let proc = null;
  let available = false;      // a live child we can write to
  let ready = false;          // bridge is between turns
  let running = false;        // the startup `ready` has landed
  let bootstrapped = false;   // "Plugin pages" created+opened in this process
  let activeSid = null;       // the session the bridge currently drives
  let sidWaiters = [];        // pending waits on a `projects` event
  const queue = [];           // pending jobs, one in flight
  let current = null;         // {job, steps, i}
  const articleByUrl = new Map(); // transient page text, never persisted
  // model picker: the bridge announces the pickable lists once (startup
  // completion_context) and the live per-agent model on every status event.
  // Both are cached because neither is replayed to a late-connecting client.
  let lastCtx = null;
  let lastStatus = null;
  let lastModels = null;
  const effort = { ...EFFORT_DEFAULTS };

  const emit = ev => { try { onEvent(ev); } catch { } };
  // control turns carry no page: they never emit chat events
  const chat = (job, fields) => { if (job.url) emit({ type: 'chat', url: job.url, target: job.target, ...fields }); };
  const send = obj => { if (proc && available) proc.stdin.write(JSON.stringify(obj) + '\n'); };

  function command() {
    if (process.env.PLUGIN_BRIDGE_CMD) return JSON.parse(process.env.PLUGIN_BRIDGE_CMD);
    const py = process.env.BOTFERENCE_PYTHON_BIN || 'python3';
    // --task-file is required by the bridge's argparse (exit 2 without it);
    // the task itself is thin — the system prompt carries the role
    const taskFile = path.join(ROOT, '.botference', 'plugin', '.chat-task.md');
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    fs.writeFileSync(taskFile,
      'Answer @-mention comments and page-chat questions from the web annotator. '
      + 'Each turn arrives with its page and thread context; reply in the turn text.\n');
    return [py, path.join(HOME, 'core', 'botference_ink_bridge.py'),
      '--system-prompt-file', SYSTEM_PROMPT, '--task-file', taskFile];
  }

  function start() {
    if (proc) return;
    emit({ type: 'bridge', state: 'starting' });
    const [cmd, ...args] = command();
    // scrub inherited BOTFERENCE_* vars: a companion started from inside a
    // botference room would otherwise hand the child that room's workspace
    // paths and its tmux transport, neither of which apply here
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BOTFERENCE_')));
    proc = spawn(cmd, args, {
      cwd: HOME,
      env: { ...env, BOTFERENCE_HOME: HOME, BOTFERENCE_PROJECT_ROOT: ROOT,
        BOTFERENCE_CLAUDE_TRANSPORT: 'programmatic' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    available = true;
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        handle(ev);
      }
    });
    proc.stderr.on('data', d => console.error(`[bridge] ${String(d).trim().slice(0, 500)}`));
    proc.on('error', err => died(err.message));
    proc.on('exit', code => died(code ? `bridge exited (code ${code})` : ''));
  }

  function died(error) {
    if (!proc) return;
    proc = null; available = false; ready = false; running = false; bootstrapped = false;
    emit({ type: 'bridge', state: 'exited', ...(error ? { error } : {}) });
    // nothing in flight can ever finish now: tell every waiting page
    const stranded = current ? [current.job, ...queue] : [...queue];
    current = null; queue.length = 0;
    for (const job of stranded) {
      chat(job, { kind: 'error', error: error || 'bridge stopped' });
      chat(job, { kind: 'turn-end', agents: job.control ? [] : routedAgents(job.text) });
    }
  }

  const modelSnapshot = () => (lastStatus
    ? { claude: lastStatus.claude_model || null, codex: lastStatus.codex_model || null } : null);
  // context occupancy + relay state, as the drawer's agent panel wants it
  const agentStatus = a => ({
    pct: lastStatus[`${a}_pct`] ?? null,
    tokens: lastStatus[`${a}_tokens`] ?? null,
    window: lastStatus[`${a}_window`] ?? null,
    model: lastStatus[`${a}_model`] || null,
    last_relay_at: lastStatus[`${a}_last_relay_at`] ?? null,
    last_relay_tier: lastStatus[`${a}_last_relay_tier`] ?? null,
  });
  const statusSnapshot = () => (lastStatus
    ? { claude: agentStatus('claude'), codex: agentStatus('codex'), auto_relay: !!lastStatus.auto_relay }
    : null);
  // what makes a status worth telling every tab about: occupancy percentage,
  // models, relay state. Raw token counts move on every heartbeat and would
  // turn the event stream into a firehose for no visible change.
  const statusKey = s => (s ? JSON.stringify([
    s.auto_relay,
    ['claude', 'codex'].map(a => [s[a].pct, s[a].model, s[a].last_relay_at, s[a].last_relay_tier]),
  ]) : '');
  // both pickers read the same completion_context the TUI's autosuggest uses:
  // the bridge is the only authority on what it will accept
  const scopedList = cmd => {
    const scoped = (lastCtx && lastCtx.scoped) || null;
    if (!scoped) return null;
    return { claude: scoped[`${cmd} @claude `] || [], codex: scoped[`${cmd} @codex `] || [] };
  };
  const modelOptions = () => scopedList('/model');
  const effortSnapshot = () => ({ current: { ...effort }, options: scopedList('/effort') });
  const modelsEvent = () => ({ type: 'models', current: modelSnapshot(), status: statusSnapshot(), effort: effortSnapshot() });

  function handle(ev) {
    if (ev.type === 'ready') { onBridgeReady(); return; }
    if (ev.type === 'completion_context') { lastCtx = ev; return; }
    if (ev.type === 'status') {
      lastStatus = ev;
      // today's bridge reports models but not effort; if a later one starts
      // carrying it, the horse's mouth beats our bookkeeping
      for (const a of ['claude', 'codex']) {
        if (ev[`${a}_effort`] !== undefined) effort[a] = ev[`${a}_effort`] || null;
      }
      // a /model turn lands as a status event: tell every tab, once per change
      const snap = modelSnapshot();
      const status = statusSnapshot();
      const key = JSON.stringify(snap) + statusKey(status) + JSON.stringify(effort);
      if (snap && key !== lastModels) {
        lastModels = key;
        emit(modelsEvent());
      }
      return;
    }
    if (ev.type === 'projects') {
      const sid = activeSessionOf(ev);
      if (sid) {
        activeSid = sid;
        for (const w of [...sidWaiters]) if (w.test(sid)) settleWaiter(w, sid);
      }
      return;
    }
    if (ev.type === 'stream') {
      if (!current || !current.capturing) return;
      if (ev.kind === 'text_delta') {
        chat(current.job, { kind: 'stream', model: ev.model, stream_id: ev.stream_id, text: String(ev.text || '') });
      } else if (ev.kind === 'done') {
        chat(current.job, { kind: 'stream-done', model: ev.model, stream_id: ev.stream_id });
      }
      return;
    }
    if (ev.type === 'room') {
      // control steps (and a /resume's replayed history) produce room entries
      // that are not answers to this comment — only the user turn's fresh
      // claude/codex entries become thread messages
      if (!current || !current.capturing || ev.restored) return;
      const speaker = String(ev.speaker || '').toLowerCase();
      const author = speaker.startsWith('claude') ? 'claude' : speaker.startsWith('codex') ? 'codex' : null;
      if (!author || !String(ev.text || '').trim()) return;
      // tool activity is kept, not dropped — the drawer collapses it, the
      // Obsidian note leaves it out
      const msg = { author, ts: new Date().toISOString(), text: String(ev.text) };
      if (isToolActivity(ev)) msg.kind = 'tools';
      chat(current.job, { kind: 'reply', msg });
      return;
    }
    if (ev.type === 'permission_request') {
      // The annotator reads the web and answers in a comment thread; it has no
      // business writing files, and a page that talks an agent into writing one
      // is the whole prompt-injection surface. So: deny, immediately (a pending
      // permission stalls the turn for as long as it is pending), and say so in
      // the thread that asked — silence would look like the bot ignoring it.
      send({ type: 'permission_response', allow: false });
      const who = String(ev.model || '').trim() || 'an agent';
      if (current) {
        chat(current.job, { kind: 'error',
          error: `${who} asked to write a file — file-writing is disabled in the annotator` });
      }
      return;
    }
    if (ev.type === 'choice_request') {
      // the "where should this chat live?" picker would block the turn forever
      // (no arrow-key UI here): stay in Inbox when offered, else take the first
      const opts = ev.options || [];
      const stay = opts.findIndex(o => /^stay in inbox$/i.test(String(o)));
      send({ type: 'choice_response', index: stay >= 0 ? stay : 0 });
      return;
    }
  }

  async function onBridgeReady() {
    ready = true;
    if (!running) { running = true; emit({ type: 'bridge', state: 'running' }); }
    if (current) {
      const job = current.job;
      const step = current.steps[current.i];
      // a step's `after` may wait on a projects event (sid capture/verify);
      // nothing else can move meanwhile — `current` is still set, so pump()
      // stays parked and no further input is in flight
      if (step && step.after && (await step.after()) === false) {
        if (current && current.job === job) { chat(job, { kind: 'turn-end', agents: current.agents }); current = null; }
        pump();
        return;
      }
      if (!current || current.job !== job) { pump(); return; } // bridge died mid-wait
      current.i++;
      if (current.i < current.steps.length) { sendStep(); return; }
      chat(job, { kind: 'turn-end', agents: current.agents });
      if (job.control) controlDone(job.control);
      current = null;
    }
    pump();
  }

  // A finished control turn is the only evidence we get that the bridge took a
  // setting: it answers /effort with a room line, never a status field. So the
  // level is recorded when the turn completes, not when it is queued.
  function controlDone(text) {
    const m = /^\/effort @(claude|codex)\s+(\S+)/.exec(String(text));
    if (!m || effort[m[1]] === m[2]) return;
    effort[m[1]] = m[2];
    emit(modelsEvent());
  }

  function sendStep() {
    const step = current.steps[current.i];
    current.capturing = !!step.capture;
    if (step.before) step.before();
    ready = false;
    send({ type: 'input', text: step.text, attachments: [] });
  }

  // The control steps this job needs are computed when it REACHES the front of
  // the queue, never when it is submitted: by then every earlier turn has
  // finished, so the page's session id and the bridge's active session are
  // both known facts rather than predictions.
  function planSteps(job) {
    // a control turn (e.g. "/model @claude claude-opus-5") is a raw slash
    // command: no session choreography, no envelope, no reply capture — it
    // rides the same queue only so it never interleaves with a turn in flight
    if (job.control) return [{ text: job.control }];
    const page = readPage(job.url) || {};
    const title = (page.title || job.title || job.url || '').replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_MAX);
    const steps = [];
    if (!bootstrapped) {
      // tolerate "already exists" — the create is idempotent from our side
      steps.push({ text: `/project create ${PROJECT_TITLE}` });
      steps.push({ text: `/project open ${PROJECT_ID}` });
      bootstrapped = true;
    }
    const sid = page.session_id || null;
    let sidBefore = null; // whatever the bridge was on when /new went out
    if (!sid) {
      steps.push({ text: '/new', before: () => { sidBefore = activeSid; } });
      steps.push({ text: `/rename ${title}` });
    } else if (activeSid !== sid) {
      steps.push({ text: `/resume ${sid}`, after: () => confirmResume(job, sid) });
    }
    steps.push({
      text: envelope({ url: job.url, title, target: job.target, text: job.text,
        quote: job.quote, history: job.history, first: !sid,
        // a refresh only counts when this very message carried the new text:
        // the cached copy is for pages whose first turn never got a session
        articleText: job.articleText || articleByUrl.get(job.url) || '',
        articleChanged: !!(job.articleChanged && job.articleText),
        docxDigest: job.docxDigest, asker: job.asker,
        verbosity: readConfig().verbosity }),
      capture: true,
      // the new chat becomes visible to the bridge's own panel only now that
      // it has an entry — this is the first moment its sid can be trusted
      ...(sid ? {} : { after: () => captureNewSid(job, sidBefore) }),
    });
    return steps;
  }

  // Which session is live is only ever learned from a `projects` event, and
  // those arrive when the bridge feels like it — so waiting for one is part of
  // the choreography, not an optimization.
  function settleWaiter(w, sid) {
    clearTimeout(w.timer);
    sidWaiters = sidWaiters.filter(x => x !== w);
    w.resolve(sid);
  }
  function waitForSid(test, ms = SID_WAIT_MS) {
    if (activeSid && test(activeSid)) return Promise.resolve(activeSid);
    return new Promise(resolve => {
      const w = { test, resolve, timer: null };
      w.timer = setTimeout(() => { sidWaiters = sidWaiters.filter(x => x !== w); resolve(null); }, ms);
      sidWaiters.push(w);
    });
  }

  // Capture the session `/new` created — AFTER the user turn, never after
  // `/rename`. A chat with no transcript entries is invisible in the bridge's
  // projects snapshot (project_panel_snapshot skips entry_count < 1) and
  // /rename emits no snapshot at all, so before the first real turn the only
  // sid on offer is the PREVIOUS page's. Capturing it there is how a new page
  // ended up bound to another page's chat. Rule: accept only a sid that
  // differs from the one active when /new was sent, and never one another
  // page already owns; on failure leave session_id null (the next comment
  // starts a fresh chat) rather than binding to a foreign session.
  async function captureNewSid(job, sidBefore) {
    const sid = await waitForSid(s => s && s !== sidBefore);
    const page = sid ? readPage(job.url) : null;
    const owner = sid && pageWithSession(sid, job.url);
    if (!sid || !page || owner) {
      chat(job, { kind: 'error',
        error: owner
          ? 'this page could not be given its own chat (the bridge reported a session another page owns) — its next comment starts a fresh one'
          : "couldn't create a session for this page — its next comment starts a fresh chat" });
      return;
    }
    if (page.session_id === sid) return;
    page.session_id = sid;
    savePage(page);
    emit({ type: 'page', url: page.url });
  }

  // A /resume that quietly landed somewhere else would post the user's comment
  // into a stranger's chat. Proceed only when the bridge confirms the session,
  // or says nothing at all (no snapshot is not evidence of a miss).
  async function confirmResume(job, sid) {
    if (await waitForSid(s => s === sid, RESUME_WAIT_MS)) return true;
    if (activeSid && activeSid !== sid) {
      chat(job, { kind: 'error', error: "couldn't resume this page's chat — nothing was sent" });
      return false;
    }
    return true;
  }

  function pump() {
    if (!ready || current || !queue.length || !available) return;
    const job = queue.shift();
    // the drawer spins only the agents this turn actually engages
    const agents = job.control ? [] : routedAgents(job.text);
    current = { job, agents, steps: planSteps(job), i: 0, capturing: false };
    chat(job, { kind: 'turn-start', agents });
    sendStep();
  }

  return {
    // a comment carrying an @-mention: queue a turn for its page/thread
    submit(job) {
      if (job.articleText) articleByUrl.set(job.url, String(job.articleText).slice(0, ARTICLE_MAX));
      queue.push({ ...job, target: job.target || PAGE_CHAT });
      start();
      pump();
      return { queued: true, position: queue.length + (current ? 1 : 0) };
    },
    // a raw slash command (model picker): queued like any turn, answered by
    // the bridge's next ready. Starts the bridge if nothing has yet.
    control(text) {
      queue.push({ control: String(text), url: null, target: null });
      start();
      pump();
      return { queued: true, position: queue.length + (current ? 1 : 0) };
    },
    // {current, options, status}: all null until the bridge has spoken, which
    // the extension renders as "unknown yet" rather than an empty picker.
    // effort.current is the exception — the child's defaults are known before
    // it starts, and nothing the bridge emits would ever tell us otherwise.
    models: () => ({ current: modelSnapshot(), options: modelOptions(),
      status: statusSnapshot(), effort: effortSnapshot() }),
    // only the page whose turn is actually running can interrupt it
    interrupt(url) {
      if (!current || !available || current.job.url !== url) return false;
      send({ type: 'interrupt' });
      return true;
    },
    state: () => (available ? 'running' : 'stopped'),
    queueLength: () => queue.length + (current ? 1 : 0),
    currentUrl: () => (current ? current.job.url : null),
    stop() { if (proc) { const p = proc; proc = null; available = false; try { p.kill(); } catch { } } },
  };
}

// thread history for the envelope, minus the message that triggered the turn
export function priorMsgs(page, threadId) {
  const msgs = threadId === PAGE_CHAT ? page.page_chat : (findThread(page, threadId) || {}).msgs;
  return (msgs || []).slice(0, -1);
}
