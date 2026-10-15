import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

// Paseo provides only @getpaseo/plugin to installed plugins, so derive the rest from it.
export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoAgent = NonNullable<
  Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>
>["agent"];
export type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
