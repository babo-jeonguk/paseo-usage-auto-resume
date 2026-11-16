import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// Paseo provides only @getpaseo/plugin to installed plugins, so derive the rest from it.
export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoAgent = NonNullable<
  Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>
>["agent"];
// A turn's end no longer carries a timeline, so take the item type from the timeline read the
// plugin uses instead.
type TimelineRead = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>;
export type AgentTimelineItem = TimelineRead["entries"][number]["item"];
