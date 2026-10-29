# Paseo 0.14 에이전트 lifecycle 참고 자료: 지연 전송·closed·session_open

조사일: 2026-10-29  
대상: Paseo `v0.14.0`, Usage Auto Resume `0dea7944c4b7f7032e51f1e84d0bab3cca7cb16e`, 로컬 플러그인 Auto Compact for Claude `8f9086093ebf39eb40c53bea921d67d1c0f29c6a`, Free Your Agents `b5605b9c7f46390837cc035b3b01851b256c7ff9`(`v1.2.1`)

이 문서는 수정안이 아니라 설계 참고 자료다. 코드에서 직접 확인한 사실과 코드만 읽고 추론한 내용을 구분해 적었고, 실측하지 못한 것은 **미확인**으로 표시했다.

## 결론

- **Paseo 자체 기능은 `closed`를 종료 상태로 보지 않는다.** 한 에이전트에게 나중에 프롬프트를 보내는 1st-party 경로는 schedule/heartbeat와 finish subscription 알림이다. 둘 다 "레코드 없음"과 `archivedAt`만 영구 실패로 다루고, `closed`인 대상은 `ensureAgentLoaded()`로 깨워서 보낸다. 문서도 `closed`를 "the persisted, resumable state"로 정의한다. [lifecycle 문서](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L13-L22) · [schedule 실행](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L931-L952) · [finish subscription 호출자 판정](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L1459-L1462)
- **"이 에이전트는 끝났다"는 사용자 의도는 archive로만 표현된다.** 0.14에는 사용자가 에이전트를 `closed`로 만드는 RPC나 CLI가 없다. `paseo agent stop`은 진행 중인 turn만 중단하고, 루트 에이전트의 탭을 닫으면 archive된다. `closed`는 idle 정리, 데몬 종료, provider 은퇴, reload 실패, archive·delete의 부수 효과로만 생긴다. 다만 payload나 `agent.closed` 이벤트에 그 원인을 구분하는 필드는 없다. [CLI stop](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/cli/src/commands/agent/stop.ts#L26) · [탭 닫기 = archive](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L252)
- **busy 대상은 기능마다 다르게 처리한다.** schedule은 이미 run이 진행 중이면 이번 회차를 실패로 기록하고 다음 cadence에 다시 시도한다. agent 메시지와 finish 알림은 2초 묶음 큐를 거쳐 `steer`로 진행 중인 turn에 끼워 넣는다. 처리 전에 대상을 claim하는 방식도 다르다. schedule은 저장소 update 안에서 원자적으로 claim하고 커서를 넘긴다. 메시지 전송은 `messageId`별 영속 receipt(`pending`→`completed`)로 중복을 막는다. 플러그인 `send()`도 이 receipt를 쓸 수 있다. [schedule claim](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L775-L825) · [message receipts](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/message-receipts/index.ts#L25-L56)
- **`before("agent.session_open")`에는 observe-only 예외가 없다.** 이 hook을 선언한 플러그인이 시작·중지·reload·크래시되면 데몬 전역 generation이 올라간다. 그러면 살아 있는 모든 에이전트가 다음 idle 프롬프트 전에 provider 세션을 닫았다가 다시 연다. 다시 열기에 실패하면 그 프롬프트도 실패한다. 이 플러그인의 continue 전송도 그런 프롬프트가 될 수 있다. upstream에서 observe-only hook을 논의한 기록은 찾지 못했다. [runtime](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/runtime.ts#L307-L310) · [reopen 판정](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L904-L926) · [PR #7938](https://github.com/getpaseo/paseo/pull/7938)
- **플러그인이 특정 에이전트를 idle 정리에서 보호하는 공개 API는 없다.** 보호 근거는 finish subscription의 호출자 보호와 agent 메시지 큐의 pending 상태 두 가지뿐이고, 둘 다 플러그인이나 클라이언트 RPC로는 만들 수 없다. `refresh()`와 `agents.list()`는 런타임을 깨우지 않는다. 반면 `timeline.refetch()`는 `closed` 에이전트를 resume한다. 이때 `updatedAt`은 갱신되지 않으므로 곧 다시 정리될 수 있다(코드상 추론). [idle 정리 보호 연결](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L1479-L1486) · [resume 시 시각 보존](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L3834-L3841)

## 현재 플러그인 설계 요약(참조 기준)

- **예약 생성:** `agent.turn_ended`에서 사용 한도 중단을 감지하면 예약을 만든다.
- **due 시각 전송:** `refresh()`로 에이전트를 다시 읽고 `agentGate`를 통과하면 `send(..., { activeTurnBehavior: "steer" })`로 continue를 보낸다. [send](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/0dea7944c4b7f7032e51f1e84d0bab3cca7cb16e/server/resumer.ts#L377-L417)
- **`agentGate`의 판정:**
  - archived이면 취소한다.
  - `idle`/`error`가 아니고 turn 중도 아니면 `agent_busy`로 취소한다. 즉 `closed`와 `initializing`은 취소된다.
  - turn 중이면 기다린다.
  - [gate](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/0dea7944c4b7f7032e51f1e84d0bab3cca7cb16e/server/decisions.ts#L79-L94) · [동작 명세 5번](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/0dea7944c4b7f7032e51f1e84d0bab3cca7cb16e/docs/behavior.md#L43-L56)
- **시작 scan:** `statuses: ["idle","error"]`로 목록을 조회한다. Claude는 `timeline.refetch({direction:"tail",limit:20})`로 마지막 안내를 읽는다. [scan](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/0dea7944c4b7f7032e51f1e84d0bab3cca7cb16e/server/resumer.ts#L229-L280)
- **launch env 관찰:** `before("agent.session_open")`에서 값을 반환하지 않고 launch env만 기록한다. [hook 등록](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/0dea7944c4b7f7032e51f1e84d0bab3cca7cb16e/index.server.ts#L45) · [rememberSession](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/0dea7944c4b7f7032e51f1e84d0bab3cca7cb16e/server/resumer.ts#L128-L130) · [captureLaunch](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/0dea7944c4b7f7032e51f1e84d0bab3cca7cb16e/server/subscription.ts#L52-L57)

## 1. 1st-party 지연 전송 기능

### 1.1 Schedule 서비스와 heartbeat

heartbeat는 별도 서비스가 아니다. CLI가 `PASEO_AGENT_ID`(호출한 에이전트)를 대상으로 cron schedule을 만드는 래퍼다. [heartbeat create](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/cli/src/commands/heartbeat/index.ts#L57-L86)

**검증과 전달**(`executeSchedule`):

```ts
const record = await this.agentStorage.get(schedule.target.agentId);
if (!record) throw new ScheduleTargetGoneError(`Agent ${schedule.target.agentId} no longer exists`);
if (record.archivedAt) throw new ScheduleTargetGoneError(`Agent ${schedule.target.agentId} is archived`);
const agent = await ensureAgentLoaded(schedule.target.agentId, { ... });
if (this.agentManager.hasInFlightRun(agent.id)) throw new Error(`Agent ${agent.id} already has an active run`);
await startAgentRun(this.agentManager, agent.id, wrappedPrompt, this.logger, { replaceRunning: true, activeTurnBehavior: "steer" });
```

[service.ts#L931-L961](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L931-L961)

| 상태 | 처리 |
| --- | --- |
| 레코드 없음 / archived | `ScheduleTargetGoneError` 발생. 영구 실패로 보고 schedule을 바로 `completed`로 끝낸다. 주석: "These are permanent, so the schedule is completed instead of retried". [오류 정의](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L31-L39) · [finishRun](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L870-L876) |
| `closed` | 별도로 검사하지 않는다. `ensureAgentLoaded()`로 저장된 provider 세션을 resume한 뒤 전송한다. |
| busy(`hasInFlightRun`) | 이번 run을 `failed`로 기록한다. schedule은 끝나지 않고 다음 cadence로 넘어간다. 기다리지 않는다. `hasInFlightRun`은 `lifecycle === "running"`, foreground turn, run 등록 중 하나라도 있으면 참이다. [hasInFlightRun](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1030-L1041) |
| 전송 후 permission 또는 error | 그 run을 `failed`로 기록한다. [service.ts#L953-L961](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L953-L961) |
| 전송 중 archive | 다른 경로가 schedule을 이미 `completed`로 바꿨다면 run 결과만 기록하고 재개하지 않는다. archive 콜백이 `completeForAgent`를 호출한다. [finishRun](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L874-L876) · [archive 콜백](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L1432-L1438) |

- **unarchive 여부:** 직접 `startAgentRun`을 호출하므로 unarchive 경로를 거치지 않는다. archived 대상은 위의 사전 검사에서 걸러진다.
- **reopen 실패:** `startAgentRun`이 먼저 `reloadStalePluginSession()`을 수행한다. 여기서 실패하거나 `ensureAgentLoaded`가 실패하면 예외가 run 실패로 기록된다. `isStaleProviderSessionError`만 한 번 reload한 뒤 재시도한다. [agent-prompt.ts#L118-L128](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-prompt.ts#L118-L128)

**claim과 중복 방지:**

- **실행 중 예약:** store I/O 전에 메모리 집합 `runningScheduleIds`로 먼저 예약한다. 주석: "Reserve before store I/O; persisted history cannot prove a run is still alive". [runSchedule](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L714-L773)
- **회차 claim:** `claimDueRun`이 하나의 `store.update` 안에서 due 여부를 다시 확인하고, `running` run 추가와 `nextRunAt` 이동을 함께 수행한다. 주석: "Claim the due slot and advance its cursor in the same serialized update". [claimDueRun](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L775-L825)
- **재시작 복구:** 데몬이 재시작되면 남아 있던 `running` run을 "Daemon restarted before the scheduled run completed"와 함께 `failed`로 바꾸고 다시 보내지 않는다. 데몬이 꺼져 있던 동안 놓친 회차도 실행하지 않고 `nextRunAt`을 현재 이후로 넘긴다. [recoverInterruptedSchedule](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L613-L666)
- **고아 schedule 정리:** 시작 시 대상 레코드가 없거나 archived인 schedule을 `completed`로 정리한다. [sweepOrphanedSchedule](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/schedule/service.ts#L692-L712)

### 1.2 agent 간 메시지 전달(`agent-messages`)

**수신자별 큐:** 같은 수신자의 메시지를 2초 quiet window로 묶어 한 번에 dispatch하고, 수신자별로 직렬화한다. 기본 동작은 `steer`이고, `unarchive`는 하나라도 `false`가 아니면 `true`다.

```ts
activeTurnBehavior: messages[0]!.activeTurnBehavior ?? "steer",
unarchive: messages.some((message) => message.unarchive !== false),
...
entry.cancel = schedule(2000, () => flush(message.recipientId));
```

[delivery.ts#L77-L116](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-messages/delivery.ts#L77-L116) · [enqueue](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-messages/delivery.ts#L144-L164)

- **dispatch 경로:** 실제 dispatch는 `sendPreparedPromptToAgent`가 맡는다. 순서는 archived이면 unarchive → `ensureAgentLoaded` → `startAgentRun`이다. load가 실패하면 archive 상태를 원래대로 되돌린다. [websocket-server.ts#L710-L734](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/websocket-server.ts#L710-L734) · [sendPreparedPromptToAgent](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-prompt.ts#L324-L367)
- **실패 처리:** 이 모듈 안에서는 재시도하지 않는다. receipt를 reject하고 로그만 남긴다. [delivery.ts#L98-L109](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-messages/delivery.ts#L98-L109)
- **사람 프롬프트와의 차이:** 사람이 보낸 프롬프트(`sourceAgentId` 없음)는 이 큐를 거치지 않고 `sendPromptToAgent`로 바로 간다. 이때 기본값은 `interrupt`이고, unarchive 인자를 넘기지 않으므로 기본값 `true`가 적용된다. [session.ts#L8260-L8293](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/session.ts#L8260-L8293)
- **문서의 내구성 설명:** pending window는 메모리에만 있다. clean shutdown이면 flush되지만 크래시가 나면 잃을 수 있다. [agent-lifecycle.md#L126-L131](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L126-L131)

`sendPromptToAgent`의 `unarchive` 옵션 주석:

> Default true. When false, archived agents are skipped instead of being unarchived. Use false for system-injected prompts (chat mentions, schedule fires, notify-on-finish).

[agent-prompt.ts#L225-L230](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-prompt.ts#L225-L230). `unarchive: false`인데 대상이 archived이면 조용히 no-op하고 `turn_started`를 반환한다. [agent-prompt.ts#L328-L339](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-prompt.ts#L328-L339)

**messageId receipt로 중복 방지:** `send_agent_message_request`에 `messageId`가 있으면 `MessageReceipts.send`를 거친다. 클라이언트는 messageId를 생략해도 무작위 UUID를 채워 보낸다. [daemon-client.ts#L3789-L3797](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/client/src/daemon-client.ts#L3789-L3797) · [session.ts#L8302-L8319](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/session.ts#L8302-L8319)

```ts
if (existing) {
  if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
  if (existing.state === "completed") return;
  // A provider may have accepted the message before its receipt was committed.
  throw new Error("agent_request_outcome_unknown");
}
await input.prepare?.();
await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
await input.send();
await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
```

[message-receipts/index.ts#L41-L56](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/message-receipts/index.ts#L41-L56)

- **플러그인에서 쓰기:** 플러그인의 `send()` 옵션 타입(`PaseoAgentSendOptions = SendMessageOptions`)에 `messageId`가 있다. 따라서 안정적인 ID를 넘기면 같은 continue를 다시 보낼 때 데몬 쪽에서 `completed`면 성공으로 끝나고, 크래시로 `pending`이 남았으면 `agent_request_outcome_unknown`으로 구분된다. [SendMessageOptions](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/client/src/daemon-client.ts#L445-L454) · [PaseoAgentSendOptions](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/client/src/index.ts#L287)
- **send()가 언제 resolve되는가:** 사람 경로에서는 `sendPromptToAgent`가 끝나야 응답(`accepted: true`)을 보낸다. 이 과정에는 load·reopen·run 시작 대기가 포함된다. 따라서 `send()`는 resume이나 reopen이 실패하면 reject된다. [session.ts#L8325-L8336](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/session.ts#L8325-L8336) · [SDK 계약 "Resolves when the daemon accepts the prompt"](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/sdk/reference.md#L100)

### 1.3 Finish subscriptions / `wait_for_finish`

**호출자가 살아 있는지:** 레코드가 있으면 `!archivedAt`로 판단한다. 따라서 `closed` 호출자도 "active"로 본다.

```ts
callerIsActive: async (agentId) => {
  const record = await agentStorage.get(agentId);
  return record ? !record.archivedAt : Boolean(agentManager.getAgent(agentId));
},
```

[bootstrap.ts#L1459-L1462](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L1459-L1462)

**호출자 상태에 따른 처리:**

- **archived 또는 삭제됨:** 알림을 억제하고 저장된 intent도 지운다.
- **`closed`:** 메시지 큐(`unarchive: false`, `steer`)를 거쳐 전달하므로 호출자가 깨어난다.
- **child가 `closed`:** child의 종료 사유 중 하나인 `"was closed"`로 보고한다.
- [suppressed/reasonFor](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/finish-subscriptions/index.ts#L149-L169) · [deliver](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/finish-subscriptions/index.ts#L170-L216)

**실패와 중복:**

- **재시도:** 전달이나 저장이 실패하면 캡처한 결과를 유지한 채 backoff 후 다시 시도한다.
- **intent 제거 시점:** 전달이 수락된 뒤에만 지운다. 제거에 실패하면 이미 수락된 callback은 다시 보내지 않고 commit만 다시 시도한다. [run loop](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/finish-subscriptions/index.ts#L256-L304)
- **보장 수준:** 문서는 이것을 "at-least-once wakeup, without turn attribution or exactly-once delivery"라고 명시한다. [agent-lifecycle.md#L140-L155](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L140-L155)

**`wait_for_finish`가 live가 아닌 대상을 다룰 때:**

- **동작:** 저장된 레코드만 읽고 provider를 load하지 않는다.
- **상태 매핑:**
  - `attentionReason === "permission"`이면 `permission`.
  - `lastStatus === "error"`이면 `error`.
  - 나머지(`closed` 포함)는 `idle`.
- **lastMessage:** durable timeline store의 마지막 assistant 메시지를 함께 반환한다.
- 문서 표현은 "Reading a closed child's result does not load its provider"이다.
- [session.ts#L8389-L8421](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/session.ts#L8389-L8421) · [getLastAssistantMessage](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L3512-L3517) · [finish observation](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/finish-subscriptions/internal/observation.ts#L26-L38) · [문서](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L140-L142)

### 1.4 Loops, chat, heartbeat

- **Loops와 chat room:** agent loop와 chat room은 0.14 이전에 제거되었다(`94bda1f92`, [#3053](https://github.com/getpaseo/paseo/pull/3053) "Remove chat rooms and agent loops before storage migration"). v0.14.0 protocol에는 `loop_*`/`chat_*` RPC literal이 없다. 남은 `chat-search`는 검색 기능이다.
- **heartbeat:** 1.1에서 본 대로 schedule을 감싼 래퍼다.
- **잔재:** `unarchive` 주석의 "chat mentions"는 제거된 기능을 가리키는 흔적으로 보인다(추론).

### 1.5 1st-party 비교표

| 기능 | 영구(종료) 판정 | `closed` | busy | unarchive | claim / 중복 방지 | 실패 시 |
| --- | --- | --- | --- | --- | --- | --- |
| Schedule / heartbeat | 레코드 없음, archived, cwd 없음 | 깨워서 전송 | 이번 run 실패, 다음 cadence | 하지 않음(사전 차단) | 메모리 예약 + 원자적 store claim, 재시작 시 `running`→`failed` | run `failed`, 재전송 없음 |
| agent 메시지 | 없음(호출 측 책임) | 깨워서 전송 | `steer`(기본) | 기본 `true` | 2초 묶음, 수신자별 직렬화 | reject + 로그 |
| 사람/SDK `send()` | 레코드 없음 | 깨워서 전송 | 기본 `interrupt`, 옵션 `steer` | 항상 `true` | `messageId` 영속 receipt | 응답 오류 |
| Finish 알림 | 호출자 archived/삭제 | 호출자를 깨움 | `steer` | `false` | 영속 intent, 수락 후 제거 | backoff 재시도(at-least-once) |
| `wait_for_finish` | 레코드 없음 | load 없이 저장 상태로 응답 | 대기 | 해당 없음 | 해당 없음 | timeout |

## 2. Lifecycle 의미(v0.14)

**상태 집합:** `initializing | idle | running | error | closed`. [protocol agent-lifecycle](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/protocol/src/agent-lifecycle.ts#L1-L9) · [plugin reference `useAgent` 상태](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/plugins/reference.md#L2043)

| 상태 | 의미(문서·코드) |
| --- | --- |
| `initializing` | live 에이전트가 세션을 여는 중. 데몬이 시작될 때 저장된 `initializing`/`running`은 모두 `closed`로 고쳐진다. [closeStaleAgentRecords](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L2008-L2016) |
| `idle` | turn이 없고 다음 프롬프트를 받을 수 있음. |
| `running` | foreground turn 진행 중. `hasInFlightRun`의 한 조건. |
| `error` | turn 실패 후 상태. `lastError`가 함께 저장되고, 새 stream이 시작되거나 turn이 완료·취소되면 지워진다. [streamAgent](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L2809) · [turn completed](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L4788) |
| `closed` | "the persisted, resumable state for an agent record that has no live provider runtime". "An unarchived agent may be `closed` without being deleted or archived." 프롬프트를 보내거나 열면 `ensureAgentLoaded()`로 같은 ID의 provider 세션이 resume된다. [agent-lifecycle.md#L13-L22](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L13-L22) |
| archived | 상태값이 아니라 `archivedAt` 필드. "soft delete"이며 런타임도 닫힌다. [agent-lifecycle.md#L189-L194](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L189-L194) |

### `closed`가 생기는 경로

| 원인 | 근거 | 사용자 의도? |
| --- | --- | --- |
| idle 런타임 정리(1시간, 1분 주기) | [`getRuntimeCleanupCandidates`](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1846-L1901) · [문서](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L28-L33) | 아님 |
| 데몬 종료(`closeAllAgents`) | [bootstrap.ts#L2026-L2041](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L2026-L2041) | 아님 |
| 크래시 후 시작 시 `running`/`initializing` 보정 | [bootstrap.ts#L2008-L2016](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L2008-L2016) | 아님 |
| provider 은퇴(플러그인 provider 제거 등) | [agent-manager.ts#L863-L873](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L863-L873) | 간접 |
| reload 실패. 기존 세션을 닫은 뒤 실패하면 `closed`, 닫기 전에 실패하면 `error` + `lastError` | [agent-manager.ts#L1732-L1740](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1732-L1740) · [문서](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L24-L26) | 아님 |
| archive. `closeAgentRuntime`를 거치므로 `agent.closed`가 `agent.archived`보다 먼저 나간다 | [archiveAgentUnlocked](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1986-L2029) | 예(archive) |
| delete | [handleDeleteAgentRequest](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/session.ts#L3309-L3335) | 예(삭제) |

- **명시적 close 수단:** 없다. `closeAgentCommand`를 호출하는 곳은 delete 경로뿐이다.
  - `paseo agent stop`은 "Interrupt an agent if it is running (no-op for idle agents)"이다. [stop.ts#L26](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/cli/src/commands/agent/stop.ts#L26) · [stop.ts#L85-L90](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/cli/src/commands/agent/stop.ts#L85-L90)
  - `close_items_request`는 에이전트를 archive한다. [session.ts#L3443-L3456](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/session.ts#L3443-L3456)
- **"끝났다"는 의도의 표현:** 문서는 탭 닫기를 "closing it means 'I'm done with this agent.'"라고 설명하고, 그 결과는 archive다. [agent-lifecycle.md#L252](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L252)

### "release되었지만 resume 가능"을 구별하는 필드

저장 레코드의 payload(`buildStoredAgentPayload`)에 있는 필드는 다음과 같다. [agent-projections.ts#L208-L265](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-projections.ts#L208-L265)

- `status: record.lastStatus`
- `persistence`(wire 투영된 handle)
- `archivedAt`, `lastError`, `requiresAttention`, `attentionReason`, `providerUnavailable`, `labels`
- `updatedAt`, `lastUserMessageAt`
- `pendingPermissions`는 항상 `[]`이다. `closed`로 넘어갈 때 대기 중인 권한 요청도 비워진다. [prepareAgentForClosure](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L4007-L4040)

이 필드들로 판단할 수 있는 것과 없는 것:

- **close 원인:** 원인을 담는 필드는 없다. `persistence`가 있고, `archivedAt`이 없고, `providerUnavailable`이 아니면 resume 가능성이 높다고 추론할 수 있을 뿐이다. 그래도 resume이 성공한다는 보장은 없다.
- **`lastError`:** `closed`로 바뀌어도 그대로 유지된다(`toStoredAgentRecord`는 `lastError`를 저장한다). 그래서 "마지막 turn이 실패한 채 닫힘"은 `status: "closed"` + `lastError`로 남는다. [toStoredAgentRecord](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-projections.ts#L75-L110)
- **`updatedAt`:** close 경로(`prepareAgentForClosure` → `persistSnapshot`)는 `updatedAt`을 바꾸지 않는다. 반면 archive는 `updatedAt`을 `archivedAt`으로 설정한다. [archiveAgentUnlocked](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L2020-L2022)

### 플러그인 계약

- **`agent.closed`:** "A live agent runtime closes". 이벤트 payload(`PluginHookAgent`)는 `id, workspaceId, parentAgentId, provider, cwd, title`뿐이고 원인 필드가 없다. [reference.md#L967-L997](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/plugins/reference.md#L967-L997)
- **`closed` 에이전트에 대한 `send()`:** 플러그인 reference에는 명시적인 문장이 없다. SDK 문서는 "Resolves when the daemon accepts the prompt"라고만 하고, lifecycle 문서가 "Opening or prompting the agent runs through `ensureAgentLoaded()`"라고 설명한다. 코드상으로는 unarchive 후 load한 다음 `startAgentRun`을 호출한다. [SDK reference](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/sdk/reference.md#L100) · [agent-lifecycle.md#L17-L22](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L17-L22) · [agent-prompt.ts#L325-L367](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-prompt.ts#L325-L367)
- **wire 옵션:** `SendMessageOptions`에는 `unarchive` 옵션이 없다. 따라서 플러그인 `send()`는 archived 에이전트를 항상 unarchive한다. [daemon-client.ts#L445-L454](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/client/src/daemon-client.ts#L445-L454)
- **usage source 문서의 관련 문장:** "Closed agents have no session scope until resumed." [reference.md#L491-L493](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/plugins/reference.md#L491-L493)

## 3. 플러그인 패턴

| 플러그인 | `before("agent.session_open")` | 행동 전 유효성 판단 | 지연 전송 / 중복 방지 |
| --- | --- | --- | --- |
| `lifecycle-logger` | 값을 그대로 반환(`return request`). env는 로그에서만 가린다. 공식 예제 중 유일한 순수 관찰형 | 없음 | 없음 |
| `lifecycle-actions` | env 추가(변경) | `outcome.kind !== "canceled"`와 출력 정규식만 확인. 상태 검사 없이 즉시 `send("Try again.")` | README: "it keeps sending follow-ups. Add limits or delay" |
| `agent-configuration` | provider가 codex일 때만 MCP 서버 추가, 아니면 `undefined` | 해당 없음 | 없음 |
| `agent-tools` | label이 있을 때만 tool 추가 | 해당 없음 | README: `reload()`는 진행 중 turn을 중단, `refresh()`는 세션을 다시 열지 않음 |
| Auto Compact | `interactive` open이면 예약 무효화 + env 추가. 실패해도 `request`를 반환 | `!archivedAt`, `status !== "closed"`, `idle && !activeTurn && pendingPermissions 없음 && attentionReason !== "permission"`, `internal`/`providerUnavailable`/부모 label 제외, `lastUserMessageAt`·`sessionId`·activityKey 동일 | 전송 전에 refresh를 두 번 하고, 영속 `dispatchStartedAt` marker를 남긴 뒤 `send("/compact", { messageId: id })`. 자동 재시도 없음 |
| Free Your Agents | env를 추가하고, 실패하면 자기 key만 지움 | Paseo 상태 대신 자체 runtime API(`releaseIfIdle`)의 결과(`busy`→deferred) 사용 | owner lease claim/renew. 목록 표시는 `agents.list`만 사용 |

근거:

- **lifecycle-logger:** [index.server.ts#L23-L26](https://github.com/getpaseo/paseo/blob/v0.14.0/plugin-examples/lifecycle-logger/index.server.ts#L23-L26) · [log redaction](https://github.com/getpaseo/paseo/blob/v0.14.0/plugin-examples/lifecycle-logger/server/log.ts#L4-L9)
- **lifecycle-actions:** [turn_ended follow-up](https://github.com/getpaseo/paseo/blob/v0.14.0/plugin-examples/lifecycle-actions/index.server.ts#L20-L31) · [session_open env](https://github.com/getpaseo/paseo/blob/v0.14.0/plugin-examples/lifecycle-actions/index.server.ts#L85-L93) · [README](https://github.com/getpaseo/paseo/blob/v0.14.0/plugin-examples/lifecycle-actions/README.md#L24-L26)
- **agent-configuration / agent-tools:** [agent-configuration](https://github.com/getpaseo/paseo/blob/v0.14.0/plugin-examples/agent-configuration/index.server.ts#L22-L37) · [agent-tools](https://github.com/getpaseo/paseo/blob/v0.14.0/plugin-examples/agent-tools/index.server.ts#L21-L24) · [agent-tools README](https://github.com/getpaseo/paseo/blob/v0.14.0/plugin-examples/agent-tools/README.md#L24-L26)
- **Auto Compact:** [session_open](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/8f9086093ebf39eb40c53bea921d67d1c0f29c6a/index.server.ts#L81-L96) · [eligible/idle](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/8f9086093ebf39eb40c53bea921d67d1c0f29c6a/server/gateway.ts#L36-L46) · [dispatch guard와 marker](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/8f9086093ebf39eb40c53bea921d67d1c0f29c6a/server/gateway.ts#L130-L174)
- **Free Your Agents:** [session_open](https://github.com/babo-jeonguk/paseo-free-your-agents/blob/b5605b9c7f46390837cc035b3b01851b256c7ff9/index.server.ts#L60-L63) · [prepareSession](https://github.com/babo-jeonguk/paseo-free-your-agents/blob/b5605b9c7f46390837cc035b3b01851b256c7ff9/server/backend.ts#L173-L199) · [releaseIfIdle 처리](https://github.com/babo-jeonguk/paseo-free-your-agents/blob/b5605b9c7f46390837cc035b3b01851b256c7ff9/server/control.ts#L133-L166) · [목록 주석](https://github.com/babo-jeonguk/paseo-free-your-agents/blob/b5605b9c7f46390837cc035b3b01851b256c7ff9/server/conversation-metadata.ts#L4-L7)

관찰 포인트:

- **Auto Compact와 `closed`:** `closed`를 명시적으로 부적격 처리한다. 다만 목적이 "깨우지 않고 현재 세션을 압축"이라서 Auto Resume과 판단 기준이 다르다.
- **Free Your Agents의 경고 주석:** "Do not replace this with session.refresh(), getRuntimeInfo(), timeline, or provider RPCs: those can create a native process merely to display a row." 코드상 `refresh()`(`fetch_agent`)는 load하지 않으므로 이 경고는 timeline과 provider RPC에 한해 정확하다. 2.4절과 5절을 참고.
- **session_open 사용:** 세 로컬·공식 플러그인 모두 session_open을 env 변경 용도로 쓴다. 관찰만 하는 공식 예제는 logger뿐이다. 관찰형도 hook을 선언하는 것으로 집계되므로 4절의 무효화 대상이 된다.

## 4. session_open 무효화

### 트리거

`notifySessionOpenChange`는 플러그인이 `agent.session_open` before-hook을 선언했는지만 확인하고 모든 listener를 호출한다. listener는 `agentManager.invalidatePluginSessions()`이며, 데몬 전역 generation을 1 올린다. [runtime.ts#L307-L310](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/runtime.ts#L307-L310) · [bootstrap.ts#L1023-L1025](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L1023-L1025) · [agent-manager.ts#L904-L906](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L904-L906)

호출 지점:

- `startPlugin` [L334](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/runtime.ts#L334)
- `stopPluginById` [L366](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/runtime.ts#L366)
- 플러그인 프로세스 종료(크래시 포함) [L1274-L1279](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/runtime.ts#L1274-L1279)
- `hooks.changed`로 session_open 선언 여부가 바뀔 때 [L955-L965](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/runtime.ts#L955-L965)

플러그인 관리자를 거치는 경로:

- reload는 stop + start이므로 무효화가 두 번 일어난다.
- enable과 disable도 각각 무효화를 일으킨다.
- 데몬 시작 시 설정된 플러그인을 시작할 때도 일어난다. 다만 그 시점에는 저장된 에이전트가 모두 `closed`라서 실제 영향은 거의 없을 것으로 보인다(추론).
- [plugins/index.ts#L213-L233](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/index.ts#L213-L233) · [L451-L482](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/index.ts#L451-L482)

hook이 무엇을 반환했는지, 어느 에이전트를 대상으로 하는지와 관계없이 무효화된다. "변경 없음"을 건너뛰는 검사는 없다.

### reopen 시점과 비용

```ts
private needsPluginSessionReload(agentId: string): boolean {
  const agent = this.getAgent(agentId);
  return agent !== null && agent.lifecycle !== "closed" &&
    this.sessionOpenGenerations.get(agentId) !== this.sessionOpenGeneration &&
    !this.hasInFlightRun(agentId);
}
```

[agent-manager.ts#L908-L926](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L908-L926)

- **실행 시점:** 모든 프롬프트가 거치는 `startAgentRun`이 run을 시작하기 전에 `reloadStalePluginSession()`을 호출한다. turn 중인 에이전트는 reopen 없이 steer되고, 다음 idle 프롬프트에서 reopen된다. [agent-prompt.ts#L118-L120](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-prompt.ts#L118-L120)
- **reopen이 하는 일:** reload는 hook을 `reason: "refresh"`로 다시 실행한 뒤 기존 provider 세션을 닫고("A persisted thread can have only one writer, even when its turn is idle") resume한다. [agent-manager.ts#L1667-L1698](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1667-L1698)
- **실패하면:** 2절의 표처럼 `closed` 또는 `error`가 되고 예외가 다시 던져진다. 문서: "If an automatic reopen fails, the triggering prompt fails with that error." [reference.md#L846-L853](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/plugins/reference.md#L846-L853)
- **Claude background shell:** 문서는 "Claude Code's background Bash shells, `Monitor` watches, and workflows all live in the CLI process"라고 설명한다. reopen은 그 프로세스를 닫으므로 이런 작업은 사라진다고 보는 것이 자연스럽다. 이 연결은 코드와 문서를 읽고 내린 추론이며, upstream이 reopen 비용으로 직접 언급한 적은 없다. [agent-lifecycle.md#L77-L82](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L77-L82)
- **hook이 throw하면:** "Throws or returns invalid data → Operation fails; later callbacks do not run". 관찰형 hook의 예외도 세션 열기를 실패시킨다. [reference.md#L1085-L1086](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/plugins/reference.md#L1085-L1086)

### upstream 논의

- [PR #7938](https://github.com/getpaseo/paseo/pull/7938) "Let plugins give specific agents tools"(2026-10-27 merged)
  - stale/reopen 동작과 `agents.ref(id).reload()`를 도입했다. 리뷰 코멘트는 없다.
  - 본문의 위험 항목: "A failed automatic reopen fails the triggering prompt."
  - 동기가 된 이슈는 [#5427](https://github.com/getpaseo/paseo/issues/5427)(create 시점 MCP가 기존 에이전트에 반영되지 않음)이다.
- [PR #7983](https://github.com/getpaseo/paseo/pull/7983)(2026-10-27 merged)
  - "`agent.session_open` contributes launch-only `env`, `tools`, and `mcpServers`" 모델을 정리했다.
  - install/disable/reload에 #7938의 reopen을 재사용한다.
- **observe-only 예외:** gh 검색(`session_open`, `invalidatePluginSessions`, `reloadStalePluginSession`, `observe-only`, background shell 관련 키워드)에서 관련 논의를 찾지 못했다.
- **훅 없이 env를 얻는 대안 논의:**
  - [Issue #7855](https://github.com/getpaseo/paseo/issues/7855): resume 시 launch env가 사라지는 문제. 우회책으로 session_open 플러그인을 쓰고 있었다.
  - [PR #8127](https://github.com/getpaseo/paseo/pull/8127)(2026-10-28 merged, **v0.14.0 이후**): 생성 시 env를 보존하고("without exposing them in client snapshots"), 재시작 후 working 에이전트에 `Resume working.`을 자동으로 보낸다(`agents.resumeOnStartup`). 0.14.0 태그에는 포함되지 않았다.
  - [PR #6976](https://github.com/getpaseo/paseo/pull/6976)(open): env 전용 `agent.session_maintenance` hook 제안.
  - [Issue #5723](https://github.com/getpaseo/paseo/issues/5723)(open): archive/restore 시 launch context 유실.
- **0.14 안에서 session env를 노출하는 다른 경로:** usage source의 `discover({ kind: "session", provider, model, env })`가 유일하다.
  - 동작: live 세션의 `usageSession()`이 env를 공급한다(Claude는 `harnessEnvironment`). 세션이 없으면 `[]`를 반환하며, 문서도 "Closed agents have no session scope until resumed"라고 적는다.
  - 호출 조건: `registerUsageSource`를 등록해야 하고, `usage.list_reports`가 `agentId`와 함께 호출되어야 한다.
  - 플러그인 server API가 이 RPC를 직접 호출할 수 있는지는 **미확인**이다. v0.14.0 client `index.ts`에서 `listReports` 노출을 찾지 못했다.
  - [usage scope 문서](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/plugins/reference.md#L457-L493) · [discoverAgent](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/plugins/usage-sources/index.ts#L127-L157) · [Claude usageSession](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/providers/claude/agent.ts#L3585-L3593) · [RPC schema](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/protocol/src/messages.ts#L1852-L1855)

## 5. idle 정리와의 상호작용

### 보호 수단

```ts
isProtected: (agentId) =>
  finishSubscriptions.hasPendingForCaller(agentId) ||
  (wsServer?.agentMessages.hasPending(agentId) ?? false),
```

[bootstrap.ts#L1479-L1486](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L1479-L1486)

- **daemon baseline:** idle, foreground turn 없음, run·권한·응답·lifecycle mutation·session event 꼬리 없음, 실행 중 provider subagent 없음. provider의 `canStopRuntime()` veto와 부모·자식 family 단위 판정이 추가된다. [runtimeHasNoPendingWork](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1887-L1901) · [collector](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/idle-runtime-cleanup/index.ts#L45-L136) · [문서](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L35-L52)
- **finish subscription:** agent tool host(`create_agent` 등)를 통해서만 생긴다. `session.ts`와 `daemon-client.ts`에서 클라이언트·플러그인용 등록 RPC를 찾지 못했다. [tool host 의존성](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/bootstrap.ts#L1493-L1500)
- **agent 메시지 pending:** `sourceAgentId`가 있는 메시지가 2초 window와 dispatch 동안만 유지하는 상태다.
- **결론:** 플러그인이 특정 에이전트를 보호하는 정식 수단은 없다. 데몬 전체 설정 `agents.idleRuntimeCleanup: false`만 있다. 플러그인이 이 설정을 바꾸는 것이 의도된 용도인지는 문서에 없다(**미확인**). provider 플러그인의 `canStopRuntime` veto는 자기 provider의 런타임에만 적용된다. [agent-lifecycle.md#L28-L33](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L28-L33) · [L74-L75](https://github.com/getpaseo/paseo/blob/v0.14.0/docs/agent-lifecycle.md#L74-L75)

### 어떤 호출이 깨우거나 시계를 리셋하는가

idle 시계는 live 에이전트의 `updatedAt`이다(`lastActivityAt: updatedAt.getTime()`). `isEligible()`은 수집 시점까지 `updatedAt`이 바뀌지 않았는지도 확인한다. [agent-manager.ts#L1850-L1867](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1850-L1867)

`touchUpdatedAt` 호출부는 모두 변경·실행 경로다(setMode/Model/Thinking/Feature/Title/labels, `notifyAgentState`, `streamAgent`, turn 종료, 권한 응답, 취소, 새 세션 등록). 읽기 경로에서는 호출하지 않는다. [touchUpdatedAt](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1014-L1021)

| 플러그인 호출 | RPC | 런타임을 깨우는가 | 시계 리셋 |
| --- | --- | --- | --- |
| `agents.ref(id).refresh()` | `fetch_agent`: live이면 투영, 아니면 저장 레코드 | 아니오 | 아니오 |
| `agents.list()` | `AgentDirectory.list`: live 목록과 storage를 병합 | 아니오 | 아니오 |
| `timeline.refetch()` | `fetch_agent_timeline_request` → `ensureAgentLoaded` | **예**(closed면 resume, session_open hook도 `reason: "resume"`으로 실행) | live 대상은 아니오. resume은 `restoring: true`로 기존 `updatedAt`을 보존 |
| `waitForFinish()` | `wait_for_finish_request`: 비 live 대상은 저장 레코드와 durable 마지막 assistant 메시지 | 아니오(비 live) | 아니오 |
| `send()` | `sendPromptToAgent` | 예 | 예(`streamAgent`) |
| `reload()` | `refresh_agent_request` | 예(재오픈) | 아니오(reload도 `restoring: true`) |

근거: [client refresh/reload/send](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/client/src/index.ts#L984-L997) · [client timeline.refetch](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/client/src/index.ts#L916-L917) · [getAgentPayloadById](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/session.ts#L5383-L5396) · [AgentDirectory.list](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/directory.ts#L49-L86) · [timeline handler](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/session.ts#L7783-L7801) · [ensureAgentLoaded](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-loading.ts#L70-L146) · [resume hook reason](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1503-L1529) · [restoring 시 touch 생략](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L3834-L3841) · [reload restoring](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/server/src/server/agent/agent-manager.ts#L1720-L1731)

**추론(실측 미확인):** `closed` 에이전트를 `timeline.refetch()`로 깨우면 예전 `updatedAt`을 그대로 가진 새 런타임이 생긴다. 새 세션은 collector의 `protectedAt` identity도 새로 받는다. 따라서 baseline과 provider veto를 통과하면 다음 sweep(최대 약 1분 뒤)에 다시 정리될 가능성이 있다. 즉 scan을 위해 깨우는 비용은 provider 프로세스 기동과 session_open hook 실행이고, 깨운 상태가 오래 유지된다는 보장은 없다.

## 설계에 주는 시사점

각 참고 자료가 어떤 선택지를 뒷받침하거나 반대하는지만 정리한다. 선택은 하지 않는다.

### (a) due 시각 gate에서 `closed`를 어떻게 분류할지

- **"resume 가능, 전송 진행"을 뒷받침하는 근거:**
  - lifecycle 문서가 `closed`를 resume 가능 상태로 정의한다.
  - schedule과 finish 알림은 `closed`를 깨워서 보낸다.
  - 사용자의 "끝" 의도는 archive로만 표현되고 archive는 이미 별도로 취소된다.
  - 0.14부터 1시간 idle이면 흔히 `closed`가 되므로, 지금의 "closed = 취소" 규칙(behavior 5번)은 몇 시간 뒤가 due인 예약 대부분을 취소하게 된다(추론).
- **"전송 진행" 시 주의할 근거:**
  - `closed` 레코드는 `pendingPermissions`가 항상 비어 있다. 권한 대기는 `attentionReason`으로만 남는다.
  - 원인 필드가 없어서 reload 실패나 provider 은퇴로 닫힌 경우도 구별할 수 없다.
  - resume이 실패하면 `send()`가 reject되고, 에이전트는 "closed and retryable"로 남는다. 현재처럼 `send_failed`로 끝낼지, 재시도할지 정해야 한다.
  - `providerUnavailable`과 `persistence` 없음은 resume이 불가능하다는 신호로 쓸 수 있다.
- **"기다림"을 뒷받침하는 근거:** `initializing`은 일시 상태다(`ensureAgentLoaded`가 진행 중인 초기화를 공유한다). schedule은 `hasInFlightRun`만 busy로 본다.
- **"취소"를 뒷받침하는 근거:** Auto Compact는 `closed`를 부적격으로 본다. 다만 깨우지 않는 것이 목적인 기능이라 그대로 옮겨 오기는 어렵다.
- **0.14 이후 주의:**
  - #8127 이후 Paseo가 재시작 때 working 에이전트에 `Resume working.`을 자동으로 보낸다. 플러그인 continue와 중복될 수 있다.
  - 이 자동 프롬프트가 `lastUserMessageAt`을 갱신하는지는 **미확인**이다.

### (b) 런타임을 깨우지 않고 `closed` 에이전트까지 시작 scan에 포함하기

- **현재 동작:** `statuses: ["idle","error"]`는 `closed`를 제외한다. 데몬 종료(`closeAllAgents`)와 idle 정리를 거치면 대부분의 에이전트가 `closed`로 저장되므로, 재시작 후 scan이 놓치는 범위가 넓다(추론). close는 `updatedAt`을 바꾸지 않으므로 기존 `SCAN_WINDOW_MS` 필터는 그대로 쓸 수 있다.
- **깨우지 않고 쓸 수 있는 신호:**
  - `agents.list`/`refresh()`: 저장 레코드만 읽는다. Codex 계열은 `status: "closed"` + `lastError`(성공한 turn 이후에는 지워짐)로 판정할 수 있다.
  - Claude는 `waitForFinish()`의 비 live 경로가 durable 마지막 assistant 메시지를 load 없이 돌려준다. 단 `error`/`notification` timeline 항목은 포함되지 않는다.
  - Claude 한도 안내가 assistant 메시지로 남는지는 이 문서에서 검증하지 않았다(**미확인**). live idle 대상에 대한 `waitForFinish`의 즉시 반환 여부도 **미확인**이다(`waitForActive: true`).
- **현재 방식(`timeline.refetch`) 유지 시 비용:**
  - `closed`마다 provider 프로세스를 띄운다.
  - session_open hook이 실행되고(이 플러그인의 `captureLaunch`도 실행됨), Free Your Agents가 경고한 "create a native process merely to display a row"에 해당한다.
  - 깨운 런타임은 곧 다시 정리될 수 있다.
- **대안:** 0.14에서 load 없이 durable timeline tail을 읽는 공개 API는 찾지 못했다(**미확인**). 데몬 내부에는 `durableTimelineStore`가 있다.

### (c) session_open hook을 유지할지 대체할지

- **유지할 때의 비용:**
  - 이 플러그인을 설치·업데이트·reload하거나 플러그인이 크래시할 때마다, 모든 live 에이전트가 다음 idle 프롬프트 전에 reopen된다(관찰형이어도 예외 없음).
  - Claude는 프로세스 안의 background shell과 Monitor를 잃을 수 있다(추론).
  - reopen이 실패하면 사용자 프롬프트와 이 플러그인의 continue `send()`가 실패한다.
  - hook이 throw하면 세션 열기 자체가 실패한다.
- **유지할 때 얻는 것의 한계:** env는 세션이 열릴 때만 들어온다. due 시각의 `closed` 에이전트에 대해서는 이전 open에서 기록한 값이거나, 플러그인이 재시작된 뒤라면 아예 없다. hook이 주는 정보는 원래 부분적이다.
- **대체 후보:**
  - (1) hook 없이 daemon env와 runtime env만으로 identity를 판정한다. 현재 코드 주석이 "only values other session-open hooks add are unseen"이라고 인정하는 한계가 그대로 남는다. [subscription.ts#L88-L91](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/0dea7944c4b7f7032e51f1e84d0bab3cca7cb16e/server/subscription.ts#L88-L91)
  - (2) usage source session scope를 쓴다. live 세션만 대상이고, 플러그인에서 호출할 수 있는지는 **미확인**이다.
  - (3) #8127의 영속 launch env를 쓴다. 0.14.0 이후 변경이고 payload에는 노출되지 않는다.
  - (4) #6976 같은 upstream 제안을 기다린다. open 상태다.
- **upstream 관점:** observe-only 예외를 요청하거나 논의한 기록이 없으므로, 필요하다면 새 이슈를 열어야 한다.

### (d) 복사할 만한 1st-party 패턴

- **claim:** schedule의 "메모리 예약 + 원자적 store claim + 재시작 시 진행 중 run을 실패 처리하고 재전송하지 않음"은 현재 플러그인의 `sending` claim과 restart 시 `interrupted` 처리와 같은 방향이다.
- **중복 방지:** `send()`에 안정적인 `messageId`(예: job id)를 넘기면 데몬 쪽 영속 receipt가 크래시 사이 중복 전송을 `agent_request_outcome_unknown`으로 드러낸다. 플러그인 claim을 보완하거나 일부 대체할 수 있다. Auto Compact가 이미 `send("/compact", { messageId: id })`를 쓴다.
- **busy 처리:**
  - schedule은 진행 중인 run이 있으면 그 회차를 실패시킬 뿐 기다리지 않는다.
  - 알림 계열은 큐에 넣고 `steer`한다.
  - 플러그인의 "turn 중이면 wait, 사이에 시작된 turn은 steer"는 두 방식의 중간이다.
- **영구 실패 범위:** 1st-party는 "대상 없음/archived"만 영구 실패로 보고 즉시 종료한다. 그 밖의 실패는 그 회차만 실패시키거나 재시도한다(finish 알림은 at-least-once).
- **놓친 회차:** schedule은 데몬이 꺼져 있던 동안 놓친 회차를 실행하지 않는다. 플러그인은 재시작 후 지난 due를 실행하므로 이 점은 의도적으로 다르다.
- **이중 확인:** Auto Compact는 "refresh → 확인 → refresh 재확인 → 영속 marker → send(messageId) → 자동 재시도 없음" 순서를 쓴다. 현재 플러그인의 두 번째 `agentGate`(behavior 11번)와 claim은 같은 구조이고, `messageId`만 빠져 있다.
