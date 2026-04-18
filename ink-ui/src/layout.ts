import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import hljs from "highlight.js";

// Layout budget constants — derived from Ink's rendered chrome.
// INPUT_CHROME: divider(1) + status(1) + label(1) + top inset(1)
//             + bottom inset(1) + field spacing(2) = 7
// PANE_CHROME:  border(2) + title(1) = 3
// STATUS_HEIGHT: 1
const INPUT_CHROME = 7;
const STATUS_HEIGHT = 1;
const PANE_CHROME = 3;
const PANE_HORIZONTAL_BORDER = 2;
const PANE_HORIZONTAL_PADDING = 2;

export interface LayoutBudget {
  paneHeight: number;
  paneContentHeight: number;
  leftPaneWidth: number;
  rightPaneWidth: number;
  leftTextWidth: number;
  rightTextWidth: number;
  inputHeight: number;
}

export function computeLayoutBudget(
  termRows: number,
  termCols: number,
  inputViewportLineCount: number,
): LayoutBudget {
  const inputHeight = INPUT_CHROME + Math.max(1, inputViewportLineCount);
  const paneHeight = Math.max(PANE_CHROME + 1, termRows - inputHeight - STATUS_HEIGHT);
  const paneContentHeight = Math.max(1, paneHeight - PANE_CHROME);

  const leftPaneWidth = Math.floor(termCols / 2);
  const rightPaneWidth = termCols - leftPaneWidth;
  const leftTextWidth = Math.max(
    4,
    leftPaneWidth - PANE_HORIZONTAL_BORDER - PANE_HORIZONTAL_PADDING,
  );
  const rightTextWidth = Math.max(
    4,
    rightPaneWidth - PANE_HORIZONTAL_BORDER - PANE_HORIZONTAL_PADDING,
  );

  return {
    paneHeight,
    paneContentHeight,
    leftPaneWidth,
    rightPaneWidth,
    leftTextWidth,
    rightTextWidth,
    inputHeight,
  };
}

export interface ViewportSlice {
  startIdx: number;
  endIdx: number;
  clampedScroll: number;
}

export function computeViewportSlice(
  totalLines: number,
  contentHeight: number,
  scrollOffset: number,
): ViewportSlice {
  const maxScroll = Math.max(0, totalLines - contentHeight);
  const clampedScroll = Math.min(scrollOffset, maxScroll);
  const endIdx = totalLines - clampedScroll;
  const startIdx = Math.max(0, endIdx - contentHeight);
  return { startIdx, endIdx, clampedScroll };
}

const WHEEL_ACCEL_WINDOW_MS = 40;
const WHEEL_ACCEL_STEP = 0.3;
const WHEEL_ACCEL_MAX = 6;

export interface WheelAccelState {
  time: number;
  multiplier: number;
  direction: 0 | 1 | -1;
}

export function initWheelAccel(): WheelAccelState {
  return { time: 0, multiplier: 1, direction: 0 };
}

export function computeWheelStep(
  state: WheelAccelState,
  direction: 1 | -1,
  now: number,
): number {
  const gap = now - state.time;
  if (direction !== state.direction || gap > WHEEL_ACCEL_WINDOW_MS) {
    state.multiplier = 1;
  } else {
    state.multiplier = Math.min(WHEEL_ACCEL_MAX, state.multiplier + WHEEL_ACCEL_STEP);
  }
  state.time = now;
  state.direction = direction;
  return Math.max(1, Math.floor(state.multiplier));
}

export function computeWheelScrollDelta(
  state: WheelAccelState,
  wheelSteps: number,
  now: number,
): number {
  const direction = wheelSteps > 0 ? 1 : -1;
  let delta = 0;
  for (let i = 0; i < Math.abs(wheelSteps); i++) {
    delta += computeWheelStep(state, direction, now) * direction;
  }
  return delta;
}

export function computeSmoothScrollNext(
  currentOffset: number,
  targetOffset: number,
): number {
  const distance = targetOffset - currentOffset;
  if (distance === 0) return currentOffset;
  const step = Math.min(
    Math.abs(distance),
    Math.max(1, Math.ceil(Math.abs(distance) * 0.35)),
  );
  return currentOffset + Math.sign(distance) * step;
}

export function clampScrollOffset(scrollOffset: number, maxScroll: number): number {
  return Math.max(0, Math.min(maxScroll, scrollOffset));
}

export function truncateTitle(
  title: string,
  scrollOffset: number,
  maxWidth: number,
  badge?: string,
): string {
  const badgeStr = badge ?? "";
  const scrollStr = scrollOffset > 0 ? ` [+${scrollOffset}]` : "";
  const fullSuffix = scrollStr + badgeStr;
  const ellipsis = "…";

  // If everything fits without truncation, show all
  if (stringWidth(title) + stringWidth(fullSuffix) <= maxWidth) {
    return title + fullSuffix;
  }

  // Space is tight — badge takes priority over scroll indicator.
  // Try badge-only first (more room for title), then full suffix as fallback.
  const suffixes = badgeStr ? [badgeStr, fullSuffix] : [fullSuffix];

  for (const suffix of suffixes) {
    const suffixWidth = stringWidth(suffix);
    const available = maxWidth - suffixWidth;
    if (available < 0) continue;

    if (stringWidth(title) <= available) {
      return title + suffix;
    }

    if (stringWidth(ellipsis) <= available) {
      let truncated = "";
      let w = 0;
      for (const char of title) {
        const cw = stringWidth(char);
        if (w + cw + stringWidth(ellipsis) > available) break;
        truncated += char;
        w += cw;
      }
      return truncated + ellipsis + suffix;
    }
  }

  return ellipsis;
}

// ── Cursor helpers for multi-line input ────────────────────

export function cursorToLineCol(
  text: string,
  cursor: number,
): { line: number; col: number } {
  const before = text.slice(0, cursor);
  const lines = before.split("\n");
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
}

export function lineColToCursor(
  text: string,
  targetLine: number,
  targetCol: number,
): number {
  const lines = text.split("\n");
  let pos = 0;
  for (let i = 0; i < targetLine && i < lines.length; i++) {
    pos += lines[i]!.length + 1; // +1 for the \n
  }
  const lineLen = lines[targetLine]?.length ?? 0;
  return pos + Math.min(targetCol, lineLen);
}

// ── Wrapped-line helpers for the input field ───────────────

export interface WrappedInputLine {
  text: string;
  start: number;
  end: number;
}

function segmentGraphemes(text: string): Array<{ segment: string; index: number }> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), ({ segment, index }) => ({
    segment,
    index,
  }));
}

