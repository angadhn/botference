// hubtheme.test.mjs — the owner's Hub theme folder (hubtheme.mjs): what may be served, and from where.
//
//   node --test test/hubtheme.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { THEME_STATES, THEME_TYPES, THEME_MAX, themeFile, themeState, readThemeFile } from '../hubtheme.mjs';

const mk = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-theme-'));
  const dir = path.join(root, 'theme'), outside = path.join(root, 'outside');
  fs.mkdirSync(dir); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(dir, 'hub.css'), 'body{color:red}');
  fs.writeFileSync(path.join(dir, 'Serif.woff2'), 'woff2-bytes');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not served');
  fs.writeFileSync(path.join(outside, 'secret.css'), 'secret');
  fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'deep.css'), 'x');
  return { root, dir, outside, done: () => fs.rmSync(root, { recursive: true, force: true }) };
};

test('the states are one named list; none, ok, unreadable', () => {
  const t = mk();
  assert.deepEqual(THEME_STATES, ['none', 'ok', 'unreadable']);
  assert.deepEqual(themeState('', []), { state: 'none', reason: '' });
  assert.equal(themeState(t.dir, []).state, 'ok');
  assert.equal(themeState(path.join(t.root, 'missing'), []).state, 'unreadable');
  assert.equal(themeState(t.outside, []).state, 'unreadable', 'a folder without hub.css');
  assert.match(themeState(t.outside, []).reason, /no hub\.css/);
  assert.equal(themeState(path.join(t.dir, 'hub.css'), []).state, 'unreadable', 'a file is not a folder');
  t.done();
});

test('only files directly in the folder, by name, with the allowed extensions, with the right content types', () => {
  const t = mk();
  assert.ok(themeFile(t.dir, 'hub.css').file);
  assert.equal(readThemeFile(t.dir, 'hub.css').type, 'text/css; charset=utf-8');
  assert.equal(readThemeFile(t.dir, 'Serif.woff2').type, 'font/woff2');
  assert.deepEqual(Object.keys(THEME_TYPES), ['css', 'woff2', 'woff', 'ttf', 'otf']);
  for (const bad of ['', '.', '..', '../outside/secret.css', 'sub/deep.css', '/etc/passwd', 'notes.txt', 'hub', '.hidden.css', 'hub.css/', 'a\\b.css', '%2e%2e/x.css', 'hub.css\u0000.png']) {
    assert.ok(themeFile(t.dir, bad).refused, JSON.stringify(bad));
  }
  assert.ok(themeFile(t.dir, 'missing.css').refused);
  assert.ok(themeFile('', 'hub.css').refused);
  t.done();
});

test('a symlink is followed only if it stays inside the folder', () => {
  const t = mk();
  fs.symlinkSync(path.join(t.outside, 'secret.css'), path.join(t.dir, 'out.css'));
  fs.symlinkSync(path.join(t.dir, 'hub.css'), path.join(t.dir, 'in.css'));
  fs.symlinkSync(t.outside, path.join(t.dir, 'dirlink'));
  assert.match(themeFile(t.dir, 'out.css').refused, /outside the theme folder/);
  assert.ok(themeFile(t.dir, 'in.css').file);
  assert.ok(themeFile(t.dir, 'dirlink').refused);
  t.done();
});

test('a size cap per file; the folder may not be inside the data folders', () => {
  const t = mk();
  fs.writeFileSync(path.join(t.dir, 'big.css'), 'a'.repeat(THEME_MAX.css + 1));
  fs.writeFileSync(path.join(t.dir, 'big.woff'), 'a'.repeat(THEME_MAX.font + 1));
  fs.writeFileSync(path.join(t.dir, 'ok.woff'), 'a'.repeat(THEME_MAX.css + 1));
  assert.match(themeFile(t.dir, 'big.css').refused, /too large/);
  assert.match(themeFile(t.dir, 'big.woff').refused, /too large/);
  assert.ok(themeFile(t.dir, 'ok.woff').file, 'a font may be bigger than a stylesheet');
  assert.equal(themeState(t.dir, [t.root]).state, 'unreadable');
  assert.match(themeState(t.dir, [t.root]).reason, /data folders/);
  assert.equal(themeState(t.dir, [t.outside]).state, 'ok');
  assert.ok(themeFile(path.join(t.dir, 'sub'), 'deep.css', [t.dir]).refused, 'a subfolder of a forbidden folder too');
  t.done();
});
