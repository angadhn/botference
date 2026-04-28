import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import stringWidth from "string-width";
import {
  clampScrollOffset,
  computeLayoutBudget,
  computeSmoothScrollNext,
  computeViewportSlice,
  computeWheelScrollDelta,
  truncateTitle,
  initWheelAccel,
  preRenderLines,
  parseRenderBlocks,
  shouldAutoScroll,
} from "./layout.js";

describe("computeLayoutBudget", () => {
  it("returns correct dimensions for standard terminal", () => {
    const b = computeLayoutBudget(24, 80, 1);
    assert.equal(b.paneContentHeight, 13);
    assert.equal(b.leftPaneWidth, 40);
    assert.equal(b.rightPaneWidth, 40);
    assert.equal(b.leftTextWidth, 36);
    assert.equal(b.rightTextWidth, 36);
  });

  it("grows the input viewport and shrinks panes accordingly", () => {
    const single = computeLayoutBudget(24, 80, 1);
    const triple = computeLayoutBudget(24, 80, 3);
    const tall = computeLayoutBudget(24, 80, 10);
    assert.equal(single.paneContentHeight, 13);
    assert.equal(triple.paneContentHeight, 11);
    assert.equal(tall.paneContentHeight, 4);
  });

  it("handles odd terminal width", () => {
    const b = computeLayoutBudget(24, 81, 1);
    assert.equal(b.leftPaneWidth, 40);
    assert.equal(b.rightPaneWidth, 41);
    assert.equal(b.rightTextWidth, 37);
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

describe("wheel scroll acceleration", () => {
  it("keeps slow gestures precise", () => {
    const state = initWheelAccel();
    assert.equal(computeWheelScrollDelta(state, 1, 100), 1);
    assert.equal(computeWheelScrollDelta(state, 1, 200), 1);
  });

  it("ramps repeated fast events", () => {
    const state = initWheelAccel();
    const deltas = [
      computeWheelScrollDelta(state, 1, 100),
      computeWheelScrollDelta(state, 1, 110),
      computeWheelScrollDelta(state, 1, 120),
      computeWheelScrollDelta(state, 1, 130),
    ];
    assert.deepEqual(deltas, [1, 1, 1, 2]);
  });

  it("coalesces same-batch wheel events", () => {
    const state = initWheelAccel();
    assert.equal(computeWheelScrollDelta(state, 5, 100), 6);
  });
});

describe("smooth scroll helpers", () => {
  it("moves proportionally toward distant targets", () => {
    assert.equal(computeSmoothScrollNext(0, 1), 1);
    assert.equal(computeSmoothScrollNext(0, 10), 4);
  });

  it("clamps scroll offset to bounds", () => {
    assert.equal(clampScrollOffset(-5, 20), 0);
    assert.equal(clampScrollOffset(25, 20), 20);
    assert.equal(clampScrollOffset(12, 20), 12);
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
  it("parses snippet headers and fenced code into explicit render blocks", () => {
    const blocks = parseRenderBlocks("'core/botference.py' lines 400-402:\n\n```python\ndef parse_input(raw: str):\n    return raw\n```");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.type, "code");
    if (blocks[0]!.type !== "code") return;
    assert.equal(blocks[0]!.header?.filePath, "core/botference.py");
    assert.equal(blocks[0]!.leadingBlankLines, 1);
    assert.equal(blocks[0]!.language, "python");
    assert.deepEqual(blocks[0]!.lines, [
      "def parse_input(raw: str):",
      "    return raw",
    ]);
  });

  it("normalizes common fence language aliases", () => {
    const blocks = parseRenderBlocks("```typescriptreact\nconst value = 1;\n```");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.type, "code");
    if (blocks[0]!.type !== "code") return;
    assert.equal(blocks[0]!.language, "tsx");
  });

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

  it("mutes tool transcript blocks and resumes speaker body styling after a blank line", () => {
    const entries = [{ speaker: "codex", text: "  > Read(file)\noutput line\n\nplain text" }];
    const lines = preRenderLines(entries, 40);
    assert.equal(lines[0]!.bodyColor, "gray");
    assert.equal(lines[0]!.bodyBold, false);
    assert.equal(lines[1]!.bodyColor, "gray");
    assert.equal(lines[3]!.bodyColor, "green");
  });

  it("renders markdown blockquotes with brighter contrast", () => {
    const entries = [{ speaker: "claude", text: "> This is quoted context" }];
    const lines = preRenderLines(entries, 40);
    assert.equal(lines[0]!.bodyColor, "white");
    assert.equal(lines[0]!.bodyBold, false);
  });

  it("renders explored summaries as a muted tree block", () => {
    const entries = [{ speaker: "claude", text: "Explored\n├ Read botference\n└ Search ctrl+o in src" }];
    const lines = preRenderLines(entries, 60);
    assert.equal(lines[0]!.bodyColor, "grayBright");
    assert.equal(lines[0]!.bodyBold, true);
    assert.equal(lines[1]!.bodyColor, "gray");
    assert.equal(lines[2]!.bodyColor, "gray");
  });

  it("classifies patch summary and diff lines", () => {
    const entries = [{
      speaker: "codex",
      text: "Edited in src/App.tsx (+4 -2)\n@@ -10,2 +10,3 @@\n old line\n+ added line\n- removed line",
    }];
    const lines = preRenderLines(entries, 60);
    assert.equal(lines[0]!.bodyColor, "cyanBright");
    assert.equal(lines[0]!.bodyBold, true);
    assert.equal(lines[0]!.gutter, "src/App.tsx");
    assert.equal(lines[0]!.bodyBackgroundColor, "blackBright");
    assert.equal(lines[1]!.bodyColor, "yellow");
    assert.equal(lines[1]!.gutter, "src/App.tsx");
    assert.equal(lines[2]!.gutter, "  10   10   ");
    assert.equal(lines[2]!.bodyBackgroundColor, "black");
    assert.equal(lines[3]!.bodyColor, "green");
    assert.equal(lines[3]!.gutter, "       11 + ");
    assert.equal(lines[3]!.gutterBackgroundColor, "green");
    assert.equal(lines[4]!.bodyColor, "red");
    assert.equal(lines[4]!.gutter, "  11      - ");
    assert.equal(lines[4]!.gutterBackgroundColor, "red");
  });

  it("applies syntax highlighting and intraline backgrounds inside diff hunks", () => {
    const entries = [{
      speaker: "codex",
      text: "Edited in src/app.py (+1 -1)\n- def old_name(value):\n+ def new_name(value):",
    }];
    const lines = preRenderLines(entries, 80);
    assert.equal(lines[1]!.segments?.[0]?.text, "def");
    assert.equal(lines[1]!.segments?.[0]?.color, "#ff7b72");
    assert.equal(lines[2]!.segments?.[0]?.text, "def");
    assert.equal(lines[2]!.segments?.[0]?.color, "#ff7b72");

    const removedChanged = lines[1]!.segments?.find((segment) => segment.text.includes("old_name"));
    const addedChanged = lines[2]!.segments?.find((segment) => segment.text.includes("new_name"));
    assert.equal(removedChanged?.color, "#d2a8ff");
    assert.equal(addedChanged?.color, "#d2a8ff");
    assert.equal(removedChanged?.backgroundColor, "red");
    assert.equal(addedChanged?.backgroundColor, "green");
  });

  it("marks wrapped diff continuation rows and preserves intraline highlights", () => {
    const entries = [{
      speaker: "codex",
      text: "Edited in src/app.py (+1 -1)\n- const veryLongOldName = 12345;\n+ const veryLongNewName = 12345;",
    }];
    const lines = preRenderLines(entries, 36);
    const wrappedRemoved = lines.find((line) => line.gutter === "   .    . -");
    const wrappedAdded = lines.find((line) => line.gutter === "   .    . +");
    assert.ok(wrappedRemoved);
    assert.ok(wrappedAdded);
    assert.equal(wrappedRemoved?.gutterBackgroundColor, "red");
    assert.equal(wrappedAdded?.gutterBackgroundColor, "green");
    assert.ok(
      wrappedRemoved?.segments?.some((segment) => segment.backgroundColor === "red"),
      "expected wrapped removed line to keep intraline background",
    );
    assert.ok(
      wrappedAdded?.segments?.some((segment) => segment.backgroundColor === "green"),
      "expected wrapped added line to keep intraline background",
    );
  });

  it("does not color ordinary bullet lists as diff lines", () => {
    const entries = [{
      speaker: "claude",
      text: "- first bullet\n+ second bullet",
    }];
    const lines = preRenderLines(entries, 60);
    assert.equal(lines[0]!.bodyColor, "blue");
    assert.equal(lines[1]!.bodyColor, "blue");
  });

  it("renders fenced python snippets with shared code formatting", () => {
    const entries = [{
      speaker: "claude",
      text: "'core/botference.py' lines 400-402:\n\n```python\ndef parse_input(raw: str):\n    return raw\n```",
    }];
    const lines = preRenderLines(entries, 60);
    assert.deepEqual(
      lines[0]!.segments?.map((segment) => segment.text),
      ["core/botference.py", "  ", "lines 400-402", "  ", "python"],
    );
    assert.equal(lines[1]!.text, "");
    assert.equal(lines[2]!.gutter, " 400  ");
    assert.equal(lines[2]!.segments?.[0]?.text, "def");
    assert.equal(lines[2]!.segments?.[0]?.color, "#ff7b72");
    const functionName = lines[2]!.segments?.find((segment) => segment.text.includes("parse_input"));
    assert.equal(functionName?.color, "#d2a8ff");
    assert.equal(functionName?.bold, true);
    assert.equal(lines[3]!.gutter, " 401  ");
  });

  it("marks wrapped code rows with a continuation gutter", () => {
    const entries = [{
      speaker: "claude",
      text: "'core/botference.py' lines 400-401:\n\n```python\ndef parse_input_with_a_very_long_name(raw: str):\n```",
    }];
    const lines = preRenderLines(entries, 36);
    assert.equal(lines[2]!.gutter, " 400  ");
    assert.equal(lines[3]!.gutter, "  ..  ");
  });

  it("highlights JS/TS declaration names more strongly", () => {
    const entries = [{
      speaker: "codex",
      text: "```tsx\nexport async function renderDiffBlock(): void {\n  return;\n}\n```",
    }];
    const lines = preRenderLines(entries, 80);
    const functionName = lines[1]!.segments?.find((segment) => segment.text.includes("renderDiffBlock"));
    assert.equal(functionName?.color, "#d2a8ff");
    assert.equal(functionName?.bold, true);
  });

  it("uses structured blocks from the bridge when present", () => {
    const entries = [{
      speaker: "claude",
      text: "plain text fallback",
      blocks: [{
        type: "code" as const,
        header: {
          filePath: "src/example.py",
          startLine: 12,
          endLine: 13,
        },
        language: "python",
        leadingBlankLines: 0,
        lines: [
          "def parse_input(raw: str):",
          "    return raw",
        ],
      }],
    }];
    const lines = preRenderLines(entries, 60);
    assert.deepEqual(
      lines[0]!.segments?.map((segment) => segment.text),
      ["src/example.py", "  ", "lines 12-13", "  ", "python"],
    );
    assert.equal(lines[1]!.gutter, "  12  ");
    assert.equal(lines[1]!.segments?.[0]?.text, "def");
    assert.equal(lines[2]!.gutter, "  13  ");
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
