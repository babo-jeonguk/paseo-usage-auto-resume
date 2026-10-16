# CLI 한도·크레딧 오류와 실제 인증 방식 조사

조사일: 2026-10-16. 목적은 API 과금·잔액 소진을 자동 재개에서 제외하면서, 구독의 갱신 가능한 사용 한도를 정확히 다루는 것이다. **조사 당시 구현을 대상으로 한 조사와 설계 제안**이다. 아래의 “현재 구현”은 조사 시점을 뜻한다. 이후 구현 결과와 현재 제약은 README의 동작 설명을 참고한다.

## 결론

- `Your workspace is out of credits…`를 일반적인 구독 한도 정규식에 추가하는 것은 근거가 부족하다. Codex는 워크스페이스 크레딧과 일반 사용 한도를 별도로 분류한다. 같은 응답에 5시간 창의 리셋이 있어도 크레딧 차단 해제가 보장되지 않는다. [C1][C2]
- 현재 플러그인은 API 인증을 판별해서 제외하지 않는다. 일부 결제 오류 문자열을 제외할 뿐이다. 따라서 “API 계정은 제외돼 있다”는 설명은 현재 구현보다 강한 주장이다. 특히 일반 `quota`, `RESOURCE_EXHAUSTED`, `rate_limit` 패턴은 인증·원인을 보장하지 않는다. [L1]
- 실제 실행 인증을 확인하는 수단은 있다. 다만 저장된 OAuth, 계정 이메일, provider 이름만으로는 부족하다. CLI가 선택한 인증, 실행 환경·설정·엔드포인트, 실제 과금 경로를 함께 확인해야 한다. [C3][A1][G1]
- 이 프로젝트에서 API 계정을 제외하려면 **실제 인증 경로 → 차단 사유 → 일치하는 quota의 리셋 → 전송 전 해제 확인** 순으로 판단해야 한다. API·외부 과금 경로 및 불명확한 인증에는 자동 continue를 보내지 않는 정책을 명시해야 한다. 이는 조사에 따른 설계 제안이다.

## 조사 범위와 증거 수준

| 대상 | 로컬 설치 버전 | 확인 근거 |
| --- | --- | --- |
| Codex | 0.162.1 | `codex --version`, 실제 오류 세션의 `cli_version`, 대응 공식 태그 소스 |
| Claude Code | 2.1.299 | `claude --version`, 설치된 first-party 바이너리 정적 분석; 2.1.294·2.1.296도 비교 |
| Antigravity CLI | agy 1.3.6 | `agy --version`, 공식 문서·릴리스 노트, 설치 바이너리·Paseo 어댑터 |
| Paseo | 0.11.2 | `paseo --version`, 설치된 패키지 및 v0.11.2 소스 |
| 이 플러그인의 개발 의존성 | 0.11.0 | `package.json`의 `@getpaseo/*` 버전 |

공식 소스·문서·릴리스 노트, 로컬 실측, 정적 바이너리 분석, 공식 저장소의 사용자 신고를 구분한다. 사용자 신고는 관찰 예시이며 제품의 보장된 오류 계약이 아니다. 버전별 비교는 아래 명시된 표본에 한정하며 모든 중간 버전의 최초 도입을 확정한 것은 아니다. 모델 호출이나 크레딧 소진 실험은 하지 않았다. 인증 토큰·계정 식별자·이메일은 이 문서에 기록하지 않는다.

## 1. Codex

### 오류 분류

설치 버전과 대응하는 `rust-v0.162.1`의 커밋은 `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`이다. 아래 설명은 이 버전의 공식 formatter와 API bridge 기준이다. [C1][C2]

| 원인 | 메시지·구조의 식별 부분 | 해석 |
| --- | --- | --- |
| 일반 구독 사용 한도 | `You’ve hit your usage limit`; 로컬 재시도 시각 또는 later 안내 | 해당 한도와 reset을 확인할 수 있는 재개 후보 |
| 모델별 사용 한도 | `limit_name`에 따른 모델별 안내 | 모델·meter가 일치해야 하며 다른 모델의 창으로 대체하지 않음 |
| API 잔액·과금 quota 소진 | `QuotaExceeded`; 출력은 quota 초과와 plan/billing 확인 안내 | API 과금 소진으로 분류하여 제외 |
| 워크스페이스 크레딧 | owner/member별 별도 formatter 분기 | 일반 rolling quota와 구분 |
| 워크스페이스 spend cap | owner/member별 증액 요청 안내 | 구독 로그인에서도 발생하는 별도 예산 차단 |

