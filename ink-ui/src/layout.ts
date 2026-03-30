import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

// Layout budget constants — derived from Ink's rendered chrome.
// INPUT_CHROME: border(2) + label(1) + hint(1) + gap(1) = 5
// PANE_CHROME:  border(2) + title(1) = 3
// STATUS_HEIGHT: 1
const INPUT_CHROME = 5;
const STATUS_HEIGHT = 1;
const PANE_CHROME = 3;
const MAX_VISIBLE_INPUT_LINES = 3;

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
  inputLineCount: number,
): LayoutBudget {
  // Fixed input height — panes never resize. Text scrolls within the box.
  const inputHeight = INPUT_CHROME + MAX_VISIBLE_INPUT_LINES;
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
    const wrapped = wrapText(entry.text, contentWidth);
    const indent = " ".repeat(labelWidth);

    for (let li = 0; li < wrapped.length; li++) {
      lines.push({
        key: `${ei}-${li}`,
        label: li === 0 ? label : indent,
        text: wrapped[li]!,
        speakerColor: color,
        bodyColor: body,
      });
    }
  }
  return lines;
}
