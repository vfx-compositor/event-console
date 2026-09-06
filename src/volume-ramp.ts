/**
 * 출력 볼륨 축과 램프 (U43 · U45).
 *
 * ## 왜 축이 둘인가 (U45)
 * 하나였던 마스터 볼륨으로는 현장에서 실제로 필요한 조작이 안 됐다 — MC가 말할 동안 **음악만**
 * 낮추고 싶은데 마스터를 내리면 설명 영상 소리까지 같이 죽는다. 그래서 소리를 내는 엘리먼트를
 * 두 축으로 나눈다:
 *  - `media` — 설명 영상 · 오버레이 · 중계 카메라
 *  - `music` — 행사 BGM 덱 2개
 * 축은 **엘리먼트 종류**로 정해진다. 씬이나 상황으로 나누면 같은 엘리먼트가 프레임마다 다른
 * 축에 속하게 되고, 그 경계에서 소리가 튄다. 자동 덕킹(U44)은 `music` 축에만 걸린다.
 *
 * ## 왜 저장값을 바로 덮지 않는가 (램프)
 * 볼륨은 persisted 설정이다. 램프를 "매 프레임 설정값을 조금씩 고치는" 식으로 만들면 5초 동안
 * 초당 수십 번 상태가 갈리고 그때마다 persist·방송·재렌더가 돈다 — 원장·리더 락 경로가 볼륨
 * 슬라이더 하나에 오염된다.
 *
 * 그래서 상태에는 축마다 **램프 서술자 하나**(`state.volumeRamps[axis]`)만 둔다. 저장값은
 * 램프가 끝난 뒤 리더가 한 번 확정한다(`volume/rampSettle`). 그 사이 실제로 들리는 값은
 * control·display가 각자 매 프레임 `effectiveVolume()`으로 계산한다 — 창이 몇 개든 같은
 * 서술자에서 같은 곡선이 나오므로 어긋날 자리가 없다.
 *
 * ## 램프는 migrate에서 살려 보낸다
 * display는 모든 상태 방송을 `deserialize() → migrate()`로 받는다. migrate가 램프를 리셋하면
 * display는 램프를 **한 번도 보지 못하고** 소리가 5초 뒤 뚝 바뀐다 (`sceneOpts.video.phase`와
 * 같은 함정). 모양만 검사해서 통과시킨다.
 *
 * 산수는 `fade-ramp.ts`를 그대로 쓴다 — 음악 페이드·검정 페이드와 같은 easeInOutQuad 곡선이고,
 * 지속시간이 이동 거리에 비례하므로 몇 번을 뒤집어도 초당 변화량이 같다.
 */

import { isRampDone, makeRamp, rampValueAt, type ValueRamp } from './fade-ramp';
import { clampOutputVolume } from './output-audio';
import type { Settings, VolumeAxis, VolumeRamps } from './types';

/** 상단 바에 그리는 고정 순서. 미디어가 먼저인 이유는 그쪽이 훨씬 자주 움직이기 때문이다. */
export const VOLUME_AXES: readonly VolumeAxis[] = ['media', 'music'];

export const VOLUME_AXIS_LABEL: Record<VolumeAxis, string> = {
  media: 'MEDIA',
  music: 'MUSIC',
};

export const VOLUME_AXIS_TIP: Record<VolumeAxis, string> = {
  media: '설명 영상·전환 오버레이·중계 카메라 오디오의 볼륨입니다. 행사 BGM은 옆 [MUSIC]이 따로 정합니다. 끌어서 바로 맞추거나 방향키로 1%씩 움직입니다.',
  music: '행사 BGM 덱의 볼륨입니다. 소리 있는 영상 큐에서 자동으로 내려가는 덕킹도 이 축에만 걸립니다. 영상·카메라 소리는 옆 [MEDIA]가 따로 정합니다.',
};

/** 램프 버튼이 쓰는 기본 길이(초). 0 → 1 전 구간 기준이라 →40%는 3초에 닿는다. */
export const DEFAULT_MASTER_RAMP_SEC = 5;

