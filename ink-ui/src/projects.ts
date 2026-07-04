export interface ProjectPanelSessionData {
  session_id: string;
  title: string;
  updated_at: string;
  active: boolean;
}

export interface ProjectPanelProjectData {
  id: string;
  title: string;
  status: string;
  next_action: string;
  active: boolean;
  session_count: number;
  sessions: ProjectPanelSessionData[];
}

export interface ProjectPanelStateData {
  active_project_id: string;
  inbox_session_count: number;
  projects: ProjectPanelProjectData[];
}

export type ProjectRow =
  | { kind: "inbox"; id: ""; title: string; meta: string; selectable: true; active: boolean }
  | { kind: "project"; id: string; title: string; meta: string; selectable: true; active: boolean }
  | { kind: "next"; id: string; title: string; selectable: false }
  | { kind: "session"; id: string; title: string; meta: string; selectable: true; active: boolean }
  | { kind: "empty"; id: string; title: string; selectable: false };

export interface BuildProjectRowsOptions {
  filter?: string;
  now?: number;
}

/** Compact relative age for a session row, e.g. "now", "5m", "3h", "2d". */
export function relativeTime(iso: string, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function buildProjectRows(
  state: ProjectPanelStateData,
  options: BuildProjectRowsOptions = {},
): ProjectRow[] {
  const now = options.now ?? Date.now();
  const rows: ProjectRow[] = [];
  const inboxMeta = state.inbox_session_count
    ? `(${state.inbox_session_count} chats)`
    : "";
  rows.push({
    kind: "inbox",
    id: "",
    title: "Inbox",
    meta: inboxMeta,
    selectable: true,
    active: !state.active_project_id,
  });
  for (const project of state.projects) {
    const meta = project.session_count
      ? `${project.session_count} chats`
      : "";
    rows.push({
      kind: "project",
      id: project.id,
      title: project.title,
      meta,
      selectable: true,
      active: project.active,
    });
    if (project.active) {
      if (project.next_action) {
        rows.push({
          kind: "next",
          id: `${project.id}::next`,
          title: `next: ${project.next_action}`,
          selectable: false,
        });
      }
      // Strict recency: newest first regardless of controller order
      // (ISO-8601 strings compare lexicographically; undated sink last).
      const visibleSessions = [...project.sessions]
        .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
        .slice(0, 8);
      if (visibleSessions.length === 0) {
        rows.push({
          kind: "empty",
          id: `${project.id}::empty`,
          title: "no resumable chats yet",
          selectable: false,
        });
      } else {
        for (const session of visibleSessions) {
          const title = session.title || "Untitled chat";
          const truncated = title.length > 28 ? title.slice(0, 27) + "…" : title;
          rows.push({
            kind: "session",
            id: session.session_id,
            title: truncated,
            meta: session.active ? "open" : relativeTime(session.updated_at, now),
            selectable: true,
            active: session.active,
          });
        }
      }
    }
  }
  return filterProjectRows(rows, options.filter ?? "");
}

/** Type-to-filter: keep selectable rows whose title matches; drop decorations. */
export function filterProjectRows(rows: ProjectRow[], filter: string): ProjectRow[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) => row.selectable && row.title.toLowerCase().includes(needle),
  );
}

export function nextSelectableRow(
  rows: ProjectRow[],
  start: number,
  direction: 1 | -1,
): number {
  if (rows.length === 0) return 0;
  let idx = start + direction;
  while (idx >= 0 && idx < rows.length) {
    if (rows[idx]!.selectable) return idx;
    idx += direction;
  }
  return start;
}

export function clampSelectableRow(rows: ProjectRow[], index: number): number {
  if (rows.length === 0) return 0;
  if (rows[index]?.selectable) return index;
  for (let offset = 1; offset < rows.length; offset++) {
    const before = index - offset;
    if (before >= 0 && rows[before]?.selectable) return before;
    const after = index + offset;
    if (after < rows.length && rows[after]?.selectable) return after;
  }
  return 0;
}

// Maps a row to the slash command the controller should run when the user
// hits Enter on it. Returns null for non-selectable rows (caller should no-op).
export function projectRowCommand(row: ProjectRow): string | null {
  if (!row.selectable) return null;
  if (row.kind === "inbox") return "/project clear";
  if (row.kind === "session") return `/resume ${row.id}`;
  if (row.kind === "project") return `/project open ${row.id}`;
  return null;
}
