# 파일·폴더 안내

배포판은 최종 상태를 하나의 커밋으로 묶었습니다. 커밋 이력 대신 이 문서에서 파일의 역할을 찾고, 설계 이유는 [개발 기록](DEVLOG.md), 동작 관계는 [아키텍처](ARCHITECTURE.md)를 함께 읽으세요. 파일 안의 주석과 인접한 테스트에도 수정 시 보존할 동작이 남아 있습니다.

## 폴더별 역할

| 경로 | 담긴 내용 |
| --- | --- |
| [src/](../src/) | 브라우저에서 실행되는 콘솔 코드와 기능별 테스트 |
| [src/control/](../src/control/) | 운영자가 사용하는 조작 탭과 공통 UI |
| [src/scenes/](../src/scenes/) | 관객에게 보여줄 송출 장면과 화면 효과 |
| [src/styles/](../src/styles/) | 공통 디자인 값, 조작 화면과 송출 화면 스타일 |
| [src/fonts/](../src/fonts/) | 오프라인 사용을 위해 포함한 OFL 폰트 5개 |
| [public/](../public/) | 빌드에 그대로 복사하는 정적 자료 |
| [public/media/](../public/media/) | 기본 SVG 안내 화면·팀 마크와 미디어 목록 |
| [public/photo-seed/](../public/photo-seed/) | 사용자가 준비할 시작 사진 묶음의 목록 |
| [docs/](./) | AI 수정 안내, 구조, 운영 경험, 개발 기록과 사용량 설명 |
| [launcher/](../launcher/) | 설치 폴더를 기준으로 실행하는 셸 런처 |
| [tests/](../tests/) | 별도 프로세스로 런처의 실행·포트 동작을 확인하는 테스트 |
| [licenses/](../licenses/) | 포함한 폰트의 저작권·OFL 원문 |
| [.github/workflows/](../.github/workflows/) | GitHub Actions 자동 검증 설정 |

## 루트의 파일

