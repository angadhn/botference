# Task 8 Summary — "New messages" indicator when scrolled up

## What was done
Added a "↓ new" badge to the pane title when the user is scrolled up and new messages have arrived since they last saw the bottom.

## Files changed
- `ink-ui/src/layout.ts` — Extended `truncateTitle` with optional `badge` parameter. When space is tight, badge takes priority over scroll indicator (scroll indicator dropped first to preserve title readability).
- `ink-ui/src/layout.test.ts` — Added 4 new badge tests: both fit, drop scroll for badge, truncate title with badge, no badge when undefined.
- `ink-ui/src/App.tsx` — Added `lastSeenRoomCount`/`lastSeenCaucusCount` state tracking (resets to current entry count when scroll returns to 0). Computed `roomHasNew`/`caucusHasNew` flags. Passed `hasNewMessages` prop to `Pane`. Pane passes `" ↓ new"` badge to `truncateTitle` when flag is true.

## Test results
- 18/18 layout tests pass (4 new badge tests)
- tsc clean (0 errors)
- 205/205 Python tests pass (no regression)

## Commit
`45a1f86` — feat: show new-messages indicator when scrolled up in pane title
