# Council agent presence, version 1

The council reports actual adapter calls running in **all of its live chat
bridges in one workspace**. This includes Claude/Codex turns and summoned
builders, including concurrent runs of the same family. It does not cover
independent TUI sessions, the Discuss companion, other council processes, or
tools/subagents inside an adapter call. Presence is observed runtime activity,
not a claim about what the model is thinking.

## Transport and authentication

| Request | Response |
| --- | --- |
| `GET /presence` | A complete JSON snapshot; `Cache-Control: no-store`. |
| `WS /ws?scope=presence` | A complete snapshot immediately, on every lifecycle change, and on each heartbeat. Preferred through tunnels. |
| `GET /events?scope=presence` | The same snapshots as unnamed SSE `data:` events, with the existing SSE padding/headers. Fallback transport. |

These use the council's existing authentication gate. Hosted mode requires
the council auth cookie or HTTP Basic password, including on WebSocket
upgrade. Browser WebSockets use the same-origin cookie. Missing credentials
receive 401. Local mode and explicit `--no-auth` retain their existing ungated
behavior. This is the council's single-user workspace scope, not a new
per-project permission system.

Presence subscriptions do not spawn/resume a bridge or replay a transcript.
`chat` is ignored when `scope=presence`. Ordinary `/ws` and `/events` remain
chat-scoped. Do not connect one stream per project or infer workers from room
cards. No server/tunnel restart or UI integration is part of this change.

## Snapshot

```json
{
  "type": "presence",
  "version": 1,
  "server_id": "process-epoch-uuid",
  "root": "/absolute/workspace",
  "heartbeat_ms": 15000,
  "revision": 4,
  "generated_at": "2026-10-29T18:00:00.000Z",
  "runs": [
    {
      "run_id": "process-epoch-uuid:run-uuid",
      "bridge_id": "b2",
      "stream_id": "chat-id:room:agent:7",
      "kind": "build",
      "agent_family": "codex",
      "agent_id": "chat-id:agent:1",
      "parent_stream_id": "chat-id:room:claude:6",
      "chat_id": "chat-id",
      "project_id": "my-project",
      "project_association": "session",
      "state": "running",
      "started_at": "2026-10-29T17:59:00.000Z",
      "updated_at": "2026-10-29T17:59:00.000Z",
      "ended_at": null
    }
  ],
  "recent": []
}
```

- `runs` is the authoritative list of active runs. Replace your entire list
  on every snapshot. Never merge it with restored chat history.
- `recent` holds at most 100 terminal runs, oldest first, for optional outcome
  badges. They are **not workers**. It is a bounded in-memory tail, not a
  durable audit log or time-based retention promise.
- `run_id` is opaque and stable for the lifetime of a call and across viewer
  reconnects. Different calls always get different IDs, even if bridge-local
  stream or saved agent-card IDs repeat. Key avatars by `run_id`, not family,
  project, `agent_id`, or `stream_id`.
- `kind` is `turn` or `build`. `agent_family` is `claude`, `codex`, or
  `unknown`; builders use their actual CLI family, not their summoner.
- `agent_id` and `parent_stream_id` are build-card/parent-turn references and
  are null for ordinary turns. They are scoped to the bridge/chat.
- `chat_id` is the controller's session ID at call start; older bridge
  protocols without that field report null. A known chat can be opened at
  `/#/chat/<encodeURIComponent(chat_id)>` on this council origin.
- `project_id` is the chat's explicitly filed project, verified against an
  exact existing project ID by the controller at call start.
  `project_association` is `session` for that verified association, otherwise
  `unknown` and `project_id: null`. Inbox, missing/deleted projects and older
  bridge protocols stay unknown. Neither the selected sidebar project nor
  project names in conversation text establish membership.
- Association is fixed for this run. It is a filing association, not proof
  of a task's filesystem access or current topic. A subsequent call can carry
  a different explicit filing; there is **no project-transfer/handoff event**
  in version 1. Do not infer transfers from conversation text, project names,
  the sidebar selection or timing. Place unknown projects in an unassigned
  area, and match `root` before attaching runs to city buildings.
- **Refiling animation (permitted).** When the feed itself reports the same
  `chat_id` with a verified `session` association to project A and then,
  on a later run, to a different verified project B, the city may walk that
  chat's avatar from A to B. This shows the chat's *recorded refiling*: the
  controller verified a different filing at the later call's start. It does
  **not** represent an explicit agent transfer event, and the UI must say so:
  during the walk the avatar's hover and accessible label reads "Chat refiled
  from “A” to “B”" and states that the walk shows the filing, not the agent
  choosing to move. Runs with an `unknown` association never walk. With
  reduced motion the avatar simply appears at B. A future explicit transfer
  event, if added, would need its own distinct presentation.