export function wrapInputLines(
  text: string,
  width: number,
): WrappedInputLine[] {
  if (text.length === 0) {
    return [{ text: "", start: 0, end: 0 }];
  }

  const lines: WrappedInputLine[] = [];
  let currentSegments: Array<{
    segment: string;
    index: number;
    width: number;
    isBreak: boolean;
  }> = [];
  let currentStart = 0;
  let currentEnd = 0;
  let currentWidth = 0;
  let lastBreakIdx: number | null = null;

  const flushCurrent = () => {
    const lineText = currentSegments.map((seg) => seg.segment).join("");
    lines.push({ text: lineText, start: currentStart, end: currentEnd });
  };

  const resetCurrent = (nextStart: number) => {
    currentSegments = [];
    currentStart = nextStart;
    currentEnd = nextStart;
    currentWidth = 0;
    lastBreakIdx = null;
  };

  const rebuildCurrent = () => {
    currentWidth = currentSegments.reduce((sum, seg) => sum + seg.width, 0);
    currentEnd = currentSegments.length > 0
      ? currentSegments[currentSegments.length - 1]!.index
        + currentSegments[currentSegments.length - 1]!.segment.length
      : currentStart;
    lastBreakIdx = null;
    for (let i = 0; i < currentSegments.length; i++) {
      if (currentSegments[i]!.isBreak) lastBreakIdx = i;
    }
  };

  for (const { segment, index } of segmentGraphemes(text)) {
    const nextIndex = index + segment.length;

    if (segment === "\n") {
      flushCurrent();
      resetCurrent(nextIndex);
      continue;
    }

    const segWidth = Math.max(1, stringWidth(segment));
    currentSegments.push({
      segment,
      index,
      width: segWidth,
      isBreak: /\s/.test(segment),
    });
    currentWidth += segWidth;
    currentEnd = nextIndex;
    if (/\s/.test(segment)) lastBreakIdx = currentSegments.length - 1;

    while (currentSegments.length > 0 && currentWidth > width) {
      if (lastBreakIdx !== null && lastBreakIdx < currentSegments.length - 1) {
        const head = currentSegments.slice(0, lastBreakIdx + 1);
        const tail = currentSegments.slice(lastBreakIdx + 1);
        const headText = head.map((seg) => seg.segment).join("");
        const headEnd = head[head.length - 1]!.index + head[head.length - 1]!.segment.length;
        lines.push({ text: headText, start: currentStart, end: headEnd });
        currentSegments = tail;
        currentStart = tail[0]!.index;
        rebuildCurrent();
        continue;
      }

      if (currentSegments.length > 1) {
        const tail = currentSegments[currentSegments.length - 1]!;
        const head = currentSegments.slice(0, -1);
        const headText = head.map((seg) => seg.segment).join("");
        const headEnd = head[head.length - 1]!.index + head[head.length - 1]!.segment.length;
        lines.push({ text: headText, start: currentStart, end: headEnd });
        currentSegments = [tail];
        currentStart = tail.index;
        rebuildCurrent();
        continue;
      }

      break;
    }
  }

  flushCurrent();
  return lines;
}

export function cursorToWrappedLineCol(
  text: string,
  cursor: number,
  width: number,
): { line: number; col: number } {
  const clampedCursor = Math.max(0, Math.min(cursor, text.length));
  const lines = wrapInputLines(text, Math.max(1, width));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const nextLine = lines[i + 1];
    if (
      clampedCursor === line.end &&
      nextLine &&
      nextLine.start === clampedCursor
    ) {
      continue;
    }
    if (clampedCursor >= line.start && clampedCursor <= line.end) {
      return {
        line: i,
        col: stringWidth(line.text.slice(0, clampedCursor - line.start)),
      };
    }
  }

  const last = lines[lines.length - 1]!;
  return { line: lines.length - 1, col: stringWidth(last.text) };
}

export function wrappedLineColToCursor(
  text: string,
  width: number,
  targetLine: number,
  targetCol: number,
): number {
  const lines = wrapInputLines(text, Math.max(1, width));
  const line = lines[Math.max(0, Math.min(targetLine, lines.length - 1))];
  if (!line) return text.length;

  let offset = line.start;
  let col = 0;
  for (const { segment, index } of segmentGraphemes(line.text)) {
    const segWidth = Math.max(1, stringWidth(segment));
    if (col + segWidth > targetCol) break;
    col += segWidth;
    offset = line.start + index + segment.length;
  }
  return Math.min(offset, line.end);
}

// ── Scroll policy ──────────────────────────────────────────

export function shouldAutoScroll(scrollOffset: number): boolean {
  return scrollOffset === 0;
}

// ── Speaker constants ──────────────────────────────────────

export const SPEAKER_COLORS: Record<string, string> = {
  user: "cyan",
  claude: "blueBright",
  codex: "greenBright",
  system: "yellow",
  summary: "magenta",
};

/** Muted body-text colors — softer than the bold label colors. */
export const SPEAKER_BODY_COLORS: Record<string, string> = {
  user: "grayBright",
  claude: "blue",
  codex: "green",
  system: "yellow",
  summary: "magenta",
};

export const SPEAKER_LABELS: Record<string, string> = {
  user: "[You] ",
  claude: "[Claude] ",
  codex: "[Codex] ",
  summary: "[Summary] ",
  system: "System: ",
};

// ── Flat-line pre-rendering (Howler pattern) ───────────────

export interface FlatLine {
  key: string;
  label: string;
  gutter?: string;
  gutterColor?: string;
  gutterBackgroundColor?: string;
  text: string;
  segments?: LineSegment[];
  speakerColor: string;
  bodyColor: string;
  bodyBackgroundColor?: string;
  bodyBold?: boolean;
}

export interface LineSegment {
  text: string;
  color?: string;
  bold?: boolean;
  backgroundColor?: string;
}

export interface Entry {
  speaker: string;
  text: string;
  blocks?: RenderBlock[];
}

interface DiffContext {
  filePath: string | null;
  oldLine: number | null;
  newLine: number | null;
}

const DIFF_GUTTER_WIDTH = 11;
const CODE_GUTTER_WIDTH = 6;
const CODE_BACKGROUND_COLOR = "blackBright";
const DIFF_BACKGROUND_COLOR = "black";
const DIFF_HEADER_BACKGROUND_COLOR = "blackBright";
const SNIPPET_HEADER_RE = /^['`"]?([^'"`]+?\.[A-Za-z0-9_.-]+)['`"]?\s+lines?\s+(\d+)(?:-(\d+))?:?\s*$/;
const LANGUAGE_ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  node: "javascript",
  shellsession: "shell",
  "shell-session": "shell",
  console: "shell",
  typescriptreact: "tsx",
  "typescript-react": "tsx",
  javascriptreact: "jsx",
  "javascript-react": "jsx",
};

