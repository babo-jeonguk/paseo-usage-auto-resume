import { useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { listScheduledRpc, rescheduleRpc, resumeNowRpc, setEnabledRpc, type ScheduledJob } from "../shared/rpc";
import { clockLabel, dayLabel, refusalLabel, relativeLabel, resumeNowLabel, waitingLabel } from "./format";
import { notifyScheduleChanged } from "./schedule-changes";
import { TimeEditor } from "./time-editor";
import { Toggle } from "./toggle";

export function ConversationControls(props: PluginButtonContentProps) {
  // Composer contributions are always agent-scoped.
  return props.context === "agent" ? <AgentControls {...props} agentId={props.agentId} /> : null;
}

function AgentControls({ agentId, theme, host, layout, close }: PluginButtonContentProps & { agentId: string }) {
  const list = useRpc(listScheduledRpc);
  const setEnabled = useRpc(setEnabledRpc);
  const reschedule = useRpc(rescheduleRpc);
  const resumeNow = useRpc(resumeNowRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryKey = ["usage-auto-resume", "jobs", host.id];
  const historyKey = ["usage-auto-resume", "history", host.id];
  const query = useQuery({ queryKey, queryFn: async () => (await list({})).jobs, refetchInterval: 10_000 });
  const job = query.data?.find((entry) => entry.agentId === agentId);
  const [now, setNow] = useState(Date.now);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => setEditing(false), [job?.dueAt, job?.sending]);

  const action = useMutation({
    mutationFn: async (input: { job: ScheduledJob } & ({ kind: "toggle"; enabled: boolean } | { kind: "move"; dueAt: string })) => {
      await queryClient.cancelQueries({ queryKey });
      const pin = { agentId, dueAt: input.job.dueAt };
      if (input.kind === "toggle") {
        const result = await setEnabled({ ...pin, enabled: input.enabled });
        if (!result.changed) throw new Error("This schedule already ran or changed.");
      } else {
        const result = await reschedule({ ...pin, newDueAt: input.dueAt });
        if (!result.changed) throw new Error(refusalLabel(input.job, result));
      }
    },
    onSuccess: (_result, input) => {
      setEditing(false);
      // Reflect only an acknowledged mutation, in the sidebar's shared cache too.
      queryClient.setQueryData<ScheduledJob[]>(queryKey, (jobs) => jobs?.map((entry) =>
        entry.agentId !== agentId || entry.dueAt !== input.job.dueAt ? entry : input.kind === "toggle"
          ? { ...entry, enabled: input.enabled }
          : { ...entry, dueAt: input.dueAt, enabled: true }));
      toast.show(input.kind === "toggle" ? `Auto Resume turned ${input.enabled ? "on" : "off"}` : "Resume time updated");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update the schedule."),
    onSettled: () => {
      notifyScheduleChanged();
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  // The server checks the agent and its usage first, which can take several seconds.
  const resume = useMutation({
    mutationFn: async (shown: ScheduledJob) => {
      await queryClient.cancelQueries({ queryKey });
      return resumeNow({ agentId, dueAt: shown.dueAt });
    },
    onSuccess: (result, shown) => {
      const message = resumeNowLabel(result, Date.now());
      if (result.result !== "sent") {
        toast.error(message);
        return;
      }
      queryClient.setQueryData<ScheduledJob[]>(queryKey, (jobs) =>
        jobs?.filter((entry) => entry.agentId !== agentId || entry.dueAt !== shown.dueAt));
      toast.show(message, { variant: "success" });
      close();
    },
    // The server finishes the attempt even when its answer is lost on the way.
    onError: () => toast.error("No answer from Auto Resume. Refresh to see whether the continue was sent."),
    onSettled: () => {
      notifyScheduleChanged();
      return Promise.all([queryClient.invalidateQueries({ queryKey }), queryClient.invalidateQueries({ queryKey: historyKey })]);
    },
  });
  const { colors } = theme;
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 };
  const text = { color: colors.foreground, fontSize: 14 };
  const busy = action.isPending || resume.isPending || !!job?.sending;
  const disabled = busy || query.isError || query.isPending;
  const outlined = (pressed: boolean, unavailable: boolean) => ({
    flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 6,
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, borderColor: colors.border,
    opacity: unavailable ? 0.4 : 1, backgroundColor: pressed ? colors.surface2 : "transparent",
  });
  const button = (label: string, onPress: () => void, icon: string, unavailable = disabled) => (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: unavailable }}
      disabled={unavailable} onPress={onPress} style={({ pressed }) => outlined(pressed, unavailable)}
    >
      <Icon name={icon} size={16} color={colors.foreground} /><Text style={text}>{label}</Text>
    </Pressable>
  );
  return (
    <View testID={`resume-conversation-${agentId}`} style={{ padding: 16, gap: 16, width: "100%", maxWidth: 360 }}>
      {!layout.compact ? <Text accessibilityRole="header" style={{ ...text, fontSize: 16, fontWeight: "600" }}>Auto Resume</Text> : null}
      {query.isPending ? <ActivityIndicator color={colors.foregroundMuted} /> : query.isError ? <>
        <Text accessibilityRole="alert" style={muted}>Couldn’t load this reservation.</Text>
        {button("Refresh status", () => void query.refetch(), "RefreshCw", query.isFetching)}
      </> : !job ? <>
        <Text style={muted}>Nothing scheduled for this conversation.</Text>
        {button("Close", close, "X", false)}
      </> : <>
        <View style={{ gap: 4 }}>
          <Text style={muted}>{dayLabel(job.dueAt, now)}</Text>
          <Text style={{ ...text, fontSize: 28, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{clockLabel(job.dueAt)}</Text>
          <Text style={muted}>{job.sending ? "Continuing…" : !job.enabled ? "Off"
            : waitingLabel(job) ?? `Continues ${relativeLabel(job.dueAt, now)}`}</Text>
          {job.waiting ? <Text style={muted}>Next check {relativeLabel(job.dueAt, now)}</Text> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text style={{ ...text, flex: 1 }}>Resume this reservation</Text>
          <Toggle theme={theme} value={job.enabled} disabled={disabled}
            accessibilityLabel="Resume this reservation"
            onValueChange={(enabled) => action.mutate({ kind: "toggle", job, enabled })} />
        </View>
        {editing && !busy ? <TimeEditor key={job.dueAt} job={job} now={now} compact stackDays theme={theme}
          onSave={(dueAt) => action.mutate({ kind: "move", job, dueAt })} onCancel={() => setEditing(false)} /> : <>
          {button("Change time", () => setEditing(true), "Clock")}
          {button("+10m", () => action.mutate({ kind: "move", job, dueAt: new Date(Date.parse(job.dueAt) + 600_000).toISOString() }), "Plus")}
          <ResumeNow key={job.dueAt} job={job} theme={theme} disabled={disabled} pending={resume.isPending}
            onSend={() => resume.mutate(job)} />
        </>}
        {action.isPending ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : null}
      </>}
    </View>
  );
}

/** Resume now asks once more in place: a sent continue cannot be taken back, and the delays sit right above. */
function ResumeNow({ job, theme, disabled, pending, onSend }: {
  job: ScheduledJob;
  theme: PluginButtonContentProps["theme"];
  disabled: boolean;
  pending: boolean;
  onSend(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { colors } = theme;
  const shape = { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 6, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 6 };
  const primary = (label: string, onPress: () => void, icon?: string) => (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ ...shape, flex: confirming ? 1 : undefined, backgroundColor: colors.accent, opacity: disabled ? 0.4 : pressed ? 0.85 : 1 })}
    >
      {icon ? <Icon name={icon} size={16} color={colors.accentForeground} /> : null}
      <Text style={{ color: colors.accentForeground, fontSize: 14, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  if (pending) return <View style={{ ...shape, borderWidth: 1, borderColor: colors.border }}><ActivityIndicator size="small" color={colors.foregroundMuted} /></View>;
  if (!confirming) return primary("Resume now", () => setConfirming(true), "Play");
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.foreground, fontSize: 14 }}>
        Send the continue now?{job.enabled ? "" : " This reservation is off; sending turns it into a continue now."}
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable
          accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setConfirming(false)}
          style={({ pressed }) => ({ ...shape, flex: 1, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.surface2 : "transparent" })}
        >
          <Text style={{ color: colors.foreground, fontSize: 14 }}>Cancel</Text>
        </Pressable>
        {primary("Send", () => { setConfirming(false); onSend(); })}
      </View>
    </View>
  );
}
