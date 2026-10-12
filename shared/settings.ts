import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const ProviderId = z.string().trim().regex(/^[a-z][a-z0-9-]*$/, "Use a lowercase provider ID, such as claude or claude-main.");

export const ProviderSettingsSchema = z.object({
  claudeProvider: ProviderId.default("claude"),
  codexProvider: ProviderId.default("codex"),
}).refine((values) => values.claudeProvider !== values.codexProvider, {
  message: "Claude and Codex must use different provider IDs.",
  path: ["codexProvider"],
});

export type ProviderSettings = z.output<typeof ProviderSettingsSchema>;
export type UsageSource = "claude" | "codex";
export const DEFAULT_PROVIDER_SETTINGS = ProviderSettingsSchema.parse({});

export const providerSettings = defineSettings({
  id: "providers",
  scope: "host",
  version: 1,
  schema: ProviderSettingsSchema,
});

/** Exact selection only: another alias extending the same CLI is a separate opt-in. */
export function sourceForProvider(provider: string, settings: ProviderSettings): UsageSource | null {
  if (provider === settings.claudeProvider) return "claude";
  if (provider === settings.codexProvider) return "codex";
  return null;
}
