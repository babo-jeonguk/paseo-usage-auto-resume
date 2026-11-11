# Paseo 0.16 beta 실행 검증

검증일: 2026-11-11. 대상 Paseo: `0.16.0-beta.1`. 플러그인: `1.4.0`. 제품 코드 커밋 `8118f7c`, 검토 수정 포함 `aefd48d`·`eae21fd`(harness). 이 문서 커밋은 그 뒤에 온다. 이 문서의 결과는 **beta에 대한 것이며 정식 0.16.0 검증 완료를 의미하지 않는다.**

## 호환성 판단과 정식 버전 확인 계획

플러그인 1.4.0은 **Paseo 0.16.0 이상**을 요구한다. `paseo-plugin.json`의 `requirements.paseo`는 `>=0.16.0`이고, 개발 의존성 `@getpaseo/client`, `@getpaseo/plugin`, `@getpaseo/protocol`은 `0.16.0-beta.1`로 정확히 고정했다. 0.11~0.15 지원용 분기와 주석은 제거했다. 1.4.0의 기능은 (1) Paseo 0.16의 background agent/workspace를 다루는 **Resume background agents** 스위치(기본 꺼짐), (2) plugin subscription을 이용한 실시간 갱신, (3) 0.16 SDK 기준 타입·픽스처 정리다.

`0.16.0` 정식 버전이 공개되면 다음을 확인하고, 필요한 변경이 있을 때만 같은 브랜치에 추가한 뒤 메인 병합을 진행한다.

1. `0.16.0-beta.1`부터 정식 태그까지 plugin lifecycle, settings, subscription, background visibility 계약의 변경분을 확인한다.
2. 정식 배포본에서 이 문서의 Phase 7 네 실행(전체, 17·18, OpenCode 19, overload)을 다시 실행한다.
3. Antigravity의 이전 429 재전달과 background agent 목록 노출처럼 남은 관찰 항목이 정식에서 달라졌는지 갱신한다.

`0.16.0-beta.1`은 prerelease지만 SDK pin을 정확히 고정했으므로 이후 beta가 나와도 이 브랜치의 검증 결과는 바뀌지 않는다.

## 1.4.0에서 사용자에게 보이는 변화

- **배경 에이전트 스위치 (기본 꺼짐).** Paseo는 `agent.background || workspace.background`인 에이전트를 목록에서 숨긴다. 1.3.2까지는 이런 에이전트도 제한 후 자동 재개했다. 1.4.0은 기본으로 재개하지 않고, 켜면 다른 에이전트와 똑같이 재개한다. **배경 워크스페이스의 에이전트가 더 이상 기본으로 재개되지 않는 동작 변화**이며, 켜는 즉시 시작 스캔과 같은 놓친 제한 스캔을 실행한다. 끄면 그 에이전트의 대기 중 예약을 `background_off` 사유로 즉시 취소하며, 예약을 계획하는 중에 끄더라도 저장 직후 취소한다.
- **실시간 갱신.** 예약·결과가 저장되면 plugin subscription(`auto-resume.changes`)이 revision을 push하고, Auto Resume 화면·대화 팝오버·작성창 pill이 기존 목록 RPC로 바로 다시 읽는다. 2분 주기 전체 새로고침은 이름·위치가 바뀐 에이전트를 위한 안전망으로 남는다.
- **Paseo 0.16 이상 요구.** 0.15 이하 daemon에는 설치되지 않는다.

## 작업 범위와 확정한 동작

이 작업은 Paseo 0.16 beta에서 1.3.2가 실제로 동작하는지 먼저 확인하고(구현 전 검증), 그 결과에 맞춰 1.4.0을 구현한 뒤 다시 전체 검증했다. 구현 전 검증은 제품 코드·테스트·의존성을 수정하지 않았고, 변경은 `/tmp/uar016-harness2/e2e` 사본에만 있었다. 구현 단계의 결정은 다음과 같다.

