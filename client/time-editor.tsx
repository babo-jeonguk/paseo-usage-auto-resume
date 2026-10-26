import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ScheduledJob } from "../shared/rpc";
import { clockLabel, dayChoices, dayOffset, relativeLabel, rescheduleProblem, timeOnDay } from "./format";

type Theme = PluginScreenProps["theme"];

function createTimeEditorStyles(theme: Theme, compact: boolean) {
  const { colors } = theme;
  return {
    iconButton: { width: 36, height: 36, borderRadius: 6, alignItems: "center" as const, justifyContent: "center" as const },
    pressed: { backgroundColor: colors.surface2 },
    disabled: { opacity: 0.4 },
    edit: { gap: 8, marginBottom: 6 },
    editLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: compact ? 4 : 8 },
    editInput: {
      width: compact ? 74 : 92,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      color: colors.foreground,
      fontSize: compact ? 19 : 22,
      fontVariant: ["tabular-nums" as const],
    },
    segments: {
      alignSelf: "flex-start" as const,
      flexDirection: "row" as const,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      overflow: "hidden" as const,
    },
    segment: { paddingHorizontal: compact ? 9 : 12, paddingVertical: 6 },
    segmentActive: { backgroundColor: colors.surface2 },
    segmentText: { color: colors.foregroundMuted, fontSize: 13, fontWeight: "500" as const },
    segmentTextActive: { color: colors.foreground },
    save: { backgroundColor: colors.accent },
    editHint: { color: colors.foregroundMuted, fontSize: 12 },
    editError: { color: colors.statusDanger, fontSize: 12 },
  };
}

/** Replaces the time line while a time is typed; the server still has the final say. */
export function TimeEditor(props: {
  job: ScheduledJob;
  now: number;
  compact: boolean;
  /** Composer popovers can be narrower than the screen's compact list rows. */
  stackDays?: boolean;
  theme: Theme;
  /** Saving is off, as while the reservation could not be refreshed; the typed time stays. */
  locked?: boolean;
  onSave(dueAt: string): void;
  onCancel(): void;
}) {
  const { job, now, theme } = props;
  const styles = createTimeEditorStyles(theme, props.compact);
  const choices = dayChoices(job.dueAt, now);
  const [text, setText] = useState(() => clockLabel(job.dueAt));
  const [day, setDay] = useState(() => Math.max(0, dayOffset(job.dueAt, now)));
  const dueAt = timeOnDay(text, day, now);
  const problem = dueAt ? rescheduleProblem(job, dueAt, now) : "Enter a time like 07:30.";
  const blocked = !!problem || !!props.locked;
  const save = () => {
    if (dueAt && !blocked) props.onSave(dueAt);
  };
  // A third day (a weekly reset) does not fit beside the field and buttons on a phone.
  const daysBelow = props.stackDays || (props.compact && choices.length > 2);

  const days = (
    <View style={styles.segments} accessibilityRole="radiogroup">
      {choices.map((choice) => {
        const active = choice.offset === day;
        return (
          <Pressable
            key={choice.offset}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => setDay(choice.offset)}
            style={[styles.segment, active ? styles.segmentActive : null]}
          >
            <Text style={[styles.segmentText, active ? styles.segmentTextActive : null]}>{choice.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={styles.edit}>
      <View style={styles.editLine}>
        <TextInput
          value={text}
          onChangeText={setText}
          autoFocus
          selectTextOnFocus
          maxLength={5}
          placeholder="HH:MM"
          placeholderTextColor={theme.colors.foregroundMuted}
          keyboardType="numbers-and-punctuation"
          returnKeyType="done"
          accessibilityLabel={`New time for ${job.title ?? "Untitled agent"}`}
          onSubmitEditing={save}
          onKeyPress={(event) => {
            if (event.nativeEvent.key === "Escape") props.onCancel();
          }}
          style={styles.editInput}
        />
        {daysBelow ? null : days}
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          hitSlop={8}
          onPress={props.onCancel}
          style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
        >
          <Icon name="X" size={18} color={theme.colors.foregroundMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save time"
          accessibilityState={{ disabled: blocked }}
          hitSlop={8}
          disabled={blocked}
          onPress={save}
          style={[styles.iconButton, styles.save, blocked ? styles.disabled : null]}
        >
          <Icon name="Check" size={18} color={theme.colors.accentForeground} />
        </Pressable>
      </View>
      {daysBelow ? days : null}
      {problem ? (
        <Text style={styles.editError} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      ) : (
        <Text style={styles.editHint}>{job.waiting ? "Checks again" : "Continues"} {relativeLabel(dueAt!, now)}.</Text>
      )}
    </View>
  );
}