interface SnippetHeader {
  filePath: string;
  startLine: number;
  endLine: number | null;
}

interface CodeContext {
  language: string | null;
  nextLine: number | null;
  activeHeader: SnippetHeader | null;
}

function formatDiffLineNumber(lineNumber: number | null): string {
  if (lineNumber == null) return "    ";
  return String(lineNumber).padStart(4, " ");
}

function formatCodeGutter(lineNumber: number | null): string | undefined {
  if (lineNumber == null) return undefined;
  return `${String(lineNumber).padStart(4, " ")}  `;
}

function formatCodeContinuationGutter(): string {
  return "  ..  ";
}

function formatDiffGutter(
  kind: "add" | "remove" | "context" | "continuation",
  oldLine: number | null,
  newLine: number | null,
): string {
  if (kind === "continuation") return " ".repeat(DIFF_GUTTER_WIDTH);
  const marker = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
  return `${formatDiffLineNumber(oldLine)} ${formatDiffLineNumber(newLine)} ${marker} `;
}

function formatDiffContinuationGutter(
  kind: "add" | "remove" | "context" | "meta" | "summary",
): string {
  if (kind === "summary" || kind === "meta") {
    return "...".padEnd(DIFF_GUTTER_WIDTH, " ");
  }
  const marker = kind === "add"
    ? "+"
    : kind === "remove"
      ? "-"
      : "|";
  return `${"   ."} ${"   ."} ${marker}`;
}

function nextDiffContext(
  ctx: DiffContext,
  rawLine: string,
): DiffContext {
  const patchSummary = /^(Edited|Updated|Added|Deleted) in (.+?) \(\+\d+ -\d+\)$/.exec(rawLine.trim());
  if (patchSummary) {
    return { ...ctx, filePath: patchSummary[2] ?? ctx.filePath };
  }

  const updateFile = /^\*\*\* (?:Update|Add|Delete|Move to): (.+)$/.exec(rawLine.trim());
  if (updateFile) {
    return { ...ctx, filePath: updateFile[1] ?? ctx.filePath };
  }

  const diffGit = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine.trim());
  if (diffGit) {
    return { ...ctx, filePath: diffGit[2] ?? diffGit[1] ?? ctx.filePath };
  }

  const plusPlusPlus = /^\+\+\+ (?:b\/)?(.+)$/.exec(rawLine.trim());
  if (plusPlusPlus && plusPlusPlus[1] !== "/dev/null") {
    return { ...ctx, filePath: plusPlusPlus[1] ?? ctx.filePath };
  }

  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine.trim());
  if (hunk) {
    return {
      ...ctx,
      oldLine: Number.parseInt(hunk[1]!, 10),
      newLine: Number.parseInt(hunk[2]!, 10),
    };
  }

  if (rawLine.startsWith("+") && !rawLine.startsWith("+++ ")) {
    return {
      ...ctx,
      newLine: ctx.newLine == null ? null : ctx.newLine + 1,
    };
  }

  if (rawLine.startsWith("-") && !rawLine.startsWith("--- ")) {
    return {
      ...ctx,
      oldLine: ctx.oldLine == null ? null : ctx.oldLine + 1,
    };
  }

  if (ctx.oldLine != null && ctx.newLine != null) {
    return {
      ...ctx,
      oldLine: ctx.oldLine + 1,
      newLine: ctx.newLine + 1,
    };
  }

  return ctx;
}

function diffDisplayForLine(
  rawLine: string,
  ctx: DiffContext,
): { gutter?: string; gutterColor?: string; kind?: "add" | "remove" | "context" } {
  const trimmed = rawLine.trimStart();
  if (/^(Edited|Updated|Added|Deleted) in /.test(trimmed)) {
    return {
      gutter: ctx.filePath ? `${ctx.filePath} `.slice(0, DIFF_GUTTER_WIDTH).padEnd(DIFF_GUTTER_WIDTH, " ") : undefined,
      gutterColor: "cyanBright",
    };
  }

  if (/^(diff --git|index\b|--- |\+\+\+ |@@)/.test(trimmed)) {
    const gutter = ctx.filePath
      ? `${ctx.filePath} `.slice(0, DIFF_GUTTER_WIDTH).padEnd(DIFF_GUTTER_WIDTH, " ")
      : undefined;
    return { gutter, gutterColor: "cyanBright" };
  }

  if (rawLine.startsWith("+") && !rawLine.startsWith("+++ ")) {
    return {
      gutter: formatDiffGutter("add", null, ctx.newLine),
      gutterColor: "green",
      kind: "add",
    };
  }

  if (rawLine.startsWith("-") && !rawLine.startsWith("--- ")) {
    return {
      gutter: formatDiffGutter("remove", ctx.oldLine, null),
      gutterColor: "red",
      kind: "remove",
    };
  }

  if (ctx.oldLine != null || ctx.newLine != null) {
    return {
      gutter: formatDiffGutter("context", ctx.oldLine, ctx.newLine),
      gutterColor: "gray",
      kind: "context",
    };
  }

  return {};
}

function parseSnippetHeader(rawLine: string): SnippetHeader | null {
  const match = SNIPPET_HEADER_RE.exec(rawLine.trim());
  if (!match) return null;
  return {
    filePath: match[1]!,
    startLine: Number.parseInt(match[2]!, 10),
    endLine: match[3] ? Number.parseInt(match[3], 10) : null,
  };
}

function snippetHeaderSegments(
  header: SnippetHeader,
  language: string | null,
): LineSegment[] {
  const lineRange = header.endLine == null
    ? `lines ${header.startLine}`
    : `lines ${header.startLine}-${header.endLine}`;
  return [
    { text: header.filePath, color: "cyan", bold: true, backgroundColor: CODE_BACKGROUND_COLOR },
    { text: "  ", color: "gray", backgroundColor: CODE_BACKGROUND_COLOR },
    { text: lineRange, color: "gray", backgroundColor: CODE_BACKGROUND_COLOR },
    ...(language ? [
      { text: "  ", color: "gray", backgroundColor: CODE_BACKGROUND_COLOR },
      { text: language, color: "yellow", bold: false, backgroundColor: CODE_BACKGROUND_COLOR },
    ] : []),
  ];
}

function fallbackLanguageFromPath(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  if (["py"].includes(ext)) return "python";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return ext;
  if (["sh", "bash", "zsh"].includes(ext)) return "bash";
  if (["json"].includes(ext)) return "json";
  if (["yml", "yaml"].includes(ext)) return "yaml";
  if (["md"].includes(ext)) return "markdown";
  return ext;
}

function normalizeLanguageName(language: string | null): string | null {
  if (!language) return null;
  const lowered = language.toLowerCase();
  return LANGUAGE_ALIASES[lowered] ?? lowered;
}

