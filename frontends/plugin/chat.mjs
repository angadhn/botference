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
import { fileURLToPath } from 'node:url';
import { ROOT, HOME, PAGE_CHAT, readPage, savePage, findThread } from './store.mjs';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = path.join(PLUGIN, 'bridge-system-prompt.md');
const PROJECT_TITLE = 'Plugin pages';
const PROJECT_ID = 'plugin-pages';
const PERMISSION_TIMEOUT_MS = 120000;
const SESSION_TITLE_MAX = 80;
const ARTICLE_MAX = 6000;
const HISTORY_MAX = 20;

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

export function envelope({ url, title, target, text, quote, history, articleText, first }) {
  const ctx = first
    ? `[web page: "${title}" · ${url}]\n${String(articleText || '').slice(0, ARTICLE_MAX)}\n---\n`
    : '';
  const prior = history && history.length
    ? `Earlier in this thread:\n${historyLines(history)}\n\n` : '';
  const body = target === PAGE_CHAT
    ? `The user asked about this page:\n${prior}${text}\n\nReply concisely in this turn.`
    : `The user highlighted this passage:\n> ${String(quote || '').replace(/\n/g, '\n> ')}\n\n`
      + `${prior}and wrote:\n${text}\n\n`
      + 'Reply concisely in this turn — your reply text is posted directly into the comment thread.\n'
      + 'Keep it to a few sentences unless asked for more.';
  return routePrefix(text) + ctx + body;
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
  let permTimer = null;
  const queue = [];           // pending jobs, one in flight
  let current = null;         // {job, steps, i}
  const articleByUrl = new Map(); // transient page text, never persisted
  // model picker: the bridge announces the pickable lists once (startup
  // completion_context) and the live per-agent model on every status event.
  // Both are cached because neither is replayed to a late-connecting client.
  let lastCtx = null;
  let lastStatus = null;
  let lastModels = null;

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
    clearTimeout(permTimer);
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
  const modelOptions = () => {
    const scoped = (lastCtx && lastCtx.scoped) || null;
    if (!scoped) return null;
    return { claude: scoped['/model @claude '] || [], codex: scoped['/model @codex '] || [] };
  };

  function handle(ev) {
    if (ev.type === 'ready') { onBridgeReady(); return; }
    if (ev.type === 'completion_context') { lastCtx = ev; return; }
    if (ev.type === 'status') {
      lastStatus = ev;
      // a /model turn lands as a status event: tell every tab, once per change
      const snap = modelSnapshot();
      const status = statusSnapshot();
      const key = JSON.stringify(snap) + statusKey(status);
      if (snap && key !== lastModels) {
        lastModels = key;
        emit({ type: 'models', current: snap, status });
      }
      return;
    }
    if (ev.type === 'projects') {
      const sid = activeSessionOf(ev);
      if (sid) activeSid = sid;
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
      // v1 policy: reads and writes beneath the workspace are fine, anything
      // outside it is denied. Nobody is at a keyboard to arbitrate.
      const p = String(ev.path || '');
      const rel = p ? path.relative(ROOT, path.resolve(p)) : '..';
      const allow = !!p && !rel.startsWith('..') && !path.isAbsolute(rel);
      clearTimeout(permTimer);
      permTimer = setTimeout(() => send({ type: 'permission_response', allow: false }), PERMISSION_TIMEOUT_MS);
      send({ type: 'permission_response', allow });
      return;
    }
    if (ev.type === 'permission_cleared') { clearTimeout(permTimer); return; }
    if (ev.type === 'choice_request') {
      // the "where should this chat live?" picker would block the turn forever
      // (no arrow-key UI here): stay in Inbox when offered, else take the first
      const opts = ev.options || [];
      const stay = opts.findIndex(o => /^stay in inbox$/i.test(String(o)));
      send({ type: 'choice_response', index: stay >= 0 ? stay : 0 });
      return;
    }
  }

  function onBridgeReady() {
    ready = true;
    if (!running) { running = true; emit({ type: 'bridge', state: 'running' }); }
    if (current) {
      const step = current.steps[current.i];
      if (step && step.after) step.after();
      current.i++;
      if (current.i < current.steps.length) { sendStep(); return; }
      chat(current.job, { kind: 'turn-end', agents: current.agents });
      current = null;
    }
    pump();
  }

  function sendStep() {
    const step = current.steps[current.i];
    current.capturing = !!step.capture;
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
    if (!sid) {
      steps.push({ text: '/new' });
      steps.push({ text: `/rename ${title}`, after: () => captureSid(job.url) });
    } else if (activeSid !== sid) {
      steps.push({ text: `/resume ${sid}` });
    }
    steps.push({
      text: envelope({ url: job.url, title, target: job.target, text: job.text,
        quote: job.quote, history: job.history, first: !sid,
        articleText: job.articleText || articleByUrl.get(job.url) || '' }),
      capture: true,
    });
    return steps;
  }

  function captureSid(url) {
    if (!activeSid) return;
    const page = readPage(url);
    if (!page || page.session_id === activeSid) return;
    page.session_id = activeSid;
    savePage(page);
    emit({ type: 'page', url: page.url });
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
    // the extension renders as "unknown yet" rather than an empty picker
    models: () => ({ current: modelSnapshot(), options: modelOptions(), status: statusSnapshot() }),
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
