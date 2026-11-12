import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { DEFAULT_CONTINUE_PROMPT } from "../shared/prompt";
import { listProvidersRpc, listScheduledRpc, type DiscoveredProvider } from "../shared/rpc";
import { isProviderOn, PROMPT_MAX_CHARS, providerSettings, ProviderSettingsSchema, resumeSettings, ResumeSettingsSchema, USAGE_SOURCES } from "../shared/settings";
import { filled, outlined } from "./button-styles";
import { charactersLeft, promptToSave, providerHint, sortProviders } from "./format";
import { jobsQueryKey } from "./query-keys";
import type { SaveFailure } from "./save-failure";
import { accentText, bodyText, dangerText, headingText, inputText, mutedText } from "./text-styles";
import { useSaveFeedback, type SaveFeedback } from "./use-save-feedback";

type ReadySettings = Extract<SettingsState<typeof ProviderSettingsSchema>, { status: "ready" }>;
type ReadyResumeSettings = Extract<SettingsState<typeof ResumeSettingsSchema>, { status: "ready" }>;
type Theme = PluginSurfaceProps["theme"];

const CLI_NAMES = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode" } as const;
const OVERLOAD_RETRY_LABEL = "Retry after a provider overload";

/** The failed save's message beside its control. Not a live region: the toast already announces it. */
function SaveFailureNote({ failure, feedback, saving, colors }: { failure: SaveFailure | null; feedback: SaveFeedback; saving: boolean; colors: Theme["colors"] }) {
  if (!failure) return null;
  return (
    <View style={{ gap: 8, paddingHorizontal: 4, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
      <Text style={[dangerText(colors), { flex: 1, minWidth: 200 }]}>{failure.message}</Text>
      {failure.reload ? (
        <Pressable
          accessibilityRole="button" accessibilityLabel="Reload" accessibilityState={{ disabled: saving }} disabled={saving}
          onPress={() => void feedback.reload()} style={({ pressed }) => outlined(colors, pressed, saving)}
        >
          <Text style={bodyText(colors)}>Reload</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ProviderSwitches({ settings, host, theme, feedback }: { settings: ReadySettings; feedback: SaveFeedback } & Pick<PluginSurfaceProps, "host" | "theme">) {
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
    // The switch shows the saved value, so a failed save leaves it as it was and cancels nothing.
    void feedback.run(provider.id, { kind: "switch", label: provider.label, on }, () => settings.save({ disabledProviders }, settings.revision)).then((saved) => {
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
    return <Text style={{ color: theme.colors.foregroundMuted }}>Paseo has no Claude, Codex, Antigravity, or OpenCode provider.</Text>;
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
            <SaveFailureNote failure={rows.map((provider) => feedback.failureFor(provider.id)).find(Boolean) ?? null} feedback={feedback} saving={settings.saving} colors={theme.colors} />
          </SettingsSection>
        );
      })}
    </>
  );
}

/** The text a continue sends. Typing keeps a draft through failed saves and other clients' changes. */
function PromptEditor({ settings, theme, feedback }: { settings: ReadyResumeSettings; theme: Theme; feedback: SaveFeedback }) {
  const toast = useToast();
  const { colors } = theme;
  const saved = settings.values.continuePrompt;
  // Null shows the saved prompt, so a change saved elsewhere appears until the user types.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? saved ?? DEFAULT_CONTINUE_PROMPT;
  const next = promptToSave(text);
  const changed = next !== saved;
  const savePrompt = (continuePrompt: string | null, message: string) =>
    void feedback.run("prompt", { kind: "named", name: "continue prompt" }, () => settings.save({ ...settings.values, continuePrompt }, settings.revision)).then((ok) => {
      if (!ok) return;
      setDraft(null);
      toast.show(message, { variant: "success" });
    });
  const reset = () => (saved === null ? setDraft(null) : savePrompt(null, "Continue prompt reset to default"));
  const canSave = changed && !settings.saving;
  const canReset = (saved !== null || text !== DEFAULT_CONTINUE_PROMPT) && !settings.saving;
  const left = charactersLeft(text.length, PROMPT_MAX_CHARS);
  const status = [saved === null ? "Default prompt" : "Custom prompt", changed ? "unsaved changes" : null, left].filter(Boolean).join(" · ");
  return (
    <SettingsCard>
      <TextInput
        accessibilityLabel="Continue prompt"
        multiline
        numberOfLines={8}
        maxLength={PROMPT_MAX_CHARS}
        value={text}
        onChangeText={setDraft}
        editable={!settings.saving}
        placeholder="Empty sends the default prompt"
        placeholderTextColor={colors.foregroundMuted}
        textAlignVertical="top"
        style={{ ...inputText(colors), minHeight: 184, maxHeight: 360, paddingVertical: 12, paddingHorizontal: 16 }}
      />
      <View style={{ gap: 12, paddingVertical: 12, paddingHorizontal: 16 }}>
        <Text accessibilityLiveRegion="polite" style={mutedText(colors)}>{status}</Text>
        <SaveFailureNote failure={feedback.failureFor("prompt")} feedback={feedback} saving={settings.saving} colors={colors} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
          <Pressable
            accessibilityRole="button" accessibilityLabel="Reset to default" accessibilityState={{ disabled: !canReset }}
            disabled={!canReset} onPress={reset} style={({ pressed }) => outlined(colors, pressed, !canReset)}
          >
            <Text style={bodyText(colors)}>Reset to default</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button" accessibilityLabel="Save" accessibilityState={{ disabled: !canSave, busy: settings.saving }}
            disabled={!canSave} onPress={() => savePrompt(next, next === null ? "Continue prompt reset to default" : "Continue prompt saved")}
            style={({ pressed }) => filled(colors, pressed, !canSave)}
          >
            {settings.saving ? <ActivityIndicator size="small" color={colors.accentForeground} /> : null}
            <Text style={accentText(colors)}>Save</Text>
          </Pressable>
        </View>
      </View>
    </SettingsCard>
  );
}

/** Read apart from the provider switches, so either one can fail without the other. */
function ResumeSettings({ theme }: { theme: Theme }) {
  const settings = useSettings(resumeSettings);
  const feedback = useSaveFeedback(settings);
  const { colors } = theme;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 8 }}>
        <View style={{ gap: 4 }}>
          <Text accessibilityRole="header" style={headingText(colors)}>Continue prompt</Text>
          <Text style={mutedText(colors)}>Sent to the agent when its reservation continues.</Text>
        </View>
        {settings.status === "ready" ? (
          <PromptEditor settings={settings} theme={theme} feedback={feedback} />
        ) : settings.status === "loading" ? (
          <Text style={{ color: colors.foreground }}>Loading the continue prompt…</Text>
        ) : (
          <View style={{ gap: 8 }}>
            <SettingsCard>
              <SettingsAction
                label="The continue prompt could not be read"
                hint={`${settings.error}\nContinues send the default prompt until this is fixed.`}
                actionLabel="Retry"
                onPress={() => void settings.reload()}
              />
              {settings.status === "invalid" ? (
                <SettingsAction
                  label="Reset the continue prompt"
                  hint="Goes back to the default prompt."
                  actionLabel="Reset"
                  disabled={settings.saving}
                  onPress={() => void feedback.run("reset", { kind: "named", name: "resume settings" }, () => settings.reset())}
                />
              ) : null}
            </SettingsCard>
            <SaveFailureNote failure={feedback.failureFor("reset")} feedback={feedback} saving={settings.saving} colors={colors} />
          </View>
        )}
      </View>
      {settings.status === "ready" ? (
        <View style={{ gap: 8 }}>
          <View style={{ gap: 4 }}>
            <Text accessibilityRole="header" style={headingText(colors)}>Labs</Text>
            <Text style={mutedText(colors)}>Experimental automatic resumes still being tested.</Text>
          </View>
          <SettingsCard>
            <SettingsSwitch
              label={OVERLOAD_RETRY_LABEL}
              value={settings.values.overloadRetry}
              disabled={settings.saving}
              onValueChange={(overloadRetry) => void feedback.run("labs", { kind: "switch", label: OVERLOAD_RETRY_LABEL, on: overloadRetry }, () => settings.save({ ...settings.values, overloadRetry }, settings.revision))}
            />
          </SettingsCard>
          <SaveFailureNote failure={feedback.failureFor("labs")} feedback={feedback} saving={settings.saving} colors={colors} />
        </View>
      ) : null}
    </View>
  );
}

export function ProviderSettingsScreen({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(providerSettings);
  const feedback = useSaveFeedback(settings);
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 24, gap: 16, maxWidth: 600, width: "100%", alignSelf: "center" }}
    >
      {settings.status === "ready" ? (
        <View style={{ gap: 16 }}>
          <ProviderSwitches settings={settings} host={host} theme={theme} feedback={feedback} />
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
                hint="Turns every Claude, Codex, Antigravity, and OpenCode provider back on."
                actionLabel="Reset"
                disabled={settings.saving}
                onPress={() => void feedback.run("reset", { kind: "named", name: "provider settings" }, () => settings.reset())}
              />
            ) : null}
          </SettingsCard>
          <SaveFailureNote failure={feedback.failureFor("reset")} feedback={feedback} saving={settings.saving} colors={theme.colors} />
        </SettingsSection>
      )}
      <ResumeSettings theme={theme} />
    </ScrollView>
  );
}
