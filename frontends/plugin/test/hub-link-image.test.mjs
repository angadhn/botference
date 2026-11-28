// hub-link-image.test.mjs — "Add image" from the Hub's reply box, on this computer's side: the JPEG filter (metadata out, even when the
// browser's was not), where a picture is saved (content-addressed, confined, never overwritten), the image_folder setting, the signed
// `image` route over HTTP, the cleanup, and the picture line in the owner's note text. A real JPEG is made with macOS's sips when it
// is there (the decode checks are skipped without it); the hand-built parts need no tool.
//
//   node --test test/hub-link-image.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as L from '../hub-link.mjs';
import * as I from '../hub-image.mjs';
import * as H from '../blyg-home.mjs';
import { ownText, imageCaptionProblem } from '../blyg-note.mjs';
import { makeRig } from './blyg-rig.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubimage-'));
const SIPS = fs.existsSync('/usr/bin/sips');

// ---- a real JPEG, and the segments a phone's photo carries -----------------------------------------------------------------------
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 255 / w) | 0; raw[o + 1] = (y * 255 / h) | 0; raw[o + 2] = 90; }
  const crc = b => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function realJpeg(w = 64, h = 48) {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.png'), png(w, h));
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', path.join(d, 'a.png'), '--out', path.join(d, 'a.jpg')], { stdio: 'ignore' });
  const b = fs.readFileSync(path.join(d, 'a.jpg'));
  fs.rmSync(d, { recursive: true, force: true });
  return b;
}
const segment = (marker, body) => { const s = Buffer.alloc(4 + body.length); s[0] = 0xff; s[1] = marker; s.writeUInt16BE(body.length + 2, 2); body.copy(s, 4); return s; };
/** An Exif block with a GPS IFD, built by hand (little-endian TIFF): the owner's latitude and longitude in it. */
function exifWithGps() {
  const gps = Buffer.alloc(8 + 2 + 12 * 4 + 4 + 48);   // ifd entries then the rational values
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 * 4 + 4 + 48);
  tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x8825, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18); tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(4, 26);
  let o = 28;
  for (const [tag, type, n, val] of [[1, 2, 2, 78], [2, 5, 3, 80], [3, 2, 2, 87], [4, 5, 3, 104]]) { tiff.writeUInt16LE(tag, o); tiff.writeUInt16LE(type, o + 2); tiff.writeUInt32LE(n, o + 4); tiff.writeUInt32LE(val, o + 8); o += 12; }
  tiff.writeUInt32LE(0, o);
  void gps;
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff.subarray(0, o + 4), Buffer.from('LATITUDE-51N LONGITUDE-0W', 'latin1')]));
}
const AFTER_SOI = b => 2;
/** `jpeg` with extra segments put right after the start of image, and `tail` after its end. */
const withSegments = (jpeg, segs, tail = Buffer.alloc(0)) => Buffer.concat([jpeg.subarray(0, AFTER_SOI(jpeg)), ...segs, jpeg.subarray(AFTER_SOI(jpeg)), tail]);
const FAKE_SCAN = (() => {   // not a picture that decodes: only the segment layout (SOI, JFIF, SOS, data with a stuffed FF00 and a restart, EOI)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]), Buffer.from([0xff, 0xd9])]);
})();
const markers = b => { const out = []; let at = 2; while (at + 4 <= b.length && b[at] === 0xff) { out.push(b[at + 1]); if (b[at + 1] === 0xda) break; at += 2 + b.readUInt16BE(at + 2); } return out; };
const dims = file => { const o = spawnSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' }); return o.status === 0 ? o.stdout.match(/pixelWidth: (\d+)[\s\S]*pixelHeight: (\d+)/)?.slice(1).map(Number) : null; };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

test('the filter drops Exif (with its GPS), XMP, APP13, comments and other application segments, keeps what decodes, cuts what follows the end', () => {
  const dirty = withSegments(FAKE_SCAN, [exifWithGps(), segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1')), segment(0xed, Buffer.from('Photoshop 3.0\0', 'latin1')),
    segment(0xfe, Buffer.from('shot at the owner\'s house')), segment(0xe5, Buffer.from('vendor note')), segment(0xe2, Buffer.from('MPF\0more pictures', 'latin1')), segment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile', 'latin1'))],
  Buffer.from('HIDDEN AFTER THE END'));
  assert.deepEqual(I.metadataOf(dirty).sort(), ['APP1', 'APP1', 'APP13', 'COM']);
  const r = I.stripJpeg(dirty);
  assert.equal(r.ok, true);
  assert.deepEqual(I.metadataOf(r.bytes), []);
  assert.deepEqual(markers(r.bytes), [0xe2, 0xe0, 0xda], 'JFIF, the ICC profile and the scan stay');
  assert.ok(!r.bytes.includes(Buffer.from('LATITUDE')) && !r.bytes.includes(Buffer.from('HIDDEN')) && !r.bytes.includes(Buffer.from('Exif')) && !r.bytes.includes(Buffer.from('xmpmeta')));
  assert.deepEqual(r.bytes.subarray(-2), Buffer.from([0xff, 0xd9]));
  assert.ok(r.bytes.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])), 'the image data is untouched, stuffed bytes and restart marker included');
  assert.deepEqual(r.dropped.sort(), ['APP1', 'APP1', 'APP13', 'APP2', 'APP5', 'COM']);
  // a picture with none of it is returned exactly
  assert.deepEqual(I.stripJpeg(FAKE_SCAN).bytes, FAKE_SCAN);
});

