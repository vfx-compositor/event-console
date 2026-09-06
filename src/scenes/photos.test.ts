/**
 * 현장 사진 씬 — 뷰 고정성(§11 L9)과 스팅어 겹침 정책(§11 M3).
 *
 * 재생 루프 자체(크로스페이드·objectURL LRU)는 DOM·IndexedDB가 필요해 여기서 다루지 않는다
 * (vitest 환경이 `environment: 'node'`). 브라우저 측정은 Playwright 검증표가 맡고,
 * **판단을 내리는 순수 함수만** 여기로 빼서 회귀를 고정한다 — `transition-video.test.ts`와 같은 방식이다.
 */

import { describe, expect, it } from 'vitest';
import { createInitialState, reducer, type Action } from '../state';
import { toHTML, toText } from '../vdom';
import { advancePhoto, photoQueue } from '../photos';
import {
  photoFilterClasses,
  photoLayerAttrs,
  photoPlaybackEnabled,
  photoTransitionPresentation,
  view,
} from './photos';
import type { AppState, PhotoMeta } from '../types';

const T0 = 1_700_000_000_000;

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

function withPhotos(count: number): AppState {
  return run(createInitialState(), {
    type: 'photos/add',
    items: Array.from({ length: count }, (_, i) => ({
      id: `IMG_${i}.jpg|2048|${T0 + i}`,
      name: `IMG_${i}.jpg`,
      takenAt: T0 + i,
      addedAt: T0 + i,
      w: 1920,
      h: 1440,
      bytes: 2048,
      hidden: false,
    })),
  });
}

describe('현장 사진 씬 뷰', () => {
  it('두 레이어가 꽂힐 슬롯과 브랜드 지면을 항상 렌더한다', () => {
    const html = toHTML(view(createInitialState()));
    expect(html).toContain('class="scene scene--photos"');
    expect(html).toContain('class="photo-brand"');
    expect(html).toContain('data-photo-slot=""');
  });

  it('사진 장수·숨김·설정이 달라져도 HTML이 한 글자도 바뀌지 않는다 (§11 L9)', () => {
    // renderInto는 HTML이 달라진 순간 stage를 통째로 교체한다 → 크로스페이드가 끊기고
    // .scene의 진입 애니메이션이 매번 재생된다. 그래서 "상태와 무관하게 동일"이 계약이다.
    const empty = toHTML(view(createInitialState()));
    const many = withPhotos(12);
    expect(toHTML(view(many))).toBe(empty);
    expect(
      toHTML(view(run(many, { type: 'photos/hidden', id: many.photos.items[0].id, hidden: true }))),
    ).toBe(empty);
    expect(
      toHTML(view(run(many, { type: 'photos/settings', patch: { intervalSec: 9, order: 'random' } }))),
    ).toBe(empty);
    expect(toHTML(view(run(many, { type: 'photos/clear' })))).toBe(empty);
  });

  it('사진 메타를 텍스트로도 속성으로도 내보내지 않는다 (§4-1 잠금 계약)', () => {
    const s = run(createInitialState(), {
      type: 'photos/add',
      items: [
        {
          id: '용의자_후보.jpg|10|1',
          name: '용의자_후보.jpg',
          takenAt: T0,
          addedAt: T0,
          w: 1920,
          h: 1080,
          bytes: 10,
          hidden: false,
        },
      ],
    });
    expect(toText(view(s)).trim()).toBe('');
    expect(toHTML(view(s))).not.toMatch(/용의자|2부|추리|도핑|수사/);
    // `alt`·`title`·`aria-label`은 뷰에 아예 없다 — 런타임 <img>도 alt='' 고정이다 (§11 H3)
    expect(toHTML(view(s))).not.toContain('alt=');
    expect(toHTML(view(s))).not.toContain('title=');
  });
});

