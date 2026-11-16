# Paseo 0.16.0 정식 버전: beta.1 이후 변경 조사

조사일: 2026-11-16. 비교 대상은 `0.16.0-beta.1`과 정식 `0.16.0`이다. 정식 버전은 2026-11-16에 공개됐다. npm에 배포된 `@getpaseo/client`, `@getpaseo/plugin`, `@getpaseo/protocol`의 `dist` 타입 선언과 [정식 릴리스 노트](https://github.com/getpaseo/paseo/releases/tag/v0.16.0)를 대조했다. 설치 경로는 beta가 `/tmp/paseo-0.16.0-beta.1`, 정식이 `/tmp/paseo-0.16.0`이다.

## 결론

이 플러그인의 코드를 바꿔야 하는 계약 변경은 세 가지다.

1. `agent.turn.after`(`agent.turn_ended`)에서 `timeline` 필드가 제거됐다. 플러그인은 이미 `timeline.refetch`로 에이전트의 대화 기록을 읽으므로, 제거된 필드에 의존하던 타입 유도만 고치면 된다.
2. `PluginHookAgent`와 session-open 요청에 `background: boolean`이 필수로 추가됐다. 훅 payload를 만드는 테스트 픽스처가 이 값을 넣어야 하고, `timeline`을 넣던 픽스처는 더 이상 넣을 수 없다.
3. Settings → Plugins가 plugin 갤러리로 바뀌어 설치된 plugin 행 자체가 상세 페이지를 연다. 행의 `Settings` 버튼은 없어졌다. e2e harness의 설정 진입 locator만 고치면 된다.

구독(subscription), 플러그인 동시 시작, workspace 행 배지, `backgroundWork.count`, 리뷰 모드 `all`은 플러그인 코드를 바꾸지 않아도 된다. 정식 0.16.0에서 이 플러그인의 동작이 달라지는 부분은 발견하지 못했다. 실제 실행 결과는 [정식 버전 실행 검증 문서](../paseo-0.16-verification.md)를 따른다.

## `agent.turn.after.timeline` 제거 (#9573)

beta.1의 `PluginHookEvents["agent.turn.after"]`는 `timeline`을 항상 빈 배열로 실어 보냈고 `@deprecated`로 표시돼 있었다. 정식에서는 필드가 완전히 빠지고, 대신 `timeline.refetch`로 읽으라는 설명과 `turnId`가 남았다. [PR #9573](https://github.com/getpaseo/paseo/pull/9573), [정식 릴리스의 Breaking 항목](https://github.com/getpaseo/paseo/releases/tag/v0.16.0)

이 플러그인은 0.16 beta 대응 때부터 turn end에서 `event.timeline`을 읽지 않고 `api.agents.ref(id).timeline.refetch({ direction: "tail", limit: 20 })`를 읽었다. 따라서 동작 변경은 없고, `server/paseo-types.ts`의 `AgentTimelineItem`을 turn end payload가 아니라 timeline read의 반환에서 유도하도록 바꿨다. 제거된 필드를 검사하던 테스트는 남은 동작, 즉 timeline이 없는 turn end가 에이전트의 timeline read로 분류된다는 테스트로 교체했다.

## 훅과 session-open의 `background` 필드 (#9362)

정식의 `PluginHookAgent`와 `PluginSessionOpenRequest`는 `readonly background: boolean`을 필수로 가진다. 에이전트 snapshot에는 `backgroundWork.count`도 추가됐다. [PR #9362](https://github.com/getpaseo/paseo/pull/9362), [PR #8683](https://github.com/getpaseo/paseo/pull/8683)

플러그인의 background 판정은 Paseo 정의인 `agent.background || workspace.background`를 그대로 쓴다. hook payload가 agent 자신의 flag를 이제 직접 실어 주므로 agent snapshot을 읽는 경로는 그대로 두되, workspace flag는 여전히 workspace read가 필요하다. `server/background.ts`의 주석을 그에 맞게 고쳤고, 훅 payload 픽스처에 `background`를 넣었다. `backgroundWork.count`는 예약 판정에 쓰지 않는다.

## plugin 갤러리와 설정 상세 페이지 (#8675, #9752)

0.16.0은 Settings → Plugins를 갤러리로 바꾸고, 설치된 plugin의 행을 누르면 상세 페이지에서 그 plugin의 설정을 직접 렌더링한다. 업데이트가 있으면 같은 이름의 `Updates` 행이 위에 나타날 수 있다. [PR #8675](https://github.com/getpaseo/paseo/pull/8675), [PR #9752](https://github.com/getpaseo/paseo/pull/9752), [릴리스 노트의 Built-in plugin gallery](https://github.com/getpaseo/paseo/releases/tag/v0.16.0)

제품 코드는 바뀌지 않는다. e2e harness의 `openSettings`가 더 이상 행 안의 `Settings` 버튼을 찾지 않고, 설치된 행(`Usage Auto Resume` 버튼, 여러 개면 마지막 것)을 눌러 상세 페이지의 `Automatic resume` 제목을 기다린다. plugin 행 snapshot 수집은 유지한다.

## 구독과 플러그인 동시 시작 (#8527, #8427)

plugin subscription은 daemon의 이벤트를 plugin 패널로 stream하고 RPC/event에 `Uint8Array` payload를 허용한다. 이 플러그인은 이미 `auto-resume.changes` 구독으로 예약·결과 변경을 push하고 있어 정식에서도 그대로 동작한다. [PR #8527](https://github.com/getpaseo/paseo/pull/8527)

daemon은 설정된 plugin들을 순차가 아니라 동시에 시작한다. 플러그인의 시작 스캔은 Paseo API가 아직 연결되지 않았으면 기다렸다가 붙는 구조라 변경이 필요 없다. [PR #8427](https://github.com/getpaseo/paseo/pull/8427)

## 그 밖의 추가 사항

- plugin이 sidebar workspace 행에 배지를 붙일 수 있다(#7645). 이 플러그인은 배지를 쓰지 않는다.
- plugin composer control, draft/attachment 편집, agent metadata 저장(#8744, #9209, #9207, #9734)은 이 플러그인의 화면·RPC에 영향이 없다.
- 리뷰 모드 `all`은 이 플러그인의 예약·전달 경로와 무관하다.

## 조사 방법과 한계

beta.1과 정식 패키지의 `dist` 선언을 비교하고, 정식 릴리스 노트의 Plugins/Breaking 항목과 대조했다.

```bash
diff -rq /tmp/paseo-0.16.0-beta.1/node_modules/@getpaseo/plugin/dist \
         /tmp/paseo-0.16.0/node_modules/@getpaseo/plugin/dist
diff -rq /tmp/paseo-0.16.0-beta.1/node_modules/@getpaseo/client/dist \
         /tmp/paseo-0.16.0/node_modules/@getpaseo/client/dist
diff -rq /tmp/paseo-0.16.0-beta.1/node_modules/@getpaseo/protocol/dist \
         /tmp/paseo-0.16.0/node_modules/@getpaseo/protocol/dist
gh release view v0.16.0 -R getpaseo/paseo
```

Paseo 소스 전체를 다시 읽지는 않았고, 위 패키지 선언·릴리스 노트·실행 검증으로 확인한 범위만 기록했다. 모바일 네이티브 앱과 원격 host는 검증 범위 밖이다.
