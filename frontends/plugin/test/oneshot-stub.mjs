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
  // claude with tools answers as `--output-format stream-json --verbose` does: the tool uses named in "$ONESHOT_LOG.tools" (a JSON
  // list of {name, input}, for a test that wants a passage to have used the web or notes), then the result
  if (process.argv.includes('stream-json')) {
    let tools = [];
    try { tools = JSON.parse(fs.readFileSync(`${process.env.ONESHOT_LOG}.tools`, 'utf8')); } catch { tools = []; }
    for (const t of tools) process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: t.name, input: t.input }] } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ONESHOT filled text.' }) + '\n');
    return;
  }
  process.stdout.write('ONESHOT filled text.\n');
});
