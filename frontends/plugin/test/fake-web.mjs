// fake-web.mjs — a pretend public web for a companion under test.
//
// The companion never fetches a link that lands on this computer or the
// private network (netguard.mjs), and that rule has no exceptions —
// so a test that wants it to fetch "a page on the web" cannot point it at a
// loopback server. This preload (NODE_OPTIONS=--import) gives the test a web
// instead: any host ending `.web.test` RESOLVES to a public address (so the
// companion's check passes for the reason it would in real life), and a request
// to one is carried to the loopback server whose port is in
// $FAKE_WEB_PORT_FILE. Nothing outside those names is touched, and nothing
// here is loaded outside the tests.
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const FAKE = /\.web\.test$/i;
const realLookup = dns.promises.lookup.bind(dns.promises);
dns.promises.lookup = async (host, opts) => (FAKE.test(String(host))
  ? (opts && opts.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 })
  : realLookup(host, opts));

// A fetch is node's own http/https request: the companion's guarded GET
// (netguard.mjs, for both the Blygger check and a lassoed link) connects with
// http.request and a lookup that answers only the address it checked. A
// request for a pretend host is first asked which address it would connect
// to — that must be the public one the check saw — and is then carried to the
// loopback server, path and headers unchanged.
const realHttpRequest = http.request.bind(http);
const realHttpsRequest = https.request.bind(https);
const fakeRequest = real => function (opts, cb) {
  if (!opts || typeof opts !== 'object' || !FAKE.test(String(opts.hostname || ''))) return real(opts, cb);
  let addr = '';
  if (typeof opts.lookup === 'function') opts.lookup(opts.hostname, {}, (err, a) => { addr = err ? '' : a; });
  if (addr !== '93.184.216.34') throw new Error(`fake-web: ${opts.hostname} would connect to ${addr || 'nothing'}`);
  const port = String(fs.readFileSync(process.env.FAKE_WEB_PORT_FILE, 'utf8')).trim();
  return realHttpRequest({ host: '127.0.0.1', port, path: opts.path, method: opts.method || 'GET',
    headers: opts.headers, agent: false }, cb);
};
http.request = fakeRequest(realHttpRequest);
https.request = fakeRequest(realHttpsRequest);
