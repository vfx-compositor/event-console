import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MASTER_RAMP_SEC,
  MASTER_RAMP_SEC_RANGE,
  VOLUME_AXES,
  effectiveVolume,
  emptyVolumeRamps,
  normalizeVolumeRamp,
  startVolumeRamp,
  volumeRampSettled,
  storedVolume,
} from './volume-ramp';
import { createInitialState, deserialize, promoteLegacyDefaults, reducer, serialize } from './state';
import type { Settings, VolumeAxis, VolumeRamps } from './types';

/** 축 하나짜리 축약 헬퍼 — 순수 산수 테스트는 축을 바꿔 가며 같은 계약을 확인한다 */
const S = (media: number, music = media): Settings =>
  ({ ...createInitialState().settings, mediaVolume: media, musicVolume: music }) as Settings;
const R = (axis: VolumeAxis, ramp: VolumeRamps[VolumeAxis]): VolumeRamps => ({
  ...emptyVolumeRamps(),
  [axis]: ramp,
});
const eff = (v: number, ramp: VolumeRamps['media'], now: number, axis: VolumeAxis = 'media') =>
  effectiveVolume(S(v), R(axis, ramp), axis, now);
const start = (
  v: number,
  ramp: VolumeRamps['media'],
  target: number,
  sec: number,
  now: number,
  axis: VolumeAxis = 'media',
) => startVolumeRamp(S(v), R(axis, ramp), axis, target, sec, now);

describe('마스터 볼륨 램프 (U43)', () => {
  it('램프가 없으면 저장된 마스터 값이 그대로 들린다', () => {
    expect(eff(0.42, null, 1000)).toBeCloseTo(0.42, 6);
  });

  it('램프 구간을 easeInOut으로 지나 목표값에 닿는다', () => {
    const ramp = start(1, null, 0.1, 5, 0);
    expect(eff(1, ramp, 0)).toBeCloseTo(1, 6);
    const mid = eff(1, ramp, ramp.startedAt + ramp.durationMs / 2);
    // 중간값은 선형 중간(0.55)과 같다 — easeInOutQuad는 t=0.5에서 0.5다.
    expect(mid).toBeCloseTo(0.55, 3);
    // 3/4 지점은 선형보다 목표에 가깝다 (ease-out 구간)
    const late = eff(1, ramp, ramp.startedAt + ramp.durationMs * 0.75);
    expect(late).toBeLessThan(0.325);
    expect(eff(1, ramp, ramp.startedAt + ramp.durationMs)).toBeCloseTo(0.1, 6);
  });

  it('기울기가 거리와 무관하게 일정하다 — 5초는 0→1 전 구간 기준', () => {
    const full = start(0, null, 1, 5, 0);
    const half = start(0.5, null, 1, 5, 0);
    expect(full.durationMs).toBe(5000);
    expect(half.durationMs).toBe(2500);
  });

  it('램프 도중 역전하면 저장값이 아니라 **현재 값**에서 출발한다', () => {
    const down = start(1, null, 0.1, 5, 0);
    const at = down.startedAt + down.durationMs / 2;
    const current = eff(1, down, at);
    const up = start(1, down, 1, 5, at);
    expect(up.from).toBeCloseTo(current, 6);
    expect(up.to).toBe(1);
    // 뒤집은 순간 값이 튀지 않는다
    expect(eff(1, up, at)).toBeCloseTo(current, 6);
  });

  it('길이가 0이면 컷으로 강등된다', () => {
    const ramp = start(1, null, 0, 0, 0);
    expect(volumeRampSettled(ramp, 0)).toBe(true);
    expect(eff(1, ramp, 0)).toBe(0);
  });

  it('완료 판정은 시간이 다 지난 뒤에만 참이다', () => {
    const ramp = start(1, null, 0, 5, 0);
    expect(volumeRampSettled(null, 0)).toBe(false);
    expect(volumeRampSettled(ramp, 4999)).toBe(false);
    expect(volumeRampSettled(ramp, 5000)).toBe(true);
  });

  it('목표·시작값은 0~1로 클램프된다', () => {
    const ramp = start(3, null, 9, 5, 0);
    expect(ramp.from).toBe(1);
    expect(ramp.to).toBe(1);
    expect(start(0.5, null, -2, 5, 0).to).toBe(0);
  });

  it('저장본에서 되살릴 때 모양이 어긋난 램프는 버린다', () => {
    expect(normalizeVolumeRamp(null)).toBeNull();
    expect(normalizeVolumeRamp({ from: 1, to: 0 })).toBeNull();
    expect(normalizeVolumeRamp({ from: 'a', to: 0, startedAt: 0, durationMs: 10 })).toBeNull();
    expect(normalizeVolumeRamp({ from: 1, to: 0.1, startedAt: 5, durationMs: 4500 })).toEqual({
      from: 1,
      to: 0.1,
      startedAt: 5,
      durationMs: 4500,
    });
    // 값은 클램프해서 되살린다 — 범위 밖 볼륨이 element에 그대로 실리면 안 된다
    expect(normalizeVolumeRamp({ from: 5, to: -1, startedAt: 0, durationMs: 100 })).toEqual({
      from: 1,
      to: 0,
      startedAt: 0,
      durationMs: 100,
    });
  });

  it('기본 램프 길이는 5초이고 설정 범위 안이다', () => {
    expect(DEFAULT_MASTER_RAMP_SEC).toBe(5);
    expect(DEFAULT_MASTER_RAMP_SEC).toBeGreaterThanOrEqual(MASTER_RAMP_SEC_RANGE.min);
    expect(DEFAULT_MASTER_RAMP_SEC).toBeLessThanOrEqual(MASTER_RAMP_SEC_RANGE.max);
  });
});

