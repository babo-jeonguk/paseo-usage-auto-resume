# End-to-end simulation

Installs the plugin into a real, isolated Paseo daemon and drives its main features with the real Claude Code, Codex, Antigravity (`agy`) and OpenCode CLIs. Linux and Windows run the same scripts. PR CI runs the CLI and web simulation on Ubuntu 24.04 and Windows against Paseo 0.16.2 and 0.17.1. Repeat the full simulation with all providers at release time.

## What is real and what is fake

The following are real:
- The Paseo daemon, with its own home and port per run.
- The plugin install from GitHub (`paseo plugin install` / `plugin update --ref`).
- The CLIs.
- The plugin's hooks, 30-second tick, settings, store and history.

Three things are replaced:
- **Model APIs.** `fake-models.mjs` serves Anthropic Messages, OpenAI Responses, Gemini and OpenAI-compatible chat completions on one local port. Each answers normally or with its usage-limit error.
  - Claude gets a 429 with the unified rate-limit headers, so the CLI itself writes `You've hit your session limit · resets …` and ends the turn normally.
  - Codex gets `usage_limit_reached`.
  - Antigravity gets `RESOURCE_EXHAUSTED … Resets in 2h.`
  - OpenCode gets a 429 `FreeUsageLimitError`, which OpenCode 2.2.6 records as `provider.free-limit`. A `hang` mode answers only after `delayMs`, so a daemon restart can interrupt a running turn.
- **Account and usage check.** A CLI pointed at a local API counts as API billing, so `patch-plugin.mjs` rewrites the installed copy's `index.server.ts` to read the subscription check from a control file. It also logs `event.timeline.length` on each turn end.
- **Outbound connections.** CLI telemetry and updater traffic goes to `blackhole-proxy.mjs`, which refuses and records it.

No model request leaves the host and no real account is used. Each CLI runs with its own empty config home: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `HOME` for agy; OpenCode gets its own `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` with an `opencode.json` that points `opencode-go` at the fake API.

## Requirements

- Node 24.
- `@getpaseo/cli` **0.16.0 or later**, installed in its own prefix: `npm i --prefix /tmp/paseo-<v> @getpaseo/cli@<v>`. Do not use the CLI that runs your own daemon's home. The plugin requires Paseo 0.16, so older daemons cannot install it.
- The CLIs to test (`claude`, `codex`, `agy`, and `opencode` for `--suites opencode`). Windows also needs Git on `PATH` for the GitHub install; portable MinGit is enough.
- `--ui 1` needs Playwright and a Chromium-based browser. Set `PW_ROOT` to the `node_modules` directory that holds `playwright`. `CHROME` picks the browser binary; without it, Linux uses Playwright’s Chromium (`playwright install chromium`) and Windows uses the installed Microsoft Edge.

## Run

```bash
node e2e/e2e.mjs --label linux-0.16.0 --cli /tmp/paseo-0.16.0/node_modules/@getpaseo/cli \
  --root /tmp/uar-e2e-run --suites claude,codex,antigravity,opencode \
  --claude ~/.local/bin/claude --codex ~/.local/bin/codex --agy ~/.local/bin/agy --opencode ~/.opencode/bin/opencode \
  --from v1.3.2 --to main [--ui 1] [--min 1] [--only 17,18]
```

