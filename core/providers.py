"""
providers.py — Provider abstraction for Anthropic and OpenAI APIs.

Tool schemas stay in Anthropic format (canonical). Translation to OpenAI
format happens at call time inside this module.

Provider auto-detected from model name:
  claude-* → anthropic
  gpt-*/o1*/o3*/o4* → openai

OpenAI policy: only GPT-5.4 (high thinking) is supported. Other OpenAI
models technically work but are not recommended or tested.
"""

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

# model_catalog sits beside this file; make it importable however we were loaded
_CORE_DIR = str(Path(__file__).resolve().parent)
if _CORE_DIR not in sys.path:
    sys.path.insert(0, _CORE_DIR)
import model_catalog  # noqa: E402


# ── Response normalization ────────────────────────────────────

@dataclass
class ToolCall:
    id: str
    name: str
    input: dict


@dataclass
class LLMResponse:
    text_blocks: list[str] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    raw: object = None
    raw_content: list = field(default_factory=list)  # Anthropic content blocks, preserves server-side blocks


# ── Context windows ───────────────────────────────────────────

# Built-in table lives in model_catalog.py; this name stays for importers.
_CONTEXT_WINDOWS = model_catalog.builtin_context_windows()


def get_context_window(model: str) -> int:
    """Return context window size in tokens for the given model.

    Override with BOTFERENCE_CONTEXT_WINDOW env var (e.g. 1000000 for 1M plans).
    """
    import os
    override = os.environ.get("BOTFERENCE_CONTEXT_WINDOW", "")
    if override:
        try:
            return int(override)
        except ValueError:
            pass
    return model_catalog.context_window(model)




def percent_of_limit(input_tokens: int, output_tokens: int,
                     tool_result_est: int, context_window: int) -> float:
    """Projected next-turn usage as %% of yield limit. 100 = yield now.

    Threshold: 20%% for windows >= 1M tokens, 45%% for smaller windows.
    """
    threshold = 0.20 if context_window >= 1_000_000 else 0.45
    limit = context_window * threshold
    if limit <= 0:
        return 0.0
    projected = input_tokens + output_tokens + tool_result_est
    return (projected / limit) * 100
# ── Provider detection ────────────────────────────────────────

def detect_provider(model: str) -> str:
    """Detect provider from model name. Returns 'anthropic' or 'openai'."""
    if model.startswith("claude"):
        return "anthropic"
    if model.startswith(("gpt-", "o1", "o3", "o4")):
        return "openai"
    raise ValueError(
        f"Cannot detect provider for model '{model}'. "
        "Expected claude-*, gpt-*, o1*, o3*, or o4*."
    )


def _is_thinking_model(model: str) -> bool:
    """Check if model supports reasoning_effort (thinking mode)."""
    return model.startswith(("o1", "o3", "o4", "gpt-5", "gpt-6"))


def _is_reasoning_model(model: str) -> bool:
    """Check if model is an OpenAI o-series reasoning model."""
    return model.startswith(("o1", "o3", "o4"))


# ── Client creation ──────────────────────────────────────────

def create_client(provider: str):
    """Create an API client for the given provider."""
    if provider == "anthropic":
        return _create_anthropic_client()
    if provider == "openai":
        return _create_openai_client()
    raise ValueError(f"Unknown provider: {provider}")


