#!/usr/bin/env node
// Stand-in for core/botference_ink_bridge.py: speaks the same JSONL protocol
// (input on stdin, events on stdout) with none of the CLIs behind it, so
// companion.test.mjs can exercise the whole turn choreography deterministically.
// Every stdin object is appended to $MOCK_BRIDGE_LOG for the test to assert on.
import fs from 'node:fs';
import path from 'node:path';

// One log for the whole test, or — when several children run at once (the
// bridge pool, pool.mjs) — one per child, named by pid. A single file cannot
// answer "which child sent this", and that is the only question the parallel
// suite has.
const LOG = process.env.MOCK_LOG_DIR
  ? path.join(process.env.MOCK_LOG_DIR, `${process.pid}.jsonl`)
  : (process.env.MOCK_BRIDGE_LOG || '');
if (process.env.MOCK_LOG_DIR) {
  try { fs.mkdirSync(process.env.MOCK_LOG_DIR, { recursive: true }); } catch { }
}
// Session ids are the mock's own counter, which two children would both start
// at 1 — a collision the real controller cannot have (its ids are unique) and
// which the companion is right to refuse (pageWithSession). Stamped with the
// pid when several children are in play, so the fixture stops manufacturing a
// bug that does not exist.
const SID_TAG = process.env.MOCK_LOG_DIR ? `${process.pid}-` : '';
const DELAY = Number(process.env.MOCK_TURN_DELAY_MS || 0);
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
const log = o => { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch { } } };
// The real bridge spawns the CLIs, which read their API keys from the
// environment — so which variables are PRESENT at spawn is the whole of the
// key feature. Recorded once, as a plain presence/value map, so a test can
// tell "absent" from "empty string": they are not the same thing to a CLI.
if (process.env.MOCK_ENV_DUMP) {
  const want = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
    'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CODEX_API_KEY'];
  const seen = {};
  for (const k of want) if (k in process.env) seen[k] = process.env[k];
  // Phase 2: WHERE this child may write, kept in its own field so `present`
  // stays exactly the auth question it has always been. The real bridge turns
  // these into the CLIs' own configuration (cli_adapters.planner_write_config)
  // — claude's permissions.allow Edit rules, codex's workspace-write sandbox
  // root — so what is present at spawn is the whole of the write scope,
  // exactly as the API keys are the whole of the auth.
  const scope = {};
  // …and, since blog source pages, WHAT this child may not run: the reader's
  // website repo is theirs to publish, so a blog child is born with git and gh
  // denied (cli_adapters._plan_denied_commands turns this into claude's
  // permissions.deny). Same field, same reason: it is part of the scope.
  for (const k of ['BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS', 'BOTFERENCE_PLAN_DENY_BASH',
    'BOTFERENCE_PROJECT_ROOT']) {
    if (k in process.env) scope[k] = process.env[k];
  }
  try {
    fs.appendFileSync(process.env.MOCK_ENV_DUMP,
      JSON.stringify({ present: want.filter(k => k in process.env), values: seen, scope }) + '\n');
  } catch { }
}
const ready = () => setImmediate(() => emit({ type: 'ready' }));
const room = (speaker, text) => emit({ type: 'room', speaker, text, blocks: [] });

let seq = 0, streamSeq = 0, sid = null, pendingDelete = null;
// which [mock:write:…] directives have already been carried out (see below)
const written = new Set();
// Which project the room is in. "Plugin pages" until something opens another
// one — a WORKSPACE bridge (a project-artifact page, SPEC "Project artifact
// pages") opens the reader's real project instead, and its chats must be
// reported under that id or the companion could not tell where they landed.
let openProject = { id: 'plugin-pages', title: 'Plugin pages' };
const sessions = [];
const MODELS = {
  claude: ['claude-fable-5', 'claude-opus-5', 'claude-haiku-4-5'],
  codex: ['gpt-5.6-sol', 'gpt-5.5', 'o3'],
};
// the controller's own effort ladders (botference.py _CLAUDE/_CODEX_EFFORT_LEVELS)
const EFFORT = {
  claude: ['low', 'medium', 'high', 'xhigh'],
  codex: ['minimal', 'low', 'medium', 'high', 'max'],
};
const live = { claude: 'claude-fable-5', codex: 'gpt-5.6-sol' };
// occupancy: tokens creep on every status (the heartbeat), pct only when a
// turn asks for it — the companion must broadcast on the latter, not the former
const use = { claude_tokens: 42000, codex_tokens: 31000, claude_pct: 4, codex_pct: 3 };
const status = () => emit({
  type: 'status', mode: 'plan', lead: 'claude', route: '@all', project: openProject.id,
  claude_model: live.claude, codex_model: live.codex,
  claude_pct: use.claude_pct, codex_pct: use.codex_pct,
  claude_tokens: use.claude_tokens, claude_window: 1000000,
  codex_tokens: use.codex_tokens, codex_window: 1050000,
  claude_last_relay_at: null, claude_last_relay_tier: null,
  codex_last_relay_at: null, codex_last_relay_tier: null,
  auto_relay: true,
});
const completionContext = () => emit({
  type: 'completion_context',
  global: ['/new', '/rename', '/resume', '/model @claude', '/model @codex'],
  scoped: {
    '/project ': ['open', 'create'],
    '/model @claude ': MODELS.claude,
    '/model @codex ': MODELS.codex,
    '/effort @claude ': EFFORT.claude,
    '/effort @codex ': EFFORT.codex,
  },
});
const touch = id => sessions.find(s => s.session_id === id)
  || (sessions.push({ session_id: id, title: 'Untitled', entries: 0 }), sessions[sessions.length - 1]);