function normalizeFenceLanguage(rawFence: string, header: SnippetHeader | null): string | null {
  const trimmed = rawFence.trim();
  const match = /^```([\w.+-]+)?/.exec(trimmed);
  const explicit = normalizeLanguageName(match?.[1] ?? null);
  return explicit || (header ? normalizeLanguageName(fallbackLanguageFromPath(header.filePath)) : null);
}

export type RenderBlock =
  | TextBlock
  | CodeBlock
  | DiffBlock;

export interface TextBlock {
  type: "text";
  lines: string[];
}

export interface CodeBlock {
  type: "code";
  header: SnippetHeader | null;
  language: string | null;
  leadingBlankLines: number;
  lines: string[];
}

export interface DiffBlock {
  type: "diff";
  filePath: string | null;
  language: string | null;
  lines: string[];
}

function isDiffStartLine(rawLine: string): boolean {
  const trimmed = rawLine.trimStart();
  return (
    /^(Edited|Updated|Added|Deleted)\b/.test(trimmed)
    || /^\*\*\* (Update|Add|Delete|Move to):/.test(trimmed)
    || /^(diff --git|index\b|--- |\+\+\+ |@@)/.test(trimmed)
  );
}

function isDiffContinuationLine(rawLine: string, inDiffBlock: boolean): boolean {
  if (!inDiffBlock) return isDiffStartLine(rawLine);
  if (rawLine.length === 0) return false;
  if (isDiffStartLine(rawLine)) return true;
  if (rawLine.startsWith(" ") || rawLine.startsWith("+") || rawLine.startsWith("-")) {
    return !/^(--- |\+\+\+ )/.test(rawLine) || rawLine.startsWith(" ");
  }
  return false;
}

export function parseRenderBlocks(text: string): RenderBlock[] {
  const rawLines = text.split("\n");
  const blocks: RenderBlock[] = [];
  let textLines: string[] = [];
  let pendingHeader: SnippetHeader | null = null;
  let pendingHeaderBlankLines = 0;

  const flushTextBlock = () => {
    if (textLines.length === 0) return;
    blocks.push({ type: "text", lines: textLines });
    textLines = [];
  };

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!;
    const trimmed = rawLine.trimStart();
    const snippetHeader = parseSnippetHeader(rawLine);

    if (snippetHeader) {
      flushTextBlock();
      pendingHeader = snippetHeader;
      pendingHeaderBlankLines = 0;
      continue;
    }

    if (pendingHeader && rawLine.trim().length === 0) {
      pendingHeaderBlankLines += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      flushTextBlock();
      const language = normalizeFenceLanguage(rawLine, pendingHeader);
      const codeLines: string[] = [];
      for (i += 1; i < rawLines.length; i++) {
        const codeLine = rawLines[i]!;
        if (/^```/.test(codeLine.trimStart())) break;
        codeLines.push(codeLine);
      }
      blocks.push({
        type: "code",
        header: pendingHeader,
        language,
        leadingBlankLines: pendingHeaderBlankLines,
        lines: codeLines,
      });
      pendingHeader = null;
      pendingHeaderBlankLines = 0;
      continue;
    }

    if (isDiffStartLine(rawLine)) {
      flushTextBlock();
      const diffLines: string[] = [];
      let ctx: DiffContext = {
        filePath: null,
        oldLine: null,
        newLine: null,
      };

      for (; i < rawLines.length; i++) {
        const diffLine = rawLines[i]!;
        if (!isDiffContinuationLine(diffLine, diffLines.length > 0)) break;
        diffLines.push(diffLine);
        ctx = nextDiffContext(ctx, diffLine);
      }
      i -= 1;
      blocks.push({
        type: "diff",
        filePath: ctx.filePath,
        language: ctx.filePath ? fallbackLanguageFromPath(ctx.filePath) : null,
        lines: diffLines,
      });
      pendingHeader = null;
      pendingHeaderBlankLines = 0;
      continue;
    }

    if (pendingHeader) {
      blocks.push({
        type: "code",
        header: pendingHeader,
        language: fallbackLanguageFromPath(pendingHeader.filePath),
        leadingBlankLines: 0,
        lines: [],
      });
      pendingHeader = null;
      pendingHeaderBlankLines = 0;
    }

    textLines.push(rawLine);
  }

  if (pendingHeader) {
    blocks.push({
      type: "code",
      header: pendingHeader,
      language: fallbackLanguageFromPath(pendingHeader.filePath),
      leadingBlankLines: 0,
      lines: [],
    });
  }
  flushTextBlock();
  return blocks;
}

function tokenizeWithRegex(
  line: string,
  regex: RegExp,
  classify: (token: string) => Omit<LineSegment, "text">,
  defaultColor = "white",
): LineSegment[] {
  const segments: LineSegment[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(regex)) {
    const token = match[0]!;
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, index), color: defaultColor });
    }
    segments.push({ text: token, ...classify(token) });
    lastIndex = index + token.length;
  }
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), color: defaultColor });
  }
  return segments.length > 0 ? segments : [{ text: line, color: defaultColor }];
}

const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "case", "class", "continue",
  "def", "del", "elif", "else", "except", "False", "finally", "for", "from",
  "global", "if", "import", "in", "is", "lambda", "match", "None", "nonlocal",
  "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
]);
const JS_KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "default", "else", "export", "extends", "false", "finally", "for", "from",
  "function", "if", "import", "interface", "let", "new", "null", "return",
  "static", "switch", "throw", "true", "try", "type", "undefined", "var", "while",
]);
const SHELL_KEYWORDS = new Set([
  "case", "do", "done", "echo", "elif", "else", "esac", "exit", "export", "fi",
  "for", "function", "if", "in", "local", "printf", "return", "then", "while",
]);

