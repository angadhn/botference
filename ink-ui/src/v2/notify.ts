import { tmuxPassthrough } from "./clipboard.js";

const ESC = "\x1b";
const BEL = "\x07";

export interface NotifyOptions {
  env?: NodeJS.ProcessEnv;
  writeStdout?: (text: string) => void;
}

/** Strip control characters and OSC separators so text can't break the sequence. */
export function sanitizeNotificationText(text: string, maxLength = 120): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x1f\x7f;]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

/** Terminals known to implement OSC 777 notify (title + body). */
export function supportsOsc777(env: NodeJS.ProcessEnv): boolean {
  const program = (env["TERM_PROGRAM"] ?? "").toLowerCase();
  const term = (env["TERM"] ?? "").toLowerCase();
  return ["ghostty", "wezterm", "foot"].some(
    (name) => program.includes(name) || term.includes(name),
  );
}

/**
 * Desktop-notification escape sequence: OSC 777 where supported (separate
 * title and body), OSC 9 everywhere else (iTerm2, kitty, Windows Terminal…).
 * Wrapped in a tmux passthrough when running inside tmux.
 */
export function notificationSequence(
  title: string,
  body: string,
  env: NodeJS.ProcessEnv,
): string {
  const safeTitle = sanitizeNotificationText(title, 40) || "botference";
  const safeBody = sanitizeNotificationText(body);
  const raw = supportsOsc777(env)
    ? `${ESC}]777;notify;${safeTitle};${safeBody}${BEL}`
    : `${ESC}]9;${safeTitle}: ${safeBody}${BEL}`;
  return env["TMUX"] ? tmuxPassthrough(raw) : raw;
}

/** Ask the terminal to post a desktop notification (typically shown while unfocused). */
export function sendDesktopNotification(
  title: string,
  body: string,
  options: NotifyOptions = {},
): void {
  const env = options.env ?? process.env;
  const writeStdout =
    options.writeStdout ?? ((sequence: string) => process.stdout.write(sequence));
  writeStdout(notificationSequence(title, body, env));
}
