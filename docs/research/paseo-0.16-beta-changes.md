# Paseo 0.16 beta: 릴리스와 동작 변경 조사

조사일: 2026-11-11. 공식 upstream은 `getpaseo/paseo`이며, 조사 시점의 0.16 태그는 **`v0.16.0-beta.1` 하나**다. GitHub 릴리스 공개 시각은 2026-11-10 12:13 UTC이고 prerelease로 표시된다. 릴리스 본문은 나중에 바뀔 수 있으므로 아래 판단은 내려받은 **태그 소스**를 기준으로 한다. [공식 beta 릴리스](https://github.com/getpaseo/paseo/releases/tag/v0.16.0-beta.1), [릴리스 노트 동기화 정책](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/docs/release.md#release-notes-on-github)

## 현재 프로젝트에 대한 판단

플러그인 `1.3.2`, 기준 commit `74a6a7d`의 소스와 대조했다. 현재까지 **즉시 실행 코드·manifest·의존성을 변경해야 할 파손은 발견하지 못했다.** 실제 beta 실행 호환성 인증은 아니다.

- Claude의 `failed` 이벤트는 이미 `outcome.error.message`로 제한을 감지하며, startup scan도 `error` 상태의 `lastError`를 읽는다. 정상 완료 + 마지막 assistant notice 경로도 남아 있어 이전 Paseo 지원을 유지한다. [감지 코드](../../server/limit.ts), [hook 처리와 scan](../../server/resumer.ts)
- Claude 과부하 재시도 역시 failed 오류 문구와 `overloaded_error` code 경로가 있어 새 실패 보고를 처리할 수 있다. 기존 completed notice 전용이라는 주석은 이전 버전 설명이며 beta에서는 failed 경로가 중요하다. [과부하 감지](../../server/overload.ts)
- startup scan은 이미 `includeBackground: true`를 사용한다. 일반 lifecycle hook이 유지되고 beta host가 새 client를 주입하므로 background helper도 기존 예약 정책의 대상이 될 것으로 예상한다. 실제 숨겨진 helper의 재시작 후 재발견은 미검증이다. [scan](../../server/resumer.ts), [호출부 회귀 테스트](../../server/resumer.test.ts)
- 기존 `addComposerPill`과 RPC polling을 유지할 수 있다. subscription으로 10초/30초 polling을 줄이는 것은 선택적 개선이며, 현재 최소 지원 Paseo 0.11을 유지하려면 capability 분기 또는 지원 버전 정책이 필요하다. [작성창 버튼](../../client/conversations.ts), [목록 화면](../../client/screen.tsx)
- 새 `fx` 제공자는 현재 지원 CLI 네 종류에 포함되지 않으므로 자동 지원 대상이 되지 않는다. [지원 목록](../../shared/settings.ts), [제공자 판별](../../server/providers.ts), [fx 추가](https://github.com/getpaseo/paseo/pull/9160)

실제 beta 실행 검증의 우선순위는 (1) Claude 제한·529가 failed로 끝나도 예약 생성·재개·정리되는지, (2) recovery on/off에서 기존 예약과 host 복구가 겹치는지, (3) 숨겨진 background helper의 제한과 재시작 후 scan, (4) 동시 plugin 시작 시 초기 발견과 재연결 후 작성창·목록·설정 UI다. OpenCode 재시작 중 상태 및 기존 Antigravity 오류 재전달도 재확인 대상이다. 위 위험은 소스에서 도출한 검증 항목이며 이번에 회귀를 재현했다는 뜻은 아니다.

## 비교 기준

`git ls-remote --tags https://github.com/getpaseo/paseo.git 'v0.16*' 'v0.15*'`로 annotated tag와 실제 commit을 구분해 확인했다.

| 대상 | 실제 commit SHA | 용도 |
|---|---|---|
| `v0.16.0-beta.1` | `5196801fdfdad4c954bd37016c57745b07aba430` | 조사 대상 |
| `v0.15.4` | `1c00b365c9e0b74c1580eba33d905d693125ae21` | 조사 시점의 최신 0.15 stable, 직접 소스 비교 기준 |
| `v0.15.0` | `8938fde3c713143f12eacbdd60c11fdfc0be0fb1` | 이 저장소의 기존 정식 버전 조사 기준 |

출처: [beta commit](https://github.com/getpaseo/paseo/commit/5196801fdfdad4c954bd37016c57745b07aba430), [0.15.4 commit](https://github.com/getpaseo/paseo/commit/1c00b365c9e0b74c1580eba33d905d693125ae21), [0.15.0 commit](https://github.com/getpaseo/paseo/commit/8938fde3c713143f12eacbdd60c11fdfc0be0fb1).

0.15.1은 Windows daemon 시작 실패, 0.15.2는 초기 설정 UI, 0.15.3은 iOS 키보드 표시를 수정했다. 0.15.4의 Claude Fable/Mythos 5.2 추가는 beta에도 포함되지만 이미 stable에 배포된 변경이다. 두 모델은 Claude Code 2.1.321 이상이 필요하고 Mythos는 접근 권한을 CLI가 광고해야 나타난다. 이 내용을 0.16만의 새 제한 감지 기능으로 해석하지 않는다. [태그 changelog의 0.15 항목](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/CHANGELOG.md#0154---2026-11-10)

## 플러그인에 가장 직접적인 변화

### Claude 제한·overload가 정상 완료 대신 실패로 보고됨

`#8480`의 구현은 실제 beta 태그에 있다. Claude Code가 `result.subtype: "success"`와 `is_error: true`를 함께 보내면 이제 `turn_failed`를 발행한다. 오류는 `result` 문자열, 보류했던 오류 reply, `Claude run failed` 순서로 선택하며 usage도 보존한다. 이전 stable의 같은 분기는 `turn_completed`로 끝났다. 따라서 Claude 제한 종료가 이제 `error` 상태와 `lastError`로 관찰될 수 있다. [변경 PR](https://github.com/getpaseo/paseo/pull/8480), [beta 결과 변환](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/providers/claude/agent.ts#L5081), [stable 결과 변환](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/server/src/server/agent/providers/claude/agent.ts)

오류 문구의 위치도 바뀐다. `message.error`가 붙은 synthetic assistant reply는 최종 결과까지 보류하고, 실제 실패이면 기존 failure 경로로 한 번만 표시한다. beta의 테스트는 session limit과 `API Error: 529 Overloaded`가 `turn_failed.error`에 남으며 오류 assistant message는 없는 것을 명시적으로 검증한다. 도중 오류를 회복해 성공한 turn은 그 reply를 다시 공개한다. 따라서 **assistant timeline만 읽어야 한다는 가정은 위험하며 hook의 실패 오류 및 snapshot의 `lastError` 경로가 중요하다.** 이는 감지 입력에 관한 소스 분석이고, 실제 제한 발생을 이 조사에서 재현한 결과는 아니다. [보류 처리](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/providers/claude/agent.ts#L4481), [upstream 회귀 테스트](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/providers/claude/agent.error-result.test.ts#L135)

### Claude graceful restart recovery 수정

`#8686`은 기존에 관찰한 “recovery를 켰는데 graceful stop 뒤 Claude 작업이 재개되지 않음”과 같은 원인을 수정한다. 종전 `close()`가 사용자 취소 callback을 실행해 idle snapshot을 발행하면서 종료 직전에 저장한 recovery intent를 지웠다. beta는 runtime 해제와 사용자 취소를 구분하고 tool cleanup을 발행한 뒤, AgentManager가 해당 이벤트를 drain하고 session을 닫힌 상태로 바꾼다. 비동기 실행 옵션 준비 도중 session이 닫힌 경우 새 query 생성을 거절하는 guard도 있다. **태그의 구현 포함은 확인했지만 실제 daemon 재시작 재현은 별도다.** [변경 PR](https://github.com/getpaseo/paseo/pull/8686), [Claude close](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/providers/claude/agent.ts#L3067), [query 수명 guard](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/providers/claude/agent.ts#L3577), [runtime 해제](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/agent-manager.ts)

host recovery는 여전히 `resumeOnStartup === true`일 때만 켜진다. beta가 recovery를 다시 기본 켜짐으로 바꾼 것은 아니다. 후보 복구는 일반 prompt 경로를 사용하므로 플러그인의 사용량 reset 재개와 서로 다른 트리거라는 기존 구분도 유지된다. [설정 판정](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/bootstrap.ts#L1047), [복구 모듈](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/restart-recovery/index.ts), [이전 검증](../paseo-0.15-verification.md)

### 새 turn의 오래된 실패 상태 정리

`#8083`은 새로운 foreground turn이 수락될 때 이전 attention을 지우며, autonomous turn 시작에서는 `lastError`도 지운다. 성공한 재개 뒤에도 snapshot이 계속 이전 실패로 보이는 문제를 고친다. 오래된 snapshot 오류가 언제 사라지는지, 재개가 실제 수락됐는지에 영향을 주지만 오류 문구를 새로 정규화하는 기능은 아니다. [변경 PR](https://github.com/getpaseo/paseo/pull/8083), [foreground 수락](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/agent-manager.ts#L3257), [autonomous 시작](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/agent-manager.ts#L5427)

## Background agent와 background task는 구분해야 함

`#8683`은 생성 시 고정되는 `agent.background`를 추가한다. 실효 background는 agent 또는 workspace의 flag로 결정한다. 기본 목록·History에서 숨기고 notification과 attention을 억제하지만 **history, plugin hook, archive, restart recovery는 일반 durable agent와 같다.** `includeBackground` 목록과 정확한 ID 조회의 의미를 구분해야 한다. [변경 PR](https://github.com/getpaseo/paseo/pull/8683), [태그의 visibility 계약](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/docs/agent-lifecycle.md#background-visibility)

새 agent 단위 background를 포함한 discovery는 `background_agents` hello capability도 요구한다. 오래된 클라이언트는 `includeBackground: true`여도 workspace 단위 background만 포함한다. 다만 **현재 플러그인의 개발 의존성 0.11 pin을 runtime 클라이언트 버전으로 볼 수는 없다.** beta host의 plugin process가 host에 번들된 `DaemonClient`와 `createPaseoApi`를 직접 생성하고, 새 client는 해당 capability를 광고한다. 이 플러그인은 서버 SDK를 type으로만 가져오며 host가 주입한 `paseo`를 쓴다. 따라서 SDK pin만을 이유로 startup scan에서 새 background agent가 빠진다고 결론 내릴 근거는 없다. [host의 API 생성](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/plugins/plugin-process.ts#L307), [capability 광고](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/client/src/connection/index.ts#L148), [현재 진입점](../../index.server.ts), [현재 startup scan](../../server/resumer.ts)

별도로 `#6220`/`#9162`는 Claude/Codex/OpenCode v2가 실행하는 shell·monitor 등의 **background work inventory와 Stop UI**를 추가한다. background helper agent 생성과 다른 기능이다. idle agent도 background work를 가질 수 있고, runtime cleanup은 이를 보존하도록 provider의 안전성 검사를 받는다. UI에 background work가 있다는 이유만으로 agent의 turn lifecycle이 running이라고 단정할 수 없다. 제한 재개 gate를 바꿀 근거로 사용하려면 실제 provider 상태와 전송 의미를 검증해야 한다. [background work와 runtime 수명](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/docs/agent-lifecycle.md), [클라이언트 background work handle](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/client/src/index.ts#L380)

## 플러그인 API와 시작 방식

- **기존 lifecycle 이름 유지:** `server.on`/`server.before` alias와 2027-04-30 이후 제거 예정 표시는 그대로다. `agent.turn_started`/`agent.turn_ended`를 즉시 변경해야 하는 제거는 없다. 태그 사이 lifecycle SDK 변경은 agent/workspace metadata와 hook request의 metadata 반환 계약 추가다. [lifecycle SDK](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/plugin/src/server/lifecycle.ts#L170)
- **composer·sidebar 확장:** `addComposerItem`, `addNewWorkspaceItem`, `addSidebarView`, composer draft/attachments/provider/model/mode/thinking 접근과 focus 등이 추가된다. 기존 composer pill·settings screen 등록도 남아 있다. 새 기능이 있다는 이유로 현재 UI를 반드시 다시 작성해야 하는 것은 아니다. [client 계약](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/plugin/src/client/contracts.ts), [composer API](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/plugin/src/client/composer.tsx)
- **실시간 plugin subscription 및 binary payload:** daemon→plugin panel stream과 `Uint8Array` RPC/event를 추가한다. reconnect 뒤 재구독하고 plugin 종료 시 정리하는 계약이다. 기존 request/response RPC가 제거되지는 않았다. Zod transform을 쓰는 RPC input/output 처리도 수정됐다. [RPC SDK](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/plugin/src/rpc.ts), [서버 subscription 계약](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/plugin/src/server/contracts.ts), [client subscription 계약](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/plugin/src/client/contracts.ts#L240)
- **설정된 플러그인 동시 시작:** `#8427`은 plugin process 시작을 병렬화한다. 소스의 `publishTurn`/`earlierPublished`는 provider 등록 공개 순서를 보존한다. “모든 plugin이 이전 순서대로 완전히 기동한 뒤 내 초기 scan이 실행됨”이라는 가정은 유지되지 않으므로 다른 provider plugin의 준비 상태를 보는 scan은 실제 host에서 확인할 가치가 있다. 이것이 현재 플러그인의 startup 누락을 재현했다는 뜻은 아니다. [시작 구현](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/plugins/index.ts#L220), [등록 공개 순서](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/plugins/index.ts#L576)
- **manifest 호환성 검사 동일:** `plugin-requirements.ts`는 0.15.4와 파일 차이가 없다. prerelease의 stable core도 range와 비교하므로 현재 `>=0.11.0`은 beta를 허용한다. 실제 SDK 타입 호환성은 별도 검증 결과로 판단한다. [요구 버전 검사](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/protocol/src/plugin-requirements.ts#L22), [현재 manifest](../../paseo-plugin.json)

## 사용량 조회와 제공자별 보조 변화

daemon의 `session/usage/usage-session.ts`는 0.15.4와 동일하다. sidebar usage summary는 panel과 앱이 표시 중일 때 polling하도록 바뀐다. host의 표시용 usage 설정을 플러그인의 직접 quota 조회에 새로 강제하는 변화는 이 경로에서 발견하지 못했다. Paseo의 usage 설정과 관계없이 플러그인 조회·재개를 유지한다는 기존 결정은 이 조사로 바뀌지 않는다. [usage RPC 구현](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/session/usage/usage-session.ts), [sidebar polling](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/app/src/usage/sidebar-item.tsx#L39), [기존 정책 결정](../paseo-0.15-verification.md#사용량-조회를-끈-상태)

| 제공자/경로 | 확인한 변경과 검증 의미 |
|---|---|
| Claude | 위 API 오류·graceful recovery 외에 idle reopen 시 query/process 해제 지연을 고쳤다. 매우 큰 transcript의 import가 전체 문자열 크기 한도에 걸리지 않도록 title 스캔도 chunk 방식으로 바뀐다. [close 구현](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/providers/claude/agent.ts#L3097), [title 스캔](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/agent/providers/claude/agent.ts) |
| Codex | Stop/interrupt 뒤 shell command가 남는 문제와 동시 작업 시 SQLite 초기화 경합을 수정한다. quota endpoint나 reset 문구 변경이라고 볼 근거는 없다. [shell 중단 PR #7525](https://github.com/getpaseo/paseo/pull/7525), [SQLite PR #9008](https://github.com/getpaseo/paseo/pull/9008) |
| OpenCode v2 | daemon 재시작 도중 진행 중인 turn이 idle로 보이고 Stop이 무시되던 문제를 수정한다. idle/error만 대상으로 하는 기존 scan과 실제 상태 갱신 순서를 검증할 가치가 있다. [PR #8698](https://github.com/getpaseo/paseo/pull/8698), [태그 구현](https://github.com/getpaseo/paseo/tree/v0.16.0-beta.1/packages/server/src/server/agent/providers/opencode/v2) |
| ACP | provider process가 끝난 뒤 전송하면 running에 머무르던 것을 오류로 끝내고, 끝난 turn의 abandoned approval도 정리한다. Antigravity 관련 오류 분류를 바꾼다는 뜻은 아니다. [전송 오류 PR #8406](https://github.com/getpaseo/paseo/pull/8406), [approval PR #8548](https://github.com/getpaseo/paseo/pull/8548) |
| Antigravity | `plugins/antigravity-provider`는 두 태그에서 파일 차이가 **없다**. 기존에 기록한 이전 limit 오류 재전달이 수정됐다고 보고할 근거를 찾지 못했다. 실제 agy 바이너리 버전의 효과는 별도다. [stable 소스](https://github.com/getpaseo/paseo/tree/v0.15.4/plugins/antigravity-provider), [beta 소스](https://github.com/getpaseo/paseo/tree/v0.16.0-beta.1/plugins/antigravity-provider) |

## 설치와 앱/host 버전

beta를 명시적으로 설치하려면 `npm install -g @getpaseo/cli@0.16.0-beta.1`로 버전을 고정할 수 있다. `@beta`는 이동하는 dist-tag이고 plain install은 stable `latest`를 따른다. Desktop은 beta update channel 또는 beta 다운로드를 이용한다. 이 조사에서는 실제 사용자 설치를 변경하지 않았다. [태그의 배포 채널 문서](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/docs/release.md#beta-flow)

공식 노트는 background tasks, background agents, plugin subscriptions 등 새 기능에 **host와 app 모두 이 버전**이 필요하다고 명시한다. host만 올리고 stable 웹 앱으로 새 composer/sidebar 기능까지 검증했다고 볼 수 없다. registry mirror 사용 시 `npm artifact changed since review`로 설치가 실패하던 문제도 수정되며, `@getpaseo/*` package license 필드는 Apache-2.0으로 추가된다. [공식 릴리스의 Plugins/Notes](https://github.com/getpaseo/paseo/releases/tag/v0.16.0-beta.1), [registry 설치 회귀 테스트](https://github.com/getpaseo/paseo/blob/v0.16.0-beta.1/packages/server/src/server/plugins/managed-source.posix.test.ts#L579)

## 조사 범위와 남은 검증

공식 release/PR과 다음 두 tag archive를 읽어 비교했다. broad diff 뒤 관련 파일의 내용을 확인했으며 전체 upstream 변경을 모두 review한 것은 아니다.

```bash
git ls-remote --tags https://github.com/getpaseo/paseo.git 'v0.16*' 'v0.15*'
diff -qr /tmp/uar-paseo016-research/paseo-0.15.4/packages/plugin/src /tmp/uar-paseo016-research/paseo-0.16.0-beta.1/packages/plugin/src
diff -u /tmp/uar-paseo016-research/paseo-0.15.4/packages/server/src/server/agent/providers/claude/agent.ts /tmp/uar-paseo016-research/paseo-0.16.0-beta.1/packages/server/src/server/agent/providers/claude/agent.ts
diff -u /tmp/uar-paseo016-research/paseo-0.15.4/packages/server/src/server/session/usage/usage-session.ts /tmp/uar-paseo016-research/paseo-0.16.0-beta.1/packages/server/src/server/session/usage/usage-session.ts
diff -qr /tmp/uar-paseo016-research/paseo-0.15.4/plugins/antigravity-provider /tmp/uar-paseo016-research/paseo-0.16.0-beta.1/plugins/antigravity-provider
```

태그 조회와 archive 다운로드는 성공했다. 기본 sandbox에서는 GitHub DNS 조회가 실패해 동일한 공개 source 읽기를 network escalation으로 재실행했다. `diff`의 1은 차이 발견이며 테스트 실패가 아니다. usage RPC, Antigravity 디렉터리 및 requirements 검사 비교는 차이가 없어 0이었다. 일부 최초 파일 탐색은 upstream 경로를 잘못 가정해 `No such file or directory`였고 올바른 위치를 확인해 재조사했다.

이 파일 작성 자체는 **문서와 upstream 소스 조사만** 수행했다. 실제 beta daemon/provider 실행, 실제 limit·overload·reset, restart 동시 전송, background agent startup scan, 모바일/desktop UI 및 proxy 동작은 이 조사로 검증하지 않았다. upstream 테스트 코드를 읽은 것은 그 테스트를 이 환경에서 실행한 것과 다르다. 로컬 플러그인의 SDK 검사·회귀 테스트 결과 및 최종 호환성 판단은 별도 실행 결과와 함께 기록해야 한다.

## 이번 조사에서 직접 실행한 로컬 검증

실행 코드·테스트·manifest·package.json·lockfile은 수정하지 않았다. 저장소 변경은 이 조사 문서뿐이다.

| 환경 | 명령 | 결과 |
|---|---|---|
| 현재 SDK pin 0.11.0 | `npm run check` | 타입 검사 및 **561/561 테스트 통과** |
| 현재 SDK pin 0.11.0 | `npm run test:focus -- server/limit.test.ts server/resumer.test.ts server/decisions.test.ts server/overload.test.ts client/conversations.test.ts` | **206/206 통과** |
| 격리 beta SDK (clean install) | `npm test` | **561/561 통과** |
| 격리 beta SDK (clean install) | `npm run typecheck` | **통과(약 11초, peak RSS 약 476MB)**. 픽스처 6곳의 `PluginHookAgent.metadata` 누락 오류만 남음 |
| 격리 beta SDK (clean install) | 픽스처 `metadata: {}` 추가 후 `npm run check` | **561/561 통과** |
| 문서 | `git diff --check` 및 문서의 줄 끝 공백 검사 | 통과 |

격리 환경은 현재 소스를 새 디렉터리에 복사하고 `@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol`을 정확히 `0.16.0-beta.1`로 설치한 뒤 `npm install`로 의존성 트리를 새로 구성했다. 이전 조사에서 기록한 OOM은 **beta SDK 타입 정의의 문제가 아니라 격리 환경에 zod가 두 벌(4.6.5와 4.6.7) 설치된 구성 문제**였다. SDK가 peer 의존성을 다른 경로에서 찾도록 손으로 연결하면서 zod 사본이 갈라졌고, 그 상태의 타입 검사가 약 2GB를 넘겨 OOM으로 끝났다. zod가 한 벌인 clean install에서는 같은 소스의 beta SDK 타입 검사가 약 11초, peak RSS 약 476MB로 끝난다. `npm ls zod`로 사본이 하나인지 먼저 확인해야 한다.

beta 타입 정의는 `PluginHookAgent.metadata`를 필수로 요구하므로 테스트 픽스처 6곳(당시 `server/claude-keychain.test.ts` 2곳, `server/limit-scenarios.test.ts`, `server/opencode-usage.test.ts`, `server/resumer.test.ts`, `server/subscription-matrix.test.ts`)이 타입 검사에서 걸린다. 캐스트로 숨기지 않고 `metadata: {}`를 넣으면 타입 검사와 **561/561 테스트가 모두 통과한다**. 즉 **0.16 beta SDK로의 상향은 타입 수준에서 가능하며**, 기존 pin을 유지할 기술적 이유는 확인되지 않았다. 실제 beta host 호환성은 여전히 별도 실행 검증으로 판단한다.

임시 로그는 `/tmp/uar016-check.log`, `/tmp/uar016-focus.log`, `/tmp/uar016-sdk-tests.log`, `/tmp/uar016-sdk-check-final.log`이며 환경 정리 때 사라질 수 있다. 핵심 결과는 이 문서에 보존했다.