const PYTHON_TOKEN_RE = /(@[A-Za-z_][\w.]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#.*$)|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b/g;
const JS_TOKEN_RE = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/g;
const SHELL_TOKEN_RE = /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(^|\s)(-[A-Za-z-]+)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w-]*\b/g;
const JSON_TOKEN_RE = /("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b/g;
const YAML_TOKEN_RE = /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(^\s*[A-Za-z0-9_.-]+:)|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b/g;
const HLJS_STYLE_MAP: Record<string, Omit<LineSegment, "text">> = {
  "hljs-keyword": { color: "#ff7b72", bold: true },
  "hljs-operator": { color: "#ff7b72" },
  "hljs-built_in": { color: "#79c0ff" },
  "hljs-type": { color: "#ffa657", bold: true },
  "hljs-title": { color: "#d2a8ff", bold: true },
  "hljs-function": { color: "#d2a8ff", bold: true },
  "hljs-params": { color: "#c9d1d9" },
  "hljs-string": { color: "#a5d6ff" },
  "hljs-char.escape_": { color: "#79c0ff" },
  "hljs-number": { color: "#79c0ff" },
  "hljs-literal": { color: "#79c0ff", bold: true },
  "hljs-comment": { color: "#8b949e" },
  "hljs-quote": { color: "#8b949e" },
  "hljs-variable": { color: "#ffa657" },
  "hljs-property": { color: "#79c0ff" },
  "hljs-attr": { color: "#79c0ff" },
  "hljs-attribute": { color: "#79c0ff" },
  "hljs-meta": { color: "#7ee787" },
  "hljs-tag": { color: "#7ee787" },
  "hljs-name": { color: "#7ee787" },
  "hljs-section": { color: "#d2a8ff", bold: true },
  "hljs-punctuation": { color: "#c9d1d9" },
  "function_": { color: "#d2a8ff", bold: true },
  "class_": { color: "#ffa657", bold: true },
};
const HLJS_LANGUAGE_ALIASES: Record<string, string> = {
  py: "python",
  python: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  typescript: "typescript",
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
};
const highlightCache = new Map<string, LineSegment[]>();

function makeSegment(
  text: string,
  color: string,
  baseBackgroundColor?: string,
  bold?: boolean,
): LineSegment {
  return {
    text,
    color,
    ...(bold ? { bold: true } : {}),
    ...(baseBackgroundColor == null ? {} : { backgroundColor: baseBackgroundColor }),
  };
}

function highlightPythonGeneric(line: string, baseBackgroundColor?: string): LineSegment[] {
  return tokenizeWithRegex(line, PYTHON_TOKEN_RE, (token) => {
    if (token.startsWith("@")) return makeSegment(token, "cyan", baseBackgroundColor, true);
    if (token === "self") return makeSegment(token, "white", baseBackgroundColor);
    if (token.startsWith("\"") || token.startsWith("'")) return makeSegment(token, "yellow", baseBackgroundColor);
    if (token.startsWith("#")) return makeSegment(token, "gray", baseBackgroundColor);
    if (/^\d/.test(token)) return makeSegment(token, "cyan", baseBackgroundColor);
    if (PYTHON_KEYWORDS.has(token)) return makeSegment(token, "magenta", baseBackgroundColor, true);
    return makeSegment(token, "green", baseBackgroundColor);
  }, "white");
}

function highlightPythonStructured(line: string, baseBackgroundColor?: string): LineSegment[] | null {
  const declaration = /^(\s*)(async\s+def|def|class)(\s+)([A-Za-z_]\w*)(.*)$/.exec(line);
  if (declaration) {
    const [, indent, keyword, spacing, name, rest] = declaration;
    return [
      makeSegment(indent!, "white", baseBackgroundColor),
      ...highlightPythonGeneric(keyword!, baseBackgroundColor),
      makeSegment(spacing!, "white", baseBackgroundColor),
      makeSegment(name!, keyword === "class" ? "cyanBright" : "greenBright", baseBackgroundColor, true),
      ...highlightPythonGeneric(rest!, baseBackgroundColor),
    ];
  }

  const fromImport = /^(\s*)(from)(\s+)([A-Za-z_][\w.]*)(\s+)(import)(\s+)(.*)$/.exec(line);
  if (fromImport) {
    const [, indent, fromKw, gap1, modulePath, gap2, importKw, gap3, rest] = fromImport;
    return [
      makeSegment(indent!, "white", baseBackgroundColor),
      makeSegment(fromKw!, "magenta", baseBackgroundColor, true),
      makeSegment(gap1!, "white", baseBackgroundColor),
      makeSegment(modulePath!, "cyanBright", baseBackgroundColor),
      makeSegment(gap2!, "white", baseBackgroundColor),
      makeSegment(importKw!, "magenta", baseBackgroundColor, true),
      makeSegment(gap3!, "white", baseBackgroundColor),
      ...highlightPythonGeneric(rest!, baseBackgroundColor),
    ];
  }

  return null;
}

function highlightJsGeneric(line: string, baseBackgroundColor?: string): LineSegment[] {
  return tokenizeWithRegex(line, JS_TOKEN_RE, (token) => {
    if (token.startsWith("//")) return makeSegment(token, "gray", baseBackgroundColor);
    if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) return makeSegment(token, "yellow", baseBackgroundColor);
    if (/^\d/.test(token)) return makeSegment(token, "cyan", baseBackgroundColor);
    if (JS_KEYWORDS.has(token)) return makeSegment(token, "magenta", baseBackgroundColor, true);
    if (/^[A-Z][A-Za-z0-9_$]*$/.test(token)) return makeSegment(token, "cyanBright", baseBackgroundColor);
    return makeSegment(token, "blue", baseBackgroundColor);
  }, "white");
}

function highlightJsStructured(line: string, baseBackgroundColor?: string): LineSegment[] | null {
  const declaration = /^(\s*)((?:(?:export|default|async)\s+)*)(function|class|interface|type)(\s+)([A-Za-z_$][\w$]*)(.*)$/.exec(line);
  if (declaration) {
    const [, indent, modifiers, keyword, spacing, name, rest] = declaration;
    return [
      makeSegment(indent!, "white", baseBackgroundColor),
      ...highlightJsGeneric(modifiers!, baseBackgroundColor),
      makeSegment(keyword!, "magenta", baseBackgroundColor, true),
      makeSegment(spacing!, "white", baseBackgroundColor),
      makeSegment(name!, "cyanBright", baseBackgroundColor, true),
      ...highlightJsGeneric(rest!, baseBackgroundColor),
    ];
  }

  const binding = /^(\s*)((?:export\s+)?)(const|let|var)(\s+)([A-Za-z_$][\w$]*)(.*)$/.exec(line);
  if (binding) {
    const [, indent, exportKw, keyword, spacing, name, rest] = binding;
    return [
      makeSegment(indent!, "white", baseBackgroundColor),
      ...highlightJsGeneric(exportKw!, baseBackgroundColor),
      makeSegment(keyword!, "magenta", baseBackgroundColor, true),
      makeSegment(spacing!, "white", baseBackgroundColor),
      makeSegment(name!, "cyanBright", baseBackgroundColor, true),
      ...highlightJsGeneric(rest!, baseBackgroundColor),
    ];
  }

  return null;
}