def _create_anthropic_client():
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")

    # 1. Regular API key (sk-ant-api*) — use directly
    if api_key and not api_key.startswith("sk-ant-oat"):
        print("Auth: using ANTHROPIC_API_KEY (API key)", file=sys.stderr)
        return anthropic.Anthropic()

    # 2. OAuth tokens (sk-ant-oat*) from env or keychain do NOT work with
    #    the Anthropic API directly. Claude Code uses an internal SDK
    #    integration that botference_agent.py cannot replicate.
    #    Users need a real API key from console.anthropic.com.
    if api_key and api_key.startswith("sk-ant-oat"):
        raise RuntimeError(
            "ANTHROPIC_API_KEY contains an OAuth token (sk-ant-oat*), which cannot be "
            "used with the Anthropic API directly. botference_agent.py requires a regular "
            "API key (sk-ant-api*) from console.anthropic.com.\n"
            "  Note: botference -p detects this automatically and falls back to "
            "claude -p, so this error only appears when invoking botference_agent.py directly.\n"
            "  Alternatively, use interactive mode (no -p flag) which routes through "
            "the claude CLI and supports OAuth natively."
        )

    # 3. Check macOS keychain — if only OAuth token is available, explain the limitation
    try:
        creds = _keychain_json("Claude Code", ["-s", "Claude Code-credentials"])
        if creds is not None:
            token = (creds.get("claudeAiOauth") or {}).get("accessToken")
            if token:
                raise RuntimeError(
                    "Found Claude Code OAuth token in keychain, but OAuth tokens cannot "
                    "be used with the Anthropic API directly. botference_agent.py requires a "
                    "regular API key (sk-ant-api*) from console.anthropic.com.\n"
                    "  Note: botference -p detects this automatically and falls back to "
                    "claude -p, so this error only appears when invoking botference_agent.py directly.\n"
                    "  Set: export ANTHROPIC_API_KEY=sk-ant-api03-...\n"
                    "  Or use interactive mode (no -p flag) which supports OAuth natively."
                )
    except RuntimeError:
        raise
    except Exception as e:
        print(f"Auth: reading the Claude Code keychain entry failed "
              f"({type(e).__name__}); skipped.", file=sys.stderr)

    raise RuntimeError(
        "No Anthropic auth found. Set ANTHROPIC_API_KEY (sk-ant-api* from "
        "console.anthropic.com) or use interactive mode (no -p flag) with `claude login`.\n"
        "  Note: botference -p automatically falls back to claude -p when no API key "
        "is set, so this error only appears when invoking botference_agent.py directly."
    )


# Seconds the macOS keychain lookup may take (it can stall behind an unlock
# prompt) before it is given up on.
_KEYCHAIN_TIMEOUT = 10


def _keychain_json(what: str, args: list) -> "dict | None":
    """Read a JSON secret from the macOS keychain, or None.

    Nothing stored is the ordinary answer and says nothing. A lookup that
    hangs, fails or holds something unreadable says so in one line on the
    error stream; the secret itself is never printed.
    """
    try:
        result = subprocess.run(
            ["security", "find-generic-password", *args, "-w"],
            capture_output=True, text=True, timeout=_KEYCHAIN_TIMEOUT,
        )
    except FileNotFoundError:
        return None  # no keychain on this system
    except subprocess.TimeoutExpired:
        print(f"Auth: the keychain lookup for {what} did not answer within "
              f"{_KEYCHAIN_TIMEOUT} seconds; skipped.", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Auth: the keychain lookup for {what} failed "
              f"({type(e).__name__}); skipped.", file=sys.stderr)
        return None
    if result.returncode != 0:
        return None
    try:
        creds = json.loads(result.stdout.strip())
    except ValueError:
        print(f"Auth: the keychain entry for {what} is not in the expected "
              "form; skipped.", file=sys.stderr)
        return None
    return creds if isinstance(creds, dict) else None


def _create_openai_client():
    try:
        import openai
    except ImportError:
        raise ImportError(
            "OpenAI support requires the openai package. Install it with: pip install openai"
        )

    # 1. Explicit API key takes priority
    api_key = os.environ.get("OPENAI_API_KEY")
    if api_key:
        print("Auth: using OPENAI_API_KEY", file=sys.stderr)
        return openai.OpenAI(api_key=api_key)

    # 2. Try Codex CLI auth file (~/.codex/auth.json)
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    auth_file = codex_home / "auth.json"
    if auth_file.exists():
        try:
            creds = json.loads(auth_file.read_text())
            # API key mode
            if creds.get("openai_api_key"):
                print("Auth: using Codex CLI API key from ~/.codex/auth.json", file=sys.stderr)
                return openai.OpenAI(api_key=creds["openai_api_key"])
            # ChatGPT OAuth mode
            token = (creds.get("tokens") or {}).get("access_token")
            if token:
                print("Auth: using Codex CLI OAuth token from ~/.codex/auth.json", file=sys.stderr)
                return openai.OpenAI(api_key=token)
        except (json.JSONDecodeError, OSError):
            pass

    # 3. Try Codex CLI keychain (macOS, service "Codex Auth")
    try:
        import hashlib
        codex_canonical = str(codex_home.resolve())
        account_hash = hashlib.sha256(codex_canonical.encode()).hexdigest()[:16]
        account_key = f"cli|{account_hash}"
        creds = _keychain_json("Codex", ["-s", "Codex Auth", "-a", account_key])
        if creds is not None:
            if creds.get("openai_api_key"):
                print("Auth: using Codex CLI API key from keychain", file=sys.stderr)
                return openai.OpenAI(api_key=creds["openai_api_key"])
            token = (creds.get("tokens") or {}).get("access_token")
            if token:
                print("Auth: using Codex CLI OAuth token from keychain", file=sys.stderr)
                return openai.OpenAI(api_key=token)
    except Exception as e:
        print(f"Auth: reading the Codex keychain entry failed "
              f"({type(e).__name__}); skipped.", file=sys.stderr)

    raise RuntimeError(
        "No OpenAI auth found. Either:\n"
        "  - Set OPENAI_API_KEY, or\n"
        "  - Run `codex login` (reads ~/.codex/auth.json or macOS keychain)"
    )


