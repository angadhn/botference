// following-store.mjs — where the Hub's engine (following.mjs) keeps what it keeps, and the one way it writes it.
//
// THE STORE IS ASYNCHRONOUS AND GIVES A REAL COMPARE-AND-SWAP. A host backs it with whatever it has (files for the companion; a
// blob store with conditional writes for a serverless host); the engine never reads a file or a blob itself.
//   get(kind, name)                       → null (nothing stored) | { value, version, at } | { unreadable: Error, version }
//                                           value: parsed JSON, except 'body' (a string); at: when it was written (ms), or 0
//   put(kind, name, value, { ifVersion }) → { version }. ifVersion undefined: write whatever is stored; null: only if nothing
//                                           is stored; a string: only if the stored version is still that one. Otherwise it
//                                           throws StoreConflict and writes nothing.
//   delete(kind, name, { ifVersion })     → true if something was deleted (ifVersion as for put)
//   list(kind)                            → the names stored of that kind
// A version is opaque. Every method returns a promise.
//
// WHAT IS KEPT, by kind (STORE_KINDS):
//   state    'following' — the follow list (blygs, kept), the last run's tally. Small: no posts.
//            'run'       — the run lease (RUN_STATES), the top-up gap, the hosts' circuit breakers.
//            'inbox'     — the mentions inbox.
//            'stars'     — the owner's starred posts (STAR_STATES), each a small record of its own.
//            'pre-shard' — a copy of the document a conversion read (the older layout's), kept through the conversion's quiet
//                          period (following.mjs MIGRATION_STATES), then deleted.
//            'legacy'    — where a host keeps the older layout's document when this layout's main document is kept elsewhere
//                          (the hosted Hub: the old blob, which an old invocation may still read during a deploy). The
//                          conversion replaces it, conditionally, with a MARKER that an old engine cannot load (so it writes
//                          nothing more) and that still names every post the old document held. The companion has none
//                          (following-legacy.json is never written: its older document IS following.json, converted in place).
//   feed     one per followed blyg: its held posts that are not in the Archive (unread, and withdrawn markers), and its
//            summary (archived count, backfill mode, unusable documents, queue length, recent changes) for a page to read
//            without the ledger.
//   archive  one per followed blyg: its archive records (what the owner ticked: no text).
//   ledger   one per followed or kept blyg: its read ids and gone filter, unusable and later-again ids, backfill mode,
//            queue, the edit-return and change counters.
//   body     one per held post: its sanitised text.
//   oldbody  a post's text where the older layout kept it, when a host keeps this layout's bodies elsewhere (the hosted Hub:
//            the old prefix, which an old invocation's sweep may still delete from during a deploy). The conversion COPIES
//            each unread post's text from here to 'body' and deletes these only when its quiet period is over. The companion
//            keeps its bodies where the older layout did (following-bodies/), so for it this kind is always empty.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonState, refuseIfUnreadable } from './fsjson.mjs';

export const STORE_KINDS = Object.freeze(['state', 'feed', 'archive', 'ledger', 'body', 'oldbody']);
export const STATE_NAMES = Object.freeze(['following', 'run', 'inbox', 'stars', 'pre-shard', 'legacy']);
export class StoreConflict extends Error {
  constructor(kind, name) { super(`${kind} ${name} was changed by someone else meanwhile`); this.name = 'StoreConflict'; this.code = 'ESTORECONFLICT'; }
}
/** The name a blyg's documents are kept under: a digest of its origin (an origin is not a safe file name). */
export const ledgerName = origin => crypto.createHash('sha256').update(String(origin)).digest('hex').slice(0, 32);
const isText = kind => kind === 'body' || kind === 'oldbody';
const checkKind = kind => { if (!STORE_KINDS.includes(kind)) throw new Error(`store: no such kind ${kind}`); };

/**
 * The companion's store: files. `file` is following.json (the main document); beside it following-run.json,
 * following-inbox.json, following-stars.json, following-pre-shard.json; and the folders following-feed/, following-archive/,
 * following-ledgers/ (<name>.json) and following-bodies/ (<name>.html). The ledgers and bodies folders are where the layout
 * before this one kept them, so they carry over as they are: 'oldbody' is empty here (nothing to copy), and 'legacy' is a
 * file nobody writes (the older main document is following.json itself). A version is the file's inode, size and modification time in
 * nanoseconds; a conditional put compares it just before its atomic rename (one process: the engine's own lock serialises
 * its operations, so two writers can only meet if two companions share a folder, which they never do).
 */
