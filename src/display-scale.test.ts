import { describe, expect, it } from 'vitest';

import { displayScaleForShortcut, fitDisplayScale } from './display-scale';

describe('출력창 GUI 배율', () => {
  it('Cmd+=와 Cmd+-를 5% 단위 배율 변경으로 해석한다', () => {
    expect(displayScaleForShortcut(1, { metaKey: true, code: 'Equal' })).toBe(1.05);
    expect(displayScaleForShortcut(1, { metaKey: true, code: 'Minus' })).toBe(0.95);
    expect(displayScaleForShortcut(1, { metaKey: false, code: 'Equal' })).toBeNull();
    expect(displayScaleForShortcut(1, { metaKey: true, code: 'KeyA' })).toBeNull();
  });

  it('배율을 75~150%로 제한한다', () => {
    expect(displayScaleForShortcut(1.5, { metaKey: true, code: 'Equal' })).toBe(1.5);
    expect(displayScaleForShortcut(0.75, { metaKey: true, code: 'Minus' })).toBe(0.75);
  });

  it('1920×1080 기준 자동 맞춤 배율 위에 사용자 배율을 곱한다', () => {
    expect(fitDisplayScale(1280, 720, 1.2)).toBeCloseTo(0.8, 10);
    expect(fitDisplayScale(1920, 1200, 0.9)).toBeCloseTo(0.9, 10);
  });
});
