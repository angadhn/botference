// Screen-consistency regression test for the TUI render path.
//
// Interprets the exact ANSI Ink writes into a virtual screen buffer and
// asserts that after content mutations which CHANGE THE FRAME'S LINE COUNT
// (input area growing, panels toggling, transcript streaming) the screen is
// byte-identical to a fresh render of the same state — no orphaned border
// rows, no frame shifted down a line, no overstruck status lines.
//
// This is the test that would have caught the Ink 6.8 incrementalRendering
// regression: its per-line diff corrupts cursor bookkeeping when the visible
// line count shifts, leaving the previous frame's top border floating above
// the new frame (user-visible as "botched panel separation lines"). The
// production render path (standard writer) must keep this green.
import test from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import React from "react";
import { render, Box, Text } from "ink";
import { BusyLine, Pane, THEME } from "./panes.js";
import type { FlatLine } from "./layout.js";

const ROWS = 24;
const COLS = 80;
const FRAME_ROWS = ROWS - 1;

// ── Minimal VT emulator (the subset Ink/log-update/ansi-escapes emit) ──
class VTerm {
  screen: string[][];
  row = 0;
  col = 0;
  scrolls = 0;
  clears = 0;

  constructor(private rows: number, private cols: number) {
    this.screen = Array.from({ length: rows }, () => Array(cols).fill(" "));
  }

  private blankRow(): string[] {
    return Array(this.cols).fill(" ");
  }

  private lineFeed() {
    if (this.row === this.rows - 1) {
      this.screen.shift();
      this.screen.push(this.blankRow());
      this.scrolls += 1;
    } else {
      this.row += 1;
    }
  }

  write(data: string) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "") {
        if (data[i + 1] !== "[") { i += 1; continue; }
        let j = i + 2;
        let params = "";
        while (j < data.length && !/[A-Za-z]/.test(data[j]!)) {
          params += data[j]!;
          j += 1;
        }
        const final = data[j] ?? "";
        const isPrivate = params.startsWith("?");
        const nums = (isPrivate ? params.slice(1) : params)
          .split(";")
          .map((p) => Number.parseInt(p, 10));
        const n = Number.isFinite(nums[0]!) ? nums[0]! : 1;
        if (!isPrivate) {
          switch (final) {
            case "A": this.row = Math.max(0, this.row - n); break;
            case "B": this.row = Math.min(this.rows - 1, this.row + n); break;
            case "C": this.col = Math.min(this.cols - 1, this.col + n); break;
            case "D": this.col = Math.max(0, this.col - n); break;
            case "E": this.row = Math.min(this.rows - 1, this.row + n); this.col = 0; break;
            case "F": this.row = Math.max(0, this.row - n); this.col = 0; break;
            case "G": this.col = Math.max(0, Math.min(this.cols - 1, n - 1)); break;
            case "H": {
              const r = Number.isFinite(nums[0]!) ? nums[0]! : 1;
              const c = Number.isFinite(nums[1]!) ? nums[1]! : 1;
              this.row = Math.max(0, Math.min(this.rows - 1, r - 1));
              this.col = Math.max(0, Math.min(this.cols - 1, c - 1));
              break;
            }
            case "J":
              if (params === "2") {
                this.screen = Array.from({ length: this.rows }, () => this.blankRow());
                this.clears += 1;
              }
              break;
            case "K":
              if (params === "2") this.screen[this.row] = this.blankRow();
              else for (let c = this.col; c < this.cols; c++) this.screen[this.row]![c] = " ";
              break;
            default: break; // SGR etc.
          }
        }
        i = j + 1;
        continue;
      }
      if (ch === "\n") { this.col = 0; this.lineFeed(); i += 1; continue; } // tty ONLCR
      if (ch === "\r") { this.col = 0; i += 1; continue; }
      if (ch === "") { i += 1; continue; }
      if (this.col < this.cols) {
        this.screen[this.row]![this.col] = ch;
        this.col += 1;
      }
      i += 1;
    }
  }

  snapshot(): string[] {
    return this.screen.map((r) => r.join("").replace(/\s+$/g, ""));
  }
}

class VTStdout extends EventEmitter {
  isTTY = true;
  rows = ROWS;
  columns = COLS;
  term = new VTerm(ROWS, COLS);
  write(chunk: string): boolean {
    this.term.write(String(chunk));
    return true;
  }
}

