# AI CLI로 행사에 맞게 개조하기

Event Console은 완성된 범용 행사 제품보다, 실제 운영에 사용한 구현을 자기 행사에 맞게 고쳐 쓰는 출발점에 가깝습니다. GitHub 저장소 링크와 아래 프롬프트를 사용하는 AI CLI에 전달하면 행사 규칙, 운영체제, 화면과 장비 조건을 먼저 정리한 뒤 변경 범위를 찾도록 안내할 수 있습니다.

## 복사해서 사용할 프롬프트

아래 내용을 복사한 뒤 `<저장소 URL>`과 알고 있는 행사 정보를 채우세요. 모르는 항목은 비워 두고 AI CLI가 질문하게 두어도 됩니다.

```text
<저장소 URL>의 Event Console을 내 행사와 장비에 맞게 개조해 줘.

이 저장소는 실제 행사에서 사용한 로컬 운영 콘솔을 공개용으로 정리한 코드다. 바로 수정하지 말고 README.md, docs/ARCHITECTURE.md, docs/AI_CUSTOMIZATION.md, package.json을 먼저 읽은 다음 관련 소스와 테스트를 조사해라.

원본 보호:
- 원본 checkout을 직접 덮어쓰지 말고 fork, 별도 branch, worktree 또는 복사본 중 현재 환경에 맞는 방법을 선택해라.
- 변경 전 기준 commit을 기록하고, 기존 설정과 브라우저 데이터의 백업 방법을 먼저 제시해라.
- 기존 동작을 삭제하거나 행사 규칙을 바꾸기 전에 해당 동작을 고정하는 테스트를 확인해라.

먼저 다음 요구사항을 질문하고, 답을 짧은 요구사항 표로 정리해라.
- 행사명, 행사 날짜, 팀 수, 팀 이름과 색, 진행 부와 종목의 순서
- 종목별 점수 계산, 공동 순위, 동점 처리, 보너스, 확정 취소 방식
- 관객에게 늦게 공개해야 하는 단계와 잠금 해제 조건
- 필요한 조작 화면, 송출 장면, 타이머, 명단, 사진, 영상, 음악, 카메라, 리플레이
- 운영자 수, 단축키와 입력 장치, 접근성 요구, 오프라인 운영 여부

현장 환경과 장비도 확인해라.
- 운영체제와 버전, Node.js와 npm 버전, Chrome 또는 Edge 버전
- 조작 모니터와 송출 모니터의 해상도, 배율, 연결 방식
- 프로젝터, LED 프로세서, 캡처 장치, 카메라, 오디오 인터페이스와 실제 신호 경로
- 브라우저에서 프로젝터로 직접 송출하는지, OBS로 방송 또는 녹화하는지
- OBS를 쓴다면 설치 여부와 버전, Virtual Camera 사용 여부, 캔버스와 출력 해상도, fps, 오디오 모니터링 경로를 확인해라.
- 브라우저에서 프로젝터로 직접 송출할 뿐이라면 OBS를 필수 조건으로 만들지 말고 '사용하지 않음'으로 기록해라.

경로를 임의로 정하지 말고 사용자에게 다음 위치를 선택하게 해라.
- 작업할 프로젝트 경로
- 행사 미디어 원본을 보관할 경로
- 상태 내보내기와 백업을 보관할 경로
- 필요한 경우 로그와 임시 파일 경로
개인 절대 경로를 코드에 넣지 말고 저장소 상대 경로 또는 문서화한 환경 변수를 사용해라.

수정 전에 변경 계획과 영향을 받는 테스트를 제시해라. docs/AI_CUSTOMIZATION.md의 '수정 순서'와 '보존 계약과 테스트 지도'를 기준으로 도메인 모델부터 화면과 미디어까지 순서대로 바꿔라. 서로 관련된 규칙을 한 파일만 임시로 고치지 마라.

각 단계에서 관련 테스트를 먼저 읽고, 필요한 회귀 테스트를 추가한 뒤 구현해라. 마지막에는 npm ci, npm run typecheck, npm test, npm run build를 실행해라. 그 다음 같은 브라우저 프로필의 조작 화면과 송출 화면으로 실제 브라우저 검사를 하고, 사용할 카메라·오디오·프로젝터·캡처 장비로 현장 리허설 체크리스트를 수행해라.

자동 검사가 통과해도 장치 권한, 코덱, 자동재생, GPU 합성, 화면 배율, 케이블과 오디오 라우팅은 보장된 것으로 기록하지 마라. 실제 장비 검사를 하지 못했다면 완료라고 단정하지 말고 '현장 검증 대기' 항목과 실행 방법을 남겨라. 변경 파일, 바뀐 행사 규칙, 통과한 검사, 남은 현장 검증을 최종 보고해라.
```

