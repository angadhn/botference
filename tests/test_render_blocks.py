from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from render_blocks import build_tool_use_blocks, parse_render_blocks


class TestRenderBlocks:
    def test_parses_snippet_header_and_fenced_code(self):
        blocks = parse_render_blocks(
            "'core/botference.py' lines 400-402:\n\n```python\ndef parse_input(raw: str):\n    return raw\n```"
        )

        assert len(blocks) == 1
        block = blocks[0]
        assert block["type"] == "code"
        assert block["header"]["filePath"] == "core/botference.py"
        assert block["header"]["startLine"] == 400
        assert block["header"]["endLine"] == 402
        assert block["leadingBlankLines"] == 1
        assert block["language"] == "python"
        assert block["lines"] == [
            "def parse_input(raw: str):",
            "    return raw",
        ]

    def test_parses_diff_block_with_language_from_path(self):
        blocks = parse_render_blocks(
            "Edited in src/app.py (+1 -1)\n- def old_name(value):\n+ def new_name(value):"
        )

        assert len(blocks) == 1
        block = blocks[0]
        assert block["type"] == "diff"
        assert block["filePath"] == "src/app.py"
        assert block["language"] == "python"
        assert block["lines"] == [
            "Edited in src/app.py (+1 -1)",
            "- def old_name(value):",
            "+ def new_name(value):",
        ]

    def test_keeps_plain_text_as_text_block(self):
        blocks = parse_render_blocks("plain text\nsecond line")

        assert blocks == [{"type": "text", "lines": ["plain text", "second line"]}]

    def test_normalizes_common_fence_language_aliases(self):
        blocks = parse_render_blocks("```typescriptreact\nconst x = 1;\n```")

        assert len(blocks) == 1
        assert blocks[0]["type"] == "code"
        assert blocks[0]["language"] == "tsx"

    def test_builds_diff_block_from_edit_tool_input(self):
        blocks = build_tool_use_blocks(
            "Edit",
            {
                "file_path": "src/app.py",
                "old_string": "old_name = 1\n",
                "new_string": "new_name = 1\n",
            },
        )

        assert len(blocks) == 1
        block = blocks[0]
        assert block["type"] == "diff"
        assert block["filePath"] == "src/app.py"
        assert block["lines"] == [
            "Edited in src/app.py (+1 -1)",
            "@@ -1,1 +1,1 @@",
            "-old_name = 1",
            "+new_name = 1",
        ]

    def test_builds_code_block_from_write_tool_input(self):
        blocks = build_tool_use_blocks(
            "Write",
            {
                "file_path": "src/app.py",
                "content": "def parse_input(raw: str):\n    return raw\n",
            },
        )

        assert len(blocks) == 1
        block = blocks[0]
        assert block["type"] == "code"
        assert block["header"]["filePath"] == "src/app.py"
        assert block["header"]["startLine"] == 1
        assert block["header"]["endLine"] == 2
        assert block["language"] == "python"
        assert block["lines"] == [
            "def parse_input(raw: str):",
            "    return raw",
        ]
