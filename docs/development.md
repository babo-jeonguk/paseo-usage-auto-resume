# Development and registry submission

[English README](../README.md) · [한국어 README](../README.ko.md)

## Local development

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

`client/conversations.ts` registers and removes composer pills from the scheduled-job directory, including disabled reservations. `client/conversation.tsx` provides the per-conversation controls, sharing the list's query key and `client/time-editor.tsx`. Both surfaces use the existing guarded mutation RPCs; the job's displayed `dueAt` must still match before it can be changed. Client-only placement metadata comes from the agent snapshot and is not persisted in jobs.

Canceling, skipping or dropping a reservation goes through `retire` in `server/resumer.ts`, which removes it only if the row is still the one that was checked, then logs and records the reason in `server/history.ts`. Two results are recorded where they are decided instead: giving up, which `schedule` decides in the same update that would otherwise write the next reservation, and a continue that was sent or failed to send. Clearing a continue that was already sent records nothing. History is a separate file, so a failed write never affects jobs.

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

Claude credential-store selection follows the [official authentication guide](https://code.claude.com/docs/en/authentication#credential-management). The macOS account-specific and legacy Keychain lookup behavior references [Paseo v0.12.0's usage source](https://github.com/getpaseo/paseo/blob/v0.12.0/plugins/claude-usage-source/server/usage.ts#L298). Store override precedence was also checked against Claude Code 2.1.303's native selector. Credential tests inject the OS boundary; the Claude limit scenarios exercise the macOS reader with fixture Keychain records even on Linux. Actual macOS permission dialogs and locked-Keychain behavior still require a Mac host to validate.

See [third-party notices](../THIRD_PARTY_NOTICES.md) for attribution and license details.
