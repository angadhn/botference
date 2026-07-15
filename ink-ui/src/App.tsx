import React, { useState, useEffect, useRef, useCallback, useMemo, useDeferredValue } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import stringWidth from "string-width";
import {
  clampScrollOffset,
  computeLayoutBudget,
  computeSmoothScrollNext,
  computeViewportSlice,
  computeWheelScrollDelta,
  initWheelAccel,
  truncateTitle,
  preRenderLines,
  shouldAutoScroll,
  cursorToWrappedLineCol,
  wrappedLineColToCursor,
  wrapInputLines,
  type FlatLine,
  type RenderBlock,
} from "./layout.js";
import {
  onMouseEvent,
  onMouseScroll,
  onPaste,
  onShiftEnter,
  setMouseTrackingEnabled,
  type MouseEventInfo,
} from "./index.js";
import { copyToClipboard } from "./v2/clipboard.js";
import { sendDesktopNotification } from "./v2/notify.js";
import { saveClipboardImage, tokenizePaste } from "./v2/attachments.js";
import { flightRecorder, recordCrashEvidence } from "./index.js";
import {
  buildToolStackText,
  capDisplayEntries,
  createStreamSegmentState,
  isFinalEntryForSegmentedStream,
  stripFooterFromStreamEntries,
  nextPacedChunkEnd,
  replaceOrInsertStreamEntryBefore,
  replaceOrAppendStreamEntry,
  shouldAppendImmediately,
  textSegmentStreamId,
  toolEventId,
  toolPreviewLine,
  toolSegmentStreamId,
  type StreamSegmentState,
  PACED_MESSAGE_INTERVAL_MS,
} from "./v2/messages.js";
import {
  applySelectionHighlight,
  hitTestPane,
  selectedTextFromLines,
  type PaneHit,
  type PaneName,
  type PaneSelection,
} from "./v2/selection.js";
import {
  createV2Activity,
  formatV2ActivityText,
  startV2ActivityFromInput,
  updateV2ActivityForStream,
  v2ActivityGlyph,
  type V2Activity,
} from "./v2/activity.js";

// ── Types ──────────────────────────────────────────────────

interface Entry {
  speaker: string;
  text: string;
  blocks?: RenderBlock[];
  streamId?: string;
  streaming?: boolean;
  restored?: boolean;
}

interface StatusData {
  mode: string;
  lead: string;
  route: string;
  project: string;
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
  openaiEffort: string;
  systemPromptFile: string;
  taskFile: string;
  debugPanes: boolean;
  claudeEffort: string;
  claudeTransport: string;
}

interface PendingPermission {
  request_id: string;
  model: string;
  path: string;
  reason: string;
}

type StateUpdate<T> = T | ((prev: T) => T);

// Project panel data shapes + row builder live in projects.ts so they can be
// exercised by node:test without spinning up React.
import {
  buildProjectRows,
  clampSelectableRow,
  nextSelectableRow,
  projectRowCommand,
  type ProjectPanelProjectData,
  type ProjectPanelStateData,
  type ProjectRow,
} from "./projects.js";

// ── Constants ──────────────────────────────────────────────

// Autosuggest completions are sourced from the Python bridge at startup
// (type: "slash_commands") so they stay in sync with the canonical
// dispatcher in core/botference.py.

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

type BusyTarget = "claude" | "codex" | "all" | "system" | null;
type BusySegment = { text: string; color: string; bold?: boolean };

function resolveBusyTarget(input: string, currentRoute: string): BusyTarget {
  const trimmed = input.trim();
  if (trimmed.startsWith("@claude")) return "claude";
  if (trimmed.startsWith("@codex")) return "codex";
  if (trimmed.startsWith("@all")) return "all";
  if (trimmed.startsWith("/")) return "system";
  if (currentRoute === "@claude") return "claude";
  if (currentRoute === "@codex") return "codex";
  return "all";
}

function v2ActivityFromBusyTarget(target: BusyTarget): V2Activity {
  switch (target) {
    case "claude":
      return createV2Activity("claude", "claude");
    case "codex":
      return createV2Activity("codex", "codex");
    case "all":
      return createV2Activity("all", "all");
    case "system":
    case null:
      return createV2Activity("system", "system");
  }
}

function buildBusySegments(text: string, frameIndex: number): BusySegment[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [{ text: "", color: THEME.textMuted }];

  const cyclePadding = 10;
  const cycleLength = chars.length + cyclePadding * 2;
  const glimmerIndex = (frameIndex % cycleLength) - cyclePadding;

  return chars.map((char, index) => {
    const distance = Math.abs(index - glimmerIndex);
    if (distance === 0) {
      return { text: char, color: "white", bold: true };
    }
    if (distance <= 1) {
      return { text: char, color: "grayBright" };
    }
    if (distance <= 2) {
      return { text: char, color: THEME.textMuted };
    }
    return { text: char, color: THEME.textMuted };
  });
}

// ── Sub-components ─────────────────────────────────────────

function Pane({
  title,
  pane,
  flatLines,
  focused,
  height,
  contentHeight,
  textWidth,
  scrollOffset,
  hasNewMessages,
  selection,
}: {
  title: string;
  pane: PaneName;
  // Pre-rendered flat visual lines. Computed once by the parent (from the
  // deferred transcript) so the urgent render path never re-flattens the
  // whole transcript — Pane only slices the viewport out of it.
  flatLines: FlatLine[];
  focused: boolean;
  height: number;
  contentHeight: number;
  textWidth: number;
  scrollOffset: number;
  hasNewMessages: boolean;
  selection: PaneSelection | null;
}) {
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
      {visibleLines.map((line, visibleIndex) => {
        const lineIndex = startIdx + visibleIndex;
        const selectedSegments = applySelectionHighlight(line, selection, pane, lineIndex);
        return (
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
              {selectedSegments
                ? selectedSegments.map((segment, index) => (
                  <Text
                    key={`${line.key}-${index}`}
                    color={dimmed ? THEME.chromeMuted : (segment.color ?? line.bodyColor)}
                    backgroundColor={dimmed ? undefined : (segment.backgroundColor ?? line.bodyBackgroundColor)}
                    bold={!dimmed && segment.bold}
                    italic={!dimmed && segment.italic}
                    underline={!dimmed && segment.underline}
                    strikethrough={!dimmed && segment.strikethrough}
                  >
                    {segment.text}
                  </Text>
                ))
                : line.text}
            </Text>
          </Box>
        </Box>
        );
      })}
    </Box>
  );
}

