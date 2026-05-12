import stringWidth from "string-width";
import { computeViewportSlice, type FlatLine, type LineSegment } from "../layout.js";

export type PaneName = "room" | "caucus";

export interface PaneSelection {
  pane: PaneName;
  anchorLine: number;
  anchorCol: number;
  focusLine: number;
  focusCol: number;
  dragging: boolean;
}

export interface PaneHit {
  pane: PaneName;
  lineIndex: number;
  col: number;
}

export interface PaneHitTestInput {
  x: number;
  y: number;
}

export interface PaneHitTestConfig {
  paneContentHeight: number;
  leftPaneWidth: number;
  leftTextWidth: number;
  rightTextWidth: number;
  roomFlatLines: FlatLine[];
  caucusFlatLines: FlatLine[];
  roomScrollOffset: number;
  caucusScrollOffset: number;
  contentTop?: number;
  horizontalPadding?: number;
}

export function normalizedSelection(selection: PaneSelection | null): {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
} | null {
  if (!selection) return null;
  const before = (
    selection.anchorLine < selection.focusLine
    || (
      selection.anchorLine === selection.focusLine
      && selection.anchorCol <= selection.focusCol
    )
  );
  return before
    ? {
      startLine: selection.anchorLine,
      startCol: selection.anchorCol,
      endLine: selection.focusLine,
      endCol: selection.focusCol,
    }
    : {
      startLine: selection.focusLine,
      startCol: selection.focusCol,
      endLine: selection.anchorLine,
      endCol: selection.anchorCol,
    };
}

export function selectionRangeForLine(
  selection: PaneSelection | null,
  pane: PaneName,
  lineIndex: number,
  lineText: string,
): { start: number; end: number } | null {
  if (!selection || selection.pane !== pane) return null;
  const normalized = normalizedSelection(selection);
  if (!normalized) return null;
  if (lineIndex < normalized.startLine || lineIndex > normalized.endLine) return null;

  const lineLength = lineText.length;
  const start = lineIndex === normalized.startLine
    ? Math.max(0, Math.min(lineLength, normalized.startCol))
    : 0;
  const end = lineIndex === normalized.endLine
    ? Math.max(0, Math.min(lineLength, normalized.endCol + 1))
    : lineLength;
  if (end <= start) return null;
  return { start, end };
}

export function applySelectionHighlight(
  line: FlatLine,
  selection: PaneSelection | null,
  pane: PaneName,
  lineIndex: number,
): LineSegment[] | undefined {
  const range = selectionRangeForLine(selection, pane, lineIndex, line.text);
  if (!range) return line.segments;
  const source = line.segments ?? [{ text: line.text, color: line.bodyColor }];
  const highlighted: LineSegment[] = [];
  let offset = 0;

  for (const segment of source) {
    const segmentStart = offset;
    const segmentEnd = offset + segment.text.length;
    offset = segmentEnd;

    if (range.end <= segmentStart || range.start >= segmentEnd) {
      highlighted.push(segment);
      continue;
    }

    const localStart = Math.max(0, range.start - segmentStart);
    const localEnd = Math.min(segment.text.length, range.end - segmentStart);
    if (localStart > 0) {
      highlighted.push({ ...segment, text: segment.text.slice(0, localStart) });
    }
    if (localEnd > localStart) {
      highlighted.push({
        ...segment,
        text: segment.text.slice(localStart, localEnd),
        backgroundColor: "blue",
        color: "white",
      });
    }
    if (localEnd < segment.text.length) {
      highlighted.push({ ...segment, text: segment.text.slice(localEnd) });
    }
  }

  return highlighted;
}

export function selectedTextFromLines(
  lines: FlatLine[],
  selection: PaneSelection | null,
): string {
  if (!selection) return "";
  const normalized = normalizedSelection(selection);
  if (!normalized) return "";
  const selected: string[] = [];
  for (let index = normalized.startLine; index <= normalized.endLine; index++) {
    const line = lines[index];
    if (!line) continue;
    const range = selectionRangeForLine(selection, selection.pane, index, line.text);
    if (!range) continue;
    selected.push(line.text.slice(range.start, range.end).trimEnd());
  }
  return selected.join("\n").trim();
}

export function hitTestPane(
  event: PaneHitTestInput,
  config: PaneHitTestConfig,
): PaneHit | null {
  const contentTop = config.contentTop ?? 2;
  const horizontalPadding = config.horizontalPadding ?? 2;
  const contentBottom = contentTop + config.paneContentHeight - 1;
  if (event.y < contentTop || event.y > contentBottom) return null;

  const pane = event.x < config.leftPaneWidth ? "room" : "caucus";
  const paneLeft = pane === "room" ? 0 : config.leftPaneWidth;
  const textWidth = pane === "room" ? config.leftTextWidth : config.rightTextWidth;
  const contentLeft = paneLeft + horizontalPadding;
  const contentRight = contentLeft + textWidth - 1;
  if (event.x < contentLeft || event.x > contentRight) return null;

  const flatLines = pane === "room" ? config.roomFlatLines : config.caucusFlatLines;
  const scrollOffset = pane === "room" ? config.roomScrollOffset : config.caucusScrollOffset;
  const { startIdx, endIdx } = computeViewportSlice(
    flatLines.length,
    config.paneContentHeight,
    scrollOffset,
  );
  const visibleRow = event.y - contentTop;
  const lineIndex = startIdx + visibleRow;
  if (lineIndex < startIdx || lineIndex >= endIdx || !flatLines[lineIndex]) return null;

  const line = flatLines[lineIndex]!;
  const bodyStart = stringWidth(line.label) + stringWidth(line.gutter ?? "");
  const col = Math.max(0, Math.min(
    line.text.length,
    event.x - contentLeft - bodyStart,
  ));
  return { pane, lineIndex, col };
}

