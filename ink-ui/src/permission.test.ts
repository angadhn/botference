import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  PERMISSION_CHOICES,
  PERMISSION_LABELS,
  cyclePermissionChoice,
  permissionChoiceForKey,
  permissionResponse,
} from "./permission.js";

describe("protected write prompt", () => {
  it("offers allow once, allow always and deny, in that order", () => {
    assert.deepEqual(
      PERMISSION_CHOICES.map((c) => PERMISSION_LABELS[c]),
      ["Allow once", "Allow always", "Deny"],
    );
  });

  it("Tab and arrows cycle through all three and wrap", () => {
    assert.equal(cyclePermissionChoice("once", 1), "always");
    assert.equal(cyclePermissionChoice("deny", 1), "once");
    assert.equal(cyclePermissionChoice("once", -1), "deny");
  });

  it("Y allows once, A always, N denies", () => {
    assert.equal(permissionChoiceForKey("y"), "once");
    assert.equal(permissionChoiceForKey("A"), "always");
    assert.equal(permissionChoiceForKey("n"), "deny");
    assert.equal(permissionChoiceForKey("x"), null);
  });

  it("allow always is sent as an allow carrying always", () => {
    assert.deepEqual(permissionResponse("r1", "always"), {
      type: "permission_response", request_id: "r1", allow: true, always: true,
    });
    assert.deepEqual(permissionResponse("r1", "once"), {
      type: "permission_response", request_id: "r1", allow: true,
    });
    assert.equal(permissionResponse("r1", "deny").allow, false);
  });
});