## 권장 수정 순서

1. **기준 보존** — fork, branch, worktree 또는 복사본을 만들고 기준 commit과 기존 백업 위치를 기록합니다.
2. **요구사항과 장비 표 작성** — 행사 규칙과 실제 신호 경로를 확정합니다. 장비 모델을 모르면 연결 단자와 목표 해상도·fps라도 기록합니다.
3. **도메인 모델과 초기 상태 변경** — 팀, 부, 종목, 단계, 장면, 설정의 타입과 저장본 정규화 규칙을 함께 수정합니다.
4. **점수와 순위 규칙 변경** — 배점, 공동 순위, 제출 순서, 보너스와 취소를 원장 기반으로 계산하도록 고칩니다.
5. **큐와 공개 잠금 변경** — 행사 순서, 큐 실행 action, 전환 중 도착 장면 판정, 잠긴 장면의 마지막 렌더 관문을 함께 검토합니다.
6. **조작 화면 변경** — 입력, 확정, 취소, 잠금 해제, 단축키와 운영 피드백을 새 규칙에 맞춥니다.
7. **송출 장면 변경** — 관객에게 보이는 이름, 순위, 타이머, 명단, 전환과 해상도 대응을 수정합니다.
8. **미디어와 오디오 변경** — 재배포 권리를 확인한 자료만 등록하고, 누락 시 폴백과 재생 소유권을 확인합니다.
9. **실행 환경 변경** — 필요한 경우에만 포트와 환경 변수를 문서화합니다. 개인 경로나 특정 장치 번호를 기본값으로 굳히지 않습니다.
10. **자동 검사와 리허설** — 관련 회귀 테스트, 전체 타입 검사·테스트·빌드, 브라우저 점검, 실제 장비 리허설, 백업 복원 순으로 확인합니다.

## 보존 계약과 테스트 지도

아래 표는 기능을 바꿀 때 함께 확인할 경계입니다. 새 행사 구조가 기존 테스트의 고정값을 의도적으로 바꾸는 경우에는 테스트를 지우기보다 새 요구사항을 표현하도록 갱신합니다.

