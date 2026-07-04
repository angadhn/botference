import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildProjectRows,
  clampSelectableRow,
  filterProjectRows,
  nextSelectableRow,
  projectRowCommand,
  relativeTime,
  type ProjectPanelStateData,
  type ProjectRow,
} from "./projects.js";

// Fixed clock for deterministic relative timestamps.
const NOW = Date.parse("2026-05-10T12:00:00Z");

const empty: ProjectPanelStateData = {
  active_project_id: "",
  inbox_session_count: 0,
  projects: [],
};

const inboxWithCounts: ProjectPanelStateData = {
  active_project_id: "",
  inbox_session_count: 42,
  projects: [
    {
      id: "career-switch",
      title: "Career Switch",
      status: "active",
      next_action: "",
      active: false,
      session_count: 3,
      sessions: [],
    },
  ],
};

const activeProject: ProjectPanelStateData = {
  active_project_id: "career-switch",
  inbox_session_count: 1,
  projects: [
    {
      id: "career-switch",
      title: "Career Switch",
      status: "active",
      next_action: "Draft applications",
      active: true,
      session_count: 2,
      sessions: [
        {
          session_id: "abc12345-aaaa-bbbb-cccc-ddddeeeeffff",
          title: "Resume polish",
          updated_at: "2026-05-10T00:00:00Z",
          active: true,
        },
        {
          session_id: "deadbeef-1111-2222-3333-444455556666",
          title: "",
          updated_at: "2026-05-09T00:00:00Z",
          active: false,
        },
      ],
    },
    {
      id: "spaceship",
      title: "Spaceship",
      status: "active",
      next_action: "",
      active: false,
      session_count: 0,
      sessions: [],
    },
  ],
};

const activeProjectNoSessions: ProjectPanelStateData = {
  active_project_id: "spaceship",
  inbox_session_count: 0,
  projects: [
    {
      id: "spaceship",
      title: "Spaceship",
      status: "active",
      next_action: "",
      active: true,
      session_count: 0,
      sessions: [],
    },
  ],
};

describe("buildProjectRows", () => {
  it("returns just Inbox when there are no projects", () => {
    const rows = buildProjectRows(empty);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "inbox");
    assert.equal(rows[0]!.selectable, true);
    assert.equal((rows[0] as { active: boolean }).active, true);
  });

  it("marks Inbox as active when no project is active and shows chat count", () => {
    const rows = buildProjectRows(inboxWithCounts);
    const inbox = rows[0] as { kind: string; active: boolean; meta: string };
    assert.equal(inbox.kind, "inbox");
    assert.equal(inbox.active, true);
    assert.equal(inbox.meta.includes("42"), true);
    const career = rows[1] as { kind: string; meta: string; active: boolean };
    assert.equal(career.kind, "project");
    assert.equal(career.active, false);
    assert.equal(career.meta.includes("3"), true);
  });

  it("expands the active project with next-action and session rows", () => {
    const rows = buildProjectRows(activeProject, { now: NOW });
    const kinds = rows.map((r) => r.kind);
    // Inbox, active project, next-action, two sessions, sibling project header
    assert.deepEqual(kinds, ["inbox", "project", "next", "session", "session", "project"]);
    const nextRow = rows[2] as { title: string };
    assert.equal(nextRow.title.startsWith("next:"), true);
    const firstSession = rows[3] as { id: string; title: string; meta: string; active: boolean };
    assert.equal(firstSession.id, "abc12345-aaaa-bbbb-cccc-ddddeeeeffff");
    assert.equal(firstSession.title, "Resume polish");
    assert.equal(firstSession.meta, "open");
    assert.equal(firstSession.active, true);
    const secondSession = rows[4] as { title: string; meta: string };
    assert.equal(secondSession.title, "Untitled chat");
    // 2026-05-09 → one day before NOW.
    assert.equal(secondSession.meta, "1d");
  });

  it("sorts active-project sessions newest first regardless of input order", () => {
    const shuffled: ProjectPanelStateData = {
      active_project_id: "p",
      inbox_session_count: 0,
      projects: [{
        id: "p",
        title: "P",
        status: "active",
        next_action: "",
        active: true,
        session_count: 3,
        sessions: [
          { session_id: "old", title: "old", updated_at: "2026-05-01T00:00:00Z", active: false },
          { session_id: "new", title: "new", updated_at: "2026-05-10T00:00:00Z", active: false },
          { session_id: "mid", title: "mid", updated_at: "2026-05-05T00:00:00Z", active: false },
        ],
      }],
    };
    const rows = buildProjectRows(shuffled, { now: NOW });
    const sessionIds = rows.filter((r) => r.kind === "session").map((r) => r.id);
    assert.deepEqual(sessionIds, ["new", "mid", "old"]);
  });

  it("emits an empty placeholder when the active project has no sessions", () => {
    const rows = buildProjectRows(activeProjectNoSessions);
    const placeholder = rows[2] as { kind: string; title: string; selectable: boolean };
    assert.equal(placeholder.kind, "empty");
    assert.equal(placeholder.selectable, false);
    assert.equal(placeholder.title, "no resumable chats yet");
  });

  it("filters selectable rows by case-insensitive title match", () => {
    const rows = buildProjectRows(activeProject, { now: NOW, filter: "resume" });
    assert.deepEqual(
      rows.map((r) => ({ kind: r.kind, title: r.title })),
      [{ kind: "session", title: "Resume polish" }],
    );
  });

  it("keeps decorations when the filter is empty", () => {
    const unfiltered = buildProjectRows(activeProject, { now: NOW });
    assert.deepEqual(filterProjectRows(unfiltered, "  "), unfiltered);
  });
});

