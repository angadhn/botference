// blyg-home-page.mjs — the companion's own page for "Where my blyg lives": READ ONLY.
// Owner only, on the machine only (server.mjs GET /blyg-home/page). The setting decides what commands run on this machine, so it is
// never written over HTTP: this page shows whether it is valid, what is set, and the exact CLI lines that change it
// (`botference blyg-home …`). It has NO script and no form (its CSP says script-src 'none'); nothing from the settings is put into
// the markup except through esc().
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The commands the page reports on, in order. */
export const PAGE_COMMANDS = Object.freeze(['check', 'prepare', 'plan', 'apply', 'publish', 'plan_edit', 'apply_edit', 'publish_edit', 'discard', 'abandon', 'link_targets']);

export function blygHomePage({ settings, valid, errors, defaults, nonce }) {
  const s = settings || {};
  const cmds = s.commands && typeof s.commands === 'object' ? s.commands : {};
  const row = (k, v) => `<tr><th scope="row">${esc(k)}</th><td><code>${esc(v)}</code></td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Where my blyg lives</title>
<style nonce="${esc(nonce)}">
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fbfbfa;--mut:#666;--line:#d6d6d2;--bad:#a4262c;--good:#1d6b34}
@media(prefers-color-scheme:dark){:root{--fg:#ececec;--bg:#161616;--mut:#999;--line:#3a3a3a;--bad:#ff8a80;--good:#7bd88f}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.3rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:1.5rem 0 .4rem}p.lead{color:var(--mut);margin:.25rem 0 1.25rem}
.bad{color:var(--bad)}.good{color:var(--good)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.3rem .5rem;border-bottom:1px solid var(--line)}
th{width:11rem;font-weight:600}code,pre{font:13px/1.45 ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
pre{background:transparent;border:1px solid var(--line);border-radius:6px;padding:.6rem .7rem;white-space:pre-wrap}
</style></head><body><main>
<h1>Where my blyg lives</h1>
<p class="lead">The place “Publish as blyg” writes your short posts, and the commands that check and publish them. This page only shows the setting: it decides what runs on this computer, so it is changed only on this computer, with the commands below, never from a web page.</p>
${valid ? '<p id="now" class="good">Valid: Publish as blyg can run.</p>' : `<p id="now" class="bad">Not usable yet: ${esc((errors || []).join('; '))}</p>`}
<h2>What is set</h2>
<table>
${row('notes folder', s.folder || '(not set)')}
${row('file name', s.filename || defaults.filename)}
${row('time zone', s.timezone || '(this computer’s)')}
${row('escaping', s.escape || defaults.escape)}
${row('before it goes live', (s.confirm || defaults.confirm) === 'never' ? 'never ask (one click publishes)' : 'always ask (you see the note and the plan first)')}
${row('plan guard', (s.plan_guard || []).join(' ') || '(none)')}
${row('done marker', s.published_marker || '(none)')}
${row('passed to commands', (s.env_pass || []).join(' ') || '(nothing beyond the minimal environment)')}
${row('preview address', s.preview_url || '(none: no picture of the draft)')}
${row('preview element', s.preview_selector || 'article')}
${row('preview theme attribute', s.preview_theme_attribute || '(none: light)')}
${PAGE_COMMANDS.map(k => row(`command: ${k}`, cmds[k] ? JSON.stringify(cmds[k]) : '(not set)')).join('\n')}
</table>
<h2>To change it</h2>
<p>On this computer, in the same environment the companion is started with:</p>
<pre>botference blyg-home show                 # what is set, and where the file is
botference blyg-home example > blyg-home.json   # a starting point for a Jekyll blog
botference blyg-home check blyg-home.json # validate a file and print every problem
botference blyg-home set blyg-home.json   # validate, then write it (refused while a run is under way)
botference blyg-home links                # run the link_targets command: the published posts a /tk passage may link to</pre>
<p class="lead">A change takes effect for the next run; a run that is under way stops before its next step if the setting changed.</p>
</main></body></html>`;
}
