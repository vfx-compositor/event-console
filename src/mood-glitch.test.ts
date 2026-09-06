// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BLACK_AT_GLITCH_END,
  BLACK_OVERLAP_START,
  coverSourceRect,
  glitchFrame,
  glitchIntensityAt,
  isGlitchComplete,
  moodBlackAt,
  moodGlitchMs,
  moodTotalMs,
  sortCoverageAt,
  sortThresholdAt,
} from './mood-glitch';
import { moodVisualState } from './mood-visual';
import { createInitialState, deserialize, reducer, resetRuntimeVideoPhase, serialize } from './state';

/** 결정적 난수 — 같은 시퀀스를 반복해 프레임 명세를 재현한다 */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('디스토션 세기 곡선 — 스멀스멀 (U26b)', () => {
  const D = 10_000;
  const at = (ms: number, strength = 1) => glitchIntensityAt(ms, D, strength);

  it('첫 프레임은 정확히 0이다 — 라이브와 픽셀 단위로 같아야 한다', () => {
    expect(at(0)).toBe(0);
  });

  it('앞 40%는 사실상 감지되지 않는다', () => {
    expect(at(D * 0.2)).toBeLessThan(0.01);
    expect(at(D * 0.4)).toBeLessThan(0.05);
  });

  it('중반부터 가속해 마지막 20%에서 붕괴한다', () => {
    expect(at(D * 0.6)).toBeGreaterThan(at(D * 0.4) * 3);
    expect(at(D * 0.8)).toBeGreaterThan(0.4);
    expect(at(D * 0.8)).toBeLessThan(0.6);
    expect(at(D)).toBeCloseTo(1, 9);
    // 마지막 20% 구간이 전체 상승폭의 절반 이상을 차지한다
    expect(at(D) - at(D * 0.8)).toBeGreaterThan(0.5);
  });

  it('단조 증가한다', () => {
    let prev = -1;
    for (let ms = 0; ms <= D; ms += 250) {
      const v = at(ms);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('세기 0이면 어느 시점에도 0이다 (디스토션 끄기)', () => {
    for (const t of [0, 500, 5000, 99_999]) expect(at(t, 0)).toBe(0);
  });

  it('설정 세기가 상한이다', () => {
    expect(at(D, 0.4)).toBeCloseTo(0.4, 9);
    expect(at(99_999, 0.4)).toBeCloseTo(0.4, 9);
  });

  it('길이가 0이면 곧바로 완료로 본다', () => {
    expect(isGlitchComplete(0, 0)).toBe(true);
    expect(isGlitchComplete(9999, D)).toBe(false);
    expect(isGlitchComplete(D, D)).toBe(true);
  });
});

describe('픽셀 정렬 마스크 (U26b)', () => {
  it('세기 0이면 정렬 대상이 없다 — 첫 프레임이 원본 그대로다', () => {
    expect(sortCoverageAt(0)).toBe(0);
    expect(sortThresholdAt(0)).toBe(240);
  });

  it('세기가 오르면 임계가 내려가고 범위가 넓어진다 (녹아내림이 번진다)', () => {
    const thresholds = [0, 0.25, 0.5, 0.75, 1].map(sortThresholdAt);
    const coverages = [0, 0.25, 0.5, 0.75, 1].map(sortCoverageAt);
    for (let i = 1; i < thresholds.length; i += 1) {
      expect(thresholds[i]).toBeLessThan(thresholds[i - 1]);
      expect(coverages[i]).toBeGreaterThan(coverages[i - 1]);
    }
    expect(sortThresholdAt(1)).toBe(15);
    expect(sortCoverageAt(1)).toBe(1);
  });

  it('범위는 세기보다 빨리 오른다 — 약한 세기에서도 여기저기 번진다', () => {
    expect(sortCoverageAt(0.25)).toBeGreaterThan(0.25);
  });
});

describe('라이브 화면 크롭 일치 (U26b)', () => {
  it('4:3 카메라는 위아래를 잘라 16:9를 채운다', () => {
    expect(coverSourceRect(640, 480, 1920, 1080)).toEqual({ sx: 0, sy: 60, sw: 640, sh: 360 });
  });

  it('16:10 카메라도 위아래만 잘린다', () => {
    const r = coverSourceRect(1920, 1200, 1920, 1080);
    expect(r.sw).toBe(1920);
    expect(r.sh).toBe(1080);
    expect(r.sx).toBe(0);
    expect(r.sy).toBe(60);
  });

  it('16:9 카메라는 잘리지 않는다', () => {
    expect(coverSourceRect(1280, 720, 1920, 1080)).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });

  it('세로로 긴 소스는 폭을 다 쓰고 위아래를 크게 잘라 낸다', () => {
    const r = coverSourceRect(1080, 1920, 1920, 1080);
    expect(r.sw).toBe(1080);
    expect(r.sh).toBeCloseTo(607.5, 6);
    expect(r.sx).toBe(0);
    expect(r.sy).toBeCloseTo((1920 - 607.5) / 2, 6);
  });

  it('잘라낸 사각형의 비율은 언제나 목표와 같다', () => {
    for (const [w, h] of [[640, 480], [1920, 1200], [1280, 720], [1080, 1920], [800, 600]] as const) {
      const r = coverSourceRect(w, h, 1920, 1080);
      expect(r.sw / r.sh).toBeCloseTo(1920 / 1080, 6);
      expect(r.sx).toBeGreaterThanOrEqual(0);
      expect(r.sy).toBeGreaterThanOrEqual(0);
      expect(r.sx + r.sw).toBeLessThanOrEqual(w + 1e-6);
      expect(r.sy + r.sh).toBeLessThanOrEqual(h + 1e-6);
    }
  });

  it('크기를 아직 모르면(메타데이터 전) 안전한 값을 준다', () => {
    expect(coverSourceRect(0, 0, 1920, 1080)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 });
  });
});

describe('암전 겹침 (U26b)', () => {
  const G = 10_000;
  const B = 2500;
  const at = (phase: 'idle' | 'glitch' | 'blackout' | 'crossfade', ms: number) =>
    moodBlackAt({ phase, phaseElapsedMs: ms, glitchMs: G, blackoutMs: B });

  it('디스토션 앞 구간에는 검정이 없다', () => {
    expect(at('glitch', 0)).toBe(0);
    expect(at('glitch', G * BLACK_OVERLAP_START)).toBe(0);
  });

  it('디스토션 마지막 구간에서 검정이 겹쳐 올라온다', () => {
    const mid = at('glitch', G * (BLACK_OVERLAP_START + (1 - BLACK_OVERLAP_START) / 2));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(BLACK_AT_GLITCH_END);
    expect(at('glitch', G)).toBeCloseTo(BLACK_AT_GLITCH_END, 9);
  });

  it('단계가 바뀌는 지점에서 값이 이어진다 (튀지 않는다)', () => {
    expect(at('blackout', 0)).toBeCloseTo(at('glitch', G), 9);
  });

  it('암전 단계가 나머지를 채우고 영상 위에서는 1을 유지한다', () => {
    expect(at('blackout', B)).toBeCloseTo(1, 9);
    expect(at('crossfade', 0)).toBe(1);
    expect(at('idle', 0)).toBe(0);
  });

  it('전 구간 단조 증가한다', () => {
    const samples: number[] = [];
    for (let ms = 0; ms <= G; ms += 200) samples.push(at('glitch', ms));
    for (let ms = 0; ms <= B; ms += 100) samples.push(at('blackout', ms));
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-9);
    }
  });

  it('암전 길이 0이면 그 단계에서 곧바로 완전한 검정이다', () => {
    expect(moodBlackAt({ phase: 'blackout', phaseElapsedMs: 0, glitchMs: G, blackoutMs: 0 })).toBe(1);
  });
});

