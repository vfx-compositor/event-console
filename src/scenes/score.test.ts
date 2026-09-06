import { describe, expect, it } from 'vitest';

import { createInitialState, reducer } from '../state';
import { toHTML, toText } from '../vdom';
import { resetAnimations } from './anim';
import { declOf, positiveLetterSpacings, section, TOKENS } from './luxe-css.testkit';
import { rowStyle } from './luxe-grid';
import {
  eventColumns,
  ROW_GAP,
  ROWS_AREA,
  rowEnterDelays,
  rowIntroDelayMs,
  rowsTop,
  rowStep,
  tick,
  view,
} from './score';

/** 공통 골격 + S4 고유 규칙을 함께 본다 — 리더보드가 실제로 쓰는 범위. */
const sbBlock = section('Broadcast Luxe 공통 골격', '타이머 (풀스크린)');

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

/**
 * tick()이 실제로 쓰는 만큼만 흉내 내는 보드 스텁 (U76).
 * vitest 환경이 node라 DOM이 없다 — `data-team` 셀렉터에서 팀 id만 뽑아 행을 돌려준다.
 */
function fakeBoard(teamIds: string[]) {
  const vars = new Map<string, Map<string, string>>();
  const rows = new Map<string, unknown>();
  for (const id of teamIds) {
    const props = new Map<string, string>();
    vars.set(id, props);
    rows.set(id, {
      style: { transform: '', setProperty: (k: string, v: string) => props.set(k, v) },
      dataset: {} as Record<string, string>,
      classList: { toggle: () => {} },
      textContent: '',
      title: '',
    });
  }
  return {
    querySelector(sel: string) {
      const id = /data-team="([^"]+)"/.exec(sel)?.[1];
      if (!id) return null;
      // 행 외 슬롯(총점·순위 pill·셀)은 쓰기만 하고 검사하지 않으므로 빈 스텁으로 충분하다
      return sel.startsWith('.sb__row[')
        ? (rows.get(id) ?? null)
        : { textContent: '', title: '', classList: { toggle: () => {} } };
    },
    delayOf: (id: string) => vars.get(id)?.get('--row-delay'),
    rankDelayOf: (id: string) => vars.get(id)?.get('--rank-delay'),
  };
}

