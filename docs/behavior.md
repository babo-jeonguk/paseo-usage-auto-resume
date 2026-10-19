# Behavior, data access and troubleshooting

[English README](../README.md) · [한국어 README](../README.ko.md)

## From a limit stop to a resume

Usage Auto Resume detects short provider limit notices and explicit limit error codes at the end of a turn. Claude can finish a turn normally while leaving a limit notice, so detection also checks the closing assistant message. Context overflow, ordinary errors and API billing failures are excluded.

The plugin keeps one resume reservation per agent. When a notice states a reset time, it schedules that time plus two minutes without querying usage. Codex and Claude authentication is checked separately to bind the account/model when available; a failed identity check does not replace the stated schedule with an earlier verification wait. API-key and external billing routes are excluded. A saved OAuth login alone does not override an active API route.

Without a reset time, Codex and Claude authentication and account/model usage are checked directly to choose the schedule, including for workspace credit notices. Failed authentication or usage checks create a verification wait. Every Codex/Claude delivery still requires fresh subscription authentication and available usage; a timestamp alone never authorizes a continue.

- **Codex:** reads account/config status without refreshing the login. When usage is needed, it queries the exact ChatGPT workspace's usage. Account/workspace and model scope are bound to the reservation.
- **Claude:** checks `auth status --json` and verifies the OAuth profile. When usage is needed, it reads subscription usage. Account/organization and model scope are bound to the reservation. macOS Keychain credentials are not supported, so Claude on macOS waits for verification before delivery.
- **Antigravity:** agy 1.4.0 reports no account identity, and Paseo has no Antigravity usage source. The plugin follows the notice's stated reset without reading quota. A weekly quota exhausted behind a five-hour notice is not seen. Known API routes (`GEMINI_API_KEY`, `AGY_ADC_AUTH`, `GOOGLE_GEMINI_BASE_URL`) are excluded.

For Codex and Claude, the applicable five-hour and weekly usage windows determine the wait when the notice has no reset and during pre-send checks. Multiple exhausted windows wait for their latest known reset. Codex's exact-model `model_usage.available_at` can supply that model's reset. A known reset gets a two-minute buffer; a stale exhausted window still requires fresh confirmation of recovery after that timestamp passes.

Credit and spending notices are also treated as limit stops. They do not themselves decide readiness: credits indicate whether usage can run past a window. When no applicable window is exhausted and usage is verified ready, the plugin retries the continue after 15, 30 and 60 minutes, then gives up if each hits another limit. A future reset in the notice is still honored. An exhausted window discovered later starts this retry sequence over. Refilling credits does not restart a finished sequence.

Unknown authentication, unavailable usage or a stale exhausted window schedules a read-only recheck in 15 minutes, without a continue. Antigravity has no quota verification and, without a stated reset, uses the bounded 15/30/60-minute continue sequence. Actual automatic continues are bounded to 24 consecutive limit stops; read-only checks do not consume these attempts.

## Checks before sending

The plugin cancels a reservation when a new turn starts or when its final agent check finds a newer user message, a running/closed/archived agent, pending permissions, or a provider change. A known selected model is saved even when authentication is unavailable. A different model or a change from a previously verified Codex/Claude account identity cancels the reservation, including after a restart. If account identity could not initially be verified, it is bound on the first successful check. The provider switch and reservation switch are checked before sending.

Sending is claimed in persistent storage first to prevent duplicate delivery after a crash. A send interrupted at that point may therefore be lost rather than retried. These checks do not provide an atomic guarantee against every concurrent change between checking and sending.

The fixed continue prompt asks the parent agent to review the latest conversation, workspace and task status, then continue unfinished work. It also asks the parent to resume unfinished subagents using their existing identities and tools, respect user pauses/cancellations and report blockers. The plugin sends only to the parent; actual subagent continuation depends on the tools available to it. It does not create a new agent or switch providers.

## Reservation and provider controls

A new reservation starts enabled. Turning it off leaves it visible until its due time; it can be re-enabled before then. At its due time, a disabled reservation is skipped and removed. Sending another message also cancels it.

