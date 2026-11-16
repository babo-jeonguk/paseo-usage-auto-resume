import type { PaseoApi } from "./paseo-types";
import { accountEmail, type DaemonConfig } from "./usage";
import type { DiscoveredProvider } from "../shared/rpc";
import { USAGE_SOURCES, type UsageSource } from "../shared/settings";

type ProvidersApi = Pick<PaseoApi, "config" | "providers">;

/** The supported CLI a provider runs, following `extends` to the built-in it starts from. */
export function cliFor(config: DaemonConfig, provider: string): UsageSource | null {
  const visited = new Set<string>();
  let id = provider;
  for (;;) {
    if (visited.has(id)) return null;
    visited.add(id);
    const parent = (config.providers[id] as { extends?: string } | undefined)?.extends;
    if (!parent) return (USAGE_SOURCES as readonly string[]).includes(id) ? (id as UsageSource) : null;
    id = parent;
  }
}

/** Each provider's current name in Paseo, from its provider snapshot alone: no account or usage probe. */
export async function providerLabels(api: Pick<PaseoApi, "providers">): Promise<Map<string, string>> {
  let entries: Array<{ provider: string; label?: string | null }>;
  try {
    ({ entries } = await api.providers.snapshot());
  } catch {
    entries = [];
  }
  return new Map(entries.flatMap((entry) => {
    const label = entry.label?.trim();
    return label ? [[entry.provider, label] as const] : [];
  }));
}

/** Every provider the daemon knows that runs Claude, Codex, Antigravity, or OpenCode, with the account it signs in as. */
export async function discoverProviders(api: ProvidersApi): Promise<DiscoveredProvider[]> {
  const [{ entries }, { config }] = await Promise.all([api.providers.snapshot(), api.config.get()]);
  const found = entries.flatMap((entry) => {
    const cli = cliFor(config, entry.provider);
    return cli ? [{ entry, cli }] : [];
  });
  return Promise.all(
    found.map(async ({ entry, cli }) => ({
      id: entry.provider,
      label: entry.label ?? entry.provider,
      cli,
      paseoEnabled: entry.enabled !== false,
      account: cli === "antigravity" || cli === "opencode" ? null : await accountEmail(config, entry.provider, cli).catch(() => null),
    })),
  );
}
