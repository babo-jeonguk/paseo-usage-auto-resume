import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { listProvidersRpc, listScheduledRpc, type DiscoveredProvider } from "../shared/rpc";
import { isProviderOn, providerSettings, ProviderSettingsSchema, USAGE_SOURCES } from "../shared/settings";
import { providerHint, sortProviders } from "./format";
import { jobsQueryKey } from "./query-keys";
import { headingText, mutedText } from "./text-styles";

type ReadySettings = Extract<SettingsState<typeof ProviderSettingsSchema>, { status: "ready" }>;

const CLI_NAMES = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" } as const;

function ProviderSwitches({ settings, host, theme }: { settings: ReadySettings } & Pick<PluginSurfaceProps, "host" | "theme">) {
  const listProviders = useRpc(listProvidersRpc);
  const listScheduled = useRpc(listScheduledRpc);
  const toast = useToast();
  const providers = useQuery({
    queryKey: ["usage-auto-resume", "providers", host.id],
    queryFn: async () => (await listProviders({})).providers,
  });
  // Shares the Auto Resume screen's cache, so counts match the list there.
  const jobs = useQuery({
    queryKey: jobsQueryKey(host.id),
    queryFn: async () => (await listScheduled({})).jobs,
  });
  const pending = new Map<string, number>();
  for (const job of jobs.data ?? []) if (!job.sending) pending.set(job.provider, (pending.get(job.provider) ?? 0) + 1);

  const turn = (provider: DiscoveredProvider, on: boolean) => {
    const others = settings.values.disabledProviders.filter((id) => id !== provider.id);
    const disabledProviders = on ? others : [...others, provider.id].sort();
    void settings.save({ disabledProviders }, settings.revision).then((saved) => {
      if (saved) toast.show(`${provider.label} turned ${on ? "on" : "off"}`, { variant: "success" });
    });
  };

  if (!providers.data) {
    return providers.error ? (
      <SettingsSection title="Providers">
        <SettingsCard>
          <SettingsAction
            label="Providers could not be listed"
            hint={String(providers.error)}
            actionLabel="Retry"
            onPress={() => void providers.refetch()}
          />
        </SettingsCard>
      </SettingsSection>
    ) : (
      <Text style={{ color: theme.colors.foreground }}>Loading providers…</Text>
    );
  }
  if (providers.data.length === 0) {
    return <Text style={{ color: theme.colors.foregroundMuted }}>Paseo has no Claude, Codex, or Antigravity provider.</Text>;
  }

  return (
    <>
      <View style={{ gap: 4, marginBottom: 8 }}>
        <Text accessibilityRole="header" style={headingText(theme.colors)}>Automatic resume</Text>
        <Text style={mutedText(theme.colors)}>
          Choose which providers continue after a usage limit. Turning one off cancels its pending reservations.
        </Text>
      </View>
      {USAGE_SOURCES.map((cli) => {
        const rows = sortProviders(providers.data.filter((provider) => provider.cli === cli));
        if (rows.length === 0) return null;
        return (
          <SettingsSection key={cli} title={CLI_NAMES[cli]}>
            <SettingsCard>
              {rows.map((provider) => {
                const on = isProviderOn(provider.id, settings.values);
                return (
                  <SettingsSwitch
                    key={provider.id}
                    label={provider.label}
                    hint={providerHint(provider, on ? (pending.get(provider.id) ?? 0) : 0)}
                    value={on}
                    onValueChange={(value) => turn(provider, value)}
                    disabled={settings.saving}
                  />
                );
              })}
            </SettingsCard>
          </SettingsSection>
        );
      })}
    </>
  );
}

export function ProviderSettingsScreen({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(providerSettings);
  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16, maxWidth: 600, width: "100%", alignSelf: "center" }}>
      {settings.status === "ready" ? (
        <View style={{ gap: 16 }}>
          <ProviderSwitches settings={settings} host={host} theme={theme} />
          {settings.saveError ? (
            <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>
          ) : null}
        </View>
      ) : settings.status === "loading" ? (
        <Text style={{ color: theme.colors.foreground }}>Loading provider settings…</Text>
      ) : (
        <SettingsSection title="Provider settings">
          <SettingsCard>
            <SettingsAction
              label="Provider settings could not be read"
              hint={settings.error}
              actionLabel="Retry"
              onPress={() => void settings.reload()}
            />
            {settings.status === "invalid" ? (
              <SettingsAction
                label="Reset provider settings"
                hint="Turns every Claude, Codex, and Antigravity provider back on."
                actionLabel="Reset"
                disabled={settings.saving}
                onPress={() => void settings.reset()}
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      )}
    </ScrollView>
  );
}
