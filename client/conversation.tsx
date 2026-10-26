import { useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { listScheduledRpc, rescheduleRpc, resumeNowRpc, setEnabledRpc, type ScheduledJob } from "../shared/rpc";
import { clockLabel, dayLabel, delayChoices, notePreview, RESUME_NOW_UNFINISHED, refusalLabel, relativeLabel, resumeNowToast, SCHEDULE_CHANGED, waitingLabel } from "./format";
import { editorLocks } from "./edit-session";
import { NoteEditor } from "./note-editor";
import { historyQueryKey, jobsQueryKey } from "./query-keys";
import { accentText, bodyText, chipText, clockText, headingText, mutedText } from "./text-styles";
import { filled, outlined, pressFeedback } from "./button-styles";
import { notifyScheduleChanged } from "./schedule-changes";
import { TimeEditor } from "./time-editor";
import { useEditSession } from "./use-edit-session";
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
  const queryKey = jobsQueryKey(host.id);
  const query = useQuery({ queryKey, queryFn: async () => (await list({})).jobs, refetchInterval: 10_000 });
  const job = query.data?.find((entry) => entry.agentId === agentId);
  const [now, setNow] = useState(Date.now);
  const [session, dispatch] = useEditSession(query.data);
  const editing = session?.kind ?? null;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const action = useMutation({
    mutationFn: async (input: { job: ScheduledJob } & ({ kind: "toggle"; enabled: boolean } | { kind: "move"; dueAt: string })) => {
      await queryClient.cancelQueries({ queryKey });
      const pin = { agentId, dueAt: input.job.dueAt };
      if (input.kind === "toggle") {
        const result = await setEnabled({ ...pin, enabled: input.enabled });
        if (!result.changed) throw new Error(SCHEDULE_CHANGED);
      } else {
        const result = await reschedule({ ...pin, newDueAt: input.dueAt });
        if (!result.changed) throw new Error(refusalLabel(input.job, result));
      }
    },
    onSuccess: (_result, input) => {
      if (input.kind === "move") dispatch({ type: "moved", agentId });
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
      const { message, tone } = resumeNowToast(result, Date.now());
      toast.show(message, { variant: tone });
      if (result.result !== "sent") return;
      queryClient.setQueryData<ScheduledJob[]>(queryKey, (jobs) =>
        jobs?.filter((entry) => entry.agentId !== agentId || entry.dueAt !== shown.dueAt));
      close();
    },
    // A timeout, a lost connection or a server error: the daemon may still have finished, and sent.
    onError: () => toast.error(RESUME_NOW_UNFINISHED),
    onSettled: () => {
      notifyScheduleChanged();
      return Promise.all([queryClient.invalidateQueries({ queryKey }), queryClient.invalidateQueries({ queryKey: historyQueryKey(host.id) })]);
    },
  });
  const { colors } = theme;
  const muted = mutedText(colors);
  const text = bodyText(colors);
  const busy = action.isPending || resume.isPending || !!job?.sending;
  const disabled = busy || query.isError || query.isPending;
  // While a note is written nothing moves or sends the reservation: its save is pinned to this
  // time, and a continue would leave it behind.
  const locks = editorLocks(session);
  const noteLocked = disabled || locks.note;
  const changeLocked = disabled || locks.time;
  const preview = job?.note ? notePreview(job.note, 200) : undefined;
  const button = (label: string, onPress: () => void, icon: string, unavailable = disabled) => (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: unavailable }}
      disabled={unavailable} onPress={onPress} style={({ pressed }) => outlined(colors, pressed, unavailable)}
    >
      <Icon name={icon} size={16} color={colors.foreground} /><Text style={text}>{label}</Text>
    </Pressable>
  );
  return (
    <View testID={`resume-conversation-${agentId}`} style={{ padding: 16, gap: 16, width: "100%", maxWidth: 360 }}>
      {!layout.compact ? <Text accessibilityRole="header" style={headingText(colors)}>Auto Resume</Text> : null}
      {/* A failed refresh keeps what was shown, with every change off until it loads. */}
      {query.isError && query.data ? <View style={{ gap: 8 }}>
        <Text accessibilityRole="alert" style={muted}>Couldn’t refresh this reservation.</Text>
        {button("Refresh status", () => void query.refetch(), "RefreshCw", query.isFetching)}
      </View> : null}
      {query.isPending ? <ActivityIndicator color={colors.foregroundMuted} /> : !query.data ? <>
        <Text accessibilityRole="alert" style={muted}>Couldn’t load this reservation.</Text>
        {button("Refresh status", () => void query.refetch(), "RefreshCw", query.isFetching)}
      </> : !job ? <>
        <Text style={muted}>Nothing scheduled for this conversation.</Text>
        {button("Close", close, "X", false)}
      </> : <>
        {/* The time and the controls that move it stay together; the editor replaces all of them. */}
        {editing === "time" && !busy ? <TimeEditor key={job.dueAt} job={job} now={now} compact stackDays theme={theme} locked={disabled}
          onSave={(dueAt) => action.mutate({ kind: "move", job, dueAt })} onCancel={() => dispatch({ type: "cancel" })} /> : (
          <View style={{ gap: 4 }}>
            <Text style={muted}>{dayLabel(job.dueAt, now)}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={clockText(colors)}>{clockLabel(job.dueAt)}</Text>
              <Pressable
                accessibilityRole="button" accessibilityLabel="Change time" accessibilityState={{ disabled: changeLocked }}
                disabled={changeLocked} hitSlop={6} onPress={() => dispatch({ type: "open", kind: "time", job })}
                style={({ pressed }) => ({ ...pressFeedback(colors, pressed, changeLocked), width: 32, height: 32, borderRadius: 6, alignItems: "center", justifyContent: "center" })}
              >
                <Icon name="Pencil" size={16} color={colors.foregroundMuted} />
              </Pressable>
            </View>
            <Text style={muted}>{job.sending ? "Continuing…" : !job.enabled ? "Off"
              : waitingLabel(job) ?? `Continues ${relativeLabel(job.dueAt, now)}`}</Text>
            {job.waiting ? <Text style={muted}>Next check {relativeLabel(job.dueAt, now)}</Text> : null}
            <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
              {delayChoices(job, now).map((choice) => {
                const unavailable = changeLocked || !!choice.problem;
                return (
                  <Pressable
                    key={choice.label} accessibilityRole="button" accessibilityLabel={choice.spoken}
                    accessibilityHint={choice.problem ?? undefined} accessibilityState={{ disabled: unavailable }}
                    disabled={unavailable} hitSlop={{ top: 8, bottom: 8 }}
                    onPress={() => action.mutate({ kind: "move", job, dueAt: choice.dueAt })}
                    style={({ pressed }) => ({ ...outlined(colors, pressed, unavailable), paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 })}
                  >
                    <Text style={chipText(colors)}>{choice.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text style={{ ...text, flex: 1 }}>Resume this reservation</Text>
          <Toggle theme={theme} value={job.enabled} disabled={disabled}
            accessibilityLabel="Resume this reservation"
            onValueChange={(enabled) => action.mutate({ kind: "toggle", job, enabled })} />
        </View>
        {session?.kind === "note" ? (
          <NoteEditor job={job} session={session} dispatch={dispatch} hostId={host.id} theme={theme} locked={disabled} />
        ) : preview ? (
          <Pressable
            accessibilityRole="button" accessibilityLabel="Edit extra instructions" accessibilityHint={preview}
            accessibilityState={{ disabled: noteLocked }} disabled={noteLocked} onPress={() => dispatch({ type: "open", kind: "note", job })}
            style={({ pressed }) => ({ ...pressFeedback(colors, pressed, noteLocked), flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: colors.border })}
          >
            <Icon name="NotebookPen" size={16} color={colors.foregroundMuted} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={muted}>Extra instructions</Text>
              <Text style={text} numberOfLines={2}>{preview}</Text>
            </View>
            <Icon name="Pencil" size={16} color={colors.foregroundMuted} />
          </Pressable>
        ) : button("Add extra instructions", () => dispatch({ type: "open", kind: "note", job }), "NotebookPen", noteLocked)}
        {/* A sibling of the editor, so its key must not repeat the editor's. */}
        <ResumeNow key={`resume-now-${job.dueAt}`} theme={theme} disabled={changeLocked} pending={resume.isPending}
          onSend={() => resume.mutate(job)} />
        {action.isPending ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : null}
      </>}
    </View>
  );
}

/** Resume now asks once more in place: a sent continue cannot be taken back, and the delays sit right above. */
function ResumeNow({ theme, disabled, pending, onSend }: {
  theme: PluginButtonContentProps["theme"];
  disabled: boolean;
  pending: boolean;
  onSend(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { colors } = theme;
  const primary = (label: string, onPress: () => void, icon?: string) => (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ ...filled(colors, pressed, disabled), flex: confirming ? 1 : undefined })}
    >
      {icon ? <Icon name={icon} size={16} color={colors.accentForeground} /> : null}
      <Text style={accentText(colors)}>{label}</Text>
    </Pressable>
  );
  if (pending) return <View style={outlined(colors, false)}><ActivityIndicator size="small" color={colors.foregroundMuted} /></View>;
  if (!confirming) return primary("Resume now", () => setConfirming(true), "Play");
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityLiveRegion="polite" style={bodyText(colors)}>
        Send the continue now?
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable
          accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setConfirming(false)}
          style={({ pressed }) => ({ ...outlined(colors, pressed), flex: 1 })}
        >
          <Text style={bodyText(colors)}>Cancel</Text>
        </Pressable>
        {primary("Send", () => { setConfirming(false); onSend(); })}
      </View>
    </View>
  );
}
