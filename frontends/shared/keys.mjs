// API keys, for people who would rather spend credit than a subscription.
//
// Both frontends — Discuss (the browser plugin's companion) and the council
// web server — drive the `claude` and `codex` CLIs, and those CLIs already
// know how to prefer an API key over the login they hold: give the child
// process ANTHROPIC_API_KEY / OPENAI_API_KEY and it bills the key; leave the
// variable out and it uses whatever the user logged in with. So there is
// nothing to implement in either protocol — the whole feature is deciding what
// the bridge's environment says at spawn, per agent.
//
// Three modes, and the default mimics Claude Code itself:
//   auto          a stored key is used; no stored key means subscription
//   subscription  never the key, even when one is stored
//   key           always the stored key
//
// ONE STORE OF KEYS, ONE MODE PER PRODUCT. A key is a credential the person
// pastes once and expects to work everywhere on their machine, so the keys
// file is shared: paste it into Discuss's options page and the council bills
// it too. A MODE is a preference about one product ("the council runs on my
// subscription, Discuss burns credit"), so each frontend keeps its own —
// Discuss's alongside the keys (where it has always been), the council's in
// its own workspace state file. modeStore() is what makes that split cheap.
//
// ABSENT, NEVER EMPTY. Every path that means "do not use a key" DELETES the
// variable rather than setting it to ''. An empty ANTHROPIC_API_KEY is not the
// same thing as an unset one to every tool that reads it, and the difference
// between "subscription" and "an auth error" should never come down to that.
// This is also why `auto` with no stored key deletes an INHERITED key: the
// mode says what happens, and a variable left over in the environment of
// whatever started the server — a login shell, a LaunchAgent plist — is not an
// answer the user chose.
//
// Storage is a 0600 JSON file beside the other secrets. The keys go in one
// direction only: they can be written and removed over the API, never read
// back — GET answers "set" or "unset" and nothing else. Nothing here is ever
// logged, echoed into an error, or written to a page record.
import fs from 'node:fs';
import path from 'node:path';
import { secretsDir } from './secrets.mjs';

export const AGENTS = ['claude', 'codex'];
export const MODES = ['auto', 'subscription', 'key'];

// The variable each CLI reads a key from, and every OTHER variable that could
// answer the same question. "Subscription" has to clear the siblings too: an
// ANTHROPIC_AUTH_TOKEN or a Bedrock switch left in the environment is just as
// much "not your subscription" as a key is, and Claude Code says so out loud
// ("another auth source is set and takes precedence over your claude.ai login").
export const ENV_VAR = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY' };
const SIBLINGS = {
  claude: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
  codex: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
};
// every variable this module takes authority over, in one list — what a UI or
// a test can ask about without guessing
export const MANAGED_VARS = AGENTS.flatMap(a => [ENV_VAR[a], ...SIBLINGS[a]]);

// The two CLIs do NOT agree about what a key in the environment means, and
// pretending otherwise would be the kind of lie that produces a bug report a
// year later:
//
//   claude  the key WINS. Documented: "this key is used instead of your
//           subscription even if you are logged in", and in -p mode (which is
//           how the bridge runs it) there is not even a prompt.
//   codex   the stored ChatGPT login wins. A key in the environment is only
//           consulted when there is NO login — `codex doctor` calls the
//           combination "mixed auth signals" and still reports `auth mode
//           chatgpt`. Making the key win means logging in with it
//           (`codex login --with-api-key`), which is the user's decision to
//           make, not something a server should do behind their back.
//           (`forced_login_method = "api"` DOES force it — and silently
//            deletes ~/.codex/auth.json, logging you out. Never send it.)
//
// So for codex a stored key is a fallback for the logged-out case, and both
// UIs say as much rather than promising an override the CLI will not perform.
export const KEY_OVERRIDES_LOGIN = { claude: true, codex: false };

export const keysFile = () => path.join(secretsDir(), 'discuss-keys.json');

// --- a tiny 0600 JSON file, read through an mtime cache ---------------------
// mtime-watched like grants.json: edited by hand or by another process (the
// other frontend, most of all), and picked up without a restart.
function jsonFile(fileFn) {
  let cache = { mtime: -1, size: -1, data: {} };
  function read() {
    const file = fileFn();
    let st = null;
    try { st = fs.statSync(file); } catch { cache = { mtime: -1, size: -1, data: {} }; return cache.data; }
    if (st.mtimeMs !== cache.mtime || st.size !== cache.size) {
      let data = {};
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j && typeof j === 'object') data = j;
      } catch { /* unreadable or half-written: behave as if there were none */ }
      cache = { mtime: st.mtimeMs, size: st.size, data };
    }
    return cache.data;
  }
  function write(data) {
    const file = fileFn();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { }
    cache = { mtime: -1, size: -1, data: {} }; // re-read on the next call
  }
  return { read, write };
}