이번 사용자가 받은 문구는 다음과 같다. 이는 `WorkspaceMemberCreditsDepleted` 분기와 일치한다. 이 분기는 reset이 있어도 재시도 시각을 덧붙이지 않고 반환한다. [C1]

```text
Your workspace is out of credits. Ask your workspace owner to refill in order to continue.
```

원시 API 구분에는 다음 정보가 있다. [C2]

- HTTP 429의 `error.type == usage_limit_reached`는 `UsageLimitReachedError`로 변환된다.
- `insufficient_quota`, `credit_balance_exhausted`, 조직·프로젝트 spend/usage limit 코드는 `QuotaExceeded`로 변환될 수 있다. SSE 실패 경로도 별도 정규화한다.
- `x-codex-active-limit`, `x-codex-rate-limit-reached-type`, `resets_at` 등의 정보가 사용된다.
- app-server의 `usageLimitExceeded`는 구독 한도와 API `QuotaExceeded` 등을 함께 표현한다. **이 코드 하나만으로 구독 한도를 확정할 수 없다.**

### 이번 로컬 사례에서 확인된 사실과 확인되지 않은 사실

오류가 난 Paseo 에이전트의 provider는 `codex-sub`이고, 해당 저장 인증의 `auth_mode`는 `chatgpt`였다. 실제 오류 세션의 버전은 0.162.1, 모델 provider는 `openai`였다. 이는 저장된 API 키 인증으로 인한 사건과 구분되는 근거다. 다만 일반화된 구현에서는 provider override까지 확인해야 한다. [L2][C3]

2026-10-16 19:24 KST에 조회한 원시 REST 사용량 중 필요한 항목만 보존하면 다음과 같다. 날짜는 조사 당시 관찰값이지 현재 상태의 보장이 아니다. [L2]

```json
{
  "plan_type": "team",
  "rate_limit": {
    "allowed": false,
    "limit_reached": true,
    "primary_window": {
      "used_percent": 100,
      "limit_window_seconds": 18000,
      "reset_at": 1792160062
    },
    "secondary_window": {
      "used_percent": 24,
      "limit_window_seconds": 604800,
      "reset_at": 1792722866
    }
  },
  "credits": { "has_credits": false, "unlimited": false, "balance": null },
  "rate_limit_reached_type": {
    "type": "workspace_member_credits_depleted",
    "details": null
  }
}
```

5시간 창의 reset은 **2026-10-16 23:14:22 KST**, 주간 창의 reset은 **2026-10-23 11:34:26 KST**로 변환된다. 그러나 실제 실패 세션의 마지막 rate-limit 이벤트는 다음과 같이 **`premium` bucket**이었다. [L2]

```json
{
  "limit_id": "premium",
  "primary": null,
  "secondary": null,
  "credits": { "has_credits": false, "unlimited": false, "balance": null },
  "rate_limit_reached_type": "workspace_member_credits_depleted"
}
```

따라서 **23:14:22는 한 quota 창의 리셋 시각이며, 이번 오류의 복구 시각은 확인되지 않았다.** 일반 창, 활성 모델 bucket, 워크스페이스 크레딧 차단을 하나로 합쳐 판단하면 안 된다. 이것은 앞선 대화의 “약 23:16 자동 재개 예약 가능” 제안을 수정하는 결론이다. [C1][C4][L2]

추가로 app-server rate-limit notification은 sparse이므로 완전한 조회 결과와 합치거나 재조회해야 한다. nullable metadata는 이전 상태를 무조건 지우는 의미가 아니며, `spendControlReached == null`도 해제 확인이 아니다. REST의 `rate_limit_reached_type`은 객체이고 app-server는 문자열 형태로 변환하므로 두 표현도 구분해야 한다. [C4]

### 버전 차이

| 공식 소스 표본 | 확인된 차이 |
| --- | --- |
| 0.50.0 | 상대 시간 `Try again in …` |
| 0.100.0 | 절대 로컬 시간 `Try again at …` |
| 0.130.0 / 0.140.0 | 전자 formatter에는 workspace 전용 분기가 없고 후자에는 존재; 정확한 최초 도입 버전은 미확정 |
| 0.150.0 / 0.162.1 | ASCII/곡선 따옴표, usage URL, 모델별 안내 등의 차이 |

