// sites.test.mjs — a site of the reader's own, made by the bots (sites.mjs).
//
//   node frontends/plugin/test/sites.test.mjs
//
// Two things are under test and they are separate things:
//
//   1. THE GATE. Which commands may run in a site folder, decided on the parsed
//      argument vector. This is a table, and it is written as a table on
//      purpose: every row is a command somebody will one day type, and the
//      denials matter more than the allowances.
//   2. THE REGISTRATION. A folder that has become a real site — a git repo with
//      an origin remote and a host that can serve it — becomes a publish target
//      at turn-end, once, and never overwrites one that is already there.
//
// Everything runs against a THROWAWAY root: BOTFERENCE_PROJECT_ROOT is set to a
// temp directory before store.mjs is ever imported, so the developer's own
// config.json is never read and never written. No git, no gh, no netlify and no
// network is used anywhere in this file — the fixtures are hand-written
// `.git/config` and `.netlify/state.json` files, which is all the code reads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-sites-'));
process.env.BOTFERENCE_PROJECT_ROOT = TMP;
process.env.PLUGIN_OWNER_PASSWORD = '';

const sites = await import('../sites.mjs');
const store = await import('../store.mjs');

let pass = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) {
    failures.push(`${name}: ${e && e.message}`);
    console.log(`  ✗ ${name}\n      ${e && e.message}`);
  }
}

// --- fixtures -------------------------------------------------------------

const ROOT = path.join(TMP, 'council');
const SITES = path.join(ROOT, 'sites');
fs.mkdirSync(SITES, { recursive: true });

/** A repo, as the three files this code actually reads. */
function repo(dir, { origin = 'git@github.com:angadhn/thing.git', netlify = '', pages = '' } = {}) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'),
    `[core]\n\tbare = false\n${origin ? `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*\n` : ''}`);
  if (netlify) {
    fs.mkdirSync(path.join(dir, '.netlify'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.netlify', 'state.json'), JSON.stringify({ siteId: netlify }));
  }
  if (pages === 'cname') fs.writeFileSync(path.join(dir, 'CNAME'), 'lff.angadh.com\n');
  if (pages === 'docs') fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  if (pages === 'branch') {
    fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'gh-pages'), '0'.repeat(40) + '\n');
  }
  return dir;
}

// The reader's own blog: a publish target in config.json, with a Netlify site
// id and a GitHub slug of its own. Nothing the bots run may name any of them.
const BLOG = path.join(TMP, 'MySite');
const BLOG_SITE_ID = '3abf5bf5-fcb0-4bbf-af48-63302f135a06';
repo(BLOG, { origin: 'git@github.com:angadhn/MySite.git', netlify: BLOG_SITE_ID });
store.saveConfig({
  publish: { site: { repo: BLOG, dir: 'lff', url: 'https://angadh.com/lff/', branch: 'main' } },
});

const LFF = repo(path.join(SITES, 'lff'), { origin: 'https://github.com/angadhn/lff.git', netlify: 'aaaa1111-2222-3333-4444-555566667777' });
const PROTECT = () => sites.protectedTokens(SITES);

// --- 1. the gate ----------------------------------------------------------

console.log('\nsites — the command gate');

const decide = (command, cwd = LFF) =>
  sites.commandDecision({ tool: 'Bash', command, cwd, sites: SITES, protect: PROTECT() });

const allows = (name, command, cwd) => t(name, () => {
  const d = decide(command, cwd);
  assert.equal(d.allow, true, `refused: ${d.why}`);
});
const refuses = (name, command, cwd) => t(name, () => {
  const d = decide(command, cwd);
  assert.equal(d.allow, false, 'it was ALLOWED, and should not have been');
  assert.equal(d.kind, 'command');
  assert.ok(d.why, 'a refusal says why — it is posted into the thread');
});

