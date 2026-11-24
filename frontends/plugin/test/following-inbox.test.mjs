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

function rig({ answer = { status: 200, body: FIXTURE }, settings = {}, forbidden = [], mayFetch = () => true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-inbox-'));
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-inbox-tok-'));
  const tokenFile = path.join(tokenDir, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\nsecond line ignored\n`);
  const web = makeWeb();
  const seen = [];
  const box = { answer, mayFetch };
  const get = async (url, o) => {
    if (url === URL_) {
      seen.push({ url, headers: o.headers || {} });
      const a = box.answer;
      if (a.throw) { const e = new Error(a.throw); e.kind = a.kind || 'network'; throw e; }
      return { status: a.status, url: a.url || url, text: typeof a.body === 'string' ? a.body : JSON.stringify(a.body) };
    }
    return web.get(url, o);
  };
  const cfg = () => CFG.followingSettingsOf({ inbox_api_url: URL_, inbox_token_file: tokenFile, my_origins: ['https://me.example.test/'], ...settings }).settings;
  const file = path.join(dir, 'following.json');
  const f = F.createFollowing({ file, get, getSettings: cfg, tokenForbidden: forbidden, mayFetch: () => box.mayFetch(), timers: { set: () => 1, clear: () => {} } });
  return { f, web, seen, box, file, dir, tokenFile, tokenDir, cfg,
    done: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tokenDir, { recursive: true, force: true }); } };
}


// every script on a Hub page carries the nonce; exactly one is executable inline code (ours), the only one with a source is the
// companion's own anchoring code, and the rest is JSON data
const scriptsOf = html => {
  const tags = html.match(/<script\b[^>]*>/g) || [];
  return { all: tags.length, nonced: tags.filter(t => /\snonce="[^"]+"/.test(t)).length,
    inline: tags.filter(t => !/\ssrc=/.test(t) && !/type="application\/json"/.test(t)).length,
    sources: tags.filter(t => /\ssrc=/.test(t)).map(t => /src="([^"]*)"/.exec(t)[1]) };
};

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

test('the inbox state is named: off, pending, paused, ok, unauthorised, unreachable, unreadable; one function moves it', async () => {
  assert.deepEqual(F.INBOX_STATES, ['off', 'pending', 'paused', 'ok', 'unauthorised', 'unreachable', 'unreadable']);
  assert.equal(F.moveInbox({ state: 'off' }, 'set'), 'pending');
  assert.equal(F.moveInbox({ state: 'ok' }, 'unset'), 'off');
  assert.throws(() => F.moveInbox({ state: 'off' }, 'succeed'), /cannot succeed while off/);
  assert.throws(() => F.moveInbox({ state: 'off' }, 'unset'), /cannot unset while off/);
  const r = rig();
  assert.equal(await r.f.inboxState(), 'off');
  await r.f.confirmImport([]);
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'ok');
  r.box.answer = { status: 401, body: {} };
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'unauthorised');
  r.box.answer = { throw: 'timeout', kind: 'timeout' };
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'unreachable');
  r.box.answer = { status: 200, body: 'not json' };
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'unreadable', 'it answered, but not with anything readable');
  r.box.answer = { status: 502, body: {} };
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'unreachable');
  r.box.answer = { status: 200, body: FIXTURE };
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'ok');
  const none = F.createFollowing({ file: path.join(r.dir, 'none.json'), getSettings: () => CFG.followingSettingsOf({}).settings, get: async () => { throw new Error('no request expected'); } });
  await none.refresh();
  assert.equal(await none.inboxState(), 'off', 'nothing set: off, and nothing asked');
  // a token file that may not be used: unauthorised, with the reason, and no request
  const bad = rig({ forbidden: [rig().tokenDir] });
  const g = F.createFollowing({ file: path.join(bad.dir, 'g.json'), getSettings: bad.cfg, get: async () => { throw new Error('no request expected'); },
    tokenForbidden: [bad.tokenDir] });
  await g.refresh();
  assert.equal(await g.inboxState(), 'unauthorised');
  assert.match((await g.view({ view: 'mentions' })).inbox.error, /may not be inside/);
  r.done(); bad.done();
});

test('the token goes to the inbox as a bearer header and nowhere else: not to disk, not to the browser, not into an error', async () => {
  const r = rig();
  await r.f.refresh();
  assert.deepEqual(r.seen.map(x => x.headers), [{ authorization: `Bearer ${TOKEN}` }]);
  const everything = [fs.readFileSync(r.file, 'utf8'), JSON.stringify(await r.f.view({ view: 'mentions' })), JSON.stringify(await r.f.view({ view: 'background' })),
    JSON.stringify(await r.f.view()), JSON.stringify(r.cfg())];
  for (const text of everything) assert.ok(!text.includes(TOKEN), 'the token is nowhere in the stored or served data');
  // an inbox that echoes the token back, in a mention or in an error, is scrubbed
  const echoed = JSON.parse(JSON.stringify(FIXTURE));
  echoed.mentions[0].quote = `your token is ${TOKEN}`;
  r.box.answer = { status: 200, body: echoed };
  await r.f.refresh();
  const shown = JSON.stringify(await r.f.view({ view: 'mentions' })) + fs.readFileSync(r.file, 'utf8');
  assert.ok(!shown.includes(TOKEN));
  assert.ok(shown.includes('[redacted]'));
  r.box.answer = { throw: `connect failed for ${TOKEN}`, kind: 'network' };
  await r.f.refresh();
  assert.ok(!JSON.stringify(await r.f.view({ view: 'mentions' })).includes(TOKEN));
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
  const mentions = await r.f.view({ view: 'mentions' });
  assert.equal(mentions.inbox.state, 'ok');
  const reasons = Object.fromEntries(mentions.mentions.map(m => [m.ident, m.reason]));
  assert.deepEqual(reasons, { 'id:m1': 'response', 'id:m2': 'response', 'id:m5': 'plain mention (lower class)', 'id:m6': 'class unknown', 'id:m7': 'response' });
  assert.equal(mentions.mentions[0].ident, 'id:m1', 'newest first');
  const bg = (await r.f.view({ view: 'background' })).background.filter(b => b.type === 'mention');
  assert.deepEqual(Object.fromEntries(bg.map(b => [b.mention.ident, b.reason])), { 'id:m3': 'linked from', 'id:m4': 'reposted by' });
  assert.ok(!mentions.mentions.some(m => m.class === 'notice'), 'notices MUST NOT appear in a responses list (§15.5)');
  const tabs = (await r.f.view()).tabs;
  assert.deepEqual([tabs.mentions, tabs.mentions_unseen], [5, 5]);
  r.done();
});

test('Mentions: seen state survives a refresh; Open marks a mention seen and answers with its source; one whose source is a followed post links to that entry', async () => {
  const r = rig();
  const site = r.web.add(ADA, { title: "Ada's Notes" });
  const id = idOf(1);
  site.put(makeDoc({ id, origin: ADA, kind: 'thread', title: 'Ada replies', transclusions: [] }));
  await r.f.confirmImport([{ origin: ADA }]);
  await r.f.refresh();
  let v = await r.f.view({ view: 'mentions' });
  const m1 = v.mentions.find(m => m.ident === 'id:m1');
  assert.equal(m1.feed_key, await r.f.keyFor(ADA, id), 'it links to the entry in the feed');
  const m2 = v.mentions.find(m => m.ident === 'id:m2');
  assert.equal(m2.feed_key, '');
  assert.match(m1.key, /^[0-9a-f]{24}$/);
  // Open: the one path
  assert.deepEqual(await r.f.open(m1.key), { url: 'https://ada.example.test/a/t/00000000000000000000000001/', opens_on: '' });
  assert.equal((await r.f.itemByKey(await r.f.keyFor(ADA, id))).read, 'opened', 'the followed post it is, opened');
  assert.deepEqual(await r.f.open(m2.key), { url: 'https://bo.example.test/f/bbbbbbbbbbbbbbbbbbbbbbbbbb/', opens_on: '' });
  await assert.rejects(async () => await r.f.open(v.mentions.find(m => m.ident === 'id:m6').key), /no link/);
  assert.equal((await r.f.view()).tabs.mentions_unseen, 3);
  await r.f.refresh();
  assert.equal((await r.f.view()).tabs.mentions_unseen, 3, 'a refresh does not make seen mentions unseen again');
  assert.equal((await r.f.view({ view: 'mentions' })).mentions.find(m => m.ident === 'id:m1').key, m1.key, 'and keys are stable');
  assert.equal(await r.f.mentionSeen(m1.key), 'seen');
  assert.equal(await r.f.allMentionsSeen(), 5, 'the three left in Mentions and the two notices in Background');
  assert.equal((await r.f.view()).tabs.mentions_unseen, 0);
  await assert.rejects(async () => await r.f.mentionSeen('nope'), /no such mention/);
  assert.throws(() => F.moveMention({ read: 'seen' }, 'see'), /cannot see while seen/);
  r.done();
});

test('the Mentions page: grouped by your post, passage, details as escaped JSON, never-verified line, hostile fields escaped', async () => {
  const r = rig();
  await r.f.refresh();
  const data = await r.f.view({ view: 'mentions' });
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
  assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(html));
  assert.ok(!/<[^>]*\son(error|load)\s*=/i.test(body));
  for (const m of body.matchAll(/\s(?:href|src|action)="([^"]*)"/g)) assert.match(m[1], /^(\/(hub|pages)|#e-)/, m[1]);
  { const sc = scriptsOf(html); assert.deepEqual([sc.inline, sc.nonced === sc.all], [1, true]); assert.ok(sc.sources.every(u => u === '/assets/anchor.js')); }
  assert.ok(!html.includes(TOKEN));
  // the Background page names the reasons
  const bg = followingPage({ data: await r.f.view({ view: 'background' }), settings, nonce: 'N0NCE' });
  assert.match(bg, /linked from/);
  assert.match(bg, /reposted by/);
  r.done();
});

// ---- round 2 ----------------------------------------------------------------------------------

test('the token file: visible ASCII only, no quote or backslash, 8 to 512 characters; too long is refused, not cut', () => {
  const r = rig();
  const put = text => fs.writeFileSync(r.tokenFile, text);
  put('abcdefg\n');
  assert.throws(() => I.readTokenFile(r.tokenFile), /too short/);
  put('abcdefgh\n');
  assert.equal(I.readTokenFile(r.tokenFile), 'abcdefgh');
  put('a'.repeat(512) + '\n');
  assert.equal(I.readTokenFile(r.tokenFile).length, 512);
  put('a'.repeat(513) + '\n');
  assert.throws(() => I.readTokenFile(r.tokenFile), /longer than 512/);
  for (const bad of ['abcd"efgh', 'abcd\\efgh', 'abcd' + String.fromCharCode(233) + 'efgh', 'abcd' + String.fromCharCode(0x2028) + 'efgh', 'abcd efgh']) {
    put(bad + '\n');
    assert.throws(() => I.readTokenFile(r.tokenFile), /not a usable token/, JSON.stringify(bad));
  }
  r.done();
});

test('the token is scrubbed from the whole document before anything is read out of it or clipped', async () => {
  const doc = JSON.parse(JSON.stringify(FIXTURE));
  doc.generated_at = `at ${TOKEN}`;
  doc.never_verified = [{ who: 'x'.repeat(150) + TOKEN, source: `https://x.test/${TOKEN}` }, `see ${TOKEN}`, { who: TOKEN }];
  doc.mentions[0].quote = 'y'.repeat(595) + TOKEN;          // the clip limit falls inside the token
  doc.mentions[0].who = 'z'.repeat(155) + TOKEN;
  doc.mentions[1][TOKEN] = 'a key';
  doc.mentions[2].action = { name: TOKEN };
  doc.failure_log = { never_verified: 3, note: TOKEN };
  const r = rig({ answer: { status: 200, body: doc } });
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'ok');
  const out = JSON.stringify([await r.f.view({ view: 'mentions' }), await r.f.view({ view: 'background' }), await r.f.view()]) + fs.readFileSync(r.file, 'utf8')
    + followingPage({ data: await r.f.view({ view: 'mentions' }), settings: r.cfg(), nonce: 'N' });
  for (const piece of [TOKEN, TOKEN.slice(0, 8), TOKEN.slice(-8)]) assert.ok(!out.includes(piece), `no piece of the token (${piece})`);
  assert.ok(out.includes('[redacted]'));
  assert.deepEqual(I.scrubDeep({ a: [TOKEN, { [TOKEN]: 1 }] }, TOKEN), { a: ['[redacted]', { '[redacted]': 1 }] });
  r.done();
});