- 배경 에이전트 판정은 Paseo 정의(`agent.background || workspace.background`)를 그대로 쓴다. hook payload에는 background 필드가 없으므로 agent snapshot과 `api.workspaces.ref(id).refresh()`의 `background`를 읽는다. workspace를 읽지 못하면 agent 자신의 flag로 결정하고 한 번만 기록한다.
- 설정 파일 버전은 **2를 유지**했다. 0.16의 `PluginSettingsStore`는 저장된 version이 현재 version과 같으면 `schema.parseAsync(values)`를 그대로 실행하므로, `resumeBackground`가 없는 기존 version 2 파일은 zod default인 `false`로 읽힌다. 마이그레이션이 필요 없다.
- 예약 행에는 `background?: boolean`을 추가했다. 이 버전이 만드는 배경 예약은 `true`를 저장하고, 예전 행(플래그 없음)은 전달 시점에 agent를 읽어 판정한다. 전달 시점의 배경 판정은 agent 상태 확인보다 먼저 하며, 저장된 플래그가 있으면 agent가 사라졌어도 그 플래그로 결정한다. 1.3.2로 되돌리면 이 키는 무시된다.
- 저장소 쓰기 알림은 **파일을 실제로 바꾼 쓰기**에만 붙였다(no-op update는 알리지 않음). job/history 어느 쪽이 바뀌어도 revision이 오른다.

## 실행 환경과 검증의 한계

- Linux, Node `v24.21.0`, Claude Code `2.1.321`, Codex CLI `0.167.0`, Antigravity CLI `1.5.5`, OpenCode `2.2.6`, Playwright `1.65.0`.
- npm에 배포된 실제 Paseo `0.16.0-beta.1`을 `/tmp/paseo-0.16.0-beta.1`에 설치했다. 각 실행은 별도 home·port·작업 디렉터리를 썼고, 사용자의 라이브 daemon(port 6767, `~/.paseo`)은 건드리지 않았다.
- 실제 daemon, 실제 CLI 실행 파일, 실제 plugin hook·settings·subscription·store, 실제 Chromium을 사용했다. 모델 응답은 로컬 fake API가 대신했고 실제 유료 모델·실제 계정 사용량은 호출하지 않았다.
- 계정·사용량 검사는 설치 사본의 `index.server.ts`만 patch해 제어 파일로 대체했다. 따라서 실제 계정 인증·외부 사용량 서비스는 이 실행으로 검증되지 않았다.
- 재시작 검증은 fake model의 `hang` 모드로 turn을 실행 중에 유지했다. 제품 코드에는 지연이나 테스트 분기를 넣지 않았다.
- OpenCode는 실제 `opencode` 2.2.6 바이너리와 fake `/chat/completions`를 썼다. 실제 OpenCode Go/무료 계정 호출은 이번 구현 검증에서 0회다.
- Windows, macOS, 모바일 네이티브 앱, 원격 host는 범위 밖이다.

## 구현 전 검증 (플러그인 1.3.2, `74a6a7d`)

`/tmp/uar016-test/REPORT.md`(전체·overload·OpenCode smoke)와 `/tmp/uar016-test/REPORT2.md`(UI, background, restart recovery, OpenCode fake suite)의 요약이다.

| 항목 | 관찰 | 판정 |
|---|---|---|
| Claude 제한이 `turn_failed`로 보고됨 | 0.16은 `outcome=failed`와 `error.message`에 제한 문구를 싣고 agent status는 `error`. 1.3.2는 그 경로로 예약을 만들었다 | 기존 감지 경로로 충분 |
| Claude 529 overload | Labs off면 예약 없음, on이면 스케줄·Resume now 고정 프롬프트·완료 정리 모두 통과. Codex도 동일 | 회귀 없음 |
| Claude 정상 종료 자동 복구 | 0.15에서 실패했던 사례가 0.16에서 recovery prompt 1회로 동작(`#8686`) | upstream 수정 확인 |
| background agent | 실제 제한 → reset+2분 예약, tick 1회 재개, plugin off 동안 놓친 제한을 scan이 발견 | 동작함 |
| `fetchAgents({includeBackground:true})` | background agent가 목록에 보이지 않음. plugin list RPC와 `fetchAgent(id)`는 정상 | harness/client 관찰, 제품 경로 아님 |
| 0.16 UI | plugin 행에 자체 `Settings` 버튼이 생기고 액션 메뉴 이름이 표시 이름 기준으로 바뀜 | harness locator 수정 필요 |
| OpenCode fake suite | 무료 한도 문구를 `provider.free-limit`으로 기록, `resetAt null` + 15분 재시도 예약, tick 1회, scan 1건 모두 통과 | 동작함 |
| provider 목록 | 설치 직후 `auto-resume.providers`에 opencode가 없고 잠시 뒤 나타남 | warm-up timing |
| daemon 종료 중 startup scan | `startup scan failed DaemonConnectionError: Transport not connected` / `Error: Daemon client closed`를 stderr에 기록 | **1.4.0에서 수정** |
| Antigravity | 재개 성공 뒤 이전 429를 다시 기록해 새 예약 생성 | 기존 외부 동작, 범위 밖 |

