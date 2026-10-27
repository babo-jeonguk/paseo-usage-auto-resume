# Usage Auto Resume

**한도 리셋을 기다리는 일은 맡겨두세요.**

사용 한도로 멈춘 Codex·Claude·Antigravity 에이전트가 같은 대화에서 미완료 작업을 이어가도록 요청하는 [Paseo](https://paseo.sh) 플러그인입니다. 리셋 시각에 돌아와 “계속해”를 보낼 수고를 덜어줍니다.

[English](README.md)

![날짜별 자동 재개 예약과 시각, 스위치, 대화 열기 버튼](assets/auto-resume.png)

샘플 예약을 사용한 실제 Paseo 웹 화면입니다. 재개 예정인 작업과 확인 대기 중인 작업을 함께 볼 수 있습니다.

- **같은 대화에서 이어서.** 지원하는 에이전트가 사용 한도로 멈추면 재개가 자동으로 예약됩니다.
- **다음 일정을 한눈에.** 여러 provider와 작업공간의 재개 일정을 모아 봅니다. 데몬이나 플러그인을 재시작해도 예약은 유지됩니다.
- **필요할 때만 조절.** 재개를 건너뛰거나, 시각을 옮기거나, 지시를 덧붙이거나, 바로 재개할 수 있습니다.

## 필요한 것

- **Paseo 데몬과 앱 0.11.0 이상**, **Settings → Plugins**에서 플러그인 활성화
- 데몬 호스트에 로그인된 provider CLI, 그리고 절전 상태에 들어가지 않는 데몬 호스트

| Provider | 보내기 전에 |
| --- | --- |
| Codex | ChatGPT 구독 사용량이 남았는지 확인합니다. |
| Claude | claude.ai 구독 사용량이 남았는지 확인합니다. |
| Antigravity | 한도 안내를 따릅니다. 사용량은 확인할 수 없습니다. |

API 키나 다른 과금 경로로 쓰는 에이전트는 재개하지 않습니다.

## 설치

```bash
paseo plugin install github:babo-jeonguk/paseo-usage-auto-resume
```

## 사용

1. 사이드바에서 **Auto Resume**를 여세요. 에이전트가 사용 한도에 걸리기 전까지는 목록이 비어 있습니다.
2. 평소처럼 에이전트를 사용하세요. 한도로 멈추면 목록에 재개 예약이 나타납니다.
3. 예약 시각이 되면 같은 대화에서 에이전트에게 이어서 진행하도록 요청합니다.

에이전트에게 직접 메시지를 보내거나 에이전트를 보관하면 재개 예약이 취소됩니다. 예약 시각에 에이전트가 닫혀 있거나 권한 승인을 기다리고 있어도 취소됩니다.

목록의 각 예약에는 다음이 있습니다.

- **스위치:** 끄면 이번 재개를 건너뜁니다. 예정 시각 전에 다시 켤 수 있습니다.
- **+10m / 시각:** 10분 미루거나, 시각을 눌러 다른 시간을 입력합니다.
- **추가 지시(Extra instructions):** 이번 재개에 덧붙여 에이전트에게 전할 내용을 적습니다. 한 번만 전송됩니다.
- **열기:** 해당 대화로 이동합니다.

헤더의 스위치는 보이는 예약을 한꺼번에 끄거나 켭니다. 목록 아래 **Recent activity**에서 최근 24시간 동안 예약이 어떻게 끝났는지 볼 수 있습니다.

예약이 있는 대화에는 메시지 입력창 옆에 **Auto Resume** 버튼도 나타납니다. 대화를 떠나지 않고 그 예약을 관리할 수 있고, 한도가 일찍 풀렸다면 **Resume now**로 바로 재개할 수 있습니다.

예약이 확인 대기 중이라고 나오면, 아직 계정이나 사용량을 확인하지 못했다는 뜻입니다. 표시된 시각에 다시 확인합니다.

## 설정

**Settings → Plugins → usage-auto-resume → Settings**를 여세요.

![계정 표시와 provider별 스위치가 있는 설정 화면](assets/provider-settings.png)

- **Providers:** provider별로 자동 재개를 켜거나 끕니다. `claude-main`, `codex-sub` 같은 프로필도 포함됩니다. 끄면 그 provider의 대기 중인 예약이 취소됩니다.
- **Continue prompt:** 에이전트에게 보내는 메시지를 확인하고 바꿀 수 있습니다. **Reset to default**를 누르면 하위 에이전트까지 이어서 진행하도록 요청하는 기본 메시지로 돌아갑니다.

## 업데이트

```bash
paseo plugin update usage-auto-resume
```

## 제거

```bash
paseo plugin remove usage-auto-resume
```

플러그인 설정도 함께 지워집니다. 예약과 최근 기록은 Paseo 홈(기본값 `~/.paseo`)의 `plugin-data/usage-auto-resume`에 남으니, 함께 지우려면 이 폴더를 삭제하세요.

## 내 데이터

- 데몬 호스트에서 에이전트 상태, 최근 한도 안내, provider CLI 로그인 정보를 읽습니다.
- Codex·Claude 사용량 확인은 provider의 계정 서비스에 요청하며, 모델을 실행하지 않습니다. 로그인 토큰은 저장하거나 로그에 남기지 않습니다.
- 예약, 추가 지시, 바꾼 Continue prompt는 데몬 호스트에 저장합니다. 추가 지시는 전송한 뒤 지웁니다.
- 재개 메시지는 직접 보내는 메시지처럼 Paseo를 거쳐 기존 에이전트에게 전달됩니다.

## 더 보기

정확한 동작 규칙과 문제 해결은 [동작·데이터 접근 안내](docs/behavior.md)에, 기여 방법은 [개발·레지스트리 제출 안내](docs/development.md)에 있습니다. 상세 안내는 영어로 제공합니다. Provider 확대와 인계 아이디어는 [#3](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/3), [#4](https://github.com/babo-jeonguk/paseo-usage-auto-resume/issues/4)에서 논의합니다.

## 출처와 라이선스

[MIT](LICENSE). [서드파티 고지](THIRD_PARTY_NOTICES.md)를 참고하세요. [chat-resume](https://github.com/panrafal/paseo-plugins/tree/main/chat-resume), [paseo-continuity](https://github.com/keefeere/paseo-continuity), [paseo-limits](https://github.com/ortschun/paseo-limits), [paseo-defer](https://github.com/tomgrin10/paseo-defer)를 참고했습니다.