test('the filter refuses what is not a whole JPEG', () => {
  const bad = { 'a PNG': png(4, 4), 'empty': Buffer.alloc(0), 'text': Buffer.from('<?php echo 1;'), 'SOI only': Buffer.from([0xff, 0xd8, 0xff]),
    'no end': FAKE_SCAN.subarray(0, FAKE_SCAN.length - 2), 'a length past the end': Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1, 0xff, 0xff, 1, 2])]),
    'no scan': Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0')), Buffer.from([0xff, 0xd9])]) };
  for (const [what, b] of Object.entries(bad)) assert.equal(I.stripJpeg(b).ok, false, what);
  assert.equal(I.stripJpeg(png(4, 4)).why, 'not-jpeg');
  assert.equal(I.stripJpeg(bad['no end']).why, 'damaged');
});

test('a real JPEG with an Exif GPS block: the saved file has no APP1, APP13 or comment, and still decodes at the same size', { skip: !SIPS && 'sips is not here' }, () => {
  const good = realJpeg(64, 48);
  const dirty = withSegments(good, [exifWithGps(), segment(0xed, Buffer.from('Photoshop 3.0\0', 'latin1')), segment(0xfe, Buffer.from('a comment'))]);
  assert.ok(I.metadataOf(dirty).includes('APP1'));
  const rig = makeRig();
  try {
    const url = '/assets/imgs/hub/';
    const folder = path.join(rig.top, 'assets/imgs/hub');
    const r = I.saveImage({ folder, url, top: rig.top, bytes: dirty });
    assert.equal(r.ok, true, JSON.stringify(r));
    const saved = path.join(folder, r.name);
    const bytes = fs.readFileSync(saved);
    assert.deepEqual(I.metadataOf(bytes), []);
    assert.ok(!bytes.includes(Buffer.from('LATITUDE')));
    assert.deepEqual(dims(saved), [64, 48]);
    assert.equal(r.name, `${sha(bytes)}.jpg`, 'named by the hash of the bytes as saved');
    assert.equal(r.path, `/assets/imgs/hub/${r.name}`);
    assert.equal(fs.statSync(saved).mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(folder), [r.name], 'no temporary file is left');
    // the same picture again: the same file, no second one
    const again = I.saveImage({ folder, url, top: rig.top, bytes: dirty });
    assert.equal(again.path, r.path);
    assert.equal(fs.readdirSync(folder).length, 1);
  } finally { rig.done(); }
});

