import { describe, expect, it } from 'vitest';

// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import { glitchIntensityAt } from './mood-glitch';
import {
  MOOD_GLITCH_FADE_IN_SEC,
  MOOD_OVERLAY_Z,
  moodGlitchOpacity,
  moodOverlayLayer,
  moodOwnsOverlay,
  moodVisualState,
} from './mood-visual';

/**
 * U53 — 반전 영상은 큐를 누르는 순간부터 백그라운드로 돌고, 글리치는 검정이 완전히 덮을 때까지
 * 계속 심해진다. 그래서 레이어 판정이 두 가지 바뀌었다.
 *  1) 캔버스는 `blackout` 단계에서도 살아 있다 (예전에는 여기서 떼어 디스토션이 뚝 멈췄다).
 *  2) 영상의 검정 배경이 글리치를 가리지 않게 한다 — U53에서는 층을 내려서(`is-mood-under`),
 *     U77부터는 `screen` 합성으로(`moodOverlayLayer`). 층을 내리면 자막까지 묻혔다.
 */
describe('분위기 반전 출력 레이어', () => {
  it('글리치 단계는 캔버스를 켜고 암전은 아직 올리지 않는다', () => {
    expect(moodVisualState(true, 'glitch')).toEqual({
      hidden: false,
      phase: 'glitch',
      // D8 — 영상은 t0부터 소리가 있다. 앞 15초가 검정이라 그동안 들리는 것은 소리뿐이다.
      videoAudio: true,
      crossfadeVisual: false,
      glitchCanvas: true,
      blackTarget: 0,
    });
  });

  it('검정 단계에서도 캔버스를 유지한 채 암전을 올린다 (U53)', () => {
    expect(moodVisualState(true, 'blackout')).toEqual({
      hidden: false,
      phase: 'blackout',
      videoAudio: true,
      crossfadeVisual: false,
      // 여기서 캔버스를 내리면 "글리치가 가다가 마는" 그림이 된다
      glitchCanvas: true,
      blackTarget: 1,
    });
  });

  it('크로스디졸브 단계에서만 캔버스를 내리고 영상을 위로 올린다', () => {
    expect(moodVisualState(true, 'crossfade')).toEqual({
      hidden: false,
      phase: 'crossfade',
      videoAudio: true,
      crossfadeVisual: true,
      glitchCanvas: false,
      // 검정은 영상 아래에 남는다 — 레터박스 여백으로 이전 씬이 비치지 않게
      blackTarget: 1,
    });
  });

  it('종료 단계는 레이어를 닫는다', () => {
    expect(moodVisualState(false, 'crossfade')).toEqual({
      hidden: true,
      phase: 'idle',
      videoAudio: false,
      crossfadeVisual: false,
      glitchCanvas: false,
      blackTarget: 0,
    });
  });

  it('자막이 타 오르는 구간과 캔버스가 도는 구간이 정확히 겹친다 (U77)', () => {
    for (const phase of ['glitch', 'blackout'] as const) {
      const v = moodVisualState(true, phase);
      expect(v.glitchCanvas).toBe(true);
      expect(moodOverlayLayer(true, phase).blend).toBe('screen');
    }
  });
});

/**
 * U77 — 반전 영상 앞 15초의 **흰 자막**이 글리치 위로 보여야 한다.
 *
 * U53은 영상의 검정 배경이 글리치를 가리는 것을 막으려고 영상을 글리치 아래로 내렸는데,
 * 그 검정 위에 얹혀 있던 도입부 자막까지 함께 묻혔다. 층 대신 합성을 바꾼다 — `screen`은
 * 검정이 항등원이라 배경은 아무것도 덮지 않고 흰 자막만 타 오른다.
 */
