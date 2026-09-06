// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { freezeToggleView, selectVisualState } from './pgm';
import { createInitialState, migrate, reducer, resetRuntimeVideoPhase, serialize } from './state';

const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
const controlCss = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');
const topbar = readFileSync(new URL('./control/topbar.ts', import.meta.url), 'utf8');

describe('화면 동결 선택 (U75)', () => {
  it('얼어 있고 스냅샷이 있으면 스냅샷을, 아니면 라이브를 준다', () => {
    expect(selectVisualState(true, 'snap', 'live')).toBe('snap');
    expect(selectVisualState(false, 'snap', 'live')).toBe('live');
  });

  it('스냅샷이 없는 동결은 라이브로 떨어진다 — 그리지 못하는 상태로 굳지 않게', () => {
    expect(selectVisualState(true, null, 'live')).toBe('live');
  });
});

describe('화면 동결 리듀서 (U75)', () => {
  it('불린 하나만 바꾼다 — 스냅샷은 상태에 들어가지 않는다', () => {
    const base = createInitialState();
    expect(base.pgm.frozen).toBe(false);
    const on = reducer(base, { type: 'pgm/freeze', on: true });
    expect(on.pgm).toEqual({ frozen: true });
    expect(Object.keys(on.pgm)).toEqual(['frozen']);
    // 씬·소리·큐는 그대로다
    expect(on.scene).toBe(base.scene);
    expect(on.music).toBe(base.music);
    expect(on.sceneOpts).toBe(base.sceneOpts);
  });

  it('같은 값으로 다시 누르면 상태가 바뀌지 않는다', () => {
    const on = reducer(createInitialState(), { type: 'pgm/freeze', on: true });
    expect(reducer(on, { type: 'pgm/freeze', on: true })).toBe(on);
  });

  it('해제는 상태를 되돌릴 뿐이다 — 전환 래핑이 없다(컷)', () => {
    const on = reducer(createInitialState(), { type: 'pgm/freeze', on: true });
    const off = reducer(on, { type: 'pgm/freeze', on: false });
    expect(off.pgm.frozen).toBe(false);
    expect(off.sceneOpts.transitionVideo.active).toBe(false);
    expect(off.sceneOpts.sceneFade.active).toBe(false);
  });
});

describe('화면 동결 저장본 처리 (U75)', () => {
  it('migrate는 불린 정규화만 한다 — 리셋하지 않는다', () => {
    const on = reducer(createInitialState(), { type: 'pgm/freeze', on: true });
    expect(migrate(JSON.parse(serialize(on))).pgm.frozen).toBe(true);
  });

  it('불린이 아닌 값은 false로 접는다', () => {
    const raw = { ...createInitialState(), pgm: { frozen: 'yes' } };
    expect(migrate(JSON.parse(JSON.stringify(raw))).pgm.frozen).toBe(false);
    expect(migrate({}).pgm.frozen).toBe(false);
  });

  it('저장본 인수(resetRuntimeVideoPhase)는 동결을 건드리지 않는다 — 숨은 상태가 아니다', () => {
    const on = reducer(createInitialState(), { type: 'pgm/freeze', on: true });
    expect(resetRuntimeVideoPhase(on).pgm.frozen).toBe(true);
  });
});

/**
 * 이 배치의 핵심 계약 — **시각 경로와 소리 경로가 서로 다른 상태를 읽는다.**
 * 소스 스캔인 이유: vitest 환경이 node라 display.ts를 실행해 볼 수 없다.
 */
