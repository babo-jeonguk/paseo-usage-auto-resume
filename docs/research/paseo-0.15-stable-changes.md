# Paseo 0.15 정식 버전: beta 이후 변경 조사

조사일: 2026-11-03. 비교 대상은 공식 태그 `v0.15.0-beta.1`과 `v0.15.0`이다. 정식 버전은 11월 3일 공개됐으며 릴리스 페이지의 커밋 약칭은 `8938fde`다. 비교한 플러그인 코드는 `c63480506a264d171cf625ac7e647f4315512b37`과 동일하고, 현재 준비 브랜치에는 문서만 추가돼 있다. [정식 릴리스](https://github.com/getpaseo/paseo/releases/tag/v0.15.0)

## 결론

정식 버전의 소스에서 기존 플러그인 코드를 바꿔야 할 인터페이스 변경은 발견하지 못했다. beta와 정식 태그의 플러그인 개발 도구, 클라이언트, 통신 형식 소스는 동일하다. 서버의 제공자 실행·플러그인 실행·사용량 조회 코드도 그대로다. 따라서 소스 비교만으로 기존의 "코드와 manifest 변경 불필요" 판단을 뒤집을 근거는 없다. 실제 실행 결과는 [정식 버전 호환성 검증 문서](../paseo-0.15-compatibility.md)를 별도로 따른다. 아래 내용은 실행 테스트 통과를 주장하는 것이 아니다.

정식 버전에서 반드시 구분해야 하는 변화는 **Paseo 자체의 재시작 후 자동 복구가 기본 꺼짐으로 바뀌었다는 점**이다. 플러그인이 사용량 제한 해제 뒤 보내는 재개 메시지와 Paseo가 중단된 작업에 보내는 복구 메시지는 별개의 기능이다. [정식 버전의 실행 수명 문서](https://github.com/getpaseo/paseo/blob/v0.15.0/docs/agent-lifecycle.md#daemon-restart-recovery)

## 재시작 후 자동 복구는 명시적으로 켰을 때만 동작

beta는 설정이 없으면 복구를 켠 것으로 해석했다. 정식 버전은 설정이 없거나 `false`이면 중단된 에이전트를 자동으로 재개하지 않고, `agents.resumeOnStartup: true`로 저장한 경우에만 재개한다. 기존에 명시적으로 저장한 `true`와 사용자 지정 복구 메시지는 유지된다. 기본 메시지는 여전히 `Resume working.`이다. [변경 PR #8619](https://github.com/getpaseo/paseo/pull/8619), [기본값 해석](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/config.ts#L840), [실행 시 설정 판정](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/bootstrap.ts#L1047)

설정 화면도 값이 없으면 꺼짐으로 표시하도록 바뀌었다. 플러그인에서 이 설정을 켜거나 끌 필요는 없다. 사용자가 복구를 켠 경우와 기본 설정인 경우를 구분해 예약 처리와 메시지 수를 확인하면 된다. 특히 정식 버전의 기본 설정에서 Paseo의 복구 메시지가 오지 않는 것은 이 변경의 정상 결과다. [설정 화면](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/app/src/screens/settings/restart-recovery-card.tsx#L62)

다운로드한 두 태그의 서버 소스를 비교했을 때 차이가 있는 파일은 다음 네 개뿐이다.

| 파일 | 변경 내용 |
|---|---|
| `packages/server/src/server/config.ts` | 자동 복구 설정이 없을 때 기본값을 `true`에서 `false`로 변경 |
| `packages/server/src/server/bootstrap.ts` | 저장소와 실행 경로 모두 명시적인 `true`만 복구 켜짐으로 해석 |
| `packages/server/src/server/config.test.ts` | 기본 꺼짐 기대값 검증 |
| `packages/server/src/server/daemon-e2e/daemon-restart-resume.e2e.test.ts` | 복구를 검증하는 사례는 직접 켜고, 설정 생략 사례를 추가 |

출처: [beta 서버 소스](https://github.com/getpaseo/paseo/tree/v0.15.0-beta.1/packages/server/src), [정식 서버 소스](https://github.com/getpaseo/paseo/tree/v0.15.0/packages/server/src).

## 플러그인이 사용하는 인터페이스와 실행 방식

다음 세 디렉터리는 두 태그 사이에 파일 차이가 없다.

- `packages/plugin/src`: 서버 이벤트 등록, 설정·요청 처리, 클라이언트 화면·버튼 등록을 포함한 플러그인 개발 도구.
- `packages/client/src`: 에이전트 조회·목록·대화 기록·전송 등 플러그인에 제공하는 클라이언트 기능.
- `packages/protocol/src`: 설정, 에이전트, 메시지 형식과 플러그인 요구 버전 검사.

출처: [beta 플러그인 개발 도구](https://github.com/getpaseo/paseo/tree/v0.15.0-beta.1/packages/plugin/src), [정식 플러그인 개발 도구](https://github.com/getpaseo/paseo/tree/v0.15.0/packages/plugin/src), [정식 클라이언트](https://github.com/getpaseo/paseo/tree/v0.15.0/packages/client/src), [정식 통신 형식](https://github.com/getpaseo/paseo/tree/v0.15.0/packages/protocol/src).

따라서 beta와 마찬가지로 기존 `server.on`과 `server.before` 등록은 새 이벤트 이름으로 연결돼 계속 동작한다. 두 방식의 제거 예정 표시는 2027-04-30 이후로 동일하다. 사용량 제한을 감지할 때 별도로 대화 기록을 읽는 현재 방식도 그대로 사용할 수 있다. [정식 이벤트 등록과 이전 이름 연결](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/plugin/src/server/lifecycle.ts#L153)

플러그인의 현재 요구 버전 `>=0.11.0`은 정식 `0.15.0`을 허용한다. 정식 버전의 요구사항 검사도 그대로이므로 `paseo-plugin.json`에 `0.15`를 따로 추가할 필요가 없다. 개발용 패키지의 배포 버전 표기는 정식 `0.15.0`으로 바뀌었지만 이 자체가 플러그인의 개발 의존성을 올려야 한다는 뜻은 아니다. [정식 요구 버전 검사](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/protocol/src/plugin-requirements.ts#L22), [정식 플러그인 패키지](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/plugin/package.json)

## 외부 문제와 사용량 조회 정책

beta에서 관찰한 Claude 정상 종료 후 복구 누락과 Antigravity의 이전 제한 오류 재전달에 해당하는 제공자 코드, 재시작 복구 구현과 저장 코드에는 정식 태그까지 변경이 없다. 내장 제공자 플러그인 디렉터리도 패키지 버전 표기를 제외하면 동일하다. 소스 비교를 근거로 정식에서 두 문제가 수정됐다고 보고할 수는 없다. 반대로 실제 재현 여부는 제공자 실행 파일과 실행 조건에 따라 달라질 수 있어 실행 검증으로 구분해야 한다. [재시작 복구 구현](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/restart-recovery/index.ts), [에이전트 저장](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/agent-storage.ts), [제공자 소스](https://github.com/getpaseo/paseo/tree/v0.15.0/packages/server/src/server/agent/providers), [내장 제공자 플러그인](https://github.com/getpaseo/paseo/tree/v0.15.0/plugins)

Paseo의 사용량 조회 설정을 꺼도 플러그인의 자체 조회와 재개를 유지한다는 기존 결정도 유효하다. 정식 태그에는 사용량 설정이나 그 설정을 플러그인에 강제하는 새 변경이 없다. 플러그인이 직접 수행하는 계정·사용량 확인을 Paseo의 표시용 조회 설정에 맞춰 바꿀 이유는 이번 변경분에서 발견하지 못했다. [기존 결정과 검증 기록](../paseo-0.15-verification.md#사용량-조회를-끈-상태), [정식 설정 형식](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/protocol/src/messages.ts#L233)

## 화면 변경의 확인 범위

정식 버전은 휴대폰에서 재연결·상태 안내가 상단 헤더 뒤에 가려지던 문제를 고쳤다. 앱 소스의 나머지 변경은 이 안내 표시 위치와 재시작 복구 설정의 기본 표시값에 한정된다. 플러그인 전용 화면이나 버튼 등록 형식이 바뀐 것은 아니다. 단, 공용 안내 메시지 표시도 수정됐으므로 플러그인의 수동 재개 결과 안내를 실제 화면에서 다시 확인하는 것이 적절하다. 모바일 네이티브 화면은 브라우저 검사만으로 검증했다고 볼 수 없다. [정식 릴리스의 #8568](https://github.com/getpaseo/paseo/releases/tag/v0.15.0), [공용 안내 표시](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/app/src/components/toast-host.tsx), [휴대폰 입력 영역](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/app/src/composer/dock/index.native.tsx)

## 조사 방법과 검증 한계

두 공식 태그의 압축 소스를 내려받아 디렉터리 비교를 수행했다. beta 경로는 `/tmp/uar-paseo015-review`, 정식 경로는 `/tmp/uar-paseo015-stable-research`다.

```bash
diff -qr /tmp/uar-paseo015-review/packages/plugin/src /tmp/uar-paseo015-stable-research/packages/plugin/src
diff -qr /tmp/uar-paseo015-review/packages/client/src /tmp/uar-paseo015-stable-research/packages/client/src
diff -qr /tmp/uar-paseo015-review/packages/protocol/src /tmp/uar-paseo015-stable-research/packages/protocol/src
diff -qr /tmp/uar-paseo015-review/packages/server/src /tmp/uar-paseo015-stable-research/packages/server/src
diff -qr /tmp/uar-paseo015-review/plugins /tmp/uar-paseo015-stable-research/plugins
diff -qr /tmp/uar-paseo015-review/packages/app/src /tmp/uar-paseo015-stable-research/packages/app/src
```

앞의 세 명령은 차이가 없어서 종료 코드 0이었다. 서버·내장 플러그인·앱 비교는 위에서 설명한 차이가 있어 종료 코드 1이었다. 이는 파일 비교의 정상적인 "차이 있음" 결과이며 테스트 실패가 아니다. 변경된 파일은 개별 내용도 대조했다. 이 조사 파일 작성 과정에서 제공자 실행이나 타입 검사·테스트는 수행하지 않았다. 실제 정식 배포본을 대상으로 한 실행 검증 결과와 소스 조사 결과를 구분한다.
