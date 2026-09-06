import { describe, expect, it } from 'vitest';

import { createInitialState, reducer } from '../state';
import { renderScene } from './index';
import { declOf, parseRules, section } from './luxe-css.testkit';
import type { AppState } from '../types';

const core = section('Broadcast Luxe 공통 골격', 'S4 리더보드');

/**
 * display는 node 환경 테스트에서 실제 DOM 없이 돈다.
 * renderScene이 실제로 만지는 것은 `dataset`과 `innerHTML`뿐이라 그만큼만 흉내 낸다.
 */
function fakeStage(): HTMLElement {
  return { dataset: {} as Record<string, string>, innerHTML: '' } as unknown as HTMLElement;
}

function rosterState(versus: boolean): AppState {
  const base = reducer(createInitialState(), { type: 'scene/set', scene: 'roster' });
  return versus
    ? reducer(base, {
        type: 'sceneOpts/patch',
        patch: { liveOverlay: { versus: ['t1', 't3'] } },
      })
    : base;
}

describe('씬 진입 표시', () => {
  it('씬이 바뀐 렌더에만 data-scene-enter가 붙는다', () => {
    const stage = fakeStage();
    renderScene(rosterState(false), stage, 'roster');
    expect(stage.dataset.sceneEnter).toBe('1');
    expect(stage.dataset.scene).toBe('roster');
  });

  it('HTML이 그대로인 프레임에서는 표시를 지우지 않는다', () => {
    // 매 프레임 지우면 아직 돌고 있는 1초짜리 진입 모션이 중간에 끊긴다
    const stage = fakeStage();
    const state = rosterState(false);
    renderScene(state, stage, 'roster');
    for (let i = 0; i < 5; i += 1) {
      expect(renderScene(state, stage, 'roster')).toBe(false);
      expect(stage.dataset.sceneEnter).toBe('1');
    }
  });

  it('같은 씬에서 데이터가 바뀌어 다시 그리면 표시를 지운다', () => {
    // 대결팀 토글 — 온에어 중에 행 등장이 다시 도는 것을 막는다
    const stage = fakeStage();
    renderScene(rosterState(false), stage, 'roster');
    expect(renderScene(rosterState(true), stage, 'roster')).toBe(true);
    expect(stage.dataset.sceneEnter).toBeUndefined();
  });

  it('다른 씬으로 갔다 오면 진입 모션이 다시 붙는다', () => {
    const stage = fakeStage();
    renderScene(rosterState(false), stage, 'roster');
    renderScene(rosterState(true), stage, 'roster'); // 같은 씬 재렌더 → 표시가 지워진다
    expect(stage.dataset.sceneEnter).toBeUndefined();
    renderScene(createInitialState(), stage, 'score');
    expect(stage.dataset.sceneEnter).toBe('1');
    renderScene(rosterState(true), stage, 'roster');
    expect(stage.dataset.sceneEnter).toBe('1');
  });
});

describe('진입 모션 게이트 CSS', () => {
  const gate = parseRules(core).find((rule) =>
    rule.selectors.some((sel) => sel.startsWith('[data-scene]:not([data-scene-enter])')),
  );

  it('보드 골격의 진입 모션을 표시가 없을 때 끈다', () => {
    expect(gate).toBeDefined();
    expect(gate?.body).toMatch(/animation:\s*none/);
    for (const target of [
      '.luxe-row > .luxe-pill',
      '.luxe-row > .luxe-capsule',
      '.luxe-headbar',
      '.luxe-mast__title',
      '.sb__row-body',
      '.sb__rank',
      '.rs__panel',
      '.rs__vs',
    ]) {
      expect(gate?.selectors).toContain(`[data-scene]:not([data-scene-enter]) ${target}`);
    }
  });

  it('리더보드 재정렬 트윈은 건드리지 않는다', () => {
    // 재정렬은 animation이 아니라 transition이라 게이트 밖에 있다
    expect(gate?.body).not.toMatch(/transition/);
    expect(declOf(core, '.luxe-row', 'transition')).toBe('transform 0.4s var(--ease-out)');
    expect(declOf(core, '.luxe-row', 'transform')).toBe(
      'translateY(calc(var(--row-index, 0) * var(--step)))',
    );
  });

  it('시상 리빌의 단계별 모션은 게이트에 넣지 않는다', () => {
    // slot-reveal은 등수를 열 때마다 도는 게 맞다
    for (const kept of ['.award__history-card', '.award__reveal-focus']) {
      expect(gate?.selectors.some((sel) => sel.includes(kept))).toBe(false);
    }
  });
});