표본 소스는 [C5]에 연결한다. 클라이언트 버전 외에도 서버 분류·계정 권한·모델별 meter가 메시지를 바꿀 수 있다.

### 실제 인증 판별

upstream `account/read`는 `apiKey`, `chatgpt`, `amazonBedrock` 등을 구분하고 계정 변경 notification도 제공한다. 그러나 **managed account 상태와 특정 요청의 실제 provider 인증은 다를 수 있다.** provider의 `env_key`, bearer token, 인증 명령, 외부 provider 설정 등이 우선할 수 있다. 실행 중인 app-server의 계정 상태와 resolved provider/config를 함께 확인해야 한다. [C3]

`CODEX_HOME/auth.json`의 `auth_mode`는 보조 근거다. 토큰 존재나 이메일만으로 확정하지 않는다. `OPENAI_API_KEY`가 존재하면 언제나 OAuth를 덮는다는 단순 규칙도 버전·진입점별 동작을 반영하지 못한다. [C3]

## 2. Claude Code

### 메시지와 구조

아래 템플릿은 로컬 first-party 바이너리 **2.1.294·2.1.296·2.1.299**에서 확인했다. 상세 분기 분석은 2.1.299 기준이며 실제 소진 요청을 재현한 것은 아니다. [A2][L3]

| 원인 | 식별 가능한 표현 | 주의점 |
| --- | --- | --- |
| Anthropic API 선불 잔액 부족 | SDK `billing_error`, 정규화 문구 `Credit balance is too low` | 터미널은 Add funds 안내를 붙여 다르게 렌더링함 |
| 구독 5시간/session | `session limit`과 reset 안내; `rate_limit` | 시각은 로케일에 따라 변함 |
| 구독 주간 | `weekly limit`; `rateLimitType: seven_day` | 5시간 창과 구분 |
| 모델별 주간 | Opus/Sonnet 제한; `seven_day_opus`, `seven_day_sonnet` | 실제 모델의 quota를 확인 |
| 추가 사용 크레딧·조직/그룹 예산 | `out of usage credits` 계열 등; 일반 `rate_limit`도 가능 | 구독의 기본 창과 별도 |
| API·서버 throttle | HTTP 429 및 `rate_limit` 계열 | 정기 구독 한도라는 증거가 아님 |

신버전의 `api_error: usage_limit_reached`와 `api_error_params.rate_limit_info`는 추가 구분 근거지만, 이 subtype도 session/weekly/model 한도와 사용 크레딧 spend cap을 포함한다. `rateLimitType`, overage 상태·이유·scope·reset 등을 함께 해석해야 한다. [L3]

현재 공식 Anthropic API 오류 문서에는 일부 spend cap도 429/rate-limit 계열이 될 수 있다고 명시된다. HTTP 상태나 broad SDK error 하나만으로 재개를 결정하지 않는다. [A3]

### 버전 차이

공식 changelog에서 확인한 변경점이다. “그 이전 버전에는 이 기능이 전혀 없었다”는 의미로 확대하지 않는다. [A4]

| 버전 | 관련 변경 |
| --- | --- |
| 2.1.101 | 한도·reset 표시 개선 |
| 2.1.105 | API 키·Bedrock·Vertex 429 출력이 raw JSON에서 간결한 안내로 변경 |
| 2.1.108 | 서버 throttle과 구독 quota 안내 구분 개선 |
| 2.1.199 | 구독 사용자 transient 429 재시도 동작 변경 |
| 2.1.295 | headless rate-limit warning에 extra usage 문맥 추가 |

구조 필드도 SDK wrapper에 따라 빠질 수 있다. 확인한 공식 Python SDK는 `AssistantMessage.error`의 broad 분류를 제공하지만 일부 최신 CLI 추가 필드는 명시적으로 모델링하지 않는다. CLI terminal 출력, stream JSON, SDK 객체, Paseo timeline을 동일한 오류 형태로 가정하지 않는다. [A5]

### 실제 인증 판별

실제 SDK 연결의 initialize account 정보에는 버전에 따라 `apiProvider`, `tokenSource`, `apiKeySource`, `subscriptionType` 등이 있다. 이 정보를 provider 어댑터가 보존하는 것이 우선이다. `system/init.apiKeySource == none`만으로는 구독이라고 할 수 없다. bearer/gateway/cloud도 API key 없이 동작할 수 있다. [L3]

