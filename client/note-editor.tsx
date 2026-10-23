import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { NOTE_MAX_CHARS } from "../shared/prompt";
import { setNoteRpc, type ScheduledJob } from "../shared/rpc";
import { filled, outlined } from "./button-styles";
import { charactersLeft, noteRefusal } from "./format";
import { jobsQueryKey } from "./query-keys";
import { notifyScheduleChanged } from "./schedule-changes";
import { accentText, bodyText, dangerText, inputText, mutedText } from "./text-styles";

type Theme = PluginSurfaceProps["theme"];

/**
 * Writes the note sent after one reservation's continue. Saving never moves or switches the
 * reservation, and the typed text stays through every failure.
 */
export function NoteEditor(props: {
  job: ScheduledJob;
  hostId: string;
  theme: Theme;
  onClose(): void;
}) {
  const { job, theme } = props;
  const { colors } = theme;
  const setNote = useRpc(setNoteRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryKey = jobsQueryKey(props.hostId);
  // What the editor opened on, which Escape checks for typing. Save compares with the saved note
  // instead, which another surface may have changed meanwhile.
  const [initial] = useState(job.note ?? "");
  const [text, setText] = useState(initial);
  // The reservation the user saw. A refusal moves it to the latest one, which the screen then
  // shows, so a second save is a choice made with the new time in view.
  const [pin, setPin] = useState(job.dueAt);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (note: string) => {
      await queryClient.cancelQueries({ queryKey });
      const result = await setNote({ agentId: job.agentId, dueAt: pin, note });
      if (result.changed) return { result, latest: pin };
      await queryClient.refetchQueries({ queryKey });
      const latest = queryClient.getQueryData<ScheduledJob[]>(queryKey)?.find((entry) => entry.agentId === job.agentId)?.dueAt;
      return { result, latest: latest ?? pin };
    },
    onSuccess: ({ result, latest }, note) => {
      if (!result.changed) {
        setPin(latest);
        setProblem(noteRefusal(result.reason));
        return;
      }
      const saved = note.trim() || undefined;
      queryClient.setQueryData<ScheduledJob[]>(queryKey, (jobs) => jobs?.map((entry) =>
        entry.agentId === job.agentId && entry.dueAt === pin ? { ...entry, note: saved } : entry));
      toast.show(saved ? "Extra instructions saved" : "Extra instructions removed", { variant: "success" });
      props.onClose();
    },
    onError: () => setProblem("Couldn’t save the extra instructions. Try again."),
    onSettled: () => {
      notifyScheduleChanged();
      return queryClient.invalidateQueries({ queryKey });
    },
  });

  const busy = save.isPending;
  const unchanged = text.trim() === (job.note ?? "") && pin === job.dueAt;
  const left = charactersLeft(text.length, NOTE_MAX_CHARS);
  const button = (label: string, onPress: () => void, unavailable: boolean) => (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: unavailable }}
      disabled={unavailable} onPress={onPress} style={({ pressed }) => outlined(colors, pressed, unavailable)}
    >
      <Text style={bodyText(colors)}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        accessibilityLabel={`Extra instructions for ${job.title ?? "Untitled agent"}`}
        multiline
        numberOfLines={5}
        maxLength={NOTE_MAX_CHARS}
        autoFocus
        value={text}
        onChangeText={setText}
        editable={!busy}
        placeholder="Extra instructions sent after the continue prompt"
        placeholderTextColor={colors.foregroundMuted}
        textAlignVertical="top"
        // Escape closes only an untouched editor; typed text leaves through Cancel. Like Cancel, it
        // waits for a save in flight, whose result closes whichever editor is open by then.
        onKeyPress={(event) => {
          if (event.nativeEvent.key === "Escape" && !busy && text.trim() === initial) props.onClose();
        }}
        style={{
          ...inputText(colors), minHeight: 112, maxHeight: 220,
          borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10,
        }}
      />
      {problem ? (
        <Text accessibilityRole="alert" style={dangerText(colors)}>{problem}</Text>
      ) : left ? (
        <Text accessibilityLiveRegion="polite" style={mutedText(colors)}>{left}</Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {job.note ? button("Remove", () => save.mutate(""), busy) : null}
        <View style={{ flex: 1 }} />
        {button("Cancel", props.onClose, busy)}
        <Pressable
          accessibilityRole="button" accessibilityLabel="Save extra instructions" accessibilityState={{ disabled: busy || unchanged, busy }}
          disabled={busy || unchanged} onPress={() => save.mutate(text)}
          style={({ pressed }) => filled(colors, pressed, busy || unchanged)}
        >
          {busy ? <ActivityIndicator size="small" color={colors.accentForeground} /> : null}
          <Text style={accentText(colors)}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}
