import { describe, expect, it } from 'vitest';
import { fadeOpacityAt, isFadeComplete, tailStartSec, volumeForOpacity } from './fade';

describe('fadeOpacityAt', () => {
  it('to-black: 0ms=0(투명), fadeMs=1(검정), 범위 밖은 클램프', () => {
    expect(fadeOpacityAt(0, 1000, 'to-black')).toBe(0);
    expect(fadeOpacityAt(1000, 1000, 'to-black')).toBe(1);
    expect(fadeOpacityAt(-500, 1000, 'to-black')).toBe(0);
    expect(fadeOpacityAt(5000, 1000, 'to-black')).toBe(1);
  });

  it('from-black: 0ms=1(검정), fadeMs=0(투명), 범위 밖은 클램프', () => {
    expect(fadeOpacityAt(0, 1000, 'from-black')).toBe(1);
    expect(fadeOpacityAt(1000, 1000, 'from-black')).toBe(0);
    expect(fadeOpacityAt(-500, 1000, 'from-black')).toBe(1);
    expect(fadeOpacityAt(5000, 1000, 'from-black')).toBe(0);
  });

  it('중간 지점은 ease-in-out 곡선값을 따른다 (선형이 아니다)', () => {
    // t=0.25 → 2*0.25^2 = 0.125 (to-black), 선형(0.25)과 다름을 확인
    expect(fadeOpacityAt(250, 1000, 'to-black')).toBeCloseTo(0.125, 5);
    // t=0.5 → 양쪽 분기가 만나는 지점, 0.5
    expect(fadeOpacityAt(500, 1000, 'to-black')).toBeCloseTo(0.5, 5);
    // t=0.75 → 1 - 2*(1-0.75)^2 = 1 - 0.125 = 0.875
    expect(fadeOpacityAt(750, 1000, 'to-black')).toBeCloseTo(0.875, 5);
  });

  it('fadeMs <= 0이면 즉시 끝값 (컷 강등)', () => {
    expect(fadeOpacityAt(0, 0, 'to-black')).toBe(1);
    expect(fadeOpacityAt(0, 0, 'from-black')).toBe(0);
    expect(fadeOpacityAt(999, -100, 'to-black')).toBe(1);
    expect(fadeOpacityAt(999, -100, 'from-black')).toBe(0);
  });
});

describe('isFadeComplete', () => {
  it('경과 시간이 fadeMs 이상이면 완료', () => {
    expect(isFadeComplete(999, 1000)).toBe(false);
    expect(isFadeComplete(1000, 1000)).toBe(true);
    expect(isFadeComplete(1500, 1000)).toBe(true);
  });

  it('fadeMs <= 0이면 즉시 완료', () => {
    expect(isFadeComplete(0, 0)).toBe(true);
    expect(isFadeComplete(0, -50)).toBe(true);
  });
});

describe('volumeForOpacity', () => {
  it('opacity와 반대 값을 낸다 (같은 곡선 하나에서 파생 — 두 값이 갈라지지 않음)', () => {
    expect(volumeForOpacity(0)).toBe(1);
    expect(volumeForOpacity(1)).toBe(0);
    expect(volumeForOpacity(0.3)).toBeCloseTo(0.7, 10);
  });

  it('opacity와 volume이 fadeOpacityAt이 만든 값에서 정확히 상보적이다', () => {
    const opacity = fadeOpacityAt(300, 1000, 'to-black');
    expect(volumeForOpacity(opacity)).toBeCloseTo(1 - opacity, 10);
  });

  it('범위 밖 입력도 [0,1]로 클램프한다', () => {
    expect(volumeForOpacity(-1)).toBe(1);
    expect(volumeForOpacity(2)).toBe(0);
  });
});

describe('tailStartSec', () => {
  it('duration을 모르면 null', () => {
    expect(tailStartSec(undefined, 0.5)).toBeNull();
  });

  it('정상 케이스: duration - fadeSec', () => {
    expect(tailStartSec(10, 0.5)).toBeCloseTo(9.5, 10);
  });

  it('duration < fadeSec이면 0으로 클램프', () => {
    expect(tailStartSec(0.2, 0.5)).toBe(0);
    expect(tailStartSec(0, 0.5)).toBe(0);
  });
});
