// supersede.test.mjs — an edit sets aside what follows only when someone else (a bot, a tool summary, another person) answered the
// old wording; the owner's own later comments are kept; what was set aside before is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { supersedeAfter } from '../store.mjs';

const m = (author, ts, extra = {}) => ({ author, ts, text: `${author} ${ts}`, ...extra });

test('only the owner\'s own words after the edited one: nothing is set aside', () => {
  const list = [m('owner', '1'), m('owner', '2'), m('owner', '3')];
  assert.equal(supersedeAfter(list, list[0]), 0);
  assert.ok(list.every(x => !x.superseded));
});

test('a bot answered after it: everything after is set aside, as before (the owner\'s later words too)', () => {
  const list = [m('owner', '1'), m('owner', '2'), m('claude', '3'), m('owner', '4')];
  assert.equal(supersedeAfter(list, list[0]), 3);
  assert.deepEqual(list.map(x => x.superseded || ''), ['', '1', '1', '1']);
});

test('a tool summary in the owner\'s name, or another person, counts as an answer', () => {
  const a = [m('owner', '1'), m('owner', '2', { kind: 'tools' })];
  assert.equal(supersedeAfter(a, a[0]), 1);
  const b = [m('owner', '1'), m('ada', '2')];
  assert.equal(supersedeAfter(b, b[0]), 1);
});

test('messages set aside earlier are not touched and do not count', () => {
  const list = [m('owner', '1'), m('codex', '2', { superseded: '0' }), m('owner', '3')];
  assert.equal(supersedeAfter(list, list[0]), 0, 'the only bot message was set aside already');
  assert.equal(list[1].superseded, '0');
  const two = [m('owner', '1'), m('codex', '2', { superseded: '0' }), m('claude', '3')];
  assert.equal(supersedeAfter(two, two[0]), 1);
  assert.deepEqual(two.map(x => x.superseded || ''), ['', '0', '1']);
});

test('the last message, or one not in the list: nothing', () => {
  const list = [m('claude', '0'), m('owner', '1')];
  assert.equal(supersedeAfter(list, list[1]), 0);
  assert.equal(supersedeAfter(list, m('owner', '9')), 0);
});