describe('글리치 프레임 명세', () => {
  const frame = (over: Partial<Parameters<typeof glitchFrame>[0]> = {}) =>
    glitchFrame({
      elapsedMs: 9800,
      durationMs: 10_000,
      strength: 0.8,
      width: 480,
      height: 270,
      rand: seeded(7),
      ...over,
    });

  it('실제로 망가뜨릴 것을 내놓는다 — 빈 프레임이 아니다', () => {
    const f = frame();
    expect(f.slices.length).toBeGreaterThan(0);
    expect(f.rgbSplitPx).toBeGreaterThan(0);
    expect(f.blocks.length).toBeGreaterThan(0);
    expect(f.scanlineAlpha).toBeGreaterThan(0);
  });

  it('슬라이스는 캔버스 안에 있고 겹치지 않는다', () => {
    const f = frame();
    let prevBottom = 0;
    for (const slice of f.slices) {
      expect(slice.y).toBeGreaterThanOrEqual(prevBottom - 1);
      expect(slice.y + slice.h).toBeLessThanOrEqual(270);
      expect(slice.h).toBeGreaterThan(0);
      expect(Math.abs(slice.dx)).toBeLessThanOrEqual(18);
      prevBottom = slice.y + slice.h;
    }
  });

  it('블록·드롭아웃도 캔버스 안에 머문다', () => {
    const f = frame();
    for (const b of f.blocks) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(480);
      expect(b.y + b.h).toBeLessThanOrEqual(270);
    }
    for (const d of f.dropouts) {
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y + d.h).toBeLessThanOrEqual(270);
    }
  });

  it('세기 0이면 아무것도 그리지 않는다', () => {
    const f = frame({ strength: 0 });
    expect(f.slices).toEqual([]);
    expect(f.blocks).toEqual([]);
    expect(f.dropouts).toEqual([]);
    expect(f.rgbSplitPx).toBe(0);
    expect(f.brightness).toBe(1);
  });

  it('초반보다 후반이 더 많이 망가진다', () => {
    const early = glitchFrame({
      elapsedMs: 5000, durationMs: 10_000, strength: 1, width: 480, height: 270, rand: seeded(3),
    });
    const late = glitchFrame({
      elapsedMs: 9800, durationMs: 10_000, strength: 1, width: 480, height: 270, rand: seeded(3),
    });
    expect(late.intensity).toBeGreaterThan(early.intensity);
    expect(late.rgbSplitPx).toBeGreaterThan(early.rgbSplitPx);
    expect(late.blocks.length).toBeGreaterThan(early.blocks.length);
  });

  it('같은 난수 시퀀스는 같은 프레임을 낸다 (재현 가능)', () => {
    expect(frame({ rand: seeded(11) })).toEqual(frame({ rand: seeded(11) }));
  });
});

