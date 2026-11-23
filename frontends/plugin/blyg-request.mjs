// blyg-request.mjs — WHICH REQUESTS may reach the Publish-as-blyg routes (`/blyg-publish/*` and `/blyg-home*`), in every mode.
//
// A THIN LAYER over the companion-wide rule (hosted.mjs `sourceRefusal`, which judges where a request came from): the blyg routes
// first get that verdict, applied in every mode with reads strict, and then ONLY what they need on top, because they end in a push
// to a live site and the settings are code that runs:
//   1. an extension Origin is accepted only when extension ids are in force (the ONE helper server.mjs `extensionIdsInForce`: the
//      access settings' ids, else PLUGIN_EXTENSION_IDS) and names it: the feature is off for an extension until ids are set;
//   2. the settings WRITE (the command set) never accepts an extension Origin at all, pinned or not: only the companion's own page on
//      this machine (or no Origin: a person's own curl);
//   3. Sec-Fetch-Site, when sent, must be `same-origin` or `none` (a pinned extension's own worker may say `cross-site`);
//   4. a POST must say `content-type: application/json`.
// ONE exported function, called once, at the top of the blyg block in server.mjs (right after the owner check, before any body is
// read). → null when the request may proceed, else { status, error }.
export function blygRequestRefusal(req, { origin = 'absent', extensionIds = [], sourceRefusal = null, writesSettings = false } = {}) {
  if (typeof sourceRefusal === 'function') {
    const why = sourceRefusal(req, origin, { strictReads: true });
    if (why) return { status: 403, error: why };
  } else if (origin === 'foreign') {
    return { status: 403, error: 'refused: requests from other websites cannot use Publish as blyg' };
  }
  const rawOrigin = String(req.headers.origin || '').trim().toLowerCase();
  const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  const isExt = rawOrigin.startsWith('chrome-extension://');
  if (isExt) {
    const id = rawOrigin.slice('chrome-extension://'.length).replace(/\/+$/, '');
    if (writesSettings) return { status: 403, error: 'refused: the Where my blyg lives setting is changed only from the companion\'s own page on this machine, never by an extension' };
    if (!extensionIds.length) return { status: 403, error: 'refused: Publish as blyg is off for the extension until the companion is told which extension may use it (PLUGIN_EXTENSION_IDS, or the access settings\' extension ids)' };
    if (!extensionIds.includes(id)) return { status: 403, error: 'refused: this extension is not one the companion was told to trust' };
  }
  if (site && site !== 'same-origin' && site !== 'none' && !(isExt && site === 'cross-site')) {
    return { status: 403, error: 'refused: Publish as blyg answers only this site\'s own pages' };
  }
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
    return { status: 415, error: 'send the body as JSON (content-type: application/json)' };
  }
  return null;
}
