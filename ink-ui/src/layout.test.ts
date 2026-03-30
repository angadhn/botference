import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import stringWidth from "string-width";
import { computeLayoutBudget, computeViewportSlice, truncateTitle, preRenderLines, shouldAutoScroll } from "./layout.js";

describe("computeLayoutBudget", () => {
  it("returns correct dimensions for standard terminal", () => {
    const b = computeLayoutBudget(24, 80, 1);
    assert.equal(b.paneContentHeight, 12);
    assert.equal(b.leftPaneWidth, 40);
    assert.equal(b.rightPaneWidth, 40);
    assert.equal(b.leftTextWidth, 38);
    assert.equal(b.rightTextWidth, 38);
  });

  it("input height is fixed — panes never resize", () => {
    const single = computeLayoutBudget(24, 80, 1);
    const triple = computeLayoutBudget(24, 80, 3);
    const over = computeLayoutBudget(24, 80, 10);
    assert.equal(single.paneContentHeight, 12);
    assert.equal(triple.paneContentHeight, 12);
    assert.equal(over.paneContentHeight, 12);
  });

  it("handles odd terminal width", () => {
    const b = computeLayoutBudget(24, 81, 1);
    assert.equal(b.leftPaneWidth, 40);
    assert.equal(b.rightPaneWidth, 41);
    assert.equal(b.rightTextWidth, 39);
  });
});

describe("computeViewportSlice", () => {
  it("clamps scroll and returns correct indices", () => {
    const result = computeViewportSlice(100, 14, 5);
    assert.deepEqual(result, { startIdx: 81, endIdx: 95, clampedScroll: 5 });
  });

  it("handles content shorter than viewport", () => {
    const result = computeViewportSlice(10, 14, 0);
    assert.deepEqual(result, { startIdx: 0, endIdx: 10, clampedScroll: 0 });
  });

  it("clamps excessive scroll", () => {
    const result = computeViewportSlice(20, 14, 999);
    assert.deepEqual(result, { startIdx: 0, endIdx: 14, clampedScroll: 6 });
  });
});

describe("truncateTitle", () => {
  it("fits title and scroll indicator within maxWidth", () => {
    const result = truncateTitle("ROOM", 15, 20);
    assert.equal(result, "ROOM [+15]");
  });

  it("truncates long title", () => {
    const result = truncateTitle("VERY LONG TITLE NAME", 0, 10);
    assert.ok(stringWidth(result) <= 10, `display width ${stringWidth(result)} exceeds 10`);
    assert.ok(result.endsWith("…"), `result "${result}" should end with "…"`);
  });

  it("omits indicator when scrollOffset is 0", () => {
    const result = truncateTitle("ROOM", 0, 20);
    assert.equal(result, "ROOM");
  });

  it("shows badge and scroll indicator when both fit", () => {
    const result = truncateTitle("ROOM", 5, 30, " ↓ new");
    assert.equal(result, "ROOM [+5] ↓ new");
  });

  it("drops scroll indicator but keeps badge when space is tight", () => {
    // "ROOM" (4) + " [+5]" (5) + " ↓ new" (6) = 15, maxWidth = 12
    // Full suffix won't fit even with truncation, but badge-only: "ROOM" (4) + " ↓ new" (6) = 10 <= 12
    const result = truncateTitle("ROOM", 5, 12, " ↓ new");
    assert.equal(result, "ROOM ↓ new");
  });

  it("truncates title but keeps badge when title is long", () => {
    // badge " ↓ new" = 6, maxWidth = 15, so available for title = 9
    const result = truncateTitle("VERY LONG TITLE", 0, 15, " ↓ new");
    assert.ok(result.endsWith(" ↓ new"), `result "${result}" should end with badge`);
    assert.ok(stringWidth(result) <= 15, `display width ${stringWidth(result)} exceeds 15`);
  });

  it("shows no badge when badge is undefined", () => {
    const result = truncateTitle("ROOM", 3, 20);
    assert.equal(result, "ROOM [+3]");
  });
});

describe("preRenderLines", () => {
  it("uses display width for label indent with ASCII speaker", () => {
    // Speaker "test" falls back to "[test] " (7 chars, 7 display-width)
    const entries = [{ speaker: "test", text: "first line that is long enough to wrap onto a second visual line for testing" }];
    const lines = preRenderLines(entries, 30);
    assert.equal(lines[0]!.label, "[test] ");
    const expectedIndent = " ".repeat(stringWidth("[test] "));
    assert.equal(lines[1]!.label, expectedIndent);
    assert.equal(expectedIndent.length, 7);
  });

  it("uses display width not .length for wide-char label", () => {
    // "[中文] " — .length=5, stringWidth=7 (each CJK char is 2 cols)
    const entries = [{ speaker: "中文", text: "short line then a much longer second line that wraps" }];
    const lines = preRenderLines(entries, 30);
    const label = "[中文] ";
    assert.equal(lines[0]!.label, label);
    // The indent must be stringWidth(label)=7 spaces, NOT label.length=5 spaces
    const expectedIndent = " ".repeat(stringWidth(label));
    assert.equal(expectedIndent.length, 7, "indent should be 7 spaces (display width), not 5 (.length)");
    assert.equal(lines[1]!.label, expectedIndent);
  });
});

describe("shouldAutoScroll", () => {
  it("returns true when at bottom (scrollOffset === 0)", () => {
    assert.equal(shouldAutoScroll(0), true);
  });

  it("returns false when scrolled up by 1", () => {
    assert.equal(shouldAutoScroll(1), false);
  });

  it("returns false when scrolled up by many lines", () => {
    assert.equal(shouldAutoScroll(5), false);
  });
});
