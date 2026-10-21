import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from "react-native";
import {
  listScheduledRpc,
  rescheduleRpc,
  setAllEnabledRpc,
  setEnabledRpc,
  type ScheduledJob,
} from "../shared/rpc";
import {
  bulkAction,
  clockLabel,
  groupByDay,
  placeLabel,
  providerLabel,
  refusalLabel,
  relativeLabel,
  summaryLabels,
  waitingLabel,
} from "./format";
import { Toggle } from "./toggle";
import { TimeEditor } from "./time-editor";
import { notifyScheduleChanged } from "./schedule-changes";

type Theme = PluginScreenProps["theme"];

const BUMP_MS = 10 * 60_000;

/** Re-renders on a cadence so countdowns stay current without refetching. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const byDueAt = (jobs: ScheduledJob[]) => [...jobs].sort((left, right) => left.dueAt.localeCompare(right.dueAt));

function createStyles(theme: Theme, compact: boolean) {
  const { colors } = theme;
  return {
    scroll: { flex: 1, backgroundColor: colors.surface0 },
    content: {
      padding: compact ? 16 : 24,
      paddingBottom: 48,
      width: "100%" as const,
      maxWidth: 600,
      alignSelf: "center" as const,
    },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, marginBottom: 24 },
    headerText: { flex: 1, gap: 4 },
    summary: { color: colors.foreground, fontSize: 18, fontWeight: "600" as const },
    summaryDetail: { color: colors.foregroundMuted, fontSize: 14, fontVariant: ["tabular-nums" as const] },
    iconButton: {
      width: 36,
      height: 36,
      borderRadius: 6,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    pressed: { backgroundColor: colors.surface2 },
    disabled: { opacity: 0.4 },
    section: { marginBottom: 24 },
    sectionTitle: { color: colors.foregroundMuted, fontSize: 12, marginLeft: 4, marginBottom: 12 },
    card: {
      backgroundColor: colors.surface1,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: "hidden" as const,
    },
    row: { paddingVertical: 14, paddingHorizontal: 16 },
    rowLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
    rowBody: { flex: 1, minWidth: 0 },
    timeLine: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8 },
    time: {
      fontSize: 26,
      fontWeight: "600" as const,
      letterSpacing: -0.5,
      fontVariant: ["tabular-nums" as const],
    },
    // Dotted like an editable value; a solid underline would read as a link.
    timeEditable: {
      textDecorationLine: "underline" as const,
      textDecorationStyle: "dotted" as const,
      textDecorationColor: colors.foregroundMuted,
    },
    relative: { color: colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums" as const] },
    title: { fontSize: 14, marginTop: 2 },
    meta: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 6,
      marginTop: 8,
    },
    chip: {
      backgroundColor: colors.surface2,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    chipText: { color: colors.foreground, fontSize: 12, fontWeight: "500" as const },
    metaText: { color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
    pill: {
      height: 30,
      paddingHorizontal: 10,
      borderRadius: 15,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    pillText: { color: colors.foreground, fontSize: 13, fontWeight: "500" as const, fontVariant: ["tabular-nums" as const] },
    button: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    buttonText: { color: colors.foreground, fontSize: 13, fontWeight: "500" as const },
    centered: { alignItems: "center" as const, paddingVertical: 64, paddingHorizontal: 24, gap: 12 },
    emptyIcon: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.surface1,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      marginBottom: 4,
    },
    emptyTitle: { color: colors.foreground, fontSize: 16, fontWeight: "600" as const },
    emptyBody: { color: colors.foregroundMuted, fontSize: 14, textAlign: "center" as const, lineHeight: 20 },
    retry: {
      marginTop: 4,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    retryText: { color: colors.foreground, fontSize: 14, fontWeight: "500" as const },
  };
}

type Styles = ReturnType<typeof createStyles>;

function JobRow(props: {
  job: ScheduledJob;
  now: number;
  divided: boolean;
  editing: boolean;
  compact: boolean;
  theme: Theme;
  styles: Styles;
  onEdit(editing: boolean): void;
  onReschedule(job: ScheduledJob, dueAt: string): void;
  onToggle(job: ScheduledJob, enabled: boolean): void;
  onOpen?: (agentId: string) => void;
}) {
  const { job, now, styles, theme, onOpen, editing } = props;
  const on = job.enabled;
  const busy = job.sending;
  const tone = on ? theme.colors.foreground : theme.colors.foregroundMuted;
  const title = job.title ?? "Untitled agent";
  const place = placeLabel(job);
  const countdown = job.resetAt ? relativeLabel(job.dueAt, now) : `${relativeLabel(job.dueAt, now)} · reset unknown`;
  const status = busy ? "Continuing…" : on ? waitingLabel(job) ?? countdown : "Skipped";
  const resetSpoken = job.resetAt ? `limit resets at ${clockLabel(job.resetAt)}` : "reset time unknown, checks again";

  return (
    <View style={[styles.row, props.divided ? styles.rowDivider : null]}>
      {editing ? (
        <TimeEditor
          job={job}
          now={now}
          compact={props.compact}
          theme={theme}
          onSave={(dueAt) => props.onReschedule(job, dueAt)}
          onCancel={() => props.onEdit(false)}
        />
      ) : null}
      <View style={styles.rowLine}>
        <View style={styles.rowBody}>
          {editing ? null : (
            <View style={styles.timeLine}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Change time for ${title}, now ${clockLabel(job.dueAt)}`}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                hitSlop={8}
                onPress={() => props.onEdit(true)}
              >
                <Text style={[styles.time, { color: tone }, busy ? null : styles.timeEditable]}>{clockLabel(job.dueAt)}</Text>
              </Pressable>
              <Text style={styles.relative}>{status}</Text>
            </View>
          )}
          <Text style={[styles.title, { color: tone }]} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.meta}>
            <View style={styles.chip}>
              <Text style={styles.chipText}>{providerLabel(job.provider)}</Text>
            </View>
            {place ? (
              <Text style={styles.metaText} numberOfLines={1}>
                {place}
              </Text>
            ) : null}
          </View>
        </View>
        {/* The editor needs the row's width on compact layouts, so the row's own controls step aside. */}
        {editing ? null : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Continue ${title} 10 minutes later`}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              hitSlop={6}
              onPress={() => props.onReschedule(job, new Date(Date.parse(job.dueAt) + BUMP_MS).toISOString())}
              style={({ pressed }) => [styles.pill, busy ? styles.disabled : null, pressed ? styles.pressed : null]}
            >
              <Text style={styles.pillText}>+10m</Text>
            </Pressable>
            {onOpen ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${title}`}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                hitSlop={4}
                onPress={() => onOpen(job.agentId)}
                style={({ pressed }) => [styles.iconButton, busy ? styles.disabled : null, pressed ? styles.pressed : null]}
              >
                <Icon name="SquareArrowOutUpRight" size={18} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
            <Toggle
              value={on}
              disabled={busy}
              onValueChange={(value) => props.onToggle(job, value)}
              theme={theme}
              accessibilityLabel={`Continue ${title} automatically at ${clockLabel(job.dueAt)}, ${resetSpoken}`}
            />
          </>
        )}
      </View>
    </View>
  );
}

