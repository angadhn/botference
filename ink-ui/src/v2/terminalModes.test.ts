import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  DISABLE_BRACKETED_PASTE,
  DISABLE_MOUSE_TRACKING,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
  terminalRestoreSequence,
} from "./terminalModes.js";

describe("Ink terminal cleanup sequences", () => {
  it("restores mouse, paste, cursor, and alternate screen modes on exit", () => {
    const sequence = terminalRestoreSequence({ useAltScreen: true });
    assert.ok(sequence.includes(DISABLE_MOUSE_TRACKING));
    assert.ok(sequence.includes(DISABLE_BRACKETED_PASTE));
    assert.ok(sequence.includes(SHOW_CURSOR));
    assert.ok(sequence.startsWith(EXIT_ALT_SCREEN));
  });

  it("does not exit alternate screen when the app did not enter it", () => {
    const sequence = terminalRestoreSequence({ useAltScreen: false });
    assert.equal(sequence.includes(EXIT_ALT_SCREEN), false);
    assert.ok(sequence.includes(DISABLE_MOUSE_TRACKING));
  });
});
