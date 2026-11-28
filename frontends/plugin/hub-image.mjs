// hub-image.mjs — a picture added in the Hub's reply box ("Add image"), as this computer takes it.
//
// The browser has already drawn the picture on a canvas (at most 1600 px, JPEG), which carries no metadata. NOTHING HERE TRUSTS THAT:
// the bytes are read as a JPEG segment by segment, every segment that can carry the owner's location, camera, thumbnail or words is
// dropped (APP1 Exif/XMP, APP13, comments, and every application segment but JFIF, an ICC profile and Adobe's colour tag), whatever
// follows the end of the image is cut off, and what is left is saved in the site checkout's image folder under the sha256 of those
// bytes (`<hex>.jpg`, mode 0644). The folder is the `image_folder` setting (blyg-home.mjs); without it images are off.
//
// Pure JavaScript, no tool is run, nothing is decoded: the parser only walks the segment lengths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const IMAGE_LIMITS = Object.freeze({
  bytes: 3_000_000,        // the most one picture may be (the Hub and the companion both; the page keeps to 2.5 MB)
  perHour: 40,             // pictures accepted an hour
  keepDays: 30,            // an untracked picture no note names is deleted after this many days (cleanupImages)
});
export const IMAGE_TYPE = 'image/jpeg';
export const IMAGE_GATES = Object.freeze(['on', 'off']);
export const IMAGE_NAME = /^[0-9a-f]{64}\.jpg$/;

/** The segments a JPEG keeps. Everything else of the application kind is metadata or something this computer has no use for. */
const KEEP_APP = (marker, body) => marker === 0xe0                                                            // JFIF
  || (marker === 0xe2 && body.toString('latin1', 0, 12) === 'ICC_PROFILE\0')                                  // an ICC colour profile
  || (marker === 0xee && body.toString('latin1', 0, 5) === 'Adobe');                                          // Adobe's colour transform
const isApp = m => m >= 0xe0 && m <= 0xef;

export const startsLikeJpeg = buf => Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

/**
 * Filters a JPEG. → { ok: true, bytes, dropped: [marker names] } or { ok: false, why }.
 * `why`: not-jpeg (first bytes), damaged (a length that runs off the end, a marker out of place, no image data, no end of image).
 */
export function stripJpeg(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!startsLikeJpeg(b)) return { ok: false, why: 'not-jpeg' };
  const out = [Buffer.from([0xff, 0xd8])];
  const dropped = [];
  let at = 2, sawScan = false;
  for (;;) {
    // a marker: 0xFF, optional 0xFF fill, then the code
    if (at >= b.length || b[at] !== 0xff) return { ok: false, why: 'damaged' };
    while (b[at + 1] === 0xff) at++;
    const marker = b[at + 1];
    if (marker === undefined || marker === 0x00) return { ok: false, why: 'damaged' };
    if (marker === 0xd9) { if (!sawScan) return { ok: false, why: 'damaged' }; out.push(Buffer.from([0xff, 0xd9])); break; }   // end of image: what follows is cut off
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return { ok: false, why: 'damaged' };   // no length: not here
    if (at + 4 > b.length) return { ok: false, why: 'damaged' };
    const len = b.readUInt16BE(at + 2);
    if (len < 2 || at + 2 + len > b.length) return { ok: false, why: 'damaged' };
    const body = b.subarray(at + 4, at + 2 + len);
    const whole = b.subarray(at, at + 2 + len);
    if (marker === 0xfe || (isApp(marker) && !KEEP_APP(marker, body))) dropped.push(marker === 0xfe ? 'COM' : `APP${marker - 0xe0}`);
    else out.push(whole);
    at += 2 + len;
    if (marker === 0xda) {
      // the entropy-coded data after a scan header: up to the next marker that is not a stuffed 0xFF00 or a restart (D0–D7)
      sawScan = true;
      const from = at;
      for (;;) {
        const i = b.indexOf(0xff, at);
        if (i < 0 || i + 1 >= b.length) return { ok: false, why: 'damaged' };
        const n = b[i + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) { at = i + (n === 0xff ? 1 : 2); continue; }
        at = i; break;
      }
      out.push(b.subarray(from, at));
    }
  }
  return { ok: true, bytes: Buffer.concat(out), dropped };
}

