// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  blackoutDurationMs,
  blackoutOpacity,
  blackoutRemainingSec,
  blackoutTarget,
} from './blackout';
import { blackoutToggleView } from './control/launcher';
import { adoptStoredState, createInitialState, migrate, reducer, resetRuntimeVideoPhase, serialize } from './state';

const css = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');
const controlCss = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');
const displaySource = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

describe('암전 불투명도 (U65)', () => {
  it('0 · 중간 · 끝 세 지점이 0 → 0.5 → 1이다', () => {
    const ms = blackoutDurationMs(5, 0, 1);
    expect(ms).toBe(5000);
    expect(blackoutOpacity(0, ms, 0, 1)).toBe(0);
    // easeInOutQuad는 t=0.5에서 정확히 0.5로 두 분기가 만난다
    expect(blackoutOpacity(2500, ms, 0, 1)).toBeCloseTo(0.5, 6);
    expect(blackoutOpacity(5000, ms, 0, 1)).toBe(1);
  });

  it('되돌아오는 램프는 같은 세 지점을 거꾸로 지난다', () => {
    const ms = blackoutDurationMs(5, 1, 0);
    expect(blackoutOpacity(0, ms, 1, 0)).toBe(1);
    expect(blackoutOpacity(2500, ms, 1, 0)).toBeCloseTo(0.5, 6);
    expect(blackoutOpacity(5000, ms, 1, 0)).toBe(0);
  });

  it('지속시간은 거리에 비례한다 — 반쯤 어두워진 화면은 절반 시간에 돌아온다', () => {
    expect(blackoutDurationMs(5, 0.5, 1)).toBe(2500);
    expect(blackoutDurationMs(5, 0.8, 0)).toBeCloseTo(4000, 6);
  });

  it('길이가 0이거나 유한하지 않으면 컷으로 강등된다', () => {
    expect(blackoutDurationMs(0, 0, 1)).toBe(0);
    expect(blackoutDurationMs(Number.NaN, 0, 1)).toBe(0);
    expect(blackoutOpacity(0, 0, 0, 1)).toBe(1);
  });

  it('범위 밖 경과 시간은 클램프한다', () => {
    const ms = blackoutDurationMs(5, 0, 1);
    expect(blackoutOpacity(-1000, ms, 0, 1)).toBe(0);
    expect(blackoutOpacity(99999, ms, 0, 1)).toBe(1);
  });

  it('목표는 active가 곧 결정한다', () => {
    expect(blackoutTarget(true)).toBe(1);
    expect(blackoutTarget(false)).toBe(0);
  });

  it('남은 초는 올림이고 끝나면 0이다', () => {
    expect(blackoutRemainingSec(0, 5000)).toBe(5);
    expect(blackoutRemainingSec(2600, 5000)).toBe(3);
    expect(blackoutRemainingSec(5000, 5000)).toBe(0);
    expect(blackoutRemainingSec(0, 0)).toBe(0);
  });
});

describe('암전 리듀서 (U65)', () => {
  it('토글이 목표와 시작 시각을 세운다 — 씬·소리는 건드리지 않는다', () => {
    const base = createInitialState();
    const on = reducer(base, { type: 'blackout/set', on: true, now: 1_000 });
    expect(on.sceneOpts.blackout).toEqual({ active: true, startedAt: 1_000, fromOpacity: 0 });
    expect(on.scene).toBe(base.scene);
    expect(on.music).toBe(base.music);
    expect(on.settings).toBe(base.settings);
  });

  it('같은 상태로 다시 누르면 상태가 바뀌지 않는다 (램프 재시작 방지)', () => {
    const base = createInitialState();
    const on = reducer(base, { type: 'blackout/set', on: true, now: 1_000 });
    expect(reducer(on, { type: 'blackout/set', on: true, now: 3_000 })).toBe(on);
  });

  it('램프 도중 뒤집으면 지금 보이는 밝기에서 출발한다', () => {
    const base = createInitialState();
    expect(base.settings.blackoutSec).toBe(5);
    const on = reducer(base, { type: 'blackout/set', on: true, now: 0 });
    // 절반(2.5초) 지점 = 0.5. 여기서 끄면 0.5에서 출발해 2.5초만에 되돌아온다.
    const off = reducer(on, { type: 'blackout/set', on: false, now: 2_500 });
    expect(off.sceneOpts.blackout.active).toBe(false);
    expect(off.sceneOpts.blackout.startedAt).toBe(2_500);
    expect(off.sceneOpts.blackout.fromOpacity).toBeCloseTo(0.5, 6);
    expect(blackoutDurationMs(5, off.sceneOpts.blackout.fromOpacity, 0)).toBeCloseTo(2500, 3);
  });

  it('다 끝난 뒤 뒤집으면 끝값에서 출발한다', () => {
    const base = createInitialState();
    const on = reducer(base, { type: 'blackout/set', on: true, now: 0 });
    const off = reducer(on, { type: 'blackout/set', on: false, now: 60_000 });
    expect(off.sceneOpts.blackout.fromOpacity).toBe(1);
  });
});

