/**
 * 운영자 암전(U65) 계산 — 순수 함수만.
 *
 * ## 왜 `sceneFade`를 재사용하지 않는가
 * `scene-fade.ts`의 왕복은 **씬 전환용**이다: 덮고(0→1) 씬을 갈아끼운 뒤 걷는다(1→0).
 * 총 길이가 `durationSec * 2`로 정해져 있어 "검게 덮은 채로 운영자가 되돌릴 때까지 머무는"
 * 상태가 없다. 게다가 `sceneFade/play`는 `scene-routing.ts`(중앙 전환 경계)만 내는 액션이라,
 * 씬을 바꾸지 않는 암전이 그 경로를 타면 경계 계약이 흐려진다. 그래서 별도 축이다.
 *
 * ## 곡선은 새로 쓰지 않는다
 * 값은 `fade-ramp.ts`의 램프를 그대로 통과시킨다 — 검정 페이드(`fade.ts`)·음악 페이드·
 * 대기 배경 크로스디졸브가 전부 같은 `easeInOutQuad` 하나에서 나온다. 페이드마다 곡선을
 * 새로 쓰면 같은 화면에서 두 검정이 다른 속도로 움직인다.
 *
 * ## 거리 비례 지속시간
 * `blackoutSec`은 **0 → 1 전체 구간**의 길이다. 0.8까지 어두워진 순간 다시 끄면 남은 거리는
 * 0.2뿐인데 여기에 5초를 다시 주면 거의 검은 화면이 5초 동안 기어서 밝아진다. 거리에 비례해
 * 자르면 초당 변화량이 항상 같아서, 몇 번을 뒤집어도 같은 속도로 움직인다
 * (`fade-ramp.ts`의 주석과 같은 원칙 — 그래서 계산도 같은 함수를 쓴다).
 */

import { clampUnit, rampValueAt, type ValueRamp } from './fade-ramp';

/** 암전 목표 불투명도. `active`가 곧 목표다(1 = 완전 검정). */
export function blackoutTarget(active: boolean): number {
  return active ? 1 : 0;
}

/**
 * 이번 램프의 길이(ms). 거리에 비례한다 — `makeRamp()`와 **같은 식**이어야 한다.
 * `blackoutSec`이 0 이하이거나 유한하지 않으면 0(컷 강등)이다.
 */
export function blackoutDurationMs(blackoutSec: number, from: number, to: number): number {
  const sec = Number.isFinite(blackoutSec) ? Math.max(0, blackoutSec) : 0;
  return sec * 1000 * Math.abs(clampUnit(to) - clampUnit(from));
}

/**
 * 지금 화면에 적용할 불투명도 (0 = 투명, 1 = 완전 검정).
 * `durationMs <= 0`이면 즉시 끝값. `elapsedMs`가 범위 밖이어도 클램프한 뒤 계산한다.
 */
export function blackoutOpacity(
  elapsedMs: number,
  durationMs: number,
  from: number,
  to: number,
): number {
  const ramp: ValueRamp = {
    from: clampUnit(from),
    to: clampUnit(to),
    startedAt: 0,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
  };
  return rampValueAt(ramp, Number.isFinite(elapsedMs) ? elapsedMs : durationMs);
}

/**
 * 램프가 끝나기까지 남은 초 (올림, 최소 0). 런처 토글이 "5초" → "1초"로 세는 숫자다.
 * 끝났으면 0이므로 호출부는 `> 0`으로 램프 진행 여부를 판정할 수 있다.
 */
export function blackoutRemainingSec(elapsedMs: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const left = durationMs - (Number.isFinite(elapsedMs) ? elapsedMs : durationMs);
  if (left <= 0) return 0;
  return Math.ceil(left / 1000);
}
