# Screenshot provenance

Captured from the real Paseo 0.11.4 bundled web app and the Usage Auto Resume plugin, using Chromium through Playwright at a 1440 × 960 desktop viewport.

- `auto-resume.png` was recaptured on October 18, 2026 and shows four sample reservations in an isolated daemon and demo workspace. Scheduled, skipped and waiting-for-usage-verification states, countdowns, day grouping, row controls (+10m and open), and the bulk toggle are rendered by the current plugin. Reservations were seeded as demo data; they are not records of real provider-limit failures. The demo agents received no task prompts. CLI logins were isolated from the user's accounts and providers were disabled in Paseo.
- `provider-settings.png` shows the real settings screen with every provider on. It was recaptured on October 16, 2026 from the Paseo 0.11.4 bundled web app at the same viewport, in an isolated daemon with no agents. Its providers `claude-main`, `claude-sub`, `codex-sub` and `codex-reserve` and their `example.com` accounts are demo configuration.

No production conversation content, account emails or credentials are included. The screenshots are direct browser captures; the displayed interface was not retouched.

The October 18 auto-resume capture checked scheduled, skipped and usage-verification waiting states, toggled a skipped reservation on and back off, and reported no browser errors. Earlier browser checks on the demo host covered reservation toggles, upgrading from the one-ID-per-CLI settings, turning providers off and back on with cancellation of their reservations, unreadable settings and their reset.
