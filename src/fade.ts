/**
 * 설명 영상(full) 검정 페이드 계산 — 순수 함수만.
 *
 * rAF 루프 안에 타이밍 산수를 넣으면 테스트가 불가능하다(vitest 환경이 `node`라 DOM 테스트가
 * 없다). 값 계산만 여기 빼 두고, display 루프는 이 함수들의 결과를 매 프레임 그대로 적용한다.
 *
 * opacity·volume은 **같은 ease-in-out 곡선 하나**에서 나온다 — 두 값을 따로 계산하면
 * 검정이 다 덮이기 전에 소리가 먼저 끊기거나 그 반대인 어긋남이 반드시 생긴다
 * (사용자 슬라이더 룰 — 핸들·fill이 한 계산식에서 나와야 한다는 것과 같은 원칙).
 */

export type FadeDirection = 'to-black' | 'from-black';

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * ease-in-out (2차) — t<0.5는 가속, t>=0.5는 감속. 두 분기는 t=0.5에서 값 0.5로 만난다.
 *
 * 음악 페이드(U18)·대기 배경 크로스디졸브(U19)도 이 곡선 하나를 쓴다 (`fade-ramp.ts`) —
 * 페이드마다 곡선을 새로 쓰면 같은 화면에서 검정 페이드와 소리 페이드가 다른 속도로 움직인다.
 */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

/**
 * 0 = 완전 투명, 1 = 완전 검정. fadeMs<=0이면 즉시 끝값(컷 강등).
 * elapsedMs가 범위 밖이어도 [0, fadeMs]로 클램프한 뒤 계산한다.
 */
export function fadeOpacityAt(elapsedMs: number, fadeMs: number, dir: FadeDirection): number {
  const endOpacity = dir === 'to-black' ? 1 : 0;
  if (fadeMs <= 0) return endOpacity;

  const t = clamp01(elapsedMs / fadeMs);
  const eased = easeInOutQuad(t);
  return dir === 'to-black' ? eased : 1 - eased;
}

/** 페이드가 끝났는가 (보고 시점 판정). fadeMs<=0이면 즉시 완료 */
export function isFadeComplete(elapsedMs: number, fadeMs: number): boolean {
  if (fadeMs <= 0) return true;
  return elapsedMs >= fadeMs;
}

/**
 * 검정 불투명도에 맞춘 볼륨 (1 - opacity). muted 여부와 무관하게 값만 계산한다 —
 * 실제로 들리는지는 videoEl.muted가 따로 결정하고, 여기는 볼륨 램프의 크기만 낸다.
 */
export function volumeForOpacity(opacity: number): number {
  return 1 - clamp01(opacity);
}

/**
 * 재생 중 꼬리 페이드를 시작할 시각(초). duration을 모르면 null을 반환하고,
 * 그 경우 display는 'ended' 이벤트만으로 tail 단계를 연다(§4-3).
 * duration이 fadeSec보다 짧으면 0으로 클램프한다 — 시작하자마자 꼬리 페이드에 들어간다.
 */
export function tailStartSec(durationSec: number | undefined, fadeSec: number): number | null {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec)) return null;
  return Math.max(0, durationSec - fadeSec);
}
