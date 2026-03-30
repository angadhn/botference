# Implementation Plan — Fix Ink TUI Scroll Overflow & Layout Breakage

**Thread:** fix-ink-scroll-overflow
**Created:** 2026-03-28
**Architecture:** serial
**Autonomy:** autopilot

## Problem

The Ink TUI (`ink-ui/src/App.tsx`) has four compounding layout bugs that cause text to overflow from one pane into another when scrolling or receiving long messages:

1. **`overflow="hidden"` doesn't clip in Ink 6** — Yoga layout doesn't enforce pixel-level cropping. Extra rendered children bleed past the `<Box>` boundary into adjacent panes or the input area.

2. **`contentHeight` off-by-one when title wraps** — Line 139 hardcodes `height - 3` for chrome (border top + title + border bottom). When the scroll indicator `[+N]` pushes the title past pane width, it wraps to 2 lines, and the viewport overflows by 1 row.

3. **`measureElement` re-render loop** — Lines 124-128: `useEffect` with no dependency array calls `measureElement` after every render, triggering `setMeasuredWidth`, which triggers another render. First frame uses stale default width (40), producing wrong line wrapping and a visible jump.

4. **Fixed `paneHeight` ignores multiline input** — Line 275 computes `paneHeight = rows - 7`, assuming the input box is always a fixed height. Alt+Enter (line 464) grows `InputRenderer` but the budget doesn't adjust, so the total layout exceeds terminal rows.

## Agent Inventory

No new agent needed. The built-in `coder` agent covers all source, test, and refactoring changes.

## Design Decisions

1. **Parent-owned dimension model.** `App` is the single source of truth for all layout dimensions, computed from `stdout.rows` and `stdout.columns`. `Pane` receives `contentHeight` and `textWidth` as props. No `measureElement`, no `useState(40)`, no effect loop inside `Pane`.

2. **Explicit left/right pane widths.** `leftPaneWidth = Math.floor(termCols / 2)`, `rightPaneWidth = termCols - leftPaneWidth`. Each derives its own `textWidth = paneWidth - 2` (border). Handles odd terminal widths exactly rather than approximating a 50/50 split.

3. **Single-line title enforced via truncation.** Title + scroll indicator truncated to pane width using `string-width` for display-width correctness. Chrome height is always exactly 3 (top border + title + bottom border). No dynamic title measurement needed. Use a small custom helper with `string-width` (already a direct dependency) rather than adding `cli-truncate` as a new dependency.

4. **Clipping as data, not styling.** `Pane` renders exactly `contentHeight` lines — the `visibleLines` slice is the clipping mechanism. `overflow="hidden"` stays as defense-in-depth but is not relied upon.

5. **`string-width` for all display-width calculations.** Replace `label.length` in `preRenderLines` (line 89) with `stringWidth(label)`. Already a direct dependency in `package.json`.

6. **Dynamic input height feeds layout budget.** `inputLineCount` derived from `inputText.split("\n").length` feeds into the layout budget so pane height adjusts when input grows via Alt+Enter. This is in Phase 1 because without it, multiline input still breaks the total vertical budget.

7. **Test with `node:test` + `tsx`.** Add `tsx` as a devDependency. Use Node's built-in test runner (`node --test`). No vitest/jest — the Phase 1 work is pure layout math that `node:test` + `assert` covers cleanly. Add a `"test"` script to `package.json`: `"tsx --test src/**/*.test.ts"`.

8. **Scroll policy improvement deferred to Phase 2.** Auto-scroll suppression when the user is scrolled up, plus a "new messages" indicator, are UX polish that builds on the stable layout math from Phase 1.

## Tasks

### Phase 1 — Core layout fix (serial)

- [ ] 1. Add `tsx` devDependency and test scaffold with `computeLayoutBudget` (red/green TDD) — **coder**
  RED: `ink-ui/src/layout.test.ts` `computeLayoutBudget returns correct dimensions for standard terminal`: assert `computeLayoutBudget(24, 80, 1).paneContentHeight === 14` and `computeLayoutBudget(24, 80, 1).leftPaneWidth === 40` and `computeLayoutBudget(24, 80, 1).rightPaneWidth === 40` and `computeLayoutBudget(24, 80, 1).leftTextWidth === 38` and `computeLayoutBudget(24, 80, 1).rightTextWidth === 38`, fails because `layout.ts` does not exist. Second test `computeLayoutBudget adjusts for multiline input`: assert `computeLayoutBudget(24, 80, 3).paneContentHeight === 12` (two fewer rows than single-line), fails for same reason. Third test `computeLayoutBudget handles odd terminal width`: assert `computeLayoutBudget(24, 81, 1).leftPaneWidth === 40` and `computeLayoutBudget(24, 81, 1).rightPaneWidth === 41` and `computeLayoutBudget(24, 81, 1).rightTextWidth === 39`, fails for same reason.
  GREEN: Create `ink-ui/src/layout.ts`, export `computeLayoutBudget(termRows: number, termCols: number, inputLineCount: number)` — implement: `inputHeight = 2 + inputLineCount + 2` (border-top + label + input-lines + hint + border-bottom = but label and hint are each 1 line inside the border, so total = border(2) + label(1) + inputLines + hint(1) = 4 + inputLineCount), `statusHeight = 1`, `paneHeight = termRows - inputHeight - statusHeight`, `paneContentHeight = max(1, paneHeight - 3)`, `leftPaneWidth = Math.floor(termCols / 2)`, `rightPaneWidth = termCols - leftPaneWidth`, `leftTextWidth = max(4, leftPaneWidth - 2)`, `rightTextWidth = max(4, rightPaneWidth - 2)`. Also add `tsx` to devDependencies and a `"test": "npx tsx --test src/**/*.test.ts"` script to `package.json`.
  VERIFY: `cd ink-ui && npm install && npm test`
  Commits: `test(red): add computeLayoutBudget tests` and `fix(green): implement computeLayoutBudget pure helper`