// ---------------------------------------------------------------- 리듀서 계약

describe('볼륨 램프 액션 (U43 · U45)', () => {
  for (const axis of VOLUME_AXES) {
    const other: VolumeAxis = axis === 'media' ? 'music' : 'media';

    it(`[${axis}] rampTo는 저장값을 덮지 않고 램프만 세운다 — 완료 전 새로고침해도 값이 튀지 않는다`, () => {
      const base = createInitialState();
      const next = reducer(base, { type: 'volume/rampTo', axis, target: 0.1, sec: 5, now: 1000 });
      expect(storedVolume(next.settings, axis)).toBe(1);
      expect(next.volumeRamps[axis]).not.toBeNull();
      expect(next.volumeRamps[axis]?.to).toBe(0.1);
      expect(effectiveVolume(next.settings, next.volumeRamps, axis, 1000)).toBeCloseTo(1, 6);
    });

    it(`[${axis}] 램프는 그 축에만 걸린다 — 다른 축은 값도 램프도 그대로다`, () => {
      const base = createInitialState();
      const next = reducer(base, { type: 'volume/rampTo', axis, target: 0, sec: 5, now: 0 });
      expect(next.volumeRamps[other]).toBeNull();
      expect(effectiveVolume(next.settings, next.volumeRamps, other, 9999)).toBe(1);
    });

    it(`[${axis}] 역전 램프는 지금 들리는 값에서 이어진다`, () => {
      const down = reducer(createInitialState(), { type: 'volume/rampTo', axis, target: 0, sec: 5, now: 0 });
      const at = 2500;
      const heard = effectiveVolume(down.settings, down.volumeRamps, axis, at);
      const up = reducer(down, { type: 'volume/rampTo', axis, target: 1, sec: 5, now: at });
      expect(effectiveVolume(up.settings, up.volumeRamps, axis, at)).toBeCloseTo(heard, 6);
    });

    it(`[${axis}] 완료된 램프를 settle하면 최종값이 저장값이 되고 램프가 사라진다`, () => {
      const ramping = reducer(createInitialState(), { type: 'volume/rampTo', axis, target: 0.1, sec: 5, now: 0 });
      expect(reducer(ramping, { type: 'volume/rampSettle', axis, now: 100 })).toBe(ramping);
      const settled = reducer(ramping, { type: 'volume/rampSettle', axis, now: 999_999 });
      expect(storedVolume(settled.settings, axis)).toBe(0.1);
      expect(settled.volumeRamps[axis]).toBeNull();
    });

    it(`[${axis}] 슬라이더를 잡으면 지금 들리는 값에서 램프가 끊긴다`, () => {
      const ramping = reducer(createInitialState(), { type: 'volume/rampTo', axis, target: 0, sec: 5, now: 0 });
      const heard = effectiveVolume(ramping.settings, ramping.volumeRamps, axis, 2500);
      const cancelled = reducer(ramping, { type: 'volume/rampCancel', axis, now: 2500 });
      expect(cancelled.volumeRamps[axis]).toBeNull();
      expect(storedVolume(cancelled.settings, axis)).toBeCloseTo(heard, 6);
      // 램프가 없을 때는 상태를 갈지 않는다 (재렌더 유발 금지)
      expect(reducer(cancelled, { type: 'volume/rampCancel', axis, now: 3000 })).toBe(cancelled);
    });

    it(`[${axis}] 슬라이더 조작(volume/set)은 진행 중인 램프를 이기고 다른 축은 건드리지 않는다`, () => {
      const ramping = reducer(createInitialState(), { type: 'volume/rampTo', axis, target: 0, sec: 5, now: 0 });
      const set = reducer(ramping, { type: 'volume/set', axis, value: 0.7 });
      expect(set.volumeRamps[axis]).toBeNull();
      expect(storedVolume(set.settings, axis)).toBe(0.7);
      expect(storedVolume(set.settings, other)).toBe(1);
    });

    it(`[${axis}] 램프는 방송(직렬화)을 타고 display까지 살아 간다 — migrate가 지우면 소리가 안 움직인다`, () => {
      const ramping = reducer(createInitialState(), { type: 'volume/rampTo', axis, target: 0.1, sec: 5, now: 1234 });
      expect(deserialize(serialize(ramping)).volumeRamps[axis]).toEqual(ramping.volumeRamps[axis]);
    });
  }

  it('두 축 램프가 동시에 돌아도 서로 섞이지 않는다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'volume/rampTo', axis: 'media', target: 0, sec: 5, now: 0 });
    s = reducer(s, { type: 'volume/rampTo', axis: 'music', target: 0.5, sec: 5, now: 0 });
    expect(effectiveVolume(s.settings, s.volumeRamps, 'media', 999_999)).toBe(0);
    expect(effectiveVolume(s.settings, s.volumeRamps, 'music', 999_999)).toBe(0.5);
    // 한쪽만 확정해도 다른 쪽 램프는 그대로 돈다
    const settled = reducer(s, { type: 'volume/rampSettle', axis: 'media', now: 999_999 });
    expect(settled.volumeRamps.media).toBeNull();
    expect(settled.volumeRamps.music).not.toBeNull();
  });

  it('램프 키가 없는 옛 저장본은 두 축 모두 null로 인수된다', () => {
    const legacy = JSON.parse(serialize(createInitialState()));
    delete legacy.volumeRamps;
    expect(deserialize(JSON.stringify(legacy)).volumeRamps).toEqual(emptyVolumeRamps());
    legacy.volumeRamps = { media: { from: 'x' }, music: 7 };
    expect(deserialize(JSON.stringify(legacy)).volumeRamps).toEqual(emptyVolumeRamps());
  });

  it('램프 길이 설정은 기본 5초이고 저장본에서 범위 밖 값은 되돌린다', () => {
    expect(createInitialState().settings.masterRampSec).toBe(DEFAULT_MASTER_RAMP_SEC);
    const legacy = JSON.parse(serialize(createInitialState()));
    delete legacy.settings.masterRampSec;
    expect(deserialize(JSON.stringify(legacy)).settings.masterRampSec).toBe(DEFAULT_MASTER_RAMP_SEC);
    legacy.settings.masterRampSec = 999;
    expect(deserialize(JSON.stringify(legacy)).settings.masterRampSec).toBe(MASTER_RAMP_SEC_RANGE.max);
  });
});