이 결과로 1.4.0에서 고친 것은 startup scan의 종료 잡음, pre-0.16 분기 제거, background 스위치, 실시간 갱신이다. 1.3.2에서 이미 동작하던 감지·예약·재개 로직은 바꾸지 않았다.

## 구현 후 전체 검증 (1.4.0, `8118f7c`)

각 실행은 `/tmp`에 격리 home을 만들고 `--source git:file:///home/babo/Projects/paseo-usage-auto-resume-016 --from v1.3.2 --to 8118f7c…`로 설치했다. 전체 실행은 15~40분씩 걸려 `nohup`으로 띄우고 완료를 기다렸다.

| 실행 | label | 검증한 커밋 | 범위 | OK | FAIL | NOTE |
|---|---|---|---|---|---|---|
| 1. 전체 | `impl-full` | `8118f7c` | `claude,codex,antigravity` + `--ui 1` | 46 | 1 (item 21 화면, harness) | 4 |
| 1. UI 재검증 | `impl-ui21` | `aefd48d` | `claude` + `--ui 1` | 34 | 0 | 2 |
| 2. 새 절 | `impl-1718` | `aefd48d` | `--only 17,18`, `claude,codex` | 29 | 0 | 2 |
| 3. OpenCode | `impl-oc` | `aefd48d` | `--suites opencode --only 19` | 6 | 1 (item 1, harness) | 0 |
| 3. OpenCode 재검증 | `impl-oc2` | `eae21fd` | `--suites opencode --only 19` | 8 | 0 | 0 |
| 4. Overload | `impl-overload` | 작업 트리 | `--overload 1 --suites claude,codex` | 6 | 0 | 0 |

모든 실행은 `nohup`으로 띄우고 완료까지 기다렸다. 전체 실행(1)은 05:48–06:12, UI 재검증은 06:13–06:32, 17·18은 06:33–06:51, OpenCode는 06:52–06:58, overload는 06:59에 끝났다. `SUMMARY`의 `fake` 요청 수는 각각 56, 38, 39, 3, 3, 8이었다.

주요 OK 원문(발췌):

```
OK [1/claude] install v1.3.2 ... v1.3.2 supports claude,codex,antigravity, providers claude,codex,antigravity,claude-sub, plugin logs clean
OK [2/plugin] update to eae21fd... and discover every requested provider :: providers claude,codex,opencode,antigravity
OK [17/claude-bg] 17a ... off: background limit made no reservation and wrote no history; on: row stored with background=true; off again: canceled/background_off at once, row gone
OK [17/claude-bg] 17b ... 1 continue, row cleared, continue text in the same background agent timeline; still hidden from the default list: true
OK [17/claude-bg] 17c ... no job while disabled; after enable the scan created one with background=true
OK [18/claude] 18a ... recoveryPrompts 1, pluginContinues 0, reservationLeft null, history canceled/new_message
OK [18/claude] 18b ... recoveryPrompts 1, pluginContinues 0, ... canceled/new_message
OK [18/claude] 18c ... recoveryPrompts 0, pluginContinues 0, ... canceled/new_message
OK [18/codex] 18d ... recoveryPrompts 1, pluginContinues 0, ... canceled/new_message
OK [19/opencode] 19a ... notice [Free usage limit reached...]; resetAt null, dueAt ~+15 min retry; probe turn_ended outcome=failed timeline.length=0
OK [19/opencode] 19b ... 1 continue, row cleared, continue in the same OpenCode agent timeline
OK [19/opencode] 19c ... no job while disabled; after enable the scan created one
OK [21/claude-ui] a reservation from a hook appears on the Auto Resume screen within 5 s without reloading :: appeared 12 ms after the reservation was stored, with the screen already open (no reload)
OK [21/claude-ui] ... composer pill within 5 s without reloading :: pill appeared 24 ms after the reservation was stored
OK [overload-on/claude] Labs on schedules, Resume now sends the fixed prompt, completion clears
OK [overload-disable/codex] switching Labs off immediately cancels pending retries and enabling does not restore them
```

