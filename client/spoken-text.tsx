import type { ReactNode } from "react";
import { Platform, Text, type StyleProp, type TextStyle } from "react-native";

// Kept in the accessibility tree but not on screen: one transparent pixel that clips its text.
const visuallyHidden = { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 } as const;

/**
 * Text that screen readers hear as `spoken` instead of what it shows, e.g. "in 7d" read as "in 7 days".
 * Native reads `accessibilityLabel`. The web ignores a label on role-less text, so there the shown text
 * is hidden from screen readers and the spoken wording is kept, visually hidden, beside it.
 */
export function SpokenText({ style, spoken, children }: { style?: StyleProp<TextStyle>; spoken: string; children: ReactNode }) {
  if (Platform.OS !== "web") {
    return (
      <Text style={style} accessibilityLabel={spoken}>
        {children}
      </Text>
    );
  }
  return (
    <Text style={style}>
      <Text aria-hidden>{children}</Text>
      <Text style={visuallyHidden}>{spoken}</Text>
    </Text>
  );
}
