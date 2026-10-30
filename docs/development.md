# Development and registry submission

[English README](../README.md) · [한국어 README](../README.ko.md)

## Local development

Use `npm run test:focus -- <test files>` for focused runs (for example, `shared/prompt.test.ts`); see [verification rules](../AGENTS.md) for the development workflow. Type checking caches results in `.cache/typescript/`; delete that directory to reset the cache.

```bash
npm ci
npm run check
paseo plugin install "$PWD"
```

`npm run check` runs TypeScript checking and the Node test suite. `npm run test:native` runs the account check against an installed CLI selected by `NATIVE_CLI=claude` or `NATIVE_CLI=codex`, using fixture logins in a temporary home; CI runs it on Linux and Windows for Claude Code (native installer and npm) and Codex (npm: a pinned release through the full check, and the latest release started and stopped only, since it does not answer a fixture login).

`e2e/` holds a by-hand end-to-end simulation. It installs the plugin from GitHub into an isolated real Paseo daemon and drives limit stops, reservations, Resume now, the tick, cancellations, the startup scan and a rollback, with the real Claude Code, Codex and Antigravity CLIs against local fake model APIs, on Linux and Windows. Run it before a release or after a Paseo upgrade; see [its README](../e2e/README.md).

After changing an installed directory plugin:

```bash
paseo plugin reload usage-auto-resume
```

Plugin logs use the `[usage-auto-resume]` prefix in the daemon log. Paseo compiles the TypeScript entry points; no separate application build is required. Runtime imports use Paseo's host-provided modules.

`client/conversations.ts` registers and removes composer pills from the scheduled-job directory, including disabled reservations. `client/conversation.tsx` provides the per-conversation controls, sharing `client/time-editor.tsx` and the query keys in `client/query-keys.ts` with the list. Both surfaces use the guarded mutation RPCs, and the composer adds `auto-resume.resume-now`; each one acts only on the reservation `id` the screen showed, and only while its displayed `dueAt` still matches. Client-only placement metadata comes from the agent snapshot and is not persisted in jobs. `auto-resume.set-note` saves or removes a reservation's note by its `id` alone, since a note is for the reservation, not its time, and `client/note-editor.tsx` is the editor both surfaces open. The interface calls a note **extra instructions**; the code, the RPC and `jobs.json` keep the name `note`. Which editor is open, for which reservation, and what it has typed live in `client/edit-session.ts`, a reducer both surfaces keep at their top through `client/use-edit-session.ts`; another reservation for the same agent closes it. A row drawn again, as when its day group changes, therefore keeps them, and `client/edit-session.test.ts` covers each rule.

Canceling, skipping or dropping a reservation goes through `retire` in `server/resumer.ts`, which removes it only if the row is still the one that was checked, then logs and records the reason in `server/history.ts`. Two kinds of result are recorded where they are decided instead: a stop that ends its reservation, by giving up, under another account or for a newer message, which `replan` decides in the same update that would otherwise write the next reservation, and a continue that was sent or failed to send. Clearing a continue that was already sent records nothing. History is a separate file, so a failed write never affects jobs.

Delivery goes through `deliver` in `server/resumer.ts`. The tick runs it in auto mode; the `auto-resume.resume-now` RPC runs it in manual mode, which ignores the notice's reset and the reservation switch and records its results with `trigger: "manual"`. Both read the usage check through `usageHold`: the tick postpones a reservation it holds, while Resume now answers `used_up` or `unverified` and leaves the reservation unchanged. Both claim the row inside one store update, so a tick and Resume now at the same time send one continue. What happens to a reservation follows the table in [behavior](behavior.md#checks-before-sending). `server/decisions.ts` decides from a row and an agent: `turnAction` for turn events, `agentGate` for due-time checks 3 to 8. `server/reservation.ts` holds every way a row changes, so no writer builds one by hand: `replan` for a stop at a limit, `postponed`, `rescheduled`, `switched`, `noted`, `claimed` and `sent`, with `pinned` and `isSameJob` saying when a change still applies. Both have a case per rule in their tests; the checks that need settings, the account or usage stay in `deliver`, tested through the resumer. A reservation's `id` names it for its whole life. What a change targets follows where it comes from: turn events act on the id they read, user changes send the id the screen showed (with its time, except for a note), a due-time attempt in `deliver` claims or cancels only the row it checked (`isSameJob`), whatever it finds, and the archive hook, `reconcileProviders` and a stop finding API billing act on whatever pending reservation the agent has. Only the send that claimed it, `replan` and `recover` remove a row in state `sending`. A new message is told apart only by `lastUserMessageAt`, which Paseo does not move for a turn a provider starts on its own, such as for Claude's subagent notifications. Paseo has no "send only if idle": a send unarchives the agent, clears its permission requests and replaces a running turn, so the agent is read again after the usage lookup and the continue is sent with `activeTurnBehavior: "steer"`. The text sent is built by `continuePrompt` in `shared/prompt.ts`, from the `resume` host setting (null keeps the built-in prompt) and the note read from the claimed row. The `resume` setting is kept apart from `providers`: when it cannot be read, the built-in prompt is sent instead of holding resumes.