describe('리더보드 정보 계약', () => {
  it('A안 위계인 RANK · TEAM · EVENT SCORE · TOTAL을 렌더한다', () => {
    const text = toText(view(createInitialState()));
    expect(text).toMatch(/RANK\s*TEAM\s*EVENT SCORE\s*TOTAL/);
  });

  it('2부 잠금 중에는 후반 열·마크업을 만들지 않는다', () => {
    const html = toHTML(view(createInitialState()));
    expect(html).not.toMatch(/2부|p2:|data-col="s[123]"/);
  });

  it('4팀과 팀별 4종목 바인딩 슬롯을 렌더한다', () => {
    const html = toHTML(view(createInitialState()));
    expect(count(html, /class="sb__row"/g)).toBe(4);
    expect(count(html, /data-bind="score-cell"/g)).toBe(16);
    expect(count(html, /class="sb__event-item/g)).toBe(16);
    expect(html).not.toContain('class="sb__track"');
  });

  it('실제 state의 팀명·팀 색·순위/총점 슬롯을 그대로 쓴다', () => {
    const html = toHTML(view(createInitialState()));
    expect(html).toContain('--team:#c0453b');
    expect(count(html, /data-bind="total"/g)).toBe(4);
    expect(count(html, /data-bind="rank"/g)).toBe(4);
  });
});

describe('리더보드 행 격자 (1920×1080 스테이지)', () => {
  it('공용 격자 모듈의 수치를 그대로 다시 내보낸다', () => {
    expect(ROWS_AREA).toBe(510);
    expect(ROW_GAP).toBe(18);
    expect([rowStep(4), rowStep(5), rowStep(6)]).toEqual([127, 102, 85]);
    expect(rowsTop(4)).toBe(10);
    expect(eventColumns(4)).toBe(2);
  });

  it('6팀 행에도 2줄짜리 종목 블록이 들어가는 높이를 남긴다', () => {
    expect(rowStep(6) - ROW_GAP).toBeGreaterThanOrEqual(64);
    expect(rowStep(4) - ROW_GAP).toBe(109);
  });

  it('view가 step · rows-top · event-cols를 CSS 변수로 넘긴다', () => {
    const html = toHTML(view(createInitialState()));
    expect(html).toContain('--step:127px');
    expect(html).toContain('--rows-top:10px');
    expect(html).toContain('--event-cols:2');
    expect(html).toContain('data-cols="2"');
  });
});

describe('리더보드 빠른 진입 모션', () => {
  it('패널은 첫 프레임부터 보이고 제목·헤더·순위·행 모션 클래스를 갖는다', () => {
    const html = toHTML(view(createInitialState()));
    expect(html).toContain('class="sb__board"');
    // 게임패드 SVG 대신 공용 행사 모노그램
    expect(html).toContain('class="luxe-mast__mark"');
    expect(html).not.toContain('sb__game-icon');
    expect(html).toContain('class="sb__table-head"');
    expect(html).toContain('class="sb__rank"');
    expect(html).toContain('class="sb__row-body"');
  });

  it('4~6팀의 마지막 행도 1초 안에 완료되는 지연값을 만든다', () => {
    for (const teams of [4, 5, 6]) {
      expect(rowIntroDelayMs(teams - 1, teams) + 267).toBeLessThanOrEqual(1000);
    }
    expect(rowIntroDelayMs(1, 4)).toBeCloseTo(167, 0);
  });

  // U76 — 명부 순서(t1..t4)와 순위가 어긋나면 1-2-4-3으로 들어오던 회귀를 값으로 막는다.
  it('진입 스태거는 명부 순서가 아니라 순위를 따른다 (1-2-3-4)', () => {
    let s = createInitialState();
    // t3가 4위, t4가 3위 — 명부 순서와 순위가 뒤바뀌는 최소 조합
    const totals: [string, number][] = [
      ['t1', 40],
      ['t2', 30],
      ['t3', 10],
      ['t4', 20],
    ];
    for (const [teamId, delta] of totals) {
      s = reducer(s, {
        type: 'ledger/manual',
        teamId,
        delta,
        reason: 'test',
        now: 1_700_000_000_000,
      } as never);
    }

    const enters = rowEnterDelays(s);
    expect(enters.map((e) => e.slot)).toEqual([1, 2, 3, 4]);
    // 슬롯 순으로 단조 증가해야 한다 — 수정 전에는 [0, 167, 500, 333]이었다
    expect(enters.map((e) => e.delayMs)).toEqual([0, 167, 333, 500]);
    expect(enters.map((e) => e.teamId)).toEqual(['t1', 't2', 't4', 't3']);

    // 이 픽스처가 실제로 버그 조건(명부 순서 ≠ 순위)을 담고 있는지 — 마크업이 굽는
    // 명부 순서 지연은 t3=333 · t4=500이라 tick이 덮어쓰지 않으면 1-2-4-3이 된다
    expect(rowStyle('#000', 2, 4)).toContain('--row-delay:333ms'); // dom#2 = t3 = 4위
    expect(rowStyle('#000', 3, 4)).toContain('--row-delay:500ms'); // dom#3 = t4 = 3위

    // tick()이 그 마크업 값을 순위 기준으로 덮어쓰는지 직접 본다 (env가 node라 DOM 스텁)
    const root = fakeBoard(['t1', 't2', 't3', 't4']);
    tick(root as unknown as HTMLElement, s, 1_700_000_000_000);
    expect(root.delayOf('t3')).toBe('500ms'); // 4위 → 마지막에 들어온다
    expect(root.delayOf('t4')).toBe('333ms'); // 3위 → t3보다 먼저
    expect(root.rankDelayOf('t3')).toBe('467ms'); // 순위 pill 클램프는 유지
  });

  it('tick이 덮어쓰는 지연 문자열은 rowStyle이 굽는 것과 같은 형식이다', () => {
    // score.ts의 RANK_DELAY_MAX_MS(467)가 luxe-grid의 클램프와 어긋나면 여기서 깨진다
    for (const [index, count] of [
      [0, 4],
      [3, 4],
      [5, 6],
    ] as const) {
      const delay = rowIntroDelayMs(index, count);
      expect(rowStyle('#000', index, count)).toContain(
        `--row-delay:${delay}ms; --rank-delay:${Math.min(delay, 467)}ms`,
      );
    }
  });

  it('순위 pill은 앞 레이어, 흰 행은 뒤 레이어에서 translateX+clip-path로 등장한다', () => {
    expect(declOf(sbBlock, '.sb__row > .sb__rank', 'z-index')).toBe('2');
    expect(declOf(sbBlock, '.sb__row > .sb__row-body', 'z-index')).toBe('1');
    expect(declOf(sbBlock, '.sb__row > .sb__row-body', 'animation')).toContain('sb-row-reveal');
    expect(sbBlock).toMatch(
      /@keyframes\s+sb-row-reveal\s*\{[^}]*translateX\(-110px\)[^}]*clip-path:\s*inset\(0 100% 0 0\)/s,
    );
  });

  it('순위 재정렬과 총점 카운트업 배선을 유지한다', () => {
    expect(declOf(sbBlock, '.sb__row', 'transition')).toBe('transform 0.4s var(--ease-out)');
    expect(toHTML(view(createInitialState()))).toContain('data-bind="total"');
  });

  it('reduced-motion에서는 모든 진입 모션을 제거해 즉시 완성한다', () => {
    expect(sbBlock).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.sb__row-body[\s\S]*animation:\s*none/,
    );
  });

  it('점수만 바뀌면 view 마크업이 같아 전체 인트로가 재시작되지 않는다', () => {
    const before = createInitialState();
    let after = reducer(before, { type: 'p1/rank', eventId: 'curling', teamId: 't1', rank: 1 });
    after = reducer(after, { type: 'p1/confirm', eventId: 'curling', now: 1_700_000_000_000 });
    expect(toHTML(view(after))).toBe(toHTML(view(before)));
  });
});