// Faithful to project_panel_snapshot: a chat with no transcript entries is
// invisible here, so a just-created session cannot be flagged active — the
// snapshot still shows the PREVIOUS chat. This is what made a new page inherit
// another page's session id.
function projects() {
  const visible = sessions.filter(s => s.entries > 0);
  emit({
    type: 'projects',
    active_project_id: openProject.id,
    inbox_session_count: 0,
    inbox_sessions: [],
    projects: [{
      id: openProject.id, title: openProject.title, status: 'active', next_action: '',
      active: true, session_count: visible.length,
      sessions: visible.map(s => ({
        session_id: s.session_id, title: s.title,
        updated_at: new Date().toISOString(), active: s.session_id === sid,
      })),
    }],
  });
}

function input(text) {
  if (text.startsWith('/project create')) { room('system', 'Created project Plugin pages (plugin-pages).'); return ready(); }
  if (text.startsWith('/project open')) {
    const id = text.slice('/project open'.length).trim() || 'plugin-pages';
    openProject = { id, title: id === 'plugin-pages' ? 'Plugin pages' : id };
    room('system', `Project context set to ${openProject.title} (${openProject.id}).`);
    projects();
    return ready();
  }
  if (text.trim() === '/new') {
    seq++; sid = `sess-${SID_TAG}${seq}`; touch(sid);
    emit({ type: 'clear_panes' });
    projects();
    return ready();
  }
  if (text.startsWith('/rename ')) {
    // the real _rename_session persists but never syncs the panel: no
    // projects event here at all
    touch(sid).title = text.slice('/rename '.length);
    room('system', `Renamed chat to ${touch(sid).title}`);
    return ready();
  }
  if (text.startsWith('/resume ')) {
    sid = text.slice('/resume '.length).trim();
    touch(sid).entries ||= 1; // a resumable chat has content, so the panel sees it
    emit({ type: 'clear_panes' });
    // replayed history: the companion must NOT mistake these for new replies
    emit({ type: 'room', speaker: 'claude', text: 'MOCK claude reply.', restored: true });
    projects();
    return ready();
  }
  const model = /^\/model @(claude|codex)\s+(\S+)/.exec(text);
  if (model) {
    live[model[1]] = model[2];
    room('system', `${model[1]} now runs ${model[2]}`);
    status();
    return ready();
  }
  // /delete is a two-step command in the real controller: it asks the UI to
  // confirm and only finishes the turn once an answer comes back
  if (text.startsWith('/delete ')) {
    pendingDelete = text.slice('/delete '.length).trim();
    emit({ type: 'choice_request', prompt: `Delete “${pendingDelete}” permanently? This cannot be undone.`,
      options: ['Delete it', 'Cancel'] });
    return;
  }
  if (text.startsWith('/')) { room('system', 'ok'); return ready(); }

  const models = /^@all\b/.test(text) ? ['claude', 'codex'] : [/^@codex\b/.test(text) ? 'codex' : 'claude'];
  // [mock:sleep:N] — this ONE turn takes N ms. MOCK_TURN_DELAY_MS is per
  // process and cannot express "hold page A's turn open while page B's runs",
  // which is the whole of what a parallelism test has to arrange.
  const slow = /\[mock:sleep:(\d+)\]/.exec(text);
  setTimeout(() => {
    // an agent that decided to write a file mid-turn: the real bridge blocks on
    // the answer, so the companion must refuse without waiting for a timer
    // …optionally naming the path it wants, so a test can ask for one INSIDE
    // the project folder and prove the companion refuses that too (a yes here
    // grants a whole extra write root, never one file — see chat.mjs)
    const perm = /\[mock:perm(?::([^\]]+))?\]/.exec(text);
    if (perm) {
      const p = perm[1] || '/tmp/notes-from-the-page.md';
      emit({ type: 'permission_request', model: models[0], tool: 'Write',
        path: p, description: `Write ${p}` });
    }
    // an agent that actually wrote a file mid-turn. The real thing does it
    // through the CLI's own sandbox; here it is one fs call, which is all the
    // companion's change census can see of it either way.
    // ONCE per directive, ever. The envelope replays the thread's history above
    // the new message, so a directive the reader sent three turns ago is still
    // in the text of this one — a mock that re-ran it would rewrite the file on
    // every subsequent turn and the companion's change census would be right to
    // report it, which is a bug in the fixture and not in the thing under test.
    // …and it is the NEW one that counts: the history sits above the message,
    // so the first match in the text is the oldest, not the current ask.
    const wm = [...String(text).matchAll(/\[mock:write(?::([^\]]+))?\]/g)]
      .filter(m => !written.has(m[0])).pop();
    const write = wm && (wm[1] || process.env.MOCK_WRITE_FILE || '');
    if (write) {
      written.add(wm[0]);
      try {
        fs.mkdirSync(path.dirname(write), { recursive: true });
        fs.writeFileSync(write, `rewritten by the mock at ${new Date().toISOString()}\n`);
      } catch { }
    }
    // [mock:copy:<from>|<to>] — the same act with CONTENT the test chose.
    // `[mock:write]` stamps a one-line placeholder, which proves a file moved
    // and nothing else; a test about what the turn-end DIFF makes of an edit
    // needs the edit to be a real one, so this copies a prepared file over the
    // target. Once per directive, exactly as above and for the same reason.
    // The separator is `|` because both halves are absolute paths.
    const cm = [...String(text).matchAll(/\[mock:copy:([^\]|]+)\|([^\]]+)\]/g)]
      .filter(m => !written.has(m[0])).pop();
    if (cm) {
      written.add(cm[0]);
      try {
        fs.mkdirSync(path.dirname(cm[2]), { recursive: true });
        fs.copyFileSync(cm[1], cm[2]);
      } catch { }
    }
    for (const model of models) {
      const stream_id = `${sid || 's0'}:room:${model}:${++streamSeq}`;
      const head = { stream_id, pane: 'room', model };
      // a turn that used tools emits the activity summary as its own room
      // entry first — with a `:tools` stream id, or none at all when the
      // response was not streamed
      if (/\[mock:tools\]/.test(text)) {
        emit({ type: 'room', speaker: model, blocks: [], stream_id: `${stream_id}:tools`,
          text: 'Explored\n└ Fetch https://ledger.test/2026/night-trains' });
        emit({ type: 'room', speaker: model, blocks: [],
          text: 'Explored\n├ Search web for night train load factors\n└ Read notes.md' });
      }
      // [mock:reads:…] — the answer a bot gives when its change REWROTE the
      // passage a comment is about: it quotes the new wording back verbatim
      // (bridge-system-prompt rule 5), which is what lets the page re-anchor
      // the thread onto the rewrite instead of leaving it orphaned.
      const reads = /\[mock:reads:([^\]]+)\]/.exec(text);
      // [mock:says:…] — the whole reply, verbatim, with `\\n` for newlines.
      // For the tests that care what a bot's WORDS are rather than that it
      // answered: a filing suggestion has to sit on a line of its own.
      //
      // The LAST one in the turn, for the same reason [mock:write] takes the
      // last: the envelope replays the thread's history above the new message,
      // so a directive the reader sent two turns ago is still in this turn's
      // text — and the first match is the oldest, not the current ask. A thread
      // where the reader asks claude, then asks codex, would otherwise have
      // codex answering in claude's words.
      const says = [...String(text).matchAll(/\[mock:says:([^\]]+)\]/g)].pop();
      const body = says
        ? String(says[1]).split('\\n').join('\n')
        : reads
          ? `Done — this passage now reads: "${reads[1]}"`
          : `MOCK ${model} reply.`;
      emit({ type: 'stream', kind: 'start', ...head });
      emit({ type: 'stream', kind: 'text_delta', ...head, text: body.slice(0, 5) });
      emit({ type: 'stream', kind: 'text_delta', ...head, text: body.slice(5) });
      emit({ type: 'stream', kind: 'done', ...head });
      room(model, body);
    }
    // every turn burns context: tokens always move, pct only on demand
    use.claude_tokens += 1200; use.codex_tokens += 900;
    if (/\[mock:pct\]/.test(text)) { use.claude_pct += 5; use.codex_pct += 4; }
    status();
    emit({ type: 'ready' });
    // the chat has an entry now, so the panel can finally see it — and the
    // snapshot lands AFTER the ready, exactly as the real bridge's post-turn
    // sync does. [mock:nosid] withholds it, simulating a bridge that never
    // confirms the new session.
    if (sid && !/\[mock:nosid\]/.test(text)) {
      touch(sid).entries += 1;
      setTimeout(projects, 30);
    }
  }, slow ? Number(slow[1]) : DELAY);
}

let buf = '';
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    log(ev);
    if (ev.type === 'input') input(String(ev.text || ''));
    if (ev.type === 'choice_response' && pendingDelete) {
      const target = pendingDelete; pendingDelete = null;
      if (ev.index === 0) {
        const i = sessions.findIndex(s => s.session_id === target);
        if (i >= 0) sessions.splice(i, 1);
        if (sid === target) sid = null;
        room('system', `Deleted “${target}”.`);
        projects();
      } else room('system', 'Delete cancelled.');
      ready();
    }
  }
});

completionContext();
projects();
status();
emit({ type: 'ready' });