test('saving: only inside the checkout, never over a different file, refusals say why', () => {
  const rig = makeRig();
  try {
    const url = '/assets/imgs/hub/';
    const folder = path.join(rig.top, 'assets/imgs/hub');
    // a folder outside the checkout, a link out of it, the work tree itself, .git
    const outside = tmp();
    assert.equal(I.checkImageFolder(outside, rig.top).ok, false);
    assert.equal(I.checkImageFolder(rig.top, rig.top).ok, false, 'not the checkout itself');
    assert.equal(I.checkImageFolder(path.join(rig.top, '.git/x'), rig.top).ok, false);
    assert.equal(I.checkImageFolder(path.join(rig.top, 'a/../../escape'), rig.top).ok, false);
    assert.equal(I.checkImageFolder('relative/dir', rig.top).ok, false);
    fs.symlinkSync(outside, path.join(rig.top, 'linked'));
    assert.equal(I.checkImageFolder(path.join(rig.top, 'linked'), rig.top).ok, false, 'a link that leads out');
    assert.equal(I.checkImageFolder(path.join(rig.top, 'linked/sub'), rig.top).ok, false);
    const r0 = I.saveImage({ folder: path.join(rig.top, 'linked'), url, top: rig.top, bytes: FAKE_SCAN });
    assert.equal(r0.ok, false);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside');
    // the folder is a link out, made AFTER the setting was checked: the save checks again
    fs.mkdirSync(path.join(rig.top, 'assets'), { recursive: true });
    fs.symlinkSync(outside, path.join(rig.top, 'assets/imgs'));
    assert.equal(I.saveImage({ folder, url, top: rig.top, bytes: FAKE_SCAN }).error, 'folder-outside');
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(rig.top, 'assets/imgs'));
    // a file with the name already there but other bytes is never overwritten
    const name = `${sha(FAKE_SCAN)}.jpg`;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name), 'something else');
    const taken = I.saveImage({ folder, url, top: rig.top, bytes: FAKE_SCAN });
    assert.deepEqual([taken.ok, taken.error], [false, 'name-taken']);
    assert.equal(fs.readFileSync(path.join(folder, name), 'utf8'), 'something else');
    fs.rmSync(outside, { recursive: true, force: true });
    // refusals
    assert.deepEqual(I.saveImage({ folder, url, top: rig.top, bytes: png(4, 4) }).error, 'not-jpeg');
    assert.deepEqual(I.saveImage({ folder, url, top: rig.top, bytes: Buffer.concat([FAKE_SCAN.subarray(0, FAKE_SCAN.length - 2), Buffer.alloc(I.IMAGE_LIMITS.bytes), Buffer.from([0xff, 0xd9])]) }).error, 'too-large');
    assert.equal(I.saveImage({ folder: '', url, top: rig.top, bytes: FAKE_SCAN }).error, 'images-off');
  } finally { rig.done(); }
});

test('the image_folder setting: inside the checkout or refused; none means images off', () => {
  const rig = makeRig();
  try {
    const prog = process.execPath;
    const base = { ...rig.home };
    const ok = H.validateHome({ ...base, image_folder: path.join(rig.top, 'assets/imgs/hub') });
    assert.equal(ok.ok, true, ok.errors.join());
    assert.equal(ok.settings.image_url, '/assets/imgs/hub/');
    assert.equal(ok.settings.image_folder, path.join(rig.top, 'assets/imgs/hub'));
    const none = H.validateHome(base);
    assert.deepEqual([none.ok, none.settings.image_folder, none.settings.image_url], [true, '', '']);
    assert.match(H.validateHome({ ...base, image_folder: os.tmpdir() }).errors.join(), /inside the site checkout/);
    assert.match(H.validateHome({ ...base, image_folder: 'assets' }).errors.join(), /absolute/);
    assert.equal(H.storable({ ...base, image_folder: '/x' }).image_folder, '/x');
    assert.equal(H.fingerprint(ok.settings), H.fingerprint(none.settings), 'the setting changes nothing a run does');
    void prog;
  } finally { rig.done(); }
});

test('cleanup: an untracked picture no note names goes after the wait; a tracked one, a named one and a recent one stay', () => {
  const rig = makeRig();
  try {
    const folder = path.join(rig.top, 'assets/imgs/hub');
    fs.mkdirSync(folder, { recursive: true });
    const mk = (label, ageDays) => { const n = `${sha(label)}.jpg`; const f = path.join(folder, n); fs.writeFileSync(f, label); const t = new Date(Date.now() - ageDays * 86_400_000); fs.utimesSync(f, t, t); return n; };
    const old = mk('old', 40), recent = mk('recent', 1), named = mk('named', 40), tracked = mk('tracked', 40);
    fs.writeFileSync(path.join(rig.folder, 'post.md'), `---\ntitle: x\n---\n\n![](/assets/imgs/hub/${named})\n`);
    execFileSync('git', ['-C', rig.top, 'add', path.join(folder, tracked)]);
    execFileSync('git', ['-C', rig.top, 'commit', '-qm', 'pic']);
    const gone = I.cleanupImages({ folder, top: rig.top, notesFolder: rig.folder });
    assert.deepEqual(gone, [old]);
    assert.deepEqual(fs.readdirSync(folder).sort(), [named, recent, tracked].sort());
  } finally { rig.done(); }
});