describe('Broadcast Luxe 스킨', () => {
  it('1536×876 보드와 얇은 라이트 테두리·깊이 그림자를 쓴다', () => {
    expect(declOf(sbBlock, '.sb__board', 'width')).toBe('1536px');
    expect(declOf(sbBlock, '.sb__board', 'height')).toBe('876px');
    expect(declOf(sbBlock, '.sb__board', 'border')).toBe('1px solid var(--luxe-panel-line)');
    expect(declOf(sbBlock, '.sb__board', 'box-shadow')).toContain('--luxe-panel-glow');
  });

  it('헤더 pill과 순위 pill을 그라디언트 캡슐로 세운다', () => {
    expect(declOf(sbBlock, '.sb__table-head', 'border-radius')).toBe('999px');
    expect(declOf(sbBlock, '.sb__table-head', 'background')).toBe('var(--luxe-head-grad)');
    expect(declOf(sbBlock, '.sb__rank', 'border-radius')).toBe('999px');
    expect(declOf(sbBlock, '.sb__rank', 'background')).toBe('var(--luxe-pill-grad)');
    expect(declOf(TOKENS, ':root', '--luxe-pill-grad')).toContain('linear-gradient(145deg');
  });

  it('헤더와 행이 같은 열 격자(168 · 448 · 1fr · 224)를 쓴다', () => {
    expect(declOf(sbBlock, '.sb__table-head', 'grid-template-columns')).toBe(
      '168px 448px minmax(0, 1fr) 224px',
    );
    expect(declOf(sbBlock, '.sb__row > .sb__row-body', 'grid-template-columns')).toBe(
      '448px minmax(0, 1fr) 224px',
    );
    // 순위 pill 190px = 168 열 + 22px 캡슐 겹침, 흰 캡슐은 168px에서 시작
    expect(declOf(sbBlock, '.sb__row > .sb__rank', 'width')).toBe('190px');
    expect(declOf(sbBlock, '.sb__row > .sb__row-body', 'left')).toBe('168px');
    // RANK 라벨은 pill 중심(x=95)에, TEAM 라벨은 아바타 시작선(x=224)에 선다
    expect(declOf(sbBlock, '.sb__head-rank', 'padding-left')).toBe('22px');
    expect(declOf(sbBlock, '.sb__head-team', 'padding-left')).toBe('56px');
    expect(declOf(sbBlock, '.sb__id', 'padding')).toBe('0 16px 0 56px');
  });

  it('팀 식별색은 아바타 링에서만 쓰고 총점은 캡슐 중앙에 놓는다', () => {
    expect(declOf(sbBlock, '.sb__avatar', 'border')).toBe(
      '6px solid color-mix(in srgb, var(--team) 70%, #fff)',
    );
    expect(sbBlock).not.toMatch(/background:\s*var\(--team\)/);
    expect(declOf(sbBlock, '.sb__total', 'place-items')).toBe('center');
    expect(declOf(sbBlock, '.sb__total', 'color')).toBe('var(--luxe-violet-ink)');
  });

  /**
   * U79 — 1위 pill의 골드 테두리를 걷어냈다. 등수는 pill 안 숫자가 이미 말한다.
   * 거기에 색 하이라이트를 더하면 팀 식별색과 신호가 겹쳐 "옐로우 팀만 강조"로 읽혔다.
   * `is-lead` 클래스 자체는 글로우 정지 판정(D9)이 쓰므로 마크업에 남는다 — 시각 효과만 없다.
   */
  it('1위 pill에 골드 하이라이트를 다시 넣지 않는다', () => {
    expect(declOf(sbBlock, '.sb__row.is-lead > .sb__rank', 'box-shadow')).toBeNull();
    expect(sbBlock).not.toContain('.luxe-row.is-first > .luxe-pill');
  });

  it('행 영역·행 높이·5·6팀 축소 규격이 CSS에 있다', () => {
    expect(declOf(sbBlock, '.sb__rows', 'height')).toBe('510px');
    expect(declOf(sbBlock, '.sb__row', 'height')).toBe('calc(var(--step) - 18px)');
    expect(declOf(sbBlock, '.sb__row', 'top')).toBe('var(--rows-top, 0px)');
    for (const teams of ['5', '6']) {
      // U79 — `sb__logo`는 빠졌다. 로고는 아바타 상자의 100%라 지름 규칙 하나만 줄이면
      // 따라온다(공용 `.luxe-logo`). 축소 규격을 두 곳에 적던 것이 어긋남의 원인이었다.
      for (const sel of ['sb__avatar', 'sb__name', 'sb__total']) {
        expect(sbBlock).toContain(`.sb__rows[data-teams='${teams}'] .${sel}`);
      }
      // 종목 칸은 개별 규칙 대신 세로 예산 변수로 줄인다
      expect(declOf(sbBlock, `.sb__rows[data-teams='${teams}']`, '--cells-fs-v')).not.toBeNull();
    }
  });

  it('6팀 × 7종목에서 종목 글자가 큰 쪽으로 되돌아가지 않는다', () => {
    // data-teams(세로 20px)와 data-cols(가로 22px)는 특이도가 같다.
    // 서로 다른 변수를 쓰고 min()으로 합치므로 순서와 무관하게 작은 쪽이 이긴다.
    expect(declOf(sbBlock, '.sb__cell', 'font-size')).toBe(
      'min(var(--cells-fs-v), var(--cells-fs-h))',
    );
    expect(declOf(sbBlock, ".sb__rows[data-teams='6']", '--cells-fs-v')).toBe('20px');
    expect(declOf(sbBlock, ".sb__rows[data-cols='4']", '--cells-fs-h')).toBe('22px');
    expect(declOf(sbBlock, ".sb__rows[data-cols='4']", '--cells-fs-v')).toBeNull();
    expect(declOf(sbBlock, ".sb__rows[data-teams='6']", '--cells-fs-h')).toBeNull();
  });

  it('리더보드 안에는 양수 자간이 하나도 없다', () => {
    expect(positiveLetterSpacings(sbBlock)).toEqual([]);
  });
});