function highlightShellGeneric(line: string, baseBackgroundColor?: string): LineSegment[] {
  return tokenizeWithRegex(line, SHELL_TOKEN_RE, (token) => {
    const trimmed = token.trimStart();
    if (trimmed.startsWith("#")) return makeSegment(token, "gray", baseBackgroundColor);
    if (trimmed.startsWith("\"") || trimmed.startsWith("'")) return makeSegment(token, "yellow", baseBackgroundColor);
    if (trimmed.startsWith("-")) return makeSegment(token, "cyan", baseBackgroundColor, true);
    if (/^\d/.test(trimmed)) return makeSegment(token, "cyan", baseBackgroundColor);
    if (SHELL_KEYWORDS.has(trimmed)) return makeSegment(token, "magenta", baseBackgroundColor, true);
    return makeSegment(token, "green", baseBackgroundColor);
  }, "white");
}

function decodeHighlightedText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function mergeLineSegmentStyle(
  base: Omit<LineSegment, "text">,
  extra: Omit<LineSegment, "text">,
): Omit<LineSegment, "text"> {
  return {
    ...base,
    ...extra,
    backgroundColor: extra.backgroundColor ?? base.backgroundColor,
  };
}

function normalizeHighlightLanguage(language: string | null): string | null {
  const normalized = normalizeLanguageName(language);
  if (!normalized) return null;
  const candidate = HLJS_LANGUAGE_ALIASES[normalized] ?? normalized;
  return hljs.getLanguage(candidate) ? candidate : null;
}

function stylesEqual(
  left: Omit<LineSegment, "text">,
  right: Omit<LineSegment, "text">,
): boolean {
  return left.color === right.color
    && left.bold === right.bold
    && left.backgroundColor === right.backgroundColor;
}

function pushHighlightedSegment(
  segments: LineSegment[],
  text: string,
  style: Omit<LineSegment, "text">,
): void {
  if (text.length === 0) return;
  const previous = segments[segments.length - 1];
  if (previous && stylesEqual(previous, style)) {
    previous.text += text;
    return;
  }
  segments.push({ text, ...style });
}

function parseHighlightedHtml(
  html: string,
  baseBackgroundColor?: string,
): LineSegment[] {
  const baseStyle: Omit<LineSegment, "text"> = {
    color: "#e6edf3",
    ...(baseBackgroundColor == null ? {} : { backgroundColor: baseBackgroundColor }),
  };
  const segments: LineSegment[] = [];
  const stack: Array<Omit<LineSegment, "text">> = [baseStyle];
  const tagPattern = /<\/?span(?:\s+class="([^"]+)")?>/g;
  let lastIndex = 0;

  for (const match of html.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      pushHighlightedSegment(
        segments,
        decodeHighlightedText(html.slice(lastIndex, index)),
        stack[stack.length - 1]!,
      );
    }

    if (match[0].startsWith("</")) {
      if (stack.length > 1) stack.pop();
    } else {
      const classes = (match[1] ?? "").split(/\s+/).filter(Boolean);
      let style = stack[stack.length - 1]!;
      for (const className of classes) {
        const classStyle = HLJS_STYLE_MAP[className] ?? HLJS_STYLE_MAP[`hljs-${className}`];
        if (classStyle) {
          style = mergeLineSegmentStyle(style, classStyle);
        }
      }
      stack.push(style);
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < html.length) {
    pushHighlightedSegment(
      segments,
      decodeHighlightedText(html.slice(lastIndex)),
      stack[stack.length - 1]!,
    );
  }

  return segments.length > 0 ? segments : [{ text: decodeHighlightedText(html), ...baseStyle }];
}

