# Paseo 0.13.0 변경 사항과 Usage Auto Resume 영향

조사일: 2026-10-27  
대상: Paseo `v0.12.0` → `v0.13.0`, Usage Auto Resume `99eaebd1471c211478b70f9ecc7a38a9bc35f454`

## 결론

Paseo 0.13.0은 2026-10-24에 릴리스되었고, 연결된 호스트, 폴더블 레이아웃, 통합 Changes 화면과 여러 플러그인 API를 추가했다. 공식 릴리스에는 별도의 `Breaking` 또는 `Before upgrading` 절이 없지만, 플러그인 관점에서는 `agent.turn_ended.timeline`을 항상 빈 배열로 보내는 의도적인 동작 변경이 있다. [공식 릴리스](https://github.com/getpaseo/paseo/releases/tag/v0.13.0) · [v0.13.0 changelog](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L3-L93) · [v0.12.0…v0.13.0 비교](https://github.com/getpaseo/paseo/compare/v0.12.0...v0.13.0)

이 프로젝트에는 한 가지 필수 수정이 있다. 현재 라이브 `agent.turn_ended` 훅은 `event.timeline`에서 사용 한도 안내를 찾는데, 0.13에서는 이 배열이 비어 있으므로 특히 `outcome.kind === "completed"`인 Claude 안내처럼 outcome 밖 timeline에만 있는 신호를 놓치고 예약을 만들지 못할 수 있다. 기존의 bounded timeline 조회 함수 `timelineTail()`을 라이브 훅에서도 사용하고, 빈 이벤트 타임라인에 대한 회귀 테스트를 추가해야 한다. [현재 라이브 훅](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/server/resumer.ts#L142-L147) · [현재 bounded 조회 함수](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/server/resumer.ts#L225-L229) · [Paseo 0.13 lifecycle 계약](https://github.com/getpaseo/paseo/blob/v0.13.0/packages/plugin/src/server/lifecycle.ts#L39-L54)

그 밖의 변경은 선택적 개선 또는 운영상 주의 사항이다. 현재 최소 호스트 버전 `>=0.11.0`을 유지한다면 `/client/react-native` import는 당장 바꾸지 않는 편이 안전하며, 연결된 원격 호스트의 에이전트까지 자동 재개하려면 각 원격 데몬에도 플러그인을 설치해야 한다.

## 0.13.0 변경 사항 요약

### 제품과 호스트

- 연결된 호스트가 추가되어 한 데몬에서 다른 직접·SSH·relay 호스트의 에이전트를 생성하고 프롬프트를 보내고 모니터링할 수 있다. 플러그인 서버 컨텍스트에도 `paseo.hosts`가 추가되었지만, 호스트 B에서 발생한 lifecycle hook은 호스트 A로 전달되지 않는다. [changelog](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L13-L19) · [플러그인 connected-host 계약](https://github.com/getpaseo/paseo/blob/v0.13.0/public-docs/plugins/reference.md#L25-L42)
- 폴더블 기기는 펼쳤을 때 wide layout으로 전환하고, Explorer는 휴대폰·태블릿·데스크톱에서 같은 탭과 런처를 사용한다. 사이드바의 기본 정렬과 긴 프로젝트 그룹 표시도 바뀌었다. [changelog](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L13-L31)
- Changes 패널의 기본 보기가 브랜치 기준 이후의 커밋된 변경과 미커밋 변경을 함께 보여 주는 **All changes**로 바뀌었고, 터미널은 이미지 붙여넣기와 파일 드롭을 로컬·원격 호스트에서 지원한다. [changelog](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L13-L19)
- 암호가 설정된 데몬의 relay 연결도 이제 데몬 암호를 요구한다. 암호 없이 저장한 relay 호스트는 다시 추가해야 한다. [changelog](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L20-L37)

### 플러그인 플랫폼

- 파일 패널, `useTabState`, `addAgentPanel`, 통합된 workspace/agent/file panel props가 추가되었다. 기존 panel의 `context`, `agentId` props와 `addWorkspacePanel.context`는 deprecated이며 `params.agentId`와 `addAgentPanel`이 권장된다. [changelog](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L38-L50) · [패널 API 설명](https://github.com/getpaseo/paseo/pull/7685)
- 런타임 번역과 번역된 플러그인 listing, Paseo 렌더러를 쓰는 `Markdown`, inline SVG·컴포넌트 아이콘이 추가되었다. 모두 새 기능이므로 현재 기능을 유지하는 데 필수는 아니다. [changelog](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L38-L50)
- Paseo UI import는 `@getpaseo/plugin/client/ui`로 통합되었다. 기존 `@getpaseo/plugin/client/react-native` entry는 0.13에서도 재수출되므로 동작하지만 deprecated이고, 공식 소스는 2027-04-20 이후 제거 예정이라고 명시한다. [UI entrypoint PR](https://github.com/getpaseo/paseo/pull/7474) · [0.13 deprecated 재수출](https://github.com/getpaseo/paseo/blob/v0.13.0/packages/plugin/src/client/react-native.ts)
- `agent.turn_ended.timeline`은 deprecated이며 항상 `[]`이다. 필요한 플러그인은 `context.paseo.agents.ref(event.agent.id).timeline.refetch({ direction: "tail", limit: 20 })`처럼 필요한 범위만 조회해야 한다. 호환성 플래그나 이전 payload를 복구하는 version floor는 없다. [0.13 플러그인 레퍼런스](https://github.com/getpaseo/paseo/blob/v0.13.0/public-docs/plugins/reference.md#L639-L672) · [의도적 동작 변경 PR](https://github.com/getpaseo/paseo/pull/7477)
- 플러그인 헤더 버튼의 좁은 화면 표시, 재개한 ACP 플러그인 에이전트의 빈 채팅, notification timeline transformer 로딩이 수정되었다. 이 프로젝트는 해당 API를 사용하지 않는다. [changelog](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L47-L50)

## 이 프로젝트에 미치는 영향

### 1. 필수: 라이브 turn-ended 한도 감지를 bounded refetch로 전환

현재 `onTurnEnded()`는 `detectLimitStop(outcome, event.timeline, observedAt)`를 호출한다. `detectLimitStop()`은 실패 outcome의 `error.message`뿐 아니라 timeline의 `error`, 경고 `notification`, 마지막 `assistant_message`도 검사한다. 따라서 0.13에서도 사용 한도 코드·문구가 `outcome.error`에 직접 들어 있는 실패는 감지될 수 있지만, timeline에만 있는 완료형 안내는 감지되지 않는다. [호출부](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/server/resumer.ts#L142-L147) · [감지 입력](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/server/limit.ts#L78-L111) · [0.13 빈 timeline 계약](https://github.com/getpaseo/paseo/blob/v0.13.0/public-docs/plugins/reference.md#L711-L735)

권장 구현은 기존 `timelineTail(api, agentId)`을 재사용하는 것이다. 이 함수는 공식 권고와 같은 tail 20개 조회를 이미 수행하고, startup recovery에서도 Claude의 마지막 안내를 검사하는 데 쓰인다. 최소 지원 버전 0.11/0.12의 기존 payload도 활용하려면 `event.timeline.length > 0 ? event.timeline : await timelineTail(api, event.agent.id)`로 호환할 수 있다. 항상 bounded refetch하는 구현도 0.13 계약에는 맞지만 매 turn마다 추가 RPC가 발생한다. [기존 helper와 startup 사용처](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/server/resumer.ts#L225-L265) · [공식 마이그레이션 예](https://github.com/getpaseo/paseo/pull/7477)

추가할 회귀 테스트:

1. `event.timeline = []`이고 `timeline.refetch()`의 tail에 완료형 Claude 한도 안내가 있으면 예약이 생성된다.
2. refetch가 오류를 반환하거나 tail에 한도 안내가 없으면 예약을 만들지 않는다.
3. 기존 0.11/0.12식 non-empty 이벤트 timeline도 계속 감지한다.

`timeline.refetch()`용 fake와 timeline fixture는 이미 테스트 harness에 있으므로 새 프로덕션 경계는 필요하지 않다. [기존 테스트 harness](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/server/resumer.test.ts#L73-L137) · [현재 turn-ended fixture](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/server/resumer.test.ts#L196-L221)

### 2. 정책 결정: SDK pin과 deprecated UI import

프로젝트는 `@getpaseo/client`, `@getpaseo/plugin`, `@getpaseo/protocol`을 모두 `0.11.0`에 고정하고, manifest는 Paseo `>=0.11.0`을 지원한다고 선언한다. Paseo 0.13의 plugin package도 client/protocol 0.13을 정확한 peer version으로 요구하므로 SDK를 올릴 때는 세 패키지를 함께 올려야 한다. [현재 dependency pins](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/package.json#L35-L47) · [현재 host requirement](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/paseo-plugin.json#L1-L7) · [0.13 plugin package peers](https://github.com/getpaseo/paseo/blob/v0.13.0/packages/plugin/package.json#L70-L89)

현재 다섯 파일은 `Icon`, `ScrollView`, `TextInput`, `useToast`를 deprecated `/client/react-native`에서 가져온다. 0.13에서는 계속 동작하지만, 0.11의 `/client/ui`는 이 UI들을 내보내지 않으므로 import만 즉시 옮기면 manifest의 0.11 지원과 어긋난다. 현재 import: [screen](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/client/screen.tsx#L1-L6) · [conversation](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/client/conversation.tsx#L1-L5) · [note editor](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/client/note-editor.tsx#L1-L4) · [settings](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/client/settings.tsx#L1-L6) · [time editor](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/client/time-editor.tsx#L1-L4). Upstream 근거: [0.11 client/ui exports](https://github.com/getpaseo/paseo/blob/v0.11.0/packages/plugin/src/client/ui.ts) · [0.13 deprecated compatibility entry](https://github.com/getpaseo/paseo/blob/v0.13.0/packages/plugin/src/client/react-native.ts)

선택지는 다음 두 가지다.

- **0.11 이상 지원 유지(권장):** 당장은 deprecated import를 유지하고 0.11과 0.13 두 SDK 조합을 CI/릴리스 전에 검증한다. lifecycle fix는 0.11에도 이미 존재하는 `timeline.refetch()` API만 사용하므로 최소 버전을 올릴 이유가 없다.
- **0.13 이상으로 기준 상향:** manifest를 `>=0.13.0`으로 바꾸고 세 Paseo SDK pin을 함께 0.13으로 올린 뒤, 다섯 파일의 UI import를 `/client/ui`로 이동한다. 이 경우 0.11/0.12 호스트 지원을 의도적으로 중단한다.

### 3. 운영 문서: 연결된 원격 호스트

Paseo 0.13에서 플러그인은 데몬별로 설치되고, 선택된 호스트가 bundle, Paseo API, RPC transport와 query cache를 제공한다. 같은 contribution이 여러 호스트에 있으면 Paseo가 하나의 sidebar item과 호스트 선택기를 보여 준다. 호스트 B의 lifecycle hook은 A로 전달되지 않으므로, 이 플러그인이 원격 위임 에이전트의 한도 중단까지 감지하려면 B의 데몬에도 플러그인이 설치되어 있어야 한다. [connected-host API와 hook 범위](https://github.com/getpaseo/paseo/blob/v0.13.0/public-docs/plugins/reference.md#L25-L42) · [plugin host lifecycle](https://github.com/getpaseo/paseo/blob/v0.13.0/public-docs/plugins/reference.md#L2053-L2074)

현재 로컬 데몬 범위의 동작에는 코드 변경이 필요하지 않다. README/behavior 문서에 “연결된 각 호스트에 설치해야 해당 호스트의 에이전트를 자동 재개한다”는 운영 조건을 추가하는 것이 좋다.

### 4. 선택적 제품 개선

- 기존 한국어 README가 있으므로 0.13의 plugin runtime/listing translations를 도입해 현재 hard-coded 영어 UI와 listing을 현지화할 수 있다. 번역은 새 기능이며 0.11 지원을 유지하는 동안에는 적용하지 않는 편이 일관적이다. [0.13 translation 변경](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L38-L46)
- file panel, `Markdown`, panel state와 richer icon 기능은 Auto Resume의 현재 예약·설정 화면에 필요한 마이그레이션이 아니다. [0.13 plugin 기능 목록](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L38-L50)
- 폴더블에서 compact/wide layout이 런타임에 바뀌므로 실제 fold/unfold smoke test는 유용하지만, 호스트가 제공하는 `layout.compact`를 렌더 스타일의 memo dependency로 사용하는 현재 구조에서 확인된 필수 코드 수정은 없다. [0.13 foldable 변경](https://github.com/getpaseo/paseo/blob/v0.13.0/CHANGELOG.md#L13-L14) · [현재 layout 사용](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/client/screen.tsx#L440-L442)

## 로컬 검증

현재 이 환경에 설치된 daemon/CLI는 `paseo --version` 기준 `0.12.0`이므로 실제 0.13 daemon smoke test는 아직 실행하지 않았다. 대신 저장소를 `/tmp`에 복사하고 `@getpaseo/client`, `@getpaseo/plugin`, `@getpaseo/protocol`만 공식 0.13.0 패키지로 교체해 다음을 실행했다.

```text
npm run typecheck  # 통과
npm test           # 479 passed, 0 failed
```

이는 기존 소스가 0.13 타입과 호환되고 기존 단위 테스트가 깨지지 않음을 보여 주지만, 런타임 호환성을 증명하지는 않는다. 현재 테스트의 `turnEnded()` fixture는 populated timeline을 직접 넣기 때문에 0.13 daemon의 `timeline: []` 동작을 재현하지 않는다. 따라서 위의 empty-timeline 회귀 테스트와 실제 0.13 daemon smoke test가 필요하다. [공식 0.13 package version](https://www.npmjs.com/package/@getpaseo/plugin/v/0.13.0) · [현재 populated fixture](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/server/resumer.test.ts#L196-L221) · [공식 daemon 회귀 검증](https://github.com/getpaseo/paseo/pull/7477)

이 한계를 확인하기 위해 `/tmp` 복사본에서 완료형 Claude 한도 테스트만 0.13의 실제 계약대로 `event.timeline = []`로 바꾸고, 같은 안내를 API `timeline.refetch()` tail에 두었다. 현 구현은 refetch를 호출하지 않아 `dueAt`이 생성되지 않았고 테스트가 실패했다(`expected dueAt, got undefined`). 이는 타입·기존 테스트 통과와 별개로 라이브 0.13 회귀가 실제로 존재함을 재현한다. [문제가 있는 현재 호출부](https://github.com/babo-jeonguk/paseo-usage-auto-resume/blob/99eaebd1471c211478b70f9ecc7a38a9bc35f454/server/resumer.ts#L142-L147) · [0.13이 요구하는 bounded 조회](https://github.com/getpaseo/paseo/blob/v0.13.0/public-docs/plugins/reference.md#L718-L735)

## 권장 작업 순서

1. `onTurnEnded()`에서 빈 `event.timeline`을 bounded `timeline.refetch()`로 보완한다.
2. empty timeline 성공·오류·비한도 회귀 테스트를 추가한다.
3. 실제 Paseo 0.13 daemon에서 완료형 한도 안내가 예약을 생성하는지 smoke test한다.
4. 0.11 최소 지원을 유지할지 결정한다. 유지한다면 deprecated UI import를 그대로 두고 dual-version 검증을 문서화한다.
5. 연결된 각 원격 호스트에 별도 설치가 필요하다는 운영 문구를 추가한다.
6. 번역, `/client/ui` 전환, file/agent panel 기능은 별도 선택적 개선으로 다룬다.
