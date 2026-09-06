/**
 * 라이브 다크 프레임 (U118) — **무엇을 카메라 위에 얹을지**를 정하는 순수 계산만.
 *
 * ## 무엇인가
 * 2026-09-05 07:07 사용자 지시: "2부 전환 라이브 송출이 좀 심심해서 그런데, 대기화면 사진
 * 배경 모드의 다크 모드를 얹은 채 배경만 라이브 중계하면 어때. 그 상태로 위에 글리치."
 *
 * 대기 화면의 "사진 배경 켬" 그림은 세 겹이다 — **검정 지면 → 사진 백드롭 → 알파 다크 영상**
 * (`scenes/standby.ts`의 `standby-stack--on`). 여기서 하는 일은 가운데 한 겹을 갈아 끼우는
 * 것이다: 사진 자리에 **중계 카메라**가 들어온다.
 *
 *   검정 지면 → (버린다)          카메라가 그 자리를 통째로 채우므로 지면이 필요 없다.
 *   사진 백드롭 → 카메라           `.cam-video`가 이미 스테이지를 덮고 있다.
 *   알파 다크 영상 → 그대로        `main_05_dark.webm` 한 장을 카메라 위에 얹는다.
 *
 * **검정 지면을 넣지 않는 것이 계약이다.** 대기 화면에서 그 지면은 알파 영상의 투명한 구멍
 * 너머로 밝은 영상이 비치지 않게 막는 벽이었다(`standby-stack--on`의 `background: #000`).
 * 여기서는 그 구멍 너머로 **보여야 하는 것이 카메라**다 — 지면을 그대로 옮겨 오면 라이브가
 * 한 픽셀도 나오지 않는다.
 *
 * ## 왜 파일이 따로 있는가
 * 판정이 DOM 없이 단언 가능해야 하기 때문이다(`mood-glitch.ts`와 같은 이유). display는
 * 여기서 나온 boolean 하나를 심을 뿐이고, "언제 붙이고 언제 떼는가"의 근거는 전부 여기 있다.
 */

/**
 * 라이브 화면 위 프레임 모드 (`sceneOpts.liveOverlay.frame`).
 *
 * `liveOverlay`에 넣은 이유: 이 값은 "중계 카메라 위에 무엇이 얹히는가"라는 질문의 한 축이고,
 * 그 질문의 주인은 이미 `liveOverlay`다(스코어바·타이머·배지·대결 보더·리플레이 표식).
 * 새 최상위 키(`sceneOpts.live`)를 만들면 migrate 화이트리스트·큐 `opts`·`moveScene` 세 곳에
 * 같은 배선을 한 벌 더 깔아야 하는데, 얻는 것이 없다.
 */
export type LiveFrameMode = 'none' | 'dark-standby';

/**
 * 화이트리스트 — **한 곳에 적는다**(`STANDBY_MODES`·`SUBMIT_MODES`와 같은 계약).
 * 모르는 값이 남으면 어느 분기에도 안 걸려 프레임이 조용히 사라지거나 조용히 남는다.
 */
export const LIVE_FRAME_MODES: readonly LiveFrameMode[] = ['none', 'dark-standby'];

/**
 * 다크 프레임 영상 — 대기 화면이 쓰는 **바로 그 파일**이다.
 *
 * 사본을 뜨지 않는다. 대기 화면과 2부 전환이 같은 그림이어야 한다는 것이 지시의 전부이고,
 * 파일이 갈라지면 한쪽만 교체됐을 때 두 화면이 조용히 달라진다. 매니페스트에 올리지 않는
 * **씬 붙박이 그림**이라는 성질도 그대로 물려받는다(`ATHLETE_OATH_IMAGE`와 같은 이유).
 */
export const LIVE_FRAME_DARK_SRC = './media/main_05_dark.webm';

/**
 * 카메라 위에 까는 어둡힘의 세기 — **설정이 아니라 상수다.**
 *
 * 다크 프레임은 어두운 사진 백드롭 위에 얹히도록 만들어진 그림이라, 밝은 카메라 화면 위에
 * 그대로 올리면 프레임만 어둡고 가운데만 환한 그림이 된다(분위기가 갈린다). 0.25는
 * "라이브인 것이 여전히 읽히는 가장 어두운 값"으로 잡았다 — 0.4를 넘기면 사람 얼굴이
 * 뭉개지고, 0.15 아래에서는 프레임과 카메라의 밝기 차가 그대로 남는다.
 *
 * 운영자가 고를 값이 아니다. 고르게 만들면 본방에서 누군가 0으로 내려 두고 그날의 그림이
 * 리허설과 달라진다 — 대기 화면의 검정 지면을 설정으로 빼지 않은 것과 같은 판단이다.
 */
export const LIVE_FRAME_SCRIM_ALPHA = 0.25;

/** CSS `.live-frame__scrim`의 배경과 **같은 값**이어야 한다(테스트가 대조한다). */
export const LIVE_FRAME_SCRIM_FILL = `rgba(0, 0, 0, ${LIVE_FRAME_SCRIM_ALPHA})`;

