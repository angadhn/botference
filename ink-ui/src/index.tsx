import React from "react";
import { render } from "ink";
import { Transform } from "node:stream";
import App from "./App";
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_BRACKETED_PASTE,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  restoreTerminalSync,
} from "./v2/terminalModes.js";

// ── Mouse scroll support via stdin filter ──────────────────
// Strip SGR 1006 mouse sequences from stdin before Ink sees them.
// Emit scroll events for panels to consume.
// Pattern: Howler TUI (apps/tui/src/bin.tsx)

type ScrollHandler = (wheelSteps: number) => void;
const scrollHandlers: ScrollHandler[] = [];
export function onMouseScroll(handler: ScrollHandler) {
  scrollHandlers.push(handler);
  return () => {
    const idx = scrollHandlers.indexOf(handler);
    if (idx >= 0) scrollHandlers.splice(idx, 1);
  };
}

export interface MouseEventInfo {
  kind: "press" | "drag" | "release";
  x: number;
  y: number;
}

type MouseEventHandler = (event: MouseEventInfo) => void;
const mouseEventHandlers: MouseEventHandler[] = [];
export function onMouseEvent(handler: MouseEventHandler) {
  mouseEventHandlers.push(handler);
  return () => {
    const idx = mouseEventHandlers.indexOf(handler);
    if (idx >= 0) mouseEventHandlers.splice(idx, 1);
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

// ── Mouse tracking terminal mode ───────────────────────────

let mouseTrackingEnabled = false;

export function setMouseTrackingEnabled(enabled: boolean) {
  if (!process.stdout.isTTY || mouseTrackingEnabled === enabled) return;
  mouseTrackingEnabled = enabled;
  if (enabled) {
    process.stdout.write(ENABLE_MOUSE_TRACKING);
  } else {
    process.stdout.write(DISABLE_MOUSE_TRACKING);
    mouseTrackingEnabled = false;
  }
}

// ── Stdin filter transform ─────────────────────────────────

const MOUSE_SEQ = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
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
    let wheelSteps = 0;
    while ((m = MOUSE_SEQ.exec(text)) !== null) {
      const btn = parseInt(m[1]!, 10);
      if (btn === 64) wheelSteps += 1;
      else if (btn === 65) wheelSteps -= 1;
      else {
        const x = Math.max(0, parseInt(m[2]!, 10) - 1);
        const y = Math.max(0, parseInt(m[3]!, 10) - 1);
        const suffix = m[4]!;
        const kind = suffix === "m"
          ? "release"
          : (btn & 32) === 32
            ? "drag"
            : "press";
        mouseEventHandlers.forEach((h) => h({ kind, x, y }));
      }
    }
    if (wheelSteps !== 0) {
      scrollHandlers.forEach((h) => h(wheelSteps));
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
  setMouseTrackingEnabled(true);
  process.stdout.write(ENABLE_BRACKETED_PASTE); // Bracketed paste mode
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
    claudeTransport: process.env["BOTFERENCE_CLAUDE_TRANSPORT"] ?? "programmatic",
    inkLegacy: false,
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
      case "--ink-legacy":
        args.inkLegacy = true;
        break;
      case "--ink-v2":
        args.inkLegacy = false;
        break;
      case "--claude-effort":
        args.claudeEffort = argv[++i] ?? "";
        break;
      case "--claude-transport":
        args.claudeTransport = argv[++i] ?? args.claudeTransport;
        break;
      case "--claude-interactive":
        args.claudeTransport = "tmux";
        break;
    }
  }

  return args;
}

// ── Alternate screen buffer ─────────────────────────────────

const useAltScreen = !process.env["INK_DEBUG"];

if (useAltScreen) {
  process.stdout.write(ENTER_ALT_SCREEN);
}

let didRestoreTerminal = false;

function restoreTerminal() {
  if (didRestoreTerminal) return;
  didRestoreTerminal = true;
  mouseTrackingEnabled = false;
  restoreTerminalSync({ useAltScreen });
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
