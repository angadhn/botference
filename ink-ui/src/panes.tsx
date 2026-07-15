// Render-path components for the transcript pane and the busy spinner.
//
// These live in their own module (not App.tsx) for two reasons:
// - App.tsx imports ./index.js, which has module-level side effects (terminal
//   mode writes, stdin piping, render()). Components here can be imported by
//   node:test without launching the TUI.
// - The busy spinner's frame tick is deliberately isolated in <BusyLine> so a
//   70–150ms animation frame re-renders O(1) nodes instead of the whole app
//   tree. Before this split, every tick re-rendered ~130 components and — with
//   the root Box at full terminal height — forced Ink down its fullscreen
//   clearTerminal path: a full clear + repaint of the screen ~14×/s, which is
//   what made streaming turns flicker.
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import {
  computeViewportSlice,
  truncateTitle,
  type FlatLine,
} from "./layout.js";
import {
  applySelectionHighlight,
  type PaneName,
  type PaneSelection,
} from "./v2/selection.js";
import { v2ActivityGlyph } from "./v2/activity.js";

export const THEME = {
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

// ── Busy spinner ───────────────────────────────────────────

export type BusySegment = { text: string; color: string; bold?: boolean };

// 150ms reads as a calm shimmer; the old 70ms (~14fps) animated faster than
// anyone can perceive on a status line and doubled the render rate for nothing.
export const BUSY_FRAME_INTERVAL_MS = 150;

export function buildBusySegments(text: string, frameIndex: number): BusySegment[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [{ text: "", color: THEME.textMuted }];

  const cyclePadding = 10;
  const cycleLength = chars.length + cyclePadding * 2;
  const glimmerIndex = (frameIndex % cycleLength) - cyclePadding;

  const segments: BusySegment[] = [];
  for (let index = 0; index < chars.length; index++) {
    const distance = Math.abs(index - glimmerIndex);
    let color = THEME.textMuted;
    let bold = false;
    if (distance === 0) {
      color = "white";
      bold = true;
    } else if (distance <= 1) {
      color = "grayBright";
    }
    const previous = segments[segments.length - 1];
    // Coalesce adjacent same-style characters into one segment so the busy
    // line renders a handful of <Text> nodes instead of one per character.
    if (previous && previous.color === color && (previous.bold ?? false) === bold) {
      previous.text += chars[index]!;
    } else {
      segments.push(bold ? { text: chars[index]!, color, bold } : { text: chars[index]!, color });
    }
  }
  return segments;
}

/**
 * The animated "bot is busy" line. Owns its own frame-index state and interval
 * so each animation tick re-renders only this component — never the app tree.
 * Mount it while busy; unmounting stops the timer and resets the frame.
 */
export function BusyLine({
  text,
  frameIntervalMs = BUSY_FRAME_INTERVAL_MS,
}: {
  text: string;
  frameIntervalMs?: number;
}) {
  const [frameIndex, setFrameIndex] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => prev + 1);
    }, frameIntervalMs);
    return () => clearInterval(interval);
  }, [frameIntervalMs]);

  const segments = buildBusySegments(text, frameIndex);
  return (
    <Text>
      <Text color={THEME.accentBright}>{v2ActivityGlyph(frameIndex)} </Text>
      {segments.map((segment, index) => (
        <Text key={`busy-${index}`} color={segment.color} bold={segment.bold}>
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

// ── Transcript pane ────────────────────────────────────────

// Test hook: total PaneRow render count. Lets tests assert that unchanged
// transcript rows are NOT re-rendered by spinner ticks or streaming flushes.
export const paneRowRenderCounter = { count: 0 };

interface PaneRowProps {
  line: FlatLine;
  lineIndex: number;
  pane: PaneName;
  dimmed: boolean;
  selection: PaneSelection | null;
}

function PaneRowImpl({ line, lineIndex, pane, dimmed, selection }: PaneRowProps) {
  paneRowRenderCounter.count += 1;
  const selectedSegments = applySelectionHighlight(line, selection, pane, lineIndex);
  return (
    <Box width="100%">
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
}

// FlatLine objects are cached per entry (layout.ts entryFlatLineCache), so an
// unchanged transcript entry yields the IDENTICAL line object across renders —
// reference equality is a correct and cheap "did this row change" test. The
// lineIndex prop shifts on every append while auto-scrolled, but it only
// matters to selection highlighting, so it is ignored while no selection is
// active; without that, streaming would still re-render every visible row.
const paneRowPropsEqual = (prev: PaneRowProps, next: PaneRowProps): boolean => (
  prev.line === next.line
  && prev.pane === next.pane
  && prev.dimmed === next.dimmed
  && prev.selection === next.selection
  && (next.selection === null || prev.lineIndex === next.lineIndex)
);

const PaneRow = React.memo(PaneRowImpl, paneRowPropsEqual);

function PaneImpl({
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
      {visibleLines.map((line, visibleIndex) => (
        <PaneRow
          key={line.key}
          line={line}
          lineIndex={startIdx + visibleIndex}
          pane={pane}
          dimmed={dimmed}
          selection={selection}
        />
      ))}
    </Box>
  );
}

// Memoized so app-level re-renders that don't touch the transcript (status
// updates, hints, input typing) skip the pane entirely. flatLines identity
// only changes when the transcript content actually changed.
export const Pane = React.memo(PaneImpl);
