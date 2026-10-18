Usage Auto Resume schedules a continue prompt for the same Codex, Claude, or Antigravity agent when a usage limit stops its work. Known resets have a two-minute buffer. Codex and Claude require fresh account and usage checks before sending; Antigravity follows the notice's reset without account or quota verification.

The Auto Resume sidebar screen groups reservations by day, showing time, status, conversation, provider and workspace. Switch a reservation off, delay it by ten minutes, enter another time, or turn the displayed reservations off together. Verification waits show the next check time.

## Setup

Requires Paseo daemon and app 0.11.0 or later, plugins enabled, existing CLI logins and a running daemon host. Built-in and derived providers start on; per-provider switches apply immediately. Turning a provider off cancels its pending reservations. Turning it back on does not restore them.

Claude on macOS waits because Keychain credentials are unsupported. API-key and external billing routes are excluded.

## Data and limits

The plugin reads agent state, recent notices, provider configuration and CLI credentials. Account/usage requests use OAuth tokens without refreshing them; tokens are never saved in jobs or logged. Reservations are stored locally. Resume prompts reach the existing agent's provider through Paseo.

New messages, active turns, closed or archived agents and pending permissions cancel resumes. Unverified Codex/Claude authentication or usage waits. Reservations survive restarts; checks need a lifecycle event or Auto Resume request to reconnect the API. Subagent continuation depends on the parent's tools.
