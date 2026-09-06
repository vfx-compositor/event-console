import { describe, expect, it } from 'vitest';
import { createInitialState, getEvent, reducer } from '../state';
import { toHTML, toText } from '../vdom';
import { resetAnimations } from './anim';
import { tick, view } from './award';
import { declOf, positiveLetterSpacings, rowOffsets, section } from './luxe-css.testkit';
import { rowStep, rowsTop } from './luxe-grid';

const aw = section('════ 시상'); // 시상이 display.css의 마지막 섹션이다

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function awardState() {
  let state = createInitialState();
  for (const [i, [teamId, name, color, delta]] of ([
    ['t1', '알파', '#a10101', 400],
    ['t2', '브라보', '#b20202', 300],
    ['t3', '찰리', '#c30303', 200],
    ['t4', '델타', '#d40404', 100],
  ] as const).entries()) {
    state = reducer(state, {
      type: 'team/patch',
      teamId,
      patch: { name, color, logoAssetId: `secret-logo-${teamId}` },
    });
    state = reducer(state, {
      type: 'ledger/manual',
      teamId,
      delta,
      reason: '시상 테스트',
      now: i + 1,
    });
  }
  return reducer(state, { type: 'award/step', step: 'reveal' });
}

/**
 * U127 (2026-09-05 10:56 사용자 지시) — "최종 순위 발표 때 다른 팀 안 보이게 하고 4위 팀만 공개,
 * 이런 식으로 독립으로 구분."
 *
 * 계약은 **가리기가 아니라 렌더 안 함**이다: 공개하지 않은 팀은 물론이고 **이미 공개한 팀**도
 * 다음 등수로 넘어가는 순간 DOM에서 사라진다.
 */
