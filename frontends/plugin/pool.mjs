// THE DISPATCHER — several bot turns at once, without ever crossing two.
//
// One bridge child runs ONE turn at a time: that is the bridge's protocol, not
// a choice this companion makes (`ready` is the turn boundary and there is only
// one of it). So for as long as the plugin had one child, every turn in the
// building queued behind every other one: a question on a blog post waited out
// a twelve-comment review round on a paper, and a send-review fan-out held the
// whole companion for minutes.
//
// The fix is more children, and the entire difficulty is deciding which turn
// may go to which child. Two rules answer it:
//
//   1. A LANE is a conversation. Turns in one lane are strictly serial and run
//      on ONE child, in submission order. A page's chat is one session; its
//      ordering is its meaning.
//   2. Different lanes may run at the same time, up to a cap.
//
// The lane of an ordinary page is the page (`pg:<url>`) — that is what this
// file dispatches. The lane of a PROJECT ARTIFACT page is its project, and it
// is not dispatched here at all: server.mjs already gives each (council root,
// project) its own child (`workspaceChats`), which IS the per-project write
// lock — one child, one FIFO, one writable directory. Nothing about a project's
// serialization had to be invented; it was already load-bearing for Phase 2's
// write scope, and this file was written to leave it exactly alone.
//
// ── WHEN A LANE MAY MOVE, AND WHEN IT MAY NOT ─────────────────────────────
// The controller's session file (`<work>/sessions/<sid>.json`) is rewritten
// whole on every persisted turn — atomically, with no lock. Two children
// DRIVING one session id at once is therefore a silent whole-turn loss, and
// the invariant that stops it is held here, in Node.
//
// A lane binds to a child on its first turn. Until 2026-11-06 it then stayed
// there for as long as that child lived, which is what made a reader wait on a
// different website: pages A and C shared a child, A was talking, C queued
// behind A while another child sat idle. So a lane now MOVES — but only when
// it is provably safe to:
//
//   · the lane has NOTHING on its old child: no turn running, none queued.
//     Its turns are strictly serial, so the old child has finished every turn
//     it was ever given for this session and is not driving it.
//   · the old child is busy with somebody else's turn (moving off an idle
//     child would buy a /resume for nothing).
//   · there is somewhere better to go: an idle child, or room for a new one.
//
// What the old child can still do to the session it is leaving is ONE save:
// `/resume` persists the chat it is switching away from (core/botference.py
// _resume_session). That copy is the one already on disk — that child was the
// last to write it — and if the new child has written since, the old copy is
// SHORTER, which core/session_store.py refuses (StaleSessionWrite) rather than
// overwrites. So the worst a move can cost is a logged refusal, never a turn.
// A lane with a turn queued on its child never moves: ordering is the lane's
// meaning, and the queued turn is going to drive that session.
//
// ── WHAT IS STILL SHARED, HONESTLY ────────────────────────────────────────
// Every child in this pool works in the same root and files under the same
// project ("Plugin pages"). The controller's per-project scratch files —
// `work/handoff-<model>.md` above all — are not per session, so two children
// relaying at the same moment can overwrite each other's handoff. The session
// index and the project index are both flock'd and safe; the scratch files are
// not. It is rare (a relay needs a context ceiling and these turns are short),
// it costs a relay rather than a transcript, and the real fix is in the
// controller. See the SPEC amendment for the shape of it.
import { createChat } from './chat.mjs';

// How many children the plugin's own pool may run at once. Three is two more
// than yesterday and still bounded by something a laptop can hold: each child
// is a python process with a claude and a codex CLI under it.
export const DEFAULT_POOL = 3;
// How long a child beyond the first may sit with nothing to do before it is
// retired. The pool grows to meet a busy afternoon and shrinks back to
// yesterday's footprint when the reader stops — the cost of being wrong is one
// "waking the agents…" the next time that page speaks, which is a wait the
// drawer already knows how to say.
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const REAP_TICK_MS = 30 * 1000;
const POOL_MAX = 8;

export const laneOf = url => `pg:${String(url || '')}`;