function ProjectsPane({
  rows,
  focused,
  cursorIndex,
  height,
  textWidth,
  viewportHeight,
  filter = "",
}: {
  rows: ProjectRow[];
  focused: boolean;
  cursorIndex: number;
  height: number;
  textWidth: number;
  viewportHeight: number;
  filter?: string;
}) {
  // Keep the cursor in view by scrolling the row window when needed.
  const safeHeight = Math.max(1, viewportHeight);
  let startIdx = 0;
  if (rows.length > safeHeight) {
    startIdx = Math.min(
      Math.max(0, cursorIndex - Math.floor(safeHeight / 2)),
      rows.length - safeHeight,
    );
  }
  const visible = rows.slice(startIdx, startIdx + safeHeight);
  const dimmed = !focused;

  return (
    <Box
      flexDirection="column"
      borderStyle={focused ? "bold" : "single"}
      borderColor={focused ? THEME.accent : THEME.chrome}
      overflow="hidden"
      height={height}
      width={textWidth + 4}
      paddingX={1}
    >
      <Text bold color={focused ? THEME.accentBright : THEME.textMuted} wrap="truncate-end">
        {filter ? `PROJECTS ⌕ ${filter}` : "PROJECTS"}
      </Text>
      {filter && rows.length === 0 ? (
        <Text color={THEME.textMuted} wrap="truncate-end">
          {"  no matches (Esc clears)"}
        </Text>
      ) : null}
      {visible.map((row, vi) => {
        const idx = startIdx + vi;
        const isCursor = focused && idx === cursorIndex && row.selectable;
        if (row.kind === "inbox") {
          const marker = row.active ? "●" : " ";
          const color = dimmed
            ? THEME.textMuted
            : row.active ? THEME.accentBright : THEME.text;
          return (
            <Box key={`row-${idx}`} width="100%">
              <Text
                bold={row.active && !dimmed}
                color={color}
                backgroundColor={isCursor ? THEME.accent : undefined}
                wrap="truncate-end"
              >
                {`${marker} ${row.title}${row.meta ? " " + row.meta : ""}`}
              </Text>
            </Box>
          );
        }
        if (row.kind === "project") {
          const marker = row.active ? "●" : " ";
          const disclosure = row.active ? "▾" : "▸";
          const color = dimmed
            ? THEME.textMuted
            : row.active ? THEME.accentBright : THEME.text;
          const tail = row.meta ? ` · ${row.meta}` : "";
          return (
            <Box key={`row-${idx}`} width="100%">
              <Text
                bold={row.active && !dimmed}
                color={color}
                backgroundColor={isCursor ? THEME.accent : undefined}
                wrap="truncate-end"
              >
                {`${marker} ${disclosure} ${row.title}${tail}`}
              </Text>
            </Box>
          );
        }
        if (row.kind === "next") {
          return (
            <Box key={`row-${idx}`} width="100%">
              <Text color={THEME.textMuted} wrap="truncate-end">
                {`    ${row.title}`}
              </Text>
            </Box>
          );
        }
        if (row.kind === "session") {
          const sessionMarker = row.active ? "▸" : " ";
          const age = row.meta ? ` · ${row.meta}` : "";
          return (
            <Box key={`row-${idx}`} width="100%">
              <Text
                bold={row.active && !dimmed}
                color={dimmed ? THEME.textMuted : (row.active ? THEME.ready : THEME.text)}
                backgroundColor={isCursor ? THEME.accent : undefined}
                wrap="truncate-end"
              >
                {`  ${sessionMarker} ${row.title}`}
                <Text
                  bold={false}
                  color={dimmed ? THEME.textMuted : (row.active ? THEME.ready : THEME.statusMuted)}
                  backgroundColor={isCursor ? THEME.accent : undefined}
                >
                  {age}
                </Text>
              </Text>
            </Box>
          );
        }
        // empty
        return (
          <Box key={`row-${idx}`} width="100%">
            <Text color={THEME.textMuted} wrap="truncate-end">
              {`    ${row.title}`}
            </Text>
          </Box>
        );
      })}
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
        {"Project: "}{status.project}{" | Mode: "}{status.mode}{" | Lead: "}{status.lead}{" | Route: "}{status.route}{" | Claude: "}
        <ContextPercent pct={status.claude_pct} />
        {" | Codex: "}
        <ContextPercent pct={status.codex_pct} />
        {" | Observe: "}{status.observe ? "on" : "off"}
      </Text>
    </Box>
  );
}

function PermissionPrompt({
  request,
  choice,
}: {
  request: PendingPermission;
  choice: "allow" | "deny";
}) {
  const allowFocused = choice === "allow";
  const denyFocused = choice === "deny";

  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      <Text bold color={THEME.warning}>
        Protected write request
      </Text>
      <Text color={THEME.text} wrap="truncate-end">
        {request.model.charAt(0).toUpperCase() + request.model.slice(1)} wants to edit{" "}
        <Text bold>{request.path}</Text>
      </Text>
      <Text color={THEME.textMuted} wrap="truncate-end">
        {request.reason}
      </Text>
      <Box>
        <Text
          bold={allowFocused}
          color={allowFocused ? THEME.ready : THEME.textMuted}
        >
          {allowFocused ? "[ Allow once ]" : "  Allow once  "}
        </Text>
        <Text color={THEME.textMuted}>{"  "}</Text>
        <Text
          bold={denyFocused}
          color={denyFocused ? THEME.danger : THEME.textMuted}
        >
          {denyFocused ? "[ Deny ]" : "  Deny  "}
        </Text>
      </Box>
      <Text color={THEME.statusMuted} wrap="truncate-end">
        Enter confirms | Tab/Left/Right switches | Y allows | N/Esc denies
      </Text>
    </Box>
  );
}

function ChoicePrompt({
  prompt,
  options,
  index,
}: {
  prompt: string;
  options: string[];
  index: number;
}) {
  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      <Text bold color={THEME.accentBright}>
        {prompt}
      </Text>
      {options.map((option, i) => {
        const focused = i === index;
        return (
          <Text
            key={`choice-${i}`}
            bold={focused}
            color={focused ? THEME.ready : THEME.textMuted}
            wrap="truncate-end"
          >
            {focused ? `❯ ${option}` : `  ${option}`}
          </Text>
        );
      })}
      <Text color={THEME.statusMuted} wrap="truncate-end">
        Up/Down selects | Enter confirms | Esc dismisses
      </Text>
    </Box>
  );
}

// ── Main App ───────────────────────────────────────────────