const store = jsonFile(keysFile);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};

const isAgent = a => AGENTS.includes(String(a));
const keyOf = (agent) => {
  const k = obj(store.read().keys)[agent];
  return (typeof k === 'string' && k.trim()) ? k.trim() : '';
};
export const keyIsSet = agent => !!keyOf(agent);

// --- modes: one store per product ------------------------------------------
// Called with no argument you get Discuss's: the `modes` object inside the
// keys file, exactly where the companion has always kept it (so nobody's
// setting moves the day this file did). Called with a path you get an
// independent one — the council's lives in its own workspace state, because a
// mode is a preference about a product, not a secret, and the council saying
// "subscription" must not silently retune the browser plugin.
export function modeStore(file = null) {
  const f = file ? jsonFile(() => file) : store;
  const modeOf = agent => {
    const m = obj(f.read().modes)[agent];
    return MODES.includes(m) ? m : 'auto';
  };
  return {
    file: () => file || keysFile(),
    modeOf,
    all() {
      const out = {};
      for (const a of AGENTS) out[a] = modeOf(a);
      return out;
    },
    setMode(agent, mode) {
      if (!isAgent(agent)) return { ok: false, error: 'unknown agent' };
      if (!MODES.includes(String(mode))) return { ok: false, error: `mode must be one of ${MODES.join(', ')}` };
      const data = f.read();
      // the whole document is rewritten, not just `modes` — for the shared
      // keys file that is what keeps the keys where they are
      f.write({ ...data, modes: { ...obj(data.modes), [agent]: String(mode) } });
      return { ok: true };
    },
  };
}

// Discuss's mode store, and the default for every function below, so the
// companion's call sites read the same as before this module was shared.
export const defaultModes = modeStore();
export const modeOf = agent => defaultModes.modeOf(agent);
export const setMode = (agent, mode) => defaultModes.setMode(agent, mode);

// Everything a UI is allowed to know: whether a key exists, not what it is.
export function status(modes = defaultModes) {
  const out = { modes: {} };
  for (const a of AGENTS) {
    out[a] = keyOf(a) ? 'set' : 'unset';
    out.modes[a] = modes.modeOf(a);
  }
  return out;
}

export function setKey(agent, key) {
  if (!isAgent(agent)) return { ok: false, error: 'unknown agent' };
  const v = String(key == null ? '' : key).trim();
  if (!v) return { ok: false, error: 'a key is required — use remove to clear one' };
  if (v.length > 500) return { ok: false, error: 'that does not look like an API key' };
  const data = store.read();
  store.write({ ...data, keys: { ...obj(data.keys), [agent]: v } });
  return { ok: true };
}

// Removal is a real operation, not an overwrite: the key leaves the file, and
// with mode 'auto' the very next bridge gets no variable at all. It removes
// the key for BOTH products — one store, one key, one removal.
export function removeKey(agent) {
  if (!isAgent(agent)) return { ok: false, error: 'unknown agent' };
  const data = store.read();
  const keys = { ...obj(data.keys) };
  const had = !!keys[agent];
  delete keys[agent];
  store.write({ ...data, keys });
  return { ok: true, removed: had };
}

// The one function the bridge cares about: given the environment we were going
// to spawn with, return the environment we should actually spawn with.
export function applyEnv(env, modes = defaultModes) {
  const out = { ...env };
  for (const agent of AGENTS) {
    const mode = modes.modeOf(agent);
    const key = keyOf(agent);
    // Every path out of here removes the sibling auth sources: they are only
    // ever noise, and one left behind is exactly the "why is it billing the
    // wrong thing" bug this feature exists to prevent.
    for (const sib of SIBLINGS[agent]) delete out[sib];
    if (mode === 'subscription' || !key) {
      delete out[ENV_VAR[agent]];   // absent, not empty — see the note at the top
      continue;
    }
    out[ENV_VAR[agent]] = key;      // 'auto' with a key, or 'key' with a key
  }
  return out;
}
