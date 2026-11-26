# End-to-end simulation

Installs the plugin into a real, isolated Paseo daemon and drives its main features with the real Claude Code, Codex, Antigravity (`agy`) and OpenCode CLIs. Linux and Windows run the same scripts. Run it by hand before a release or after a Paseo upgrade; it is not part of `npm run check` or CI.

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

- Node 22 or later.
- `@getpaseo/cli` **0.16.0 or later**, installed in its own prefix: `npm i --prefix /tmp/paseo-<v> @getpaseo/cli@<v>`. Do not use the CLI that runs your own daemon's home. The plugin requires Paseo 0.16, so older daemons cannot install it.
- The CLIs to test (`claude`, `codex`, `agy`, and `opencode` for `--suites opencode`). Windows also needs Git on `PATH` for the GitHub install; portable MinGit is enough.
- `--ui 1` needs Playwright and a Chromium-based browser. Set `PW_ROOT` to the `node_modules` directory that holds `playwright`. `CHROME` picks the browser binary; without it, Linux uses Playwright's Chromium and Windows uses the installed Microsoft Edge, so Windows needs no browser download (`npm i --prefix <dir> playwright` is enough).

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
| `--only` | Runs only the listed newer sections (`17`, `18`, `19`, `20`); items 1–16 always run |
| `--agy` | Path to the `agy` binary. The harness configures it as `[path]` on Paseo 0.16 and as `[path, "acp", "--disable-telemetry"]` on Paseo 0.17 and later, which starts Antigravity as an ACP server |
| `--opencode` | Path to the `opencode` binary, for `--suites opencode` |
| `--model` | OpenCode model the fake `opencode-go` provider serves (default `opencode-go/deepseek-v4.1-flash`) |
| `--upgrade-cli` | A newer `@getpaseo/cli` directory; see [Upgrade check](#upgrade-check) |
| `--hold 1` | Pauses after item 3 until `<root>/release` exists |
| `--path` | Extra `PATH` entries, such as the Windows npm prefix, MinGit and agy |
| `--out` | Results directory (default `e2e/out-<label>/`) |

On Windows, run `node.exe e2e\e2e.mjs …` with the same flags.

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

- The real account and usage readers. The CI `native-cli` job checks these against the real CLIs.
- Real provider limits.
- Connected hosts.
- Native apps.

## Known issues

- **Background agents in the agent list.** `fetchAgents({ includeBackground: true })` may not return an agent-level background agent even though the plugin's own list and its scan see it; item 17d records what the connected client sees and is a NOTE, not a failure.
- **Windows: an item that saves a reservation or history entry fails now and then.** The plugin saves `jobs.json` and `history.json` by renaming a temporary file over them. Windows refuses that rename while another process has the file open, and the harness reads both files throughout the run, so a save that lands on a read fails. On a Windows host this failed 1.8% of saves with a reader polling every second and 3.6% every 0.3 seconds (the UI phase's pace); no save failed out of 1000 without one. The failed save is lost, so the item waiting for it times out (seen in 8, the UI phase's 4, 9 and 15). The daemon log then holds an `EPERM: operation not permitted, rename '…jobs.json.….tmp' -> '…jobs.json'` (or `history.json`) line from the same moment; rerun the item. The plugin keeps a single rename because no other program normally reads these files. Item 14 does not catch a failure on an RPC path, which the daemon logs as `Error handling message` rather than as plugin output.

## Native apps

Run these manual checks alongside the CLI/web simulation before releasing the plugin or upgrading Paseo. Use Node 24, Git, an isolated installation of `@getpaseo/cli`, and released app artifacts of the same Paseo version. Put the real provider binaries on the isolated run's `PATH` with `--path` (use the OS path separator for several directories). On Windows, include the directory containing Git and any provider command shims.

Each runner makes a separate temporary Paseo home and provider profile with a space and Korean characters in the path. The app runs use a loopback fake model server, refusing proxies and OS-level network isolation. Both apps take the local Git source and full SHA from the staging report. For an unpublished commit, pass `--source "file://$PWD" --to "$(git rev-parse HEAD)"` from the plugin checkout.

With network access, stage the GitHub revision. This starts a CLI-launched Paseo daemon with a separate home, installs the requested plugin revision, and writes a local repository pinned to that commit. Pass `--source git:owner/repo` to override the default GitHub repository. Set `STAGED_SOURCE` and `STAGED_REVISION` from `localSource` and `revision` in the passing report.

```bash
node e2e/desktop-source.mjs --cli /tmp/paseo-0.17.1/node_modules/@getpaseo/cli --to main --out /tmp/uar-results
```

Both live-update checks start with an open app surface and verify a schedule event, a subsequent list response containing the new reservation, and its display before the fallback poll. The reports record observation time for diagnosis.

Use `--out <directory>` to choose the report location. The default is `e2e/out-native`. Each run writes a new subdirectory with `results.json`, daemon and model logs, proxy logs, app or emulator diagnostics, and screenshots. Failed runs keep the temporary home and include its path in the report. Successful runs remove it after copying the evidence.

### Desktop on Linux and Windows

Extract the matching desktop release archive and point `--app` at the directory containing `Paseo` and `Paseo.bin` on Linux, or `Paseo.exe` on Windows. Install `playwright-core` in a separate prefix and set `PW_ROOT` to its `node_modules` directory. CDP connects to the released app, so a Playwright browser download is unnecessary. Linux needs an X display. Windows needs native Node and an interactive desktop session.

On Linux, run the whole Desktop scenario in a loopback-only network namespace. This example uses Bubblewrap with unprivileged user namespaces enabled.

```bash
PW_ROOT=/tmp/uar-tools/node_modules bwrap --unshare-net --bind / / --dev /dev -- \
  xvfb-run -a -s '-screen 0 1440x900x24' \
  node e2e/desktop.mjs --cli /tmp/paseo-0.17.1/node_modules/@getpaseo/cli \
  --app /path/to/Paseo-0.17.1-x64 --source "$STAGED_SOURCE" --to "$STAGED_REVISION" \
  --path "$HOME/.local/bin" --out /tmp/uar-results
```

On Windows, copy the staged `source.git` and the other prerequisites into a dedicated Windows VM with its network adapters removed. Use the file URL for the repository's location inside that VM and the revision from the online report. The runner launches Electron in a Windows job object so that shutdown can account for the entire process tree.

```powershell
$env:PW_ROOT = 'C:\uar-tools\node_modules'
node e2e/desktop.mjs --expect-platform win32 --cli C:\tools\node_modules\@getpaseo\cli `
  --app C:\Paseo-0.17.1-x64 --source file:///C:/uar-source/source.git --to $env:STAGED_REVISION `
  --path 'C:\provider-bin;C:\MinGit\cmd' --out C:\uar-results
```

The runner checks the Electron-owned daemon's version and executable, real Claude and Codex subscription CLI launches, Settings account discovery, live composer updates, the keyboard time editor, extra instructions, blocked and successful Resume now, day sections, Labs hover and provider-off cancellation. It closes the window and checks that its daemon and child processes exit. A new app instance must restore the reservation and let the real 30-second tick send one continue to the closed conversation. The report includes bundled Node and SQLite availability and any startup retries.

Only the installed copy's subscription HTTP boundary is replaced. The Claude model turn uses the loopback API, and its auth check uses the login fixture in the isolated home. The Codex app-server probe uses the default model provider and receives a used-up usage window so the pending reservation stays in place without starting a model turn. The fixture disables Paseo’s separate built-in usage polling. Use a Codex build that accepts the synthetic login, such as the version pinned for the repository’s full native CLI integration check.

The Desktop runner requires loopback-only networking and probes direct IPv4 and IPv6 connections before launching Paseo and again at the end. Electron and the provider CLIs have separate refusing proxies that record attempted connections. The report also counts DNS failures from the built-in Paseo registry directory when Settings opens offline. Other unexpected daemon errors, network boundary failures, and updater files fail the run.

### Android on Linux

Use a Linux Android SDK with `platform-tools`, `emulator`, `cmdline-tools/latest`, Java, KVM acceleration, and a matching released `paseo-v<version>-android.apk`. Install Tesseract with English text recognition (`tesseract-ocr` and `tesseract-ocr-eng` on Debian-based hosts) for the tooltip and toast screenshot checks. The default image is `system-images;android-34;google_apis;x86_64`. Install the image before running. Use `--sdk` to override `ANDROID_HOME` or `~/Android/Sdk` and `--system-image` to select an installed replacement. `--port` selects the unused even emulator console port (default 5584).

```bash
bwrap --unshare-net --bind / / --dev /dev --dev-bind /dev/kvm /dev/kvm -- \
  node e2e/android.mjs --cli /tmp/paseo-0.17.1/node_modules/@getpaseo/cli \
  --apk /path/to/paseo-v0.17.1-android.apk --source "$STAGED_SOURCE" --to "$STAGED_REVISION" \
  --path "$HOME/.local/bin" --out /tmp/uar-results
```

Run the Android host daemon and emulator in the same loopback-only namespace. The runner verifies IPv4 and IPv6 isolation and records refused provider attempts and offline registry lookups. It uses its own AVD and adb server. It boots with wiped data, two cores, 2 GB RAM and software rendering. Use an emulator build with `-network-user-mode-options` and `-wifi-user-mode-options` support. Both guest networks run in restricted mode. The app connects over `adb reverse` from device loopback to the isolated host daemon. UI Automator drives the compact list and pull-to-refresh, checks Hermes date formatting and spoken time, opens the native composer sheet, types times and notes, and checks both Resume now toasts and the exact model-request count. It also checks provider-off cancellation, the full Labs tooltip text in a screenshot, prompt edit and reset, recent activity, and reservation recovery after Android force-stops the app. The report counts dismissed system ANR dialogs and includes a continuous `logcat` capture for React Native and Hermes failures.
