// following-fake.mjs — an invented blyg (or several) served from memory, for
// the Following tests. No network: `get` has the shape of netguard's guardedGet.
import crypto from 'node:crypto';

const sha = s => 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
/** A valid 26-character id from a small number. */
export const idOf = n => { let s = ''; let x = n; do { s = B32[x % 32] + s; x = Math.floor(x / 32); } while (x); return s.padStart(26, '0'); };

export function makeDoc({ id, origin, kind = 'fragment', version = 1, title = 'A made-up title', body = 'Some invented words.',
  created = '2026-11-01T10:00:00Z', updated = created, transclusions, stub_of, links, author = 'Invented Author', page, changelog = [] }) {
  const md = (title ? `# ${title}\n\n` : '') + body;
  const html = (title ? `<h1>${title}</h1>\n` : '') + `<p>${body}</p>`;
  const doc = { blyg: '0.4', id, kind, origin, version, created, updated, content_md: kind === 'withdrawn' ? '' : md,
    content_html: kind === 'withdrawn' ? '' : html, content_hash: sha(kind === 'withdrawn' ? '' : md), media: [],
    changelog };
  if (author !== null) doc.author = { name: author };
  if (page !== undefined) doc.page = page;
  if (kind === 'thread') doc.transclusions = transclusions || [];
  if (stub_of) doc.stub_of = stub_of;
  if (links) doc.links = links;
  return doc;
}

/** A pretend web of blygs. web.add(origin, {title}) → site with .put(doc) / .drop(id) / .down. */
export function makeWeb() {
  const sites = new Map();
  const web = { sites, requests: [], inFlight: 0, maxInFlight: 0, delayMs: 0, hosts: {} };
  web.add = (origin, { title = 'Invented Notes', author = 'Invented Author' } = {}) => {
    const site = { origin, title, author, docs: new Map(), down: null, noManifest: false, index404: false };
    site.put = doc => { site.docs.set(doc.id, doc); return doc; };
    site.drop = id => site.docs.delete(id);
    sites.set(origin, site);
    return site;
  };
  web.get = async (url, opts = {}) => {
    web.requests.push(String(url));
    web.inFlight++; web.maxInFlight = Math.max(web.maxInFlight, web.inFlight);
    try {
      if (web.delayMs) await new Promise(r => setTimeout(r, web.delayMs));
      const u = new URL(String(url));
      const site = [...sites.values()].find(s => String(url).startsWith(s.origin) || (u.host === new URL(s.origin).host && u.pathname.startsWith(new URL(s.origin).pathname)));
      const none = () => ({ status: 404, url: String(url), contentType: 'text/plain', text: 'not found' });
      if (!site && [...sites.values()].some(x => new URL(x.origin).host === u.host)) return none();
      if (!site) {
        const e = new Error(`no route to ${u.host}`); e.kind = 'network'; throw e;
      }
      if (site.down) { const e = new Error(site.down); e.kind = site.down === 'refused' ? 'refused' : 'network'; throw e; }
      const rel = String(url).slice(site.origin.length).split('?')[0];
      const json = v => ({ status: 200, url: String(url), contentType: 'application/json', text: JSON.stringify(v) });
      if (rel === 'blyg.json') return site.noManifest ? none() : json({ blyg: '0.4', title: site.title, author: { name: site.author }, updated: '2026-11-02T00:00:00Z' });
      if (rel === 'items/index.json') {
        if (site.index404) return none();
        const items = [...site.docs.values()].map(d => ({ id: d.id, kind: d.kind, created: d.created, updated: d.updated, version: d.version }))
          .sort((a, b) => b.updated.localeCompare(a.updated));
        return json({ updated: '2026-11-02T00:00:00Z', items });
      }
      if (/^[tf]\/[^/]+\/$/.test(rel)) {
        return { status: 200, url: String(url), contentType: 'text/html',
          text: `<!doctype html><head><link rel="blyg" href="${site.origin}blyg.json"></head><body><p>a page</p></body>` };
      }
      const m = /^items\/([^/]+)\.json$/.exec(rel);
      if (m && site.docs.has(m[1])) return json(site.docs.get(m[1]));
      return none();
    } finally { web.inFlight--; }
  };
  web.count = pred => web.requests.filter(pred).length;
  web.itemRequests = () => web.requests.filter(u => /\/items\/(?!index)[^/]+\.json$/.test(u));
  return web;
}
