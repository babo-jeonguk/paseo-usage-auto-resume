# Usage Auto Resume

**Let Auto Resume handle the wait for usage limits to reset.**

A [Paseo](https://paseo.sh) plugin that automatically asks the same Codex, Claude, or Antigravity agent to continue unfinished work after a usage limit resets. Step away without coming back just to send “continue.”

[한국어](README.ko.md)

![Automatic resume reservations grouped by day, with times, switches and conversation links](assets/auto-resume.png)

Actual Paseo web interface with sample reservations. Each row shows what is scheduled to continue or waiting for verification.

- **Pick up in the same conversation.** Resumes are scheduled automatically when a supported agent stops at a usage limit.
- **See what comes next.** Check upcoming resumes across providers and workspaces, including session and weekly resets. Reservations survive daemon and plugin restarts.
- **Adjust when you need to.** Skip one resume, turn the displayed reservations off together, or move a resume to a later time.

## Install and start

Requires **Paseo daemon and app 0.11.0 or later**, with plugins enabled, and the provider CLI already signed in on the daemon host. Enable plugins in **Settings → Plugins**, or set `pluginsEnabled` to `true` in the daemon configuration.

| Provider | Current behavior |
| --- | --- |
| Codex | Verifies the ChatGPT account, model and subscription usage before sending. |
| Claude | Verifies the claude.ai account, model and subscription usage. On macOS, reads the selected profile's Keychain or fallback credential file. |
| Antigravity | Uses the reset stated in the limit notice; account and usage verification are unavailable. |

API-key and external billing routes are excluded.

```bash
paseo plugin install github:babo-jeonguk/paseo-usage-auto-resume
```

1. Open **Auto Resume** from the sidebar. An empty list is normal until an eligible limit stop is found.
2. Continue using your agents as usual. When a supported agent hits its limit, a resume reservation or verification wait appears automatically.
3. Keep the daemon host awake and running. A reset time in the notice is scheduled with a two-minute buffer without an initial usage lookup. Without a stated time, Codex and Claude look up the account/model usage to choose the schedule. Both require fresh account and usage checks before sending.

A verification wait shows the **next check time**, not a promised resume. If you send another message or the agent is running, closed, archived or awaiting permission, the pending resume is canceled.

## Adjust a resume

Each row shows the time, countdown or verification status, conversation title, provider and workspace.

- **Switch:** off skips this resume. Turn it back on before its time to restore it.
- **+10m / time:** delay by ten minutes or select the time to enter another one. The editor explains the allowed range. Changing the time turns the reservation on.
- **Note button:** add extra instructions for this continue. The note is sent once, below the continue prompt, and saving it leaves the time and switch as they are.
- **Header switch:** turn the displayed reservations off or back on together. A resume already being sent is left alone.
- **Open button:** go to the existing conversation.

For a verification wait, changing the time moves the next check.

**Recent activity** below the list shows how reservations ended in the last 24 hours: continued, skipped, canceled and why, or gave up.

Scheduled conversations also show an **Auto Resume** composer pill with their time or status. Select it to turn that reservation off or back on, delay it by 10 minutes, 30 minutes or an hour, change its time, or write its note without leaving the conversation. **Resume now** sends the continue right away when a limit lifted early; it runs the same checks first and is blocked while Codex or Claude usage is still used up. Off reservations keep their pill until their due time; reservations that run or are canceled lose it. The sidebar and conversation controls manage the same reservation.

## Choose providers

Open **Settings → Plugins → usage-auto-resume → Settings**. Built-in providers and profiles that extend them, such as `claude-main` or `codex-sub`, are listed with their account when available.

![Provider settings with account labels and individual switches](assets/provider-settings.png)

All supported providers start on, including newly added ones. Turning a provider off cancels its pending reservations, including skipped ones. Turning it back on does not restore canceled reservations. Settings apply immediately and are stored per daemon.

Below the providers, **Continue prompt** shows the text sent to the agent and lets you replace it. **Reset to default** brings back the built-in prompt, which asks the agent to resume its unfinished subagents.

## Data and operating limits

The plugin reads agent state, recent limit notices, provider configuration and CLI credentials. Codex and Claude checks contact their providers' account/usage endpoints without model turns. Tokens are never saved in jobs or logged. Resume prompts and notes go through Paseo to the existing agent and its provider; reservations, notes and a custom prompt are stored locally, and a note is deleted once it is sent.

After a restart, checks resume once a lifecycle event or an app request supplies the Paseo API. A connected app does this through composer polling. Unreadable authentication or usage keeps Codex/Claude in verification wait. Subagent continuation depends on the parent agent's tools.

See [behavior, data access and troubleshooting](docs/behavior.md) for retry rules, storage paths and other limits, or [development and registry submission](docs/development.md) to contribute. Provider expansion and handoff ideas are tracked in [#3](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/3) and [#4](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/4).

## Credits and license

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md). Inspired by [chat-resume](https://github.com/panrafal/paseo-plugins/tree/main/chat-resume), [paseo-continuity](https://github.com/keefeere/paseo-continuity), [paseo-limits](https://github.com/ortschun/paseo-limits) and [paseo-defer](https://github.com/tomgrin10/paseo-defer).
