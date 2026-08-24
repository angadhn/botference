// The "▸ more" marker: how a bot says "the short answer ends here".
//
// A reply in a comment thread is a margin note, and the length instruction on
// every turn says so. But some questions genuinely have a long answer, and the
// old choice was between a wall of text and an answer that stops short. So the
// bots lead with the capped answer and put the rest after ONE marker line:
//
//     the short answer, two or three sentences
//
//     <!--more-->
//
//     the long version, as long as it needs to be
//
// The marker is `<!--more-->` alone on its line (inner spaces and case are
// tolerated). It was chosen because it is inert in every markdown renderer
// there is, every model already knows it from a decade of blog engines, and
// nothing a person would type by accident looks like it. A marker inside a
// fenced code block is CODE, not a marker — the same rule splitEnvelopes
// obeys, and for the same reason: fence ordinals are the Run button's address.
//
// Three copies of this parser exist, byte for byte: here (the companion),
// extension/drawer.js (the drawer) and reader.js (the phone). The extension
// cannot import from the server and the phone's script has no build step, so
// the duplication is the same one normUrl and tagHue carry — and
// test/more.test.mjs pins all three to the same source text and the same
// answers.

// ⟦more⟧ begin — byte-identical in extension/drawer.js and reader.js
var MORE_MARK = /^[ \t]*<!--[ \t]*more[ \t]*-->[ \t]*$/i;
function splitMore(raw) {
  var s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  if (s.indexOf('<!--') === -1) return { head: s, more: '' };
  var lines = s.split('\n');
  var fence = '', at = -1, tail = [];
  for (var i = 0; i < lines.length; i++) {
    var f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1].charAt(0) === fence.charAt(0) && f[1].length >= fence.length) fence = '';
    } else if (!fence && MORE_MARK.test(lines[i])) {
      if (at < 0) at = i;
      continue;
    }
    if (at >= 0) tail.push(lines[i]);
  }
  if (at < 0) return { head: s, more: '' };
  var head = lines.slice(0, at).join('\n').replace(/\s+$/, '');
  var more = tail.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
  if (!head) return { head: more, more: '' };
  return { head: head, more: more };
}
function stripMore(raw) {
  var p = splitMore(raw);
  return p.more ? p.head + '\n\n' + p.more : p.head;
}
// ⟦more⟧ end

export { MORE_MARK, splitMore, stripMore };