- Timestamps are UTC ISO strings observed by the council on start/finish.
  `updated_at` is the latest lifecycle change, not a token heartbeat or a
  last-tool timestamp. Long silent calls can still be running. No prompts,
  tool arguments, or conversation text are included.

## Lifecycle and recovery

| State | Meaning |
| --- | --- |
| `running` | An adapter call started and has not reached a terminal boundary. This includes internal retries or waiting inside the call. |
| `completed` | Adapter returned exit code zero. |
| `failed` | Adapter returned a nonzero exit code or raised an exception. |
| `cancelled` | The call was cancelled, including cancellation by an outer build timeout. An adapter that returns a timeout error is `failed`. |
| `interrupted` | A ready/reset boundary arrived without an explicit terminal outcome, or an older bridge ended a stream without reporting its outcome. |
| `disconnected` | Its bridge exited, failed, lost stdout, or was retired before a terminal outcome was observed. Success is unknown. |

Terminal entries include `ended_at` and `reason`: `adapter_finished`,
`outcome_unknown`, `ready_without_terminal`, `chat_reset`, or `bridge_lost`.
Completion/failure/cancellation remove the run from `runs` immediately.
Bridge loss removes all that bridge's runs, leaving other bridges alone.
Buffered output after retirement is ignored. Active presence also protects
a bridge from idle parking/billing retirement.

Disconnecting a browser does not stop a worker. On transport close/error,
the UI must immediately mark its view disconnected and stop claiming live
activity. Also mark it stale when no snapshot arrives for three times
`heartbeat_ms` (default 45 seconds). Use local receipt time for that deadline.
Before the first snapshot, show connecting/unknown rather than assuming idle.

Reconnect to the presence stream for a complete replacement snapshot; there
is no event cursor or `Last-Event-ID` replay. `revision` increases on lifecycle
changes; unchanged heartbeat snapshots retain it and refresh `generated_at`.
If HTTP polling and a stream are combined, discard older revisions within
the same `server_id`. Discard callbacks from obsolete transport connections.

`server_id` changes on every server start. On a new ID, discard all old run
and terminal state. The server never loads presence from saved sessions or
"working" cards, so restart/reopen cannot resurrect a worker. SIGTERM/SIGINT
retire the owned bridges. A hard-killed server cannot report the outcome of
orphaned processes: the new server starts with no observed runs, and does
not adopt them or pretend they completed.

## Runtime source and validation

`Botference._run_adapter_streamed` emits live `stream/start` and `stream/done`
around each call. Both carry `chat_id`, `project_id` and
`project_association`; `done` adds `outcome` and is emitted in `finally` on
exceptions/cancellation too. Build streams already carry `agent` metadata.
The council feeds only incoming runtime events into `Presence`; room
messages, batches, saved cards and browser history replay do not populate it.

Three new tests cover concurrent identity/association, snapshot recovery and
bridge cleanup, and runtime terminal boundaries. The council handler tests
run in process with `COUNCIL_NO_LISTEN=1`; no listening server is needed.
Live socket/tunnel integration remains for the next authorized deployment
check. The city UI and explicit handoffs are intentionally outside this step.

Validation on this change (no servers/tunnels started):

- `node --test tests/council-presence.test.mjs`: 2 passed.
- `python3 -m pytest -q tests/test_presence_lifecycle.py tests/test_summon.py tests/test_botference_ink_bridge.py`: 95 passed.
- `node --test tests/project-network.test.mjs tests/project-network-ui.test.mjs`: 26 passed.
- `node --test --test-name-pattern='^(subagent lane:|credit exhaustion flags|hash routing:|chat switch:|replay lands|agents panel:)' tests/council-web.test.mjs`: 10 passed; only in-process DOM tests selected.
- `python3 -m pytest -q tests/test_botference.py`: 505 passed, 1 failed.
  `TestBotferenceFinalize.test_finalize_revises_plan_writes_checkpoint_and_archives_comments`
  expects an archived file under `archive/reviewer-comments/demo/` that is
  absent. Reproduced in isolation, then reproduced again with the original
  `HEAD` version of `_run_adapter_streamed` substituted in memory. No source
  files were reverted for that check. This pre-existing archive issue is left
  unchanged.
- Node syntax checks and `git diff --check` pass.
