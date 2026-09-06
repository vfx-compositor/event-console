import { describe, expect, it } from 'vitest';

import { standbyKeyVisualId } from './standby-key-visual';

describe('배포 메인 대기화면 자동 연결', () => {
  it('미지정 상태이고 배포 이미지가 있으면 메인 이미지 id를 고른다', () => {
    expect(standbyKeyVisualId(null, ['media:main_standby.jpeg'])).toBe('media:main_standby.jpeg');
  });

  it('사용자가 이미 고른 키비주얼은 덮어쓰지 않는다', () => {
    expect(standbyKeyVisualId('custom', ['media:main_standby.jpeg'])).toBe('custom');
  });

  it('배포 이미지가 아직 없으면 미지정 상태를 보존한다', () => {
    expect(standbyKeyVisualId(null, [])).toBeNull();
  });
});
