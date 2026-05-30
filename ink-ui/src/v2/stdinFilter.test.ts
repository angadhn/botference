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

  it("treats horizontal wheel (buttons 66/67) as scroll, not a press", () => {
    const state = createTerminalInputFilterState();

    const event = processTerminalInputChunk(state, "\x1b[<66;10;5M\x1b[<67;10;5M");

    assert.equal(event.text, "");
    assert.deepEqual(event.mouseEvents, []);
  });

  it("ignores bare pointer motion (no button held) so scrolling can't select", () => {
    const state = createTerminalInputFilterState();
    // Button code 35 = motion bit (32) + no-button (3), as emitted by any-motion
    // tracking. It must not become a drag/press.
    const event = processTerminalInputChunk(state, "\x1b[<35;20;8M");

    assert.equal(event.text, "");
    assert.deepEqual(event.mouseEvents, []);
  });

  it("emits a drag only while a real button is held (button 32)", () => {
    const state = createTerminalInputFilterState();

    const event = processTerminalInputChunk(state, "\x1b[<32;20;8M");

    assert.deepEqual(event.mouseEvents, [{ kind: "drag", x: 19, y: 7 }]);
  });

  it("emits a release on the trailing 'm'", () => {
    const state = createTerminalInputFilterState();

    const event = processTerminalInputChunk(state, "\x1b[<0;3;4m");

    assert.deepEqual(event.mouseEvents, [{ kind: "release", x: 2, y: 3 }]);
  });
});
