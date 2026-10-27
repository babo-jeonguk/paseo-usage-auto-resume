# Screenshot provenance

Captured on October 27, 2026 from the real Paseo 0.13.2 bundled web app and the Usage Auto Resume plugin at v1.3.0, using Chromium through Playwright at a 1440 × 960 desktop viewport. They come from an isolated daemon with two demo workspaces, `billing-service` and `docs-site`.

- `auto-resume.png` shows four reservations and the expanded recent activity. The states shown are scheduled, waiting for usage verification, with extra instructions, and skipped, grouped by day.
  - The first reservation was made by the plugin itself when the agent's Claude Code stopped at its limit.
  - The other three and the recent activity entries were seeded as demo data.
- `composer.png` shows that first conversation with its **Auto Resume** panel open. The limit notice is the one Claude Code itself wrote.
- `settings.png` shows the plugin settings, scrolled to show both the providers and the continue prompt. The providers `claude`, `claude-team`, `codex` and `antigravity` and their `example.com` accounts are demo configuration.

The only model request was the demo conversation's turn. It went to a local stand-in for the Anthropic API, which answered with a usage-limit error. No real account was used, and the CLIs' other outbound connections were refused. The plugin's account and usage check was replaced by a fixed "available" answer. No production conversation content, account emails or credentials are included. The screenshots are direct browser captures, and the displayed interface was not retouched. The browser reported no errors.
