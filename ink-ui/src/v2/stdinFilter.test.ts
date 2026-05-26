import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  createTerminalInputFilterState,
  processTerminalInputChunk,
} from "./stdinFilter.js";

describe("Ink stdin filter", () => {
  it("strips mouse wheel sequences split across chunks", () => {
    const state = createTerminalInputFilterState();

    const first = processTerminalInputChunk(state, "hello\x1b[<64;10");
    const second = processTerminalInputChunk(state, ";5Mworld");

    assert.equal(first.text, "hello");
    assert.equal(first.wheelSteps, 0);
    assert.equal(second.text, "world");
    assert.equal(second.wheelSteps, 1);
  });

  it("strips mouse press sequences split across chunks", () => {
    const state = createTerminalInputFilterState();

    const first = processTerminalInputChunk(state, "\x1b[<0;12;");
    const second = processTerminalInputChunk(state, "7M");

    assert.equal(first.text, "");
    assert.equal(second.text, "");
    assert.deepEqual(second.mouseEvents, [{ kind: "press", x: 11, y: 6 }]);
  });

  it("buffers bracketed paste markers split across chunks", () => {
    const state = createTerminalInputFilterState();

    const first = processTerminalInputChunk(state, "a\x1b[20");
    const second = processTerminalInputChunk(state, "0~pasted");
    const third = processTerminalInputChunk(state, "\x1b[201~b");

    assert.equal(first.text, "a");
    assert.equal(second.text, "");
    assert.deepEqual(second.pastes, []);
    assert.equal(third.text, "b");
    assert.deepEqual(third.pastes, ["pasted"]);
  });

  it("buffers shift-enter sequences split across chunks", () => {
    const state = createTerminalInputFilterState();

    const first = processTerminalInputChunk(state, "\x1b[13");
    const second = processTerminalInputChunk(state, ";2u");

    assert.equal(first.text, "");
    assert.equal(second.text, "");
    assert.equal(second.shiftEnterCount, 1);
  });

  it("forwards a lone escape key instead of buffering forever", () => {
    const state = createTerminalInputFilterState();

    const event = processTerminalInputChunk(state, "\x1b");

    assert.equal(event.text, "\x1b");
    assert.equal(state.pending, "");
  });
});
