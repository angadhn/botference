// "Is anyone actually using this?" — asked once a day, and answered with as
// little as it is possible to say.
//
// This is the whole of the telemetry in Discuss, and it is deliberately the
// least interesting request on the internet: one event, at most once per day,
// carrying a random number that means "an install" and a version string. No
// URL, no page title, no annotation, no handle, no username, no IP-derived
// location asked for, no timing, no counts. Nothing that could be joined back
// to a person or to anything they read.
//
// Three separate things each turn it off completely, and all of them are
// checked before any network call is made:
//   · BOTFERENCE_NO_TELEMETRY=1 in the environment (honoured in the LaunchAgent
//     path too, because the launcher passes the environment through)
//   · "telemetry": false in .botference/plugin/config.json
//   · an unset or placeholder API_SECRET below — which is how it ships, so a
//     fork that never fills it in never phones anywhere at all
//
// The install id is generated once and stored beside the other local state. It
// is a random 16 bytes and nothing else: not derived from the machine, the
// user, the workspace, or anything that exists elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// --- the one block anybody has to edit ---------------------------------
export const MEASUREMENT_ID = 'G-GR3QKD82JS';
// Filled in by the maintainer. While it looks like this, the beacon is a no-op.
// A Measurement Protocol api_secret is a write-only ingestion token for the
// maintainer's own property — it is not a user credential, and any client-side
// analytics ships one — so living in the source is the honest place for it.
// BOTFERENCE_TELEMETRY_SECRET overrides it, which is what the tests use to
// exercise the send path without a secret existing anywhere in the repo.
export const API_SECRET = '';
export const ENDPOINT = 'https://www.google-analytics.com/mp/collect';
export const EVENT_NAME = 'discuss_alive';
export const APP_VERSION = '1.0.0';
// -----------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const PLACEHOLDER = /^$|^(?:x+|placeholder|todo|your[-_]?secret)$/i;

const secretOf = env => String((env && env.BOTFERENCE_TELEMETRY_SECRET) || API_SECRET || '');
export const configured = (env = process.env) => {
  const s = secretOf(env);
  return !!(s && !PLACEHOLDER.test(s));
};

// Why the beacon is not going to fire, in one word — used by the tests and
// worth having when someone asks "does this thing phone home?".
export function reason({ dir, env = process.env, config = {}, now = Date.now() } = {}) {
  if (String(env.BOTFERENCE_NO_TELEMETRY || '') === '1') return 'opted out (BOTFERENCE_NO_TELEMETRY)';
  if (config && config.telemetry === false) return 'opted out (config.json)';
  if (!configured(env)) return 'no api secret — telemetry is inert in this build';
  const last = lastPing(dir);
  if (last && now - last < DAY_MS) return 'already pinged today';
  return '';
}

const stampFile = dir => path.join(dir, '.beacon');
function lastPing(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(stampFile(dir), 'utf8'));
    return Number(j.last) || 0;
  } catch { return 0; }
}

// The id: random, once, ours. Kept in the same file as the timestamp so the
// whole of what telemetry knows about you is one small file you can delete.
function installId(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(stampFile(dir), 'utf8'));
    if (typeof j.id === 'string' && /^[0-9a-f]{32}$/.test(j.id)) return j.id;
  } catch { }
  return crypto.randomBytes(16).toString('hex');
}

function stamp(dir, id, now) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stampFile(dir), JSON.stringify({ id, last: now }) + '\n', { mode: 0o600 });
  } catch { /* an unwritable workspace means we simply ping again tomorrow */ }
}

// Exactly what goes on the wire, as an object, so a test can assert on the
// whole thing rather than on a fragment of it.
export function payload(id) {
  return {
    client_id: id,
    non_personalized_ads: true,
    events: [{ name: EVENT_NAME, params: { app_version: APP_VERSION, engagement_time_msec: '1' } }],
  };
}

// ping({dir, config}) -> {sent:false, reason} | {sent:true, body}
// `send` is injectable so the tests never touch the network; the default is a
// fire-and-forget fetch that cannot fail loudly — a companion must never be
// slower, noisier, or less reliable because of this.
export async function ping({ dir, env = process.env, config = {}, now = Date.now(), send } = {}) {
  const why = reason({ dir, env, config, now });
  if (why) return { sent: false, reason: why };
  const id = installId(dir);
  const body = payload(id);
  const url = `${ENDPOINT}?measurement_id=${encodeURIComponent(MEASUREMENT_ID)}`
    + `&api_secret=${encodeURIComponent(secretOf(env))}`;
  // Stamped BEFORE the request, not after: a network that is down should cost
  // one skipped day, never a retry loop against someone's analytics endpoint.
  stamp(dir, id, now);
  try {
    const post = send || ((u, b) => fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(4000),
    }));
    await post(url, body);
  } catch { /* never surfaces: this is the least important thing here */ }
  return { sent: true, body };
}
