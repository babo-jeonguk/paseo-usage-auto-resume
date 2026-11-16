import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { ScheduledJob } from "../shared/rpc";
import { dayChoices, relativeLabel, relativeSpoken, timeEdit, type TimeEditorStart, type TimeEntry } from "./format";
import { SpokenText } from "./spoken-text";

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

/**
 * Replaces the time line while a time is typed. The draft lives with the surface, so a row drawn again
 * keeps it. It opens on the reservation's own time, which saves as is; the server has the final say on
 * any other. Days are counted from the moment it opened; the window check reads the current time on each
 * render, not this surface's clock.
 */
export function TimeEditor(props: {
  job: ScheduledJob;
  now: number;
  compact: boolean;
  /** Composer popovers can be narrower than the screen's compact list rows. */
  stackDays?: boolean;
  theme: Theme;
  /** The opening entry and the entry as typed. */
  time: { start: TimeEditorStart; entry: TimeEntry };
  onChange(entry: TimeEntry): void;
  /** Saving is off, as while the reservation could not be refreshed; the typed time stays. */
  locked?: boolean;
  onSave(dueAt: string): void;
  onCancel(): void;
}) {
  const { job, now, theme } = props;
  const styles = createTimeEditorStyles(theme, props.compact);
  const { start, entry } = props.time;
  const { text, day } = entry;
  // The days the user picked from stay the same calendar days while the editor is open.
  const choices = dayChoices(job.dueAt, start.openedAt);
  const { dueAt, unchanged, problem } = timeEdit(job, start, entry);
  const blocked = !!problem || !!props.locked;
  const save = () => {
    if (blocked) return;
    // The reservation's own time: nothing moves and nothing is recorded, so saving only closes the editor.
    if (unchanged) props.onCancel();
    else if (dueAt) props.onSave(dueAt);
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
            onPress={() => props.onChange({ ...entry, day: choice.offset })}
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
          onChangeText={(value) => props.onChange({ ...entry, text: value })}
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
        <SpokenText style={styles.editHint} spoken={`${job.waiting ? "Checks again" : "Continues"} ${relativeSpoken(dueAt!, now)}.`}>
          {job.waiting ? "Checks again" : "Continues"} {relativeLabel(dueAt!, now)}.
        </SpokenText>
      )}
    </View>
  );
}