describe('사진 필터와 대기 화면 배경 표시 정책', () => {
  it('세피아·비네팅·그레인은 서로 독립적으로 조합된다', () => {
    const base = createInitialState().photos.settings;
    expect(photoFilterClasses(base)).toEqual([]);
    expect(photoFilterClasses({ ...base, sepia: true })).toEqual(['is-sepia']);
    expect(photoFilterClasses({ ...base, vignette: true })).toEqual(['is-vignette']);
    expect(photoFilterClasses({ ...base, grain: true })).toEqual(['is-grain']);
    expect(
      photoFilterClasses({ ...base, sepia: true, vignette: true, grain: true }),
    ).toEqual(['is-sepia', 'is-vignette', 'is-grain']);
  });

  it('사진 씬은 항상 재생하고, 대기 화면은 배경 토글이 켜졌을 때만 재생한다', () => {
    const base = createInitialState().photos.settings;
    const on = { ...base, standbyBackdrop: true };
    expect(photoPlaybackEnabled('photos', base)).toBe(true);
    expect(photoPlaybackEnabled('standby', base)).toBe(false);
    expect(photoPlaybackEnabled('standby', on)).toBe(true);
    // 게임 대기는 종목별 고정 이미지 한 장 — 사진이 깔릴 자리가 없다 (U29)
    expect(photoPlaybackEnabled('game', on)).toBe(false);
    expect(photoPlaybackEnabled('score', on)).toBe(false);
    // 사전미션은 지정 이미지 한 장이라 사진 큐가 보일 자리가 없다 — 런타임을 돌리지 않는다
    expect(photoPlaybackEnabled('standby', on, { standbyMode: 'pre-mission' })).toBe(false);
    expect(photoPlaybackEnabled('game', on, { standbyMode: 'pre-mission' })).toBe(false);
    // 전체 사진 씬은 대기 모드와 무관하게 항상 돈다
    expect(photoPlaybackEnabled('photos', base, { standbyMode: 'pre-mission' })).toBe(true);
  });
});

describe('photoTransitionPresentation — 스팅어·설명 영상과 겹칠 때 (§11 M3)', () => {
  it('아무것도 덮고 있지 않으면 Ken Burns를 굴리고 시계도 흐른다', () => {
    expect(photoTransitionPresentation(false, 'idle')).toEqual({
      motion: true,
      willChange: true,
      hold: false,
    });
  });

  it('알파 스팅어가 떠 있는 동안에는 모션 정지 · will-change 해제 · advance 보류', () => {
    expect(photoTransitionPresentation(true, 'idle')).toEqual({
      motion: false,
      willChange: false,
      hold: true,
    });
  });

  it('설명 영상 3단계(covering·playing·revealing) 전부 같은 처리다', () => {
    for (const phase of ['covering', 'playing', 'revealing'] as const) {
      expect(photoTransitionPresentation(false, phase)).toEqual({
        motion: false,
        willChange: false,
        hold: true,
      });
    }
  });

  it('둘이 겹쳐도 판정이 뒤집히지 않는다', () => {
    expect(photoTransitionPresentation(true, 'playing').hold).toBe(true);
  });

  it('hold일 때 motion·willChange는 항상 함께 false다 (display의 조건 분기가 죽은 코드인 근거)', () => {
    // display.ts의 `if (!pres.motion || !pres.willChange) freeze()`는 hold 아래에서 항상 참이었다.
    // 세 값이 같은 `covered` 하나에서 나오는 한 이 성질은 유지되어야 한다 (§11 L2).
    for (const active of [false, true]) {
      for (const phase of ['idle', 'covering', 'playing', 'revealing'] as const) {
        const p = photoTransitionPresentation(active, phase);
        expect(p.motion).toBe(!p.hold);
        expect(p.willChange).toBe(!p.hold);
      }
    }
  });
});

