# Changelog

All notable user-facing changes to Usage Auto Resume are documented in this file.

## 1.4.2 - 2026-11-28

### Added

- Added OpenCode Go usage checks with the OpenCode Console API key, falling back to the `opencode-go` key or `auth.json` only when the Console key is rejected (#46)

### Changed

- Changed Antigravity resumes to follow the limit notice and its bounded 15/30/60-minute retries instead of running `agy -p /usage` before sending (#46)
- Changed the plugin to Paseo's current hook and UI APIs, replacing the ones Paseo 0.18 deprecates (#46)

### Fixed

- Fixed Paseo-managed subagents being resumed on their own after a usage limit; their earlier reservations are canceled as `subagent managed by parent` (#45)