describe('분위기 반전 단계 (U26)', () => {
  it('검정 단계가 글리치와 크로스페이드 사이에 있다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'mood/start', assetId: 'media:260831_pt1_v001.mp4' });
    expect(s.sceneOpts.moodTransition.phase).toBe('glitch');
    const token = s.sceneOpts.moodTransition.token;

    s = reducer(s, { type: 'mood/blackout', token });
    expect(s.sceneOpts.moodTransition.phase).toBe('blackout');

    s = reducer(s, { type: 'mood/crossfade', token });
    expect(s.sceneOpts.moodTransition.phase).toBe('crossfade');
  });

  it('검정을 건너뛴 크로스페이드는 무시한다 — 영상이 글리치 위에서 시작하면 안 된다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'mood/start', assetId: 'a' });
    const token = s.sceneOpts.moodTransition.token;
    expect(reducer(s, { type: 'mood/crossfade', token })).toBe(s);
  });

  it('stale 토큰의 단계 전이는 버린다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'mood/start', assetId: 'a' });
    const token = s.sceneOpts.moodTransition.token;
    expect(reducer(s, { type: 'mood/blackout', token: token + 1 })).toBe(s);
    s = reducer(s, { type: 'mood/blackout', token });
    expect(reducer(s, { type: 'mood/blackout', token })).toBe(s);
  });

  it('중단은 어느 단계에서든 레이어를 닫는다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'mood/start', assetId: 'a' });
    const token = s.sceneOpts.moodTransition.token;
    s = reducer(s, { type: 'mood/blackout', token });
    s = reducer(s, { type: 'mood/abort', token });
    expect(s.sceneOpts.moodTransition).toMatchObject({ active: false, phase: 'idle', assetId: null });
  });

  it('출력 레이어 상태 — 검정이 다 덮일 때까지 캔버스 유지 (U53)', () => {
    // D8: 소리는 t0부터 열려 있다 (검정 구간에는 오디오만 깔린다)
    expect(moodVisualState(true, 'glitch')).toMatchObject({
      hidden: false, glitchCanvas: true, blackTarget: 0, videoAudio: true, crossfadeVisual: false,
    });
    // U53: 암전 단계에서도 캔버스가 살아 있어야 디스토션이 끊기지 않는다
    expect(moodVisualState(true, 'blackout')).toMatchObject({
      hidden: false, glitchCanvas: true, blackTarget: 1, videoAudio: true, crossfadeVisual: false,
    });
    // crossfade에서도 검정을 유지한다 — 영상 아래라 가려지고, 내리면 이전 씬이 비친다
    expect(moodVisualState(true, 'crossfade')).toMatchObject({
      hidden: false, glitchCanvas: false, blackTarget: 1, videoAudio: true,
    });
    expect(moodVisualState(false, 'idle')).toMatchObject({
      hidden: true, glitchCanvas: false, blackTarget: 0,
    });
  });
});

