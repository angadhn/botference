// hub-link-speech.test.mjs — speech over the hub link: `transcribe` (signed audio, its type and length in the signed string, an
// allow-list and the container's first bytes, a hard cap), `transcript {job}` (pending, done, failed), the jobs (one at a time, at most
// 3 open, 20 an hour, forgotten after 10 minutes), `ping` saying whether speech is on. The routes run in this process; ffmpeg and
// whisper are stand-ins here, except in the last test, which runs the real tools in the real sandbox when they are on this machine
// (with whisper.cpp's own tiny test model, never a model API).
//
//   node --test test/hub-link-speech.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as L from '../hub-link.mjs';
import * as S from '../hub-speech.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubspeech-'));
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), crypto.randomBytes(2000)]);
const OGG = Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(2000)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), crypto.randomBytes(2000)]);
const TOOLS = { tools: { whisper: '/x/whisper-cli', ffmpeg: '/x/ffmpeg', model: '/x/model.bin', sandboxExec: '/usr/bin/sandbox-exec', gpu: true }, missing: '' };

// a stand-in run: ffmpeg writes a WAV of `seconds`, whisper answers `text`; counts how many run at once
function stubRun({ text = 'Hello from the phone.', seconds = 3, slowMs = 0, fail = '' } = {}) {
  const seen = { live: 0, most: 0, argv: [], works: [] };
  const run = async ({ tools, tool, bin = tools[tool], args, work }) => {
    seen.live++; seen.most = Math.max(seen.most, seen.live); seen.argv.push([bin, ...args]); seen.works.push(work);
    try {
      if (slowMs) await new Promise(r => setTimeout(r, slowMs));
      if (bin.endsWith('ffmpeg')) {
        if (fail === 'convert') return { code: 1, out: '', timedOut: false, group: 'gone' };
        fs.writeFileSync(args[args.length - 1], Buffer.alloc(44 + 32000 * seconds));
        return { code: 0, out: '', timedOut: false, group: 'gone' };
      }
      if (fail === 'timeout') return { code: -1, out: '', timedOut: true, group: 'gone' };
      if (fail === 'group') return { code: 0, out: 'words', timedOut: false, group: 'remains' };
      return { code: 0, out: `${text}\n[BLANK_AUDIO]\n`, timedOut: false, group: 'gone' };
    } finally { seen.live--; }
  };
  return { run, seen };
}