export function fileStore(file) {
  const dir = path.dirname(file);
  const dirs = { body: path.join(dir, 'following-bodies'), ledger: path.join(dir, 'following-ledgers'),
    feed: path.join(dir, 'following-feed'), archive: path.join(dir, 'following-archive') };
  const safe = name => String(name).replace(/[^0-9a-f]/g, '');
  const where = (kind, name) => {
    checkKind(kind);
    if (kind === 'oldbody') return null; // (see above: this store keeps bodies where the older layout did)
    if (kind === 'state') {
      if (!STATE_NAMES.includes(name)) throw new Error(`store: no such state document ${name}`);
      return name === 'following' ? file : path.join(dir, `following-${name}.json`);
    }
    return path.join(dirs[kind], `${safe(name)}.${kind === 'body' ? 'html' : 'json'}`);
  };
  const statOf = f => {
    try { const s = fs.statSync(f, { bigint: true }); return { version: `${s.ino}-${s.size}-${s.mtimeNs}`, at: Number(s.mtimeMs) }; }
    catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  };
  return {
    kind: 'files',
    async get(kind, name) {
      const f = where(kind, name);
      if (f === null) return null;
      const st = statOf(f);
      if (st === null) return null;
      if (kind === 'body') { try { return { value: fs.readFileSync(f, 'utf8'), ...st }; } catch { return null; } }
      const got = readJsonState(f);
      if (got.state === 'missing') return null;
      if (got.state === 'unreadable') return { unreadable: got.error, ...st };
      return { value: got.value, ...st };
    },
    async put(kind, name, value, { ifVersion } = {}) {
      const f = where(kind, name);
      if (f === null) throw new Error(`store: this store keeps no ${kind}`);
      if (kind !== 'body') refuseIfUnreadable(f);
      if (ifVersion !== undefined && (statOf(f)?.version ?? null) !== ifVersion) throw new StoreConflict(kind, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, kind === 'body' ? String(value) : (typeof value === 'string' ? value : JSON.stringify(value)));
      fs.renameSync(tmp, f);
      return { version: statOf(f).version };
    },
    async delete(kind, name, { ifVersion } = {}) {
      const f = where(kind, name);
      if (f === null) return false;
      if (ifVersion !== undefined && (statOf(f)?.version ?? null) !== ifVersion) throw new StoreConflict(kind, name);
      try { fs.unlinkSync(f); return true; } catch { return false; }
    },
    async list(kind) {
      checkKind(kind);
      if (kind === 'oldbody') return [];
      if (kind === 'state') return STATE_NAMES.filter(n => fs.existsSync(where('state', n)));
      let names = [];
      try { names = fs.readdirSync(dirs[kind]); } catch { return []; }
      const ext = kind === 'body' ? '.html' : '.json';
      // a temp file a crash left behind (older than an hour, so never one being written now) goes
      for (const n of names) {
        if (!/\.tmp\.\d+$/.test(n)) continue;
        try { const p = path.join(dirs[kind], n); if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.unlinkSync(p); } catch { /* gone */ }
      }
      return names.filter(n => n.endsWith(ext)).map(n => n.slice(0, -ext.length));
    },
  };
}

/**
 * A store held in memory, with the same contract and a real compare-and-swap: for tests, and the shape a serverless host's
 * blob store takes. `writes` counts puts per kind; `log` lists every put and delete in order ("put feed:<name>").
 * `gate(op, kind, name)` (settable) is awaited before every operation: a test holds one engine there while another runs,
 * so two engines can be interleaved step by step. `crashAfter(n)` makes the n-th next write throw (a process that died).
 * `now` is the clock that stamps `at`.
 */
export function memoryStore({ now = Date.now } = {}) {
  const m = new Map();
  let n = 0;
  const writes = { state: 0, feed: 0, archive: 0, ledger: 0, body: 0, oldbody: 0 };
  const log = [];
  const k = (kind, name) => { checkKind(kind); return `${kind}/${name}`; };
  let crashIn = 0;
  const s = {
    kind: 'memory', writes, entries: m, log, gate: null,
    crashAfter(count) { crashIn = count; },
    async get(kind, name) {
      if (s.gate) await s.gate('get', kind, name);
      const e = m.get(k(kind, name));
      return e ? { value: isText(kind) ? e.text : JSON.parse(e.text), version: e.version, at: e.at } : null;
    },
    async put(kind, name, value, { ifVersion } = {}) {
      if (s.gate) await s.gate('put', kind, name);
      const e = m.get(k(kind, name));
      if (ifVersion !== undefined && (e ? e.version : null) !== ifVersion) throw new StoreConflict(kind, name);
      if (crashIn > 0 && --crashIn === 0) throw Object.assign(new Error('the process died here'), { code: 'ECRASH' });
      const version = `v${++n}`;
      m.set(k(kind, name), { text: isText(kind) ? String(value) : (typeof value === 'string' ? value : JSON.stringify(value)), version, at: now() });
      writes[kind]++;
      log.push(`put ${kind}:${name}`);
      return { version };
    },
    async delete(kind, name, { ifVersion } = {}) {
      if (s.gate) await s.gate('delete', kind, name);
      const e = m.get(k(kind, name));
      if (ifVersion !== undefined && (e ? e.version : null) !== ifVersion) throw new StoreConflict(kind, name);
      if (crashIn > 0 && --crashIn === 0) throw Object.assign(new Error('the process died here'), { code: 'ECRASH' });
      log.push(`delete ${kind}:${name}`);
      return m.delete(k(kind, name));
    },
    async list(kind) { checkKind(kind); return [...m.keys()].filter(x => x.startsWith(`${kind}/`)).map(x => x.slice(kind.length + 1)); },
    /** Synchronous peeks for tests: the parsed value stored, or null. */
    peek(kind, name) { const e = m.get(k(kind, name)); return e ? (isText(kind) ? e.text : JSON.parse(e.text)) : null; },
    names(kind) { return [...m.keys()].filter(x => x.startsWith(`${kind}/`)).map(x => x.slice(kind.length + 1)); },
  };
  return s;
}
