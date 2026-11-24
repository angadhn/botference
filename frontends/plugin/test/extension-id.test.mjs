// The extension carries a public key in its manifest, so its id is the same in
// every browser it is loaded into (without one, an unpacked extension's id comes
// from the folder it was loaded from). A companion that pins the extension's id
// can then be given one id for all of the owner's machines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const EXTENSION_ID = 'jgfkgfajcgcnmndmbkomeabkcolnecdc';

test('the manifest key gives the documented extension id', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const der = Buffer.from(manifest.key, 'base64');
  assert.ok(der.length > 200, 'a public key is present');
  crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); // throws if it is not a public key
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(id, EXTENSION_ID);
});
