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
// Codex (`codex exec`, the CLI's non-interactive form) has no tool-less switch, so it is LOCKED DOWN as far as
// its flags go (CODEX_LOCKDOWN, below): no user config (`--ignore-user-config`, so no MCP servers, profiles or
// rules from the owner's ~/.codex; auth still comes from there), no execpolicy rules, nothing saved
// (`--ephemeral`), a read-only sandbox (`--sandbox read-only`: commands could read, never write or reach the
// network), approvals never asked (`approval_policy="never"`), web search off, no MCP servers, and the tools that
// run or look at anything turned off as features (shell, unified exec, apps, plugins, browser and computer use,
// image tools, sub-agents, hooks, memories); its working root is a fresh empty folder removed after; the prompt
// on stdin; only the last message is read, from a file of its own (`-o`), as text. What it can STILL do: the
// read-only sandbox lets a command read any file the owner can read, so the protection against reading the
// disk is that no tool that runs a command or opens a file is left on, which these flags say and which is not
// proven here by running a model. The gap's prompt holds the page's words as quoted data (tkgaps.gapPrompt),
// and a post with any agent's text is always shown to the owner before it is published (blyg-run.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';

export const ONESHOT_AGENTS = Object.freeze(['claude', 'codex']);
// What makes `codex exec` as close to a tool-less one-shot as its flags allow (see above). Every item is checked by the tests.
export const CODEX_OFF_FEATURES = Object.freeze(['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'image_generation', 'view_image', 'multi_agent', 'hooks', 'memories', 'tool_suggest', 'skill_search',
  'skill_mcp_dependency_install', 'goals']);
export const CODEX_LOCKDOWN = Object.freeze(['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
  '--sandbox', 'read-only', '--color', 'never',
  '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '-c', 'sandbox_workspace_write.network_access=false',
  ...CODEX_OFF_FEATURES.flatMap(f => ['--disable', f])]);
// the efforts each CLI is given (the owner's chat setting; medium when none is set)
export const DEFAULT_EFFORT = 'medium';
const DENY_ALL = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Task', 'Agent', 'TodoWrite', 'mcp__*'];

/** The command for a one-shot of `agent`, or null when there is none. `dir` is the fresh working folder, `out` the file codex
 *  writes its last message to (outside that folder). */
export function oneshotCommand(agent, { model = '', effort = '', dir = '', out = '' } = {}) {
  if (agent === 'claude') {
    return { cmd: 'claude', args: ['-p', '--tools', '', '--strict-mcp-config', '--restricted',
      '--settings', JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: [], deny: DENY_ALL } }),
      '--output-format', 'text', ...(model ? ['--model', String(model)] : []), ...(effort ? ['--effort', String(effort)] : [])] };
  }
  if (agent === 'codex') {
    return { cmd: 'codex', args: ['exec', ...CODEX_LOCKDOWN, '--cd', dir, '-o', out,
      ...(model ? ['-m', String(model)] : []), '-c', `model_reasoning_effort="${String(effort || DEFAULT_EFFORT).replace(/[^\w-]/g, '')}"`, '-'],
      lastMessage: out };
  }
  return null;
}

/**
 * → Promise<{ ok: true, text, model? } | { ok: false, error }>. Never throws.
 * `spawn` is injectable for the tests (a stand-in that records what it was
 * given and answers, or never answers).
 */
export function runOneShot(agent, prompt, { model = '', effort = '', timeoutMs = 60000, maxBytes = 64 * 1024, spawn = realSpawn } = {}) {
  if (!ONESHOT_AGENTS.includes(agent)) return Promise.resolve({ ok: false, error: `${agent} cannot fill gaps here` });
  return new Promise(resolve => {
    let dir = '';
    let outDir = '';
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-oneshot-')); } catch { resolve({ ok: false, error: 'could not make a folder for the agent' }); return; }
    try { outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-oneshot-out-')); } catch { outDir = ''; }
    const c = oneshotCommand(agent, { model, effort, dir, out: outDir ? path.join(outDir, 'last.txt') : '' });
    if (!c || (c.lastMessage === '' && agent === 'codex')) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } resolve({ ok: false, error: `could not start ${agent}` }); return; }
    let child;
    let out = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => { for (const d of [dir, outDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a temp folder */ } } };
    const done = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(r);
    };
    // the wait abandoned is the run stopped: nothing keeps running (or billing)
    const timer = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch { /* gone */ } done({ ok: false, error: 'the agent took too long' }); }, timeoutMs);
    try { child = spawn(c.cmd, c.args, { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { done({ ok: false, error: `could not start ${agent}` }); return; }
    child.on('error', () => done({ ok: false, error: `could not start ${agent}` }));
    child.stdout.on('data', d => {
      // claude answers on stdout; codex's stdout is its progress, read only to stop a flood
      out = Buffer.concat([out, d]);
      if (out.length > maxBytes) { try { child.kill('SIGKILL'); } catch { /* gone */ } out = out.subarray(0, maxBytes); }
    });
    child.on('close', code => {
      if (settled) return;
      let text = '';
      let full = false;
      if (c.lastMessage) {
        // codex: the last message only, from its own file, as text, under the same cap
        try { const buf = fs.readFileSync(c.lastMessage); full = buf.length >= maxBytes; text = buf.subarray(0, maxBytes).toString('utf8').trim(); } catch { text = ''; }
      } else { text = out.toString('utf8').trim(); full = out.length >= maxBytes; }
      if (code === 0 || (text && full)) done(text ? { ok: true, text, ...(model ? { model } : {}) } : { ok: false, error: 'the agent wrote nothing' });
      else done({ ok: false, error: `the agent stopped (exit ${code})` });
    });
    try { child.stdin.end(String(prompt)); } catch { /* the close handler answers */ }
  });
}
