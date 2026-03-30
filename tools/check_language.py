"""Language quality checks for LaTeX and Markdown content."""

import io
import re
import statistics
import sys
from pathlib import Path


def _is_markdown(filepath: str) -> bool:
    """Detect if a file is Markdown based on extension."""
    return Path(filepath).suffix.lower() in (".md", ".markdown", ".mdown", ".mkd")


def strip_latex_commands(text: str) -> str:
    """Remove LaTeX commands but keep text content."""
    text = re.sub(r"%.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\\(begin|end)\{[^}]*\}", "", text)
    text = re.sub(
        r"\\begin\{(figure|table|equation|align|tabular|longtable)\*?\}.*?\\end\{\1\*?\}",
        "",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(r"\\(?!cite)[a-zA-Z]+\*?(?:\[[^\]]*\])*\{([^}]*)\}", r"\1", text)
    text = re.sub(r"\\[a-zA-Z]+\*?", "", text)
    text = re.sub(r"[{}]", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_body(latex_content: str) -> str:
    """Extract content between \\begin{document} and \\end{document}."""
    match = re.search(r"\\begin\{document\}(.*?)\\end\{document\}", latex_content, re.DOTALL)
    if match:
        return match.group(1)
    return latex_content


def split_sections(body: str) -> list:
    """Split LaTeX body into sections, returning (section_name, content) pairs."""
    pattern = r"\\(?:section|subsection|subsubsection)\{([^}]*)\}"
    parts = re.split(pattern, body)
    sections = []
    if parts[0].strip():
        sections.append(("Preamble", parts[0]))
    for i in range(1, len(parts), 2):
        name = parts[i] if i < len(parts) else "Unknown"
        content = parts[i + 1] if i + 1 < len(parts) else ""
        sections.append((name, content))
    return sections


def strip_markdown_formatting(text: str) -> str:
    """Remove markdown formatting but keep text content."""
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]+`", "", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*{1,3}([^*]+)\*{1,3}", r"\1", text)
    text = re.sub(r"_{1,3}([^_]+)_{1,3}", r"\1", text)
    text = re.sub(r"^[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_markdown_body(content: str) -> str:
    """Extract body content, stripping YAML frontmatter if present."""
    if content.startswith("---"):
        match = re.match(r"^---\s*\n.*?\n---\s*\n", content, re.DOTALL)
        if match:
            return content[match.end():]
    return content


def split_markdown_sections(body: str) -> list:
    """Split markdown body into sections by headers."""
    pattern = r"^(#{1,3})\s+(.+)$"
    parts = re.split(pattern, body, flags=re.MULTILINE)
    sections = []
    if parts[0].strip():
        sections.append(("Preamble", parts[0]))
    for i in range(1, len(parts), 3):
        name = parts[i + 1] if i + 1 < len(parts) else "Unknown"
        content = parts[i + 2] if i + 2 < len(parts) else ""
        sections.append((name, content))
    return sections


def split_paragraphs(text: str) -> list:
    """Split text into paragraphs (separated by blank lines)."""
    paras = re.split(r"\n\s*\n", text)
    return [p.strip() for p in paras if p.strip() and len(p.strip()) > 50]


def split_sentences(text: str, is_md: bool = False) -> list:
    """Split text into sentences (simple heuristic)."""
    if is_md:
        clean = re.sub(r"\[(?:[^\]]*@[^\]]+)\]", "", text)
    else:
        clean = re.sub(r"\\cite\{[^}]*\}", "", text)
        clean = re.sub(r"~", " ", clean)
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z])", clean)
    return [s.strip() for s in sentences if len(s.strip()) > 10]


STOCK_FRAMINGS = [
    (r"[Ii]n recent years,?\s+there has been", "Stock framing: 'In recent years, there has been...'"),
    (r"[Ii]t is well known that", "Stock framing: 'It is well known that...'"),
    (r"[Tt]his represents a promising", "Stock framing: 'This represents a promising...'"),
    (r"[Ff]urther research is needed to", "Stock framing: 'Further research is needed to...'"),
    (r"plays a crucial role in", "Stock framing: 'plays a crucial role in...'"),
    (r"has attracted significant attention", "Stock framing: 'has attracted significant attention'"),
    (r"offers? a compelling alternative", "Stock framing: 'offers a compelling alternative'"),
    (r"remains? an active area of research", "Stock framing: 'remains an active area of research'"),
    (r"address(?:es|ing)? critical limitations?", "Stock framing: 'addresses critical limitations'"),
    (r"paving the way for", "Stock framing: 'paving the way for...'"),
    (r"[Tt]here (?:has been|is) (?:a )?growing interest", "Stock framing: 'There is growing interest...'"),
    (r"[Rr]ecent advances have (?:made|shown|demonstrated)", "Stock framing: 'Recent advances have...'"),
    (
        r"has (?:gained|received) (?:considerable|significant|increasing) attention",
        "Stock framing: 'has gained considerable attention'",
    ),
    (r"represents? a paradigm shift", "Stock framing: 'represents a paradigm shift'"),
    (r"[Ii]t is (?:worth noting|important to note) that", "Stock framing: 'It is worth noting that...'"),
    (r"has (?:emerged|become) as a (?:key|critical|vital|important)", "Stock framing: 'has emerged as a key...'"),
]

BALANCED_CLAUSE_PATTERNS = [
    r"[Ww]hile\s+[^,]{10,},\s+[^.]{10,}\.",
    r"[Aa]lthough\s+[^,]{10,},\s+[^.]{10,}\.",
    r"[Oo]n (?:the )?one hand[^.]*[Oo]n the other hand",
]


def check_citation_density(paragraphs: list, section_name: str, is_md: bool = False) -> list:
    """Check that paragraphs containing factual claims have inline citations."""
    issues = []
    for i, para in enumerate(paragraphs):
        if len(para) < 100:
            continue

        if is_md:
            if para.count("\n- ") > 2 or para.count("|") > 3:
                continue
            cite_count = len(re.findall(r"\[(?:[^\]]*@[^\]]+)\]", para))
        else:
            if para.count("\\item") > 2 or para.count("&") > 3:
                continue
            cite_count = len(re.findall(r"\\cite\{[^}]*\}", para))

        if cite_count == 0:
            strip_fn = strip_markdown_formatting if is_md else strip_latex_commands
            sentences = split_sentences(strip_fn(para), is_md=is_md)
            if len(sentences) >= 2:
                issues.append(
                    {
                        "type": "error",
                        "check": "citation_density",
                        "section": section_name,
                        "paragraph": i + 1,
                        "message": f"Paragraph {i+1} in '{section_name}' has {len(sentences)} sentences but zero citations",
                        "preview": para[:120].replace("\n", " ") + "...",
                    }
                )
    return issues


def check_sentence_length_variance(paragraphs: list, section_name: str, is_md: bool = False) -> list:
    """Check that sentence lengths within paragraphs vary enough."""
    issues = []
    strip_fn = strip_markdown_formatting if is_md else strip_latex_commands
    for i, para in enumerate(paragraphs):
        clean_para = strip_fn(para)
        sentences = split_sentences(clean_para, is_md=is_md)
        if len(sentences) < 3:
            continue

        word_counts = [len(s.split()) for s in sentences]
        try:
            stdev = statistics.stdev(word_counts)
            mean = statistics.mean(word_counts)
        except statistics.StatisticsError:
            continue

        if mean > 0 and stdev / mean < 0.25:
            issues.append(
                {
                    "type": "warning",
                    "check": "sentence_variance",
                    "section": section_name,
                    "paragraph": i + 1,
                    "message": (
                        f"Low sentence length variance in '{section_name}' paragraph {i+1}: "
                        f"mean={mean:.1f} words, stdev={stdev:.1f} (ratio={stdev/mean:.2f}, want >=0.25)"
                    ),
                    "lengths": word_counts,
                }
            )
    return issues


def check_stock_framings(text: str, section_name: str) -> list:
    """Check for known LLM stock framing patterns."""
    issues = []
    for pattern, description in STOCK_FRAMINGS:
        matches = list(re.finditer(pattern, text))
        for match in matches:
            line_num = text[: match.start()].count("\n") + 1
            issues.append(
                {
                    "type": "warning",
                    "check": "stock_framing",
                    "section": section_name,
                    "line": line_num,
                    "message": f"{description} (line ~{line_num} in '{section_name}')",
                    "match": match.group(0),
                }
            )
    return issues


def check_balanced_clauses(text: str, section_name: str) -> list:
    """Check for excessive While X, Y / Although X, Y balanced clauses."""
    issues = []
    total_matches = 0
    for pattern in BALANCED_CLAUSE_PATTERNS:
        matches = re.findall(pattern, text)
        total_matches += len(matches)

    if total_matches > 2:
        issues.append(
            {
                "type": "warning",
                "check": "balanced_clauses",
                "section": section_name,
                "message": (
                    f"Section '{section_name}' has {total_matches} balanced "
                    "'While/Although X, Y' clauses (max 2 recommended)"
                ),
            }
        )
    return issues


def check_citation_free_generalizations(text: str, section_name: str, is_md: bool = False) -> list:
    """Check for generalizations that should have citations."""
    patterns = [
        (r"[Ii]t is (?:well )?known that [^.]*\.", "Citation-free generalization: 'It is known that...'"),
        (r"[Ss]tudies have shown that [^.]*\.", "Citation-free generalization: 'Studies have shown...'"),
        (
            r"[Rr]esearch(?:ers)? ha(?:s|ve) demonstrated [^.]*\.",
            "Citation-free generalization: 'Research has demonstrated...'",
        ),
        (r"[Ss]everal (?:studies|papers|works|authors) [^.]*\.", "Citation-free generalization: 'Several studies...'"),
        (
            r"[Aa]s (?:many|several|numerous) (?:studies|researchers) have (?:shown|noted|observed)",
            "Citation-free generalization: 'As many studies have shown...'",
        ),
    ]

    cite_token = "@" if is_md else "\\cite"

    issues = []
    for pattern, description in patterns:
        for match in re.finditer(pattern, text):
            end_pos = match.end()
            nearby = text[max(0, match.start() - 10) : min(len(text), end_pos + 30)]
            if cite_token not in nearby:
                line_num = text[: match.start()].count("\n") + 1
                issues.append(
                    {
                        "type": "error",
                        "check": "citation_free_generalization",
                        "section": section_name,
                        "line": line_num,
                        "message": f"{description} without citation (line ~{line_num} in '{section_name}')",
                        "match": match.group(0)[:80],
                    }
                )
    return issues


def check_file(filepath: str, strict: bool = False, verbose: bool = False) -> bool:
    """Run all checks on a LaTeX or Markdown file. Returns True if pass."""
    path = Path(filepath)
    if not path.exists():
        print(f"Error: {filepath} not found", file=sys.stderr)
        return False

    content = path.read_text(encoding="utf-8")
    is_md = _is_markdown(filepath)

    if is_md:
        body = extract_markdown_body(content)
        sections = split_markdown_sections(body)
    else:
        body = extract_body(content)
        sections = split_sections(body)

    all_issues = []

    for section_name, section_content in sections:
        paragraphs = split_paragraphs(section_content)
        all_issues.extend(check_citation_density(paragraphs, section_name, is_md=is_md))
        all_issues.extend(check_sentence_length_variance(paragraphs, section_name, is_md=is_md))
        all_issues.extend(check_stock_framings(section_content, section_name))
        all_issues.extend(check_balanced_clauses(section_content, section_name))
        all_issues.extend(check_citation_free_generalizations(section_content, section_name, is_md=is_md))

    errors = [i for i in all_issues if i["type"] == "error"]
    warnings = [i for i in all_issues if i["type"] == "warning"]

    if errors:
        print(f"\n{'='*60}")
        print(f"ERRORS ({len(errors)}):")
        print(f"{'='*60}")
        for issue in errors:
            print(f"  [{issue['check']}] {issue['message']}")
            if "preview" in issue:
                print(f"    Preview: {issue['preview']}")
            if "match" in issue:
                print(f"    Match: \"{issue['match']}\"")

    if warnings:
        print(f"\n{'='*60}")
        print(f"WARNINGS ({len(warnings)}):")
        print(f"{'='*60}")
        for issue in warnings:
            print(f"  [{issue['check']}] {issue['message']}")
            if "lengths" in issue:
                print(f"    Sentence lengths: {issue['lengths']}")
            if "match" in issue:
                print(f"    Match: \"{issue['match']}\"")

    if not errors and not warnings:
        print(f"\nAll checks passed for {filepath}")

    print(f"\n{'='*60}")
    print(f"Summary: {len(errors)} errors, {len(warnings)} warnings")
    print(f"{'='*60}")

    if errors:
        print("FAIL: Fix errors before committing.")
        return False
    if warnings and strict:
        print("FAIL (strict mode): Fix warnings before committing.")
        return False
    if warnings:
        print("PASS with warnings. Consider fixing before committing.")
        return True

    print("PASS")
    return True


def _handle_check_language(inp):
    """Run language checks directly (no subprocess)."""
    buf = io.StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    sys.stdout = buf
    sys.stderr = buf
    try:
        check_file(inp["file_path"], strict=inp.get("strict", False))
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
    output = buf.getvalue()
    return output if output.strip() else "(no output)"


TOOLS = {
    "check_language": {
        "name": "check_language",
        "description": (
            "Check a LaTeX or Markdown file for citation density, sentence length variance, "
            "stock framings, balanced clauses, and citation-free generalizations. "
            "Returns PASS/FAIL with specific violations."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to the LaTeX or Markdown file to check"},
                "strict": {"type": "boolean", "description": "Fail on warnings too (default false)"},
            },
            "required": ["file_path"],
        },
        "function": _handle_check_language,
    },
}
