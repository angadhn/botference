#!/usr/bin/env node
// Stand-in for core/botference_ink_bridge.py: speaks the same JSONL protocol
// (input on stdin, events on stdout) with none of the CLIs behind it, so
// companion.test.mjs can exercise the whole turn choreography deterministically.
// Every stdin object is appended to $MOCK_BRIDGE_LOG for the test to assert on.
import fs from 'node:fs';

const LOG = process.env.MOCK_BRIDGE_LOG || '';
const DELAY = Number(process.env.MOCK_TURN_DELAY_MS || 0);
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
const log = o => { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch { } } };
const ready = () => setImmediate(() => emit({ type: 'ready' }));
const room = (speaker, text) => emit({ type: 'room', speaker, text, blocks: [] });

let seq = 0, streamSeq = 0, sid = null;
const sessions = [];
const MODELS = {
  claude: ['claude-fable-5', 'claude-opus-5', 'claude-haiku-4-5'],
  codex: ['gpt-5.6-sol', 'gpt-5.5', 'o3'],
};
const live = { claude: 'claude-fable-5', codex: 'gpt-5.6-sol' };
// occupancy: tokens creep on every status (the heartbeat), pct only when a
// turn asks for it — the companion must broadcast on the latter, not the former
const use = { claude_tokens: 42000, codex_tokens: 31000, claude_pct: 4, codex_pct: 3 };
const status = () => emit({
  type: 'status', mode: 'plan', lead: 'claude', route: '@all', project: 'plugin-pages',
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
  },
});
const touch = id => sessions.find(s => s.session_id === id)
  || (sessions.push({ session_id: id, title: 'Untitled' }), sessions[sessions.length - 1]);

function projects() {
  emit({
    type: 'projects',
    active_project_id: 'plugin-pages',
    inbox_session_count: 0,
    inbox_sessions: [],
    projects: [{
      id: 'plugin-pages', title: 'Plugin pages', status: 'active', next_action: '',
      active: true, session_count: sessions.length,
      sessions: sessions.map(s => ({
        session_id: s.session_id, title: s.title,
        updated_at: new Date().toISOString(), active: s.session_id === sid,
      })),
    }],
  });
}

function input(text) {
  if (text.startsWith('/project create')) { room('system', 'Created project Plugin pages (plugin-pages).'); return ready(); }
  if (text.startsWith('/project open')) { room('system', 'Project context set to Plugin pages (plugin-pages).'); projects(); return ready(); }
  if (text.trim() === '/new') {
    seq++; sid = `sess-${seq}`; touch(sid);
    emit({ type: 'clear_panes' });
    projects();
    return ready();
  }
  if (text.startsWith('/rename ')) {
    touch(sid).title = text.slice('/rename '.length);
    projects();
    room('system', `Renamed chat to ${touch(sid).title}`);
    return ready();
  }
  if (text.startsWith('/resume ')) {
    sid = text.slice('/resume '.length).trim(); touch(sid);
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
  if (text.startsWith('/')) { room('system', 'ok'); return ready(); }

  const models = /^@all\b/.test(text) ? ['claude', 'codex'] : [/^@codex\b/.test(text) ? 'codex' : 'claude'];
  setTimeout(() => {
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
      emit({ type: 'stream', kind: 'start', ...head });
      emit({ type: 'stream', kind: 'text_delta', ...head, text: 'MOCK ' });
      emit({ type: 'stream', kind: 'text_delta', ...head, text: `${model} reply.` });
      emit({ type: 'stream', kind: 'done', ...head });
      room(model, `MOCK ${model} reply.`);
    }
    // every turn burns context: tokens always move, pct only on demand
    use.claude_tokens += 1200; use.codex_tokens += 900;
    if (/\[mock:pct\]/.test(text)) { use.claude_pct += 5; use.codex_pct += 4; }
    status();
    emit({ type: 'ready' });
  }, DELAY);
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
  }
});

completionContext();
projects();
status();
emit({ type: 'ready' });
