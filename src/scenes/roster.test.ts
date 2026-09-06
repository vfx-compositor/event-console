import { describe, expect, it } from 'vitest';

import { createInitialState, reducer } from '../state';
import { toHTML, toText } from '../vdom';
import { declOf, positiveLetterSpacings, section } from './luxe-css.testkit';
import { MAX_SEATS, panelColumns, parseRoster, seatBucket, seatCells, seatColumns, view } from './roster';
import type { AppState, P1EventId, TeamId } from '../types';

const rs = section('출전 명단', '제시어 카드');

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function withRoster(entries: Partial<Record<TeamId, string>>): AppState {
  let state = createInitialState();
  for (const [teamId, names] of Object.entries(entries)) {
    state = reducer(state, {
      type: 'p1/roster',
      eventId: 'curling',
      teamId: teamId as TeamId,
      text: names,
    });
  }
  return state;
}

function withVersus(state: AppState, pair: [TeamId, TeamId]): AppState {
  return reducer(state, { type: 'sceneOpts/patch', patch: { liveOverlay: { versus: pair } } });
}

function withEvent(state: AppState, eventId: P1EventId): AppState {
  return reducer(state, { type: 'sceneOpts/patch', patch: { roster: { eventId } } });
}

/**
 * 팀 수는 `teams/count`가 4로 고정(CONFIRMED_TEAM_COUNT)이라 리듀서로는 못 바꾼다.
 * view는 state의 순수 함수이므로, 예전 5~6팀 저장본을 렌더하는 상황을 상태로 직접 만든다.
 */
function withTeamCount(state: AppState, teamCount: number): AppState {
  return { ...state, teamCount };
}

describe('출전 명단 파싱·격자 계산', () => {
  it('콤마·줄바꿈을 모두 구분자로 보고 빈 칸을 버린다', () => {
    expect(parseRoster('샘플 참가자 19, 샘플 참가자 33\n, 샘플 참가자 17 ,')).toEqual(['샘플 참가자 19', '샘플 참가자 33', '샘플 참가자 17']);
    expect(parseRoster(undefined)).toEqual([]);
    expect(parseRoster('   ')).toEqual([]);
  });

  it('4팀은 2×2, 5~6팀은 3열로 두 줄을 유지한다', () => {
    expect(panelColumns(4)).toBe(2);
    expect(panelColumns(5)).toBe(3);
    expect(panelColumns(6)).toBe(3);
    for (const teams of [4, 5, 6]) {
      expect(Math.ceil(teams / panelColumns(teams))).toBe(2);
    }
  });

  it('이름 칸은 3칸까지 한 줄씩, 4칸부터 2열, 7칸부터 3열이다', () => {
    expect([1, 2, 3].map(seatColumns)).toEqual([1, 1, 1]);
    expect([4, 5, 6].map(seatColumns)).toEqual([2, 2, 2]);
    expect([7, 8, 9].map(seatColumns)).toEqual([3, 3, 3]);
    // 어느 칸 수든 세 줄을 넘지 않는다
    for (let n = 1; n <= MAX_SEATS; n += 1) {
      expect(Math.ceil(n / seatColumns(n))).toBeLessThanOrEqual(3);
    }
  });

  it('열 수와 CSS 규격 구간이 같은 칸 수를 본다', () => {
    // 둘이 다른 수를 보면 행 수가 어긋나 패널을 넘친다 (7명 넘침 사고)
    for (let n = 1; n <= 12; n += 1) {
      expect(seatBucket(n)).toBe(Math.min(n, 7));
      expect(seatColumns(seatBucket(n))).toBe(seatColumns(n));
    }
  });

  it('상한을 넘으면 8명까지 적고 넘침 배지를 한 칸 쓴다', () => {
    expect(MAX_SEATS).toBe(9);
    expect(seatCells(['가', '나']).overflow).toBe(0);
    expect(seatCells(Array.from({ length: 9 }, (_, i) => `n${i}`)).names).toHaveLength(9);
    const twelve = seatCells(Array.from({ length: 12 }, (_, i) => `n${i}`));
    expect(twelve.names).toHaveLength(8);
    expect(twelve.overflow).toBe(4);
    // 이름 8 + 배지 1 = 9칸, 상한 그대로
    expect(twelve.names.length + 1).toBe(MAX_SEATS);
  });
});