async function linkWith({ speech, find = () => TOOLS, audioReadMs } = {}) {
  const dir = tmp();
  const key = L.newKey({ hub_origin: 'https://blog.example.com', publish: 'drafts-only' });
  L.writeLinkKey(dir, key);
  const logs = [];
  const link = L.createHubLink({ keyDir: dir, repliesFile: path.join(dir, L.HUB_LINK_REPLIES_FILE), log: l => logs.push(l), perMinute: 10000,
    bind: async () => ({ verdict: 'unverified', code: 'not-verified' }), fileReply: () => null, press: async () => ({ ok: false }), cancel: () => ({ ok: false }),
    queue: () => ({ entries: [], run: null }), readPage: () => null, speech: speech || S.createSpeech({ find, run: stubRun().run, log: l => logs.push(l) }), ...(audioReadMs ? { audioReadMs } : {}) });
  const srv = http.createServer((q, s) => link.handle(q, s, q.url.split('?')[0]));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const send = async (route, body, { type = 'application/json', signType, signBody, headers = {}, bodyHash } = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const p = `/hub-link/${route}`;
    const extra = type.startsWith('audio/') || signType ? [signType || type, String((signBody || buf).length)] : [];
    const sig = L.signedHeaders(key, p, signBody || buf, { extra });
    // (audio: the body's sha256 in a header too, so the signature is checked before the body is read)
    if (extra.length) sig['x-hub-link-body-sha256'] = bodyHash !== undefined ? bodyHash : L.bodyHashOf(signBody || buf);
    if (sig['x-hub-link-body-sha256'] === '') delete sig['x-hub-link-body-sha256'];
    // (http.request, not fetch: a 413 answered before the whole body was read is still read here)
    return new Promise((resolve, reject) => {
      let answered = null;
      const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': type, 'content-length': buf.length, ...sig, ...headers } }, res => {
        let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { } answered = { status: res.statusCode, json }; resolve(answered); });
      });
      rq.on('error', e => (['EPIPE', 'ECONNRESET'].includes(e.code) ? setTimeout(() => resolve(answered || { status: 'reset', json: null }), 200) : reject(e)));
      rq.end(buf);
    });
  };
  // a request whose body is sent slowly (or never finished): headers of the right form, the right key id and a fresh time, a wrong
  // signature; `release()` ends it
  const slow = ({ type = 'audio/webm', bytes = 1000, headers = {} } = {}) => {
    const k = L.readLinkKey(dir).key;
    const rq = http.request({ host: '127.0.0.1', port, path: '/hub-link/transcribe', method: 'POST', headers: { 'content-type': type, 'content-length': bytes,
      'x-hub-link-key': k.key_id, 'x-hub-link-ts': String(Math.floor(Date.now() / 1000)), 'x-hub-link-nonce': crypto.randomBytes(16).toString('hex'), 'x-hub-link-sig': 'ab'.repeat(32), ...headers } });
    const answered = new Promise(resolve => { rq.on('response', res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); rq.on('error', () => resolve({ status: 'reset' })); });
    rq.write(WEBM.subarray(0, 100));
    return { answered, release: () => { try { rq.end(Buffer.alloc(bytes - 100)); } catch { } } };
  };
  // the same slow request, but signed by a key holder (over the body it will send, and its hash in the header)
  const slowSigned = (k, bytes = 1000) => {
    const body = Buffer.concat([WEBM.subarray(0, 100), Buffer.alloc(bytes - 100)]);
    const sig = L.signedHeaders(k, '/hub-link/transcribe', body, { extra: ['audio/webm', String(bytes)] });
    const rq = http.request({ host: '127.0.0.1', port, path: '/hub-link/transcribe', method: 'POST', headers: { 'content-type': 'audio/webm', 'content-length': bytes, ...sig, 'x-hub-link-body-sha256': L.bodyHashOf(body) } });
    const answered = new Promise(resolve => { rq.on('response', res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); rq.on('error', () => resolve({ status: 'reset' })); });
    rq.write(body.subarray(0, 100));
    return { answered, release: () => { try { rq.end(body.subarray(100)); } catch { } } };
  };
  return { send, slow, slowSigned, logs, dir, close: () => new Promise(r => srv.close(r)) };
}

