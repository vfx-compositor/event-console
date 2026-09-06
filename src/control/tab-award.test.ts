import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import { activeTeamIds, createInitialState, reducer } from '../state';
import type { Action } from '../state';
import type { AppState } from '../types';
import { awardRankChoices, nextAwardBeat, soloStatusLine } from './tab-award';

// 테스트 환경이 `environment: 'node'`(DOM 없음)라 render(ctx)를 직접 부를 수 없다 —
// 렌더가 실제로 이 분기를 쓰는지는 소스 텍스트로 확인한다 (tab-p1.test.ts·tab-roster.test.ts와 같은 방식).
const source = readFileSync(new URL('./tab-award.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles/control.css', import.meta.url), 'utf8');

/** 큰 [다음] 버튼을 끝까지 눌러 본다. 각 박자의 라벨과 그때 나간 액션을 그대로 남긴다. */
function walkBeats(start: AppState, limit = 40): { label: string; actions: Action[] }[] {
  let state = start;
  const log: { label: string; actions: Action[] }[] = [];
  for (let i = 0; i < limit; i += 1) {
    const beat = nextAwardBeat(
      state.sceneOpts.award,
      activeTeamIds(state).length,
      state.p2.unlocked,
      state.scene === 'award',
    );
    if (beat === null) return log;
    log.push({ label: beat.label, actions: beat.actions });
    for (const action of beat.actions) state = reducer(state, action);
  }
  throw new Error('박자가 끝나지 않았다 — nextAwardBeat가 제자리를 돈다');
}

describe('시상 직접 등수 선택', () => {
  it('4팀의 모든 등수를 현장 버튼으로 제공한다', () => {
    expect(awardRankChoices(4)).toEqual([1, 2, 3, 4]);
  });
});

