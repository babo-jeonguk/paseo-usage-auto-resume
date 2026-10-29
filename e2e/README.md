# End-to-end simulation

Installs the plugin into a real, isolated Paseo daemon and drives its main features with the real Claude Code, Codex and Antigravity (`agy`) CLIs. Linux and Windows run the same scripts. Run it by hand before a release or after a Paseo upgrade; it is not part of `npm run check` or CI.

## What is real and what is fake

The following are real:
- The Paseo daemon, with its own home and port per run.
- The plugin install from GitHub (`paseo plugin install` / `plugin update --ref`).
- The CLIs.
- The plugin's hooks, 30-second tick, settings, store and history.

Three things are replaced:
- **Model APIs.** `fake-models.mjs` serves Anthropic Messages, OpenAI Responses and Gemini on one local port. Each answers normally or with its usage-limit error.
  - Claude gets a 429 with the unified rate-limit headers, so the CLI itself writes `You've hit your session limit · resets …` and ends the turn normally.
  - Codex gets `usage_limit_reached`.
  - Antigravity gets `RESOURCE_EXHAUSTED … Resets in 2h.`
- **Account and usage check.** A CLI pointed at a local API counts as API billing, so `patch-plugin.mjs` rewrites the installed copy's `index.server.ts` to read the subscription check from a control file. It also logs `event.timeline.length` on each turn end.
- **Outbound connections.** CLI telemetry and updater traffic goes to `blackhole-proxy.mjs`, which refuses and records it.

No model request leaves the host and no real account is used. Each CLI runs with its own empty config home: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `HOME` for agy.

## Requirements

- Node 22 or later.
- `@getpaseo/cli` of the Paseo version under test, installed in its own prefix: `npm i --prefix /tmp/paseo-<v> @getpaseo/cli@<v>`. Do not use the CLI that runs your own daemon's home.
- The CLIs to test (`claude`, `codex`, `agy`). Windows also needs Git on `PATH` for the GitHub install; portable MinGit is enough.
- `--ui 1` needs Playwright and a Chromium-based browser. Set `PW_ROOT` to the `node_modules` directory that holds `playwright`. `CHROME` picks the browser binary; without it, Linux uses Playwright's Chromium and Windows uses the installed Microsoft Edge, so Windows needs no browser download (`npm i --prefix <dir> playwright` is enough).

## Run

```bash
node e2e/e2e.mjs --label linux-0.13.2 --cli /tmp/paseo-0.13.2/node_modules/@getpaseo/cli \
  --root /tmp/uar-e2e-run --suites claude,codex,antigravity \
  --claude ~/.local/bin/claude --codex ~/.local/bin/codex --agy ~/.local/bin/agy \
  --from v1.2.2 --to main [--ui 1] [--min 1]
```

| Flag | Meaning |
|---|---|
| `--cli` | Directory of the `@getpaseo/cli` package to run |
| `--root` | Run directory; deleted first |
| `--suites` | Any of `claude,codex,antigravity` |
| `--from`, `--to` | Release installed first and rolled back to (default `v1.2.2`), and the ref under test (default `main`) |
| `--source` | Plugin git source (default `git:babo-jeonguk/paseo-usage-auto-resume`) |
| `--min 1` | Skips items 9–11, 16 and the `--ui 1` phase |
| `--ui 1` | Also runs `ui-steps.mjs` in the web app |
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
| 15 | The Auto Resume screen: day sections, a row's +10m, Change time, extra instructions, Open and switch, and Turn all off/on (`--ui 1`) |
| 16 | A reservation whose agent a daemon restart closed is continued at its due time |

Codex and Antigravity run items 3, 6, 7, 9, 11 and 16. The fake-request total, the refused connections and the harness's longest event-loop stall (`loopMaxMs`) are printed in the final `SUMMARY` line. The harness keeps one daemon session open for the whole run, and the daemon closes a session that sends nothing for 45 seconds, so the harness must not block its event loop: it runs the `paseo` CLI asynchronously.

Time is advanced through the reschedule RPC, or by editing `jobs.json` to a past due time and letting the real tick fire. The tick cannot move a reservation earlier than its reset plus two minutes.

## Not covered

- The real account and usage readers. The CI `native-cli` job checks these against the real CLIs.
- Real provider limits.
- Connected hosts.
- Native apps.

## Known issues

- **Windows: an item that saves a reservation or history entry fails now and then.** The plugin saves `jobs.json` and `history.json` by renaming a temporary file over them. Windows refuses that rename while another process has the file open, and the harness reads both files throughout the run, so a save that lands on a read fails. On a Windows host this failed 1.8% of saves with a reader polling every second and 3.6% every 0.3 seconds (the UI phase's pace); no save failed out of 1000 without one. The failed save is lost, so the item waiting for it times out (seen in 8, the UI phase's 4, 9 and 15). The daemon log then holds an `EPERM: operation not permitted, rename '…jobs.json.….tmp' -> '…jobs.json'` (or `history.json`) line from the same moment; rerun the item. The plugin keeps a single rename because no other program normally reads these files. Item 14 does not catch a failure on an RPC path, which the daemon logs as `Error handling message` rather than as plugin output.