FAIL 2건은 모두 harness 문제였고, 제품 코드 수정 없이 harness를 고친 뒤 재실행했다. 원문은 다음과 같다.

```
FAIL [21/claude-ui] a reservation from a hook appears on the Auto Resume screen within 5 s without reloading :: expect(locator).toHaveCount(expected) failed

Locator:  getByText('UI live screen', { exact: true })
Expected: 0
Received: 2
Timeout:  5000ms
```

에이전트 제목이 예약 행이 생기기 전에도 사이드바 등에 이미 있어 2개가 잡힌 것이다. Auto Resume 화면의 행에만 있는 `Change time for <title>, now …` 버튼으로 locator를 좁혔고(`test(e2e): scope the live-screen check to Auto Resume rows`), 5초 기대값은 그대로 두었다. 재검증(`impl-ui21`)에서 화면 12 ms, pill 24 ms로 통과했다.

```
FAIL [1/claude] install v1.3.2 through paseo plugin install (git source + ref) :: Timeout: providers opencode discovered
```

`--from v1.3.2`는 OpenCode 지원 이전 릴리스(`USAGE_SOURCES`에 `opencode` 없음)라 그 릴리스의 providers RPC가 OpenCode를 영원히 나열할 수 없다. item 1은 설치된 릴리스가 지원하는 provider만 기다리고, 업데이트 후 item 2에서 **버전 under test가 요청한 모든 suite의 provider를 발견하는지** 확인하도록 고쳤다(`test(e2e): expect only the providers the installed release supports`). 새 버전에 대한 검사는 약화하지 않았다. 재검증(`impl-oc2`)에서 `providers claude,codex,opencode,antigravity`로 통과했다.

NOTE는 다음과 같다.

| 실행 | NOTE |
|---|---|
| `impl-full` | 2/claude 기준선 관찰, 6·7/antigravity 이전 429 재전달(허용), 17d background agent 목록 노출 관찰 |
| `impl-ui21` | 2/claude 기준선, 17d |
| `impl-1718` | 2/claude 기준선, 17d |
| `impl-oc`, `impl-oc2`, `impl-overload` | 없음 |

item 13(1.3.2로 되돌리기)은 전체 실행에서 17개 예약을 그대로 나열했고 새 `jobs.json`/`history.json`을 읽었다. `background`/`background_off` 데이터가 있어도 crash 없이 동작했다. item 14는 전체 실행 0 오류 라인, OpenCode 실행 0 오류 라인으로 통과했다. 1.3.2의 providers.json에 남은 `resumeBackground`는 1.3.2가 무시한다.

검토 후 수정 두 건(`scan`의 workspace 읽기 순서, change listener 정리)은 `aefd48d`에 포함되며, 그 뒤 실행한 UI·17/18·OpenCode·overload 실행이 그 커밋을 검증했다. **전체 3-provider + UI 실행은 `8118f7c`에서만 수행했으므로, Antigravity는 검토 수정 이후 다시 실행하지 않았다.** 두 수정은 provider별 감지 로직을 바꾸지 않는다. 정식 0.16.0에서는 네 실행을 모두 다시 수행해야 한다.

저장소 검증은 `npm run check`로 타입 검사와 **581/581 테스트**가 통과했다.

## 발견한 문제와 남은 것

### Antigravity가 정상 응답 뒤 이전 429를 다시 기록하고 예약이 생김

