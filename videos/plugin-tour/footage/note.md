---
url: https://angadh.com/whereVonBraunWheel
site: angadh.com
saved: 2026-08-12
tags: [botference-discuss, spaceships, artificial-gravity]
---

# Where is my von Braun wheel?

> Much like a ferris wheel, the wheel’s rotation could disorient astronauts if spun too fast.

*Resolved by angadh.* The comment asked what "too fast" is in numbers. Claude answered that the comfort ceiling sits around 4–6 rpm and that almost nobody is troubled below 2, because the discomfort comes from turning your head across the spin axis rather than from the spin itself. The outcome was that the sentence stays as written and the Globus range one line down carries the number.

**angadh:** @claude how fast is "too fast" — is there a number?
**claude:** The comfort ceiling most of the literature settles on is 4–6 rpm, and almost nobody is troubled below 2. What makes people ill is turning your head across the spin axis, not the spin itself.

> For example, one of von Braun’s designs called for a massive 75 metre diameter wheel that generated lunar gravity if spun at 3 rpm and Earth-like gravity at 5 rpm

*Resolved by angadh.* The comment asked whether 3 rpm on a 75 metre wheel really gives lunar gravity. Claude worked ω²r at r = 37.5 m and answered that it does not: 3 rpm lands on 0.38 g, which is Mars, while the Moon wants about 2 rpm — the 5 rpm Earth-like figure is right. Codex plotted gravity against radius for all three rates with the wheel marked. The outcome was that the sentence needs Mars-like in place of lunar, or 2 rpm in place of 3.

**angadh:** @claude 3 rpm on a 75 m wheel — is that really lunar gravity?
**claude:** Not quite — that one is Mars.

Artificial gravity is ω²r, and a 75 m wheel gives r = 37.5 m:

- 5 rpm → 10.3 m/s² = 1.05 g. Earth-like, as you have it.
- 3 rpm → 3.70 m/s² = 0.38 g, which is Mars (0.38 g), not the Moon (0.17 g).

Lunar gravity on this wheel wants about 2 rpm — still well inside the comfort range you link to, so the design survives; it is the label that slips.
**angadh:** @codex plot gravity vs radius at 2, 3 and 5 rpm?
**codex:** Here is ω²r swept over radius, with the three rates and the Moon/Mars/Earth levels drawn in, and your wheel marked:

```python
import numpy as np
import matplotlib.pyplot as plt

g, r = 9.80665, np.linspace(2, 120, 400)

plt.figure(figsize=(6.4, 3.6))
for rpm in (2, 3, 5):
    w = rpm * 2 * np.pi / 60
    plt.plot(r, w * w * r / g,
             label=f"{rpm} rpm")

lvls = [("Moon", .166), ("Mars", .379),
        ("Earth", 1.0)]
for tag, lvl in lvls:
    plt.axhline(lvl, ls=":", c="0.55")
    plt.text(3, lvl + .04, tag, fontsize=8)

plt.axvline(37.5, ls="--", c="crimson")
plt.text(40, 1.42, "von Braun: 37.5 m",
         fontsize=8, color="crimson")
plt.xlabel("spin radius (m)")
plt.ylabel("artificial gravity (g)")
plt.ylim(0, 1.6)
plt.legend(loc="lower right")
plt.tight_layout()
plt.show()
```

![figure 1](attachments/1305e7e0e56d03e3aa08507b45b75f4c4b509933-1.png)

The 37.5 m line crosses 3 rpm at 0.38 g and 5 rpm just over 1 g.
