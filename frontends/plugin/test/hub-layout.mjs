// hub-layout.mjs — for tests whose subject is what the Hub keeps on disk (following-store.mjs fileStore): read the per-blyg
// documents back as one picture (the main document with every post in `items`, keyed as the engine keys them), and write one
// back the same way. No engine code: plain files.
import fs from 'node:fs';
import path from 'node:path';
import { ledgerName } from '../following-store.mjs';

const ARCHIVE = ['archived', 'archived_changed'];
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/** → { layout, blygs, kept, last_run, items: { "<origin>\n<id>": record } } */
export function readLayout(file) {
  const dir = path.dirname(file);
  const main = readJson(file) || {};
  const items = {};
  for (const o of Object.keys(main.blygs || {})) {
    for (const kind of ['feed', 'archive']) {
      const d = readJson(path.join(dir, `following-${kind}`, `${ledgerName(o)}.json`));
      if (!d || d.epoch !== main.blygs[o].epoch) continue;
      for (const [id, rec] of Object.entries(d.items || {})) items[`${o}\n${id}`] = rec;
    }
  }
  const { ops, ...rest } = main;
  void ops;
  return { ...rest, items };
}
/** Write `j` (the shape readLayout gives) back: the main document and each followed blyg's feed and archive. */
export function writeLayout(file, j) {
  const dir = path.dirname(file);
  const { items = {}, ...main } = j;
  fs.writeFileSync(file, JSON.stringify(main));
  for (const o of Object.keys(main.blygs || {})) {
    const epoch = main.blygs[o].epoch;
    const mine = Object.entries(items).filter(([k]) => k.startsWith(`${o}\n`)).map(([, r]) => r);
    for (const kind of ['feed', 'archive']) {
      const f = path.join(dir, `following-${kind}`, `${ledgerName(o)}.json`);
      const old = readJson(f) || {};
      const list = mine.filter(r => (kind === 'archive') === ARCHIVE.includes(r.read));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ ...old, origin: o, epoch, items: Object.fromEntries(list.map(r => [r.id, r])) }));
    }
  }
}
/** The size of everything kept about the follow list and its posts (not bodies), in bytes. */
export function layoutBytes(file) {
  const dir = path.dirname(file);
  let n = fs.existsSync(file) ? fs.statSync(file).size : 0;
  for (const d of ['following-feed', 'following-archive', 'following-ledgers']) {
    try { for (const x of fs.readdirSync(path.join(dir, d))) n += fs.statSync(path.join(dir, d, x)).size; } catch { /* none */ }
  }
  return n;
}
