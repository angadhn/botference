// blyg-request.test.mjs — the blyg routes' request rule: a thin layer over hosted.mjs sourceRefusal, each added rule refused alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blygRequestRefusal as refuse } from '../blyg-request.mjs';
import { sourceRefusal } from '../hosted.mjs';

const rq = (method, headers = {}) => ({ method, headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers } });
const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const o = (origin, extra = {}) => ({ origin, extensionIds: [EXT], sourceRefusal, ...extra });
const ext = { origin: `chrome-extension://${EXT}`, 'sec-fetch-site': 'cross-site' };

test('the global rule is applied first: a foreign origin, and a browser saying same-site with no Origin, are refused by sourceRefusal\'s own words', () => {
  assert.match(refuse(rq('POST'), o('foreign')).error, /other websites cannot use the companion/);
  assert.match(refuse(rq('POST', { 'sec-fetch-site': 'same-site', origin: 'https://x.test' }), o('foreign')).error, /other websites/);
  assert.match(refuse(rq('GET', { 'sec-fetch-site': 'cross-site' }), o('absent')).error, /other websites/);
  assert.equal(refuse({ method: 'PUT', headers: {} }, o('absent')).error, 'refused: unsupported method');
});

test('what the blyg routes add: JSON, Sec-Fetch-Site same-origin or none, extension ids required', () => {
  assert.equal(refuse(rq('GET', { 'sec-fetch-site': 'none' }), o('absent')), null, 'the read-only settings view, from the machine');
  assert.equal(refuse(rq('POST', ext), o('trusted')), null, 'a pinned extension\'s own worker');
  for (const [req, origin, status] of [
    [rq('POST', { ...ext, 'content-type': 'text/plain' }), 'trusted', 415], [rq('POST', { ...ext, 'content-type': 'application/x-www-form-urlencoded' }), 'trusted', 415],
    [{ method: 'POST', headers: { ...ext } }, 'trusted', 415], [rq('POST', { ...ext, 'content-type': 'application/jsonx' }), 'trusted', 415],
    [rq('POST', { origin: 'https://discuss.example.test', 'sec-fetch-site': 'same-site' }), 'trusted', 403],
    [rq('POST', { origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }), 'trusted', 403],
  ]) assert.equal(refuse(req, o(origin))?.status, status, JSON.stringify(req.headers));
});

test('with no extension ids in force the feature is off for every extension', () => {
  assert.match(refuse(rq('POST', ext), o('trusted', { extensionIds: [] })).error, /off for the extension/);
});

// Review item 1: a script on the companion's own origin (a page it serves) must not start, advance or read a publish: only the drawer
// offers that, through the extension's worker, whose requests carry the extension's own Origin (a page cannot send that header).
test('the publish routes answer only the pinned extension: the companion\'s own page, a curl, a same-site page are refused; reads too', () => {
  const pr = (origin, extra = {}) => o(origin, { publishRoute: true, ...extra });
  assert.equal(refuse(rq('POST', ext), pr('trusted')), null, 'the drawer, through the worker');
  assert.equal(refuse(rq('GET', ext), pr('trusted')), null, 'the drawer reading its run');
  assert.equal(refuse(rq('GET', { 'sec-fetch-site': 'none' }), pr('absent')), null, 'a person typing the address, or a curl: a read');
  for (const [req, origin, why] of [
    [rq('POST', { origin: 'http://127.0.0.1:4189', 'sec-fetch-site': 'same-origin' }), 'trusted', /only from the extension's drawer/],
    [rq('POST'), 'absent', /only from the extension's drawer/],
    [rq('POST', { origin: 'https://discuss.example.test', 'sec-fetch-site': 'same-origin' }), 'trusted', /only from the extension's drawer/],
    [rq('GET', { 'sec-fetch-site': 'same-origin' }), 'absent', /read only by the extension's drawer/],
    [rq('GET', { origin: 'http://127.0.0.1:4189', 'sec-fetch-site': 'same-origin' }), 'trusted', /read only by the extension's drawer/],
  ]) {
    const r = refuse(req, pr(origin));
    assert.equal(r && r.status, 403, JSON.stringify(req));
    assert.match(r.error, why);
  }
  assert.equal(refuse(rq('POST', { origin: 'http://127.0.0.1:4189', 'sec-fetch-site': 'same-origin' }), o('trusted')), null, 'not a publish route: the rule is unchanged');
});