**+10m** delays a reservation by ten minutes. Selecting its time opens an editor with **Today**, **Tomorrow**, and the reservation's own day when a weekly reset is further away. The earliest allowed time is the later of reset + two minutes and one minute from now; without a known reset it is one minute from now. The latest is seven days and one hour from now. Changing the time turns the reservation on. Editing a verification wait changes its next check time; it does not authorize a continue.

The header switch changes only the pending reservations shown on screen. New reservations and ones already being sent are left alone. The list refreshes every 30 seconds, with a refresh button on desktop and pull to refresh on mobile. Times use the viewing device's time zone.

Provider discovery follows each provider's `extends` chain to built-in Claude, Codex or Antigravity. Profiles sharing an account still have separate switches. All supported providers, including newly discovered ones, start on. Turning one off cancels all of its pending reservations, including individually disabled ones. Turning it back on does not restore them; subsequent limit stops can create new reservations. A startup scan can also find a recent stop again.

Settings are per daemon. Hosts upgrading from the earlier one-ID-per-CLI settings start with every provider on. If settings cannot be read, automatic resumes wait rather than falling back to defaults.

## Restarts and missed stops

Reservations survive daemon and plugin restarts. Paseo supplies its plugin API inside lifecycle hooks and screen requests, so due-job checks wait until one of these connects it after startup. Opening **Auto Resume** supplies that API. A connected daemon continues checking without keeping the app open; the daemon host must stay running and awake.

The startup scan searches up to 200 idle/error agents active in the preceding 12 hours for missed limit stops. Existing persisted reservations can wait longer, including for weekly resets. Codex and Antigravity recovery checks error notices; Claude also checks recent timeline notices.

At session open, the plugin captures non-secret launch paths and credential-presence flags. These survive restarts with the reservation. For a session opened before the plugin loaded, account checks use the daemon environment plus provider configuration; environment values added by other plugins at session open are not available. Unrecognized quota shapes and custom launchers with multiple command arguments wait for verification. Known one-command launchers can use native account/status protocols.

## Data access and storage

The plugin reads agent state, recent timeline notices, provider configuration and configured launch environments through Paseo. It reads CLI login stores and runs read-only status probes to identify the authentication actually in use.

Codex checks contact `chatgpt.com` account usage; Claude checks contact `api.anthropic.com` OAuth profile and usage endpoints. Access tokens authenticate those requests. The plugin does not refresh or rewrite login stores, purchase credits or enable overages. Status/usage checks create no model turns. Tokens are not saved in jobs, logged or included in the continue prompt.

Continue prompts are sent through Paseo to the existing agent and its provider; the agent can then perform model turns and tools as usual. Local reservation storage does not mean all processing stays on the host.

| Stored data | Location |
| --- | --- |
| Resume jobs, hashed account/model identity, sanitized launch paths and boolean credential-presence flags | `$PASEO_HOME/plugin-data/usage-auto-resume/jobs.json` |
| Provider switches | `$PASEO_HOME/plugin-settings/usage-auto-resume/providers.json` |

The default Paseo home is `~/.paseo`. Settings and jobs are separate from plugin source code.

## Troubleshooting

| What you see | Meaning and next step |
| --- | --- |
| Empty Auto Resume list | No eligible stop has been found. Use agents normally; only detected limit stops create reservations. Older stops can be outside the startup scan. |
| Waiting for account verification | The CLI authentication could not be confirmed. Check the CLI login and configured launcher. Claude on macOS remains here because Keychain is unsupported. |
| Waiting for usage verification | Usage is unreadable, unrecognized or still exhausted without a usable future reset. The displayed time is the next check; time passing alone does not authorize a continue. |
| Reservation disappeared | It may have been sent, skipped, canceled by agent activity/settings, or reached its retry bound. Check the conversation and daemon log. |
| Saved jobs are not checked after restart | Open Auto Resume or let a lifecycle event reconnect the Paseo API. |
| Reservation canceled after changing account or model | Codex/Claude reservations are tied to the original identity. A subsequent detected limit stop can create a new one. |

Plugin log lines use the `[usage-auto-resume]` prefix in the daemon log.