describe("relativeTime", () => {
  it("buckets ages into compact units", () => {
    assert.equal(relativeTime("2026-05-10T11:59:30Z", NOW), "now");
    assert.equal(relativeTime("2026-05-10T11:15:00Z", NOW), "45m");
    assert.equal(relativeTime("2026-05-10T07:00:00Z", NOW), "5h");
    assert.equal(relativeTime("2026-05-07T12:00:00Z", NOW), "3d");
    assert.equal(relativeTime("2026-04-20T12:00:00Z", NOW), "2w");
    assert.equal(relativeTime("2026-02-10T12:00:00Z", NOW), "2mo");
    assert.equal(relativeTime("2024-05-10T12:00:00Z", NOW), "2y");
  });

  it("returns empty for missing or invalid dates", () => {
    assert.equal(relativeTime("", NOW), "");
    assert.equal(relativeTime("not-a-date", NOW), "");
  });
});

describe("nextSelectableRow", () => {
  it("skips next-action rows when navigating", () => {
    const rows = buildProjectRows(activeProject);
    // Cursor sits on the active project (index 1). Moving down should land
    // on the first session row, skipping the next-action row at index 2.
    assert.equal(nextSelectableRow(rows, 1, 1), 3);
  });

  it("stays put when no selectable row exists in the chosen direction", () => {
    const rows: ProjectRow[] = [
      { kind: "next", id: "x", title: "next", selectable: false },
      { kind: "inbox", id: "", title: "Inbox", meta: "", selectable: true, active: true },
      { kind: "empty", id: "y", title: "empty", selectable: false },
    ];
    // Moving forward from Inbox can't find another selectable row.
    assert.equal(nextSelectableRow(rows, 1, 1), 1);
  });
});

describe("clampSelectableRow", () => {
  it("snaps to the nearest selectable neighbor when index lands on an unselectable row", () => {
    const rows = buildProjectRows(activeProject);
    // Index 2 is the next-action row (not selectable).
    const clamped = clampSelectableRow(rows, 2);
    assert.equal(rows[clamped]!.selectable, true);
    assert.ok(clamped === 1 || clamped === 3);
  });

  it("returns the same index when already on a selectable row", () => {
    const rows = buildProjectRows(activeProject);
    assert.equal(clampSelectableRow(rows, 3), 3);
  });
});

describe("projectRowCommand", () => {
  it("returns /project clear for the Inbox row", () => {
    const rows = buildProjectRows(activeProject);
    const inbox = rows[0]!;
    assert.equal(projectRowCommand(inbox), "/project clear");
  });

  it("returns /project open <id> for a project header", () => {
    const rows = buildProjectRows(activeProject);
    const project = rows[1]!;
    assert.equal(projectRowCommand(project), "/project open career-switch");
  });

  it("returns /resume <id> for a session row", () => {
    const rows = buildProjectRows(activeProject);
    const session = rows[3]!;
    assert.equal(
      projectRowCommand(session),
      "/resume abc12345-aaaa-bbbb-cccc-ddddeeeeffff",
    );
  });

  it("returns null for unselectable rows", () => {
    const rows = buildProjectRows(activeProject);
    const nextRow = rows[2]!;
    assert.equal(projectRowCommand(nextRow), null);
  });
});
