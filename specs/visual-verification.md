# Visual Output Verification

For any work whose output is rendered by a human, including HTML, CSS, plots,
charts, PDFs, LaTeX files that produce PDFs, dashboards, web UI, generated
images, or inline document figures, the agent must use the status labels and
verification rules below.

This is a hard Botference gate, not a style preference. If an agent changes or
generates a rendered artifact and the same turn does not show an appropriate
render check, Botference records the result as **User-review needed** and
rejects any "done", "fixed", "ready", or "verified" claim.

## Status Labels

- **Changed**: files were edited.
- **Generated**: outputs were created.
- **Structurally checked**: syntax, files, links, or metadata were checked.
- **Visually verified**: rendered output was inspected at relevant viewports.
- **User-review needed**: visual verification was not available in this
  environment, or a subjective visual judgment remains.

Do not say "done", "fixed", "ready", "this works", or "verified" for rendered
work unless it is visually verified. If render tooling is unavailable, say what
changed and ask the user to reload the artifact.

## Minimum Visual Checks

Before claiming rendered output is visually verified:

1. Render the artifact with the same kind of renderer a user will use: browser
   for HTML/web UI, PDF renderer for PDFs, LaTeX compiler plus PDF inspection
   for `.tex` files, or the plotting backend for static figures.
2. Check at desktop and narrow/mobile widths.
3. Check that `document.documentElement.scrollWidth <= window.innerWidth` for
   HTML outputs.
4. Check that important text is visible, not clipped, and not overlapping.
5. Check console/page errors for browser-rendered outputs.
6. Save screenshots or rendered artifacts plus a compact report under the
   Botference work directory.

For HTML artifacts, prefer:

```bash
python3 "$BOTFERENCE_HOME/tools/cli.py" visual_check_html '{"html_file":"path/to/file.html"}'
```

The tool writes screenshots and `report.json` under
`$BOTFERENCE_WORK_DIR/visual-checks/` by default. If Playwright is missing, the
result is not visually verified; report the missing dependency and ask the user
whether to install it.

For LaTeX artifacts, `.tex` is treated as visual work because the human output
is the generated PDF. A compile-only pass is structural, not visual. Before
claiming visual completion, compile the file with `compile_latex`, `pdflatex`,
`latexmk`, or `tectonic`, then inspect the rendered PDF with `view_pdf_page`,
a screenshot, or an equivalent PDF visual check.

## Inline Figures In Reading Documents

For prose documents, reports, essays, and thesis-style pages:

- Inline figures should be static SVG or PNG by default.
- Interactive Plotly, D3, Chart.js, or custom JS charts should be standalone
  deep-dive pages linked from captions or nearby text.
- Do not embed JS-driven charts inline unless the agent can browser-verify the
  layout at desktop and narrow widths.

## Batch Fixes

When fixing a reported visual issue, batch plausible fixes in one pass instead
of asking "is this fixed?" after every small adjustment. Then run the render
check again or clearly state that user review is needed.

## Permission Symmetry

Before assigning visual build/edit work to multiple agents, verify each
agent's writable roots. If an agent cannot write to the target directory, label
that agent as review/staging-only or request/grant access before work begins.
