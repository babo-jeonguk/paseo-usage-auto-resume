import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { providerSettings, ProviderSettingsSchema, type ProviderSettings } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof ProviderSettingsSchema>, { status: "ready" }>;

function ProviderForm({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const [draft, setDraft] = useState<ProviderSettings>(settings.values);
  const toast = useToast();
  const parsed = ProviderSettingsSchema.safeParse(draft);
  const errorFor = (key: keyof ProviderSettings) =>
    parsed.success ? null : parsed.error.issues.find((issue) => issue.path[0] === key)?.message;
  const changed = parsed.success && (
    parsed.data.claudeProvider !== settings.values.claudeProvider ||
    parsed.data.codexProvider !== settings.values.codexProvider ||
    parsed.data.antigravityProvider !== settings.values.antigravityProvider
  );

  return (
    <View style={{ gap: 16 }}>
      <SettingsSection title="Automatic resume providers">
        <SettingsCard>
          <SettingsInput
            label="Claude provider ID"
            hint="Use claude for the default provider, or a Claude alias such as claude-main."
            initialValue={draft.claudeProvider}
            onChangeText={(claudeProvider) => setDraft((current) => ({ ...current, claudeProvider }))}
            error={errorFor("claudeProvider")}
            disabled={settings.saving}
          />
          <SettingsInput
            label="Codex provider ID"
            hint="Use codex for the default provider, or your Codex alias."
            initialValue={draft.codexProvider}
            onChangeText={(codexProvider) => setDraft((current) => ({ ...current, codexProvider }))}
            error={errorFor("codexProvider")}
            disabled={settings.saving}
          />
          <SettingsInput
            label="Antigravity provider ID"
            hint="Use antigravity for the default provider, or your Antigravity alias."
            initialValue={draft.antigravityProvider}
            onChangeText={(antigravityProvider) => setDraft((current) => ({ ...current, antigravityProvider }))}
            error={errorFor("antigravityProvider")}
            disabled={settings.saving}
          />
          <SettingsAction
            label="Save provider selection"
            hint="Only these exact IDs will resume. Saving cancels pending reservations for providers removed from this selection."
            actionLabel={settings.saving ? "Saving…" : "Save"}
            disabled={!changed || settings.saving}
            onPress={() => {
              if (!parsed.success) return;
              void settings.save(parsed.data, settings.revision).then((saved) => {
                if (saved) toast.show("Provider selection saved", { variant: "success" });
              });
            }}
          />
        </SettingsCard>
      </SettingsSection>
      {settings.saveError ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>
      ) : null}
    </View>
  );
}

export function ProviderSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(providerSettings);
  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16, maxWidth: 600, width: "100%", alignSelf: "center" }}>
      {settings.status === "ready" ? (
        <ProviderForm key={settings.revision} settings={settings} theme={theme} />
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
                label="Reset provider selection"
                hint="Selects the public defaults claude, codex, and antigravity, and cancels reservations for other providers."
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