/**
 * 저장본·방송·큐에서 온 값의 화이트리스트 검증. 모르는 값과 없는 값은 **똑같이** `none`이다.
 *
 * 모르는 값의 안전한 쪽이 `none`인 이유: 프레임은 카메라 위에 얹히는 **덧그림**이라, 빠져도
 * 중계는 그대로 나간다. 반대로 알 수 없는 값이 프레임을 켜 두면 1부 중계에 2부 톤이 얹힌 채
 * 나가고 아무도 그 자리에서 원인을 못 찾는다.
 */
export function normalizeLiveFrameMode(raw: unknown): LiveFrameMode {
  return LIVE_FRAME_MODES.includes(raw as LiveFrameMode) ? (raw as LiveFrameMode) : 'none';
}

export interface LiveFrameVisibilityInput {
  /** 지금 화면에 나가는 씬(`shownScene`) */
  scene: string;
  mode: LiveFrameMode;
  moodActive: boolean;
  moodPhase: 'idle' | 'glitch' | 'blackout' | 'crossfade';
}

/**
 * 이 프레임에 다크 프레임 영상을 화면에 둘 것인가.
 *
 * ## 왜 `glitch`에서는 남고 `blackout`부터는 사라지는가 (U118 · U91 계약)
 * 글리치 캔버스(z 42)는 **화면을 다시 그린다** — 카메라 한 장이 아니라 이 프레임까지 합쳐
 * 그린다(`drawLiveFrame`). 그래야 진입 0.6초 디졸브가 끝난 그림이 라이브와 같다. 캔버스가
 * 매 프레임 이 영상에서 픽셀을 읽어 가므로 `glitch` 동안에는 **재생 중이어야** 한다.
 *
 * 검정이 1에 닿는 `blackout`부터는 아무도 이 영상을 보지 않는다(캔버스도 검정 아래다).
 * 9MB 알파 webm을 계속 디코딩할 이유가 없고, 이어지는 반전 영상이 화면의 주인이 되는
 * 순간까지 프레임이 남아 있으면 `crossfade`에서 영상 가장자리와 겹쳐 한 겹이 더 비친다.
 * 그래서 여기서 끊는다 — 반전이 오버레이의 주인이 되는 자리(`moodOwnsOverlay`)와 같은 층위다.
 */
export function liveFrameVisible(input: LiveFrameVisibilityInput): boolean {
  if (input.mode !== 'dark-standby') return false;
  if (input.scene !== 'live') return false;
  if (input.moodActive && input.moodPhase !== 'glitch') return false;
  return true;
}

/**
 * 크롬을 전부 끈 라이브 오버레이 — **"퓨어 카메라" 프리셋의 공용 빌더** (U131).
 *
 * 사용자 지시(2026-09-05 11:3x): "중계 오버레이 다 끄고 완전 퓨어 카메라로 보이는 옵션도
 * 만들어줘." `part2-live` 큐(U118)가 이미 크롬 넷(배지·스코어바·타이머·대결 보더)을 전부
 * 끄고 `frame`만 얹는 같은 모양의 opts를 썼다 — 그 자리와 런처의 [퓨어] 버튼이 이 함수
 * 하나를 공유한다. 차이는 `frame` 인자 하나뿐이다: 2부 전환은 `'dark-standby'`(다크
 * 프레임 위 라이브), 런처 [퓨어]는 `'none'`(맨 카메라).
 *
 * 리플레이(`replay`·`replayMarkAt`)는 여기 넣지 않는다 — 반환값은 `scene/set`의 부분
 * patch라 넣지 않은 필드는 그대로 남는다. 리플레이 중이 아니면 원래 꺼져 있고, 리플레이
 * 중에 퓨어를 누르는 것이 되감기를 멈추라는 뜻은 아니다(리플레이 배지는 경고라 스미면
 * 안 된다 — `scenes/live.ts`의 `replayBadge` 계약).
 */
export function liveOverlayAllOff(frame: LiveFrameMode): {
  scorebar: false;
  timer: false;
  badge: null;
  versus: null;
  frame: LiveFrameMode;
} {
  return { scorebar: false, timer: false, badge: null, versus: null, frame };
}

/**
 * 지금 오버레이가 "퓨어 카메라" 상태와 같은가 — 크롬 넷이 전부 꺼지고 프레임도 없다 (U131).
 *
 * 런처 [경기 중계] 버튼이 이 상태에서 눌렸을 때만 기본 크롬(스코어바·타이머)으로 복귀시키는
 * 판정에 쓴다 — 평소(퓨어가 아닐 때)는 F2가 예전 그대로 오버레이를 건드리지 않는다.
 */
export function isPureCameraOverlay(overlay: {
  scorebar: boolean;
  timer: boolean;
  badge: unknown;
  versus: unknown;
  frame: LiveFrameMode;
}): boolean {
  return (
    !overlay.scorebar &&
    !overlay.timer &&
    overlay.badge === null &&
    overlay.versus === null &&
    overlay.frame === 'none'
  );
}
