import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  applySelectionHighlight,
  hitTestPane,
  selectedTextFromLines,
  selectionRangeForLine,
  type PaneSelection,
} from "./selection.js";
import type { FlatLine } from "../layout.js";

function line(text: string, label = ""): FlatLine {
  return {
    key: `k-${text}`,
    label,
    text,
    speakerColor: "white",
    bodyColor: "white",
  };
}

describe("Ink pane hit testing", () => {
  it("maps terminal coordinates into the council pane", () => {
    const room = [line("alpha", "[Codex] ")];
    const base = {
      paneContentHeight: 5,
      councilTextWidth: 76,
      roomFlatLines: room,
      roomScrollOffset: 0,
    };

    assert.deepEqual(hitTestPane({ x: 10, y: 2 }, base), {
      pane: "room",
      lineIndex: 0,
      col: 0,
    });
    assert.equal(hitTestPane({ x: 10, y: 20 }, base), null);
  });

  it("uses scrolled viewport rows when selecting older pane text", () => {
    const room = Array.from({ length: 10 }, (_, i) => line(`row-${i}`));
    const hit = hitTestPane({
      x: 4,
      y: 2,
    }, {
      paneContentHeight: 3,
      councilTextWidth: 76,
      roomFlatLines: room,
      roomScrollOffset: 2,
    });

    assert.deepEqual(hit, {
      pane: "room",
      lineIndex: 5,
      col: 2,
    });
  });
});

describe("Ink pane selection", () => {
  it("clamps selection rendering to the pane where the drag started", () => {
    const selection: PaneSelection = {
      pane: "room",
      anchorLine: 0,
      anchorCol: 1,
      focusLine: 1,
      focusCol: 2,
      dragging: true,
    };

    assert.deepEqual(selectionRangeForLine(selection, "room", 0, "alpha"), { start: 1, end: 5 });
    // Lines outside the selection range render unhighlighted.
    assert.equal(selectionRangeForLine(selection, "room", 5, "alpha"), null);
  });

  it("extracts selected text from wrapped rendered lines", () => {
    const lines = [
      line("first visual row"),
      line("second visual row"),
      line("third visual row"),
    ];
    const selection: PaneSelection = {
      pane: "room",
      anchorLine: 0,
      anchorCol: 6,
      focusLine: 1,
      focusCol: 5,
      dragging: false,
    };

    assert.equal(selectedTextFromLines(lines, selection), "visual row\nsecond");
  });

  it("keeps styled segments while applying an obvious selected span", () => {
    const selected = applySelectionHighlight({
      ...line("hello world"),
      segments: [
        { text: "hello", color: "green", bold: true },
        { text: " world", color: "white" },
      ],
    }, {
      pane: "room",
      anchorLine: 0,
      anchorCol: 3,
      focusLine: 0,
      focusCol: 7,
      dragging: true,
    }, "room", 0);

    assert.deepEqual(selected?.map((segment) => ({
      text: segment.text,
      color: segment.color,
      backgroundColor: segment.backgroundColor,
      bold: segment.bold,
    })), [
      { text: "hel", color: "green", backgroundColor: undefined, bold: true },
      { text: "lo", color: "white", backgroundColor: "blue", bold: true },
      { text: " wo", color: "white", backgroundColor: "blue", bold: undefined },
      { text: "rld", color: "white", backgroundColor: undefined, bold: undefined },
    ]);
  });
});