function highlightCodeLineWithHighlightJs(
  line: string,
  language: string | null,
  baseBackgroundColor?: string,
): LineSegment[] | null {
  const resolvedLanguage = normalizeHighlightLanguage(language);
  if (!resolvedLanguage) return null;

  const cacheKey = `${resolvedLanguage}\u0000${baseBackgroundColor ?? ""}\u0000${line}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    return cached.map((segment) => ({ ...segment }));
  }

  try {
    const html = hljs.highlight(line, {
      language: resolvedLanguage,
      ignoreIllegals: true,
    }).value;
    const parsed = parseHighlightedHtml(html, baseBackgroundColor);
    highlightCache.set(cacheKey, parsed);
    return parsed.map((segment) => ({ ...segment }));
  } catch {
    return null;
  }
}

function highlightCodeLine(
  line: string,
  language: string | null,
  baseBackgroundColor?: string,
): LineSegment[] {
  const highlighted = highlightCodeLineWithHighlightJs(line, language, baseBackgroundColor);
  if (highlighted) return highlighted;

  const lang = normalizeLanguageName(language) ?? "";

  if (lang === "python") {
    return highlightPythonStructured(line, baseBackgroundColor)
      ?? highlightPythonGeneric(line, baseBackgroundColor);
  }

  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "typescript", "javascript"].includes(lang)) {
    return highlightJsStructured(line, baseBackgroundColor)
      ?? highlightJsGeneric(line, baseBackgroundColor);
  }

  if (["bash", "sh", "zsh", "shell"].includes(lang)) {
    return highlightShellGeneric(line, baseBackgroundColor);
  }

  if (lang === "json") {
    return tokenizeWithRegex(line, JSON_TOKEN_RE, (token) => {
      if (token.startsWith("\"")) return makeSegment(token, "yellow", baseBackgroundColor);
      if (/^-?\d/.test(token)) return makeSegment(token, "cyan", baseBackgroundColor);
      return makeSegment(token, "magenta", baseBackgroundColor, true);
    }, "white");
  }

  if (["yaml", "yml"].includes(lang)) {
    return tokenizeWithRegex(line, YAML_TOKEN_RE, (token) => {
      if (token.startsWith("#")) return makeSegment(token, "gray", baseBackgroundColor);
      if (token.startsWith("\"") || token.startsWith("'")) return makeSegment(token, "yellow", baseBackgroundColor);
      if (token.trimEnd().endsWith(":")) return makeSegment(token, "blue", baseBackgroundColor, true);
      if (/^-?\d/.test(token)) return makeSegment(token, "cyan", baseBackgroundColor);
      return makeSegment(token, "magenta", baseBackgroundColor, true);
    }, "white");
  }

  return [makeSegment(line, "white", baseBackgroundColor)];
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const wrapped = wrapAnsi(text, width, { hard: true, trim: false });
  return wrapped.split("\n");
}

function classifyTextLine(
  rawLine: string,
  defaultColor: string,
  inToolBlock: boolean,
): {
  bodyColor: string;
  bodyBold?: boolean;
  startsToolBlock?: boolean;
  endsToolBlock?: boolean;
} {
  const trimmed = rawLine.trimStart();
  const isToolInvocation = /^> /.test(trimmed);
  const isToolSummaryHeader = trimmed === "Explored";
  const isToolSummaryLine = /^[├└│]/.test(trimmed);

  if (isToolInvocation) {
    return { bodyColor: "gray", bodyBold: false, startsToolBlock: true };
  }

  if (isToolSummaryHeader) {
    return { bodyColor: "grayBright", bodyBold: true, startsToolBlock: true };
  }

  if (inToolBlock) {
    if (trimmed.length === 0) {
      return { bodyColor: defaultColor, bodyBold: false, endsToolBlock: true };
    }
    if (isToolSummaryLine) {
      return { bodyColor: "gray", bodyBold: false, startsToolBlock: true };
    }
    return { bodyColor: "gray", bodyBold: false, startsToolBlock: true };
  }

  if (/^\d+\s+[|:]/.test(trimmed) || /^\[\+?\-?\d+\]/.test(trimmed)) {
    return { bodyColor: "gray", bodyBold: false };
  }

  return {
    bodyColor: defaultColor,
    bodyBold: false,
  };
}

type PushFlatLine = (line: Omit<FlatLine, "key" | "label" | "speakerColor">) => void;

interface ParsedDiffLine {
  raw: string;
  kind: "summary" | "meta" | "context" | "add" | "remove";
  gutter?: string;
  gutterColor?: string;
  filePath: string | null;
}

interface IntralineRange {
  start: number;
  end: number;
  backgroundColor: string;
}

function parseDiffLineKind(rawLine: string): ParsedDiffLine["kind"] {
  const trimmed = rawLine.trimStart();
  if (/^(Edited|Updated|Added|Deleted)\b/.test(trimmed) || /^\*\*\* (Update|Add|Delete|Move to):/.test(trimmed)) {
    return "summary";
  }
  if (/^(diff --git|index\b|--- |\+\+\+ |@@)/.test(trimmed)) {
    return "meta";
  }
  if (rawLine.startsWith("+") && !rawLine.startsWith("+++ ")) return "add";
  if (rawLine.startsWith("-") && !rawLine.startsWith("--- ")) return "remove";
  return "context";
}

function parseDiffLines(block: DiffBlock): ParsedDiffLine[] {
  const parsed: ParsedDiffLine[] = [];
  let ctx: DiffContext = {
    filePath: block.filePath,
    oldLine: null,
    newLine: null,
  };
  for (const rawLine of block.lines) {
    const display = diffDisplayForLine(rawLine, ctx);
    parsed.push({
      raw: rawLine,
      kind: parseDiffLineKind(rawLine),
      gutter: display.gutter,
      gutterColor: display.gutterColor,
      filePath: ctx.filePath,
    });
    ctx = nextDiffContext(ctx, rawLine);
  }
  return parsed;
}

function computeChangedRanges(before: string, after: string): {
  beforeRange: IntralineRange | null;
  afterRange: IntralineRange | null;
} {
  if (before === after) {
    return { beforeRange: null, afterRange: null };
  }

  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > prefix
    && afterEnd > prefix
    && before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return {
    beforeRange: {
      start: prefix,
      end: beforeEnd,
      backgroundColor: "red",
    },
    afterRange: {
      start: prefix,
      end: afterEnd,
      backgroundColor: "green",
    },
  };
}

function buildIntralineHighlights(lines: ParsedDiffLine[]): Map<number, IntralineRange> {
  const highlights = new Map<number, IntralineRange>();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.kind !== "remove") continue;

    const removeIndexes: number[] = [];
    let j = i;
    while (lines[j]?.kind === "remove") {
      removeIndexes.push(j);
      j += 1;
    }

    const addIndexes: number[] = [];
    while (lines[j]?.kind === "add") {
      addIndexes.push(j);
      j += 1;
    }

    const pairCount = Math.min(removeIndexes.length, addIndexes.length);
    for (let k = 0; k < pairCount; k++) {
      const removeIndex = removeIndexes[k]!;
      const addIndex = addIndexes[k]!;
      const removeLine = lines[removeIndex]!.raw.slice(1);
      const addLine = lines[addIndex]!.raw.slice(1);
      const { beforeRange, afterRange } = computeChangedRanges(removeLine, addLine);
      if (beforeRange && beforeRange.start < beforeRange.end) {
        highlights.set(removeIndex, beforeRange);
      }
      if (afterRange && afterRange.start < afterRange.end) {
        highlights.set(addIndex, afterRange);
      }
    }

    i = j - 1;
  }

  return highlights;
}

function applyIntralineBackground(
  segments: LineSegment[],
  range: IntralineRange | null,
): LineSegment[] {
  if (!range || range.start >= range.end) return segments;

  const result: LineSegment[] = [];
  let offset = 0;

  for (const segment of segments) {
    const segmentStart = offset;
    const segmentEnd = offset + segment.text.length;

    if (range.end <= segmentStart || range.start >= segmentEnd) {
      result.push(segment);
      offset = segmentEnd;
      continue;
    }

    const localStart = Math.max(0, range.start - segmentStart);
    const localEnd = Math.min(segment.text.length, range.end - segmentStart);

    if (localStart > 0) {
      result.push({ ...segment, text: segment.text.slice(0, localStart) });
    }
    if (localEnd > localStart) {
      result.push({
        ...segment,
        text: segment.text.slice(localStart, localEnd),
        backgroundColor: range.backgroundColor,
      });
    }
    if (localEnd < segment.text.length) {
      result.push({ ...segment, text: segment.text.slice(localEnd) });
    }

    offset = segmentEnd;
  }

  return result.filter((segment) => segment.text.length > 0);
}

function sliceRangeForWrappedLine(
  range: IntralineRange | null,
  start: number,
  length: number,
): IntralineRange | null {
  if (!range) return null;
  const wrappedEnd = start + length;
  const sliceStart = Math.max(range.start, start);
  const sliceEnd = Math.min(range.end, wrappedEnd);
  if (sliceEnd <= sliceStart) return null;
  return {
    start: sliceStart - start,
    end: sliceEnd - start,
    backgroundColor: range.backgroundColor,
  };
}

function renderTextBlock(
  block: TextBlock,
  options: {
    textWidth: number;
    labelWidth: number;
    defaultColor: string;
    pushLine: PushFlatLine;
  },
): void {
  const { textWidth, labelWidth, defaultColor, pushLine } = options;
  let inToolBlock = false;

  for (const rawLine of block.lines) {
    const {
      bodyColor,
      bodyBold,
      startsToolBlock,
      endsToolBlock,
    } = classifyTextLine(rawLine, defaultColor, inToolBlock);
    const contentWidth = Math.max(4, textWidth - labelWidth);
    const wrapped = wrapText(rawLine, contentWidth);

    for (const wrappedLine of wrapped) {
      pushLine({
        text: wrappedLine,
        bodyColor,
        bodyBold,
      });
    }

    if (startsToolBlock) {
      inToolBlock = true;
    } else if (endsToolBlock) {
      inToolBlock = false;
    }
  }
}

function renderCodeBlock(
  block: CodeBlock,
  options: {
    textWidth: number;
    labelWidth: number;
    pushLine: PushFlatLine;
  },
): void {
  const { textWidth, labelWidth, pushLine } = options;
  if (block.header) {
    pushLine({
      text: "",
      segments: snippetHeaderSegments(block.header, block.language),
      bodyColor: "white",
      bodyBackgroundColor: CODE_BACKGROUND_COLOR,
      bodyBold: true,
    });
  } else {
    pushLine({
      text: "",
      segments: [{
        text: block.language ?? "code",
        color: "yellow",
        backgroundColor: CODE_BACKGROUND_COLOR,
      }],
      bodyColor: "white",
      bodyBackgroundColor: CODE_BACKGROUND_COLOR,
    });
  }

  for (let blank = 0; blank < block.leadingBlankLines; blank++) {
    pushLine({
      text: "",
      bodyColor: "white",
      bodyBackgroundColor: CODE_BACKGROUND_COLOR,
    });
  }

  let nextLine = block.header?.startLine ?? null;
  for (const rawLine of block.lines) {
    const codeGutter = formatCodeGutter(nextLine);
    const gutterWidth = codeGutter ? stringWidth(codeGutter) : 0;
    const contentWidth = Math.max(4, textWidth - labelWidth - gutterWidth);
    const wrapped = wrapText(rawLine, contentWidth);

    for (let index = 0; index < wrapped.length; index++) {
      pushLine({
        gutter: index === 0
          ? codeGutter
          : codeGutter
            ? formatCodeContinuationGutter()
            : undefined,
        gutterColor: "gray",
        gutterBackgroundColor: CODE_BACKGROUND_COLOR,
        text: wrapped[index]!,
        segments: highlightCodeLine(wrapped[index]!, block.language, CODE_BACKGROUND_COLOR),
        bodyColor: "white",
        bodyBackgroundColor: CODE_BACKGROUND_COLOR,
      });
    }

    if (nextLine != null) nextLine += 1;
  }
}

function renderDiffBlock(
  block: DiffBlock,
  options: {
    textWidth: number;
    labelWidth: number;
    pushLine: PushFlatLine;
  },
): void {
  const { textWidth, labelWidth, pushLine } = options;
  const parsedLines = parseDiffLines(block);
  const intralineHighlights = buildIntralineHighlights(parsedLines);

  for (let index = 0; index < parsedLines.length; index++) {
    const line = parsedLines[index]!;
    const lineLanguage = line.filePath ? fallbackLanguageFromPath(line.filePath) : block.language;

    if (line.kind === "summary" || line.kind === "meta") {
      const gutterWidth = line.gutter ? stringWidth(line.gutter) : 0;
      const contentWidth = Math.max(4, textWidth - labelWidth - gutterWidth);
      const wrapped = wrapText(line.raw, contentWidth);
      const bodyColor = line.kind === "summary" ? "cyanBright" : "yellow";
      for (let wrappedIndex = 0; wrappedIndex < wrapped.length; wrappedIndex++) {
        pushLine({
          gutter: wrappedIndex === 0
            ? line.gutter
            : line.gutter
              ? formatDiffContinuationGutter(line.kind)
              : undefined,
          gutterColor: line.gutterColor,
          gutterBackgroundColor: DIFF_HEADER_BACKGROUND_COLOR,
          text: wrapped[wrappedIndex]!,
          bodyColor,
          bodyBold: true,
          bodyBackgroundColor: DIFF_HEADER_BACKGROUND_COLOR,
        });
      }
      continue;
    }

    const code = line.raw.slice(1);
    const gutterWidth = line.gutter ? stringWidth(line.gutter) : 0;
    const contentWidth = Math.max(4, textWidth - labelWidth - gutterWidth);
    const wrapped = wrapText(code, contentWidth);
    const rowBackgroundColor = DIFF_BACKGROUND_COLOR;
    const gutterBackgroundColor = line.kind === "add"
      ? "green"
      : line.kind === "remove"
        ? "red"
        : DIFF_HEADER_BACKGROUND_COLOR;
    const intralineRange = intralineHighlights.get(index) ?? null;
    let wrappedOffset = 0;

    for (let wrappedIndex = 0; wrappedIndex < wrapped.length; wrappedIndex++) {
      let segments = highlightCodeLine(
        wrapped[wrappedIndex]!,
        lineLanguage,
        rowBackgroundColor,
      );
      segments = applyIntralineBackground(
        segments,
        sliceRangeForWrappedLine(
          intralineRange,
          wrappedOffset,
          wrapped[wrappedIndex]!.length,
        ),
      );

      pushLine({
        gutter: wrappedIndex === 0
          ? line.gutter
          : line.gutter
            ? formatDiffContinuationGutter(line.kind)
            : undefined,
        gutterColor: line.gutterColor,
        gutterBackgroundColor,
        text: wrapped[wrappedIndex]!,
        segments,
        bodyColor: line.kind === "add"
          ? "green"
          : line.kind === "remove"
            ? "red"
            : "white",
        bodyBackgroundColor: rowBackgroundColor,
      });

      wrappedOffset += wrapped[wrappedIndex]!.length;
    }
  }
}

export function preRenderLines(entries: Entry[], textWidth: number): FlatLine[] {
  const lines: FlatLine[] = [];

  for (let ei = 0; ei < entries.length; ei++) {
    const entry = entries[ei]!;
    const s = entry.speaker.toLowerCase();
    const label = SPEAKER_LABELS[s] ?? `[${entry.speaker}] `;
    const color = SPEAKER_COLORS[s] ?? "white";
    const body = SPEAKER_BODY_COLORS[s] ?? "white";
    const labelWidth = stringWidth(label);
    const indent = " ".repeat(labelWidth);
    let visualLineIndex = 0;

    const pushLine: PushFlatLine = (line) => {
      lines.push({
        key: `${ei}-${visualLineIndex}`,
        label: visualLineIndex === 0 ? label : indent,
        speakerColor: color,
        ...line,
      });
      visualLineIndex += 1;
    };

    const blocks = entry.blocks && entry.blocks.length > 0
      ? entry.blocks
      : parseRenderBlocks(entry.text);

    for (const block of blocks) {
      if (block.type === "text") {
        renderTextBlock(block, {
          textWidth,
          labelWidth,
          defaultColor: body,
          pushLine,
        });
      } else if (block.type === "code") {
        renderCodeBlock(block, {
          textWidth,
          labelWidth,
          pushLine,
        });
      } else {
        renderDiffBlock(block, {
          textWidth,
          labelWidth,
          pushLine,
        });
      }
    }
  }

  return lines;
}
