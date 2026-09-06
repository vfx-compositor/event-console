import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { atToRemaining, fmtRemaining, parseRemaining, remainingToAt } from './p2-remaining';
import { pointsFromRanks, rankSubmissions } from './scoring';
import { computeScores, createInitialState, getStage, reducer, type Action } from './state';
import type { AppState, Submission, TeamId } from './types';

const T0 = 1_700_000_000_000;
const IDS: TeamId[] = ['t1', 't2', 't3', 't4'];

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

/** 남은 시간(초) 맵 → `rankSubmissions`가 받는 제출 기록 */
function fromRemaining(map: Partial<Record<TeamId, number>>): Record<TeamId, Submission | null> {
  const out = {} as Record<TeamId, Submission | null>;
  for (const id of IDS) {
    const sec = map[id];
    out[id] = sec === undefined ? null : { at: remainingToAt(sec), correct: true, remainingSec: sec };
  }
  return out;
}

describe('parseRemaining — 수기 입력 파서', () => {
  it('mm:ss를 초로 읽는다', () => {
    expect(parseRemaining('12:34')).toBe(754);
    expect(parseRemaining('0:07')).toBe(7);
    expect(parseRemaining(' 1:00 ')).toBe(60);
  });

  it('h:mm:ss도 읽는다', () => {
    expect(parseRemaining('1:02:03')).toBe(3723);
  });

  it('단위 없는 숫자는 초로 읽는다', () => {
    expect(parseRemaining('90')).toBe(90);
    expect(parseRemaining('0')).toBe(0);
  });

  it('한글 단위 표기를 읽는다', () => {
    expect(parseRemaining('7분')).toBe(420);
    expect(parseRemaining('7분 30초')).toBe(450);
    expect(parseRemaining('90초')).toBe(90);
  });

  it('빈 값·음수·해석 불가는 null이다', () => {
    expect(parseRemaining('')).toBeNull();
    expect(parseRemaining('   ')).toBeNull();
    expect(parseRemaining('-5')).toBeNull();
    expect(parseRemaining('-1:00')).toBeNull();
    expect(parseRemaining('abc')).toBeNull();
    expect(parseRemaining('12:34:56:78')).toBeNull();
    expect(parseRemaining('12:ab')).toBeNull();
  });

  it('0은 유효하다 — 시간을 다 쓴 팀도 기록되어야 한다', () => {
    expect(parseRemaining('0:00')).toBe(0);
    expect(parseRemaining('0초')).toBe(0);
  });
});

describe('fmtRemaining — 표시 포맷', () => {
  it('m:ss로 찍는다', () => {
    expect(fmtRemaining(754)).toBe('12:34');
    expect(fmtRemaining(7)).toBe('0:07');
    expect(fmtRemaining(0)).toBe('0:00');
    expect(fmtRemaining(3723)).toBe('62:03');
  });

  it('소수는 반올림하고 음수는 0으로 막는다', () => {
    expect(fmtRemaining(59.6)).toBe('1:00');
    expect(fmtRemaining(-3)).toBe('0:00');
  });
});

describe('at 사상 — 순위 함수를 안 건드리기 위한 장치', () => {
  it('남은 시간이 많을수록 at이 작다 (오름차순 정렬에서 앞선다)', () => {
    expect(remainingToAt(754)).toBeLessThan(remainingToAt(60));
    expect(remainingToAt(0)).toBe(-0);
    expect(atToRemaining(remainingToAt(754))).toBe(754);
  });

  it('at 차이는 남은 시간 차이 그대로 ms 단위다 (tieWindow가 그대로 성립)', () => {
    expect(remainingToAt(60) - remainingToAt(63)).toBe(3000);
  });
});

describe('rankSubmissions — 남은 시간 순위', () => {
  it('많이 남은 팀이 1위다', () => {
    const ranks = rankSubmissions(fromRemaining({ t1: 60, t2: 754, t3: 0 }), 5, IDS);
    expect(ranks.t2).toBe(1);
    expect(ranks.t1).toBe(2);
    expect(ranks.t3).toBe(3);
    expect(ranks.t4).toBeNull();
  });

  it('선두와 tieWindow 이내 차이는 공동 순위이고 점수를 평균한다', () => {
    const ranks = rankSubmissions(fromRemaining({ t1: 300, t2: 298, t3: 100 }), 5, IDS);
    expect(ranks.t1).toBe(1);
    expect(ranks.t2).toBe(1);
    expect(ranks.t3).toBe(3);

    const pts = pointsFromRanks(ranks, [300, 200, 150, 100], IDS);
    expect(pts.t1).toBe(250);
    expect(pts.t2).toBe(250);
    expect(pts.t3).toBe(150);
    expect(pts.t4).toBe(0);
  });

  it('tieWindow를 넘는 차이는 단독 순위다', () => {
    const ranks = rankSubmissions(fromRemaining({ t1: 300, t2: 294 }), 5, IDS);
    expect(ranks.t1).toBe(1);
    expect(ranks.t2).toBe(2);
  });

  it('오답 처리한 팀은 남은 시간이 많아도 순위에서 빠진다', () => {
    const subs = fromRemaining({ t1: 300, t2: 100 });
    subs.t1 = { ...subs.t1!, correct: false };
    const ranks = rankSubmissions(subs, 5, IDS);
    expect(ranks.t1).toBeNull();
    expect(ranks.t2).toBe(1);
  });
});