저장된 OAuth가 있어도 실제 요청에서는 API key, helper, bearer, gateway, Bedrock/Vertex/Foundry 등의 설정이 우선할 수 있다. 특히 headless API 키 사용은 interactive 승인과 다르다. 공식 인증 우선순위를 따라야 한다. [A1]

같은 실행 파일·cwd·설정·환경으로 실행하는 `claude auth status --json`은 보조 조회 방법이다. 다만 새 프로세스가 helper 실행이나 로그인 갱신을 하거나 변경된 설정을 볼 수 있으므로, 과거 실패한 세션의 인증을 완벽하게 증명하지는 않는다. 이번 조사에서는 실행하지 않았다. [A1][L3]

## 3. Antigravity CLI (`agy`)

Paseo가 사용하는 것은 Google 공식 Antigravity CLI이며 이번 설치는 1.3.6이다. 공식 저장소는 문서·릴리스 노트 중심으로, 전체 구현 소스를 확인할 수 없었다. [G1][G2]

### 인증과 과금 경로

| 경로 | 판별에 필요한 근거 |
| --- | --- |
| 개인 Google OAuth | 실제 선택된 계정·plan·baseline quota |
| Gemini Enterprise/Google Cloud | 로그인뿐 아니라 프로젝트·라이선스·PAYG 여부 |
| 직접 Gemini API 키 | `modelProvider: gemini`와 `GEMINI_API_KEY`가 함께 적용됨 |
| ADC | `AGY_ADC_AUTH`, 설정의 ADC 사용 및 프로젝트 경로 |
| Gemini 호환 custom endpoint | 실제 endpoint와 provider 설정 |

`GEMINI_API_KEY` 하나만으로 API 모드가 되는 것은 아니며, OAuth 존재만으로 개인 구독이라고 할 수도 없다. Paseo launch environment·agent environment·설정·wrapper까지 확인해야 한다. [G1]

### 구독 baseline과 추가 AI 크레딧의 구분

공식 plans 문서는 Pro/Ultra의 5시간 baseline과 주간 ceiling, 별도 AI credit overage를 구분한다. 기본 quota로 돌아가는 동작이 있으므로 OAuth에서 추가 AI 크레딧 부족이 발생해도 **해당 baseline 리셋으로 회복할 가능성**이 있다. 그 경우에도 동일 모델의 baseline이 실제 소진됐고 reset이 확인돼야 한다. 자동으로 overage를 켜거나 크레딧 소비를 허용하는 제안이 아니다. [G3]

반면 직접 Gemini API의 Prepay 잔액 소진은 공식 billing 문서상 **HTTP 402**이며 충전 전까지 중단된다. API 오류와 구독 baseline은 별개다. 모든 generate-content/Interactions/gateway 경로가 같은 snake_case 오류 envelope를 쓴다고 가정하지 않는다. [G4]

### 버전별 차이와 메시지 근거

| 버전 | 공식 릴리스 노트에서 확인된 차이 |
| --- | --- |
| 1.0.3 | AI credit overage 및 credit panel 도입 |
| 1.1.11 | print-mode `/usage`, `/quota`, `/credits`가 모델 호출 없는 조회로 처리됨 |
| 1.1.13 | 직접 Gemini API 키 경로 도입; banner/help에 credential 표시 |
| 1.1.15 | print-mode `/help`, `/config` 읽기 전용 지원 |
| 1.2.1 | transient 오류의 내부 재시도 추가 |
| 1.2.10 | headless partial failure의 exit 3/`AGY_ERROR` 처리 |
| 1.2.12–13 | API daily quota·spend cap·선불 소진 등에 대한 부적절한 재시도 수정 |
| 1.2.15 | baseline 및 AI reserve 부족을 명확한 AI credit 부족 문구로 표시 |

1.2.15 이후 표시 예시는 `Your AI credits balance is too low to continue.`이다. 이전에는 재시도 후 일반적인 실행 종료 메시지가 나올 수 있었다. [G2]

구독 quota의 `Individual quota reached`와 `Resets in …` 조합은 로컬 플러그인 기존 사례 및 공식 tracker의 버전별 신고에서 관찰된다. 1.0.3·1.1.12·1.2.2 신고에는 수시간부터 약 일주일까지의 countdown이 있으며, 5시간/주간 제한의 기본 문구가 같을 수 있다. upgrade/admin suffix로 인증 방식을 판정하면 안 된다. **tracker 내용은 사용자가 제출한 관찰이며 보장된 계약이 아니다.** [G5]

