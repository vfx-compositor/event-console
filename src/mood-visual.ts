import { easeInOutQuad } from './fade';
import type { SceneOpts } from './types';

type MoodPhase = SceneOpts['moodTransition']['phase'];

export interface MoodVisualState {
  hidden: boolean;
  phase: MoodPhase;
  /**
   * 반전 영상의 소리를 낼 것인가 (D8).
   *
   * **`crossfade`가 아니라 `active` 전체다.** 영상은 큐를 누르는 순간부터 돌고 앞 15초가
   * 검정이므로, 그동안 들리는 것은 소리뿐이다 — 여기서 음소거하면 전환의 절반이 사라진다.
   * 이 슬롯을 함께 쓰는 매치 영상과의 구분은 파일이 아니라 **mood가 그 오버레이의 주인인가**로
   * 한다(`moodOwnsOverlay`). 무음 파일이라 결과가 같아도 판정 근거는 소유권이어야,
   * 나중에 소리 있는 오버레이가 들어와도 조용히 음소거되지 않는다.
   */
  videoAudio: boolean;
  /** 영상이 검정을 뚫고 올라오는 마지막 단계인가 — CSS 크로스페이드 클래스용 */
  crossfadeVisual: boolean;
  /** 캔버스 글리치를 그릴 단계인가 — 이 단계에서만 캔버스가 존재한다(GPU 경합 방지) */
  glitchCanvas: boolean;
  /** 검정 레이어 목표 불투명도. 글리치 중 0, 검정 단계에서 1, 영상 위로 넘어가도 1을 유지한다 */
  blackTarget: number;
}

/** `#overlay-video`가 이 프레임에 앉을 층과 합성 방식 (U77) */
export interface MoodOverlayLayer {
  /** z-index. CSS 규칙과 **같은 숫자**여야 한다(테스트가 대조한다) */
  z: number;
  /** `mix-blend-mode` */
  blend: 'normal' | 'screen';
}

/** `#overlay-video`의 평소 자리. `#mood-transition`(42)보다 위다. */
export const MOOD_OVERLAY_Z = 43;

/**
 * 반전 영상이 앉을 층과 합성 방식 (U77) — 순수 함수.
 *
 * ## 문제
 * 1부 반전 영상은 **앞 15초가 검정인데 그 위에 흰 자막이 얹혀 있다.** U53에서는 그 검정
 * 한 장이 글리치를 가리는 것을 막으려고 영상을 글리치(42) **아래**(41)로 내렸는데
 * (`is-mood-under`), 그러면 자막까지 함께 묻혔다. 소리로만 흐르던 도입부 문구가 화면에
 * 한 글자도 나오지 않았다.
 *
 * ## 해법
 * 층을 내리는 대신 **합성 방식**을 바꾼다. `screen`은 검정을 항등원으로 두므로
 * (`screen(x, 0) = x`) 영상의 검정 배경은 아무것도 덮지 않고 흰 자막만 타 오른다.
 * 그래서 영상을 글리치 **위**(43, 평소 자리)에 그대로 두고 글리치가 계속 보이게 한다.
 *
 * 캔버스를 떼는 `crossfade`에서 `normal`로 되돌린다 — 그때는 영상 자체가 화면의 주인이라
 * 검정도 그려져야 한다. `screen`을 남겨 두면 영상의 어두운 부분이 통째로 투명해진다.
 *
 * 카메라·씬에는 이 값을 쓰지 않는다. 합성이 걸리는 엘리먼트는 `#overlay-video` 하나뿐이고,
 * 그것도 반전이 도는 동안만이다.
 */
export function moodOverlayLayer(active: boolean, phase: MoodPhase): MoodOverlayLayer {
  const captions = active && (phase === 'glitch' || phase === 'blackout');
  return { z: MOOD_OVERLAY_Z, blend: captions ? 'screen' : 'normal' };
}

/**
 * 지금 `#overlay-video`에 실려 있는 것이 **분위기 반전이 튼 영상**인가 (D8).
 *
 * 오버레이 슬롯은 매치 영상(U36)과 공유한다. 소리를 열지 말지를 파일로 판정하면
 * 소리 있는 오버레이를 새로 등록하는 날 조용히 음소거된다 — 주인으로 판정한다.
 */
