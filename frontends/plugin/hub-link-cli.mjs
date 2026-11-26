#!/usr/bin/env node
// hub-link-cli.mjs — `botference hub-link`: the ONE way to link the owner's hosted Hub to this computer (hub-link.mjs).
//
//   botference hub-link pair --hub https://<hub origin> [--publish one-click|drafts-only] [--companion https://<companion's public name>]
//                                  make the key; print the two lines for the Hub's environment, once, and the fingerprint
//   botference hub-link rotate [--publish one-click|drafts-only] [--companion …]
//                                  replace the key (the old one is refused at once); print the two lines again
//   botference hub-link off        delete the key: every /hub-link/* route answers 404
//   botference hub-link status     whether it is linked: the Hub's origin, the publish setting, the key id and the fingerprint
//
// The key file is `hub-link.json` in the secrets folder (shared/secrets.mjs), mode 0600. The secret is printed by pair and rotate
// ONLY; status never prints it. Nothing here is reachable over HTTP: the publish setting is changed only on this machine.
// Exit 0: done; 1: refused; 2: usage.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretsDir } from '../shared/secrets.mjs';
import { readLinkKey, newKey, writeLinkKey, deleteLinkKey, fingerprintOf, hubOriginOf, keyFileOf, HUB_LINK_PUBLISH } from './hub-link.mjs';

const USAGE = 'Usage: botference hub-link pair --hub https://<hub origin> [--publish one-click|drafts-only] [--companion https://<name>] | rotate [--publish …] [--companion …] | off | status';

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--(hub|publish|companion)(?:=(.*))?$/.exec(args[i]);
    if (!m) return { bad: args[i] };
    out[m[1]] = m[2] !== undefined ? m[2] : args[++i];
    if (out[m[1]] === undefined) return { bad: args[i - 1] };
  }
  return { out };
}
// the companion's public address for the Hub's BLYG_HUB_STUDIO_URL: --companion, else the reading room's name the launcher passes
function companionUrlOf(given, env) {
  if (given !== undefined) return hubOriginOf(given) || null;
  const name = String(env.PLUGIN_READING_HOSTNAME || '').trim() || String(env.PLUGIN_PUBLIC_HOSTNAMES || '').split(',').map(s => s.trim()).find(Boolean) || '';
  return name ? (hubOriginOf(`https://${name}`) || '') : '';
}
const linesFor = (key, companion) => [
  'Put these two lines in your Hub\'s environment (Netlify: Site configuration > Environment variables), then redeploy:',
  '',
  `BLYG_HUB_STUDIO_URL=${companion || 'https://<your companion\'s public name>'}`,
  `BLYG_HUB_STUDIO_KEY=${key.key_id}.${key.secret}`,
  '',
  ...(companion ? [] : ['(No public name is set for this companion: put its https address in place of the first value, or pass --companion.)', '']),
  `Key ${key.key_id}, fingerprint ${fingerprintOf(key.secret)}. The Hub shows the same two to say it is linked to this computer.`,
  `Publishing from the Hub: ${key.publish}. The key is not shown again; \`botference hub-link rotate\` makes a new one.`,
];

/** → exit code. `dir`: the secrets folder; `say`: one line out. */
export function main(argv, { dir = secretsDir(), env = process.env, say = s => process.stdout.write(`${s}\n`), now = () => new Date() } = {}) {
  const [cmd, ...rest] = argv;
  const usage = () => { say(USAGE); return 2; };
  if (cmd === 'status') {
    if (rest.length) return usage();
    const { gate, key } = readLinkKey(dir);
    if (gate === 'off') { say('Not linked: no Hub can reach this computer. Link one with: botference hub-link pair --hub https://<your Hub>'); return 0; }
    if (gate === 'broken') { say(`The hub link key file is not readable (${keyFileOf(dir)}); the link is off until it is fixed or removed (botference hub-link off).`); return 1; }
    say(`Linked to ${key.hub_origin}`);
    say(`Publishing from the Hub: ${key.publish}`);
    say(`Key ${key.key_id}, fingerprint ${fingerprintOf(key.secret)}, made ${key.created_at}`);
    return 0;
  }
  if (cmd === 'off') {
    if (rest.length) return usage();
    const had = deleteLinkKey(dir);
    say(had ? 'The hub link is off: the key is deleted and the Hub can no longer reach this computer.' : 'The hub link was already off.');
    return 0;
  }
  if (cmd !== 'pair' && cmd !== 'rotate') return usage();
  const f = flags(rest);
  if (f.bad !== undefined) return usage();
  const o = f.out;
  if (o.publish !== undefined && !HUB_LINK_PUBLISH.includes(o.publish)) { say(`--publish must be one of: ${HUB_LINK_PUBLISH.join(', ')}`); return 2; }
  const companion = companionUrlOf(o.companion, env);
  if (companion === null) { say('Refused: --companion must be an https origin, like https://companion.example.com'); return 1; }
  const was = readLinkKey(dir);
  if (was.gate === 'broken') { say(`Refused: the hub link key file is not readable (${keyFileOf(dir)}). It is never written over: fix it or run botference hub-link off.`); return 1; }
  let key;
  if (cmd === 'pair') {
    if (was.gate === 'on') { say(`Already linked to ${was.key.hub_origin} (key ${was.key.key_id}). Use botference hub-link rotate for a new key, or off first.`); return 1; }
    const hub = hubOriginOf(o.hub);
    if (!hub) { say('Refused: --hub must be the Hub\'s https origin, like https://blog.example.com (no path, no http).'); return 1; }
    key = newKey({ hub_origin: hub, publish: o.publish || 'drafts-only', now });
  } else {
    if (was.gate !== 'on') { say('Not linked: nothing to rotate. Link a Hub with: botference hub-link pair --hub https://<your Hub>'); return 1; }
    if (o.hub !== undefined) { say('rotate keeps the Hub it is linked to; to link another, run off, then pair.'); return 2; }
    key = newKey({ hub_origin: was.key.hub_origin, publish: o.publish || was.key.publish, now });
  }
  writeLinkKey(dir, key);
  if (cmd === 'rotate') say(`The old key ${was.key.key_id} is refused from now on.`);
  for (const l of linesFor(key, companion)) say(l);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
