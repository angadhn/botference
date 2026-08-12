---
url: https://slatestarcodex.com/2014/07/30/meditations-on-moloch/
site: slatestarcodex.com
saved: 2026-08-12
tags: [botference-discuss, coordination, to-re-read]
---

# Meditations on Moloch

> Every owner can do this arithmetic, and every owner knows the others can do it too.

*Resolved by angadh.* The comment asked whether the arithmetic really is common knowledge, or whether the farms are only assumed to have worked it out. Claude answered that the assumption is doing real work and is worth stating: the trap needs everyone to know that everyone knows. The outcome was that the sentence stays, with "and every owner knows the others can do it too" carrying the load.

**angadh:** @claude does this need the "everyone knows that everyone knows" step spelled out?
**claude:** It does, and the sentence already carries it — the second clause is the common-knowledge condition in plain words. Without it the farms are merely selfish; with it they are trapped.

> Each competitor gains by defecting, and every one of them ends up worse off than if none of them had

*Resolved by angadh.* The comment asked whether the lake and an arms race are the same trap. Claude answered that they are — the same defection payoff with no enforceable promise underneath it — and differ only in whether a referee already exists. Codex plotted the spread to show how fast the equilibrium tips once it starts. The outcome was that the paragraph stands and the plot stays in the thread.

**angadh:** @claude is this the same trap as arms races?
**claude:** Yes — same shape, shorter fuse.

An arms race is this lake with two farms: each side’s build is the correct answer to the other’s, neither can stop first, and the equilibrium they reach together is worse than the treaty neither can enforce.

The difference is the exit. Fisheries get quotas because the players are few and countable; an arms race has to invent its own referee first.
**angadh:** @codex plot how defection spreads?
**codex:** Replicator dynamics is the mechanism you are asking about — defectors grow at whatever edge their payoff has over the field:

```python
import matplotlib.pyplot as plt

def spread(edge, p=0.02, n=24):
    for _ in range(n):
        yield p
        p = p * (1 + edge) / (1 + p * edge)

plt.figure(figsize=(6, 3.4))
for edge in (0.2, 0.4, 0.8):
    share = list(spread(edge))
    plt.plot(share, label=f"+{edge:.0%}")
plt.title("Defection, by payoff edge")
plt.xlabel("round")
plt.grid(alpha=.3)
plt.legend()
plt.tight_layout()
plt.show()
```

![figure 1](attachments/meditations-on-moloch-1.png)

The curve is a logistic. The payoff edge only moves the knee.
