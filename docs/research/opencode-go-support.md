# OpenCode Go·공식 무료 모델 사용 한도 자동 재개 지원 조사

조사일: **2026-11-05**. 구현 없이 공식 문서·공식 저장소와 이 프로젝트 소스를 조사했다. 추가 조사에서는 설치된 OpenCode **2.2.5**·Paseo **0.15.0**을 기준으로 재검토하고, 인증 저장소의 존재·구조만 확인했으며 사용자가 제공한 과거 무료 모델 실행 기록을 반영했다. 유료·무료 모델 호출, 계정 로그인, 인증 비밀 값 열람·출력, 사용량 API 실호출, 토큰 갱신은 실행하지 않았다. 9–13절은 설치 환경과 무료 모델에 대한 추가 조사이며, 14절은 **2026-11-06** 최소 지원 버전 조사다. 초기 절의 dev 소스 주장과 설치·release tag 근거를 구분한다.

증거 표시는 **[확인]** 공개 문서 또는 고정 소스로 확인한 사실, **[확인·로컬 기록]** 사용자가 제공한 과거 실행 기록, **[확인·로컬 관찰/계산]** 이번에 직접 확인한 구조·계산, **[추론·제안]** 그 사실에서 도출한 설계, **[미확인]** 실제 환경 또는 추가 소스 확인이 필요한 항목이다. 공식 저장소에 올라온 사용자 이슈는 제품 계약의 증거로 사용하지 않았다.

## 1. 판단과 권장 범위

**[추론·제안] OpenCode CLI의 Go 구독과 OpenCode 공식 무료 chat 모델을 Paseo 경로로 지원하는 것이 이 프로젝트와 가장 잘 맞는다.** 대화·예약·사용자 취소·재시작 복구·계속하기 전송은 기존 Paseo 흐름을 유지하고, OpenCode 버전별 종료 오류와 실제 과금 경로·사용량 확인을 추가한다. 무료 사용량을 조회할 수 없을 때에는 Antigravity처럼 오류 안내와 제한된 재시도를 따르는 정책을 선택할 수 있으며, 이를 “회복을 조회로 확인함”과 구분한다. 구체적인 조건은 9절과 13절에 정리한다. OpenCode 자체 플러그인 또는 독립 스케줄러는 별도 제품 범위다. 근거는 이 프로젝트의 [현재 동작](../behavior.md), [provider 판별](../../server/providers.ts), [구독 확인](../../server/subscription.ts), [Antigravity fallback](../../server/agy-usage.ts)과 Paseo의 [OpenCode 어댑터][P1]다.

| 항목 | 확인한 근거 | 구현 전 해소할 사항 |
| --- | --- | --- |
| 같은 대화에서 재개 | Paseo OpenCode 어댑터는 V1/V2 세션을 재사용한다. [P1][P2] | 지원 Paseo·OpenCode 버전을 고정하고 재시작 후 재개를 검증 |
| Go 한도 감지 | V2는 전용 `provider.go-limit`, 응답 body, `retryAfterMs`를 가진다. [O2][O3] | Paseo v0.15.0 V2 종료 이벤트는 `error.message`만 전달한다. 구조 보존 또는 보조 조회 필요. [P3] |
| 공식 무료 한도 감지·재개 | 실제 2.2.5 로컬 기록에 `provider.free-limit`, 429와 재시도 지연이 있다. 9절 참조 | 무료 readiness API 미발견. 힌트 보존 또는 메시지 기반 bounded retry 정책 필요 |
| 사용량 조회 | OpenCode V2 실험 API와 Paseo Go usage source가 이미 존재한다. [O5][O6][P4] | 실행 세션과 같은 계정·워크스페이스·모델 범위인지 확인 |
| 구독과 API 과금 구분 | Go 자체가 API 키 구독이며 초과 사용은 잔액 과금으로 전환될 수 있다. [D1][D3] | API 키 존재만으로 제외하면 Go도 제외됨. 실제 route와 Extra Usage 분리 |
| 예약·전송 안전성 | 기존 예약은 계정·모델 변경, 새 사용자 메시지, 권한 대기 등을 검사한다. [L1] | OpenCode 계정 식별과 native retry 중복 전송 방지 연결 |

## 2. 이름과 과금 경로를 분리해야 한다

| 이름 | 의미와 이 조사에서의 취급 |
| --- | --- |
| OpenCode | 오픈 소스 코딩 에이전트. V1과 V2 모두 `opencode` 명령을 쓰므로 명령 이름만으로 API 세대를 알 수 없다. V2 설치 패키지는 `@opencode/cli`; V1 SDK는 `@opencode-ai/sdk`, V2 network client는 `@opencode/client`다. [D5][D6][D14][D15] |
| OpenCode Go | 선택형 구독 공급자. 현재 공식 안내는 Go $10/월, Go Plus $40/월, Go Teams $20/인/월이며 연결 시 API 키를 사용할 수 있다. 모델 ID는 `opencode-go/<model-id>`. [D1] |
| Zen / Console 모델 | 현재 `/docs/zen/`는 Console Models로 이동한다. Console의 일반 모델 경로는 요청별 잔액 과금이며 Go 포함 사용량과 구별한다. 코드와 구 API에는 `zen` 이름이 남아 있다. 제품명만으로 구독을 판정하지 않는다. [D2][O5] |
| Console BYOK | Console을 통해 자신의 provider 계정을 연결하는 별도 경로다. 응답의 `opencode.billing_source`는 `byok`를 구별한다. Go 구독으로 간주하지 않는다. [D3][D7] |
| ChatGPT·Claude 등 다른 구독 | OpenCode라는 클라이언트를 쓴다는 사실은 Go 과금을 뜻하지 않는다. V2조차 ChatGPT 한도를 `provider.chatgpt-limit`로 따로 분류한다. 다른 구독의 확인 방법을 Go 확인 방법으로 대체하면 안 된다. [O2] |

**[확인] 응답 사용량에 `opencode.billing_source`가 있고 값은 `free`, `balance`, `go`, `go-plus`, `byok` 등 문서에 명시된 경로를 구별한다. `opencode.allowance`는 해당 요청이 Go 한도에 반영된 양이고 잔여량·reset이 아니다.** 따라서 과거 성공 응답은 실제 route의 보조 증거가 되지만, 다음 요청의 현재 entitlement나 회복을 보장하지 않는다. 마지막 문장은 추론이다. [D3]

**[추론·제안] “API 키·외부 과금 제외”를 인증 저장 형식에 관한 규칙으로 적용하지 말고, 검증된 Go 포함 사용량 경로와 일반 API 잔액 경로를 나눠야 한다.** 기존 Codex·Claude의 API 제외 규칙을 완화할 필요는 없다. Go를 Codex/Claude CLI에 연결하는 사용법도 공식 제공되지만, 이 경우 기존 reader는 외부 base URL 등을 보고 제외하는 것이 현재 정책과 맞다. 이를 함께 지원하려면 CLI와 과금 공급자를 분리하는 별도 설계가 필요하다. [D8][L2]

## 3. Go 사용 한도·reset·오류

### 현재 문서와 조회 응답

**[확인] 공식 문서는 모델별 월 허용 금액을 기준으로 5시간 20%, 주간 50%, 월간 100% 창을 설명한다.** 모델별 월 허용량과 토큰 단가는 바뀔 수 있다. 요청 수 표는 토큰 가정을 둔 추정치이므로 스케줄 계산에 쓰지 않는다. Extra Usage가 켜져 있으면 한도 도달 후 Console 잔액으로 넘어가며 Go Teams는 기본으로 켜져 있다. [D1]

**[확인] 현재 OpenCode V2는 `GET /api/experimental/usage/limits`를 제공한다.** location의 활성 Console 연결에 대해 워크스페이스 정보, 선택적 `go`, `budgets`를 반환한다. `go`에는 `rolling`, `weekly`, `monthly`가 있고 각각 `percent`, **`limited`**, `resetsAt`(Unix epoch **밀리초**)가 있다. 실험 API임을 명시한다. [O5][O6][O7]

V2 내부 Go 조회는 다음과 같다. 이는 인증 정보를 담은 실행 예제가 아니라 공개 소스 계약 요약이다. [O5]

```text
GET <Console origin>/zen/go/v1/usage
Authorization: Bearer <active Key 또는 OAuth access>
x-opencode-org-id: <active workspace ID>

{ usage: {
  rolling: { status: "ok" | "rate-limited", percent, resetsAt: ISO 문자열 },
  weekly:  { status: "ok" | "rate-limited", percent, resetsAt: ISO 문자열 },
  monthly: { status: "ok" | "rate-limited", percent, resetsAt: ISO 문자열 }
} }
```

**[확인] V2는 `status === "rate-limited"`를 `limited`로 옮긴다.** 403은 해당 연결의 `go` 없음으로 처리하고, 다른 실패·파싱 오류는 조회 불가 오류가 된다. 활성 Console 연결·credential 또는 `orgID`가 없으면 결과가 없을 수 있다. 이는 quota 0%나 준비 완료와 다르다. [O5][O7]

**[미확인] 모델 범위의 대응 관계가 남는다.** 현재 Go 문서는 모델별 한도를 설명하지만 위 응답과 정규화 스키마는 모델 ID나 모델별 목록을 노출하지 않는다. 한 모델의 오류에 이 세 창을 그대로 적용할 수 있는지, 모든 모델이 같은 normalized allowance를 공유하는지, Go Plus/Teams가 같은 방식인지 실측 또는 서비스 계약 확인이 필요하다. 모델 쿼리 파라미터를 임의로 발명하지 않는다. [D1][O5][O7]

### reset 계산의 한계

**[확인·과거 소스] 2026-09-07 서버 공개 소스는 rolling 창의 `timeUpdated + window`, 주간 경계, 구독일 기준 월간 경계를 사용하고 응답에 `resetsAt`을 계산했다.** 당시 limit 수치는 배포 resource에서 읽었다. 이 소스를 11월 현재 서비스의 모든 플랜·모델에 대한 고정 계약으로 일반화할 수 없다. 현재 문서에 정확한 UTC reset 요일·시각이나 모든 창의 경계 알고리즘이 명시되어 있지는 않다. [H2][H3]

**[추론·제안] reset은 서버 응답·원시 오류의 시각을 우선하고, “항상 5시간 뒤”, “매주 월요일”, “매월 1일”을 하드코딩하지 않는다.** 여러 적용 가능한 창이 차단되면 가장 늦은 미래 reset+기존 buffer에 예약하고, 지난 reset만으로 준비 완료를 선언하지 말고 다시 조회한다. `resetsAt`의 ISO 문자열·epoch milliseconds와 `Retry-After`의 초 단위를 혼동하지 않아야 한다. [O5][O7][L1]

### 차단 종류

| 입력 근거 | 분류·처리 제안 |
| --- | --- |
| V2 `provider.go-limit`, 또는 검증된 Go route의 `GoUsageLimitError` | Go 포함 사용량 한도 후보. workspace/model과 현재 usage를 확인한다. [O2][O3] |
| HTTP 429만 존재 / `provider.rate-limit` | 일반 요청 throttle일 수 있다. Go 구독 소진으로 확정하지 않는다. [O4] |
| `FreeUsageLimitError` / `provider.free-limit` | 무료 사용 제한. Go 유료 구독과 별도다. [O2][O4] |
| `BudgetLimitError`, model/workspace budget | Console 예산 정책. Go allowance reset과 동일시하지 않는다. [O2][O7] |
| HTTP 402, `CreditLimitExceeded`, `provider.quota` | 일반 잔액·과금 quota 가능성이 있다. Go 확인 없이 자동 continue하지 않는다. [O4] |
| 401/403, 네트워크·schema 오류, `go` 없음 | 회복 확인 실패 또는 entitlement 없음. 자동 전송하지 않는다. [O5] |

**[확인] 최근 V2는 Go 오류 body의 `metadata.limitName`을 표시 문구에 반영하고 `provider.go-limit`, HTTP status, 원본 response body, `retryAfterMs`를 유지한다.** 2026-10-29 병합 PR은 Go 429의 `metadata.{workspace,limitName}`와 `retry-after`, 기본 정책에서 재시도 없이 실패하는 회귀 검증을 명시한다. 추가 조사에서 설치 버전 2.2.5에도 포함됨을 확인했다(10.1절). [O2][O3][D9][I5]

## 4. OpenCode의 자체 재시도와 외부 재개의 차이

| 소스 표본 | 확인한 동작 | 외부 예약에 대한 의미 |
| --- | --- | --- |
| 과거 V1 `57ef382…` (2026-09-07) | 최대 5회 retry 정책. `retry-after-ms`, `retry-after` 초/HTTP date를 반영하고 지연 상한은 32bit timer 범위다. Go body를 인식해 reset 안내를 만들 수 있다. [H1] | 첫 retry 자체가 수시간 대기할 수 있다. “5회니까 곧 종료”라고 가정하면 안 된다. |
| 현재 V2 `893e8dc…` (2026-11-05) | 일반 모델 실패 retry는 2/4/8초 이후 10초 간격 상한, jitter, 최대 10회; `Retry-After`는 일반 정책에서 최대 15분으로 제한. timeout·연결 불가·일회 생성에는 별도 정책이 있다. [O8] | 해당 정책은 구독 reset 예약과 다르다. 설치 버전의 정책을 검증한다. |
| 현재 V2 Go quota | `GoUsageLimitError`는 quota 종류로 분류되어 기본 transient retry와 구별된다. [O2][O4] | terminal Go 실패 뒤의 외부 예약에 의미가 있다. |
| V2 retry hook | 플러그인이 retry 여부·delay를 수정할 수 있다. 전체 최대 횟수는 유지되며 `session.retry.scheduled`에 다음 시각·attempt·error가 나온다. [O9][O10] | 다른 플러그인이 Go를 다시 retry하게 만들 수 있으므로 실행 중 상태도 검사한다. |

