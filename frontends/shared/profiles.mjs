// Profiles: whose accounts and whose history the bots run under.
//
// A profile is a name plus the places one person's bot work lives: a Claude
// config dir (CLAUDE_CONFIG_DIR), a Codex home (CODEX_HOME), an API-key file,
// and the history the Discuss companion and the council keep (pages, threads,
// page chats, sessions). The machine has ONE active profile. Both servers
// read it once, at start-up, before anything else loads (profile-env.mjs in
// each frontend), and a switch restarts them — so nothing ever runs half under
// one profile and half under another.
//
// The registry is one 0600 file, <secrets>/profiles.json:
//   { format: 1, active: "<name>", profiles: { "<name>": { …dirs… } } }
// A dir that is null means "whatever this machine did before profiles
// existed": the CLI's own default, or the companion's own folder. That is how
// the first profile adopts today's state in place, without moving a file.
//
// No registry at all means no profiles: every function here then leaves the
// environment exactly as it was. `active` is the one field that says which
// profile is in force, and setActive() is the one way to change it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { secretsDir } from './secrets.mjs';

export const FORMAT = 1;
export const SURFACES = ['discuss', 'council'];
// The record's fields, all optional paths; null = the pre-profiles default.
export const FIELDS = ['claude_config_dir', 'codex_home', 'keys_file',
  'discuss_data_dir', 'discuss_work_dir', 'council_work_dir'];
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
// The launch agents a switch restarts, when they are loaded (macOS only).
export const SERVICE_LABELS = ['com.botference.plugin-web', 'com.botference.council'];

export const registryFile = () => path.join(secretsDir(), 'profiles.json');
export const profilesRoot = () => path.join(secretsDir(), 'profiles');
export const validName = n => typeof n === 'string' && NAME_RE.test(n);

/** The registry, or null when profiles have never been set up. Throws on a
 *  file that exists but cannot be read: guessing would run bots under the
 *  wrong accounts. */