test('the audio is checked by its type AND its first bytes; the allow-list is three containers', () => {
  assert.deepEqual(S.AUDIO_TYPES, { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4' });
  assert.equal(S.audioTypeOf('audio/webm;codecs=opus'), 'webm');
  assert.equal(S.audioTypeOf('audio/mp4'), 'mp4');
  for (const bad of ['audio/wav', 'text/plain', 'application/json', 'audio/webm\nx', '', 'video/webm']) assert.equal(S.audioTypeOf(bad), '', bad);
  assert.deepEqual([S.sniffAudio(WEBM), S.sniffAudio(OGG), S.sniffAudio(MP4), S.sniffAudio(crypto.randomBytes(100)), S.sniffAudio(Buffer.from('#!/bin/sh\necho hi'))], ['webm', 'ogg', 'mp4', '', '']);
});

test('job states: one list, one move function that refuses an illegal move', () => {
  assert.deepEqual(S.JOB_STATES, ['queued', 'converting', 'transcribing', 'done', 'failed']);
  const j = { state: 'queued' };
  S.moveJob(j, 'converting'); S.moveJob(j, 'transcribing'); S.moveJob(j, 'done', { text: 't' });
  assert.throws(() => S.moveJob(j, 'failed'), S.IllegalJobMove);
  assert.throws(() => S.moveJob({ state: 'queued' }, 'done'), S.IllegalJobMove);
});

test('PING says whether speech is on; with a tool missing every speech route is 404', async () => {
  const on = await linkWith();
  try { assert.equal((await on.send('ping', {})).json.speech, 'on'); } finally { await on.close(); }
  const off = await linkWith({ find: () => ({ tools: null, missing: 'ffmpeg (brew install ffmpeg)' }) });
  try {
    assert.equal((await off.send('ping', {})).json.speech, 'off');
    assert.equal((await off.send('transcribe', WEBM, { type: 'audio/webm' })).status, 404);
    assert.equal((await off.send('transcript', { job: 'a'.repeat(24) })).status, 404);
  } finally { await off.close(); }
});

test('TRANSCRIBE answers at once with a job; TRANSCRIPT answers pending, then done with the text; nothing of it is logged', async () => {
  const st = stubRun({ slowMs: 100 });
  const sp = S.createSpeech({ find: () => TOOLS, run: st.run });
  const k = await linkWith({ speech: sp });
  try {
    const t = await k.send('transcribe', WEBM, { type: 'audio/webm;codecs=opus' });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.match(t.json.job, /^[0-9a-f]{24}$/);
    assert.equal(t.json.state, 'pending');
    assert.equal((await k.send('transcript', { job: t.json.job })).json.state, 'pending');
    await sp.idle();
    const d = await k.send('transcript', { job: t.json.job });
    assert.deepEqual(d.json, { ok: true, job: t.json.job, state: 'done', text: 'Hello from the phone.', seconds: 3 });
    assert.ok(!k.logs.join('\n').includes('Hello'), 'no transcript in the log');
    // the argv: fixed tools, the demuxer from the sniffed container, nothing from the request but the bytes
    const [ff, wh] = st.seen.argv;
    assert.equal(ff[0], '/x/ffmpeg');
    assert.deepEqual(ff.slice(ff.indexOf('-f'), ff.indexOf('-f') + 2), ['-f', 'matroska']);
    assert.ok(ff.includes('-protocol_whitelist') && ff.includes('file') && ff.includes('-t') && ff.includes('180'));
    assert.deepEqual(wh.slice(0, 1), ['/x/whisper-cli']);
    assert.ok(wh.includes('-l') && wh[wh.indexOf('-l') + 1] === 'en', 'English, no auto-detect');
    assert.ok(!fs.existsSync(st.seen.works[0]), 'the job\'s folder is gone');
    assert.equal((await k.send('transcript', { job: 'f'.repeat(24) })).status, 404);
  } finally { await k.close(); }
});

test('REFUSED: a type off the list, bytes that are not that container, a body over the cap, a type or length not the one signed', async () => {
  const k = await linkWith();
  try {
    assert.equal((await k.send('transcribe', WEBM, { type: 'audio/wav' })).status, 415);
    assert.equal((await k.send('transcribe', OGG, { type: 'audio/webm' })).status, 415, 'the first bytes say Ogg');
    assert.equal((await k.send('transcribe', Buffer.from('#!/bin/sh\nrm -rf ~\n'.repeat(10)), { type: 'audio/mp4' })).status, 415);
    assert.equal((await k.send('transcribe', WEBM, { type: 'application/json' })).status, 415);
    const big = Buffer.concat([WEBM, Buffer.alloc(S.SPEECH_LIMITS.audioBytes)]);
    const b = await k.send('transcribe', big, { type: 'audio/webm' });
    assert.deepEqual([b.status, b.json && b.json.error], [413, 'too-large']);
    assert.equal((await k.send('transcribe', WEBM, { type: 'audio/webm', signType: 'audio/ogg' })).status, 401, 'the type is signed');
    for (const h of ['x-hub-link-sig', 'x-hub-link-nonce']) {
      const r = await k.send('transcribe', WEBM, { type: 'audio/webm', headers: { [h]: '' } });
      assert.equal(r.status, 401, `without ${h}`);
    }
    assert.equal((await k.send('transcribe', WEBM, { type: 'audio/webm', headers: { origin: 'https://blog.example.com' } })).status, 403, 'an Origin');
    assert.equal((await k.send('transcribe', WEBM, { type: 'audio/webm', signBody: WEBM.subarray(0, 100) })).status, 401, 'the bytes are signed');
  } finally { await k.close(); }
});

test('JOBS: one runs at a time; at most 3 open (429 speech-busy); 20 an hour (429 speech-per-hour); forgotten after 10 minutes', async () => {
  let t = 1_800_000_000_000;
  const st = stubRun({ slowMs: 60 });
  const sp = S.createSpeech({ find: () => TOOLS, run: st.run, now: () => t });
  const k = await linkWith({ speech: sp });
  try {
    const first = [];
    for (let i = 0; i < 4; i++) first.push(await k.send('transcribe', WEBM, { type: 'audio/webm' }));
    assert.deepEqual(first.map(r => r.status), [200, 200, 200, 429]);
    assert.equal(first[3].json.limit, 'speech-busy');
    await sp.idle();
    assert.equal(st.seen.most, 1, 'one tool at a time');
    for (let i = 0; i < 17; i++) { assert.equal((await k.send('transcribe', WEBM, { type: 'audio/webm' })).status, 200, `job ${i + 4}`); await sp.idle(); }
    const over = await k.send('transcribe', WEBM, { type: 'audio/webm' });
    assert.deepEqual([over.status, over.json.limit], [429, 'speech-per-hour']);
    t += S.SPEECH_LIMITS.keepMs;
    assert.equal((await k.send('transcript', { job: first[0].json.job })).status, 404, 'forgotten');
    t += 3600 * 1000;
    assert.equal((await k.send('transcribe', WEBM, { type: 'audio/webm' })).status, 200, 'a new hour');
    await sp.idle();
  } finally { await k.close(); }
});

test('FAILED jobs say one code and a fixed sentence: unreadable audio, a run over its time, no speech', async () => {
  for (const [opts, why] of [[{ fail: 'convert' }, 'unreadable-audio'], [{ fail: 'timeout' }, 'timed-out'], [{ text: '[BLANK_AUDIO]' }, 'no-speech'], [{ fail: 'group' }, 'internal']]) {
    const sp = S.createSpeech({ find: () => TOOLS, run: stubRun(opts).run });
    const k = await linkWith({ speech: sp });
    try {
      const j = (await k.send('transcribe', MP4, { type: 'audio/mp4' })).json.job;
      await sp.idle();
      const v = (await k.send('transcript', { job: j })).json;
      assert.deepEqual([v.state, v.why, v.say], ['failed', why, S.SPEECH_FAILURES[why]], why);
    } finally { await k.close(); }
  }
});

// ---- the real tools, in the real sandbox (skipped when they are not on this machine) ----
const TINY = '/opt/homebrew/share/whisper.cpp/for-tests-ggml-tiny.bin';
const JFK = '/opt/homebrew/share/whisper.cpp/jfk.wav';
const real = (() => { try { return S.speechTools({ env: { ...process.env, BOTFERENCE_WHISPER_MODEL: TINY } }).tools && fs.existsSync(JFK); } catch { return false; } })();
test('REAL: ffmpeg and whisper-cli run contained; the folder is gone after; an over-time run is killed with its group', { skip: !real && 'whisper-cli, ffmpeg or the test model is not on this machine' }, async () => {
  // (ONLY THIS TEST'S OWN JOBS are checked: their folders and their processes, by the folders' exact paths. Another speech job on the
  // machine, from another companion or another test run at the same time, is none of this test's business: a machine-wide count or
  // a grep for any `bfspeech-` made this test fail whenever one was running.)
  const works = [];
  const run = opts => { works.push(opts.work); return S.runJailed(opts); };
  const clipDir = tmp();
  const clip = path.join(clipDir, 'c.webm');
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', JFK, '-c:a', 'libopus', '-b:a', '32k', clip]);
  const find = () => S.speechTools({ env: { ...process.env, BOTFERENCE_WHISPER_MODEL: TINY } });
  const sp = S.createSpeech({ find, run });
  const r = sp.submit({ audio: fs.readFileSync(clip), container: 'webm' });
  await sp.idle();
  const v = sp.view(r.job);
  assert.ok(v.state === 'done' || (v.state === 'failed' && v.why === 'no-speech'), JSON.stringify(v));   // (the test model's words are not the point)
  if (v.state === 'done') assert.ok(v.seconds > 10 && v.seconds < 12, 'the 11 s clip, read by ffmpeg in the sandbox');
  // a run over its time: killed, the job failed, nothing left running, the folder gone
  const slow = S.createSpeech({ find, run, limits: { transcribeMs: 1 } });
  const s = slow.submit({ audio: fs.readFileSync(clip), container: 'webm' });
  await slow.idle();
  assert.equal(slow.view(s.job).why, 'timed-out');
  let ps = '';
  try { ps = execFileSync('/bin/ps', ['-Ao', 'command'], { encoding: 'utf8' }); } catch { ps = ''; }
  assert.ok(works.length >= 3, 'the tools ran');
  for (const w of new Set(works)) {
    assert.ok(!ps.includes(w), 'no tool of this test\'s jobs left running');
    assert.equal(fs.existsSync(w), false, 'every job folder of this test deleted');
  }
  // the sandbox itself: the contained ffmpeg cannot read a file outside its folder
  const tools = find().tools;
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubspeech-jail-')));
  const out = await S.runJailed({ tools, tool: 'ffmpeg', work, timeoutMs: 20000, args: ['-nostdin', '-loglevel', 'error', '-i', clip, '-f', 'wav', '-y', path.join(work, 'x.wav')] });
  assert.notEqual(out.code, 0, 'a file outside the job folder cannot be read');
  const net = await S.runJailed({ tools, tool: 'ffmpeg', work, timeoutMs: 20000, args: ['-nostdin', '-loglevel', 'error', '-i', 'http://example.com/a.webm', '-f', 'wav', '-y', path.join(work, 'y.wav')] });
  assert.notEqual(net.code, 0, 'no network');
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(clipDir, { recursive: true, force: true });
});

// ---- the profiles themselves, under the real sandbox (macOS only; skipped elsewhere) ----
import net from 'node:net';
import { spawn } from 'node:child_process';
const mac = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
const fakeTools = () => ({ whisper: '/usr/bin/true', ffmpeg: '/usr/bin/true', model: '/usr/bin/true', sandboxExec: '/usr/bin/sandbox-exec', kegs: { ffmpeg: [], whisper: [] }, links: { ffmpeg: [], whisper: [] } });

test('PROFILES: deny by default; each tool reads only system files, its Homebrew keg, its job folder (and the model); writes only the job folder', () => {
  for (const tool of ['ffmpeg', 'whisper']) {
    const p = S.speechProfile(tool, { gpu: true });
    assert.match(p, /^\(version 1\)\n/);
    assert.match(p, /\(deny default\)/);
    assert.ok(!/\(allow default\)/.test(p));
    assert.ok(!/network/.test(p.replace(/;.*$/gm, '')), 'no network rule at all (denied by default)');
    assert.ok(!/process-fork/.test(p.replace(/;.*$/gm, '')), 'no fork');
    assert.match(p, /\(allow process-exec \(literal \(param "BIN"\)\)\)/);
    assert.match(p, /\(allow signal \(target self\)\)/);
    assert.match(p, /\(allow file-write\* \(subpath \(param "WORK"\)\)/);
  }
  assert.ok(!/mach-lookup|iokit/.test(S.speechProfile('ffmpeg', { gpu: true }).replace(/;.*$/gm, '')), 'ffmpeg: no services, no devices');
  assert.ok(!/mach-lookup|iokit/.test(S.speechProfile('whisper', { gpu: false }).replace(/;.*$/gm, '')), 'whisper on the CPU: none either');
  const g = S.speechProfile('whisper', { gpu: true }).replace(/;.*$/gm, '');
  assert.deepEqual(g.match(/global-name "[^"]+"/g), ['global-name "com.apple.MTLCompilerService"'], 'one service: Metal\'s shader compiler');
  assert.deepEqual(g.match(/iokit-user-client-class "[^"]+"/g), ['iokit-user-client-class "AGXDeviceUserClient"'], 'one device class: the GPU');
});

test('REFUSED UNDER THE REAL PROFILES: the clipboard, preferences, another process, /etc, a file outside the job folder, the network, fork, exec', { skip: !mac && 'macOS only' }, async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubspeech-probe-')));
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubspeech-scratch-')));
  fs.writeFileSync(path.join(scratch, 'outside.txt'), 'outside the job folder');
  fs.writeFileSync(path.join(work, 'inside.txt'), 'inside');
  const victim = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  let connected = 0;
  const server = net.createServer(c => { connected++; c.destroy(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tools = fakeTools();
  try {
    for (const tool of ['ffmpeg', 'whisper']) {
      const run = (bin, args) => S.runJailed({ tools, tool, bin, args, work, timeoutMs: 10000 });
      // (pbpaste: its exit status only; the clipboard is never printed or changed)
      assert.notEqual((await run('/usr/bin/pbpaste', [])).code, 0, `${tool}: the clipboard`);
      const prefs = await run('/usr/bin/defaults', ['read', 'com.apple.finder']);
      assert.ok(prefs.code !== 0 || prefs.out.replace(/\s/g, '') === '{}', `${tool}: preferences read as nothing`);
      assert.notEqual((await run('/bin/kill', ['-0', String(victim.pid)])).code, 0, `${tool}: another process`);
      assert.notEqual((await run('/bin/cat', ['/etc/hosts'])).code, 0, `${tool}: /etc`);
      assert.notEqual((await run('/bin/cat', [path.join(scratch, 'outside.txt')])).code, 0, `${tool}: outside the job folder`);
      assert.notEqual((await run('/usr/bin/nc', ['-z', '-G', '2', '127.0.0.1', String(port)])).code, 0, `${tool}: localhost`);
      const forked = await run('/bin/sh', ['-c', '/bin/echo forked']);
      assert.ok(!forked.out.includes('forked'), `${tool}: fork`);
      assert.notEqual((await run('/usr/bin/env', ['/bin/sh', '-c', 'true'])).code, 0, `${tool}: exec of another program`);
      const inside = await run('/bin/cat', [path.join(work, 'inside.txt')]);
      assert.deepEqual([inside.code, inside.out], [0, 'inside'], `${tool}: its own folder is readable (the profile is not simply broken)`);
    }
    assert.equal(connected, 0, 'nothing reached the listener');
    assert.equal(victim.exitCode, null, 'the other process is alive');
  } finally {
    victim.kill(); server.close();
    fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('THE GROUP IS KILLED ON EVERY PATH: a child left behind by a normal exit is gone, and the answer says the group is gone', { skip: !mac && 'macOS only' }, async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubspeech-group-')));
  // (a permissive profile for this one test only: the real ones refuse fork, so a leftover child cannot be made under them)
  const r = await S.runJailed({ tools: fakeTools(), tool: 'ffmpeg', bin: '/bin/sh', args: ['-c', `/bin/sleep 30 >/dev/null 2>&1 & echo $! > ${path.join(work, 'pid')}; exit 0`], work,
    timeoutMs: 10000, profileText: '(version 1)\n(allow default)\n' });
  assert.deepEqual([r.code, r.timedOut, r.group], [0, false, 'gone']);
  const pid = Number(fs.readFileSync(path.join(work, 'pid'), 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the child left behind is gone');
  fs.rmSync(work, { recursive: true, force: true });
});

test('CPU TIME IS LIMITED besides the wall clock (macOS enforces RLIMIT_CPU): a spinning tool is stopped by its CPU limit', { skip: !mac && 'macOS only' }, async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubspeech-cpu-')));
  const t0 = Date.now();
  const r = await S.runJailed({ tools: fakeTools(), tool: 'ffmpeg', bin: '/usr/bin/yes', args: [], work, timeoutMs: 30000, limits: { cpuSec: 1 } });
  assert.notEqual(r.code, 0);
  assert.equal(r.timedOut, false, 'not the wall clock');
  assert.equal(r.signal, 'SIGXCPU', 'the CPU limit');
  assert.ok(Date.now() - t0 < 15000, `stopped in ${Date.now() - t0} ms`);
  fs.rmSync(work, { recursive: true, force: true });
});

test('BEFORE ANY BYTE IS READ: an unsigned caller is 401 whether speech is on or off; a stale time or another key is 401 at once', async () => {
  for (const find of [() => TOOLS, () => ({ tools: null, missing: 'ffmpeg' })]) {
    const k = await linkWith({ find });
    try {
      const unsigned = await k.send('transcribe', WEBM, { type: 'audio/webm', headers: { 'x-hub-link-sig': '', 'x-hub-link-key': '', 'x-hub-link-ts': '', 'x-hub-link-nonce': '' } });
      assert.equal(unsigned.status, 401, 'unsigned audio');
      const t = await k.send('transcript', { job: 'a'.repeat(24) }, { headers: { 'x-hub-link-sig': '' } });
      assert.equal(t.status, 401, 'unsigned transcript');
    } finally { await k.close(); }
  }
  const off = await linkWith({ find: () => ({ tools: null, missing: 'ffmpeg' }) });
  try { assert.equal((await off.send('transcribe', WEBM, { type: 'audio/webm' })).status, 404, 'signed, speech off: 404'); } finally { await off.close(); }
  const k = await linkWith();
  try {
    // (answered before the body: these requests never send the rest of it, and are answered all the same)
    for (const headers of [{ 'x-hub-link-ts': '1' }, { 'x-hub-link-key': 'ffffffff' }, { 'x-hub-link-nonce': 'short' }, { 'x-hub-link-sig': 'zz' }]) {
      const r = k.slow({ headers });
      assert.equal((await r.answered).status, 401, JSON.stringify(headers));
      r.release();
    }
  } finally { await k.close(); }
});


// ---- review 3: the tool's place, and slots only for a key holder ----
test('A TOOL OUTSIDE A HOMEBREW CELLAR turns speech off, with a sentence; no fallback to its folder', () => {
  for (const env of [{ BOTFERENCE_FFMPEG_BIN: '/bin/cat' }, { BOTFERENCE_WHISPER_BIN: '/bin/cat' }]) {
    const f = S.speechTools({ env: { ...process.env, ...env } });
    assert.equal(f.tools, null, JSON.stringify(env));
    assert.match(f.missing, /not a Homebrew install/);
  }
  assert.deepEqual(S.homebrewPlace('/opt/homebrew/Cellar/ffmpeg/9.0.2_1/bin/ffmpeg'), { prefix: '/opt/homebrew', formula: 'ffmpeg', keg: '/opt/homebrew/Cellar/ffmpeg/9.0.2_1' });
  for (const bad of ['/Users/someone/bin/ffmpeg', '/bin/cat', '/opt/homebrew/bin/ffmpeg', '/tmp/Cellar/ffmpeg/1/bin/ffmpeg', '/opt/homebrew/Cellar/ffmpeg/bin', '/opt/homebrew/Cellar/f"x/1/bin/ffmpeg'])
    assert.equal(S.homebrewPlace(bad), null, bad);
});

const realFound = (() => { try { return S.speechTools(); } catch { return { tools: null }; } })();
test('THE READ ALLOWANCE is the tool\'s own formula and the formulas it links against, nothing more; under every accepted profile ~, /etc/hosts and a scratch file stay refused',
  { skip: !(mac && realFound.tools) && 'the tools are not on this machine' }, async () => {
    const t = realFound.tools;
    for (const tool of ['ffmpeg', 'whisper']) {
      assert.ok(t.kegs[tool].length >= 1 && t.kegs[tool].every(k => /^\/(opt\/homebrew|usr\/local)\/Cellar\/[^/]+\/[^/]+$/.test(k)), `${tool}: ${t.kegs[tool]}`);
      for (const gpu of tool === 'whisper' ? [true, false] : [false]) {
        const p = S.speechProfile(tool, { gpu, kegs: t.kegs[tool], links: t.links[tool] });
        assert.ok(!/"\/opt\/homebrew\/Cellar"\)|"\/opt\/homebrew\/opt"\)|"\/usr\/local\/Cellar"\)/.test(p), 'never the whole Cellar or opt');
      }
    }
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubspeech-keg-')));
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubspeech-keg2-')));
    fs.writeFileSync(path.join(scratch, 'x.txt'), 'x');
    try {
      for (const [tool, gpu] of [['ffmpeg', false], ['whisper', true], ['whisper', false]]) {
        const tools = { ...t, gpu };
        const run = (bin, args) => S.runJailed({ tools, tool, bin, args, work, timeoutMs: 10000 });
        assert.notEqual((await run('/bin/cat', [path.join(scratch, 'x.txt')])).code, 0, `${tool}/${gpu}: scratch`);
        assert.notEqual((await run('/bin/ls', [os.homedir()])).code, 0, `${tool}/${gpu}: ~`);
        assert.notEqual((await run('/bin/cat', ['/etc/hosts'])).code, 0, `${tool}/${gpu}: /etc/hosts`);
        assert.notEqual((await run('/bin/ls', ['/opt/homebrew/Cellar'])).code, 0, `${tool}/${gpu}: the whole Cellar`);
      }
      // and the tools themselves still work under it: a real clip (the tiny test model)
      const find = () => S.speechTools({ env: { ...process.env, BOTFERENCE_WHISPER_MODEL: TINY } });
      const sp = S.createSpeech({ find });
      const clip = path.join(scratch, 'c.webm');
      execFileSync('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', JFK, '-c:a', 'libopus', '-b:a', '32k', clip]);
      const r = sp.submit({ audio: fs.readFileSync(clip), container: 'webm' });
      await sp.idle();
      const v = sp.view(r.job);
      assert.ok(v.state === 'done' || v.why === 'no-speech', JSON.stringify(v));
    } finally { fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true }); }
  });

test('A READ SLOT ONLY FOR A KEY HOLDER: the signature (over the body hash the request names) is checked before any byte is read', async () => {
  const k = await linkWith({ audioReadMs: 400 });
  try {
    const key = L.readLinkKey(k.dir).key;
    // a caller with the key id but not the secret: refused at once, before its body, and takes no slot
    const forged = [k.slow(), k.slow(), k.slow()];
    for (const f of forged) { assert.equal((await f.answered).status, 401); f.release(); }
    // with the secret: two slow bodies hold the two slots; a third key holder waits (429)
    const good = () => k.slowSigned(key);
    const a = good(), b = good();
    await new Promise(r => setTimeout(r, 100));
    const c = good();
    assert.equal((await c.answered).status, 429);
    const [ra, rb] = await Promise.all([a.answered, b.answered]);
    assert.deepEqual([ra.status, rb.status], [408, 408]);
    // the body must be the one whose hash was signed
    assert.equal((await k.send('transcribe', WEBM, { type: 'audio/webm', bodyHash: crypto.createHash('sha256').update(OGG).digest('hex') })).status, 401);
    assert.equal((await k.send('transcribe', WEBM, { type: 'audio/webm', bodyHash: '' })).status, 401, 'no body hash header');
    assert.equal((await k.send('transcribe', WEBM, { type: 'audio/webm' })).status, 200);
  } finally { await k.close(); }
});