class VTStdin extends EventEmitter {
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

// ── App-shaped harness (real Pane + BusyLine, App.tsx layout skeleton) ──
function makeFlatLine(i: number, text: string): FlatLine {
  return { key: `e${i}:0`, label: "claude ", text, speakerColor: "cyan", bodyColor: "white" };
}

function AppShape({
  flatLines,
  busy,
  inputLines,
  projectsVisible,
}: {
  flatLines: FlatLine[];
  busy: boolean;
  inputLines: number;
  projectsVisible: boolean;
}) {
  const inputHeight = 4 + Math.max(1, inputLines);
  const paneHeight = Math.max(4, FRAME_ROWS - inputHeight - 1);
  return (
    <Box flexDirection="column" height={FRAME_ROWS}>
      <Box flexDirection="row" flexGrow={1} marginBottom={1}>
        {projectsVisible ? (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={THEME.chrome}
            overflow="hidden"
            height={paneHeight}
            width={24}
            paddingX={1}
          >
            <Text bold color={THEME.textMuted}>PROJECTS</Text>
            <Text color={THEME.text}>● Inbox</Text>
            <Text color={THEME.text}>  ▸ paper-review</Text>
          </Box>
        ) : null}
        <Pane
          title="COUNCIL"
          pane="room"
          flatLines={flatLines}
          focused
          height={paneHeight}
          contentHeight={paneHeight - 3}
          textWidth={COLS - 30}
          scrollOffset={0}
          hasNewMessages={false}
          selection={null}
        />
      </Box>
      <Box flexDirection="column" marginBottom={1} width="100%">
        <Text color={THEME.chromeMuted}>{"─".repeat(COLS - 2)}</Text>
        <Text color={THEME.statusMuted}>
          {busy ? <BusyLine text="claude is responding" frameIntervalMs={10_000_000} /> : " "}
        </Text>
        <Text color={THEME.text}>{"You (@claude/@codex/@all, /help):"}</Text>
        <Box flexDirection="column" paddingX={1} paddingY={1} backgroundColor="black" width="100%" overflow="hidden">
          {Array.from({ length: Math.max(1, inputLines) }, (_, i) => (
            <Text key={i} color={THEME.text}>{i === 0 ? "hello world" : `line ${i + 1}`}</Text>
          ))}
        </Box>
      </Box>
      <Box height={1} paddingX={1}>
        <Text color={THEME.textMuted}>Project: Inbox | Mode: public | Lead: auto</Text>
      </Box>
    </Box>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Step = { flatLines: FlatLine[]; busy: boolean; inputLines: number; projectsVisible: boolean };

async function runScenario(steps: Step[]): Promise<{ screen: string[]; scrolls: number; clears: number }> {
  const stdout = new VTStdout();
  const stdin = new VTStdin();
  const app = render(<AppShape {...steps[0]!} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await sleep(50);
  for (const step of steps.slice(1)) {
    app.rerender(<AppShape {...step} />);
    await sleep(50);
  }
  const screen = stdout.term.snapshot();
  const { scrolls, clears } = stdout.term;
  app.unmount();
  await sleep(20);
  return { screen, scrolls, clears };
}

test("line-count churn leaves the screen identical to a fresh render (no orphan borders)", async () => {
  const base = Array.from({ length: 30 }, (_, i) => makeFlatLine(i, `line ${i} content`));
  const grown = [...base, makeFlatLine(30, "streamed line 30"), makeFlatLine(31, "streamed 31")];
  // Streaming, busy toggle, input area grow/shrink, projects panel toggle —
  // every mutation that changes how many terminal lines each region spans.
  const steps: Step[] = [
    { flatLines: base, busy: false, inputLines: 1, projectsVisible: true },
    { flatLines: base, busy: true, inputLines: 1, projectsVisible: true },
    { flatLines: [...base, makeFlatLine(30, "streamed line 30")], busy: true, inputLines: 1, projectsVisible: true },
    { flatLines: grown, busy: true, inputLines: 3, projectsVisible: true },
    { flatLines: grown, busy: true, inputLines: 1, projectsVisible: false },
    { flatLines: grown, busy: true, inputLines: 1, projectsVisible: true },
  ];

  const scenario = await runScenario(steps);
  const fresh = await runScenario([steps[steps.length - 1]!]);

  const mismatches: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    if (scenario.screen[r] !== fresh.screen[r]) {
      mismatches.push(`row ${r}: got ${JSON.stringify(scenario.screen[r])}, want ${JSON.stringify(fresh.screen[r])}`);
    }
  }
  assert.deepStrictEqual(
    mismatches,
    [],
    `screen corrupted after line-count churn:\n${mismatches.join("\n")}`,
  );
  assert.strictEqual(scenario.clears, 0, "must never repaint via clearTerminal");
  assert.strictEqual(scenario.scrolls, 0, "frame must never spill past the terminal bottom");
});
