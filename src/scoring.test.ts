import { describe, expect, it } from 'vitest';
import { pointsFromRanks, rankSubmissions } from './scoring';
import { TEAM_IDS, teamIdsFor, type RankMap, type Submission, type TeamId } from './types';

const P1 = [100, 80, 50, 30, 20, 10];
const P2 = [300, 200, 150, 100, 70, 40];

/** 순위 맵은 항상 6슬롯을 채운다 — 실제 참가 팀은 teamIds로 따로 넘긴다 */
function ranks(v: Partial<Record<TeamId, number | null>>): RankMap {
  const out = {} as RankMap;
  for (const id of TEAM_IDS) out[id] = v[id] ?? null;
  return out;
}

function subs(v: Partial<Record<TeamId, Submission | null>>): Record<TeamId, Submission | null> {
  const out = {} as Record<TeamId, Submission | null>;
  for (const id of TEAM_IDS) out[id] = v[id] ?? null;
  return out;
}

/** 4·5·6팀 파라미터화 — 팀 수가 바뀌어도 규칙이 그대로여야 한다 */
const COUNTS = [4, 5, 6] as const;

describe('pointsFromRanks — 팀 수 4/5/6 공통', () => {
  for (const n of COUNTS) {
    const ids = teamIdsFor(n);

    it(`${n}팀: 1~${n}위를 점수표 앞에서부터 순서대로 배분한다`, () => {
      const map: Partial<Record<TeamId, number>> = {};
      ids.forEach((id, i) => (map[id] = i + 1));
      const p = pointsFromRanks(ranks(map), P1, ids);
      ids.forEach((id, i) => expect(p[id]).toBe(P1[i]));
      // 참가하지 않는 슬롯은 언제나 0
      for (const id of TEAM_IDS.filter((x) => !ids.includes(x))) expect(p[id]).toBe(0);
    });

    it(`${n}팀: 공동 1위는 1·2위 슬롯 평균을 나눠 갖고 다음 팀은 3위 슬롯을 받는다`, () => {
      const map: Partial<Record<TeamId, number>> = { [ids[0]]: 1, [ids[1]]: 1 };
      ids.slice(2).forEach((id, i) => (map[id] = i + 3));
      const p = pointsFromRanks(ranks(map), P1, ids);
      expect(p[ids[0]]).toBe((P1[0] + P1[1]) / 2);
      expect(p[ids[1]]).toBe((P1[0] + P1[1]) / 2);
      expect(p[ids[2]]).toBe(P1[2]);
      // 총합은 참가 팀 수만큼의 슬롯 합과 같아야 한다 (평균 배분은 총량을 보존한다)
      const total = ids.reduce((sum, id) => sum + p[id], 0);
      expect(total).toBeCloseTo(P1.slice(0, n).reduce((a, b) => a + b, 0), 6);
    });

    it(`${n}팀: 미입력 팀은 0점이고 점수표 슬롯을 차지하지 않는다`, () => {
      const p = pointsFromRanks(ranks({ [ids[0]]: 1, [ids[1]]: 2 }), P1, ids);
      expect(p[ids[0]]).toBe(P1[0]);
      expect(p[ids[1]]).toBe(P1[1]);
      for (const id of ids.slice(2)) expect(p[id]).toBe(0);
    });
  }

  it('3팀 공동은 1~3위 슬롯 평균을 나눠 갖는다', () => {
    const ids = teamIdsFor(6);
    const p = pointsFromRanks(
      ranks({ t1: 1, t2: 1, t3: 1, t4: 4, t5: 5, t6: 6 }),
      P1,
      ids,
    );
    const avg = (100 + 80 + 50) / 3;
    expect(p.t1).toBeCloseTo(avg, 6);
    expect(p.t3).toBeCloseTo(avg, 6);
    expect(p.t4).toBe(30);
    expect(p.t6).toBe(10);
  });

  it('점수표가 팀 수보다 짧으면 남는 순위는 0점이다 (앱이 죽지 않는다)', () => {
    const ids = teamIdsFor(6);
    const short = [100, 80];
    const p = pointsFromRanks(ranks({ t1: 1, t2: 2, t3: 3, t4: 4, t5: 5, t6: 6 }), short, ids);
    expect(p.t1).toBe(100);
    expect(p.t2).toBe(80);
    expect(p.t3).toBe(0);
    expect(p.t6).toBe(0);
  });
});