agy 1.3.6에서 실제 API 선불 잔액 소진이 최종적으로 어떤 한 문장으로 출력되는지는 실측하지 않았다. 공식 문서는 HTTP/충전 의미를, 릴리스 노트는 처리 변경을 입증하지만, 여기서 임의의 최종 오류 문장을 만들어 fixture로 쓰면 안 된다.

1.3.6에서 별도 `agy -p '/usage' --output-format json`은 문서상 모델 호출 없는 quota 조회이고 `/help`는 credential 분류의 보조 수단이다. 이번 조사에서는 이 조회를 실행하지 않았다. **구버전은 slash 문자열이 모델 프롬프트가 될 수 있으므로 반드시 버전 검사가 선행되어야 한다.** Paseo의 stream 프로세스는 `--disable-slash-commands`를 사용하므로 그 세션에 사용자 프롬프트로 보내는 방식과도 구분한다. [G2][G6]

## 4. 현재 Paseo와 플러그인의 정보 손실

설치된 Paseo 0.11.2와 이 플러그인을 읽어 확인했다. [P1][P2][P3][L1]

- 공통 `AgentRuntimeInfo`에는 provider/session/model 등의 정보와 범용 extra가 있지만, Auto Resume가 바로 의존할 수 있는 표준화된 실제 인증 종류 필드는 없다.
- Codex 어댑터의 turn 실패는 주로 `errorMessage` 문자열을 전달한다. raw quota 원인·active bucket·인증 메타데이터 전체가 lifecycle 오류로 보존되지는 않는다.
- Codex usage source는 OAuth store에서 REST usage를 읽어 quota window를 정규화하지만, 응답 스키마가 `rate_limit_reached_type`과 spend-control readiness 등의 정보를 보존하지 않는다. `providers.listUsage()`의 window만으로 원래 차단 이유를 재구성할 수 없다.
- Claude 어댑터는 진단에서 같은 provider environment로 `claude auth status`를 실행하는 수단이 있다. 그러나 이는 진단 문자열이지 Auto Resume의 정형화된 세션 인증 필드가 아니다. 확인한 stream mapping은 assistant content를 timeline으로 옮기며 최신 quota/auth 필드 전체를 전달하지 않는다.
- agy 어댑터는 init의 model을 보존하지만 실제 인증 필드는 보존하지 않는다. result ERROR도 대부분 문자열 failure로 전달한다. 현재 플러그인은 Antigravity usage source가 없어서 `usage.ts`에서 조회를 건너뛴다.
- 플러그인의 `usage.ts`는 현재 계정 이메일로 legacy 사용량 항목을 찾는다. 같은 이메일의 다른 워크스페이스·동일 계정의 다른 meter를 구분하는 데 충분하지 않다.
- `resumer.ts`는 사용량을 읽지 못한 경우와 소진 창이 없는 경우를 `null`로 합치며, 예약 시각에 조회가 실패해도 continue를 보낼 수 있다. 새 credit-blocked 경로에 이 동작을 그대로 적용하면 안 된다.

Paseo 0.11에는 session-scope usage discovery와 stable account key가 있다. 공식 계약은 실제 launch environment의 계정으로 scope를 제한하고, 인증 정보를 report에 넣지 않으며 credential store를 쓰거나 refresh token을 redeem하지 말라고 명시한다. 이를 활용할 여지는 있지만 session quota 존재 자체가 실제 요청의 과금 경로를 보장하는 것은 아니다. [P4]

### 기존 분류기를 대상으로 한 확인

코드를 바꾸지 않고 `node --import tsx --input-type=module`로 `detectLimitStop`을 호출했다. [L1]

| 입력 | 결과 |
| --- | --- |
| 이번 실제 workspace notice | `null` — 현재는 예약 대상이 아님 |
| `Credit balance is too low` | `null` — 현재 제외됨 |
| 합성 입력 `RESOURCE_EXHAUSTED: prepaid credits depleted` | `{ resetAt: null }` — 일반 패턴이 우선 적용됨 |

마지막 입력은 **실제 제품 오류를 인용한 것이 아닌 분류기 성질 확인용 합성 사례**다. API 인증을 보지 않는 현재 구현에서 일반 quota 문구만으로 과금 소진을 배제할 수 없다는 것을 보여 준다. 이 결과를 특정 CLI의 실제 최종 오류 형태로 인용하면 안 된다.