test('a very deeply nested inbox cannot overflow the stack: bounded, and never left "pending" with no word', async () => {
  let deep = { name: 'x' };
  for (let n = 0; n < 200000; n++) deep = { name: deep };
  assert.doesNotThrow(() => I.normaliseMention({ who: deep, quote: deep }));
  assert.doesNotThrow(() => I.scrubDeep(deep, TOKEN));
  const nested = '{"mentions":[{"who":' + '{"name":'.repeat(60000) + '"x"' + '}'.repeat(60000) + ',"action":"replied"}]}';
  const r = rig({ answer: { status: 200, body: nested } });
  await r.f.refresh();
  const v = await r.f.view({ view: 'mentions' });
  assert.notEqual(v.inbox.state, 'pending');
  assert.ok(['ok', 'unreadable'].includes(v.inbox.state));
  if (v.inbox.state === 'unreadable') assert.match(v.inbox.error, /cannot read/);
  assert.equal(await r.f.runState(), 'idle');
  r.done();
});

test('an inbox that answers from another origin than the one set (a redirect) is unreachable, with the reason', async () => {
  const r = rig({ answer: { status: 200, body: FIXTURE, url: 'https://elsewhere.web.test/api/mentions' } });
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'unreachable');
  assert.match((await r.f.view({ view: 'mentions' })).inbox.error, /another origin/);
  assert.equal((await r.f.view({ view: 'mentions' })).mentions.length, 0, 'what it said is not taken');
  r.box.answer = { status: 200, body: FIXTURE, url: `${URL_}?page=2` };
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'ok', 'the same origin, another path, is fine');
  r.done();
});