describe('시상 등수 단독 공개 (U127)', () => {
  const SECRETS = {
    t1: ['알파', '400점', '#a10101', 'secret-logo-t1'],
    t2: ['브라보', '300점', '#b20202', 'secret-logo-t2'],
    t3: ['찰리', '200점', '#c30303', 'secret-logo-t3'],
    t4: ['델타', '100점', '#d40404', 'secret-logo-t4'],
  } as const;

  /** 이 팀들 것이 HTML 어디에도 없어야 한다 */
  function expectAbsent(html: string, teams: (keyof typeof SECRETS)[]): void {
    for (const team of teams) for (const secret of SECRETS[team]) expect(html).not.toContain(secret);
  }

  it('4위 팀을 공개해도 나머지 세 팀은 DOM에 없다', () => {
    let state = reducer(awardState(), { type: 'award/selectRank', rank: 4 });
    state = reducer(state, { type: 'award/revealSelectedTeam' });
    const html = toHTML(view(state));
    const text = toText(view(state));

    expect(text).toContain('4위');
    expect(text).toContain('델타');
    expect(text).toContain('100점');
    expectAbsent(html, ['t1', 't2', 't3']);
  });

  it('3위로 넘어가면 이미 공개한 4위 팀도 화면에서 사라진다', () => {
    let state = reducer(awardState(), { type: 'award/selectRank', rank: 4 });
    state = reducer(state, { type: 'award/revealSelectedTeam' });
    state = reducer(state, { type: 'award/selectRank', rank: 3 });
    const html = toHTML(view(state));
    const text = toText(view(state));

    expect(text).toContain('3위');
    expect(text).not.toContain('4위');
    // 이력 칸 자체가 없다 — 빈 상자로도 남지 않는다
    expect(html).not.toContain('award__reveal-history');
    expect(html).not.toContain('award__history-card');
    expectAbsent(html, ['t1', 't2', 't3', 't4']);
  });

  it('4위 → 3위 → 2위 → 1위를 한 장씩 독립으로 공개한다', () => {
    let state = awardState();
    const expected = [
      [4, 'delta', '델타', '100점', ['t1', 't2', 't3']],
      [3, 'charlie', '찰리', '200점', ['t1', 't2', 't4']],
      [2, 'bravo', '브라보', '300점', ['t1', 't3', 't4']],
      [1, 'alpha', '알파', '400점', ['t2', 't3', 't4']],
    ] as const;

    for (const [rank, , name, points, others] of expected) {
      state = reducer(state, { type: 'award/selectRank', rank });
      // 첫 박자 — 등수 자리만. 어느 팀도 DOM에 없다.
      let html = toHTML(view(state));
      expect(toText(view(state))).toContain(`${rank}위`);
      expectAbsent(html, ['t1', 't2', 't3', 't4']);

      // 둘째 박자 — 그 팀 한 장만.
      state = reducer(state, { type: 'award/revealSelectedTeam' });
      html = toHTML(view(state));
      const text = toText(view(state));
      expect(text).toContain(name);
      expect(text).toContain(points);
      expectAbsent(html, [...others]);
    }
  });

  it('단독 공개 무대에는 is-solo 표식이 붙고 격자가 한 칸으로 접힌다', () => {
    const state = reducer(awardState(), { type: 'award/selectRank', rank: 4 });
    const html = toHTML(view(state));

    expect(html).toContain('award--reveal is-solo');
    expect(html).toContain('data-solo="true"');
    expect(declOf(aw, '.award--reveal.is-solo .award__reveal-stage', 'grid-template-columns')).toBe(
      'minmax(0, 1fr)',
    );
  });

  it('solo:false를 명시하면 예전 누적 무대가 그대로 선다', () => {
    let state = reducer(awardState(), { type: 'award/selectRank', rank: 4, solo: false });
    state = reducer(state, { type: 'award/revealSelectedTeam' });
    state = reducer(state, { type: 'award/selectRank', rank: 3, solo: false });
    const html = toHTML(view(state));

    expect(html).toContain('award__reveal-history');
    expect(html).toContain('award__history-card');
    expect(html).not.toContain('is-solo');
    expect(toText(view(state))).toContain('델타');
  });

  /**
   * 합계가 전부 0이면 `orderByTotal`의 정렬은 팀 등록 순서(`activeTeamIds`)로 안정된다.
   * 등수 버튼을 눌러도 같은 팀이 같은 등수에 서야 재발표에서 순서가 뒤집히지 않는다.
   */
  it('합계 0 동률에서도 등수→팀 대응이 안정적이다', () => {
    let state = createInitialState();
    for (const [teamId, name] of [
      ['t1', '알파'],
      ['t2', '브라보'],
      ['t3', '찰리'],
      ['t4', '델타'],
    ] as const) {
      state = reducer(state, { type: 'team/patch', teamId, patch: { name } });
    }
    for (const [rank, name] of [
      [1, '알파'],
      [2, '브라보'],
      [3, '찰리'],
      [4, '델타'],
    ] as const) {
      let shown = reducer(state, { type: 'award/selectRank', rank });
      shown = reducer(shown, { type: 'award/revealSelectedTeam' });
      const text = toText(view(shown));
      expect(text).toContain(`${rank}위`);
      expect(text).toContain(name);
      // 두 번 렌더해도 같은 팀이다 (정렬이 흔들리지 않는다)
      expect(toText(view(shown))).toBe(text);
    }
  });

  it('2부 잠금 중 단독 공개 카드에는 2부 문자열이 없다 (P3)', () => {
    let state = reducer(awardState(), { type: 'award/selectRank', rank: 4 });
    state = reducer(state, { type: 'award/revealSelectedTeam' });
    expect(state.p2.unlocked).toBe(false);
    expect(toHTML(view(state))).not.toMatch(/2부|p2:/);
  });
});

