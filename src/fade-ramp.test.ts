import { describe, expect, it } from 'vitest';
import { clampUnit, isRampDone, makeRamp, rampTarget, rampValueAt } from './fade-ramp';

describe('값 램프 (음악 페이드 · 배경 크로스디졸브 공통)', () => {
  it('0에서 1까지는 fadeSec 전체를 쓰고 양 끝에서 정확히 끝값이다', () => {
    const ramp = makeRamp(0, 1, 5, 1000);
    expect(ramp.durationMs).toBe(5000);
    expect(rampValueAt(ramp, 1000)).toBe(0);
    expect(rampValueAt(ramp, 6000)).toBe(1);
    expect(rampValueAt(ramp, 3500)).toBeCloseTo(0.5, 6);
  });

  it('구간 중간은 단조 증가하며 0.5 지점에서 두 분기가 만난다', () => {
    const ramp = makeRamp(0, 1, 5, 0);
    const samples = [0, 1000, 2000, 2500, 3000, 4000, 5000].map((t) => rampValueAt(ramp, t));
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1] - 1e-9);
    }
    expect(samples[3]).toBeCloseTo(0.5, 6);
  });

  it('fadeSec이 0이면 즉시 끝값 — 컷으로 강등한다', () => {
    const ramp = makeRamp(0, 1, 0, 0);
    expect(ramp.durationMs).toBe(0);
    expect(rampValueAt(ramp, 0)).toBe(1);
    expect(isRampDone(ramp, 0)).toBe(true);
  });

  it('페이드 아웃 도중 역전하면 현재 값에서 이어 올라가고 점프하지 않는다', () => {
    const out = makeRamp(1, 0, 5, 0);
    const atReverse = rampValueAt(out, 2500);
    expect(atReverse).toBeCloseTo(0.5, 6);

    const back = makeRamp(atReverse, 1, 5, 2500);
    // 시작값이 그대로 이어진다 (점프 없음)
    expect(rampValueAt(back, 2500)).toBeCloseTo(atReverse, 6);
    // 남은 거리가 절반이므로 남은 시간도 절반이다 — 기울기가 같다
    expect(back.durationMs).toBeCloseTo(2500, 6);
    expect(rampValueAt(back, 5000)).toBe(1);
  });

  it('범위를 벗어난 시각과 값은 클램프한다', () => {
    const ramp = makeRamp(-3, 9, 4, 100);
    expect(ramp.from).toBe(0);
    expect(ramp.to).toBe(1);
    expect(rampValueAt(ramp, 0)).toBe(0);
    expect(rampValueAt(ramp, 10_000)).toBe(1);
    expect(clampUnit(Number.NaN)).toBe(0);
  });

  it('rampTarget은 진행 중인 램프의 목표를, 없으면 현재 값을 돌려준다', () => {
    expect(rampTarget(makeRamp(1, 0, 5, 0), 1)).toBe(0);
    expect(rampTarget(null, 0.42)).toBe(0.42);
  });
});
