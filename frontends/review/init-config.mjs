#!/usr/bin/env node
// Scaffolds/repairs the bridge block of review.config.json: computes the
// core_dir fallback dynamically instead of hardcoding a ../ chain.
// Usage: node review/init-config.mjs [path-to-botference-home]
import fs from 'node:fs';
import path from 'node:path';

const REVIEW = path.dirname(new URL(import.meta.url).pathname);
const cfgFile = path.join(REVIEW, 'review.config.json');

export function findHome(explicit) {
  const candidates = [explicit, process.env.BOTFERENCE_HOME].filter(Boolean);
  // walk up from the review dir looking for a sibling botference-main at each level
  let d = REVIEW;
  while (d !== path.dirname(d)) {
    candidates.push(path.join(d, 'botference-main'));
    d = path.dirname(d);
  }
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'core', 'botference_ink_bridge.py'))) return path.resolve(c);
  }
  return null;
}

export function bridgeBlock(home) {
  return {
    core_dir: path.relative(REVIEW, path.join(home, 'core')), // computed, never hand-counted
    system_prompt: 'review/bridge-system-prompt.md',
    mention_max_chars: 4000,
  };
}

if (process.env.REVIEW_INIT_NO_WRITE !== '1') {
  const home = findHome(process.argv[2]);
  if (!home) { console.error('botference home not found; pass it as an argument or set $BOTFERENCE_HOME'); process.exit(1); }
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  cfg.bridge = { ...cfg.bridge, ...bridgeBlock(home) };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1));
  console.log(`bridge.core_dir = ${cfg.bridge.core_dir} (verified against ${home})`);
}