| 변경 대상 | 보존할 계약 | 주요 소스 | 관련 테스트 |
| --- | --- | --- | --- |
| 팀·종목·단계·상태 스키마 | 상태는 JSON으로 직렬화할 수 있어야 하며, 저장본 정규화가 누락 필드와 구버전 값을 안전한 기본값으로 접어야 합니다. Blob은 상태에 직접 넣지 않습니다. | [types.ts](../src/types.ts), [state.ts](../src/state.ts) | [state.test.ts](../src/state.test.ts), [persist.test.ts](../src/persist.test.ts), [storage-namespace.test.ts](../src/storage-namespace.test.ts) |
| 점수·순위·보너스 | 표시 점수는 append-only 원장에서 파생하며, 취소는 기존 항목 삭제나 점수 직접 수정 대신 역분개 항목으로 남깁니다. 공동 순위와 미입력 값을 명시적으로 처리합니다. | [state.ts](../src/state.ts), [scoring.ts](../src/scoring.ts), [p1-results.ts](../src/p1-results.ts), [p2-remaining.ts](../src/p2-remaining.ts) | [scoring.test.ts](../src/scoring.test.ts), [ledger-bonus.test.ts](../src/ledger-bonus.test.ts), [p1-results.test.ts](../src/p1-results.test.ts), [p1-ranking.test.ts](../src/p1-ranking.test.ts) |
| 큐·행사 순서 | 큐 하나가 장면, 단계, 옵션, 영상·음악 명령을 일관된 action 묶음으로 만들어야 합니다. 전환 중에는 현재 장면보다 도착 예정 장면을 기준으로 다음 명령을 판정합니다. | [cue.ts](../src/cue.ts), [pending-scene.ts](../src/pending-scene.ts), [cue-transitions.ts](../src/cue-transitions.ts) | [cue.test.ts](../src/cue.test.ts), [pending-scene.test.ts](../src/pending-scene.test.ts), [cue-transitions.test.ts](../src/cue-transitions.test.ts), [scene-routing.test.ts](../src/scene-routing.test.ts) |
| 비공개 단계 잠금 | 버튼을 숨기는 데 그치지 않고 장면 선택과 렌더 경계에서 잠긴 내용을 대기 화면으로 강등해야 합니다. 복원 상태와 단축키 진입도 같은 규칙을 거칩니다. | [types.ts](../src/types.ts), [scenes/index.ts](../src/scenes/index.ts), [hotkeys.ts](../src/hotkeys.ts) | [lock.test.ts](../src/lock.test.ts), [scene-routing.test.ts](../src/scene-routing.test.ts), [hotkeys.test.ts](../src/hotkeys.test.ts) |
| 조작·송출 동기화 | 두 화면은 같은 origin과 브라우저 프로필을 사용합니다. 늦게 열린 송출 화면이 최신 상태를 요청할 수 있어야 하고, 조작 화면은 하나의 리더만 상태를 발행해야 합니다. | [sync.ts](../src/sync.ts), [control-leader.ts](../src/control-leader.ts), [control.ts](../src/control.ts), [display.ts](../src/display.ts) | [sync.test.ts](../src/sync.test.ts), [control-leader.test.ts](../src/control-leader.test.ts), [display-shell.test.ts](../src/display-shell.test.ts) |
| 저장·백업·복구 | 현재 상태와 IndexedDB의 대용량 자료를 구분합니다. JSON 내보내기에 영상·사진 Blob이 포함된다고 가정하지 않으며, 스냅샷과 복원은 저장 실패를 조용히 숨기지 않습니다. | [db.ts](../src/db.ts), [state.ts](../src/state.ts), [control/tab-settings.ts](../src/control/tab-settings.ts) | [db.test.ts](../src/db.test.ts), [persist.test.ts](../src/persist.test.ts), [storage-namespace.test.ts](../src/storage-namespace.test.ts) |
| 미디어 등록·매니페스트·폴백 | 사용자가 등록한 자료, 매니페스트, 기본 자료의 우선순위를 유지하고 실제 선택된 출처를 추적합니다. 누락 파일은 예측 가능한 안내 화면이나 사용 불가 상태로 처리합니다. | [media-manifest.ts](../src/media-manifest.ts), [photo-seed.ts](../src/photo-seed.ts), [logos.ts](../src/logos.ts), [control/tab-assets.ts](../src/control/tab-assets.ts) | [media-manifest.test.ts](../src/media-manifest.test.ts), [public-assets.test.ts](../src/public-assets.test.ts), [photo-seed.test.ts](../src/photo-seed.test.ts), [logos.test.ts](../src/logos.test.ts), [control/tab-assets.test.ts](../src/control/tab-assets.test.ts) |
| 카메라·리플레이 | 반복 호출이 카메라 세션을 중복 생성하지 않아야 합니다. 리플레이는 브라우저의 MediaRecorder와 코덱 지원을 확인하고, 늦게 끝난 이전 요청이 새 재생을 종료하지 않도록 명령 세대를 구분합니다. | [camera-session.ts](../src/camera-session.ts), [replay-ring.ts](../src/replay-ring.ts), [replay-playback.ts](../src/replay-playback.ts), [display.ts](../src/display.ts) | [camera-session.test.ts](../src/camera-session.test.ts), [replay-ring.test.ts](../src/replay-ring.test.ts), [replay-playback.test.ts](../src/replay-playback.test.ts), [replay-control.test.ts](../src/replay-control.test.ts) |
| 음악·출력 오디오 | 곡 선택, 재생 상태, ducking, master gain과 영상 오디오를 서로 다른 축으로 다룹니다. 사용자 입력 전 자동재생 제한과 송출 화면의 오디오 잠금을 운영자에게 드러냅니다. | [music-playback.ts](../src/music-playback.ts), [music-duck.ts](../src/music-duck.ts), [output-audio.ts](../src/output-audio.ts), [audio-lock.ts](../src/audio-lock.ts), [asset-music.ts](../src/asset-music.ts) | [music-playback.test.ts](../src/music-playback.test.ts), [music-duck.test.ts](../src/music-duck.test.ts), [output-audio.test.ts](../src/output-audio.test.ts), [audio-lock.test.ts](../src/audio-lock.test.ts), [asset-music.test.ts](../src/asset-music.test.ts) |
| 장면 전환·영상 종료 | 전환의 컷 시점과 종료 책임을 한 소유자가 맡고, 지연된 `ended` 이벤트가 이후 장면 선택을 되돌리지 않아야 합니다. | [transition-video.ts](../src/transition-video.ts), [scene-fade.ts](../src/scene-fade.ts), [pending-scene.ts](../src/pending-scene.ts), [video-hold.ts](../src/video-hold.ts) | [transition-video.test.ts](../src/transition-video.test.ts), [scene-fade.test.ts](../src/scene-fade.test.ts), [pending-scene.test.ts](../src/pending-scene.test.ts), [video-hold.test.ts](../src/video-hold.test.ts) |
| 장면 렌더·시간 갱신 | `view()`의 HTML이 달라지면 장면 DOM이 교체됩니다. 매 프레임 변하는 값은 가능한 한 고정된 슬롯을 `tick()`에서 갱신해 애니메이션과 미디어 노드를 보존합니다. | [vdom.ts](../src/vdom.ts), [scenes/index.ts](../src/scenes/index.ts), [display.ts](../src/display.ts) | [scenes/scene-enter.test.ts](../src/scenes/scene-enter.test.ts), [scenes/timerScene.test.ts](../src/scenes/timerScene.test.ts), [display-presentation.test.ts](../src/display-presentation.test.ts) |
| 조작 UI·단축키 | 입력 중에는 전역 단축키가 개입하지 않아야 하며, 확정·취소·강제 인수처럼 결과가 큰 조작은 상태와 피드백이 함께 보여야 합니다. | [control.ts](../src/control.ts), [hotkeys.ts](../src/hotkeys.ts), [control/modal.ts](../src/control/modal.ts) | [hotkeys.test.ts](../src/hotkeys.test.ts), [control-layout.test.ts](../src/control-layout.test.ts), [control/topbar.test.ts](../src/control/topbar.test.ts) |
| 해상도·전체 화면 | 기준 송출 비율을 유지하면서 창 크기와 배율이 달라도 화면이 잘리지 않아야 합니다. 전체 화면 진입 실패와 창 모드도 처리합니다. | [display-scale.ts](../src/display-scale.ts), [display-fullscreen.ts](../src/display-fullscreen.ts), [display-windowed.ts](../src/display-windowed.ts), [styles/display.css](../src/styles/display.css) | [display-scale.test.ts](../src/display-scale.test.ts), [display-fullscreen.test.ts](../src/display-fullscreen.test.ts), [display-windowed.test.ts](../src/display-windowed.test.ts) |

