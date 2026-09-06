/**
 * `db.ts`의 **순수 로직**만 검증한다 (vitest 환경은 `node` — IndexedDB 없음).
 *
 * 여기서 잡고자 하는 실제 사고:
 *  - 5초 스냅샷이 사진 목록을 200벌 복사해 이력이 같은 내용으로만 가득 찬다 (M3)
 *  - 스냅샷을 되돌렸더니 사진이 통째로 비어 나온다 (M3 — 읽기 경로가 최신 목록을 다시 끼운다)
 *  - `onblocked` 직후 여러 호출부가 동시에 재시도해 경고가 초당 수십 줄로 흐른다 (M4)
 *
 * 다중 창 협상 규칙(`createDbNegotiation`)·스토어 업그레이드(`applyUpgrade`)는
 * `photos.test.ts`가 이미 덮고 있다.
 */

import { describe, expect, it } from 'vitest';

import {
  DB_BLOCKED_COOLDOWN_MS,
  injectPhotoItems,
  isBlockedCooldown,
  leanSnapshotJson,
} from './db';
import type { AppState } from './types';

/** 스냅샷 직렬화가 보는 부분만 갖춘 최소 상태 */
function stateWith(items: unknown[], scene = 'standby'): AppState {
  return {
    scene,
    photos: { items, settings: { autoIntake: true, intervalSec: 6 } },
  } as unknown as AppState;
}

// ---------------------------------------------------------------- M3 스냅샷 비대

describe('leanSnapshotJson — 사진 목록을 스냅샷에서 뺀다 (M3)', () => {
  it('photos.items를 빈 배열로 바꾼다 (나머지는 그대로)', () => {
    const json = leanSnapshotJson(stateWith([{ id: 'a' }, { id: 'b' }]));
    const obj = JSON.parse(json) as { scene: string; photos: { items: unknown[]; settings: unknown } };
    expect(obj.photos.items).toEqual([]);
    expect(obj.scene).toBe('standby');
    // 설정은 남는다 — 자동 수집 on/off는 되돌릴 값이다
    expect(obj.photos.settings).toEqual({ autoIntake: true, intervalSec: 6 });
  });

  it('원본 상태를 건드리지 않는다', () => {
    const items = [{ id: 'a' }];
    const state = stateWith(items);
    leanSnapshotJson(state);
    expect(state.photos.items).toBe(items);
    expect(state.photos.items.length).toBe(1);
  });

  it('사진 200장이면 스냅샷이 눈에 띄게 줄어든다', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `IMG_${i}.jpg:400000:170000000${i}`,
      name: `IMG_${i}.jpg`,
      takenAt: 1700000000000 + i,
      addedAt: 1700000000000 + i,
      w: 1920,
      h: 1080,
      bytes: 400_000,
      hidden: false,
      p2: false,
    }));
    const full = JSON.stringify(stateWith(many));
    const lean = leanSnapshotJson(stateWith(many));
    expect(lean.length * 10).toBeLessThan(full.length);
  });

  it('photos가 없거나 items가 배열이 아니면 통째로 직렬화한다 (옛 저장본 방어)', () => {
    const noPhotos = { scene: 'live' } as unknown as AppState;
    expect(JSON.parse(leanSnapshotJson(noPhotos))).toEqual({ scene: 'live' });
    const broken = { scene: 'live', photos: { items: null } } as unknown as AppState;
    expect(JSON.parse(leanSnapshotJson(broken))).toEqual({ scene: 'live', photos: { items: null } });
  });

  it('사진만 늘어난 상태는 lean 직렬화가 동일하다 (같으면 저장을 건너뛰는 근거)', () => {
    const a = leanSnapshotJson(stateWith([{ id: 'a' }]));
    const b = leanSnapshotJson(stateWith([{ id: 'a' }, { id: 'b' }]));
    expect(a).toBe(b);
  });

  it('사진 밖이 바뀌면 직렬화도 달라진다 (스냅샷을 건너뛰면 안 되는 경우)', () => {
    const a = leanSnapshotJson(stateWith([{ id: 'a' }], 'standby'));
    const b = leanSnapshotJson(stateWith([{ id: 'a' }], 'score'));
    expect(a).not.toBe(b);
  });
});

describe('injectPhotoItems — 읽을 때 최신 사진 목록을 되돌린다 (M3)', () => {
  it('빈 items 자리에 최신 목록을 끼운다', () => {
    const json = leanSnapshotJson(stateWith([]));
    const out = JSON.parse(injectPhotoItems(json, [{ id: 'a' }, { id: 'b' }])) as {
      photos: { items: unknown[] };
    };
    expect(out.photos.items).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('items가 이미 들어 있는 옛 스냅샷은 건드리지 않는다', () => {
    const legacy = JSON.stringify({ scene: 'live', photos: { items: [{ id: 'old' }] } });
    expect(injectPhotoItems(legacy, [{ id: 'new' }])).toBe(legacy);
  });

  it('끼울 목록이 비었으면 원문 그대로다', () => {
    const json = leanSnapshotJson(stateWith([]));
    expect(injectPhotoItems(json, [])).toBe(json);
  });

  it('깨진 JSON·photos 없는 스냅샷에도 던지지 않는다', () => {
    expect(injectPhotoItems('{ not json', [{ id: 'a' }])).toBe('{ not json');
    const noPhotos = JSON.stringify({ scene: 'live' });
    expect(injectPhotoItems(noPhotos, [{ id: 'a' }])).toBe(noPhotos);
  });

  it('끼운 목록은 복사본이다 (복원 상태와 kv 캐시가 같은 배열을 공유하지 않게)', () => {
    const items = [{ id: 'a' }];
    const out = JSON.parse(injectPhotoItems(leanSnapshotJson(stateWith([])), items)) as {
      photos: { items: unknown[] };
    };
    expect(out.photos.items).not.toBe(items);
    expect(out.photos.items).toEqual(items);
  });
});

// ---------------------------------------------------------------- M4 blocked 재시도 폭주

describe('isBlockedCooldown — onblocked 뒤 재시도 잠금 (M4)', () => {
  it('막힌 적이 없으면 언제나 새로 연다', () => {
    expect(isBlockedCooldown(null, 1_000)).toBe(false);
  });

  it('쿨다운 안에서는 같은 거절을 재사용한다', () => {
    expect(isBlockedCooldown(1_000, 1_000)).toBe(true);
    expect(isBlockedCooldown(1_000, 1_000 + DB_BLOCKED_COOLDOWN_MS - 1)).toBe(true);
  });

  it('쿨다운을 지나면 다시 시도한다 (막은 창이 닫혔을 수 있다)', () => {
    expect(isBlockedCooldown(1_000, 1_000 + DB_BLOCKED_COOLDOWN_MS)).toBe(false);
    expect(isBlockedCooldown(1_000, 1_000 + DB_BLOCKED_COOLDOWN_MS * 10)).toBe(false);
  });

  it('시계가 뒤로 가면 쿨다운을 믿지 않는다 (절전 복귀·수동 조정)', () => {
    expect(isBlockedCooldown(10_000, 5_000)).toBe(false);
  });

  it('행사 중 실측 폭주 시나리오 — 3초 폴링·5초 스냅샷이 겹쳐도 open은 한 번뿐이다', () => {
    const blockedAt = 0;
    const calls = [0, 100, 500, 1_000, 1_999];
    expect(calls.every((now) => isBlockedCooldown(blockedAt, now))).toBe(true);
    expect(isBlockedCooldown(blockedAt, 2_000)).toBe(false);
  });
});