| Flag | Meaning |
|---|---|
| `--cli` | Directory of the `@getpaseo/cli` package to run |
| `--root` | Run directory; deleted first |
| `--suites` | Any of `claude,codex,antigravity,opencode` |
| `--from`, `--to` | Release installed first and rolled back to (default `v1.2.2`), and the ref under test (default `main`) |
| `--source` | Plugin git source (default `git:babo-jeonguk/paseo-usage-auto-resume`); `file://<checkout>` installs an unpushed local branch with `--to <SHA>` |
| `--min 1` | Skips items 9–11, 16, the newer sections (17–20) and the `--ui 1` phase |
| `--ui 1` | Also runs `ui-steps.mjs` in the web app (items 4, 5, 6, 9, 12, 15 and 21) |
| `--only` | `core` runs the original CLI checks and any requested web phase. Use a comma-separated list of `17`, `18`, `19`, and `20` to select extended scenarios. The default runs all applicable checks. |
| `--agy` | Path to the `agy` binary. The harness configures it as `[path]` on Paseo 0.16 and as `[path, "acp", "--disable-telemetry"]` on Paseo 0.17 and later, which starts Antigravity as an ACP server |
| `--opencode` | Path to the `opencode` binary, for `--suites opencode` |
| `--model` | OpenCode model the fake `opencode-go` provider serves (default `opencode-go/deepseek-v4.1-flash`) |
| `--upgrade-cli` | A newer `@getpaseo/cli` directory; see [Upgrade check](#upgrade-check) |
| `--hold 1` | Pauses after item 3 until `<root>/release` exists |
| `--path` | Extra `PATH` entries, such as the Windows npm prefix, MinGit and agy |
| `--out` | Results directory (default `e2e/out-<label>/`) |

On Windows, run `node.exe e2e\e2e.mjs …` with the same flags.

CI installs pinned Claude Code and Codex npm packages and runs the core suites and browser checks. The manual release simulation also runs the longer background and restart overlap scenarios, Antigravity and OpenCode. Antigravity requires a separate `agy` installation, and the public `opencode-ai` npm package does not provide the version required by the free-limit scenario. The `simulation` jobs upload their reports, logs and any screenshots on success or failure.

Each run writes `results.json` (one row per checked item), `daemon.log` and `model.jsonl` (every fake request) to the results directory, then stops everything it started. `inspect-agent.mjs` prints an agent's latest timeline from a running daemon.

## Checked items

| # | Item |
|---|---|
| 1 | Install `--from` from GitHub |
| 2 | Update to `--to`, keeping reservations and history |
| 3 | A real limit stop schedules the stated reset plus two minutes |
| 4 | Time presets and Change time |
| 5 | Extra instructions and a changed continue prompt are sent together |
| 6 | Resume now: blocked while used up or unverified, otherwise sent once |
| 7 | The tick continues the same agent once |
| 8 | A reservation turned off is skipped |
| 9 | Turning a provider off cancels its reservations |
| 10 | A new message cancels the reservation |
| 11 | The startup scan finds a stop missed while the plugin was off |
| 12 | Recent activity and history |
| 13 | Rolling back to `--from` |
| 14 | No plugin errors in the daemon log |
| 15 | The Auto Resume screen: day sections, a weekly wait shown as days and spoken in words, a row's +10m, Change time, extra instructions, Open and switch, and Turn all off/on (`--ui 1`) |
| 16 | A reservation whose agent a daemon restart closed is continued at its due time |
| 17a | Background agents are skipped while **Resume background agents** is off, and a pending one is swept with `background_off` when it is turned off (`--suites claude`) |
| 17b | With the switch on, the tick continues a background agent once, in the same agent (`--suites claude`) |
| 17c | With the switch on, the startup scan finds a background agent stopped while the plugin was off (`--suites claude`) |
| 17d | Observation: the plugin list RPC and agent list visibility of background agents |
| 18a–c | Restart recovery (Paseo's `agents.resumeOnStartup`/`resumePrompt`) overlapping a stale reservation: graceful stop, crash, and recovery off (`--suites claude`) |
| 18d | The same restart case for Codex (`--suites codex`) |
| 19a–c | OpenCode: a real free-limit error through the fake API becomes a reservation, the tick continues once, and the scan finds a missed stop (`--suites opencode`) |
| 20 | Observation: provider discovery after warm-up |
| 21 | A reservation from a hook reaches the open Auto Resume screen and the composer pill within 5 s, without reloading (`--ui 1`) |
| 22 | A settings save that fails (read-only settings directory, or a conflict) shows a plain message and changes nothing; Reload and a retry recover (`--ui 1`, not on Windows or as root) |

Items 17 and 18 turn the background switch through Paseo's settings API (`settings.providers.write`), because a direct file edit does not notify the plugin's settings subscribers. Codex and Antigravity run items 3, 6, 7, 9, 11 and 16; OpenCode runs 19a–c instead of item 3, because its limit message carries no reset. The fake-request total, the refused connections and the harness's longest event-loop stall (`loopMaxMs`) are printed in the final `SUMMARY` line. The harness keeps one daemon session open for the whole run, and the daemon closes a session that sends nothing for 45 seconds, so the harness must not block its event loop: it runs the `paseo` CLI asynchronously.

Items 6 and 7 report what the continue led to, from the final reads: whether its turn ended, whether the plugin handled that turn end (the delivered reservation is no longer being sent), whether a limit notice in the provider's error form followed it, and which reservation is left. They pass when the turn ended and was handled and either no row is left with no notice after the continue, or, for Antigravity only, a new pending reservation other than the one just continued is left after such a notice, which is a NOTE. A notice that cannot be read fails. On Paseo 0.16, agy can replay the earlier 429 after the continue's reply (seen in some runs, not all) and the plugin reserves it again, which is a NOTE; on Paseo 0.17.0-beta.1 and 0.17.1 no replay was seen and the row is cleared.

Time is advanced through the reschedule RPC, or by editing `jobs.json` to a past due time and letting the real tick fire. The tick cannot move a reservation earlier than its reset plus two minutes.

## Upgrade check

Reservations made on one Paseo version must survive the next. Run this when the Paseo line changes:

```bash
node e2e/e2e.mjs --label upgrade-0.16-0.17 --cli /tmp/paseo-0.16.2/node_modules/@getpaseo/cli \
  --upgrade-cli /tmp/paseo-0.17.1/node_modules/@getpaseo/cli --root /tmp/uar-e2e-upgrade --suites codex,antigravity \
  --codex ~/.local/bin/codex --agy ~/.local/bin/agy --from v1.3.2 --to main --min 1
```

With `--upgrade-cli`, each Codex and Antigravity suite makes its limit (item 3) and tick reservations on the `--cli` version. The `upgrade` step then stops the daemon, switches to the newer CLI on the same home, rewrites the `--agy` command for that version, checks that every reservation is still listed, and opens each conversation as the app does, which loads the agent on the newer version. Items 6 and 7 then send them on the newer version, through **Resume now** and the tick. Each must send exactly one continue into the same agent; a reservation canceled as `model_changed` fails the item. Paseo's own restart recovery stays off, as in every run.

For Paseo 0.16 to 0.17, Codex needs CLI 0.121.0 or later to reopen a conversation that 0.16 started.

## Not covered

- The real account and usage readers. Run `npm run test:native` with a supported installed CLI for focused verification.
- Real provider limits.
- Connected hosts.
- Native apps.

## Known issues

- **Background agents in the agent list.** `fetchAgents({ includeBackground: true })` may not return an agent-level background agent even though the plugin's own list and its scan see it; item 17d records what the connected client sees and is a NOTE, not a failure.
- **Windows: a reservation or history save reports `EPERM` on rename.** The plugin renames a temporary file over `jobs.json` or `history.json`. A concurrent external read can block the rename on Windows. Live CLI and browser checks read through daemon RPCs. The CLI fixture exposes a queued read of stored rows for lifecycle assertions because the public list omits sent rows. Direct file reads are used for disk compatibility, disabled-plugin assertions and intentional on-disk fixture edits. Before the switch to RPCs, a Windows host reproduced save failures at 1.8% with an external reader polling every second and 3.6% at 0.3 seconds. All 1,000 saves succeeded without the reader. Check the daemon log for a rename error at the time of a missing result. RPC errors can appear there under `Error handling message`.

## Native apps

Run Desktop on Linux and Windows and Android on the WSL emulator before releasing. CI runs the unit checks and the CLI/web simulation. Each manual runner uses its own Paseo home, synthetic credentials and a loopback fake model. Provider traffic uses a refusing proxy. The daemon uses the host network for the GitHub install.

Use Node 24 and an isolated installation of `@getpaseo/cli` at the app's version. Install released artifacts from the [Paseo release](https://github.com/getpaseo/paseo/releases). Compare each archive's SHA-256 with the release asset digest before extracting it. Use `sha256sum` on Linux or `Get-FileHash -Algorithm SHA256` in Windows PowerShell.

Both runners install the plugin from GitHub at `--to <ref>`. For an unpublished commit use `--source <file URL>` and pass its full SHA to `--to`. Set `--path` to the directories containing the provider commands, using the OS path separator between them. Each run writes a new report directory under `--out`, including `results.json`, app/daemon logs, refused connections and screenshots. It retains its temporary profile on failure.

### Desktop

Point `--app` at the extracted `Paseo-<version>-x64.tar.gz` directory on Linux or the directory holding `Paseo.exe` from `Paseo-Setup-<version>-x64.zip` on 64-bit Windows. Install `playwright-core` separately and set `PW_ROOT` to its `node_modules` directory. It connects to the released app over CDP.

In WSL:

```sh
revision=main  # Set to the pushed branch, tag, or commit under test.
PW_ROOT=/tmp/uar-tools/node_modules xvfb-run -a -s '-screen 0 1440x900x24' \
  node e2e/desktop.mjs --cli /tmp/paseo-0.17.1/node_modules/@getpaseo/cli \
  --app /path/to/Paseo-0.17.1-x64 --to "$revision" --path "$HOME/.local/bin" --out /tmp/uar-results
```

On Windows, use an interactive Windows session, Windows Node 24 and a checkout on the Windows drive, such as `C:\src\paseo-usage-auto-resume`. You can invoke Windows PowerShell from WSL and run the same command there. Include Git or MinGit and the provider shims in `--path`.

```powershell
$revision = 'main'  # Set to the pushed branch, tag, or commit under test.
$env:PW_ROOT = 'C:\uar-tools\node_modules'
node.exe e2e\desktop.mjs --expect-platform win32 --cli C:\uar-tools\node_modules\@getpaseo\cli `
  --app C:\Paseo-0.17.1-x64 --to "$revision" --path 'C:\provider-bin;C:\MinGit\cmd' --out C:\uar-results
```

Electron and its daemon use temporary profiles. On Windows the runner builds the launcher with the .NET Framework 4.x compiler included with Windows, and a Job Object tracks the app process tree until shutdown. Chromium uses an independent refusing proxy to block self-updates. The report includes attempted requests and checks that it downloaded no update files.

Desktop verifies the version-matched managed daemon, real Claude and Codex subscription commands and exact fixture bearer tokens, live composer updates, keyboard editing, blocked and successful Resume now, Settings, and reservation recovery after closing and reopening the app. It checks that exactly one tick continue goes to the restored reservation. On Windows, `CODEX_HOME` directs Codex to its synthetic login because its default lookup uses the Windows account profile. Linux exercises Codex’s default discovery with the inherited isolated `HOME`. Use a Codex build that accepts the synthetic login, such as 0.152.1.

### Android

Use the WSL Android SDK with `platform-tools`, `emulator`, `cmdline-tools/latest`, Java and `/dev/kvm`. Install the default `system-images;android-34;google_apis;x86_64` image and use the matching `paseo-v<version>-android.apk` release.

```sh
revision=main  # Set to the pushed branch, tag, or commit under test.
node e2e/android.mjs --cli /tmp/paseo-0.17.1/node_modules/@getpaseo/cli \
  --apk /path/to/paseo-v0.17.1-android.apk --to "$revision" \
  --path "$HOME/.local/bin" --out /tmp/uar-results
```

The runner creates a temporary AVD and its own adb server, wipes the AVD on boot and stops both when done. The released app connects by Direct connection through `adb reverse`. Select a different installed image with `--system-image`, SDK with `--sdk`, or unused even emulator port with `--port`.

UI Automator drives the native controls and reads the accessibility tree. The runner checks native list updates, sheet edits, the correlated Resume now RPCs, reservation state and exact model-request counts, Settings and recovery after force-stop. It saves screenshots and `logcat` for inspection. The runner taps **Wait** on System UI ANR dialogs and counts them. A Paseo ANR fails the run. On a UI wait failure, `results.json` includes the observation counts for that wait.

#### Manual visual verification

Run the same Android command with `--visual 1` from a terminal with an emulator window available through WSLg or an X server. The runner uses the same temporary emulator and test data and pauses at the two **Resume now** confirmations.

1. Watch the emulator and press Enter in the terminal when ready. The runner taps **Send** with usage still limited. Check that the toast says **Usage is still used up until …** and includes the reset time.
2. Repeat the observation at the next prompt. Usage is now available. Check that the toast says **Continue sent**.
3. When the Labs tooltip appears, check that both lines are visible without clipping. The runner holds the tooltip open for inspection.

At each prompt enter `pass` or `fail` followed by what you saw, for example `pass Continue sent`. Enter `skip` if you could not inspect the display. Keep the `manualVisualChecks` entries from `results.json` with the release evidence. Headless runs and skipped checks report `not-run`. The automated result covers the RPC outcomes, reservation and model effects, and the tooltip’s accessibility text. The visual results go in the release record separately.