describe('동결 경계 (U75)', () => {
  it('시각 상태 게터가 순수 선택 함수 하나를 통해서만 갈린다', () => {
    expect(display).toContain('function visualState(): AppState {');
    expect(display).toContain('return selectVisualState(state.pgm.frozen, frozenSnapshot, state);');
    // 스냅샷 수명은 한 곳에서만 움직인다
    expect(display).toContain('function syncFreezeSnapshot(): void {');
    expect(display).toContain('if (!frozenSnapshot) frozenSnapshot = state;');
  });

  it('스냅샷 갱신이 paint의 맨 앞에서 한 번만 돈다', () => {
    expect(display).toMatch(
      /function paint\(\): void \{\s*\n\s*const now = Date\.now\(\);[\s\S]{0,200}syncFreezeSnapshot\(\);\s*\n\s*const vis = visualState\(\);/,
    );
  });

  it('씬 렌더·씬 tick·전환·씬 페이드가 시각 상태를 읽는다', () => {
    expect(display).toContain('const changed = renderScene(vis, stage, scene);');
    expect(display).toContain('tickScene(stage, vis, now, scene);');
    expect(display).toContain('const want = pickScene(vis);');
    expect(display).toContain('const fade = visualState().sceneOpts.sceneFade;');
    expect(display).toContain('const v = visualState().sceneOpts.video;');
    expect(display).toContain('const transition = visualState().sceneOpts.transitionVideo;');
    expect(display).toContain('const overlay = visualState().sceneOpts.overlayVideo;');
    // 씬 렌더가 라이브 상태를 그대로 넘기는 경로가 남아 있으면 안 된다
    expect(display).not.toContain('renderScene(state,');
    expect(display).not.toContain('tickScene(stage, state,');
  });

  it('음악·볼륨·게인은 라이브 상태를 읽는다 — 얼어 있어도 BGM은 조작된다', () => {
    expect(display).toContain("effectiveVolume(state.settings, state.volumeRamps, 'media', now)");
    expect(display).toContain("effectiveVolume(state.settings, state.volumeRamps, 'music', now)");
    expect(display).toContain('musicPlaybackCommand(appliedMusic, state.music)');
    expect(display).toContain('if (state.music.ducked !== musicDuck.applied)');
    // U122 — 기본 fadeSec는 여전히 라이브 `state.settings.musicFadeSec`를 읽는다(디폴트 인자는
    // 매 호출마다 다시 평가된다). cut-in(U122)만 이 기본을 0으로 넘겨 덮는다.
    expect(display).toContain(
      'fadeSec: number = state.settings.musicFadeSec,',
    );
    expect(display).toContain('deck.track = rampGain(deck.track, to, fadeSec, now, after);');
    // 음악 경로가 스냅샷을 읽으면 얼어 있는 동안 재생 명령이 도달하지 않는다
    expect(display).not.toContain('visualState().music');
    expect(display).not.toMatch(/visualState\(\)\.settings\.(?:music|media|master)/);
    expect(display).not.toContain('visualState().volumeRamps');
  });

  it('리플레이·암전·카메라도 라이브를 따른다 — 즉시 들어야 하는 조작이다', () => {
    expect(display).toContain('enabled: state.settings.replayEnabled,');
    expect(display).toContain('const b = state.sceneOpts.blackout;');
    expect(display).toContain('void camera.ensure(state.settings.camera.deviceId, state.settings.camera.audio);');
    expect(display).not.toContain('visualState().sceneOpts.blackout');
  });
});

describe('동결 토글 UI (U75)', () => {
  it('얼면 라벨이 해제로 바뀐다 — 버튼 하나로 현재 상태를 알 수 있다', () => {
    expect(freezeToggleView(false).label).toBe('● PGM FREEZE');
    expect(freezeToggleView(true).label).toBe('■ FREEZE 해제');
    expect(freezeToggleView(true).pressed).toBe(true);
  });

  it('툴팁이 음악·타이머는 계속 간다는 사실을 말한다', () => {
    for (const frozen of [true, false]) {
      const tip = freezeToggleView(frozen).tip;
      expect(tip).toContain('음악');
      expect(tip).toContain('타이머');
    }
  });

  it('상단 바가 다른 조작과 떨어진 자리에 버튼과 배지를 둔다', () => {
    expect(topbar).toContain("class: `topbar__freeze${frozen ? ' is-on' : ''}`");
    expect(topbar).toContain("type: 'pgm/freeze', on: !frozen");
    expect(topbar).toContain("text: 'FROZEN'");
  });

  it('control.css에 규칙이 있고 배지는 opacity만 움직인다', () => {
    expect(controlCss).toMatch(/\.topbar__freeze\s*\{/);
    expect(controlCss).toMatch(/\.freeze-btn\s*\{/);
    expect(controlCss).toMatch(/\.freeze-btn\.is-on\s*\{/);
    expect(controlCss).toMatch(/\.freeze-badge\s*\{/);
    const frames = controlCss.slice(controlCss.indexOf('@keyframes freeze-pulse'));
    const block = frames.slice(0, frames.indexOf('}\n}') + 3);
    expect(block).toContain('opacity');
    expect(block).not.toMatch(/transform|width|height|filter|background/);
    // 양수 자간 금지
    expect(controlCss.match(/\.freeze-btn\s*\{([^}]*)\}/)?.[1]).not.toMatch(/letter-spacing:\s*0\.\d/);
  });

  it('단축키를 새로 만들지 않는다 — 오조작 거리를 0으로 만들지 않기 위해', () => {
    const hotkeys = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');
    expect(hotkeys).not.toMatch(/pgm\/freeze[\s\S]{0,200}installHotkeys/);
    expect(hotkeys).not.toContain("'pgm/freeze'");
  });
});