export default function App({ bridgeArgs }: { bridgeArgs: BridgeArgs }) {
  const [roomEntries, setRoomEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<StatusData>({
    mode: "public",
    lead: "auto",
    route: "@all",
    project: "Inbox",
    claude_pct: null,
    codex_pct: null,
    claude_tokens: null,
    claude_window: null,
    codex_tokens: null,
    codex_window: null,
    observe: true,
  });
  const [focusedPane, setFocusedPane] = useState<"room" | "projects">("room");
  const [projectState, setProjectState] = useState<ProjectPanelStateData>({
    active_project_id: "",
    inbox_session_count: 0,
    projects: [],
  });
  const [projectsVisible, setProjectsVisible] = useState(true);
  const [projectCursor, setProjectCursor] = useState(0);
  const [projectFilter, setProjectFilter] = useState("");
  const [inputText, setInputTextState] = useState("");
  const [cursor, setCursorState] = useState(0);
  const [hint, setHint] = useState("");
  const [ready, setReady] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [busyTarget, setBusyTarget] = useState<BusyTarget>(null);
  const [busyFrameIndex, setBusyFrameIndex] = useState(0);
  const [v2Activity, setV2Activity] = useState<V2Activity | null>(null);
  const [mouseSelectionMode, setMouseSelectionMode] = useState(false);
  const [paneSelection, setPaneSelection] = useState<PaneSelection | null>(null);
  const [roomScroll, setRoomScroll] = useState(0);
  const [lastSeenRoomCount, setLastSeenRoomCount] = useState(0);

  const [desiredCol, setDesiredCol] = useState<number | null>(null);
  const [imageAttachments, setImageAttachmentsState] = useState<Map<number, string>>(new Map());
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [permissionChoice, setPermissionChoice] = useState<"allow" | "deny">("allow");
  const [pendingChoice, setPendingChoice] = useState<{ prompt: string; options: string[] } | null>(null);
  const [choiceIndex, setChoiceIndex] = useState(0);
  const [completionCtx, setCompletionCtx] = useState<{
    global: string[];
    scoped: Record<string, string[]>;
  }>({ global: [], scoped: {} });
  const nextImageId = useRef(1);
  const inputTextRef = useRef("");
  const cursorRef = useRef(0);
  const imageAttachmentsRef = useRef<Map<number, string>>(new Map());
  const setInputText = useCallback((update: StateUpdate<string>) => {
    const next = typeof update === "function"
      ? (update as (prev: string) => string)(inputTextRef.current)
      : update;
    inputTextRef.current = next;
    setInputTextState(next);
  }, []);
  const setCursor = useCallback((update: StateUpdate<number>) => {
    const next = typeof update === "function"
      ? (update as (prev: number) => number)(cursorRef.current)
      : update;
    cursorRef.current = Math.max(0, Math.min(next, inputTextRef.current.length));
    setCursorState(cursorRef.current);
  }, []);
  const setImageAttachments = useCallback((update: StateUpdate<Map<number, string>>) => {
    const next = typeof update === "function"
      ? (update as (prev: Map<number, string>) => Map<number, string>)(imageAttachmentsRef.current)
      : update;
    imageAttachmentsRef.current = next;
    setImageAttachmentsState(next);
  }, []);

  const wheelAccelRef = useRef(initWheelAccel());
  const roomScrollRef = useRef(0);
  const roomScrollTargetRef = useRef(0);
  const roomMaxScrollRef = useRef(0);
  const scrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pacedTimersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const toolStacksRef = useRef<Map<string, Map<string, string>>>(new Map());
  const streamSegmentsRef = useRef<Map<string, StreamSegmentState>>(new Map());
  const handledSegmentedStreamsRef = useRef<Set<string>>(new Set());
  const completedSegmentedStreamsRef = useRef<Set<string>>(new Set());

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
  const {
    paneHeight,
    paneContentHeight,
    councilTextWidth,
    projectsPaneWidth,
    projectsTextWidth,
  } = computeLayoutBudget(rows, cols, visibleInputLines, {
    projectsVisible,
  });
  // If the budget refused to draw the panel (e.g. terminal too narrow), treat
  // it as hidden for behavior purposes too — otherwise focus could get stuck
  // on an invisible pane.
  const projectsPaneRendered = projectsVisible && projectsPaneWidth > 0;
  const projectRows = useMemo(
    () => buildProjectRows(projectState, { filter: projectFilter }),
    [projectState, projectFilter],
  );

  // Snap the cursor to the active row on first load, then leave it alone so
  // selecting a session doesn't yank focus back to the project header. If the
  // cursor lands on a row that disappears (e.g. sessions collapse), clamp to
  // the nearest selectable row.
  const initialProjectSnapRef = useRef(false);
  useEffect(() => {
    if (projectRows.length === 0) return;
    setProjectCursor((prev) => {
      if (!initialProjectSnapRef.current) {
        initialProjectSnapRef.current = true;
        const activeIdx = projectRows.findIndex(
          (row) => row.selectable && (row as { active?: boolean }).active,
        );
        if (activeIdx >= 0) return activeIdx;
      }
      if (prev >= 0 && prev < projectRows.length && projectRows[prev]!.selectable) {
        return prev;
      }
      return clampSelectableRow(projectRows, prev);
    });
  }, [projectRows]);
  // Defer the transcript-derived flattening so keystrokes (urgent state) are not
  // blocked behind a full pane reflow while bots stream. The per-entry FlatLine
  // cache keeps the deferred recompute cheap; together they keep the input box
  // responsive even on long sessions.
  const deferredRoomEntries = useDeferredValue(roomEntries);
  const roomFlatLines = useMemo(
    () => preRenderLines(deferredRoomEntries, councilTextWidth),
    [deferredRoomEntries, councilTextWidth],
  );
  const roomFlatLineCount = roomFlatLines.length;
  const roomMaxScroll = Math.max(0, roomFlatLineCount - paneContentHeight);
  roomMaxScrollRef.current = roomMaxScroll;
  roomScrollRef.current = roomScroll;

  const startScrollDrain = useCallback(() => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setInterval(() => {
      const roomTarget = clampScrollOffset(roomScrollTargetRef.current, roomMaxScrollRef.current);
      roomScrollTargetRef.current = roomTarget;

      const nextRoomScroll = computeSmoothScrollNext(roomScrollRef.current, roomTarget);
      roomScrollRef.current = nextRoomScroll;
      setRoomScroll(nextRoomScroll);

      if (nextRoomScroll === roomTarget && scrollTimerRef.current) {
        clearInterval(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
    }, 16);
  }, []);

  const nextPacedEntryIdRef = useRef(1);

  const appendEntry = useCallback((entry: Entry) => {
    const setEntries = setRoomEntries;
    const setScroll = setRoomScroll;
    const scrollRef = roomScrollRef;

    if (entry.streamId) {
      for (const baseStreamId of completedSegmentedStreamsRef.current) {
        if (
          handledSegmentedStreamsRef.current.has(baseStreamId)
          && isFinalEntryForSegmentedStream(entry.streamId, baseStreamId)
        ) {
          return;
        }
      }
      setEntries((prev) => capDisplayEntries(replaceOrAppendStreamEntry(prev, entry)));
      setScroll((prev) => shouldAutoScroll(prev) ? 0 : prev);
      return;
    }

    if (shouldAppendImmediately(entry)) {
      setEntries((prev) => capDisplayEntries([...prev, entry]));
      setScroll((prev) => shouldAutoScroll(prev) ? 0 : prev);
      return;
    }

    const finalText = entry.text;
    const finalBlocks = entry.blocks;
    // The reveal ticks look the placeholder up by a synthetic stream id, not
    // by array index: the display log may be trimmed (or cleared) while the
    // reveal is in flight, and a stale index would then rewrite the wrong
    // entry. If the placeholder is gone, the reveal simply stops.
    const pacedStreamId = `paced:${nextPacedEntryIdRef.current}`;
    nextPacedEntryIdRef.current += 1;
    setEntries((prev) => capDisplayEntries([
      ...prev,
      { speaker: entry.speaker, text: "", streamId: pacedStreamId },
    ]));
    setScroll((prev) => shouldAutoScroll(prev) ? 0 : prev);

    let visibleEnd = 0;
    const interval = setInterval(() => {
      visibleEnd = nextPacedChunkEnd(finalText, visibleEnd);
      const done = visibleEnd >= finalText.length;

      setEntries((prev) => {
        const index = prev.findIndex((e) => e.streamId === pacedStreamId);
        if (index === -1) return prev;

        const next = [...prev];
        next[index] = {
          speaker: entry.speaker,
          text: finalText.slice(0, visibleEnd),
          blocks: done ? finalBlocks : undefined,
          streamId: pacedStreamId,
        };
        return next;
      });

      if (shouldAutoScroll(scrollRef.current)) {
        setScroll(0);
      }

      if (done) {
        clearInterval(interval);
        pacedTimersRef.current.delete(interval);
      }
    }, PACED_MESSAGE_INTERVAL_MS);
    pacedTimersRef.current.add(interval);
  }, []);

  // Bulk-append restored history in a single state update (one reflow), instead of
  // one setState + render per historical entry. With the per-entry FlatLine cache
  // this makes reload O(N) instead of the old O(N²) "stream slowly into view".
  const appendEntries = useCallback((entries: Entry[]) => {
    if (entries.length === 0) return;
    setRoomEntries((prev) => capDisplayEntries([...prev, ...entries]));
    setRoomScroll((prev) => shouldAutoScroll(prev) ? 0 : prev);
  }, []);

  const updateStreamEntry = useCallback((
    streamId: string,
    speaker: string,
    update: (entry: Entry | undefined) => Entry | null,
    options: { beforeStreamId?: string } = {},
  ) => {
    const setEntries = setRoomEntries;
    const setScroll = setRoomScroll;
    const scrollRef = roomScrollRef;

    setEntries((prev) => {
      const index = prev.findIndex((entry) => entry.streamId === streamId);
      const updated = update(index === -1 ? undefined : prev[index]);
      if (!updated) {
        if (index === -1) return prev;
        return prev.filter((_, entryIndex) => entryIndex !== index);
      }
      if (index === -1) {
        if (options.beforeStreamId) {
          return capDisplayEntries(
            replaceOrInsertStreamEntryBefore(prev, updated, options.beforeStreamId),
          );
        }
        return capDisplayEntries([...prev, updated]);
      }
      const next = [...prev];
      next[index] = updated;
      return next;
    });
    if (shouldAutoScroll(scrollRef.current)) {
      setScroll(0);
    }
  }, []);

  // ── Mouse scroll — dispatch to focused pane ──────────────
  useEffect(() => {
    return onMouseScroll((wheelSteps) => {
      const delta = computeWheelScrollDelta(
        wheelAccelRef.current,
        wheelSteps,
        performance.now(),
      );
      roomScrollTargetRef.current = clampScrollOffset(
        roomScrollTargetRef.current + delta,
        roomMaxScroll,
      );
      startScrollDrain();
    });
  }, [roomMaxScroll, startScrollDrain]);

  const hitTestPaneForEvent = useCallback((event: MouseEventInfo): PaneHit | null => {
    return hitTestPane(event, {
      paneContentHeight,
      councilTextWidth,
      roomFlatLines,
      roomScrollOffset: roomScrollRef.current,
      projectsPaneWidth: projectsPaneRendered ? projectsPaneWidth : 0,
    });
  }, [
    councilTextWidth,
    paneContentHeight,
    roomFlatLines,
    projectsPaneRendered,
    projectsPaneWidth,
  ]);

  useEffect(() => {
    return onMouseEvent((event) => {
      const hit = hitTestPaneForEvent(event);
      if (event.kind === "press") {
        if (!hit) {
          setPaneSelection(null);
          return;
        }
        setFocusedPane(hit.pane);
        setPaneSelection({
          pane: hit.pane,
          anchorLine: hit.lineIndex,
          anchorCol: hit.col,
          focusLine: hit.lineIndex,
          focusCol: hit.col,
          dragging: true,
        });
        return;
      }

      if (event.kind === "drag") {
        if (!hit) return;
        setPaneSelection((prev) => {
          if (!prev || !prev.dragging || prev.pane !== hit.pane) return prev;
          return {
            ...prev,
            focusLine: hit.lineIndex,
            focusCol: hit.col,
          };
        });
        return;
      }

      if (event.kind === "release") {
        setPaneSelection((prev) => {
          if (!prev) return prev;
          const finalSelection = hit && hit.pane === prev.pane
            ? { ...prev, focusLine: hit.lineIndex, focusCol: hit.col, dragging: false }
            : { ...prev, dragging: false };
          void copyToClipboard(selectedTextFromLines(roomFlatLines, finalSelection));
          return finalSelection;
        });
      }
    });
  }, [hitTestPaneForEvent, roomFlatLines]);

  useEffect(() => {
    setMouseTrackingEnabled(!mouseSelectionMode);
    return () => setMouseTrackingEnabled(true);
  }, [mouseSelectionMode]);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearInterval(scrollTimerRef.current);
      for (const timer of pacedTimersRef.current) clearInterval(timer);
      pacedTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    setRoomScroll((prev) => clampScrollOffset(prev, roomMaxScroll));
    roomScrollTargetRef.current = clampScrollOffset(roomScrollTargetRef.current, roomMaxScroll);
  }, [roomMaxScroll]);

  useEffect(() => {
    if (!scrollTimerRef.current) roomScrollTargetRef.current = roomScroll;
  }, [roomScroll]);

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
  // Drag-drop and Finder Cmd+C deliver paths that may be backslash-escaped
  // (spaces in screenshot names), quoted, file:// URLs, or several on one
  // line. Only paths that actually exist become attachments; anything else
  // stays visible as text instead of turning into a dead "[image N]".
  useEffect(() => {
    return onPaste((pasted) => {
      const insertAt = cursorRef.current;
      let insertion = "";
      const newAttachments = new Map(imageAttachmentsRef.current);

      for (const token of tokenizePaste(pasted)) {
        if (token.type === "image") {
          const id = nextImageId.current++;
          newAttachments.set(id, token.value);
          insertion += `[image ${id}]`;
        } else {
          insertion += token.value;
        }
      }

      if (insertion) {
        setInputText((prev) => prev.slice(0, insertAt) + insertion + prev.slice(insertAt));
        setCursor(insertAt + insertion.length);
        setImageAttachments(newAttachments);
        setDesiredCol(null);
      }
    });
  }, [setCursor, setImageAttachments, setInputText]);

  // Track last-seen entry count per pane (updates when scroll returns to bottom)
  useEffect(() => {
    if (roomScroll === 0) setLastSeenRoomCount(roomEntries.length);
  }, [roomScroll, roomEntries.length]);

  const roomHasNew = roomScroll > 0 && roomEntries.length > lastSeenRoomCount;
  useEffect(() => {
    if (ready) {
      setBusyFrameIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setBusyFrameIndex((prev) => prev + 1);
    }, 70);
    return () => clearInterval(interval);
  }, [ready]);

  // ── Ghost text (autocomplete) ──────────────────────────

  const normPunct = (s: string) => s.replace(/[-.]/g, "");
  const ghostText = React.useMemo(() => {
    if (!inputText) return "";
    const lower = inputText.toLowerCase();
    // Scoped match: "/model @claude opus" -> claude-opus-4-8. Fires even when
    // only the prefix is typed (shows first option) and normalizes punctuation
    // so "5-4", "5.4", "47", "opus-4" all substring-match.
    for (const [prefix, options] of Object.entries(completionCtx.scoped)) {
      const lowerPrefix = prefix.toLowerCase();
      let suffix: string | null = null;
      if (lower.startsWith(lowerPrefix)) {
        suffix = inputText.slice(prefix.length).toLowerCase();
      } else if (lower === lowerPrefix.trimEnd()) {
        suffix = "";
      }
      if (suffix === null) continue;
      const nsuffix = normPunct(suffix);
      for (const opt of options) {
        if (normPunct(opt.toLowerCase()).includes(nsuffix) && opt.toLowerCase() !== suffix) {
          return (prefix + opt).slice(inputText.length);
        }
      }
      return "";
    }
    // Global (prefix) match
    for (const cmd of completionCtx.global) {
      if (cmd.toLowerCase().startsWith(lower) && cmd.toLowerCase() !== lower) {
        return cmd.slice(inputText.length);
      }
    }
    return "";
  }, [inputText, completionCtx]);

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
    if (bridgeArgs.openaiEffort) args.push("--openai-effort", bridgeArgs.openaiEffort);
    if (bridgeArgs.claudeTransport) args.push("--claude-transport", bridgeArgs.claudeTransport);

    const bridgePython = process.env.BOTFERENCE_PYTHON_BIN || "python3";
    const proc = spawn(bridgePython, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit CWD from parent (project root) so file writes target the right place.
      // PYTHONPATH handles imports — no need to force cwd to botferenceHome.
      env: { ...process.env, PYTHONPATH: path.join(botferenceHome, "core") },
    });
    bridgeRef.current = proc;

    // Capture stderr so bridge errors surface in the room pane. Capped like
    // every other append — a crash-looping bridge can spew stderr forever.
    const stderrRl = createInterface({ input: proc.stderr! });
    stderrRl.on("line", (line: string) => {
      setRoomEntries((prev) => capDisplayEntries([
        ...prev,
        { speaker: "system", text: `[bridge stderr] ${line}` },
      ]));
    });

    proc.on("error", (err) => {
      setRoomEntries((prev) => [
        ...prev,
        { speaker: "system", text: `Bridge spawn error: ${err.message}` },
      ]);
    });

    const asString = (value: unknown, fallback = ""): string =>
      typeof value === "string" ? value : fallback;

    const handleBridgeEvent = (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "room":
          appendEntry({
            speaker: asString(msg.speaker, "system"),
            text: asString(msg.text),
            blocks: Array.isArray(msg.blocks) ? msg.blocks as RenderBlock[] : undefined,
            streamId: typeof msg.stream_id === "string" ? msg.stream_id : undefined,
            restored: msg.restored === true,
          });
          break;
        case "restore": {
          const rawEntries = Array.isArray(msg.entries) ? msg.entries : [];
          const restored: Entry[] = rawEntries
            .filter((e: unknown): e is Record<string, unknown> => (
              typeof e === "object" && e !== null
            ))
            .map((e: Record<string, unknown>) => ({
              speaker: asString(e.speaker, "system"),
              text: asString(e.text),
              blocks: Array.isArray(e.blocks) ? e.blocks as RenderBlock[] : undefined,
              restored: true,
            }));
          appendEntries(restored);
          break;
        }
        case "stream": {
          const streamId = typeof msg.stream_id === "string" ? msg.stream_id : "";
          const speaker = typeof msg.model === "string" ? msg.model : "system";
          if (!streamId) break;
          setV2Activity((prev) => updateV2ActivityForStream(prev, msg));

          if (msg.kind === "start") {
            streamSegmentsRef.current.set(streamId, createStreamSegmentState());
            completedSegmentedStreamsRef.current.delete(streamId);
            handledSegmentedStreamsRef.current.delete(streamId);
            break;
          }

          if (msg.kind === "text_delta") {
            const delta = typeof msg.text === "string" ? msg.text : "";
            if (!delta) break;
            const segmentState = streamSegmentsRef.current.get(streamId) ?? createStreamSegmentState();
            streamSegmentsRef.current.set(streamId, segmentState);
            const textStreamId = textSegmentStreamId(streamId, segmentState);
            handledSegmentedStreamsRef.current.add(streamId);
            updateStreamEntry(textStreamId, speaker, (entry) => ({
              speaker,
              text: `${entry?.text ?? ""}${delta}`,
              streamId: textStreamId,
              streaming: true,
            }));
            break;
          }

          if (msg.kind === "tool_start" || msg.kind === "tool_done") {
            const segmentState = streamSegmentsRef.current.get(streamId) ?? createStreamSegmentState();
            streamSegmentsRef.current.set(streamId, segmentState);
            const toolId = toolEventId(msg);
            const toolStackStreamId = toolSegmentStreamId(
              streamId,
              segmentState,
              toolId,
              msg.kind === "tool_start",
            );
            const stack = toolStacksRef.current.get(toolStackStreamId) ?? new Map<string, string>();
            stack.set(toolId, toolPreviewLine(msg));
            toolStacksRef.current.set(toolStackStreamId, stack);
            handledSegmentedStreamsRef.current.add(streamId);
            updateStreamEntry(toolStackStreamId, speaker, () => ({
              speaker,
              text: buildToolStackText(Array.from(stack.values())),
              streamId: toolStackStreamId,
              streaming: msg.kind === "tool_start",
            }));
            break;
          }

          if (msg.kind === "done") {
            completedSegmentedStreamsRef.current.add(streamId);
            // The streamed text stays in the pane (the controller's stripped
            // final entry is dropped for segmented streams), so remove any
            // trailing routing footer from the last text segment here.
            setRoomEntries((prev) => stripFooterFromStreamEntries(prev, streamId));
          }
          break;
        }
        case "clear_panes":
          setRoomEntries([]);
          setRoomScroll(0);
          streamSegmentsRef.current.clear();
          toolStacksRef.current.clear();
          handledSegmentedStreamsRef.current.clear();
          completedSegmentedStreamsRef.current.clear();
          break;
        case "projects": {
          const projectsArr = Array.isArray(msg.projects)
            ? (msg.projects as ProjectPanelProjectData[])
            : [];
          setProjectState({
            active_project_id: typeof msg.active_project_id === "string"
              ? msg.active_project_id
              : "",
            inbox_session_count: typeof msg.inbox_session_count === "number"
              ? msg.inbox_session_count
              : 0,
            projects: projectsArr,
          });
          break;
        }
        case "status":
          setStatus({
            mode: msg.mode as string,
            lead: msg.lead as string,
            route: msg.route as string,
            project: typeof msg.project === "string" && msg.project ? msg.project : "Inbox",
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
          setFocusedPane("room");
          break;
        case "ready":
          setReady(true);
          setQueuedCount(0);
          setHint("");
          setBusyTarget(null);
          setV2Activity(null);
          break;
        case "queue": {
          const pending = typeof msg.pending === "number" ? msg.pending : 0;
          setQueuedCount(pending);
          if (pending > 0) {
            setHint(`${pending} queued message${pending === 1 ? "" : "s"}.`);
          }
          break;
        }
        case "completion_context":
          setCompletionCtx({
            global: (msg.global as string[]) ?? [],
            scoped: (msg.scoped as Record<string, string[]>) ?? {},
          });
          break;
        case "permission_request":
          setPendingPermission({
            request_id: msg.request_id as string,
            model: msg.model as string,
            path: msg.path as string,
            reason: msg.reason as string,
          });
          setPermissionChoice("allow");
          setHint("Approve or deny the protected write.");
          break;
        case "permission_cleared":
          setPendingPermission(null);
          setHint("");
          break;
        case "choice_request":
          setPendingChoice({
            prompt: typeof msg.prompt === "string" ? msg.prompt : "",
            options: Array.isArray(msg.options)
              ? (msg.options as unknown[]).map(String)
              : [],
          });
          setChoiceIndex(0);
          break;
        case "choice_cleared":
          setPendingChoice(null);
          break;
        case "notify":
          sendDesktopNotification(
            typeof msg.title === "string" ? msg.title : "botference",
            typeof msg.body === "string" ? msg.body : "",
          );
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
    };

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line: string) => {
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        msg = parsed as Record<string, unknown>;
      } catch {
        return;
      }

      // One malformed event must never throw out of readline's callback —
      // that would be an uncaught exception and kill the entire UI process.
      try {
        flightRecorder.note(`bridge:${String((msg as { type?: unknown }).type ?? "?")}`);
        handleBridgeEvent(msg);
      } catch {
        // Drop the event; the next one is processed normally.
      }
    });

    proc.on("close", (code) => {
      flightRecorder.note(`bridge_exit:${code}`, { flush: true });
      if (code !== 0 && code !== null) {
        recordCrashEvidence(
          "bridge_exit",
          new Error(`Python bridge exited with code ${code}`),
        );
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
  }, [appendEntry, updateStreamEntry]); // eslint-disable-line react-hooks/exhaustive-deps

  const cleanup = useCallback(() => {
    if (bridgeRef.current) {
      bridgeRef.current.kill();
      bridgeRef.current = null;
    }
    process.exit(0);
  }, []);

  // ── Submission logic ───────────────────────────────────

  const submit = useCallback(() => {
    if (pendingPermission) {
      setHint("Resolve the protected write request first.");
      return;
    }
    if (pendingChoice) {
      setHint("Answer the pending question first (Up/Down + Enter, Esc dismisses).");
      return;
    }
    const stripped = inputTextRef.current.trim();
    if (!stripped) {
      setHint("Enter a message or command.");
      return;
    }
    if (focusedPane === "projects" && !stripped.startsWith("/")) {
      setHint("Projects focused \u2014 Tab to Council to send messages");
      return;
    }
    const queued = !ready;
    if (!queued) {
      setReady(false);
      const nextBusyTarget = resolveBusyTarget(stripped, status.route);
      setBusyTarget(nextBusyTarget);
      setV2Activity(startV2ActivityFromInput(stripped, status.route));
      setHint("");
    } else {
      setQueuedCount((prev) => prev + 1);
      setHint("Queued message.");
    }
    setInputText("");
    setCursor(0);
    setDesiredCol(null);

    const proc = bridgeRef.current;
    if (proc?.stdin?.writable) {
      flightRecorder.note("user_submit");
      const msg: Record<string, unknown> = { type: "input", text: stripped };
      const attachments = imageAttachmentsRef.current;
      if (attachments.size > 0) {
        msg.attachments = Array.from(attachments.entries()).map(([id, filePath]) => ({
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
  }, [focusedPane, ready, pendingPermission, pendingChoice, setCursor, setImageAttachments, setInputText, status.route, status.mode]);

  const respondToPermission = useCallback((allow: boolean) => {
    const proc = bridgeRef.current;
    if (!pendingPermission || !proc?.stdin?.writable) {
      return;
    }
    proc.stdin.write(JSON.stringify({
      type: "permission_response",
      request_id: pendingPermission.request_id,
      allow,
    }) + "\n");
    setHint(allow ? "Allowing protected write..." : "Denying protected write...");
  }, [pendingPermission]);

  const respondToChoice = useCallback((index: number) => {
    const proc = bridgeRef.current;
    if (!pendingChoice || !proc?.stdin?.writable) {
      return;
    }
    proc.stdin.write(JSON.stringify({
      type: "choice_response",
      index,
    }) + "\n");
  }, [pendingChoice]);

  const interrupt = useCallback(() => {
    if (ready) {
      return;
    }
    const proc = bridgeRef.current;
    if (proc?.stdin?.writable) {
      proc.stdin.write(JSON.stringify({ type: "interrupt" }) + "\n");
      setHint("Interrupting...");
    }
  }, [ready]);

  // ── Keyboard handling ──────────────────────────────────

  useInput((input, key) => {
    const currentText = inputTextRef.current;
    const currentCursor = cursorRef.current;

    // Ctrl+C — exit
    if (input === "c" && key.ctrl) {
      cleanup();
      return;
    }

    // Ctrl+V — attach a raw image from the macOS clipboard (screenshot
    // Cmd+C, browser "Copy Image"). Terminals only deliver text through
    // Cmd+V paste, so raw image data needs this side channel; file paths
    // (drag-drop, Finder Cmd+C) keep going through the normal paste path.
    if (input === "v" && key.ctrl) {
      setHint("Checking the clipboard for an image…");
      void saveClipboardImage().then((saved) => {
        if (!saved) {
          setHint(
            "No image on the clipboard — Ctrl+V attaches a copied image; "
            + "Cmd+V pastes text and file paths.",
          );
          return;
        }
        const id = nextImageId.current++;
        const next = new Map(imageAttachmentsRef.current);
        next.set(id, saved);
        setImageAttachments(next);
        const c = cursorRef.current;
        const placeholder = `[image ${id}]`;
        setInputText((prev) => prev.slice(0, c) + placeholder + prev.slice(c));
        setCursor(c + placeholder.length);
        setDesiredCol(null);
        setHint("Image attached from clipboard.");
      });
      return;
    }

    // Ctrl+Y — toggle native terminal text selection (mouse passthrough).
    if (input.toLowerCase() === "y" && key.ctrl) {
      setMouseSelectionMode((prev) => {
        const next = !prev;
        setHint(next
          ? "Mouse selection mode: drag to select text; Ctrl+Y or Esc returns to scrolling."
          : "");
        return next;
      });
      return;
    }

    if (mouseSelectionMode && key.escape) {
      setMouseSelectionMode(false);
      setHint("");
      return;
    }

    if (pendingPermission) {
      if (key.leftArrow || key.rightArrow || key.tab) {
        setPermissionChoice((prev) => (prev === "allow" ? "deny" : "allow"));
        return;
      }
      if (key.return) {
        respondToPermission(permissionChoice === "allow");
        return;
      }
      if (key.escape || input.toLowerCase() === "n") {
        respondToPermission(false);
        return;
      }
      if (input.toLowerCase() === "y") {
        respondToPermission(true);
        return;
      }
      return;
    }

    if (pendingChoice) {
      const optionCount = pendingChoice.options.length;
      if (key.upArrow) {
        setChoiceIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || key.tab) {
        setChoiceIndex((prev) => Math.min(optionCount - 1, prev + 1));
        return;
      }
      if (key.return) {
        respondToChoice(choiceIndex);
        return;
      }
      if (key.escape) {
        respondToChoice(-1);
        return;
      }
      return;
    }

    // Tab / Shift+Tab — toggle pane focus
    if (input === "p" && key.ctrl) {
      setProjectsVisible((prev) => {
        const next = !prev;
        if (!next) {
          setProjectFilter("");
          if (focusedPane === "projects") setFocusedPane("room");
        }
        setHint(next ? "" : "Projects panel hidden (Ctrl+P to show)");
        return next;
      });
      return;
    }

    if (key.tab) {
      if (!projectsPaneRendered) return;
      setProjectFilter("");
      setFocusedPane((prev) => {
        const next = prev === "room" ? "projects" : "room";
        if (next === "projects") {
          setHint("Projects focused \u2014 \u2191/\u2193 to navigate, type to filter, Enter to open, Tab to leave");
        } else {
          setHint("");
        }
        return next;
      });
      return;
    }

    if (focusedPane === "projects" && projectsPaneRendered) {
      if (key.upArrow && !key.meta && !key.ctrl) {
        setProjectCursor((prev) => nextSelectableRow(projectRows, prev, -1));
        return;
      }
      if (key.downArrow && !key.meta && !key.ctrl) {
        setProjectCursor((prev) => nextSelectableRow(projectRows, prev, 1));
        return;
      }
      if (key.return && !key.meta) {
        const row = projectRows[projectCursor];
        if (!row || !row.selectable) return;
        const command = projectRowCommand(row);
        if (!command) return;
        const proc = bridgeRef.current;
        if (proc?.stdin?.writable) {
          if (ready) {
            setReady(false);
            setBusyTarget("system");
            setV2Activity(createV2Activity("system", "system"));
          } else {
            setQueuedCount((prev) => prev + 1);
            setHint("Queued project command.");
          }
          proc.stdin.write(JSON.stringify({ type: "input", text: command }) + "\n");
        }
        setProjectFilter("");
        return;
      }
      // Type-to-filter: printable characters narrow the list while the
      // input box is empty; "/" still starts a slash command.
      if ((key.backspace || key.delete) && projectFilter) {
        setProjectFilter((prev) => prev.slice(0, -1));
        return;
      }
      if (key.escape && projectFilter) {
        setProjectFilter("");
        return;
      }
      if (
        input
        && !key.ctrl && !key.meta && !key.return && !key.escape
        && inputTextRef.current === ""
        && !(projectFilter === "" && input.startsWith("/"))
      ) {
        setProjectFilter((prev) => prev + input);
        return;
      }
    }

    // Alt/Option+Enter — insert newline (fallback for Shift+Enter)
    // Shift+Enter is handled at the stdin filter level (onShiftEnter)
    // because terminals send raw escape sequences that Ink can't parse.
    if (key.return && key.meta) {
      setInputText((prev) => prev.slice(0, currentCursor) + "\n" + prev.slice(currentCursor));
      setCursor((c) => c + 1);
      setDesiredCol(null);
      return;
    }

    // Enter — submit
    if (key.return) {
      submit();
      return;
    }

    // Escape — interrupt active turn
    if (key.escape) {
      interrupt();
      return;
    }

    // Ctrl+U — delete to start of line
    if (input === "u" && key.ctrl && currentCursor > 0) {
      setInputText((prev) => prev.slice(currentCursor));
      setCursor(0);
      setDesiredCol(null);
      return;
    }

    // Ctrl+K — delete to end of line
    if (input === "k" && key.ctrl) {
      setInputText((prev) => prev.slice(0, currentCursor));
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
      setCursor(currentText.length);
      setDesiredCol(null);
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (currentCursor > 0) {
        setInputText((prev) => prev.slice(0, currentCursor - 1) + prev.slice(currentCursor));
        setCursor((c) => c - 1);
      }
      setDesiredCol(null);
      return;
    }

    // Cmd+Left / Option+Left — jump word/line backward
    if (key.leftArrow && (key.meta || key.ctrl)) {
      // Jump to previous word boundary
      let pos = currentCursor - 1;
      while (pos > 0 && currentText[pos - 1] === " ") pos--;
      while (pos > 0 && currentText[pos - 1] !== " ") pos--;
      setCursor(Math.max(0, pos));
      setDesiredCol(null);
      return;
    }

    // Cmd+Right / Option+Right — jump word/line forward
    if (key.rightArrow && (key.meta || key.ctrl)) {
      let pos = currentCursor;
      while (pos < currentText.length && currentText[pos] !== " ") pos++;
      while (pos < currentText.length && currentText[pos] === " ") pos++;
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
      if (currentCursor === currentText.length && ghostText) {
        setInputText((prev) => prev + ghostText);
        setCursor((c) => c + ghostText.length);
      } else {
        setCursor((c) => Math.min(currentText.length, c + 1));
      }
      setDesiredCol(null);
      return;
    }

    // Up arrow — move cursor to previous line in multi-line input
    if (key.upArrow && !key.meta) {
      const { line, col } = cursorToWrappedLineCol(currentText, currentCursor, inputTextWidth);
      if (line > 0) {
        const targetCol = desiredCol ?? col;
        setCursor(wrappedLineColToCursor(currentText, inputTextWidth, line - 1, targetCol));
        if (desiredCol === null) setDesiredCol(col);
      }
      return;
    }

    // Down arrow — move cursor to next line in multi-line input
    if (key.downArrow && !key.meta) {
      const { line, col } = cursorToWrappedLineCol(currentText, currentCursor, inputTextWidth);
      const lineCount = wrapInputLines(currentText, inputTextWidth).length;
      if (line < lineCount - 1) {
        const targetCol = desiredCol ?? col;
        setCursor(wrappedLineColToCursor(currentText, inputTextWidth, line + 1, targetCol));
        if (desiredCol === null) setDesiredCol(col);
      }
      return;
    }

    // PageUp / PageDown — page scroll (Ctrl+B up, Ctrl+F down)
    if (input === "b" && key.ctrl) {
      const pageSize = Math.max(1, paneContentHeight);
      setRoomScroll((prev) => prev + pageSize);
      return;
    }
    if (input === "f" && key.ctrl) {
      const pageSize = Math.max(1, paneContentHeight);
      setRoomScroll((prev) => Math.max(0, prev - pageSize));
      return;
    }

    // Regular character input — insert at cursor position
    if (input && !key.ctrl && !key.meta) {
      setInputText((prev) => prev.slice(0, currentCursor) + input + prev.slice(currentCursor));
      setCursor((c) => c + input.length);
      setDesiredCol(null);
    }
  });

  // ── Input label ────────────────────────────────────────

  const inputLabel =
    focusedPane === "projects"
      ? "Projects — Enter opens; / for commands:"
      : "You (@claude/@codex/@all, /help):";

  const cursorColor = ready ? THEME.ready : THEME.warning;
  const activeV2Activity = v2Activity ?? v2ActivityFromBusyTarget(busyTarget);
  const busyText = formatV2ActivityText(activeV2Activity);
  const busySegments = buildBusySegments(busyText, busyFrameIndex);
  const busyGlyph = v2ActivityGlyph(busyFrameIndex);
  const selectionHint = "Mouse selection mode: drag to select text; Ctrl+Y or Esc returns to scrolling.";
  const queueHint = queuedCount > 0
    ? `${queuedCount} queued message${queuedCount === 1 ? "" : "s"}.`
    : "";
  const statusText = mouseSelectionMode ? selectionHint : hint || queueHint || (!ready ? busyText : " ");

  // ── Render ─────────────────────────────────────────────

  return (
    <Box flexDirection="column" height={rows}>
      {/* Panes */}
      <Box flexDirection="row" flexGrow={1} marginBottom={1}>
        {projectsPaneRendered ? (
          <ProjectsPane
            rows={projectRows}
            focused={focusedPane === "projects"}
            cursorIndex={projectCursor}
            height={paneHeight}
            textWidth={projectsTextWidth}
            viewportHeight={paneContentHeight}
            filter={projectFilter}
          />
        ) : null}
        <Pane
          title="COUNCIL"
          pane="room"
          flatLines={roomFlatLines}
          focused={focusedPane === "room"}
          height={paneHeight}
          contentHeight={paneContentHeight}
          textWidth={councilTextWidth}
          scrollOffset={roomScroll}
          hasNewMessages={roomHasNew}
          selection={paneSelection}
        />
      </Box>

      {/* Input area */}
      <Box flexDirection="column" marginBottom={1} width="100%">
        <Text color={THEME.chromeMuted}>{"─".repeat(Math.max(1, cols - 2))}</Text>
        {pendingPermission ? (
          <PermissionPrompt request={pendingPermission} choice={permissionChoice} />
        ) : pendingChoice ? (
          <ChoicePrompt
            prompt={pendingChoice.prompt}
            options={pendingChoice.options}
            index={choiceIndex}
          />
        ) : (
          <>
            <Text color={(hint || mouseSelectionMode) ? THEME.textMuted : THEME.statusMuted}>
              {mouseSelectionMode || hint || ready
                ? statusText
                : (
                  <>
                    <Text color={THEME.accentBright}>{busyGlyph} </Text>
                    {busySegments.map((segment, index) => (
                      <Text key={`busy-${index}`} color={segment.color} bold={segment.bold}>
                        {segment.text}
                      </Text>
                    ))}
                  </>
                )}
            </Text>
            <Text color={THEME.text}>{inputLabel}</Text>
            <Box
              flexDirection="column"
              paddingX={1}
              paddingY={1}
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
            </Box>
          </>
        )}
      </Box>

      {/* Status bar */}
      <StatusBar status={status} />
    </Box>
  );
}
