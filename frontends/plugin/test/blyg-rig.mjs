// blyg-rig.mjs — what the Publish-as-blyg tests share: a throwaway git work tree with a notes folder, a command set that
// is the fake command (test/fixtures/blyg-fake-cmd.mjs), and a way to tell it to fail at a step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE = path.join(HERE, 'fixtures', 'blyg-fake-cmd.mjs');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(pred, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = await pred(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

/** → { top, folder, log, ctl, home, calls(), control(obj), done() }. `folder` is `<top>/_notes` unless `sub` says otherwise. */
export function makeRig({ sub = '_notes', discard = false, prepare = false, confirm = 'always', extra = {} } = {}) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blygrig-')));
  git(top, 'init', '-q'); git(top, 'config', 'user.email', 'o@example.test'); git(top, 'config', 'user.name', 'Owner');
  const folder = path.join(top, sub);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(top, 'README.md'), 'site\n');
  git(top, 'add', '.'); git(top, 'commit', '-qm', 'init');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blygrig-out-'));
  const log = path.join(out, 'calls.jsonl');
  const ctl = path.join(out, 'control.json');
  fs.writeFileSync(ctl, '{}');
  const cmd = step => [process.execPath, FAKE, log, ctl, step, '{note}'];
  const home = { folder, filename: '${slug}.md', timezone: 'Europe/London', escape: 'liquid', confirm,
    commands: { ...(prepare ? { prepare: cmd('prepare') } : {}), plan: cmd('plan'), apply: cmd('apply'), publish: cmd('publish'), ...(discard || prepare ? { discard: cmd('discard') } : {}) }, ...extra };
  return {
    top, folder, log, ctl, home, out,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    control: obj => fs.writeFileSync(ctl, JSON.stringify(obj)),
    done: () => { fs.rmSync(top, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); },
  };
}

// pages and messages the owner could have
export const ID = '0123456789abcdefghjkmnpqrs';
export const ORIGIN = 'https://blyg.example.test/notes/';
export const POST = `${ORIGIN}t/${ID}/`;
export const mine = (text, extra = {}) => ({ author: 'owner', ts: '2026-11-22T10:00:00Z', text, provenance: 'owner-typed', ...extra });
export const thread = (id, quote, text, extra = {}) => ({ id, quote, msgs: [mine(text)], ...extra });
export const blygPage = threads => ({ url: POST, title: 'A made-up post', threads,
  blyg: { status: 'blyg', item: { origin: ORIGIN, id: ID, version: 2, page: POST } } });
export const stamp = () => ({ status: 'blyg', id: ID, version: 2, origin: ORIGIN, page: POST, passage: { match: true } });
