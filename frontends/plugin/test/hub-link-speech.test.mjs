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
const TOOLS = { tools: { whisper: '/x/whisper-cli', ffmpeg: '/x/ffmpeg', model: '/x/model.bin', home: '/x', sandboxExec: '/usr/bin/sandbox-exec', profile: '/x/p.sb' }, missing: '' };

// a stand-in run: ffmpeg writes a WAV of `seconds`, whisper answers `text`; counts how many run at once
function stubRun({ text = 'Hello from the phone.', seconds = 3, slowMs = 0, fail = '' } = {}) {
  const seen = { live: 0, most: 0, argv: [], works: [] };
  const run = async ({ bin, args, work }) => {
    seen.live++; seen.most = Math.max(seen.most, seen.live); seen.argv.push([bin, ...args]); seen.works.push(work);
    try {
      if (slowMs) await new Promise(r => setTimeout(r, slowMs));
      if (bin.endsWith('ffmpeg')) {
        if (fail === 'convert') return { code: 1, out: '', timedOut: false };
        fs.writeFileSync(args[args.length - 1], Buffer.alloc(44 + 32000 * seconds));
        return { code: 0, out: '', timedOut: false };
      }
      if (fail === 'timeout') return { code: -1, out: '', timedOut: true };
      return { code: 0, out: `${text}\n[BLANK_AUDIO]\n`, timedOut: false };
    } finally { seen.live--; }
  };
  return { run, seen };
}

async function linkWith({ speech, find = () => TOOLS } = {}) {
  const dir = tmp();
  const key = L.newKey({ hub_origin: 'https://blog.example.com', publish: 'drafts-only' });
  L.writeLinkKey(dir, key);
  const logs = [];
  const link = L.createHubLink({ keyDir: dir, repliesFile: path.join(dir, L.HUB_LINK_REPLIES_FILE), log: l => logs.push(l), perMinute: 10000,
    bind: async () => ({ verdict: 'unverified', code: 'not-verified' }), fileReply: () => null, press: async () => ({ ok: false }), cancel: () => ({ ok: false }),
    queue: () => ({ entries: [], run: null }), readPage: () => null, speech: speech || S.createSpeech({ find, run: stubRun().run, log: l => logs.push(l) }) });
  const srv = http.createServer((q, s) => link.handle(q, s, q.url.split('?')[0]));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const send = async (route, body, { type = 'application/json', signType, signBody, headers = {} } = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const p = `/hub-link/${route}`;
    const extra = type.startsWith('audio/') || signType ? [signType || type, String((signBody || buf).length)] : [];
    const sig = L.signedHeaders(key, p, signBody || buf, { extra });
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
  return { send, logs, dir, close: () => new Promise(r => srv.close(r)) };
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
  for (const [opts, why] of [[{ fail: 'convert' }, 'unreadable-audio'], [{ fail: 'timeout' }, 'timed-out'], [{ text: '[BLANK_AUDIO]' }, 'no-speech']]) {
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
  const out = await S.runJailed({ tools, bin: tools.ffmpeg, work, timeoutMs: 20000, args: ['-nostdin', '-loglevel', 'error', '-i', clip, '-f', 'wav', '-y', path.join(work, 'x.wav')] });
  assert.notEqual(out.code, 0, 'a file outside the job folder cannot be read');
  const net = await S.runJailed({ tools, bin: tools.ffmpeg, work, timeoutMs: 20000, args: ['-nostdin', '-loglevel', 'error', '-i', 'http://example.com/a.webm', '-f', 'wav', '-y', path.join(work, 'y.wav')] });
  assert.notEqual(net.code, 0, 'no network');
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(clipDir, { recursive: true, force: true });
});
