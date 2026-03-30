"""Compatibility shim for legacy check/citation tool imports."""

from tools._paths import scripts_dir as _scripts_dir
from tools.check_language import TOOLS as _language_tools
from tools.check_journal import TOOLS as _journal_tools
from tools.check_figure import TOOLS as _figure_tools
from tools.citations import TOOLS as _citation_tools


TOOLS = {}
TOOLS.update(_language_tools)
TOOLS.update(_journal_tools)
TOOLS.update(_figure_tools)
TOOLS.update(_citation_tools)
