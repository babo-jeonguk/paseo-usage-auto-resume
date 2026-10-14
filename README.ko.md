# Usage Auto Resume

[English](README.md) · [MIT 라이선스](LICENSE)

별도 데모 환경에서 샘플 예약을 사용해 실제 Paseo 웹 화면을 촬영했다.

![날짜별 자동 재개 예약과 켜기·끄기](assets/auto-resume.png)

![기본 claude·codex 대상 설정](assets/provider-settings.png)

Codex, Claude 또는 Antigravity agent가 usage/rate limit으로 멈추면 reset 시각 + 2분에 **같은 agent**에 continue prompt를 한 번 보내는 Paseo plugin이다. 새 agent 생성, provider 전환은 없다.

## Auto Resume 화면

사이드바(☰) 위쪽 목록의 **Auto Resume**에서 예정된 자동 재개를 날짜별로 본다. 각 행은 전송 시각, 남은 시간, agent 제목, provider, project/workspace를 보여 준다. 행을 누르면 그 agent 대화가 열린다.

- 모든 예약은 켜진 상태로 생긴다. 필요 없는 것만 스위치로 끈다. 저장 버튼 없이 바로 적용된다.
- 끈 예약은 예정 시각까지 목록에 남아 다시 켤 수 있다. 예정 시각이 지나면 보내지 않고 목록에서 사라진다. 그 전에 agent에게 직접 메시지를 보내도 사라진다.
- 화면은 30초마다 새로 고친다. Desktop은 새로 고침 버튼, mobile은 당겨서 새로 고침을 쓴다.

