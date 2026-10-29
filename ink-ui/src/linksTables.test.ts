// Clickable links (OSC 8) and markdown tables in the transcript pane.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import React from "react";
import stringWidth from "string-width";
import { renderToString } from "ink";
import {
  fitTableColumnWidths,
  osc8Link,
  parseInlineMarkdownSegments,
  parseMarkdownTable,
  preRenderLines,
  wrapSegments,
} from "./layout.js";
import { Pane } from "./panes.js";
import { selectedTextFromLines, type PaneSelection } from "./v2/selection.js";

const visible = (segments: { text: string }[]) => segments.map((s) => s.text).join("");

describe("links", () => {
  it("shows only the label of a markdown link and carries the URL as href", () => {
    const segments = parseInlineMarkdownSegments("See [AoE guide](https://example.com/aoe) now", {});
    assert.equal(visible(segments), "See AoE guide now");
    const link = segments.find((s) => s.text === "AoE guide");
    assert.equal(link?.href, "https://example.com/aoe");
    assert.equal(link?.underline, true);
  });

  it("turns a bare localhost URL into a link shown as itself", () => {
    const segments = parseInlineMarkdownSegments("Preview at http://localhost:4173/a_b_c.", {});
    assert.equal(visible(segments), "Preview at http://localhost:4173/a_b_c.");
    const link = segments.find((s) => s.href);
    assert.equal(link?.text, "http://localhost:4173/a_b_c");
    assert.equal(link?.href, "http://localhost:4173/a_b_c");
  });

  it("keeps the target visible for a link the terminal cannot open", () => {
    const segments = parseInlineMarkdownSegments("[notes](docs/notes.md)", {});
    assert.equal(visible(segments), "notes (docs/notes.md)");
    assert.ok(segments.every((s) => !s.href));
  });

  it("counts only the label toward a link's width", () => {
    const [link] = parseInlineMarkdownSegments("[AoE guide](https://example.com/a/very/long/path)", {});
    assert.equal(stringWidth(link!.text), stringWidth("AoE guide"));
    assert.equal(stringWidth(osc8Link(link!.href!, link!.text)), stringWidth("AoE guide"));
  });

  it("does not wrap a line early because of a hidden URL", () => {
    const text = "Read [the guide](https://example.com/" + "x".repeat(80) + ") today";
    const wrapped = wrapSegments(parseInlineMarkdownSegments(text, {}), 30);
    assert.equal(wrapped.length, 1);
  });

  it("strips control characters from the link target", () => {
    assert.equal(osc8Link("http://a\u001b[31m/\u0007x", "a"), "\u001b]8;;http://a[31m/x\u0007a\u001b]8;;\u0007");
  });

  it("renders the label as an OSC 8 link with the line laid out on visible text", () => {
    const lines = preRenderLines([{ speaker: "claude", text: "Go to [AoE guide](http://127.0.0.1:8000/aoe) end" }], 36);
    const out = renderToString(
      React.createElement(Pane, {
        title: "room", pane: "room", flatLines: lines, focused: true,
        height: 6, contentHeight: 3, textWidth: 36, scrollOffset: 0,
        hasNewMessages: false, selection: null,
      }),
      { columns: 40 },
    );
    assert.ok(out.includes("\u001b]8;;http://127.0.0.1:8000/aoe\u0007AoE guide\u001b]8;;\u0007"));
    assert.ok(!out.includes("(http://127.0.0.1"));
    const row = out.split("\n").find((l) => l.includes("AoE guide"))!;
    assert.equal(stringWidth(row), 40);
  });

  it("copies a link's address after its label", () => {
    const lines = preRenderLines([{ speaker: "claude", text: "See [docs](https://example.com) ok" }], 60);
    const selection: PaneSelection = {
      pane: "room", anchorLine: 0, anchorCol: 0, focusLine: 0, focusCol: lines[0]!.text.length, dragging: false,
    };
    assert.ok(selectedTextFromLines(lines, selection).endsWith("See docs (https://example.com) ok"));
  });

  it("copies a bare URL once", () => {
    const lines = preRenderLines([{ speaker: "claude", text: "at http://localhost:3000 ok" }], 60);
    const selection: PaneSelection = {
      pane: "room", anchorLine: 0, anchorCol: 0, focusLine: 0, focusCol: lines[0]!.text.length, dragging: false,
    };
    assert.ok(selectedTextFromLines(lines, selection).endsWith("at http://localhost:3000 ok"));
  });
});

