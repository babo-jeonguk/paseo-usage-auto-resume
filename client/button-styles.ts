import type { Colors } from "./text-styles";

// Button shapes shared by the composer controls, the note editor and the settings screen.
export const buttonShape = { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 6 } as const;
/** Dims when unavailable and darkens while pressed, with or without a border around it. */
export const pressFeedback = (colors: Colors, pressed: boolean, unavailable = false) => ({
  opacity: unavailable ? 0.4 : 1, backgroundColor: pressed ? colors.surface2 : "transparent",
});
export const outlined = (colors: Colors, pressed: boolean, unavailable = false) => ({
  ...buttonShape, borderWidth: 1, borderColor: colors.border, ...pressFeedback(colors, pressed, unavailable),
});
/** The accent-filled button for the one action a block leads to. */
export const filled = (colors: Colors, pressed: boolean, unavailable = false) => ({
  ...buttonShape, backgroundColor: colors.accent, opacity: unavailable ? 0.4 : pressed ? 0.85 : 1,
});
