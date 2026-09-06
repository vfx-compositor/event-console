import { describe, expect, it } from 'vitest';

import { overlayEndEvent } from './overlay-video';

describe('매치 알파 오버레이 종료', () => {
  it('홀드 에셋은 마지막 프레임 유지 사건을 낸다', () => {
    expect(overlayEndEvent(42, true)).toBe('overlay-held:42');
  });

  it('일반 오버레이는 즉시 종료 사건을 낸다', () => {
    expect(overlayEndEvent(42, false)).toBe('overlay-ended:42');
  });
});
