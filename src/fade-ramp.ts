/**
 * 값 램프(volume·opacity) 공통 계산 — 순수 함수만.
 *
 * U18 음악 페이드(5초)와 U19 대기 배경 크로스디졸브(10초)는 대상만 다를 뿐 산수가 같다.
 * 두 곳에 따로 쓰면 반드시 어긋난다 — 특히 "페이드 도중 반대로 뒤집기"의 처리가 그렇다.
 * 그래서 램프 하나를 두고 곡선은 검정 페이드와 같은 `easeInOutQuad`를 그대로 쓴다.
 *
 * ## 왜 지속시간이 거리에 비례하는가
 * `fadeSec`은 **0 → 1 전체 구간**의 길이다. 페이드 아웃이 0.8까지 내려간 순간 다시 재생을
 * 누르면 남은 거리는 0.2뿐인데 여기에 5초를 다시 주면 "거의 다 찬 볼륨이 5초 동안 기어오르는"
 * 이상한 소리가 난다. 거리에 비례해 자르면 기울기(초당 변화량)가 항상 같아서, 몇 번을 뒤집어도
 * 같은 속도로 움직인다. 시작값은 항상 **현재 값**이라 값이 튀지 않는다.
 */

import { easeInOutQuad } from './fade';

export interface ValueRamp {
  /** 램프 시작 시점의 실제 값 — 역전 시 점프를 막는 유일한 근거 */
  from: number;
  to: number;
  startedAt: number;
  durationMs: number;
}

export function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** `fadeSec`이 0 이하이거나 유한하지 않으면 즉시 끝값(컷 강등)인 램프를 만든다. */
export function makeRamp(from: number, to: number, fadeSec: number, now: number): ValueRamp {
  const start = clampUnit(from);
  const end = clampUnit(to);
  const sec = Number.isFinite(fadeSec) ? Math.max(0, fadeSec) : 0;
  return {
    from: start,
    to: end,
    startedAt: now,
    durationMs: sec * 1000 * Math.abs(end - start),
  };
}

export function rampValueAt(ramp: ValueRamp, now: number): number {
  if (ramp.durationMs <= 0) return ramp.to;
  const t = clampUnit((now - ramp.startedAt) / ramp.durationMs);
  return ramp.from + (ramp.to - ramp.from) * easeInOutQuad(t);
}

export function isRampDone(ramp: ValueRamp, now: number): boolean {
  if (ramp.durationMs <= 0) return true;
  return now - ramp.startedAt >= ramp.durationMs;
}

/** 이미 향하고 있는 목표값. 램프가 없으면 현재 값이 곧 목표다. */
export function rampTarget(ramp: ValueRamp | null, current: number): number {
  return ramp ? ramp.to : current;
}
