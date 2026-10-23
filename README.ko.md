# Usage Auto Resume

**한도 리셋을 기다리는 일은 맡겨두세요.**

사용 한도로 멈춘 Codex·Claude·Antigravity 에이전트가 같은 대화에서 미완료 작업을 이어가도록 요청하는 [Paseo](https://paseo.sh) 플러그인입니다. 리셋 시각에 돌아와 “계속해”를 보낼 수고를 덜어줍니다.

[English](README.md)

![날짜별 자동 재개 예약과 시각, 스위치, 대화 열기 버튼](assets/auto-resume.png)

샘플 예약을 사용한 실제 Paseo 웹 화면입니다. 재개 예정인 작업과 확인 대기 중인 작업을 함께 볼 수 있습니다.

- **같은 대화에서 이어서.** 지원하는 에이전트가 사용 한도로 멈추면 재개 예약이 자동으로 생깁니다.
- **다음 일정을 한눈에.** 여러 provider와 작업공간의 재개 일정을 모아 봅니다. 세션·주간 리셋을 다루며, 데몬이나 플러그인을 재시작해도 예약은 유지됩니다.
- **필요할 때만 조절.** 예약 하나를 끄거나, 화면의 예약을 한꺼번에 끄거나, 재개 시각을 뒤로 미룰 수 있습니다.

## 설치하고 시작하기

**Paseo 데몬과 앱 0.11.0 이상**, 플러그인 활성화, 데몬 호스트에 로그인된 provider CLI가 필요합니다. **Settings → Plugins**에서 플러그인을 활성화하거나 데몬 설정의 `pluginsEnabled`를 `true`로 설정하세요.

| Provider | 현재 동작 |
| --- | --- |
| Codex | 전송 전에 ChatGPT 계정·모델·구독 사용량을 확인합니다. |
| Claude | claude.ai 계정·모델·구독 사용량을 확인합니다. macOS에서는 해당 프로필의 Keychain과 파일 대체 저장소를 지원합니다. |
| Antigravity | 한도 안내에 적힌 리셋 시각을 따릅니다. 계정·사용량 확인은 제공되지 않습니다. |

API 키와 외부 과금 경로는 자동 재개 대상에서 제외합니다.

```bash
paseo plugin install github:babo-jeonguk/paseo-usage-auto-resume
```

1. 사이드바에서 **Auto Resume**를 여세요. 대상 한도 중단을 찾기 전에는 빈 목록이 정상입니다.
2. 평소처럼 에이전트를 사용하세요. 지원하는 에이전트가 한도에 걸리면 재개 예약이나 확인 대기 항목이 자동으로 나타납니다.
3. 데몬 호스트를 켜 두고 절전 상태에 들어가지 않게 하세요. 안내에 리셋 시각이 있으면 최초 사용량 조회 없이 그 시각 + 2분으로 예약합니다. 시각이 없으면 Codex·Claude의 계정·모델 사용량을 조회해 예약을 정합니다. 두 경우 모두 전송 직전에는 계정과 사용량을 확인합니다.

확인 대기 항목의 시각은 **다음 확인 시각**입니다. 재개를 약속하는 시각은 아닙니다. 직접 새 메시지를 보내거나 에이전트가 실행 중·닫힘·보관·권한 대기 상태이면 예약을 취소합니다.

## 재개 예약 조절하기

각 행은 시각, 남은 시간 또는 확인 상태, 대화 제목, provider와 작업공간을 보여줍니다.

- **스위치:** 끄면 이번 재개를 건너뜁니다. 예정 시각 전에 다시 켤 수 있습니다.
- **+10m / 시각:** 10분 미루거나 시각을 눌러 새 시간을 입력하세요. 허용 범위는 편집 화면에서 안내합니다. 시각을 바꾸면 예약이 켜집니다.
- **추가 지시(Extra instructions):** 이번 재개에 덧붙일 지시를 적습니다. 재개 프롬프트 아래에 붙어 한 번만 전송되며, 저장해도 시각과 스위치는 그대로입니다.
- **헤더 스위치:** 화면의 예약을 한꺼번에 끄거나 다시 켭니다. 이미 전송 중인 예약에는 적용되지 않습니다.
- **열기 버튼:** 기존 대화로 이동합니다.

확인 대기 항목의 시각을 바꾸면 다음 확인 시각이 바뀝니다.

목록 아래 **Recent activity**에서 최근 24시간 동안 예약이 어떻게 끝났는지(재개됨, 건너뜀, 취소와 그 이유, 재시도 포기) 확인할 수 있습니다.

예약된 대화에는 시각이나 상태를 표시하는 **Auto Resume composer pill**도 나타납니다. pill을 누르면 대화를 떠나지 않고 해당 예약을 끄거나 다시 켜고, 10분·30분·1시간 미루거나 시각을 변경하고, 추가 지시를 적을 수 있습니다. 한도가 일찍 풀렸다면 **Resume now**로 바로 이어서 진행하게 할 수 있습니다. 보내기 전에 같은 확인을 거치며, Codex·Claude 사용량이 아직 소진 상태이면 보내지 않습니다. 끈 예약은 예정 시각까지 pill이 유지되며, 실행되거나 취소된 예약의 pill은 사라집니다. 사이드바와 대화 안의 컨트롤은 같은 예약을 관리합니다.

## 대상 provider 선택하기

**Settings → Plugins → usage-auto-resume → Settings**를 여세요. 내장 provider와 이를 확장한 `claude-main`, `codex-sub` 같은 프로필이 표시되며, 확인 가능한 경우 로그인 계정도 보여줍니다.

![계정 표시와 provider별 스위치가 있는 설정 화면](assets/provider-settings.png)

처음에는 모든 지원 provider가 켜져 있고, 나중에 추가한 provider도 켜진 상태로 시작합니다. Provider를 끄면 건너뛰기로 둔 항목을 포함해 기존 예약을 취소합니다. 다시 켜도 취소된 예약은 복구하지 않습니다. 설정은 즉시 적용되며 데몬별로 저장됩니다.

Provider 목록 아래 **Continue prompt**에서 에이전트에게 보내는 문구를 확인하고 바꿀 수 있습니다. **Reset to default**를 누르면 하위 에이전트까지 이어서 진행하도록 요청하는 기본 프롬프트로 돌아갑니다.

## 데이터와 동작 조건

에이전트 상태, 최근 한도 안내, provider 설정과 CLI 인증 정보를 읽습니다. Codex·Claude 확인은 모델을 실행하지 않고 provider의 계정·사용량 주소로 요청을 보냅니다. 토큰은 예약 파일이나 로그에 남기지 않습니다. 재개 프롬프트와 추가 지시는 Paseo를 통해 기존 에이전트와 해당 provider로 전달합니다. 예약, 추가 지시, 직접 바꾼 프롬프트는 로컬에 저장하며, 추가 지시는 전송한 뒤 지웁니다.

재시작 뒤에는 lifecycle 이벤트나 앱 요청으로 Paseo API가 연결된 후 확인을 재개합니다. 연결된 앱은 composer pill 조회를 통해 API를 전달합니다. Codex·Claude의 인증이나 사용량을 읽지 못하면 확인 대기로 남습니다. 하위 에이전트의 재개는 부모 에이전트가 가진 도구에 달려 있습니다.

재시도 규칙, 저장 경로와 문제 해결은 [동작·데이터 접근 안내](docs/behavior.md)에, 기여 방법은 [개발·레지스트리 제출 안내](docs/development.md)에 정리했습니다. 상세 안내는 영어로 제공합니다. Provider 확대와 다른 provider로의 인계 아이디어는 [#3](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/3), [#4](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/4)에서 논의합니다.

## 출처와 라이선스

[MIT](LICENSE). [서드파티 고지](THIRD_PARTY_NOTICES.md)를 참고하세요. [chat-resume](https://github.com/panrafal/paseo-plugins/tree/main/chat-resume), [paseo-continuity](https://github.com/keefeere/paseo-continuity), [paseo-limits](https://github.com/ortschun/paseo-limits), [paseo-defer](https://github.com/tomgrin10/paseo-defer)를 참고했습니다.
