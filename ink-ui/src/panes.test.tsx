// Render-path regression tests: the busy-spinner tick and streaming flushes
// must not repaint the whole screen. Renders a real Ink tree against a fake
// TTY and asserts (a) spinner ticks re-render zero transcript rows, (b) a
// stream flush re-renders only the changed/appended rows, and (c) no frame is
// written via the fullscreen clearTerminal path (the 2026-07 flicker bug).
import test from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import React from "react";
import { render, Box } from "ink";
import { BusyLine, Pane, buildBusySegments, paneRowRenderCounter } from "./panes.js";
import type { FlatLine } from "./layout.js";

const TERM_ROWS = 30;
const TERM_COLS = 100;
// \x1b[2J (erase screen) only ever appears in ansiEscapes.clearTerminal —
// Ink's fullscreen full-repaint path that must never be hit.
const CLEAR_SCREEN = "[2J";

class FakeStdout extends EventEmitter {
  isTTY = true;
  rows = TERM_ROWS;
  columns = TERM_COLS;
  writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(String(chunk));
    return true;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setRawMode() { return this; }
  setEncoding() { return this; }
  ref() { return this; }
  unref() { return this; }
  pause() { return this; }
  resume() { return this; }
  read() { return null; }
  unpipe() { return this; }
}

function makeFlatLine(index: number, text: string): FlatLine {
  return {
    key: `entry-${index}:0`,
    label: "claude ",
    text,
    speakerColor: "cyan",
    bodyColor: "white",
  };
}

function makeFlatLines(count: number): FlatLine[] {
  return Array.from({ length: count }, (_, i) => makeFlatLine(i, `line ${i} content`));
}

function Harness({ flatLines, busy }: { flatLines: FlatLine[]; busy: boolean }) {
  return (
    <Box flexDirection="column" height={TERM_ROWS - 1}>
      <Pane
        title="COUNCIL"
        pane="room"
        flatLines={flatLines}
        focused
        height={TERM_ROWS - 3}
        contentHeight={TERM_ROWS - 5}
        textWidth={TERM_COLS - 6}
        scrollOffset={0}
        hasNewMessages={false}
        selection={null}
      />
      {busy ? <BusyLine text="claude is thinking" frameIntervalMs={15} /> : null}
    </Box>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(element: React.ReactElement) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const app = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true,
  });
  return { app, stdout };
}

test("busy-spinner ticks re-render zero transcript rows and never clear the screen", async () => {
  const flatLines = makeFlatLines(40);
  const { app, stdout } = mount(<Harness flatLines={flatLines} busy />);
  await sleep(80); // settle initial render

  const rowRendersBefore = paneRowRenderCounter.count;
  const writesBefore = stdout.writes.length;
  await sleep(300); // ~20 spinner frames at 15ms
  const rowDelta = paneRowRenderCounter.count - rowRendersBefore;
  const tickWrites = stdout.writes.slice(writesBefore);

  app.unmount();

  assert.strictEqual(
    rowDelta,
    0,
    `spinner ticks must not re-render transcript rows (got ${rowDelta} row renders)`,
  );
  assert.ok(
    !tickWrites.some((w) => w.includes(CLEAR_SCREEN)),
    "spinner ticks must not repaint via clearTerminal",
  );
});

test("a streaming flush re-renders only the changed and appended rows", async () => {
  const flatLines = makeFlatLines(40);
  const { app, stdout } = mount(<Harness flatLines={flatLines} busy={false} />);
  await sleep(80);

  const rowRendersBefore = paneRowRenderCounter.count;
  // Simulate a stream flush: the tail line grows (new object, same key) and a
  // new line is appended — every other FlatLine keeps its identity, exactly
  // like preRenderLines' per-entry cache behaves during streaming.
  const flushed = [
    ...flatLines.slice(0, -1),
    makeFlatLine(39, "line 39 content plus a streamed token"),
    makeFlatLine(40, "a brand new streamed line"),
  ];
  app.rerender(<Harness flatLines={flushed} busy={false} />);
  await sleep(80);
  const rowDelta = paneRowRenderCounter.count - rowRendersBefore;

  app.unmount();

  assert.ok(rowDelta >= 1, "the changed row must re-render");
  assert.ok(
    rowDelta <= 4,
    `a flush must re-render only changed/appended rows, not the viewport (got ${rowDelta})`,
  );
  assert.ok(
    !stdout.writes.some((w) => w.includes(CLEAR_SCREEN)),
    "streaming must not repaint via clearTerminal",
  );
});

test("unchanged-identity rerender of the same lines re-renders zero rows", async () => {
  const flatLines = makeFlatLines(40);
  const { app } = mount(<Harness flatLines={flatLines} busy={false} />);
  await sleep(80);

  const rowRendersBefore = paneRowRenderCounter.count;
  // Same array identity — e.g. an app-level state change that doesn't touch
  // the transcript (status update, hint, spinner text change).
  app.rerender(<Harness flatLines={flatLines} busy={false} />);
  await sleep(80);
  const rowDelta = paneRowRenderCounter.count - rowRendersBefore;

  app.unmount();
  assert.strictEqual(rowDelta, 0);
});

test("buildBusySegments coalesces same-style runs and preserves the text", () => {
  const text = "claude is thinking about the answer";
  const segments = buildBusySegments(text, 12);
  assert.strictEqual(segments.map((s) => s.text).join(""), text);
  // one glimmer bright char + up to two adjacent + the muted rest — a handful
  // of segments, not one per character.
  assert.ok(
    segments.length <= 5,
    `expected coalesced segments, got ${segments.length} for ${text.length} chars`,
  );
});
