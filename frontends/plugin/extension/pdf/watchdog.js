// The viewer's own script is an ES module: if it, or the PDF engine it
// imports (vendor/pdfjs/build/), fails to load, NOTHING in it runs — so it
// cannot say so, and the page sat on "Loading…" for ever. This plain script
// has no imports, so it always runs: if the title has not moved after a few
// seconds and nothing has been said, it says what happened and offers the
// file itself. viewer.js sets the title within its first few lines, so a
// slow PDF never trips this.
setTimeout(function () {
  var title = document.getElementById('doc-title');
  var note = document.getElementById('notice');
  if (!title || title.textContent !== 'Loading…' || (note && !note.hidden)) return;
  var src = new URLSearchParams(location.search).get('src') || '';
  title.textContent = 'Could not start the viewer';
  if (!note) return;
  note.textContent = 'The Botference PDF viewer did not start: part of the extension is missing or failed to load '
    + '(reinstall or update the extension folder, then reload it). ';
  if (/^(https?|file):/i.test(src)) {
    var a = document.createElement('a');
    a.href = src; a.textContent = 'Open the PDF in the browser instead.';
    note.appendChild(a);
  }
  note.hidden = false;
}, 4000);
