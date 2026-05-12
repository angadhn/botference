import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

export type ClipboardPath = "native" | "tmux-buffer" | "osc52";

export interface ClipboardEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface ClipboardResult {
  ok: boolean;
  path: ClipboardPath;
  details: string;
  bytes: number;
}

export interface ClipboardOptions extends ClipboardEnv {
  writeStdout?: (text: string) => void;
  spawnFile?: (command: string, args: string[], input: string) => Promise<number>;
  logPath?: string | null;
}

function platformOf(options: ClipboardEnv): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function envOf(options: ClipboardEnv): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

export function getClipboardPath(options: ClipboardEnv = {}): ClipboardPath {
  const env = envOf(options);
  const platform = platformOf(options);
  if (platform === "darwin" && !env["SSH_CONNECTION"]) return "native";
  if (env["TMUX"]) return "tmux-buffer";
  return "osc52";
}

export function osc52Sequence(text: string): string {
  const encoded = Buffer.from(text, "utf-8").toString("base64");
  return `${ESC}]52;c;${encoded}${BEL}`;
}

export function tmuxPassthrough(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`;
}

function defaultLogPath(): string | null {
  if (process.env["BOTFERENCE_INK_LOG"] === "0") return null;
  return process.env["BOTFERENCE_INK_LOG"]
    ?? path.join(process.cwd(), ".botference", "ink-v2.log");
}

async function logClipboardResult(result: ClipboardResult, logPath: string | null | undefined): Promise<void> {
  const target = logPath === undefined ? defaultLogPath() : logPath;
  if (!target) return;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(
      target,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "ink_v2_clipboard_copy",
        ...result,
      }) + "\n",
      "utf-8",
    );
  } catch {
    // Clipboard diagnostics should never make selection fail.
  }
}

function spawnWithInput(command: string, args: string[], input: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", () => resolve(127));
    proc.on("close", (code) => resolve(code ?? 0));
    proc.stdin?.end(input);
  });
}

async function copyNative(
  text: string,
  options: ClipboardOptions,
): Promise<boolean> {
  const platform = platformOf(options);
  const spawnFile = options.spawnFile ?? spawnWithInput;
  if (platform === "darwin") {
    return (await spawnFile("pbcopy", [], text)) === 0;
  }
  if (platform === "linux") {
    for (const candidate of [
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
    ] as const) {
      if ((await spawnFile(candidate[0], [...candidate[1]], text)) === 0) return true;
    }
  }
  if (platform === "win32") {
    return (await spawnFile("clip", [], text)) === 0;
  }
  return false;
}

async function tmuxLoadBuffer(
  text: string,
  options: ClipboardOptions,
): Promise<boolean> {
  const env = envOf(options);
  if (!env["TMUX"]) return false;
  const spawnFile = options.spawnFile ?? spawnWithInput;
  const args = env["LC_TERMINAL"] === "iTerm2"
    ? ["load-buffer", "-"]
    : ["load-buffer", "-w", "-"];
  return (await spawnFile("tmux", args, text)) === 0;
}

export async function copyToClipboard(
  text: string,
  options: ClipboardOptions = {},
): Promise<ClipboardResult> {
  const trimmed = text.length;
  const pathChoice = getClipboardPath(options);
  if (!text) {
    const result = { ok: false, path: pathChoice, details: "empty selection", bytes: 0 };
    await logClipboardResult(result, options.logPath);
    return result;
  }

  const env = envOf(options);
  const writeStdout = options.writeStdout ?? ((sequence: string) => process.stdout.write(sequence));
  let ok = false;
  let details = "";

  if (!env["SSH_CONNECTION"]) {
    ok = await copyNative(text, options);
    if (ok && pathChoice === "native" && !env["TMUX"]) {
      const result = { ok: true, path: pathChoice, details: "native clipboard utility", bytes: trimmed };
      await logClipboardResult(result, options.logPath);
      return result;
    }
  }

  const rawOsc52 = osc52Sequence(text);
  if (env["TMUX"]) {
    const loaded = await tmuxLoadBuffer(text, options);
    writeStdout(loaded ? tmuxPassthrough(rawOsc52) : rawOsc52);
    const result = {
      ok: loaded || ok,
      path: "tmux-buffer" as const,
      details: loaded
        ? "tmux load-buffer succeeded; wrote OSC 52 passthrough"
        : "tmux load-buffer failed; wrote raw OSC 52 fallback",
      bytes: trimmed,
    };
    await logClipboardResult(result, options.logPath);
    return result;
  }

  writeStdout(rawOsc52);
  details = ok
    ? "native clipboard utility succeeded; wrote OSC 52 fallback too"
    : "wrote OSC 52 fallback";
  const result = { ok: true, path: pathChoice, details, bytes: trimmed };
  await logClipboardResult(result, options.logPath);
  return result;
}