export function readRegistry() {
  let raw;
  try { raw = fs.readFileSync(registryFile(), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const r = JSON.parse(raw);
  if (!r || typeof r !== 'object' || typeof r.profiles !== 'object' || !r.profiles) {
    throw new Error(`${registryFile()} is not a profiles registry`);
  }
  if (r.format > FORMAT) throw new Error(`${registryFile()} is format ${r.format}; this botference reads up to ${FORMAT}`);
  return r;
}

function writeRegistry(r) {
  fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
  const tmp = `${registryFile()}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...r, format: FORMAT }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, registryFile());
  fs.chmodSync(registryFile(), 0o600);
}

const blankRecord = () => Object.fromEntries(FIELDS.map(f => [f, null]));

/** First run: today's state becomes profile <name>, every dir null. */
export function initRegistry(name) {
  if (!validName(name)) return { ok: false, error: `not a valid profile name: ${JSON.stringify(name)}` };
  if (readRegistry()) return { ok: false, error: 'profiles are already set up' };
  writeRegistry({ format: FORMAT, active: name, profiles: { [name]: blankRecord() } });
  return { ok: true, name };
}

export function listProfiles() {
  const r = readRegistry();
  if (!r) return [];
  return Object.keys(r.profiles).sort().map(name => ({ name, active: name === r.active, ...r.profiles[name] }));
}

/** The profile in force, with its name, or null when there are no profiles. */
export function activeProfile() {
  const r = readRegistry();
  if (!r) return null;
  const rec = r.profiles[r.active];
  if (!rec) throw new Error(`${registryFile()}: active profile "${r.active}" is not defined`);
  return { name: r.active, ...blankRecord(), ...rec };
}

/** A new profile with its own dirs under <secrets>/profiles/<name>/. */
export function addProfile(name) {
  if (!validName(name)) return { ok: false, error: `not a valid profile name: ${JSON.stringify(name)}` };
  const r = readRegistry();
  if (!r) return { ok: false, error: 'profiles are not set up yet: run `botference profile init <your name>` first' };
  if (r.profiles[name]) return { ok: false, error: `profile "${name}" already exists` };
  const base = path.join(profilesRoot(), name);
  const rec = {
    claude_config_dir: path.join(base, 'claude'),
    codex_home: path.join(base, 'codex'),
    keys_file: path.join(base, 'discuss-keys.json'),
    discuss_data_dir: path.join(base, 'discuss', 'plugin'),
    discuss_work_dir: path.join(base, 'discuss', 'work'),
    council_work_dir: path.join(base, 'council', 'work'),
  };
  for (const k of ['claude_config_dir', 'codex_home', 'discuss_data_dir', 'discuss_work_dir', 'council_work_dir']) {
    fs.mkdirSync(rec[k], { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.join(rec.discuss_work_dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(rec.council_work_dir, 'sessions'), { recursive: true });
  writeRegistry({ ...r, profiles: { ...r.profiles, [name]: rec } });
  return { ok: true, name, record: rec };
}

/** The ONE way the active profile changes. Refuses what it cannot honour. */
export function setActive(name) {
  const r = readRegistry();
  if (!r) return { ok: false, error: 'profiles are not set up yet' };
  if (!r.profiles[name]) return { ok: false, error: `no profile named "${name}"` };
  if (r.active === name) return { ok: true, name, changed: false };
  writeRegistry({ ...r, active: name });
  return { ok: true, name, changed: true, from: r.active };
}

/** Forget a profile. Never the active one; its files stay unless asked. */
export function removeProfile(name, { deleteData = false } = {}) {
  const r = readRegistry();
  if (!r || !r.profiles[name]) return { ok: false, error: `no profile named "${name}"` };
  if (r.active === name) return { ok: false, error: `"${name}" is the active profile; switch to another first` };
  const rec = r.profiles[name];
  const { [name]: _gone, ...rest } = r.profiles;
  writeRegistry({ ...r, profiles: rest });
  let deleted = null;
  const own = path.join(profilesRoot(), name);
  if (deleteData && fs.existsSync(own)) { fs.rmSync(own, { recursive: true, force: true }); deleted = own; }
  return { ok: true, name, deleted, kept: deleteData ? null : own, record: rec };
}

/** The environment a surface runs under for a profile: { set, unset }.
 *  A null dir unsets its variable, so the CLI default applies and nothing
 *  inherited from a shell can point the bots somewhere else. */
export function profileEnv(profile, surface) {
  if (!SURFACES.includes(surface)) throw new Error(`unknown surface ${surface}`);
  const set = {}; const unset = [];
  const put = (name, value) => { if (value) set[name] = value; else unset.push(name); };
  set.BOTFERENCE_PROFILE = profile.name;
  put('CLAUDE_CONFIG_DIR', profile.claude_config_dir);
  put('CODEX_HOME', profile.codex_home);
  put('BOTFERENCE_KEYS_FILE', profile.keys_file);
  if (surface === 'discuss') {
    put('BOTFERENCE_PLUGIN_DIR', profile.discuss_data_dir);
    // A null work dir leaves BOTFERENCE_WORK_DIR alone: the companion resolves
    // it from its workspace exactly as before.
    if (profile.discuss_work_dir) set.BOTFERENCE_WORK_DIR = profile.discuss_work_dir;
  } else if (profile.council_work_dir) {
    // the council's default comes from council.env; only a profile's own
    // dir overrides it
    set.BOTFERENCE_WORK_DIR = profile.council_work_dir;
  }
  return { set, unset };
}

/** Put the active profile into process.env for a surface. Returns the
 *  profile, or null when there are no profiles (env left untouched). */
export function applyActiveProfile(surface, env = process.env) {
  const p = activeProfile();
  if (!p) return null;
  const { set, unset } = profileEnv(p, surface);
  for (const k of unset) delete env[k];
  Object.assign(env, set);
  return p;
}

// --- who each bot is signed in as, read from files on this machine ----------

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The email claim of a JWT, decoded locally. The token itself never leaves. */
export function jwtEmail(token) {
  try {
    const part = String(token).split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return typeof claims.email === 'string' ? claims.email : null;
  } catch { return null; }
}

export function claudeAccount(configDir) {
  const file = configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  const j = readJsonSafe(file);
  const email = j && j.oauthAccount && typeof j.oauthAccount.emailAddress === 'string' ? j.oauthAccount.emailAddress : null;
  return { signed_in: !!email, email };
}

export function codexAccount(codexHome) {
  const file = path.join(codexHome || path.join(os.homedir(), '.codex'), 'auth.json');
  const j = readJsonSafe(file);
  if (!j) return { signed_in: false, email: null, method: null };
  const email = j.tokens && j.tokens.id_token ? jwtEmail(j.tokens.id_token) : null;
  if (email || (j.tokens && j.tokens.access_token)) return { signed_in: true, email, method: 'chatgpt' };
  if (j.OPENAI_API_KEY) return { signed_in: true, email: null, method: 'api-key' };
  return { signed_in: false, email: null, method: null };
}

/** Every profile with each bot's account, for the extension's options page.
 *  Emails and states only; no token, key or path is in the answer. */
export function profilesWithAccounts() {
  return listProfiles().map(p => ({
    name: p.name,
    active: p.active,
    claude: claudeAccount(p.claude_config_dir),
    codex: codexAccount(p.codex_home),
  }));
}

// --- accounts: which sign-in each bot uses, chosen per bot ------------------
//
// An account is one sign-in folder for one bot: a Claude config dir or a Codex
// home. The active profile names one for each bot (claude_config_dir,
// codex_home); setAccount() is the one way to change that choice, and it only
// accepts an account this machine already knows. Known accounts are the CLI
// default, every profile's own folder, and any added with addAccount(). The
// drawer sees them by email and an opaque id, never by path.
export const AGENTS = ['claude', 'codex'];
const AGENT_FIELD = { claude: 'claude_config_dir', codex: 'codex_home' };
const accountOf = { claude: d => claudeAccount(d), codex: d => codexAccount(d) };
export const accountId = dir => (dir ? 'a-' + createHash('sha1').update(dir).digest('hex').slice(0, 12) : 'default');

function knownDirs(agent, r) {
  const dirs = [null];
  for (const rec of Object.values((r && r.profiles) || {})) {
    if (rec && rec[AGENT_FIELD[agent]]) dirs.push(rec[AGENT_FIELD[agent]]);
  }
  for (const d of Object.values(((r && r.accounts) || {})[agent] || {})) dirs.push(d);
  return [...new Set(dirs)];
}

/** Every account this machine knows for one bot: [{id, label, email,
 *  signed_in, current}]. Without profiles, just the default, current. */
export function accountsFor(agent) {
  if (!AGENTS.includes(agent)) throw new Error(`unknown bot ${agent}`);
  const r = readRegistry();
  const cur = r ? (r.profiles[r.active] || {})[AGENT_FIELD[agent]] || null : null;
  const labels = Object.fromEntries(Object.entries(((r && r.accounts) || {})[agent] || {}).map(([k, d]) => [d, k]));
  return knownDirs(agent, r).map(dir => {
    const a = accountOf[agent](dir);
    return { id: accountId(dir), label: dir ? (labels[dir] || path.basename(path.dirname(dir))) : 'default',
      email: a.email, signed_in: a.signed_in, current: dir === cur };
  });
}

/** The one way a bot's account changes, for the active profile. */
export function setAccount(agent, id) {
  if (!AGENTS.includes(agent)) return { ok: false, error: `unknown bot ${agent}` };
  const r = readRegistry();
  if (!r) return { ok: false, error: 'profiles are not set up yet: run `botference profile init <your name>` first' };
  const dir = knownDirs(agent, r).find(d => accountId(d) === id);
  if (dir === undefined) return { ok: false, error: `no ${agent} account ${id} on this machine` };
  const rec = { ...r.profiles[r.active] };
  if ((rec[AGENT_FIELD[agent]] || null) === dir) return { ok: true, changed: false };
  rec[AGENT_FIELD[agent]] = dir;
  writeRegistry({ ...r, profiles: { ...r.profiles, [r.active]: rec } });
  return { ok: true, changed: true, account: accountOf[agent](dir) };
}

/** A new sign-in folder for one bot, under <secrets>/accounts/<bot>/<label>. */
export function addAccount(agent, label) {
  if (!AGENTS.includes(agent)) return { ok: false, error: `unknown bot ${agent}` };
  if (!validName(label)) return { ok: false, error: `not a valid account label: ${JSON.stringify(label)}` };
  const r = readRegistry();
  if (!r) return { ok: false, error: 'profiles are not set up yet: run `botference profile init <your name>` first' };
  const accounts = { ...(r.accounts || {}) };
  const mine = { ...(accounts[agent] || {}) };
  if (mine[label]) return { ok: false, error: `${agent} account "${label}" already exists` };
  const dir = path.join(secretsDir(), 'accounts', agent, label);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  mine[label] = dir; accounts[agent] = mine;
  writeRegistry({ ...r, accounts });
  return { ok: true, id: accountId(dir), dir };
}

/** The bots' sign-in folders as the registry says NOW, for a bridge about to
 *  start: a change made in the drawer reaches the next bot that starts, in
 *  either server, without restarting it. Returns env, changed in place. */
export function withBotDirs(env) {
  let p = null;
  try { p = activeProfile(); } catch { return env; } // unreadable: keep what start-up set
  if (!p) return env;
  for (const [agent, field] of Object.entries(AGENT_FIELD)) {
    const name = agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    if (p[field]) env[name] = p[field]; else delete env[name];
  }
  return env;
}

// --- restarting the services after a switch ---------------------------------

/** Restart the loaded botference launch agents so they start under the new
 *  profile. `except` is a label to leave to the caller (a server restarting
 *  itself must answer its request first). Returns the labels restarted. */
export function restartServices({ except = null, labels = SERVICE_LABELS } = {}) {
  if (process.platform !== 'darwin') return [];
  // A registry somewhere else (BOTFERENCE_SECRETS_DIR: a test, a sandbox) is
  // not the one the machine's services read; restarting them would only
  // interrupt them.
  if (process.env.BOTFERENCE_SECRETS_DIR) return [];
  const uid = process.getuid();
  const done = [];
  for (const label of labels) {
    if (label === except) continue;
    try {
      execFileSync('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'ignore' });
    } catch { continue; } // not loaded here
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'ignore' });
      done.push(label);
    } catch { /* reported by its absence */ }
  }
  return done;
}

/** The launch agent this process runs as, if any (launchd sets the label). */
export const ownLabel = () => process.env.XPC_SERVICE_NAME || null;
