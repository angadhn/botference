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

export function buildProjectRows(state: ProjectPanelStateData): ProjectRow[] {
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
      const visibleSessions = project.sessions.slice(0, 8);
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
          const truncated = title.length > 28 ? title.slice(0, 25) + "..." : title;
          rows.push({
            kind: "session",
            id: session.session_id,
            title: truncated,
            meta: "",
            selectable: true,
            active: session.active,
          });
        }
      }
    }
  }
  return rows;
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