describe('reducer — p2/submitRemaining', () => {
  const base = (): AppState => run(createInitialState(), { type: 'p2/unlock' });

  it('남은 시간을 정답 제출로 기록하고 at을 음수로 사상한다', () => {
    const s = run(base(), { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 754 });
    const sub = getStage(s, 's1').submissions.t1!;
    expect(sub.remainingSec).toBe(754);
    expect(sub.at).toBe(-754_000);
    expect(sub.correct).toBe(true);
  });

  it('단계 status를 건드리지 않는다 (p2/submit과 같은 상태 전이)', () => {
    const before = getStage(base(), 's1').status;
    const s = run(base(), { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 60 });
    expect(getStage(s, 's1').status).toBe(before);
  });

  it('다른 단계와 다른 팀은 건드리지 않는다', () => {
    const s = run(base(), { type: 'p2/submitRemaining', stageId: 's2', teamId: 't3', remainingSec: 60 });
    expect(getStage(s, 's1').submissions.t3).toBeNull();
    expect(getStage(s, 's2').submissions.t1).toBeNull();
    expect(getStage(s, 's2').submissions.t3?.remainingSec).toBe(60);
  });

  it('0초는 기록된다 — 시간을 다 쓴 팀도 순위에 들어간다', () => {
    const s = run(base(), { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 0 });
    expect(getStage(s, 's1').submissions.t1?.remainingSec).toBe(0);
  });

  it('음수·NaN은 무시하고 상태를 그대로 둔다', () => {
    const s0 = base();
    expect(run(s0, { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: -1 })).toBe(s0);
    expect(run(s0, { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: NaN })).toBe(s0);
    expect(
      run(s0, { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: Infinity }),
    ).toBe(s0);
  });

  it('다시 기록하면 덮어쓴다 (취소 없이 오타 정정)', () => {
    const s = run(
      base(),
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 60 },
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 754 },
    );
    expect(getStage(s, 's1').submissions.t1?.remainingSec).toBe(754);
  });

  it('취소(p2/unsubmit)와 정답/오답 토글이 그대로 동작한다', () => {
    const s1 = run(
      base(),
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 60 },
      { type: 'p2/correct', stageId: 's1', teamId: 't1', correct: false },
    );
    const sub = getStage(s1, 's1').submissions.t1!;
    expect(sub.correct).toBe(false);
    expect(sub.remainingSec).toBe(60);

    const s2 = run(s1, { type: 'p2/unsubmit', stageId: 's1', teamId: 't1' });
    expect(getStage(s2, 's1').submissions.t1).toBeNull();
  });
});

describe('p2/confirm — 남은 시간으로 확정한 원장 점수', () => {
  it('많이 남은 팀이 앞 순위로 점수표를 받는다', () => {
    const s = run(
      createInitialState(),
      { type: 'p2/unlock' },
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 60 },
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't2', remainingSec: 754 },
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't3', remainingSec: 0 },
      { type: 'p2/confirm', stageId: 's1', now: T0 },
    );
    const stage = getStage(s, 's1');
    expect(stage.ranks.t2).toBe(1);
    expect(stage.ranks.t1).toBe(2);
    expect(stage.ranks.t3).toBe(3);

    const scores = computeScores(s);
    expect(scores.t2.p2).toBe(300);
    expect(scores.t1.p2).toBe(200);
    expect(scores.t3.p2).toBe(150);
    expect(scores.t4.p2).toBe(0);
    expect(s.ledger.some((e) => e.ref === 'p2:s1')).toBe(true);
  });

  it('공동 순위는 평균 점수로 원장에 들어간다', () => {
    const s = run(
      createInitialState(),
      { type: 'p2/unlock' },
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 300 },
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't2', remainingSec: 298 },
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't3', remainingSec: 100 },
      { type: 'p2/confirm', stageId: 's1', now: T0 },
    );
    const scores = computeScores(s);
    expect(scores.t1.p2).toBe(250);
    expect(scores.t2.p2).toBe(250);
    expect(scores.t3.p2).toBe(150);
  });

  it('역분개하면 남은 시간 기록도 0으로 돌아간다', () => {
    const s = run(
      createInitialState(),
      { type: 'p2/unlock' },
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 754 },
      { type: 'p2/confirm', stageId: 's1', now: T0 },
      { type: 'p2/revoke', stageId: 's1', now: T0 + 1000 },
    );
    expect(computeScores(s).t1.p2).toBe(0);
  });
});

