import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import stringWidth from "string-width";
import {
  computeLayoutBudget,
  computeViewportSlice,
  truncateTitle,
  preRenderLines,
  shouldAutoScroll,
  cursorToWrappedLineCol,
  wrappedLineColToCursor,
  wrapInputLines,
} from "./layout.js";
import { onMouseScroll, onPaste, onShiftEnter } from "./index.js";

// ── Types ──────────────────────────────────────────────────

interface Entry {
  speaker: string;
  text: string;
}

interface StatusData {
  mode: string;
  lead: string;
  route: string;
  claude_pct: number | null;
  codex_pct: number | null;
  claude_tokens: number | null;
  claude_window: number | null;
  codex_tokens: number | null;
  codex_window: number | null;
  observe: boolean;
}

interface BridgeArgs {
  anthropicModel: string;
  openaiModel: string;
  systemPromptFile: string;
  taskFile: string;
  debugPanes: boolean;
  claudeEffort: string;
}

// ── Constants ──────────────────────────────────────────────

const COMPLETIONS = [
  "/caucus ",
  "/lead @claude",
  "/lead @codex",
  "/draft",
  "/finalize",
  "/status",
  "/help",
  "/quit",
  "/exit",
  "@claude ",
  "@codex ",
  "@all ",
];

const THEME = {
  chrome: "gray",
  chromeMuted: "gray",
  accent: "cyan",
  accentBright: "cyanBright",
  warning: "yellow",
  danger: "red",
  text: "white",
  textMuted: "grayBright",
  statusMuted: "gray",
  ready: "green",
};

const BUSY_FRAMES = [".", "..", "..."];

type BusyTarget = "claude" | "codex" | "all" | "system" | null;
type BusySegment = { text: string; color: string; bold?: boolean };

function resolveBusyTarget(input: string, currentRoute: string, mode: string): BusyTarget {
  const trimmed = input.trim();
  if (mode === "caucus") return "all";
  if (trimmed.startsWith("@claude")) return "claude";
  if (trimmed.startsWith("@codex")) return "codex";
  if (trimmed.startsWith("@all")) return "all";
  if (trimmed.startsWith("/")) return "system";
  if (currentRoute === "@claude") return "claude";
  if (currentRoute === "@codex") return "codex";
  return "all";
}

function busyLabel(target: BusyTarget, mode: string): string {
  if (mode === "caucus") return "Claude and Codex are caucusing";
  switch (target) {
    case "claude":
      return "Claude is thinking";
    case "codex":
      return "Codex is thinking";
    case "all":
      return "Claude and Codex are thinking";
    case "system":
      return "Botference is working";
    default:
      return "Working";
  }
}

function buildBusySegments(text: string, frameIndex: number): BusySegment[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [{ text: "", color: THEME.statusMuted }];

  const pulseWidth = Math.max(3, Math.floor(chars.length / 7));
  const cycle = chars.length + pulseWidth;
  const highlightStart = frameIndex % cycle - pulseWidth;

  return chars.map((char, index) => {
    const distance = Math.abs(index - highlightStart);
    if (distance === 0) {
      return { text: char, color: "white", bold: true };
    }
    if (distance <= 1) {
      return { text: char, color: THEME.textMuted };
    }
    return { text: char, color: THEME.statusMuted };
  });
}

// ── Sub-components ─────────────────────────────────────────