allows('git init', 'git init -b main');
allows('git add and commit', 'git commit -m "the page"');
allows('git push', 'git push origin HEAD:main');
allows('git remote add origin', 'git remote add origin https://github.com/angadhn/lff.git');
refuses('a force push', 'git push --force origin main');
refuses('a short force push', 'git push -f origin main');
refuses('a force-with-lease push', 'git push --force-with-lease origin main');
refuses('a `+` refspec, which is a force push wearing a hat', 'git push origin +main:main');
refuses('a mirror push', 'git push --mirror origin');
refuses('deleting a remote branch', 'git push origin --delete main');
refuses('git pointed at another repository', 'git -C /Users/angadhnanjangud/elsewhere push');
refuses('a global -c before the subcommand', 'git -c push.default=matching push --force');

allows('gh repo create, private', 'gh repo create angadhn/lff --private --source . --push');
refuses('gh repo create, public', 'gh repo create angadhn/lff --public --source . --push');
refuses('gh repo create with no --private at all', 'gh repo create angadhn/lff --source . --push');
refuses('gh repo create, internal', 'gh repo create angadhn/lff --internal --source .');
refuses('gh repo create --source pointing out of the folder', 'gh repo create angadhn/lff --private --source ../..');
allows('gh repo view', 'gh repo view angadhn/lff --json url');
refuses('gh repo delete', 'gh repo delete angadhn/lff --yes');
allows('gh api on the Pages endpoint', 'gh api -X POST repos/angadhn/lff/pages -f "source[branch]=main"');
allows('gh api reading the Pages settings', 'gh api repos/angadhn/lff/pages');
refuses('gh api anywhere else', 'gh api repos/angadhn/lff/collaborators');
refuses('gh api user', 'gh api user');
refuses('gh api DELETE, even on pages', 'gh api -X DELETE repos/angadhn/lff/pages');
refuses('gh secret', 'gh secret set TOKEN --body x');

allows('netlify sites:create', 'netlify sites:create --name lff --account-slug angadhn');
allows('netlify link', 'netlify link --id aaaa1111-2222-3333-4444-555566667777');
allows('netlify deploy', 'netlify deploy --prod --dir .');
allows('netlify status', 'netlify status');
allows('netlify api updateSite, setting the custom domain',
  'netlify api updateSite --data \'{"site_id":"aaaa1111-2222-3333-4444-555566667777","body":{"custom_domain":"lff.angadh.com"}}\'');
allows('netlify api getSite', 'netlify api getSite --data \'{"site_id":"aaaa1111-2222-3333-4444-555566667777"}\'');
allows('netlify api createSiteInTeam', 'netlify api createSiteInTeam --data \'{"account_slug":"angadhn"}\'');
refuses('netlify env:set', 'netlify env:set KEY value');
refuses('netlify env:list', 'netlify env:list');
refuses('netlify sites:delete', 'netlify sites:delete --site-id aaaa1111-2222-3333-4444-555566667777');
refuses('netlify api deleteSite', 'netlify api deleteSite --data \'{"site_id":"x"}\'');
refuses('netlify unlink', 'netlify unlink');
refuses('netlify deploy from somewhere else on the disk', 'netlify deploy --prod --dir /Users/angadhnanjangud/MySite');

t('the reader\'s own Netlify site id is refused wherever it appears', () => {
  const d = decide(`netlify api updateSite --data '{"site_id":"${BLOG_SITE_ID}","body":{"custom_domain":"x.angadh.com"}}'`);
  assert.equal(d.allow, false);
  assert.match(d.why, /off limits/);
});
t('…and so is the reader\'s own repo, by name', () => {
  assert.equal(decide('gh repo view angadhn/MySite').allow, false);
  assert.equal(decide('gh repo create angadhn/MySite --private').allow, false);
});
t('…and by path', () => {
  assert.equal(decide(`git push ${BLOG} main`).allow, false);
});

