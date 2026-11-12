import assert from "node:assert/strict";
import { test } from "node:test";
import { saveFailure } from "./save-failure";

test("a provider switch that could not be turned off names the provider", () => {
  assert.deepEqual(
    saveFailure("Request failed: EACCES: permission denied, open '/tmp/x/providers.json.0b1c-uuid.tmp' requestType=plugin.rpc.invoke.request code=handler_error", { kind: "switch", label: "Claude Sub", on: false }),
    { message: "Couldn’t turn off Claude Sub. Try again.", reload: false },
  );
});

test("a provider switch that could not be turned on names the provider", () => {
  assert.deepEqual(saveFailure("boom", { kind: "switch", label: "Codex", on: true }), {
    message: "Couldn’t turn on Codex. Try again.",
    reload: false,
  });
});

test("a named setting that could not be saved is named", () => {
  assert.deepEqual(saveFailure("boom", { kind: "named", name: "continue prompt" }), {
    message: "Couldn’t save the continue prompt. Try again.",
    reload: false,
  });
});

test("an unknown setting gets the generic message", () => {
  assert.deepEqual(saveFailure("boom", { kind: "unknown" }), {
    message: "Couldn’t save the setting. Try again.",
    reload: false,
  });
  assert.deepEqual(saveFailure(null, { kind: "unknown" }), {
    message: "Couldn’t save the setting. Try again.",
    reload: false,
  });
});

test("a revision conflict asks for a reload whatever was being saved", () => {
  const targets = [
    { kind: "switch", label: "Claude Sub", on: false },
    { kind: "named", name: "continue prompt" },
    { kind: "unknown" },
  ] as const;
  for (const target of targets) {
    assert.deepEqual(saveFailure("Settings changed on another client. Reload before saving again.", target), {
      message: "Settings changed elsewhere. Reload and try again.",
      reload: true,
    });
  }
  assert.deepEqual(saveFailure("Reload or reset settings before saving a different schema version", { kind: "unknown" }), {
    message: "Settings changed elsewhere. Reload and try again.",
    reload: true,
  });
});

test("the raw error never reaches the message", () => {
  const raw = "Request failed: EACCES: permission denied, open '/tmp/a/providers.json.3f2a9c1e-1111-2222-3333-444455556666.tmp' requestType=plugin.rpc.invoke.request code=handler_error";
  const targets = [
    { kind: "switch", label: "Claude Sub", on: false },
    { kind: "named", name: "continue prompt" },
    { kind: "unknown" },
  ] as const;
  for (const target of targets) {
    const { message } = saveFailure(raw, target);
    for (const fragment of ["EACCES", "/tmp", ".tmp", "3f2a9c1e", "requestType", "handler_error", "Request failed"]) {
      assert.equal(message.includes(fragment), false);
    }
  }
});