The plugin uses a persistent queue because the Paseo 0.11 public plugin API supplies agent access inside hooks/RPCs rather than a schedule API. A due reservation rechecks agent and subscription state before sending. See [behavior](behavior.md) for the restart and delivery tradeoffs, and [plugin reference](https://paseo.sh/docs/plugins/reference) for the host API.

## Registry submission

The official [Paseo registry](https://github.com/getpaseo/plugins#submit-a-plugin) accepts a public GitHub source without an npm release. Submit this repository using the [submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml). Review pins the artifact to an exact commit; acceptance is decided by the registry maintainers. Direct GitHub installation and a registry listing are separate.

[`OVERVIEW.md`](../OVERVIEW.md) is included for the listing page. Actual-interface screenshots are shipped in [`assets/`](../assets/README.md) and declared in the manifest's `media` field. Follow the current [publishing guide](https://paseo.sh/docs/plugins/publishing) and [review policy](https://github.com/getpaseo/plugins/blob/main/REVIEW.md#images-and-media) when submitting. Check that the overview, assets and runtime files are included in the artifact.

## Planned work

- Support more providers, using Paseo usage information where available: [#3](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/3).
- Explore continuing a limited task on another selected provider: [#4](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/4).

Feedback and contributions are welcome on these issues. Real provider limit notices are useful; remove private conversation content and credentials before sharing.

## Implementation references

Reset parsing draws on [panrafal's chat-resume](https://github.com/panrafal/paseo-plugins/tree/main/chat-resume) and [paseo-continuity](https://github.com/keefeere/paseo-continuity). Usage-window selection follows [paseo-limits](https://github.com/ortschun/paseo-limits); the persistent queue was inspired by [paseo-defer](https://github.com/tomgrin10/paseo-defer). The interface follows Paseo settings and the alarm-list pattern in the iOS Clock app.

Windows launches follow Node's documented rule that `.bat` and `.cmd` files start only through a shell ([child_process](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows), enforced since the [April 2024 security releases](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)); the `cmd.exe` switches and quoting follow [`cmd`](https://learn.microsoft.com/windows-server/administration/windows-commands/cmd), and lookup follows `PATH` and `PATHEXT` order as `cmd.exe` does. The login directories come from the CLIs themselves: `configDirectory` in `claude auth status --json` (observed in Claude Code 2.1.306 and 2.1.308) and `codexHome` in the Codex app server's `initialize` response (observed in 0.152.1 and 0.163.0).

Claude credential-store selection follows the [official authentication guide](https://code.claude.com/docs/en/authentication#credential-management). The macOS account-specific and legacy Keychain lookup behavior references [Paseo v0.12.0's usage source](https://github.com/getpaseo/paseo/blob/v0.12.0/plugins/claude-usage-source/server/usage.ts#L298). Store override precedence was also checked against Claude Code 2.1.303's native selector. Credential tests inject the OS boundary; the Claude limit scenarios exercise the macOS reader with fixture Keychain records even on Linux. Actual macOS permission dialogs and locked-Keychain behavior still require a Mac host to validate.

See [third-party notices](../THIRD_PARTY_NOTICES.md) for attribution and license details.
