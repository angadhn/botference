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
