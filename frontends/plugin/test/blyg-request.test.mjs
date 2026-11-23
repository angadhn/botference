// blyg-request.test.mjs — the blyg routes' request rule: a thin layer over hosted.mjs sourceRefusal, each added rule refused alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blygRequestRefusal as refuse } from '../blyg-request.mjs';
import { sourceRefusal } from '../hosted.mjs';

const rq = (method, headers = {}) => ({ method, headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers } });
const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const o = (origin, extra = {}) => ({ origin, extensionIds: [EXT], sourceRefusal, ...extra });

test('the global rule is applied first: a foreign origin, and a browser saying same-site with no Origin, are refused by sourceRefusal\'s own words', () => {
  assert.match(refuse(rq('POST'), o('foreign')).error, /other websites cannot use the companion/);
  assert.match(refuse(rq('POST', { 'sec-fetch-site': 'same-site', origin: 'https://x.test' }), o('foreign')).error, /other websites/);
  assert.match(refuse(rq('GET', { 'sec-fetch-site': 'cross-site' }), o('absent')).error, /other websites/);
  assert.equal(refuse({ method: 'PUT', headers: {} }, o('absent')).error, 'refused: unsupported method');
});

test('what the blyg routes add: JSON, Sec-Fetch-Site same-origin or none, extension ids required', () => {
  assert.equal(refuse(rq('POST'), o('absent')), null);
  assert.equal(refuse(rq('POST', { origin: 'https://discuss.example.test', 'sec-fetch-site': 'same-origin' }), o('trusted')), null);
  assert.equal(refuse(rq('GET', { 'sec-fetch-site': 'none' }), o('absent')), null);
  assert.equal(refuse(rq('POST', { origin: `chrome-extension://${EXT}`, 'sec-fetch-site': 'cross-site' }), o('trusted')), null, 'a pinned extension\'s own worker');
  for (const [req, origin, status] of [
    [rq('POST', { 'content-type': 'text/plain' }), 'absent', 415], [rq('POST', { 'content-type': 'application/x-www-form-urlencoded' }), 'absent', 415],
    [{ method: 'POST', headers: {} }, 'absent', 415], [rq('POST', { 'content-type': 'application/jsonx' }), 'absent', 415],
    [rq('POST', { origin: 'https://discuss.example.test', 'sec-fetch-site': 'same-site' }), 'trusted', 403],
    [rq('POST', { origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }), 'trusted', 403],
  ]) assert.equal(refuse(req, o(origin))?.status, status, JSON.stringify(req.headers));
});

test('with no extension ids in force the feature is off for every extension; a settings write refuses an extension Origin even when pinned', () => {
  assert.match(refuse(rq('POST', { origin: `chrome-extension://${EXT}` }), o('trusted', { extensionIds: [] })).error, /off for the extension/);
  assert.match(refuse(rq('POST', { origin: `chrome-extension://${EXT}` }), o('trusted', { writesSettings: true })).error, /only from the companion's own page on this machine, never by an extension/);
  assert.equal(refuse(rq('POST', { origin: 'http://127.0.0.1:4189' }), o('trusted', { writesSettings: true })), null, 'the companion\'s own page');
  assert.equal(refuse(rq('POST'), o('absent', { writesSettings: true })), null, 'a person\'s own curl on the machine');
});
