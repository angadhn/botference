// hub-speech.mjs — SPEECH FOR THE HUB LINK: the owner speaks into the Hub's reply box on a phone, the Hub's function passes the
// recording over the signed link (`/hub-link/transcribe`), and this companion turns it into text with whisper.cpp on the computer.
// The text goes back to the Hub (`/hub-link/transcript`) for the owner to edit in the reply box. Nothing is filed or published here.
//
// A JOB, because a transcription may take longer than the Hub's 8 s request: `transcribe` answers at once with a job id; `transcript`
// answers pending, done or failed. Jobs live in memory only, are capped (SPEECH_LIMITS), and one Whisper runs at a time.
//
// A JOB'S STATE, one field (`job.state`), moved only by moveJob, which refuses a move JOB_MOVES does not list:
//   queued        accepted; waiting for the one runner
//   converting    ffmpeg is turning the recording into 16 kHz mono WAV
//   transcribing  whisper-cli is reading the WAV
//   done          `text` is the transcript (kept SPEECH_LIMITS.keepMs, then the job is forgotten)
//   failed        `why` is one code of SPEECH_FAILURES (kept the same time)
//
// CONTAINED. ffmpeg and whisper-cli parse bytes from the network, so each runs under sandbox-exec with hub-speech.sb: no network, no
// file read but the model and the job's own folder, no write but that folder, no other program. Spawned with an argument array (never
// a shell), from fixed absolute paths, in its own process group (a run over its time is killed with the whole group), with a minimal
// environment. The job's folder is fresh (mkdtemp, random), private (0700), the audio file has a fixed name, and the folder is deleted
// in a `finally`. No path, name or option comes from the request. Where the sandbox cannot be made (not macOS), speech is off.
//
// PRIVATE. The audio and the transcript are never logged, never written outside the job's folder, never put on a page record. The log
// says a job id's first 6 characters, a state and a failure code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelPath, cleanTranscript } from '../shared/transcribe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SPEECH_PROFILE = path.join(HERE, 'hub-speech.sb');
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export const SPEECH_LIMITS = Object.freeze({
  // three minutes of speech as browsers record it (Opus about 32–128 kbit/s, AAC about 64–160 kbit/s): 4.5 MiB, well under the 6 MB a
  // synchronous Netlify function can be sent
  audioBytes: 4.5 * 1024 * 1024,
  maxSeconds: 180,            // ffmpeg keeps at most this much of a recording (-t)
  open: 3,                    // jobs not yet done or failed
  perHour: 20,                // jobs accepted in an hour
  keepMs: 10 * 60 * 1000,     // a finished job's answer is kept this long, then forgotten
  convertMs: 30 * 1000,       // ffmpeg's time limit
  transcribeMs: 120 * 1000,   // whisper's time limit (a 2-minute clip takes about 5 s here)
  outputBytes: 64 * 1024,     // what is read of whisper's output
  textChars: 20000,           // the transcript returned
});
export const SPEECH_LANGUAGE = 'en';
/** The recordings accepted: the content type's base (its parameters, like `;codecs=opus`, are allowed and signed) → the container, which
 *  the first bytes must show too. Chromium and Firefox record WebM (or Ogg) with Opus; Safari on iOS and macOS records MP4 with AAC. */
