// blyg-request.test.mjs — which requests may reach the Publish-as-blyg routes (blyg-request.mjs): every rule, each refused alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blygRequestRefusal as refuse } from '../blyg-request.mjs';

const own = req => (req.headers.origin === 'https://discuss.example.test' ? 'trusted' : 'foreign');
const rq = (method, headers = {}) => ({ method, headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers } });
const EXT = 'abcdefghijklmnopabcdefghijklmnop';

test('a plain request, a same-origin page and a pinned extension pass; every deviation is refused on its own', () => {
  const o = { originVerdict: own, extensionIds: [EXT] };
  assert.equal(refuse(rq('POST'), o), null, 'no Origin (the Node side, curl): as everywhere else');
  assert.equal(refuse(rq('POST', { origin: 'https://discuss.example.test', 'sec-fetch-site': 'same-origin' }), o), null);
  assert.equal(refuse(rq('GET', { 'sec-fetch-site': 'none' }), o), null);
  assert.equal(refuse(rq('POST', { origin: `chrome-extension://${EXT}`, 'sec-fetch-site': 'cross-site' }), o), null, 'a pinned extension\'s own worker is cross-site by nature');
  const no = [
    [rq('POST', { origin: 'https://evil.example.test' }), 403], [rq('POST', { origin: 'null' }), 403],
    [rq('POST', { origin: 'https://discuss.example.test', 'sec-fetch-site': 'same-site' }), 403],
    [rq('POST', { 'sec-fetch-site': 'cross-site' }), 403], [rq('GET', { 'sec-fetch-site': 'same-site' }), 403],
    [rq('POST', { origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }), 403],
    [rq('POST', { 'content-type': 'text/plain' }), 415], [rq('POST', { 'content-type': 'application/x-www-form-urlencoded' }), 415],
    [{ method: 'POST', headers: {} }, 415], [rq('POST', { 'content-type': 'application/jsonx' }), 415],
  ];
  for (const [req, status] of no) assert.equal(refuse(req, o)?.status, status, JSON.stringify(req.headers));
});

test('with no extension ids pinned the feature is off for every extension; with none and no verdict function a present Origin is refused', () => {
  assert.match(refuse(rq('POST', { origin: `chrome-extension://${EXT}` }), { originVerdict: own, extensionIds: [] }).error, /PLUGIN_EXTENSION_IDS/);
  assert.equal(refuse(rq('POST', { origin: 'https://discuss.example.test' }), {})?.status, 403);
  assert.equal(refuse(rq('POST'), {}), null);
});
