// page-chats.mjs — the web-page chats (the browser plugin's chats about a
// page), as far as the council's left panel needs them:
//
//   listPageChats   a read-only list: name, address and date. Nothing else.
//   copyPageChat    "Copy into the council": the same thing
//                   `botference discuss continue` does, run for the reader.
//
// The plugin keeps its records in ITS OWN workspace, which is usually not
// the council's. Its code (frontends/plugin/store.mjs) reads that workspace
// from the environment when it is loaded, so it cannot be loaded into the
// council server. The list is therefore read straight from the plugin's
// index file, which holds one small row per page and no chat text; the page
// records themselves (pages/*.json, where the chats are) are never opened
// here. The copy is done by the plugin's own command, as a child process
// started with the plugin's workspace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// the most rows one listing hands the page
export const PAGE_CHATS_MOST = 200;
const KEY = /^[0-9a-f]{40}$/;
const DISCUSS_DEFAULT = 'http://127.0.0.1:4189';

// Where the plugin keeps its records, found the way `botference discuss`
// finds it: named outright (COUNCIL_PLUGIN_WORKSPACE), else the one the
// plugin's launcher remembered, else *fallback*.
export function pluginWorkspace({ env = process.env, home = os.homedir(), fallback = '' } = {}) {
  const named = String(env.COUNCIL_PLUGIN_WORKSPACE || '').trim();
  if (named) return named;
  try {
    const saved = fs.readFileSync(path.join(home, '.botference', 'plugin-workspace'), 'utf8')
      .split('\n')[0].trim();
    if (saved && fs.existsSync(saved)) return saved;
  } catch { /* the plugin was never started on this machine */ }
  return fallback;
}

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const pluginDir = workspace => path.join(workspace, '.botference', 'plugin');

// every page the bots have a chat about, newest first: {id, title, url, updated_at}
function rowsOf(workspace) {
  const idx = workspace ? readJson(path.join(pluginDir(workspace), 'index.json')) : null;
  if (!idx || typeof idx !== 'object' || Array.isArray(idx)) return [];
  const rows = [];
  for (const [id, r] of Object.entries(idx)) {
    if (!KEY.test(id) || !r || typeof r !== 'object' || !r.has_session) continue;
    if (typeof r.url !== 'string' || !r.url) continue;
    rows.push({
      id,
      title: String(r.title || '').trim() || r.url,
      url: r.url,
      updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
    });
  }
  return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

// The address of the plugin's own web pages (one per chat, at /p/<id>): the
// plugin's `discuss_web` setting, else this machine.
export function discussBase(dirs) {
  for (const dir of dirs) {
    const cfg = dir ? readJson(path.join(pluginDir(dir), 'config.json')) : null;
    const v = String((cfg && cfg.discuss_web) || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\/[^\s"'<>]+$/.test(v)) return v;
  }
  return DISCUSS_DEFAULT;
}

// What the page is sent. Long names and addresses are cut: they are for
// reading in a list.
export function listPageChats(workspace) {
  const rows = rowsOf(workspace);
  return {
    total: rows.length,
    pages: rows.slice(0, PAGE_CHATS_MOST).map(r => ({
      id: r.id, title: r.title.slice(0, 300), url: r.url.slice(0, 500), updated_at: r.updated_at.slice(0, 40),
    })),
  };
}

// The copy command's words, turned into something to show a person. The
// details (folder names and the like) go to the server's log, not the page.
function plainError(text) {
  if (/already lives in your council/.test(text)) return 'That page’s chat is already in the council.';
  if (/nothing to carry over/.test(text)) return 'That page has no chat to copy yet.';
  if (/is not a council/.test(text)) return 'This council’s folder is not set up to take copies.';
  return 'Could not copy that chat. Try again.';
}

// "Copy into the council". The page is named by its id only; its address is
// looked up in the plugin's list here, never taken from the request. Resolves
// with { ok: true, sid, project, reused } or { ok: false, error: <plain words> }.
export function copyPageChat({
  workspace, id, councilRoot, home, env = process.env, waitMs = 60000,
  command = [process.execPath, path.join(home, 'frontends', 'plugin', 'continue-cli.mjs')],
} = {}) {
  return new Promise(resolve => {
    const row = KEY.test(String(id || '')) ? rowsOf(workspace).find(r => r.id === id) : null;
    // (an address that starts with a dash would be read as an option)
    if (!row || row.url.startsWith('-')) {
      resolve({ ok: false, error: 'That page chat is not in the list any more.' });
      return;
    }
    // The council's own BOTFERENCE_* settings describe the council's
    // workspace; the command must see the plugin's.
    const base = Object.fromEntries(Object.entries(env).filter(([k]) =>
      !k.startsWith('BOTFERENCE_') || k === 'BOTFERENCE_PYTHON_BIN'));
    let out = '', err = '', settled = false, timer = null;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const fail = why => {
      console.error('[council] copy a page chat:', String(why).split('\n')[0].slice(0, 300));
      done({ ok: false, error: plainError(String(why)) });
    };
    let proc;
    try {
      proc = spawn(command[0], [...command.slice(1), row.url, '--council', councilRoot], {
        env: { ...base, BOTFERENCE_HOME: home, BOTFERENCE_PROJECT_ROOT: workspace },
        cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { fail(e.message); return; }
    timer = setTimeout(() => { proc.kill(); fail('the copy took too long'); }, waitMs);
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', e => fail(e.message));
    proc.on('close', code => {
      const m = /^\s*chat:\s+(\S+)(?:\s+\(project ([^)]+)\))?/m.exec(out);
      if (code !== 0 || !m) { fail(err.trim() || out.trim() || `the copy stopped (${code})`); return; }
      done({ ok: true, sid: m[1], project: m[2] || '', reused: /^Already in the council/m.test(out) });
    });
  });
}
