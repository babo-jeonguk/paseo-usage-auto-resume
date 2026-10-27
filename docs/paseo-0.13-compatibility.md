# Paseo 0.13 compatibility

Validated against Paseo `0.13.2` on October 27, 2026. The plugin continues to support Paseo `>=0.11.0`. The research behind this change is in [Paseo 0.13.0 changes](research/paseo-0.13.0-changes.md).

## Turn-end timeline

Paseo 0.13 sends `agent.turn_ended` with `timeline: []`; the field is deprecated and has no compatibility flag. Claude can end a turn normally with only a closing limit notice in its timeline, so without the timeline those stops made no reservation. A failed turn whose error carried the notice was still detected.

When the event's timeline is empty, the plugin now reads the agent's latest 20 timeline items with `timeline.refetch({ direction: "tail", limit: 20 })`, the read the startup scan already used. Paseo 0.11 and 0.12 still send the timeline, which is used as before without a read. A read that fails, by an error page or a rejected request, counts as no items: a turn-end check falls back to the turn's error, and the startup scan skips that agent and goes on to the next.

See Paseo's [lifecycle reference](https://github.com/getpaseo/paseo/blob/v0.13.2/public-docs/plugins/reference.md#L830-L843) and the [change that emptied the field](https://github.com/getpaseo/paseo/pull/7477).

## Connected hosts

Plugins are installed per daemon, and lifecycle hooks run on the daemon that runs the agent. An agent that a connected host runs on another machine is resumed only by the plugin installed on that machine's daemon. See Paseo's [plugin host model](https://github.com/getpaseo/paseo/blob/v0.13.2/public-docs/plugins/reference.md#L2673), its [hook scope](https://github.com/getpaseo/paseo/blob/v0.13.2/public-docs/plugins/reference.md#L654) and the [agent manager that publishes them](https://github.com/getpaseo/paseo/blob/v0.13.2/packages/server/src/server/agent/agent-manager.ts).

## SDK and UI imports

The Paseo SDK stays pinned to `0.11.0`. The client keeps importing `Icon`, `ScrollView`, `TextInput` and `useToast` from `@getpaseo/plugin/client/react-native`: 0.13 still re-exports them there, though deprecated, and 0.11's `@getpaseo/plugin/client/ui` does not export them. Moving to `client/ui` waits until the minimum host is raised to 0.13.

## Validation

- Type checking and all 485 tests passed with SDK `0.11.0` and, in an isolated copy, SDK `0.13.2`.
- An isolated `0.13.2` daemon loaded the plugin with a stand-in ACP agent that ends each turn normally with Claude's closing notice, `You've hit your limit · resets 3pm (Asia/Seoul)`. The plugin copy reported that provider as Claude and stubbed the subscription check.
  - Every `agent.turn_ended` arrived with an empty timeline.
  - An agent started after the startup scan had run got a reservation for the stated reset from its turn end alone.
  - With the previous `server/resumer.ts`, an agent started the same way got none.

Two connected hosts, the native apps and real provider limits were not exercised.
