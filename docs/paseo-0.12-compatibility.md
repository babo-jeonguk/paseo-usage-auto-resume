# Paseo 0.12 compatibility

Validated against Paseo `0.12.0-beta.2` on October 18, 2026. The plugin continues to support Paseo `>=0.11.0`.

## Background workspaces

Paseo 0.12 excludes background workspace agents from default discovery. Auto Resume includes them in its startup scan, so a limit stop that happened while the plugin was unloaded can create a reservation after it starts again. Hiding a workspace from the sidebar does not disable automatic resumes.

The scan still checks up to 200 idle/error agents active in the preceding 12 hours. Recovered reservations pass through the existing provider, authentication, usage and agent-state checks.

Older SDKs ignore the background discovery field. If a newer SDK explicitly rejects inclusive discovery against an older daemon, the plugin retries the listing without that field. Other discovery failures follow the normal error path.

See Paseo's [background workspace lifecycle](https://github.com/getpaseo/paseo/blob/v0.12.0-beta.2/docs/agent-lifecycle.md#background-workspaces) and [SDK capability gate](https://github.com/getpaseo/paseo/blob/v0.12.0-beta.2/packages/client/src/daemon-client.ts#L2412).

## Validation

- Type checking and all 119 tests passed with SDK `0.11.0` and, in an isolated copy, SDK `0.12.0-beta.2`.
- An isolated beta.2 daemon loaded the actual plugin. A visible agent and hidden parent/child agents were stopped before plugin installation; the startup scan created all three reservations. Live turn hooks also created reservations for all three.
- A delivery check connected the product resumer to the beta daemon with controlled subscription readiness and time. It sent one continue to each existing agent, created no new agents, and preserved the parent/child relationship.
- The beta's bundled web app passed seven smoke checks in a 390 × 844 touch Chromium viewport: sidebar entry, time editing, ten-minute delay, reservation toggles, opening a hidden child in a sheet, opening it as a tab, and navigating to provider settings. No browser `pageerror` events occurred. A separate check saved and restored a provider switch.

The daemon used an upstream fake AgentClient fixture, temporary storage and a test provider profile. The native iOS/Android apps, real subscription endpoints and a real model's execution of subagent resume tools were not exercised.

## Usage CLI

Paseo's new usage CLI is an optional manual diagnostic. For example, when an agent remains in usage verification wait:

```bash
paseo usage ls --agent <agent-id> --refresh --json
```

This shows the host's account quota report for comparison. Automation must inspect report status: a successful CLI request can contain an unavailable or failed report. See the [official usage CLI contract](https://github.com/getpaseo/paseo/blob/v0.12.0-beta.2/public-docs/cli.md#account-usage).