describe('rankSubmissions — 동시 제출 판정', () => {
  const base = 1_700_000_000_000;

  it('6팀: 제출 시각 순서대로 1~6위를 매긴다', () => {
    const ids = teamIdsFor(6);
    const r = rankSubmissions(
      subs({
        t1: { at: base + 30_000, correct: true },
        t2: { at: base + 10_000, correct: true },
        t3: { at: base + 20_000, correct: true },
        t4: { at: base + 40_000, correct: true },
        t5: { at: base + 50_000, correct: true },
        t6: { at: base + 60_000, correct: true },
      }),
      5,
      ids,
    );
    expect(r).toEqual({ t2: 1, t3: 2, t1: 3, t4: 4, t5: 5, t6: 6 });
  });

  it('5초 이내 제출은 공동 순위가 되고 점수는 평균 배분된다', () => {
    const ids = teamIdsFor(6);
    const s = subs({
      t1: { at: base, correct: true },
      t2: { at: base + 3_000, correct: true },
      t3: { at: base + 20_000, correct: true },
      t4: { at: base + 30_000, correct: true },
      t5: { at: base + 40_000, correct: true },
      t6: { at: base + 50_000, correct: true },
    });
    const r = rankSubmissions(s, 5, ids);
    expect(r.t1).toBe(1);
    expect(r.t2).toBe(1);
    expect(r.t3).toBe(3);
    expect(r.t6).toBe(6);

    const p = pointsFromRanks(r, P2, ids);
    expect(p.t1).toBe(250); // (300+200)/2
    expect(p.t2).toBe(250);
    expect(p.t3).toBe(150);
    expect(p.t6).toBe(40);
  });

  it('임계를 1ms 넘기면 공동이 아니다 (경계 조건)', () => {
    const r = rankSubmissions(
      subs({
        t1: { at: base, correct: true },
        t2: { at: base + 5_001, correct: true },
      }),
      5,
      teamIdsFor(6),
    );
    expect(r.t1).toBe(1);
    expect(r.t2).toBe(2);
  });

  it('오답과 미제출은 순위에서 빠지고 점수를 받지 않는다', () => {
    const ids = teamIdsFor(6);
    const r = rankSubmissions(
      subs({
        t1: { at: base, correct: false },
        t2: { at: base + 1_000, correct: true },
        t3: { at: base + 2_000, correct: true },
      }),
      5,
      ids,
    );
    expect(r.t1).toBeNull();
    expect(r.t4).toBeNull();
    expect(r.t2).toBe(1);
    expect(r.t3).toBe(1); // 1초 차 → 공동 1위

    const p = pointsFromRanks(r, P2, ids);
    expect(p.t1).toBe(0);
    expect(p.t2).toBe(250);
    expect(p.t3).toBe(250);
  });

  it('참가하지 않는 슬롯의 제출은 무시된다 (4팀 경기에 t5·t6가 섞여도 순위가 밀리지 않는다)', () => {
    const ids = teamIdsFor(4);
    const r = rankSubmissions(
      subs({
        t5: { at: base, correct: true }, // 비활성 슬롯 — 무시되어야 한다
        t1: { at: base + 1_000, correct: true },
        t2: { at: base + 20_000, correct: true },
      }),
      5,
      ids,
    );
    expect(r.t5).toBeNull();
    expect(r.t1).toBe(1);
    expect(r.t2).toBe(2);
  });
});
