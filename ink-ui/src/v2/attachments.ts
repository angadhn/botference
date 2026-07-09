import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;

export interface PasteToken {
  type: "text" | "image";
  value: string;
}

/** Normalize one pasted path candidate.

    Handles what terminals actually deliver: Finder drag-drop backslash-escapes
    spaces/parens (`/a/Screen\ Shot.png`), some drops arrive quoted, and some
    arrive as file:// URLs with percent-encoding. `~` expands to the home dir.
*/
export function normalizePathCandidate(
  raw: string,
  homedir: string = os.homedir(),
): string {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
    || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1);
  }
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.slice("file://".length));
    } catch {
      s = s.slice("file://".length);
    }
  }
  s = s.replace(/\\(.)/g, "$1");
  if (s === "~" || s.startsWith("~/")) {
    s = path.join(homedir, s.slice(1));
  }
  return s;
}

/** Split one pasted line into whitespace-separated candidates, honoring
    backslash-escaped spaces and quoted segments (multi-file drag-drop
    pastes several paths on a single line). */
export function splitPathCandidates(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && i + 1 < line.length) {
      current += ch + line[i + 1];
      i++;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function looksLikePath(candidate: string): boolean {
  return (
    candidate.startsWith("/")
    || candidate.startsWith("~")
    || candidate.startsWith("file://")
    || candidate.startsWith('"/')
    || candidate.startsWith("'/")
  );
}

/** Break pasted text into text and image-attachment tokens.

    Only candidates that look like a path, have an image extension, AND exist
    on disk become attachments — a nonexistent path stays visible as text
    instead of turning into a placeholder for an image nobody can read
    (silent drops were how pastes reached the bots as bare "[image N]").
*/
export function tokenizePaste(
  pasted: string,
  fileExists: (p: string) => boolean = existsSync,
  homedir: string = os.homedir(),
): PasteToken[] {
  const tokens: PasteToken[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === "text") last.value += value;
    else tokens.push({ type: "text", value });
  };

  const lines = pasted.split(/(\r\n|\r|\n)/);
  for (const line of lines) {
    if (line === "\r\n" || line === "\r" || line === "\n") {
      pushText("\n");
      continue;
    }
    if (!line) continue;

    const candidates = splitPathCandidates(line);
    const hasAnyPath = candidates.some(
      (c) => looksLikePath(c) && IMAGE_EXTS.test(normalizePathCandidate(c, homedir)),
    );
    if (!hasAnyPath) {
      pushText(line);
      continue;
    }

    let pendingText: string[] = [];
    for (const candidate of candidates) {
      const normalized = normalizePathCandidate(candidate, homedir);
      if (
        looksLikePath(candidate)
        && IMAGE_EXTS.test(normalized)
        && fileExists(normalized)
      ) {
        if (pendingText.length) {
          pushText(pendingText.join(" ") + " ");
          pendingText = [];
        }
        tokens.push({ type: "image", value: normalized });
      } else {
        pendingText.push(candidate);
      }
    }
    if (pendingText.length) pushText(pendingText.join(" "));
  }
  return tokens;
}

/** Save a raw image from the macOS clipboard (screenshot Cmd+C, browser
    "Copy Image") to a PNG file. Returns the file path, or null when the
    clipboard holds no image (or not on macOS). Terminals only deliver
    *text* through paste events, so raw image data needs this side channel.
*/
export function saveClipboardImage(
  destDir: string = os.tmpdir(),
  runner: typeof execFile = execFile,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== "darwin") return Promise.resolve(null);
  const dest = path.join(
    destDir,
    `botference-clipboard-${Date.now()}-${process.pid}.png`,
  );
  const script = [
    "try",
    "set imgData to the clipboard as «class PNGf»",
    "on error",
    'return "NOIMG"',
    "end try",
    `set f to open for access POSIX file "${dest}" with write permission`,
    "set eof f to 0",
    "write imgData to f",
    "close access f",
    'return "OK"',
  ];
  const args = script.flatMap((line) => ["-e", line]);
  return new Promise((resolve) => {
    runner("osascript", args, (error, stdout) => {
      if (error || String(stdout).trim() !== "OK") resolve(null);
      else resolve(dest);
    });
  });
}