function Pane({
  title,
  entries,
  focused,
  height,
  contentHeight,
  textWidth,
  scrollOffset,
  hasNewMessages,
}: {
  title: string;
  entries: Entry[];
  focused: boolean;
  height: number;
  contentHeight: number;
  textWidth: number;
  scrollOffset: number;
  hasNewMessages: boolean;
}) {
  // Pre-render entries to flat visual lines
  const flatLines = useMemo(
    () => preRenderLines(entries, textWidth),
    [entries, textWidth],
  );

  // Viewport slicing — bottom-anchored (0 = bottom, scroll up = older)
  const { startIdx, endIdx, clampedScroll } = computeViewportSlice(
    flatLines.length,
    contentHeight,
    scrollOffset,
  );
  const visibleLines = flatLines.slice(startIdx, endIdx);

  const badge = hasNewMessages ? " ↓ new" : undefined;
  const displayTitle = truncateTitle(title, clampedScroll, textWidth, badge);
  const dimmed = !focused;

  return (
    <Box
      flexGrow={1}
      flexShrink={1}
      flexBasis="50%"
      flexDirection="column"
      borderStyle={focused ? "bold" : "single"}
      borderColor={focused ? THEME.accent : THEME.chrome}
      overflow="hidden"
      height={height}
      paddingX={1}
    >
      <Text bold color={focused ? THEME.accentBright : THEME.textMuted}>
        {displayTitle}
      </Text>
      {visibleLines.map((line) => (
        <Box key={line.key} width="100%">
          <Text
            bold
            color={dimmed ? THEME.textMuted : line.speakerColor}
            wrap="truncate-end"
          >
            {line.label}
          </Text>
          <Box
            flexGrow={1}
            backgroundColor={dimmed ? undefined : (line.bodyBackgroundColor ?? line.gutterBackgroundColor)}
          >
            {line.gutter ? (
              <Text
                color={dimmed ? THEME.chromeMuted : (line.gutterColor ?? THEME.textMuted)}
                backgroundColor={dimmed ? undefined : (line.gutterBackgroundColor ?? line.bodyBackgroundColor)}
                wrap="truncate-end"
              >
                {line.gutter}
              </Text>
            ) : null}
            <Text
              bold={line.bodyBold && !dimmed}
              color={dimmed ? THEME.chromeMuted : line.bodyColor}
              backgroundColor={dimmed ? undefined : line.bodyBackgroundColor}
              wrap="truncate-end"
            >
              {line.segments
                ? line.segments.map((segment, index) => (
                  <Text
                    key={`${line.key}-${index}`}
                    color={dimmed ? THEME.chromeMuted : (segment.color ?? line.bodyColor)}
                    backgroundColor={dimmed ? undefined : (segment.backgroundColor ?? line.bodyBackgroundColor)}
                    bold={!dimmed && segment.bold}
                  >
                    {segment.text}
                  </Text>
                ))
                : line.text}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function ContextPercent({ pct }: {
  pct: number | null;
}) {
  if (pct == null) {
    return <Text color={THEME.textMuted}>{"-- "}</Text>;
  }
  const label = `~${Math.round(pct)}%`;
  if (pct != null && pct >= 90) return <Text bold color={THEME.danger}>{label}</Text>;
  if (pct != null && pct >= 75) return <Text bold color={THEME.warning}>{label}</Text>;
  return <Text color={THEME.text}>{label}</Text>;
}

const MIN_VISIBLE_INPUT_LINES = 1;

function InputRenderer({
  text,
  cursor,
  ghostText,
  cursorColor,
  textWidth,
  maxVisibleLines,
  showTrailingCursorLine,
}: {
  text: string;
  cursor: number;
  ghostText: string;
  cursorColor: string;
  textWidth: number;
  maxVisibleLines: number;
  showTrailingCursorLine: boolean;
}) {
  const wrappedLines = wrapInputLines(text, Math.max(1, textWidth));
  const displayLines = showTrailingCursorLine
    ? [...wrappedLines, { text: "", start: text.length, end: text.length }]
    : wrappedLines;
  const { line: baseCursorLine } = cursorToWrappedLineCol(
    text,
    cursor,
    Math.max(1, textWidth),
  );
  const cursorLine =
    showTrailingCursorLine && cursor === text.length
      ? displayLines.length - 1
      : baseCursorLine;

  // Scroll the visible window to keep the cursor line in view
  let startLine = 0;
  if (displayLines.length > maxVisibleLines) {
    // Center cursor in the visible window, clamped to bounds
    startLine = Math.min(
      Math.max(0, cursorLine - Math.floor(maxVisibleLines / 2)),
      displayLines.length - maxVisibleLines,
    );
  }
  const endLine = startLine + Math.min(displayLines.length, maxVisibleLines);
  const visibleLines = displayLines.slice(startLine, endLine);

  return (
    <Box flexDirection="column" width="100%">
      {visibleLines.map((line, vi) => {
        const i = startLine + vi; // actual line index
        if (i === cursorLine) {
          // This line contains the cursor
          const localCursor = Math.max(0, Math.min(cursor - line.start, line.text.length));
          const pre = line.text.slice(0, localCursor);
          const charUnderCursor = line.text.slice(localCursor, localCursor + 1);
          const cur = charUnderCursor || " ";
          const post = line.text.slice(localCursor + (charUnderCursor ? 1 : 0));
          const isLastLine = i === displayLines.length - 1;
          return (
            <Box key={i} width="100%">
              <Text color={THEME.text} wrap="truncate-end">
                {pre}
                <Text inverse color={cursorColor}>{cur}</Text>
                {post}
                {isLastLine && cursor === text.length && ghostText
                  ? <Text color={THEME.textMuted}>{ghostText}</Text>
                  : null}
              </Text>
            </Box>
          );
        }
        return (
          <Box key={i} width="100%">
            <Text color={THEME.text} wrap="truncate-end">
              {line.text.length > 0 ? line.text : " "}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function StatusBar({
  status,
}: {
  status: StatusData;
}) {
  return (
    <Box height={1} paddingX={1}>
      <Text color={THEME.textMuted}>
        {"Mode: "}{status.mode}{" | Lead: "}{status.lead}{" | Route: "}{status.route}{" | Claude: "}
        <ContextPercent pct={status.claude_pct} />
        {" | Codex: "}
        <ContextPercent pct={status.codex_pct} />
        {" | Observe: "}{status.observe ? "on" : "off"}
      </Text>
    </Box>
  );
}

// ── Main App ───────────────────────────────────────────────

export default function App({ bridgeArgs }: { bridgeArgs: BridgeArgs }) {
  const [roomEntries, setRoomEntries] = useState<Entry[]>([]);
  const [caucusEntries, setCaucusEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<StatusData>({
    mode: "public",
    lead: "auto",
    route: "@all",
    claude_pct: null,
    codex_pct: null,
    claude_tokens: null,
    claude_window: null,
    codex_tokens: null,
    codex_window: null,
    observe: true,
  });
  const [focusedPane, setFocusedPane] = useState<"room" | "caucus">("room");
  const [inputText, setInputText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [hint, setHint] = useState("");
  const [ready, setReady] = useState(false);
  const [busyTarget, setBusyTarget] = useState<BusyTarget>(null);
  const [busyFrameIndex, setBusyFrameIndex] = useState(0);
  const [roomScroll, setRoomScroll] = useState(0);
  const [caucusScroll, setCaucusScroll] = useState(0);
  const [lastSeenRoomCount, setLastSeenRoomCount] = useState(0);
  const [lastSeenCaucusCount, setLastSeenCaucusCount] = useState(0);

  const [desiredCol, setDesiredCol] = useState<number | null>(null);
  const [imageAttachments, setImageAttachments] = useState<Map<number, string>>(new Map());
  const nextImageId = useRef(1);
  const cursorRef = useRef(0);
  cursorRef.current = cursor; // keep ref in sync for use in stdin filter callbacks

  const bridgeRef = useRef<ChildProcess | null>(null);
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;
  const inputTextWidth = Math.max(8, cols - 4);
  const wrappedInputLines = useMemo(
    () => wrapInputLines(inputText, inputTextWidth),
    [inputText, inputTextWidth],
  );
  const showTrailingCursorLine = useMemo(() => {
    const lastLine = wrappedInputLines[wrappedInputLines.length - 1];
    return (
      cursor === inputText.length &&
      !!lastLine &&
      stringWidth(lastLine.text) >= inputTextWidth
    );
  }, [cursor, inputText.length, inputTextWidth, wrappedInputLines]);
  const maxVisibleInputLines = Math.max(
    MIN_VISIBLE_INPUT_LINES,
    Math.min(12, Math.floor(rows * 0.35)),
  );
  const visibleInputLines = Math.max(
    MIN_VISIBLE_INPUT_LINES,
    Math.min(
      wrappedInputLines.length + (showTrailingCursorLine ? 1 : 0),
      maxVisibleInputLines,
    ),
  );

  // Parent-owned layout budget — single source of truth for all dimensions
  const { paneHeight, paneContentHeight, leftTextWidth, rightTextWidth } =
    computeLayoutBudget(rows, cols, visibleInputLines);
  const roomFlatLineCount = useMemo(
    () => preRenderLines(roomEntries, leftTextWidth).length,
    [roomEntries, leftTextWidth],
  );
  const caucusFlatLineCount = useMemo(
    () => preRenderLines(caucusEntries, rightTextWidth).length,
    [caucusEntries, rightTextWidth],
  );
  const roomMaxScroll = Math.max(0, roomFlatLineCount - paneContentHeight);
  const caucusMaxScroll = Math.max(0, caucusFlatLineCount - paneContentHeight);

  // ── Mouse scroll — dispatch to focused pane ──────────────
  useEffect(() => {
    return onMouseScroll((dir) => {
      if (focusedPane === "room") {
        setRoomScroll((prev) => (
          dir === "up"
            ? Math.min(roomMaxScroll, prev + 1)
            : Math.max(0, prev - 1)
        ));
      } else {
        setCaucusScroll((prev) => (
          dir === "up"
            ? Math.min(caucusMaxScroll, prev + 1)
            : Math.max(0, prev - 1)
        ));
      }
    });
  }, [focusedPane, roomMaxScroll, caucusMaxScroll]);

  useEffect(() => {
    setRoomScroll((prev) => Math.min(prev, roomMaxScroll));
  }, [roomMaxScroll]);

  useEffect(() => {
    setCaucusScroll((prev) => Math.min(prev, caucusMaxScroll));
  }, [caucusMaxScroll]);

  // ── Shift+Enter — insert newline (intercepted at stdin filter level) ──
  useEffect(() => {
    return onShiftEnter(() => {
      const c = cursorRef.current;
      setInputText((prev) => prev.slice(0, c) + "\n" + prev.slice(c));
      setCursor(c + 1);
      setDesiredCol(null);
    });
  }, []);

  // ── Paste handler — detect image file paths ──────────────
  useEffect(() => {
    return onPaste((pasted) => {
      const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;
      const parts = pasted.split(/(\r\n|\r|\n)/);
      const insertAt = cursorRef.current;
      let insertion = "";
      const newAttachments = new Map(imageAttachments);

      for (const part of parts) {
        if (part === "\r\n" || part === "\r" || part === "\n") {
          insertion += "\n";
          continue;
        }

        const trimmed = part.trim();
        if (
          trimmed &&
          (trimmed.startsWith("/") || trimmed.startsWith("~")) &&
          IMAGE_EXTS.test(trimmed)
        ) {
          const id = nextImageId.current++;
          newAttachments.set(id, trimmed);
          insertion += `[image ${id}]`;
        } else {
          insertion += part;
        }
      }

      if (insertion) {
        setInputText((prev) => prev.slice(0, insertAt) + insertion + prev.slice(insertAt));
        setCursor(insertAt + insertion.length);
        setImageAttachments(newAttachments);
        setDesiredCol(null);
      }
    });
  }, [imageAttachments]);

  // Track last-seen entry count per pane (updates when scroll returns to bottom)
  useEffect(() => {
    if (roomScroll === 0) setLastSeenRoomCount(roomEntries.length);
  }, [roomScroll, roomEntries.length]);

  useEffect(() => {
    if (caucusScroll === 0) setLastSeenCaucusCount(caucusEntries.length);
  }, [caucusScroll, caucusEntries.length]);

  const roomHasNew = roomScroll > 0 && roomEntries.length > lastSeenRoomCount;
  const caucusHasNew = caucusScroll > 0 && caucusEntries.length > lastSeenCaucusCount;
  const activeBusyLabel = busyLabel(busyTarget, status.mode);
  const activeBusyFrame = BUSY_FRAMES[busyFrameIndex] ?? BUSY_FRAMES[0]!;

  useEffect(() => {
    if (ready) {
      setBusyFrameIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setBusyFrameIndex((prev) => prev + 1);
    }, 90);
    return () => clearInterval(interval);
  }, [ready]);

  // ── Ghost text (autocomplete) ──────────────────────────

  const ghostText = React.useMemo(() => {
    if (!inputText) return "";
    const lower = inputText.toLowerCase();
    for (const cmd of COMPLETIONS) {
      if (cmd.toLowerCase().startsWith(lower) && cmd.toLowerCase() !== lower) {
        return cmd.slice(inputText.length);
      }
    }
    return "";
  }, [inputText]);

  // ── Bridge subprocess ──────────────────────────────────

  useEffect(() => {
    const botferenceHome = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const bridgePath = path.join(botferenceHome, "core", "botference_ink_bridge.py");

    const args = [
      bridgePath,
      "--anthropic-model", bridgeArgs.anthropicModel,
      "--openai-model", bridgeArgs.openaiModel,
      "--system-prompt-file", bridgeArgs.systemPromptFile,
      "--task-file", bridgeArgs.taskFile,
    ];
    if (bridgeArgs.debugPanes) args.push("--debug-panes");
    if (bridgeArgs.claudeEffort) args.push("--claude-effort", bridgeArgs.claudeEffort);

    const proc = spawn("python3", args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit CWD from parent (project root) so file writes target the right place.
      // PYTHONPATH handles imports — no need to force cwd to botferenceHome.
      env: { ...process.env, PYTHONPATH: path.join(botferenceHome, "core") },
    });
    bridgeRef.current = proc;

    // Capture stderr so bridge errors surface in the room pane
    const stderrRl = createInterface({ input: proc.stderr! });
    stderrRl.on("line", (line: string) => {
      setRoomEntries((prev) => [
        ...prev,
        { speaker: "system", text: `[bridge stderr] ${line}` },
      ]);
    });

    proc.on("error", (err) => {
      setRoomEntries((prev) => [
        ...prev,
        { speaker: "system", text: `Bridge spawn error: ${err.message}` },
      ]);
    });

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      switch (msg.type) {
        case "room":
          setRoomEntries((prev) => [
            ...prev,
            { speaker: msg.speaker as string, text: msg.text as string },
          ]);
          setRoomScroll((prev) => shouldAutoScroll(prev) ? 0 : prev);
          break;
        case "caucus":
          setCaucusEntries((prev) => [
            ...prev,
            { speaker: msg.speaker as string, text: msg.text as string },
          ]);
          setCaucusScroll((prev) => shouldAutoScroll(prev) ? 0 : prev);
          break;
        case "status":
          setStatus({
            mode: msg.mode as string,
            lead: msg.lead as string,
            route: msg.route as string,
            claude_pct: msg.claude_pct as number | null,
            codex_pct: msg.codex_pct as number | null,
            claude_tokens: (msg.claude_tokens as number) ?? null,
            claude_window: (msg.claude_window as number) ?? null,
            codex_tokens: (msg.codex_tokens as number) ?? null,
            codex_window: (msg.codex_window as number) ?? null,
            observe: msg.observe as boolean,
          });
          break;
        case "mode":
          setStatus((prev) => ({ ...prev, mode: msg.mode as string }));
          if (msg.mode === "caucus") {
            setFocusedPane("caucus");
          } else {
            setFocusedPane("room");
          }
          break;
        case "ready":
          setReady(true);
          setBusyTarget(null);
          break;
        case "exit":
          cleanup();
          break;
        case "error":
          setRoomEntries((prev) => [
            ...prev,
            { speaker: "system", text: `Bridge error: ${msg.message}` },
          ]);
          break;
      }
    });

    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        setRoomEntries((prev) => [
          ...prev,
          { speaker: "system", text: `Bridge exited with code ${code}. Press Ctrl+C to exit.` },
        ]);
      } else {
        cleanup();
      }
    });

    return () => {
      proc.kill();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cleanup = useCallback(() => {
    if (bridgeRef.current) {
      bridgeRef.current.kill();
      bridgeRef.current = null;
    }
    process.exit(0);
  }, []);

  // ── Submission logic ───────────────────────────────────

  const submit = useCallback(() => {
    const stripped = inputText.trim();
    if (!stripped) {
      setHint("Enter a message or command.");
      return;
    }
    if (focusedPane === "caucus" && !stripped.startsWith("/")) {
      setHint("Caucus focused \u2014 Shift-Tab to Council to send messages");
      return;
    }
    if (!ready) {
      setHint("Waiting for response...");
      return;
    }

    setReady(false);
    setBusyTarget(resolveBusyTarget(stripped, status.route, status.mode));
    setHint("");
    setInputText("");
    setCursor(0);
    setDesiredCol(null);

    const proc = bridgeRef.current;
    if (proc?.stdin?.writable) {
      const msg: Record<string, unknown> = { type: "input", text: stripped };
      if (imageAttachments.size > 0) {
        msg.attachments = Array.from(imageAttachments.entries()).map(([id, filePath]) => ({
          id,
          path: filePath,
          type: "image",
        }));
      }
      proc.stdin.write(JSON.stringify(msg) + "\n");
    }

    // Clear attachments after send
    setImageAttachments(new Map());
    nextImageId.current = 1;
  }, [inputText, focusedPane, ready, imageAttachments]);

  // ── Keyboard handling ──────────────────────────────────

  useInput((input, key) => {
    // Ctrl+C — exit
    if (input === "c" && key.ctrl) {
      cleanup();
      return;
    }

    // Tab / Shift+Tab — toggle pane focus
    if (key.tab) {
      setFocusedPane((prev) => (prev === "room" ? "caucus" : "room"));
      setHint(
        focusedPane === "room"
          ? "Caucus focused \u2014 Shift-Tab to Council to send messages"
          : "",
      );
      return;
    }

    // Alt/Option+Enter — insert newline (fallback for Shift+Enter)
    // Shift+Enter is handled at the stdin filter level (onShiftEnter)
    // because terminals send raw escape sequences that Ink can't parse.
    if (key.return && key.meta) {
      setInputText((prev) => prev.slice(0, cursor) + "\n" + prev.slice(cursor));
      setCursor((c) => c + 1);
      setDesiredCol(null);
      return;
    }

    // Enter — submit
    if (key.return) {
      submit();
      return;
    }

    // Escape — clear input
    if (key.escape) {
      setInputText("");
      setCursor(0);
      setHint("");
      setDesiredCol(null);
      return;
    }

    // Ctrl+U — delete to start of line
    if (input === "u" && key.ctrl && cursor > 0) {
      setInputText((prev) => prev.slice(cursor));
      setCursor(0);
      setDesiredCol(null);
      return;
    }

    // Ctrl+K — delete to end of line
    if (input === "k" && key.ctrl) {
      setInputText((prev) => prev.slice(0, cursor));
      setDesiredCol(null);
      return;
    }

    // Ctrl+A — move to start
    if (input === "a" && key.ctrl) {
      setCursor(0);
      setDesiredCol(null);
      return;
    }

    // Ctrl+E — move to end
    if (input === "e" && key.ctrl) {
      setCursor(inputText.length);
      setDesiredCol(null);
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInputText((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
        setCursor((c) => c - 1);
      }
      setDesiredCol(null);
      return;
    }

    // Cmd+Left / Option+Left — jump word/line backward
    if (key.leftArrow && (key.meta || key.ctrl)) {
      // Jump to previous word boundary
      let pos = cursor - 1;
      while (pos > 0 && inputText[pos - 1] === " ") pos--;
      while (pos > 0 && inputText[pos - 1] !== " ") pos--;
      setCursor(Math.max(0, pos));
      setDesiredCol(null);
      return;
    }

    // Cmd+Right / Option+Right — jump word/line forward
    if (key.rightArrow && (key.meta || key.ctrl)) {
      let pos = cursor;
      while (pos < inputText.length && inputText[pos] !== " ") pos++;
      while (pos < inputText.length && inputText[pos] === " ") pos++;
      setCursor(pos);
      setDesiredCol(null);
      return;
    }

    // Left arrow — move cursor by 1
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      setDesiredCol(null);
      return;
    }

    // Right arrow — move cursor by 1, or accept ghost text at end
    if (key.rightArrow) {
      if (cursor === inputText.length && ghostText) {
        setInputText((prev) => prev + ghostText);
        setCursor((c) => c + ghostText.length);
      } else {
        setCursor((c) => Math.min(inputText.length, c + 1));
      }
      setDesiredCol(null);
      return;
    }

    // Up arrow — move cursor to previous line in multi-line input
    if (key.upArrow && !key.meta) {
      const { line, col } = cursorToWrappedLineCol(inputText, cursor, inputTextWidth);
      if (line > 0) {
        const targetCol = desiredCol ?? col;
        setCursor(wrappedLineColToCursor(inputText, inputTextWidth, line - 1, targetCol));
        if (desiredCol === null) setDesiredCol(col);
      }
      return;
    }

    // Down arrow — move cursor to next line in multi-line input
    if (key.downArrow && !key.meta) {
      const { line, col } = cursorToWrappedLineCol(inputText, cursor, inputTextWidth);
      const lineCount = wrapInputLines(inputText, inputTextWidth).length;
      if (line < lineCount - 1) {
        const targetCol = desiredCol ?? col;
        setCursor(wrappedLineColToCursor(inputText, inputTextWidth, line + 1, targetCol));
        if (desiredCol === null) setDesiredCol(col);
      }
      return;
    }

    // PageUp / PageDown — page scroll (Ctrl+B up, Ctrl+F down)
    if (input === "b" && key.ctrl) {
      const pageSize = Math.max(1, paneContentHeight);
      if (focusedPane === "room") {
        setRoomScroll((prev) => prev + pageSize);
      } else {
        setCaucusScroll((prev) => prev + pageSize);
      }
      return;
    }
    if (input === "f" && key.ctrl) {
      const pageSize = Math.max(1, paneContentHeight);
      if (focusedPane === "room") {
        setRoomScroll((prev) => Math.max(0, prev - pageSize));
      } else {
        setCaucusScroll((prev) => Math.max(0, prev - pageSize));
      }
      return;
    }

    // Regular character input — insert at cursor position
    if (input && !key.ctrl && !key.meta) {
      setInputText((prev) => prev.slice(0, cursor) + input + prev.slice(cursor));
      setCursor((c) => c + input.length);
      setDesiredCol(null);
    }
  });

  // ── Input label ────────────────────────────────────────

  const inputLabel =
    focusedPane === "caucus"
      ? "Slash commands still work here:"
      : "You (@claude/@codex/@all, /help):";

  const cursorColor = ready ? THEME.ready : THEME.warning;
  const busyText = `${activeBusyLabel}${activeBusyFrame}`;
  const busySegments = buildBusySegments(busyText, busyFrameIndex);
  const inputStatusText = hint || (!ready ? busyText : " ");

  // ── Render ─────────────────────────────────────────────

  return (
    <Box flexDirection="column" height={rows}>
      {/* Panes */}
      <Box flexDirection="row" flexGrow={1} marginBottom={1}>
        <Pane
          title="COUNCIL"
          entries={roomEntries}
          focused={focusedPane === "room"}
          height={paneHeight}
          contentHeight={paneContentHeight}
          textWidth={leftTextWidth}
          scrollOffset={roomScroll}
          hasNewMessages={roomHasNew}
        />
        <Pane
          title="CAUCUS"
          entries={caucusEntries}
          focused={focusedPane === "caucus"}
          height={paneHeight}
          contentHeight={paneContentHeight}
          textWidth={rightTextWidth}
          scrollOffset={caucusScroll}
          hasNewMessages={caucusHasNew}
        />
      </Box>

      {/* Input area */}
      <Box flexDirection="column" marginBottom={1} width="100%">
        <Text color={THEME.text}>{inputLabel}</Text>
        <Box
          flexDirection="column"
          paddingX={1}
          paddingTop={1}
          paddingY={0}
          backgroundColor="black"
          width="100%"
          overflow="hidden"
        >
          <InputRenderer
            text={inputText}
            cursor={cursor}
            ghostText={ghostText}
            cursorColor={cursorColor}
            textWidth={inputTextWidth}
            maxVisibleLines={visibleInputLines}
            showTrailingCursorLine={showTrailingCursorLine}
          />
          <Text color={hint ? THEME.textMuted : THEME.statusMuted}>
            {hint || ready
              ? inputStatusText
              : busySegments.map((segment, index) => (
                <Text key={`busy-${index}`} color={segment.color} bold={segment.bold}>
                  {segment.text}
                </Text>
              ))}
          </Text>
        </Box>
      </Box>

      {/* Status bar */}
      <StatusBar status={status} />
    </Box>
  );
}
