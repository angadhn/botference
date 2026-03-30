import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeLayoutBudget,
  computeViewportSlice,
  truncateTitle,
  preRenderLines,
  shouldAutoScroll,
  cursorToLineCol,
  lineColToCursor,
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
      borderColor={focused ? "blue" : "gray"}
      overflow="hidden"
      height={height}
    >
      <Text bold color={focused ? "blueBright" : "gray"}>
        {displayTitle}
      </Text>
      {visibleLines.map((line) => (
        <Box key={line.key}>
          <Text bold color={dimmed ? "gray" : line.speakerColor}>
            {line.label}
          </Text>
          <Text color={dimmed ? "gray" : line.bodyColor}>{line.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

function ContextPercent({ pct }: {
  pct: number | null;
}) {
  if (pct == null) {
    return <Text>{"-- "}</Text>;
  }
  const label = `~${Math.round(pct)}%`;
  if (pct != null && pct >= 90) return <Text bold color="red">{label}</Text>;
  if (pct != null && pct >= 75) return <Text bold color="yellow">{label}</Text>;
  return <Text>{label}</Text>;
}

const MAX_VISIBLE_INPUT_LINES = 3;

function InputRenderer({
  text,
  cursor,
  ghostText,
  cursorColor,
}: {
  text: string;
  cursor: number;
  ghostText: string;
  cursorColor: string;
}) {
  // Split text into lines (multi-line support via Shift+Enter)
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  const cursorChar = (after[0] === "\n" ? " " : after[0]) ?? " ";
  const afterCursor = after.slice(1);

  // For multi-line: split around cursor and render each line
  const allLines = (before + cursorChar + afterCursor).split("\n");
  const beforeLines = before.split("\n");
  const cursorLine = beforeLines.length - 1;
  const cursorCol = beforeLines[cursorLine]!.length;

  // Scroll the visible window to keep the cursor line in view
  let startLine = 0;
  if (allLines.length > MAX_VISIBLE_INPUT_LINES) {
    // Center cursor in the visible window, clamped to bounds
    startLine = Math.min(
      Math.max(0, cursorLine - Math.floor(MAX_VISIBLE_INPUT_LINES / 2)),
      allLines.length - MAX_VISIBLE_INPUT_LINES,
    );
  }
  const endLine = startLine + Math.min(allLines.length, MAX_VISIBLE_INPUT_LINES);
  const visibleLines = allLines.slice(startLine, endLine);

  return (
    <Box flexDirection="column">
      {visibleLines.map((line, vi) => {
        const i = startLine + vi; // actual line index
        if (i === cursorLine) {
          // This line contains the cursor
          const pre = line.slice(0, cursorCol);
          const cur = line[cursorCol] ?? " ";
          const post = line.slice(cursorCol + 1);
          const isLastLine = i === allLines.length - 1;
          return (
            <Box key={i}>
              <Text>{pre}</Text>
              <Text inverse color={cursorColor}>{cur}</Text>
              <Text>{post}</Text>
              {isLastLine && ghostText ? <Text dimColor>{ghostText}</Text> : null}
            </Box>
          );
        }
        return (
          <Box key={i}>
            <Text>{line}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function StatusBar({ status }: { status: StatusData }) {
  return (
    <Box height={1} paddingX={1}>
      <Text dimColor>
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

  // Parent-owned layout budget — single source of truth for all dimensions
  const inputLineCount = inputText.split("\n").length;
  const { paneHeight, paneContentHeight, leftTextWidth, rightTextWidth } =
    computeLayoutBudget(rows, cols, inputLineCount);

  // ── Mouse scroll — dispatch to focused pane ──────────────
  useEffect(() => {
    return onMouseScroll((dir) => {
      const setter = focusedPane === "room" ? setRoomScroll : setCaucusScroll;
      setter((prev) => (dir === "up" ? prev + 1 : Math.max(0, prev - 1)));
    });
  }, [focusedPane]);

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
      const lines = pasted.split(/[\r\n]+/).filter(Boolean);

      let insertion = "";
      const newAttachments = new Map(imageAttachments);

      for (const line of lines) {
        const trimmed = line.trim();
        if (
          (trimmed.startsWith("/") || trimmed.startsWith("~")) &&
          IMAGE_EXTS.test(trimmed)
        ) {
          const id = nextImageId.current++;
          newAttachments.set(id, trimmed);
          insertion += `[image ${id}]`;
        } else {
          insertion += trimmed;
        }
      }

      if (insertion) {
        setInputText((prev) => prev.slice(0, cursor) + insertion + prev.slice(cursor));
        setCursor((c) => c + insertion.length);
        setImageAttachments(newAttachments);
        setDesiredCol(null);
      }
    });
  }, [cursor, imageAttachments]);

  // Track last-seen entry count per pane (updates when scroll returns to bottom)
  useEffect(() => {
    if (roomScroll === 0) setLastSeenRoomCount(roomEntries.length);
  }, [roomScroll, roomEntries.length]);

  useEffect(() => {
    if (caucusScroll === 0) setLastSeenCaucusCount(caucusEntries.length);
  }, [caucusScroll, caucusEntries.length]);

  const roomHasNew = roomScroll > 0 && roomEntries.length > lastSeenRoomCount;
  const caucusHasNew = caucusScroll > 0 && caucusEntries.length > lastSeenCaucusCount;

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
      const { line, col } = cursorToLineCol(inputText, cursor);
      if (line > 0) {
        const targetCol = desiredCol ?? col;
        setCursor(lineColToCursor(inputText, line - 1, targetCol));
        if (desiredCol === null) setDesiredCol(col);
      }
      return;
    }

    // Down arrow — move cursor to next line in multi-line input
    if (key.downArrow && !key.meta) {
      const { line, col } = cursorToLineCol(inputText, cursor);
      const lineCount = inputText.split("\n").length;
      if (line < lineCount - 1) {
        const targetCol = desiredCol ?? col;
        setCursor(lineColToCursor(inputText, line + 1, targetCol));
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

  const cursorColor = ready ? "green" : "yellow";

  // ── Render ─────────────────────────────────────────────

  return (
    <Box flexDirection="column" height={rows}>
      {/* Panes */}
      <Box flexDirection="row" flexGrow={1}>
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
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={ready ? "green" : "yellow"}
        paddingX={1}
      >
        <Text dimColor>{inputLabel}</Text>
        <InputRenderer
          text={inputText}
          cursor={cursor}
          ghostText={ghostText}
          cursorColor={cursorColor}
        />
        <Text dimColor>{hint || " "}</Text>
      </Box>

      {/* Status bar */}
      <StatusBar status={status} />
    </Box>
  );
}