export function moodOwnsOverlay(
  mood: { active: boolean; assetId: string | null },
  overlayAssetId: string | null,
): boolean {
  return mood.active && mood.assetId !== null && mood.assetId === overlayAssetId;
}

// ---------------------------------------------------------------- 진입 디졸브 (U91)

/**
 * 글리치 캔버스가 라이브 위로 떠오르는 시간(초) (U91).
 *
 * 0.6초인 이유는 두 방향에서 눌린다. 더 짧으면 사라지는 것들(스코어바·VS 바·배지·앰비언트
 * 그레인)이 "깜빡" 꺼진 것처럼 보여 튐이 그대로 남는다. 더 길면 큐를 누른 뒤 아무 일도
 * 일어나지 않는 구간이 길어져 전환의 시작이 뭉개진다. 반전 영상 소리를 올리는 램프
 * (`MOOD_AUDIO_RAMP_SEC`)와 같은 값이라, 소리가 붙는 동안 그림도 함께 올라온다.
 *
 * 이 시간은 **글리치 단계 안에 있다** — 전체 15초(`moodTotalSec`)를 늘리지 않는다.
 */
export const MOOD_GLITCH_FADE_IN_SEC = 0.6;

/**
 * 글리치 캔버스 불투명도 — 순수 함수 (U91).
 *
 * ## 왜 필요한가 (사용자 관찰: "파트원 글리치 넘어갈 때 화면이 순간 튄다")
 * 세기 곡선(`glitchIntensityAt`)은 t=0에서 정확히 0이라 **캔버스에 그려지는 그림**은 첫
 * 프레임에 라이브와 같다. 그런데 캔버스는 카메라 **한 장만** 옮겨 그린다. 라이브 화면에는
 * 그 위에 스코어바·VS 바·종목 배지·타이머·리플레이 표식이 얹혀 있고 `#ambient` 그레인까지
 * 겹쳐 있는데, 불투명한 캔버스(z 42)가 스테이지를 통째로 덮는 순간 그것들이 **한 프레임에
 * 전부 사라진다.** 튀는 것은 카메라 그림이 아니라 카메라 위의 크롬이었다.
 *
 * 그래서 캔버스를 0에서 올린다. 램프가 도는 동안 크롬은 잘려 나가는 대신 서서히 묻히고,
 * 램프가 끝나는 0.6초 시점의 글리치 세기는 (0.6/15)^3.5 ≈ 0.00001 — 사실상 라이브 그대로다.
 * 곡선은 `easeInOutQuad` 하나를 그대로 쓴다(검정 페이드·음악 페이드와 같은 곡선).
 */
export function moodGlitchOpacity(elapsedSec: number): number {
  if (!(MOOD_GLITCH_FADE_IN_SEC > 0)) return 1;
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return 0;
  if (elapsedSec >= MOOD_GLITCH_FADE_IN_SEC) return 1;
  return easeInOutQuad(elapsedSec / MOOD_GLITCH_FADE_IN_SEC);
}

export function moodVisualState(active: boolean, phase: MoodPhase): MoodVisualState {
  return {
    hidden: !active,
    phase: active ? phase : 'idle',
    videoAudio: active,
    crossfadeVisual: active && phase === 'crossfade',
    // U53: 암전 단계에서도 계속 그린다. 예전에는 여기서 캔버스를 떼어 디스토션이 뚝 멈춘 뒤
    // 검정만 올라왔고, 사용자가 "글리치가 가다가 마는 느낌"이라고 지적한 지점이 정확히 이것이다.
    // 검정이 1에 닿는 `crossfade`에서만 캔버스를 뗀다 — 그때는 이미 아무것도 안 보인다.
    glitchCanvas: active && (phase === 'glitch' || phase === 'blackout'),
    // crossfade에서도 1로 두는 이유: 검정 레이어는 오버레이 영상 **아래**에 있고, 영상 자체가
    // 검정에서 시작한다. 여기서 0으로 내리면 영상 뒤로 이전 씬이 잠깐 비친다.
    blackTarget: active && (phase === 'blackout' || phase === 'crossfade') ? 1 : 0,
  };
}
