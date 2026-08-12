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
