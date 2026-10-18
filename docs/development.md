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

See [third-party notices](../THIRD_PARTY_NOTICES.md) for attribution and license details.
