// The transcription engine (frontends/shared/transcribe.mjs): the pipeline
// with a stub in place of whisper-cli, so the test needs no model and no
// Homebrew, plus the text cleaner and the request handler's refusals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// a fake whisper-cli: ignores its input, prints two lines and a marker
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-stt-test-'));
const stub = path.join(dir, 'whisper-cli');
fs.writeFileSync(stub, '#!/bin/sh\necho "[BLANK_AUDIO]"\necho " Hello there,"\necho "this is a test."\n');
fs.chmodSync(stub, 0o755);
const model = path.join(dir, 'ggml-test.bin'); fs.writeFileSync(model, 'x');
process.env.BOTFERENCE_WHISPER_BIN = stub;
process.env.BOTFERENCE_WHISPER_MODEL = model;

const T = await import('../../shared/transcribe.mjs');
let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };

ok('status ok with a model on disk', T.whisperStatus().ok === true);
ok('cleaner joins lines and drops markers', T.cleanTranscript(' [BLANK_AUDIO]\n Hello there,\nthis is a test.\n(silence)\n') === 'Hello there, this is a test.');

// a real (tiny) audio file so ffmpeg has something to convert: half a second of silence
const wav = path.join(dir, 'in.wav');
const { execFileSync } = await import('node:child_process');
let haveFfmpeg = true;
try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.5', wav]); } catch { haveFfmpeg = false; }
if (haveFfmpeg) {
  const r = await T.transcribeAudio({ buffer: fs.readFileSync(wav), mime: 'audio/wav' });
  ok('pipeline returns the cleaned text', r.text === 'Hello there, this is a test.', JSON.stringify(r));
  ok('and the clip length', Math.abs(r.seconds - 0.5) < 0.1, String(r.seconds));
  const req = await T.transcribeRequest({ audio_b64: fs.readFileSync(wav).toString('base64'), mime: 'audio/wav' });
  ok('request handler: 200 with text', req.status === 200 && req.body.ok && req.body.text === 'Hello there, this is a test.');
} else {
  console.log('  (ffmpeg not installed here — pipeline checks skipped)');
}
const empty = await T.transcribeRequest({});
ok('request handler: no audio is a 400', empty.status === 400 && empty.body.ok === false);
const big = await T.transcribeRequest({ audio_b64: Buffer.alloc(T.MAX_AUDIO_BYTES + 10).toString('base64'), mime: 'audio/wav' });
ok('request handler: an oversize clip is a 413', big.status === 413);
delete process.env.BOTFERENCE_WHISPER_MODEL;

fs.rmSync(dir, { recursive: true, force: true });
console.log(`transcribe: ${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