describe('암전 저장본 처리 (U65)', () => {
  it('migrate는 리셋하지 않고 모양만 본다 — display가 지시를 받아야 한다', () => {
    const live = reducer(createInitialState(), { type: 'blackout/set', on: true, now: 7_000 });
    const round = migrate(JSON.parse(serialize(live)));
    expect(round.sceneOpts.blackout).toEqual({ active: true, startedAt: 7_000, fromOpacity: 0 });
  });

  it('migrate가 이상한 값은 0~1 · 유한수로 좁힌다', () => {
    const raw = {
      ...createInitialState(),
      sceneOpts: {
        ...createInitialState().sceneOpts,
        blackout: { active: 'yes', startedAt: Number.NaN, fromOpacity: 5 },
      },
    };
    expect(migrate(JSON.parse(JSON.stringify(raw))).sceneOpts.blackout).toEqual({
      active: false,
      startedAt: 0,
      fromOpacity: 0,
    });
  });

  it('저장본 인수(adoptStoredState)는 암전을 푼다 — 검은 화면으로 깨어나지 않게', () => {
    const live = reducer(createInitialState(), { type: 'blackout/set', on: true, now: 7_000 });
    const taken = adoptStoredState(live);
    expect(taken.sceneOpts.blackout).toEqual({ active: false, startedAt: 0, fromOpacity: 0 });
  });

  it('암전이 없는 상태는 adoptStoredState가 그대로 돌려준다 (불필요한 방송 방지)', () => {
    const base = createInitialState();
    expect(adoptStoredState(base)).toBe(base);
  });

  /**
   * **U96 실측 회귀.** 리듀서 안에서 불리는 런타임 리셋이 암전을 소유하면 안 된다.
   * 영상 재생 중 `F1`을 누르면 control이 `video/abort`를 배치 맨 앞에 끼우는데, 그 액션이
   * `resetRuntimeVideoPhase()`를 그대로 쓰기 때문에 암전이 통째로 스냅됐다.
   */
  it('런타임 단계 리셋(resetRuntimeVideoPhase)은 암전을 건드리지 않는다', () => {
    const live = reducer(createInitialState(), { type: 'blackout/set', on: true, now: 7_000 });
    expect(resetRuntimeVideoPhase(live).sceneOpts.blackout).toEqual(live.sceneOpts.blackout);
  });

  it('`video/abort`도 암전을 남긴다 — 뒤따르는 해제가 지금 밝기에서 출발해야 한다', () => {
    const base = reducer(createInitialState(), { type: 'blackout/set', on: true, now: 0 });
    const playing = reducer(base, {
      type: 'video/playFull',
      assetId: 'clip-1',
      nextScene: null,
      now: 100,
    });
    expect(playing.sceneOpts.video.phase).not.toBe('idle');
    const aborted = reducer(playing, { type: 'video/abort' });
    expect(aborted.sceneOpts.video.phase).toBe('idle');
    expect(aborted.sceneOpts.blackout).toEqual(base.sceneOpts.blackout);
  });
});

describe('암전 화면 계약 (U65)', () => {
  it('#blackout이 씬 페이드(46)·스팅어(45)보다 위, 운영 크롬(50)보다 아래다', () => {
    const z = (selector: string): number => {
      const escaped = selector.replace(/[.#]/g, '\\$&');
      const bodies = [...css.matchAll(new RegExp('\\n' + escaped + '\\s*\\{([^}]*)\\}', 'g'))]
        .map((m) => m[1])
        .filter((body) => /z-index:/.test(body));
      return Number.parseInt(bodies[bodies.length - 1]?.match(/z-index:\s*(-?\d+)/)?.[1] ?? 'NaN', 10);
    };
    expect(z('#blackout')).toBe(47);
    expect(z('#blackout')).toBeGreaterThan(z('#scene-fade'));
    expect(z('#blackout')).toBeGreaterThan(z('#fade-black'));
    expect(z('#blackout')).toBeLessThan(z('#fs-btn'));
  });

  it('#blackout은 검정 · 포인터 통과 · CSS transition 없음(곡선은 rAF가 쥔다)', () => {
    const block = css.match(/#blackout\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).toMatch(/background:\s*#000/);
    expect(block).toMatch(/pointer-events:\s*none/);
    expect(block).toMatch(/opacity:\s*0/);
    expect(block).not.toMatch(/transition:/);
  });

  it('display가 라이브 상태를 읽어 opacity만 쓴다 (동결 중에도 암전은 듣는다)', () => {
    expect(displaySource).toContain("blackoutEl.id = 'blackout'");
    expect(displaySource).toContain('const b = state.sceneOpts.blackout;');
    expect(displaySource).toContain('blackoutEl.style.opacity');
    expect(displaySource).toContain('tickBlackout(now);');
  });
});

describe('암전 토글 UI (U65)', () => {
  it('켬/끔이 텍스트와 형태 문자로 함께 갈린다', () => {
    expect(blackoutToggleView(false, 0)).toEqual({
      label: '● 화면 암전',
      pressed: false,
      ramping: false,
    });
    expect(blackoutToggleView(true, 0)).toEqual({
      label: '■ 암전 해제',
      pressed: true,
      ramping: false,
    });
  });

  it('램프가 도는 동안에만 ramping이다', () => {
    expect(blackoutToggleView(true, 3).ramping).toBe(true);
    expect(blackoutToggleView(true, 0).ramping).toBe(false);
  });

  it('control.css에 토글 규칙이 있다 — JS가 붙이는 클래스는 규칙이 있어야 한다', () => {
    expect(controlCss).toMatch(/\.launcher__blackout\s*\{/);
    expect(controlCss).toMatch(/\.launcher__blackout\.is-on\s*\{/);
    expect(controlCss).toMatch(/\.launcher__blackout-label\s*\{/);
    expect(controlCss).toMatch(/\.launcher__blackout-count\s*\{/);
    expect(controlCss).toMatch(/\.launcher__blackout\.is-ramping\s+\.launcher__blackout-count\s*\{/);
    // 양수 자간 금지
    expect(controlCss.match(/\.launcher__blackout\s*\{([^}]*)\}/)?.[1]).not.toMatch(
      /letter-spacing:\s*0\.\d/,
    );
  });
});
