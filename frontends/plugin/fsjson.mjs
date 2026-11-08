// fsjson.mjs — read a JSON file, and write one so it can never be half-written.
//
// The atomic-write contract is a whole-repo invariant: every record this
// companion keeps is written to a temp file beside its destination and RENAMED
// onto it, so a reader either sees the old file or the new one and never a
// truncated JSON document. store.mjs states it at the top of the file as the
// rule for the whole store.
//
// It was held in three copies. store.mjs and hosted.mjs had the same six lines
// character for character; identity.mjs had it open-coded a third time with one
// real difference — `mode: 0o600`, because the file it writes is a password.
// One invariant kept in three places is one invariant with three chances to
// drift, so it lives here and the three import it. The 0o600 survives as an
// argument.
//
// No dependencies beyond node's own, deliberately: everything in this tree
// imports this and nothing here may import back.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** The parsed file, or `fallback` for anything that is not readable JSON. */
export const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

// ---- a missing file is not a broken one ------------------------------------
//
// `readJson` answers the fallback for both, and that was fine for reading and
// wrong for everything that writes afterwards: a config.json with one trailing
// comma read as "no config", and the first-run code then wrote the defaults
// over the owner's settings. So the files that get written back on the
// strength of a read ask which it was. A file is in exactly one of these:
//
//   'missing'    — not there (ENOENT): use the default, and creating it is fine;
//   'ok'         — parsed;
//   'unreadable' — there, but not JSON (or not readable at all): use the
//                  default for READING, say so loudly once, and never write
//                  over it — the owner's bytes stay until the owner fixes them.
export const JSON_FILE_STATES = Object.freeze(['missing', 'ok', 'unreadable']);

/** `{state, value, error}` — `value` is the parsed JSON only when state is 'ok'. */
export function readJsonState(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'missing', value: undefined, error: null };
    return { state: 'unreadable', value: undefined, error: e };
  }
  try { return { state: 'ok', value: JSON.parse(text), error: null }; } catch (e) {
    return { state: 'unreadable', value: undefined, error: e };
  }
}

/** The refusal a write path throws (and a route answers) when its file is broken. */
export class UnreadableJsonError extends Error {
  constructor(file, cause) {
    super(`${file} is not readable JSON (${(cause && cause.message) || cause}) — fix or move it; `
      + 'nothing was written over it');
    this.name = 'UnreadableJsonError';
    this.code = 'EUNREADABLEJSON';
    this.file = file;
  }
}

const warned = new Set();
/** One loud line per broken file per run — a log that repeats every request is a log nobody reads. */
export function warnUnreadable(file, error) {
  if (warned.has(file)) return;
  warned.add(file);
  console.error(`!! ${new UnreadableJsonError(file, error).message}. Reading defaults in its place until then.`);
}

/**
 * The parsed file; `fallback` when it is missing; `fallback` AND one loud
 * warning when it is unreadable. For reads whose result may later be written
 * back: pair it with `refuseIfUnreadable` on the write.
 */
export function readJsonOrWarn(file, fallback = null) {
  const r = readJsonState(file);
  if (r.state === 'ok') return r.value;
  if (r.state === 'unreadable') warnUnreadable(file, r.error);
  return fallback;
}

/** Throws UnreadableJsonError if `file` is there but broken; a missing file is fine to create. */
export function refuseIfUnreadable(file) {
  const r = readJsonState(file);
  if (r.state === 'unreadable') { warnUnreadable(file, r.error); throw new UnreadableJsonError(file, r.error); }
}

/**
 * `obj` at `file`, atomically: temp beside it, then rename.
 *
 * The temp name carries the pid, so two processes writing the same record
 * cannot collide on the temp file itself (the rename is the atom, and the last
 * one wins — which is the store's documented rule).
 *
 * `mode` is for the files that are secrets. Passing it sets the permissions on
 * the TEMP file, which is the only moment the bytes exist under a name of their
 * own; rename carries them across.
 */
export function writeJson(file, obj, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

/**
 * Constant-time string comparison, for credentials.
 *
 * Hashed first, then compared, because `timingSafeEqual` throws on buffers of
 * different lengths — and a comparison that throws on the wrong length has
 * already leaked the length. Both sides become 32 bytes whatever went in.
 *
 * One copy on purpose. This was duplicated in hosted.mjs and identity.mjs, and
 * a security primitive is the last thing that should exist twice: a fix applied
 * to one copy is a fix that did not happen.
 */
export const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