refuses('rm -rf, which is on no list at all', 'rm -rf /Users/angadhnanjangud/MySite');
refuses('rm -rf inside the folder either — it is not an allowed verb', 'rm -rf .');
refuses('curl', 'curl https://example.com -o page.html');
refuses('a shell pipeline', 'git status | tee /tmp/x');
refuses('a command substitution', 'gh repo create angadhn/$(whoami) --private');
refuses('a backtick', 'gh repo view `cat /etc/passwd`');
refuses('a semicolon', 'git status; rm -rf .');
refuses('a redirect', 'git status > /Users/angadhnanjangud/out.txt');
refuses('an unterminated quote — unparseable is denied', 'gh repo create "angadhn/lff --private');

t('a cwd outside the sites folder is refused however ordinary the command', () => {
  const d = decide('git status', path.join(ROOT, 'projects', 'spaceship'));
  assert.equal(d.allow, false);
  assert.match(d.why, /may only run inside/);
});
t('…and the sites folder ITSELF is not a site', () => {
  assert.equal(decide('git status', SITES).allow, false);
});
t('a relative cwd is refused', () => {
  assert.equal(decide('git status', 'sites/lff').allow, false);
});

t('with no cwd the command must cd into the site folder first', () => {
  assert.equal(decide('git status', '').allow, false, 'nowhere to run');
  const d = sites.commandDecision({ tool: 'Bash', command: `cd ${LFF} && git push origin HEAD:main`,
    cwd: '', sites: SITES, protect: PROTECT() });
  assert.equal(d.allow, true, d.why);
});
t('…and a cd somewhere else does not become a way in', () => {
  const d = sites.commandDecision({ tool: 'Bash', command: `cd ${BLOG} && git push origin HEAD:main`,
    cwd: '', sites: SITES, protect: PROTECT() });
  assert.equal(d.allow, false);
});
t('…nor does a cd back out half way through', () => {
  const d = decide(`git status && cd ${path.join(ROOT, 'projects')} && git push origin main`);
  assert.equal(d.allow, false);
});
t('every step of an && chain is checked, not just the first', () => {
  assert.equal(decide('git add -A && git commit -m x && git push --force origin main').allow, false);
  assert.equal(decide('git add -A && git commit -m x && git push origin HEAD:main').allow, true);
});

t('a request with no command at all is not a command request, and stays denied', () => {
  const d = sites.commandDecision({ tool: 'Write', command: '', cwd: LFF, sites: SITES });
  assert.equal(d.allow, false);
  assert.equal(d.kind, 'other', 'so the companion keeps its own words for a write request');
});
t('a lane with no sites folder allows nothing', () => {
  const d = sites.commandDecision({ tool: 'Bash', command: 'git status', cwd: LFF, sites: '' });
  assert.equal(d.allow, false);
});

// --- 2. the parser --------------------------------------------------------

console.log('\nsites — the parser');

t('quotes hold a JSON body together as ONE argument', () => {
  assert.deepEqual(sites.splitArgv('netlify api updateSite --data \'{"a":"b c"}\''),
    ['netlify', 'api', 'updateSite', '--data', '{"a":"b c"}']);
});
t('double quotes with escapes do too', () => {
  assert.deepEqual(sites.splitArgv('git commit -m "a \\"quoted\\" title"'),
    ['git', 'commit', '-m', 'a "quoted" title']);
});
t('&& is its own token', () => {
  assert.deepEqual(sites.splitArgv('a && b'), ['a', '&&', 'b']);
});
t('a lone & is not readable', () => assert.equal(sites.splitArgv('git push &'), null));
t('a newline is not readable', () => assert.equal(sites.splitArgv('git status\nrm -rf .'), null));
t('nothing is not a command', () => assert.equal(sites.splitArgv('   '), null));

// --- 3. registering a target ---------------------------------------------

console.log('\nsites — the target that appears when the site does');

t('the domain comes from the reader\'s existing publish target', () => {
  assert.equal(sites.sitesDomain(ROOT), 'angadh.com');
});