test('the inbox has its own small request budget: blygs cannot starve it', async () => {
  const r = rig({ settings: { following_run_requests: 5 } });
  for (const [n, o] of ['https://one.web.test/', 'https://two.web.test/', 'https://three.web.test/'].entries()) {
    const site = r.web.add(o);
    for (let k = 1; k <= 8; k++) site.put(makeDoc({ id: idOf(n * 10 + k), origin: o }));
    await r.f.confirmImport([{ origin: o }]);
  }
  const s = await r.f.refresh();
  assert.ok(s.deferred > 0, 'the blygs spent the run\'s budget');
  assert.equal(await r.f.inboxState(), 'ok', 'and the inbox was asked all the same');
  assert.equal(r.seen.length, 1);
  r.done();
});

test('configured but fetching is off: the inbox says it is paused, not that none is set; back on, it is asked again', async () => {
  let on = false;
  const r = rig({ mayFetch: () => on });
  const v = await r.f.view({ view: 'mentions' });
  assert.equal(v.inbox.state, 'paused');
  const html = followingPage({ data: v, settings: r.cfg(), nonce: 'N' });
  assert.match(html, /paused: Blygger checks are off/);
  assert.ok(!/no inbox is set/.test(html));
  await r.f.refresh();
  assert.equal(r.seen.length, 0, 'nothing was asked');
  on = true;
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'ok');
  on = false;
  assert.equal((await r.f.view({ view: 'mentions' })).inbox.state, 'paused');
  assert.equal((await r.f.view({ view: 'mentions' })).mentions.length, 5, 'what was already listed stays');
  // and with nothing configured it still says so
  const none = F.createFollowing({ file: path.join(r.dir, 'n.json'), getSettings: () => CFG.followingSettingsOf({}).settings, mayFetch: () => false });
  assert.equal((await none.view()).inbox.state, 'off');
  r.done();
});

