// card-modes.js — the one list of modes a suggestion card can be in, and the
// moves between them. Shared by the server (apply.mjs, which keeps each
// card's mode in state/apply.json) and the page (review.js, which draws the
// card from that mode and greys out any button whose move would be refused).
//
//   pending    nobody has decided yet
//   accepted   accepted, not yet written into the source
//   rejected   rejected
//   flagged    accepted, but the edit could not be placed (the reason is kept)
//   applied    written into the source, not yet committed
//   committed  in git; nothing moves it any more
//
// `applied -> rejected` is deliberately missing: an edit that is already in
// the source has to be reverted (which moves it back to `accepted`) before it
// can be rejected — otherwise a rejected change could ride into the commit.
// UMD-lite like span-match.js: `module.exports` under node, `window.CardModes`
// in the page.
(function (root) {
  'use strict';
  const CARD_MODES = Object.freeze(['pending', 'accepted', 'rejected', 'flagged', 'applied', 'committed']);
  const CARD_MOVES = Object.freeze({
    pending: Object.freeze(['accepted', 'rejected']),
    accepted: Object.freeze(['pending', 'rejected', 'flagged', 'applied']),
    rejected: Object.freeze(['pending', 'accepted']),
    flagged: Object.freeze(['pending', 'accepted', 'rejected', 'flagged', 'applied']),
    applied: Object.freeze(['committed', 'accepted']),   // accepted = the round was reverted
    committed: Object.freeze([]),
  });
  // what a person's accept / reject / reset button reads each mode as
  const DECISION_OF_MODE = Object.freeze({
    pending: 'pending', accepted: 'accepted', rejected: 'rejected',
    flagged: 'accepted', applied: 'accepted', committed: 'accepted',
  });
  const canMove = (from, to) => from === to || (CARD_MOVES[from] || []).includes(to);
  // can a person's decision button take a card in `mode` to `decision`?
  // Asking for the decision the card already carries is a harmless no-op.
  const decisionAllowed = (mode, decision) =>
    DECISION_OF_MODE[mode] === decision || (CARD_MOVES[mode] || []).includes(decision);
  const api = { CARD_MODES, CARD_MOVES, DECISION_OF_MODE, canMove, decisionAllowed };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardModes = api;
})(typeof window !== 'undefined' ? window : globalThis);
