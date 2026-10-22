import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Colors = PluginSurfaceProps["theme"]["colors"];

// Text the composer controls and the settings screen share; the sidebar keeps its own sheet.
export const bodyText = (colors: Colors) => ({ color: colors.foreground, fontSize: 14 });
export const headingText = (colors: Colors) => ({ color: colors.foreground, fontSize: 16, fontWeight: "600" as const });
export const mutedText = (colors: Colors) => ({ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 });