- [ ] 2. Extract and test `computeViewportSlice` (red/green TDD) (depends: 1) — **coder**
  RED: `ink-ui/src/layout.test.ts` `computeViewportSlice clamps scroll and returns correct indices`: assert `computeViewportSlice(100, 14, 5)` returns `{ startIdx: 81, endIdx: 95, clampedScroll: 5 }`. Second test `computeViewportSlice handles content shorter than viewport`: assert `computeViewportSlice(10, 14, 0)` returns `{ startIdx: 0, endIdx: 10, clampedScroll: 0 }`. Third test `computeViewportSlice clamps excessive scroll`: assert `computeViewportSlice(20, 14, 999)` returns `{ startIdx: 0, endIdx: 14, clampedScroll: 6 }`. All fail because function does not exist.
  GREEN: `ink-ui/src/layout.ts:computeViewportSlice(totalLines: number, contentHeight: number, scrollOffset: number)` — implement: `maxScroll = max(0, totalLines - contentHeight)`, `clamped = min(scrollOffset, maxScroll)`, `endIdx = totalLines - clamped`, `startIdx = max(0, endIdx - contentHeight)`, return `{ startIdx, endIdx, clampedScroll: clamped }`.
  VERIFY: `cd ink-ui && npm test`
  Commits: `test(red): add computeViewportSlice tests` and `fix(green): implement computeViewportSlice pure helper`

- [ ] 3. Extract and test `truncateTitle` using `string-width` (red/green TDD) (depends: 1) — **coder**
  RED: `ink-ui/src/layout.test.ts` `truncateTitle fits title and scroll indicator within maxWidth`: assert `truncateTitle("ROOM", 15, 20)` returns `"ROOM [+15]"` (10 chars, fits in 20). Second test `truncateTitle truncates long title`: assert display width of `truncateTitle("VERY LONG TITLE NAME", 0, 10)` is `<= 10` and result ends with `"…"`. Third test `truncateTitle omits indicator when scrollOffset is 0`: assert `truncateTitle("ROOM", 0, 20)` returns `"ROOM"` (no indicator). All fail because function does not exist.
  GREEN: `ink-ui/src/layout.ts:truncateTitle(title: string, scrollOffset: number, maxWidth: number)` — implement using `stringWidth` from `string-width`: build suffix `scrollOffset > 0 ? " [+${scrollOffset}]" : ""`, compute available width for title as `maxWidth - stringWidth(suffix)`, if `stringWidth(title) > availableWidth` then truncate title characters until `stringWidth(truncated + "…") <= availableWidth`, return `truncated + "…" + suffix`, else return `title + suffix`.
  VERIFY: `cd ink-ui && npm test`
  Commits: `test(red): add truncateTitle tests` and `fix(green): implement truncateTitle with string-width`

- [ ] 4. Update `preRenderLines` to use `string-width` for label width (red/green TDD) (depends: 1) — **coder**
  RED: `ink-ui/src/layout.test.ts` `preRenderLines uses display width for label indent`: create an entry with speaker `"test"` where `SPEAKER_LABELS["test"]` is not defined so it falls back to `"[test] "` (7 chars, 7 display-width). Assert that the second visual line (continuation) has `label` equal to `" ".repeat(stringWidth("[test] "))` i.e. 7 spaces. Then create a test where the fallback label contains a character wider than 1 cell (e.g. add a test-only entry with a known label) and assert indent matches `stringWidth` not `.length`. Fails because `preRenderLines` is in `App.tsx` using `.length` and not exported from `layout.ts`.
  GREEN: Move `preRenderLines` (and its `FlatLine` type, `wrapText` helper, `SPEAKER_LABELS`, `SPEAKER_COLORS`) from `App.tsx` to `layout.ts`. Replace `label.length` (current line 89) with `stringWidth(label)`. Replace `" ".repeat(labelWidth)` indent (current line 91) with `" ".repeat(stringWidth(label))`. Export from `layout.ts`.
  VERIFY: `cd ink-ui && npm test`
  Commits: `test(red): assert preRenderLines uses display width for indent` and `fix(green): move preRenderLines to layout.ts, use string-width`

