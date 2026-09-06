import { describe, expect, it } from 'vitest';

import { outputVolume, volumePercent } from './output-audio';

describe('출력 마스터 볼륨', () => {
  it('마스터 볼륨과 페이드 게인을 곱하고 안전 범위로 제한한다', () => {
    expect(outputVolume(0.8, 1)).toBe(0.8);
    expect(outputVolume(0.8, 0.25)).toBeCloseTo(0.2, 10);
    expect(outputVolume(2, 2)).toBe(1);
    expect(outputVolume(-1, 1)).toBe(0);
  });

  it('노브 표시값을 정수 퍼센트로 만든다', () => {
    expect(volumePercent(0)).toBe(0);
    expect(volumePercent(0.426)).toBe(43);
    expect(volumePercent(2)).toBe(100);
  });
});