## 현장 리허설 범위

자동 검사는 계산과 상태 전환의 회귀를 찾지만 실제 신호 경로를 대신하지 못합니다. 사용할 구성에 해당하는 항목만 골라 최소 한 번은 행사 장비 그대로 확인합니다.

| 구성 | 확인할 내용 |
| --- | --- |
| 브라우저 → 프로젝터 또는 LED | 같은 브라우저 프로필에서 조작·송출 동기화, 실제 해상도와 배율, 전체 화면, 케이블 재연결, 절전 방지, 영상과 음악 자동재생, 오디오 출력 장치 |
| 카메라 사용 | 브라우저 권한, 올바른 장치 선택, 해상도와 fps, 장치 분리·재연결, 신호 없음 표시, 장시간 실행 발열과 프레임 유지 |
| 리플레이 사용 | MediaRecorder 지원, 실제 코덱, 지정 구간과 배속, 연속 실행, 카메라 재연결 뒤 복구, 메모리 사용량 |
| OBS 방송·녹화 | OBS 설치와 버전, 브라우저 또는 화면 캡처 방식, Virtual Camera 사용 여부, 캔버스·출력 해상도와 fps, 오디오 모니터링, 녹화 파일, 장면 전환 때 검은 프레임 여부 |
| 복구 훈련 | 상태 JSON 내보내기와 가져오기, 미디어 원본 별도 보관, 브라우저 재시작, 잘못된 조작 취소, 예비 컴퓨터에서의 재구성 시간 |
