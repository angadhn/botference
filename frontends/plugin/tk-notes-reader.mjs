#!/usr/bin/env node
// tk-notes-reader.mjs — THE ONLY WAY A CODEX `/tk` PASSAGE READS THE OWNER'S NOTES (oneshot.mjs, capability set `web+notes`).
//
// Codex has no file tool of its own: it reads files through a shell, and a passage never gets a shell (a shell under the same OS
// wrapper as the CLI could read the CLI's own sign-in folder, and a wrapper cannot be nested inside a wrapper on macOS). So the CLI is
// given this one small program instead, as a tool server it starts itself (the Model Context Protocol over stdin/stdout): three
// tools, all READ ONLY, all confined to the read roots given on the command line.
//
//   node tk-notes-reader.mjs '<JSON list of absolute root folders>'
//
//   list_notes   { folder? }          the entries of a folder under a root (the roots themselves when none is named)
//   read_note    { path }             one file's text (at most LIMITS.fileBytes of it)
//   search_notes { query, folder? }   the lines holding `query` (case ignored) in the text files under a root
//
// A path is taken as the disk has it (realpath: links followed, the names' own case) and must then lie INSIDE a root; anything else
// is refused, whatever it was called. Nothing here writes, renames, deletes or starts a program; there is no tool that could.
// The OS wrapper (oneshot.mjs codexJail) is the outer wall: no write, no program but the CLI and this one, no read under /Users or
// /Volumes but the roots, the CLI's own folder and the run's two fresh folders.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({ fileBytes: 256 * 1024, entries: 500, searchFiles: 3000, searchHits: 60, lineChars: 300, queryChars: 200, depth: 12 });
export const TEXT_FILE = /\.(md|markdown|txt|org|rst|tex|bib|csv|json|ya?ml)$/i;
const key = p => (process.platform === 'darwin' ? String(p).normalize('NFC').toLowerCase() : String(p));
const real = p => { try { return fs.realpathSync.native(p); } catch { return ''; } };

/** The reader for `roots` (real paths). Each tool → { ok: true, text } or { ok: false, error }. */
export function makeReader(roots) {
  const allowed = roots.map(real).filter(Boolean);
  const inside = p => allowed.some(r => key(p) === key(r) || key(p).startsWith(`${key(r)}/`));
  // a path as given (absolute, or relative to the first root that has it) → its real path inside a root, or ''
  const resolve = given => {
    const g = String(given == null ? '' : given);
    if (!g || g.includes('\0')) return '';
    const tries = path.isAbsolute(g) ? [g] : allowed.map(r => path.join(r, g));
    for (const t of tries) { const p = real(t); if (p && inside(p)) return p; }
    return '';
  };
  const refuse = what => ({ ok: false, error: `${what} is not a file or folder inside the notes folders` });
  return {
    roots: allowed,
    list_notes({ folder = '' } = {}) {
      if (!folder) return { ok: true, text: allowed.join('\n') };
      const dir = resolve(folder);
      if (!dir) return refuse('that folder');
      let names;
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return refuse('that folder'); }
      const shown = names.filter(d => !d.name.startsWith('.')).slice(0, LIMITS.entries).map(d => `${d.name}${d.isDirectory() ? '/' : ''}`);
      return { ok: true, text: `${dir}\n${shown.join('\n')}${names.length > LIMITS.entries ? '\n… more entries not shown' : ''}` };
    },
    read_note({ path: given = '' } = {}) {
      const file = resolve(given);
      if (!file) return refuse('that path');
      let fd;
      try {
        if (!fs.statSync(file).isFile()) return refuse('that path');
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(LIMITS.fileBytes + 1);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const text = buf.subarray(0, Math.min(n, LIMITS.fileBytes)).toString('utf8');
        return { ok: true, text: n > LIMITS.fileBytes ? `${text}\n… the rest of the file is not shown` : text };
      } catch { return refuse('that path'); } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
    },
    search_notes({ query = '', folder = '' } = {}) {
      const q = String(query).slice(0, LIMITS.queryChars).toLowerCase();
      if (!q.trim()) return { ok: false, error: 'give the words to look for' };
      const starts = folder ? [resolve(folder)].filter(Boolean) : allowed;
      if (!starts.length) return refuse('that folder');
      const hits = [];
      let files = 0;
      const walk = (dir, depth) => {
        if (depth > LIMITS.depth || files >= LIMITS.searchFiles || hits.length >= LIMITS.searchHits) return;
        let names;
        try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of names) {
          if (d.name.startsWith('.') || files >= LIMITS.searchFiles || hits.length >= LIMITS.searchHits) continue;
          const p = real(path.join(dir, d.name));
          if (!p || !inside(p)) continue;
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          if (st.isDirectory()) { walk(p, depth + 1); continue; }
          if (!st.isFile() || !TEXT_FILE.test(d.name) || st.size > 4 * 1024 * 1024) continue;
          files++;
          let text;
          try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
          if (d.name.toLowerCase().includes(q)) hits.push(`${p}: (the file's name)`);
          text.split('\n').forEach((l, i) => { if (hits.length < LIMITS.searchHits && l.toLowerCase().includes(q)) hits.push(`${p}:${i + 1}: ${l.trim().slice(0, LIMITS.lineChars)}`); });
        }
      };
      for (const s of starts) walk(s, 0);
      return { ok: true, text: hits.length ? hits.join('\n') : 'nothing found' };
    },
  };
}

export const TOOLS = Object.freeze([
  { name: 'list_notes', description: 'List a folder of the reader\'s notes (read only). With no folder: the notes folders themselves.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'a folder inside the notes folders' } } } },
  { name: 'read_note', description: 'Read one note file (read only).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'the file, absolute or relative to a notes folder' } }, required: ['path'] } },
  { name: 'search_notes', description: 'Find the lines of the reader\'s notes that hold some words (case ignored; read only).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, folder: { type: 'string', description: 'search only inside this folder' } }, required: ['query'] } },
]);

/** One JSON-RPC message → the answer to send, or null (a notification). */
export function answer(reader, msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null;
  const reply = result => (msg.id === undefined || msg.id === null ? null : { jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') {
    return reply({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'botference-notes-reader', version: '1' } });
  }
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({ tools: TOOLS });
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const tool = TOOLS.some(t => t.name === name) ? reader[name] : null;
    let r;
    try { r = tool ? tool(msg.params.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}) : { ok: false, error: 'no such tool' }; }
    catch { r = { ok: false, error: 'the notes could not be read' }; }
    return reply({ content: [{ type: 'text', text: r.ok ? r.text : r.error }], isError: !r.ok });
  }
  if (msg.id === undefined || msg.id === null) return null;
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let roots = [];
  try { roots = JSON.parse(process.argv[2] || '[]').filter(r => typeof r === 'string' && path.isAbsolute(r)); } catch { roots = []; }
  const reader = makeReader(roots);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', l => {
    let msg;
    try { msg = JSON.parse(l); } catch { return; }
    const a = answer(reader, msg);
    if (a) process.stdout.write(`${JSON.stringify(a)}\n`);
  });
}