const TABLE = [
  "| Term | Meaning | n |",
  "|:---|:---:|---:|",
  "| AoE | **Area** of effect | 1 |",
  "| DPS | Damage per second | 200 |",
].join("\n");

describe("markdown tables", () => {
  it("detects a header, separator and body rows", () => {
    const parsed = parseMarkdownTable(TABLE.split("\n"), 0);
    assert.ok(parsed);
    assert.deepEqual(parsed.table.header, ["Term", "Meaning", "n"]);
    assert.deepEqual(parsed.table.aligns, ["left", "center", "right"]);
    assert.equal(parsed.table.rows.length, 2);
    assert.equal(parsed.lineCount, 4);
  });

  it("leaves a lone pipe line as plain text", () => {
    const lines = preRenderLines([{ speaker: "claude", text: "| just a pipe line |" }], 60);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.text.trim(), "| just a pipe line |");
  });

  it("leaves a header with no body rows as plain text", () => {
    assert.equal(parseMarkdownTable(["| a | b |", "|---|---|"], 0), null);
  });

  it("sizes columns to content and lines every row up", () => {
    const rows = preRenderLines([{ speaker: "claude", text: TABLE }], 100).map((l) => l.text);
    assert.equal(new Set(rows.map((t) => stringWidth(t))).size, 1, rows.join("\n"));
    assert.ok(rows.includes("│ Term │      Meaning      │   n │"));
  });

  it("applies left, centre and right alignment from the separator", () => {
    const rows = preRenderLines([{ speaker: "claude", text: TABLE }], 100).map((l) => l.text);
    assert.ok(rows.includes("│ AoE  │  Area of effect   │   1 │"));
    assert.ok(rows.includes("│ DPS  │ Damage per second │ 200 │"));
  });

  it("makes header cells bold and keeps inline markdown in cells", () => {
    const lines = preRenderLines([{ speaker: "claude", text: TABLE }], 100);
    const term = lines.flatMap((l) => l.segments ?? []).find((s) => s.text.includes("Term"));
    assert.equal(term?.bold, true);
    const area = lines.flatMap((l) => l.segments ?? []).find((s) => s.text === "Area");
    assert.equal(area?.bold, true);
  });

  it("wraps a long cell inside its column and keeps the table within the width", () => {
    const text = [
      "| Term | Meaning |",
      "|---|---|",
      "| AoE | " + "a long explanation of the term ".repeat(4).trim() + " |",
    ].join("\n");
    const lines = preRenderLines([{ speaker: "claude", text }], 50);
    const widths = new Set(lines.map((l) => stringWidth(l.label + l.text)));
    assert.equal(widths.size, 1);
    assert.ok([...widths][0]! <= 50);
    assert.ok(lines.length > 5);
  });

  it("shares space so narrow columns keep their natural width", () => {
    assert.deepEqual(fitTableColumnWidths([4, 40, 30], 50), [4, 23, 23]);
    assert.deepEqual(fitTableColumnWidths([4, 10], 50), [4, 10]);
    assert.equal(fitTableColumnWidths([10, 10, 10], 8), null);
  });
});

describe("markdown table cell wrapping", () => {
  it("does not start a wrapped cell row with a space", () => {
    const text = ["| a | b |", "|---|---|", "| x | " + "word ".repeat(30).trim() + " |"].join("\n");
    const rows = preRenderLines([{ speaker: "claude", text }], 40).map((l) => l.text);
    assert.ok(rows.every((t) => !/│ {2}\S/.test(t)), rows.join("\n"));
  });
});
