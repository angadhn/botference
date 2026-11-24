// hub-world.mjs — for tests of the Hub engine under overlapping invocations: ONE versioned memory store seen by several engines,
// each through a view that can stop it before its i-th store call (`arm(tag, { holdAt })`), or make that call throw as if the
// process died there (`crashAt`). And the properties checked after every interleaving (P1..P5 of hubtx.test.mjs, and P6):
//   P2 no read post is unread without a real edit (a post in the Feed never has its id in the ledger, unless `edited`)
//   P3 no archive record or ledger id lost or duplicated (at rest: a post in its feed or its archive, never both; every archive
//      record's id in its ledger)
//   P4 no body deleted while its record is unread
//   P5 the day's edit-return count is not undercounted (P1, every owner's move told done stands, is the tests' own)
// No network: invented blygs held in memory (following-fake.mjs).
import { createRequire } from 'node:module';
import * as F from '../following.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';

export { F, makeWeb, makeDoc, idOf };
export const CFG = createRequire(import.meta.url)('../extension/config.js');
export const A = 'https://alpha.web.test/notes/';
export const B = 'https://beta.web.test/';
export const C = 'https://gamma.web.test/';
export const day = n => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3600e3).toISOString();
export const N = o => F.ledgerName(o);

export function world({ settings = {}, store = null } = {}) {
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const s = store || F.memoryStore({ now: () => clock.t });
  const web = makeWeb();
  const ctl = new Map();
  const view = tag => {
    const step = async (op, kind, name) => {
      const c = ctl.get(tag);
      if (!c) return;
      c.count++; c.ops.push(`${op} ${kind}:${name}`);
      if (c.crashAt && c.count >= c.crashAt) throw Object.assign(new Error('died'), { code: 'ECRASH' });
      if (c.holdAt && c.count === c.holdAt) await new Promise(res => { c.go = res; c.arrived(); });
    };
    return {
      kind: 'memory',
      get: async (k, n) => { await step('get', k, n); return s.get(k, n); },
      put: async (k, n, v, o) => { await step('put', k, n); return s.put(k, n, v, o); },
      delete: async (k, n, o) => { await step('delete', k, n); return s.delete(k, n, o); },
      list: async k => { await step('list', k, ''); return s.list(k); },
    };
  };
  return {
    clock, store: s, web, ctl,
    engine(tag, { skew = 0, extra = {} } = {}) {
      ctl.set(tag, { count: 0, ops: [] });
      return F.createFollowing({ store: view(tag), get: async (u, o) => { clock.t += 10; return web.get(u, o); }, now: () => clock.t + skew,
        getSettings: () => CFG.followingSettingsOf({ following_unread_target: 500, ...settings, ...extra }).settings, timers: { set: () => ({}), clear: () => {} } });
    },
    /** Count `tag`'s store calls from now; stop it before call `holdAt` (until release), or make call `crashAt` throw. */
    arm(tag, { holdAt = 0, crashAt = 0 } = {}) {
      const c = ctl.get(tag);
      Object.assign(c, { count: 0, ops: [], holdAt, crashAt, go: null });
      c.reached = new Promise(res => { c.arrived = res; });
      return c;
    },
    release(tag) { const c = ctl.get(tag); c.holdAt = 0; if (c.go) c.go(); },
  };
}
export const publish = (site, n, from = 1) => { for (let k = from; k <= n; k++) site.put(makeDoc({ id: idOf(k), origin: site.origin, title: `Post ${k}`, body: `Words of post ${k}, and some more words to read.`, created: day(k) })); };
export const editPost = (site, k, { words = true, v = 2 } = {}) => site.put(makeDoc({ id: idOf(k), origin: site.origin, title: `Post ${k}`,
  body: words ? `Entirely rewritten words of post ${k}, version ${v}, nothing like before at all.` : `Words of post ${k}, and some more words to read.`, version: v, created: day(k), updated: day(100 + v) }));

/** P2..P4 on what is stored for origin `o` (at rest: also "never in both"). → a list of violations, [] when none. */
export function invariants(w, o = A, { atRest = true } = {}) {
  const s = w.store, bad = [];
  const main = s.peek('state', 'following');
  const b = main?.blygs?.[o];
  if (!b) return bad;
  const ep = b.epoch;
  const fd = s.peek('feed', N(o)), ad = s.peek('archive', N(o)), ld = s.peek('ledger', N(o));
  const feed = fd && fd.epoch === ep ? fd.items : {};
  const arch = ad && ad.epoch === ep ? ad.items : {};
  const led = ld && ld.epoch === ep ? ld : { ids: [], returns: [] };
  const ids = (led.ids || []).map(p => p[0]);
  if (new Set(ids).size !== ids.length) bad.push('P3 a ledger id twice');
  if (atRest) for (const id of Object.keys(feed)) if (arch[id]) bad.push(`P3 in both feed and archive: ${id}`);
  if (atRest) for (const id of Object.keys(arch)) if (!ids.includes(id)) bad.push(`P3 archive record ${id} not in the ledger`);
  for (const [id, r] of Object.entries(feed)) {
    if (r.kind === 'withdrawn') continue;
    if (s.peek('body', r.body || r.key) === null) bad.push(`P4 the body of unread ${id} is gone`);
    if (ids.includes(id) && r.read !== 'edited') bad.push(`P2 read ${id} is unread as ${r.read}`);
  }
  // P5 the day's edit-return count is not undercounted: every return of the last 24 hours is in the ledger's `returns`
  const returned = Object.values(feed).filter(r => r.read === 'edited' && r.returned_at && w.clock.t - r.returned_at < 24 * 3600e3).length;
  if ((led.returns || []).length < returned) bad.push(`P5 ${returned} edit-returns today, ${(led.returns || []).length} counted`);
  return bad;
}
/** Where a post is: its read state in its feed, in its archive, and whether its id is in its ledger. */
export function readStateOf(w, o, id) {
  const s = w.store;
  const ep = s.peek('state', 'following')?.blygs?.[o]?.epoch;
  const fd = s.peek('feed', N(o)), ad = s.peek('archive', N(o)), ld = s.peek('ledger', N(o));
  const f = fd && fd.epoch === ep ? fd.items[id] : null;
  const a = ad && ad.epoch === ep ? ad.items[id] : null;
  const inLed = !!(ld && ld.epoch === ep && ld.ids.some(p => p[0] === id));
  return { feed: f ? f.read : null, archive: a ? a.read : null, ledger: inLed };
}
