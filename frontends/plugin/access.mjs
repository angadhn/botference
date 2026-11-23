// Cloudflare Access sign-in for a hosted companion.
//
// With Access in front of the tunnel, Cloudflare asks each person for an emailed one-time code and passes
// every allowed request on with a signed token in the Cf-Access-Jwt-Assertion header. This file is the
// companion's half: read the settings, check that token on EVERY request (the companion can also be
// reached around Cloudflare, so it trusts nothing else: no cookie, no other header, no path), and turn
// a good token into one standing, owner or guest, by the person's email.
//
// How a hosted companion knows who is asking is ONE named setting, HOSTED_AUTH (hosted.mjs reads it):
//   password  today's behaviour: the shared passwords, the login page, the cookie. Access is not asked.
//   access    only a valid Access token is accepted. The password routes, the login page and the
//             cookie are off, and a Bearer password is ignored.
//   either    a transition mode, TEMPORARY: a valid token is used when one is present, otherwise the
//             password path applies. It exists so the owner can move over without being locked out.
//
// What a request's token comes to is one of ACCESS_VERDICTS, worked out by one function (verdictFor):
//   absent    no token (the request did not come through Access)
//   invalid   a token that fails any check, or a service token that carries no person
//   service   a valid service token (no email, `common_name`): refused, it is a password under another name
//   unlisted  a valid person whose email is neither the owner's nor a collaborator's
//   owner     a valid person: the owner's email
//   guest     a valid person: a collaborator's email
//
// Only node:crypto is used. Every failure is the same answer to the caller: nothing says which check
// failed, and the token, the settings and the emails are never logged or sent to a client.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { secretsDir } from '../shared/secrets.mjs';

export const HOSTED_AUTH = Object.freeze(['password', 'access', 'either']);
export const ACCESS_VERDICTS = Object.freeze(['absent', 'invalid', 'service', 'unlisted', 'owner', 'guest']);
export const ACCESS_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_FILE = 'plugin-access.json';

export const SKEW_SECONDS = 60;           // for nbf and iat; exp is strict (a stream is closed AT exp)
export const JWKS_TTL_MS = 10 * 60_000;   // keys are fresh this long
export const JWKS_STALE_OK_MS = 24 * 3600_000; // if Cloudflare's key list is down, keys this old still verify
export const JWKS_REFETCH_MIN_MS = 30_000; // an unknown key id never makes us fetch more often than this
export const JWKS_TIMEOUT_MS = 3000;
const JWKS_MAX_BYTES = 64 * 1024;
const MAX_TOKEN_CHARS = 8192;
const B64URL = /^[A-Za-z0-9_-]+$/;

export class AccessConfigError extends Error { }

