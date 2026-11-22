// following-inbox.test.mjs — the owner's mentions inbox: parsing, the token, the Mentions view.
//
//   node --test test/following-inbox.test.mjs
//
// The inbox's real mention shape is UNVERIFIED; the fixture (test/fixtures/following/inbox-invented.json) is
// invented from the few fields a command-line listing showed. Nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as F from '../following.mjs';
import * as I from '../following-inbox.mjs';
import { guardedGet } from '../netguard.mjs';
import { followingPage } from '../following-view.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = createRequire(import.meta.url)('../extension/config.js');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'following', 'inbox-invented.json'), 'utf8'));
const URL_ = 'https://inbox.web.test/api/mentions';
const TOKEN = 'tok_INVENTED_secret_0123456789';
const ADA = 'https://ada.example.test/a/';

function rig({ answer = { status: 200, body: FIXTURE }, settings = {}, forbidden = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-inbox-'));
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-inbox-tok-'));
  const tokenFile = path.join(tokenDir, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\nsecond line ignored\n`);
  const web = makeWeb();
  const seen = [];
  const box = { answer };
  const get = async (url, o) => {
    if (url === URL_) {
      seen.push({ url, headers: o.headers || {} });
      const a = box.answer;
      if (a.throw) { const e = new Error(a.throw); e.kind = a.kind || 'network'; throw e; }
      return { status: a.status, url, text: typeof a.body === 'string' ? a.body : JSON.stringify(a.body) };
    }
    return web.get(url, o);
  };
  const cfg = () => CFG.followingSettingsOf({ inbox_api_url: URL_, inbox_token_file: tokenFile, my_origins: ['https://me.example.test/'], ...settings }).settings;
  const file = path.join(dir, 'following.json');
  const f = F.createFollowing({ file, get, getSettings: cfg, tokenForbidden: forbidden, timers: { set: () => 1, clear: () => {} } });
  return { f, web, seen, box, file, dir, tokenFile, tokenDir, cfg,
    done: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tokenDir, { recursive: true, force: true }); } };
}

test('the field mapping is one table, and the parser tolerates what it does not know', () => {
  assert.ok(Object.isFrozen(I.MENTION_FIELDS));
  const p = I.parseInbox(FIXTURE);
  assert.equal(p.mentions.length, 7);
  const by = Object.fromEntries(p.mentions.map(m => [m.ident, m]));
  const m1 = by['id:m1'];
  assert.deepEqual([m1.who, m1.action, m1.version, m1.class, m1.passage, m1.post_title],
    ['Ada Invented', 'replied', 2, 'response', 'an invented passage about gardens', 'On gardens']);
  assert.equal(m1.source_url, 'https://ada.example.test/a/t/00000000000000000000000001/');
  assert.equal(m1.blyg_title, "Ada's Notes");
  assert.equal(by['id:m3'].class, 'notice');
  assert.equal(by['id:m4'].who, 'Di Invented', 'an author given as an object is read by its name');
  assert.match(by['id:m4'].at, /^2025-11-1\d|2025-11-/, 'an epoch timestamp is made a date');
  assert.equal(by['id:m5'].class, 'plain');
  const m6 = by['id:m6'];
  assert.equal(m6.class, 'unknown', 'an inbox that does not say what it is is not guessed at');
  assert.deepEqual([m6.source_url, m6.post_title, m6.version], ['', '', 0], 'a missing field is empty, never invented');
  assert.equal(by['id:m7'].source_url, '', 'a javascript: address is dropped');
  assert.equal(p.never_verified_count, 2);
  assert.equal(p.never_verified.length, 2);
  assert.equal(p.blocked_count, 1);
  assert.ok(m1.raw.includes('"quote"'), 'the raw object is kept for the details toggle');
  // nothing at all, or the wrong shape entirely, is not an error
  assert.deepEqual(I.parseInbox(null).mentions, []);
  assert.deepEqual(I.parseInbox({ mentions: 'x' }).mentions, []);
  assert.equal(I.parseInbox({ mentions: [7, null, 'text', []] }).mentions.length, 4);
  // the explicit class field, when the inbox has one, wins; the table is how a correction is made
  assert.equal(I.normaliseMention({ class: 'notice', action: 'replied' }).class, 'notice');
});

test('settings: inbox_api_url is https only; inbox_token_file is an absolute path; the token is not a setting', () => {
  const ok = CFG.followingSettingsOf({ inbox_api_url: 'https://me.example.test/inbox.json', inbox_token_file: '/home/x/.token' });
  assert.deepEqual(ok.refused, []);
  for (const bad of ['http://me.example.test/x', 'ftp://x/y', 'https://user:pw@x.test/y', 'not a url', 'https://x.test/y#frag']) {
    assert.deepEqual(CFG.followingSettingsOf({ inbox_api_url: bad }).refused, ['inbox_api_url'], bad);
  }
  assert.deepEqual(CFG.followingSettingsOf({ inbox_token_file: 'relative/token' }).refused, ['inbox_token_file']);
  assert.deepEqual(CFG.followingSettingsOf({}).settings.inbox_api_url, '');
  assert.ok(!('inbox_token' in CFG.followingSettingsOf({ inbox_token: 'abc' }).settings));
});

test('the token file: first line only; refused inside the repository or a data folder; never a directory', () => {
  const r = rig();
  assert.equal(I.readTokenFile(r.tokenFile), TOKEN);
  assert.match(I.tokenPathRefusal('relative', []), /absolute/);
  assert.match(I.tokenPathRefusal(r.tokenFile, [r.tokenDir]), /may not be inside/);
  assert.match(I.tokenPathRefusal(path.join(r.tokenDir, 'sub', 'later'), [r.tokenDir]), /may not be inside/, 'even a file not yet there');
  assert.equal(I.tokenPathRefusal(r.tokenFile, [r.dir]), '');
  assert.throws(() => I.readTokenFile(r.tokenDir), /not a file/);
  assert.throws(() => I.readTokenFile(path.join(r.tokenDir, 'missing')), /cannot be read/);
  fs.writeFileSync(r.tokenFile, '\n');
  assert.throws(() => I.readTokenFile(r.tokenFile), /empty/);
  fs.writeFileSync(r.tokenFile, 'has a space\n');
  assert.throws(() => I.readTokenFile(r.tokenFile), /not a usable token/);
  // a symlink into a forbidden folder is judged by where it leads
  fs.writeFileSync(r.tokenFile, `${TOKEN}\n`);
  const link = path.join(r.dir, 'link');
  fs.symlinkSync(r.tokenFile, link);
  assert.match(I.tokenPathRefusal(link, [r.tokenDir]), /may not be inside/);
  r.done();
});

test('the inbox state is named: off, pending, ok, unauthorised, unreachable; one function moves it', async () => {
  assert.deepEqual(F.INBOX_STATES, ['off', 'pending', 'ok', 'unauthorised', 'unreachable']);
  assert.equal(F.moveInbox({ state: 'off' }, 'set'), 'pending');
  assert.equal(F.moveInbox({ state: 'ok' }, 'unset'), 'off');
  assert.throws(() => F.moveInbox({ state: 'off' }, 'succeed'), /cannot succeed while off/);
  assert.throws(() => F.moveInbox({ state: 'off' }, 'unset'), /cannot unset while off/);
  const r = rig();
  assert.equal(r.f.inboxState(), 'off');
  r.f.confirmImport([]);
  await r.f.refresh();
  assert.equal(r.f.inboxState(), 'ok');
  r.box.answer = { status: 401, body: {} };
  await r.f.refresh();
  assert.equal(r.f.inboxState(), 'unauthorised');
  r.box.answer = { throw: 'timeout', kind: 'timeout' };
  await r.f.refresh();
  assert.equal(r.f.inboxState(), 'unreachable');
  r.box.answer = { status: 200, body: 'not json' };
  await r.f.refresh();
  assert.equal(r.f.inboxState(), 'unreachable');
  r.box.answer = { status: 200, body: FIXTURE };
  await r.f.refresh();
  assert.equal(r.f.inboxState(), 'ok');
  const none = F.createFollowing({ file: path.join(r.dir, 'none.json'), getSettings: () => CFG.followingSettingsOf({}).settings, get: async () => { throw new Error('no request expected'); } });
  await none.refresh();
  assert.equal(none.inboxState(), 'off', 'nothing set: off, and nothing asked');
  // a token file that may not be used: unauthorised, with the reason, and no request
  const bad = rig({ forbidden: [rig().tokenDir] });
  const g = F.createFollowing({ file: path.join(bad.dir, 'g.json'), getSettings: bad.cfg, get: async () => { throw new Error('no request expected'); },
    tokenForbidden: [bad.tokenDir] });
  await g.refresh();
  assert.equal(g.inboxState(), 'unauthorised');
  assert.match(g.view({ view: 'mentions' }).inbox.error, /may not be inside/);
  r.done(); bad.done();
});

test('the token goes to the inbox as a bearer header and nowhere else: not to disk, not to the browser, not into an error', async () => {
  const r = rig();
  await r.f.refresh();
  assert.deepEqual(r.seen.map(x => x.headers), [{ authorization: `Bearer ${TOKEN}` }]);
  const everything = [fs.readFileSync(r.file, 'utf8'), JSON.stringify(r.f.view({ view: 'mentions' })), JSON.stringify(r.f.view({ view: 'background' })),
    JSON.stringify(r.f.view()), JSON.stringify(r.cfg())];
  for (const text of everything) assert.ok(!text.includes(TOKEN), 'the token is nowhere in the stored or served data');
  // an inbox that echoes the token back, in a mention or in an error, is scrubbed
  const echoed = JSON.parse(JSON.stringify(FIXTURE));
  echoed.mentions[0].quote = `your token is ${TOKEN}`;
  r.box.answer = { status: 200, body: echoed };
  await r.f.refresh();
  const shown = JSON.stringify(r.f.view({ view: 'mentions' })) + fs.readFileSync(r.file, 'utf8');
  assert.ok(!shown.includes(TOKEN));
  assert.ok(shown.includes('[redacted]'));
  r.box.answer = { throw: `connect failed for ${TOKEN}`, kind: 'network' };
  await r.f.refresh();
  assert.ok(!JSON.stringify(r.f.view({ view: 'mentions' })).includes(TOKEN));
  assert.ok(!fs.readFileSync(r.file, 'utf8').includes(TOKEN));
  r.done();
});

test('netguard sends the extra header only to the origin the fetch started at (a redirect elsewhere does not get the token)', async () => {
  const sent = [];
  const reply = (status, headers) => { const res = Readable.from([Buffer.from('{"ok":true}')]); res.statusCode = status; res.headers = headers; return res; };
  const transport = { https: { request(opts, cb) {
    sent.push({ host: opts.hostname, headers: opts.headers });
    const to = opts.hostname === 'a.example.test' && opts.path === '/start' ? reply(302, { location: 'https://b.example.test/there' })
      : opts.hostname === 'a.example.test' && opts.path === '/same' ? reply(302, { location: 'https://a.example.test/final' }) : reply(200, { 'content-type': 'application/json' });
    return { on() {}, end() { setImmediate(() => cb(to)); }, destroy() {} };
  } } };
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  await guardedGet('https://a.example.test/start', { maxBytes: 1000, timeoutMs: 2000, resolve, transport, headers: { authorization: 'Bearer SECRET' } });
  assert.deepEqual(sent.map(s => [s.host, 'authorization' in s.headers]), [['a.example.test', true], ['b.example.test', false]]);
  sent.length = 0;
  await guardedGet('https://a.example.test/same', { maxBytes: 1000, timeoutMs: 2000, resolve, transport, headers: { authorization: 'Bearer SECRET' } });
  assert.deepEqual(sent.map(s => [s.host, 'authorization' in s.headers]), [['a.example.test', true], ['a.example.test', true]]);
});

test('Mentions: responses and plain mentions here (plain apart, labelled), notices in Background as "linked from" / "reposted by", unknown class labelled', async () => {
  const r = rig();
  await r.f.refresh();
  const mentions = r.f.view({ view: 'mentions' });
  assert.equal(mentions.inbox.state, 'ok');
  const reasons = Object.fromEntries(mentions.mentions.map(m => [m.ident, m.reason]));
  assert.deepEqual(reasons, { 'id:m1': 'response', 'id:m2': 'response', 'id:m5': 'plain mention (lower class)', 'id:m6': 'class unknown', 'id:m7': 'response' });
  assert.equal(mentions.mentions[0].ident, 'id:m1', 'newest first');
  const bg = r.f.view({ view: 'background' }).background.filter(b => b.type === 'mention');
  assert.deepEqual(Object.fromEntries(bg.map(b => [b.mention.ident, b.reason])), { 'id:m3': 'linked from', 'id:m4': 'reposted by' });
  assert.ok(!mentions.mentions.some(m => m.class === 'notice'), 'notices MUST NOT appear in a responses list (§15.5)');
  const tabs = r.f.view().tabs;
  assert.deepEqual([tabs.mentions, tabs.mentions_unseen], [5, 5]);
  r.done();
});

test('Mentions: seen state survives a refresh; Open marks a mention seen and answers with its source; one whose source is a followed post links to that entry', async () => {
  const r = rig();
  const site = r.web.add(ADA, { title: "Ada's Notes" });
  const id = idOf(1);
  site.put(makeDoc({ id, origin: ADA, kind: 'thread', title: 'Ada replies', transclusions: [] }));
  r.f.confirmImport([{ origin: ADA }]);
  await r.f.refresh();
  let v = r.f.view({ view: 'mentions' });
  const m1 = v.mentions.find(m => m.ident === 'id:m1');
  assert.equal(m1.feed_key, r.f.keyFor(ADA, id), 'it links to the entry in the feed');
  const m2 = v.mentions.find(m => m.ident === 'id:m2');
  assert.equal(m2.feed_key, '');
  assert.match(m1.key, /^[0-9a-f]{24}$/);
  // Open: the one path
  assert.deepEqual(r.f.open(m1.key), { url: 'https://ada.example.test/a/t/00000000000000000000000001/', opens_on: '' });
  assert.equal(r.f.itemByKey(r.f.keyFor(ADA, id)).read, 'opened', 'the followed post it is, opened');
  assert.deepEqual(r.f.open(m2.key), { url: 'https://bo.example.test/f/bbbbbbbbbbbbbbbbbbbbbbbbbb/', opens_on: '' });
  assert.throws(() => r.f.open(v.mentions.find(m => m.ident === 'id:m6').key), /no link/);
  assert.equal(r.f.view().tabs.mentions_unseen, 3);
  await r.f.refresh();
  assert.equal(r.f.view().tabs.mentions_unseen, 3, 'a refresh does not make seen mentions unseen again');
  assert.equal(r.f.view({ view: 'mentions' }).mentions.find(m => m.ident === 'id:m1').key, m1.key, 'and keys are stable');
  assert.equal(r.f.mentionSeen(m1.key), 'seen');
  assert.equal(r.f.allMentionsSeen(), 5, 'the three left in Mentions and the two notices in Background');
  assert.equal(r.f.view().tabs.mentions_unseen, 0);
  assert.throws(() => r.f.mentionSeen('nope'), /no such mention/);
  assert.throws(() => F.moveMention({ read: 'seen' }, 'see'), /cannot see while seen/);
  r.done();
});

test('the Mentions page: grouped by your post, passage, details as escaped JSON, never-verified line, hostile fields escaped', async () => {
  const r = rig();
  await r.f.refresh();
  const data = r.f.view({ view: 'mentions' });
  const settings = r.cfg();
  const html = followingPage({ data, settings, nonce: 'N0NCE' });
  const body = html.replace(/<script nonce="N0NCE">[\s\S]*?<\/script>/, '[our script]');
  assert.match(body, /<h2>On gardens<\/h2>/);
  assert.match(body, /an invented passage about gardens/);
  assert.match(body, /2 accepted, never verified/);
  assert.match(body, /1 blocked/);
  assert.match(body, /Plain mentions/);
  assert.match(body, /class unknown/);
  assert.match(body, /<details><summary[^>]*>details<\/summary><pre>/);
  assert.ok(!/<script>alert|<img\b|<svg\b/i.test(body));
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;') || body.includes('&lt;img'), 'hostile text is there as text');
  assert.ok(!/[‪-‮⁦-⁩]/.test(html));
  assert.ok(!/<[^>]*\son(error|load)\s*=/i.test(body));
  for (const m of body.matchAll(/\s(?:href|src|action)="([^"]*)"/g)) assert.match(m[1], /^\/(following|pages)/, m[1]);
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.ok(!html.includes(TOKEN));
  // the Background page names the reasons
  const bg = followingPage({ data: r.f.view({ view: 'background' }), settings, nonce: 'N0NCE' });
  assert.match(bg, /linked from/);
  assert.match(bg, /reposted by/);
  r.done();
});
