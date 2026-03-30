# Reflection Template

This file is read only on reflection iterations (when `$BOTFERENCE_RUN/reflect` exists).
Complete all steps below BEFORE dispatching to an agent.

## Step 1 — Gather context

Read the last 5 entries in `CHANGELOG.md` and run `git log --oneline -5`.

## Step 2 — Epistemic questions

- Are you getting closer to the goal?
- Is there a better question to be trying to answer that might take you towards a better understanding of the problem at hand?
- Is there a new angle to take towards addressing an argument or claim?
- Are you finding things that might make you re-evaluate your current biased position, or are you finding evidence to support it?

## Step 3 — Operational questions

- Are we making the right next step given what we know so far? Should `checkpoint.md`'s Next Task change?
- What's working? What's wasting effort?
- Are we spiraling on one area while neglecting another?

## Step 4 — Record the reflection

Write the full reflection to `ai-generated-outputs/reflections/reflection-iter-N.md`:

```
# Reflection — Iteration N — YYYY-MM-DD

## Trajectory: <on track / drifting / stuck>

## Working
<what's going well>

## Not working
<what's failing or wasting effort>

## Next 5 iterations should focus on
<clear direction>

## Adjustments
<any changes to approach, Next Task, or priorities>
```

Append a summary line to `CHANGELOG.md`:

```
## Reflection — Iteration N — YYYY-MM-DD
- Trajectory: <on track / drifting / stuck>. See ai-generated-outputs/reflections/reflection-iter-N.md
```

Update `checkpoint.md`'s Last Reflection section with a 2-3 line summary of the trajectory assessment and any course correction.

## Step 5 — Course change

If the reflection reveals the approach needs significant change, write a concrete plan in the Adjustments section of the reflection file — specific tasks, agent assignments, and what to do differently. Update `checkpoint.md`'s Next Task to match. The next iteration executes that plan.

## Step 6 — Clean up and proceed

Delete `$BOTFERENCE_RUN/reflect`, then proceed with normal agent dispatch.
