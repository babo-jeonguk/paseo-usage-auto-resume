# Behavior, data access and troubleshooting

[English README](../README.md) · [한국어 README](../README.ko.md)

## From a limit stop to a resume

Usage Auto Resume detects short provider limit notices and explicit limit error codes at the end of a turn. Claude can finish a turn normally while leaving a limit notice, so detection also checks the closing assistant message. Context overflow, ordinary errors and API billing failures are excluded.

The plugin keeps one resume reservation per agent. When a notice states a reset time, it schedules that time plus two minutes without querying usage. Codex and Claude authentication is checked separately to bind the account/model when available; a failed identity check does not replace the stated schedule with an earlier verification wait. API-key and external billing routes are excluded. A saved OAuth login alone does not override an active API route.

Without a reset time, Codex and Claude authentication and account/model usage are checked directly to choose the schedule, including for workspace credit notices. Failed authentication or usage checks create a verification wait. Every Codex/Claude delivery still requires fresh subscription authentication and available usage; a timestamp alone never authorizes a continue.

- **Codex:** reads account/config status without refreshing the login. When usage is needed, it queries the exact ChatGPT workspace's usage. Account/workspace and model scope are bound to the reservation. The login is read from the home Codex reports for itself; a Codex that reports none falls back to `CODEX_HOME`, then `.codex` in the user profile on Windows or in `HOME` elsewhere.
- **Claude:** checks `auth status --json` and verifies the OAuth profile. When usage is needed, it reads subscription usage. Account/organization and model scope are bound to the reservation. On macOS it reads the selected profile's Keychain item, with a two-second timeout per lookup, then its same-profile `.credentials.json` fallback if the item is unavailable. `CLAUDE_CONFIG_DIR` selects separate stores; the CLI's `CLAUDE_SECURESTORAGE_CONFIG_DIR` override, including an empty value selecting the default store, is also honored. Without either override, the credential file is the one in the configuration directory `auth status` reports, else `.claude` in the user profile on Windows or in `HOME` elsewhere. It never searches another profile to find a working token. Missing, unreadable or expired credentials wait for verification.
- **Antigravity:** agy 1.4.0 reports no account identity, and Paseo has no Antigravity usage source. The plugin follows the notice's stated reset without reading quota. A weekly quota exhausted behind a five-hour notice is not seen. Known API routes (`GEMINI_API_KEY`, `AGY_ADC_AUTH`, `GOOGLE_GEMINI_BASE_URL`) are excluded.

For Codex and Claude, the applicable five-hour and weekly usage windows determine the wait when the notice has no reset and during pre-send checks. Multiple exhausted windows wait for their latest known reset. Codex's exact-model `model_usage.available_at` can supply that model's reset. A known reset gets a two-minute buffer; a stale exhausted window still requires fresh confirmation of recovery after that timestamp passes.

Credit and spending notices are also treated as limit stops. They do not themselves decide readiness: credits indicate whether usage can run past a window. When no applicable window is exhausted and usage is verified ready, the plugin retries the continue after 15, 30 and 60 minutes, then gives up if each hits another limit. A future reset in the notice is still honored. An exhausted window discovered later starts this retry sequence over. Refilling credits does not restart a finished sequence.

Unknown authentication, unavailable usage or a stale exhausted window schedules a read-only recheck in 15 minutes, without a continue. Antigravity has no quota verification and, without a stated reset, uses the bounded 15/30/60-minute continue sequence. Actual automatic continues are bounded to 24 consecutive limit stops; read-only checks do not consume these attempts.

## Checks before sending

The plugin cancels a reservation when a new turn starts or when its final agent check finds a newer user message, a running/closed/archived agent, pending permissions, or a provider change. A known selected model is saved even when authentication is unavailable. A different model or a change from a previously verified Codex/Claude account identity cancels the reservation, including after a restart. If account identity could not initially be verified, it is bound on the first successful check. The provider switch and reservation switch are checked before sending. **Resume now** runs the same checks, except that it ignores the reset stated in the notice and the reservation switch.

Sending is claimed in persistent storage first to prevent duplicate delivery after a crash. A send interrupted at that point may therefore be lost rather than retried. These checks do not provide an atomic guarantee against every concurrent change between checking and sending.

The default continue prompt asks the parent agent to review the latest conversation, workspace and task status, then continue unfinished work. It also asks the parent to resume unfinished subagents using their existing identities and tools, respect user pauses/cancellations and report blockers. The prompt can be replaced under **Continue prompt** in the plugin's settings. Saving it empty, or identical to the default, goes back to the default, which then follows later versions' changes to it. A custom prompt without the subagent instructions changes how subagents continue. A reservation's extra instructions, when it has them, are added below the prompt under a fixed heading. The prompt is read when the continue is sent, so a change saved while a due reservation is being checked applies to it. The plugin sends only to the parent; actual subagent continuation depends on the tools available to it. It does not create a new agent or switch providers.

