# Paseo 0.16.0 정식 실행 검증

검증일: 2026-11-16. 대상 Paseo: `0.16.0` 정식. 플러그인: `1.4.0`. 검증한 코드는 `42caf49`이며, 그 앞의 `ef0c6b5`(main 병합), `bbd7ac9`(SDK 고정), `b40aa5a`(e2e harness)를 포함한다. `0.16.0-beta.1`에 대한 이전 결과는 아래 **beta 검증 이력**에 요약했다.

## 호환성 판단과 정식 버전 확인 결과

플러그인 1.4.0은 **Paseo 0.16.0 이상**을 요구한다. `paseo-plugin.json`의 `requirements.paseo`는 `>=0.16.0`이고, 개발 의존성 `@getpaseo/client`, `@getpaseo/plugin`, `@getpaseo/protocol`은 정식 `0.16.0`으로 정확히 고정했다. 0.11~0.15 지원용 분기와 주석은 제거된 상태다. 1.4.0의 기능은 (1) Paseo 0.16의 background agent/workspace를 다루는 **Resume background agents** 스위치(기본 꺼짐), (2) plugin subscription을 이용한 실시간 갱신, (3) 0.16 SDK 기준 타입·픽스처 정리다.

정식 버전 확인 계획은 세 가지였고 모두 완료했다.

