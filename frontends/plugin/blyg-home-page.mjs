// blyg-home-page.mjs — the companion's own page for "Where my blyg lives".
// Owner only (server.mjs GET /blyg-home/page). One small form; its script (under a nonce) reads and
// saves through /blyg-home, which validates everything again. Nothing from the settings is put into
// the markup except through esc().
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
<label for="prepare">Command: prepare (optional)<small>Runs after the note is written and before plan: for a site that must commit the note or fetch what it quotes first. A JSON list with {note}.</small></label>
<input type="text" id="prepare" value="${cmd('prepare')}">
<label for="plan">Command: plan<small>A JSON list, one argument each; {note} becomes the note’s path inside the work tree, as ONE argument. Run in the work tree, never through a shell.</small></label>
<input type="text" id="plan" value="${cmd('plan')}">
<label for="apply">Command: apply</label><input type="text" id="apply" value="${cmd('apply')}">
<label for="publish">Command: publish<small>This is the one that goes live. It runs only after you press Publish on the confirmation.</small></label>
<input type="text" id="publish" value="${cmd('publish')}">
<label for="discard">Command: discard (optional)<small>Undoes what plan staged, when you cancel at the confirmation.</small></label>
<input type="text" id="discard" value="${cmd('discard')}">
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
      var commands={plan:cmd('plan'),apply:cmd('apply'),publish:cmd('publish')};var d=cmd('discard');if(d)commands.discard=d;var pp=cmd('prepare');if(pp)commands.prepare=pp;
      body={settings:{folder:$('folder').value.trim(),filename:$('filename').value.trim(),timezone:$('timezone').value.trim(),escape:$('escape').value,
        template:$('template').value,commands:commands,env_pass:$('env_pass').value.split(/\\s+/).filter(Boolean)}};
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
