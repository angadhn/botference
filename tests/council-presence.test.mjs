// In-process HTTP handlers and bridge events only: no listening server/CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function council(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-presence-'));
  const saved = { ...process.env };
  const args = [...process.argv];
  Object.assign(process.env, {
    COUNCIL_NO_LISTEN: '1', BOTFERENCE_PROJECT_ROOT: root, COUNCIL_PASSWORD: 'presence-test',
  });
  process.argv.push('--hosted');
  t.after(() => {
    process.argv.splice(0, process.argv.length, ...args);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return import(`../frontends/council/server.mjs?test=${encodeURIComponent(root)}`);
}

function request(handler, url = '/presence', auth = true) {
  const req = new EventEmitter();
  Object.assign(req, { method: 'GET', url, headers: auth ? {
    authorization: `Basic ${Buffer.from(':presence-test').toString('base64')}`,
  } : {} });
  const res = {
    body: '', status: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    write(chunk) { this.body += chunk; },
    end(chunk = '') { this.body += chunk; return this; },
  };
  handler(req, res);
  return { req, res, json: () => JSON.parse(res.body) };
}
const start = (chat, project, model = 'claude', stream = 'same-local-id') => ({
  type: 'stream', kind: 'start', stream_id: stream, model, pane: 'room',
  chat_id: chat, project_id: project, project_association: project ? 'session' : 'unknown',
  ...(model === 'agent' ? { agent: { id: 'build-card', cli: 'codex', parent_stream_id: 'parent' } } : {}),
});
const events = res => res.body.split('\n\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));

test('concurrent turns and builds have distinct stable identities and explicit project associations', async t => {
  const { Bridge, handler } = await council(t);
  const a = new Bridge('wrong-claim');
  const b = new Bridge('chat-b');
  a.handle(start('chat-a', 'project-a'));
  b.handle(start('chat-b', 'project-b'));
  a.handle(start('chat-a', 'project-a', 'agent', 'build-stream'));
  b.handle(start('chat-b', null, 'agent', 'unfiled-build'));
  // Saved cards and ordinary prose never create workers or move projects.
  b.handle({ type: 'room', speaker: 'agent', agent: { id: 'old', status: 'working' }, restored: true });
  a.handle({ type: 'room', speaker: 'claude', text: 'Moving to project-b now.' });
  const first = request(handler).json();
  assert.equal(first.runs.length, 4);
  assert.equal(new Set(first.runs.map(r => r.run_id)).size, 4);
  assert.deepEqual(first.runs.map(r => [r.kind, r.agent_family, r.chat_id, r.project_id]), [
    ['turn', 'claude', 'chat-a', 'project-a'], ['turn', 'claude', 'chat-b', 'project-b'],
    ['build', 'codex', 'chat-a', 'project-a'], ['build', 'codex', 'chat-b', null],
  ]);
  assert.equal(first.runs[3].project_association, 'unknown');
  assert.equal(first.runs[2].agent_id, 'build-card');
  assert.equal(first.runs[2].parent_stream_id, 'parent');
  for (const r of first.runs) {
    assert.equal(r.state, 'running');
    assert.ok(Number.isFinite(Date.parse(r.started_at)));
    assert.equal(r.ended_at, null);
  }
  a.handle({ type: 'stream', kind: 'text_delta', stream_id: 'same-local-id', text: 'still here' });
  assert.deepEqual(request(handler).json().runs, first.runs);
  a.disconnect(); b.disconnect();
});

test('authenticated reconnect replaces runtime state; completion, reset, bridge loss and restart cannot revive workers', async t => {
  const { Bridge, handler } = await council(t);
  for (const url of ['/presence', '/events?scope=presence']) assert.equal(request(handler, url, false).res.status, 401);
  const a = new Bridge();
  const b = new Bridge();
  a.handle(start('a', 'one'));
  b.handle(start('b', 'two', 'agent'));
  const initial = request(handler).json();
  const live = request(handler, '/events?scope=presence');
  assert.equal(live.res.status, 200);
  assert.equal(live.res.headers['cache-control'], 'no-store');
  assert.deepEqual(events(live.res)[0].runs, initial.runs);
  // Losing the viewing browser is not losing the worker.
  live.req.emit('close');
  a.handle({ type: 'stream', kind: 'done', stream_id: 'same-local-id', outcome: 'completed' });
  assert.equal(events(live.res).length, 1, 'closed subscribers are removed');
  const resumed = request(handler, '/events?scope=presence');
  let current = events(resumed.res).at(-1);
  assert.deepEqual(current.runs.map(r => r.run_id), [initial.runs[1].run_id]);
  assert.equal(current.recent[0].state, 'completed');
  b.handle({ type: 'stream', kind: 'done', stream_id: 'same-local-id', outcome: 'failed' });
  a.handle(start('a', 'one', 'codex', 'cancel'));
  a.handle({ type: 'stream', kind: 'done', stream_id: 'cancel', outcome: 'cancelled' });
  a.handle(start('a', 'one', 'claude', 'leftover'));
  a.handle({ type: 'ready' });
  a.handle(start('a', 'one', 'claude', 'reset'));
  a.handle({ type: 'clear_panes' });
  a.handle(start('a', 'one', 'claude', 'lost'));
  b.handle(start('b', 'two', 'agent', 'survives'));
  a.disconnect({ code: 1 });
  a.handle(start('a', 'one', 'claude', 'late-buffered-start'));
  assert.equal(request(handler).json().runs.length, 1, 'one bridge dying does not clear another');
  b.disconnect();
  current = events(resumed.res).at(-1);
  assert.deepEqual(current.runs, []);
  assert.deepEqual(current.recent.map(r => r.state), [
    'completed', 'failed', 'cancelled', 'interrupted', 'interrupted', 'disconnected', 'disconnected',
  ]);
  assert.ok(current.revision > initial.revision);
  for (const r of current.recent) {
    assert.ok(Date.parse(r.ended_at) >= Date.parse(r.started_at));
    assert.equal(r.updated_at, r.ended_at);
  }
  resumed.req.emit('close');
  const restarted = await council(t);
  const fresh = new restarted.Bridge();
  fresh.handle({ type: 'room_batch', entries: [{ speaker: 'agent', agent: { status: 'working' } }] });
  fresh.handle({ type: 'room', speaker: 'agent', restored: true, agent: { status: 'working' } });
  const recovered = request(restarted.handler).json();
  assert.notEqual(recovered.server_id, initial.server_id);
  assert.deepEqual(recovered.runs, []);
  assert.deepEqual(recovered.recent, []);
  fresh.handle(start('a', 'one'));
  assert.notEqual(request(restarted.handler).json().runs[0].run_id, initial.runs[0].run_id);
  fresh.disconnect();
});