- [x] 5. Wire parent-owned dimensions into App and Pane (depends: 1,2,3,4) — **coder**
  Scope — refactor `ink-ui/src/App.tsx`:
  - Import `computeLayoutBudget`, `computeViewportSlice`, `truncateTitle`, `preRenderLines`, `SPEAKER_COLORS`, `SPEAKER_LABELS`, `FlatLine` from `./layout.ts`
  - Remove the duplicate definitions now living in `layout.ts`
  - In `App`: read `cols` from `useStdout().stdout?.columns ?? 80`, derive `inputLineCount = inputText.split("\n").length`, call `computeLayoutBudget(rows, cols, inputLineCount)`, destructure `{ leftPaneWidth, rightPaneWidth, leftTextWidth, rightTextWidth, paneHeight, paneContentHeight }`
  - Pass `contentHeight={paneContentHeight}` and the appropriate `textWidth` to each `Pane`
  - Change `Pane` props: add `contentHeight: number` and `textWidth: number`, remove internal `measureElement` usage, remove `useState(40)` for `measuredWidth`, remove the `useEffect` that calls `measureElement`, remove the `containerRef`
  - In `Pane`: use `truncateTitle(title, scrollOffset, textWidth)` for the title `<Text>`, use `computeViewportSlice(flatLines.length, contentHeight, scrollOffset)` for the viewport slice, pass `textWidth` to `preRenderLines`, render exactly `contentHeight` visible lines (the slice is the clip)
  - `preRenderLines` `useMemo` now depends on `[entries, textWidth]` where `textWidth` is a prop (stable unless terminal resizes)
  VERIFY: `npx tsc -p ink-ui/tsconfig.json --noEmit && cd ink-ui && npm test`
  Commits: `refactor: wire parent-owned layout dimensions into App and Pane`

- [x] 6. Full regression — TypeScript + layout tests + Python tests (depends: 5) — **coder**
  Scope: Run all verification commands. Resolve any type errors or test failures from the refactor. Also run the Python regression suite to confirm no unrelated breakage.
  VERIFY: `npx tsc -p ink-ui/tsconfig.json --noEmit && cd ink-ui && npm test && cd .. && python3 -m pytest tests/ -x`
  Commits: only if fixes needed

### Phase 2 — UX polish (serial, depends: Phase 1)

- [x] 7. Auto-scroll only when user is at bottom (red/green TDD) (depends: 6) — **coder**
  RED: `ink-ui/src/layout.test.ts` `shouldAutoScroll returns true only when at bottom`: assert `shouldAutoScroll(0)` returns `true` and `shouldAutoScroll(1)` returns `false` and `shouldAutoScroll(5)` returns `false`, fails because function does not exist.
  GREEN: `ink-ui/src/layout.ts:shouldAutoScroll(scrollOffset: number): boolean` — return `scrollOffset === 0`. In `App.tsx`, change `setRoomScroll(0)` on new room message (line 349) to `setRoomScroll((prev) => prev === 0 ? 0 : prev)` (i.e. only reset if already at bottom, using `shouldAutoScroll`). Same for `setCaucusScroll(0)` on new caucus message (line 356). Also update `computeViewportSlice` page-size usage in `Ctrl+B`/`Ctrl+F` handlers (lines 574-590) to use `paneContentHeight` instead of `paneHeight - 3`.
  VERIFY: `cd ink-ui && npm test`
  Commits: `test(red): add shouldAutoScroll test` and `fix(green): auto-scroll only when already at bottom`

- [x] 8. "New messages" indicator when scrolled up (depends: 7) — **coder**
  Scope: In `App`, track `lastSeenEntryCount` per pane (state, updated to current entry count when `scrollOffset` returns to 0). In `Pane`, when `scrollOffset > 0` and `entries.length > lastSeenCount`, pass a `hasNewMessages` flag. `truncateTitle` gains an optional `badge` parameter — when set, append ` ↓ new` to the title (within the truncation budget, taking priority over the scroll indicator if space is tight).
  VERIFY: `npx tsc -p ink-ui/tsconfig.json --noEmit && cd ink-ui && npm test`
  Commits: `feat: show new-messages indicator when scrolled up in pane title`

## Expected Outcome

After Phase 1:
- Pane text never overflows into adjacent panes or the input area
- Layout remains correct at any terminal size and with multiline input (Alt+Enter)
- Title line never wraps (truncated to single line with display-width awareness)
- No render-measure-rerender loop (`measureElement` removed from Pane)
- Pure layout helpers tested and deterministic via `node:test`

After Phase 2:
- Scrolling up to read history is not interrupted by new incoming messages
- Clear `↓ new` indicator in pane title when new messages arrive while scrolled up
- Page-up/page-down uses the actual viewport height