export function AutoResumeScreen({ theme, host, layout, navigation }: PluginScreenProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const listScheduled = useRpc(listScheduledRpc);
  const setEnabled = useRpc(setEnabledRpc);
  const setAllEnabled = useRpc(setAllEnabledRpc);
  const reschedule = useRpc(rescheduleRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow(15_000);
  const [editing, setEditing] = useState<string | null>(null);
  const queryKey = useMemo(() => ["usage-auto-resume", "jobs", host.id], [host.id]);

  const query = useQuery({
    queryKey,
    queryFn: async () => (await listScheduled({})).jobs,
    refetchInterval: 30_000,
  });

  /** Applies a change to the cached list at once and returns what to roll back to. */
  async function optimistic(change: (jobs: ScheduledJob[]) => ScheduledJob[]) {
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<ScheduledJob[]>(queryKey);
    queryClient.setQueryData<ScheduledJob[]>(queryKey, (jobs) => (jobs ? change(jobs) : jobs));
    return { previous };
  }

  function rollback(error: unknown, context: { previous?: ScheduledJob[] } | undefined) {
    if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    toast.error(error instanceof Error ? error.message : "Could not update the schedule.");
  }

  const toggle = useMutation({
    mutationFn: async (input: { job: ScheduledJob; enabled: boolean }) => {
      const { changed } = await setEnabled({
        agentId: input.job.agentId,
        dueAt: input.job.dueAt,
        enabled: input.enabled,
      });
      if (!changed) throw new Error("This schedule already ran or changed.");
    },
    onMutate: ({ job, enabled }) =>
      optimistic((jobs) => jobs.map((entry) => (entry.agentId === job.agentId ? { ...entry, enabled } : entry))),
    onError: (error, _input, context) => rollback(error, context),
    onSettled: () => {
      notifyScheduleChanged();
      return queryClient.invalidateQueries({ queryKey });
    },
  });

  // Moving a job turns it on, like changing an alarm's time; it may also change its day group.
  const move = useMutation({
    mutationFn: async (input: { job: ScheduledJob; dueAt: string }) => {
      const result = await reschedule({ agentId: input.job.agentId, dueAt: input.job.dueAt, newDueAt: input.dueAt });
      if (!result.changed) throw new Error(refusalLabel(input.job, result));
    },
    onMutate: ({ job, dueAt }) => {
      setEditing(null);
      return optimistic((jobs) =>
        byDueAt(jobs.map((entry) => (entry.agentId === job.agentId ? { ...entry, dueAt, enabled: true } : entry))),
      );
    },
    onError: (error, _input, context) => rollback(error, context),
    onSettled: () => {
      notifyScheduleChanged();
      return queryClient.invalidateQueries({ queryKey });
    },
  });

  // Only the rows on screen change; one being sent cannot be turned off any more.
  const toggleAll = useMutation({
    mutationFn: async (input: { enabled: boolean; jobs: ScheduledJob[] }) =>
      (
        await setAllEnabled({
          enabled: input.enabled,
          jobs: input.jobs.map(({ agentId, dueAt }) => ({ agentId, dueAt })),
        })
      ).changed,
    onMutate: ({ enabled, jobs: shown }) => {
      const ids = new Set(shown.map((job) => job.agentId));
      return optimistic((jobs) => jobs.map((entry) => (ids.has(entry.agentId) ? { ...entry, enabled } : entry)));
    },
    onSuccess: (changed, { enabled }) =>
      toast.show(`${changed} ${changed === 1 ? "schedule" : "schedules"} turned ${enabled ? "on" : "off"}`),
    onError: (error, _input, context) => rollback(error, context),
    onSettled: () => {
      notifyScheduleChanged();
      return queryClient.invalidateQueries({ queryKey });
    },
  });

  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const jobs = query.data ?? [];
  const summary = summaryLabels(jobs);
  const bulk = bulkAction(jobs);

  let content;
  if (query.isPending) {
    content = (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      </View>
    );
  } else if (query.isError) {
    content = (
      <View style={styles.centered}>
        <Icon name="TriangleAlert" size={24} color={theme.colors.statusDanger} />
        <Text style={styles.emptyTitle}>Couldn’t load schedules</Text>
        <Text style={styles.emptyBody}>{query.error instanceof Error ? query.error.message : String(query.error)}</Text>
        <Pressable accessibilityRole="button" onPress={() => void query.refetch()} style={styles.retry}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  } else if (jobs.length === 0) {
    content = (
      <View style={styles.centered}>
        <View style={styles.emptyIcon}>
          <Icon name="AlarmClockCheck" size={24} color={theme.colors.foregroundMuted} />
        </View>
        <Text style={styles.emptyTitle}>Nothing scheduled</Text>
        <Text style={styles.emptyBody}>Agents stopped by a usage limit appear here.</Text>
      </View>
    );
  } else {
    content = (
      <>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.summary} accessibilityRole="header">
              {summary.title}
            </Text>
            {summary.detail ? <Text style={styles.summaryDetail}>{summary.detail}</Text> : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={bulk.label}
            hitSlop={4}
            onPress={() => toggleAll.mutate({ enabled: bulk.enabled, jobs: jobs.filter((job) => !job.sending) })}
            style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
          >
            <Icon name={bulk.enabled ? "Power" : "PowerOff"} size={14} color={theme.colors.foreground} />
            <Text style={styles.buttonText}>{layout.compact ? bulk.shortLabel : bulk.label}</Text>
          </Pressable>
          {layout.compact ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh"
              hitSlop={4}
              onPress={() => void query.refetch()}
              style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
            >
              <Icon name="RefreshCw" size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          )}
        </View>
        {groupByDay(jobs, now).map((group) => (
          <View key={group.label} style={styles.section}>
            <Text style={styles.sectionTitle}>{group.label}</Text>
            <View style={styles.card}>
              {group.jobs.map((job, index) => (
                <JobRow
                  key={job.agentId}
                  job={job}
                  now={now}
                  divided={index > 0}
                  editing={editing === job.agentId && !job.sending}
                  compact={layout.compact}
                  theme={theme}
                  styles={styles}
                  onEdit={(start) => setEditing(start ? job.agentId : null)}
                  onOpen={openAgent}
                  onReschedule={(target, dueAt) => move.mutate({ job: target, dueAt })}
                  onToggle={(target, enabled) => toggle.mutate({ job: target, enabled })}
                />
              ))}
            </View>
          </View>
        ))}
      </>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        layout.compact ? (
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            tintColor={theme.colors.foregroundMuted}
          />
        ) : undefined
      }
    >
      {content}
    </ScrollView>
  );
}