## 5. 권장 판정 정책

아래는 조사 결과에 따른 설계 제안이며 아직 구현하지 않았다.

1. **실제 인증 경로를 세 가지로 구분한다:** 검증된 first-party 구독, 검증된 API/외부 과금 경로, 불명확. 저장 로그인만으로 첫 번째로 올리지 않는다. 이 프로젝트의 API 제외 정책을 적용하면 뒤 두 경로는 자동 continue 대상에서 제외한다.
2. **제한 종류를 별도로 구분한다:** 구독 rolling/model quota, API budget depletion, workspace credits, spend cap, transient request throttle, context/auth 오류, unknown. “구독 인증이면 모든 limit을 재개”로 묶지 않는다.
3. **증거를 한 대상에 연결한다:** provider/CLI 버전, 계정·워크스페이스, 실제 인증, 모델·meter, 원래 failure timestamp. 다른 account나 활성 실패와 무관한 quota 창을 사용하지 않는다.
4. **일반 구독 quota는 갱신 근거로 예약한다:** 해당 quota가 소진됐고 미래 reset이 있으면 reset+grace에 예약한다. 여러 독립 quota가 요청을 막고 있다는 근거가 있으면 모두 해제되는 시점을 고려한다. 현재 호출에 적용되지 않는 전체 계정의 모델 quota까지 무조건 합치지 않는다.
5. **workspace credit 오류는 상태 관찰과 continue 전송을 분리한다:** 관찰할 경우 read-only full usage를 갱신한다. 5시간 창 하나가 바뀌었다는 이유로 보내지 않고, 원래 workspace/meter의 차단 해제가 확인되어 rolling-quota 분류 또는 ready로 전환될 때만 재개한다. 해제 정보가 없으면 대기한다.
6. **null·조회 실패·오래된 캐시는 해제 증거가 아니다:** fresh full snapshot과 sparse 이벤트를 구분한다. 사용량 조회에 실패한 상태에서는 신규 credit-blocked 경로가 continue로 진행하지 않는다.
7. **버전별 문구는 보조 adapter fixture로 관리한다:** 출처, CLI 버전, auth kind, 원시 envelope, Paseo에 도달한 형태, 기대 판정을 함께 남긴다. “최신 메시지 한 줄”에 의존하지 않는다.

우선 추가할 검증 사례는 API key+일반 429, API 잔액 소진, OAuth 파일이 남은 API provider, 동일 이메일의 다른 workspace, subscription session/weekly/model quota, workspace credit+무관한 5h reset, spend cap, sparse/null quota 이벤트, 조회 실패, Claude extra-usage budget, agy API 402와 OAuth baseline+reserve 부족이다. 실측·공식 소스 fixture와 합성 테스트를 명시적으로 구분한다.

## 출처

### Codex

