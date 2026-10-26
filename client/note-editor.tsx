import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { NOTE_MAX_CHARS } from "../shared/prompt";
import { setNoteRpc, type ScheduledJob } from "../shared/rpc";
import { filled, outlined } from "./button-styles";
import type { EditEvent, EditSession } from "./edit-session";
import { charactersLeft, noteRefusal } from "./format";
import { jobsQueryKey } from "./query-keys";
import { notifyScheduleChanged } from "./schedule-changes";
import { accentText, bodyText, dangerText, inputText, mutedText } from "./text-styles";

type Theme = PluginSurfaceProps["theme"];

/**
 * Writes the note sent after one reservation's continue. What is typed, the time it is pinned to
 * and the save in flight live in the surface's `session`, so a row drawn again keeps them. Saving
 * never moves or switches the reservation, and the typed text stays through every failure.
 */
export function NoteEditor(props: {
  job: ScheduledJob;
  session: EditSession;
  dispatch(event: EditEvent): void;
  hostId: string;
  theme: Theme;
  /** Saving is off, as while the reservation could not be refreshed; the typed text stays. */
  locked?: boolean;
}) {
  const { job, session, dispatch, theme } = props;
  const { colors } = theme;
  const setNote = useRpc(setNoteRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryKey = jobsQueryKey(props.hostId);
  const { agentId } = job;

  // The results are handled here, not per call, so they still arrive if the row is drawn again.
  const save = useMutation({
    mutationFn: async ({ note, reservation }: { note: string; reservation: string; opened: object }) => {
      await queryClient.cancelQueries({ queryKey });
      return setNote({ agentId, id: reservation, note });
    },
    onSuccess: (result, { note, reservation, opened }) => {
      // Refused only once the reservation is gone, replaced or being sent: the list then closes the editor.
      if (!result.changed) return dispatch({ type: "refused", opened, problem: noteRefusal(result.reason) });
      const saved = note.trim() || undefined;
      queryClient.setQueryData<ScheduledJob[]>(queryKey, (jobs) => jobs?.map((entry) =>
        entry.id === reservation ? { ...entry, note: saved } : entry));
      toast.show(saved ? "Extra instructions saved" : "Extra instructions removed", { variant: "success" });
      dispatch({ type: "saved", opened });
    },
    onError: (_error, { opened }) => dispatch({ type: "failed", opened, problem: "Couldn’t save the extra instructions. Try again." }),
    onSettled: () => {
      notifyScheduleChanged();
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  const submit = (note: string) => {
    dispatch({ type: "save" });
    save.mutate({ note, reservation: session.reservation, opened: session.opened });
  };

  const { draft: text, problem } = session;
  const busy = session.saving;
  const blocked = busy || !!props.locked;
  // Save compares with the saved note, which another surface may have changed meanwhile.
  const unchanged = text.trim() === (job.note ?? "");
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
        onChangeText={(value) => dispatch({ type: "type", text: value })}
        editable={!busy}
        placeholder="Extra instructions sent after the continue prompt"
        placeholderTextColor={colors.foregroundMuted}
        textAlignVertical="top"
        onKeyPress={(event) => {
          if (event.nativeEvent.key === "Escape") dispatch({ type: "escape" });
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
        {job.note ? button("Remove", () => submit(""), blocked) : null}
        <View style={{ flex: 1 }} />
        {button("Cancel", () => dispatch({ type: "cancel" }), busy)}
        <Pressable
          accessibilityRole="button" accessibilityLabel="Save extra instructions" accessibilityState={{ disabled: blocked || unchanged, busy }}
          disabled={blocked || unchanged} onPress={() => submit(text)}
          style={({ pressed }) => filled(colors, pressed, blocked || unchanged)}
        >
          {busy ? <ActivityIndicator size="small" color={colors.accentForeground} /> : null}
          <Text style={accentText(colors)}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}
