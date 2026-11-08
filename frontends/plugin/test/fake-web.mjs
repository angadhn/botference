// fake-web.mjs — a pretend public web for a companion under test.
//
// The companion never fetches a link that lands on this computer or the
// private network (lasso.webAddressRefusal), and that rule has no exceptions —
// so a test that wants it to fetch "a page on the web" cannot point it at a
// loopback server. This preload (NODE_OPTIONS=--import) gives the test a web
// instead: any host ending `.web.test` RESOLVES to a public address (so the
// companion's check passes for the reason it would in real life), and a fetch
// to one is carried to the loopback server whose port is in
// $FAKE_WEB_PORT_FILE. Nothing outside those names is touched, and nothing
// here is loaded outside the tests.
import dns from 'node:dns';
import fs from 'node:fs';

const FAKE = /\.web\.test$/i;
const realLookup = dns.promises.lookup.bind(dns.promises);
dns.promises.lookup = async (host, opts) => (FAKE.test(String(host))
  ? (opts && opts.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 })
  : realLookup(host, opts));

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input && input.url ? input.url : input));
  if (!FAKE.test(u.hostname)) return realFetch(input, init);
  const port = String(fs.readFileSync(process.env.FAKE_WEB_PORT_FILE, 'utf8')).trim();
  const res = await realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  // a redirect the far end sends is relative to the PRETEND host, as it would be
  const loc = res.headers.get('location');
  if (loc && /^\//.test(loc)) {
    const headers = new Headers(res.headers);
    headers.set('location', `${u.protocol}//${u.host}${loc}`);
    return new Response(null, { status: res.status, headers });
  }
  return res;
};