// ---- the route, signed, over HTTP ---------------------------------------------------------------------------------------------------
async function linkWith({ settings = null } = {}) {
  const dir = tmp();
  const key = L.newKey({ hub_origin: 'https://blog.example.com', publish: 'drafts-only' });
  L.writeLinkKey(dir, key);
  const logs = [];
  const images = I.createImages({ settings: () => settings, log: l => logs.push(l) });
  const link = L.createHubLink({ keyDir: dir, repliesFile: path.join(dir, L.HUB_LINK_REPLIES_FILE), log: l => logs.push(l), perMinute: 10000, images,
    bind: async () => ({ verdict: 'unverified', code: 'not-verified' }), fileReply: () => null, press: async () => ({ ok: false }), cancel: () => ({ ok: false }),
    queue: () => ({ entries: [], run: null }), readPage: () => null });
  const srv = http.createServer((q, s) => link.handle(q, s, q.url.split('?')[0]));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const send = (route, body, { type = 'application/json', signType, headers = {}, bodyHash } = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const p = `/hub-link/${route}`;
    const binary = route === 'image';
    const sig = L.signedHeaders(key, p, buf, { extra: binary ? [signType || type, String(buf.length)] : [] });
    if (binary) sig['x-hub-link-body-sha256'] = bodyHash !== undefined ? bodyHash : L.bodyHashOf(buf);
    return new Promise((resolve, reject) => {
      let answered = null;
      const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': type, 'content-length': buf.length, ...sig, ...headers } }, res => {
        let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { } answered = { status: res.statusCode, json }; resolve(answered); });
      });
      rq.on('error', e => (['EPIPE', 'ECONNRESET'].includes(e.code) ? setTimeout(() => resolve(answered || { status: 'reset', json: null }), 200) : reject(e)));
      rq.end(buf);
    });
  };
  return { send, logs, close: () => new Promise(r => srv.close(r)) };
}
const settingsOf = rig => ({ image_folder: path.join(rig.top, 'assets/imgs/hub'), image_url: '/assets/imgs/hub/', top: rig.top, folder: rig.folder });

test('PING says images on or off; with no setting the route is 404 (to a caller that signed)', async () => {
  const off = await linkWith();
  try {
    assert.equal((await off.send('ping', {})).json.images, 'off');
    assert.equal((await off.send('image', FAKE_SCAN, { type: 'image/jpeg' })).status, 404);
  } finally { await off.close(); }
  const rig = makeRig();
  const on = await linkWith({ settings: settingsOf(rig) });
  try { assert.equal((await on.send('ping', {})).json.images, 'on'); } finally { await on.close(); rig.done(); }
});

test('IMAGE route: a signed JPEG is filtered and saved, and its address answered; the rest is refused', async () => {
  const rig = makeRig();
  const k = await linkWith({ settings: settingsOf(rig) });
  try {
    const dirty = withSegments(FAKE_SCAN, [exifWithGps(), segment(0xfe, Buffer.from('c'))], Buffer.from('TAIL'));
    const r = await k.send('image', dirty, { type: 'image/jpeg' });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.match(r.json.path, /^\/assets\/imgs\/hub\/[0-9a-f]{64}\.jpg$/);
    const file = path.join(rig.top, r.json.path);
    assert.deepEqual(I.metadataOf(fs.readFileSync(file)), []);
    assert.equal(path.basename(file), `${sha(fs.readFileSync(file))}.jpg`);
    assert.ok(!k.logs.join('\n').includes('LATITUDE'));
    // not a JPEG: the right type and the wrong bytes; the wrong type; a type that was not the one signed; bytes that were not the ones signed
    assert.deepEqual([(await k.send('image', png(8, 8), { type: 'image/jpeg' })).status, (await k.send('image', png(8, 8), { type: 'image/jpeg' })).json.error], [415, 'not-image']);
    assert.equal((await k.send('image', FAKE_SCAN, { type: 'image/png' })).status, 415);
    assert.equal((await k.send('image', FAKE_SCAN, { type: 'image/jpeg', signType: 'image/png' })).status, 401);
    assert.equal((await k.send('image', FAKE_SCAN, { type: 'image/jpeg', bodyHash: sha('other') })).status, 401);
    assert.equal((await k.send('image', FAKE_SCAN, { type: 'image/jpeg', headers: { 'x-hub-link-sig': 'a'.repeat(64) } })).status, 401);
    assert.equal((await k.send('image', FAKE_SCAN, { type: 'image/jpeg', headers: { origin: 'https://x.example' } })).status, 403);
    // a JPEG that is damaged past its first bytes
    assert.equal((await k.send('image', FAKE_SCAN.subarray(0, 30), { type: 'image/jpeg' })).status, 415);
    // over the size
    const big = Buffer.concat([FAKE_SCAN.subarray(0, FAKE_SCAN.length - 2), Buffer.alloc(I.IMAGE_LIMITS.bytes + 10), Buffer.from([0xff, 0xd9])]);
    const over = await k.send('image', big, { type: 'image/jpeg' });
    assert.equal(over.status, 413);
    assert.match(over.json.say, /too large/);
    assert.equal(fs.readdirSync(path.join(rig.top, 'assets/imgs/hub')).length, 1, 'only the one good picture was saved');
  } finally { await k.close(); rig.done(); }
});

