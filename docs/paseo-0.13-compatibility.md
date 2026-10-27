# Paseo 0.13 compatibility

Validated against Paseo `0.13.2` and `0.12.0` on October 27, 2026. The plugin continues to support Paseo `>=0.11.0`. The research behind this change is in [Paseo 0.13.0 changes](research/paseo-0.13.0-changes.md).

## Turn-end timeline

Paseo 0.13 sends `agent.turn_ended` with `timeline: []`; the field is deprecated and has no compatibility flag. Claude can end a turn normally with only a closing limit notice in its timeline, so without the timeline those stops made no reservation. A failed turn whose error carried the notice was still detected.

A turn end that was not canceled now reads the agent's latest 20 timeline items with `timeline.refetch({ direction: "tail", limit: 20 })`, the read the startup scan already used, on every supported Paseo version. The event's `timeline` is no longer read, so the plugin keeps working if a later Paseo drops the field. A read that fails counts as no items and is logged: a turn-end check falls back to the turn's error, and the startup scan skips that agent and goes on to the next. The SDK rejects a failed read rather than returning an error page, so before this change one failed read stopped the whole startup scan. Failed reads are not retried; a plugin restart runs the startup scan again.

See Paseo's [lifecycle reference](https://github.com/getpaseo/paseo/blob/v0.13.2/public-docs/plugins/reference.md#L830-L843) and the [change that emptied the field](https://github.com/getpaseo/paseo/pull/7477).

### Subagent limit stops

Claude transcripts of Paseo agents on this host, from September 23 to October 26, 2026, show how a limit stop reaches the parent agent:

- A background subagent stopped by a limit sends its parent a task notification. The parent calls the model on its own, and that turn ends with Claude's synthetic notice, such as `You've hit your session limit · resets 2:20am (Asia/Seoul)`. Paseo ends this turn like any other: on October 26 the plugin scheduled the parent from it about two seconds after the notice, with no user message in between.
- A foreground subagent returns the limit error as its tool result, and the parent's same turn ends with the notice.
- A notification that arrives after the parent has already stopped at the limit either starts a turn that ends with another notice, or waits without a model call and is delivered with the next message, such as the plugin's continue. Both were observed.

Paseo does not add a declared subagent task's notification to the parent's timeline, in 0.12 or 0.13, so the parent's latest items after such a stop end with the notice.

The read happens shortly after the turn ends, not at the moment the event is created. A turn Claude starts on its own in between adds its own items. Under a limit such a turn ends with another notice, so the read still finds one. A notification of a task other than a subagent, such as a background command, that reaches the parent's timeline in that interval could hide the notice. This was not observed.

## Connected hosts

Plugins are installed per daemon, and lifecycle hooks run on the daemon that runs the agent. An agent that a connected host runs on another machine is resumed only by the plugin installed on that machine's daemon. See Paseo's [plugin host model](https://github.com/getpaseo/paseo/blob/v0.13.2/public-docs/plugins/reference.md#L2673), its [hook scope](https://github.com/getpaseo/paseo/blob/v0.13.2/public-docs/plugins/reference.md#L654) and the [agent manager that publishes them](https://github.com/getpaseo/paseo/blob/v0.13.2/packages/server/src/server/agent/agent-manager.ts).

## SDK and UI imports

The Paseo SDK stays pinned to `0.11.0`. The client keeps importing `Icon`, `ScrollView`, `TextInput` and `useToast` from `@getpaseo/plugin/client/react-native`: 0.13 still re-exports them there, though deprecated, and 0.11's `@getpaseo/plugin/client/ui` does not export them. Moving to `client/ui` waits until the minimum host is raised to 0.13.

## Validation

- Type checking and all 486 tests passed with SDK `0.11.0` and, in an isolated copy, SDK `0.13.2`.
- Isolated `0.13.2` and `0.12.0` daemons loaded the plugin with a stand-in ACP agent that ends each turn normally with `You've hit your session limit · resets 3pm (Asia/Seoul)`. The plugin copy reported that provider as Claude and stubbed the subscription check.
  - `0.13.2` sent each turn end with an empty timeline; `0.12.0` sent it filled, and the plugin did not use it.
  - On both, an agent started after the startup scan had run got a reservation for the stated reset from its turn end alone.
  - On `0.13.2`, the plugin before this change made no reservation for such an agent.

Two connected hosts, the native apps and real provider limits were not exercised.
