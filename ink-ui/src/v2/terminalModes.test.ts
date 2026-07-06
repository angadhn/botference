import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  DISABLE_BRACKETED_PASTE,
  DISABLE_MOUSE_TRACKING,
  ENABLE_BRACKETED_PASTE,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  createSuspendResumeController,
  disableRawMode,
  terminalRestoreSequence,
  terminalResumeSequence,
  type SuspendResumeIO,
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

  it("disables raw mode during cleanup", () => {
    const calls: boolean[] = [];
    const stdin = {
      isTTY: true,
      setRawMode(raw: boolean) {
        calls.push(raw);
      },
    } as unknown as NodeJS.ReadStream;

    disableRawMode(stdin);

    assert.deepEqual(calls, [false]);
  });
});

describe("terminal resume sequence (SIGCONT)", () => {
  it("re-enters alt screen, mouse tracking, bracketed paste, and re-hides the cursor", () => {
    const sequence = terminalResumeSequence({
      useAltScreen: true,
      mouseTracking: true,
      bracketedPaste: true,
      hideCursor: true,
    });
    assert.ok(sequence.startsWith(ENTER_ALT_SCREEN));
    assert.ok(sequence.includes(ENABLE_MOUSE_TRACKING));
    assert.ok(sequence.includes(ENABLE_BRACKETED_PASTE));
    assert.ok(sequence.includes(HIDE_CURSOR));
  });

  it("omits modes that were not active before the suspend", () => {
    const sequence = terminalResumeSequence({
      useAltScreen: false,
      mouseTracking: false,
      bracketedPaste: true,
      hideCursor: false,
    });
    assert.equal(sequence.includes(ENTER_ALT_SCREEN), false);
    assert.equal(sequence.includes(ENABLE_MOUSE_TRACKING), false);
    assert.equal(sequence.includes(HIDE_CURSOR), false);
    assert.ok(sequence.includes(ENABLE_BRACKETED_PASTE));
  });
});

describe("suspend/resume controller (SIGTSTP / SIGCONT)", () => {
  interface FakeIO extends SuspendResumeIO {
    events: string[];
    raw: boolean;
    exiting: boolean;
    mouseTracking: boolean;
  }

  function makeIO(overrides: Partial<FakeIO> = {}): FakeIO {
    const io: FakeIO = {
      events: [],
      raw: true,
      exiting: false,
      mouseTracking: true,
      write(sequence: string) {
        io.events.push(`write:${sequence}`);
      },
      setRawMode(mode: boolean) {
        io.raw = mode;
        io.events.push(`raw:${mode}`);
      },
      isRaw: () => io.raw,
      isExiting: () => io.exiting,
      getMouseTracking: () => io.mouseTracking,
      raiseSigtstp() {
        io.events.push("raise");
      },
      onResume() {
        io.events.push("repaint");
      },
      ...overrides,
    };
    return io;
  }

  it("suspend restores the terminal and drops raw mode BEFORE re-raising SIGTSTP", () => {
    const io = makeIO();
    const controller = createSuspendResumeController({ useAltScreen: true }, io);

    controller.suspend();

    assert.deepEqual(io.events, [
      `write:${terminalRestoreSequence({ useAltScreen: true })}`,
      "raw:false",
      "raise",
    ]);
    assert.ok(controller.isSuspended());
  });

  it("resume re-enables the modes, restores raw mode, and repaints", () => {
    const io = makeIO();
    const controller = createSuspendResumeController({ useAltScreen: true }, io);

    controller.suspend();
    io.events.length = 0;
    controller.resume();

    assert.deepEqual(io.events, [
      `write:${terminalResumeSequence({
        useAltScreen: true,
        mouseTracking: true,
        bracketedPaste: true,
        hideCursor: true,
      })}`,
      "raw:true",
      "repaint",
    ]);
    assert.equal(controller.isSuspended(), false);
  });

  it("does not re-enable mouse tracking when it was off at suspend time", () => {
    const io = makeIO({ mouseTracking: false });
    const controller = createSuspendResumeController({ useAltScreen: true }, io);

    controller.suspend();
    io.events.length = 0;
    controller.resume();

    const writes = io.events.filter((e) => e.startsWith("write:"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.includes(ENABLE_MOUSE_TRACKING), false);
    assert.ok(writes[0]!.includes(ENABLE_BRACKETED_PASTE));
  });

  it("does not force raw mode back on when stdin was not raw before suspend", () => {
    const io = makeIO({ raw: false });
    const controller = createSuspendResumeController({ useAltScreen: true }, io);

    controller.suspend();
    io.events.length = 0;
    controller.resume();

    assert.equal(io.events.includes("raw:true"), false);
    assert.ok(io.events.includes("repaint"));
  });

  it("suspend while the app is exiting re-raises without touching the terminal", () => {
    const io = makeIO({ exiting: true });
    const controller = createSuspendResumeController({ useAltScreen: true }, io);

    controller.suspend();

    assert.deepEqual(io.events, ["raise"]);
    assert.equal(controller.isSuspended(), false);
  });

  it("resume without a prior suspend is a no-op", () => {
    const io = makeIO();
    const controller = createSuspendResumeController({ useAltScreen: true }, io);

    controller.resume();

    assert.deepEqual(io.events, []);
  });

  it("a second suspend re-raises but does not restore twice", () => {
    const io = makeIO();
    const controller = createSuspendResumeController({ useAltScreen: true }, io);

    controller.suspend();
    io.events.length = 0;
    controller.suspend();

    assert.deepEqual(io.events, ["raise"]);
  });

  it("a second resume after resuming is a no-op", () => {
    const io = makeIO();
    const controller = createSuspendResumeController({ useAltScreen: true }, io);

    controller.suspend();
    controller.resume();
    io.events.length = 0;
    controller.resume();

    assert.deepEqual(io.events, []);
  });
});