/** The segments of a JPEG that carry metadata, by name (for tests, and for the browser-side check). */
export function metadataOf(input) {
  const b = Buffer.from(input);
  const found = [];
  let at = 2;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const m = b[at + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = b.readUInt16BE(at + 2);
    if (m === 0xfe) found.push('COM');
    else if (m === 0xe1 || m === 0xed) found.push(`APP${m - 0xe0}`);
    at += 2 + len;
  }
  return found;
}

const within = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const posix = p => p.split(path.sep).join('/');
const realOrNull = p => { try { return fs.realpathSync(p); } catch { return null; } };

/**
 * The image folder setting, against the site checkout `top` (a real path). → { ok, folder, url } | { ok: false, error }.
 * `folder` is absolute and lies INSIDE `top` (an existing part of it is resolved through links first; a part that does not exist yet is
 * made at the first save); `url` is the site-relative address a picture in it has, ending in `/`.
 */
export function checkImageFolder(raw, top) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, folder: '', url: '' };
  if (typeof raw !== 'string' || raw.includes('\0') || !path.isAbsolute(raw) || raw.length > 400) return { ok: false, error: 'image_folder must be an absolute path (a folder inside the site checkout)' };
  if (!top) return { ok: false, error: 'image_folder needs the notes folder to be inside a git work tree first' };
  const want = path.resolve(raw);
  // the nearest part that exists, resolved through links; the rest is plain names
  let existing = want;
  const rest = [];
  while (!realOrNull(existing)) { rest.unshift(path.basename(existing)); const up = path.dirname(existing); if (up === existing) break; existing = up; }
  const base = realOrNull(existing);
  if (!base) return { ok: false, error: 'image_folder is not under a folder that exists' };
  const folder = path.join(base, ...rest);
  if (!within(top, folder) || folder === top) return { ok: false, error: 'image_folder must be a folder inside the site checkout' };
  const rel = posix(path.relative(top, folder));
  if (rel.split('/')[0] === '.git' || rel.split('/').some(s => !s || s.startsWith('.') || !/^[A-Za-z0-9 _.-]+$/.test(s))) return { ok: false, error: 'image_folder may hold only letters, digits, space, _ . - in its names, and no name that starts with a dot' };
  try { if (fs.existsSync(folder) && !fs.statSync(folder).isDirectory()) return { ok: false, error: 'image_folder is not a folder' }; } catch { /* checked at save */ }
  return { ok: true, folder, url: `/${rel.split('/').map(encodeURIComponent).join('/')}/` };
}

/**
 * Saves the picture. → { ok: true, path (site-relative, for the markdown), name, stripped } | { ok: false, status, error }.
 * The name is the sha256 of the bytes as saved; a file that is already there with those bytes is the answer too (the same picture
 * twice); one with other bytes is never overwritten (error 'name-taken'). The folder is resolved again here and must lie inside `top`.
 */
