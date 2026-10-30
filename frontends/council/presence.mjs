import { randomUUID } from 'node:crypto';

// Process-local runtime state. Never hydrate this from transcript/history:
// saved build cards can say "working" long after their process has died.
export class Presence {
  constructor({ changed = () => {}, now = () => new Date().toISOString(), root = null, heartbeatMs = 15000 } = {}) {
    this.serverId = randomUUID();
    this.revision = 0;
    this.active = new Map();
    this.recent = [];
    this.changed = changed;
    this.now = now;
    this.root = root;
    this.heartbeatMs = heartbeatMs;
  }
  key(bridgeId, streamId) { return JSON.stringify([bridgeId, streamId]); }
  hasBridge(bridgeId) {
    return [...this.active.values()].some(r => r.bridge_id === bridgeId);
  }
  snapshot() {
    return {
      type: 'presence', version: 1, server_id: this.serverId,
      root: this.root, heartbeat_ms: this.heartbeatMs,
      revision: this.revision, generated_at: this.now(),
      runs: [...this.active.values()].map(r => ({ ...r })),
      recent: this.recent.map(r => ({ ...r })),
    };
  }
  publish() {
    this.revision++;
    this.changed(this.snapshot());
  }
  handle(bridgeId, ev) {
    // start/done are emitted around actual adapter calls, never on resume.
    if (ev.type !== 'stream' || !ev.stream_id || ev.restored) return;
    const key = this.key(bridgeId, ev.stream_id);
    if (ev.kind === 'start') {
      if (this.active.has(key)) return;
      const build = ev.model === 'agent';
      if (!build && !['claude', 'codex'].includes(ev.model)) return;
      const family = build ? ev.agent?.cli : ev.model;
      const verified = ev.chat_id && ev.project_id && ev.project_association === 'session';
      const stamp = this.now();
      this.active.set(key, {
        run_id: `${this.serverId}:${randomUUID()}`,
        bridge_id: bridgeId, stream_id: ev.stream_id,
        kind: build ? 'build' : 'turn',
        agent_family: ['claude', 'codex'].includes(family) ? family : 'unknown',
        agent_id: build ? ev.agent?.id || null : null,
        parent_stream_id: build ? ev.agent?.parent_stream_id || null : null,
        chat_id: ev.chat_id || null,
        project_id: verified ? ev.project_id : null,
        project_association: verified ? 'session' : 'unknown',
        state: 'running', started_at: stamp, updated_at: stamp, ended_at: null,
      });
      this.publish();
    } else if (ev.kind === 'done' && this.active.has(key)) {
      // An old bridge's done without an outcome is terminal, but its success
      // is unknown. Never silently paint an exception as a successful build.
      const state = ['completed', 'failed', 'cancelled'].includes(ev.outcome) ? ev.outcome : 'interrupted';
      this.finish(key, state, state === 'interrupted' ? 'outcome_unknown' : 'adapter_finished');
      this.publish();
    }
  }
  finish(key, state, reason) {
    const run = this.active.get(key);
    if (!run) return;
    this.active.delete(key);
    const stamp = this.now();
    this.recent.push({ ...run, state, reason, updated_at: stamp, ended_at: stamp });
    // Terminal records are for badges/debugging, never active avatars. Keep
    // reconnect cost bounded even after a server has run for many days.
    if (this.recent.length > 100) this.recent.splice(0, this.recent.length - 100);
  }
  closeBridge(bridgeId, state = 'disconnected', reason = 'bridge_lost') {
    let changed = false;
    for (const [key, run] of this.active) {
      if (run.bridge_id !== bridgeId) continue;
      this.finish(key, state, reason);
      changed = true;
    }
    if (changed) this.publish();
  }
}