**[추론·제안] native retry 중에는 외부 continue를 보내지 않고 최종 execution 실패를 기준으로 예약한다.** 단일 실행 안의 retry hook만으로 장시간 예약을 구현하면 OpenCode 종료·호스트 재시작에 대한 영속성, 사용자 취소, 중복 방지까지 별도로 해결해야 한다. retry 이벤트는 예약 후보의 참고 자료이며 terminal turn-end와 같지 않다. [O9][O10][P1][L1]

## 5. 로컬 설정·세션·이벤트·플러그인·자동화

### V1과 V2를 별도 adapter로 취급

**[확인] V1 server는 `opencode serve`, `/doc` OpenAPI, `/session/:id/message`, `/session/:id/prompt_async`, `/session/status`, `/event`를 제공한다.** V1 SDK의 `session.prompt`·event subscription과 로컬 plugin event hook을 사용할 수 있다. 로컬 플러그인 경로는 `.opencode/plugins/`, `~/.config/opencode/plugins/`다. V1의 API 이름을 V2에 그대로 사용하지 않는다. [D4][D5][D13]

**[확인] V2 network client는 `@opencode/client`; `@opencode/sdk`는 HTTP listener 없이 서버를 앱 안에 호스팅하는 별도 선택이다.** 기존 서비스 연결에는 network client가 더 직접적이며, `Service.discover/ensure`를 통해 로컬 서비스 조회·기동이 가능하다. 후자는 호출자 환경과 실제 서버 환경을 구분해야 하는 이유이기도 하다. 마지막 판단은 추론이다. [D6][D11]

**[확인] V2의 동일 세션 재개는 기존 `sessionID`로 `POST /api/session/:sessionID/prompt`에 continue 텍스트를 넣는 경로다.** input은 영속 inbox에 수용되고 `resume: false`가 아니면 실행이 예약된다. 성공 응답은 admission 성공이며 모델 작업 완료가 아니다. 입력 ID를 제공할 수 있지만 재시도 중복에 관한 전체 멱등성 보장은 이 조사에서 확인하지 않았다. 대기·메시지·archive·permission API로 상태를 함께 확인할 수 있다. [O11][D10]

**[확인] V2 이벤트에는 `session.execution.started/succeeded/failed/interrupted`, `session.step.failed`, `session.retry.scheduled`, inbox·model 변경 등이 있다.** step 실패와 execution 실패를 동시에 예약하면 중복될 수 있으므로 execution을 최종 기준으로 삼는 것이 제안이다. 이벤트는 session ID와 location을 함께 다룬다. [O10]

**[확인] V2 client 구독은 live-only이며 replay·자동 reconnect가 없다.** 끊겼다가 돌아오면 다시 subscribe하고 세션·예약을 재조회해야 한다. 이벤트만 믿는 startup scan은 누락 위험이 있다. 마지막 문장은 추론이다. [D6]

**[확인] V2 server plugin은 `Plugin.define({ id, setup })`, 영속 JSON `ctx.storage`, `ctx.session.prompt`, `ctx.event.subscribe`, session retry/HTTP hook을 제공한다.** 플러그인 인스턴스의 location과 이벤트 대상 세션의 location은 같다고 보장되지 않는다. V1/V2를 같은 패키지에서 지원할 수 있어도 hook 계약은 각자 구현해야 한다. [D10]

### 설정과 인증 저장소

**[확인] 현재 V2는 전역 `~/.config/opencode/opencode.json(c)`, 프로젝트의 `opencode.json(c)`·`.opencode/opencode.json(c)`, 시스템 관리 설정을 합친다.** CLI 표시 설정인 `cli.json`은 서버·프로젝트 설정과 별도다. CWD의 파일 하나만 읽어 실제 model/route를 확정하면 안 된다. [O12][O13]

**[확인] Paseo v0.15.0 Go usage source는 `$XDG_DATA_HOME/opencode/auth.json` 또는 `$HOME/.local/share/opencode/auth.json`의 `opencode-go: {type:"api",key}`를 읽는다.** 반면 조사한 현재 V2 credential 서비스는 DB에 저장된 활성 integration credential을 사용하고 Key/OAuth를 모두 취급한다. auth.json 파일만으로 최신 V2의 실제 실행 인증을 보장할 수 없다. [P4][O5][O14]

**[확인] V2 native usage 조회의 `integration.connection.resolve`는 만료가 가까운 OAuth를 refresh할 수 있다.** 모델 호출은 없지만 기존 프로젝트의 “토큰 refresh 없이 확인” 정책과는 차이가 있으므로, native API를 곧바로 부작용 없는 조회로 표기하지 않는다. 자동화에서 어느 정책을 허용할지 정하고 검증해야 한다. [O5][O15][L2]

**[확인] CLI도 비대화형 사용을 지원한다:** `opencode run --session <id> --format json "…"`; V2는 `--standalone` 또는 지원 명령의 `--server`로 서버 선택을 제어한다. `--continue`는 최신 세션 선택이므로 예약된 특정 대화에는 명시적 ID가 적합하다. 연구 중 이 명령은 실행하지 않았다. 재개 목적으로 권한 auto-approve 옵션을 새로 켤 필요는 없다. 마지막 두 판단은 제안이다. [D12]

## 6. 이 저장소와 Paseo에 연결할 때

**[확인] 이 저장소의 `UsageSource`/`USAGE_SOURCES`는 claude·codex·antigravity 세 종류이며 `cliFor`는 provider의 `extends`를 따라간다.** `createSubscriptionReader`는 Antigravity·Codex 다음에 Claude 흐름으로 이어지므로 union에 OpenCode만 추가하면 잘못된 Claude auth 조회가 발생한다. `captureLaunch`는 XDG 경로를 보존하지만 OpenCode 설정·서버 선택 문맥은 별도 검토가 필요하다. [L2][L3]

**[확인] 현재 개발 의존성은 Paseo 0.11.0이고, 이번 Paseo 근거는 v0.15.0이다.** “Paseo 0.11 이상이면 아래 OpenCode 동작이 모두 지원된다”고 확대하지 않는다. v0.15.0에는 OpenCode V1/V2 처리와 Go usage source가 이미 있다. [L4][P1][P2][P4]

Paseo v0.15.0에서 확인한 경계는 다음과 같다.

- V1 `session.error`는 terminal `turn_failed`로 연결되고, `session.status=retry`는 `Provider retry (attempt N): …` timeline 오류로 표시된다. retry를 terminal 한도로 오인하면 안 된다. [P1]
- V2 `session.execution.failed`는 Paseo turn 실패가 되지만 현재 코드가 넘기는 값은 `execution.data.error.message`다. 원래 `provider.go-limit`, `retryAfterMs`, body가 이 경계에서 손실된다. 최근 V2의 표시 문구 자체에는 reset 시각이 없으므로 문자열만으로 정확한 reset 예약이 어려울 수 있다. [P3][O2]
- Go usage source는 global discovery만 하며 계정 key를 인증 **파일 경로**로 hash한다. API 응답의 `status`를 파싱하지만 report의 window는 `percent`로만 만든다. 경로가 같아도 credential이 바뀔 수 있고, 표시용 percent만으로 Go의 차단 상태를 완전히 전달하지 못한다. [P4]
- OpenCode token/context 사용량 projection은 Go entitlement 조회와 다르다. [P5]

| 선택지 | 장점 | 범위·제약 | 권장 |
| --- | --- | --- | --- |
| 이 Paseo 플러그인에 OpenCode reader/분류 추가 | 예약 UI·지속 저장·기존 취소 규칙 재사용 | 원본 오류 보완 또는 메시지 fallback, 버전 floor, 실행 auth 매칭 필요 | 첫 구현 후보 |
| Paseo provider/usage source도 함께 개선 | 전용 Go 오류·원시 status·워크스페이스를 여러 플러그인이 활용 | upstream 변경·사용자 업그레이드 필요 | metadata 손실이 blocker면 우선 협의 |
| OpenCode server plugin | 원시 오류·세션·native hooks와 가까움 | 별도 설치·UI·영속 예약·V1/V2 호환 책임 | Paseo 없는 사용자까지 원할 때 |
| 독립 CLI wrapper/daemon | `run --session`으로 접근 가능 | 서버 선택·세션 lifecycle·사용자 취소·중복 제어를 새로 구현 | 후순위 |

**[추론·제안] 최소 계약은 `billing route`, `workspace/account identity`, `model/meter scope`, `limited`, `resetsAt`, `observedAt`, `source/version`을 함께 전달하는 것이다.** 비밀 값 대신 안정된 비밀 아닌 식별자를 hash하고, 파일 경로만으로 계정 일치라 판정하지 않는다. 한도 확인 실패는 기존 verification wait로 남긴다. Go `limited`를 percent 임계치와 별도로 보존해야 한다. [O5][O7][P4][L1]

**[추론·제안] Extra Usage나 모델 전환은 사용자가 하는 과금·실행 범위 변경이다.** 자동 재개는 이를 켜거나 다른 모델로 바꾸지 않는다. Go 한도 해제 후에도 실행이 PAYG로 갈 수 있는 경로와 workspace budget 차단이 남으면 “Go 회복”만으로 전송 허가를 만들지 않는다. 현재 API가 Extra Usage 상태를 충분히 드러내는지 미확인이다. [D1][D3][O5]

## 7. 구현 전 재현 가능한 검증 계획

다음은 **미실행 계획**이다. 우선 credential·외부 모델 없이 localhost mock provider와 임시 HOME/XDG/프로젝트·명시적 standalone 서버를 사용한다. 실제 계정 검증은 후속 단계이며 이 조사에서 하지 않았다.

1. **버전 고정:** Paseo v0.15.0, 구현 시 지원할 OpenCode V1/V2 실제 release를 고정하고 `--version`·해당 `/doc` 또는 V2 contract·원시 이벤트 표본을 기록한다. 현재 dev에서 확인한 기능의 최초 release는 별도로 찾는다.
2. **native retry 대 terminal:** mock의 동일 Go 429 body에 `Retry-After: 3`, `3600`을 주고 request 수·retry 이벤트·execution 실패 시점을 기록한다. 429 throttle, 402 credit, 무료 한도, budget, auth, context overflow를 대조한다. 긴 retry는 짧게 관찰 후 정상 중단하며 실제 수시간 기다리지 않는다. installed plugin이 retry hook을 바꾸는 경우도 포함한다.
3. **전송 경계 보존:** V1/V2 원시 이벤트 → Paseo timeline/`turn_ended`까지 비교한다. type/body/reset 단위가 어디서 사라지는지 fixture로 고정하고 retry 중 예약·continue가 생기지 않는지 확인한다.
4. **usage reader:** raw Go 세 창을 mock한다. 한 창·여러 창 제한, 과거 reset, 누락/잘못된 reset, `status=rate-limited`와 percent 불일치, 401/403/500/timeout/schema 오류를 넣는다. 불명확한 결과에서는 read-only verification만 예약되고 continue가 전송되지 않아야 한다.
5. **동일 실행 범위:** 계정·workspace·프로필·CWD·선택 모델 변경, 동일 auth 경로의 key 교체, 로컬 credential과 재사용 서버 credential 차이를 검증한다. 계정·모델 변경은 기존 예약 취소 규칙을 지킨다. Go allowance와 Zen/PAYG·BYOK를 구별한다.
6. **세션 경쟁·복구:** native retry 중 due tick, 사용자 메시지/permission/form 대기/archiving, 종료 후 재시작, SSE 끊김·재연결, send claim 직후 crash를 넣는다. 같은 session ID에 한 번만 continue하며 기존 reservation identity 검사를 유지한다.
7. **사용자가 이미 가진 Go 환경의 후속 확인:** 허가된 읽기 전용 상태 조회로 플랜·workspace와 Go 모델 범위를 확인한다. Extra Usage on/off에서 raw usage와 실제 route를 비교하되, 구독을 구매하거나 잔액 소모를 유도하지 않는다. 모델별 문서와 aggregate endpoint의 차이를 해결하기 전 full-ready 판정을 제한한다.
8. **구현 시 필수 검증:** 변경된 분류·quota·reader·resumer 및 영향 caller에 `npm run test:focus -- <files>`, 필요한 `npm run typecheck`, 마지막 코드 변경 뒤 `npm run check`를 실행한다. 이번은 문서만 작성했으므로 npm 테스트를 실행하지 않았다. [L5]

## 8. 출처와 조사 범위