export const AUDIO_TYPES = Object.freeze({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4' });
const DEMUXER = Object.freeze({ webm: 'matroska', ogg: 'ogg', mp4: 'mov' });
/** The container a content type names, or '' (not on the list, or a malformed header). */
export function audioTypeOf(contentType) {
  const ct = String(contentType || '').trim().toLowerCase();
  if (!ct || ct.length > 100 || !/^[a-z0-9/+.;=, "-]+$/.test(ct)) return '';
  return AUDIO_TYPES[ct.split(';')[0].trim()] || '';
}
/** The container the first bytes show (never the file name, never the header alone): EBML (WebM), OggS, or an ISO `ftyp` box (MP4). */
export function sniffAudio(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  return '';
}

export const JOB_STATES = Object.freeze(['queued', 'converting', 'transcribing', 'done', 'failed']);
export const JOB_MOVES = Object.freeze({
  queued: Object.freeze(['converting', 'failed']),
  converting: Object.freeze(['transcribing', 'failed']),
  transcribing: Object.freeze(['done', 'failed']),
  done: Object.freeze([]),
  failed: Object.freeze([]),
});
export const OPEN_JOB_STATES = Object.freeze(['queued', 'converting', 'transcribing']);
export class IllegalJobMove extends Error {}
export function moveJob(job, to, facts = {}) {
  if (!JOB_STATES.includes(to)) throw new Error(`speech job: no such state ${String(to).slice(0, 20)}`);
  if (!JOB_MOVES[job.state].includes(to)) throw new IllegalJobMove(`speech job: cannot go from ${job.state} to ${to}`);
  Object.assign(job, facts, { state: to });
  return job;
}
/** Why a job failed, one code each, with the sentence the Hub may show as it is. */
export const SPEECH_FAILURES = Object.freeze({
  'unreadable-audio': 'The recording could not be read. Try again.',
  'no-speech': 'No speech was heard in the recording.',
  'timed-out': 'Turning the recording into text took too long. Try a shorter one.',
  'unavailable': 'Speech is not available on your computer now.',
  'internal': 'Something went wrong on your computer. Try again.',
});
/** Whether speech is offered, one value derived from what is on this machine (speechGate): on, or off with a reason. */
export const SPEECH_GATES = Object.freeze(['on', 'off']);

const realOr = p => { try { return fs.realpathSync(p); } catch { return ''; } };
const firstFile = list => { for (const p of list) { if (p && path.isAbsolute(p)) { const r = realOr(p); if (r) { try { if (fs.statSync(r).isFile()) return r; } catch { /* gone */ } } } } return ''; };
/** The tools, as real absolute paths, or null with the reason (what is missing). Read at each use: installing one turns speech on. */
export function speechTools({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'darwin' || !fs.existsSync(SANDBOX_EXEC) || !fs.existsSync(SPEECH_PROFILE)) return { tools: null, missing: 'the macOS sandbox (sandbox-exec)' };
  const whisper = firstFile([env.BOTFERENCE_WHISPER_BIN, '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']);
  if (!whisper) return { tools: null, missing: 'whisper-cli (brew install whisper-cpp)' };
  const ffmpeg = firstFile([env.BOTFERENCE_FFMPEG_BIN, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
  if (!ffmpeg) return { tools: null, missing: 'ffmpeg (brew install ffmpeg)' };
  const model = realOr(modelPath());
  if (!model) return { tools: null, missing: 'a whisper model (~/.botference/models/ggml-large-v3-turbo.bin)' };
  const home = realOr(env.HOME || os.homedir());
  return { tools: { whisper, ffmpeg, model, home, sandboxExec: SANDBOX_EXEC, profile: SPEECH_PROFILE }, missing: '' };
}
export const speechGate = found => (found && found.tools ? 'on' : 'off');

/**
 * Run ONE contained program: sandbox-exec with the profile, then the program's argv. Its own process group; killed with the whole group
 * at `timeoutMs`. → { code, out, timedOut } (stdout, at most SPEECH_LIMITS.outputBytes; stderr is read and thrown away, never logged).
 */
export function runJailed({ tools, bin, args, work, timeoutMs }) {
  return new Promise(resolve => {
    const argv = ['-f', tools.profile, '-D', `HOME=${tools.home}`, '-D', `MODEL=${tools.model}`, '-D', `WORK=${work}`, '-D', `BIN=${bin}`, bin, ...args];
    let child;
    try {
      child = spawn(tools.sandboxExec, argv, { cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: work, TMPDIR: work, LANG: 'C' } });
    } catch { return resolve({ code: -1, out: '', timedOut: false }); }
    let out = Buffer.alloc(0);
    let timedOut = false;
    child.stdout.on('data', c => { if (out.length < SPEECH_LIMITS.outputBytes) out = Buffer.concat([out, c]).subarray(0, SPEECH_LIMITS.outputBytes); });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out: '', timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code === null ? -1 : code, out: out.toString('utf8'), timedOut }); });
  });
}

/**
 * deps: { find() → speechTools()'s answer (tests), run(opts) → runJailed's answer (tests), now() → ms, log(line), limits }
 */
export function createSpeech(deps = {}) {
  const L = { ...SPEECH_LIMITS, ...(deps.limits || {}) };
  const now = () => (deps.now ? deps.now() : Date.now());
  const find = deps.find || (() => speechTools());
  const run = deps.run || runJailed;
  const say = line => { try { (deps.log || (() => {}))(`speech: ${line}`); } catch { /* nowhere */ } };
  const jobs = new Map();
  let accepted = [];             // times jobs were accepted, for the hourly cap
  let runner = Promise.resolve(); // one job at a time, in order

  const forget = id => { jobs.delete(id); };
  function finish(job, to, facts) {
    moveJob(job, to, facts);
    say(`${job.id.slice(0, 6)} ${to}${to === 'failed' ? ` ${job.why}` : ''}`);
    const t = setTimeout(() => forget(job.id), L.keepMs);
    if (t.unref) t.unref();
    job.forget_at = now() + L.keepMs;
  }
  async function work(job, audio) {
    const found = find();
    if (!found.tools) return finish(job, 'failed', { why: 'unavailable' });
    const tools = found.tools;
    let dir = '';
    try {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bfspeech-${crypto.randomBytes(6).toString('hex')}-`)));
      fs.chmodSync(dir, 0o700);
      const input = path.join(dir, 'in.audio'), wav = path.join(dir, 'speech.wav');
      fs.writeFileSync(input, audio, { mode: 0o600 });
      audio = null;
      moveJob(job, 'converting');
      const c = await run({ tools, bin: tools.ffmpeg, work: dir, timeoutMs: L.convertMs,
        args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', DEMUXER[job.container], '-i', input,
          '-vn', '-sn', '-dn', '-t', String(L.maxSeconds), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', wav] });
      if (c.timedOut) return finish(job, 'failed', { why: 'timed-out' });
      let size = 0;
      try { size = fs.statSync(wav).size; } catch { size = 0; }
      if (c.code !== 0 || size <= 44) return finish(job, 'failed', { why: 'unreadable-audio' });
      const seconds = Math.round(((size - 44) / 32000) * 10) / 10;
      moveJob(job, 'transcribing', { seconds });
      const w = await run({ tools, bin: tools.whisper, work: dir, timeoutMs: L.transcribeMs,
        args: ['-m', tools.model, '-f', wav, '-nt', '-np', '-l', SPEECH_LANGUAGE, '-t', '4'] });
      if (w.timedOut) return finish(job, 'failed', { why: 'timed-out' });
      if (w.code !== 0) return finish(job, 'failed', { why: 'internal' });
      const text = cleanTranscript(w.out).slice(0, L.textChars);
      if (!text) return finish(job, 'failed', { why: 'no-speech' });
      return finish(job, 'done', { text });
    } catch {
      if (OPEN_JOB_STATES.includes(job.state)) finish(job, 'failed', { why: 'internal' });
    } finally {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS clears its temp folder */ } }
    }
  }

  return {
    /** → 'on' | 'off' (SPEECH_GATES) */
    gate: () => speechGate(find()),
    missing: () => find().missing,
    /** A recording, already checked for size, type and container by the route. → { ok, job } | { ok: false, status, error, limit? } */
    submit({ audio, container }) {
      if (speechGate(find()) !== 'on') return { ok: false, status: 404, error: 'not found' };
      const t = now();
      accepted = accepted.filter(x => t - x < 3600 * 1000);
      if (accepted.length >= L.perHour) return { ok: false, status: 429, error: 'limit', limit: 'speech-per-hour' };
      if ([...jobs.values()].filter(j => OPEN_JOB_STATES.includes(j.state)).length >= L.open) return { ok: false, status: 429, error: 'limit', limit: 'speech-busy' };
      accepted.push(t);
      const job = { id: crypto.randomBytes(12).toString('hex'), state: 'queued', container, at: t };
      jobs.set(job.id, job);
      say(`${job.id.slice(0, 6)} queued`);
      runner = runner.then(() => work(job, audio)).catch(() => {});
      return { ok: true, job: job.id };
    },
    /** The Hub's view of a job: { job, state: 'pending'|'done'|'failed', text?, seconds?, why?, say? }, or null (unknown or forgotten). */
    view(id) {
      const job = jobs.get(String(id || ''));
      if (!job || (job.forget_at && now() >= job.forget_at)) { if (job) forget(job.id); return null; }
      if (job.state === 'done') return { job: job.id, state: 'done', text: job.text, seconds: job.seconds };
      if (job.state === 'failed') return { job: job.id, state: 'failed', why: job.why, say: SPEECH_FAILURES[job.why] || '' };
      return { job: job.id, state: 'pending' };
    },
    /** (tests) let every accepted job finish */
    idle: () => runner,
  };
}