/**
 * 단일 마스터 → 두 축 승격 (U45).
 *
 * **`promoteLegacyDefaults()`에서 한 번만** 한다. migrate는 상태 방송마다 도는 경로라
 * 거기서 옮기면 사용자가 나중에 바꾼 축 값을 다음 방송이 옛 마스터 값으로 도로 덮는다.
 */
describe('마스터 볼륨 → 두 축 승격 (U45)', () => {
  const legacySave = (masterVolume: number, extra: Record<string, unknown> = {}): string => {
    const raw = JSON.parse(serialize(createInitialState()));
    raw.settings.masterVolume = masterVolume;
    delete raw.settings.mediaVolume;
    delete raw.settings.musicVolume;
    delete raw.settings.volumeAxesPromoted;
    Object.assign(raw.settings, extra);
    return JSON.stringify(raw);
  };

  it('옛 마스터 값이 두 축 초기값이 된다', () => {
    const promoted = promoteLegacyDefaults(deserialize(legacySave(0.4)));
    expect(promoted.settings.mediaVolume).toBeCloseTo(0.4, 6);
    expect(promoted.settings.musicVolume).toBeCloseTo(0.4, 6);
    expect(promoted.settings.volumeAxesPromoted).toBe(true);
  });

  it('승격은 한 번뿐 — 그 뒤 축을 따로 맞춰도 다시 덮지 않는다', () => {
    const once = promoteLegacyDefaults(deserialize(legacySave(0.4)));
    const tuned = reducer(once, { type: 'volume/set', axis: 'music', value: 0.15 });
    // 저장 → 재인수 왕복에도 사용자가 고른 값이 살아남는다
    const revived = promoteLegacyDefaults(deserialize(serialize(tuned)));
    expect(revived.settings.musicVolume).toBeCloseTo(0.15, 6);
    expect(revived.settings.mediaVolume).toBeCloseTo(0.4, 6);
  });

  it('마스터가 기본값(1)이면 옮길 것이 없고 플래그만 선다', () => {
    const promoted = promoteLegacyDefaults(deserialize(legacySave(1)));
    expect(promoted.settings.mediaVolume).toBe(1);
    expect(promoted.settings.volumeAxesPromoted).toBe(true);
  });

  it('migrate는 승격하지 않는다 — 방송마다 돌면 사용자의 선택을 매번 덮는다', () => {
    const revived = deserialize(legacySave(0.4));
    expect(revived.settings.mediaVolume).toBe(1);
    expect(revived.settings.musicVolume).toBe(1);
  });

  it('저장본의 축 값이 범위 밖이면 되돌린다', () => {
    const raw = JSON.parse(serialize(createInitialState()));
    raw.settings.mediaVolume = 9;
    raw.settings.musicVolume = 'loud';
    const revived = deserialize(JSON.stringify(raw));
    expect(revived.settings.mediaVolume).toBe(1);
    expect(revived.settings.musicVolume).toBe(1);
  });
});
