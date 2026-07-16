// BridgeChat: runs botference_ink_bridge.py as a child (server.mjs --chat) and
// relays browser mentions/chat as user turns. JSONL: input on stdin, events on stdout.
// Bots stay the canonical writers of threads.json/suggestions.json; streams are UI-only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class BridgeChat {
  constructor({ reviewDir, cfg, onEvent }) {
    this.review = reviewDir;
    this.cfg = cfg;
    this.onEvent = onEvent;         // (obj) => broadcast as SSE 'chat'
    this.queue = [];                // pending turns, one in flight
    this.current = null;            // {target_id, mention_id}
    this.seen = new Set();          // mention_id dedupe across debounce/reload
    this.ready = false;
    this.proc = null;
    this.lockFile = path.join(reviewDir, 'state', '.chat-lock');
    // dedupe survives server restarts, but only turn-completed mentions are
    // persisted — a mention still queued or in flight when the server dies
    // must be resubmittable after a restart
    this.seenFile = path.join(reviewDir, 'state', '.mention-seen.json');
    this.completed = [];
    try { this.completed = JSON.parse(fs.readFileSync(this.seenFile, 'utf8')); } catch { }
    this.seen = new Set(this.completed);
    this.startedAt = new Date().toISOString(); // thread entries older than this never trigger bot-tag summons
    this.botTagCount = {};                     // per-thread depth cap, reset by the next human turn on the thread
  }

  // workspace root = nearest ancestor with project.json (never the paper repo itself unless it has one)
  projectRoot() {
    if (process.env.BOTFERENCE_PROJECT_ROOT) return process.env.BOTFERENCE_PROJECT_ROOT;
    let d = path.resolve(this.review, '..');
    while (d !== path.dirname(d)) {
      if (fs.existsSync(path.join(d, 'project.json'))) return d;
      d = path.dirname(d);
    }
    throw new Error('no botference workspace found above the document (missing project.json); set BOTFERENCE_PROJECT_ROOT');
  }

  home() {
    // $BOTFERENCE_HOME wins; bridge.core_dir (relative to review/) is the fallback
    const h = process.env.BOTFERENCE_HOME;
    if (h && fs.existsSync(path.join(h, 'core', 'botference_ink_bridge.py'))) return h;
    const core = path.resolve(this.review, this.cfg.bridge?.core_dir || '');
    if (fs.existsSync(path.join(core, 'botference_ink_bridge.py'))) return path.dirname(core);
    throw new Error('bridge not found: set $BOTFERENCE_HOME or fix bridge.core_dir in review.config.json');
  }

  alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }

  // one review-chat per workspace: the lock file is the hard guard; a live TUI
  // in the run-ledger only warrants a note, since each drives its own session
  acquireLock() {
    const root = this.projectRoot();
    const bfDir = path.join(root, '.botference');
    fs.mkdirSync(bfDir, { recursive: true });
    this.lockFile = path.join(bfDir, 'review-chat.lock');
    const ledger = path.join(bfDir, 'run-ledger.jsonl');
    if (fs.existsSync(ledger)) {
      const open = new Map();
      for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        const pid = e.pid ?? e.launcher_pid;
        if (!pid) continue;
        if (/exit|end|stop/i.test(e.event || e.type || '')) open.delete(pid);
        else open.set(pid, e);
      }
      for (const [pid] of open) {
        if (pid !== process.pid && this.alive(pid)) {
          // a TUI on this workspace shares only the per-session store with us —
          // review chat drives its own bridge session, so coexisting is safe;
          // the hard invariant (one review-chat per workspace) is the lock below
          console.error(`note: another botference frontend is attached to this workspace (pid ${pid} per run-ledger); review chat continues with its own session`);
        }
      }
    }
    if (fs.existsSync(this.lockFile)) {
      const l = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (l.pid !== process.pid && this.alive(l.pid)) {
        throw new Error(`session already attached by ${l.frontend} (pid ${l.pid}) — close it before --chat`);
      }
    }
    fs.writeFileSync(this.lockFile, JSON.stringify({ frontend: 'review-chat', pid: process.pid, started: new Date().toISOString() }));
    process.on('exit', () => { try { fs.unlinkSync(this.lockFile); } catch { } });
  }

  start() {
    this.acquireLock();
    const home = this.home();
    const sys = path.resolve(this.review, '..', this.cfg.bridge?.system_prompt || 'review/bridge-system-prompt.md');
    const task = path.join(this.review, 'state', '.chat-task.md');
    fs.writeFileSync(task, 'Review-site chat session. Respond to browser review turns per the system prompt; the review protocol in .claude/skills/paper-review/SKILL.md applies.\n');
    // scrub inherited BOTFERENCE_* vars: a server started from inside a
    // botference room would otherwise hand the bridge that room's stale
    // workspace paths and its tmux transport, neither of which apply here
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BOTFERENCE_')));
    this.proc = spawn('python3', [path.join(home, 'core', 'botference_ink_bridge.py'),
      '--system-prompt-file', sys, '--task-file', task], {
      cwd: home,
      env: { ...env, BOTFERENCE_HOME: home, BOTFERENCE_PROJECT_ROOT: this.projectRoot(), BOTFERENCE_CLAUDE_TRANSPORT: 'programmatic' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        this.handle(ev);
      }
    });
    this.available = true;
    this.proc.stderr.on('data', d => this.onEvent({ kind: 'bridge-log', text: String(d).slice(0, 500) }));
    this.proc.on('error', err => {
      this.available = false; this.ready = false;
      this.onEvent({ kind: 'bridge-exit', code: -1, error: err.message });
    });
    this.proc.on('exit', code => {
      this.available = false; this.ready = false;
      this.onEvent({ kind: 'bridge-exit', code });
      try { fs.unlinkSync(this.lockFile); } catch { }
    });
  }

  handle(ev) {
    if (ev.type === 'ready') {
      this.ready = true;
      if (this.current) {
        if (this.current.mention_id) {
          this.completed = [...this.completed, this.current.mention_id].slice(-500);
          try { fs.writeFileSync(this.seenFile, JSON.stringify(this.completed)); } catch { }
        }
        this.onEvent({ kind: 'turn-end', ...this.current });
        this.current = null;
        this.scanBotTags(); // a bot's fresh thread reply may @-tag its counterpart
      }
      this.pump();
      return;
    }
    if (ev.type === 'stream' || ev.type === 'room') {
      // 'room' is the canonical batch for text already streamed: mark final so the UI replaces
      this.onEvent({ kind: 'stream', final: ev.type === 'room', target_id: this.current?.target_id || null, ev });
      return;
    }
    if (ev.type === 'permission_request' || ev.type === 'permission_cleared') {
      if (ev.type === 'permission_request') {
        // default-deny: unanswered requests are denied after 120s
        clearTimeout(this.permTimer);
        this.permTimer = setTimeout(() => {
          this.send({ type: 'permission_response', allow: false });
          this.onEvent({ kind: 'permission-timeout', target_id: this.current?.target_id || null });
        }, 120000);
      } else clearTimeout(this.permTimer);
      this.onEvent({ kind: 'permission', target_id: this.current?.target_id || null, ev });
      return;
    }
    if (ev.type === 'choice_request') {
      // the automatic "where should this chat live?" picker on an Inbox
      // session's first message would block the turn forever here (nobody is
      // at an arrow-key UI) — answer it ourselves and stay in Inbox
      const stay = (ev.options || []).findIndex(o => /^stay in inbox$/i.test(o));
      if (stay >= 0) {
        this.send({ type: 'choice_response', index: stay });
        this.onEvent({ kind: 'choice-auto', target_id: this.current?.target_id || null, prompt: ev.prompt, picked: ev.options[stay] });
        return;
      }
      // any other picker: show it in the page; default-dismiss after 120s so
      // an unanswered choice can never jam the queue (mirrors permissions)
      clearTimeout(this.choiceTimer);
      this.choiceTimer = setTimeout(() => {
        this.send({ type: 'choice_response', index: null });
        this.onEvent({ kind: 'choice-timeout', target_id: this.current?.target_id || null });
      }, 120000);
      this.onEvent({ kind: 'choice', target_id: this.current?.target_id || null, ev });
      return;
    }
    if (ev.type === 'choice_cleared') {
      clearTimeout(this.choiceTimer);
      this.onEvent({ kind: 'choice', target_id: this.current?.target_id || null, ev });
      return;
    }
    this.onEvent({ kind: 'meta', type: ev.type });
  }

  answerPermission(payload) { clearTimeout(this.permTimer); this.send(payload); }
  answerChoice(payload) { clearTimeout(this.choiceTimer); this.send(payload); }

  send(obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }

  // browser mention/chat -> queued turn; dedupe on mention_id; size-capped upstream
  submit({ mention_id, target_id, author, text }) {
    if (!this.available) return { queued: false, reason: 'agent bridge is not running — restart the server with --chat' };
    if (mention_id && this.seen.has(mention_id)) return { queued: false, reason: 'duplicate' };
    // a human turn on a thread opens a new round there: the bot-tag depth cap resets
    if (target_id && !/^(claude|codex)/i.test(String(author || ''))) this.botTagCount[target_id] = 0;
    if (mention_id) this.seen.add(mention_id); // persisted only once its turn completes
    // keep the raw human words alongside the composed envelope: the UI shows only
    // the former (turn-start carries author/user_text), the bridge gets the latter
    this.queue.push({ target_id: target_id || null, mention_id, author, user_text: text, text: this.compose({ target_id, author, text }) });
    this.pump();
    return { queued: true, position: this.queue.length + (this.current ? 1 : 0) };
  }

  compose({ target_id, author, text }) {
    const rd = path.relative(this.projectRoot(), this.review);
    // strict routing: a turn that tags exactly one bot is routed to that bot
    // alone (room route token as message prefix); @all or no tag keeps the
    // default room behavior. Prevents the untagged bot answering a turn that
    // was addressed to its counterpart.
    const tags = new Set((String(text).match(/@(claude|codex|all)\b/gi) || []).map(s => s.slice(1).toLowerCase()));
    const solo = !tags.has('all') && tags.size === 1 ? [...tags][0] : null;
    const route = solo ? `@${solo} ` : '';
    const head = target_id
      ? `[review chat · review_dir=${rd}] ${author} replied on ${target_id} in the review site:`
      : `[review chat · review_dir=${rd}] ${author} wrote in the review chat panel:`;
    return `${route}${head}\n${text}\n\nRespond per the review round protocol. Operate only beneath ${rd}/ — its threads.json, suggestions.json, ack.json, and build.mjs; never edit the paper sources.`;
  }

  // bot-to-bot consultation happens ONLY through visible @-tags in the bots' own
  // thread replies (threads.json), never via the free-form room footer. After each
  // turn, bot-authored entries newer than this session carrying exactly one
  // other-bot tag enqueue a mention turn for that bot on the same thread — same
  // queue, same mention_id dedupe (bot-tag:<thread>:<ts>), same presence-strip
  // visibility as a human tag. Depth cap: one bot-summoned turn per thread
  // between human turns on it, so tag exchanges cannot loop.
  scanBotTags() {
    let threads;
    try { threads = JSON.parse(fs.readFileSync(path.join(this.review, 'state', 'threads.json'), 'utf8')); } catch { return; }
    for (const [tid, entries] of Object.entries(threads)) {
      for (const e of [].concat(entries || [])) {
        const author = String(e.author || '').toLowerCase();
        const self = author.startsWith('claude') ? 'claude' : author.startsWith('codex') ? 'codex' : null;
        if (!self || !e.text || !e.ts || String(e.ts) <= this.startedAt) continue;
        const tags = new Set((String(e.text).match(/@(claude|codex)\b/gi) || []).map(s => s.slice(1).toLowerCase()));
        tags.delete(self); // self-tags don't summon
        if (tags.size !== 1) continue;
        const mid = `bot-tag:${tid}:${e.ts}`;
        if (this.seen.has(mid)) continue;
        if ((this.botTagCount[tid] || 0) >= 1) {
          this.seen.add(mid);
          console.error(`bot-tag capped on ${tid}: ${self} tagged @${[...tags][0]} but the depth cap (1 per thread per round) was reached`);
          this.onEvent({ kind: 'bridge-log', text: `bot-tag capped on ${tid} (depth 1 per thread per round)` });
          continue;
        }
        this.botTagCount[tid] = (this.botTagCount[tid] || 0) + 1;
        this.submit({ mention_id: mid, target_id: tid, author: self, text: e.text });
      }
    }
  }

  pump() {
    if (!this.ready || this.current || !this.queue.length) return;
    const t = this.queue.shift();
    this.current = { target_id: t.target_id, mention_id: t.mention_id };
    this.ready = false;
    this.onEvent({ kind: 'turn-start', ...this.current, author: t.author || null, user_text: t.user_text || null });
    this.send({ type: 'input', text: t.text, attachments: [] });
  }
}
