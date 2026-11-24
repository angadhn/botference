// A page's address is whatever a visitor gave: written into an inline script it must
// not be able to end the script element (a hosted guest could otherwise run script
// on the owner's pages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptString } from '../views.mjs';

const SEP = String.fromCharCode(0x2028), PSEP = String.fromCharCode(0x2029);
const HOSTILE = [
  'x</script><script>alert(1)</script>',
  'javascript:</script><img src=x onerror=alert(1)>',
  '<!--<script>',
  ']]>&lt;',
  'a' + SEP + 'b' + PSEP + 'c',
  '"\';//',
];

test('a value written into an inline script cannot end the script or start markup', () => {
  for (const value of HOSTILE) {
    const written = scriptString(value);
    for (const bad of ['<', '>', '&', SEP, PSEP]) assert.ok(!written.includes(bad), written);
    assert.equal(JSON.parse(written), value, 'and it reads back as the same text');
  }
});
