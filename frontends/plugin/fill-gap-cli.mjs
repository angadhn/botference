#!/usr/bin/env node
// fill-gap-cli.mjs — `botference fill-gap`: one passage for a gap in the owner's own draft, for a blog's build tooling.
//
//   echo '{"agent":"claude","instruction":"explain X in 80 words","context":"…draft with [GAP]…","words":80}' | botference fill-gap
//   → {"text":"…","model":"…","at":"2026-11-25T10:00:00Z"}            exit 0
//   → {"error":"…"}                                                   exit 1 (refused or not written), 2 (usage)
//
// Input (JSON on stdin): agent (claude | codex), instruction (the owner's, at most 500 characters), context (the whole draft
// with this gap marked [GAP]), and optionally words (a target length), inline (true: the gap sits inside a sentence) and task
// ('gap', the default, or 'note': at most 80 words on the draft's structure or logic; the instruction is then not used).
//
// It is the companion's contained one-shot exactly (oneshot.mjs: no tools, minimal environment, Codex jailed, bounded time),
// with the model and effort the owner set for that agent in the companion's settings (config.json of the folder it is run in;
// read only, never written). It reads nothing else: not the blog, not the draft's files. The draft is quoted data
// (tkgaps.draftPrompt) and the answer is untrusted plain text, cut at GAP_LIMITS.outputChars; whoever writes it anywhere
// escapes it. PLUGIN_ONESHOT_CMD (a JSON argv) replaces the agent's CLI in tests, as it does for the companion.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { runOneShot, codexJail, claudeJail, ONESHOT_AGENTS, CLAUDE_FETCH_RULES_VERSION } from './oneshot.mjs';
import { validateTkRead, tkCapsFor, ownerHosts } from './tk-read.mjs';
import { draftPrompt, DRAFT_TASKS, GAP_LIMITS } from './tkgaps.mjs';
import { CONFIG_PATH, MODEL_RE, EFFORT_RE } from './store.mjs';
import { readJsonState } from './fsjson.mjs';

const INPUT_MAX = 512 * 1024;
const CONTEXT_MAX = 200000;
const NOTE_WORDS = 80;

/** The model and effort the companion's settings give `agent` (read only). Nothing set: no model (the CLI's own), medium. */
export function agentSetting(agent, file = CONFIG_PATH) {
  const got = readJsonState(file);
  const a = (got.state === 'ok' && got.value && got.value.agents) || {};
  const model = (a.model || {})[agent];
  const effort = (a.effort || {})[agent];
  return { model: typeof model === 'string' && MODEL_RE.test(model) && !model.startsWith('-') ? model : '',
    effort: typeof effort === 'string' && EFFORT_RE.test(effort) ? effort : 'medium' };
}

/** The request, checked. → { ok: true, req } | { ok: false, error } */
export function checkRequest(raw) {
  let r;
  try { r = JSON.parse(raw); } catch { return { ok: false, error: 'the input is not JSON' }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: 'the input must be one JSON object' };
  const task = r.task === undefined ? 'gap' : r.task;
  if (!DRAFT_TASKS.includes(task)) return { ok: false, error: `task must be one of ${DRAFT_TASKS.join(', ')}` };
  if (!ONESHOT_AGENTS.includes(r.agent)) return { ok: false, error: `agent must be one of ${ONESHOT_AGENTS.join(', ')}` };
  if (typeof r.context !== 'string' || r.context.length > CONTEXT_MAX) return { ok: false, error: `context must be the draft, at most ${CONTEXT_MAX} characters` };
  if (task === 'gap' && (typeof r.instruction !== 'string' || !r.instruction.trim() || r.instruction.length > GAP_LIMITS.instructionChars)) {
    return { ok: false, error: `instruction must be text of at most ${GAP_LIMITS.instructionChars} characters` };
  }
  if (r.words !== undefined && !(Number.isInteger(r.words) && r.words > 0 && r.words <= 5000)) return { ok: false, error: 'words must be a whole number from 1 to 5000' };
  return { ok: true, req: { task, agent: r.agent, instruction: task === 'gap' ? r.instruction : '', context: r.context,
    words: task === 'note' ? NOTE_WORDS : r.words, inline: r.inline === true } };
}

const firstWords = (t, n) => { const w = t.split(/\s+/); return w.length <= n ? t : w.slice(0, n).join(' ') + '…'; };

/** One answer. → { text, model?, at } | { error } */
export async function fillGap(req, { env = process.env, config = CONFIG_PATH, now = Date.now } = {}) {
  const { model, effort } = agentSetting(req.agent, config);
  // what the agent may use: the same capability set as a /tk passage written on this machine (channel api), from the same settings
  const got = readJsonState(config);
  const read = validateTkRead(got.state === 'ok' ? got.value : {});
  const caps = tkCapsFor({ read, agent: req.agent, channel: 'api' });
  const roots = caps === 'web+notes' ? read.roots : [];
  // (a notes run fetches only from the hosts the owner's instruction names)
  const fetchHosts = caps === 'web+notes' ? ownerHosts(req.instruction) : [];
  const prompt = draftPrompt({ task: req.task, instruction: req.instruction, context: req.context, words: req.words, inline: req.inline, caps, roots });
  const r = await runOneShot(req.agent, prompt, { model, effort, env, caps, roots, fetchHosts, ...override(env) });
  let text = r && r.ok ? String(r.text || '').trim().slice(0, GAP_LIMITS.outputChars) : '';
  if (req.task === 'note') text = firstWords(text, NOTE_WORDS);
  if (!text) return { error: (r && r.error) || 'the agent wrote nothing' };
  return { text, ...(model ? { model } : {}), at: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

// tests: PLUGIN_ONESHOT_CMD replaces the CLI (the stand-in is started with the CLI's argv after its own, and told where to log)
function override(env) {
  if (!env.PLUGIN_ONESHOT_CMD) return {};
  const argv = JSON.parse(env.PLUGIN_ONESHOT_CMD);
  return { spawn: (cmd, args, o) => spawn(argv[0], [...argv.slice(1), cmd, ...args],
    { ...o, env: { ...o.env, ...(env.ONESHOT_LOG ? { ONESHOT_LOG: env.ONESHOT_LOG } : {}) } }),
  jail: o => codexJail({ ...o, bin: 'codex' }), claudeJail: o => claudeJail({ ...o, bin: 'claude', install: '/usr/bin' }),
  cliVersion: async () => env.PLUGIN_ONESHOT_CLAUDE_VERSION || CLAUDE_FETCH_RULES_VERSION };
}

async function main() {
  if (process.argv.slice(2).some(a => a === '-h' || a === '--help')) {
    process.stdout.write('Usage: botference fill-gap < request.json\n'
      + '  {"agent":"claude|codex","instruction":"…","context":"the draft with [GAP]","words":80,"inline":false,"task":"gap|note"}\n'
      + '  → {"text","model","at"} on stdout (exit 0), or {"error"} (exit 1)\n');
    return 0;
  }
  if (process.argv.length > 2) { process.stdout.write(JSON.stringify({ error: 'fill-gap takes no arguments; the request is JSON on stdin' }) + '\n'); return 2; }
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > INPUT_MAX) { process.stdout.write(JSON.stringify({ error: 'the input is too long' }) + '\n'); return 2; } }
  const c = checkRequest(raw);
  if (!c.ok) { process.stdout.write(JSON.stringify({ error: c.error }) + '\n'); return 2; }
  const out = await fillGap(c.req);
  process.stdout.write(JSON.stringify(out) + '\n');
  return out.error ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main().then(code => { process.exitCode = code; }, e => { process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }) + '\n'); process.exitCode = 1; });
}
