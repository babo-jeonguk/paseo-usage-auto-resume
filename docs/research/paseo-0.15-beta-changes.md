# Paseo 0.15 beta: release and behavior research

조사일: 2026-11-02. 대상: Paseo `v0.15.0-beta.1`, 릴리스 페이지 표시 시각 2026-11-01 06:57 UTC, 태그 커밋 약칭 `8bd38fb`. 비교 기준은 직전 stable `v0.14.0`, 플러그인 기준 커밋은 `c63480506a264d171cf625ac7e647f4315512b37`이다. 이 절은 11월 2일 조사 시점의 기록이다. 11월 3일 실제 실행 검증은 [검증 결과](../paseo-0.15-verification.md)에 별도로 기록한다. [공식 릴리스](https://github.com/getpaseo/paseo/releases/tag/v0.15.0-beta.1)

후속 결론: 실행 검증 결과 현재 beta 대응을 위한 플러그인 코드·manifest·의존성 변경은 필요하지 않다. 사용량 조회 설정과 무관하게 기존 동작을 유지하며, 확인한 외부 문제는 관찰 기록으로 남긴다. 아래의 미검증 표현과 검증 계획은 최초 조사 시점의 기록이다. 최종 검증 범위와 정식 버전 확인 계획은 위 검증 문서를 기준으로 한다.

## 릴리스의 큰 변화

- daemon 재시작·크래시 이후 터미널 프로세스를 보존하고, 재시작 전 작업 중이던 에이전트를 같은 대화에서 자동 재개한다.
- 모바일 터미널 렌더링·선택 핸들·스크롤백 복구, 회전 대응이 개선되었다.
- `.worktreeinclude`와 플러그인 worktree 경로·생성 전후 hook이 추가되었다. 새 `server.addHook`, `worktree.create.before`, awaited `worktree.create.after`는 이 플러그인이 현재 사용하는 기능은 아니다.
- usage 요청을 표시 중일 때만 수행하고 host 전체에서 끌 수 있다. 정확한 reset 시각 표시도 추가된다.

위 항목의 출처: [공식 릴리스](https://github.com/getpaseo/paseo/releases/tag/v0.15.0-beta.1).

릴리스 본문만으로 특정 커밋의 포함 여부를 확정하면 안 된다. Paseo는 main의 CHANGELOG 수정 시 기존 prerelease 본문도 갱신한다. 이번 조사는 실제 beta 태그 소스도 대조했다. Codex promptless reopen 수정 #8393은 아래와 같이 태그 구현에서 확인했다. [릴리스 노트 동기화 정책](https://github.com/getpaseo/paseo/blob/main/docs/release.md#release-notes-on-github)

## 플러그인과 겹치는 변경

### 1. host 재시작 자동 재개: 가장 먼저 회귀 검증할 부분

Paseo #8127은 graceful shutdown 시 recovery intent를 저장하고, crash는 저장된 running 상태로 후보를 고른다. 시작 시 다른 경로가 상태를 정리하기 전에 후보를 결정하며, 각 후보를 독립적으로 reopen하여 일반 prompt 경로로 재개한다. 기본값은 켜짐이고 prompt는 `Resume working.`이다. `agents.resumeOnStartup`, `agents.resumePrompt`로 설정한다. idle 에이전트는 대상으로 삼지 않고 archived/private/Hub 소유 작업도 제외한다. 정확히 한 번의 전송이나 durable turn journal은 보장 범위가 아니다. 생성 시 명시한 환경변수도 reopen·refresh에 보존된다. [PR #8127](https://github.com/getpaseo/paseo/pull/8127)

플러그인의 사용량 reset 예약과 이 기능은 트리거가 다르다. 이미 idle/error로 멈춘 limit 예약은 host recovery의 정상 대상이 아니다. 다만 종료 직전 running 상태, 플러그인의 예약 생성·전송 중 daemon 종료, startup scan과 host recovery의 동시 실행은 겹칠 수 있다. 이는 소스 계약에서 도출한 **검증 대상**이며 중복 전송이 재현되었다는 뜻은 아니다.

현재 플러그인은 `agent.turn_started`, `agent.turn_ended`를 관찰하고 마지막 사용자 메시지 시각을 예약 baseline으로 저장한다. 태그의 startup recovery는 별도 source 없이 일반 prompt 함수를 호출하므로 기본 human source를 사용하고 `lastUserMessageAt`도 갱신된다. 현재 플러그인의 새 메시지 guard가 이 변화로 예약을 취소할 수 있다. recovery가 시작되기 전 예약이 먼저 due가 되는 경합과, 전송 중 종료된 예약은 실제 daemon에서 추가 확인해야 한다. [startup 호출](https://github.com/getpaseo/paseo/blob/v0.15.0-beta.1/packages/server/src/server/bootstrap.ts#L1056) · [hook 등록](../../index.server.ts) · [예약과 시작 scan](../../server/resumer.ts) · [due gate](../../server/decisions.ts)

### 2. host의 Check usage off와 플러그인의 직접 조회

#8181은 host 전체에 공유되는 usage switch를 추가한다. 꺼지면 두 daemon usage RPC 모두 discovery/vendor 호출 전에 요청을 거절한다. 기본값은 켜짐이고, 기존 5분 cache는 변경하지 않는다. UI의 조회를 줄이는 부분과 daemon RPC의 정책 enforcement는 별개다. [PR #8181](https://github.com/getpaseo/paseo/pull/8181)

이 플러그인은 daemon usage RPC에 의존하는 대신 provider credential과 실제 CLI/API로 구독·quota를 확인한다. 따라서 host switch를 끈다고 플러그인의 조회도 자동으로 막힌다고 가정하면 안 된다. 이는 API 파손보다는 **제품 정책 결정**이다. **2026-11-03 사용자 결정: Paseo의 사용량 조회 설정과 관계없이 플러그인의 기존 조회·재개 동작을 유지한다.** host switch를 따르는 변경은 하지 않는다. 무조건 모든 자동 재개를 끄면 이미 reset 시각을 아는 예약이나 overload 재시도까지 다른 의미가 될 수 있다. [구독 검사](../../server/subscription.ts) · [quota 조회](../../server/quota.ts) · [CLI 실행](../../server/cli-launch.ts)

### 3. proxy는 중복 구현보다 host 상속 검증

#8177은 fetch dispatcher를 daemon worker뿐 아니라 **플러그인 프로세스 시작에도 설치**한다. `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`와 소문자 변형을 지원하며 loopback은 직접 연결한다. 따라서 플러그인의 전역 `fetch`는 새 host의 proxy 정책을 상속할 것으로 예상된다. 외부 CLI subprocess가 자체적으로 HTTP를 처리하는 경로는 별도로 검증해야 한다. 별도의 plugin proxy dispatcher를 먼저 추가할 근거는 없다. [PR #8177](https://github.com/getpaseo/paseo/pull/8177)

### 4. steer 전송 중 시작 경합이 바뀜

#6192는 `activeTurnBehavior: "steer"` 전송이 이전 turn 시작 도중 들어오면 시작·native turn ID 확정을 기다려 같은 turn으로 보내도록 고친다. 이전 prompt를 대체하여 잃는 문제가 원인이었다. 시작 실패나 turn 종료 시 기다리는 전송도 풀린다. public protocol 변경은 없다. 플러그인의 continue도 steer를 사용하므로 일반 resume과 시작 직전 경합을 확인한다. 플러그인의 agent gate는 여전히 필요하다. [PR #6192](https://github.com/getpaseo/paseo/pull/6192) · [continue 전송](../../server/resumer.ts)

### 5. provider reopen·history 변화

- Codex #8171은 reopen/import 시 전체 history 한 번 읽기를 pagination으로 바꾼다. 큰 기록과 Codex 0.145 이상 paginated thread 호환성 개선이다. 플러그인의 timeline tail 조회 계약을 바꿔야 한다는 근거는 없지만 큰 기록의 resume을 확인할 가치가 있다. [PR #8171](https://github.com/getpaseo/paseo/pull/8171)
- #8278은 앱의 실패한 history load 자동 timer 재시도를 없애고 수동 Retry를 제공한다. provider resume나 저장 방식 변경은 명시적으로 범위 밖이다. 플러그인의 독립적인 timeline 조회 실패 처리를 바꾸는 근거로 확대 해석하지 않는다. [PR #8278](https://github.com/getpaseo/paseo/pull/8278)
- Claude #8148은 Paseo flags가 `extraArgs.settings` 파일/inline 설정을 덮어쓰던 문제를 고친다. 플러그인의 native CLI probe와 실제 에이전트 실행 환경의 일치 여부를 확인할 보조 사례다. [PR #8148](https://github.com/getpaseo/paseo/pull/8148)
- Codex #8393 수정은 **실제 beta 태그에 포함**되어 있다. 0.14에는 없던 `savedThreadId`를 추가하고, rollout이 만들어진 thread만 runtime persistence에 노출한다. prompt 없는 thread를 reopen 때 잘못 resume하지 않도록 예방하는 수정이다. `ensureThreadLoaded()`의 오류 처리만 보면 archived 복구만 남아 있어 놓치기 쉽다. 0.14 대응 문서에 기록한 `no rollout found` 재현 항목을 다시 돌려 기존 제한을 해제할 수 있는지 검증한다. [savedThreadId](https://github.com/getpaseo/paseo/blob/v0.15.0-beta.1/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L3438) · [runtime info gate](https://github.com/getpaseo/paseo/blob/v0.15.0-beta.1/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L4967) · [rollout 이후 저장 표시](https://github.com/getpaseo/paseo/blob/v0.15.0-beta.1/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L6185) · [기존 실패 기록](../paseo-0.14-compatibility.md)

### 6. lifecycle hook 이름은 새 API로 이동하되 기존 API도 유지

태그 SDK는 `server.addHook`를 제공하고, `on`/`before`를 deprecated로 표시한다. 제거 예정은 2027-04-30 이후다. 기존 `agent.turn_started` → `agent.turn.before`, `agent.turn_ended` → `agent.turn.after`, `agent.archived` → `agent.archive.after`, `agent.session_open` → `agent.open.before` 매핑을 유지한다. 따라서 즉시 모든 hook을 바꿀 필요는 없으며 0.11 최소 지원을 유지하려면 추후 adapter 또는 최소 버전 상향과 함께 옮길 수 있다. `timeline`이 빈 배열인 계약은 이미 0.14에도 있었고 플러그인은 `timelineTail()`로 별도 조회하므로 새 파손이 아니다. [태그 SDK 계약과 alias](https://github.com/getpaseo/paseo/blob/v0.15.0-beta.1/packages/plugin/src/server/lifecycle.ts#L153) · [기존 timeline fallback](../../server/resumer.ts)

### 7. 연결 해제 후 플러그인 UI 유지

#8105는 transient host disconnect 때 client plugin을 unload하지 않고 화면·local state·query cache를 보존한다. 재연결 때 catalog를 비교하고 변경된 코드·삭제된 플러그인을 반영한다. 이 플러그인은 목록 query와 note draft를 가지므로, 서버가 재시작해 예약이 변경된 뒤 화면이 재조회되는지 확인한다. mount가 항상 다시 일어난다는 가정에 기대면 안 된다. [PR #8105](https://github.com/getpaseo/paseo/pull/8105) · [화면 query](../../client/screen.tsx) · [note editor](../../client/note-editor.tsx)

## 최초 조사 제안과 후속 결정

1. **호환성 검증:** SDK 0.11 지원을 유지한 채 beta SDK 타입 검사와 실제 beta 실행 검증을 수행한다. 재시작 자동 복구와 기존 예약의 공존, 닫힌 대화의 재개, 첫 prompt 전 Codex reopen 및 브라우저 동작을 확인한다. **11월 3일 사용자 지시에 따라 실패해도 이번에는 코드 수정 없이 문제만 기록한다.**
2. **정책 확정:** 사용량 조회를 꺼도 플러그인은 기존대로 동작한다. 해당 설정을 따르는 패치는 진행하지 않는다. 이번 작업은 검증과 문제 기록에 한정하며 구현·테스트·의존성·빌드 설정을 수정하지 않는다.
3. **회귀 검증 보강:** Claude/Codex/Antigravity의 restart 전후 예약, 전송 중 crash, proxy 환경 fetch와 CLI subprocess, reconnect 화면을 검증한다. API 이름 변경보다 동작 경계 검증이 우선이다.

## 검증 범위와 남은 확인

이 파일은 공식 릴리스 및 upstream PR 설명, 다운로드한 0.14/0.15 beta 태그 소스, 현재 플러그인 코드를 읽은 조사 결과다. PR의 QA 결과는 upstream 저자의 결과이며 이 저장소에서 재실행한 결과가 아니다. 전수 tag diff와 실제 daemon/provider E2E는 이 파일 작성 과정에서 수행하지 않았다. SDK 및 저장소 검증 결과는 별도 아래 기록을 따른다. 따라서 아직 실제 환경에서 “0.15 지원 검증 완료”라고 표시할 근거는 없다. 구현·테스트·빌드 설정은 변경하지 않았다.

### 이번 조사에서 직접 수행한 검증

- 현재 저장소에서 `npm run check`: 타입 검사 및 **536/536 테스트 통과**. 최초 sandbox 실행은 tsx의 IPC 소켓 생성이 `EPERM`으로 막혀 테스트가 실행되지 않았고, 같은 명령을 제한 밖에서 재실행하여 통과했다.
- `/tmp/uar-sdk015-validation/plugin`에 소스를 복사하고 `@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol`을 모두 정확히 `0.15.0-beta.1`로 설치한 격리 환경에서 `npm run check`: 타입 검사 및 **536/536 테스트 통과**. 나머지 의존성과 실행기는 현재 저장소 것을 연결했다. 저장소의 SDK pin/lockfile은 변경하지 않았다.
- 격리 검증 준비 중 첫 타입 검사는 `@types/node`, `@types/react` 누락으로 실패했고, 첫 check는 실행기 `tsc` 누락으로 실패했다. 기존 의존성과 실행기를 연결한 후 최종 검증은 모두 통과했다.
- SDK의 `packages/plugin/src`를 0.14와 beta 태그 사이에서 비교하면 변경 파일은 lifecycle 계약, server export, boundary test다. client contribution 소스는 동일하다. `agents.ref().refresh/send/timeline`, `agents.list`, `config.get`, `providers.snapshot` 호출은 현재 소스 그대로 beta 타입 검사를 통과했다. [0.14 SDK](https://github.com/getpaseo/paseo/tree/v0.14.0/packages/plugin/src) · [beta SDK](https://github.com/getpaseo/paseo/tree/v0.15.0-beta.1/packages/plugin/src)
- 실제 beta daemon 설치/기동, 실제 provider limits, native UI 및 proxy 통합 검증은 수행하지 않았다. 위 테스트 통과는 해당 동작의 검증을 대신하지 않는다.

### 초기 검증안과 현재 작업 범위

**검증만 진행(2026-11-03).** SDK `0.11.0` pin과 최소 Paseo `>=0.11.0`을 유지한다. 기존 E2E 11번(Codex promptless reopen)과 16번(closed 예약)을 beta에서 재실행한다. 추가로 native recovery on/off 각각에서 (a) limit로 멈춘 예약은 reset 전 전송되지 않음, (b) 다른 turn 실행 중 재시작하면 native recovery prompt를 관찰한 오래된 예약은 기존 새 메시지 규칙대로 정리됨, (c) due 시점과 recovery가 겹칠 때 전송 횟수와 history가 일치함을 검증한다. native prompt 문자열을 비교해 예외 처리하거나 host recovery를 플러그인에서 끄지는 않는다. 현재 소스상 native recovery는 사용자 입력 경로를 거쳐 `lastUserMessageAt`을 바꾸므로, 오래된 예약이 `new_message`로 취소될 수 있다. 이 순서의 실제 재현은 남아 있다. [recovery dispatch](https://github.com/getpaseo/paseo/blob/v0.15.0-beta.1/packages/server/src/server/bootstrap.ts#L1056) · [메시지 시각 갱신](https://github.com/getpaseo/paseo/blob/v0.15.0-beta.1/packages/server/src/server/agent/agent-manager.ts#L5075)

**사용량 조회 정책 확정(2026-11-03).** 앞서 제안했던 host 설정에 따른 플러그인 대기는 사용자가 채택하지 않았다. Paseo에서 사용량 조회를 꺼도 플러그인의 계정/사용량 조회, 예약 생성, 수동 및 자동 재개는 기존대로 유지한다. 아래 검증에서 이 동작을 확인하며 코드 변경은 하지 않는다.

**추가 관찰만 할 부분.** 화면은 이미 30초, conversation controls는 10초 간격으로 조회하므로 reconnect 즉시 새로운 구독 체계를 만들기보다 해당 주기 안에 갱신되는지 확인한다. 긴 timeline은 잘린 문자열에도 limit/overload 판별이 동작하는지 확인한다. beta는 큰 항목의 문자열을 자르므로 후반부에만 있는 notice가 사라질 가능성은 있지만, 현재 오탐/누락을 재현한 것은 아니다. proxy는 host가 설치한 dispatcher를 사용하고 CLI subprocess만 별도로 확인한다. hook API 이전은 제거 일정 전에 adapter 또는 지원 버전 정책과 함께 별도 작업으로 진행한다. [timeline 제한 #8274](https://github.com/getpaseo/paseo/pull/8274) · [현재 화면](../../client/screen.tsx) · [현재 composer controls](../../client/conversations.ts)
