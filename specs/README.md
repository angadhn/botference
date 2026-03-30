> [!NOTE]
> This README was AI-generated. I (Angadh) have not manually authored this nor checked it.

# specs/

Quality standards and output format templates. Agents read these during their workflows so the agent prompts stay short. Verbose examples live in `templates/`.

## Quality standards

- `writing-style.md` — anti-LLM-speak rules
- `grading-rubric.md` — paper scoring for scout
- `publication-requirements.md` — target journal constraints
- `banned-phrases.txt` — prohibited phrases for check_language.py
- `reflection-template.md` — loop self-assessment structure
- `evidence-format.md` — evidence-ledger JSONL schema (claim, source_key, confidence)

## Output format specs (one per agent)

- `scout-output-format.md`
- `triage-output-format.md`
- `deep-reader-output-format.md`
- `critic-output-format.md`
- `provocateur-output-format.md`
- `synthesizer-output-format.md`
- `paper-writer-output-format.md`
- `editor-output-format.md`
- `coherence-reviewer-output-format.md`
- `research-coder-output-format.md`
- `figure-stylist-output-format.md`
