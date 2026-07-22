// Deterministic stand-in for core/botference_ink_bridge.py in council-web
// tests: speaks the same JSONL protocol (events out on stdout, input in on
// stdin) with canned content. argv[2] = file where received input text is
// appended (one line per turn), so tests can assert verbatim delivery.
import fs from 'node:fs';
import readline from 'node:readline';

const rxFile = process.argv[2];
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');

emit({ type: 'completion_context', global: ['/status', '/new', '/resume', '@claude ', '@codex '], scoped: { '/model @claude ': ['claude-fable-5', 'claude-opus-4-8'], '/model @codex ': ['gpt-5.6-sol', 'gpt-5.5'] } });
emit({ type: 'status', mode: 'chat', lead: '', route: '@all', project: 'demo', claude_pct: 12, codex_pct: 4, claude_model: 'claude-fable-5', codex_model: 'gpt-5.6-sol' });
emit({
  type: 'projects', active_project_id: 'p1', inbox_session_count: 2,
  projects: [{
    id: 'p1', title: 'Demo project', status: 'active', next_action: '', active: true, session_count: 1,
    sessions: [{ session_id: 'abc12345', title: 'First chat', updated_at: new Date().toISOString(), active: true }],
  }],
});
emit({ type: 'room', speaker: 'system', text: 'Council room ready. First plain text routes to @all.' });
emit({ type: 'ready' });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'input') {
    if (rxFile) fs.appendFileSync(rxFile, msg.text + '\n');
    // attachments are recorded verbatim so tests can assert the exact
    // bridge schema ({id, path, type:'image'} — what the Ink TUI sends)
    if (rxFile && Array.isArray(msg.attachments) && msg.attachments.length) {
      fs.appendFileSync(rxFile, 'ATT ' + JSON.stringify(msg.attachments) + '\n');
    }
    if (msg.text === '/trigger-choice') {
      emit({ type: 'choice_request', prompt: 'Where should this chat live?', options: ['Stay in inbox', 'Demo project'] });
      return; // choice_response resolves it below
    }
    if (msg.text === '/trigger-permission') {
      emit({ type: 'permission_request', request_id: 'r1', model: 'claude', path: '/tmp/x.md', reason: 'draft' });
      return;
    }
    if (msg.text === '/trigger-clear') {
      // resume/new-chat shape: clear_panes wipes the server's event history
      emit({ type: 'clear_panes' });
      emit({ type: 'room', speaker: 'system', text: 'fresh chat' });
      emit({ type: 'ready' });
      return;
    }
    // model switch: reflect the new current model back in a status event, as
    // the real bridge does once the controller applies /model @agent <model>
    const mm = /^\/model @(claude|codex) ([\w.-]+)$/.exec(String(msg.text).trim());
    if (mm) {
      const key = mm[1] === 'claude' ? 'claude_model' : 'codex_model';
      emit({ type: 'status', mode: 'chat', lead: '', route: '@all', project: 'demo', claude_pct: 12, codex_pct: 4, claude_model: 'claude-fable-5', codex_model: 'gpt-5.6-sol', [key]: mm[2] });
      emit({ type: 'room', speaker: 'system', text: `model set: @${mm[1]} → ${mm[2]}`, stream_id: 'm1' });
      emit({ type: 'ready' });
      return;
    }
    emit({ type: 'stream', kind: 'text_delta', stream_id: 's1', pane: 'room', model: 'claude', text: 'thinking about ' });
    emit({ type: 'stream', kind: 'text_delta', stream_id: 's1', pane: 'room', model: 'claude', text: 'your message' });
    emit({ type: 'room', speaker: 'claude', text: `echo: ${msg.text}`, stream_id: 's1' });
    emit({ type: 'ready' });
  }
  if (msg.type === 'choice_response') {
    emit({ type: 'choice_cleared' });
    emit({ type: 'room', speaker: 'system', text: `choice answered: ${msg.index}` });
    emit({ type: 'ready' });
  }
  if (msg.type === 'permission_response') {
    emit({ type: 'permission_cleared' });
    emit({ type: 'room', speaker: 'system', text: `permission: ${msg.allow}` });
    emit({ type: 'ready' });
  }
});
