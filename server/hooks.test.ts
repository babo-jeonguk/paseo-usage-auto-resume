import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";

test("server entry registers all lifecycle hooks through addHook and removes them on cleanup", () => {
  const hooks: string[] = [];
  const stopped: string[] = [];
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready" as const, revision: "1", values: {} }),
      subscribe: () => () => {},
    }),
    handle: () => {},
    addHook: (name: string) => {
      hooks.push(name);
      return () => { stopped.push(name); };
    },
    on: () => { throw new Error("deprecated server.on must not be called"); },
    before: () => { throw new Error("deprecated server.before must not be called"); },
  } as unknown as PluginServerContext;

  const cleanup = contribute(server);
  try {
    assert.deepEqual(hooks, [
      "agent.open.before",
      "agent.turn.before",
      "agent.turn.after",
      "agent.archive.after",
      "agent.permission.before",
      "agent.create.after",
      "agent.close.after",
    ]);
  } finally {
    if (typeof cleanup === "function") cleanup();
  }
  assert.deepEqual(stopped, hooks);
});
