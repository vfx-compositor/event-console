import { describe, expect, it } from 'vitest';

import { sceneFadeFrame } from './scene-fade';

describe('컬러 씬 페이드 프레임', () => {
  it('전반부에 불투명해지고 정점에서 씬 교체 사건을 낸다', () => {
    expect(sceneFadeFrame(0.25, 0.5, false)).toEqual({ opacity: 0.5, event: null });
    expect(sceneFadeFrame(0.5, 0.5, false)).toEqual({ opacity: 1, event: 'switch' });
  });

  it('씬 교체 뒤 투명해지고 끝에서 종료 사건을 낸다', () => {
    expect(sceneFadeFrame(0.75, 0.5, true)).toEqual({ opacity: 0.5, event: null });
    expect(sceneFadeFrame(1, 0.5, true)).toEqual({ opacity: 0, event: 'finish' });
  });

  it('0초 설정은 즉시 교체·종료한다', () => {
    expect(sceneFadeFrame(0, 0, false)).toEqual({ opacity: 1, event: 'switch' });
    expect(sceneFadeFrame(0, 0, true)).toEqual({ opacity: 0, event: 'finish' });
  });
});
