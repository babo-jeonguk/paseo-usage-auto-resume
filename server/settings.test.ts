import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROVIDER_SETTINGS, ProviderSettingsSchema, sourceForProvider } from "../shared/settings";

test("public defaults select only the standard Claude and Codex IDs", () => {
  assert.equal(sourceForProvider("claude", DEFAULT_PROVIDER_SETTINGS), "claude");
  assert.equal(sourceForProvider("codex", DEFAULT_PROVIDER_SETTINGS), "codex");
  for (const id of ["claude-main", "claude-sub", "codex-reserve"]) {
    assert.equal(sourceForProvider(id, DEFAULT_PROVIDER_SETTINGS), null);
  }
});

test("an explicit alias replaces the default and preserves its usage source", () => {
  const settings = ProviderSettingsSchema.parse({ claudeProvider: " claude-main ", codexProvider: "codex-work" });
  assert.equal(sourceForProvider("claude-main", settings), "claude");
  assert.equal(sourceForProvider("codex-work", settings), "codex");
  for (const id of ["claude", "claude-sub", "codex"]) assert.equal(sourceForProvider(id, settings), null);
});

test("invalid or ambiguous provider selections cannot be saved", () => {
  for (const claudeProvider of ["", "Claude", "claude/opus", "claude main", "codex"]) {
    assert.equal(ProviderSettingsSchema.safeParse({ claudeProvider }).success, false);
  }
});
