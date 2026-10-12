# Usage Auto Resume

A [Paseo](https://paseo.sh) plugin that continues the same Codex or Claude agent after a provider usage limit resets. It supports session and weekly limits, persists scheduled resumes across restarts, and gives each pending resume an on/off switch.

[한국어 안내](README.ko.md)

## Screenshots

The actual Paseo web interface, captured with sample reservations in an isolated demo host.

![Auto Resume reservations grouped by day, with enabled and skipped jobs](assets/auto-resume.png)

![Provider settings with the public defaults claude and codex](assets/provider-settings.png)

## Install

Requires **Paseo daemon and app 0.11.x**, with plugins enabled in the daemon configuration.

```bash
paseo plugin install github:babo-jeonguk/paseo-usage-auto-resume
```

The plugin ID is `usage-auto-resume`. This repository can be installed directly from GitHub; a registry listing is separate.

By default, the plugin resumes agents whose provider ID is exactly `codex` or `claude`. The plugin uses the CLI accounts already signed in on the daemon host.

## Select your providers

Open **Settings → Plugins → usage-auto-resume → Settings**. Set **Claude provider ID** and **Codex provider ID**, then press **Save**. Each field replaces that CLI's default ID. For example, choosing `claude-main` for Claude and keeping `codex` for Codex resumes only `claude-main` and `codex`; `claude` and `claude-sub` are excluded. A custom ID must run the corresponding Claude or Codex CLI, normally by extending that built-in provider.

Selection is exact, not a prefix or `extends` match. It is stored per daemon, so the public repository retains standard defaults while your host can use its own aliases. Saving a selection cancels pending reservations for removed providers; restoring an ID does not restore its canceled reservations. If stored settings cannot be read, automatic resumes wait instead of falling back to different providers.

Provider settings use Paseo's native settings storage under `$PASEO_HOME/plugin-settings/usage-auto-resume/providers.json`. They are separate from the source code and resume-job file.

## Use

Open **Auto Resume** from the sidebar. Pending resumes are grouped by day and show their send time, countdown, agent title, provider and project/workspace.

- New reservations start enabled. Switch one off to skip it; changes save immediately.
- A disabled reservation stays visible until its scheduled time and can be enabled again before then.
- Select a row to open the agent conversation.
- The list refreshes every 30 seconds. Desktop has a refresh button; mobile supports pull to refresh.

## How it works

A turn-ending hook detects renewable usage/rate-limit errors from explicit error codes or short provider notices. Claude notices can arrive as a final assistant message even when a turn is marked completed. Context overflow, billing/credit failures, normal completion and canceled turns are excluded.

The reset time comes from the provider notice first. If the notice has none, the plugin consults the signed-in account's Paseo usage windows. Exhausted windows include weekly limits; when several windows are exhausted, it waits for the latest reset. Otherwise it uses an available five-hour/session reset.

It schedules one job per agent and sends a fixed continue prompt **two minutes after the reset**. Immediately before sending, it checks the agent again. A newer user message, a new turn, a running/closed/archived agent, or a pending permission request cancels the resume. Claiming the job before sending prevents duplicate delivery after a crash, though an interrupted send can therefore be lost.

The prompt asks the parent agent to review saved progress and resume unfinished work, including unfinished subagents that stopped at the usage limit. Actual subagent continuation depends on the parent's available provider tools; the plugin sends only to the parent.

## Data access

To distinguish accounts, the daemon reads the selected provider's configured CLI home. It reads Claude's `oauthAccount.emailAddress` from `.claude.json` or email claims from Codex's `auth.json` tokens, using the provider's configured `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. Only matching account usage entries are used. Tokens are not stored in jobs, logged or sent in the continue prompt.

The plugin reads agent state, recent timeline notices, provider configuration and usage information through Paseo. Resume jobs are stored in:

```text
$PASEO_HOME/plugin-data/usage-auto-resume/jobs.json
```

The default home is `~/.paseo`. The plugin sends a fixed prompt to the existing agent through Paseo; it does not create a new agent or switch providers.

## Limitations

- If neither a notice nor matching account usage supplies a reset, the plugin rechecks in 15 minutes. It may then send a continue prompt and retry if the limit persists, stopping after 24 consecutive unsuccessful automatic continues.
- A notice's stated reset takes priority over usage windows. Known scheduled jobs do not recheck usage before sending.
- After a daemon/plugin restart, jobs wait for a lifecycle hook or a request from the Auto Resume screen to supply the API. Due jobs then run subject to the agent checks.
- The startup scan recovers missed limit stops only for agents active in the preceding 12 hours. Already persisted jobs can wait longer, including for a weekly reset.
- Support is limited to the two selected Claude/Codex provider IDs and the Paseo version range above.

## Development

```bash
npm ci
npm run check
paseo plugin install "$PWD"
```

`npm run check` runs TypeScript checking and the Node test suite. After changing an installed directory plugin:

```bash
paseo plugin reload usage-auto-resume
```

Plugin logs use the `[usage-auto-resume]` prefix in the daemon log. Paseo compiles the TypeScript entry points; no separate application build is required. Runtime imports use Paseo's host-provided modules.

## Registry submission

The official [Paseo registry](https://github.com/getpaseo/plugins#submit-a-plugin) accepts a public GitHub source without an npm release. Submit this repository using the [submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml). Review pins the artifact to an exact commit; acceptance is decided by the registry maintainers.

`OVERVIEW.md` is included for the listing page. Screenshots of the actual interface are shipped in `assets/` and declared in the manifest's `media` field, as required by the registry's [review policy](https://github.com/getpaseo/plugins/blob/main/REVIEW.md#images-and-media). Publishing the repository does not itself approve a listing.

## Credits and license

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

Reset parsing draws on [panrafal's chat-resume](https://github.com/panrafal/paseo-plugins/tree/main/chat-resume) and [paseo-continuity](https://github.com/keefeere/paseo-continuity). Usage-window selection follows [paseo-limits](https://github.com/ortschun/paseo-limits); the persisted-queue approach was inspired by [paseo-defer](https://github.com/tomgrin10/paseo-defer). The screen follows Paseo settings and the alarm-list pattern in the iOS Clock app.
