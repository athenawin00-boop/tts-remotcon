# TTS 리모컨 (tts-remotcon)

SillyTavern 내장 TTS를 채팅 화면에서 바로 조작하는 작은 리모컨입니다.
확장 탭을 열지 않아도 아래 기능을 한곳에서 쓸 수 있어요.

- TTS 켜기/끄기, 재생/정지, 대화 전체 읽기
- 캐릭터 목소리 바꾸기
- 읽기 옵션: 자동 낭독, 따옴표 대사만, 내 메시지도 읽기, *지문* 건너뛰기
- 재생 속도

## 이런 분께 맞아요

- ST 내장 TTS를 이미 쓰고 있고, 확장 탭을 자주 여닫기가 번거로운 분
- 공급자는 상관없어요. ElevenLabs, OpenAI, Edge, 시스템 음성 등 ST가 지원하는 공급자면 됩니다.

TTS를 아직 연결하지 않았다면 먼저 확장 탭에서 TTS 공급자를 설정해 주세요.
리모컨은 새 음성 엔진을 추가하지 않고, 이미 설정된 TTS를 조작만 합니다.

## 설치

1. ST 상단의 확장 메뉴(블록 아이콘)에서 **Install extension**을 누릅니다.
2. 아래 주소를 붙여 넣고 설치합니다.
   ```
   https://github.com/athenawin00-boop/tts-remotcon
   ```
3. 페이지를 새로고침합니다.
4. 입력창 옆 요술봉 메뉴에 **TTS 리모컨**이 보이면 설치가 끝난 거예요.

## 사용법

- 요술봉 메뉴에서 **TTS 리모컨**을 누르면 카드가 열립니다. `✕`로 닫아요.
- 카드 머리줄의 `📌`를 누르면 **항상 띄우기**로 바뀝니다. 화면 구석에 작은 바 `[🔊 ■ ▾]`가 떠 있고, `▾`로 카드를 펼치고 `▴`로 다시 접어요. `✕`는 어느 방식에서든 리모컨을 완전히 끄고 요술봉에서만 열리는 방식으로 돌려요. 다시 `📌`를 누르면 요술봉에서만 열리는 방식으로 돌아갑니다.
- 카드 머리줄이나 바를 끌어서 위치를 옮길 수 있어요. 위치는 기기마다 따로 기억합니다.
- 공급자 이름 옆 `⚙` 버튼은 확장 탭의 TTS 설정을 바로 열어 줍니다.

## 설계 원칙 (개발자용)

리모컨은 `extension_settings.tts` 를 **직접 쓰지 않습니다.** 대신 TTS 확장 탭에 있는
원래 컨트롤을 대신 조작합니다.

| 종류 | 대리 조작 방식 |
|---|---|
| 체크박스 | 원하는 상태와 다를 때만 native `el.click()` |
| select | `.val(v).trigger('change')` |
| range | `.val(v).trigger('input')` |
| 버튼 | `.trigger('click')` |

덕분에 저장(`saveSettingsDebounced`)·검증·voicemap 반영은 전부 ST TTS 쪽 핸들러가
그대로 담당하고, 원래 탭에서 바꾼 값도 리모컨에 그대로 반영됩니다.

> 체크박스에 jQuery `.trigger('click')` 을 쓰지 않는 이유: jQuery 버전에 따라 핸들러
> 실행 뒤 native click 을 한 번 더 태워 체크 상태가 뒤집힙니다. 조건부 native click 은
> 사용자의 실제 클릭과 동일 경로입니다.

## 표시 방식

- **요술봉에서만** (기본): 요술봉 메뉴의 `TTS 리모컨` → 메뉴가 닫히고 카드가 뜹니다. `✕` 로만 닫힙니다.
- **항상 띄우기**: 접힌 바 `[🔊 ■ ▾]` 가 상시 떠 있고 `▾` 로 카드를 펼치고 `▴` 로 접습니다. `✕` 는 모드와 무관하게 완전히 끄고 요술봉 모드로 되돌립니다. 이 모드에선 요술봉 항목이 펼치기/접기입니다.

전환은 카드 머리줄의 `📌` 입니다. 표시 방식은 서버 설정(`extension_settings.tts_remote`)에
저장되어 기기 공통이고, 카드·바의 **위치는 `localStorage` 라 기기별**입니다.

## 원본 연결 지점

| 리모컨 | 원래 컨트롤 |
|---|---|
| 켜기/끄기 스위치 | `#tts_enabled` |
| 공급자 이름 | `#tts_provider` (읽기 전용) |
| ■/▶ | `#ttsExtensionMenuItem` (상태는 `#tts_media_control` 클래스 관찰) |
| 📻 | `#ttsExtensionNarrateAll` |
| 누구 / 어떤 목소리 | `#tts_voicemap_block` 의 `#tts_voicemap_char_*_voice` |
| 자동 낭독 | `#tts_auto_generation` |
| 따옴표 대사만 | `#tts_narrate_quoted` |
| 내 메시지도 읽기 | `#tts_narrate_user` |
| \*지문\* 건너뛰기 | `#tts_narrate_dialogues` |
| 속도 | `#playback_rate` (공급자가 `System` 이면 숨김) |

## 검증

```bash
node --check index.js          # 폴더에 package.json 이 없어 .js 그대로 통과
node test/logic-harness.mjs    # 순수 로직 39 케이스
```
