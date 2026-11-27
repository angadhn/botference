#!/usr/bin/env node
// oneshot-slow-stub.mjs — test/oneshot-stub.mjs with a delay per call: the Nth call (counted by the lines already in $ONESHOT_LOG)
// waits delays[N] ms (from the JSON array in "$ONESHOT_LOG.delays") before it answers, so a test can hold one fill while another
// runs. No model is called.
import fs from 'node:fs';
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const log = process.env.ONESHOT_LOG;
  let n = 0;
  try { n = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch { n = 0; }
  fs.appendFileSync(log, JSON.stringify({ n, input: input.length }) + '\n');
  let delays = [];
  try { delays = JSON.parse(fs.readFileSync(`${log}.delays`, 'utf8')); } catch { delays = []; }
  // (claude with tools answers as `--output-format stream-json` does)
  const answer = process.argv.includes('stream-json') ? `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `FILL ${n}` })}\n` : `FILL ${n}\n`;
  setTimeout(() => process.stdout.write(answer), Number(delays[n]) || 0);
});