# ── Tool schema translation ──────────────────────────────────

def _anthropic_tools_to_openai(tools: list[dict]) -> list[dict]:
    """Convert Anthropic tool schemas to OpenAI function-calling format."""
    openai_tools = []
    for tool in tools:
        openai_tools.append({
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {"type": "object", "properties": {}}),
            },
        })
    return openai_tools


# ── API call + response normalization ─────────────────────────

def call_model(client, provider: str, model: str, system_prompt: str,
               tools: list[dict], messages: list[dict],
               max_tokens: int, effort: str = None) -> LLMResponse:
    """Call the model and return a normalized LLMResponse."""
    if provider == "anthropic":
        return _call_anthropic(client, model, system_prompt, tools, messages, max_tokens, effort)
    if provider == "openai":
        return _call_openai(client, model, system_prompt, tools, messages, max_tokens)
    raise ValueError(f"Unknown provider: {provider}")


def _call_anthropic(client, model, system_prompt, tools, messages, max_tokens, effort=None):
    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system_prompt,
        "tools": tools,
        "messages": messages,
    }
    if effort:
        kwargs["thinking"] = {"type": "adaptive"}
        kwargs["output_config"] = {"effort": effort}
    response = client.messages.create(**kwargs)

    text_blocks = []
    tool_calls = []
    for block in response.content:
        if block.type == "text":
            text_blocks.append(block.text)
        elif block.type == "tool_use":
            tool_calls.append(ToolCall(id=block.id, name=block.name, input=block.input))

    return LLMResponse(
        text_blocks=text_blocks,
        tool_calls=tool_calls,
        input_tokens=response.usage.input_tokens,
        output_tokens=response.usage.output_tokens,
        cache_creation_input_tokens=getattr(response.usage, 'cache_creation_input_tokens', 0) or 0,
        cache_read_input_tokens=getattr(response.usage, 'cache_read_input_tokens', 0) or 0,
        raw=response,
        raw_content=list(response.content),
    )


def _call_openai(client, model, system_prompt, tools, messages, max_tokens):
    # Build OpenAI messages: system prompt + converted conversation
    oai_messages = [{"role": "system", "content": system_prompt}]
    oai_messages.extend(_convert_messages_to_openai(messages))

    oai_tools = _anthropic_tools_to_openai(tools) if tools else None

    kwargs = {
        "model": model,
        "messages": oai_messages,
    }
    if oai_tools:
        kwargs["tools"] = oai_tools

    # Thinking models use max_completion_tokens + reasoning_effort
    if _is_thinking_model(model):
        kwargs["max_completion_tokens"] = max_tokens
        kwargs["reasoning_effort"] = "high"
    elif _is_reasoning_model(model):
        kwargs["max_completion_tokens"] = max_tokens
    else:
        kwargs["max_tokens"] = max_tokens

    response = client.chat.completions.create(**kwargs)
    msg = response.choices[0].message

    text_blocks = [msg.content] if msg.content else []
    tool_calls = []
    if msg.tool_calls:
        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments)
            except (json.JSONDecodeError, TypeError):
                args = {"raw_arguments": tc.function.arguments}
            tool_calls.append(ToolCall(id=tc.id, name=tc.function.name, input=args))

    return LLMResponse(
        text_blocks=text_blocks,
        tool_calls=tool_calls,
        input_tokens=getattr(response.usage, 'prompt_tokens', 0) or 0,
        output_tokens=getattr(response.usage, 'completion_tokens', 0) or 0,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
        raw=response,
    )


