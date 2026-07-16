#!/usr/bin/env node
// Commits (and optionally pushes) the caller's own review comments so they travel via git.
// Usage:  node review/submit.mjs [--push]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REVIEW = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(REVIEW, '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

let handle = '';
try { handle = git('config', 'github.user'); } catch { }
if (!handle) {
  let name = '';
  try { name = git('config', 'user.name'); } catch { }
  handle = (name || 'anonymous').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const file = path.join(REVIEW, 'state', 'users', handle.replace(/[^\w-]/g, '_') + '.json');
if (!fs.existsSync(file)) {
  console.error(`No comments found at ${path.relative(ROOT, file)} — open the review site first (node review/server.mjs).`);
  process.exit(1);
}
const n = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).decisions || {}).length;
const rel = path.relative(ROOT, file);
git('add', rel);
try {
  git('commit', '-m', `Review comments from ${handle} (${n} item${n === 1 ? '' : 's'})`, '--', rel);
  console.log(`committed ${rel} (${n} items)`);
} catch { console.log('nothing new to commit'); }
if (process.argv.includes('--push')) { git('push'); console.log('pushed'); }
