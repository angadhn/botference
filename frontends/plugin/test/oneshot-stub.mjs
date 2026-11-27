#!/usr/bin/env node
// oneshot-stub.mjs — stands in for a bot's CLI in a one-shot gap fill
// (PLUGIN_ONESHOT_CMD). It records exactly what it was started with and what
// it was given on stdin, in $ONESHOT_LOG (one JSON line per run), and answers
// one line of text. No model is called.
import fs from 'node:fs';
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  if (process.env.ONESHOT_LOG) {
    fs.appendFileSync(process.env.ONESHOT_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input, env: process.env }) + '\n');
  }
  // codex writes its last message to the file after -o
  const o = process.argv.indexOf('-o');
  if (o !== -1 && process.argv[o + 1]) fs.writeFileSync(process.argv[o + 1], 'ONESHOT filled text.\n');
  process.stdout.write('ONESHOT filled text.\n');
});
