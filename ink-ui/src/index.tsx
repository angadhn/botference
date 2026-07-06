import React from "react";
import { render } from "ink";
import { Transform } from "node:stream";
import App from "./App";
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_BRACKETED_PASTE,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  createSuspendResumeController,
  restoreTerminalSync,
  terminalRestoreSequence,
  writeTerminalSequenceSync,
} from "./v2/terminalModes.js";
import {
  createTerminalInputFilterState,
  processTerminalInputChunk,
  type MouseEventInfo,
} from "./v2/stdinFilter.js";
// Re-export so consumers (App.tsx) can import the type from the index module.
export type { MouseEventInfo } from "./v2/stdinFilter.js";

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

// True once the final terminal restore has run (any exit path). Declared here
// because setMouseTrackingEnabled consults it and runs at module load.
let didRestoreTerminal = false;

let mouseTrackingEnabled = false;

export function setMouseTrackingEnabled(enabled: boolean) {
  if (!process.stdout.isTTY || mouseTrackingEnabled === enabled) return;
  // Never re-enable after the final terminal restore. Ink's own exit hook
  // unmounts the React tree AFTER our process 'exit' restore has run, and an
  // App effect cleanup calls setMouseTrackingEnabled(true) — without this
  // guard that re-enables mouse tracking on the way out and the shell prompt
  // receives escape-sequence garbage on every mouse move.
  if (enabled && didRestoreTerminal) return;
  mouseTrackingEnabled = enabled;
  if (enabled) {
    process.stdout.write(ENABLE_MOUSE_TRACKING);
  } else {
    process.stdout.write(DISABLE_MOUSE_TRACKING);
    mouseTrackingEnabled = false;
  }
}

// ── Stdin filter transform ─────────────────────────────────

const terminalInputState = createTerminalInputFilterState();

const stdinFilter = new Transform({
  transform(chunk, _enc, cb) {
    const events = processTerminalInputChunk(
      terminalInputState,
      chunk.toString("utf-8"),
    );
    if (events.wheelSteps !== 0) {
      scrollHandlers.forEach((h) => h(events.wheelSteps));
    }
    events.mouseEvents.forEach((event) => {
      mouseEventHandlers.forEach((h) => h(event));
    });
    for (let i = 0; i < events.shiftEnterCount; i++) {
      shiftEnterHandlers.forEach((h) => h());
    }
    events.pastes.forEach((pasted) => {
      pasteHandlers.forEach((h) => h(pasted));
    });
    if (events.suspendCount > 0 && process.stdout.isTTY) {
      // Ctrl+Z arrives as a raw 0x1a byte while stdin is in raw mode (ISIG is
      // off), so the terminal never sends SIGTSTP itself. Translate it into a
      // real SIGTSTP so the suspend path (terminal restore + job stop) runs.
      process.kill(process.pid, "SIGTSTP");
    }
    cb(null, events.text.length > 0 ? Buffer.from(events.text, "utf-8") : undefined);
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
    anthropicModel: "claude-fable-5",
    openaiModel: "gpt-5.4",
    openaiEffort: "",
    systemPromptFile: "",
    taskFile: "",
    debugPanes: false,
    claudeEffort: "",
    claudeTransport: process.env["BOTFERENCE_CLAUDE_TRANSPORT"] ?? "programmatic",
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

function restoreTerminal() {
  if (didRestoreTerminal) return;
  didRestoreTerminal = true;
  mouseTrackingEnabled = false;
  try {
    process.stdin.unpipe(stdinFilter);
  } catch {
    // stdin may already be torn down
  }
  restoreTerminalSync({ useAltScreen });
}

// Guarantee terminal modes are restored on ANY exit path.
// process.on('exit') fires for normal exits, SIGINT, SIGTERM, uncaught errors,
// and process.exit() calls — it's the last-resort cleanup. Handlers here may
// only perform synchronous work (async writes never flush after 'exit').
process.on("exit", () => {
  restoreTerminal();
});

process.on("SIGINT", () => {
  process.exit(0);
});
process.on("SIGTERM", () => {
  process.exit(0);
});
process.on("SIGHUP", () => {
  // Terminal went away; still run the 'exit' restore so a reattached tty
  // (e.g. tmux) is left clean.
  process.exit(0);
});

// ── Suspend/resume (Ctrl+Z → SIGTSTP, fg → SIGCONT) ────────
// Without this, SIGTSTP stops the process while mouse tracking, bracketed
// paste, and the alt screen are still enabled — the shell then receives raw
// escape sequences on every mouse move ("garbage in the prompt").

const suspendController = createSuspendResumeController(
  { useAltScreen },
  {
    write: writeTerminalSequenceSync,
    setRawMode: (raw: boolean) => {
      process.stdin.setRawMode?.(raw);
    },
    isRaw: () =>
      (process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw === true,
    isExiting: () => didRestoreTerminal,
    getMouseTracking: () => mouseTrackingEnabled,
    raiseSigtstp: () => {
      // Drop our handler so SIGTSTP regains its default disposition (stop),
      // then re-deliver it to the WHOLE foreground process group (pid 0) —
      // the launcher shell script and the Python bridge must stop too, or the
      // interactive shell never notices the job is suspended. This mirrors
      // what the terminal driver does for Ctrl+Z when ISIG is enabled.
      // The SIGCONT handler reinstalls us when the job is resumed.
      process.removeListener("SIGTSTP", onSigtstp);
      try {
        process.kill(0, "SIGTSTP");
      } catch {
        process.kill(process.pid, "SIGTSTP");
      }
    },
    onResume: () => {
      try {
        // The alt screen was reset while suspended; force a full repaint.
        inkApp?.clear();
        inkApp?.rerender(<App bridgeArgs={bridgeArgs} />);
      } catch {
        // app not mounted yet — nothing to repaint
      }
    },
  },
);

function onSigtstp() {
  suspendController.suspend();
}

process.on("SIGTSTP", onSigtstp);
process.on("SIGCONT", () => {
  if (!process.listeners("SIGTSTP").includes(onSigtstp)) {
    process.on("SIGTSTP", onSigtstp);
  }
  suspendController.resume();
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

const inkApp = render(<App bridgeArgs={bridgeArgs} />, {
  exitOnCtrlC: false,
  stdin: stdinFilter as unknown as NodeJS.ReadStream,
});

// Backstop: registered AFTER render() so it runs after Ink's own exit hook
// (Node fires 'exit' listeners in registration order). Ink's hook unmounts the
// React tree, which can write to stdout after our first restore ran; re-issue
// the mode disables last so nothing can leak past them. Sync writes only.
process.on("exit", () => {
  writeTerminalSequenceSync(terminalRestoreSequence({ useAltScreen: false }));
});