describe('리더보드 오피셜 팀 로고 (U31)', () => {
  it('업로드가 없어도 슬롯별 오피셜 배지를 박는다', () => {
    const html = toHTML(view(createInitialState()));
    for (const color of ['yellow', 'blue', 'red', 'green']) {
      expect(html).toContain(`src="./media/team_logo_${color}.svg"`);
    }
    // 이중 링을 막는 CSS 훅이 배지에만 붙는다
    expect(count(html, /class="sb__logo team-badge"/g)).toBe(4);
    expect(html).not.toContain('sb__logo-fallback');
  });

  it('사용자가 올린 로고가 오피셜 배지를 이긴다', () => {
    const base = createInitialState();
    const patched = reducer(base, {
      type: 'team/patch',
      teamId: 't1',
      patch: { logoDataUrl: 'data:image/png;base64,AAA' },
    });
    const html = toHTML(view(patched));
    expect(html).toContain('src="data:image/png;base64,AAA"');
    expect(html).not.toContain('./media/team_logo_yellow.svg');
    // 임의 그림에는 팀 색 링이 유일한 식별 신호라 team-badge를 붙이지 않는다
    expect(count(html, /class="sb__logo team-badge"/g)).toBe(3);
  });

  it('기본 배지가 없는 5·6번 슬롯은 중립 이니셜로 남는다', () => {
    const six = { ...createInitialState(), teamCount: 6 };
    const html = toHTML(view(six));
    expect(count(html, /class="sb__logo team-badge"/g)).toBe(4);
    expect(count(html, /class="sb__logo-fallback"/g)).toBe(2);
  });

  it('배지가 붙은 아바타만 링을 hairline으로 낮춘다', () => {
    expect(declOf(sbBlock, '.sb__avatar', 'border')).toContain('6px');
    expect(declOf(sbBlock, '.sb__avatar:has(.team-badge)', 'border-width')).toBe('2px');
    expect(declOf(sbBlock, '.sb__avatar:has(.team-badge)', 'background')).toBe('transparent');
  });
});