0.15 검증과 같은 현상이 0.16 beta에서도 재현됐다. 재개 메시지가 전달되고 `Done.` 응답이 온 뒤 대화에 이전 `Error 429 ... RESOURCE_EXHAUSTED`가 다시 기록되고, 플러그인이 이를 새 제한으로 처리해 새 예약을 만든다. `plugins/antigravity-provider`는 0.15.4와 0.16.0-beta.1 사이에 파일 차이가 없으므로 0.16 회귀로 분류하지 않는다. harness는 이 경우를 FAIL이 아니라 NOTE로 남긴다.

### `fetchAgents`의 background agent 목록

0.16 beta에서 `client.fetchAgents({ includeBackground: true })`와 `filter.includeBackground`가 agent 단위 background agent를 반환하지 않는 경우가 있었다. 반면 플러그인의 `auto-resume.list` RPC, startup scan, `fetchAgent(id)`는 그 agent를 정상적으로 다뤘다. 제품 경로의 실패가 아니므로 e2e item 17d는 NOTE로 기록한다. Paseo stable에서 재확인이 필요하다.

### 설치 직후 provider 목록 warm-up

daemon 시작 직후 첫 `auto-resume.providers` 호출에서 OpenCode가 빠져 있을 수 있다. provider snapshot/CLI probe가 비동기로 끝나기 전에 읽는 timing이며, 잠시 뒤 다시 읽으면 나타난다. e2e item 1은 이 시간을 최대 90초 기다리도록 바꿨다(발견 자체를 약화하지 않는다).

### 구현 전 harness의 한계 (해결됨)

`Actions for usage-auto-resume` locator, item 14의 JSON 로그 메시지 추출, item 1의 provider timing, OpenCode가 generic item 3에 걸리던 문제는 e2e를 0.16 기준으로 고치면서 해결했다. `--only`는 17~20 절만 선택하고 기존 1~16은 항상 실행한다.

## 1.4.0 릴리스 노트 초안

- **Paseo 0.16.0 이상이 필요합니다.** 0.15 이하 daemon에서는 설치되지 않습니다.
- **Resume background agents (기본 꺼짐).** Paseo가 목록에서 숨기는 background agent와 background workspace의 agent를 자동 재개할지 정합니다. 기본값이 꺼짐이므로, 이전에 이런 agent가 재개되던 환경은 설정에서 켜야 합니다. 끄면 대기 중인 배경 예약이 `background_off`로 취소되며, 예약을 계획하는 중에 끄더라도 저장 직후 취소됩니다.
- **실시간 갱신.** 예약이 생기거나 결과가 기록되면 열려 있는 Auto Resume 화면, 대화 팝오버, 작성창 pill이 즉시 갱신됩니다. 2분마다 전체 새로고침도 유지됩니다.
- **종료 중 로그 정리.** daemon이 멈추는 중에 시작 스캔이 끊기면 오류 대신 정보 로그만 남깁니다.
- OpenCode Go·무료 모델 지원은 1.3.2와 같습니다.

## 명령과 증거 위치

```bash
# 구현 전
cd /home/babo/Projects/paseo-usage-auto-resume && npm run check        # 561/561
# 구현 후
cd /home/babo/Projects/paseo-usage-auto-resume-016 && npm run check    # 아래 결과 참조

# Phase 7 실행 (요지)
PW_ROOT=/tmp/uar016-pw/node_modules node e2e/e2e.mjs \
  --label impl-full --cli /tmp/paseo-0.16.0-beta.1/node_modules/@getpaseo/cli \
  --root /tmp/uar016-impl-full --out /tmp/uar016-impl-full-results \
  --suites claude,codex,antigravity \
  --claude /home/babo/.local/bin/claude --codex /home/babo/.local/bin/codex --agy /home/babo/.local/bin/agy \
  --source git:file:///home/babo/Projects/paseo-usage-auto-resume-016 --from v1.3.2 --to 8118f7c --ui 1
```

증거는 `/tmp/uar016-test/REPORT.md`, `REPORT2.md`, `harness2.diff`, `/tmp/uar016-impl-*-results/{results.json,daemon.log,model.jsonl}`, `/tmp/uar016-impl-*.log`에 있다. `/tmp` 정리 시 사라질 수 있으며, 핵심 결과는 이 문서에 보존했다.