describe('출전 명단 정보 계약', () => {
  it('마스트헤드에 종목명과 출전명단 라벨을 세운다', () => {
    const text = toText(view(createInitialState()));
    expect(text).toContain('출전명단');
    expect(text).toContain('컬링');
  });

  it('리더보드의 행 표를 쓰지 않는다', () => {
    // U28: 순위·헤더바·행 격자는 명단에 맞지 않는다
    const html = toHTML(view(withRoster({ t1: '샘플 참가자 19' })));
    expect(html).not.toContain('luxe-headbar');
    expect(html).not.toContain('luxe-row');
    expect(html).not.toContain('luxe-rows');
    expect(html).not.toContain('--step:');
    expect(html).not.toContain('--row-index');
    expect(toText(view(createInitialState()))).not.toMatch(/RANK|NO\.|PLAYERS|COUNT/);
  });

  it('팀마다 패널 하나를 두고 실제 state의 팀명·팀 색·선수·인원을 쓴다', () => {
    const state = withRoster({ t1: '샘플 참가자 19, 샘플 참가자 33', t2: '샘플 참가자 17' });
    const html = toHTML(view(state));
    const text = toText(view(state));

    expect(count(html, /class="rs__panel/g)).toBe(4);
    expect(html).toContain('--team:#c0453b');
    expect(html).toContain('data-team="t1"');
    expect(text).toContain('샘플 참가자 19');
    expect(text).toContain('샘플 참가자 33');
    expect(text).toContain('2명');
    expect(text).toContain('1명');
  });

  it('선수 한 명당 이름 캡슐 하나를 만든다', () => {
    const html = toHTML(view(withRoster({ t1: '가, 나, 다' })));
    expect(count(html, /class="rs__seat"/g)).toBe(3);
    expect(html).toContain('data-seats="3"');
    expect(html).toContain('--seat-cols:1');
  });

  it('4명 이상이면 이름 캡슐을 2열로 접는다', () => {
    const html = toHTML(view(withRoster({ t1: '가, 나, 다, 라, 마' })));
    expect(html).toContain('data-seats="5"');
    expect(html).toContain('--seat-cols:2');
  });

  it('명단이 없는 팀은 mute 플레이스홀더로 남기고 인원을 세지 않는다', () => {
    const state = withRoster({ t1: '샘플 참가자 19' });
    const html = toHTML(view(state));
    expect(count(html, /rs__panel[^"]*is-empty/g)).toBe(3);
    expect(count(html, /rs__seat--none/g)).toBe(3);
    expect(toText(view(state))).toContain('명단 미정');
    expect(count(toText(view(state)), /미정/g)).toBe(6); // 배지 3 + 캡슐 3
  });

  it('2부 잠금 — 1부 종목만 렌더하고 2부 문자열을 만들지 않는다', () => {
    const html = toHTML(view(withRoster({ t1: '샘플 참가자 19' })));
    expect(html).not.toMatch(/2부|p2:|data-col="s[123]"/);
  });

  it('5·6팀은 3열 그리드로 넘어간다', () => {
    const html = toHTML(view(withTeamCount(withRoster({ t1: '가' }), 6)));
    expect(html).toContain('data-cols="3"');
    expect(html).toContain('--panel-cols:3');
    expect(count(html, /class="rs__panel/g)).toBe(6);
  });

  it('점수만 바뀌면 view 마크업이 같아 진입 모션이 재시작되지 않는다', () => {
    const before = withRoster({ t1: '샘플 참가자 19' });
    let after = reducer(before, { type: 'p1/rank', eventId: 'sticky', teamId: 't1', rank: 1 });
    after = reducer(after, { type: 'p1/confirm', eventId: 'sticky', now: 1_700_000_000_000 });
    expect(toHTML(view(after))).toBe(toHTML(view(before)));
  });
});

describe('대결 종목 레이아웃', () => {
  const duel = () => withVersus(withRoster({ t1: '샘플 참가자 19', t3: '샘플 참가자 17' }), ['t1', 't3']);

  it('versus가 없으면 대결 마크업 자체를 만들지 않는다', () => {
    const html = toHTML(view(withRoster({ t1: '샘플 참가자 19' })));
    expect(html).not.toContain('rs__duel');
    expect(html).not.toContain('rs__vs');
    expect(html).not.toContain('rs__bench');
    expect(html).not.toContain('data-side');
    expect(html).toContain('rs__grid');
  });

  it('두 팀을 좌·우 큰 패널로 세우고 가운데에 VS를 둔다', () => {
    const html = toHTML(view(duel()));
    expect(html).toContain('rs__duel-stage');
    expect(count(html, /rs__panel--duel/g)).toBe(2);
    expect(html).toContain('data-side="left"');
    expect(html).toContain('data-side="right"');
    expect(toText(view(duel()))).toContain('VS');
    expect(html).not.toContain('rs__grid');
  });

  it('좌·우 순서는 versus 배열 순서를 그대로 따른다 (오버레이 보더와 일치)', () => {
    const html = toHTML(view(duel()));
    const left = html.indexOf('data-side="left"');
    const right = html.indexOf('data-side="right"');
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(right);
    // 뒤집으면 좌·우가 같이 뒤집힌다
    const flipped = toHTML(view(withVersus(withRoster({ t1: '샘플 참가자 19', t3: '샘플 참가자 17' }), ['t3', 't1'])));
    expect(flipped.indexOf('data-team="t3"')).toBeLessThan(flipped.indexOf('data-team="t1"'));
  });

  it('대결 모드에서는 현재 대결하는 두 팀만 렌더한다', () => {
    const html = toHTML(view(duel()));
    expect(count(html, /rs__panel--duel/g)).toBe(2);
    expect(html).not.toContain('rs__bench');
    expect(html).not.toContain('rs__chip');
  });

  it('팀 수가 늘어도 대결 두 팀 외의 명단은 DOM에 노출하지 않는다', () => {
    const six = toHTML(view(withVersus(withTeamCount(withRoster({ t1: '가' }), 6), ['t1', 't3'])));
    expect(count(six, /rs__panel--duel/g)).toBe(2);
    expect(six).not.toContain('rs__bench');
    expect(six).not.toContain('rs__chip');
  });

  it('대결 격자는 본문 높이를 모두 쓰고 VS는 배경 없는 큰 타이포로 보여 준다', () => {
    expect(declOf(rs, '.rs__duel-stage', 'height')).toBe('100%');
    expect(declOf(rs, '.rs__vs', 'background')).toBe('transparent');
    expect(declOf(rs, '.rs__vs', 'box-shadow')).toBe('none');
    expect(declOf(rs, '.rs__vs', 'border-radius')).toBe('0');
    expect(Number.parseInt(declOf(rs, '.rs__vs', 'font-size') ?? '0', 10)).toBeGreaterThanOrEqual(96);
  });

  // U55 — 대결 레이아웃은 컬링에만 있다. 신문지 달리기·끈끈이 낚시는 두 팀씩 나와도 기록·점수로
  // 순위를 정하는 종목이라, versus가 (직전 컬링 대결의 잔여값 등으로) 남아 있어도 그리드를 지킨다.
  it.each(['newspaper', 'sticky', 'sync'] as const)(
    '%s는 대결 종목이 아니라 versus가 있어도 4팀 그리드를 유지한다',
    (eventId) => {
      const state = withEvent(
        withVersus(withRoster({ t1: '샘플 참가자 19', t3: '샘플 참가자 17' }), ['t1', 't3']),
        eventId,
      );
      const html = toHTML(view(state));
      expect(html).toContain('rs__grid');
      expect(count(html, /class="rs__panel/g)).toBe(4);
      expect(html).not.toContain('rs__duel');
      expect(html).not.toContain('rs__vs');
      expect(html).not.toContain('data-side');
    },
  );

  it('컬링으로 돌아오면 같은 versus가 다시 대결 레이아웃을 그린다', () => {
    const state = withEvent(
      withVersus(withRoster({ t1: '샘플 참가자 19', t3: '샘플 참가자 17' }), ['t1', 't3']),
      'curling',
    );
    const html = toHTML(view(state));
    expect(html).toContain('rs__duel-stage');
    expect(html).not.toContain('rs__grid');
  });
});

/**
 * U61 — 신문지 달리기는 두 팀씩 한 조로 달린다. 이번 조 두 팀만 보여 주는 보드를 추가하되
 * **대결이 아니다** — VS 타이포도, 대칭 무대도 쓰지 않는다. U55 결정을 좁힐 뿐 뒤집지 않는다.
 */
describe('조별 명단 보드 (U61)', () => {
  /** `withRoster`는 컬링 명단만 채운다 — 조별 보드를 볼 종목에도 같은 명단을 넣어 준다. */
  function withEventRoster(eventId: P1EventId, entries: Partial<Record<TeamId, string>>): AppState {
    let state = createInitialState();
    for (const [teamId, names] of Object.entries(entries)) {
      state = reducer(state, {
        type: 'p1/roster',
        eventId,
        teamId: teamId as TeamId,
        text: names,
      });
    }
    return withEvent(state, eventId);
  }

  function heatState(eventId: P1EventId = 'newspaper', versus: [TeamId, TeamId] | null = ['t1', 't3']) {
    let state = withEventRoster(eventId, { t1: '샘플 참가자 19, 샘플 참가자 33', t3: '샘플 참가자 17, 샘플 참가자 16' });
    if (versus) state = withVersus(state, versus);
    return reducer(state, { type: 'sceneOpts/patch', patch: { roster: { scope: 'heat' } } });
  }

  it('이번 조 두 팀만 같은 패널 두 칸으로 그린다', () => {
    const state = heatState();
    const html = toHTML(view(state));
    expect(html).toContain('rs__grid--heat');
    expect(html).toContain('data-cols="2"');
    expect(count(html, /class="rs__panel/g)).toBe(2);
    expect(html).toContain('data-team="t1"');
    expect(html).toContain('data-team="t3"');
    expect(html).not.toContain('data-team="t2"');
    expect(html).not.toContain('data-team="t4"');
    expect(toText(view(state))).toContain('샘플 참가자 17');
  });

  it('대결이 아니다 — VS 글자도 대결 무대도 만들지 않는다', () => {
    const state = heatState();
    const html = toHTML(view(state));
    expect(html).not.toContain('rs__duel');
    expect(html).not.toContain('rs__vs');
    expect(html).not.toContain('rs__panel--duel');
    expect(html).not.toContain('data-side');
    expect(toText(view(state))).not.toContain('VS');
  });

  it('좌·우 순서는 대결과 같은 규칙 — versus 배열 순서 그대로다', () => {
    const html = toHTML(view(heatState('newspaper', ['t3', 't1'])));
    expect(html.indexOf('data-team="t3"')).toBeLessThan(html.indexOf('data-team="t1"'));
  });

  it('조를 고르지 않았으면 두 팀을 지어내지 않고 전체 명단으로 떨어진다', () => {
    const html = toHTML(view(heatState('newspaper', null)));
    expect(count(html, /class="rs__panel/g)).toBe(4);
    expect(html).not.toContain('rs__grid--heat');
    expect(html).toContain('rs__grid');
  });

  it('scope가 all이면 지금까지처럼 4팀 그리드다 (기존 동작 유지)', () => {
    const state = withEvent(withVersus(withRoster({ t1: '샘플 참가자 19' }), ['t1', 't3']), 'newspaper');
    const html = toHTML(view(state));
    expect(state.sceneOpts.roster.scope).toBe('all');
    expect(count(html, /class="rs__panel/g)).toBe(4);
    expect(html).not.toContain('rs__grid--heat');
  });

  it('컬링은 scope와 무관하게 대결 레이아웃을 지킨다', () => {
    const html = toHTML(view(heatState('curling')));
    expect(html).toContain('rs__duel-stage');
    expect(toText(view(heatState('curling')))).toContain('VS');
    expect(html).not.toContain('rs__grid--heat');
  });

  it('조별 격자는 전체 격자와 같은 패널 규격을 쓰되 두 칸을 세로 가운데로 모은다', () => {
    expect(declOf(rs, '.rs__grid--heat', 'align-content')).toBe('center');
    expect(declOf(rs, '.rs__grid--heat', 'grid-auto-rows')).toBe('minmax(0, 400px)');
    // 새 클래스는 CSS 규칙이 있어야 한다 (JS 생성 class 스캔 규칙)
    expect(rs).toContain('.rs__grid--heat');
  });

  it('2부 잠금 — 조별 보드도 2부 문자열을 만들지 않는다', () => {
    expect(toHTML(view(heatState()))).not.toMatch(/2부|p2:|data-col="s[123]"/);
  });
});

describe('출전 명단 Broadcast Luxe 응용', () => {
  it('보드·마스트헤드·아바타 링은 공용 골격을 그대로 쓴다', () => {
    const html = toHTML(view(createInitialState()));
    for (const cls of ['luxe-board', 'luxe-mast', 'luxe-mast__eyebrow', 'luxe-mast__title', 'luxe-avatar']) {
      expect(html).toContain(cls);
    }
  });

  it('이름 캡슐이 흰 캡슐 언어를 쓰고 이 씬에서 가장 큰 글자다', () => {
    expect(declOf(rs, '.rs__seat', 'background')).toBe('var(--luxe-capsule-bg)');
    expect(declOf(rs, '.rs__seat', 'color')).toBe('var(--luxe-capsule-ink)');
    expect(declOf(rs, '.rs__seat-name', 'font-size')).toBe('var(--seat-fs)');
    // 기본 4팀 2명 규격이 팀명(32px)보다 크다
    expect(declOf(rs, ".rs__panel[data-seats='2']", '--seat-fs')).toBe('34px');
    expect(declOf(rs, '.rs__team', 'font-size')).toBe('32px');
  });

  it('팀 색은 아바타 링과 팀명 pill 테두리에만 쓴다', () => {
    expect(declOf(rs, '.rs__team', 'border')).toContain('color-mix(in srgb, var(--team)');
    expect(rs).not.toMatch(/background:\s*var\(--team\)/);
    expect(rs).not.toMatch(/color:\s*var\(--team\)/);
  });

  it('인원별 캡슐 규격이 패널 세로 예산(137px) 안에 들어온다', () => {
    // 281(패널) − 2(테두리) − 52(패딩) − 76(헤더) − 14(간격) = 137
    for (const seats of [1, 2, 3, 4, 5, 6, 7]) {
      const h = Number.parseInt(
        declOf(rs, `.rs__panel[data-seats='${seats}']`, '--seat-h') ?? '0',
        10,
      );
      expect(h).toBeGreaterThan(0);
      const rows = Math.ceil(seats / seatColumns(seats));
      expect(rows * h + (rows - 1) * 10).toBeLessThanOrEqual(137);
    }
  });

  it('실제 렌더 결과가 어떤 인원에서도 세로 예산을 넘지 않는다', () => {
    // 마크업이 내보낸 data-seats·--seat-cols를 그대로 읽어 CSS 규격과 맞춰 본다.
    // 7명에서 2열 × 4행(186px)로 넘치던 사고를 이 계산이 잡는다.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12]) {
      const names = Array.from({ length: n }, (_, i) => `선수${i + 1}`).join(', ');
      const html = toHTML(view(withRoster({ t1: names })));
      const bucket = html.match(/data-seats="(\d+)"/)?.[1];
      const cols = Number.parseInt(html.match(/--seat-cols:(\d+)/)?.[1] ?? '0', 10);
      const cells = count(html, /class="rs__seat[ "]/g) / 4; // t1 외 세 팀은 미정 1칸씩
      const h = Number.parseInt(
        declOf(rs, `.rs__panel[data-seats='${bucket}']`, '--seat-h') ?? '0',
        10,
      );
      expect(cols).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      const seatCount = Math.min(n, MAX_SEATS);
      const rows = Math.ceil(seatCount / cols);
      expect(rows * h + (rows - 1) * 10).toBeLessThanOrEqual(137);
      expect(cells).toBeGreaterThan(0);
    }
  });

  it('7명 이상은 3열로 접고 12명은 넘침 배지를 단다', () => {
    const seven = toHTML(view(withRoster({ t1: '가, 나, 다, 라, 마, 바, 사' })));
    expect(seven).toContain('data-seats="7"');
    expect(seven).toContain('--seat-cols:3');
    expect(count(seven, /class="rs__seat"/g)).toBe(7);
    expect(seven).not.toContain('rs__seat--more');

    const twelve = Array.from({ length: 12 }, (_, i) => `선수${i + 1}`).join(', ');
    const many = toHTML(view(withRoster({ t1: twelve })));
    expect(many).toContain('data-seats="7"');
    expect(count(many, /class="rs__seat"/g)).toBe(8);
    expect(many).toContain('rs__seat--more');
    expect(toText(view(withRoster({ t1: twelve })))).toContain('외 4명');
    // 인원 배지는 자른 수가 아니라 실제 인원을 말한다
    expect(toText(view(withRoster({ t1: twelve })))).toContain('12명');
  });

  it('본문 세로 예산이 마스트헤드 아래 586px이다', () => {
    // 보드 콘텐츠 726 − 매스트헤드 120 − 간격 20
    expect(declOf(rs, '.rs__grid', 'height')).toBe('586px');
    expect(declOf(rs, '.rs__grid', 'margin-top')).toBe('20px');
  });

  it('패널 진입 모션은 luxe 리듬을 쓰고 to 블록을 두지 않는다', () => {
    expect(declOf(rs, '.rs__panel', 'animation')).toBe(
      'rs-panel-in 0.267s var(--ease-out) var(--panel-delay) both',
    );
    expect(rs).toMatch(/@keyframes rs-panel-in\s*\{\s*from\s*\{[^}]*\}\s*\}/);
  });

  it('출전 명단 블록에는 양수 자간이 하나도 없다', () => {
    expect(positiveLetterSpacings(rs)).toEqual([]);
  });
});

describe('출전 명단 오피셜 팀 로고 (U31)', () => {
  it('팀 패널 아바타에 슬롯별 오피셜 배지가 들어간다', () => {
    const html = toHTML(view(createInitialState()));
    for (const color of ['yellow', 'blue', 'red', 'green']) {
      expect(html).toContain(`<img class="luxe-logo team-badge" src="./media/team_logo_${color}.svg" alt="">`);
    }
  });

  it('기본 배지가 없는 5·6번 슬롯만 중립 이니셜로 남는다', () => {
    const html = toHTML(view(withTeamCount(createInitialState(), 6)));
    expect(count(html, /class="luxe-logo team-badge"/g)).toBe(4);
    expect(count(html, /class="luxe-logo-fallback"/g)).toBe(2);
  });
});
