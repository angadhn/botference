import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  copyToClipboard,
  getClipboardPath,
  osc52Sequence,
  tmuxPassthrough,
} from "./clipboard.js";

describe("Ink clipboard routing", () => {
  it("uses pbcopy on local macOS", () => {
    assert.equal(getClipboardPath({
      platform: "darwin",
      env: {},
    }), "native");
  });

  it("prefers tmux buffer inside tmux and OSC 52 over SSH", () => {
    assert.equal(getClipboardPath({
      platform: "darwin",
      env: { SSH_CONNECTION: "host", TMUX: "/tmp/tmux" },
    }), "tmux-buffer");
    assert.equal(getClipboardPath({
      platform: "darwin",
      env: { SSH_CONNECTION: "host" },
    }), "osc52");
  });

  it("builds OSC 52 and tmux passthrough sequences", () => {
    assert.equal(osc52Sequence("hi"), "\x1b]52;c;aGk=\x07");
    assert.equal(
      tmuxPassthrough("\x1b]52;c;aGk=\x07"),
      "\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\",
    );
  });

  it("logs copy diagnostics and writes tmux passthrough when tmux load succeeds", async () => {
    const writes: string[] = [];
    const spawns: Array<{ command: string; args: string[]; input: string }> = [];
    const result = await copyToClipboard("hello", {
      platform: "darwin",
      env: { TMUX: "/tmp/tmux" },
      logPath: null,
      writeStdout: (text) => writes.push(text),
      spawnFile: async (command, args, input) => {
        spawns.push({ command, args, input });
        return command === "pbcopy" || command === "tmux" ? 0 : 127;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.path, "tmux-buffer");
    assert.deepEqual(spawns.map((spawn) => spawn.command), ["pbcopy", "tmux"]);
    assert.equal(writes.length, 1);
    assert.ok(writes[0]!.startsWith("\x1bPtmux;"));
  });
});

