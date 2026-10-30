"""The runtime boundary feeding council presence, without servers or CLIs."""
import asyncio

import pytest

from test_botference import _make_botference, _ok
from test_summon import MetaUI


@pytest.mark.asyncio
async def test_every_adapter_exit_emits_terminal_presence_with_verified_filing(tmp_path):
    controller, adapter, _, _ = _make_botference(tmp_path=tmp_path)
    project = controller.project_store.create_project("Filed project")
    lens = controller.project_store.create_project("Sidebar project")
    controller.active_project_id = lens.id
    # One lifecycle contract, exercised through success, returned failure,
    # raised failure, cancellation and timeout for both turns and builders.
    for model in ("claude", "agent"):
        for mode in ("success", "failure", "exception", "cancel", "timeout", "unknown", "fuzzy"):
            controller.session_project_id = (
                "missing" if mode == "unknown" else "filed" if mode == "fuzzy" else project.id
            )
            ui = MetaUI()
            previous_callback = object()
            adapter.stream_callback = previous_callback

            async def call():
                if mode == "exception":
                    raise ValueError("adapter failed")
                if mode == "cancel":
                    raise asyncio.CancelledError()
                if mode == "timeout":
                    await asyncio.Future()
                return _ok(exit_code=1 if mode == "failure" else 0)

            async def run():
                return await controller._run_adapter_streamed(
                    adapter, model, "room", ui, call,
                    extra={"agent": {"id": "build", "cli": "codex"}} if model == "agent" else None,
                )

            if mode == "exception":
                with pytest.raises(ValueError):
                    await run()
            elif mode == "cancel":
                with pytest.raises(asyncio.CancelledError):
                    await run()
            elif mode == "timeout":
                with pytest.raises(asyncio.TimeoutError):
                    await asyncio.wait_for(run(), timeout=0.01)
            else:
                await run()

            start, end = ui.stream_events
            assert (start["kind"], end["kind"]) == ("start", "done")
            assert start["stream_id"] == end["stream_id"]
            assert start["chat_id"] == end["chat_id"] == controller.session_id
            expected_project = None if mode in ("unknown", "fuzzy") else project.id
            assert start["project_id"] == end["project_id"] == expected_project
            assert start["project_association"] == ("session" if expected_project else "unknown")
            assert end["outcome"] == (
                "failed" if mode in ("failure", "exception") else
                "cancelled" if mode in ("cancel", "timeout") else "completed"
            )
            assert adapter.stream_callback is previous_callback