## Reservation and provider controls

A new reservation starts enabled. Turning it off leaves it visible until its due time; it can be re-enabled before then. At its due time, a disabled reservation is skipped and removed. Sending another message also cancels it.

**+10m** delays a reservation by ten minutes; it is turned off when the new time would fall outside the range below. Selecting its time opens an editor with **Today**, **Tomorrow**, and the reservation's own day when a weekly reset is further away. The earliest allowed time is the later of reset + two minutes and one minute from now; without a known reset it is one minute from now. The latest is seven days and one hour from now. Changing the time turns the reservation on. Editing a verification wait changes its next check time; it does not authorize a continue.

The header switch changes only the pending reservations shown on screen. New reservations and ones already being sent are left alone. The list refreshes every 30 seconds, with a refresh button on desktop and pull to refresh on mobile. Times use the viewing device's time zone.

Conversations with a reservation have an **Auto Resume** composer pill. It shows the reservation time, **Resume off**, **Resuming…**, or a **Check** time for verification waits. Selecting it opens a popover on desktop or a sheet on mobile. The reservation time has an edit button for the time editor and **+10m**, **+30m** and **+1h** below it, followed by the same per-reservation switch, the reservation's **extra instructions** and **Resume now**. The delays are added to the reservation's time, not to now, and are turned off when the result would fall outside the editor's range: no earlier than reset + two minutes or one minute from now, and no later than seven days and one hour from now. Off keeps the pill available for re-enabling before the due time; it does not disable future reservations. Changing the time turns the reservation on. Sending jobs cannot be edited. Executed, skipped-at-due-time and canceled reservations lose their pill.

A reservation can carry **extra instructions** for its continue, up to 2,000 characters. Add or edit them with the button on its row in **Auto Resume** (at the end of the title line on a phone), or with **Add extra instructions** in the composer popover. Saving them leaves the reservation's time and switch as they are; it does not turn an off reservation on. If the reservation moved, ran or started sending since it was shown, the save is refused and the text stays in the editor: review the time and save again. While extra instructions are being written, no other editor opens: in the list, every time and every other row's button is off; in the composer, **Resume now**, the time editor and the delays are off. While a time is being typed, extra instructions cannot be opened. Escape closes the editor only when nothing was typed. Extra instructions are sent once, with the continue, and then deleted. Postponing a reservation, a new plan for one still waiting, a time change and the switch keep them. A reservation that is canceled, skipped or fails to send takes them with it, including when another message cancels it. A limit hit again after the continue makes a new reservation without them. If the continue is sent while they are still being edited, the editor closes with the reservation and unsaved text is lost.

**Resume now** sends the continue right away, after a second press in place. It is meant for a limit lifted before the reset in the notice, for example by a reset credit, and for checking a verification wait without waiting for its next check. It also works on a reservation that is off. Codex and Claude usage is read first: a window still used up blocks the send and reports when it renews, and an account or usage that cannot be verified also blocks it. A blocked Resume now leaves the reservation's time and switch unchanged; its due time checks again as usual. A failed safety check cancels the reservation as it would at its due time. It sends the same prompt and extra instructions an automatic continue would. Antigravity has no usage check, so Resume now sends immediately; if the limit still applies, the agent stops again and a new reservation is made. The app waits about 30 seconds for the answer. When the checks take longer, or the request fails, it says Resume now did not finish and refreshes; the daemon may still finish the attempt and send.

**Recent activity**, below the list, shows how reservations ended in the last 24 hours, up to 200 results: continued, could not be sent, skipped while off, canceled with its reason, gave up after the retry bound, or dropped by a restart. Only final results are recorded; time changes, switches and postponements are not. It starts collapsed with a count by kind, refreshes with the list, and opens the conversation when the agent still exists; an archived agent's button is shown but turned off. An agent deleted since keeps the title recorded at the time. Results that Resume now caused are marked **Resume now**.

The composer directory refreshes every ten seconds while the client is active and immediately after local schedule actions. Open conversation controls share the sidebar's schedule cache and refresh every ten seconds. Other clients see changes on their next refresh. A failed directory read replaces the displayed time with **Unavailable**; failed reads in the controls disable changes and offer a retry. Placement uses the reservation's agent workspace, including background workspaces, without listing unrelated conversations.

