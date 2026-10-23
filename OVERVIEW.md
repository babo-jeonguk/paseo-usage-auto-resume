Usage Auto Resume schedules a continue prompt for the same Codex, Claude, or Antigravity agent when a usage limit stops its work. Known resets have a two-minute buffer. Codex and Claude require fresh account and usage checks before sending; Antigravity follows the notice's reset without account or quota verification.

The Auto Resume sidebar screen groups reservations by day, showing time, status, conversation, provider and workspace. Switch a reservation off, delay it by ten minutes, enter another time, or turn the displayed reservations off together. Verification waits show the next check time. Recent activity shows which reservations continued, were skipped or canceled, and why, over the last 24 hours.

Scheduled conversations also have an Auto Resume composer pill for managing that same reservation in place. Turn it off or back on before its due time, delay it by 10 minutes, 30 minutes or an hour, edit its time, or resume it now when a limit lifts early, from a desktop popover or mobile sheet. Resume now runs the same checks and is blocked while Codex or Claude usage is still used up.

You can change what is sent. The plugin's settings show the continue prompt and let you replace it or reset it to the built-in one, which asks the agent to resume unfinished subagents. Each reservation can also carry extra instructions, written from the sidebar or the composer pill. They are added below the prompt and sent once with that continue.

## Setup

Requires Paseo daemon and app 0.11.0 or later, plugins enabled, existing CLI logins and a running daemon host. Built-in and derived providers start on; per-provider switches apply immediately. Turning a provider off cancels its pending reservations. Turning it back on does not restore them.

Claude on macOS waits because Keychain credentials are unsupported. API-key and external billing routes are excluded.

## Data and limits

The plugin reads agent state, recent notices, provider configuration and CLI credentials. Account/usage requests use OAuth tokens without refreshing them; tokens are never saved in jobs or logged. Reservations, extra instructions and a custom continue prompt are stored locally; extra instructions are deleted once sent and never logged. Resume prompts and extra instructions reach the existing agent's provider through Paseo.

New messages, closed or archived agents and pending permissions cancel resumes; a turn the agent starts on its own, such as for a subagent's notification, does not. Unverified Codex/Claude authentication or usage waits. Reservations survive restarts; checks need a lifecycle event or Auto Resume request to reconnect the API. Subagent continuation depends on the parent's tools.