export function saveImage({ folder, url, top, bytes }) {
  if (!folder || !top) return { ok: false, status: 404, error: 'images-off' };
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) return { ok: false, status: 415, error: 'not-jpeg' };
  if (bytes.length > IMAGE_LIMITS.bytes) return { ok: false, status: 413, error: 'too-large' };
  if (!startsLikeJpeg(bytes)) return { ok: false, status: 415, error: 'not-jpeg' };
  const s = stripJpeg(bytes);
  if (!s.ok) return { ok: false, status: 415, error: s.why === 'not-jpeg' ? 'not-jpeg' : 'damaged' };
  const name = `${crypto.createHash('sha256').update(s.bytes).digest('hex')}.jpg`;
  try {
    // resolved BEFORE anything is made: a link on the way that leads out of the checkout stops the save with nothing created
    const before = checkImageFolder(folder, top);
    if (!before.ok) return { ok: false, status: 409, error: 'folder-outside' };
    fs.mkdirSync(before.folder, { recursive: true, mode: 0o755 });
    const real = fs.realpathSync(before.folder);
    const now = checkImageFolder(real, top);
    if (!now.ok || now.folder !== real) return { ok: false, status: 409, error: 'folder-outside' };
    const target = path.join(real, name);
    if (path.dirname(path.resolve(target)) !== real || !IMAGE_NAME.test(name)) return { ok: false, status: 409, error: 'folder-outside' };
    let existed = false;
    try {
      const st = fs.lstatSync(target);
      if (!st.isFile() || st.isSymbolicLink()) return { ok: false, status: 409, error: 'name-taken' };
      if (!fs.readFileSync(target).equals(s.bytes)) return { ok: false, status: 409, error: 'name-taken' };
      existed = true;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!existed) {
      const tmp = path.join(real, `.upload-${crypto.randomBytes(8).toString('hex')}`);
      fs.writeFileSync(tmp, s.bytes, { flag: 'wx', mode: 0o644 });
      try { fs.chmodSync(tmp, 0o644); fs.linkSync(tmp, target); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
    } else { try { fs.utimesSync(target, new Date(), new Date()); } catch { /* the age is only for the cleanup */ } }
    return { ok: true, path: `${url}${name}`, name, stripped: s.dropped, size: s.bytes.length };
  } catch {
    return { ok: false, status: 500, error: 'internal' };
  }
}

/**
 * Deletes the pictures in the folder that were never published: UNTRACKED by git, older than IMAGE_LIMITS.keepDays, and named by no
 * note in `notesFolder`. (A picture a draft still holds is not in a note yet, which is why the wait is long.) → the names deleted.
 */
export function cleanupImages({ folder, top, notesFolder, now = Date.now(), keepDays = IMAGE_LIMITS.keepDays }) {
  const gone = [];
  try {
    if (!folder || !top || !fs.existsSync(folder)) return gone;
    const names = fs.readdirSync(folder).filter(n => IMAGE_NAME.test(n));
    if (!names.length) return gone;
    const tracked = new Set(execFileSync('git', ['-C', top, 'ls-files', '-z', '--', folder], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean).map(f => path.basename(f)));
    let notes = '';
    if (notesFolder && fs.existsSync(notesFolder)) for (const f of fs.readdirSync(notesFolder)) if (f.endsWith('.md')) { try { notes += fs.readFileSync(path.join(notesFolder, f), 'utf8') + '\n'; } catch { /* unreadable: kept */ } }
    for (const n of names) {
      const file = path.join(folder, n);
      const st = fs.lstatSync(file);
      if (!st.isFile() || now - st.mtimeMs < keepDays * 86_400_000) continue;
      if (tracked.has(n) || notes.includes(n)) continue;
      fs.unlinkSync(file); gone.push(n);
    }
  } catch { /* a cleanup never fails a save */ }
  return gone;
}

/**
 * What the hub link asks of this module: deps.images. `settings()` → the validated blyg-home settings (or null when not set up).
 * gate() is 'on' only when the setting names a folder.
 */
export function createImages({ settings, log = () => {} }) {
  const taken = [];   // the times of the pictures accepted in the last hour
  const here = () => { const s = settings(); return s && s.image_folder ? s : null; };
  return {
    gate: () => (here() ? 'on' : 'off'),
    save(bytes) {
      const s = here();
      if (!s) return { ok: false, status: 404, error: 'images-off' };
      const t = Date.now();
      while (taken.length && t - taken[0] > 3_600_000) taken.shift();
      if (taken.length >= IMAGE_LIMITS.perHour) return { ok: false, status: 429, error: 'limit', limit: 'images-per-hour' };
      const r = saveImage({ folder: s.image_folder, url: s.image_url, top: s.top, bytes });
      if (r.ok) {
        taken.push(t);
        log(`image saved ${r.name.slice(0, 8)} (${r.size} bytes${r.stripped.length ? `, dropped ${r.stripped.join(' ')}` : ''})`);
        cleanupImages({ folder: s.image_folder, top: s.top, notesFolder: s.folder });
      } else log(`image refused ${r.error}`);
      return r;
    },
  };
}
