// tk-read.mjs — WHAT A `/tk` PASSAGE'S AGENT MAY USE (the owner's decision, 2026-11-27): it may search the web and read pages, and
// read the owner's notes in the folders the owner names; it may never write, edit, create, delete or rename a file, run a command or
// a program, read outside those folders, or use MCP servers or other tools. The passage text is its only output. The drawer's chat and
// @-mentions are not touched by any of this: only `/tk` passages and `botference fill-gap`.
//
// THE CAPABILITY SET, one named value chosen by ONE function (tkCapsFor) from the settings, the agent and WHO WROTE THE INSTRUCTION: the
// gap's own `from` (tkgaps MSG_CHANNELS), set when the instruction is born and never from a later save of the message; never a pile
// of flags:
//   none        no tools at all (what a one-shot was before; still used for a post's changelog line, never for a passage now)
//   web         web search and fetching pages
//   web+notes   web, and reading (only reading) files under the read roots
//
// THE SETTINGS (the companion's config.json, written by hand on this machine like `clippings`; `botference tk-read check`):
//   "tk_read_roots": ["/absolute/folder", …]   the folders a passage may read. No default: none set, no notes are read.
//   "hub_link_tk_notes": "on" | "off"           may a passage asked through the hub link (the owner's Hub) read notes? Default off:
//                                               a stolen link key could otherwise ask for the notes and read the answer back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secretsDir } from '../shared/secrets.mjs';

export const TK_CAPS = Object.freeze(['none', 'web', 'web+notes']);
export const HUB_LINK_TK_NOTES = Object.freeze(['off', 'on']);
// the time a passage may take: a run with tools reads and searches, so it is given longer; a hard ceiling either way
export const TK_CAPS_TIME_MS = Object.freeze({ none: 90000, web: 180000, 'web+notes': 180000 });
export const TK_READ_LIMITS = Object.freeze({ roots: 20 });

// folders a root may never be, or contain: the home folder itself (and what is above it), and the places secrets live
const forbiddenInside = (home) => [secretsDir(), path.join(home, '.ssh'), path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.config'),
  path.join(home, 'Library'), path.join(home, '.gnupg'), path.join(home, '.aws')];
// the path as the disk has it (realpath.native: on macOS the names' own case, not the case they were typed in)
const realOr = p => { try { return fs.realpathSync.native(p); } catch { return ''; } };
// HOW TWO PATHS COMPARE on this system: on macOS the disk is case-insensitive and keeps names in either Unicode form, so `/Users/x/.SSH`
// and `/users/x/.ssh` are one folder; the comparison is made on a key with the case folded and the form normalised (NFC)
export const pathKey = (p, platform = process.platform) => (platform === 'darwin' ? String(p).normalize('NFC').toLowerCase() : String(p));
const within = (inner, outer, platform) => { const a = pathKey(inner, platform), b = pathKey(outer, platform); return a === b || a.startsWith(`${b}/`); };

/** The settings checked: → { ok, errors, roots (real paths), hubLinkNotes }. An invalid setting reads as none (no notes). */
export function validateTkRead(config, { home = os.homedir(), platform = process.platform } = {}) {
  const errors = [];
  const raw = config && config.tk_read_roots;
  const roots = [];
  if (raw !== undefined) {
    if (!Array.isArray(raw)) errors.push('"tk_read_roots" must be a list of absolute folders');
    else {
      if (raw.length > TK_READ_LIMITS.roots) errors.push(`at most ${TK_READ_LIMITS.roots} folders in "tk_read_roots"`);
      const realHome = realOr(home) || home;
      for (const r of raw) {
        if (typeof r !== 'string' || !path.isAbsolute(r)) { errors.push(`${JSON.stringify(r)} is not an absolute folder`); continue; }
        const real = realOr(r);
        let dir = false;
        try { dir = !!real && fs.statSync(real).isDirectory(); } catch { dir = false; }
        if (!dir) { errors.push(`${r} is not a folder on this computer`); continue; }
        if (real === '/' || within(realHome, real, platform)) { errors.push(`${r} is your home folder or above it: name the notes folder itself`); continue; }
        // (the forbidden places by their own names and by the disk's, whether or not they exist: a case-folded spelling never slips by)
        const places = forbiddenInside(realHome).flatMap(f => [f, realOr(f)]).filter(Boolean);
        const holds = places.find(f => within(f, real, platform) || within(real, f, platform));
        if (holds) { errors.push(`${r} holds or is inside ${holds}, where secrets and settings live`); continue; }
        if (!/^\/[A-Za-z0-9 ._@+,()'&~/-]+$/.test(real) || /["\\]/.test(real)) { errors.push(`${r} has characters a sandbox rule cannot hold`); continue; }
        if (!roots.some(x => pathKey(x, platform) === pathKey(real, platform))) roots.push(real);
      }
    }
  }
  const hl = config && config.hub_link_tk_notes;
  if (hl !== undefined && !HUB_LINK_TK_NOTES.includes(hl)) errors.push('"hub_link_tk_notes" must be "on" or "off"');
  return { ok: !errors.length, errors, roots: errors.length ? [] : roots, hubLinkNotes: !errors.length && hl === 'on' ? 'on' : 'off' };
}

/**
 * THE ONE FUNCTION that says what a passage's agent may use. `read`: validateTkRead's answer; `agent`: claude | codex; `channel`: the
 * line's tkgaps channel (drawer, reading-room, api, hub-link; fill-gap counts as api). Notes need read roots, an agent that can read a
 * file without running a program (Claude's Read/Glob/Grep; Codex reads files only through its shell, which is never given), and,
 * through the hub link, the owner's `hub_link_tk_notes: "on"`.
 */
export function tkCapsFor({ read, agent, channel }) {
  const roots = (read && read.roots) || [];
  if (!roots.length || agent !== 'claude') return 'web';
  if (channel === 'hub-link') return read && read.hubLinkNotes === 'on' ? 'web+notes' : 'web';
  // FAIL CLOSED: only a door on this machine reads notes; a missing or unknown channel (a gap from before `from`, anything else) is web
  return MACHINE_CHANNELS.includes(channel) ? 'web+notes' : 'web';
}
// the doors on this machine (tkgaps MSG_CHANNELS less the hub link): the drawer, the companion's own pages, a tool on the machine
export const MACHINE_CHANNELS = Object.freeze(['drawer', 'reading-room', 'api']);

// ---- WHERE A NOTES RUN MAY FETCH (oneshot.mjs): the hosts the owner's own line names, and no others -------------------------------
// A run that can read notes could carry them out in the address of a page it fetches. So it fetches only from hosts that appear in the
// owner's line (an address with its scheme, `www.…`, or a bare `host.tld/path`); a page it found by searching is not fetched unless
// its host is one of those. Lower case, the port and anything after the host dropped; at most TK_FETCH_HOSTS_MAX.
export const TK_FETCH_HOSTS_MAX = 20;
const HOST_RE = /\b(?:https?:\/\/([^\s/?#<>"'`)\]]+)|(www\.[a-z0-9.-]+\.[a-z]{2,})|([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?=\/))/gi;
export function ownerHosts(text) {
  const out = [];
  for (const m of String(text == null ? '' : text).matchAll(HOST_RE)) {
    let host = '';
    try { host = new URL(`https://${m[1] || m[2] || m[3]}`).hostname.toLowerCase(); } catch { continue; }
    host = host.replace(/\.$/, '');
    if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || /^[\d.]+$/.test(host)) continue;
    if (!out.includes(host)) out.push(host);
    if (out.length >= TK_FETCH_HOSTS_MAX) break;
  }
  return out;
}