고정 소스: OpenCode dev **`893e8dc43f05e872d4cac603486ce8a7181170fa`**, commit 시간 **2026-11-05 08:57:45 UTC**; 역사 비교 **`57ef3828431790c53f8f333c7ffbfe88770a1812`**, **2026-09-07 06:11:00 UTC**. 현재 설치 release와 동일하다고 주장하지 않는다. Paseo **v0.15.0 / `8938fde3c713143f12eacbdd60c11fdfc0be0fb1`**. 이 저장소 기준 HEAD **`5c749c686327152e7218b086976021c85d7a0074`**. [현재 OpenCode commit](https://github.com/anomalyco/opencode/commit/893e8dc43f05e872d4cac603486ce8a7181170fa), [과거 commit](https://github.com/anomalyco/opencode/commit/57ef3828431790c53f8f333c7ffbfe88770a1812)

문서는 조사일 조회 기준이며 변경될 수 있다. 공식 GitHub API와 고정 source를 정적으로 읽었다. 공개 최신 tree에는 과거 Console 서버 구현 일부가 없어 reset 알고리즘은 역사 소스로만 설명했다. 추가 조사에서는 `--version`과 로컬 판별 함수의 입력·출력만 실행했다. 사용자가 제공한 과거 실제 오류는 9절에서 별도 증거로 구분하며, 직접 실행해 재현한 결과가 아니다. 실서비스 사용량 API 응답, 모델 실행·서버 기동·재시작, npm 테스트는 검증하지 않았다.

## 9. 무료 first-party 모델 후속 조사 (A1–A7)

조사일 2026-11-05. **[추론·제안] 무료 모델은 Go와 구분하여, 원본 한도 오류와 서버의 retry 힌트에 근거한 조건부 자동 재개부터 지원할 수 있다.** 무료 잔여량 read-only API가 미발견인 점은 전면 지원의 차이지만 자동 재개 자체의 blocker는 아니다. 이 프로젝트도 Antigravity는 quota 조회가 없을 때 한도 메시지를 따르는 `agyFallback` 선례가 있다. 무료 자동 재개를 회복 검증 완료로 표시하지 않고, 같은 세션·모델·실행 범위 유지와 native retry 종료·bounded retry/cancel 규칙을 붙이는 것이 제안이다. [F24][F25] 아래의 “없음”은 조사한 공식 문서·공개 소스 범위에서 미발견이라는 뜻이다.

### 9.1. A1 — 현재 무료 모델과 경로

**[확인] 11월 5일 공식 Console 모델 문서는 다음 모델을 무료 가격표에 올린다.** 아래 ID 앞에 `opencode/`를 붙이는 것이 OpenCode의 first-party provider/model 선택 형식이다. 무료 모델 목록은 교체되고 무료 기간도 제한될 수 있으므로 영구 allowlist나 서비스 보장으로 취급하지 않는다. OpenRouter의 `:free` 등 제3자 경로는 이번 대상이 아니다. [F1][F2]

| 공식 표시 이름 | 모델 ID |
| --- | --- |
| Big Pickle | `big-pickle` |
| Crouton Alpha Free | `crouton-alpha-free` |
| Pulse Alpha Free | `pulse-alpha-free` |
| GLM-5.3-Flash Free | `glm-5.3-flash-free` |
| DeepSeek V4.1 Flash Free | `deepseek-v4.1-flash-free` |
| Beam Free | `beam-free` |
| Flint 40B Free | `flint-40b-free` |
| MiMo-V2.6-Flash Free | `mimo-v2.6-flash-free` |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` |
| Nemotron 3.5 Super VL Free | `nemotron-3.5-super-vl-free` |
| Jev 1.13 Free | `jev-1.13-free` |

**[확인] 앞의 11개는 chat 모델이며 Jev는 별도 System One 구조화 의사결정 모델이다.** Jev를 기존 chat 세션의 continue 대상으로 묶지 않는다. 공식 모델 문서는 Jev에 Console API 키 예제를 제시한다. 따라서 “무료 모델이면 모두 동일한 무인증 chat 경로”라는 결론은 맞지 않는다. [F1]

### 9.2. A2 — 로그인·키·식별 범위

**[확인] 설치 버전 v2.2.5와 현재 dev의 OpenCode provider 플러그인은 사용자가 키를 주지 않고 Console 연결도 없으면 first-party `opencode`를 활성화하며 literal `apiKey: "public"`를 넣는다.** 키 없는 경우 가격이 있는 모델을 비활성화한다. 과거 V1도 키 없을 때 input cost 0 모델만 남기고 `public`를 넣었다. 이것은 클라이언트가 로그인 없이 무료 모델을 제시하는 근거이며 실제 서비스가 어떤 IP·계정에 허용량을 배정하는지의 증거는 아니다. `OPENCODE_DISABLE_FREE_MODELS=1/true`는 이 활성화를 막을 수 있다. [F3][F4][F21]

**[확인] 현재 공식 inference 문서는 무료 chat을 OpenCode 내부에서만 허용하고 외부 클라이언트는 API 키를 주어도 HTTP 403이라고 명시한다.** 무료 채널에 raw curl로 모델 호출을 해 “read-only 검증”을 할 수 있다는 설계를 제안하지 않는다. 공개 API 모델 목록은 quota 잔여량이 아니다. [F5]

**[미확인] 현재 서비스의 identity/quota scope(IP, IPv6 subnet, device, 세션, account, workspace, key 또는 그 조합)는 공개 문서로 확정하지 못했다.** API 키가 없는 세션을 계정 인증 파일 경로에 매칭하거나, 로그인/유료 잔액 보유가 무료 cap을 해제한다고 가정하지 않는다. OpenCode device OAuth 로그인 흐름이 있다는 것과 무료 quota가 device를 기준으로 묶인다는 것은 서로 다른 주장이다. [F3][F5]

**[확인·과거 legacy 소스 한정] 2026-09-07 `handler.ts`는 `x-real-ip`를 읽고 IPv6를 앞 네 그룹으로 자르며, `allowAnonymous` 모델에 IP limiter를 먼저 적용한 뒤 인증한다.** `public`는 사용자 키 없음으로 바뀌고 anonymous 허용 모델은 키 없이 authenticate를 통과한다. 이때 기본 무료 모델은 IP+UTC일자 key를 공유하고, `rateLimit`가 별도 지정된 모델은 날짜에 model ID 앞 두 글자를 붙인다. 새 IP의 lifetime count로 임시 증량하는 코드도 있다. 따라서 이 역사 소스조차 모든 무료 모델이 항상 모델별 독립 또는 항상 하나의 pool이라는 단순 설명과 다르다. [F6][F7]

**[미확인] 위 legacy 분기가 11월 실서비스 무료 요청의 실제 구현이라는 증거는 없다.** 같은 9월 `handler.ts`조차 `modelList === "full"`에서 legacy 검사 전에 `proxyInference`로 위임할 수 있고, 11월 tree에는 해당 limiter/handler 서버 구현이 없다. 과거 IP 기준을 현재 device/account 정책으로 일반화하지 않는다. [F6][F8]

### 9.3. A3 — 한도 창·reset의 공개 보장

**[미확인] 현재 공식 무료 모델 문서에서 숫자 요청/토큰 한도, 공유 범위, 5시간·일간·주간 창, reset의 UTC 시각, 무료 제공 종료 시점에 대한 공통 계약을 찾지 못했다.** 무료 가격표는 무제한 이용 보장이 아니다. Go의 5시간/주간/월간 수치를 무료에 복사하지 않는다. [F1][F2]

**[확인·과거 legacy 소스 한정] IP limiter의 `getRetryAfterDay(now)`는 다음 UTC 00:00까지의 초를 올림하고 `FreeUsageLimitError(message, retryAfter)`에 넣었다.** daily count는 성공 응답 tracking에서 증가하고, threshold 값은 공개 숫자 상수가 아니라 `Resource.ZEN_LIMITS.value`의 `dailyRequests`와 모델별 override에서 온다. “매일 200회”, “자정이면 무조건 회복”을 현재 계약으로 쓰지 않는다. 새 IP 임시 증량과 모델별 override도 있으므로 하나의 고정 숫자를 복원할 수 없다. [F6][F7][F9]

**[추론·제안] 향후 무료 error의 유효한 `retryAfterMs`는 다음 확인 시각 후보이며 quota 해제의 증거가 아니다.** 값 없음/0/과거/너무 먼 시각/clock skew를 검증하고 임의의 매일 자정이나 24시간 대기를 넣지 않는다. 서버가 403으로 OpenCode 사용 자격을 거절한 경우에는 일간 reset 예약으로 바꾸지 않는다. [F5][F10][F11]

### 9.4. A4 — 오류 형식과 retry 힌트

| 증거 표본 | 확인 내용과 한계 |
| --- | --- |
| 9월 legacy server | `FreeUsageLimitError`와 다른 limit error를 HTTP429로 반환. body는 `{type:"error",error:{type:"FreeUsageLimitError",message},metadata:{}}`; `retryAfter`가 truthy면 `retry-after` 초를 설정. `metadata.workspace/limitName`은 Go 오류에서만 넣음. 무료 오류에 reset timestamp·scope·remaining metadata는 이 소스에 없음. `retry-after-ms`는 이 서버 분기에서 발행하지 않음. [F6][F12] |
| 11월 dev 분류기 | `FreeUsageLimitError`를 일반 throttle과 구별해 `QuotaExceeded`로 분류. session error는 `provider.free-limit`, 원본 status/body와 `retryAfterMs`를 보존. 문구는 사람이 읽는 고정 무료 한도 안내로 바뀌므로 문구만 보고 시각을 추출할 수 없음. [F10][F13] |
| 11월 dev 회귀 fixture | HTTP429 free body와 `retry-after:3600`이 `provider.free-limit`, `retryAfterMs:3600000` 및 native non-retryable로 바뀌는 fixture가 있음. 이것은 현재 클라이언트 호환 계약의 정적 증거이며 실제 계정에서 캡처한 응답은 아님. [F11] |
| 현재 공식 API 문서 | OpenCode 외부 무료 chat 요청 HTTP403을 명시. 현재 서비스의 free 오류 body·추가 metadata·hint 보장은 이 문서에서 확인 못 함. quota 소진 429와 허용 클라이언트 403을 분리. [F5] |

**[확인] V2 HTTP executor는 `retry-after-ms`를 먼저 보고, 없으면 `retry-after` 숫자 초 또는 HTTP-date를 밀리초로 정규화한다.** 현재 서버가 두 헤더 모두 또는 어느 헤더를 모든 무료 오류에 준다는 의미는 아니다. 빈 값/음수·범위에 대해서도 소스의 clamp를 확인해야 한다. 외부 예약은 정규화 값만 남기기보다 관측 시각과 원본 body를 함께 저장하는 것이 제안이다. [F14]

**[확인·로컬 기록] 사용자가 제공한 기존 read-only 추출에는 OpenCode v2.2.5 standalone 무료 실패가 2026-11-02 11:18–13:21 UTC에 7세션 있다.** `opencode/deepseek-v4.1-flash-free` 5건과 `opencode/glm-5.3-flash-free` 2건 모두 finish=error, `provider.free-limit`, HTTP429이며 위 v2.2.5 표시 문구와 일치한다. 원본 body는 `{type:"error",error:{type:"FreeUsageLimitError",message:"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"}}`이고 제공 추출에 metadata는 보이지 않는다. `retryAfterMs`는 48,986,000–41,569,000ms이며 각 실패 관측 시각에 더하면 모두 **11월 3일 00:54:45–46 UTC**로 모인다. 원시 HTTP header가 없으므로 `Retry-After` 또는 `retry-after-ms` 중 무엇을 받았는지는 알 수 없다. [FLOCALDB][FLOCALLOG]

**[확인·로컬 기록] 이 7건은 시작 약 0.3–1초 만에 assistant `finish:"error"`가 되고, 이어진 idle 레코드도 `outcome:"failed"`와 같은 error를 남겼다.** 이 표본의 native 실행은 장시간 retry 대기가 아니라 terminal 실패였다는 관측을 지지한다. 무료 성공은 11월 4일 07:13 UTC 이후, Go 전환은 11월 2일 13:26 UTC에 기록되었다. 이것은 실제 무료 회복 경계의 정확한 시각이나 Go가 무료 cap을 해제했다는 증거가 아니다. [FLOCALDB][FLOCALLOG]

**[추론·제안] 두 모델의 deadline 일치는 이 환경에서 공유 회복 시각이 있었음을 지지하지만 전 계정·모델의 공유 pool, UTC 자정 reset, 첫 사용 후 24시간을 증명하지 않는다.** 첫 무료 사용 표본은 11월 2일 01:51 UTC이고 11월 1일 기록은 없다. 이 표본의 첫 사용+24시간인 11월 3일 01:51 UTC도 관측 deadline과 맞지 않는다. 기록만으로 다른 identity·서버 측 창 시작점을 복원할 수는 없다. 현재 기록에서 나온 00:54:45–46 UTC를 과거 legacy 소스의 00:00 UTC로 덮어쓰면 안 된다. 이 로컬 증거는 사용자가 제공한 추출이며 이번 조사에서 로그/DB의 실행 기록을 다시 읽거나 재현하지 않았다. [FLOCALDB][FLOCALLOG]

### 9.5. A5 — V1/V2 native retry와 외부 continue

**[확인·과거 V1] `retryable()`는 APIError의 retryable/상태/문구 검사 뒤 `FreeUsageLimitError`를 인식하고 `free_tier_limit` UI action을 가진 retry 후보를 만든다.** 최대 retry 5회이며 지연은 `retry-after-ms`, `retry-after` 초/HTTP-date를 우선한다. 헤더 지연은 약 24.8일 timer 상한까지 허용하므로 “한도 오류를 보자마자 종료” 또는 “5회라 금방 종료”로 일반화하지 않는다. [F15]

**[확인·v2.2.5 및 현재 dev V2] 기본 `QuotaExceeded`는 retry 불가이고 free 전용 terminal error로 변환된다.** 다만 `AIError.isRetryable`는 `x-should-retry:true/false`를 먼저 적용하고 session retry hook도 결정을 바꿀 수 있다. 따라서 무료 한도가 절대 native retry하지 않는다는 표현은 피한다. 일반 retry의 15분 `Retry-After` cap은 RateLimit/ProviderInternal에 대한 정책이며 무료 quota의 회복 창을 15분으로 만드는 계약이 아니다. [F11][F16][F17][F22][F23]

**[추론·제안] 외부 자동화는 raw retry event나 UI 오류가 아니라 실행이 최종 실패한 뒤에만 후보를 만든다.** V1/V2별 원본 오류가 Paseo 경계에서 보존되는지 확인하고 native retry/permission/user input 상태를 함께 검사해야 한다. 다른 무료 모델, 유료 모델, Go로 자동 전환하거나 Go 구독을 권유하는 UI action을 실행하지 않는다.

### 9.6. A6 — 모델 호출 없는 무료 회복 조회

**[확인] 현재 공개 `/api/experimental/usage/limits` 계약은 로그인한 Console workspace의 Go allowance와 budgets이며 `free` meter가 없다.** response가 null이거나 Go가 없다고 무료가 준비됐다는 뜻은 아니다. API 설명의 “Get usage limits”라는 이름만 보고 무료용으로 재사용하지 않는다. 내부 Go 조회는 연결 resolve 중 OAuth refresh를 유발할 수 있으므로 그 API 자체도 무조건 부작용 없는 확인이라고 표기하면 안 된다. [F18][F19]

**[미확인] 무료 모델별 또는 무료 identity별 remaining/limited/reset을 모델 호출 없이 읽는 공식 공개 API는 찾지 못했다.** `/inference/v1/models`는 catalog이고, 로컬 session token/context 사용량이나 Console 지출 budget은 무료 cap의 readiness가 아니다. 현재 `/api/experimental/usage/limits`가 무료 정보를 반환한다는 가정도 계약에 없다. 이 조사에서는 usage 실호출·계정 로그인·모델 호출·credential 읽기·refresh를 하지 않았다. [F1][F18][F19]

**[추론·제안] 무료 오류 분류/표시, retry 힌트 보존, 힌트에 따른 조건부 재개는 구현 후보가 된다.** read-only quota API가 없는 상태의 continue는 회복 확인을 끝낸 전송이 아니라 서버가 제시한 시각 이후의 재시도다. Antigravity의 메시지 기반 fallback처럼 이를 명확히 표시하고, 연속 실패 시 횟수/기간 한도와 취소·지연을 적용할 수 있다. hint가 없으면 임의 reset을 만들지 말고 메시지에서 검증된 deadline 또는 제한된 backoff 정책을 사용한다. [F24][F25]

### 9.7. A7 — 0원 경로와 유료 fallback

**[확인] 현재 official usage의 `cost=0`은 무료와 Go 포함 사용량에 모두 쓰이고 `billing_source`가 `free`, `balance`, `go`, `go-plus`, `byok`를 구별한다.** 따라서 0원 응답만으로 무료를 판별하지 않는다. 무료 price·`-free` 접미사·`opencode` provider 이름·Console key 존재도 실제 요청 과금 route의 충분조건이 아니다. model alias/base URL/provider 설정까지 연결한 뒤 과거 성공 응답의 `billing_source=free`를 보조 증거로 쓴다는 것은 설계 제안이다. [F5][F20]

**[확인·과거 legacy 소스] anonymous 모델은 키 없이 `anonymous`, 일반 연결이 있으면 `free`로 반환하며 balance 검사 전에 종료한다.** 무료 IP limiter는 그보다 먼저 실행되므로 그 코드의 무료 한도를 넘어가면 자동으로 잔액을 써서 같은 요청을 통과시키는 fallback은 없다. 반대로 BYOK credentials는 free 판정보다 먼저 선택된다. 이 과거 순서를 현재 모든 request의 무과금 보장으로 확대할 수 없다. [F6]

**[미확인] 현재 무료 요청이 cap에 닿을 때 동일 ID를 유지한 채 자동 유료로 전환하는 일반 동작/설정 계약은 찾지 못했다.** 공식 docs의 무료 가격과 `billing_source=free`는 그 경로를 설명하지만, 제한된 무료 제공의 영구성이나 임의 커스텀 endpoint의 무과금을 보장하지 않는다. Go Extra Usage의 balance fallback은 별도 과금 계약이다. 무료 제한을 풀기 위해 결제·잔액 충전·BYOK·다른 모델 선택을 자동화하지 않는다. [F1][F5][F20]

### 9.8. 증거 시점과 미실행 검증

[F3] 등 current source는 **dev `893e8dc43f05e872d4cac603486ce8a7181170fa`** 정적 코드이고 설치 release 또는 실서비스와 동일하다고 주장하지 않는다. 역사 소스는 **`57ef3828431790c53f8f333c7ffbfe88770a1812` (2026-09-07)** legacy 분기다. 공식 현재 문서와 고정 source가 다르면 현재 문서/해당 설치 버전의 source를 따로 기록한다. 특히 무료 claim은 V1 구버전 문서나 사용자 이슈의 재현값으로 보강하지 않았다.

구현 전에는 외부 네트워크 없는 mock으로 (1) free429+hint, (2) free429 no hint, (3) plain throttle429, (4) 403 client gate, (5) 402 balance, (6) V1 native retry 대 V2 terminal, (7) retry hook override, (8) raw metadata Paseo 통과, (9) signed-out identity 불명/네트워크 변경, (10) 모델 목록·가격·route 변경 후 예약 취소를 검증해야 한다. 이 조사에서는 모델/usage/API 인증 호출을 실행하지 않았고, 로컬 기록은 사용자가 제공한 기존 추출만 인용했다. 문서만 추가하므로 npm 테스트를 실행하지 않았다.

## 10. 설치 OpenCode v2.2.5와 Paseo v0.15.0의 실제 경계

### 10.1 버전·release·adapter 선택

**[확인·로컬]** `/home/babo/.opencode/bin/opencode`는 ELF 실행 파일이며, 임시 `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`을 `/tmp/uar-opencode-inspect` 아래로 지정한 `--version`은 exit 0, **`opencode v2.2.5`**였다. 사용자 인증 파일을 읽지 않았고 서버·모델·usage·로그인 명령은 실행하지 않았다. 원래 환경에서 parent가 실행한 `--version`은 sandbox의 사용자 로그 경로 쓰기 제한으로 실패했으므로 버전 결과는 임시 경로 실행 결과다. 바이너리를 공식 배포 자산과 hash 대조하지는 않았다.

**[확인]** 공식 tag `v2.2.5`는 **`9bbb8ce18c80f099e0e448775f59d965ead40a21`**, commit 시각 **2026-10-30 22:06:51 UTC**, release 게시 시각 **2026-10-30 23:17:23 UTC**다. tag의 `packages/cli/package.json`은 `@opencode/cli` 2.2.5와 `@opencode/client`/`@opencode/server` 의존성을 명시한다. 따라서 이 tag는 새 V2 코드이며, 2.x 표기만 바꾼 legacy V1이라는 근거는 없다. [I1][I2][I3]

**[확인]** Go 오류 개선 PR #60284는 2026-10-29 17:02:58 UTC에 **`d9ecbbc874dea02f0efffb4251b4095c0c490f9b`**로 병합됐고, tag와의 공식 compare는 `ahead_by:156, behind_by:0, merge_base=d9ecbbc…`다. **이 변경은 v2.2.5에 포함된다.** 반면 기존 조사 dev `893e8dc…` 전체가 tag에 포함된 것은 아니다. tag→dev compare는 `diverged`, `ahead_by:377, behind_by:1`, merge-base `958f965d35ed44d32b018fd55b02a5357a7748fd`다. 실제 소스 비교에서도 최신 dev의 연결 불가 오류 표시 변경 등이 tag에는 없지만, 아래 Go/free/budget message mapping은 tag에서도 확인했다. [I4][I5][I6][I7]

**[확인] Paseo v0.15.0의 기본 owned-server 선택에서 이 출력은 V2 adapter로 간다.** `runtime-client.ts`는 `opencode v2.2.5`를 정상 parse하고 최소 `2.0.10` 검사를 통과시킨다. 명시적/발견된 외부 서버를 선택하면 version probe 이전에 V2 adapter를 쓴다. version 실행 실패 또는 형식 불일치 때 legacy V1 fallback이 존재하므로, 이 로컬 버전 확인만으로 사용자의 실행 중 Paseo 세션이 실제 어느 launch/server를 쓰는지 확정하지는 않는다. [I8]

### 10.2 오류→turn outcome→timeline 변환

**[확인]** V2 `session.step.failed` 자체는 Paseo의 terminal event가 아니다. `SessionTurns.observe()`는 `session.execution.started/succeeded/failed/interrupted`만 받아들이고, active session이 끝난 뒤 durable execution과 최종 history를 reconcile한다. `session.execution.failed`의 **`data.error.message`만** `turn_failed.error`에 복사하며 OpenCode `type`, `status`, `response.body`, `retryAfterMs`를 전달하지 않는다. `session.retry.scheduled` 역시 이 경로에서 `turn_failed`나 전용 retry timeline으로 투영하지 않는다. V1의 `Provider retry (attempt N): …` timeline 처리를 이 V2 경로에 적용하면 안 된다. [I9][I10]

**[확인]** Paseo lifecycle 변환은 아래와 같다. V2 event에서 `code`를 전달하지 않았으므로 plugin outcome에도 OpenCode 오류 type이 code로 생기지 않는다. `agent.turn_ended`는 v0.15.0에서도 지원되는 legacy alias이며 실제 hook 이름은 `agent.turn.after`다. **hook payload의 `timeline`은 항상 `[]`**이며 SDK 문서는 필요하면 `context.paseo.agents.ref(agent.id).timeline.refetch({direction:"tail",limit:20})`를 쓰라고 명시한다. [I11][I12]

```text
OpenCode execution.data.error = {type, message: M, status?, response?, retryAfterMs?}
→ Paseo turn_failed = {provider:"opencode", error:M, turnId:<가변 ID>}
→ PluginTurnOutcome = {kind:"failed", error:{message:M, code:undefined}}
→ hook payload timeline = []
```

**[확인] 저장된 live timeline은 별도다.** `agent-manager.ts`는 terminal failure를 처리할 때 `formatTurnFailedMessage()`로 message를 trim하고, code/diagnostic이 없는 이 경로에서는 **`{type:"assistant_message", text:"[System Error] " + M.trim()}`**를 append한다. error item이 아니다. 이미 같은 마지막 assistant item이 있거나 history replay인 경우에는 중복 append하지 않는다. 따라서 아래 fixture의 “timeline text”는 tail을 refetch했을 때의 저장 항목이고 hook의 빈 배열과 구별해야 한다. [I13]

### 10.3 고정 문자열 fixture와 현재 `server/limit.ts`

**[확인·정적 fixture]** 아래는 실제 계정에서 캡처한 오류가 아니다. v2.2.5의 공식 `session-error.test.ts`에 있는 wire body 및 `to-session-error.ts`의 결정적 mapping을 근거로 만든 입력→출력 fixture다. `M`은 아래 표의 **완전한 문자열**이고 저장 timeline text는 위 공통 규칙 `[System Error] ${M}`다. generic 429/402의 message는 provider에 따라 가변이므로, 표에서는 아래 명시한 body를 넣었을 때만 고정된다. reset 열은 **Paseo를 통과한 문자열** 기준이다. [I7][I14][I15][I16]

| 입력 fixture | 원래 OpenCode error type | `PluginTurnOutcome.error.message`의 정확한 `M` | 현재 감지 | 문자열 reset |
| --- | --- | --- | --- | --- |
| 429 `GoUsageLimitError`, `metadata.limitName:"5 hour"`, `Retry-After:120` | `provider.go-limit` | `OpenCode Go 5 hour usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.` | hit `{resetAt:null}` | 없음 |
| 같은 Go body에서 `limitName` 생략 | `provider.go-limit` | `OpenCode Go usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.` | hit `{resetAt:null}` | 없음 |
| 429 `FreeUsageLimitError`, `Retry-After:3600` | `provider.free-limit` | `Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.` | hit `{resetAt:null}` | 없음 |
| 일반 429 body `{"error":{"type":"rate_limit_error","message":"Too many requests"}}`, `Retry-After:10` | `provider.rate-limit` | `Too many requests` | hit `{resetAt:null}` | 없음 |
| 402 body `{"type":"error","error":{"type":"CreditLimitExceeded","message":"Credit limit exceeded."}}` | `provider.quota` | `Credit limit exceeded.` | miss `null` | 없음 |
| 429 `BudgetLimitError`, `metadata.coverage:"models"`, `metadata.resetsAt:"2026-11-01T00:00:00.000Z"` | `provider.model-budget-limit` | `You've reached the spend limit for this model. Switch models to keep going.` | miss `null` | 없음 |
| 429 `BudgetLimitError`, coverage `all`, 동일 `resetsAt` (공식 fixture의 Google ErrorInfo envelope 포함) | `provider.budget-limit` | `Workspace usage limit reached. Model use is paused until the limit resets.` | hit `{resetAt:null}` | 없음 |

**[확인]** Go `limitName`은 원래 body에서 정규식으로 추출한 **가변 부분**이다. `weekly`면 `OpenCode Go weekly usage limit reached. …`, `monthly`면 `OpenCode Go monthly usage limit reached. …`가 되며 뒤의 문장은 위와 같다. 임의의 이름도 그대로 들어갈 수 있어 허용 목록 검사나 정확한 reset으로 취급하면 안 된다. tag 공식 fixture의 원래 Go body는 다음과 같고 `retryAfterMs:120000`를 보존하지만, Paseo outcome에는 이 숫자가 남지 않는다. [I7][I14]

```json
{"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"workspace":"wrk_go_limit","limitName":"5 hour"}}
```

**[확인]** generic HTTP 오류의 message는 `RequestExecutor.statusError()`가 body의 `error.message` 등 알려진 필드에서 추출한다. 알려진 message가 없고 body가 없거나 HTML이면 `Provider request failed with HTTP 429`가 될 수 있고, 이 문자열은 현재 `LIMIT_PATTERNS`에 걸리지 않는다. 알 수 없는 JSON body는 `Provider request failed with HTTP 429: <최대 2000자 body>` 형태다. 따라서 **429 전체에 대한 hit를 보장하지 않는다.** 공식 unit helper가 `httpFailure({message:"Rate limit exceeded. Please try again later.",…})`를 직접 호출한 경우에는 body와 무관하게 그 지정된 message가 유지되며 이 역시 hit다. 실제 HTTP body extraction과 이 helper의 입력을 섞어 표현하지 않았다. [I14][I15][I16]

**[확인·로컬 계산]** 위 표는 변경 없이 기존 `detectLimitStop()`/`parseResetAt()`를 `node --import tsx --input-type=module`에서 호출해 대조했다. outcome만 넣는 경우와 저장된 `[System Error] …` assistant item만 넣는 경우의 hit/miss는 같았다. 관측 시각은 `2026-11-05T00:00:00.000Z`로 고정했고 모든 `parseResetAt(M)`는 `null`이었다. 이 계산은 mock server/모델 호출 또는 패키지 테스트 실행이 아니다.

**[추론·제안]** 현재 문자열 규칙은 Go와 free와 generic throttle과 workspace budget을 같은 renewable limit 후보로 만든다. 반대로 모델 budget의 고정 문구는 `CREDIT_NOTICE`가 기대하는 `your` 대신 `the spend limit`여서 놓친다. `resets`라는 단어만 있는 workspace 문구는 정확한 시각이 아니며 Go의 `5 hour`는 창 이름이지 남은 대기 시간이다. 원래 Go/free의 `retryAfterMs`, budget body의 `resetsAt`도 projection에서 사라진다. 이 경계만으로 현재 코드가 Go reset에 정확히 예약할 수 있다고 판단하면 안 된다. [I7][I9][I13][I14]

**[확인·로컬 계산] 정규식별 결과:** Go/free/workspace budget은 `LIMIT_PATTERNS`의 `usage limit … reached`, 표의 generic 429는 `too many requests`에 걸린다. `Credit limit exceeded.`는 `NOT_A_LIMIT`가 명시적으로 veto해서가 아니라 positive pattern과 `CREDIT_NOTICE` 모두에 걸리지 않아 제외된다. 모델 budget도 두 positive 경로 모두 놓친다. 이 고정 fixture들은 `NOT_A_LIMIT`와 `CREDIT_NOTICE`에 걸리지 않는다. 구조화된 OpenCode type은 Paseo outcome의 `error.code`로 전달되지 않아 `LIMIT_CODES` 경로도 쓸 수 없다. [L7][I9]

**[확인·로컬 기록과 정적 도출의 연결]** 9.4절의 실제 standalone free 오류는 표의 free 표시 문구와 같고 raw `retryAfterMs`도 존재했다. 이를 같은 Paseo V2 projection에 넣으면 문구만 남아 detector는 hit하되 `resetAt:null`이 된다. 이것은 **실측된 raw 오류와 고정 소스 변환을 연결한 도출**이며, 7건을 Paseo에서 재실행하거나 hook으로 캡처한 결과는 아니다. [FLOCALDB][FLOCALLOG][I7][I9]

**[확인]** v2.2.5는 Go/free/budget/402를 `QuotaExceeded`로 분류해 기본 retry 대상에서 제외하고, 일반 429는 retry 가능하게 분류한다. 단 `x-should-retry:true/false`가 기본 분류보다 먼저 적용되고 retry hook도 있으므로 “Go는 어떤 환경에서도 재시도하지 않는다”로 확대하지 않는다. V2 retry 중 terminal failure로 처리하지 않아야 한다. [I16][I17]

### 10.4 provider/model/runtimeInfo 신호의 범위

**[확인]** Paseo 내장 제공자를 직접 사용하는 agent의 `provider`는 `opencode`다(사용자 정의 profile은 자신의 provider ID를 사용하므로 혼동하지 않는다). catalog model은 `id:"<OpenCode providerID>/<model.id>"`, `provider:"opencode"`, metadata `{providerId:<providerID>,modelId:<model.id>,…}`다. 선택 문자열은 첫 `/`에서 나눠 V2 `ModelRef={providerID,id,variant?}`로 보낸다. adapter의 runtimeInfo 반환은 `{provider:"opencode", sessionId, model:"<providerID>/<id>"|null, modeId, thinkingOptionId}`다. 예를 들어 `providerID:"opencode-go",id:"<model-id>"`이면 model string은 `opencode-go/<model-id>`다. 이는 **형태 예시**이며 이 호스트의 Paseo 세션에서 그 모델이 선택됐다는 관측이 아니다. [I18][I19]

**[확인]** v2.2.5의 model resolver는 실제 provider/model settings·credential·variant overlay로 모델을 구성하고 `settings.baseURL`/실제 route endpoint를 다룬다. OpenCode Console plugin은 remote config를 integration layer로 합치며 `opencode` integration에 Key/OAuth를 제공하고, API key가 없으면 free 모델용 `apiKey:"public"`도 설정할 수 있다. 그러므로 `provider:"opencode"`는 CLI 종류이고, `runtimeInfo.model`의 prefix는 논리 provider 선택 정보다. 이 둘만으로 **Go 포함량·Extra Usage 잔액·Console BYOK 중 실제 청구 source**, 현재 활성 credential/workspace, 응답의 `billing_source`를 확정할 수 없다. 마지막 판단은 source 경계에서의 추론이다. [I20][I21]

**[추론·제안]** `opencode-go/…`는 지원 대상으로 좁히는 후보 신호로는 쓸 수 있으나 Go 구독 회복 검증의 완전한 허가 신호로 쓰지 않는다. `runtimeInfo.model:null` 또는 서버/launch context 불명은 unknown으로 두고 native 오류 type/body·현재 scope가 일치하는 usage를 함께 확인한다. 현재 Paseo projection의 code/body/reset 손실과 empty hook timeline을 먼저 해결하거나 명시적으로 보완해야 한다.

**[확인]** plugin context의 Paseo client agent handle은 `refresh()` 이후 `runtimeInfo`를 노출하고, `AgentRuntimeInfo.sessionId`로 OpenCode native session ID를 얻을 수 있다. 다만 V2 adapter의 runtimeInfo 반환에는 server URL·서버 인증·connection identity가 없다. **[추론·제안]** 따라서 session ID만으로 안전한 native error side reader가 완성되지는 않는다. 정확한 서버 선택·인증·scope를 추가로 확보하면 raw durable execution의 오류 hint를 보완할 여지는 있고, hint 없이 정해진 간격/상한의 보수적인 free 재시도 정책은 별도의 plugin 정책으로 설계할 수 있다. 이것을 정확한 reset 시각 복원과 구별하며, upstream metadata 보존만이 유일한 구현법이라고 단정하지 않는다. [I19][I22][I23]

## 11. 설치 호스트의 인증 저장과 Go 사용량 조회 연결

### 11.1 비밀 값을 제외한 로컬 관찰

**[확인·로컬 관찰]** 조사 호스트의 기본 data directory는 `~/.local/share/opencode`이며 `auth.json`, `opencode.db`, `opencode.db-wal`, `opencode.db-shm`이 존재했다. JSON은 최상위 제공자 이름·`type`·필드 이름만 출력했고, SQLite는 `mode=ro`와 `PRAGMA query_only=ON`으로 schema와 아래 projection만 읽었다. API 키·토큰·credential ID·사용자 label·조직 식별 값은 출력하지 않았다.

```text
auth.json:
  openrouter -> type: api, field names: key, type
  groq       -> type: api, field names: key, type
  opencode-go 항목 없음

opencode.db / credential, integration_id가 opencode 또는 opencode-go인 행:
  integration_id: opencode-go
  type: key
  active: true
  value의 field names: type, key
  opencode 행 없음
```

재현 시 비밀 대신 구조만 반환하는 SQL은 다음과 같다. `SELECT value`, `.dump`, 인증 CLI 조회는 사용하지 않았다.

```sql
SELECT c.integration_id, json_extract(c.value, '$.type') AS type, c.active,
       (SELECT json_group_array(j.key) FROM json_each(c.value) AS j) AS field_names
FROM credential AS c
WHERE c.integration_id IN ('opencode', 'opencode-go');
```

**[확인] v2.2.5는 credential을 DB 테이블로 저장한다.** `integration_id`, JSON `value`, 활성 선택 `active`가 있으며, legacy `auth.json`의 `type: api`는 migration에서 `type: key`로 바꿔 가져온다. `auth.json`이 남아 있는 것은 현재 Go 연결도 그 파일에 있다는 증거가 아니다. 이 호스트의 실제 구조도 그 차이를 보였다. [B1][B2][B3]

### 11.2 기본 Go 키에는 native usage API의 전제 조건이 맞지 않는다

**[확인] v2.2.5의 `UsageLimits.get` 구현은 기존 조사 dev 소스와 동일하다.** 먼저 `integration.connection.active('opencode')`를 찾고, 그 credential의 `metadata.orgID`가 있어야 Go·budget 조회를 시작한다. `opencode-go`의 bare key를 대신 찾는 경로는 없다. 위 로컬 구조에는 `opencode` 연결도 `metadata` 필드도 없었다. 따라서 **이 기본 저장소 스냅샷만으로는 해당 통합 조회가 현재 Go 키를 반환할 조건이 충족되지 않는다.** 다른 실행 환경·env 연결·사용자 플러그인이 추가하는 연결은 이번 projection으로 확인하지 않았다. 실제 API는 호출하지 않았다. [B4]

**[확인] Paseo 0.15의 Go usage source도 이 호스트의 DB 키를 발견하는 구현은 아니다.** 그 코드는 `auth.json['opencode-go'].key`만 읽고, DB를 읽지 않는다. 따라서 앞선 “이미 있는 Go 조회 구현 활용”은 **HTTP 계약과 응답 정규화의 참고 구현으로 활용 가능**하다는 뜻이며, 현재 설치 환경에서 인증 발견까지 그대로 재사용된다는 뜻은 아니다. [P4][B1][B2]

**[추론·제안] 플러그인에 DB credential 저장 방식과 실제 세션의 연결 선택을 반영하는 reader가 필요하다.** default DB의 활성 key만 찾았다는 사실은 원격 재사용 서버·다른 XDG·profile·환경 변수·custom endpoint로 실행한 세션의 계정 일치까지 증명하지 않는다. 키 변경 감지용 fingerprint를 도입하더라도 “동일 키”와 “검증된 동일 계정”을 구분해야 한다. 이번 조사에서는 key 자체를 읽거나 fingerprint를 계산하지 않았다.

### 11.3 API 키 조회와 OAuth refresh는 분리된다

**[확인] API 키를 이미 확보한 코드가 `/zen/go/v1/usage`에 직접 GET하는 경로에는 token refresh나 모델 호출이 없다.** Paseo source는 bearer key로 GET만 실행한다. v2.2.5도 key credential은 `Integration.connection.resolve`에서 즉시 반환하며, OAuth일 때만 만료 임박 여부를 확인해 refresh할 수 있다. 따라서 **키 방식의 조회에 기존 “모델 호출·토큰 갱신 없이 확인” 원칙을 적용할 수 있다.** OAuth native API의 부작용을 모든 Go 키 조회에 일반화하면 안 된다. 실제 key 유효성·service 응답은 미검증이다. [P4][B4][B5]

**[확인·역사 소스]** 공개됐던 Go usage handler도 bearer key를 DB에서 검증하고 workspace/user의 사용량을 SELECT한 뒤 응답을 만들며 inference·토큰 refresh·사용량 증가를 실행하지 않는다. 현재 배포 서버의 전체 구현을 같은 것으로 단정하지는 않는다. [H3]

## 12. Go 세 창이 모델 간 공유되는가

**[확인·역사 소스] 모델 간 공유를 뒷받침하는 추가 근거가 있다.** 2026-09-07의 legacy inference handler는 Go의 당시 내부 명칭인 `lite` 과금일 때 `quotaCost = round(cost * modelInfo.costMultiplier)`를 계산하고, `LiteTable`의 rolling/weekly/monthly 카운터를 증가시킨다. 갱신의 WHERE 조건은 **workspaceID + userID**뿐이며 model ID 조건이 없다. 같은 범위에서 모델마다 환산한 비용이 동일한 세 창에 합산되는 구조다. Go usage handler도 같은 workspace/user 행을 읽고, 공통 Lite limits로 세 창을 계산한다. [B6][H3]

**[확인·한계]** 그 handler에는 새 inference 경로로 프록시하는 분기도 있다. 위 코드는 공개 legacy 경로의 구조를 증명하며, 현재 모든 모델·플랜이 그 분기를 통과한다는 증거는 아니다. [B6]

**[확인] v2.2.5의 usage 응답에도 model 인자는 없고 세 창이 한 묶음으로 반환된다.** 이는 aggregate allowance 해석과 일관되지만, 현재 공식 문서의 모델별 한도 설명까지 해명하지는 못한다. [B4][D1]

**[추론·제안]** “모델마다 독립적인 5시간 창”을 만들어 계산할 근거는 없다. 서버가 반환한 세 창을 workspace/user 수준의 값으로 보존하고, 모델별 적용 가능성이 불명확하면 준비 완료를 확정하지 않는 것이 적절하다.

**[미확인]** 현재 Go/Go Plus/Teams의 모델별 allowance 환산·독립 제한 여부, 모든 모델에 같은 세 창을 적용해도 되는지, 특정 모델 차단 때 aggregate `limited=false`가 가능한지는 실서비스 계약 또는 사용자 관찰로 남는다. 기존 3절의 미확인 사항은 역사 근거가 보강됐지만 완전히 해소되지는 않았다.

## 13. 구현 가능성·정책 결정·남은 확인

### 무료 사용자: 조건부 가능

**[추론·제안] OpenCode 공식 무료 chat 사용자의 Auto Resume은 조건부로 가능하다.** 7건의 로컬 기록은 실제 `provider.free-limit` terminal 실패와 회복 가능한 재시도 시각이 있음을 보여 준다. 무료 readiness 조회 API가 미발견이어도 Antigravity와 같이 오류 안내에 근거한 재시도 정책을 적용할 수 있다. 현재 프로그램이 모든 제공자에 반드시 구독 quota 조회를 강제한다는 전제로 무료 지원을 막을 이유는 없다. [FLOCALDB][FLOCALLOG][F24][F25]

정해야 할 정책은 다음과 같다.

1. **조회 없는 재시도 허용:** 무료 한도는 “회복 확인됨” 대신 “무료 한도 후 재시도 예정”으로 표시한다. 새 사용자 메시지·모델/실행 범위 변경·권한 대기·archive·native 실행 중 검사와 기존 시도 상한을 유지한다.
2. **시각 정보 수준:** raw `retryAfterMs`를 확보하면 오류의 관측 시각에 더해 예약하고 buffer를 둔다. 확보하지 못하면 기존 15/30/60분 방식 등 bounded backoff를 사용할 수 있으나, 이를 정확한 reset 예약이라고 설명하지 않는다. 그 세 번이 모두 11–14시간짜리 한도 안에서 끝나면 회복 전에 give-up할 수 있으므로, **힌트 보존을 우선하고 무힌트 free retry의 횟수·기간은 별도로 결정**한다. 네트워크 재연결 뒤 과거 오류를 다시 읽은 시각에 delay를 더해 예약을 계속 뒤로 미루지 않는다.
3. **무료 범위 유지:** first-party 실제 free chat 모델만 포함하고, 예약 사이의 모델·가격·endpoint·과금 경로 변경을 재확인한다. 자동으로 Go/유료 모델/BYOK로 전환하거나 추가 사용을 켜지 않는다. `-free` 접미사만 검사하면 `big-pickle`은 빠지고 custom alias는 잘못 포함될 수 있다. Jev와 third-party free tier는 첫 지원 범위에서 제외한다. [F1][F5][F20]

**[미확인]** 현재 서비스에서 모든 free 요청이 항상 0원이라는 보편적인 보장은 확인하지 못했다. 공식 무료 모델과 `billing_source=free`라는 명시적 경로는 근거가 있지만, 커스텀 endpoint·BYOK·가격 변경·다른 billable 도구까지 포함한 전체 continue의 비용 0을 보장하지 않는다. 과거 무료 handler에는 balance fallback이 없었으나 현재 모든 배포 경로의 계약을 대신하지 않는다. [F5][F6][F20]

### Go 구현: Paseo upstream 수정이 필수인가

**[추론·제안] 기본 Go Auto Resume에 Paseo upstream 수정이 논리적으로 필수인 것은 아니다.** 지금도 Go 전용 표시 문구는 도착하고, 우리 플러그인은 별도 key reader와 model-free Go usage GET으로 일정·전송 전 확인을 구성할 수 있다. 이 호스트에서는 DB credential 지원과 실제 실행 세션의 인증 범위 연결이 필요하다. 현재 Paseo usage source를 그대로 부르는 것만으로 완성되지는 않는다. [I7][I9][P4][B1][B4][B5]

| 원하는 수준 | 플러그인만으로 가능한 경로 | 남는 조건 |
| --- | --- | --- |
| Go 한도 메시지 감지 + 자체 quota 조회 후 재개 | 전용 문구 분류, DB/key reader, Go usage GET, 기존 예약·send | 실행 계정·model/meter·추가 과금 범위 검증 |
| 무료 한도 후 제한된 메시지 기반 재시도 | 전용 최종 문구 분류와 기존 bounded scheduler | 무료 경로 유지와 조회 없는 전송 정책 |
| free의 정확한 원본 retry deadline 복원 | native session ID와 같은 서버/DB의 오류를 보완해서 읽는 별도 reader | Paseo가 서버 URL·auth를 runtimeInfo에 제공하지 않아 side reader 설계·검증 필요 |
| Paseo hook만 사용해 type/status/retryAfterMs/body를 받기 | 현재 0.15 projection으로는 불가능 | 이 계약을 원하면 upstream metadata 전달 보완이 유용 |

즉 upstream 보완은 **원본 정보를 공용 인터페이스로 전달하는 좋은 개선**이다. 플러그인이 사용할 수 있는 메시지·별도 조회·bounded fallback 경로까지 없다는 뜻은 아니다. exact-reset 보장과 best-effort 재시도를 같은 기능으로 설명하지 않는다. [I9][I19][I22][I23]

### 여전히 미확인인 사항과 사용자 환경에서의 후속 확인

아래는 이번에 실행하지 않은 후속 확인이다. 새로운 모델 호출이나 한도 소진을 요청하지 않으며, Console 화면과 기존 기록 또는 평소 사용 중 자연스럽게 생기는 기록으로 확인할 수 있다.

| 미확인 | 사용자 환경에서 확인할 증거 |
| --- | --- |
| 현재 free identity·창의 정의, 모든 모델의 공유 여부 | provider의 공식 정책 확인. 기존 7건은 두 모델의 같은 deadline만 증명하며 IP/account/device의 정확한 범위는 모름 |
| free의 원시 HTTP retry header | 다음 자연 발생 제한에서 인증 헤더를 제외한 response `Retry-After`/`retry-after-ms`와 timestamp. 기존 `retryAfterMs`만으로 어느 헤더였는지 확정 불가 |
| 실제 Paseo 실행 경로·전달 문자열 | 사용 중 세션의 binary/server 선택과 runtimeInfo, 다음 자연 발생 실패의 outcome 및 tail timeline. 현재 free 기록은 standalone이며 Paseo를 통과시킨 실측이 아님 |
| Go Extra Usage·모델별 한도와 세 창의 대응 | Console의 Go 플랜/조직·Extra Usage 설정·모델별 allowance 표시, 기존 오류/사용량 응답. API 키가 있다는 사실이나 prefix만으로 확정하지 않음 |
| 현재 세션과 Go key의 계정 일치 | 실제 Paseo host/XDG/프로필·remote server 여부와 선택 연결. 기본 DB의 구조 snapshot은 다른 서버 credential과의 일치 증거가 아님 |
| 무료 continue의 실제 청구 경로 | 기존 성공 응답의 `billing_source`, 선택 모델·endpoint와 Console 사용 내역. token/cost 0만으로 free라고 판정하지 않음 |

### 추가 조사 검증 기록

**[확인·로컬 계산]** 문서만 수정했다. 격리된 경로의 `opencode --version`과 기존 분류 함수의 직접 실행은 성공했다. 기본 경로 `--version`의 로그 쓰기 제한 실패는 격리 경로로 재확인했으며 제품 호환성 실패로 집계하지 않는다. 문서의 참조·고정 source 경로·공백을 검사했다. 실제 모델/usage 호출, 로그인, token refresh, 인증 비밀 값 열람·출력, 서버 기동·재개 실험은 하지 않았다. `npm run test:focus`, `npm run typecheck`, `npm run check`는 코드 변경이 없으므로 실행하지 않았다. 구현 시의 필수 검증 요구는 7절을 따른다.

## 14. OpenCode V2 최소 지원 버전 — 2026-11-06

**[확인·조사 범위]** 이번 지원 대상은 OpenCode V2이며 V1(1.x)은 제외한다는 결정에 따라, 공식 V2 release tag와 고정 커밋을 비교했다. Free는 같은 native 세션의 마지막 free-limit 오류를 DB에서 읽고, Go는 선택된 opencode-go key로 usage를 확인하는 구현을 전제로 필요한 기능의 최초 버전을 구분한다. 아래에서는 source tag 포함, 실제 오류 생성, JSON schema 수용, DB 기록을 분리해 확인한다.

### 14.1 오류 기능별 최초 공식 V2 릴리스 태그

**[확인] 무료 한도를 전용 오류로 분류하고 `status`, `response.body`, `retryAfterMs`를 보존하여 assistant 오류와 idle 실패 메시지에 저장하는 조합은 공식 태그 `v2.1.2`부터 확인된다. Go 전용 분류와 현재 표시 문구는 둘 다 `v2.2.2`가 최초 공식 태그다.** `v2.2.5`에 기능이 있다는 관찰과 최초 지원 버전은 다르다. 아래의 “최초”는 공식 저장소의 V2 태그와 그 고정 소스 기준이며, 과거 태그의 GitHub Releases 게시물 존재 여부와 구분한다. [EFL1][EFL2][EFL3][EFL4][EFL5]

| 기능 | 도입 커밋 | 최초 공식 V2 태그 / 고정 SHA | 직전 태그에서의 부재·차이 |
| --- | --- | --- | --- |
| `FreeUsageLimitError` → `provider.free-limit`, 현재 고정 무료 문구, quota의 `retryAfterMs` 전달 및 session error 스키마 필드 | `a9fa57b738b4cdc4200e352cafcec99aab8a9ef3` (`#57146`) | `v2.1.2` / `a517687fde98a7329ada3ae644a01a9fc6c4e99e` | `v2.1.1` / `ba546ec1598a70db2570e9c6258028d955ba8f58`는 quota를 `provider.quota`로 통과시키며 free 전용 분기·고정 문구가 없다. [EFL1][EFL2][EFL6][EFL7] |
| 다른 provider 오류에도 공통 `retryAfterMs` 전달, 정수·상한 정규화 | `80b87629139889ecd8d3b57e690f94d05f6bd745` (`#57589`) | `v2.1.2` / 위 SHA | 첫 무료 커밋은 free 분기에서만 delay를 직접 붙였다. 이 후속 커밋은 `providerError` 공통 함수로 전달을 옮겼다. 두 커밋 모두 `v2.1.1…v2.1.2`에 들어간다. [EFL6][EFL8][EFL9] |
| `GoUsageLimitError` → `provider.go-limit`, status/body/delay 보존 | `3eb834b85ac064d07a1d58044f0c7aa9d78f27b5` (`#57897`) | `v2.2.2` / `098aa7fd6e02b03d6fc410f0b052038c7d4c5e81` | `v2.2.1` / `3ebcf9a32c7b28f658cfee80775448929361727a`는 Go 전용 분기 없이 `provider.quota`로 처리한다. [EFL3][EFL4][EFL10] |
| `metadata.limitName`을 반영한 현재 Go 문구 | `d9ecbbc874dea02f0efffb4251b4095c0c490f9b` (`#60284`) | `v2.2.2` / 위 SHA | `#60284` 실제 diff는 **이미 존재하는** `provider.go-limit` 분류의 문구를 바꾼다. 초기 분류와 새 문구의 두 커밋이 모두 `v2.2.1…v2.2.2`에 포함된다. PR 본문에서 “new type”이라고 표현한 부분만으로 도입 시점을 정하면 틀린다. [EFL10][EFL11][EFL12] |

**[확인] 태그 포함 여부는 날짜가 아니라 커밋 계보와 코드로 확인했다.** `a9fa57b…→a517687…` 비교는 `ahead`, `behind_by: 0`이고 직전 `ba546ec…`에는 해당 free 분기가 없다. `3eb834b…→098aa7f…` 및 `d9ecbbc…→098aa7f…`도 각각 `ahead`, `behind_by: 0`이다. 직전 `3ebcf9a…`에는 Go 전용 분기가 없다. `v2.2.2` 공식 릴리스 노트도 Go/ChatGPT의 전용 분류와 Go reset·계정 링크·composer tray를 명시한다. [EFL2][EFL3][EFL7][EFL9][EFL12][EFL13][EFL14][EFL15]

**[확인] 스키마 수용, 실제 분류, DB 저장은 별도 증거다.** `SessionError.Error.type`이 `Schema.String`이라는 사실은 특정 문자열을 담을 수 있다는 뜻일 뿐, 실제 서버가 그 문자열로 분류했다는 증거가 아니다. `v2.1.2`의 스키마는 `type`, `message`, 선택적 `status`, `response.body`, `retryAfterMs`를 수용하고, `toSessionError`는 free 전용 타입·문구와 원본 status/body/delay를 실제로 만든다. [EFL1][EFL16]

**[확인] 같은 `v2.1.2` 소스에서 저장 경로까지 연결된다.** runner는 `toSessionError` 결과를 실패 assistant에 전달하고 `SessionEvent.Step.Failed`로 발행한다. message updater는 `assistant.finish = "error"`, `assistant.error = event.data.error`로 갱신한다. execution 실패도 `toSessionError`를 거쳐 `SessionEvent.Execution.Failed`에 실리고, updater는 `type: "idle"`, `outcome: "failed"`, 같은 error를 가진 메시지를 append한다. projector는 두 메시지를 `SessionMessage.Info`로 encode한 뒤 `SessionMessageTable.data`에 update/insert하며 SQL 선언의 실제 테이블 이름은 `session_message`다. 따라서 필드가 스키마에 있다는 주장에 그치지 않고, 이 태그에서 두 종류의 영속 메시지에 포함되는 경로를 확인했다. [EFL17][EFL18][EFL19][EFL20][EFL21][EFL22]

**[미확인]** 이 판단은 고정 공개 소스의 정상 terminal failure 경로에 대한 것이다. 해당 과거 바이너리를 설치해 모델을 호출하거나 DB를 새로 생성하는 실험은 하지 않았다. 사용자 DB·로그·인증 비밀은 읽지 않았다. 플러그인이 native retry 정책을 바꾸면 terminal 실패 시점이 달라질 수 있으며, 현재 Paseo가 이 구조를 그대로 전달하는지는 별도 경계다.

### 14.2 정확한 문구와 이전 버전의 차이

**[확인] 무료 고정 문구는 `v2.1.2`에서 처음 들어와 `v2.2.5`에서도 같다.** [EFL1][EFL6][EFL23]

```text
Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.
```

**[확인] 직전 공식 태그 `v2.1.1`에는 대체 가능한 “이전 무료 고정 문구”가 없다.** AI 계층은 `freeusagelimiterror`를 quota code로 인식하지만, core는 `provider.quota`와 `cause.reason.message`를 통과시킨다. 따라서 입력 body의 `error.message`가 아래 값인 공식 회귀 fixture에서는 이전 전달 문자열도 아래 값이다. 이 한 fixture를 모든 당시 무료 서버 응답의 유일한 문구라고 일반화하지 않는다. `v2.1.1`에서는 quota reason에 retry delay도 전달되지 않았다. [EFL2][EFL6][EFL24]

```text
Rate limit exceeded. Please try again later.
```

**[확인] 현재 Go 문구는 `v2.2.2`가 최초 공식 태그다.** `metadata.limitName`을 찾으면 `OpenCode Go ` 다음에 이름과 공백을 넣고, 없으면 이름 부분을 생략한다. 문구 자체에 reset timestamp는 없고 지연은 구조 필드 `retryAfterMs`에 남는다. [EFL4][EFL11]

```text
OpenCode Go[ <limitName>] usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.
```

위 대괄호는 선택 영역을 설명하는 표기다. 실제 `limitName: "5 hour"` 예시는 다음과 같다.

```text
OpenCode Go 5 hour usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.
```

**[확인] 직전 공식 태그 `v2.2.1`의 Go 오류는 `provider.quota`이며 `reason.message` 통과 방식이다.** `#60284` 회귀 fixture의 서버 payload가 `error.message: "Go usage limit exceeded"`이면 그 이전 전달값은 정확히 아래 문자열이다. 다른 서버 원문이면 다른 문자열일 수 있다. [EFL3][EFL11]

```text
Go usage limit exceeded
```

**[확인] 다음 이전 Go 전용 문구도 실제 소스에 존재하지만, 공식 태그로 배포된 이전 문구라고 부르면 안 된다.** `3eb834b…`에서 도입되어 `d9ecbbc…` 직전까지 dev 소스에 있었고, 두 커밋이 모두 처음 포함되는 공식 태그는 `v2.2.2`다. 따라서 공식 태그 `v2.2.1`과 `v2.2.2`의 비교에서 이 중간 문구를 끼워 넣지 않는다. [EFL10][EFL11][EFL12]

```text
OpenCode Go usage limit reached. To keep using this model, enable spending from your available balance in the Console.
```

**[추론·제안]** free `v2.1.2`, Go `v2.2.2`는 기능별 도입선이며, 실제 제품의 공통 지원선은 14.5의 `2.2.2`로 통일한다. 그 이전 태그의 raw 메시지 경로를 별도 지원 구현으로 추가할 필요는 없다. 위의 중간 dev Go 문구는 preview/custom build에서 관측될 가능성은 있으나 정식 릴리스 구간에 대응시키지 않는다.

### 14.3 저장 형식과 V2 태그 경계

**[확인]** 아래 경계는 공식 저장소의 V2 태그가 가리키는 커밋에서 파일을 직접 대조한 결과다. `v2.0.0` 등 초기 V2 태그의 GitHub Release 객체가 존재한다거나 그 게시 시각을 확인했다는 뜻은 아니다. 커밋 시각과 마이그레이션 ID에 들어 있는 날짜를 릴리스 게시 날짜로 사용하지 않는다. V2 최초 태그 자체의 근거와 배포 버전 판별은 14.4를 참조한다.

| 필요한 저장 형식 | V2 태그 기준 최초 확인 | 직전 V2 태그와 차이 |
| --- | --- | --- |
| `session_message.session_id/type/time_created/data`, assistant `data.finish`와 `data.error` | `v2.0.0` (`63f7ceecbed2d7d9a627518d935dd963b9d4ac9f`) | 최초 V2 태그부터 존재한다. V1 지원 여부와는 별개다. [SFL1][SFL2][SFL3] |
| `credential.integration_id`, JSON `value`의 `{type:"key",key}`, nullable `active`, `auth.json` legacy import | `v2.0.0` (같은 커밋) | 최초 V2 태그부터 존재한다. [SFL4][SFL5][SFL6] |
| `session_message`의 `type:"idle"`, `data.outcome:"failed"` | `v2.0.3` (`d44b52ca66b6bf69626c0384626d1a9cd9555977`) | `v2.0.2`에는 Idle 메시지 타입이 없고 execution failure는 retry 상태만 비운다. [SFL7][SFL7B][SFL8][SFL8B][SFL9] |
| 실패 idle 메시지의 `data.error` | `v2.0.27` (`1f4d07a4a519185955ae8ab2ea3607805509e386`) | `v2.0.26`의 Idle은 outcome만 저장한다. `v2.0.27`은 execution error를 Idle에 함께 저장한다. [SFL10][SFL10B][SFL11][SFL11B][SFL12] |

#### 메시지 테이블과 assistant 오류

**[확인]** `v2.0.0`의 `SessionMessageTable`은 `session_message`에 `id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, JSON `data`를 저장한다. `time_created`는 공통 `Timestamps`에 정의되어 있고, projector는 인코딩한 메시지에서 `id`와 `type`을 분리한 나머지를 `data`에 넣는다. 따라서 메시지 JSON 안의 `type`이 아니라 SQL 행의 `type`으로 assistant/idle을 구분하는 구조다. [SFL1][SFL3][SFL13]

**[확인]** 같은 태그에서 `session.step.failed`는 해당 assistant의 `time.completed`, `finish = event.data.finish ?? "error"`, `error = event.data.error`를 갱신한다. 이 저장 경로가 이미 있다는 사실과 특정 오류 코드/`retryAfterMs`가 그 버전에 존재한다는 사실은 구분해야 한다. 후자는 14.1–14.2의 공급자 오류 도입 경계가 결정한다. [SFL2]

**[확인]** assistant 행의 SQL `time_created`는 오류 발생 시각이 아니라 `message.time.created`에서 나온다. 실패 업데이트는 `data.time.completed`를 실패 이벤트 시각으로 바꾸고, SQL `time_created`는 계속 메시지 생성 시각을 반영한다. 따라서 저장된 `retryAfterMs`를 절대 재개 시각으로 바꿀 때 assistant 행의 `time_created + retryAfterMs`를 사용하면 안 된다. [SFL2][SFL3]

**[추론·제안]** 메시지에서 상대 재시도 지연을 읽는 구현은 해당 오류가 기록된 terminal 시각(assistant의 `data.time.completed`, 또는 오류를 포함하는 idle의 실패 이벤트 생성 시각)을 함께 검증해야 한다. `retryAfterMs`를 DB를 읽은 현재 시각에 다시 더하는 것도 원래의 reset 시각을 뒤로 미룬다. 구체적인 기준 시각 및 누락 처리 계약을 구현 전에 정해야 한다.

**[확인]** `session_v2.idle_outcome` 열은 `v2.0.0`에도 있으며 projector는 execution failure를 `"failed"`로 기록한다. 반면 **`session_message` 안의 idle 메시지**는 `v2.0.3`부터다. 두 저장소를 같은 도입 시점으로 취급하면 안 된다. [SFL1][SFL3][SFL7][SFL7B][SFL8][SFL8B]

**[확인]** idle 메시지는 commit `2816d1c849cc1a103f90e0215966c8080d65e95f`의 `feat(session): add turn diff route (#47821)`에서 도입되었고, `session.execution.failed`를 `idle("failed")`로 투영한다. 별도 commit `40cc0f377bb30c35ad56bebfc57de83097e70995`의 `fix: surface session execution errors in desktop and TUI timelines (#53826)`가 optional Idle.error와 `idle("failed", event.data.error)`를 추가했다. [SFL9][SFL12]

#### credential과 legacy import

**[확인]** 최초 V2 태그의 credential 테이블은 현재 필요한 `integration_id`, JSON `value`, nullable boolean `active` 열을 이미 갖고 있다. 키 값의 discriminator는 `type:"key"`이고 실제 키는 `key` 필드다. legacy importer는 `$data/auth.json`의 최상위 객체를 integration ID → credential 값으로 읽고, 기존 `{type:"api",key}`를 `{type:"key",key}`로 변환해 SQL `value`에 JSON으로 넣는다. integration ID의 뒤쪽 `/`도 제거하며 해당 integration의 SQL 행이 이미 있으면 import를 건너뛴다. [SFL4][SFL5][SFL6]

**[확인]** 해당 importer의 INSERT는 `active`를 명시하지 않는다. 최초 V2 및 `v2.2.5`의 `Credential.list`는 `active`, `time_created`, `id`를 오름차순으로 정렬하고, integration의 connection resolver는 그 목록을 역순으로 바꾼 뒤 첫 항목을 선택한다. 따라서 OpenCode의 ‘선택된 credential’을 재현하려면 `active = 1` 조건만으로 조회하면 안 된다. legacy의 `active IS NULL`인 행도 최신 행 선택의 대상이다. SQL에서 같은 선택을 재현한다면 integration ID를 먼저 제한한 뒤 `ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`에 해당한다. [SFL6][SFL14][SFL15][SFL15B]

**[추론·제안]** Go usage 조회용 키를 읽을 때는 위 선택 규칙으로 `integration_id = 'opencode-go'`의 선택된 행을 정하고, 그 행의 `value.type === 'key'` 및 문자열 `value.key`를 확인한다. 선택된 행이 다른 credential 종류라면 다음 API key 행으로 임의 fallback하지 않는다. `auth.json`의 legacy `type:"api"`를 SQL JSON의 현재 discriminator로 혼동하지 않는다. 이 조사는 공식 소스만 읽었으며 실제 auth 파일·DB·키를 조회하거나 usage API를 호출하지 않았다.

**[추론·제안]** 위 표의 `v2.0.0`/`v2.0.3`/`v2.0.27`은 저장 형식을 읽기 위한 개별 경계다. 실제 기능의 최소 지원 버전은 무료 오류 코드 및 Go usage 경계까지 함께 만족해야 하므로, 이 중 어느 하나를 단독으로 제품 최소 버전으로 정할 수 없다.

### 14.4 Paseo 2.0.10 하한, `--version`, channel·prerelease

**[확인] Paseo 0.15의 `MINIMUM_V2=[0,10]`은 V2 transport/SDK 어댑터의 하한이다.** 코드 주석도 CI에서 다룬 SDK와 binary에 맞춘 최소값이라고 설명한다. 이 검사는 Go/free 전용 오류·현재 문구·DB reader 계약의 존재까지 검사하지 않는다. 따라서 `2.0.10 <= version < 2.2.2`는 Paseo가 V2로 연결할 수 있는 구간이지만, 이번 Auto Resume의 전체 계약을 갖춘 구간은 아니다. 명시적/발견된 외부 server는 로컬 binary probe보다 먼저 V2 어댑터를 선택하며, probe 실패·형식 불일치는 legacy fallback으로 이어질 수 있다. [VFL1]

**[확인·고정 소스와 기존 로컬 관찰]** 최초 V2 tag 2.0.0, Paseo 하한 2.0.10, 권장 하한 2.2.2의 CLI entrypoint는 모두 `Runtime.run(...,{version:OPENCODE_VERSION})`를 호출하고 root command 이름은 `opencode`다. Effect CLI의 `Command.run`에 version을 전달하는 구조도 같다. 앞선 설치 2.2.5의 격리 `--version` 관측은 **`opencode v2.2.5`**였다. 이 source wiring은 같은 name+version 출력 계열을 뒷받침하지만, 과거 모든 platform별 release binary를 실행해 확인한 주장은 아니다. [VFL2][VFL3][VFL4][VFL5][VFL6][I3]

**[확인] stable과 preview의 version 생성은 다르다.** 빌드는 `Script.version`과 `Script.channel`을 별도 상수로 넣는다. `packages/script/src/index.ts`는 명시적 `OPENCODE_VERSION`을 우선하고, preview 기본 version은 `0.0.0-<channel>-<build number>`다. build number는 CI run number(재실행이면 `.attempt`) 또는 분 단위 UTC 날짜이며, 로컬 source에서 version 상수가 주입되지 않으면 CLI의 fallback은 `local`이다. 그러므로 V2 소스로 빌드했다는 사실이 반드시 `2.x.y` 출력이라는 뜻은 아니다. [VFL7][VFL8][VFL9]

| 출력 형태 | source/관측 상태 | Auto Resume 판정 제안 |
| --- | --- | --- |
| `opencode v2.2.5` | 이 호스트의 기존 관측 | V2 하한 비교 대상 |
| `opencode v2.2.2` | stable 2.2.2의 version/root wiring에 따른 형태 | 하한과 같아 허용 대상 |
| `2.2.2`, `v2.2.2` | Paseo parser가 허용하는 대체 형식; 공식 binary 실측이라고 주장하지 않음 | anchored parser가 지원할 수 있음 |
| `opencode v0.0.0-dev-<run>`, `…-beta-<run>` | preview 생성 규칙의 예시; 해당 binary 관측값 아님 | V2 feature 포함 여부를 숫자로 증명할 수 없어 기본 지원 제외 |
| `opencode v2.2.2-beta.1`, 더 높은 numeric version의 prerelease | 명시적 version override로 만들 수 있는 예시; 이 이름의 공식 release가 있다는 뜻은 아님 | stable-first 정책에서 제외 |
| `opencode vlocal` 또는 `local` 포함 출력 | 주입 상수 없는 source fallback; 정확한 prefix는 runtime formatter에 의존 | 확인 불가로 제외 |
| 1.x / 3.x / 실행 실패 / 추가 문구가 섞여 유효한 단일 version이 아님 | 요구 범위 밖 또는 판별 불가 | 자동 재개 지원으로 판정하지 않음 |

**[추론·제안] 파싱과 지원 정책을 분리한다.** optional `opencode`/`v` prefix 뒤 전체 SemVer를 읽고, **major=2, stable numeric version>=2.2.2**를 기본 조건으로 둔다. `+build` metadata는 SemVer 비교의 우선순위를 바꾸지 않지만 source·schema 확인을 대신하지 않는다. `-prerelease` 또는 `0.0.0-<channel>`을 suffix만 잘라 stable로 승격시키지 않는다. Paseo parser의 suffix 허용은 그 버전의 Auto Resume 지원 증거가 아니며, Antigravity의 숫자 비교를 그대로 복사해 더 높은 prerelease까지 자동 허용할 필요도 없다. 이는 구현 제안이고 코드는 수정하지 않았다. [VFL1][VFL7]

**[미확인]** 과거 모든 플랫폼의 `--version` 실제 출력과 preview release별 기능 포함은 실행하지 않았다. 현재 조사한 2.x release 이후의 3.x, custom fork·wrapper, 동일 숫자를 보고하는 다른 DB writer도 지원된다고 단정하지 않는다. 실제 세션이 remote/reused server를 사용하면 **로컬 CLI 버전만으로 그 서버와 DB의 버전까지 판정할 수 없다**는 기존 scope 확인 요구도 유지한다.

### 14.5 권장 floor: OpenCode **2.2.2**

**[추론·제안] 하나의 공통 최소 지원 버전은 `SUPPORT_FLOOR=[2,2,2]`로 권장한다.** 범위는 OpenCode **V2 stable 2.x**이며 V1은 지원 대상에서 제외한다. floor를 결정하는 기능은 **Go 전용 `provider.go-limit`와 현재 `OpenCode Go[ <limitName>] usage limit reached. …` 문구의 최초 release 포함**이다. 무료 오류/DB 시간 reader의 필요한 계약은 2.1.2에 이미 있고 credential·session schema도 더 이르므로 2.2.2가 전체 요구의 최댓값이다. 설치 2.2.5는 이 하한을 넘는다. [EFL1][EFL4][SFL1][VFL10]

**[확인·조사 범위]** 이 권장은 공식 tag의 고정 소스와 포함 커밋을 대조한 **기능 하한**이다. 2.2.2의 Paseo 실행·모델 오류·실계정 사용량을 이번에 재현한 결과는 아니다. 모델 호출, 로그인, usage API 요청, 비밀 값 열람, DB 실데이터 조회, Paseo 기동, 코드 변경은 하지 않았다. GitHub의 tag와 release 게시물도 구분했다. 초기 2.0.0은 공식 tag가 있지만 이번 `releases/tags/v2.0.0` 조회는 404였으므로, 과거 GitHub Release 게시물의 존재·게시 시각까지 확인했다고 적지 않는다. 2.2.2의 공식 release는 확인했다. [VFL10]

[D1]: https://opencode.ai/v2/docs/console/go/
[D2]: https://opencode.ai/v2/docs/console/models/
[D3]: https://opencode.ai/v2/docs/console/api/inference/
[D4]: https://opencode.ai/docs/server/
[D5]: https://opencode.ai/docs/sdk/
[D6]: https://opencode.ai/v2/docs/build/client/
[D7]: https://opencode.ai/v2/docs/console/
[D8]: https://opencode.ai/v2/docs/console/harnesses/
[D9]: https://github.com/anomalyco/opencode/pull/60284
[D10]: https://opencode.ai/v2/docs/build/plugins/server/
[D11]: https://opencode.ai/v2/docs/build/sdk/
[D12]: https://opencode.ai/v2/docs/cli/commands/
[D13]: https://opencode.ai/docs/plugins/
[D14]: https://opencode.ai/docs/
[D15]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/cli/package.json
[O2]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/session/to-session-error.ts
[O3]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/schema/src/session-error.ts
[O4]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/ai/src/provider-error.ts
[O5]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/usage-limits.ts
[O6]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/protocol/src/groups/usage.ts
[O7]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/schema/src/usage-limits.ts
[O8]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/model-retry.ts
[O9]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/session/runner/retry.ts
[O10]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/schema/src/session-event.ts
[O11]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/protocol/src/groups/session.ts
[O12]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/services/www/src/docs/content/config.mdx
[O13]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/services/www/src/docs/content/cli/config.mdx
[O14]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/credential.ts
[O15]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/integration.ts
[H1]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/opencode/src/session/retry.ts
[H2]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/core/src/subscription.ts
[H3]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/app/src/routes/zen/go/v1/usage.ts
[P1]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/providers/opencode-agent.ts
[P2]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/providers/opencode/runtime-client.ts
[P3]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/providers/opencode/v2/turns.ts
[P4]: https://github.com/getpaseo/paseo/blob/v0.15.0/plugins/opencode-go-usage-source/server/usage.ts
[P5]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/providers/opencode/v2/usage.ts
[L1]: ../behavior.md
[L2]: ../../server/subscription.ts
[L3]: ../../shared/settings.ts
[L4]: ../../package.json
[L5]: ../../AGENTS.md
[L7]: ../../server/limit.ts
[F1]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/services/www/src/docs/content/console/models.mdx
[F2]: https://opencode.ai/v2/docs/console/models/
[F3]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/plugin/provider/opencode.ts#L430
[F4]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/opencode/src/provider/provider.ts#L185
[F5]: https://opencode.ai/v2/docs/console/api/inference/
[F6]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/app/src/routes/zen/util/handler.ts
[F7]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/app/src/routes/zen/util/ipRateLimiter.ts
[F8]: https://github.com/anomalyco/opencode/tree/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/console/app/src/routes/zen
[F9]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/core/src/subscription.ts#L9
[F10]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/session/to-session-error.ts
[F11]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/test/session-error.test.ts#L70
[F12]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/app/src/routes/zen/util/error.ts
[F13]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/ai/src/provider-error.ts
[F14]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/ai/src/route/executor.ts#L22
[F15]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/opencode/src/session/retry.ts
[F16]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/ai/src/schema/errors.ts#L197
[F17]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/session/runner/retry.ts
[F18]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/protocol/src/groups/usage.ts
[F19]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/usage-limits.ts
[F20]: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/services/www/src/docs/content/console/api/inference.mdx
[F21]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/provider/opencode.ts#L299
[F22]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/to-session-error.ts
[F23]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/ai/src/provider-error.ts#L89
[F24]: ../../server/agy-usage.ts
[F25]: ../../OVERVIEW.md
[I1]: https://github.com/anomalyco/opencode/commit/9bbb8ce18c80f099e0e448775f59d965ead40a21
[I2]: https://github.com/anomalyco/opencode/releases/tag/v2.2.5
[I3]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/cli/package.json
[I4]: https://github.com/anomalyco/opencode/pull/60284
[I5]: https://github.com/anomalyco/opencode/compare/d9ecbbc874dea02f0efffb4251b4095c0c490f9b...9bbb8ce18c80f099e0e448775f59d965ead40a21
[I6]: https://github.com/anomalyco/opencode/compare/9bbb8ce18c80f099e0e448775f59d965ead40a21...893e8dc43f05e872d4cac603486ce8a7181170fa
[I7]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/to-session-error.ts
[I8]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/providers/opencode/runtime-client.ts
[I9]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/providers/opencode/v2/turns.ts
[I10]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/providers/opencode/v2/timeline.ts
[I11]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/plugins/lifecycle/index.ts
[I12]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/plugin/src/server/lifecycle.ts
[I13]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/agent-manager.ts
[I14]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/test/session-error.test.ts
[I15]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/ai/src/route/executor.ts
[I16]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/ai/src/provider-error.ts
[I17]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/runner/retry.ts
[I18]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/providers/opencode/v2/mapping.ts
[I19]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/providers/opencode/v2/session.ts
[I20]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/model-resolver.ts
[I21]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/provider/opencode.ts
[I22]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/client/src/index.ts
[I23]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/protocol/src/agent-types.ts
[B1]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/credential.ts
[B2]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/credential/sql.ts
[B3]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts
[B4]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/usage-limits.ts
[B5]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/integration.ts
[B6]: https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/app/src/routes/zen/util/handler.ts
[FLOCALDB]: /home/babo/.local/share/opencode/opencode.db
[FLOCALLOG]: /home/babo/.local/share/opencode/log/opencode.log
[EFL1]: https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/to-session-error.ts#L28
[EFL2]: https://github.com/anomalyco/opencode/blob/ba546ec1598a70db2570e9c6258028d955ba8f58/packages/core/src/session/to-session-error.ts#L28
[EFL3]: https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/core/src/session/to-session-error.ts#L40
[EFL4]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/session/to-session-error.ts#L44
[EFL5]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/to-session-error.ts
[EFL6]: https://github.com/anomalyco/opencode/commit/a9fa57b738b4cdc4200e352cafcec99aab8a9ef3
[EFL7]: https://github.com/anomalyco/opencode/compare/a9fa57b738b4cdc4200e352cafcec99aab8a9ef3...a517687fde98a7329ada3ae644a01a9fc6c4e99e
[EFL8]: https://github.com/anomalyco/opencode/commit/80b87629139889ecd8d3b57e690f94d05f6bd745
[EFL9]: https://github.com/anomalyco/opencode/compare/ba546ec1598a70db2570e9c6258028d955ba8f58...a517687fde98a7329ada3ae644a01a9fc6c4e99e
[EFL10]: https://github.com/anomalyco/opencode/commit/3eb834b85ac064d07a1d58044f0c7aa9d78f27b5
[EFL11]: https://github.com/anomalyco/opencode/commit/d9ecbbc874dea02f0efffb4251b4095c0c490f9b
[EFL12]: https://github.com/anomalyco/opencode/compare/3ebcf9a32c7b28f658cfee80775448929361727a...098aa7fd6e02b03d6fc410f0b052038c7d4c5e81
[EFL13]: https://github.com/anomalyco/opencode/compare/3eb834b85ac064d07a1d58044f0c7aa9d78f27b5...098aa7fd6e02b03d6fc410f0b052038c7d4c5e81
[EFL14]: https://github.com/anomalyco/opencode/compare/d9ecbbc874dea02f0efffb4251b4095c0c490f9b...098aa7fd6e02b03d6fc410f0b052038c7d4c5e81
[EFL15]: https://github.com/anomalyco/opencode/releases/tag/v2.2.2
[EFL16]: https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/schema/src/session-error.ts#L7
[EFL17]: https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/runner/step.ts#L181
[EFL18]: https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/runner/publish-llm-event.ts#L413
[EFL19]: https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/execution.ts#L47
[EFL20]: https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/message-updater.ts#L63
[EFL21]: https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/projector.ts#L256
[EFL22]: https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/sql.ts#L79
[EFL23]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/to-session-error.ts#L28
[EFL24]: https://github.com/anomalyco/opencode/blob/ba546ec1598a70db2570e9c6258028d955ba8f58/packages/ai/src/provider-error.ts#L120
[SFL1]: https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/sql.ts#L79
[SFL2]: https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/message-updater.ts#L254
[SFL3]: https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/projector.ts#L386
[SFL4]: https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/credential/sql.ts
[SFL5]: https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/schema/src/credential.ts#L52
[SFL6]: https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts
[SFL7]: https://github.com/anomalyco/opencode/blob/ea5ae2329569e4fbf063be451480b58e29de6816/packages/schema/src/session-message.ts#L283
[SFL7B]: https://github.com/anomalyco/opencode/blob/ea5ae2329569e4fbf063be451480b58e29de6816/packages/core/src/session/message-updater.ts#L128
[SFL8]: https://github.com/anomalyco/opencode/blob/d44b52ca66b6bf69626c0384626d1a9cd9555977/packages/schema/src/session-message.ts#L288
[SFL8B]: https://github.com/anomalyco/opencode/blob/d44b52ca66b6bf69626c0384626d1a9cd9555977/packages/core/src/session/message-updater.ts#L63
[SFL9]: https://github.com/anomalyco/opencode/commit/2816d1c849cc1a103f90e0215966c8080d65e95f
[SFL10]: https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/schema/src/session-message.ts#L288
[SFL10B]: https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/session/message-updater.ts#L63
[SFL11]: https://github.com/anomalyco/opencode/blob/1f4d07a4a519185955ae8ab2ea3607805509e386/packages/schema/src/session-message.ts#L289
[SFL11B]: https://github.com/anomalyco/opencode/blob/1f4d07a4a519185955ae8ab2ea3607805509e386/packages/core/src/session/message-updater.ts#L63
[SFL12]: https://github.com/anomalyco/opencode/commit/40cc0f377bb30c35ad56bebfc57de83097e70995
[SFL13]: https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/database/schema.sql.ts
[SFL14]: https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/credential.ts#L77
[SFL15]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/credential.ts#L112
[SFL15B]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/integration.ts#L409
[VFL1]: https://github.com/getpaseo/paseo/blob/8938fde3c713143f12eacbdd60c11fdfc0be0fb1/packages/server/src/server/agent/providers/opencode/runtime-client.ts
[VFL2]: https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/cli/src/index.ts
[VFL3]: https://github.com/anomalyco/opencode/blob/b8cedc1a7a5e2916bbb65dc1d4b620729c261638/packages/cli/src/index.ts
[VFL4]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/cli/src/index.ts
[VFL5]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/cli/src/commands/commands.ts
[VFL6]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/cli/src/framework/runtime.ts
[VFL7]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/script/src/index.ts
[VFL8]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/cli/script/build.ts
[VFL9]: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/cli/src/version.ts
[VFL10]: https://github.com/anomalyco/opencode/releases/tag/v2.2.2
