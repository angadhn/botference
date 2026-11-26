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
  assert.throws(() => T.handMove('both', 'none'), /no such move/);
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

// REVIEW: a fresh answer from the agent (Write again) drops the text part and keeps the prompt part; rewording is decided only after
// every exact match is made, and only when it cannot be ambiguous; a change of spaces only is not a rewording.
const answer = g => T.gapMove(g, 'filled-by-agent', { text: 'Fresh.', agent: g.agent, model: 'm', at: '2026-11-26T11:00:00Z' });
const filledFrom = text => T.buildGaps(text, []).gaps.map(g => (g.mode === 'pending' ? answer(g) : g));
const hands = (text, prior) => T.buildGaps(text, prior).gaps.map(g => [g.instruction, T.handOf(g)]);

test('a fresh answer from the agent drops `text` and keeps `prompt`; the moves are named and anything else refused', () => {
  assert.equal(T.handMove('both', 'fresh'), 'prompt');
  assert.equal(T.handMove('text', 'fresh'), 'none');
  assert.equal(T.handMove('prompt', 'fresh'), 'prompt');
  assert.equal(T.handMove('none', 'fresh'), 'none');
  assert.throws(() => T.handMove('both', 'none'), /no such move/);
  // edit the text, then Write again: the robot alone
  const e = filledFrom('/tk-claude explain rockets\n');
  T.gapMove(e[0], 'edited-by-reader', { text: 'mine' });
  assert.equal(T.handOf(e[0]), 'text');
  T.gapMove(e[0], 'pending');
  answer(e[0]);
  assert.equal(T.handOf(e[0]), 'none');
  // reword, edit the text, Write again: "prompt reworded" only
  const r = T.buildGaps('/tk-claude explain rockets briefly\n', filledFrom('/tk-claude explain rockets\n')).gaps;
  answer(r[0]);
  T.gapMove(r[0], 'edited-by-reader', { text: 'mine' });
  assert.equal(T.handOf(r[0]), 'both');
  T.gapMove(r[0], 'pending');
  answer(r[0]);
  assert.equal(T.handOf(r[0]), 'prompt');
});

test('rewording is decided after every exact match: a new prompt inserted is never a rewording; an ambiguous edit is none', () => {
  const A = filledFrom('Intro.\n/tk-claude explain rockets\n');
  assert.deepEqual(hands('Intro.\n/tk-claude list moons\n/tk-claude explain rockets\n', A), [['list moons', 'none'], ['explain rockets', 'none']], '[A] → [X, A]');
  const AB = filledFrom('/tk-claude A one\n/tk-claude B two\n');
  assert.deepEqual(hands('/tk-claude A one\n/tk-claude X new\n/tk-claude B two\n', AB), [['A one', 'none'], ['X new', 'none'], ['B two', 'none']], '[A,B] → [A,X,B]');
  assert.deepEqual(hands('/tk-claude A one, reworded\n/tk-claude B two\n', AB), [['A one, reworded', 'prompt'], ['B two', 'none']], "[A,B] → [A',B]");
  assert.deepEqual(hands('/tk-claude B two\n/tk-claude A one, reworded\n', AB), [['B two', 'none'], ['A one, reworded', 'prompt']], "[A,B] → [B,A']");
  assert.deepEqual(hands('/tk-claude explain rockets more\n/tk-claude list moons\n', A), [['explain rockets more', 'none'], ['list moons', 'none']], "[A] → [A', X]: ambiguous, none");
  assert.deepEqual(hands('/tk-claude A one, reworded\n/tk-claude B two, reworded\n', AB).map(x => x[1]), ['none', 'none'], 'two left unclaimed: ambiguous');
  assert.deepEqual(hands('/tk-claude B two\n', AB), [['B two', 'none']], 'a deletion is not a rewording');
  assert.deepEqual(hands('Intro.\n/tk-codex explain rockets\n', A), [['explain rockets', 'none']], 'another agent');
  assert.deepEqual(hands('Intro.\n/tk-claude explain  rockets\n', A), [['explain  rockets', 'none']], 'spaces only: not a rewording');
});
