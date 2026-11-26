// hands.test.mjs — the owner's hand on an agent's passage (tkgaps.mjs OWNER_HANDS): rewording a prompt, editing its text.
//
//   node --test test/hands.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../tkgaps.mjs';

// THE OWNER'S HAND on a passage (OWNER_HANDS: none | prompt | text | both), one field `hand`, moved only by handMove (a part is added,
// never removed). Rewording: the owner changed a written passage's instruction (same place, same agent), so the agent writes again.
test('the owner\'s hand: a reworded prompt adds `prompt`, an edit of the text adds `text`; asking again or a first prompt adds nothing', () => {
  assert.deepEqual(T.OWNER_HANDS, ['none', 'prompt', 'text', 'both']);
  assert.equal(T.handMove('none', 'prompt'), 'prompt');
  assert.equal(T.handMove('text', 'prompt'), 'both');
  assert.equal(T.handMove('both', 'text'), 'both');
  assert.throws(() => T.handMove('both', 'none'), /adding a part/);
  assert.equal(T.handOf({ mode: 'edited-by-reader' }), 'text', 'a gap from before the field: as it always read');
  assert.equal(T.handOf({ mode: 'filled-by-agent' }), 'none');
  const first = T.buildGaps('Intro /tk(explain it) end.', []).gaps;
  assert.equal(T.handOf(first[0]), 'none', 'a first prompt is not a rewording');
  T.gapMove(first[0], 'filled-by-agent', { text: 'Answer.', agent: 'claude', at: '2026-01-01T00:00:00Z' });
  const same = T.buildGaps('Intro edited /tk(explain it) end.', first).gaps;
  assert.equal(same[0].mode, 'filled-by-agent', 'same words: kept as it was');
  assert.equal(T.handOf(same[0]), 'none');
  const reworded = T.buildGaps('Intro /tk(explain it more plainly) end.', first);
  assert.equal(reworded.gaps[0].mode, 'pending', 'the agent writes again');
  assert.equal(reworded.gaps[0].hand, 'prompt');
  assert.equal(reworded.fresh.length, 1);
  // a written passage whose text the owner edited, then reworded: both
  const ed = T.buildGaps('Intro /tk(explain it) end.', []).gaps;
  T.gapMove(ed[0], 'filled-by-agent', { text: 'Answer.', agent: 'claude', at: '2026-01-01T00:00:00Z' });
  T.gapMove(ed[0], 'edited-by-reader', { text: 'Mine.' });
  assert.equal(ed[0].hand, 'text');
  assert.equal(T.buildGaps('Intro /tk(explain it again) end.', ed).gaps[0].hand, 'both');
  // never answered (pending or failed): rewording it is a first prompt still; another agent at that place is a new passage
  const pend = T.buildGaps('Intro /tk(explain it) end.', []).gaps;
  assert.equal(T.handOf(T.buildGaps('Intro /tk(explain it better) end.', pend).gaps[0]), 'none');
  assert.equal(T.handOf(T.buildGaps('Intro /tk-codex(explain it more) end.', first).gaps[0]), 'none');
  // the agent writing again (pending → filled) keeps the hand
  const g = reworded.gaps[0];
  T.gapMove(g, 'filled-by-agent', { text: 'New answer.', agent: 'claude', at: '2026-01-02T00:00:00Z' });
  assert.equal(g.hand, 'prompt');
  T.gapMove(g, 'pending');
  assert.equal(g.hand, 'prompt', 'write again: the hand stays');
});