// `make` is the seam the tests use: a fake chat with the same surface, so the
// dispatcher's rules can be proved without spawning anything.
// Pool children serve ORDINARY pages, whose bots may write nothing — and,
// since 2026-09-04, may run neither `git` nor `gh`: their working directory is
// the companion's own workspace, and a bot that "helpfully" committed a page it
// had built there swept the developer's half-finished files into its commit.
// Project lanes (workspaceChatFor) keep git and gh, inside their own folders.
export const POOL_DENY_BASH = ['git', 'gh'];
export function createPool({ onEvent, root, max = DEFAULT_POOL, idleMs = DEFAULT_IDLE_MS,
  make = createChat, now = Date.now, denyBash = POOL_DENY_BASH } = {}) {
  const cap = Math.max(1, Math.min(POOL_MAX, Math.floor(Number(max)) || 1));
  const idle = Math.max(0, Math.floor(Number(idleMs)) || 0);
  const members = [];
  const lanes = new Map();          // lane key → member
  let timer = null;

  const emit = ev => { try { onEvent(ev); } catch { } };

  // Every lane this child holds goes back on the market. Called when the child
  // is gone and only then — see the invariant above.
  function release(m) {
    for (const [k, v] of [...lanes]) if (v === m) lanes.delete(k);
  }

  function add() {
    const m = { chat: null, at: now() };
    m.chat = make({
      root,
      denyBash: denyBash.slice(),
      onEvent: ev => {
        // a child that exited cannot finish anything it held, and chat.mjs has
        // already told every waiting page so; what is left is to stop sending
        // that child's lanes to it
        if (ev && ev.type === 'bridge' && ev.state === 'exited') release(m);
        if (ev && ev.type === 'chat' && ev.kind === 'turn-end') m.at = now();
        emit(ev);
      },
    });
    members.push(m);
    arm();
    return m;
  }

  // The primary exists from the first moment, child or no child. Everything
  // that asks the pool a question with no page attached — the model picker, a
  // process-wide /model — is asking this one, exactly as it asked the single
  // bridge before there was a pool.
  const primary = add();

  const laneCount = m => [...lanes.values()].filter(v => v === m).length;
  const load = m => m.chat.queueLength();

  // WHICH CHILD RUNS THIS LANE.
  //
  //   bound lane:
  //     1. stay, if this lane has a turn on its child     ordering + session rule
  //     2. stay, if its child is idle                     nothing to gain
  //     3. move to an idle child, or a new one under cap  parallelism is the point
  //     4. stay and wait                                   the cap is reached
  //   new lane:
  //     1. an idle child (a running one before a cold one)
  //     2. a new child, if under the cap
  //     3. the child with the shortest queue, then fewest lanes
  //
  // "Idle" is the child's own queue, not how many lanes it has ever held:
  // a lane is a binding, not a load, and judging by lanes is what sent a new
  // page to a busy child while one that had served three pages sat idle.
  const idleChild = (except) => {
    const free = members.filter(m => m !== except && load(m) === 0);
    if (!free.length) return null;
    // warm = actually booted, not merely spawned: a child still starting up is
    // no quicker to answer than a fresh one (chat.mjs lifecycle)
    const warm = m => ((m.chat.lifecycle ? m.chat.lifecycle() !== 'stopped' && m.chat.lifecycle() !== 'starting'
      : m.chat.state() === 'running') ? 1 : 0);
    free.sort((a, b) => (warm(b) - warm(a)) || (laneCount(a) - laneCount(b)));
    return free[0];
  };
  function pick(lane, url) {
    const held = lanes.get(lane);
    if (held && members.includes(held)) {
      if (load(held) === 0 || held.chat.busyFor(url)) return held;
      const m = idleChild(held) || (members.length < cap ? add() : null);
      if (!m) return held;
      lanes.set(lane, m);
      return m;
    }
    let m = idleChild(null) || (members.length < cap ? add() : null);
    if (!m) {
      m = members.reduce((a, b) => {
        const d = load(b) - load(a);
        return (d < 0 || (d === 0 && laneCount(b) < laneCount(a))) ? b : a;
      });
    }
    lanes.set(lane, m);
    return m;
  }

  // Retire a child that has been doing nothing. Never the primary: it is the
  // one the pickers read and the one a cold reader's first turn lands on, and
  // killing it would buy a respawn for nothing.
  function reap() {
    if (!idle) return;
    const cutoff = now() - idle;
    for (const m of [...members]) {
      if (m === primary || m.at > cutoff) continue;
      if (m.chat.queueLength() > 0) continue;
      if (m.chat.state() !== 'running') continue;
      members.splice(members.indexOf(m), 1);
      release(m);
      try { m.chat.stop(); } catch { }
      // stderr, not the event stream: a `bridge` event would write "reaped"
      // into the drawer's footer, and retiring spare capacity is housekeeping
      // rather than something the reader is waiting on
      console.error(`[pool] retired an idle bridge (${members.length} left)`);
    }
    if (members.length <= 1) disarm();
  }
  function arm() {
    if (timer || !idle || members.length <= 1) return;
    timer = setInterval(reap, REAP_TICK_MS);
    timer.unref?.();
  }
  function disarm() { if (timer) { clearInterval(timer); timer = null; } }

  return {
    // A turn for a page. The lane is the page; the child is whichever one the
    // rules above name; the ordering inside the lane is the child's own FIFO.
    submit(job) {
      const lane = laneOf(job && job.url);
      const m = pick(lane, job && job.url);
      m.at = now();
      // sampled BEFORE the push, or it would always be true: this is the
      // difference between "your own conversation is still talking" and "every
      // agent in the building is busy with somebody else"
      const mine = !!m.chat.busyFor(job && job.url);
      const res = m.chat.submit(job);
      // chat.mjs says 'busy' for any warm child with the floor taken. Only the
      // pool knows whose floor it is.
      // …and when it is somebody else's, the only way that happens now is that
      // every child is busy and the cap is reached — so the drawer can say
      // exactly that: "3 chats already running".
      if (res && res.wait === 'busy' && !mine) {
        const running = members.filter(x => load(x) > 0).length;
        const { wait_detail: _ignored, ...rest } = res;
        return { ...rest, wait: 'pool_busy', wait_detail: { running, cap } };
      }
      return res;
    },
    // A process-wide setting (/model, /effort). Every child that exists gets
    // it; a child spawned later reads the same config.json at birth. The
    // primary always exists, so a cold pool still wakes exactly as one bridge
    // did.
    control(text) {
      for (const m of members) m.chat.control(text);
      return { queued: true, position: primary.chat.queueLength() };
    },
    // A command that must reach the child holding a particular page's session —
    // `/delete <sid>`, whose whole point is that a live child owns that file
    // and would rewrite it on its next save. No holder means no child has that
    // session in memory, and the caller may delete the file itself.
    controlFor(url, text) {
      const m = lanes.get(laneOf(url));
      if (!m || !members.includes(m) || m.chat.state() !== 'running') return false;
      m.chat.control(text);
      return true;
    },
    // Every turn this page has waiting, anywhere in the pool, forgotten. Asked
    // when the page's chat is set aside (POST /page-chat-new, /page-chat-open):
    // the lane is normally one child's, but a child that died and was replaced
    // can leave a page's turns spread over two, so every member is asked rather
    // than the lane's current holder alone.
    dropQueued: url => members.reduce((n, m) =>
      n + (m.chat.dropQueued ? m.chat.dropQueued(url) : 0), 0),
    // the pickers' authority: one child's answer, not a vote
    models: () => primary.chat.models(),
    interrupt: url => members.some(m => m.chat.interrupt(url)),
    state: () => (members.some(m => m.chat.state() === 'running') ? 'running' : 'stopped'),
    queueLength: () => members.reduce((n, m) => n + m.chat.queueLength(), 0),
    busyFor: url => members.some(m => m.chat.busyFor && m.chat.busyFor(url)),
    jobs: () => members.flatMap(m => (m.chat.jobs ? m.chat.jobs() : [])),
    root: () => primary.chat.root(),
    writeRoot: () => primary.chat.writeRoot(),
    stop() {
      disarm();
      for (const m of members) { try { m.chat.stop(); } catch { } }
      lanes.clear();
    },
    // introspection, for /health and for the tests
    size: () => members.length,
    cap: () => cap,
    laneMap: () => new Map([...lanes].map(([k, v]) => [k, members.indexOf(v)])),
    // the timer is a detail of the pool; the tests drive it directly
    reapNow: reap,
  };
}
