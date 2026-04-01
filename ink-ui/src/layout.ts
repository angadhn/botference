import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

// Layout budget constants — derived from Ink's rendered chrome.
// INPUT_CHROME: label(1) + top inset(1) + hint(1) + field spacing(2) = 5
// PANE_CHROME:  border(2) + title(1) = 3
// STATUS_HEIGHT: 1
const INPUT_CHROME = 5;
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

interface Entry {
  speaker: string;
  text: string;
}

interface DiffContext {
  filePath: string | null;
  oldLine: number | null;
  newLine: number | null;
}

const DIFF_GUTTER_WIDTH = 11;
const CODE_GUTTER_WIDTH = 6;
const CODE_BACKGROUND_COLOR = "blackBright";
const SNIPPET_HEADER_RE = /^['`"]?([^'"`]+?\.[A-Za-z0-9_.-]+)['`"]?\s+lines?\s+(\d+)(?:-(\d+))?:?\s*$/;

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

function formatDiffGutter(
  kind: "add" | "remove" | "context" | "continuation",
  oldLine: number | null,
  newLine: number | null,
): string {
  if (kind === "continuation") return " ".repeat(DIFF_GUTTER_WIDTH);
  const marker = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
  return `${formatDiffLineNumber(oldLine)} ${formatDiffLineNumber(newLine)} ${marker} `;
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

function normalizeFenceLanguage(rawFence: string, header: SnippetHeader | null): string | null {
  const trimmed = rawFence.trim();
  const match = /^```([\w.+-]+)?/.exec(trimmed);
  const explicit = match?.[1]?.toLowerCase() ?? null;
  return explicit || (header ? fallbackLanguageFromPath(header.filePath) : null);
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

function highlightCodeLine(
  line: string,
  language: string | null,
): LineSegment[] {
  const lang = language?.toLowerCase() ?? "";

  if (lang === "python") {
    return tokenizeWithRegex(line, PYTHON_TOKEN_RE, (token) => {
      if (token.startsWith("@")) return { color: "cyan", bold: true, backgroundColor: CODE_BACKGROUND_COLOR };
      if (token === "self") return { color: "white", backgroundColor: CODE_BACKGROUND_COLOR };
      if (token.startsWith("\"") || token.startsWith("'")) return { color: "yellow" };
      if (token.startsWith("#")) return { color: "gray" };
      if (/^\d/.test(token)) return { color: "cyan" };
      if (PYTHON_KEYWORDS.has(token)) return { color: "magenta", bold: true, backgroundColor: CODE_BACKGROUND_COLOR };
      return { color: "green", backgroundColor: CODE_BACKGROUND_COLOR };
    }, "white");
  }

  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "typescript", "javascript"].includes(lang)) {
    return tokenizeWithRegex(line, JS_TOKEN_RE, (token) => {
      if (token.startsWith("//")) return { color: "gray", backgroundColor: CODE_BACKGROUND_COLOR };
      if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) return { color: "yellow", backgroundColor: CODE_BACKGROUND_COLOR };
      if (/^\d/.test(token)) return { color: "cyan", backgroundColor: CODE_BACKGROUND_COLOR };
      if (JS_KEYWORDS.has(token)) return { color: "magenta", bold: true, backgroundColor: CODE_BACKGROUND_COLOR };
      return { color: "blue", backgroundColor: CODE_BACKGROUND_COLOR };
    }, "white");
  }

  if (["bash", "sh", "zsh", "shell"].includes(lang)) {
    return tokenizeWithRegex(line, SHELL_TOKEN_RE, (token) => {
      const trimmed = token.trimStart();
      if (trimmed.startsWith("#")) return { color: "gray", backgroundColor: CODE_BACKGROUND_COLOR };
      if (trimmed.startsWith("\"") || trimmed.startsWith("'")) return { color: "yellow", backgroundColor: CODE_BACKGROUND_COLOR };
      if (trimmed.startsWith("-")) return { color: "cyan", bold: true, backgroundColor: CODE_BACKGROUND_COLOR };
      if (/^\d/.test(trimmed)) return { color: "cyan", backgroundColor: CODE_BACKGROUND_COLOR };
      if (SHELL_KEYWORDS.has(trimmed)) return { color: "magenta", bold: true, backgroundColor: CODE_BACKGROUND_COLOR };
      return { color: "green", backgroundColor: CODE_BACKGROUND_COLOR };
    }, "white");
  }

  if (lang === "json") {
    return tokenizeWithRegex(line, JSON_TOKEN_RE, (token) => {
      if (token.startsWith("\"")) return { color: "yellow", backgroundColor: CODE_BACKGROUND_COLOR };
      if (/^-?\d/.test(token)) return { color: "cyan", backgroundColor: CODE_BACKGROUND_COLOR };
      return { color: "magenta", bold: true, backgroundColor: CODE_BACKGROUND_COLOR };
    }, "white");
  }

  if (["yaml", "yml"].includes(lang)) {
    return tokenizeWithRegex(line, YAML_TOKEN_RE, (token) => {
      if (token.startsWith("#")) return { color: "gray", backgroundColor: CODE_BACKGROUND_COLOR };
      if (token.startsWith("\"") || token.startsWith("'")) return { color: "yellow", backgroundColor: CODE_BACKGROUND_COLOR };
      if (token.trimEnd().endsWith(":")) return { color: "blue", bold: true, backgroundColor: CODE_BACKGROUND_COLOR };
      if (/^-?\d/.test(token)) return { color: "cyan", backgroundColor: CODE_BACKGROUND_COLOR };
      return { color: "magenta", bold: true, backgroundColor: CODE_BACKGROUND_COLOR };
    }, "white");
  }

  return [{ text: line, color: "white", backgroundColor: CODE_BACKGROUND_COLOR }];
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const wrapped = wrapAnsi(text, width, { hard: true, trim: false });
  return wrapped.split("\n");
}

function classifyEntryLine(
  rawLine: string,
  defaultColor: string,
  inCodeFence: boolean,
  inDiffBlock: boolean,
  inToolBlock: boolean,
): {
  bodyColor: string;
  bodyBold?: boolean;
  startsDiffBlock?: boolean;
  endsDiffBlock?: boolean;
  startsToolBlock?: boolean;
  endsToolBlock?: boolean;
} {
  const trimmed = rawLine.trimStart();
  const isPatchSummary = /^(Edited|Updated|Added|Deleted)\b/.test(trimmed);
  const isPatchHeader = /^\*\*\* (Update|Add|Delete|Move to):/.test(trimmed);
  const isDiffFence = /^```(?:diff|patch)?\s*$/i.test(trimmed);
  const isFence = /^```/.test(trimmed);
  const isDiffMeta = /^(diff --git|index\b|--- |\+\+\+ |@@)/.test(trimmed);
  const isDiffLine = /^[+-]/.test(rawLine) && !/^(--- |\+\+\+ )/.test(rawLine);
  const isToolInvocation = /^> /.test(trimmed);

  if (isFence) {
    return {
      bodyColor: "gray",
      bodyBold: false,
      startsDiffBlock: isDiffFence,
      endsDiffBlock: inCodeFence,
    };
  }

  if (isPatchSummary || isPatchHeader) {
    return {
      bodyColor: "cyanBright",
      bodyBold: true,
      startsDiffBlock: true,
      endsToolBlock: inToolBlock,
    };
  }

  if (isToolInvocation) {
    return { bodyColor: "gray", bodyBold: false, startsToolBlock: true };
  }

  if (inToolBlock) {
    if (trimmed.length === 0) {
      return { bodyColor: defaultColor, bodyBold: false, endsToolBlock: true };
    }
    return { bodyColor: "gray", bodyBold: false, startsToolBlock: true };
  }

  if (isDiffMeta && (inDiffBlock || /^@@/.test(trimmed) || /^(diff --git|--- |\+\+\+ )/.test(trimmed))) {
    return {
      bodyColor: "yellow",
      bodyBold: true,
      startsDiffBlock: true,
    };
  }

  if (inDiffBlock && isDiffLine && /^\+/.test(rawLine)) {
    return { bodyColor: "green", bodyBold: false, startsDiffBlock: true };
  }

  if (inDiffBlock && isDiffLine && /^-/.test(rawLine)) {
    return { bodyColor: "red", bodyBold: false, startsDiffBlock: true };
  }

  if (/^\d+\s+[|:]/.test(trimmed) || /^\[\+?\-?\d+\]/.test(trimmed)) {
    return { bodyColor: "gray", bodyBold: false };
  }

  if (inCodeFence) {
    return { bodyColor: defaultColor, bodyBold: false };
  }

  return {
    bodyColor: defaultColor,
    bodyBold: false,
    endsDiffBlock: inDiffBlock,
  };
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
    const rawLines = entry.text.split("\n");
    let inCodeFence = false;
    let inDiffBlock = false;
    let inToolBlock = false;
    let visualLineIndex = 0;
    let recentSnippetHeader: SnippetHeader | null = null;
    let codeCtx: CodeContext = {
      language: null,
      nextLine: null,
      activeHeader: null,
    };
    let diffCtx: DiffContext = {
      filePath: null,
      oldLine: null,
      newLine: null,
    };

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trimStart();
      const snippetHeader = !inCodeFence ? parseSnippetHeader(rawLine) : null;
      const wasInCodeFence = inCodeFence;
      const isFenceLine = /^```/.test(trimmed);

      if (!inCodeFence && snippetHeader) {
        recentSnippetHeader = snippetHeader;
        lines.push({
          key: `${ei}-${visualLineIndex}`,
          label: visualLineIndex === 0 ? label : indent,
          text: "",
          segments: snippetHeaderSegments(
            snippetHeader,
            fallbackLanguageFromPath(snippetHeader.filePath),
          ),
          speakerColor: color,
          bodyColor: "white",
          bodyBackgroundColor: CODE_BACKGROUND_COLOR,
          bodyBold: true,
        });
        visualLineIndex += 1;
        continue;
      }

      if (!inCodeFence && isFenceLine) {
        inCodeFence = true;
        codeCtx = {
          language: normalizeFenceLanguage(rawLine, recentSnippetHeader),
          nextLine: recentSnippetHeader?.startLine ?? null,
          activeHeader: recentSnippetHeader,
        };
        if (!recentSnippetHeader) {
          lines.push({
            key: `${ei}-${visualLineIndex}`,
            label: visualLineIndex === 0 ? label : indent,
            text: "",
            segments: [{
              text: codeCtx.language ?? "code",
              color: "yellow",
              bold: false,
              backgroundColor: CODE_BACKGROUND_COLOR,
            }],
            speakerColor: color,
            bodyColor: "white",
            bodyBackgroundColor: CODE_BACKGROUND_COLOR,
          });
          visualLineIndex += 1;
        }
        recentSnippetHeader = null;
        continue;
      }

      if (inCodeFence && isFenceLine) {
        inCodeFence = false;
        inDiffBlock = false;
        codeCtx = { language: null, nextLine: null, activeHeader: null };
        continue;
      }

      const {
        bodyColor,
        bodyBold,
        startsDiffBlock,
        endsDiffBlock,
        startsToolBlock,
        endsToolBlock,
      } = classifyEntryLine(rawLine, body, inCodeFence, inDiffBlock, inToolBlock);
      const diffDisplay = diffDisplayForLine(rawLine, diffCtx);
      const codeGutter = inCodeFence ? formatCodeGutter(codeCtx.nextLine) : undefined;
      const gutter = codeGutter ?? diffDisplay.gutter;
      const gutterWidth = gutter ? stringWidth(gutter) : 0;
      const contentWidth = Math.max(4, textWidth - labelWidth - gutterWidth);
      const wrapped = wrapText(rawLine, contentWidth);

      for (let li = 0; li < wrapped.length; li++) {
        const codeSegments = inCodeFence ? highlightCodeLine(wrapped[li]!, codeCtx.language) : undefined;
        lines.push({
          key: `${ei}-${visualLineIndex}`,
          label: visualLineIndex === 0 ? label : indent,
          gutter: li === 0
            ? gutter
            : codeGutter
              ? " ".repeat(CODE_GUTTER_WIDTH)
              : gutter
                ? formatDiffGutter("continuation", null, null)
                : undefined,
          gutterColor: codeGutter ? "gray" : diffDisplay.gutterColor,
          gutterBackgroundColor: codeGutter ? CODE_BACKGROUND_COLOR : undefined,
          text: wrapped[li]!,
          segments: codeSegments,
          speakerColor: color,
          bodyColor: inCodeFence ? "white" : bodyColor,
          bodyBackgroundColor: inCodeFence ? CODE_BACKGROUND_COLOR : undefined,
          bodyBold: inCodeFence ? false : bodyBold,
        });
        visualLineIndex += 1;
      }

      if (inCodeFence) {
        codeCtx = {
          ...codeCtx,
          nextLine: codeCtx.nextLine == null ? null : codeCtx.nextLine + 1,
        };
      } else if (startsDiffBlock) {
        inDiffBlock = true;
      } else if (endsDiffBlock) {
        inDiffBlock = false;
        recentSnippetHeader = null;
      } else if (trimmed.length > 0) {
        recentSnippetHeader = null;
      }

      if (startsToolBlock) {
        inToolBlock = true;
      } else if (endsToolBlock) {
        inToolBlock = false;
      }

      diffCtx = nextDiffContext(diffCtx, rawLine);
    }
  }
  return lines;
}
