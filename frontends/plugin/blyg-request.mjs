// blyg-request.mjs — WHICH REQUESTS may reach the Publish-as-blyg routes (`/blyg-publish/*` and `/blyg-home*`), in every mode.
//
// ONE small exported function, so a companion-wide request-source rule (another branch) can replace this file's body at merge
// without touching the routes. It is called in exactly one place: server.mjs, at the top of the blyg route block, right after
// the owner check and before any body is read. The rules are stricter than the rest of the companion's, because these routes
// end in a push to a live site:
//   1. an Origin that is present must be trusted (hosted.originVerdict: the companion's own page, a configured public host, or a
//      pinned extension): `https://evil.<same parent domain>` is not;
//   2. a chrome-extension Origin is accepted only when the owner pinned extension ids (PLUGIN_EXTENSION_IDS) and this id is one:
//      the feature is off for an extension until they are set;
//   3. Sec-Fetch-Site, when sent, must be `same-origin` or `none`; `same-site` and `cross-site` are refused (a pinned extension's
//      own worker is the one exception: its requests are cross-site by nature);
//   4. a POST must say `content-type: application/json` (no content type, a form and text/plain are refused: a page can send
//      those without a preflight).
// → null when the request may proceed, else { status, error }.
export function blygRequestRefusal(req, { originVerdict, extensionIds = [] } = {}) {
  const origin = String(req.headers.origin || '').trim().toLowerCase();
  const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  const isExt = origin.startsWith('chrome-extension://');
  if (isExt) {
    const id = origin.slice('chrome-extension://'.length).replace(/\/+$/, '');
    if (!extensionIds.length) return { status: 403, error: 'refused: Publish as blyg is off for the extension until the companion is told which extension may use it (PLUGIN_EXTENSION_IDS)' };
    if (!extensionIds.includes(id)) return { status: 403, error: 'refused: this extension is not one the companion was told to trust' };
  } else if (origin && (typeof originVerdict !== 'function' || originVerdict(req) !== 'trusted')) {
    return { status: 403, error: 'refused: requests from other websites cannot use Publish as blyg' };
  }
  if (site && site !== 'same-origin' && site !== 'none' && !(isExt && site === 'cross-site')) {
    return { status: 403, error: 'refused: Publish as blyg answers only this site\'s own pages' };
  }
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
    return { status: 415, error: 'send the body as JSON (content-type: application/json)' };
  }
  return null;
}
