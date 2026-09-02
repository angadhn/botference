// One identity for the owner, across the review docs and the annotator.
//
// The review hub (frontends/review/hub.mjs) already solved "prove you are the
// owner from a phone", and it did it twice over:
//
//   · an APPROVED DEVICE — `hub_device = exp.<deviceId>.<hmac>`, signed with
//     ~/.botference/.review-hub-device-secret, 365 days, and scoped to the
//     PARENT domain (Domain=botference.com) so every subdomain sees it. The
//     annotator lives at discuss.botference.com, which is inside that scope, so
//     a browser the owner already approved for the review portal arrives here
//     already carrying proof. Nothing to enrol, nothing to type.
//   · an OWNER PASSWORD — resolved by hub.mjs's ownerPassword() as
//     REVIEW_HUB_PASSWORD, else `.owner` inside ~/.botference/
//     review-paper-secrets.json, generated and persisted there on first use.
//     The hub hands that same value to every paper server as
//     REVIEW_OWNER_PASSWORD, which is what makes it ONE password for all of
//     them rather than one per document.
//
// Both are reused here verbatim — same files, same cookie name, same signing
// input, same precedence — so the owner has literally one credential and one
// enrolled-device list for everything botference serves. The alternative
// (plugin-scoped copies) would have meant a second password to carry and a
// second approval per phone, which is the problem this is meant to remove.
//
// Reading another component's secret is safe in exactly the way it looks: all
// of these are 0600 files in one home directory, belonging to one person, and
// every consumer of them is a server that person runs on that machine. What we
// do NOT do is invent device approvals: the annotator only ever VERIFIES a
// `hub_device` cookie, never mints one. Approving a new browser stays the
// hub's own osascript flow (or, failing that, typing the owner password here).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { secretsDir } from '../shared/secrets.mjs';

// ~/.botference, or wherever the tests point us. Defined once for every
// frontend in ../shared/secrets.mjs and re-exported here, where the companion
// has always imported it from.
export { secretsDir };

const readTrimmed = f => {
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    return s || '';
  } catch { return ''; }
};

// The hub's approved-device signing key. Never created here: if the hub has
// never run, no device was ever approved, so there is nothing to verify and an
// empty secret correctly means "device cookies do not apply".
export const deviceSecret = () =>
  readTrimmed(path.join(secretsDir(), '.review-hub-device-secret'));

const paperSecretsFile = () => path.join(secretsDir(), 'review-paper-secrets.json');
const readPaperSecrets = () => {
  try {
    const s = JSON.parse(fs.readFileSync(paperSecretsFile(), 'utf8'));
    return (s && typeof s === 'object') ? s : {};
  } catch { return {}; }
};

// hub.mjs's ownerPassword(), precedence and storage identical — including
// generating one into the shared file when it is not there yet, which is what
// the hub itself would do on its next owner login. Whoever gets there first,
// both then agree.
export function ownerPassword() {
  if (process.env.PLUGIN_OWNER_PASSWORD) return process.env.PLUGIN_OWNER_PASSWORD;
  if (process.env.REVIEW_HUB_PASSWORD) return process.env.REVIEW_HUB_PASSWORD;
  const s = readPaperSecrets();
  if (s.owner) return String(s.owner);
  const pw = crypto.randomBytes(12).toString('hex');
  s.owner = pw;
  try {
    fs.mkdirSync(secretsDir(), { recursive: true });
    const file = paperSecretsFile();
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    // an unwritable home still yields a working password for this process
    console.error(`plugin: could not persist the shared owner password (${e && e.message})`);
  }
  return pw;
}

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// hub.mjs's deviceSession(), byte for byte: exp.deviceId.mac over DEVICE_SECRET.
// Returns { id } for an approved browser, else null.
export function deviceSession(cookieValue, secret = deviceSecret()) {
  if (!secret) return null;
  const raw = decodeURIComponent(String(cookieValue || ''));
  const m = /^(\d+)\.([0-9a-f]+)\.([0-9a-f]+)$/.exec(raw);
  if (!m || Date.now() > Number(m[1])) return null;
  const mac = crypto.createHmac('sha256', secret).update(`${m[1]}.${m[2]}`).digest('hex');
  return safeEqual(mac, m[3]) ? { id: m[2] } : null;
}
