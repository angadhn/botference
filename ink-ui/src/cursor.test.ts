import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cursorToLineCol, lineColToCursor } from "./layout.js";

describe("cursorToLineCol", () => {
  it("single line, cursor at start", () => {
    assert.deepStrictEqual(cursorToLineCol("hello", 0), { line: 0, col: 0 });
  });

  it("single line, cursor in middle", () => {
    assert.deepStrictEqual(cursorToLineCol("hello", 3), { line: 0, col: 3 });
  });

  it("single line, cursor at end", () => {
    assert.deepStrictEqual(cursorToLineCol("hello", 5), { line: 0, col: 5 });
  });

  it("multi-line, cursor on first line", () => {
    assert.deepStrictEqual(cursorToLineCol("hello\nworld", 3), {
      line: 0,
      col: 3,
    });
  });

  it("multi-line, cursor at start of second line", () => {
    // "hello\n" = 6 chars, so cursor 6 = start of "world"
    assert.deepStrictEqual(cursorToLineCol("hello\nworld", 6), {
      line: 1,
      col: 0,
    });
  });

  it("multi-line, cursor in middle of second line", () => {
    assert.deepStrictEqual(cursorToLineCol("hello\nworld", 8), {
      line: 1,
      col: 2,
    });
  });

  it("cursor on newline character itself", () => {
    // cursor at position 5 = the \n character
    assert.deepStrictEqual(cursorToLineCol("hello\nworld", 5), {
      line: 0,
      col: 5,
    });
  });

  it("three lines, cursor on third line", () => {
    assert.deepStrictEqual(cursorToLineCol("ab\ncd\nef", 7), {
      line: 2,
      col: 1,
    });
  });

  it("empty lines", () => {
    // "a\n\nb" — cursor at 2 is start of empty line
    assert.deepStrictEqual(cursorToLineCol("a\n\nb", 2), {
      line: 1,
      col: 0,
    });
  });

  it("empty string", () => {
    assert.deepStrictEqual(cursorToLineCol("", 0), { line: 0, col: 0 });
  });
});

describe("lineColToCursor", () => {
  it("single line, col 0", () => {
    assert.strictEqual(lineColToCursor("hello", 0, 0), 0);
  });

  it("single line, col 3", () => {
    assert.strictEqual(lineColToCursor("hello", 0, 3), 3);
  });

  it("second line, col 0", () => {
    assert.strictEqual(lineColToCursor("hello\nworld", 1, 0), 6);
  });

  it("second line, col 2", () => {
    assert.strictEqual(lineColToCursor("hello\nworld", 1, 2), 8);
  });

  it("clamps col to line length", () => {
    // Line "ab" has length 2, requesting col 10 should clamp to 2
    assert.strictEqual(lineColToCursor("ab\ncd", 0, 10), 2);
  });

  it("three lines, third line", () => {
    assert.strictEqual(lineColToCursor("ab\ncd\nef", 2, 1), 7);
  });

  it("empty line in the middle", () => {
    // "a\n\nb" — line 1 is empty, col 0 = position 2
    assert.strictEqual(lineColToCursor("a\n\nb", 1, 0), 2);
  });

  it("roundtrip: cursorToLineCol -> lineColToCursor", () => {
    const text = "hello\nworld\nfoo";
    for (let i = 0; i <= text.length; i++) {
      const { line, col } = cursorToLineCol(text, i);
      assert.strictEqual(lineColToCursor(text, line, col), i);
    }
  });
});
