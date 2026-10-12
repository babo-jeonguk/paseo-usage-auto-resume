import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from "react-native";
import { listScheduledRpc, setEnabledRpc, type ScheduledJob } from "../shared/rpc";
import {
  clockLabel,
  groupByDay,
  placeLabel,
  providerLabel,
  relativeLabel,
  summaryLabels,
} from "./format";
import { Toggle } from "./toggle";

type Theme = PluginScreenProps["theme"];

/** Re-renders on a cadence so countdowns stay current without refetching. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

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
    header: { flexDirection: "row" as const, alignItems: "center" as const, marginBottom: 24 },
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
    section: { marginBottom: 24 },
    sectionTitle: { color: colors.foregroundMuted, fontSize: 12, marginLeft: 4, marginBottom: 12 },
    card: {
      backgroundColor: colors.surface1,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: "hidden" as const,
    },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
    rowPressed: { backgroundColor: colors.surface2 },
    rowBody: { flex: 1, minWidth: 0 },
    timeLine: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8 },
    time: {
      fontSize: 26,
      fontWeight: "600" as const,
      letterSpacing: -0.5,
      fontVariant: ["tabular-nums" as const],
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
  theme: Theme;
  styles: Styles;
  onToggle(job: ScheduledJob, enabled: boolean): void;
  onOpen?: (agentId: string) => void;
}) {
  const { job, now, styles, theme, onOpen } = props;
  const on = job.enabled;
  const tone = on ? theme.colors.foreground : theme.colors.foregroundMuted;
  const title = job.title ?? "Untitled agent";
  const place = placeLabel(job);
  const countdown = job.resetAt ? relativeLabel(job.dueAt, now) : `${relativeLabel(job.dueAt, now)} · reset unknown`;
  const status = job.sending ? "Continuing…" : on ? countdown : "Skipped";
  const resetSpoken = job.resetAt ? `limit resets at ${clockLabel(job.resetAt)}` : "reset time unknown, checks again";

  const body = (
    <>
      <View style={styles.rowBody}>
        <View style={styles.timeLine}>
          <Text style={[styles.time, { color: tone }]}>{clockLabel(job.dueAt)}</Text>
          <Text style={styles.relative}>{status}</Text>
        </View>
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
      <Toggle
        value={on}
        disabled={job.sending}
        onValueChange={(value) => props.onToggle(job, value)}
        theme={theme}
        accessibilityLabel={`Continue ${title} automatically at ${clockLabel(job.dueAt)}, ${resetSpoken}`}
      />
    </>
  );

  const rowStyle = [styles.row, props.divided ? styles.rowDivider : null];
  if (!onOpen) return <View style={rowStyle}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${on ? `continues at ${clockLabel(job.dueAt)}` : "skipped"}`}
      accessibilityHint="Opens the agent"
      onPress={() => onOpen(job.agentId)}
      style={({ pressed }) => [...rowStyle, pressed ? styles.rowPressed : null]}
    >
      {body}
    </Pressable>
  );
}

export function AutoResumeScreen({ theme, host, layout, navigation }: PluginScreenProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const listScheduled = useRpc(listScheduledRpc);
  const setEnabled = useRpc(setEnabledRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow(15_000);
  const queryKey = useMemo(() => ["usage-auto-resume", "jobs", host.id], [host.id]);

  const query = useQuery({
    queryKey,
    queryFn: async () => (await listScheduled({})).jobs,
    refetchInterval: 30_000,
  });

  const toggle = useMutation({
    mutationFn: async (input: { job: ScheduledJob; enabled: boolean }) => {
      const { changed } = await setEnabled({
        agentId: input.job.agentId,
        dueAt: input.job.dueAt,
        enabled: input.enabled,
      });
      if (!changed) throw new Error("This schedule already ran or changed.");
    },
    onMutate: async ({ job, enabled }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ScheduledJob[]>(queryKey);
      queryClient.setQueryData<ScheduledJob[]>(queryKey, (jobs) =>
        jobs?.map((entry) => (entry.agentId === job.agentId ? { ...entry, enabled } : entry)),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toast.error(error instanceof Error ? error.message : "Could not update the schedule.");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const jobs = query.data ?? [];
  const summary = summaryLabels(jobs);

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
          {layout.compact ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh"
              hitSlop={4}
              onPress={() => void query.refetch()}
              style={({ pressed }) => [styles.iconButton, pressed ? styles.rowPressed : null]}
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
                  theme={theme}
                  styles={styles}
                  onOpen={openAgent}
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