/**
 * U89 — 종목 점수 공개 큐(`score-<event>`)는 **그 종목과 합계만** 보여 준다.
 *
 * 이전 종목 칸이 같이 남아 있으면 "이번 판에서 몇 점 났나"가 숫자 더미에 묻힌다.
 * CSS로 가리는 게 아니라 칸을 만들지 않는 것이 계약이라, 다른 종목 이름이 HTML에
 * 한 글자도 남지 않는지까지 본다. F3 전체 스코어보드(highlight = null)는 예전 그대로다.
 */
describe('종목 점수 공개 — 해당 종목 + 합계만 (U89)', () => {
  /** 실제 큐가 쓰는 경로(`sceneOpts/patch`)로 하이라이트를 건다. */
  function highlighted(eventId: 'curling' | 'newspaper' | 'sticky' | 'sync') {
    return reducer(createInitialState(), {
      type: 'sceneOpts/patch',
      patch: { score: { highlight: eventId } },
    });
  }

  it('행마다 해당 종목 한 칸과 합계 하나만 남는다', () => {
    const html = toHTML(view(highlighted('curling')));
    expect(count(html, /class="sb__row"/g)).toBe(4);
    expect(count(html, /class="sb__event-item/g)).toBe(4); // 팀당 1칸 (기본은 16)
    expect(count(html, /data-bind="score-cell"/g)).toBe(4);
    expect(count(html, /data-col="curling"/g)).toBe(4);
    expect(count(html, /data-bind="total"/g)).toBe(4);
  });

  it('다른 종목의 이름도 칸도 마크업에 아예 없다', () => {
    const html = toHTML(view(highlighted('curling')));
    for (const name of ['신문지 달리기', '끈끈이 낚시', '몸으로 말해요']) {
      expect(html).not.toContain(name);
    }
    for (const key of ['newspaper', 'sticky', 'sync']) {
      expect(html).not.toContain(`data-col="${key}"`);
    }
    expect(html).toContain('컬링');
  });

  it('헤더바도 행과 같은 것만 말한다 — 종목 이름 + TOTAL', () => {
    const text = toText(view(highlighted('sticky')));
    expect(text).toMatch(/RANK\s*TEAM\s*끈끈이 낚시\s*TOTAL/);
    expect(text).not.toContain('EVENT SCORE');
  });

  it('보조 격자를 한 열로 줄이고 solo 클래스를 붙인다', () => {
    const html = toHTML(view(highlighted('curling')));
    expect(html).toContain('--event-cols:1');
    expect(html).toContain('data-cols="1"');
    expect(count(html, /class="sb__cells sb__cells--solo"/g)).toBe(4);
  });

  it('하이라이트가 없는 F3 전체 스코어보드는 전 종목을 그대로 늘어놓는다', () => {
    const html = toHTML(view(createInitialState()));
    expect(count(html, /data-bind="score-cell"/g)).toBe(16);
    expect(count(html, /class="sb__event-item/g)).toBe(16);
    expect(html).not.toContain('sb__cells--solo');
    expect(html).toContain('--event-cols:2');
    expect(html).toContain('data-cols="2"');
  });

  it('마크업이 내는 solo 클래스에 대응하는 CSS 규칙이 있다', () => {
    expect(declOf(sbBlock, '.sb__cells--solo', 'grid-template-columns')).toBe('minmax(0, auto)');
    expect(declOf(sbBlock, '.sb__cells--solo', 'justify-content')).toBe('center');
    // 총점 64px보다 작아야 "이번 판 점수 < 최종 점수" 위계가 유지된다
    const solo = declOf(sbBlock, '.sb__cells--solo', '--cells-fs-v');
    expect(solo).not.toBeNull();
    expect(Number.parseInt(solo!, 10)).toBeLessThan(
      Number.parseInt(declOf(sbBlock, '.sb__total', 'font-size')!, 10),
    );
    expect(positiveLetterSpacings(sbBlock)).toEqual([]);
  });

  it('순위 pill·재정렬·진입 스태거 배선은 하이라이트에서도 그대로다', () => {
    const html = toHTML(view(highlighted('curling')));
    expect(count(html, /data-bind="rank"/g)).toBe(4);
    expect(html).toContain('class="sb__row-body"');
    expect(html).toContain('--row-delay:');
    expect(html).toContain('--rank-delay:');
    // 아바타/로고 배치는 손대지 않았다
    expect(count(html, /class="sb__logo team-badge"/g)).toBe(4);
  });
});

/**
 * U126 — [점수 전부 되돌리기] 뒤 스코어보드가 깨지지 않는지(NaN·순위·정렬) 값으로 확인한다.
 * `fakeBoard`는 `.sb__row[data-team]`만 기록하므로 여기서는 합계·순위·종목 칸까지 기록하는
 * 확장 스텁을 쓴다 — 실제 `tick()`이 쓰는 모든 슬롯을 지나가야 NaN 유무를 값으로 볼 수 있다.
 */
describe('점수 전부 되돌리기 후 렌더 (U126)', () => {
  function scoredThenReset() {
    let state = createInitialState();
    for (const eventId of ['curling', 'newspaper', 'sticky', 'sync'] as const) {
      for (const [i, teamId] of (['t1', 't2', 't3', 't4'] as const).entries()) {
        state = reducer(state, { type: 'p1/rank', eventId, teamId, rank: i + 1 });
      }
      state = reducer(state, { type: 'p1/confirm', eventId, now: 1_700_000_000_000 });
    }
    return reducer(state, { type: 'ledger/reverseAll', reason: '리셋', now: 1_700_000_001_000 });
  }

  function fullBoard(teamIds: string[]) {
    const rows = fakeBoard(teamIds);
    const totals = new Map(teamIds.map((id) => [id, { textContent: '' }]));
    const ranks = new Map(teamIds.map((id) => [id, { textContent: '' }]));
    const cells = new Map<string, { textContent: string; title: string; classList: { toggle: () => void } }>();
    return {
      querySelector(sel: string) {
        const total = /^\.sb__total\[data-team="([^"]+)"\]$/.exec(sel);
        if (total) return totals.get(total[1]) ?? null;
        const rank = /^\.sb__rank\[data-team="([^"]+)"\]$/.exec(sel);
        if (rank) return ranks.get(rank[1]) ?? null;
        const cell = /^\.sb__cell\[data-team="([^"]+)"\]\[data-col="([^"]+)"\]$/.exec(sel);
        if (cell) {
          const key = `${cell[1]}:${cell[2]}`;
          if (!cells.has(key)) cells.set(key, { textContent: '', title: '', classList: { toggle: () => {} } });
          return cells.get(key)!;
        }
        return rows.querySelector(sel);
      },
      totals,
      ranks,
      cells,
    };
  }

  it('뷰는 초기(무점수) 상태와 같은 모양으로 렌더된다 — 값은 tick()이 채우므로 마크업 자체는 무관하다', () => {
    expect(toHTML(view(scoredThenReset()))).toBe(toHTML(view(createInitialState())));
  });

  it('tick()이 합계 0 · 순위 1~4 · 종목 칸을 NaN 없이 채운다', () => {
    resetAnimations('score:');
    const state = scoredThenReset();
    const board = fullBoard(['t1', 't2', 't3', 't4']);
    tick(board as unknown as HTMLElement, state, 1_700_000_010_000);

    for (const id of ['t1', 't2', 't3', 't4']) {
      expect(board.totals.get(id)!.textContent).toBe('0');
      expect(board.ranks.get(id)!.textContent).toMatch(/^[1-4]$/);
    }
    // 4팀이 전부 동률 0점이라 순위가 겹치지 않고 1~4가 정확히 한 번씩 나와야 한다
    const ranksSeen = ['t1', 't2', 't3', 't4'].map((id) => board.ranks.get(id)!.textContent).sort();
    expect(ranksSeen).toEqual(['1', '2', '3', '4']);

    for (const cell of board.cells.values()) {
      expect(cell.textContent).toBe('–');
      expect(cell.classList).toBeTruthy();
    }
    const allText = [...board.totals.values(), ...board.ranks.values(), ...board.cells.values()]
      .map((n) => n.textContent)
      .join('|');
    expect(allText).not.toContain('NaN');
  });
});