test('netguard\'s extra headers refuse host, content-length, connection, and names or values with control characters, before any request', async () => {
  const { checkExtraHeaders } = await import('../netguard.mjs');
  const ok = { authorization: 'Bearer abc' };
  assert.doesNotThrow(() => checkExtraHeaders(ok));
  for (const name of ['host', 'Host', 'content-length', 'connection', 'Transfer-Encoding', 'upgrade']) assert.throws(() => checkExtraHeaders({ [name]: 'x' }), /may not be set/, name);
  assert.throws(() => checkExtraHeaders({ authorization: 'a' + String.fromCharCode(13, 10) + 'x-evil: 1' }), /value is not valid/);
  assert.throws(() => checkExtraHeaders({ authorization: 'a' + String.fromCharCode(0) }), /value is not valid/);
  assert.throws(() => checkExtraHeaders({ authorization: 7 }), /value is not valid/);
  assert.throws(() => checkExtraHeaders({ ['x-a' + String.fromCharCode(10) + 'b']: 'v' }), /name is not valid/);
  assert.throws(() => checkExtraHeaders({ 'bad name': 'v' }), /name is not valid/);
  let asked = 0;
  const transport = { https: { request() { asked++; throw new Error('no request expected'); } } };
  await assert.rejects(() => guardedGet('https://a.example.test/x', { maxBytes: 10, timeoutMs: 1000, transport, resolve: async () => [{ address: '93.184.216.34', family: 4 }], headers: { host: 'evil' } }), /may not be set/);
  assert.equal(asked, 0);
});

