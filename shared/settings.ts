import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export type UsageSource = "claude" | "codex" | "antigravity";
export const USAGE_SOURCES: readonly UsageSource[] = ["claude", "codex", "antigravity"];

export const ProviderSettingsSchema = z.object({
  /** Providers turned off by the user; every other Claude, Codex, or Antigravity provider resumes. */
  disabledProviders: z.array(z.string().min(1)).default([]),
});

export type ProviderSettings = z.output<typeof ProviderSettingsSchema>;
export const DEFAULT_PROVIDER_SETTINGS = ProviderSettingsSchema.parse({});

/** Version 1 chose one exact provider ID per CLI. Read only to tell a valid file from a damaged one. */
const LegacyProviderId = z.string().trim().regex(/^[a-z][a-z0-9-]*$/);
const ProviderSettingsV1Schema = z
  .object({
    claudeProvider: LegacyProviderId.default("claude"),
    codexProvider: LegacyProviderId.default("codex"),
    antigravityProvider: LegacyProviderId.default("antigravity"),
  })
  .refine((values) => new Set([values.claudeProvider, values.codexProvider, values.antigravityProvider]).size === 3);

export const providerSettings = defineSettings({
  id: "providers",
  scope: "host",
  version: 2,
  schema: ProviderSettingsSchema,
  // An upgraded host starts with every provider on, like a new install. A version 1 file that
  // did not parse stays unreadable, so resumes keep waiting instead of taking the defaults.
  migrate: (values, fromVersion) => {
    if (fromVersion !== 1) throw new Error(`Unknown provider settings version ${fromVersion}`);
    ProviderSettingsV1Schema.parse(values);
    return DEFAULT_PROVIDER_SETTINGS;
  },
});

export function isProviderOn(provider: string, settings: ProviderSettings): boolean {
  return !settings.disabledProviders.includes(provider);
}

/** Longest custom continue prompt; the default is about 700 characters. */
export const PROMPT_MAX_CHARS = 4000;

export const ResumeSettingsSchema = z.object({
  /** Labs: bounded retries after a provider capacity failure. */
  overloadRetry: z.boolean().default(false),
  /** Null sends the built-in prompt, so its later improvements reach everyone who never changed it. */
  continuePrompt: z.string().trim().min(1).max(PROMPT_MAX_CHARS).nullable().default(null),
});

export type ResumeSettings = z.output<typeof ResumeSettingsSchema>;
export const DEFAULT_RESUME_SETTINGS = ResumeSettingsSchema.parse({});

/**
 * Prompt and Labs settings. Unreadable values still send the built-in prompt; the Labs switch is
 * unknown then, so overload retries are neither made nor canceled by it.
 */
export const resumeSettings = defineSettings({ id: "resume", scope: "host", version: 1, schema: ResumeSettingsSchema });
