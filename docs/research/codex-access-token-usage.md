# Codex access tokens: route, identity, and quota

Research date: 2026-11-13. This note extends [Automation credentials and subscription verification](automation-subscription-tokens.md). The question is how to support `CODEX_ACCESS_TOKEN` as a subscription route with real quota verification. No real access token was available because the workspace administrator blocks token creation. The findings therefore rest on upstream source, third-party code, and public issue reports. No credential files were read, no authenticated endpoint was called, and no model request was made. Product code was not changed.

Upstream citations are pinned to `openai/codex` main at [`aa5f492`](https://github.com/openai/codex/tree/aa5f492031f7edb75a40973d19eda8efb9512c61) (2026-11-13), abbreviated **M**. The `rust-v0.167.0` tag resolves to commit [`086ccc8`](https://github.com/openai/codex/tree/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a), abbreviated **T**. Every 0.167.0 code path below was checked in **T**. Its classification, provider mapping, auth-status, rate-limit, and header logic match **M**; only line numbers differ. "Inference" marks conclusions the code does not state directly.

## Conclusion

`CODEX_ACCESS_TOKEN` covers **two different credentials**, and Codex chooses between them by prefix. A value beginning with `at-` is an opaque **personal access token (PAT)**; any other value is treated as a legacy **agent-identity JWT**. [M1] Both resolve to ChatGPT workspace accounts. With a valid credential, `account/read` returns `account.type: "chatgpt"`, not `null`. [M6] `account/rateLimits/read` sends the request to the same `/wham/usage` endpoint used for a saved ChatGPT login. Each mode uses its own `Authorization` scheme, together with a `chatgpt-account-id` header taken from that credential's own metadata. [M8][M9][M10] The plugin should therefore classify the route through app-server and read quota with `account/rateLimits/read`. It should not parse `auth.json` or call `/wham/usage` itself. An agent-identity credential has no bearer token that the plugin could send. [M3] Whether a real token returns populated windows has third-party evidence for PAT only; it is not verified here.

## 1. Upstream behavior (openai/codex)

### Credential format (Q1d)

| Kind | Recognition | Contents | Offline identity? |
| --- | --- | --- | --- |
| Personal access token (v2) | Prefix `at-` [M1] | Opaque. On every load Codex calls `GET https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami` with `Authorization: Bearer at-…`. It receives `email?`, `chatgpt_user_id`, `chatgpt_account_id`, `chatgpt_plan_type`, `chatgpt_account_is_fedramp`, keeps them in memory only, and fails closed on non-2xx. [M2][P1] | No. The token is opaque; identity requires `whoami` or app-server. |
| Agent-identity JWT (legacy) | Any other value [M1] | RS256 JWT with `iss` = `https://chatgpt.com/codex-backend/agent-identity` and `aud` = `codex-app-server`. Claims: `iat`, `exp`, `agent_runtime_id`, **`agent_private_key`**, `account_id`, `chatgpt_user_id`, `email?`, `plan_type`, `chatgpt_account_is_fedramp`. [M4] | The payload is plain base64url, and Codex itself decodes it without verification first. [M4][M5] `account_id`, `chatgpt_user_id`, `plan_type`, and `exp` can be read offline. The payload contains a private key, so the decoded payload is as sensitive as the token. |

PR [openai/codex#25731](https://github.com/openai/codex/pull/25731) (merge `df7818c`) describes the PAT as "v2 personal access tokens": it "classif[ies] opaque `at-` tokens separately from legacy Agent Identity JWTs". It also says "PAT does not currently require workspace-ID parity" with `forced_chatgpt_workspace_id`. [P1] Reporters in [#25246](https://github.com/openai/codex/issues/25246) say newly issued admin-console tokens have the `at-` prefix (comment of 2026-06-22). **Inference:** tokens issued today are probably PATs, while agent-identity JWTs are older tokens. Our fake-token measurement (`failed to decode agent identity JWT`) follows from this rule because the fake value lacked the `at-` prefix.

Before an agent-identity JWT is accepted, Codex fetches the JWKS from `<chatgpt_base_url>/wham/agent-identities/jwks` to verify it. It then **registers an agent task** with `POST <authapi>/v1/agent/{agent_runtime_id}/task/register`, because a JWT-derived record has no `task_id`. [M5][M4] Requests then carry `Authorization: AgentAssertion <signed envelope>` rather than a bearer token. [M8] Therefore, starting app-server with an agent-identity credential is not network-silent: it performs a registration write. A PAT load performs one `whoami` GET. [M2]

### `account/read` (Q1a)

The OpenAI provider's `account_state()` maps `AgentIdentity` and `PersonalAccessToken`, like `Chatgpt`, to `ProviderAccount::Chatgpt { email, plan_type }`. Without a plan type the result is `MissingChatgptAccountDetails`; it is never `null` for a loaded credential. [M6] For both modes, `plan_type` comes from the credential metadata: JWT claim or `whoami`. [M3] The response's `userId` is set whenever the account is `chatgpt`. [M7]

`workspaceName` and the experimental `workspaceRouting` are populated only when `is_chatgpt_auth()` is true. That predicate (`has_chatgpt_account`) **includes PAT but excludes agent identity**. [M7][M11] An upstream test shows a PAT whose `whoami` reports plan `enterprise_cbp_automation`. Its `account/read` response is `{account: {type: "chatgpt", email: null, planType: "enterprise_cbp_automation", workspaceName: null}, userId: "user-123", workspaceRouting: {chatgptAccountId: "account-123", …}}`. [M12] `enterprise_cbp_automation` is a real plan variant, displayed as "Enterprise (Automation)". [M11] A null `email` is legal for a PAT.

An invalid or failed credential never reaches `account_state`: loading fails, and `account/read` returns `{account: null, requiresOpenaiAuth: true}`, as measured in the sibling note.

### `getAuthStatus` (Q1b)

The method is marked `DEPRECATED in favor of GetAccount` but still exists. [M13] For `AgentIdentity` and `PersonalAccessToken` it returns `authMethod: "agentIdentity"` / `"personalAccessToken"` and **always** `authToken: null` ("Host-owned and metadata-bearing credentials are never exported."). [M14][T2] The upstream PAT test asserts `{authMethod: "personalAccessToken", authToken: null, requiresOpenaiAuth: true}`. [M12] `getAuthStatus` is thus the only app-server read that names the exact mode. `account/read` cannot distinguish an access token from a normal ChatGPT login.

### `account/rateLimits/read` (Q1c)

- **Gate:** the request is rejected with `-32600 "codex account authentication required…"` when no credential loads. It is rejected with `"chatgpt authentication required…"` when `!uses_codex_backend()`. Both access-token modes pass this gate. [M14][M11]
- **Endpoint:** `GET {chatgpt_base_url}/wham/usage` (`/api/codex/usage` for Codex-API path style). The access-token modes take no separate path. [M9] The `x-openai-codex-luna-reserve` variant applies only to `AuthMode::Chatgpt`, so it never applies to these modes. [M14]
- **Headers:** a PAT uses `BearerAuthProvider`: `Authorization: Bearer <at-…>` plus `chatgpt-account-id: <whoami chatgpt_account_id>`. [M8][M10] Agent identity uses `Authorization: AgentAssertion …` plus `chatgpt-account-id: <JWT account_id>`. [M8] Both add `X-OpenAI-Fedramp: true` for FedRAMP accounts.
- **Mapping:** the single `codex` snapshot is always built, with `primary`/`secondary` windows from `rate_limit`, plus `credits`, `spend_control`, `plan_type`, and `rate_limit_reached_type`. `additional_rate_limits` become extra snapshots keyed by `metered_feature`, each carrying `normal_model_slug`. [M9][M15] Windows are `null` when the backend sends no `rate_limit`. Nothing in the code is mode-specific.
- **`ordinaryUsageAllowed`** is `rate_limit.allowed`. It is **forced to null** unless the account is not FedRAMP, **and** `response.account_id == auth.get_account_id()`, **and** `response.user_id == auth.get_chatgpt_user_id()`. [M14][M9] For access tokens, both expected values come from the credential metadata. [M3] Null here can mean "backend omitted identity", not "unlimited".
- **`model_usage`** (the per-model map this plugin reads today from raw `/wham/usage`) is **not parsed anywhere in Codex**. No code under `codex-rs/` outside a TUI test references it. App-server exposes per-model state only through `rateLimitsByLimitId` / `normal_model_slug`. [M9]

### Precedence and persistence (Q1e)

`load_auth` order [M16][T3]:

1. `CODEX_API_KEY`, only when `enable_codex_api_key_env` is true. That holds in `codex exec` and in-process bootstrap; **app-server passes `false`**. [M17]
2. Ephemeral (in-memory) external auth, such as `chatgptAuthTokens`.
3. `CODEX_ACCESS_TOKEN`, classified by prefix. This step is skipped when the forced login method excludes it (`auth_mode_is_allowed(…, AgentIdentity)`).
4. Persisted store (file/keyring/auto). This is the step that would load a saved ChatGPT login or a persisted access token.

`OPENAI_API_KEY` is not a `load_auth` source. It is read only for TUI prefill and a few side features. [M17] The env token therefore masks any saved login, which matches the sibling measurement.

`codex login --with-access-token` reads the token from stdin. It is refused when the forced login method disallows ChatGPT. [M18] It stores the following through the configured credential store (`auth.json` only in file mode) [M19][M20]:
- **PAT:** `{ "OPENAI_API_KEY": null, "personal_access_token": "at-…" }` with **no `auth_mode`** ("so older Codex builds can still deserialize auth.json after a rollback"). The mode is inferred from the field. [M19][M21]
- **Agent identity:** `{ "auth_mode": "agentIdentity", "OPENAI_API_KEY": null, "agent_identity": "<jwt>" }`. Before saving, Codex verifies the JWT against JWKS. [M19] A reporter in [#25246](https://github.com/openai/codex/issues/25246) shows exactly this shape from a real Business token (2026-06-02 comment).

`codex login status` prints "Logged in using access token" (agent identity) or "Logged in using personal access token". [M22]

### Notifications (Q1f)

`account/updated` carries `authMode` (the precise mode, e.g. `personalAccessToken`) and `planType`. [M23] It is sent after a successful app-server login request, and to a connection when workspace routing resolves. The routing path requires `is_chatgpt_auth()`, so it **never fires for agent identity**, and an env-supplied token does not go through the login flow. [M23][M7] **Inference:** the notification is not a reliable classification signal for a probe. Use `getAuthStatus`.

## 2. Other projects (Q2)

### Evidence from real tokens

| Source | What it shows |
| --- | --- |
| CodexBar PR [#3060](https://github.com/steipete/CodexBar/pull/3060) (merged as [`814a5d5`](https://github.com/steipete/CodexBar/commit/814a5d5e94dc647ab2244f0ad71e13ffe4f5a744)) | The PR body says "Live Codex Settings: Auto resolved to PAT, weekly quota, Team plan" and includes a [screenshot](https://raw.githubusercontent.com/steipete/CodexBar/814a5d5e94dc647ab2244f0ad71e13ffe4f5a744/docs/screenshots/codex-pat-settings-proof.png). The screenshot shows Source `pat`, Plan `Team`, one "Weekly 30% left, resets in 5d 1h" bar, and no session (5-hour) bar, on codex-cli 0.148.0-alpha.9. This is the only third-party sign found that a PAT gets a populated `/wham/usage` window tied to a seat plan. It does not show whether the 5-hour window was absent or merely not rendered. |
| openai/codex [#25246](https://github.com/openai/codex/issues/25246) | A real-token tracker for Business. Reported: 401 on `/backend-api/codex/responses` (May–June 2026); a persisted agent-identity `auth.json` shape; new tokens prefixed `at-`; `whoami` 403 ("personal access token metadata request failed with status 403 Forbidden") on both the env and login paths (2026-06-19). Admin "Access token creation is disabled" toggles appeared later, and the reporter said it "Fully works again" on 2026-07-15. The issue covers auth and model requests; no usage-read results are reported. |

No public log, fixture, or issue was found showing a real `account/rateLimits/read` or `/wham/usage` **response body** for either access-token mode.

### Code that only handles the token

| Project | Detection | Limit read | Identity |
| --- | --- | --- | --- |
| CodexBar [`CodexPATUsageFetcher.swift`](https://github.com/steipete/CodexBar/blob/7447bc77c2497323d9c41e40164ce705533493c8/Sources/CodexBarCore/Providers/Codex/CodexPAT/CodexPATUsageFetcher.swift#L19-L108), [`CodexPATFetchStrategy.swift`](https://github.com/steipete/CodexBar/blob/7447bc77c2497323d9c41e40164ce705533493c8/Sources/CodexBarCore/Providers/Codex/CodexPAT/CodexPATFetchStrategy.swift#L92-L134) | `personal_access_token` in `auth.json` ([PR #3060](https://github.com/steipete/CodexBar/pull/3060)) | Direct HTTP: `whoami`, then `/wham/usage` with `Authorization: Bearer`, `ChatGPT-Account-Id` from `whoami`, an `originator` header, and a CLI User-Agent | `whoami.chatgpt_account_id`. The comment warns that "a stale managed-workspace ChatGPT-Account-Id would query the wrong account". It accepts a credits-only response with no windows. 401 triggers fallback; 403 is terminal ([PR #3466](https://github.com/steipete/CodexBar/pull/3466); "Tests use synthetic responses"). |
| ai-devkit [`openai-subscription.ts`](https://github.com/codeaholicguy/ai-devkit/blob/b80944e5dd7be7ed820ea58d4d5e2567ad9e9e99/packages/agent-manager/src/capacity/providers/openai-subscription.ts#L1-L190), [`sources/codex.ts`](https://github.com/codeaholicguy/ai-devkit/blob/b80944e5dd7be7ed820ea58d4d5e2567ad9e9e99/packages/agent-manager/src/capacity/sources/codex.ts#L160-L250) | Stored PAT credential | `whoami` → `/wham/usage` (Bearer + `ChatGPT-Account-Id`). Fallback: app-server `account/rateLimits/read` + `account/read`. | `whoami.chatgpt_account_id`. 401/403 → `authenticated: false`. Availability is `unknown` when no window has `used_percent`. |
| Omarchy [`omarchy-agent-usage-codex`](https://github.com/omacom/omarchy/blob/ac6cb9c712848741f994d7ecbaccdbab90b526e8/bin/omarchy-agent-usage-codex#L495-L700) | Env `CODEX_ACCESS_TOKEN` counts as credentials. The token is passed to the primary home's app-server only ("handed to every registered home, it would make each of them answer for the same account"). | App-server `account/rateLimits/read`. An error containing "auth" means signed out. A result with no buckets is a failed probe and keeps the last windows marked stale. | Env token: `"token:" + sha1(token)`. Saved login: workspace `account_id` plus `chatgpt_user_id`, because "account_id names the workspace, whose members each have their own limits". |
| NarraFork [`codex-pat.ts`](https://github.com/NarraFork/NarraFork/blob/7a8339849cbcd19c9e154ce49b71854bf800bacb/server/lib/codex-pat.ts#L14-L186) | `isCodexPersonalAccessToken` | Validation only via `whoami` | `chatgpt_account_id`, `chatgpt_user_id`, plan, FedRAMP flag |
| Paseo [`plugins/codex-usage-source/server/usage.ts`](https://github.com/getpaseo/paseo/blob/7791dcee3b97abe96f6662513937815bf368d6a0/plugins/codex-usage-source/server/usage.ts#L133-L210) | Reads `tokens.access_token` / `account_id` from `auth.json` only | `/wham/usage` (Bearer + `ChatGPT-Account-Id`) | No access-token support |
| [openai/codex-action](https://github.com/openai/codex-action/blob/13e9c17417b29e9a276f73ec6ed7fb574137d3c3/action.yml#L17) | Only an `openai-api-key` input | n/a | No access-token support |

Several other projects decode the `enterprise_cbp_automation` plan label without access-token logic, for example [Kilo Code](https://github.com/Kilo-Org/kilocode/blob/caf1f6069a51af72c1520cbad7a8adffe8eb59b9/packages/core/src/kilocode/provider-usage/codex.ts#L22) and [t3code](https://github.com/pingdotgg/t3code/blob/97cfc07759fed2a67edef22de4370ed74ff40030/apps/server/src/provider/CodexProvider.ts#L216). No project was found that reads limits for an **agent-identity** credential other than through app-server.

## 3. Official documentation (Q3)

- The token "represents the ChatGPT workspace user who created it, so runs can use that user's access", and "Each token belongs to its creator and that user's ChatGPT workspace." The access-token page says nothing about usage limits, rate limits, credits, or billing, and does not document the token format. [O1]
- The pricing page lists "Codex access tokens for trusted automation" for Business and Enterprise only. It states the general plan rules: local and cloud work "share your plan's usage allowance"; Enterprise/Edu without flexible pricing has "the same per-seat usage limits as Plus"; flexible-pricing Enterprise/Edu has "no fixed rate limits"; workspace credits can continue work. [O2]
- **Inference:** a token draws on its creator's seat allowance in its workspace. The CodexBar screenshot (Team plan, weekly window) is consistent with this. No document confirms it. The `enterprise_cbp_automation` plan type [M11][M12] suggests some automation tokens resolve to a distinct automation plan whose limits are undocumented.

## Design implications

**(a) Classify.** Stop treating `CODEX_ACCESS_TOKEN` as API billing. Run the existing app-server probe with the **agent's real environment**, which must include the token itself. The present-flag placeholders cannot authenticate (see the sibling note), and supplying the secret at probe time is still an open design point. Then require all of the following:
- `getAuthStatus` returns `authMethod` ∈ {`personalAccessToken`, `agentIdentity`, `chatgpt`}. [M14]
- `account/read` returns `type: "chatgpt"` with a `planType`. [M6]
- The existing `model_provider`/`OPENAI_BASE_URL` checks pass.

`apikey` remains API billing. A failed load, meaning `account: null` or `authMethod: null`, is `unknown`, not `api`. `CODEX_API_KEY` beats the token only in `codex exec`, not in app-server. [M17] Keep treating `CODEX_API_KEY` as API billing when the agent runs `exec`, and as irrelevant to the app-server probe.

**(b) Read quota.** Use `account/rateLimits/read` through that same app-server. It is the only path that works for agent identity, which exposes no bearer token [M3]. It also keeps the token out of plugin HTTP code.

Fields to trust:
- `rateLimits` (the `codex` bucket): `primary`/`secondary` `usedPercent` and `resetsAt`.
- `rateLimitReachedType`.
- `rateLimitsByLimitId` entries whose `normalModelSlug` matches the stopped model.
- `ordinaryUsageAllowed` **only when non-null**. [M14][M9]

Treat as `unknown`: an RPC error; null windows in every bucket; `ordinaryUsageAllowed: null` with no windows; FedRAMP accounts; a response `accountId` that differs from the identity in (c). Per-model `model_usage` is unavailable on this path. [M9] Do not infer "ready" for a model whose bucket is absent; fall back to the `codex` windows as today. Credits or spend-control state alone must not mean ready, as in the current policy.

Do not call `/wham/usage` directly with the token. It would work for a PAT, as CodexBar does [CodexBar], but not for agent identity, and it would move the secret into plugin code.

**(c) Reservation identity.** Hash `(source, accountId, userId, model)`:
- `accountId` is the `account/rateLimits/read` `accountId`. It must equal `workspaceRouting.chatgptAccountId` when present (PAT only). [M7][M14]
- `userId` comes from `account/read`. [M7]

Workspace members have separate limits, so the account id alone is not enough. Omarchy follows this rule for saved logins. Do not key on a token hash, because rotation would change the key while the seat stays the same. If the response omits `accountId`, there is no verified identity. Offline JWT decoding gives `account_id`/`chatgpt_user_id`/`exp` only for legacy agent-identity tokens. The payload holds a private key, so avoid it, or at most use `exp` as an early-expiry hint without logging. PATs are opaque. [M4][M1]

**(d) Still unverified:**
- Whether a real PAT or agent identity returns non-null 5-hour/weekly windows and `accountId`/`userId` from `/wham/usage`. The only evidence is CodexBar's weekly-only screenshot.
- Whether `ordinaryUsageAllowed` is populated for these modes.
- What the limits are for `enterprise_cbp_automation`, and whether access-token use shares the creator's seat pool (undocumented).
- Whether admin consoles still issue agent-identity JWTs.
- The side effects of the agent-task registration that each app-server start performs with an agent-identity credential. [M5] For read-only probing, reuse one app-server per check and avoid repeated spawns.
- Behavior of Codex versions other than 0.167.0 / `aa5f492`.

Verification: this change adds only this research note. Focused tests, type checking, and `npm run check` were not run.

## Primary sources

Upstream `openai/codex` (**M** = `aa5f492031f7edb75a40973d19eda8efb9512c61`, **T** = `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`, tag `rust-v0.167.0`):

- [M1: login/src/auth/access_token.rs — `at-` prefix classifier](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/login/src/auth/access_token.rs#L1-L14) ([T](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/login/src/auth/access_token.rs#L1-L14))
- [M2: login/src/auth/personal_access_token.rs — whoami hydration](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/login/src/auth/personal_access_token.rs#L11-L126)
- [M3: login/src/auth/manager.rs — get_token / get_account_id / account_plan_type](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/login/src/auth/manager.rs#L673-L773)
- [M4: agent-identity/src/lib.rs — JWT iss/aud, claims, unverified decode, AgentAssertion, URLs](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/agent-identity/src/lib.rs#L40-L129) ([decode L267-L305](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/agent-identity/src/lib.rs#L267-L305), [assertion L233-L246](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/agent-identity/src/lib.rs#L233-L246), [URLs L470-L491](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/agent-identity/src/lib.rs#L470-L491))
- [M5: login/src/auth/agent_identity.rs — from_jwt, task registration, JWKS verification](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/login/src/auth/agent_identity.rs#L133-L277)
- [M6: model-provider/src/provider.rs — account_state maps both modes to Chatgpt](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/model-provider/src/provider.rs#L667-L707) ([T L690](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/model-provider/src/provider.rs#L690-L730))
- [M7: app-server account_processor/workspace_routing.rs — get_account, userId, workspace routing gate](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs#L259-L375)
- [M8: model-provider/src/auth.rs — AgentIdentityAuthProvider and auth_provider_from_auth](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/model-provider/src/auth.rs#L162-L193) ([L524-L542](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/model-provider/src/auth.rs#L524-L542); [T L411](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/model-provider/src/auth.rs#L411-L429))
- [M9: backend-client/src/client/rate_limit_resets.rs — /wham/usage fetch and ordinary_usage_allowed](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/backend-client/src/client/rate_limit_resets.rs#L23-L133); [types.rs response fields](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/backend-client/src/types.rs#L56-L67)
- [M10: model-provider/src/bearer_auth_provider.rs — Bearer + chatgpt-account-id](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/model-provider/src/bearer_auth_provider.rs#L34-L51)
- [M11: protocol/src/auth.rs — has_chatgpt_account / uses_codex_backend; enterprise_cbp_automation](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/protocol/src/auth.rs#L42-L119)
- [M12: app-server/tests/suite/auth.rs — PAT getAuthStatus and account/read test](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/app-server/tests/suite/auth.rs#L145-L245)
- [M13: app-server-protocol common.rs — getAuthStatus deprecated](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/app-server-protocol/src/protocol/common.rs#L1594-L1598)
- [M14: app-server account_processor.rs — getAuthStatus and account/rateLimits/read](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/app-server/src/request_processors/account_processor.rs#L1117-L1294) ([T2 L1097-L1290](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/account_processor.rs#L1097-L1290))
- [M15: backend-client/src/client.rs — snapshot mapping](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/backend-client/src/client.rs#L751-L791)
- [M16: login/src/auth/manager.rs — load_auth precedence](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/login/src/auth/manager.rs#L1606-L1700) ([T3 L1628](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/login/src/auth/manager.rs#L1628-L1660))
- [M17: app-server/src/lib.rs — enable_codex_api_key_env false](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/app-server/src/lib.rs#L604); [exec/src/lib.rs — true](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/exec/src/lib.rs#L810); [env readers](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/login/src/auth/manager.rs#L1049-L1066)
- [M18: cli/src/login.rs — run_login_with_access_token](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/cli/src/login.rs#L290-L329)
- [M19: login/src/auth/manager.rs — login_with_access_token persistence](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/login/src/auth/manager.rs#L1146-L1200)
- [M20: login/src/auth/storage.rs — AuthDotJson / AgentIdentityStorage](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/login/src/auth/storage.rs#L52-L121)
- [M21: login/src/auth/manager.rs — resolved_mode infers PAT](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/login/src/auth/manager.rs#L1948-L1960)
- [M22: cli/src/login.rs — login status strings](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/cli/src/login.rs#L520-L535)
- [M23: account_processor.rs — account/updated payload and login emission](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/app-server/src/request_processors/account_processor.rs#L258-L267) ([L976-L1018](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/app-server/src/request_processors/account_processor.rs#L976-L1018), [routing emission](https://github.com/openai/codex/blob/aa5f492031f7edb75a40973d19eda8efb9512c61/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs#L215-L257))
- [P1: openai/codex#25731 — support v2 personal access tokens](https://github.com/openai/codex/pull/25731)

Other:

- [openai/codex#25246 — Business access tokens 401 tracker](https://github.com/openai/codex/issues/25246)
- [CodexBar PR #3060](https://github.com/steipete/CodexBar/pull/3060), [PR #3466](https://github.com/steipete/CodexBar/pull/3466)
- [O1: OpenAI — Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens.md)
- [O2: OpenAI — Pricing and usage limits](https://learn.chatgpt.com/docs/pricing.md)