행 구조는 iOS 시계 앱의 알람 목록을 따랐다. 스위치 사용은 [Apple HIG Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles)(목록 행 안의 스위치, 행 내용이 맥락)와 [NN/g Toggle-Switch Guidelines](https://www.nngroup.com/articles/toggle-switch-guidelines/)(즉시 적용)를 따랐다. 카드·간격·스위치 규격은 Paseo 설정 화면과 같다.

## 대상

기본 대상은 `codex`, `claude`, `antigravity`다. **Settings → Plugins → usage-auto-resume → Settings**에서 **Claude provider ID**, **Codex provider ID**, **Antigravity provider ID**를 지정하고 **Save**를 누르면 해당 CLI의 기본 ID를 교체한다. 예를 들어 Claude를 `claude-main`으로, Codex를 `codex`로, Antigravity를 `antigravity`로 저장하면 정확히 이 셋만 처리하고 `claude`와 `claude-sub`는 제외한다. 별칭은 해당 Claude/Codex/Antigravity CLI를 사용해야 하며 일반적으로 기본 provider를 `extends`한다.

설정은 daemon별 `$PASEO_HOME/plugin-settings/usage-auto-resume/providers.json`에 저장되므로 공개 코드의 기본값과 개인 설정을 따로 유지할 수 있다. Prefix나 `extends`만으로 다른 ID를 자동 포함하지 않는다. 선택에서 빠진 provider의 기존 예약은 취소한다. 설정을 읽지 못하면 기본값으로 전환하지 않고 자동 재개를 대기시킨다.

## 동작

1. `agent.turn_ended`에서 limit 종료를 보수적으로 감지한다. 명시적인 renewable limit 오류 코드(`rate_limit`, `rate_limit_exceeded`, `rate_limit_error`, `usage_limit_reached`, `usage_limit_exceeded`, `resource_exhausted`, `quota_exceeded`)가 있으면 문구·길이에 의존하지 않고 먼저 판정한다. 코드가 없으면 실패 메시지, 해당 turn의 error/warning 항목, turn을 마친 마지막 assistant 메시지(Claude는 limit을 이 형태로 알린다) 중 800자 이하의 짧은 notice를 본다. 마지막 assistant 메시지는 같은 `messageId`의 조각만 합치며, 다른 ID의 앞 답변은 붙이지 않는다. ID가 없으면 마지막 항목만 검사한다. Context window 초과, billing/credit 부족, 일반 오류, 취소된 turn은 대상이 아니다.
2. Reset 시각은 다음 순서로 정한다.
   1. Notice에 적힌 시각: `resets 3pm (Asia/Seoul)`, `try again at 4:13 AM`, `try again in 2 hours`, `Resets in 6h53m44s`, `|<epoch>`, ISO 시각.
   2. 해당 account의 Paseo usage window(`providers.listUsage()`): 소진된 window가 있으면 그 window, 없으면 5-hour/session window의 `resetsAt`을 쓴다. Paseo 0.11부터 이 목록은 source마다 로그인 account별 항목(`Claude (<email>)`, `Codex (<email>)`, `Antigravity (<email>)`)을 돌려주고, 다른 agent가 쓰는 account도 섞인다. 그래서 agent가 실제로 쓰는 account의 email을 그 CLI의 home에서 읽어 같은 email의 항목만 사용한다. 선택한 Claude provider는 `CLAUDE_CONFIG_DIR/.claude.json`의 `oauthAccount.emailAddress`, Codex는 `CODEX_HOME`(기본 `~/.codex`)`/auth.json` token의 email claim, Antigravity는 `ANTIGRAVITY_CONFIG_DIR`(또는 `~/.gemini/antigravity-cli`)의 `auth.json`/`credentials.json`/`settings.json`의 account email만 읽는다. Token 자체는 저장하거나 로그에 남기지 않는다. Email을 알 수 없거나 같은 email의 항목이 없으면 다음 단계로 넘어간다.
   3. 알 수 없으면 15분 뒤 다시 확인한다. 이때 usage window가 확인되면 그 시각으로 다시 예약하고, 여전히 모르면 continue를 보낸다. 다시 limit에 걸리면 같은 절차를 반복하며, 연속 24회 실패하면 중단한다.
3. Agent당 job은 하나이며 `(agentId, resetAt)` 기준으로 idempotent하다. 같은 failure가 반복 수신되어도 job은 하나만 남는다.
4. 실행 시각에 agent를 다시 조회한다. 다음 중 하나라도 해당하면 보내지 않고 job을 취소한다.
   - 예약 뒤 새 turn이 시작되었다.
   - `lastUserMessageAt`이 달라졌다.
   - agent가 running/closed 상태이거나 archive되었다.
   - permission 또는 input을 기다리고 있다.
5. Plugin이 시작한 뒤 첫 hook에서 한 번 시작 scan을 실행한다. 설치 전이나 재시작 중에 limit으로 멈춰 `turn_ended`를 받지 못한 agent를 찾기 위해서다. 최근 12시간 안에 활동한 대상 agent만 본다. Codex는 `error` 상태의 `lastError`로, 선택한 Claude provider는 `idle` 상태에서 timeline 마지막 20개 항목 중 turn을 끝낸 메시지로 판정한다. 이미 job이 있는 agent는 건드리지 않는다.
6. 전송은 `agents.ref(id).send()`만 사용한다. 전송 전에 `sending`을 저장하므로 crash 뒤에도 continue가 두 번 가지 않는다. 재개 prompt는 부모 agent에게 대화·작업공간·subagent/task 상태를 확인하고, **usage limit으로 중지된 미완료 서브에이전트도 기존 ID/이름·기존 지시로 이어가도록** 요청한다. 이미 완료된 작업을 다시 하거나 실행 중인 서브에이전트를 중단하지 않고, 사용자의 취소·일시정지를 존중한다. 기존 서브에이전트를 재개할 수 없으면 blocker를 보고하도록 한다. Plugin이 Claude 내부 서브에이전트에 직접 메시지를 보내는 것은 아니며, 실제 재개는 부모 agent가 provider의 resume/messaging 도구로 수행한다.

### Paseo 내장 API와 감지 범위

Paseo 0.11.0의 [`agent.turn_ended`](https://paseo.sh/docs/plugins/reference)의 `outcome`은 `completed`·`failed`·`canceled`이며, `failed`만 optional `error.code`를 갖는다. 별도의 `usage_limited` 상태나 limit 전용 lifecycle event는 없다. 이번 Claude 기록처럼 한도 안내가 일반 `assistant_message`로 오고 turn이 completed로 끝날 수 있어, 코드 판정만으로는 충분하지 않다.

[`providers.listUsage()`](https://paseo.sh/docs/sdk/reference)는 account의 subscription 사용률·리셋 시각을 제공한다. 이 plugin은 한도 중지가 확인된 뒤 reset 시각을 보완하는 데 이미 사용한다. Account 사용률이 100%라는 것만으로 모든 idle agent를 재개하면 완료된 작업까지 재개할 수 있으므로, 특정 agent가 한도로 중지됐다는 근거와 구분한다.

Job은 `$PASEO_HOME/plugin-data/usage-auto-resume/jobs.json`(기본 `~/.paseo/...`)에 저장되어 daemon/plugin 재시작 후에도 유지된다.

## Paseo heartbeat를 쓰지 않는 이유

Paseo 0.11 plugin API(`PaseoApi`)에도 schedule/heartbeat API가 없다. Heartbeat는 CLI(`paseo heartbeat create`)로만 만들 수 있다. 또 heartbeat는 실행 시각에 prompt를 그대로 보내므로, 그 사이 수동 재개나 permission 대기를 확인할 수 없다. 그래서 [paseo-defer](https://github.com/tomgrin10/paseo-defer)의 persisted queue 방식을 public SDK 호출로 구현했다.

**제약:** Plugin은 hook/RPC 안에서만 `paseo` API를 받는다. Daemon이나 plugin을 재시작한 직후에는 첫 lifecycle hook(어느 agent든 turn 시작/종료, 생성, 종료(close), permission 요청, archive) 또는 Auto Resume 화면의 RPC 요청이 들어올 때까지 예약 실행이 대기한다. 그 시점에 이미 지난 job은 바로 실행된다.

## 설치

GitHub에서 직접 설치할 수 있다:

```bash
paseo plugin install github:babo-jeonguk/paseo-usage-auto-resume
```

로컬 개발 설치:

```bash
cd /path/to/paseo-usage-auto-resume
npm install
npm run check
paseo plugin install "$PWD"
```

Paseo daemon과 app 모두 0.11.x여야 한다(`paseo-plugin.json`의 `>=0.11.0 <0.12.0`). `config.json`의 root `pluginsEnabled`가 켜져 있어야 한다. 소스를 바꾼 뒤에는 `paseo plugin reload usage-auto-resume`을 실행한다. 로그는 daemon log의 `[usage-auto-resume]` 줄에 남는다.

## 출처

Reset 문구 파싱은 [panrafal/paseo-plugins chat-resume](https://github.com/panrafal/paseo-plugins/tree/main/chat-resume)과 [keefeere/paseo-continuity](https://github.com/keefeere/paseo-continuity)(MIT)를, usage window 판별은 [ortschun/paseo-limits](https://github.com/ortschun/paseo-limits)를 참고했다.