/**
 * "깔아 두기" 버튼이 내려가는 목표 (U74).
 *
 * 10%였다가 40%로 올렸다 — 사용자 지시("100 -> 10 가는 버튼 10 말고 한 40정도로 해줘").
 * 10%는 사실상 무음이라 MC 멘트 뒤에 음악이 **깔려 있다는 느낌 자체가 사라졌다.**
 * 깔아 두기는 끄는 것이 아니라 낮추는 것이므로 들리는 자리에 두어야 한다.
 *
 * 버튼 라벨은 이 값에서 만든다 — 숫자와 글자를 따로 두면 반드시 어긋난다.
 */
export const MASTER_RAMP_DUCK_TARGET = 0.4;

/** 설정에서 고를 수 있는 램프 길이. 0이면 컷(버튼이 즉시 값을 바꾸는 것과 같다). */
export const MASTER_RAMP_SEC_RANGE = { min: 0, max: 30 } as const;

export function emptyVolumeRamps(): VolumeRamps {
  return { media: null, music: null };
}

/** 이 축의 저장된 볼륨 (램프를 무시한 값) */
export function storedVolume(settings: Settings, axis: VolumeAxis): number {
  return clampOutputVolume(axis === 'music' ? settings.musicVolume : settings.mediaVolume);
}

export function withStoredVolume(settings: Settings, axis: VolumeAxis, value: number): Settings {
  const v = clampOutputVolume(value);
  return axis === 'music' ? { ...settings, musicVolume: v } : { ...settings, mediaVolume: v };
}

/**
 * 지금 실제로 들려야 하는 이 축의 볼륨.
 *
 * 램프가 없으면 저장값이 곧 현재값이다. 이 함수가 `el.volume` 계산의 유일한 입구여야
 * "누구는 램프를 보고 누구는 저장값을 본다"가 생기지 않는다.
 */
export function effectiveVolume(
  settings: Settings,
  ramps: VolumeRamps,
  axis: VolumeAxis,
  now: number,
): number {
  const ramp = ramps[axis];
  if (!ramp) return storedVolume(settings, axis);
  return clampOutputVolume(rampValueAt(ramp, now));
}

/** 이 축의 램프가 끝나 저장값으로 확정해도 되는가. 램프가 없으면 확정할 것도 없다. */
export function volumeRampSettled(ramp: ValueRamp | null, now: number): boolean {
  return ramp !== null && isRampDone(ramp, now);
}

/** 어느 축이든 램프가 돌고 있는가 (rAF·50ms 루프 무장 판정) */
export function anyVolumeRampActive(ramps: VolumeRamps): boolean {
  return VOLUME_AXES.some((axis) => ramps[axis] !== null);
}

/**
 * 목표값으로 램프를 건다. 시작값은 **언제나 지금 들리는 값**이다 —
 * 내려가는 중에 `→100%`를 눌러도 저장값(1)으로 점프했다가 다시 오르지 않는다.
 */
export function startVolumeRamp(
  settings: Settings,
  ramps: VolumeRamps,
  axis: VolumeAxis,
  target: number,
  sec: number,
  now: number,
): ValueRamp {
  return makeRamp(effectiveVolume(settings, ramps, axis, now), target, sec, now);
}

/**
 * 저장본·방송에서 받은 램프를 되살린다. 모양이 어긋나면 버린다 —
 * `from`이 문자열인 램프가 통과하면 `el.volume`에 NaN이 실려 소리가 통째로 죽는다.
 */
export function normalizeVolumeRamp(raw: unknown): ValueRamp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nums = ['from', 'to', 'startedAt', 'durationMs'] as const;
  for (const key of nums) {
    if (typeof r[key] !== 'number' || !Number.isFinite(r[key] as number)) return null;
  }
  return {
    from: clampOutputVolume(r.from as number),
    to: clampOutputVolume(r.to as number),
    startedAt: r.startedAt as number,
    durationMs: Math.max(0, r.durationMs as number),
  };
}

export function normalizeVolumeRamps(raw: unknown): VolumeRamps {
  if (!raw || typeof raw !== 'object') return emptyVolumeRamps();
  const r = raw as Record<string, unknown>;
  return { media: normalizeVolumeRamp(r.media), music: normalizeVolumeRamp(r.music) };
}