describe('반전 자막 screen 합성 (U77)', () => {
  const css = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');
  const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

  it('글리치·암전 단계에서만 screen이고 영상은 글리치 위 평소 자리에 남는다', () => {
    for (const phase of ['glitch', 'blackout'] as const) {
      expect(moodOverlayLayer(true, phase)).toEqual({ z: MOOD_OVERLAY_Z, blend: 'screen' });
    }
  });

  it('캔버스를 떼는 crossfade에서 normal로 되돌아온다 — 안 그러면 영상의 어두운 부분이 사라진다', () => {
    expect(moodOverlayLayer(true, 'crossfade')).toEqual({ z: MOOD_OVERLAY_Z, blend: 'normal' });
  });

  it('반전 밖에서는 어떤 단계 값이 와도 normal이다', () => {
    for (const phase of ['idle', 'glitch', 'blackout', 'crossfade'] as const) {
      expect(moodOverlayLayer(false, phase).blend).toBe('normal');
    }
    expect(moodOverlayLayer(true, 'idle').blend).toBe('normal');
  });

  it('영상 층이 글리치(42)보다 위다 — CSS 숫자와 순수 함수가 같은 값을 쓴다', () => {
    const z = (selector: string): number => {
      const escaped = selector.replace(/[.#]/g, '\\$&');
      const bodies = [...css.matchAll(new RegExp('\\n' + escaped + '\\s*\\{([^}]*)\\}', 'g'))]
        .map((m) => m[1])
        .filter((body) => /z-index:/.test(body));
      return Number.parseInt(bodies[bodies.length - 1]?.match(/z-index:\s*(-?\d+)/)?.[1] ?? 'NaN', 10);
    };
    expect(z('#overlay-video')).toBe(MOOD_OVERLAY_Z);
    expect(z('#mood-transition')).toBeLessThan(MOOD_OVERLAY_Z);
  });

  it('합성은 오버레이 하나에만 걸린다 — 카메라·씬에는 없다', () => {
    expect(css).toMatch(/#overlay-video\.is-mood-caption\s*\{[^}]*mix-blend-mode:\s*screen/s);
    const blended = [...css.matchAll(/([^{}]+)\{[^}]*mix-blend-mode:\s*screen[^}]*\}/g)].map((m) =>
      m[1].trim().split('\n').pop()!.trim(),
    );
    expect(blended).toContain('#overlay-video.is-mood-caption');
    expect(blended.some((sel) => /cam-video|cam-slot|scene|stage/.test(sel))).toBe(false);
  });

  it('display가 순수 함수 결과로만 클래스를 갈고, 걷어낸 층 내리기는 남지 않는다', () => {
    expect(display).toContain('const layer = moodOverlayLayer(mood.active, mood.phase);');
    expect(display).toContain(
      "overlayVideoEl.classList.toggle('is-mood-caption', layer.blend === 'screen');",
    );
    expect(display).not.toContain('is-mood-under');
    expect(css).not.toContain('is-mood-under');
  });
});

/**
 * D8 — 실측에서 pt1 오버레이가 t0부터 crossfade(+15.0s)까지 muted였고, 카메라 소리는
 * 글리치 15초 내내 그대로 나갔다. 둘 다 "전환 중에는 반전 오디오만"이라는 연출을 깬다.
 */
describe('분위기 반전 오디오 소유권 (D8)', () => {
  const mood = (assetId: string | null, active = true) => ({ active, assetId });

  it('반전이 튼 오버레이만 소리를 연다', () => {
    expect(moodOwnsOverlay(mood('media:pt1.mp4'), 'media:pt1.mp4')).toBe(true);
  });

  it('같은 슬롯의 매치 오버레이는 소유가 아니다', () => {
    expect(moodOwnsOverlay(mood('media:pt1.mp4'), 'media:match_blue_red.webm')).toBe(false);
  });

  it('반전이 안 도는 동안에는 어떤 오버레이도 소유가 아니다', () => {
    expect(moodOwnsOverlay(mood('media:pt1.mp4', false), 'media:pt1.mp4')).toBe(false);
    expect(moodOwnsOverlay(mood(null), null)).toBe(false);
  });

  it('소리는 전환 첫 순간부터 열려 있다 — 단계가 아니라 active가 기준이다', () => {
    for (const phase of ['glitch', 'blackout', 'crossfade'] as const) {
      expect(moodVisualState(true, phase).videoAudio).toBe(true);
    }
    expect(moodVisualState(false, 'idle').videoAudio).toBe(false);
  });

  it('크로스페이드 CSS 클래스는 마지막 단계에서만 붙는다', () => {
    expect(moodVisualState(true, 'glitch').crossfadeVisual).toBe(false);
    expect(moodVisualState(true, 'blackout').crossfadeVisual).toBe(false);
    expect(moodVisualState(true, 'crossfade').crossfadeVisual).toBe(true);
  });

  it('display가 카메라 파킹과 0.6초 램프 인을 배선한다', () => {
    const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
    expect(source).toContain('const MOOD_AUDIO_RAMP_SEC = 0.6;');
    expect(source).toContain('rampGain(idleTrack(0), 1, MOOD_AUDIO_RAMP_SEC, Date.now())');
    expect(source).toContain('function syncMoodCameraAudio(');
    expect(source).toContain("requestAudioTeardown(camMedia, 'mute', now)");
    // 되돌리는 것은 카메라 슬롯이 아직 있을 때만 — 씬이 넘어갔으면 attachSlots의 정리를 지킨다
    expect(source).toContain("if (camera.stream && stage.querySelector('[data-cam-slot]'))");
    expect(source).toContain('syncMoodCameraAudio(now);');
  });

  it('캔버스는 전환이 끝나기 전에 내려 15.0초에 제거가 끝난다', () => {
    const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
    expect(source).toContain("if (remainMs <= MOOD_GLITCH_FADE_MS) canvas.style.opacity = '0';");
    expect(source).toContain("if (leaving.style.opacity === '0') leaving.remove();");
  });
});

/**
 * U91 — "파트원 글리치 넘어갈 때 화면이 순간 튄다"(사용자).
 *
 * 그려지는 그림은 첫 프레임에 라이브와 같았다(`glitchIntensityAt(0) === 0`). 튄 것은 카메라
 * 위에 얹혀 있던 것들이다 — 스코어바·VS 바·종목 배지·타이머·리플레이 표식·앰비언트 그레인이
 * 불투명한 캔버스에 한 프레임에 덮였다. 그래서 캔버스를 0에서 올린다.
 */
describe('글리치 진입 디졸브 (U91)', () => {
  it('첫 프레임은 완전히 투명하다 — 라이브가 그대로 보인다', () => {
    expect(moodGlitchOpacity(0)).toBe(0);
  });

  it('중간에서 곡선의 반값이다 (easeInOutQuad)', () => {
    expect(moodGlitchOpacity(MOOD_GLITCH_FADE_IN_SEC / 2)).toBeCloseTo(0.5, 6);
  });

  it('0.6초에 1에 닿고 그 뒤로는 계속 1이다', () => {
    expect(moodGlitchOpacity(MOOD_GLITCH_FADE_IN_SEC)).toBe(1);
    expect(moodGlitchOpacity(MOOD_GLITCH_FADE_IN_SEC + 5)).toBe(1);
    expect(moodGlitchOpacity(15)).toBe(1);
  });

  it('구간 안에서 단조 증가한다', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i += 1) {
      const v = moodGlitchOpacity((MOOD_GLITCH_FADE_IN_SEC * i) / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBe(1);
  });

  it('음수·NaN은 0으로 접는다 (기준 시각이 아직 안 잡힌 프레임)', () => {
    expect(moodGlitchOpacity(-1)).toBe(0);
    expect(moodGlitchOpacity(Number.NaN)).toBe(0);
  });

  it('디졸브는 15초 안에 있다 — 전체 길이를 늘리지 않는다', () => {
    // 램프가 끝나는 시점의 글리치 세기는 사실상 0이라, 디졸브가 끝난 그림도 라이브와 같다
    expect(MOOD_GLITCH_FADE_IN_SEC).toBeLessThan(15);
    expect(glitchIntensityAt(MOOD_GLITCH_FADE_IN_SEC * 1000, 15000, 1)).toBeLessThan(0.001);
  });

  it('display가 캔버스 불투명도를 이 함수에서 심는다', () => {
    const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
    expect(source).toContain('const fadeIn = moodGlitchOpacity((now - moodGlitchStartedAt) / 1000);');
    expect(source).toContain('canvas.style.opacity = String(fadeIn);');
    // 붙는 순간부터 투명해야 한다 — 첫 프레임에 불투명하면 rAF가 돌기 전에 이미 튄다
    expect(source).toContain("canvas.style.opacity = '0';");
    expect(source).toContain("canvas.className = 'mood-transition__glitch is-mood-fade-in';");
  });

  it('램프 구간에는 CSS transition을 덮어써 곡선이 갈라지지 않는다', () => {
    const css = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');
    const block = css.match(/\.mood-transition__glitch\.is-mood-fade-in\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).toMatch(/transition:\s*none/);
    // 나가는 0.3초 페이드는 그대로 CSS가 맡는다
    const base = css.match(/\.mood-transition__glitch\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(base).toMatch(/transition:\s*opacity\s*0\.3s/);
    const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
    expect(source).toContain('if (fadeIn >= 1) canvas.classList.remove(MOOD_GLITCH_FADE_IN_CLASS);');
    expect(source).toContain('leaving.classList.remove(MOOD_GLITCH_FADE_IN_CLASS);');
  });
});