describe('시상 스포트라이트 리빌', () => {
  it('직접 고른 등수만 먼저 표시하고 해당 팀 정보는 DOM에도 넣지 않는다', () => {
    const state = reducer(awardState(), { type: 'award/selectRank', rank: 2 });
    const html = toHTML(view(state));
    const text = toText(view(state));

    expect(text).toContain('2위');
    expect(text).toContain('2위 팀은');
    for (const secret of ['브라보', '300점', '#b20202', 'secret-logo-t2']) {
      expect(html).not.toContain(secret);
    }
  });

  it('두 번째 박자에는 직접 고른 등수의 팀과 점수를 공개한다', () => {
    let state = reducer(awardState(), { type: 'award/selectRank', rank: 2 });
    state = reducer(state, { type: 'award/revealSelectedTeam' });
    const text = toText(view(state));

    expect(text).toContain('2위');
    expect(text).toContain('브라보');
    expect(text).toContain('300점');
  });

  it('첫 입력에는 다음 등수만 스포트라이트하고 팀 정보는 숨긴다', () => {
    const state = reducer(awardState(), { type: 'award/revealNext' });
    const html = toHTML(view(state));
    const text = toText(view(state));

    expect(html).toContain('award__reveal-focus');
    expect(text).toContain('4위');
    expect(text).not.toMatch(/1위|2위|3위/);
    expect(text).not.toContain('델타');
  });

  it('등수만 공개한 HTML에는 미공개 팀의 이름·점수·색·logo id가 없다', () => {
    const state = reducer(awardState(), { type: 'award/revealNext' });
    const html = toHTML(view(state));

    for (const secret of [
      '알파',
      '브라보',
      '찰리',
      '델타',
      '400점',
      '300점',
      '200점',
      '100점',
      '#a10101',
      '#b20202',
      '#c30303',
      '#d40404',
      'secret-logo-t1',
      'secret-logo-t2',
      'secret-logo-t3',
      'secret-logo-t4',
    ]) {
      expect(html).not.toContain(secret);
    }
  });

  it('다음 입력에는 팀을 이력으로 옮기고 그 다음 입력에는 다음 등수만 연다', () => {
    let state = awardState();
    state = reducer(state, { type: 'award/revealNext' });
    state = reducer(state, { type: 'award/revealNext' });

    let text = toText(view(state));
    expect(text).toContain('4위');
    expect(text).toContain('델타');
    expect(text).toContain('100점');
    expect(text).not.toContain('3위');

    state = reducer(state, { type: 'award/revealNext' });
    text = toText(view(state));
    expect(text).toContain('4위');
    expect(text).toContain('델타');
    expect(text).toContain('3위');
    expect(text).not.toContain('찰리');
  });

  it('비동점 총점 순서대로 4위부터 1위까지 팀과 점수를 모두 공개한다', () => {
    let state = awardState();
    const expected = [
      ['4위', '델타', '100점'],
      ['3위', '찰리', '200점'],
      ['2위', '브라보', '300점'],
      ['1위', '알파', '400점'],
    ] as const;

    for (const [rank, team, points] of expected) {
      state = reducer(state, { type: 'award/revealNext' });
      let text = toText(view(state));
      expect(text).toContain(rank);
      expect(text).not.toContain(team);
      expect(text).not.toContain(points);

      state = reducer(state, { type: 'award/revealNext' });
      text = toText(view(state));
      expect(text).toContain(rank);
      expect(text).toContain(team);
      expect(text).toContain(points);
    }

    expect(toText(view(state))).toContain('모든 팀 공개 완료');
  });
});