| 파일 | 역할 |
| --- | --- |
| [README.md](../README.md) | 프로젝트 소개, 예시 영상, AI에게 전달할 프롬프트와 실행 방법 |
| [AGENTS.md](../AGENTS.md) | AI 작업자가 읽어야 할 수정 원칙·개인정보·검증·배포 지침 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 개발 환경과 기여·검증 절차 |
| [SECURITY.md](../SECURITY.md) | 로컬 실행의 보안 범위와 문제 제보 안내 |
| [LICENSE](../LICENSE) | 애플리케이션 코드의 MIT 라이선스 |
| [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | 코드와 구분되는 포함 폰트의 라이선스·저작권 고지 |
| [index.html](../index.html) | 조작·송출 화면으로 들어가는 시작 페이지 |
| [control.html](../control.html) | 운영자 조작 화면의 HTML 진입점 |
| [display.html](../display.html) | 관객용 송출 화면의 HTML 진입점 |
| [package.json](../package.json) | 프로젝트 정보, 실행 명령과 개발 의존성 |
| [package-lock.json](../package-lock.json) | 재현 가능한 설치를 위한 의존성 버전·무결성 기록 |
| [.nvmrc](../.nvmrc) | Node.js 버전 선택 안내 |
| [tsconfig.json](../tsconfig.json) | TypeScript 검사 설정 |
| [vite.config.ts](../vite.config.ts) | 세 HTML 페이지의 빌드, 상대 에셋 경로, 테스트와 라이선스 복사 설정 |
| [.gitignore](../.gitignore) | 개인 자료·행사 미디어·생성 결과를 Git에서 제외하는 규칙 |

## 핵심 코드: 상태와 행사 진행

아래 표는 함께 수정할 가능성이 높은 파일을 같은 행으로 묶었습니다. 파일명이 여러 개 있는 행에서도 각각의 파일은 분리된 모듈입니다.

| 파일 | 역할 |
| --- | --- |
| [control.ts](../src/control.ts), [display.ts](../src/display.ts) | 조작 앱과 송출 앱의 초기화·런타임 연결 |
| [types.ts](../src/types.ts) | 상태, 팀, 장면, 미디어와 action의 공통 형식 |
| [state.ts](../src/state.ts) | 기본 상태, 입력 정규화, 저장·복원과 action 처리 |
| [sync.ts](../src/sync.ts), [control-leader.ts](../src/control-leader.ts) | 창 사이 상태·이벤트 전달과 조작 창 리더 선출 |
| [db.ts](../src/db.ts) | 영상·사진·스냅샷·보조 값의 IndexedDB 저장 |
| [cue.ts](../src/cue.ts), [cue-transitions.ts](../src/cue-transitions.ts) | 진행 큐와 큐 실행에 따른 장면 전환 |
| [scoring.ts](../src/scoring.ts), [p1-ranking.ts](../src/p1-ranking.ts), [p1-results.ts](../src/p1-results.ts) | 배점·순위·1부 결과 계산 |
| [p2-remaining.ts](../src/p2-remaining.ts), [versus-pairs.ts](../src/versus-pairs.ts) | 후반부 진행의 남은 항목과 대진 조합 계산 |
| [timer.ts](../src/timer.ts), [hotkeys.ts](../src/hotkeys.ts) | 타이머 계산과 키보드 조작 |
| [scene-routing.ts](../src/scene-routing.ts), [pending-scene.ts](../src/pending-scene.ts) | 표시할 장면과 전환이 도착할 장면 판정 |
| [pgm.ts](../src/pgm.ts), [blackout.ts](../src/blackout.ts) | 송출 화면 고정과 암전 제어 |
| [vdom.ts](../src/vdom.ts) | 장면을 표현하는 가상 DOM과 화면 반영 유틸리티 |

## 미디어·송출 코드

| 파일 | 역할 |
| --- | --- |
| [media-manifest.ts](../src/media-manifest.ts) | 기본 배포 미디어 목록 해석·등록 |
| [transition-video.ts](../src/transition-video.ts), [transition-rules.ts](../src/transition-rules.ts) | 스팅어 재생과 장면 전환 규칙 |
| [overlay-video.ts](../src/overlay-video.ts), [match-video.ts](../src/match-video.ts), [winner-video.ts](../src/winner-video.ts) | 오버레이와 매치·승리 상황의 영상 처리 |
| [video-hold.ts](../src/video-hold.ts), [scripted-outro.ts](../src/scripted-outro.ts) | 영상 종료 프레임 유지와 대본에 정해진 아웃트로 |
| [camera-session.ts](../src/camera-session.ts), [live-frame.ts](../src/live-frame.ts) | 카메라 세션과 라이브 위에 표시할 프레임 계산 |
| [replay-ring.ts](../src/replay-ring.ts), [replay-playback.ts](../src/replay-playback.ts) | 짧은 구간 리플레이의 버퍼와 재생 처리 |
| [music.ts](../src/music.ts), [asset-music.ts](../src/asset-music.ts) | 음악 카탈로그와 영상에 연결되는 음악 |
| [music-playback.ts](../src/music-playback.ts), [music-autoplay.ts](../src/music-autoplay.ts) | 음악 재생과 자동 재생 정책 |
| [music-bookmarks.ts](../src/music-bookmarks.ts), [music-duck.ts](../src/music-duck.ts) | 음악 구간 북마크와 상황별 볼륨 낮추기 |
| [audio-gain.ts](../src/audio-gain.ts), [audio-lock.ts](../src/audio-lock.ts), [output-audio.ts](../src/output-audio.ts) | 게인 계산, 브라우저 오디오 잠금과 송출 음향 처리 |
| [fade.ts](../src/fade.ts), [fade-ramp.ts](../src/fade-ramp.ts), [volume-ramp.ts](../src/volume-ramp.ts), [scene-fade.ts](../src/scene-fade.ts) | 시간에 따른 화면·음량 변화와 장면 페이드 |
| [photos.ts](../src/photos.ts), [photo-intake.ts](../src/photo-intake.ts), [photo-seed.ts](../src/photo-seed.ts) | 사진 관리, 사용자 파일 가져오기와 시작 사진 목록 |
| [standby-crossfade.ts](../src/standby-crossfade.ts), [standby-key-visual.ts](../src/standby-key-visual.ts) | 대기 화면의 이미지 전환과 키 비주얼 |
| [mood-routing.ts](../src/mood-routing.ts), [mood-visual.ts](../src/mood-visual.ts), [mood-glitch.ts](../src/mood-glitch.ts), [pixel-sort.ts](../src/pixel-sort.ts) | 분위기에 따른 화면 구성과 글리치·픽셀 효과 |
| [display-fullscreen.ts](../src/display-fullscreen.ts), [display-windowed.ts](../src/display-windowed.ts), [display-scale.ts](../src/display-scale.ts), [display-presentation.ts](../src/display-presentation.ts) | 전체화면·창 모드, 출력 크기와 운영용 표시 정책 |
| [logos.ts](../src/logos.ts), [emblem.ts](../src/emblem.ts) | 기본 팀 마크와 행사 엠블럼 |

## 조작 화면: `src/control/`

| 파일 | 역할 |
| --- | --- |
| [tab-p1.ts](../src/control/tab-p1.ts), [tab-p2.ts](../src/control/tab-p2.ts) | 1부·2부 진행 조작 |
| [tab-timer.ts](../src/control/tab-timer.ts) | 타이머 조작 탭 |
| [tab-roster.ts](../src/control/tab-roster.ts), [tab-teams.ts](../src/control/tab-teams.ts) | 출전 명단과 팀 설정 |
| [tab-award.ts](../src/control/tab-award.ts), [tab-ledger.ts](../src/control/tab-ledger.ts) | 시상과 점수 원장 탭 |
| [tab-assets.ts](../src/control/tab-assets.ts), [asset-sections.ts](../src/control/asset-sections.ts) | 미디어 등록·설정·재생과 에셋 분류 |
| [tab-music.ts](../src/control/tab-music.ts), [tab-photos.ts](../src/control/tab-photos.ts) | 음악과 현장 사진 조작 |
| [tab-settings.ts](../src/control/tab-settings.ts), [transition-rules-ui.ts](../src/control/transition-rules-ui.ts) | 앱 설정·백업과 전환 규칙 편집 |
| [cuesheet.ts](../src/control/cuesheet.ts), [standings.ts](../src/control/standings.ts), [bonus-strip.ts](../src/control/bonus-strip.ts) | 진행 큐 목록, 현재 순위와 보너스 점수 표시 |
| [topbar.ts](../src/control/topbar.ts), [tabs.ts](../src/control/tabs.ts), [sidebar-resize.ts](../src/control/sidebar-resize.ts) | 상단 조작부, 탭 이동과 사이드바 크기 조절 |
| [launcher.ts](../src/control/launcher.ts), [pgm-monitor.ts](../src/control/pgm-monitor.ts) | 송출 창 열기와 송출 상태 모니터 |
| [ctx.ts](../src/control/ctx.ts), [dom.ts](../src/control/dom.ts) | 조작 UI가 공유하는 문맥·DOM 유틸리티 |
| [modal.ts](../src/control/modal.ts), [toast.ts](../src/control/toast.ts), [tooltip.ts](../src/control/tooltip.ts) | 대화상자, 알림과 도움말 |
| [render-hold.ts](../src/control/render-hold.ts), [passive-overlay.ts](../src/control/passive-overlay.ts) | 드래그 중 재렌더 보류와 보조 조작 창의 잠금 안내 |

## 송출 장면: `src/scenes/`

| 파일 | 역할 |
| --- | --- |
| [index.ts](../src/scenes/index.ts) | 장면별 렌더러 연결 |
| [standby.ts](../src/scenes/standby.ts), [photos.ts](../src/scenes/photos.ts) | 대기 화면과 사진 화면 |
| [game.ts](../src/scenes/game.ts), [roster.ts](../src/scenes/roster.ts) | 종목 화면과 출전 명단 |
| [score.ts](../src/scenes/score.ts), [award.ts](../src/scenes/award.ts) | 스코어보드와 시상 화면 |
| [live.ts](../src/scenes/live.ts), [video.ts](../src/scenes/video.ts) | 카메라 중계와 영상 장면 |
| [timerScene.ts](../src/scenes/timerScene.ts) | 타이머 송출 장면 |
| [breaking.ts](../src/scenes/breaking.ts), [prompt.ts](../src/scenes/prompt.ts), [submit.ts](../src/scenes/submit.ts), [suspects.ts](../src/scenes/suspects.ts) | 속보·안내·제출·후반부 스토리 장면 |
| [common.ts](../src/scenes/common.ts), [luxe-grid.ts](../src/scenes/luxe-grid.ts) | 장면들이 공유하는 구성 요소와 그래픽 레이아웃 |
| [ambient.ts](../src/scenes/ambient.ts), [anim.ts](../src/scenes/anim.ts), [confetti.ts](../src/scenes/confetti.ts), [transition.ts](../src/scenes/transition.ts) | 배경 움직임, 애니메이션, 축하 효과와 장면 전환 표현 |

## 기본 자료·문서·검증

| 파일·패턴 | 역할 |
| --- | --- |
| [src/styles/tokens.css](../src/styles/tokens.css) | 색·크기 등 공통 디자인 값 |
| [src/styles/control.css](../src/styles/control.css), [src/styles/display.css](../src/styles/display.css) | 조작·송출 화면의 스타일 |
| `src/fonts/*.woff2` | Pretendard Variable, Inter Variable, Barlow Condensed의 세 굵기. [폰트 고지](../THIRD_PARTY_NOTICES.md)와 함께 유지 |
| [public/favicon.svg](../public/favicon.svg) | 브라우저 탭 아이콘 |
| [public/media/manifest.json](../public/media/manifest.json) | 고정 배포 미디어 목록. 원본 행사 영상은 포함하지 않음 |
| `public/media/standby-*.svg`, `pre_mission.svg`, `athlete_oath.svg` | 대기·사전 미션·선서의 기본 안내 화면 |
| `public/media/game_steady_*.svg`, `p2_steady_stage*.svg` | 종목별·후반부 단계별 기본 안내 화면 |
| `public/media/team_logo_*.svg` | 네 팀의 기본 마크 |
| [public/photo-seed/manifest.json](../public/photo-seed/manifest.json) | 시작 사진 목록. 기본 배포는 빈 목록 |
| [AI_CUSTOMIZATION.md](AI_CUSTOMIZATION.md) | AI와 환경·규칙을 확인하고 수정하는 절차 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 상태·창·미디어의 관계와 경계 |
| [OPERATION_TIPS.md](OPERATION_TIPS.md) | 스팅어 변환, 장비 준비와 실제 운영 경험 |
| [DEVLOG.md](DEVLOG.md) | 제작 소회, 설계 이유와 후속 수정 시 주의점 |
| [AI_MODEL_USAGE.md](AI_MODEL_USAGE.md) | 사용 모델과 토큰 부분 집계·한계 |
| [FILE_GUIDE.md](FILE_GUIDE.md) | 이 파일·폴더 역할 안내 |
| [launcher/launch.sh](../launcher/launch.sh) | 의존성·포트를 확인하고 빌드·서버·브라우저 실행 |
| [tests/launcher.test.mjs](../tests/launcher.test.mjs) | 이동한 설치 경로, 점유 포트와 런처 실행을 검증 |
| `src/**/*.test.ts` | 인접 구현 또는 여러 모듈이 공유하는 동작의 회귀 테스트. 변경 대상 이름과 기능명으로 함께 검색 |
| [src/test-music-fixture.ts](../src/test-music-fixture.ts), [src/scenes/luxe-css.testkit.ts](../src/scenes/luxe-css.testkit.ts) | 테스트용 음악 데이터와 스타일 검사 보조 코드 |
| `licenses/*-OFL-1.1.txt` | 포함 폰트의 법적 고지 원문 |
| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | 설치·타입 검사·테스트·빌드·런처 문법 검사 자동화 |

`node_modules/`, `dist/`, `.private/`는 의존성·생성 결과·로컬 작업 자료를 위한 Git 제외 경로입니다. 실행 코드를 수정할 때는 `dist/` 대신 `src/`와 루트 HTML을 수정한 뒤 다시 빌드하세요. 새 파일이나 책임 분리가 생기면 이 안내와 관련 코드 주석을 함께 갱신합니다.