const asciiLower = s => String(s).replace(/[A-Z]/g, c => c.toLowerCase());
export function sameText(a, b) {
  return timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
}
const parseJson = b64 => {
  try {
    const v = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
};

// ---- the settings --------------------------------------------------------
export function parseHostedAuth(v) {
  if (v === undefined || v === null || v === '') return 'password';
  if (typeof v === 'string' && HOSTED_AUTH.includes(v)) return v;
  throw new AccessConfigError(`hosted_auth must be one of ${HOSTED_AUTH.join(', ')}`);
}
export const handleBase = email => String(email).split('@')[0].toLowerCase().replace(/[^\w-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const EMAIL = /^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/;
const TEAM = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The validated settings for access/either, from the parsed JSON file. Throws AccessConfigError naming
 * what is missing or wrong (never its value).
 *   -> { team, aud, owner, people: Map(email -> { standing, handle }), certsUrl }
 * `ownerHandle` is the owner's own name on messages; a collaborator may not take it.
 */
export function buildAccessConfig(raw, { ownerHandle = '' } = {}) {
  const missing = [];
  const r = raw && typeof raw === 'object' ? raw : {};
  const team = typeof r.team === 'string' ? asciiLower(r.team.trim()) : '';
  if (!team) missing.push('team (the Cloudflare team domain)');
  else if (!TEAM.test(team)) throw new AccessConfigError('team must be a plain host name such as myteam.cloudflareaccess.com, with no scheme or path');
  const aud = typeof r.aud === 'string' ? r.aud.trim() : '';
  if (!aud) missing.push('aud (the Access application AUD tag)');
  else if (!/^[A-Za-z0-9_-]{8,128}$/.test(aud)) throw new AccessConfigError('aud does not look like an application AUD tag');
  const ownerEmail = typeof r.owner_email === 'string' ? asciiLower(r.owner_email) : '';
  if (!ownerEmail) missing.push("owner_email (the owner's email)");
  else if (!EMAIL.test(ownerEmail)) throw new AccessConfigError('owner_email is not a plain ASCII email address');
  // the browser extension's id(s): with Access the browser's cookie is the credential, so which extensions may call is never "any"
  const ids = Array.isArray(r.extension_ids) ? r.extension_ids.map(x => asciiLower(String(x).trim())) : [];
  if (!ids.length) missing.push("extension_ids (the extension's id from the browser's extensions page; a list)");
  else if (!ids.every(x => /^[a-p]{32}$/.test(x))) throw new AccessConfigError('extension_ids must be 32-letter extension ids');
  if (missing.length) throw new AccessConfigError(`Cloudflare Access sign-in needs: ${missing.join('; ')}`);
  const list = r.collaborators === undefined ? [] : r.collaborators;
  if (!Array.isArray(list)) throw new AccessConfigError('collaborators must be a list');
  const people = new Map([[ownerEmail, { standing: 'owner', handle: '' }]]);
  const taken = new Set([String(ownerHandle || '').toLowerCase().replace(/[^\w-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40), 'owner']);
  for (const item of list) {
    const email = asciiLower(typeof item === 'string' ? item : item && item.email);
    if (!EMAIL.test(email)) throw new AccessConfigError('a collaborator entry is not a plain ASCII email address');
    if (people.has(email)) throw new AccessConfigError('an email is listed twice in the access settings');
    let handle = typeof item === 'object' && item && item.handle !== undefined ? handleBase(item.handle) : handleBase(email);
    const given = typeof item === 'object' && item && item.handle !== undefined;
    if (given && !handle) throw new AccessConfigError('a collaborator handle has no usable characters');
    if (!handle || (!given && taken.has(handle))) handle = `${handle || 'guest'}-${createHash('sha256').update(email).digest('hex').slice(0, 4)}`;
    if (taken.has(handle)) throw new AccessConfigError('two people would share one handle in the access settings');
    taken.add(handle);
    people.set(email, { standing: 'guest', handle });
  }
  let certsUrl = `https://${team}/cdn-cgi/access/certs`;
  if (r.certs_url_for_tests !== undefined) {
    if (typeof r.certs_url_for_tests !== 'string' || !/^https?:\/\//.test(r.certs_url_for_tests)) throw new AccessConfigError('certs_url_for_tests must be an http(s) address');
    certsUrl = r.certs_url_for_tests;
  }
  return { team, aud, owner: ownerEmail, people, certsUrl, extensionIds: [...new Set(ids)] };
}

/**
 * The mode and (for access/either) the settings, from the secrets directory. Called once at start.
 * A missing file means `password`. A file that cannot be read or parsed refuses to start.
 */
export function loadHostedAuth({ dir = secretsDir(), ownerHandle = '' } = {}) {
  const file = path.join(dir, ACCESS_FILE);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { mode: 'password', config: null, file };
    throw new AccessConfigError(`the access settings file could not be read as JSON (${ACCESS_FILE} in the secrets folder)`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AccessConfigError(`${ACCESS_FILE} must hold one JSON object`);
  const mode = parseHostedAuth(raw.hosted_auth);
  return { mode, config: mode === 'password' ? null : buildAccessConfig(raw, { ownerHandle }), file };
}

// ---- the team's signing keys ---------------------------------------------
export async function defaultGet(url, { timeoutMs = JWKS_TIMEOUT_MS, maxBytes = JWKS_MAX_BYTES } = {}) {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  const text = await res.text();
  if (text.length > maxBytes) throw new Error('key list too large');
  return { status: res.status, text };
}
export async function fetchKeys(url, { get = defaultGet } = {}) {
  const res = await get(url, { timeoutMs: JWKS_TIMEOUT_MS, maxBytes: JWKS_MAX_BYTES });
  if (Number(res.status) !== 200) throw new Error('key list not available');
  const doc = JSON.parse(String(res.text));
  const keys = new Map();
  for (const jwk of Array.isArray(doc && doc.keys) ? doc.keys : []) {
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) keys.set(jwk.kid, key);
    } catch { /* an unusable key is not a key */ }
  }
  if (!keys.size) throw new Error('no usable key');
  return keys;
}

// The key cache holds plain facts: what was fetched, when it was fetched, when a fetch was last tried, and
// the fetch in flight (so a crowd of requests shares ONE fetch). What the cache IS is worked out by one function.
export const KEY_CACHE_STATES = Object.freeze(['empty', 'fresh', 'stale', 'expired']);
export const newKeyCache = () => ({ keys: null, at: 0, triedAt: null, inflight: null });
export function keyCacheState(cache, t) {
  if (cache.keys === null) return 'empty';
  const age = t - cache.at;
  if (age < 0) return 'expired'; // the clock went backwards: trust nothing
  return age < JWKS_TTL_MS ? 'fresh' : age < JWKS_STALE_OK_MS ? 'stale' : 'expired';
}
async function keyFor(kid, { url, cache, now, get }) {
  const t = now();
  const state = keyCacheState(cache, t);
  if (state === 'fresh' && cache.keys.has(kid)) return cache.keys.get(kid);
  const usable = () => (state === 'fresh' || state === 'stale') ? (cache.keys.get(kid) ?? null) : null;
  if (!cache.inflight) {
    const mayTry = cache.triedAt === null || t < cache.triedAt || t - cache.triedAt >= JWKS_REFETCH_MIN_MS;
    // a stale cache that already has the key may keep serving it between attempts; an unknown key id waits for the gap
    if (!mayTry) return usable();
    cache.triedAt = t;
    cache.inflight = fetchKeys(url, { get })
      .then(keys => { cache.keys = keys; cache.at = t; return keys; })
      .finally(() => { cache.inflight = null; });
  }
  try { return (await cache.inflight).get(kid) ?? null; }
  catch { return usable(); } // the list is down: a key we already hold still verifies, for up to JWKS_STALE_OK_MS
}

// ---- the token -------------------------------------------------------------
/**
 * Checks one token. -> { why: 'ok', claims } | { why: 'invalid' } | { why: 'service', claims }
 * (a service token is a token that is valid in every way except that it names no person.)
 */
export async function checkAccessToken(token, config, { now = () => Date.now(), cache, get = defaultGet } = {}) {
  const bad = { why: 'invalid' };
  try {
    if (typeof token !== 'string' || !config || token.length > MAX_TOKEN_CHARS) return bad;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(p => B64URL.test(p))) return bad;
    const header = parseJson(parts[0]);
    // the algorithm is fixed, never read from the token: not "none", not HS256 signed with the public key
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200) return bad;
    if (header.typ !== undefined && header.typ !== 'JWT') return bad;
    if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) return bad;
    const key = await keyFor(header.kid, { url: config.certsUrl, cache, now, get });
    if (!key) return bad;
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return bad;
    const claims = parseJson(parts[1]);
    if (!claims) return bad;
    const nowS = Math.floor(now() / 1000);
    const num = v => typeof v === 'number' && Number.isFinite(v);
    if (!num(claims.exp) || claims.exp <= nowS) return bad;
    if (claims.nbf !== undefined && (!num(claims.nbf) || claims.nbf > nowS + SKEW_SECONDS)) return bad;
    if (claims.iat !== undefined && (!num(claims.iat) || claims.iat > nowS + SKEW_SECONDS)) return bad;
    if (typeof claims.iss !== 'string' || !sameText(claims.iss, `https://${config.team}`)) return bad;
    const auds = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    let audOk = false;
    for (const a of auds) if (typeof a === 'string' && sameText(a, config.aud)) audOk = true; // every entry compared
    if (!audOk) return bad;
    if (claims.type !== 'app') return bad;
    if (claims.common_name !== undefined) return { why: 'service', claims };
    if (typeof claims.identity_nonce !== 'string' || claims.identity_nonce === '') return bad;
    // exact email: printable ASCII only, no trimming, only A-Z folded: no look-alike, space or zero-width character
    if (typeof claims.email !== 'string' || !/^[\x21-\x7e]+$/.test(claims.email)) return bad;
    return { why: 'ok', claims };
  } catch { return bad; } // anything unexpected, a failed key fetch included, is a refusal
}
export async function verifyAccessToken(token, config, deps) {
  const r = await checkAccessToken(token, config, deps);
  return r.why === 'ok' ? r.claims : null;
}

/** The ONE place a checked token becomes a verdict. -> { verdict, handle?, expiresAt? } */
export function verdictFor(checked, config) {
  if (checked === null) return { verdict: 'absent' };
  if (checked.why === 'service') return { verdict: 'service' };
  if (checked.why !== 'ok') return { verdict: 'invalid' };
  const person = config.people.get(asciiLower(checked.claims.email));
  if (!person) return { verdict: 'unlisted' };
  return { verdict: person.standing, handle: person.handle, expiresAt: checked.claims.exp * 1000 };
}

// ---- the verifier a hosted companion holds ---------------------------------
// A request's verdict is worked out once, before the request is routed (the routes ask synchronously),
// and kept beside the request, never on a shared field.
const verdicts = new WeakMap();
export const verdictOfRequest = req => verdicts.get(req) || { verdict: 'absent' };

export function createAccess(config, { now = () => Date.now(), get = defaultGet } = {}) {
  const cache = newKeyCache();
  async function resolve(req) {
    const raw = req.headers[ACCESS_HEADER];
    const v = verdictFor(raw === undefined ? null : await checkAccessToken(Array.isArray(raw) ? raw.join(',') : raw, config, { now, cache, get }), config);
    verdicts.set(req, v);
    return v;
  }
  return { resolve, cache };
}

// ---- a long-lived connection's standing record ------------------------------
// A stream or socket is judged once, at connect, and that judgement is a record: who it is and until when.
// An event is delivered only to a record that is still live, and the heartbeat closes the ones that are not,
// so a connection never outlives the token that opened it (the client reconnects with a fresh one).
export const connectionRecord = (standing, expiresAt = Infinity) => ({ standing, expiresAt });
export const connectionLive = (rec, now = Date.now()) => !!rec && now < rec.expiresAt;