describe('사진 레이어 <img> 속성 (§11 H3 · M2)', () => {
  const attrs = photoLayerAttrs();

  it('alt=\'\' 외에 title·aria-*·data-*를 붙이지 않는다', () => {
    expect(attrs.alt).toBe('');
    expect(Object.keys(attrs).sort()).toEqual(['alt', 'class', 'decoding', 'draggable']);
    for (const key of Object.keys(attrs)) {
      expect(key).not.toBe('title');
      expect(key.startsWith('aria-')).toBe(false);
      expect(key.startsWith('data-')).toBe(false);
    }
  });

  it('값이 전부 고정 리터럴이다 — 파일명이 들어갈 자리가 없다', () => {
    for (const value of Object.values(attrs)) {
      expect(typeof value).toBe('string');
      // 확장자·경로·한글(파일명에서 오는 것들)이 값에 섞이면 그 자리로 메타가 샌다
      expect(value).not.toMatch(/\.(jpg|jpeg|png|webp|heic|heif)\b/i);
      expect(value).not.toMatch(/[/\\]/);
      expect(value).not.toMatch(/[가-힣]/);
    }
    // 호출할 때마다 새 객체다 — 호출부가 만지작거려도 다음 레이어가 오염되지 않는다
    expect(photoLayerAttrs()).not.toBe(attrs);
    expect(photoLayerAttrs()).toEqual(attrs);
  });
});

/**
 * 무작위 재생 순서의 **바퀴 경계** (§11 H1).
 *
 * display.ts `advanceToNextPhoto`가 쓰는 규칙을 그대로 옮긴 시뮬레이터다. 바퀴가 넘어가면
 * seed(=cycle)가 바뀌어 큐가 다시 섞이는데, 예전에는 "직전 큐의 첫 장"을 새 큐에서 이어받아
 * 그 사진의 **뒤쪽만** 재생됐다(두 바퀴째부터 앞부분이 통째로 사라진다).
 * 고친 규칙은 새 큐를 만든 즉시 `[0]`부터 다시 시작한다.
 */
function playLaps(items: readonly PhotoMeta[], laps: number): string[][] {
  let seed = 0;
  let cycle = 0;
  let current: string | null = null;
  let queue = photoQueue(items, 'random', seed, true);
  let prev: readonly string[] = [];
  const out: string[][] = [[]];
  const total = laps * queue.length;
  for (let i = 0; i < total; i++) {
    const next = advancePhoto(queue, current, cycle, prev);
    prev = queue;
    if (!next.id) break;
    let id = next.id;
    if (next.cycle !== cycle) {
      cycle = next.cycle;
      seed = next.cycle;
      queue = photoQueue(items, 'random', seed, true); // display: photoQueueCache = null 후 재생성
      if (!queue.length) break;
      id = queue[0];
      prev = queue;
      out.push([]);
    }
    current = id;
    out[out.length - 1].push(id);
  }
  return out;
}

describe('무작위 재생 — 바퀴마다 전부 나온다 (§11 H1)', () => {
  it('5장 두 바퀴에서 매 바퀴 5장이 빠짐없이 재생된다', () => {
    const items = withPhotos(5).photos.items;
    const all = items.map((p) => p.id).sort();
    const laps = playLaps(items, 2);
    expect(laps).toHaveLength(2);
    for (const lap of laps) {
      expect(lap).toHaveLength(5);
      expect([...lap].sort()).toEqual(all);
      expect(new Set(lap).size).toBe(5); // 같은 사진이 한 바퀴에 두 번 나오지 않는다
    }
  });

  it('바퀴가 넘어가면 실제로 다시 섞인다 (같은 순서를 반복하지 않는다)', () => {
    const laps = playLaps(withPhotos(12).photos.items, 3);
    expect(laps).toHaveLength(3);
    for (const lap of laps) expect(lap).toHaveLength(12);
    expect(laps[1]).not.toEqual(laps[0]);
    expect(laps[2]).not.toEqual(laps[1]);
  });

  it('한 장뿐이면 바퀴마다 그 한 장이 계속 나온다 (경계에서 멈추지 않는다)', () => {
    const laps = playLaps(withPhotos(1).photos.items, 3);
    expect(laps.flat()).toHaveLength(3);
  });
});