test('IMAGE route: at most 40 pictures an hour', async () => {
  const rig = makeRig();
  const k = await linkWith({ settings: settingsOf(rig) });
  try {
    for (let i = 0; i < I.IMAGE_LIMITS.perHour; i++) {
      const b = Buffer.concat([FAKE_SCAN.subarray(0, FAKE_SCAN.length - 2), Buffer.from(String(i)), Buffer.from([0xff, 0xd9])]);
      assert.equal((await k.send('image', b, { type: 'image/jpeg' })).status, 200, `picture ${i}`);
    }
    const r = await k.send('image', Buffer.concat([FAKE_SCAN.subarray(0, FAKE_SCAN.length - 2), Buffer.from('x'), Buffer.from([0xff, 0xd9])]), { type: 'image/jpeg' });
    assert.deepEqual([r.status, r.json.limit], [429, 'images-per-hour']);
  } finally { await k.close(); rig.done(); }
});

// ---- the picture line in the owner's words ---------------------------------------------------------------------------------------
const HASH = 'a'.repeat(64);
const line = c => `![${c}](/assets/imgs/hub/${HASH}.jpg)`;
test('the note text: a Hub picture line stands as typed on its own line; every other image is still refused', () => {
  const msg = text => ({ text, ts: '2026-11-27T10:00:00Z' });
  const opts = { imageUrl: '/assets/imgs/hub/' };
  const r = ownText(msg(`Before.\n\n${line('The bay &amp; (a) &lt;b&gt; &quot;q&quot;')}\n\nAfter.`), opts);
  assert.deepEqual(r.blocked, []);
  assert.equal(r.text, `Before.\n\n${line('The bay &amp; (a) &lt;b&gt; &quot;q&quot;')}\n\nAfter.`);
  assert.equal(ownText(msg(`Before.\n${line('')}\nAfter.`), opts).text, `Before.\n\n${line('')}\n\nAfter.`, 'blank lines are made around it');
  assert.equal(ownText(msg(line('')), opts).text, line(''), 'the first line of the post may be a picture');
  // without the setting, or from another folder, or a remote picture, or in the middle of a line: refused as before
  assert.match(ownText(msg(line('x'))).blocked.join(), /images are not supported/);
  assert.match(ownText(msg(`![x](/assets/imgs/other/${HASH}.jpg)`), opts).blocked.join(), /images are not supported/);
  assert.match(ownText(msg('![x](https://elsewhere.example/a.jpg)'), opts).blocked.join(), /images are not supported/);
  assert.match(ownText(msg(`Words ${line('x')} more`), opts).blocked.join(), /images are not supported/);
  assert.match(ownText(msg(`![x](/assets/imgs/hub/${'b'.repeat(63)}.jpg)`), opts).blocked.join(), /images are not supported/);
  assert.match(ownText(msg(`![x](/assets/imgs/hub/../../secret/${HASH}.jpg)`), opts).blocked.join(), /images are not supported/);
  // in code it is code
  assert.deepEqual(ownText(msg('```\n' + line('x') + '\n```'), opts).blocked, []);
});

test('the caption: the owner\'s plain words; characters markdown, HTML or Liquid read are refused unless written as the Hub writes them', () => {
  assert.equal(imageCaptionProblem('A day at the bay, with Tom &amp; Jerry (1998), it\'s the owner’s'), '');
  assert.equal(imageCaptionProblem(''), '');
  assert.equal(imageCaptionProblem('x'.repeat(300)), '');
  assert.match(imageCaptionProblem('x'.repeat(301)), /longer than 300/);
  for (const bad of ['a [b](https://evil.example)', 'say "hi"', '<script>alert(1)</script>', 'a | b', '{{ 7 * 7 }}', '{% include x %}', '`code`', 'a & b', 'back\\slash', 'line\nbreak', '&#x3c;script', '&nbsp;'])
    assert.notEqual(imageCaptionProblem(bad), '', JSON.stringify(bad));
  const hostile = ownText({ text: line('<img src=x onerror=alert(1)>'), ts: 't' }, { imageUrl: '/assets/imgs/hub/' });
  assert.equal(hostile.text, '');
  assert.match(hostile.blocked.join(), /image caption may not hold/);
});
