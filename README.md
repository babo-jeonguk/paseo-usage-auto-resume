# Usage Auto Resume

A [Paseo](https://paseo.sh) plugin that continues the same Codex, Claude, or Antigravity agent after a provider usage limit resets. It supports session and weekly limits, persists scheduled resumes across restarts, and gives each pending resume an on/off switch.

[한국어 안내](README.ko.md)

## Screenshots

The actual Paseo web interface, captured with sample reservations in an isolated demo host.

![Auto Resume reservations grouped by day, with enabled and skipped jobs](assets/auto-resume.png)

![Provider settings with a switch for each Claude, Codex and Antigravity provider](assets/provider-settings.png)

## Install

Requires **Paseo daemon and app 0.11.0 or later**, with plugins enabled in the daemon configuration.

```bash
paseo plugin install github:babo-jeonguk/paseo-usage-auto-resume
```

The plugin ID is `usage-auto-resume`. This repository can be installed directly from GitHub; a registry listing is separate.

By default, the plugin considers agents of every provider that runs Claude, Codex, or Antigravity: the built-in `claude`, `codex`, and `antigravity`, and any provider that extends one of them, such as `claude-main` or `codex-sub`. The plugin uses the CLI accounts already signed in on the daemon host.

## Turn providers on or off

Open **Settings → Plugins → usage-auto-resume → Settings**. The screen lists every Claude, Codex, and Antigravity provider the daemon knows, grouped by CLI, with its ID, the account it signs in as, and its pending reservations. Each switch takes effect immediately. A provider is found by following its `extends` chain to a built-in provider, so `codex-reserve` extending `codex` is listed under Codex even when it shares the `codex` account.

Every provider starts on, including one added to Paseo later. Turning a provider off means its agents are never scheduled, and its pending reservations are canceled, including ones turned off in the Auto Resume list. Turning it back on does not restore them. The next limit stop is scheduled as usual, and after a restart the startup scan may find a recent stop again. The switches are stored per daemon. Hosts upgrading from the earlier one-ID-per-CLI settings start with every provider on. If stored settings cannot be read, automatic resumes wait instead of falling back to the defaults.

Provider settings use Paseo's native settings storage under `$PASEO_HOME/plugin-settings/usage-auto-resume/providers.json`. They are separate from the source code and resume-job file.

## Use

Open **Auto Resume** from the sidebar. Pending resumes and verification waits are grouped by day and show their send or check time, countdown, agent title, provider and project/workspace.

- New reservations start enabled. Switch one off to skip it; changes save immediately.
- A disabled reservation stays visible until its scheduled time and can be enabled again before then.
- **+10m** sends 10 minutes later. Select the time to type a new one and pick **Today**, **Tomorrow**, or (for a weekly reset) the reservation's own day. A time before the limit resets (plus two minutes) or more than a week away is explained instead of saved. Moving a reservation turns it on.
- The header button turns every reservation off while any is on, and all back on otherwise. It changes only the rows on screen; one already being sent is left alone.
- The open button on each row opens the agent conversation.
- The list refreshes every 30 seconds. Desktop has a refresh button; mobile supports pull to refresh.

## How it works

A turn-ending hook identifies short limit notices and explicit error codes. These are candidates, not authorization to retry. The plugin captures non-secret launch paths and credential-presence flags at session open, then checks actual CLI authentication. API-key and external billing routes are excluded; unknown authentication waits.

For Codex it reads account/config status without refreshing the login, then queries the exact ChatGPT workspace's usage. For Claude it checks `auth status --json`, verifies the OAuth profile and reads subscription usage. Account/workspace and model scope are bound to the reservation. A change cancels the reservation. Stored OAuth alone never overrides an active API provider.

Ordinary subscription limits use the notice's reset or an actually exhausted applicable window. There is no fallback to an unused five-hour window. Codex workspace-credit notices are monitored separately: an unrelated five-hour reset cannot authorize a continue. When available, the exact model's `model_usage.available_at` schedules a check; `available: true` plus a clear spend control confirms recovery. Missing or ambiguous readiness keeps waiting.

Jobs wait two minutes past a known reset. Before sending, the plugin checks both the agent and fresh subscription state. Missing usage, stale 100% windows and unknown authentication postpone a read-only check by 15 minutes; they never authorize a continue. Multiple applicable exhausted windows wait for their latest known reset. New messages, active/closed/archived agents and pending permissions cancel a resume. Claiming before sending prevents duplicate delivery after a crash, though an interrupted send can therefore be lost.

The screen labels verification and credit recovery waits separately. A waiting row's time is the next status check, not a promised continue. Read-only checks do not count as automatic model retries; actual continues remain bounded to 24 consecutive limit stops.

The prompt asks the parent agent to review saved progress and resume unfinished work, including unfinished subagents that stopped at the usage limit. Actual subagent continuation depends on the parent's available provider tools; the plugin sends only to the parent.

## Data access

The daemon uses the provider's configured command/environment plus captured session overrides. CLI status probes and OAuth usage requests perform no model turns. Access tokens are read only to authenticate usage/profile requests; the plugin never refreshes or rewrites login stores, purchases credits or enables overages. Tokens are not saved in jobs, logged or sent in the continue prompt. Jobs retain hashed account/model identity, paths and boolean credential-presence flags.

The plugin reads agent state, recent timeline notices, provider configuration and usage information through Paseo. Resume jobs are stored in:

```text
$PASEO_HOME/plugin-data/usage-auto-resume/jobs.json
```

The default home is `~/.paseo`. The plugin sends a fixed prompt to the existing agent through Paseo; it does not create a new agent or switch providers.

## Limitations

- A session opened before the capture hook was installed has unverified per-agent overrides. Its reservation waits until an interactive session open/refresh supplies context. New reservations retain sanitized launch context across plugin restarts; older jobs remain readable but cannot bypass verification.
- The installed agy 1.3.6 read-only quota response has no account identity. Antigravity reservations therefore wait for verification instead of guessing an account from its home directory. API/ADC routes remain excluded. Slash status probes require agy 1.1.15 or later and zero-turn structured output.
- Claude on macOS waits because this implementation does not read Keychain credentials. Unrecognized quota shapes or multi-argument custom launchers also wait. Known one-command launchers use native account/status protocols.
- Claude budget/credit notices require affirmative credit recovery metadata; ordinary quota percentages alone cannot clear them.

- Without a known reset or affirmative readiness, the plugin checks again in 15 minutes and sends no continue.
- A notice can supply a proposed reset, but every continue requires fresh verification. Passing the reset timestamp alone does not clear a stale exhausted window.
- After a daemon/plugin restart, jobs wait for a lifecycle hook or a request from the Auto Resume screen to supply the API. Due jobs then run subject to the agent checks.
- The startup scan recovers missed limit stops only for agents active in the preceding 12 hours. Already persisted jobs can wait longer, including for a weekly reset.
- Support is limited to providers that run Claude, Codex, or Antigravity, on Paseo 0.11.0 or later.

## Roadmap

- Planned: support more providers, using Paseo usage information where it exists ([#3](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/3))
- Exploring: continue a limited task on another selected provider ([#4](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/4))

Feedback and contributions are welcome on the linked issues. Real limit notices from other providers are especially helpful.

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
