import React from "react";
import { render } from "ink";
import { Transform } from "node:stream";
import { rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import App from "./App";

// ── Mouse scroll support via stdin filter ──────────────────
// Strip SGR 1006 mouse sequences from stdin before Ink sees them.
// Emit scroll events for panels to consume.
// Pattern: Howler TUI (apps/tui/src/bin.tsx)

type ScrollHandler = (direction: "up" | "down") => void;
const scrollHandlers: ScrollHandler[] = [];
export function onMouseScroll(handler: ScrollHandler) {
  scrollHandlers.push(handler);
  return () => {
    const idx = scrollHandlers.indexOf(handler);
    if (idx >= 0) scrollHandlers.splice(idx, 1);
  };
}

// ── Bracketed paste support ────────────────────────────────
// Detect paste boundaries (\x1b[200~ start, \x1b[201~ end)
// and dispatch the full pasted text to handlers.

type PasteHandler = (text: string) => void;
const pasteHandlers: PasteHandler[] = [];
export function onPaste(handler: PasteHandler) {
  pasteHandlers.push(handler);
  return () => {
    const idx = pasteHandlers.indexOf(handler);
    if (idx >= 0) pasteHandlers.splice(idx, 1);
  };
}

// ── Shift+Enter support via stdin filter ───────────────────
// Terminals send distinct escape sequences for Shift+Enter that Ink
// can't parse without kitty protocol. We intercept them here.
//   xterm modifyOtherKeys: \x1b[27;2;13~
//   kitty protocol:        \x1b[13;2u

type ShiftEnterHandler = () => void;
const shiftEnterHandlers: ShiftEnterHandler[] = [];
export function onShiftEnter(handler: ShiftEnterHandler) {
  shiftEnterHandlers.push(handler);
  return () => {
    const idx = shiftEnterHandlers.indexOf(handler);
    if (idx >= 0) shiftEnterHandlers.splice(idx, 1);
  };
}

// ── Stdin filter transform ─────────────────────────────────

const MOUSE_SEQ = /\x1b\[<(\d+);(\d+);(\d+)[mM]/g;
const SHIFT_ENTER_SEQS = [
  "\x1b[27;2;13~", // xterm modifyOtherKeys
  "\x1b[13;2u",    // kitty protocol
];
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

let pasteBuffer: string | null = null; // non-null = inside a paste

const stdinFilter = new Transform({
  transform(chunk, _enc, cb) {
    let text = chunk.toString("utf-8");

    // Handle mouse scroll sequences
    MOUSE_SEQ.lastIndex = 0;
    let m;
    while ((m = MOUSE_SEQ.exec(text)) !== null) {
      const btn = parseInt(m[1]!, 10);
      if (btn === 64) scrollHandlers.forEach((h) => h("up"));
      else if (btn === 65) scrollHandlers.forEach((h) => h("down"));
    }
    MOUSE_SEQ.lastIndex = 0;
    text = text.replace(MOUSE_SEQ, "");

    // Handle Shift+Enter sequences — strip and dispatch
    for (const seq of SHIFT_ENTER_SEQS) {
      while (text.includes(seq)) {
        text = text.replace(seq, "");
        shiftEnterHandlers.forEach((h) => h());
      }
    }

    // Handle bracketed paste boundaries
    while (text.length > 0) {
      if (pasteBuffer !== null) {
        // Inside a paste — look for end marker
        const endIdx = text.indexOf(PASTE_END);
        if (endIdx >= 0) {
          pasteBuffer += text.slice(0, endIdx);
          const pasted = pasteBuffer;
          pasteBuffer = null;
          pasteHandlers.forEach((h) => h(pasted));
          text = text.slice(endIdx + PASTE_END.length);
        } else {
          // End marker not yet received — buffer everything
          pasteBuffer += text;
          text = "";
        }
      } else {
        // Outside a paste — look for start marker
        const startIdx = text.indexOf(PASTE_START);
        if (startIdx >= 0) {
          // Forward text before the paste marker to Ink
          const before = text.slice(0, startIdx);
          if (before.length > 0) {
            this.push(Buffer.from(before, "utf-8"));
          }
          pasteBuffer = "";
          text = text.slice(startIdx + PASTE_START.length);
        } else {
          break; // no more paste markers
        }
      }
    }

    // Forward remaining non-paste, non-mouse text to Ink
    cb(null, text.length > 0 ? Buffer.from(text, "utf-8") : undefined);
  },
});

// Proxy TTY properties so Ink can set raw mode on real stdin
Object.defineProperty(stdinFilter, "isTTY", { value: process.stdin.isTTY });
Object.defineProperty(stdinFilter, "setRawMode", {
  value: (mode: boolean) => {
    process.stdin.setRawMode?.(mode);
    return stdinFilter;
  },
});
Object.defineProperty(stdinFilter, "ref", {
  value: () => {
    process.stdin.ref();
    return stdinFilter;
  },
});
Object.defineProperty(stdinFilter, "unref", {
  value: () => {
    process.stdin.unref();
    return stdinFilter;
  },
});

// Enable terminal modes
if (process.stdout.isTTY) {
  process.stdout.write("\x1b[?1006h"); // SGR 1006 mouse mode
  process.stdout.write("\x1b[?1003h"); // Any-event tracking (for wheel)
  process.stdout.write("\x1b[?2004h"); // Bracketed paste mode
}
process.stdin.pipe(stdinFilter);

// ── Parse CLI args ─────────────────────────────────────────
// All large strings (system prompt, task) are passed as FILE PATHS
// to avoid ARG_MAX limits. The bridge reads them directly.

function parseArgs(argv: string[]) {
  const args = {
    anthropicModel: "claude-sonnet-4-6",
    openaiModel: "gpt-5.4",
    openaiEffort: "",
    systemPromptFile: "",
    taskFile: "",
    debugPanes: false,
    claudeEffort: "",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--anthropic-model":
        args.anthropicModel = argv[++i] ?? args.anthropicModel;
        break;
      case "--openai-model":
        args.openaiModel = argv[++i] ?? args.openaiModel;
        break;
      case "--openai-effort":
        args.openaiEffort = argv[++i] ?? "";
        break;
      case "--system-prompt-file":
        args.systemPromptFile = argv[++i] ?? "";
        break;
      case "--task-file":
        args.taskFile = argv[++i] ?? "";
        break;
      case "--debug-panes":
        args.debugPanes = true;
        break;
      case "--claude-effort":
        args.claudeEffort = argv[++i] ?? "";
        break;
    }
  }

  return args;
}

// ── Alternate screen buffer ─────────────────────────────────

const useAltScreen = !process.env["INK_DEBUG"];

if (useAltScreen) {
  process.stdout.write("\x1b[?1049h");
}

function restoreTerminal() {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?1003l"); // Disable any-event mouse tracking
    process.stdout.write("\x1b[?1006l"); // Disable SGR mouse mode
    process.stdout.write("\x1b[?2004l"); // Disable bracketed paste
  }
  if (useAltScreen) {
    process.stdout.write("\x1b[?1049l");
  }
  // Clean up staged image attachments
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  rmSync(resolve(repoRoot, ".botference", "tmp"), { recursive: true, force: true });
}

// Guarantee terminal modes are restored on ANY exit path.
// process.on('exit') fires for normal exits, SIGINT, SIGTERM, uncaught errors,
// and process.exit() calls — it's the last-resort cleanup.
process.on("exit", () => {
  restoreTerminal();
});

process.on("SIGINT", () => {
  process.exit(0);
});
process.on("SIGTERM", () => {
  process.exit(0);
});

// Log uncaught errors visibly before exit
process.on("uncaughtException", (err) => {
  restoreTerminal();
  console.error("Ink TUI crashed:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  restoreTerminal();
  console.error("Ink TUI unhandled rejection:", err);
  process.exit(1);
});

// ── Render ─────────────────────────────────────────────────

const bridgeArgs = parseArgs(process.argv);

render(<App bridgeArgs={bridgeArgs} />, {
  exitOnCtrlC: false,
  stdin: stdinFilter as unknown as NodeJS.ReadStream,
});