describe('MC를 따라가는 다음 박자 (U70)', () => {
  it('4팀 시상을 1부 표 → 종합 합산 → 꼴찌부터 등수·팀 두 박자 → 우승 순서로 안내한다', () => {
    const state = reducer(createInitialState(), { type: 'p2/unlock' });
    expect(activeTeamIds(state).length).toBe(4);

    expect(walkBeats(state).map((b) => b.label)).toEqual([
      '1부 순위표',
      '종합 합산',
      '4위 등수 노출',
      '4위 팀 공개',
      '3위 등수 노출',
      '3위 팀 공개',
      '2위 등수 노출',
      '2위 팀 공개',
      '1위 등수 노출',
      '1위 팀 공개',
      '우승 세리머니',
    ]);
  });

  it('우승 박자까지 끝나면 더 나갈 박자가 없다', () => {
    let state = reducer(createInitialState(), { type: 'p2/unlock' });
    for (const beat of walkBeats(state)) {
      for (const action of beat.actions) state = reducer(state, action);
    }
    expect(state.sceneOpts.award.step).toBe('winner');
    expect(nextAwardBeat(state.sceneOpts.award, 4, true, true)).toBeNull();
  });

  it('등수 노출과 팀 공개를 절대 한 박자에 묶지 않는다', () => {
    const state = reducer(createInitialState(), { type: 'p2/unlock' });
    for (const beat of walkBeats(state)) {
      const types = beat.actions.map((a) => a.type);
      if (types.includes('award/selectRank')) {
        // 등수를 띄우는 박자에는 팀 공개가 절대 함께 나가면 안 된다 —
        // 미공개 팀 비노출 계약(scenes/award.ts:44-47)의 조작 쪽 절반이다.
        expect(types).not.toContain('award/revealSelectedTeam');
      }
    }
  });

  it('2부 잠금 중에는 합산 박자를 1부 점수 그대로라고 알린다', () => {
    const locked = createInitialState();
    expect(locked.p2.unlocked).toBe(false);

    const labels = walkBeats(locked).map((b) => b.label);
    expect(labels[0]).toBe('1부 순위표');
    expect(labels[1]).toBe('종합 합산 (1부 점수 그대로)');
    // 잠금이어도 등수·우승 박자는 그대로 이어진다 (1부만으로도 시상이 성립한다).
    expect(labels.slice(2)).toEqual([
      '4위 등수 노출',
      '4위 팀 공개',
      '3위 등수 노출',
      '3위 팀 공개',
      '2위 등수 노출',
      '2위 팀 공개',
      '1위 등수 노출',
      '1위 팀 공개',
      '우승 세리머니',
    ]);

    const beat = nextAwardBeat(locked.sceneOpts.award, 4, false, true);
    expect(beat?.detail).toContain('2부가 잠겨 있어');
  });

  it('씬이 이미 시상이면 scene/set을 다시 내보내지 않는다', () => {
    const award = createInitialState().sceneOpts.award;

    const cold = nextAwardBeat(award, 4, true, false);
    expect(cold?.actions).toContainEqual({ type: 'scene/set', scene: 'award' });

    const warm = nextAwardBeat(award, 4, true, true);
    expect(warm?.actions.map((a) => a.type)).not.toContain('scene/set');
    // 이미 시상 씬이면 첫 박자는 1부 표 대기가 아니라 합산으로 넘어간다.
    expect(warm?.label).toBe('종합 합산');
  });

  it('진행 도중 다른 씬에 갔다 와도 처음으로 되감지 않는다', () => {
    let state = reducer(createInitialState(), { type: 'p2/unlock' });
    state = reducer(state, { type: 'award/selectRank', rank: 4 });
    state = reducer(state, { type: 'award/revealSelectedTeam' });
    state = reducer(state, { type: 'scene/set', scene: 'standby' });

    const beat = nextAwardBeat(state.sceneOpts.award, 4, true, false);
    expect(beat?.label).toBe('3위 등수 노출');
    expect(beat?.actions).toContainEqual({ type: 'scene/set', scene: 'award' });
  });

  it('수동으로 건너뛴 등수는 남은 박자에서 다시 챙긴다', () => {
    let state = reducer(createInitialState(), { type: 'p2/unlock' });
    // 운영자가 수동으로 2위부터 공개해 버린 상황
    state = reducer(state, { type: 'award/selectRank', rank: 2 });
    state = reducer(state, { type: 'award/revealSelectedTeam' });

    expect(walkBeats(state).map((b) => b.label)).toEqual([
      '4위 등수 노출',
      '4위 팀 공개',
      '3위 등수 노출',
      '3위 팀 공개',
      '1위 등수 노출',
      '1위 팀 공개',
      '우승 세리머니',
    ]);
  });
});

