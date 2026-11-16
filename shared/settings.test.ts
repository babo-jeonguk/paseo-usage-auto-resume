import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROVIDER_SETTINGS, isProviderOn, switchProvider, type ProviderSettings } from "./settings";

// A settings save replaces the whole stored document, so a provider switch must carry every other value.
test("turning a provider off or on keeps the background switch and the other providers", () => {
  const before: ProviderSettings = { disabledProviders: ["codex"], resumeBackground: true };
  const off = switchProvider(before, "claude", false);
  assert.deepEqual(off, { disabledProviders: ["claude", "codex"], resumeBackground: true });
  assert.equal(isProviderOn("claude", off), false);
  const on = switchProvider(off, "claude", true);
  assert.deepEqual(on, { disabledProviders: ["codex"], resumeBackground: true });
  assert.deepEqual(before, { disabledProviders: ["codex"], resumeBackground: true }, "the input is not changed");
});

test("switching a provider to the state it already has changes nothing", () => {
  const values: ProviderSettings = { ...DEFAULT_PROVIDER_SETTINGS, disabledProviders: ["codex"] };
  assert.deepEqual(switchProvider(values, "codex", false), values);
  assert.deepEqual(switchProvider(values, "claude", true), values);
});