test('the Authorization header is NOT sent on a redirect to http on the same host, or to the same host on another port', async () => {
  const sent = [];
  const reply = (status, headers) => { const res = Readable.from([Buffer.from('{"ok":true}')]); res.statusCode = status; res.headers = headers; return res; };
  const make = scheme => ({ request(opts, cb) {
    sent.push({ scheme, host: opts.hostname, port: opts.port || '', path: opts.path, auth: 'authorization' in opts.headers });
    const to = opts.path === '/start-http' ? reply(302, { location: 'http://a.example.test/landed' })
      : opts.path === '/start-port' ? reply(302, { location: 'https://a.example.test:8443/landed' })
        : opts.path === '/start-path' ? reply(302, { location: '/landed' }) : reply(200, { 'content-type': 'application/json' });
    return { on() {}, end() { setImmediate(() => cb(to)); }, destroy() {} };
  } });
  const transport = { http: make('http'), https: make('https') };
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  const get = p => guardedGet(`https://a.example.test${p}`, { maxBytes: 1000, timeoutMs: 2000, resolve, transport, headers: { authorization: 'Bearer SECRET' } });
  await get('/start-http');
  assert.deepEqual(sent.map(x => [x.scheme, x.auth]), [['https', true], ['http', false]], 'downgraded to http: no credential');
  sent.length = 0;
  await get('/start-port');
  assert.deepEqual(sent.map(x => [x.port, x.auth]), [['', true], ['8443', false]], 'another port of the same host: no credential');
  sent.length = 0;
  await get('/start-path');
  assert.deepEqual(sent.map(x => x.auth), [true, true], 'the same origin keeps it');
});

test('a token file that other users can read is warned about (never refused); one only the owner can read is not', async () => {
  const r = rig();
  fs.chmodSync(r.tokenFile, 0o644);
  assert.match(I.tokenFileWarning(r.tokenFile), /other users/);
  assert.equal(I.readTokenFile(r.tokenFile), TOKEN, 'still usable');
  await r.f.refresh();
  assert.equal(await r.f.inboxState(), 'ok', 'and the inbox is asked all the same');
  const v = await r.f.view({ view: 'mentions' });
  assert.match(v.inbox.token_warning, /chmod 600/);
  const html = followingPage({ data: v, settings: r.cfg(), nonce: 'N' });
  assert.match(html, /can be read by other users/);
  fs.chmodSync(r.tokenFile, 0o600);
  assert.equal(I.tokenFileWarning(r.tokenFile), '');
  assert.equal((await r.f.view({ view: 'mentions' })).inbox.token_warning, '');
  assert.equal(I.tokenFileWarning(path.join(r.tokenDir, 'missing')), '');
  r.done();
});

// The shape the owner's inbox actually returns (field names seen on a live inbox; every value
// here is invented). The table must read its page addresses, time and the inbox's own verdict.
test('a mention in the live inbox shape is read: source page, own post page, time, and the inbox mode as its class', async () => {
  const { parseInbox, INBOX_MODE_CLASSES } = await import('../following-inbox.mjs');
  const doc = { count: 2, mentions: [
    { id: 'm-1', mode: 'verified-response', relation: 'stub', target_item: 'a'.repeat(26), target_title: 'My post',
      target_page: 'https://me.example.test/my-post', target_version: 3, source_origin: 'https://them.example.test/blyg/',
      source_id: 'b'.repeat(26), source_page: 'https://them.example.test/blyg/t/' + 'b'.repeat(26) + '/',
      source_document: 'https://them.example.test/blyg/items/' + 'b'.repeat(26) + '.json', author_name: 'A Writer',
      blyg_title: 'Their Blyg', post_title: null, excerpt: 'the passage', first_verified_at: '2026-01-02T03:04:05.000Z' },
    { id: 'm-2', mode: 'verified-notice', relation: 'stub', target_page: 'https://me.example.test/my-post',
      source_page: 'https://them.example.test/blyg/t/x/', author_name: 'A Writer', verified_at: '2026-01-03T00:00:00.000Z' },
  ] };
  const out = parseInbox(doc);
  const [a, b] = out.mentions;
  assert.equal(a.source_url, 'https://them.example.test/blyg/t/' + 'b'.repeat(26) + '/');
  assert.equal(a.post_url, 'https://me.example.test/my-post');
  assert.equal(a.post_title, 'My post');
  assert.equal(a.version, 3);
  assert.ok(a.at, 'the time is read');
  assert.equal(a.class, 'response');
  assert.equal(b.class, 'notice', 'the inbox mode outranks the relation word');
  assert.deepEqual(Object.keys(INBOX_MODE_CLASSES).sort(), ['verified-notice', 'verified-response']);
});
