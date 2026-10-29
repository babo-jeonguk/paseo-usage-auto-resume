# Paseo 0.14 compatibility

Validated against Paseo `0.14.0` on October 29, 2026. The plugin continues to support Paseo `>=0.11.0`. The research behind this change is in [Paseo 0.14 agent lifecycle references](research/paseo-0.14-agent-lifecycle-references.md).

## Closed agents

Paseo 0.14 closes the runtime of an agent that has been idle for an hour, checked once a minute, and stores the agent as `closed`. The conversation and provider session are kept, and the next prompt reopens them. The host setting `agents.idleRuntimeCleanup: false` turns this off; it is on by default. A daemon shutdown already stored every agent as `closed`, on every supported version. See Paseo's [lifecycle reference](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md) and the [change that added the cleanup](https://github.com/getpaseo/paseo/pull/7782).

The due-time check canceled a closed agent's reservation as `agent_busy`. A limit's reset is usually hours away, so on 0.14 most reservations would have been canceled before their continue. A closed agent now goes on like an idle one: `send()` reopens its saved session, and the reservation's other checks still apply. Paseo has no user action that closes an agent; archiving is how a user ends one, and it still cancels. An agent that is starting still cancels.

The startup scan still searches idle and error agents only. Reading a closed agent's timeline reopens its runtime, so a stop missed while the plugin was not running is not found once the agent has closed.

## Session reopen when the plugin changes

From 0.14, starting, stopping or reloading a plugin that declares `before("agent.session_open")` makes Paseo reopen the session of each open agent before its next prompt, so that changed tools and MCP servers take effect. A plugin that only reads the request, as this one does to capture launch paths, is not exempt. Installing or updating Auto Resume therefore reopens open agents' sessions. A prompt whose reopen fails fails with it, including a continue, which is then recorded as not sent. See the [plugin reference](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/plugins/reference.md#attach-tools-to-agents) and the [invalidation](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/runtime.ts#L307-L310).

One such failure is reproducible on 0.14.0. A Codex agent created but not yet prompted has a thread with no rollout. When the plugin is disabled, or installed, updated or reloaded, before that agent's first prompt, the reopen resumes the thread and the prompt fails with `Failed to resume Codex thread …: no rollout found`. Paseo's [Codex resume](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L4081-L4107) only recovers an archived thread. This is a Paseo issue that the plugin's hook triggers; the plugin does not change it.

## SDK

The Paseo SDK stays pinned to `0.11.0`. 0.14 adds required fields to `PluginSessionOpenRequest`; session capture now asks only for the agent, purpose and environment it reads, so the source and tests compile with both SDKs.

## Validation

- Type checking and all 488 tests passed with SDK `0.11.0` and, in an isolated copy, SDK `0.14.0`.
- The [end-to-end simulation](../e2e/README.md) ran on an isolated `0.14.0` daemon with the real Claude Code, Codex and Antigravity CLIs, installing this change from a local Git source.
  - Its new item 16 stops an agent at a limit, restarts the daemon, and moves the reservation due. The agent read `closed` after the restart for all three providers, and the tick sent one continue into its timeline.
  - The same item with `main` canceled the reservation as `agent_busy` (`agent is closed`) and sent nothing.
  - Every other item passed, except 11 for Codex, which failed with the `no rollout found` reopen described above. Its harness now turns the plugin back on after a failure, so the items after it still run.

The one-hour idle cleanup itself, connected hosts, the native apps and real provider limits were not exercised.
