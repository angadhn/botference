import { closeSync, constants as fsConstants, openSync, readSync, rmSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ?1002 = button-event tracking (report motion only WHILE a button is held), not
// ?1003 = any-event tracking (report every motion sample). Any-event tracking turned
// each trackpad movement into a stream of escape sequences that (a) leaked as
// "gibberish" text whenever the input loop stalled and (b) fed phantom drag-selects.
// ?1006 keeps SGR extended coordinates. Scroll-wheel events are still reported.
export const ENABLE_MOUSE_TRACKING = "\x1b[?1006h\x1b[?1002h";
export const DISABLE_MOUSE_TRACKING = "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
export const SHOW_CURSOR = "\x1b[?25h";
export const HIDE_CURSOR = "\x1b[?25l";

export interface RestoreSequenceOptions {
  useAltScreen: boolean;
}

export function terminalRestoreSequence(options: RestoreSequenceOptions): string {
  return [
    options.useAltScreen ? EXIT_ALT_SCREEN : "",
    DISABLE_MOUSE_TRACKING,
    DISABLE_BRACKETED_PASTE,
    SHOW_CURSOR,
  ].join("");
}

export interface ResumeSequenceOptions {
  useAltScreen: boolean;
  mouseTracking: boolean;
  bracketedPaste: boolean;
  /** Ink hides the cursor while mounted; the suspend restore re-showed it. */
  hideCursor: boolean;
}

/** Sequence that re-establishes the terminal modes after a SIGCONT resume. */
export function terminalResumeSequence(options: ResumeSequenceOptions): string {
  return [
    options.useAltScreen ? ENTER_ALT_SCREEN : "",
    options.mouseTracking ? ENABLE_MOUSE_TRACKING : "",
    options.bracketedPaste ? ENABLE_BRACKETED_PASTE : "",
    options.hideCursor ? HIDE_CURSOR : "",
  ].join("");
}

/**
 * Write an escape sequence to the terminal using only synchronous writes so it
 * is safe inside process 'exit' and signal handlers (async stdout writes are
 * dropped when the process stops or exits before they flush).
 */
export function writeTerminalSequenceSync(sequence: string): void {
  if (!process.stdout.isTTY || sequence.length === 0) return;
  try {
    writeSync(1, sequence);
  } catch {
    try {
      process.stdout.write(sequence);
    } catch {
      // stdout is gone; nothing left to restore
    }
  }
}

// ── SIGTSTP / SIGCONT suspend-resume ─────────────────────────
// Default SIGTSTP disposition stops the process with mouse tracking, bracketed
// paste, and the alternate screen still enabled, so the shell prompt receives
// raw mouse escape sequences on every pointer move. The controller below
// restores the terminal synchronously, lets the caller re-raise SIGTSTP with
// default disposition (so the shell really suspends the job), and re-enters
// the modes on SIGCONT.

export interface SuspendResumeIO {
  /** Synchronously write an escape sequence to the terminal. */
  write(sequence: string): void;
  setRawMode(raw: boolean): void;
  isRaw(): boolean;
  /** True once the app has begun its final terminal restore (exiting). */
  isExiting(): boolean;
  /** Whether mouse tracking is currently enabled (Ctrl+Y can disable it). */
  getMouseTracking(): boolean;
  /** Re-deliver SIGTSTP with default disposition so the process stops. */
  raiseSigtstp(): void;
  /** Repaint hook, invoked after terminal modes are re-established. */
  onResume(): void;
}

export interface SuspendResumeController {
  suspend(): void;
  resume(): void;
  isSuspended(): boolean;
}

export function createSuspendResumeController(
  options: RestoreSequenceOptions,
  io: SuspendResumeIO,
): SuspendResumeController {
  let suspended = false;
  let wasRaw = false;
  let hadMouseTracking = false;

  return {
    suspend(): void {
      if (!io.isExiting() && !suspended) {
        suspended = true;
        wasRaw = io.isRaw();
        hadMouseTracking = io.getMouseTracking();
        io.write(terminalRestoreSequence(options));
        try {
          io.setRawMode(false);
        } catch {
          // stdin may already be torn down
        }
      }
      // Always re-raise so Ctrl+Z / kill -TSTP actually suspends the job.
      io.raiseSigtstp();
    },

    resume(): void {
      if (!suspended || io.isExiting()) return;
      suspended = false;
      io.write(
        terminalResumeSequence({
          useAltScreen: options.useAltScreen,
          mouseTracking: hadMouseTracking,
          bracketedPaste: true,
          hideCursor: true,
        }),
      );
      if (wasRaw) {
        try {
          io.setRawMode(true);
        } catch {
          // stdin may already be torn down
        }
      }
      io.onResume();
    },

    isSuspended(): boolean {
      return suspended;
    },
  };
}

export function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) return;
  try {
    while (stdin.read() !== null) {
      // discard pending mouse/paste bytes buffered by Node
    }
  } catch {
    // stream may already be closing
  }

  if (process.platform === "win32") return;
  const tty = stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (raw: boolean) => void;
  };
  const wasRaw = tty.isRaw === true;
  let fd = -1;
  try {
    if (!wasRaw) tty.setRawMode?.(true);
    fd = openSync("/dev/tty", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const buf = Buffer.alloc(1024);
    for (let i = 0; i < 64; i++) {
      if (readSync(fd, buf, 0, buf.length, null) <= 0) break;
    }
  } catch {
    // no controlling tty or nothing to drain
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (!wasRaw) {
      try {
        tty.setRawMode?.(false);
      } catch {
        // ignore
      }
    }
  }
}

export function disableRawMode(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) return;
  const tty = stdin as NodeJS.ReadStream & {
    setRawMode?: (raw: boolean) => void;
  };
  try {
    tty.setRawMode?.(false);
  } catch {
    // stream may already be closing
  }
}

export function cleanupStagedImages(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  rmSync(resolve(repoRoot, ".botference", "tmp"), { recursive: true, force: true });
}

export function restoreTerminalSync(options: RestoreSequenceOptions): void {
  if (process.stdout.isTTY) {
    try {
      writeSync(1, terminalRestoreSequence(options));
    } catch {
      process.stdout.write(terminalRestoreSequence(options));
    }
    disableRawMode();
    drainStdin();
  }
  cleanupStagedImages();
}