t('a Netlify-linked site becomes a publish target, once', () => {
  const added = sites.registerSiteTargets(ROOT);
  assert.deepEqual(added, ['lff']);
  const t0 = store.readConfig().publish.lff;
  assert.equal(t0.repo, LFF);
  assert.equal(t0.dir, '.');
  assert.equal(t0.file, 'index.html');
  assert.equal(t0.url, 'https://lff.angadh.com/');
  assert.equal(t0.branch, 'main');
  assert.equal(t0.push, true);
  assert.deepEqual(t0.deploy, ['netlify', 'deploy', '--prod', '--dir', '.'],
    'netlify deploys from this machine, so a private repo is never handed to a host');
  assert.equal(store.readConfig().publish.site.repo, BLOG,
    'and the flat single target the reader already had became the map entry "site", untouched');
  assert.deepEqual(sites.registerSiteTargets(ROOT), [], 'a second turn adds nothing');
});

t('a GitHub Pages site gets the same target with NO deploy — the push is the deploy', () => {
  repo(path.join(SITES, 'notes'), { origin: 'git@github.com:angadhn/notes.git', pages: 'cname' });
  assert.deepEqual(sites.registerSiteTargets(ROOT), ['notes']);
  const t0 = store.readConfig().publish.notes;
  assert.equal(t0.url, 'https://notes.angadh.com/');
  assert.equal(t0.deploy, undefined);
  assert.equal(t0.push, true);
});

t('docs/ and a gh-pages branch count as Pages too', () => {
  repo(path.join(SITES, 'docsy'), { origin: 'git@github.com:angadhn/docsy.git', pages: 'docs' });
  repo(path.join(SITES, 'branchy'), { origin: 'git@github.com:angadhn/branchy.git', pages: 'branch' });
  assert.deepEqual(sites.registerSiteTargets(ROOT).sort(), ['branchy', 'docsy']);
});

t('a target that is already there is NEVER overwritten', () => {
  store.saveConfig({ publish: { ...store.readConfig().publish,
    lff: { repo: LFF, dir: '.', file: 'index.html', url: 'https://films.angadh.com/', branch: 'trunk', push: false } } });
  assert.deepEqual(sites.registerSiteTargets(ROOT), []);
  const t0 = store.readConfig().publish.lff;
  assert.equal(t0.url, 'https://films.angadh.com/', 'the reader\'s own edit stands');
  assert.equal(t0.branch, 'trunk');
  assert.equal(t0.push, false);
});

t('a folder that is not finished is not a site', () => {
  fs.mkdirSync(path.join(SITES, 'half'), { recursive: true });
  fs.writeFileSync(path.join(SITES, 'half', 'index.html'), '<h1>draft</h1>');
  assert.equal(sites.discoverSites(ROOT).some(s => s.name === 'half'), false,
    'no git repo, no remote, no host — nothing to publish to');
  repo(path.join(SITES, 'nohost'), { origin: 'git@github.com:angadhn/nohost.git' });
  assert.equal(sites.discoverSites(ROOT).some(s => s.name === 'nohost'), false,
    'a repo with a remote but no host has no address yet');
  repo(path.join(SITES, 'noremote'), { origin: '', netlify: 'bbbb-1111' });
  assert.equal(sites.discoverSites(ROOT).some(s => s.name === 'noremote'), false,
    'and one with no origin has nowhere to push');
});

t('a name that is not a name is not a site', () => {
  repo(path.join(SITES, 'Not_A_Name'), { origin: 'git@github.com:angadhn/x.git', netlify: 'cccc-1111' });
  assert.equal(sites.discoverSites(ROOT).some(s => s.name === 'Not_A_Name'), false,
    'a site name is a DNS label: lowercase, digits, hyphens');
});

t('a site of the reader\'s own is not protected from itself', () => {
  const p = PROTECT();
  assert.ok(!p.some(x => x.includes(`${path.sep}sites${path.sep}`)),
    `a registered site must stay deployable — got ${JSON.stringify(p)}`);
  assert.equal(decide('netlify deploy --prod --dir .').allow, true);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* a temp dir */ }

console.log(`\nsites: ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
