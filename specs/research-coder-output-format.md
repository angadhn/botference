# Research Coder Output Format

## Matplotlib Conventions (Figure Mode)

- **File naming:** `figures/fig_NN_short_name.py` produces `.pdf` + `.png`
- **Font sizes:** title 14pt, axis labels 12pt, tick labels 10pt, legend 10pt
- **Figure size:** `figsize=(7, 5)` default; `(3.5, 3)` for single-column
- **Color palette:** colorblind-safe `tableau-colorblind10`
- **Resolution:** DPI 300+ for PNG, primary output is PDF (vector)
- **Layout:** `plt.tight_layout()` before save
- **Save format:** PDF primary (`bbox_inches='tight'`), PNG backup

## Full Script Template

```python
#!/usr/bin/env python3
"""[Description of what this script does].

Source data: [path to source files]
Output: [output path]
"""
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# All paths relative to project root
OUTPUT_DIR = Path("AI-generated-outputs/<thread>/research-code/")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Source comments on every data structure
# Source: AI-generated-outputs/<thread>/deep-analysis/notes.md, "Author2024" entry
values = [12.5, 18.3, 7.8, 22.1]

# ── Figure script example ──
plt.style.use('tableau-colorblind10')
fig, ax = plt.subplots(figsize=(7, 5))

# ... plotting code ...

ax.set_xlabel("X Label (units)", fontsize=12)
ax.set_ylabel("Y Label (units)", fontsize=12)
ax.set_title("Descriptive Title", fontsize=14)
ax.tick_params(labelsize=10)
ax.legend(fontsize=10)
plt.tight_layout()

fig.savefig("figures/fig_01_name.pdf", bbox_inches='tight')
fig.savefig("figures/fig_01_name.png", dpi=300, bbox_inches='tight')
print("Saved figures/fig_01_name.pdf and .png")
```

## Data Fidelity Rule

Every number in a script MUST trace to a specific source. Include a source comment above each data structure referencing the exact file and location. If a data point cannot be found in the cited source, write `# DATA NOT FOUND — [what was expected]` and skip that point. **Never fabricate data.**
