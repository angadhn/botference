import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

// Layout budget constants — derived from Ink's rendered chrome.
// INPUT_CHROME: label(1) + top inset(1) + hint(1) + field spacing(2) = 5
// PANE_CHROME:  border(2) + title(1) = 3
// STATUS_HEIGHT: 1
const INPUT_CHROME = 5;
const STATUS_HEIGHT = 1;
const PANE_CHROME = 3;

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
  const leftTextWidth = Math.max(4, leftPaneWidth - 2);
  const rightTextWidth = Math.max(4, rightPaneWidth - 2);

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
  user: "white",
  claude: "blue",
  codex: "green",
  system: "yellowBright",
  summary: "magentaBright",
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
  text: string;
  speakerColor: string;
  bodyColor: string;
  bodyBold?: boolean;
}

interface Entry {
  speaker: string;
  text: string;
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
): { bodyColor: string; bodyBold?: boolean; startsDiffBlock?: boolean; endsDiffBlock?: boolean } {
  const trimmed = rawLine.trimStart();
  const isPatchSummary = /^(Edited|Updated|Added|Deleted)\b/.test(trimmed);
  const isPatchHeader = /^\*\*\* (Update|Add|Delete|Move to):/.test(trimmed);
  const isDiffFence = /^```(?:diff|patch)?\s*$/i.test(trimmed);
  const isFence = /^```/.test(trimmed);
  const isDiffMeta = /^(diff --git|index\b|--- |\+\+\+ |@@)/.test(trimmed);
  const isDiffLine = /^[+-]/.test(rawLine) && !/^(--- |\+\+\+ )/.test(rawLine);

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
    };
  }

  if (/^> /.test(trimmed)) {
    return { bodyColor: "cyan", bodyBold: true };
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
    const contentWidth = Math.max(4, textWidth - labelWidth);
    const indent = " ".repeat(labelWidth);
    const rawLines = entry.text.split("\n");
    let inCodeFence = false;
    let inDiffBlock = false;
    let visualLineIndex = 0;

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trimStart();
      const wasInCodeFence = inCodeFence;
      const {
        bodyColor,
        bodyBold,
        startsDiffBlock,
        endsDiffBlock,
      } = classifyEntryLine(rawLine, body, inCodeFence, inDiffBlock);
      const wrapped = wrapText(rawLine, contentWidth);

      for (let li = 0; li < wrapped.length; li++) {
        lines.push({
          key: `${ei}-${visualLineIndex}`,
          label: visualLineIndex === 0 ? label : indent,
          text: wrapped[li]!,
          speakerColor: color,
          bodyColor,
          bodyBold,
        });
        visualLineIndex += 1;
      }

      if (/^```/.test(trimmed)) {
        inCodeFence = !inCodeFence;
        if (wasInCodeFence) {
          inDiffBlock = false;
        } else if (startsDiffBlock) {
          inDiffBlock = true;
        }
        continue;
      }

      if (startsDiffBlock) {
        inDiffBlock = true;
      } else if (endsDiffBlock) {
        inDiffBlock = false;
      }
    }
  }
  return lines;
}
