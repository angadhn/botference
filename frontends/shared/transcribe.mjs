// Speech to text on this Mac, for the mic button in every composer.
//
// The browser (the phone's, or this Mac's) records a clip and posts it to the
// server already behind the page — the council server or the plugin
// companion — which runs whisper.cpp here and hands the words back. Nothing
// leaves the machine, nothing needs a key, and the phone's own dictation, which
// is the thing this exists to replace, is never involved.
//
//   POST /transcribe  {audio_b64, mime, lang?}  →  {ok, text, seconds, took_ms}
//
// Engine: `whisper-cli` (Homebrew's whisper-cpp) on a 16 kHz mono WAV that
// ffmpeg makes from whatever the browser recorded (webm/opus on Chrome and
// Android, mp4/aac on iPhone). Model: the first that exists of
//   $BOTFERENCE_WHISPER_MODEL,
//   ~/.botference/models/ggml-large-v3-turbo.bin   (fetched on 2026-09-26),
//   Superwhisper's own ggml-small.en.bin           (already on this Mac).
// Overridable for tests and odd installs: BOTFERENCE_WHISPER_BIN, _MODEL,
// BOTFERENCE_FFMPEG_BIN.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const MODEL_CANDIDATES = [
  process.env.BOTFERENCE_WHISPER_MODEL || '',
  path.join(HOME, '.botference', 'models', 'ggml-large-v3-turbo.bin'),
  path.join(HOME, 'Library', 'Application Support', 'superwhisper', 'ggml-small.en.bin'),
].filter(Boolean);

const WHISPER_BIN = process.env.BOTFERENCE_WHISPER_BIN || 'whisper-cli';
const FFMPEG_BIN = process.env.BOTFERENCE_FFMPEG_BIN || 'ffmpeg';
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;   // ~15 minutes of phone audio
const RUN_TIMEOUT_MS = 180_000;

const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4', 'video/webm': 'webm' };

/** The model file the engine will use, or '' when none is on disk. */
export function modelPath() {
  for (const p of MODEL_CANDIDATES) { try { if (fs.statSync(p).isFile()) return p; } catch { } }
  return '';
}

/** Is transcription possible on this machine? {ok, model, reason} — the
 *  answer the mic button reads before it shows itself. */
export function whisperStatus() {
  const model = modelPath();
  if (!model) return { ok: false, model: '', reason: 'no whisper model on this machine (~/.botference/models/ggml-large-v3-turbo.bin)' };
  return { ok: true, model, bin: WHISPER_BIN };
}

function run(cmd, args, { timeout = RUN_TIMEOUT_MS, input } = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    let p;
    try { p = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); }
    catch (e) { return reject(e); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { } reject(new Error(`${cmd} took too long`)); }, timeout);
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { err += c; });
    p.on('error', e => { clearTimeout(t); reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed`) : e); });
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`)); });
    if (input) { p.stdin.end(input); }
  });
}

/** Clean whisper-cli's stdout into one paragraph of text. With `-nt` it prints
 *  the words with no timestamps, one segment per line; anything in brackets
 *  is a non-speech marker (`[BLANK_AUDIO]`, `(silence)`). */
export function cleanTranscript(raw) {
  return String(raw || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^[\[(].*[\])]$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Transcribe one recorded clip. `buffer` is the audio bytes, `mime` what the
 * browser said it recorded. Resolves {text, seconds, took_ms}; rejects with a
 * one-line reason the caller can show.
 */
export async function transcribeAudio({ buffer, mime = '', lang = 'en' } = {}) {
  if (!buffer || !buffer.length) throw new Error('no audio');
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error('clip too long');
  const model = modelPath();
  if (!model) throw new Error(whisperStatus().reason);
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-stt-'));
  const ext = EXT[String(mime).split(';')[0].trim().toLowerCase()] || 'bin';
  // distinct names: a clip that is already a WAV must not be converted onto itself
  const src = path.join(dir, `in.${ext}`);
  const wav = path.join(dir, 'out.wav');
  try {
    fs.writeFileSync(src, buffer);
    await run(FFMPEG_BIN, ['-y', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1', '-f', 'wav', wav], { timeout: 60_000 });
    const seconds = Math.max(0, (fs.statSync(wav).size - 44) / 32000);
    const args = ['-m', model, '-f', wav, '-nt', '-np'];
    // an English-only model refuses other language tags; a multilingual one
    // is told the language so it does not spend the first seconds guessing
    if (!/\.en\.bin$/.test(model) && lang) args.push('-l', lang);
    const { out } = await run(WHISPER_BIN, args);
    return { text: cleanTranscript(out), seconds: Math.round(seconds * 10) / 10, took_ms: Date.now() - started, model: path.basename(model) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
}

/** The one handler both servers mount at POST /transcribe. `data` is the
 *  parsed JSON body; returns {status, body}. */
export async function transcribeRequest(data) {
  const b64 = String((data && data.audio_b64) || '').replace(/^data:[^,]*,/, '');
  if (!b64) return { status: 400, body: { ok: false, error: 'no audio' } };
  let buffer;
  try { buffer = Buffer.from(b64, 'base64'); } catch { return { status: 400, body: { ok: false, error: 'bad audio' } }; }
  if (buffer.length > MAX_AUDIO_BYTES) return { status: 413, body: { ok: false, error: 'clip too long — keep it under about fifteen minutes' } };
  try {
    const r = await transcribeAudio({ buffer, mime: String((data && data.mime) || ''), lang: String((data && data.lang) || 'en').slice(0, 8) });
    return { status: 200, body: { ok: true, ...r } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: String((e && e.message) || e) } };
  }
}