def _convert_messages_to_openai(messages: list[dict]) -> list[dict]:
    """Convert Anthropic-format conversation messages to OpenAI format."""
    oai_messages = []
    for msg in messages:
        role = msg["role"]
        content = msg["content"]

        if role == "assistant":
            # Anthropic: content is list of blocks (text/tool_use)
            # OpenAI: content is string, tool_calls is separate
            if isinstance(content, list):
                text_parts = []
                tool_calls = []
                for block in content:
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            text_parts.append(block["text"])
                        elif block.get("type") == "tool_use":
                            tool_calls.append({
                                "id": block["id"],
                                "type": "function",
                                "function": {
                                    "name": block["name"],
                                    "arguments": json.dumps(block["input"]),
                                },
                            })
                    else:
                        # Anthropic SDK response objects
                        block_type = getattr(block, "type", None)
                        if block_type == "text":
                            text_parts.append(block.text)
                        elif block_type == "tool_use":
                            tool_calls.append({
                                "id": block.id,
                                "type": "function",
                                "function": {
                                    "name": block.name,
                                    "arguments": json.dumps(block.input),
                                },
                            })

                oai_msg = {"role": "assistant", "content": "\n".join(text_parts) or None}
                if tool_calls:
                    oai_msg["tool_calls"] = tool_calls
                oai_messages.append(oai_msg)
            else:
                oai_messages.append({"role": "assistant", "content": content})

        elif role == "user":
            # Anthropic tool results: [{"type": "tool_result", ...}]
            if isinstance(content, list) and content and isinstance(content[0], dict) and content[0].get("type") == "tool_result":
                for tr in content:
                    raw_content = tr.get("content", "")
                    if isinstance(raw_content, list):
                        text_parts = [b["text"] for b in raw_content if isinstance(b, dict) and b.get("type") == "text"]
                        oai_content = "\n".join(text_parts) if text_parts else "(image content)"
                    else:
                        oai_content = raw_content
                    oai_messages.append({
                        "role": "tool",
                        "tool_call_id": tr["tool_use_id"],
                        "content": oai_content,
                    })
            else:
                oai_messages.append({"role": "user", "content": content})

    return oai_messages


# ── Message formatting (for conversation history) ────────────

def format_assistant_message(provider: str, response: LLMResponse) -> dict:
    """Format the LLM response as an assistant message for conversation history.

    Returns Anthropic-format messages regardless of provider — botference_agent.py
    keeps its conversation in Anthropic format; translation happens in call_model.

    For Anthropic responses with raw_content, we serialize the SDK objects directly
    to preserve server-side blocks (server_tool_use, web_search_tool_result, etc.).
    """
    # Anthropic path: preserve all content blocks including server-side ones
    if response.raw_content:
        content = []
        for block in response.raw_content:
            if hasattr(block, 'model_dump'):
                content.append(block.model_dump())
            elif isinstance(block, dict):
                content.append(block)
            else:
                # Fallback: serialize known block types
                content.append({"type": getattr(block, 'type', 'unknown')})
        return {"role": "assistant", "content": content}

    # OpenAI path (or no raw_content): reconstruct from text_blocks + tool_calls
    content = []
    for text in response.text_blocks:
        content.append({"type": "text", "text": text})
    for tc in response.tool_calls:
        content.append({"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.input})
    return {"role": "assistant", "content": content}


def format_tool_results(provider: str, results: list[dict]) -> dict:
    """Format tool results as a user message for conversation history.

    Returns Anthropic-format regardless of provider.
    """
    return {"role": "user", "content": results}


# ── Error classes for retry logic ─────────────────────────────

def get_transient_errors(provider: str) -> tuple:
    """Return tuple of exception classes considered transient for retry."""
    if provider == "anthropic":
        import anthropic
        return (anthropic.RateLimitError, anthropic.APIConnectionError)
    if provider == "openai":
        import openai
        return (openai.RateLimitError, openai.APIConnectionError)
    return ()


def get_status_error_class(provider: str):
    """Return the APIStatusError class for the provider."""
    if provider == "anthropic":
        import anthropic
        return anthropic.APIStatusError
    if provider == "openai":
        import openai
        return openai.APIStatusError
    return None