describe('저장본 호환 — migrate', () => {
  it('remainingSec이 직렬화 라운드트립에서 살아남는다', async () => {
    const { deserialize, serialize } = await import('./state');
    const s = run(
      createInitialState(),
      { type: 'p2/unlock' },
      { type: 'p2/submitRemaining', stageId: 's1', teamId: 't1', remainingSec: 754 },
    );
    const back = deserialize(serialize(s));
    expect(getStage(back, 's1').submissions.t1?.remainingSec).toBe(754);
    expect(getStage(back, 's1').submissions.t1?.at).toBe(-754_000);
  });

  it('remainingSec이 없는 옛 기록은 시각 제출로 그대로 남는다', () => {
    const s = run(
      createInitialState(),
      { type: 'p2/unlock' },
      { type: 'p2/submit', stageId: 's1', teamId: 't1', at: T0 },
    );
    const sub = getStage(s, 's1').submissions.t1!;
    expect(sub.remainingSec).toBeUndefined();
    expect(sub.at).toBe(T0);
  });
});

describe('배선 — 2부 컨트롤 탭 / 출력 씬 소스', () => {
  const tab = readFileSync(new URL('./control/tab-p2.ts', import.meta.url), 'utf8');
  const scene = readFileSync(new URL('./scenes/submit.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');

  it('팀 줄에 남은 시간 입력칸과 [기록] 버튼이 있다', () => {
    expect(tab).toContain('rankrow__remain');
    expect(tab).toContain('p2-remain-save-');
    expect(tab).toContain("text: '기록'");
    expect(css).toContain('.rankrow__remain');
  });

  it('입력은 클릭 시점 draft를 읽고 전역 단축키를 막는다 (D6 재발 방지)', () => {
    expect(tab).toContain('remainingSubmitAction(st.id, id)');
    expect(tab).toContain('ev.stopPropagation()');
    expect(tab).toContain("ev.key === 'Enter'");
  });

  it('기록된 줄은 시각이 아니라 남은 시간을 보여 준다', () => {
    expect(tab).toContain('fmtRemaining(sub.remainingSec!)');
    expect(scene).toContain('s.remainingSec != null');
    expect(scene).toContain('fmtRemaining(s.remainingSec)');
  });

  it('혼용 경고와 안내 문구가 있다', () => {
    expect(tab).toContain('anyRemaining');
    expect(tab).toContain('한 방식만');
    expect(tab).toContain('많이 남은 팀이 앞 순위');
  });

  it('순위 근거 tip이 방식에 따라 갈린다', () => {
    expect(tab).toContain("isRemaining ? '남은 시간' : '제출 순서'");
  });
});

/**
 * U139 — 2부 단계 카드의 팀 이름이 `YELL…`로 잘린 건(09-05 15:08 스크린샷).
 *
 * 실측(헤드리스 Chrome + 실제 `control.css`): 중앙 열 914px(≈1280px 창)에서 옛 2열 고정
 * 격자가 카드를 452px로 눌렀고 팀 이름 칸이 **0px**이 됐다. 같은 조건에서 지금은 1열로
 * 내려가 483px, 사용자의 1440px 창(중앙 1074px)에서는 2열을 유지한 채 61px → 101px.
 *
 * 픽셀은 node 환경에서 다시 잴 수 없으므로, 그 폭을 만들어 낸 **규칙 네 개**를 고정한다.
 */
describe('2부 단계 카드 팀 이름 말줄임 (U139)', () => {
  const css = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');
  const tab = readFileSync(new URL('./control/tab-p2.ts', import.meta.url), 'utf8');

  it('카드 격자가 폭을 보장한다 — 2열 고정이 아니라 하한 있는 auto-fit', () => {
    const grid = css.match(/(?<!\S)\.eventgrid\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(grid).toMatch(/repeat\(auto-fit,\s*minmax\(min\(520px,\s*100%\),\s*1fr\)\)/);
    // `minmax(0, 1fr)`의 0은 "여기까지 눌려도 좋다"는 허가라 아무 데서도 걸리지 않는다
    expect(grid).not.toMatch(/repeat\(2,/);
  });

  it('팀 이름 칸에 붕괴 방지 floor가 있다', () => {
    const team = css.match(/\.rankrow__team\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(team).toMatch(/min-width:\s*84px/);
    expect(team).not.toMatch(/min-width:\s*0/);
    // 줄바꿈으로 세로를 부풀리지 않는다 — 잘림은 말줄임으로만 표현한다
    expect(team).toMatch(/white-space:\s*nowrap/);
    expect(team).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('같은 줄의 고정 폭을 줄여 팀 이름에 자리를 내준다', () => {
    expect(css).toMatch(/\.rankrow\s*\{[^}]*gap:\s*6px/s);
    expect(css).toMatch(/\.rankrow__remain\s*\{[^}]*width:\s*64px/s);
    expect(css).toMatch(/\.rankrow__pts\s*\{[^}]*min-width:\s*52px/s);
  });

  it('정답/오답 버튼 라벨은 두 글자, 뜻은 tip·aria-label로 내려간다 (Priority+)', () => {
    expect(tab).toContain("text: sub.correct ? '오답' : '정답'");
    expect(tab).not.toContain("'오답 처리' : '정답 처리'");
    expect(tab).toMatch(/'aria-label':\s*sub\.correct[\s\S]{0,120}오답 처리/);
    expect(tab).toMatch(/tip: sub\.correct[\s\S]{0,80}순위에서 제외/);
  });
});