Provider discovery follows each provider's `extends` chain to built-in Claude, Codex or Antigravity. Profiles sharing an account still have separate switches. All supported providers, including newly discovered ones, start on. Turning one off cancels all of its pending reservations, including individually disabled ones. Turning it back on does not restore them; subsequent limit stops can create new reservations. A startup scan can also find a recent stop again.

Settings are per daemon. Hosts upgrading from the earlier one-ID-per-CLI settings start with every provider on. If provider settings cannot be read, automatic resumes wait rather than falling back to defaults. The continue prompt is stored separately: if it cannot be read, the default prompt is sent and the error is logged once, and the settings screen offers **Retry** and **Reset**.

## Restarts and missed stops

Reservations survive daemon and plugin restarts. Paseo supplies its plugin API inside lifecycle hooks and RPC requests, so due-job checks wait until one of these connects it after startup. A connected app supplies the API through composer directory polling, as does opening **Auto Resume**. A connected daemon continues checking without keeping the app open; the daemon host must stay running and awake.

The startup scan searches up to 200 idle/error agents active in the preceding 12 hours for missed limit stops. Existing persisted reservations can wait longer, including for weekly resets. Codex and Antigravity recovery checks error notices; Claude also checks recent timeline notices.

At session open, the plugin captures non-secret launch paths, credential-store selectors, the OS username used for Keychain lookup, and credential-presence flags. These survive restarts with the reservation. For a session opened before the plugin loaded, account checks use the daemon environment plus provider configuration; environment values added by other plugins at session open are not available. Unrecognized quota shapes and custom launchers with multiple command arguments wait for verification. Known one-command launchers can use native account/status protocols.

## Data access and storage

The plugin reads agent state, recent timeline notices, provider configuration and configured launch environments through Paseo. It reads CLI login stores and runs read-only status probes to identify the authentication actually in use.

Codex checks contact `chatgpt.com` account usage; Claude checks contact `api.anthropic.com` OAuth profile and usage endpoints. Access tokens authenticate those requests. The plugin does not refresh or rewrite login stores, purchase credits or enable overages. Status/usage checks create no model turns. Tokens are not saved in jobs, logged or included in the continue prompt. The log records that a reservation's extra instructions changed (`note updated` or `note removed`), never their text, and never contains the continue prompt.

Continue prompts are sent through Paseo to the existing agent and its provider; the agent can then perform model turns and tools as usual. Local reservation storage does not mean all processing stays on the host.

| Stored data | Location |
| --- | --- |
| Resume jobs, hashed account/model identity, sanitized launch/store selectors, Keychain lookup username and boolean credential-presence flags, and reservations' extra instructions until they are sent or the reservation ends | `$PASEO_HOME/plugin-data/usage-auto-resume/jobs.json` |
| Recent activity: result and reason, agent ID, provider and the conversation title when recorded, kept for 24 hours | `$PASEO_HOME/plugin-data/usage-auto-resume/history.json` |
| Provider switches | `$PASEO_HOME/plugin-settings/usage-auto-resume/providers.json` |
| Continue prompt, when changed from the default | `$PASEO_HOME/plugin-settings/usage-auto-resume/resume.json` |

The default Paseo home is `~/.paseo`. Settings and jobs are separate from plugin source code.

## Troubleshooting

| What you see | Meaning and next step |
| --- | --- |
| Empty Auto Resume list | No eligible stop has been found. Use agents normally; only detected limit stops create reservations. Older stops can be outside the startup scan. |
| Waiting for account verification | The CLI authentication could not be confirmed. Check the CLI login and configured launcher. On Windows, the plugin starts npm-installed `.cmd` launchers through `cmd.exe` and reads the login where the CLI reports it, else from the user profile. A launcher path containing `%` or `"` cannot be passed to `cmd.exe` safely, so the check keeps waiting; install the CLI or configure its command at another path. On macOS, check that the daemon's user can access the selected profile's Keychain item or its fallback file and that the login is unexpired. |
| Waiting for usage verification | Usage is unreadable, unrecognized or still exhausted without a usable future reset. The displayed time is the next check; time passing alone does not authorize a continue. |
| Reservation disappeared | It may have been sent, skipped, canceled by agent activity/settings, or reached its retry bound. Open **Recent activity** for the last 24 hours, or check the daemon log. |
| Saved jobs are not checked after restart | Open Auto Resume or let a lifecycle event reconnect the Paseo API. |
| Reservation canceled after changing account or model | Codex/Claude reservations are tied to the original identity. A subsequent detected limit stop can create a new one. |

Plugin log lines use the `[usage-auto-resume]` prefix in the daemon log.
