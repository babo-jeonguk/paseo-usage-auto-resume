import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoApi } from "./paseo-types";
import { cliFor } from "./providers";
import { DEFAULT_PROVIDER_SETTINGS, DEFAULT_RESUME_SETTINGS, isProviderOn, PROMPT_MAX_CHARS, providerSettings, ProviderSettingsSchema, ResumeSettingsSchema } from "../shared/settings";

type DaemonConfig = Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"];

const migrate = (values: unknown, fromVersion: number) => providerSettings.migrate!(values, fromVersion);

test("every provider is on until it is turned off", () => {
  for (const id of ["claude", "claude-main", "codex", "codex-reserve", "antigravity"]) {
    assert.equal(isProviderOn(id, DEFAULT_PROVIDER_SETTINGS), true);
  }
  const settings = ProviderSettingsSchema.parse({ disabledProviders: ["codex-reserve"] });
  assert.equal(isProviderOn("codex-reserve", settings), false);
  assert.equal(isProviderOn("codex", settings), true);
});

test("a damaged provider list cannot be stored", () => {
  for (const disabledProviders of [null, "codex", [""], [1], [null]]) {
    assert.equal(ProviderSettingsSchema.safeParse({ disabledProviders }).success, false);
  }
});

test("a host upgrading from one ID per CLI starts with every provider on", async () => {
  const selections = [
    {},
    { claudeProvider: "claude-main", codexProvider: "codex" },
    { claudeProvider: "claude-main", codexProvider: "codex-work", antigravityProvider: "antigravity-fast" },
  ];
  for (const values of selections) {
    assert.deepEqual(ProviderSettingsSchema.parse(await migrate(values, 1)), DEFAULT_PROVIDER_SETTINGS);
  }
});

test("a damaged version 1 file or an unknown version stays unreadable", async () => {
  for (const values of [null, "claude", { claudeProvider: "Claude" }, { claudeProvider: "codex" }, { codexProvider: 3 }]) {
    await assert.rejects(async () => migrate(values, 1));
  }
  await assert.rejects(async () => migrate({}, 0));
});

test("the continue prompt is the built-in one until the user saves their own", () => {
  assert.deepEqual(DEFAULT_RESUME_SETTINGS, { continuePrompt: null, overloadRetry: false });
  assert.deepEqual(ResumeSettingsSchema.parse({ continuePrompt: null, overloadRetry: false }), { continuePrompt: null, overloadRetry: false });
});

test("a saved prompt is trimmed, and a blank or overlong one cannot be stored", () => {
  assert.deepEqual(ResumeSettingsSchema.parse({ continuePrompt: "  Keep going.\n" }), { continuePrompt: "Keep going.", overloadRetry: false });
  assert.equal(ResumeSettingsSchema.parse({ continuePrompt: "x".repeat(PROMPT_MAX_CHARS) }).continuePrompt?.length, PROMPT_MAX_CHARS);
  for (const continuePrompt of ["", "   \n ", "x".repeat(PROMPT_MAX_CHARS + 1), 3]) {
    assert.equal(ResumeSettingsSchema.safeParse({ continuePrompt }).success, false);
  }
});

test("a provider's CLI is found by following extends to a supported built-in", () => {
  const config = {
    providers: {
      "claude-main": { extends: "claude" },
      "claude-deep": { extends: "claude-main" },
      "codex-reserve": { extends: "codex" },
      "opencode-work": { extends: "opencode" },
      loop: { extends: "loop-back" },
      "loop-back": { extends: "loop" },
    },
  } as unknown as DaemonConfig;
  assert.equal(cliFor(config, "claude"), "claude");
  assert.equal(cliFor(config, "antigravity"), "antigravity");
  assert.equal(cliFor(config, "claude-deep"), "claude");
  assert.equal(cliFor(config, "codex-reserve"), "codex");
  for (const id of ["opencode", "opencode-work", "loop", "claude-unknown"]) assert.equal(cliFor(config, id), null);
});


test("legacy resume settings leave Labs off, and only a boolean can enable it", () => {
  assert.equal(ResumeSettingsSchema.parse({ continuePrompt: null }).overloadRetry, false);
  assert.equal(ResumeSettingsSchema.parse({ overloadRetry: true }).overloadRetry, true);
  assert.equal(ResumeSettingsSchema.safeParse({ overloadRetry: "true" }).success, false);
});
