// blyg-fake-cmd.mjs — a stand-in for a site's publish command, for the Publish-as-blyg tests.
//
//   node blyg-fake-cmd.mjs <log> <control> <step> <note>
//
// Appends one JSON line to <log>: the step, its argv, its cwd, the NAMES of the environment it was given and
// whether the note existed. What it then does is read from <control> (a JSON file, so a test can change it
// between steps): { "<step>": "ok" | "fail" | "sleep" | "big" | "prompt" } (default "ok").
//   ok      prints a line (publish also prints the post's address, taken from the note's permalink)
//   fail    prints a complaint and exits 1
//   sleep   waits a minute (a test kills it, or the time limit does)
//   big     prints more than the output buffer allows
//   prompt  waits for a line on stdin (there is none: stdin is closed, so it ends at once)
import fs from 'node:fs';
const [log, control, step, note] = process.argv.slice(2);
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(control, 'utf8')); } catch { /* none */ }
const how = ctl[step] || 'ok';
fs.appendFileSync(log, JSON.stringify({ step, argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort(),
  noteExists: fs.existsSync(note), how, pid: process.pid }) + '\n');
const permalink = (() => { try { return /^permalink:\s*(\S+)/m.exec(fs.readFileSync(note, 'utf8'))[1]; } catch { return ''; } })();
if (how === 'fail') { console.error(`${step}: something broke\nrun the same --push again, or --abandon`); process.exit(1); }
// a plain refusal of the kind the example site prints, after a stack trace and a path (only the plain line may reach the owner)
if (how === 'refuse') { console.error(`/Users/someone/site/scripts/blyg_publish.rb:42:in 'go': boom (RuntimeError)\n\tfrom scripts/blyg-publish:9:in '<main>'\nblyg-publish: _notes/other.md is already staged by this checkout; unstage it (--unstage-note) before staging another note`); process.exit(1); }
if (how === 'sleep') setTimeout(() => {}, 60000);
else if (how === 'big') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); }
else if (how === 'prompt') { process.stdin.once('data', () => { console.log('got a line'); process.exit(0); }); process.stdin.once('end', () => { console.log('stdin closed'); process.exit(3); }); }
else {
  console.log(`${step}: ok for ${note}`);
  if (step === 'plan') console.log('Would notify: nobody');
  if (step === 'publish' && permalink) console.log(`Live: https://site.example.test${permalink}`);
}