describe('시상 표·합산 단계', () => {
  it('1부 표는 순위 pill · 팀 캡슐 · 점수를 실제 state에서 만든다', () => {
    const state = reducer(awardState(), { type: 'award/step', step: 'p1' });
    const html = toHTML(view(state));
    const text = toText(view(state));

    expect(text).toContain('1부 순위');
    expect(text).toMatch(/RANK\s*TEAM\s*EVENT SCORE\s*POINTS/);
    expect(text).toContain('알파');
    expect(text).toContain('400점');
    expect(html).toContain('--team:#a10101');
    expect(count(html, /class="luxe-row aw__row/g)).toBe(4);
    // 1위만 골드 링을 받는다
    expect(count(html, /aw__row is-first/g)).toBe(1);
  });

  it('2부 잠금 중에는 2부 표를 만들지 않고 1부 표로 대체한다', () => {
    const state = reducer(awardState(), { type: 'award/step', step: 'p2' });
    const text = toText(view(state));
    expect(text).toContain('1부 순위');
    expect(text).not.toContain('2부 순위');
  });

  it('합산 단계는 카운트업 슬롯만 두고 숫자를 마크업에 굳히지 않는다', () => {
    const state = reducer(awardState(), { type: 'award/step', step: 'total' });
    const html = toHTML(view(state));

    expect(html).toContain('종합 합산');
    expect(count(html, /data-bind="awardtotal"/g)).toBe(4);
    expect(count(html, /class="luxe-value aw__total-num"/g)).toBe(4);
    /**
     * 총점 슬롯이 비어(0) 있어야 한다 — tick()의 카운트업이 채운다.
     *
     * 예전에는 `'400점'`이 마크업에 없는지로 봤다. U138에서 BONUS 칸이 생기면서 이 픽스처
     * (점수를 전부 `ledger/manual`로 준다)에서는 그 문자열이 **BONUS 칩의 `title`에
     * 정당하게** 들어간다. 전역 부재 대신 슬롯 자체를 보면 원래 묻던 것을 더 정확히 본다.
     */
    expect(count(html, /aw__total-num" data-bind="awardtotal" data-team="t\d">0</g)).toBe(4);
  });

  it('표·합산 행이 tick 없이도 idx·step 간격으로 흩어진다 (D4)', () => {
    // 시상 tick은 합산 카운트업만 담당한다. 배치는 렌더 시점에 끝나야 한다.
    for (const step of ['p1', 'total'] as const) {
      const state = reducer(awardState(), { type: 'award/step', step });
      const html = toHTML(view(state));
      const s = rowStep(4);
      expect(rowOffsets(html)).toEqual([0, s, s * 2, s * 3]);
    }
  });

  it('표·합산은 리더보드와 같은 격자 수치를 쓴다', () => {
    const state = reducer(awardState(), { type: 'award/step', step: 'p1' });
    const html = toHTML(view(state));
    expect(html).toContain(`--step:${rowStep(4)}px`);
    expect(html).toContain(`--rows-top:${rowsTop(4)}px`);
    expect(html).toContain('class="luxe-board"');
    expect(html).toContain('luxe-headbar aw__headbar');
  });
});

describe('시상 Broadcast Luxe 스킨', () => {
  it('공개 이력 카드는 pill + 흰 캡슐 리듬을 그대로 쓴다', () => {
    let state = awardState();
    state = reducer(state, { type: 'award/revealNext' });
    state = reducer(state, { type: 'award/revealNext' });
    const html = toHTML(view(state));

    expect(html).toContain('luxe-pill award__history-pos');
    expect(html).toContain('luxe-capsule award__history-body');
    expect(html).toContain('luxe-avatar');
    expect(declOf(aw, '.award__history-card > .award__history-pos', 'width')).toBe('150px');
    expect(declOf(aw, '.award__history-card > .award__history-body', 'left')).toBe('132px');
  });

  it('1위 이력 카드는 리더보드와 같은 골드 링을 쓴다', () => {
    expect(declOf(aw, '.award__history-card.is-winner > .award__history-pos', 'box-shadow')).toBe(
      'inset 0 0 0 3px var(--accent), var(--luxe-pill-shadow)',
    );
  });

  it('스포트라이트 패널과 미공개 플레이스홀더가 luxe 톤이다', () => {
    expect(declOf(aw, '.award__reveal-focus', 'background')).toBe('var(--luxe-panel)');
    expect(declOf(aw, '.award__reveal-focus', 'border')).toBe('1px solid var(--luxe-panel-line)');
    expect(declOf(aw, '.award__focus-rank', 'background')).toBe('var(--luxe-numeral-grad)');
    expect(declOf(aw, '.award__focus-wait', 'color')).toBe('var(--fg-mute)');
    expect(declOf(aw, '.award__focus-mask', 'border-radius')).toBe('999px');
  });

  it('우승 화면은 팀 아바타 링을 크게 세우고 지면은 luxe stage를 쓴다', () => {
    const state = reducer(awardState(), { type: 'award/step', step: 'winner' });
    const html = toHTML(view(state));
    expect(html).toContain('winner__avatar luxe-avatar');
    expect(html).toContain('data-confetti="1"');
    expect(declOf(aw, '.award--winner', 'background')).toContain('var(--luxe-stage)');
    expect(declOf(aw, '.winner__avatar', 'width')).toBe('240px');
  });

  it('상단 마크에 불꽃 엠블럼을 쓰지 않는다 (인계 계약 §0-1)', () => {
    let state = awardState();
    state = reducer(state, { type: 'award/revealNext' });
    const revealHtml = toHTML(view(state));
    const selectedHtml = toHTML(
      view(reducer(awardState(), { type: 'award/selectRank', rank: 2 })),
    );

    for (const html of [revealHtml, selectedHtml]) {
      // emblem.ts가 그리는 마크업 — 클래스·SVG·불꽃 path 어느 것도 남지 않아야 한다
      expect(html).not.toContain('class="emblem');
      expect(html).not.toContain('emblem__ring');
      expect(html).not.toContain('emblem__flame');
      expect(html).not.toContain('<svg');
      expect(html).not.toContain('M105 28');
      // 대신 리더보드 마스트헤드와 같은 텍스트 마크가 선다
      expect(html).toContain('award__mark-name');
      expect(toText(view(state))).toContain('EVENT CONSOLE');
    }
  });

  it('시상 블록에는 양수 자간이 하나도 없다', () => {
    expect(positiveLetterSpacings(aw)).toEqual([]);
  });
});

/**
 * U33 — "시상에도 누적성적 보이게". 총점 하나만 띄우던 자리에 종목별 내역을 붙인다.
 * 숫자는 리더보드와 같은 원장 합산이고, **미공개 팀은 여전히 DOM에 흔적이 없다.**
 */
describe('시상 누적 내역 (U33)', () => {
  /** 1부 네 종목을 실제로 확정해 종목별 점수가 원장에 쌓인 상태 */
  function scoredState() {
    let state = createInitialState();
    for (const [i, [teamId, name]] of ([
      ['t1', '알파'],
      ['t2', '브라보'],
      ['t3', '찰리'],
      ['t4', '델타'],
    ] as const).entries()) {
      state = reducer(state, { type: 'team/patch', teamId, patch: { name } });
      void i;
    }
    for (const eventId of ['curling', 'newspaper', 'sticky', 'sync'] as const) {
      for (const [i, teamId] of (['t1', 't2', 't3', 't4'] as const).entries()) {
        state = reducer(state, { type: 'p1/rank', eventId, teamId, rank: i + 1 });
      }
      state = reducer(state, { type: 'p1/confirm', eventId, now: 1_700_000_000_000 });
    }
    return reducer(state, { type: 'award/step', step: 'reveal' });
  }

  const eventNames = (state = scoredState()): string[] =>
    (['curling', 'newspaper', 'sticky', 'sync'] as const).map((id) => getEvent(state, id).name);

  it('공개된 팀은 총점과 함께 종목별 점수를 보여 준다', () => {
    let state = reducer(scoredState(), { type: 'award/selectRank', rank: 1 });
    state = reducer(state, { type: 'award/revealSelectedTeam' });
    const html = toHTML(view(state));
    const text = toText(view(state));

    expect(html).toContain('award__focus-breakdown');
    for (const name of eventNames()) expect(text).toContain(name);
    // 총점은 그대로 남는다 — 내역이 총점을 대체하지 않는다
    expect(html).toContain('award__focus-points');
  });

  it('등수만 공개한 박자에는 종목별 점수도 DOM에 없다', () => {
    const state = reducer(scoredState(), { type: 'award/selectRank', rank: 2 });
    const html = toHTML(view(state));

    expect(html).not.toContain('award__focus-breakdown');
    // 아직 아무 팀도 공개되지 않았으므로 내역 칩 자체가 0개다
    expect(count(html, /class="award__breakdown /g)).toBe(0);
  });

  // U127 — 독립 공개가 기본이라 이력 무대는 `solo: false`를 명시해야 나온다.
  it('누적 무대(solo:false)의 이력 카드에도 팀별 종목 점수 행이 붙는다', () => {
    let state = reducer(scoredState(), { type: 'award/selectRank', rank: 4, solo: false });
    state = reducer(state, { type: 'award/revealSelectedTeam' });
    state = reducer(state, { type: 'award/selectRank', rank: 3, solo: false });
    const html = toHTML(view(state));

    // 4위는 이력으로 내려갔고, 3위는 아직 등수만 공개된 상태다
    expect(count(html, /class="award__breakdown award__history-breakdown"/g)).toBe(1);
    expect(html).not.toContain('award__focus-breakdown');
  });

  /**
   * U80 — 격자 상자(`.luxe-cells`)는 리더보드와 그대로 공유하되, 열 수는 1부 종목 수로
   * 고정한다. 1부 네 종목이 첫 줄을 정확히 채워야 2부가 다음 줄로 내려간다.
   */
  it('표·합산 단계는 리더보드 격자 상자에 1부 4열로 칩을 담는다', () => {
    for (const step of ['p1', 'total'] as const) {
      const state = reducer(scoredState(), { type: 'award/step', step });
      const html = toHTML(view(state));
      expect(count(html, /class="luxe-cells aw__cells"/g)).toBe(4);
      expect(count(html, /class="luxe-event-item aw__chip"/g)).toBe(16);
      expect(html).toContain('data-cols="4"');
    }
  });

  /**
   * U80 — 종목명은 화면에서 빠지고 순번 마커가 대신한다. 순서는 `P1_EVENT_ORDER` 고정이라
   * ①=컬링 … ④=몸으로 말해요가 매 방송 같다. 이름은 `title`/`aria-label`에만 남는다.
   */
  it('칩은 동그란 번호 + 값이고 종목명은 속성으로만 남는다', () => {
    const state = reducer(scoredState(), { type: 'award/step', step: 'p1' });
    const html = toHTML(view(state));
    const text = toText(view(state));

    // 팀 4개 × 1부 4종목 = 16개 마커, 값 옆에 번호가 1~4로 붙는다
    expect(count(html, /class="aw__chip-no" aria-hidden="true">[1-4]</g)).toBe(16);
    // 종목명은 텍스트 노드가 아니라 title·aria-label에 있다 (toText는 두 속성을 읽는다)
    for (const name of eventNames()) {
      expect(html).toContain(`title="${name} · `);
      expect(text).toContain(name);
    }
    // 라벨 span은 사라졌다 — 이름이 화면 글자로 되돌아오면 이 핀이 깨진다
    expect(html).not.toContain('luxe-event-label');
    expect(html).not.toContain('award__breakdown-label');
  });

  it('합산 단계 카운트업 슬롯은 내역이 붙어도 그대로다', () => {
    const state = reducer(scoredState(), { type: 'award/step', step: 'total' });
    const html = toHTML(view(state));
    expect(count(html, /data-bind="awardtotal"/g)).toBe(4);
    expect(count(html, /class="luxe-value aw__total-num"/g)).toBe(4);
  });

  it('2부 잠금 중에는 2부 문자열이 어디에도 없다 (P3)', () => {
    for (const step of ['p1', 'total', 'winner'] as const) {
      const state = reducer(scoredState(), { type: 'award/step', step });
      const html = toHTML(view(state));
      expect(html).not.toMatch(/2부|p2:/);
    }
    // 리빌 스포트라이트도 마찬가지
    let reveal = reducer(scoredState(), { type: 'award/selectRank', rank: 1 });
    reveal = reducer(reveal, { type: 'award/revealSelectedTeam' });
    expect(toHTML(view(reveal))).not.toMatch(/2부|p2:/);
  });

  it('2부를 열면 내역 끝에 2부 합계 한 칸이 붙는다', () => {
    let state = reducer(scoredState(), { type: 'p2/unlock' });
    state = reducer(state, { type: 'award/step', step: 'total' });
    const html = toHTML(view(state));
    const text = toText(view(state));

    expect(text).toContain('2부');
    // 1부 4종목 + 2부 합계 = 팀당 5칸. 열은 4로 고정이라 2부가 둘째 줄로 내려간다 (U80)
    expect(count(html, /class="luxe-event-item aw__chip/g)).toBe(20);
    expect(count(html, /class="luxe-event-item aw__chip aw__chip--p2"/g)).toBe(4);
    expect(html).toContain('data-cols="4"');
    // 2부 마커는 순번이 아니라 `2부` — 1부 칩과 문법은 같고 CSS가 채운 마커로 구분한다
    expect(count(html, /class="aw__chip-no" aria-hidden="true">2부</g)).toBe(4);
  });

  it('누적 내역에는 양수 자간이 없다', () => {
    expect(positiveLetterSpacings(aw)).toEqual([]);
    // U80 — 종목명 라벨이 사라지고 순번 마커가 그 자리를 받았다
    expect(declOf(aw, '.aw__chip-no', 'letter-spacing')).toBe('0');
    expect(declOf(aw, '.award__breakdown-pts', 'letter-spacing')).toBe('0');
  });
});

/**
 * U126 — [점수 전부 되돌리기] 뒤 시상 씬(1부·2부 표, 합산, 우승 팀)이 값으로도 깨지지
 * 않는지 본다. 4팀 전부 0점 동률이라 우승 팀 판정은 팀 순서(t1)로 결정된다.
 */
describe('점수 전부 되돌리기 후 시상 렌더 (U126)', () => {
  // `awardState()`(모듈 최상단, t1~t4에 400/300/200/100 수동 가감점)를 기반으로 삼는다 —
  // `scoredState()`는 위 describe 콜백 안에 클로저로 갇혀 있어 여기서 참조할 수 없다.
  function scoredThenReset() {
    let state = awardState();
    state = reducer(state, { type: 'p2/unlock' });
    return reducer(state, { type: 'ledger/reverseAll', reason: '리셋', now: 1_700_000_002_000 });
  }

  it('1부·2부·합산 표는 전부 0점으로 렌더되고 NaN이 없다', () => {
    for (const step of ['p1', 'p2', 'total'] as const) {
      const state = reducer(scoredThenReset(), { type: 'award/step', step });
      const html = toHTML(view(state));
      const text = toText(view(state));
      expect(html).not.toContain('NaN');
      expect(text).not.toContain('NaN');
      expect(count(html, /class="luxe-row aw__row/g)).toBe(4);
      // 1위 골드 링은 동률이어도 정확히 한 팀(팀 순서상 t1)에만 붙는다
      expect(count(html, /aw__row is-first/g)).toBe(1);
    }
    const p1Text = toText(view(reducer(scoredThenReset(), { type: 'award/step', step: 'p1' })));
    expect(p1Text).toContain('0점');
  });

  it('우승 화면은 동률이어도 팀 순서 1번(t1)을 챔피언으로 렌더한다', () => {
    const state = reducer(scoredThenReset(), { type: 'award/step', step: 'winner' });
    const html = toHTML(view(state));
    const text = toText(view(state));
    expect(html).not.toContain('NaN');
    expect(text).toContain('알파'); // t1 이름 (awardState/scoredState 공통)
    expect(text).toContain('0점');
  });

  it('tick()의 합산 카운트업도 0으로 채워지고 NaN이 없다', () => {
    resetAnimations('award:');
    const state = reducer(scoredThenReset(), { type: 'award/step', step: 'total' });
    const totals = new Map<string, { textContent: string }>(
      (['t1', 't2', 't3', 't4'] as const).map((id) => [id, { textContent: '' }]),
    );
    const board = {
      querySelector(sel: string) {
        const m = /^\[data-bind="awardtotal"\]\[data-team="([^"]+)"\]$/.exec(sel);
        return m ? (totals.get(m[1]) ?? null) : null;
      },
    };
    tick(board as unknown as HTMLElement, state, 1_700_000_010_000);
    for (const id of ['t1', 't2', 't3', 't4'] as const) {
      expect(totals.get(id)!.textContent).toBe('0');
    }
  });
});
