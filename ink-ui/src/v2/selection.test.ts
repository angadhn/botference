import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  applySelectionHighlight,
  hitTestPane,
  moveSelection,
  NO_SELECTION,
  SELECTION_MODES,
  selectedTextFromLines,
  selectionRange,
  selectionRangeForLine,
  type PaneSelection,
  type SelectionState,
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

describe("selection modes (is text selected in the pane?)", () => {
  const at = (lineIndex: number, col: number) => ({ pane: "room" as const, lineIndex, col });

  it("names every mode in one list", () => {
    assert.deepEqual([...SELECTION_MODES], ["none", "dragging", "selected"]);
  });

  it("press -> drag -> release goes none -> dragging -> selected", () => {
    let state: SelectionState = NO_SELECTION;
    state = moveSelection(state, { type: "press", hit: at(0, 1) }).state;
    assert.equal(state.mode, "dragging");
    state = moveSelection(state, { type: "drag", hit: at(2, 3) }).state;
    assert.equal(state.mode, "dragging");
    const release = moveSelection(state, { type: "release", hit: at(2, 4) });
    assert.equal(release.ok && release.changed, true);
    assert.equal(release.state.mode, "selected");
    assert.deepEqual(selectionRange(release.state), {
      pane: "room", anchorLine: 0, anchorCol: 1, focusLine: 2, focusCol: 4,
    });
  });

  it("a release off the text keeps the last place the pointer was", () => {
    let state: SelectionState = moveSelection(NO_SELECTION, { type: "press", hit: at(1, 0) }).state;
    state = moveSelection(state, { type: "drag", hit: at(1, 5) }).state;
    state = moveSelection(state, { type: "release", hit: null }).state;
    assert.equal(state.mode, "selected");
    assert.equal(selectionRange(state)?.focusCol, 5);
  });

  it("refuses a drag or a release when no drag is under way", () => {
    assert.equal(moveSelection(NO_SELECTION, { type: "drag", hit: at(0, 0) }).ok, false);
    assert.equal(moveSelection(NO_SELECTION, { type: "release", hit: at(0, 0) }).ok, false);
    let state: SelectionState = moveSelection(NO_SELECTION, { type: "press", hit: at(0, 0) }).state;
    state = moveSelection(state, { type: "release", hit: at(0, 2) }).state;
    // A second release must not copy again.
    assert.equal(moveSelection(state, { type: "release", hit: at(0, 3) }).ok, false);
    assert.equal(moveSelection(state, { type: "drag", hit: at(0, 3) }).ok, false);
  });

  it("a press off the text clears the selection", () => {
    let state: SelectionState = moveSelection(NO_SELECTION, { type: "press", hit: at(0, 0) }).state;
    state = moveSelection(state, { type: "release", hit: at(0, 2) }).state;
    const move = moveSelection(state, { type: "press", hit: null });
    assert.deepEqual(move, { ok: true, state: NO_SELECTION, changed: true });
    assert.equal(selectionRange(move.state), null);
  });
});