describe('시상 탭 렌더', () => {
  it('큰 [다음] 버튼 하나를 큐시트와 같은 primary 클래스로 세운다', () => {
    expect(source).toContain("class: 'btn btn--primary btn--big btn--block'");
    expect(source).toContain('`다음: ${beat.label}`');
    // primary는 가이드 버튼 하나뿐이다 — 수동 영역은 시각적으로 한 단계 아래로 내린다.
    expect(source.match(/btn--primary/g)).toHaveLength(1);
  });

  it('버튼 아래 미리보기 줄과 툴팁이 같은 문장을 쓴다', () => {
    expect(source).toContain('beat.detail');
    expect(source).toContain('tip:');
  });

  it('수동 팀 공개 버튼은 reveal 단계에서만 팀을 공개한다 (한 박자 버그)', () => {
    // 진입 전에는 등수만 띄우고 멈춘다.
    const manual = source.slice(source.indexOf('const manualRevealLabel'));
    expect(manual).toContain('`${selectedRank}위 등수 노출`');
    // revealSelectedTeam은 cur === 'reveal' 가지 안에서만 나간다.
    expect(/cur === 'reveal'\s*\?\s*\[\{ type: 'award\/revealSelectedTeam' \}/.test(manual)).toBe(true);
  });

  it('control.css에 없는 새 클래스를 만들지 않는다', () => {
    for (const cls of [
      'tabpane',
      'tabpane__hint',
      'section__title',
      'btn',
      'btn--primary',
      'btn--big',
      'btn--block',
      'btn--ghost',
      'btn--tiny',
      'stepgrid',
      'step',
      'award-rank-picker',
      'revealrow',
      'scoretable',
    ]) {
      expect(css).toContain(`.${cls}`);
    }
  });
});

/**
 * 미공개 팀의 이름·점수가 출력 DOM에 새지 않는다는 계약(scenes/award.ts:44-47)은
 * 출력 씬 쪽 테스트인 `src/scenes/award.test.ts`의
 * "직접 고른 등수만 먼저 표시하고 해당 팀 정보는 DOM에도 넣지 않는다"가 이미 지키고 있다.
 * 이 파일은 조작 쪽 절반 — 등수와 팀이 한 박자로 붙지 않는지 — 만 검증한다(위 참조).
 */

/**
 * **U127** (2026-09-05 10:56 사용자 지시) — "최종 순위 발표 때 다른 팀 안 보이게 하고
 * 4위 팀만 공개, 이런 식으로 독립으로 구분."
 *
 * 조작 쪽 절반: [다음] 박자와 등수 버튼이 **독립 공개**를 켜는가. 출력 쪽(다른 팀 DOM 부재)은
 * `src/scenes/award.test.ts`의 "시상 등수 단독 공개 (U127)"가 지킨다.
 */
describe('등수 단독 공개 조작 (U127)', () => {
  it('[다음] 박자가 고르는 등수는 전부 독립 공개다', () => {
    const state = reducer(createInitialState(), { type: 'p2/unlock' });
    let cursor = state;
    for (const beat of walkBeats(state)) {
      for (const action of beat.actions) cursor = reducer(cursor, action);
      if (cursor.sceneOpts.award.selectedRank !== null && cursor.sceneOpts.award.step === 'reveal') {
        expect(cursor.sceneOpts.award.solo).toBe(true);
      }
    }
  });

  it('등수 박자는 팀을 함께 열지 않는다 — 독립 공개 안에서도 두 박자다', () => {
    let state = reducer(createInitialState(), { type: 'p2/unlock' });
    state = reducer(state, { type: 'award/step', step: 'total' });
    const beat = nextAwardBeat(state.sceneOpts.award, 4, true, true)!;
    expect(beat.label).toBe('4위 등수 노출');
    for (const action of beat.actions) state = reducer(state, action);
    expect(state.sceneOpts.award).toMatchObject({ solo: true, selectedTeamRevealed: false });
  });

  it('상태 줄이 무대의 세 상황을 각각 다른 문장으로 말한다', () => {
    const base = createInitialState().sceneOpts.award;
    expect(soloStatusLine(base, 'total')).toContain('아직 등수를 띄우지 않았습니다');

    let state = reducer(createInitialState(), { type: 'award/selectRank', rank: 4 });
    expect(soloStatusLine(state.sceneOpts.award, 'reveal')).toContain('4위 자리만');
    expect(soloStatusLine(state.sceneOpts.award, 'reveal')).toContain('다른 팀 화면에 없음');

    state = reducer(state, { type: 'award/revealSelectedTeam' });
    expect(soloStatusLine(state.sceneOpts.award, 'reveal')).toContain('4위 팀 공개됨');

    const stacked = reducer(createInitialState(), { type: 'award/selectRank', rank: 4, solo: false });
    expect(soloStatusLine(stacked.sceneOpts.award, 'reveal')).toContain('누적 무대');
  });

  it('등수 버튼은 큐시트와 같은 꼴찌부터 순서로 세운다', () => {
    // 렌더는 DOM이 없어 부를 수 없다 — 소스에서 정렬 뒤집기를 확인한다.
    expect(source).toContain('[...awardRankChoices(n)].reverse()');
    expect(source).toContain('`${rank}위 발표`');
  });

  it('등수 버튼은 위험(붉은) 버튼이 아니다 — 정상 진행 경로다', () => {
    const picker = source.slice(source.indexOf("class: 'award-rank-picker'"));
    const button = picker.slice(0, picker.indexOf('revealrow'));
    expect(button).toContain('btn btn--tiny');
    expect(button).not.toContain('btn--danger');
  });
});