- [C1] [0.162.1 오류 formatter와 공통 오류 매핑](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/error.rs#L701)
- [C2] [0.162.1 HTTP 오류 bridge](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/codex-api/src/api_bridge.rs#L187), [SSE 오류 정규화](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/codex-api/src/sse/responses_error.rs#L47)
- [C3] [account 타입](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L18), [provider 인증 우선순위](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/model-provider/src/auth.rs#L197), [저장 인증 로딩](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/login/src/auth/manager.rs#L1488)
- [C4] [sparse rate-limit/schema 주석](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L649), [REST usage 변환](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/backend-client/src/client.rs#L613), [REST reached-type 모델](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs#L69)
- [C5] [0.50.0](https://github.com/openai/codex/blob/rust-v0.50.0/codex-rs/core/src/error.rs#L253), [0.100.0](https://github.com/openai/codex/blob/rust-v0.100.0/codex-rs/core/src/error.rs#L411), [0.130.0](https://github.com/openai/codex/blob/rust-v0.130.0/codex-rs/protocol/src/error.rs#L450), [0.140.0](https://github.com/openai/codex/blob/rust-v0.140.0/codex-rs/protocol/src/error.rs#L475), [0.150.0](https://github.com/openai/codex/blob/rust-v0.150.0/codex-rs/protocol/src/error.rs#L653)
- 공식 OpenAI 문서: [App Server](https://learn.chatgpt.com/docs/app-server), [사용량·가격](https://learn.chatgpt.com/docs/pricing). 문서는 조회일 기준이며 과거 버전의 메시지 증거는 태그 소스를 우선한다.

### Claude Code

- [A1] [공식 인증 우선순위](https://code.claude.com/docs/en/authentication#authentication-precedence)
- [A2] [공식 API credit 안내](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
- [A3] [공식 API 오류](https://platform.claude.com/docs/en/api/errors)
- [A4] [공식 Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) — 조회 당시 문서의 버전 heading을 기준으로 읽음; mutable main임
- [A5] [공식 Python SDK message 타입](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py)
- [A6] [상태 표시줄의 quota/reset 필드](https://code.claude.com/docs/en/statusline#available-data)

### Antigravity

- [G1] [공식 CLI 설치·인증](https://antigravity.google/docs/install?tab=cli), [공식 저장소](https://github.com/google-antigravity/antigravity-cli)
- [G2] [공식 agy changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md) — 조회일의 버전 heading 기준; 전체 구현의 공개 소스는 확인하지 못함
- [G3] [공식 baseline·overage 정책](https://antigravity.google/docs/plans#baseline-quota)
- [G4] [Gemini API Prepay](https://ai.google.dev/gemini-api/docs/billing#prepay), [오류·재시도](https://ai.google.dev/gemini-api/docs/troubleshooting#retry-strategy)
- [G5] 공식 저장소의 사용자 신고: [1.0.3 사례 #234](https://github.com/google-antigravity/antigravity-cli/issues/234), [1.1.12 사례 #789](https://github.com/google-antigravity/antigravity-cli/issues/789), [1.2.2 사례 #1018](https://github.com/google-antigravity/antigravity-cli/issues/1018). 사용자 관찰로만 취급함
- [G6] [공식 CLI usage 명령](https://antigravity.google/docs/cli/commands/usage/)

### Paseo 및 로컬 근거

- [P1] [Paseo v0.11.2 공통 agent 타입](https://github.com/getpaseo/paseo/blob/v0.11.2/packages/protocol/src/agent-types.ts), [Codex 어댑터](https://github.com/getpaseo/paseo/blob/v0.11.2/packages/server/src/server/agent/providers/codex-app-server-agent.ts)
- [P2] [Paseo v0.11.2 Codex usage source](https://github.com/getpaseo/paseo/blob/v0.11.2/plugins/codex-usage-source/server/usage.ts), [Claude 어댑터](https://github.com/getpaseo/paseo/blob/v0.11.2/packages/server/src/server/agent/providers/claude/agent.ts)
- [P3] 설치된 `@getpaseo/server` 0.11.2의 `dist/server/builtin-plugins/antigravity-provider/server/internal/{wire,session,process,catalog}.ts` 정적 확인; 공식 [supported providers](https://paseo.sh/docs/supported-providers)
- [P4] [Paseo 공식 usage-source 계약](https://paseo.sh/docs/plugins/reference#usage-sources), [custom provider 설정](https://paseo.sh/docs/custom-providers)
- [L1] 이 저장소의 `server/limit.ts`, `server/usage.ts`, `server/resumer.ts`, `server/providers.ts`, `package.json` 및 분류기 직접 실행 결과. 조사 중 기존 사용자 수정 `index.server.ts`는 건드리지 않음.
- [L2] 현재 대화에서 사용자의 허가로 조회한 해당 Business 로그인 `/wham/usage` 응답과 오류 에이전트의 로컬 rollout. 비공개 원본은 저장소에 복사하지 않고 위에 비식별 quota 항목만 기록함.
- [L3] `/home/babo/.local/share/claude/versions/`의 first-party 바이너리 정적 확인. 2.1.299 SHA-256: `2d894a4b1bfaaa9aab72aeff7803e3c73bc2510f279a171f6b8f59f72d17d077`; 2.1.294: `27122ca7b624f537546fbef35b80c66370d974ff258f3d9b10ac50bb8771f262`; 2.1.296: `24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de`.

남은 불확실성: workspace credit 차단이 이번 계정에서 언제 해제되는지, 모든 CLI 중간 버전의 정확한 도입 경계, agy 1.3.6 실제 API 잔액 소진 최종 문구, 기존 Paseo 세션별 실제 인증 메타데이터의 완전한 재구성은 확인하지 못했다. 이 항목들은 “해제됨” 또는 “구독임”으로 추정하지 않는다.
