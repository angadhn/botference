// A browser refuses to load an extension whose scripts are not valid UTF-8, and nothing else notices:
// Node reads such a file without complaint. Every file the extension ships is checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const TEXT = /\.(js|mjs|json|html|css)$/;
function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (TEXT.test(entry.name)) yield full;
  }
}

test('every text file of the extension is valid UTF-8', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const bad = [];
  let seen = 0;
  for (const file of files(root)) {
    seen += 1;
    try { decoder.decode(fs.readFileSync(file)); } catch { bad.push(path.relative(root, file)); }
  }
  assert.ok(seen > 5, 'the extension folder was found');
  assert.deepEqual(bad, []);
});
