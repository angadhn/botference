#!/usr/bin/env python3
"""Fallback agent runner — MCP server exposing botference's per-agent tool registry.

Usage: python3 core/fallback_agent_mcp.py <agent_name> [--cwd <dir>]

This is the fallback execution path used when no API key is available.
It wraps the tool registry as an MCP stdio server so that `claude -p
--mcp-config <config>` can call botference's tools natively — preserving
truncation, redaction, and per-agent tool boundaries.

Peer of botference_agent.py (the primary agent runner that calls the
Anthropic/OpenAI API directly).

Server-side tools (e.g. web_search) are skipped — Claude handles those
internally.
"""

import asyncio
import sys
import os

# Ensure botference's root is on the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from tools import TOOLS, AGENT_TOOLS, DEFAULT_TOOLS, SERVER_TOOLS, execute_tool, get_tools_for_agent

_LOG_FILE = os.environ.get("BOTFERENCE_MCP_LOG", "")


def _log(msg: str):
    if _LOG_FILE:
        with open(_LOG_FILE, "a") as f:
            f.write(f"[MCP] {msg}\n")


def build_server(agent_name: str) -> Server:
    """Create an MCP server with tools scoped to the given agent."""
    # Use get_tools_for_agent which checks hardcoded registry first,
    # then parses ## Tools from the agent's .md file for custom agents.
    tool_names, _ = get_tools_for_agent(agent_name)

    # Filter to client-side tools that exist in the registry
    active_tools = [n for n in tool_names if n in TOOLS and n not in SERVER_TOOLS]

    server = Server(f"botference-{agent_name}")

    @server.list_tools()
    async def list_tools():
        return [
            Tool(
                name=name,
                description=TOOLS[name].get("description", ""),
                inputSchema=TOOLS[name].get("input_schema", {
                    "type": "object", "properties": {}
                }),
            )
            for name in active_tools
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict):
        _log(f"tool_call: {name} args={arguments}")
        result = execute_tool(name, arguments)
        _log(f"tool_done: {name} result_len={len(str(result))}")
        return [TextContent(type="text", text=str(result))]

    return server


async def main():
    if len(sys.argv) < 2:
        print("Usage: python3 core/fallback_agent_mcp.py <agent_name> [--cwd <dir>]", file=sys.stderr)
        sys.exit(1)

    agent_name = sys.argv[1]

    # Optional --cwd flag: change working directory so file tools
    # resolve paths relative to a worktree, not the main project.
    if "--cwd" in sys.argv:
        cwd_idx = sys.argv.index("--cwd")
        if cwd_idx + 1 < len(sys.argv):
            target_cwd = sys.argv[cwd_idx + 1]
            os.chdir(target_cwd)
            _log(f"cwd changed to {target_cwd}")

    server = build_server(agent_name)

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, write_stream,
            server.create_initialization_options(),
        )


if __name__ == "__main__":
    asyncio.run(main())
