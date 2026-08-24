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
// ── WHY A LANE NEVER MOVES OFF A LIVE CHILD ───────────────────────────────
// The controller's session file (`<work>/sessions/<sid>.json`) is rewritten
// whole on every persisted turn — atomically, but with no lock and no version
// check: last writer wins the entire transcript. Two children driving one
// session id is therefore a silent whole-turn loss, and the invariant that
// stops it is held here, in Node, because nothing in Python enforces it.
//
// So a lane binds to a child on its first turn and STAYS THERE for as long as
// that child exists. Load is balanced at binding time and never afterwards.
// A lane is released only when its child is gone — reaped (we killed it) or
// dead (it exited) — which is exactly the condition under which the old child
// can no longer write that session file. The imbalance this costs (two lanes
// sharing a child while another sits idle) is the price of that guarantee, and
// it is a wait, not a corruption.
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
export function createPool({ onEvent, root, max = DEFAULT_POOL, idleMs = DEFAULT_IDLE_MS,
  make = createChat, now = Date.now } = {}) {
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
  //   1. the one it is already bound to           ordering, and the session rule
  //   2. a child holding no lanes at all          free capacity, no sharing
  //   3. a new child, if under the cap            parallelism is the point
  //   4. the least-encumbered child               fewest lanes, then shortest queue
  //
  // Note what is NOT here: taking a lane off a busy child because another is
  // idle. That is the migration the session store cannot survive.
  function pick(lane) {
    const held = lanes.get(lane);
    if (held && members.includes(held)) return held;
    let m = members.find(x => laneCount(x) === 0);
    if (!m && members.length < cap) m = add();
    if (!m) {
      m = members.reduce((a, b) => {
        const d = laneCount(b) - laneCount(a);
        return (d < 0 || (d === 0 && load(b) < load(a))) ? b : a;
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
      const m = pick(lane);
      m.at = now();
      // sampled BEFORE the push, or it would always be true: this is the
      // difference between "your own conversation is still talking" and "every
      // agent in the building is busy with somebody else"
      const mine = !!m.chat.busyFor(job && job.url);
      const res = m.chat.submit(job);
      // chat.mjs says 'busy' for any warm child with the floor taken. Only the
      // pool knows whose floor it is.
      if (res && res.wait === 'busy' && !mine) return { ...res, wait: 'pool_busy' };
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
