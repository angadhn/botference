// oneshot.mjs — one question to a bot, in a fresh session with no tools.
//
// A TK gap (tkgaps.mjs) is filled by a bot that has read nothing of the page's
// conversation and can do nothing but write text: it is NOT a turn on the
// page's own agent session (which holds the page snapshot, every guest's
// message, every earlier bot reply, and the bots' ordinary tools). So the
// companion starts the bot's CLI itself, once, here:
//
//   claude -p, with no built-in tools at all (`--tools ""`, the form the
//   council's own title call and the Doc-comment watcher use), no MCP servers
//   (`--strict-mcp-config` with none given), no user, project or local
//   settings files (`--restricted`), every tool also denied by settings, no
//   session to resume, in a fresh empty folder; the prompt on stdin; the
//   answer read as plain text and cut at a hard limit; the process killed if
//   it runs past its time, so an abandoned gap is not left running.
//
// Codex has no such tool-less one-shot form in this repo's adapters, so Codex
// cannot fill gaps (ONESHOT_AGENTS); a gap asked of it is left unfilled and
// says so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';

export const ONESHOT_AGENTS = Object.freeze(['claude']);
const DENY_ALL = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Task', 'Agent', 'TodoWrite', 'mcp__*'];

/** The command for a tool-less one-shot of `agent`, or null when there is none. */
export function oneshotCommand(agent, { model = '' } = {}) {
  if (agent !== 'claude') return null;
  return { cmd: 'claude', args: ['-p', '--tools', '', '--strict-mcp-config', '--restricted',
    '--settings', JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: [], deny: DENY_ALL } }),
    '--output-format', 'text', ...(model ? ['--model', String(model)] : [])] };
}

/**
 * → Promise<{ ok: true, text, model? } | { ok: false, error }>. Never throws.
 * `spawn` is injectable for the tests (a stand-in that records what it was
 * given and answers, or never answers).
 */
export function runOneShot(agent, prompt, { model = '', timeoutMs = 60000, maxBytes = 64 * 1024, spawn = realSpawn } = {}) {
  const c = oneshotCommand(agent, { model });
  if (!c) return Promise.resolve({ ok: false, error: `${agent} cannot fill gaps here (no tool-less one-shot form for it)` });
  return new Promise(resolve => {
    let dir = '';
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-oneshot-')); } catch { dir = os.tmpdir(); }
    let child;
    try { child = spawn(c.cmd, c.args, { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { resolve({ ok: false, error: `could not start ${agent}` }); return; }
    let out = Buffer.alloc(0);
    let settled = false;
    const done = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a temp folder */ }
      resolve(r);
    };
    // the wait abandoned is the run stopped: nothing keeps running (or billing)
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done({ ok: false, error: 'the agent took too long' }); }, timeoutMs);
    child.on('error', () => done({ ok: false, error: `could not start ${agent}` }));
    child.stdout.on('data', d => {
      out = Buffer.concat([out, d]);
      if (out.length > maxBytes) { try { child.kill('SIGKILL'); } catch { /* gone */ } out = out.subarray(0, maxBytes); }
    });
    child.on('close', code => {
      const text = out.toString('utf8').trim();
      if (settled) return;
      if (code === 0 || (text && out.length >= maxBytes)) done(text ? { ok: true, text, ...(model ? { model } : {}) } : { ok: false, error: 'the agent wrote nothing' });
      else done({ ok: false, error: `the agent stopped (exit ${code})` });
    });
    try { child.stdin.end(String(prompt)); } catch { /* the close handler answers */ }
  });
}
