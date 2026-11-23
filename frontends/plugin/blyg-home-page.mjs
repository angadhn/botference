// blyg-home-page.mjs — the companion's own page for "Where my blyg lives".
// Owner only (server.mjs GET /blyg-home/page). One small form; its script (under a nonce) reads and
// saves through /blyg-home, which validates everything again. Nothing from the settings is put into
// the markup except through esc(). A save REPLACES the whole setting (storable keeps only what is sent), so the form has a field for
// every stored key (FORM_KEYS, checked by a test against blyg-home.mjs storable) and sends them all: a key the form left out would
// be silently dropped by the first save from this page.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The stored keys this form edits and sends (a test holds it equal to what blyg-home.mjs `storable` keeps). */
export const FORM_KEYS = Object.freeze(['folder', 'filename', 'template', 'escape', 'timezone', 'env_pass', 'commands', 'confirm', 'plan_guard', 'published_marker']);
/** The commands it has a field for (all of blyg-home.mjs COMMAND_KEYS). */
export const FORM_COMMANDS = Object.freeze(['check', 'prepare', 'plan', 'apply', 'publish', 'discard', 'abandon']);

export function blygHomePage({ settings, errors, defaults, nonce }) {
  const s = settings || {};
  const cmd = k => esc(s.commands && s.commands[k] ? JSON.stringify(s.commands[k]) : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Where my blyg lives</title>
<style nonce="${esc(nonce)}">
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fbfbfa;--mut:#666;--line:#d6d6d2;--bad:#a4262c}
@media(prefers-color-scheme:dark){:root{--fg:#ececec;--bg:#161616;--mut:#999;--line:#3a3a3a;--bad:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.3rem;margin:0 0 .25rem}p.lead{color:var(--mut);margin:.25rem 0 1.25rem}
label{display:block;font-weight:600;margin:1.1rem 0 .2rem}small{display:block;color:var(--mut);font-weight:400}
input[type=text],textarea,select{width:100%;box-sizing:border-box;padding:.45rem .55rem;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:13px/1.45 ui-monospace,Menlo,monospace}
textarea{min-height:9rem}
button{margin-top:1.25rem;padding:.5rem 1rem;border-radius:6px;border:1px solid var(--line);background:var(--fg);color:var(--bg);font:inherit;cursor:pointer}
#out{margin-top:1rem;white-space:pre-wrap}#out.bad{color:var(--bad)}
</style></head><body><main>
<h1>Where my blyg lives</h1>
<p class="lead">The place “Publish as blyg” writes your short posts, and the commands that check and publish them. Nothing is run until all of this is set. Only you can change it, and only from here.</p>
${errors && errors.length ? `<p id="now" class="bad" style="color:var(--bad)">Not usable yet: ${esc(errors.join('; '))}</p>` : '<p id="now">Valid.</p>'}
<form id="f" autocomplete="off">
<label for="folder">Notes folder<small>An absolute path to a folder that exists, inside a git work tree.</small></label>
<input type="text" id="folder" value="${esc(s.folder || '')}">
<label for="filename">File name<small>Placeholders: \${slug} and \${date}. Must contain \${slug} and end in .md.</small></label>
<input type="text" id="filename" value="${esc(s.filename || defaults.filename)}">
<label for="timezone">Time zone for dates<small>An IANA name such as Europe/London. Empty means this computer’s.</small></label>
<input type="text" id="timezone" value="${esc(s.timezone || '')}">
<label for="escape">Escaping in the body<select id="escape">${['liquid', 'none'].map(v => `<option value="${v}"${(s.escape || defaults.escape) === v ? ' selected' : ''}>${v === 'liquid' ? 'liquid (a Jekyll site: {{ }} and {% %} are made inert)' : 'none (the site is not Jekyll)'}</option>`).join('')}</select></label>
<label for="template">Front matter template<small>Lines of “key: value”. Placeholders: \${title} (a quoted string, as the whole value), \${created}, \${released}, \${slug}, and \${blyg_keys} on a line of its own (the quote’s sources and the post it responds to).</small></label>
<textarea id="template">${esc(s.template || defaults.template)}</textarea>
<label for="check">Command: check (optional)<small>The pre-flight: runs once before anything is written, and its own words refuse the start if the environment is not ready. A JSON list, no {note} (example: ["scripts/blyg-publish", "--preflight"]).</small></label>
<input type="text" id="check" value="${cmd('check')}">
<label for="prepare">Command: prepare (optional)<small>Runs after the note is written and before plan: for a site that must commit the note or fetch what it quotes first. A JSON list with {note}.</small></label>
<input type="text" id="prepare" value="${cmd('prepare')}">
<label for="plan">Command: plan<small>A JSON list, one argument each; {note} becomes the note’s path inside the work tree, as ONE argument. Run in the work tree, never through a shell.</small></label>
<input type="text" id="plan" value="${cmd('plan')}">
<label for="apply">Command: apply</label><input type="text" id="apply" value="${cmd('apply')}">
<label for="publish">Command: publish<small>This is the one that goes live: right after apply when you never ask, otherwise only after you press Publish on the confirmation.</small></label>
<input type="text" id="publish" value="${cmd('publish')}">
<label for="discard">Command: discard (optional; needed with prepare)<small>Undoes what prepare or plan did, when you cancel, or abandon a run before apply.</small></label>
<input type="text" id="discard" value="${cmd('discard')}">
<label for="abandon">Command: abandon (optional)<small>Your site's own way to end a run that stopped after apply, when you press Abandon. A JSON list with {note}.</small></label>
<input type="text" id="abandon" value="${cmd('abandon')}">
<label for="published_marker">Done marker (optional)<small>The last “State:” line the publish command prints when it is really finished (example: State: merged_back). With it, a publish that exits 0 without it counts as failed.</small></label>
<input type="text" id="published_marker" value="${esc(s.published_marker || '')}">
<label for="confirm">Before it goes live<select id="confirm">${(defaults.confirms || ['never', 'always']).map(v => `<option value="${v}"${(s.confirm || defaults.confirm) === v ? ' selected' : ''}>${v === 'never' ? 'never ask: choosing Publish as blyg is the publish' : 'always ask: show the note and the plan first, then wait for a Publish click'}</option>`).join('')}</select></label>
<label for="plan_guard">Plan guard flags (optional)<small>Flags added to the plan, apply and publish commands when you never ask, so your site's own command can refuse a plan that would change or publish more than this one note. One per line, each starting with “-”.</small></label>
<textarea id="plan_guard" style="min-height:3.5rem">${esc((s.plan_guard || []).join('\n'))}</textarea>
<label for="env_pass">Environment names to pass on (optional)<small>Upper-case names, one per line. A command gets only PATH, HOME, USER, LOGNAME, LANG, LC_ALL, TMPDIR and a few fixed variables, plus these.</small></label>
<textarea id="env_pass" style="min-height:3.5rem">${esc((s.env_pass || []).join('\n'))}</textarea>
<button type="submit">Save</button>
</form>
<div id="out" role="status"></div>
</main>
<script nonce="${esc(nonce)}">
(function(){
  var $=function(i){return document.getElementById(i)};
  function cmd(i){var v=$(i).value.trim();if(!v)return undefined;return JSON.parse(v)}
  $('f').addEventListener('submit',function(e){
    e.preventDefault();var out=$('out');out.className='';out.textContent='Saving…';
    var body;
    try{
      var commands={plan:cmd('plan'),apply:cmd('apply'),publish:cmd('publish')};['check','prepare','discard','abandon'].forEach(function(k){var v=cmd(k);if(v)commands[k]=v});
      body={settings:{folder:$('folder').value.trim(),filename:$('filename').value.trim(),timezone:$('timezone').value.trim(),escape:$('escape').value,confirm:$('confirm').value,plan_guard:$('plan_guard').value.split(/\\s+/).filter(Boolean),
        template:$('template').value,commands:commands,env_pass:$('env_pass').value.split(/\\s+/).filter(Boolean),published_marker:$('published_marker').value.trim()}};
    }catch(err){out.className='bad';out.textContent='A command is not a JSON list: '+err.message;return}
    fetch('/blyg-home',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json()}).then(function(j){
        if(j&&j.ok){out.textContent='Saved. Publish as blyg is ready.';$('now').textContent='Valid.';$('now').style.color=''}
        else{out.className='bad';out.textContent=((j&&j.errors)||[(j&&j.error)||'not saved']).join('\\n')}
      }).catch(function(){out.className='bad';out.textContent='Could not reach the companion.'});
  });
})();
</script></body></html>`;
}
