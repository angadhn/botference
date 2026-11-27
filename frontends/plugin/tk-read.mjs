// tk-read.mjs — WHAT A `/tk` PASSAGE'S AGENT MAY USE (the owner's decision, 2026-11-27): it may search the web and read pages, and
// read the owner's notes in the folders the owner names; it may never write, edit, create, delete or rename a file, run a command or
// a program, read outside those folders, or use MCP servers or other tools. The passage text is its only output. The drawer's chat and
// @-mentions are not touched by any of this: only `/tk` passages and `botference fill-gap`.
//
// THE CAPABILITY SET, one named value chosen by ONE function (tkCapsFor) from the settings, the agent and the channel the line came
// through (tkgaps MSG_CHANNELS), never a pile of flags:
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
const realOr = p => { try { return fs.realpathSync(p); } catch { return ''; } };

/** The settings checked: → { ok, errors, roots (real paths), hubLinkNotes }. An invalid setting reads as none (no notes). */
export function validateTkRead(config, { home = os.homedir() } = {}) {
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
        if (real === '/' || real === realHome || realHome.startsWith(`${real}/`)) { errors.push(`${r} is your home folder or above it: name the notes folder itself`); continue; }
        const holds = forbiddenInside(realHome).map(realOr).filter(Boolean).find(f => f === real || f.startsWith(`${real}/`) || real.startsWith(`${f}/`));
        if (holds) { errors.push(`${r} holds or is inside ${holds}, where secrets and settings live`); continue; }
        if (!/^\/[A-Za-z0-9 ._@+,()'&~/-]+$/.test(real) || /["\\]/.test(real)) { errors.push(`${r} has characters a sandbox rule cannot hold`); continue; }
        if (!roots.includes(real)) roots.push(real);
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
  if (channel === 'hub-link' && !(read && read.hubLinkNotes === 'on')) return 'web';
  return 'web+notes';
}
