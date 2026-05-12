import { closeSync, constants as fsConstants, openSync, readSync, rmSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ENABLE_MOUSE_TRACKING = "\x1b[?1006h\x1b[?1003h";
export const DISABLE_MOUSE_TRACKING = "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
export const SHOW_CURSOR = "\x1b[?25h";

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
    drainStdin();
  }
  cleanupStagedImages();
}
