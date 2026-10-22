import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

export type Colors = PluginSurfaceProps["theme"]["colors"];

// Text styles for the composer controls and the settings screen; the sidebar keeps its own sheet.
export const bodyText = (colors: Colors) => ({ color: colors.foreground, fontSize: 14 });
export const headingText = (colors: Colors) => ({ color: colors.foreground, fontSize: 16, fontWeight: "600" as const });
export const mutedText = (colors: Colors) => ({ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 });
/** The reservation time, large, with digits that keep their width as it changes. */
export const clockText = (colors: Colors) => ({ ...bodyText(colors), fontSize: 28, fontWeight: "600" as const, fontVariant: ["tabular-nums" as const] });
/** A delay chip's label. */
export const chipText = (colors: Colors) => ({ ...bodyText(colors), fontSize: 13, fontVariant: ["tabular-nums" as const] });
/** A label on the accent-filled button. */
export const accentText = (colors: Colors) => ({ color: colors.accentForeground, fontSize: 14, fontWeight: "600" as const });