1. `0.16.0-beta.1`부터 정식 태그까지 계약 변경을 확인했다. 배포 패키지의 타입 선언을 비교하고 릴리스 노트를 대조한 결과는 [beta.1 이후 변경 조사](research/paseo-0.16-stable-changes.md)에 있다. 요약하면 `agent.turn.after.timeline` 제거(#9573), hook/session-open의 필수 `background` 필드(#9362), plugin 갤러리와 설정 상세 페이지(#8675, #9752), subscription(#8527), plugin 동시 시작(#8427)이다.
2. 계약 변경에 맞춰 이 브랜치가 한 일은 SDK pin을 `0.16.0`으로 올리고, `AgentTimelineItem`을 `timeline.refetch` 반환에서 유도하고, 훅 픽스처에 `background`를 넣고 `timeline`을 제거하고, 제거된 필드를 검사하던 테스트를 남은 동작으로 교체한 것이다. e2e는 plugin 갤러리의 설치 행을 열도록 고쳤고, main이 추가한 설정 저장 실패 UI 항목은 22번으로 옮겼다.
3. 정식 배포본에서 Phase 7에 해당하는 두 실행(전체 + UI, overload)을 다시 실행했다. 둘 다 FAIL 0이고 알려진 NOTE만 남았다.

`0.16.0-beta.1`은 prerelease였으므로 그 결과는 정식 검증을 대신하지 않는다. 이 문서의 아래 결과가 정식 `0.16.0`에 대한 것이다.

## 1.4.0에서 사용자에게 보이는 변화

- **배경 에이전트 스위치 (기본 꺼짐).** Paseo는 `agent.background || workspace.background`인 에이전트를 목록에서 숨긴다. 1.3.2까지는 이런 에이전트도 제한 후 자동 재개했다. 1.4.0은 기본으로 재개하지 않고, 켜면 다른 에이전트와 똑같이 재개한다. **배경 워크스페이스의 에이전트가 더 이상 기본으로 재개되지 않는 동작 변화**이며, 켜는 즉시 시작 스캔과 같은 놓친 제한 스캔을 실행한다. 끄면 그 에이전트의 대기 중 예약을 `background_off` 사유로 즉시 취소하며, 예약을 계획하는 중에 끄더라도 저장 직후 취소한다.
- **실시간 갱신.** 예약·결과가 저장되면 plugin subscription(`auto-resume.changes`)이 revision을 push하고, Auto Resume 화면·대화 팝오버·작성창 pill이 기존 목록 RPC로 바로 다시 읽는다. 2분 주기 전체 새로고침은 이름·위치가 바뀐 에이전트를 위한 안전망으로 남는다.
- **프로바이더 스위치가 다른 설정을 지우지 않음.** 설정 저장은 문서 전체를 교체하므로, 프로바이더를 켜고 끌 때 **Resume background agents** 값과 다른 프로바이더 목록을 함께 저장한다.
- **Paseo 0.16.0 이상 요구.** 0.15 이하 daemon에는 설치되지 않는다.

## 작업 범위와 확정한 동작

이 작업은 Paseo 0.16 beta에서 1.3.2가 실제로 동작하는지 먼저 확인하고(구현 전 검증), 그 결과에 맞춰 1.4.0을 구현한 뒤 다시 전체 검증했다. 구현 전 검증은 제품 코드·테스트·의존성을 수정하지 않았고, 변경은 `/tmp/uar016-harness2/e2e` 사본에만 있었다. 구현 단계의 결정은 다음과 같다.

- 배경 에이전트 판정은 Paseo 정의(`agent.background || workspace.background`)를 그대로 쓴다. hook payload는 agent 자신의 `background`를 이제 직접 싣지만 workspace의 flag는 싣지 않으므로 agent snapshot과 `api.workspaces.ref(id).refresh()`의 `background`를 읽는다. workspace를 읽지 못하면 agent 자신의 flag로 결정하고 한 번만 기록한다.
- 설정 파일 버전은 **2를 유지**했다. 0.16의 `PluginSettingsStore`는 저장된 version이 현재 version과 같으면 `schema.parseAsync(values)`를 그대로 실행하므로, `resumeBackground`가 없는 기존 version 2 파일은 zod default인 `false`로 읽힌다. 마이그레이션이 필요 없다.
- 예약 행에는 `background?: boolean`을 추가했다. 이 버전이 만드는 배경 예약은 `true`를 저장하고, 예전 행(플래그 없음)은 전달 시점에 agent를 읽어 판정한다. 전달 시점의 배경 판정은 agent 상태 확인보다 먼저 하며, 저장된 플래그가 있으면 agent가 사라졌어도 그 플래그로 결정한다. 1.3.2로 되돌리면 이 키는 무시된다.
- 저장소 쓰기 알림은 **파일을 실제로 바꾼 쓰기**에만 붙였다(no-op update는 알리지 않음). job/history 어느 쪽이 바뀌어도 revision이 오른다.

## 정식 검증 실행 환경

- Linux, Node `v24.21.0`, Claude Code `2.1.325`, Codex CLI `0.169.0`, Antigravity CLI `1.5.9`, OpenCode `2.3.0`, Playwright `1.65.0`.
- npm에 배포된 실제 Paseo `0.16.0`을 `/tmp/paseo-0.16.0`에 설치했다. 각 실행은 별도 home·port·작업 디렉터리를 썼고, 사용자의 라이브 daemon(port 6767, `~/.paseo`)은 건드리지 않았다.
- 실제 daemon, 실제 CLI 실행 파일, 실제 plugin hook·settings·subscription·store, 실제 Chromium을 사용했다. 모델 응답은 로컬 fake API가 대신했고 실제 유료 모델·실제 계정 사용량은 호출하지 않았다.
- 계정·사용량 검사는 설치 사본의 `index.server.ts`만 patch해 제어 파일로 대체했다. 따라서 실제 계정 인증·외부 사용량 서비스는 이 실행으로 검증되지 않았다.
- 재시작 검증은 fake model의 `hang` 모드로 turn을 실행 중에 유지했다. 제품 코드에는 지연이나 테스트 분기를 넣지 않았다.
- OpenCode는 실제 `opencode` 2.3.0 바이너리와 fake `/chat/completions`를 썼다. 실제 OpenCode Go/무료 계정 호출은 이번 정식 검증에서 0회다.
- Windows, macOS, 모바일 네이티브 앱, 원격 host는 범위 밖이다.

## 정식 검증 결과

각 실행은 `/tmp`에 격리 home을 만들고 `--source git:file:///home/babo/Projects/paseo-usage-auto-resume-016 --from v1.3.2 --to 42caf49`로 설치했다. `nohup`으로 띄우고 완료를 기다렸다.

| 실행 | label | 검증한 커밋 | 범위 | OK | FAIL | NOTE |
|---|---|---|---|---|---|---|
| 1. 전체 + UI | `final-full` | `42caf49` | `claude,codex,antigravity,opencode` + `--ui 1` | 56 | 0 | 5 |
| 2. Overload | `final-overload` | `42caf49` | `claude,codex` + `--overload 1` | 6 | 0 | 0 |

전체 실행은 12:25–12:52, overload는 12:52–12:53에 끝났다. `SUMMARY`의 fake 요청 수는 각각 61과 8, event-loop 최대 지연은 773 ms와 106 ms였다.

알려진 NOTE 5건은 다음과 같다.

| 실행 | NOTE |
|---|---|
| `final-full` | `2/claude` v1.3.2 기준선 관찰(0.16.0에서 실제 제한 → v1.3.2 예약 생성, turn end probe `timeline.length=0`) |
| `final-full` | `6/antigravity`, `7/antigravity` 이전 429 재전달(허용된 외부 동작) |
| `final-full` | `17d` background agent가 `fetchAgents({includeBackground})`에 보이지 않음(플러그인 list RPC에는 보임) |
| `final-full` | `20/opencode` provider discovery 관찰(최종 provider 목록에 `opencode` 포함) |

UI 5의 알려진 upstream popover flake(Paseo #8179)는 이번 실행에서 나타나지 않았고, `--only 22` 재실행도 필요 없었다. item 22(설정 저장 실패)는 `final-full`에서 OK였다. item 5와 9도 plugin 갤러리의 설치 행에서 설정을 열어 OK였다.

주요 OK 원문(발췌):

```
OK [1/claude] install v1.3.2 through paseo plugin install (git source + ref) :: ... v1.3.2 supports claude,codex,antigravity, providers claude,codex,antigravity,claude-sub, plugin logs clean
OK [5/claude-ui] ... settings opened from the installed plugin row in the gallery
OK [9/claude-ui] Settings switch turns Claude Sub off: its pending reservation is canceled at once :: ... settings opened from the installed plugin row in the gallery
OK [22/claude-ui] a failed settings save shows a plain message, keeps the switch and the reservation, and a retry clears it :: ... conflict offered Reload; Labs and continue prompt kept their values
OK [17/claude-bg] 17a ... off: background limit made no reservation and wrote no history; switch on: rescan reserved the stop made while off ...; off again: canceled/background_off at once, row gone
OK [17/claude-bg] 17b ... tick: 1 continue, row cleared, continue text in the same background agent timeline
OK [18/claude] ... recoveryPrompts 1, pluginContinues 0, ... canceled/new_message
OK [19/opencode] ... provider.free-limit ... tick 1회 ... scan ...
OK [21/claude-ui] ... appeared 139 ms after the reservation was stored ... (no reload)
OK [overload-on/codex] Labs on schedules, Resume now sends the fixed prompt, completion clears :: fixed prompt + note, one send, cleared
```

item 13(1.3.2로 되돌리기)은 전체 실행에서 19개 예약을 그대로 나열했고 새 `jobs.json`/`history.json`을 읽었다. `background`/`background_off` 데이터가 있어도 crash 없이 동작했다. item 14는 전체 실행 0 오류 라인으로 통과했다.

저장소 검증은 `npm run check`로 타입 검사와 **657/657 테스트**가 통과했다.

## beta 검증 이력

정식 이전에는 같은 브랜치에서 `0.16.0-beta.1`을 대상으로 두 번 검증했다.

- **구현 전 (1.3.2, `74a6a7d`)**: 실제 제한 감지, background agent 예약·재개, Labs overload, OpenCode fake suite가 동작했다. Claude 정상 종료 자동 복구는 upstream #8686으로 해결됐다. plugin 행의 `Settings` 버튼, daemon 종료 중 startup scan 잡음, provider warm-up, Antigravity 429 재전달을 관찰했다.
- **구현 후 (1.4.0, `8118f7c`/`aefd48d`/`eae21fd`)**: 전체 46 OK/1 FAIL(harness)/4 NOTE, UI 재검증 34/0/2, 17·18 절 29/0/2, OpenCode 8/0/0, overload 6/0/0. `npm run check`는 581/581이었다. FAIL 2건은 모두 harness locator 문제였고 제품 코드 수정 없이 고쳤다.

beta에서 남은 관찰(17d, provider warm-up, Antigravity 재전달)은 정식에서도 같았으며 위 NOTE 표에 반영했다.

## 발견한 문제와 남은 것

### Antigravity가 정상 응답 뒤 이전 429를 다시 기록하고 예약이 생김

0.15와 0.16 beta에 이어 정식 0.16.0에서도 재현됐다. 재개 메시지가 전달되고 `Done.` 응답이 온 뒤 대화에 이전 `Error 429 ... RESOURCE_EXHAUSTED`가 다시 기록되고, 플러그인이 이를 새 제한으로 처리해 새 예약을 만든다. 0.16.0 릴리스 노트에 이 재전달을 고쳤다는 항목이 없고 beta.1 조사에서도 제공자 코드 변경을 찾지 못했으므로 0.16 회귀로 분류하지 않는다. harness는 이 경우를 FAIL이 아니라 NOTE로 남긴다.

### `fetchAgents`의 background agent 목록

정식 0.16.0에서도 `client.fetchAgents({ includeBackground: true })`와 `filter.includeBackground`가 agent 단위 background agent를 반환하지 않는 경우가 있었다. 반면 플러그인의 `auto-resume.list` RPC, startup scan, `fetchAgent(id)`는 그 agent를 정상적으로 다뤘다. 제품 경로의 실패가 아니므로 e2e item 17d는 NOTE로 기록한다.

### 설치 직후 provider 목록 warm-up

daemon 시작 직후 첫 `auto-resume.providers` 호출에서 OpenCode가 빠져 있을 수 있다. provider snapshot/CLI probe가 비동기로 끝나기 전에 읽는 timing이며, 잠시 뒤 다시 읽으면 나타난다. e2e item 1은 이 시간을 최대 90초 기다리도록 바꿨다(발견 자체를 약화하지 않는다). 정식 실행의 item 20도 이 관찰을 NOTE로 남겼다.

### 구현 전 harness의 한계 (해결됨)

`Actions for usage-auto-resume` locator, item 14의 JSON 로그 메시지 추출, item 1의 provider timing, OpenCode가 generic item 3에 걸리던 문제는 e2e를 0.16 기준으로 고치면서 해결했다. `--only`는 17~20 절만 선택하고 기존 1~16은 항상 실행한다. 정식 0.16.0에서는 설정 진입이 plugin 갤러리의 설치 행으로 바뀌어 harness도 그에 맞췄다.

## 1.4.0 릴리스 노트 초안

- **Paseo 0.16.0 이상이 필요합니다.** 0.15 이하 daemon에서는 설치되지 않습니다.
- **Resume background agents (기본 꺼짐).** Paseo가 목록에서 숨기는 background agent와 background workspace의 agent를 자동 재개할지 정합니다. 기본값이 꺼짐이므로, 이전에 이런 agent가 재개되던 환경은 설정에서 켜야 합니다. 끄면 대기 중인 배경 예약이 `background_off`로 취소되며, 예약을 계획하는 중에 끄더라도 저장 직후 취소됩니다.
- **실시간 갱신.** 예약이 생기거나 결과가 기록되면 열려 있는 Auto Resume 화면, 대화 팝오버, 작성창 pill이 즉시 갱신됩니다. 2분마다 전체 새로고침도 유지됩니다.
- **프로바이더 스위치가 다른 설정을 지우지 않습니다.** 프로바이더를 켜고 끌 때 **Resume background agents** 값과 다른 프로바이더 목록이 함께 저장됩니다.
- **종료 중 로그 정리.** daemon이 멈추는 중에 시작 스캔이 끊기면 오류 대신 정보 로그만 남깁니다.
- OpenCode Go·무료 모델 지원은 1.3.2와 같습니다.

## 명령과 증거 위치

```bash
# 저장소 검증
cd /home/babo/Projects/paseo-usage-auto-resume-016 && npm run check   # 657/657

# 정식 0.16.0 실행 (요지)
PW_ROOT=/tmp/uar016-pw/node_modules node e2e/e2e.mjs \
  --label final-full --cli /tmp/paseo-0.16.0/node_modules/@getpaseo/cli \
  --root /tmp/uar016-final-full --out /tmp/uar016-final-full-results \
  --suites claude,codex,antigravity,opencode \
  --claude ~/.local/bin/claude --codex ~/.local/bin/codex --agy ~/.local/bin/agy --opencode ~/.opencode/bin/opencode \
  --source git:file:///home/babo/Projects/paseo-usage-auto-resume-016 --from v1.3.2 --to 42caf49 --ui 1

PW_ROOT=/tmp/uar016-pw/node_modules node e2e/e2e.mjs \
  --label final-overload --cli /tmp/paseo-0.16.0/node_modules/@getpaseo/cli \
  --root /tmp/uar016-final-overload --out /tmp/uar016-final-overload-results \
  --suites claude,codex --overload 1 \
  --claude ~/.local/bin/claude --codex ~/.local/bin/codex --agy ~/.local/bin/agy --opencode ~/.opencode/bin/opencode \
  --source git:file:///home/babo/Projects/paseo-usage-auto-resume-016 --from v1.3.2 --to 42caf49
```

증거는 `/tmp/uar016-test/final-full.log`, `/tmp/uar016-test/final-overload.log`, `/tmp/uar016-final-full-results/{results.json,daemon.log,model.jsonl}`, `/tmp/uar016-final-overload-results/`에 있다. `/tmp` 정리 시 사라질 수 있으며, 핵심 결과는 이 문서에 보존했다.
