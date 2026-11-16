# Automation credentials and subscription verification

Research date: 2026-11-13. This note assesses the repository at the time of research. It separates documented behavior, upstream client implementation, and implementation recommendations. The documentary research read no credentials and called no authenticated endpoints. A later live measurement probed one Claude setup token and fake values; see [Live measurements](#live-measurements-2026-11-13). No model requests were made. Product code was not changed.

## Conclusion

Neither `CODEX_ACCESS_TOKEN` nor `CLAUDE_CODE_OAUTH_TOKEN` should automatically mean API-key billing. Both support automation using product-account entitlements. They nevertheless require different verification paths: Codex exposes account/backend telemetry through app-server, while Claude's setup token is documented as restricted to model requests. A token's presence alone proves neither a stable identity nor a replenishing quota. The recommended common policy is **verify the effective account, applicable quota, and readiness before resuming**; the mechanisms should remain provider-specific. Sources and limits follow below.

## Documented credential differences

| Question | Codex automation access token | Claude Code setup token |
| --- | --- | --- |
| Issuance | ChatGPT workspace admin console; token belongs to its creator and workspace. [O1] | `claude setup-token` opens the browser authorization flow and prints the token without saving it. [A1] |
| Intended use | Trusted local CLI/app-server scripts, schedulers, and private CI. [O1] | CI/scripts without interactive browser login. [A1] |
| Entitlement | ChatGPT workspace access, rather than a general Platform API key. Business and Enterprise are explicitly listed. [O1] | Claude subscription: Pro, Max, Ultra, Team, or Enterprise. [A1] |
| Lifetime/scopes | Scoped tokens require expiry; example windows 7/30/60/90 days, shortest custom window one day. An older Codex-only dialog may permit no expiry. Codex scope differs from Workspace Agents scope. [O1] | One year; model requests only, excluding Remote Control and claude.ai connectors. [A1] |
| CLI presentation | `CODEX_ACCESS_TOKEN`, or persistent `codex login --with-access-token`. [O1] | `CLAUDE_CODE_OAUTH_TOKEN`; bare mode ignores it. [A1] |

The access-token page currently lists Business and Enterprise, while the authentication overview still describes Enterprise availability. Prefer the more specific access-token page for this question, and check actual workspace permissions rather than assuming rollout from plan name. [O1][O2]

The environment-variable reference says `CODEX_ACCESS_TOKEN` accepts a **ChatGPT or Codex access token**. Therefore the variable name does not uniquely identify a personal access token or agent identity. Do not conflate the supported workspace automation credential, ordinary managed ChatGPT OAuth, or externally supplied `chatgptAuthTokens`. [O3][O4]

Authentication is not a complete billing model. OpenAI distinguishes ChatGPT access from API-key usage pricing, and plan-specific usage/credits still matter. A workspace credential does not establish a five-hour replenishing allowance, nor that credits or spending controls cannot block it. [O2][O5] Claude also documents Console sign-in without an API key: it stores a `user_oauth` profile for Console/API billing. This is a concrete reason to avoid the general rule “OAuth means subscription.” [A1]

## Codex: account and limit inspection

The official app-server API documents `account/read`, `account/rateLimits/read`, and `account/usage/read`. Auth notifications distinguish `chatgpt`, `chatgptAuthTokens`, `agentIdentity`, and `personalAccessToken`. Token-activity usage explicitly supports the latter two, but token totals are not quota readiness. The rate-limit response exposes optional windows and a multi-bucket map; absent telemetry must not be treated as available quota. [O4]

The following implementation evidence is pinned to upstream commit `553c764e8b99fa519e9c6eb9b657875ef0f5e1c1`, fetched through the GitHub connector:

- `protocol/src/auth.rs` declares managed OAuth, external ChatGPT tokens, agent identity, and personal access token as distinct modes. Its `uses_codex_backend()` returns true for all four (and header authentication), and false for API-key/Bedrock modes. Its narrower `has_chatgpt_account()` includes PAT but excludes agent identity. Thus a Codex-backend credential is not necessarily an ordinary ChatGPT account session. [C1]
- `login/src/auth/manager.rs` maps those credential variants to their matching API modes, and forwards `uses_codex_backend()` to that protocol predicate. [C2]
- `app-server/.../account_processor.rs` gates rate-limit reads on `uses_codex_backend()`, then calls the backend client. Consequently agent identity and PAT **pass the client-side gate**. This does not prove that every issued token, workspace, or deployed server returns usable limit windows. A failed fetch or empty snapshot is an error. [C3]
- That processor deliberately does not export agent-identity/PAT bearer tokens through `getAuthStatus`. The current saved-OAuth-file approach should not be generalized by trying to extract those secrets. [C3]

**Recommendation/inference:** Prefer native read-only app-server account/config and limit inspection for supported automation credentials. Confirm which selected account/workspace and meter the response describes. Use returned quota windows only when applicable to the stopped model and cause. Do not infer support from the auth-mode name, assume every limit is rolling, or substitute token-activity totals for remaining allowance. Actual `account/read` shapes and successful quota responses for this project's installed versions were not verified in this research.

## Claude: authentication can be known while quota remains unknown

`claude auth status` documents a distinct `oauth_token` auth method alongside `claude.ai`, API-key, helper, and third-party modes. Code that only accepts `claude.ai` does not cover the setup-token mode. [A2]

Claude's documented credential precedence puts cloud routes, bearer credentials, API keys, and a helper ahead of the setup token. A saved subscription login is lower priority. Verify the effective route instead of inspecting whether one variable exists. [A1]

**Not established:** The official documentation reviewed does not grant the setup token access to `/api/oauth/profile` or `/api/oauth/usage`, specify their setup-token response schemas, or guarantee account identifiers in `auth status` for this mode. The model-only restriction is a reason not to assume ordinary login telemetry access; it is not a live test proving a particular endpoint always returns 403. No such test was performed.

**Recommendation/inference:** Treat a recognized setup-token route as a possible subscription-backed route, but retain unknown readiness when identity/quota cannot be verified. Do not silently fall back to saved-login credentials belonging to a different session. The same resume safety policy can apply without implementing the same probe as Codex.

Issue [#32](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/32) reports insufficient-scope 403 responses from both profile and usage endpoints. This is reporter evidence, not a reproduced endpoint contract. Its proposed opt-in would resume from the limit notice's reset time despite unverified identity/quota, then reschedule on a new limit. That is an explicit exception to the current verification requirement, rather than proof that usage recovered. If adopted, keep it separate from Codex's native telemetry path, preserve the existing retry/attempt bounds and user cancellation/model checks, and specify behavior when no reset time is available or the setting is disabled.

## Current project and implementation consequences

The research-time [`server/subscription.ts`](../../server/subscription.ts) currently returns `{ auth: "api", status: "unknown" }` when either automation-token variable is present, before the native probes. This is a conservative exclusion, but the `api` label overstates what the variables establish.

Removing those early checks alone does not add correct support:

1. `captureLaunch()` retains only credential-presence flags. Reconstructed probe environments use the literal `<present>` for nonempty captured values. These placeholders cannot authenticate a probe. Restart persistence deliberately contains no secrets.
2. The Codex path requires `account.type === "chatgpt"`, saved `auth_mode === "chatgpt"`, an access token and account ID from `auth.json`, and a matching `/wham/usage` response. It does not currently query `account/rateLimits/read` or handle the distinct automation credential lifecycle.
3. The Claude path requires `authMethod === "claude.ai"`, account/org metadata, and saved-login credentials before reading profile/usage. This is not the documented setup-token mode.
4. A token variable can coexist with a higher-priority API key, provider override, or different saved account. Reusing the saved-account result would risk checking one identity and resuming another.

**Recommended design:** separate billing/entitlement classification from verifiable identity and quota availability. Unknown quota remains unknown even when subscription entitlement is documented. Codex has evidence supporting a native telemetry implementation first; Claude requires a capability/identity investigation specific to setup tokens. Preserve secret-free persistence and obtain any necessary probe credential through an explicit ephemeral provider boundary or the already-running authenticated runtime. Do not pass `<present>` as a real token, store raw tokens in scheduler state, or convert all token routes to ready/subscription unconditionally.

This is a research recommendation only. No implementation or live-authentication tests were performed. Focused tests, type checking, and `npm run check` were not run because this change only adds the research note.

## Live measurements (2026-11-13)

Measured with claude 2.1.321 and codex-cli 0.167.0. Identifiers are omitted. No model request was made. Token-free probes used fake values (`sk-ant-oat01-FAKE…`, `<present>`, `FAKE-codex-access-token`, a JWT-shaped fake). One real `claude setup-token` token from a Team account was probed from an empty `CLAUDE_CONFIG_DIR`; it was read without echo and never stored. No `CODEX_ACCESS_TOKEN` could be issued: the Business workspace's administrator settings block token creation. The Codex token rows are therefore token-free observations only.

### Claude

| Probe | Observation |
| --- | --- |
| `claude auth status --json`, env token only | Exit 0. Keys: `loggedIn: true`, `authMethod: "oauth_token"`, `apiProvider: "firstParty"`, `analyticsDisabled`, `projectsDirectory`, `configDirectory`, `loginExpiresAt: null`. No `email`, `orgId`, or `subscriptionType`. The real token and both fake values produce identical output. |
| Network use by `auth status` | None; output is identical without network access. `loggedIn: true` means a credential is present, not that it is valid. |
| Env token with a saved `claude.ai` login | `auth status` reports `oauth_token` without identity fields. The env token takes precedence over the saved login. |
| Env token plus `ANTHROPIC_API_KEY` | `authMethod: "api_key"`. The text output lists `CLAUDE_CODE_OAUTH_TOKEN · not in use`. |
| `/api/oauth/profile`, `/api/oauth/usage` with fake tokens | HTTP 401, `error.type: "authentication_error"` (`OAuth access token is invalid.`; `Invalid bearer token` for `<present>`). |
| `/api/oauth/profile` with the real setup token | HTTP 403, `error.type: "permission_error"`, `details.error_code: "oauth_scope_insufficient"`, required scopes any of `user:profile`, `user:office`. Same with and without the `anthropic-beta: oauth-2025-04-20` header. |
| `/api/oauth/usage` with the real setup token | With the beta header: HTTP 403 `oauth_scope_insufficient`, required scope `user:profile`. An immediately following call without the header returned HTTP 429 `rate_limit_error`. That result was not repeated and carries no scope information. |

Consequences: the report in #32 is confirmed. A setup token is valid yet cannot read profile or usage. `oauth_scope_insufficient` (403) separates a valid scoped token from an invalid or revoked one (401). `auth status` can classify the route but neither validates the token nor supplies an account identity. A probe that substitutes `<present>` is rejected as an invalid bearer token.

### Codex (token-free)

| Probe | Observation |
| --- | --- |
| App-server schema: `Account` (`account/read`) | Variants `apiKey`, `chatgpt` (`email`, `planType`, `workspaceName`), `amazonBedrock`, `gcp`. There is no `agentIdentity` or `personalAccessToken` account variant. |
| App-server schema: `AuthMode` | Includes `apikey`, `chatgpt`, `chatgptAuthTokens`, `headers`, `agentIdentity` ("Programmatic Codex auth backed by a registered Agent Identity"), `personalAccessToken`, among others. |
| App-server schema: `GetAccountRateLimitsResponse` | Contains `accountId` (when the backend supplies it), `ordinaryUsageAllowed` ("Null means unavailable; clients must not infer recovery from percentages or reset times"), `rateLimits` (single-bucket `RateLimitSnapshot` with `primary`/`secondary`, `planType`, `rateLimitReachedType`, `spendControlReached`, `credits`), `rateLimitsByLimitId`, and `rateLimitResetCredits`. |
| Fake `CODEX_ACCESS_TOKEN`, empty `CODEX_HOME` | `codex login status` fails: `failed to decode agent identity JWT`. `account/read` returns `{account: null, requiresOpenaiAuth: true}`. `account/rateLimits/read` and `account/usage/read` are rejected locally with `-32600` (`codex account authentication required …`). Legacy `getAuthStatus` (absent from the generated schema) still answers `{authMethod: null, authToken: null, requiresOpenaiAuth: true}`. |
| Fake env token with a saved ChatGPT `auth.json` | The env token takes precedence. `account/read` returns `null`. The CLI does not fall back to the saved login. |

Consequences: the CLI parses the variable as an agent-identity credential. The access-token page likewise says `codex login --with-access-token` stores an agent identity credential. Whether a valid token makes `account/read` return `chatgpt` or `null`, and whether `account/rateLimits/read` then returns windows and `ordinaryUsageAllowed`, remains unmeasured. Code must not require `account.type === "chatgpt"` for this route without that evidence.

## Primary sources

- [O1: OpenAI — Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens.md).
- [O2: OpenAI — Authentication](https://learn.chatgpt.com/docs/auth.md).
- [O3: OpenAI — Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables.md).
- [O4: OpenAI — App server, authentication/account API](https://learn.chatgpt.com/docs/app-server.md).
- [O5: OpenAI — Pricing and usage limits](https://learn.chatgpt.com/docs/pricing.md).
- [C1: openai/codex — Protocol auth modes and predicates](https://github.com/openai/codex/blob/553c764e8b99fa519e9c6eb9b657875ef0f5e1c1/codex-rs/protocol/src/auth.rs#L9).
- [C2: openai/codex — Credential-to-mode mapping](https://github.com/openai/codex/blob/553c764e8b99fa519e9c6eb9b657875ef0f5e1c1/codex-rs/login/src/auth/manager.rs#L594).
- [C3: openai/codex — Account processor; rate-limit gate at line 1191](https://github.com/openai/codex/blob/553c764e8b99fa519e9c6eb9b657875ef0f5e1c1/codex-rs/app-server/src/request_processors/account_processor.rs#L1191).
- [A1: Anthropic — Authentication, precedence and long-lived tokens](https://code.claude.com/docs/en/authentication.md).
- [A2: Anthropic — CLI reference, auth status](https://code.claude.com/docs/en/cli-reference.md).