/**
 * **이번 사고의 재발 방지 테스트.**
 *
 * `display.ts`가 `#mood-transition`과 `.mood-transition__noise`를 만들어 붙였는데 대응 CSS가
 * 한 줄도 없었다. position static · 0×0 · 화면 밖이라 글리치가 아무것도 보이지 않았고,
 * 타입 검사도 테스트도 전부 통과했다. JS가 만드는 선택자는 스타일시트에 규칙이 있어야 한다.
 */
describe('display가 만드는 선택자는 CSS에 규칙이 있다', () => {
  const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');

  it('id를 붙인 엘리먼트는 모두 스타일 규칙을 갖는다', () => {
    const ids = [...new Set([...display.matchAll(/\.id = '([\w-]+)'/g)].map((m) => m[1]))];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !css.includes(`#${id}`))).toEqual([]);
  });

  it('className·class 속성으로 붙인 클래스도 모두 스타일 규칙을 갖는다', () => {
    const fromProp = [...display.matchAll(/\.className = '([\w -]+)'/g)].map((m) => m[1]);
    const fromHtml = [...display.matchAll(/class="([\w -]+)"/g)].map((m) => m[1]);
    const names = [...new Set([...fromProp, ...fromHtml].flatMap((v) => v.split(/\s+/)).filter(Boolean))];
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !css.includes(`.${name}`))).toEqual([]);
  });

  it('글리치 캔버스는 스테이지와 같은 사각형을 차지한다 (화면비 어긋남 방지)', () => {
    const block = css.match(/\.mood-transition__glitch\s*\{([^}]*)\}/)?.[1] ?? '';
    // `#transition-video`와 같은 기하 — 뷰포트를 덮으면 창 비율이 16:9가 아닐 때 튄다
    expect(block).toMatch(/width:\s*1920px/);
    expect(block).toMatch(/height:\s*1080px/);
    expect(block).toMatch(/scale\(var\(--scale, 1\)\)/);
    expect(block).not.toMatch(/inset:\s*0/);
  });

  it('캔버스 드로우가 라이브의 cover 크롭과 반전을 그대로 재현한다', () => {
    expect(display).toContain(
      'coverSourceRect(camEl.videoWidth, camEl.videoHeight, MOOD_GLITCH_W, MOOD_GLITCH_H)',
    );
    expect(display).toContain('const { flipX, flipY } = state.settings.camera;');
    expect(display).toContain('ctx.drawImage(camEl, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0,');
    // 통째로 늘려 그리던 옛 배선이 되살아나면 화면비가 다시 어긋난다
    expect(display).not.toMatch(/drawImage\(camEl, 0, 0, w, h\)/);
  });

  it('픽셀 소트가 보조 글리치보다 먼저 적용된다 (주효과)', () => {
    expect(display).toContain('applyPixelSort(ctx, intensity, now)');
    expect(display).toMatch(/drawLiveFrame\(ctx\);[\s\S]{0,200}applyPixelSort\(/);
    expect(display).toContain("mode === 'glitch-only' || intensity <= 0");
  });

  it('오버레이 자동재생 차단은 플래그로 기억한다 (다음 프레임에 덮이지 않게)', () => {
    expect(display).toContain('let overlayAudioBlocked = false;');
    // D8 — 음소거 판정은 단계가 아니라 **소유권**이다. 매치 오버레이(무음)와 반전 영상의
    // 구분을 파일로 하면 소리 있는 오버레이가 들어오는 날 조용히 음소거된다.
    // U75 — 오버레이 소유권은 시각 경로라 동결 스냅샷을 읽는다
    expect(display).toContain('moodOwnsOverlay(vis.sceneOpts.moodTransition');
    expect(display).toContain('overlayAudioBlocked = true;');
    // 새 재생과 사용자 클릭 해제에서 플래그가 풀린다
    // U72(모니터)·U88(창 모드) 음소거가 한 겹 감쌌고, U101이 꼬리 램프 축을 한 겹 더 얹었다 —
    // 판정의 정본은 이제 `overlayMuted()` 하나이며 `applyOverlayMute()`가 유일한 호출부다.
    expect(display).toMatch(
      /overlayAudioBlocked = false;\n\s*const moodOwned = moodOwnsOverlay\([\s\S]{0,1200}?applyOverlayMute\(\);/,
    );
    // 판정은 `overlayMuted()` 하나뿐이고, 그 안에서 이 플래그가 최우선으로 읽힌다
    expect(display).toContain('policyBlocked: overlayAudioBlocked,');
    expect(display).toMatch(/cameraAudioBlocked = false;\s*\n\s*overlayAudioBlocked = false;/);
  });

  it('슬라이스 밀림은 캔버스 자기복사 대신 scratch 한 장에서 읽는다', () => {
    expect(display).toContain('const shelf = moodGlitchScratch();');
    expect(display).toContain('ctx.drawImage(shelf, 0, slice.y, w, slice.h, slice.dx, slice.y, w, slice.h)');
    expect(display).not.toContain('ctx.drawImage(canvas, 0, slice.y,');
  });

  it('글리치 캔버스는 되읽기용으로 컨텍스트를 잡는다 (매 프레임 getImageData)', () => {
    expect(display).toContain('willReadFrequently: true');
  });

  it('내부 해상도는 960×540 — 4배 업스케일의 bilinear 뭉갬을 피한다', () => {
    expect(display).toContain('const MOOD_GLITCH_W = 960;');
    expect(display).toContain('const MOOD_GLITCH_H = 540;');
    // 강제 pixelated는 쓰지 않는다 (카메라 원본까지 각져 보인다)
    const block = css.match(/\.mood-transition__glitch\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).not.toMatch(/image-rendering/);
  });

  it('글리치가 끝나면 임시 캔버스도 함께 놓는다', () => {
    expect(display).toMatch(/moodGlitchCtx = null;[\s\S]{0,600}moodGlitchScratchPool\.length = 0;/);
  });

  it('암전은 매 프레임 곡선으로 심는다 — CSS transition과 곡선이 갈라지지 않게', () => {
    expect(display).toContain('moodBlackEl.style.opacity = String(');
    expect(display).toContain('moodBlackAt({');
    expect(display).not.toContain('moodBlackEl.style.transitionDuration');
    const black = css.match(/\.mood-transition__black\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(black).not.toMatch(/transition-property/);
  });

  it('분위기 반전 레이어는 화면을 실제로 덮는다 (position·inset·z-index)', () => {
    const block = css.match(/#mood-transition\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).toMatch(/position:\s*absolute/);
    expect(block).toMatch(/inset:\s*0/);
    // 씬 스윕(#fx 40) 위, 오버레이 영상(#overlay-video 43) 아래여야 한다
    const z = Number(/z-index:\s*(\d+)/.exec(block)?.[1]);
    expect(z).toBeGreaterThan(40);
    expect(z).toBeLessThan(43);
  });
});

describe('저장본 인수·정규화 (U26 리뷰)', () => {
  const started = (phase: 'glitch' | 'blackout' | 'crossfade') => {
    let s = reducer(createInitialState(), { type: 'mood/start', assetId: 'a' });
    const token = s.sceneOpts.moodTransition.token;
    if (phase !== 'glitch') s = reducer(s, { type: 'mood/blackout', token });
    if (phase === 'crossfade') s = reducer(s, { type: 'mood/crossfade', token });
    return s;
  };

  /**
   * crossfade 단계는 control이 타이머를 걸지 않는다(끝은 영상 `ended`가 낸다). 그 저장본을
   * 인수하면 아무도 끝내지 않아 검정 100%가 화면에 고착된다.
   */
  it('부팅·리더 인수는 어느 단계에서도 분위기 반전을 끊는다', () => {
    for (const phase of ['glitch', 'blackout', 'crossfade'] as const) {
      const reset = resetRuntimeVideoPhase(started(phase));
      expect([phase, reset.sceneOpts.moodTransition.active]).toEqual([phase, false]);
      expect(reset.sceneOpts.moodTransition.phase).toBe('idle');
      expect(reset.sceneOpts.moodTransition.assetId).toBeNull();
    }
  });

  it('인수하며 token을 올려 인플라이트 이벤트를 무효화한다 (L7)', () => {
    const live = started('glitch');
    const token = live.sceneOpts.moodTransition.token;
    const reset = resetRuntimeVideoPhase(live);
    expect(reset.sceneOpts.moodTransition.token).toBe(token + 1);
    // 인수 직전에 떠난 이벤트가 뒤늦게 도착해도 끝난 반전을 되살리지 못한다
    expect(reducer(reset, { type: 'mood/blackout', token })).toBe(reset);
    expect(reducer(reset, { type: 'mood/crossfade', token })).toBe(reset);
  });

  it('끊을 것이 없으면 같은 상태를 그대로 돌려준다 (불필요한 방송 방지)', () => {
    const clean = createInitialState();
    expect(resetRuntimeVideoPhase(clean)).toBe(clean);
  });

  it('알 수 없는 단계 값은 idle로 접는다', () => {
    const raw = JSON.parse(serialize(started('glitch'))) as {
      sceneOpts: { moodTransition: Record<string, unknown> };
    };
    raw.sceneOpts.moodTransition.phase = 'kaleidoscope';
    const migrated = deserialize(JSON.stringify(raw));
    expect(migrated.sceneOpts.moodTransition.phase).toBe('idle');
    expect(migrated.sceneOpts.moodTransition.active).toBe(false);
  });

  it('정상 단계 값은 migrate가 건드리지 않는다 — display는 방송을 migrate로 받는다', () => {
    for (const phase of ['glitch', 'blackout', 'crossfade'] as const) {
      const round = deserialize(serialize(started(phase)));
      expect(round.sceneOpts.moodTransition.phase).toBe(phase);
      expect(round.sceneOpts.moodTransition.active).toBe(true);
    }
  });

  /** token이 NaN이면 모든 단계 전이가 토큰 비교에서 거부되어 글리치에 영원히 갇힌다 */
  it('망가진 token은 유한 정수로 되돌려 단계 전이가 다시 통한다', () => {
    const raw = JSON.parse(serialize(started('glitch'))) as {
      sceneOpts: { moodTransition: Record<string, unknown> };
    };
    raw.sceneOpts.moodTransition.token = Number.NaN;
    const migrated = deserialize(JSON.stringify(raw));
    expect(migrated.sceneOpts.moodTransition.token).toBe(0);

    const advanced = reducer(migrated, {
      type: 'mood/blackout',
      token: migrated.sceneOpts.moodTransition.token,
    });
    expect(advanced.sceneOpts.moodTransition.phase).toBe('blackout');
  });

  it('소수점 token은 잘라 낸다', () => {
    const raw = JSON.parse(serialize(started('glitch'))) as {
      sceneOpts: { moodTransition: Record<string, unknown> };
    };
    raw.sceneOpts.moodTransition.token = 7.9;
    expect(deserialize(JSON.stringify(raw)).sceneOpts.moodTransition.token).toBe(7);
  });
});

/**
 * U53 — "누르는 순간 분위기반전 영상이 백그라운드에서 재생. 딱 15초간 전환되면 됨.
 * 15초 뒤부터는 영상만 보이도록. 영상 초반 15초는 블랙으로 해놨어."
 * 보강: "글리치가 가다가 마는 느낌. 계속 심해지다가 블랙으로 자연스럽게 빠져야 함."
 */
describe('분위기 반전 15초 전환 (U53)', () => {
  const settings = { moodTotalSec: 15, moodBlackoutSec: 2.5 };

  it('전체 길이가 정본이고 글리치는 파생값이다', () => {
    expect(moodTotalMs(settings)).toBe(15000);
    expect(moodGlitchMs(settings)).toBe(12500);
    // 두 값의 합은 언제나 전체다 — 따로 저장하면 15초가 깨진다
    expect(moodGlitchMs(settings) + settings.moodBlackoutSec * 1000).toBe(moodTotalMs(settings));
  });

  it('암전이 전체보다 길어도 글리치가 음수가 되지 않는다', () => {
    expect(moodGlitchMs({ moodTotalSec: 5, moodBlackoutSec: 9 })).toBe(0);
    expect(moodTotalMs({ moodTotalSec: -3 })).toBe(0);
  });

  it('세기는 전환 끝(15초)에서 최대다 — 중간에 멈추지 않는다', () => {
    const at = (ms: number) => glitchIntensityAt(ms, moodTotalMs(settings), 1);
    const samples = [0, 3000, 6000, 9000, 12500, 14000, 15000].map(at);
    // 단조 증가
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
    // 글리치 단계가 끝나는 12.5초 이후에도 계속 오른다 (예전에는 여기서 최대에 닿고 멈췄다)
    expect(at(15000)).toBeGreaterThan(at(12500));
    expect(at(15000)).toBeGreaterThan(0.9);
  });

  it('검정은 전환 끝에서 1에 닿는다', () => {
    expect(
      moodBlackAt({
        phase: 'blackout',
        phaseElapsedMs: settings.moodBlackoutSec * 1000,
        glitchMs: moodGlitchMs(settings),
        blackoutMs: settings.moodBlackoutSec * 1000,
      }),
    ).toBe(1);
    // 글리치 단계 끝에서는 아직 절반쯤이다 — 검정이 디스토션과 겹쳐 오른다
    const atGlitchEnd = moodBlackAt({
      phase: 'glitch',
      phaseElapsedMs: moodGlitchMs(settings),
      glitchMs: moodGlitchMs(settings),
      blackoutMs: settings.moodBlackoutSec * 1000,
    });
    expect(atGlitchEnd).toBeGreaterThan(0);
    expect(atGlitchEnd).toBeLessThan(1);
  });
});

describe('분위기 반전 상태 머신 (U53)', () => {
  const ASSET = 'media:260831_pt1_v001.mp4';

  it('시작하는 순간 영상이 돌기 시작한다', () => {
    const s = reducer(createInitialState(), { type: 'mood/start', assetId: ASSET });
    expect(s.sceneOpts.moodTransition).toMatchObject({ active: true, phase: 'glitch', assetId: ASSET });
    expect(s.sceneOpts.overlayVideo).toMatchObject({
      active: true,
      assetId: ASSET,
      holdEndFrame: false,
    });
  });

  it('영상이 없으면 오버레이를 건드리지 않는다', () => {
    const s = reducer(createInitialState(), { type: 'mood/start', assetId: null });
    expect(s.sceneOpts.moodTransition.active).toBe(true);
    expect(s.sceneOpts.overlayVideo.active).toBe(false);
  });

  it('단계를 넘어가도 같은 재생이 이어진다 — 다시 로드하지 않는다', () => {
    let s = reducer(createInitialState(), { type: 'mood/start', assetId: ASSET });
    const token = s.sceneOpts.moodTransition.token;
    const restart = s.sceneOpts.overlayVideo.restartToken;
    s = reducer(s, { type: 'mood/blackout', token });
    s = reducer(s, { type: 'mood/crossfade', token });
    expect(s.sceneOpts.moodTransition.phase).toBe('crossfade');
    // restartToken이 바뀌면 display가 src를 다시 붙여 처음부터 재생된다
    expect(s.sceneOpts.overlayVideo.restartToken).toBe(restart);
    expect(s.sceneOpts.overlayVideo.assetId).toBe(ASSET);
  });

  it('중단하면 돌던 영상도 함께 정리된다', () => {
    let s = reducer(createInitialState(), { type: 'mood/start', assetId: ASSET });
    const token = s.sceneOpts.moodTransition.token;
    s = reducer(s, { type: 'mood/abort', token });
    expect(s.sceneOpts.moodTransition.active).toBe(false);
    expect(s.sceneOpts.overlayVideo.active).toBe(false);
  });

  it('control은 crossfade에서 overlay/play를 다시 내지 않는다', () => {
    const control = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');
    const armed = control.slice(control.indexOf('function syncMoodTransitionTimer'));
    const body = armed.slice(0, armed.indexOf('\n}\n'));
    expect(body).toContain("dispatch({ type: 'mood/crossfade', token: current.token })");
    expect(body).not.toContain("type: 'overlay/play'");
    // 단계 길이는 전체에서 파생된다
    expect(control).toContain('moodGlitchMs(state.settings)');
  });
});

describe('분위기 반전 z-order (U53)', () => {
  const css = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');
  /**
   * 이 셀렉터가 실제로 갖는 z-index. 같은 셀렉터가 그룹 규칙과 단독 규칙 양쪽에 나오므로
   * (`#transition-video, #overlay-video { z:45 }` 다음에 `#overlay-video { z:43 }`)
   * **마지막에 나온 값**을 읽는다 — 특정도가 같으면 순서가 이기는 실제 캐스케이드와 같다.
   */
  const z = (selector: string): number => {
    const escaped = selector.replace(/[.#]/g, '\\$&');
    const bodies = [...css.matchAll(new RegExp('\\n' + escaped + '\\s*\\{([^}]*)\\}', 'g'))]
      .map((m) => m[1])
      .filter((body) => /z-index:/.test(body));
    const last = bodies[bodies.length - 1] ?? '';
    return Number.parseInt(last.match(/z-index:\s*(-?\d+)/)?.[1] ?? 'NaN', 10);
  };

  /**
   * U77 — 영상은 이제 전환 내내 글리치 **위**(43)에 머문다. 검정 배경이 글리치를 가리는
   * 문제는 층이 아니라 `screen` 합성으로 푼다(`mood-visual.ts`). 층을 내리던 U53 방식은
   * 검정 위에 얹힌 도입부 자막까지 함께 묻었다.
   */
  it('영상이 글리치 위에 있고, 위쪽 스택은 그대로다', () => {
    const mood = z('#mood-transition');
    const overlay = z('#overlay-video');
    expect(overlay).toBeGreaterThan(mood);
    // 위쪽 스택은 건드리지 않는다 — 움직이는 것은 오버레이 하나뿐이다
    // (`#transition-video`는 `#overlay-video`와 한 규칙을 공유해 45가 그 그룹 값이다)
    expect(z('#fade-black')).toBe(44);
    expect(overlay).toBeLessThan(44);
    // 층을 내리던 옛 규칙은 남지 않는다 (다음 사람이 되살릴 근거로 읽는다)
    expect(css).not.toContain('is-mood-under');
  });

  it('display가 그 클래스를 실제로 붙인다', () => {
    const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      "overlayVideoEl.classList.toggle('is-mood-caption', layer.blend === 'screen')",
    );
  });

  it('캔버스는 즉시 제거하지 않고 페이드 뒤에 뗀다', () => {
    const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
    expect(source).toContain('MOOD_GLITCH_FADE_MS');
    expect(source).toContain("leaving.style.opacity = '0'");
    const block = css.match(/\.mood-transition__glitch\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).toMatch(/transition:\s*opacity\s*0\.3s/);
  });
});
