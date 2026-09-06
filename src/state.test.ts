import { describe, expect, it, vi } from 'vitest';

vi.mock('./music', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./music')>();
  const fixture = await import('./test-music-fixture');
  return {
    ...actual,
    MUSIC_TRACKS: fixture.SYNTHETIC_MUSIC_TRACKS,
    musicTrack: fixture.syntheticMusicTrack,
  };
});
import {
  DEFAULT_TEAM_COLORS,
  DEFAULT_TEAM_NAMES,
  LEGACY_TEAM_DEFAULTS,
  promoteLegacyDefaults,
  DEFAULT_MOOD_BLACKOUT_SEC,
  DEFAULT_MOOD_TOTAL_SEC,
  DEFAULT_MOOD_GLITCH_STRENGTH,
  MOOD_TOTAL_SEC_RANGE,
  normalizeRangedSetting,
  DEFAULT_BACKDROP_CROSSFADE_SEC,
  DEFAULT_MUSIC_FADE_SEC,
  MAX_FADE_SETTING_SEC,
  normalizeFadeSetting,
  activeLedger,
  activeTeams,
  computeScores,
  createInitialState,
  p1RoundRef,
  deserialize,
  migrate,
  P1_EVENT_NAMES,
  promoteLegacyEventName,
  getEvent,
  getStage,
  pointsByRef,
  rankedTeams,
  normalizePhotos,
  normalizeTransitionRules,
  reducer,
  LEGACY_REPLAY_RATE,
  U107_LEGACY_REPLAY_RATE,
  REPLAY_DEFAULTS,
  REPLAY_MARK_LEAD_MS,
  REPLAY_RATES,
  REPLAY_SEC_RANGE,
  REPLAY_SEGMENT_SEC_RANGE,
  SCENE_IDS,
  type PhotoIntakeMeta,
  resetRuntimeVideoPhase,
  serialize,
  type Action,
} from './state';
import { formatReplayRate } from './replay-ring';
import { createCurlingBracket } from './p1-results';
import { photoQueue } from './photos';
import { routeSceneActionsThroughDefaultTransition } from './scene-routing';
import { isDegraded, pickScene } from './scenes';
import type { AppState, PhotoMeta } from './types';

const T0 = 1_700_000_000_000;

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

function withCurlingRanks(): AppState {
  return run(
    createInitialState(),
    { type: 'p1/rank', eventId: 'curling', teamId: 't1', rank: 1 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't2', rank: 2 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't3', rank: 3 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't4', rank: 4 },
  );
}

describe('1부 확정 · 역분개', () => {
  it('확정하면 원장에 4건이 쌓이고 점수가 파생된다', () => {
    const s = run(withCurlingRanks(), { type: 'p1/confirm', eventId: 'curling', now: T0 });
    expect(s.ledger).toHaveLength(4);
    const scores = computeScores(s);
    expect(scores.t1.p1).toBe(100);
    expect(scores.t4.total).toBe(30);
    expect(getEvent(s, 'curling').status).toBe('done');
    expect(getEvent(s, 'curling').confirmedAt).not.toBeNull();
  });

  it('확정한 경기 다음 회차를 새로 열어 이전 점수와 누적한다', () => {
    const round1 = run(withCurlingRanks(), {
      type: 'p1/confirm',
      eventId: 'curling',
      now: T0,
    });
    const round2Draft = reducer(round1, { type: 'p1/nextRound', eventId: 'curling' });

    expect(getEvent(round2Draft, 'curling').round).toBe(2);
    expect(getEvent(round2Draft, 'curling').confirmedAt).toBeNull();
    expect(Object.values(getEvent(round2Draft, 'curling').ranks).every((rank) => rank === null)).toBe(true);
    expect(computeScores(round2Draft).t1.p1).toBe(100);

    const round2 = run(
      round2Draft,
      { type: 'p1/rank', eventId: 'curling', teamId: 't1', rank: 2 },
      { type: 'p1/rank', eventId: 'curling', teamId: 't2', rank: 1 },
      { type: 'p1/rank', eventId: 'curling', teamId: 't3', rank: 3 },
      { type: 'p1/rank', eventId: 'curling', teamId: 't4', rank: 4 },
      { type: 'p1/confirm', eventId: 'curling', now: T0 + 1_000 },
    );
    expect(computeScores(round2).t1.p1).toBe(180);
    expect(computeScores(round2).t2.p1).toBe(180);
    expect(pointsByRef(round2, 'p1:curling:r2').t2).toBe(100);

    const revokedRound2 = reducer(round2, {
      type: 'p1/revoke',
      eventId: 'curling',
      now: T0 + 2_000,
    });
    expect(computeScores(revokedRound2).t1.p1).toBe(100);
    expect(computeScores(revokedRound2).t2.p1).toBe(80);
  });

  it('확정하지 않은 경기는 다음 회차로 넘어가지 않는다', () => {
    const state = createInitialState();
    expect(reducer(state, { type: 'p1/nextRound', eventId: 'curling' })).toBe(state);
  });

  it('확정 취소는 항목을 지우지 않고 역분개로 상쇄한다 (append-only)', () => {
    const s1 = run(withCurlingRanks(), { type: 'p1/confirm', eventId: 'curling', now: T0 });
    const s2 = run(s1, { type: 'p1/revoke', eventId: 'curling', now: T0 + 1000 });

    expect(s2.ledger).toHaveLength(8); // 원본 4 + 역분개 4 — 아무것도 삭제되지 않음
    expect(activeLedger(s2.ledger)).toHaveLength(0);
    expect(computeScores(s2).t1.total).toBe(0);
    expect(getEvent(s2, 'curling').confirmedAt).toBeNull();
  });

  it('순위를 고쳐 재확정하면 이전 기록이 역분개되고 새 점수만 남는다', () => {
    const s1 = run(withCurlingRanks(), { type: 'p1/confirm', eventId: 'curling', now: T0 });
    const s2 = run(
      s1,
      { type: 'p1/rank', eventId: 'curling', teamId: 't1', rank: 4 },
      { type: 'p1/rank', eventId: 'curling', teamId: 't4', rank: 1 },
      { type: 'p1/confirm', eventId: 'curling', now: T0 + 5000 },
    );
    const scores = computeScores(s2);
    expect(scores.t1.total).toBe(30);
    expect(scores.t4.total).toBe(100);
    expect(scores.t2.total).toBe(80);
    expect(pointsByRef(s2, 'p1:curling').t4).toBe(100);
  });

  it('개별 항목 되돌리기도 역분개로 처리된다', () => {
    const s1 = run(withCurlingRanks(), { type: 'p1/confirm', eventId: 'curling', now: T0 });
    const target = s1.ledger.find((e) => e.teamId === 't2')!;
    const s2 = run(s1, { type: 'ledger/reverse', entryId: target.id, now: T0 + 100 });
    expect(computeScores(s2).t2.total).toBe(0);
    expect(computeScores(s2).t1.total).toBe(100);
    expect(s2.ledger).toHaveLength(5);
  });
});

describe('점수 전부 되돌리기 (U126)', () => {
  it('유효한 모든 항목(1부 확정 + 수동 가감점)을 일괄 역분개해 합계를 0으로 만든다', () => {
    const s1 = run(
      withCurlingRanks(),
      { type: 'p1/confirm', eventId: 'curling', now: T0 },
      { type: 'ledger/manual', teamId: 't1', delta: 50, reason: '보너스', now: T0 + 500 },
    );
    expect(s1.ledger).toHaveLength(5); // 확정 4건 + 수동 1건
    expect(computeScores(s1).t1.total).toBe(150);

    const s2 = run(s1, { type: 'ledger/reverseAll', reason: '리셋', now: T0 + 1000 });

    // 원본 5건 + 역분개 5건 — 아무것도 삭제되지 않는다 (append-only)
    expect(s2.ledger).toHaveLength(10);
    expect(activeLedger(s2.ledger)).toHaveLength(0);
    const scores = computeScores(s2);
    expect(scores.t1.total).toBe(0);
    expect(scores.t2.total).toBe(0);
    expect(scores.t3.total).toBe(0);
    expect(scores.t4.total).toBe(0);
    // 역분개 사유는 호출부가 넘긴 reason을 그대로 접두어로 쓴다
    expect(s2.ledger.filter((e) => e.reverseOf).every((e) => e.reason.startsWith('리셋'))).toBe(true);
  });

  it('이미 전부 0이면 no-op — 상태 참조가 그대로다', () => {
    const s0 = createInitialState();
    expect(activeLedger(s0.ledger)).toHaveLength(0);
    const s1 = reducer(s0, { type: 'ledger/reverseAll', reason: '리셋', now: T0 });
    expect(s1).toBe(s0);
    expect(s1.ledger).toHaveLength(0);
  });

  it('이미 역분개된 항목은 다시 역분개하지 않는다 — 유효 항목만 대상', () => {
    const s1 = run(withCurlingRanks(), { type: 'p1/confirm', eventId: 'curling', now: T0 });
    const target = s1.ledger.find((e) => e.teamId === 't2')!;
    const s2 = run(s1, { type: 'ledger/reverse', entryId: target.id, now: T0 + 100 });
    // 이 시점 유효 항목: t1·t3·t4 확정분 3건 (t2분은 이미 역분개됨)
    expect(activeLedger(s2.ledger)).toHaveLength(3);

    const s3 = run(s2, { type: 'ledger/reverseAll', reason: '리셋', now: T0 + 200 });
    // 5건(원본4+역분개1) + 새 역분개 3건 = 8건. t2의 역분개를 또 되짚지 않는다.
    expect(s3.ledger).toHaveLength(8);
    expect(activeLedger(s3.ledger)).toHaveLength(0);
    expect(computeScores(s3).t2.total).toBe(0);
  });

  it('전부 0으로 동률이어도 순위 판정이 깨지지 않는다 (동률은 팀 순서 유지)', () => {
    const s1 = run(withCurlingRanks(), { type: 'p1/confirm', eventId: 'curling', now: T0 });
    const s2 = run(s1, { type: 'ledger/reverseAll', reason: '리셋', now: T0 + 100 });
    expect(rankedTeams(s2)).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('원장·순번 외 상태(U71 game.winner 등 sceneOpts)는 건드리지 않는다', () => {
    const s1 = run(withCurlingRanks(), { type: 'p1/confirm', eventId: 'curling', now: T0 });
    const s2 = run(s1, { type: 'ledger/reverseAll', reason: '리셋', now: T0 + 100 });
    // reverseAll은 ledger·seq만 스프레드하므로 sceneOpts 참조 자체가 그대로다 — game.winner 포함
    expect(s2.sceneOpts).toBe(s1.sceneOpts);
    expect(s2.pgm).toBe(s1.pgm);
    expect(s2.p1).toBe(s1.p1);
    expect(s2.p2).toBe(s1.p2);
  });
});

/**
 * U126b — 사용자 보강(2026-09-05 10:5x): "점수만 되돌리는 거야. 게임을 오늘 새로 시작할 수
 * 있도록." `game/restart`는 `ledger/reverseAll`과 같은 일괄 역분개에 더해 점수가 아닌 진행
 * 상태(승리 팀 선택·점수 공개 강조·2부 제출 기록·시상 박자·전체 진행 단계·큐 커서)까지 함께
 * 초기 위치로 되돌리는 복합 액션이다. 설정·에셋·팀·음악·현재 화면·타이머·2부 잠금 상태·1부
 * 종목 진행(`p1.events`)은 목록에 없어 손대지 않는다.
 */
describe('새 게임 시작 game/restart (U126b)', () => {
  /** 점수·승리 선택·2부 진행·1부 종목 진행·시상 박자·진행 단계·큐 커서를 전부 채운 상태 */
  function playedState() {
    let s = run(
      withCurlingRanks(),
      { type: 'p1/roster', eventId: 'curling', teamId: 't1', text: '김철수, 이영희' },
      { type: 'p1/confirm', eventId: 'curling', now: T0 },
    );
    s = run(
      s,
      { type: 'sceneOpts/patch', patch: { game: { winner: 't2' }, score: { highlight: 'curling' } } },
      { type: 'p2/unlock' },
      { type: 'p2/submit', stageId: 's1', teamId: 't1', at: T0 + 10 },
      { type: 'p2/correct', stageId: 's1', teamId: 't1', correct: true },
      { type: 'p2/confirm', stageId: 's1', now: T0 + 20 },
      { type: 'p2/eliminate', code: 'suspect-x', on: true },
      { type: 'award/step', step: 'total' },
      { type: 'award/revealNext' }, // rankRevealed: false → true
      { type: 'award/revealNext' }, // revealed: 0 → 1, rankRevealed: false
      { type: 'phase/set', phase: 'p2' },
      { type: 'cue/index', index: 5, cueId: 'live-curling' },
    );
    return s;
  }

  it('점수를 0으로 되돌리고 승리 선택·점수 공개·2부 제출·1부 종목 진행·시상 박자·진행 단계·큐 커서를 초기화한다', () => {
    const before = playedState();
    // 준비가 제대로 됐는지 먼저 확인 — 이게 틀리면 아래 "초기화됐다"가 무의미하다
    expect(before.sceneOpts.game.winner).toBe('t2');
    expect(before.sceneOpts.score.highlight).toBe('curling');
    expect(before.p2.stages.find((s) => s.id === 's1')!.confirmedAt).not.toBeNull();
    expect(before.p2.eliminated).toContain('suspect-x');
    expect(before.sceneOpts.award.revealed).toBeGreaterThan(0);
    expect(before.phase).toBe('p2');
    expect(before.cueIndex).toBe(5);
    expect(computeScores(before).t1.total).toBeGreaterThan(0);
    const beforeCurling = getEvent(before, 'curling');
    expect(beforeCurling.status).toBe('done');
    expect(beforeCurling.confirmedAt).not.toBeNull();
    expect(beforeCurling.roster.t1).toBe('김철수, 이영희');

    const after = reducer(before, { type: 'game/restart', reason: '새 게임 시작', now: T0 + 9999 });

    // 점수 — 일괄 역분개, 기록은 남는다
    expect(activeLedger(after.ledger)).toHaveLength(0);
    expect(after.ledger.length).toBeGreaterThan(before.ledger.length);
    const scores = computeScores(after);
    for (const id of ['t1', 't2', 't3', 't4'] as const) expect(scores[id].total).toBe(0);

    // 진행 상태
    expect(after.sceneOpts.game.winner).toBeNull();
    expect(after.sceneOpts.score.highlight).toBeNull();
    for (const stage of after.p2.stages) {
      expect(stage.status).toBe('pending');
      expect(stage.confirmedAt).toBeNull();
      expect(Object.values(stage.submissions).every((v) => v === null)).toBe(true);
      expect(Object.values(stage.ranks).every((v) => v === null)).toBe(true);
    }
    expect(after.p2.eliminated).toEqual([]);
    expect(after.sceneOpts.award).toEqual({
      step: 'p1',
      revealed: 0,
      rankRevealed: false,
      selectedRank: null,
      selectedTeamRevealed: false,
      revealedRanks: [],
      solo: false,
    });
    expect(after.phase).toBe('pre');
    expect(after.cueIndex).toBe(0);
    expect(after.cueId).toBe('pre-mission');

    // 1부 종목 진행(U126b 마지막 보강) — 4종목 전부 확정 전 상태로
    for (const event of after.p1.events) {
      expect(event.status).toBe('pending');
      expect(event.round).toBe(1);
      expect(event.confirmedAt).toBeNull();
      expect(Object.values(event.ranks).every((v) => v === null)).toBe(true);
    }
    const afterCurling = getEvent(after, 'curling');
    expect(afterCurling.curling).toEqual(createCurlingBracket());
  });

  it('설정·에셋·팀·음악·현재 화면·타이머·2부 잠금은 건드리지 않고, 1부 종목의 id·이름·명단은 유지한다', () => {
    const before = playedState();
    const after = reducer(before, { type: 'game/restart', reason: '새 게임 시작', now: T0 + 9999 });

    expect(after.settings).toBe(before.settings);
    expect(after.assets).toBe(before.assets);
    expect(after.teams).toBe(before.teams);
    expect(after.music).toBe(before.music);
    expect(after.scene).toBe(before.scene);
    expect(after.timer).toBe(before.timer);
    // p2.unlocked는 목록에 없어 손대지 않는다 — 잠금 해제 상태 그대로 유지
    expect(after.p2.unlocked).toBe(before.p2.unlocked);
    expect(after.p2.unlocked).toBe(true);
    // 1부 종목의 id·이름·출전 명단(roster)은 "새 게임"에서도 남아야 하는 설정성 값이다
    for (const [beforeEvent, afterEvent] of before.p1.events.map(
      (e, i) => [e, after.p1.events[i]] as const,
    )) {
      expect(afterEvent.id).toBe(beforeEvent.id);
      expect(afterEvent.name).toBe(beforeEvent.name);
      expect(afterEvent.roster).toEqual(beforeEvent.roster);
    }
    expect(getEvent(after, 'curling').roster.t1).toBe('김철수, 이영희');
  });

  it('되돌리는 것과 두는 것이 액션 주석에 값으로도 어긋나지 않는다 — 씬은 절대 바뀌지 않는다', () => {
    const before = playedState();
    const after = reducer(before, { type: 'game/restart', reason: '새 게임 시작', now: T0 + 1 });
    expect(after.scene).toBe('standby');
  });
});

describe('컬링 토너먼트 승패 입력', () => {
  it('구 저장본에 컬링 대진이 없거나 깨졌으면 빈 4경기 대진으로 복구한다', () => {
    const missing = deserialize(JSON.stringify({ p1: { events: [{ id: 'curling' }] } }));
    expect(missing.p1.events.find((event) => event.id === 'curling')?.curling).toMatchObject({
      semi1: { teams: [null, null], winner: null },
      semi2: { teams: [null, null], winner: null },
      final: { teams: [null, null], winner: null },
      bronze: { teams: [null, null], winner: null },
    });

    const invalid = deserialize(
      JSON.stringify({ p1: { events: [{ id: 'curling', curling: 'broken' }] } }),
    );
    expect(invalid.p1.events.find((event) => event.id === 'curling')?.curling).toMatchObject({
      semi1: { teams: [null, null], winner: null },
    });
  });

  it('4경기 승패를 기록하면 순위표와 기존 원장 확정 경로가 자동으로 이어진다', () => {
    const ranked = run(
      createInitialState(),
      { type: 'p1/curlingPair', matchId: 'semi1', teams: ['t1', 't2'] },
      { type: 'p1/curlingPair', matchId: 'semi2', teams: ['t3', 't4'] },
      { type: 'p1/curlingWinner', matchId: 'semi1', winner: 't1' },
      { type: 'p1/curlingWinner', matchId: 'semi2', winner: 't4' },
      { type: 'p1/curlingWinner', matchId: 'final', winner: 't4' },
      { type: 'p1/curlingWinner', matchId: 'bronze', winner: 't2' },
    );
    expect(getEvent(ranked, 'curling').ranks).toMatchObject({ t4: 1, t1: 2, t2: 3, t3: 4 });

    const confirmed = reducer(ranked, { type: 'p1/confirm', eventId: 'curling', now: T0 });
    expect(computeScores(confirmed).t4.p1).toBe(100);
    expect(computeScores(confirmed).t3.p1).toBe(30);
  });

  it('확정된 다음 회차는 이전 원장을 보존하고 새 토너먼트 표를 연다', () => {
    const confirmed = run(withCurlingRanks(), { type: 'p1/confirm', eventId: 'curling', now: T0 });
    const oldBracket = getEvent(confirmed, 'curling').curling;
    const next = reducer(confirmed, { type: 'p1/nextRound', eventId: 'curling' });
    expect(getEvent(next, 'curling').curling).not.toBe(oldBracket);
    expect(getEvent(next, 'curling').curling?.semi1.teams).toEqual([null, null]);
    expect(computeScores(next).t1.p1).toBe(100);
  });
});

describe('1부 종목별 원시 기록 입력', () => {
  it('점수 입력은 음수·NaN을 안전하게 비움 처리한다', () => {
    let s = reducer(createInitialState(), { type: 'p1/value', eventId: 'sticky', teamId: 't1', value: -1 });
    expect(s.p1.events.find((event) => event.id === 'sticky')?.values?.t1).toBeNull();
    s = reducer(s, { type: 'p1/value', eventId: 'sticky', teamId: 't1', value: Number.NaN });
    expect(s.p1.events.find((event) => event.id === 'sticky')?.values?.t1).toBeNull();
  });

  it.each([
    ['sticky', 120],
    ['sync', 7],
  ] as const)('%s 기록은 큰 값 우선 순위를 자동 갱신한다', (eventId, value) => {
    let state = reducer(createInitialState(), { type: 'p1/value', eventId, teamId: 't1', value });
    state = reducer(state, { type: 'p1/value', eventId, teamId: 't2', value: value + 1 });
    const event = getEvent(state, eventId);
    expect(event.values).toMatchObject({ t1: value, t2: value + 1 });
    expect(event.ranks).toMatchObject({ t1: 2, t2: 1, t3: null, t4: null });
  });

  it('신문지 달리기는 팀별 두 선수 시간을 초 단위로 보존하고 순위는 별도 입력한다', () => {
    let state = reducer(createInitialState(), {
      type: 'p1/newspaperTime',
      teamId: 't3',
      runner: 0,
      value: 12.34,
    });
    state = reducer(state, {
      type: 'p1/newspaperTime',
      teamId: 't3',
      runner: 1,
      value: 13.21,
    });
    expect(getEvent(state, 'newspaper').newspaperTimes?.t3).toEqual([12.34, 13.21]);
    expect(getEvent(state, 'newspaper').ranks.t3).toBeNull();
  });

  it('신문지 선수 기록은 음수·NaN을 안전하게 비움 처리한다', () => {
    let state = reducer(createInitialState(), {
      type: 'p1/newspaperTime',
      teamId: 't1',
      runner: 0,
      value: -0.1,
    });
    expect(getEvent(state, 'newspaper').newspaperTimes?.t1[0]).toBeNull();
    state = reducer(state, {
      type: 'p1/newspaperTime',
      teamId: 't1',
      runner: 1,
      value: Number.NaN,
    });
    expect(getEvent(state, 'newspaper').newspaperTimes?.t1[1]).toBeNull();
  });

  it('구 저장본의 누락되거나 깨진 신문지 기록은 팀별 빈 2슬롯으로 복구한다', () => {
    const invalid = deserialize(
      JSON.stringify({ p1: { events: [{ id: 'newspaper', newspaperTimes: 'broken' }] } }),
    );
    expect(getEvent(invalid, 'newspaper').newspaperTimes).toMatchObject({
      t1: [null, null],
      t2: [null, null],
      t3: [null, null],
      t4: [null, null],
    });
  });
});

describe('후반 확정 — 제출 시각 기반', () => {
  it('동시 제출(5초 이내)은 공동 순위 평균 점수로 원장에 기록된다', () => {
    const s = run(
      createInitialState(),
      { type: 'p2/unlock' },
      { type: 'p2/submit', stageId: 's1', teamId: 't2', at: T0 },
      { type: 'p2/submit', stageId: 's1', teamId: 't3', at: T0 + 2000 },
      { type: 'p2/submit', stageId: 's1', teamId: 't1', at: T0 + 30_000 },
      { type: 'p2/confirm', stageId: 's1', now: T0 + 60_000 },
    );
    const scores = computeScores(s);
    expect(scores.t2.p2).toBe(250);
    expect(scores.t3.p2).toBe(250);
    expect(scores.t1.p2).toBe(150);
    expect(scores.t4.p2).toBe(0);
    expect(getStage(s, 's1').ranks.t2).toBe(1);
    expect(getStage(s, 's1').ranks.t1).toBe(3);
  });

  it('오답 처리한 팀은 순위에서 빠진다', () => {
    const s = run(
      createInitialState(),
      { type: 'p2/unlock' },
      { type: 'p2/submit', stageId: 's2', teamId: 't1', at: T0 },
      { type: 'p2/correct', stageId: 's2', teamId: 't1', correct: false },
      { type: 'p2/submit', stageId: 's2', teamId: 't2', at: T0 + 10_000 },
      { type: 'p2/confirm', stageId: 's2', now: T0 + 20_000 },
    );
    expect(computeScores(s).t1.p2).toBe(0);
    expect(computeScores(s).t2.p2).toBe(300);
  });

  it('1부와 후반 점수가 분리 집계되고 총합이 일치한다', () => {
    const s = run(
      withCurlingRanks(),
      { type: 'p1/confirm', eventId: 'curling', now: T0 },
      { type: 'p2/unlock' },
      { type: 'p2/submit', stageId: 's1', teamId: 't1', at: T0 + 1000 },
      { type: 'p2/confirm', stageId: 's1', now: T0 + 2000 },
    );
    const t1 = computeScores(s).t1;
    expect(t1.p1).toBe(100);
    expect(t1.p2).toBe(300);
    expect(t1.total).toBe(400);
    expect(t1.total).toBe(t1.p1 + t1.p2);
  });
});

describe('직렬화 · 복구', () => {
  it('직렬화 라운드트립 후 상태와 점수가 동일하다', () => {
    const s = run(
      withCurlingRanks(),
      { type: 'p1/confirm', eventId: 'curling', now: T0 },
      { type: 'team/patch', teamId: 't1', patch: { name: '불꽃팀', color: '#ff0000' } },
      { type: 'scene/set', scene: 'score', opts: { score: { highlight: 'curling' } } },
      { type: 'timer/preset', preset: 'sync15', durationSec: 15 },
    );
    const back = deserialize(serialize(s));
    expect(back).toEqual(s);
    expect(computeScores(back).t1.total).toBe(computeScores(s).t1.total);
    expect(back.teams[0].name).toBe('불꽃팀');
    expect(back.sceneOpts.score.highlight).toBe('curling');
  });

  it('필드가 빠진 예전 저장본도 초기값으로 채워 복구한다', () => {
    const partial = JSON.stringify({ version: 1, scene: 'live', ledger: [] });
    const back = deserialize(partial);
    expect(back.scene).toBe('live');
    expect(activeTeams(back)).toHaveLength(4); // 확정된 행사 기본 4팀
    expect(back.settings.scoreTable.p1).toEqual([100, 80, 50, 30, 20, 10]);
    expect(back.p2.unlocked).toBe(false);
  });

  it('게임 화면의 누락 값은 기본 오프닝, 알 수 없는 모드는 대기 이미지로 복구한다 (U71)', () => {
    // 키 자체가 없는 저장본은 기본값 그대로다
    const missing = deserialize(JSON.stringify({ scene: 'game', sceneOpts: {} }));
    expect(missing.sceneOpts.game).toEqual({ eventId: 'curling', mode: 'opening', winner: null });

    // 값이 들어 있는데 코드가 모르는 값이면 `standby`(그 종목 그림 한 장)로 접는다 —
    // 승리 모드가 추가된 뒤 롤백된 빌드가 이 저장본을 열어도 빈 타이틀 카드가 나오지 않는다.
    const malformed = deserialize(
      JSON.stringify({ scene: 'game', sceneOpts: { game: { eventId: 'unknown', mode: 'broken' } } }),
    );
    expect(malformed.sceneOpts.game).toEqual({ eventId: 'curling', mode: 'standby', winner: null });

    const nullGame = deserialize(JSON.stringify({ scene: 'game', sceneOpts: { game: null } }));
    expect(nullGame.sceneOpts.game).toEqual({ eventId: 'curling', mode: 'opening', winner: null });

    const valid = deserialize(
      JSON.stringify({ scene: 'game', sceneOpts: { game: { eventId: 'sticky', mode: 'standby' } } }),
    );
    expect(valid.sceneOpts.game).toEqual({ eventId: 'sticky', mode: 'standby', winner: null });
  });

  it('승리 팀은 실재하는 활성 슬롯일 때만 살아난다 (U71)', () => {
    const kept = deserialize(
      JSON.stringify({ scene: 'game', sceneOpts: { game: { eventId: 'newspaper', mode: 'standby', winner: 't3' } } }),
    );
    expect(kept.sceneOpts.game).toEqual({ eventId: 'newspaper', mode: 'standby', winner: 't3' });

    // t5·t6은 이번 행사에 없는 호환 슬롯이다 — 승리 영상 해석이 영영 null이 되지 않게 떨군다
    for (const bad of ['t6', 'nope', 42, null]) {
      const dropped = deserialize(
        JSON.stringify({ scene: 'game', sceneOpts: { game: { mode: 'standby', winner: bad } } }),
      );
      expect(dropped.sceneOpts.game.winner).toBeNull();
    }
  });

  /**
   * U110 (04:56 사용자 지시) — 승리 보드 카드 씬이 폐기됐다. 저장본에 남은 `'victory'`가
   * 그대로 살아나면 렌더할 것이 없는 씬 id가 상태에 남아 검정이 나간다.
   */
  it('저장본에 남은 `victory` 모드는 대기로 접힌다 — 승리 팀은 지킨다 (U110)', () => {
    const restored = deserialize(
      JSON.stringify({
        scene: 'game',
        sceneOpts: { game: { eventId: 'curling', mode: 'victory', winner: 't2' } },
      }),
    );
    expect(restored.sceneOpts.game.mode).toBe('standby');
    // 승리 팀은 다음 발표에 다시 쓰이는 값이라 함께 버리지 않는다
    expect(restored.sceneOpts.game.winner).toBe('t2');
    expect(restored.sceneOpts.game.eventId).toBe('curling');
  });

  it('승리 음악은 라이브러리에 실재하는 곡 id일 때만 살아난다 (U110)', () => {
    const kept = deserialize(JSON.stringify({ settings: { victoryMusicTrackId: '03' } }));
    expect(kept.settings.victoryMusicTrackId).toBe('03');
    // 곡 목록이 바뀌어 없는 id가 남으면 `music/play`가 조용히 무시해 음악만 빠진 채 나간다.
    // `undefined`는 `JSON.stringify`가 키째 지우므로 아래 "키 없음" 케이스와 같아진다 —
    // 그래서 이 목록에서는 뺐다(U119로 "키 없음"의 결과가 null이 아니게 되며 갈라졌다).
    for (const bad of ['9999', '', 42, null]) {
      const dropped = deserialize(JSON.stringify({ settings: { victoryMusicTrackId: bad } }));
      expect(dropped.settings.victoryMusicTrackId).toBeNull();
    }
    // 공개본에는 행사별 기본 곡이 없으므로 키가 없는 저장본도 미지정으로 시작한다.
    expect(deserialize(JSON.stringify({})).settings.victoryMusicTrackId).toBeNull();
  });

  it('구버전 4팀 저장본은 4팀 그대로 복구되고 순위 맵만 6슬롯으로 채워진다', () => {
    const legacy = JSON.stringify({
      version: 1,
      teams: [
        { id: 't1', name: '가', color: '#111111' },
        { id: 't2', name: '나', color: '#222222' },
        { id: 't3', name: '다', color: '#333333' },
        { id: 't4', name: '라', color: '#444444' },
      ],
      settings: { scoreTable: { p1: [100, 80, 50, 30], p2: [300, 200, 150, 100] } },
      ledger: [],
    });
    const back = deserialize(legacy);
    expect(back.teamCount).toBe(4);
    expect(activeTeams(back)).toHaveLength(4);
    expect(back.teams[0].name).toBe('가');
    // 슬롯 자체는 6개가 유지된다 (나중에 6팀으로 늘려도 데이터가 준비돼 있다)
    expect(back.teams).toHaveLength(6);
    // 점수표는 팀 수가 늘어날 수 있으니 6칸으로 늘려 두되 앞 4칸은 그대로다
    expect(back.settings.scoreTable.p1.slice(0, 4)).toEqual([100, 80, 50, 30]);
    expect(back.settings.scoreTable.p1).toHaveLength(6);
    // 순위·명단·제출 맵은 항상 6슬롯
    expect(Object.keys(back.p1.events[0].ranks).sort()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    expect(back.p1.events[0].ranks.t5).toBeNull();
    expect(back.p2.stages[0].submissions.t6).toBeNull();
  });

  it('알려진 이전 기본값만 중립 Event Console 문구로 안전하게 올린다', () => {
    const legacy = createInitialState();
    legacy.teamCount = 6;
    legacy.teams = legacy.teams.map((team, i) => ({ ...team, name: `${i + 1}팀` }));
    legacy.settings.title = 'y9 올출데이 올림픽';
    legacy.settings.subtitle = 'YEAR NINE SUMMER GAMES';

    const back = deserialize(JSON.stringify(legacy));
    expect(back.teamCount).toBe(4);
    expect(back.teams.map((team) => team.name)).toEqual([...DEFAULT_TEAM_NAMES]);
    expect(back.settings.title).toBe('EVENT CONSOLE');
    expect(back.settings.subtitle).toBe('행사를 준비하고 있습니다');
  });

  it('비활성 팀 슬롯 이름·브랜드 문구는 migration에서 덮어쓰지 않는다', () => {
    const custom = createInitialState();
    custom.teamCount = 6;
    custom.teams = custom.teams.map((team, i) => ({ ...team, name: `커스텀 ${i + 1}` }));
    custom.settings.title = '우리 행사';
    custom.settings.subtitle = '직접 쓴 카피';

    const back = deserialize(JSON.stringify(custom));
    expect(back.teamCount).toBe(4);
    expect(back.teams.map((team) => team.name)).toEqual([
      '커스텀 1',
      '커스텀 2',
      '커스텀 3',
      '커스텀 4',
      '커스텀 5',
      '커스텀 6',
    ]);
    expect(back.settings.title).toBe('우리 행사');
    expect(back.settings.subtitle).toBe('직접 쓴 카피');
  });

  it('제시어 씬을 가리키던 예전 저장본은 대기 화면으로 되돌린다', () => {
    const back = deserialize(JSON.stringify({ version: 1, scene: 'prompt', ledger: [] }));
    expect(back.scene).toBe('standby');
  });

  it('점수표를 바꾸면 이후 확정부터 새 배점이 적용된다', () => {
    const s = run(
      withCurlingRanks(),
      { type: 'settings/patch', patch: { scoreTable: { p1: [10, 8, 5, 3, 2, 1] } } },
      { type: 'p1/confirm', eventId: 'curling', now: T0 },
    );
    expect(computeScores(s).t1.total).toBe(10);
    expect(s.settings.scoreTable.p2).toEqual([300, 200, 150, 100, 70, 40]); // 다른 표는 보존
  });
});

describe('확정 참가 팀 4팀', () => {
  it('신규 행사는 색 이름 4팀과 확정 브랜드 문구로 시작한다', () => {
    const s = createInitialState();
    expect(s.teamCount).toBe(4);
    expect(activeTeams(s).map((team) => team.name)).toEqual(DEFAULT_TEAM_NAMES.slice(0, 4));
    expect(s.settings.scoreTable.p1).toHaveLength(6);
    expect(s.settings.scoreTableProvisional).toBe(false);
    expect(s.settings.title).toBe('EVENT CONSOLE');
    expect(s.settings.subtitle).toBe('행사를 준비하고 있습니다');
  });

  it('팀 수 변경 액션이 들어와도 확정된 4팀만 유지한다', () => {
    let s = reducer(createInitialState(), { type: 'teams/count', count: 6 });
    expect(s.teamCount).toBe(4);
    for (const [i, id] of (['t1', 't2', 't3', 't4'] as const).entries()) {
      s = reducer(s, { type: 'p1/rank', eventId: 'curling', teamId: id, rank: i + 1 });
    }
    s = reducer(s, { type: 'p1/confirm', eventId: 'curling', now: T0 });
    expect(s.ledger).toHaveLength(4);
    expect(computeScores(s).t5.total).toBe(0);
    expect(computeScores(s).t6.total).toBe(0);
  });

  it('비활성 슬롯 이름·컬러는 보존하지만 참가 팀에는 들어오지 않는다', () => {
    let s = reducer(createInitialState(), { type: 'team/patch', teamId: 't6', patch: { name: '여섯' } });
    s = reducer(s, { type: 'teams/count', count: 6 });
    expect(activeTeams(s)).toHaveLength(4);
    expect(s.teams[5].name).toBe('여섯'); // 슬롯을 지우지 않으므로 설정이 그대로 살아 있다
  });

  it('팀 수를 4로 줄이면 5·6팀 순위를 남겨 둬도 점수가 잡히지 않는다', () => {
    let s = createInitialState();
    for (const [i, id] of (['t1', 't2', 't3', 't4', 't5', 't6'] as const).entries()) {
      s = reducer(s, { type: 'p1/rank', eventId: 'curling', teamId: id, rank: i + 1 });
    }
    s = reducer(s, { type: 'teams/count', count: 4 });
    s = reducer(s, { type: 'p1/confirm', eventId: 'curling', now: T0 });
    expect(s.ledger).toHaveLength(4);
    expect(computeScores(s).t5.total).toBe(0);
    expect(computeScores(s).t6.total).toBe(0);
  });

  it('어떤 팀 수 입력도 확정값 4로 맞춘다', () => {
    expect(reducer(createInitialState(), { type: 'teams/count', count: 2 }).teamCount).toBe(4);
    expect(reducer(createInitialState(), { type: 'teams/count', count: 9 }).teamCount).toBe(4);
  });

  it('시상 공개 수는 팀 수를 넘지 않는다', () => {
    const six = reducer(
      reducer(createInitialState(), { type: 'teams/count', count: 6 }),
      { type: 'award/reveal', revealed: 99 },
    );
    expect(six.sceneOpts.award.revealed).toBe(4);
    const four = reducer(
      reducer(createInitialState(), { type: 'teams/count', count: 4 }),
      { type: 'award/reveal', revealed: 99 },
    );
    expect(four.sceneOpts.award.revealed).toBe(4);
  });

  it('시상 다음 공개는 등수를 먼저 열고 다음 입력에 해당 팀을 확정한다', () => {
    let s = createInitialState();

    s = reducer(s, { type: 'award/revealNext' });
    expect(s.sceneOpts.award).toMatchObject({ revealed: 0, rankRevealed: true });

    s = reducer(s, { type: 'award/revealNext' });
    expect(s.sceneOpts.award).toMatchObject({ revealed: 1, rankRevealed: false });
  });

  it('원하는 등수를 직접 선택하고 두 번째 입력에서 팀을 공개한다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'award/selectRank', rank: 2 });
    expect(s.sceneOpts.award).toMatchObject({
      step: 'reveal',
      selectedRank: 2,
      selectedTeamRevealed: false,
      revealedRanks: [],
    });

    s = reducer(s, { type: 'award/revealSelectedTeam' });
    expect(s.sceneOpts.award).toMatchObject({ selectedRank: 2, selectedTeamRevealed: true, revealedRanks: [2] });
  });

  it('이미 공개한 등수도 다시 선택하면 팀을 닫고 두 박자로 재공개한다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'award/selectRank', rank: 4 });
    s = reducer(s, { type: 'award/revealSelectedTeam' });
    s = reducer(s, { type: 'award/selectRank', rank: 1 });
    s = reducer(s, { type: 'award/revealSelectedTeam' });
    s = reducer(s, { type: 'award/selectRank', rank: 4 });
    expect(s.sceneOpts.award).toMatchObject({
      selectedRank: 4,
      selectedTeamRevealed: false,
      revealedRanks: [4, 1],
    });
  });

  it('직접 선택 시상 저장값은 등수 범위와 타입을 안전하게 보정한다', () => {
    const invalid = deserialize(
      JSON.stringify({
        sceneOpts: {
          award: { selectedRank: 9, selectedTeamRevealed: 'yes', revealedRanks: [4, 2, 2, 9, '1'] },
        },
      }),
    );
    expect(invalid.sceneOpts.award).toMatchObject({
      selectedRank: null,
      selectedTeamRevealed: false,
      revealedRanks: [4, 2],
    });
  });

  it('시상 공개는 8박자로 4팀을 완료하고 아홉 번째 입력은 no-op이다', () => {
    let s = createInitialState();
    const expected = [
      { revealed: 0, rankRevealed: true },
      { revealed: 1, rankRevealed: false },
      { revealed: 1, rankRevealed: true },
      { revealed: 2, rankRevealed: false },
      { revealed: 2, rankRevealed: true },
      { revealed: 3, rankRevealed: false },
      { revealed: 3, rankRevealed: true },
      { revealed: 4, rankRevealed: false },
    ];

    for (const award of expected) {
      s = reducer(s, { type: 'award/revealNext' });
      expect(s.sceneOpts.award).toMatchObject(award);
    }

    const complete = s;
    expect(reducer(complete, { type: 'award/revealNext' })).toBe(complete);
  });

  it('시상 공개 되돌리기는 팀을 먼저 숨기고 다음 입력에 등수를 닫는다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'award/reveal', revealed: 2 });

    s = reducer(s, { type: 'award/revealPrevious' });
    expect(s.sceneOpts.award).toMatchObject({ revealed: 1, rankRevealed: true });

    s = reducer(s, { type: 'award/revealPrevious' });
    expect(s.sceneOpts.award).toMatchObject({ revealed: 1, rankRevealed: false });
  });

  it('완료 상태에서 8박자를 되돌리면 초기 상태가 되고 아홉 번째 입력은 no-op이다', () => {
    let s = createInitialState();
    for (let i = 0; i < 8; i += 1) s = reducer(s, { type: 'award/revealNext' });

    const expected = [
      { revealed: 3, rankRevealed: true },
      { revealed: 3, rankRevealed: false },
      { revealed: 2, rankRevealed: true },
      { revealed: 2, rankRevealed: false },
      { revealed: 1, rankRevealed: true },
      { revealed: 1, rankRevealed: false },
      { revealed: 0, rankRevealed: true },
      { revealed: 0, rankRevealed: false },
    ];

    for (const award of expected) {
      s = reducer(s, { type: 'award/revealPrevious' });
      expect(s.sceneOpts.award).toMatchObject(award);
    }

    const initial = s;
    expect(reducer(initial, { type: 'award/revealPrevious' })).toBe(initial);
  });

  it('시상 등수 공개 상태가 없거나 잘못된 저장본은 닫힌 상태로 복구한다', () => {
    const legacy = deserialize(JSON.stringify({ sceneOpts: { award: { step: 'reveal', revealed: 1 } } }));
    expect(legacy.sceneOpts.award.rankRevealed).toBe(false);

    const invalid = deserialize(
      JSON.stringify({ sceneOpts: { award: { step: 'reveal', revealed: 1, rankRevealed: 'yes' } } }),
    );
    expect(invalid.sceneOpts.award.rankRevealed).toBe(false);

    const alreadyComplete = deserialize(
      JSON.stringify({ sceneOpts: { award: { step: 'reveal', revealed: 4, rankRevealed: true } } }),
    );
    expect(alreadyComplete.sceneOpts.award.rankRevealed).toBe(false);
  });
});

describe('라이브 카메라 설정', () => {
  it('출력 마스터 볼륨은 기본 100%이고 저장값을 0~1 범위로 보정한다', () => {
    expect(createInitialState().settings.masterVolume).toBe(1);
    expect(deserialize(JSON.stringify({ settings: { masterVolume: 0.42 } })).settings.masterVolume).toBe(0.42);
    expect(deserialize(JSON.stringify({ settings: { masterVolume: 2 } })).settings.masterVolume).toBe(1);
    expect(deserialize(JSON.stringify({ settings: { masterVolume: -1 } })).settings.masterVolume).toBe(0);
    expect(deserialize(JSON.stringify({ settings: { masterVolume: 'loud' } })).settings.masterVolume).toBe(1);
  });

  it('기존 저장본에도 양축 반전·무음 기본값을 보정한다', () => {
    const migrated = deserialize(JSON.stringify({ settings: { camera: { deviceId: 'camera-a' } } }));
    expect(migrated.settings.camera).toEqual({
      deviceId: 'camera-a',
      flipX: false,
      flipY: false,
      audio: false, // 하울링 방지 — 명시적으로 켜야만 켜진다
    });
  });

  it('사용자가 켠 카메라 오디오는 migration에서 보존된다', () => {
    const migrated = deserialize(
      JSON.stringify({ settings: { camera: { deviceId: 'camera-a', audio: true } } }),
    );
    expect(migrated.settings.camera.audio).toBe(true);
  });

  it('audio가 boolean이 아니면 무음으로 떨어진다', () => {
    const migrated = deserialize(JSON.stringify({ settings: { camera: { audio: 'yes' } } }));
    expect(migrated.settings.camera.audio).toBe(false);
  });
});

describe('영상 전환 오버레이', () => {
  it('재생과 종료를 상태로 명시하고 재생 토큰을 보존한다', () => {
    const playing = reducer(createInitialState(), {
      type: 'transition/play',
      assetId: 'sting-01',
      nextScene: 'score',
      switchAtSec: 0.8,
      now: T0,
    });

    expect(playing.scene).toBe('standby');
    expect(playing.sceneOpts.transitionVideo).toEqual({
      active: true,
      assetId: 'sting-01',
      nextScene: 'score',
      switchAtSec: 0.8,
      restartToken: T0,
      switched: false,
      nextStandbyMode: null,
    });

    const switched = reducer(playing, { type: 'transition/switched', token: T0 });
    expect(switched.scene).toBe('score');
    expect(switched.sceneOpts.transitionVideo.switched).toBe(true);

    const stale = reducer(switched, { type: 'transition/finish', token: T0 - 1 });
    expect(stale).toBe(switched);

    const finished = reducer(switched, { type: 'transition/finish', token: T0 });
    expect(finished.sceneOpts.transitionVideo.active).toBe(false);
    expect(finished.sceneOpts.transitionVideo.assetId).toBeNull();
  });

  it('교체 보고 없이 워치독이 끊어도 목표 씬으로 컷 전환한다', () => {
    const playing = reducer(createInitialState(), {
      type: 'transition/play',
      assetId: 'sting-01',
      nextScene: 'score',
      switchAtSec: 0.8,
      now: T0,
    });

    // display가 stall해 switch/ended가 한 번도 오지 않은 경우 control이 직접 끊는다
    const cut = reducer(playing, { type: 'transition/finish', token: T0 });

    expect(cut.scene).toBe('score');
    expect(cut.sceneOpts.transitionVideo).toMatchObject({
      active: false,
      assetId: null,
      nextScene: null,
      switched: true,
    });
  });

  it('오퍼레이터가 다른 씬을 직접 선택하면 진행 중인 영상 전환을 취소한다', () => {
    const playing = reducer(createInitialState(), {
      type: 'transition/play',
      assetId: 'sting-01',
      nextScene: 'score',
      switchAtSec: 0.8,
      now: T0,
    });
    const overridden = reducer(playing, { type: 'scene/set', scene: 'live' });

    expect(overridden.scene).toBe('live');
    expect(overridden.sceneOpts.transitionVideo).toMatchObject({
      active: false,
      assetId: null,
      nextScene: null,
      switched: false,
    });
    expect(reducer(overridden, { type: 'transition/switched', token: T0 })).toBe(overridden);
    expect(reducer(overridden, { type: 'transition/finish', token: T0 })).toBe(overridden);
  });
});

describe('화이트·블랙 씬 페이드', () => {
  it('구 저장본과 잘못된 전환 값은 안전한 스팅어 기본값으로 보정한다', () => {
    const legacy = createInitialState() as unknown as { settings: Record<string, unknown> };
    delete legacy.settings.sceneTransitionMode;
    expect(deserialize(JSON.stringify(legacy)).settings.sceneTransitionMode).toBe('stinger');
    legacy.settings.sceneTransitionMode = 'rainbow';
    expect(deserialize(JSON.stringify(legacy)).settings.sceneTransitionMode).toBe('stinger');
  });

  it('덮임 사건에서 씬을 바꾸고 종료 사건에서 페이드를 내린다', () => {
    const playing = reducer(createInitialState(), {
      type: 'sceneFade/play',
      color: '#ffffff',
      nextScene: 'score',
      durationSec: 0.5,
      now: T0,
    });
    expect(playing.scene).toBe('standby');
    expect(playing.sceneOpts.sceneFade).toEqual({
      active: true,
      color: '#ffffff',
      nextScene: 'score',
      durationSec: 0.5,
      restartToken: T0,
      switched: false,
      nextStandbyMode: null,
    });

    const switched = reducer(playing, { type: 'sceneFade/switched', token: T0 });
    expect(switched.scene).toBe('score');
    expect(switched.sceneOpts.sceneFade.switched).toBe(true);

    const finished = reducer(switched, { type: 'sceneFade/finish', token: T0 });
    expect(finished.sceneOpts.sceneFade).toMatchObject({ active: false, nextScene: null, switched: false });
  });

  it('이전 실행에서 늦게 온 사건은 무시한다', () => {
    const playing = reducer(createInitialState(), {
      type: 'sceneFade/play',
      color: '#000000',
      nextScene: 'live',
      durationSec: 0.5,
      now: T0,
    });
    expect(reducer(playing, { type: 'sceneFade/switched', token: T0 - 1 })).toBe(playing);
    expect(reducer(playing, { type: 'sceneFade/finish', token: T0 - 1 })).toBe(playing);
  });

  it('스팅어 전환 시작은 진행 중 컬러 페이드를 취소한다', () => {
    const fading = reducer(createInitialState(), {
      type: 'sceneFade/play',
      color: '#000000',
      nextScene: 'score',
      durationSec: 0.5,
      now: T0,
    });
    const stinger = reducer(fading, {
      type: 'transition/play',
      assetId: 'bridge',
      nextScene: 'live',
      switchAtSec: 0.5,
      now: T0 + 1,
    });

    expect(stinger.sceneOpts.sceneFade.active).toBe(false);
    expect(reducer(stinger, { type: 'sceneFade/switched', token: T0 })).toBe(stinger);
  });

  it('컬러 페이드 시작은 진행 중 스팅어 전환을 취소한다', () => {
    const stinger = reducer(createInitialState(), {
      type: 'transition/play',
      assetId: 'bridge',
      nextScene: 'live',
      switchAtSec: 0.5,
      now: T0,
    });
    const fading = reducer(stinger, {
      type: 'sceneFade/play',
      color: '#ffffff',
      nextScene: 'score',
      durationSec: 0.5,
      now: T0 + 1,
    });

    expect(fading.sceneOpts.transitionVideo.active).toBe(false);
    expect(reducer(fading, { type: 'transition/switched', token: T0 })).toBe(fading);
  });
});

describe('도입 스팅어 bake 매치 오버레이', () => {
  it('현재 씬을 바꾸거나 기본 전환을 거치지 않고 알파 영상을 시작한다', () => {
    const state = createInitialState();
    state.scene = 'live';

    const playing = reducer(state, {
      type: 'overlay/play',
      assetId: 'match-green-blue',
      holdEndFrame: true,
      now: T0,
    });

    expect(playing.scene).toBe('live');
    expect(playing.sceneOpts.overlayVideo).toEqual({
      active: true,
      assetId: 'match-green-blue',
      restartToken: T0,
      holdEndFrame: true,
      held: false,
    });
    expect(playing.sceneOpts.transitionVideo.active).toBe(false);
  });

  it('종료 프레임을 유지하고 오퍼레이터가 닫을 때까지 underlying 씬을 보존한다', () => {
    const playing = reducer(createInitialState(), {
      type: 'overlay/play',
      assetId: 'match-red-yellow',
      holdEndFrame: true,
      now: T0,
    });
    const held = reducer(playing, { type: 'overlay/held', token: T0 });
    expect(held.sceneOpts.overlayVideo).toMatchObject({ active: true, held: true });
    expect(reducer(held, { type: 'overlay/held', token: T0 - 1 })).toBe(held);

    const finished = reducer(held, { type: 'overlay/finish', token: T0 });
    expect(finished.scene).toBe('standby');
    expect(finished.sceneOpts.overlayVideo).toMatchObject({ active: false, assetId: null, held: false });
  });

  it('다음 씬 전환이 화면을 교체하는 순간 매치 오버레이를 함께 내린다', () => {
    const match = reducer(createInitialState(), {
      type: 'overlay/play',
      assetId: 'match-green-red',
      holdEndFrame: true,
      now: T0,
    });
    const bridge = reducer(match, {
      type: 'transition/play',
      assetId: 'bridge',
      nextScene: 'score',
      switchAtSec: 0.5,
      now: T0 + 1,
    });
    expect(bridge.sceneOpts.overlayVideo.active).toBe(true);

    const switched = reducer(bridge, { type: 'transition/switched', token: T0 + 1 });
    expect(switched.scene).toBe('score');
    expect(switched.sceneOpts.overlayVideo).toMatchObject({ active: false, assetId: null, held: false });
  });
});

describe('분위기 반전 전환', () => {
  it('현재 씬을 보존한 채 글리치 단계를 시작하고 중복 시작은 no-op이다', () => {
    const live = reducer(createInitialState(), { type: 'scene/set', scene: 'live' });
    const started = reducer(live, { type: 'mood/start', assetId: 'rendered-cut' });
    expect(started.scene).toBe('live');
    expect(started.sceneOpts.moodTransition).toMatchObject({
      active: true,
      phase: 'glitch',
      assetId: 'rendered-cut',
    });
    expect(reducer(started, { type: 'mood/start', assetId: 'rendered-cut' })).toBe(started);
  });

  it('글리치 → 검정 → 사전렌더 크로스디졸브로 전이하고 stale token은 무시한다 (U26)', () => {
    const started = reducer(createInitialState(), { type: 'mood/start', assetId: 'rendered-cut' });
    const token = started.sceneOpts.moodTransition.token;
    expect(reducer(started, { type: 'mood/blackout', token: token + 1 })).toBe(started);
    const blackout = reducer(started, { type: 'mood/blackout', token });
    expect(blackout.sceneOpts.moodTransition.phase).toBe('blackout');
    expect(reducer(blackout, { type: 'mood/crossfade', token: token + 1 })).toBe(blackout);
    const crossfade = reducer(blackout, { type: 'mood/crossfade', token });
    expect(crossfade.sceneOpts.moodTransition.phase).toBe('crossfade');
  });

  it('사전렌더 종료 또는 비상 스킵은 분위기 레이어를 완전히 닫는다', () => {
    const started = reducer(createInitialState(), { type: 'mood/start', assetId: 'rendered-cut' });
    const token = started.sceneOpts.moodTransition.token;
    const finished = reducer(started, { type: 'mood/finish', token });
    expect(finished.sceneOpts.moodTransition).toMatchObject({ active: false, phase: 'idle', assetId: null });
    expect(finished.scene).toBe('suspects');
  });

  it('비상 중단은 현재 씬을 바꾸지 않고 전환과 영상 오버레이를 함께 닫는다', () => {
    let state = reducer(createInitialState(), { type: 'mood/start', assetId: 'rendered-cut' });
    state = reducer(state, { type: 'overlay/play', assetId: 'rendered-cut', holdEndFrame: false, now: 10 });
    state = reducer(state, { type: 'mood/abort', token: state.sceneOpts.moodTransition.token });
    expect(state.scene).toBe('standby');
    expect(state.sceneOpts.moodTransition.active).toBe(false);
    expect(state.sceneOpts.overlayVideo.active).toBe(false);
  });
});

describe('migration — v1 → v2 (전환 규칙 · 페이드)', () => {
  it('구버전 저장본에 새 필드 기본값이 채워진다', () => {
    const back = deserialize(JSON.stringify({ version: 1, scene: 'live', ledger: [] }));

    expect(back.version).toBe(3);
    expect(back.transitionRules).toEqual({ defaultAssetId: null, byTo: {}, pairs: [] });
    expect(back.settings.fadeSec).toBe(0.5);
    expect(back.settings.camera.audio).toBe(false);
    expect(back.sceneOpts.video).toEqual({
      assetId: null,
      nextScene: null,
      paused: false,
      restartToken: 0,
      phase: 'idle',
      phaseToken: 0,
      fadeSec: 0.5,
      returnScene: null,
      holdEndFrame: false,
      // 대본 아웃트로(U87)는 재생 시작에만 채워진다 — 저장본에는 언제나 null로 내려앉는다
      outro: null,
    });
  });

  it('defaultAssetId 기본값이 null이라 기존 설치의 전환 동작이 그대로 유지된다', () => {
    // null = "지정 없음" → 해석기가 legacy(첫 정상 transition 에셋) 폴백을 그대로 쓴다.
    // 여기서 임의의 에셋 id가 들어가면 기존 현장 세팅이 조용히 바뀐다.
    expect(deserialize(JSON.stringify({ version: 1 })).transitionRules.defaultAssetId).toBeNull();
  });

  it('사용자가 지정한 전환 규칙·페이드·카메라 오디오는 보존된다', () => {
    const saved = {
      version: 1,
      ledger: [],
      transitionRules: {
        defaultAssetId: 'sting-default',
        byTo: { score: 'sting-score', award: 'sting-award' },
        pairs: [{ from: 'live', to: 'score', assetId: 'sting-live-score' }],
      },
      settings: { fadeSec: 1.25, camera: { deviceId: 'cam-1', audio: true } },
    };
    const back = deserialize(JSON.stringify(saved));

    expect(back.transitionRules).toEqual(saved.transitionRules);
    expect(back.settings.fadeSec).toBe(1.25);
    expect(back.settings.camera.audio).toBe(true);
    expect(back.settings.camera.deviceId).toBe('cam-1');
  });

  it('v1 저장본의 팀·원장·에셋 메타·설정은 전부 살아남는다 (회귀)', () => {
    const back = deserialize(
      JSON.stringify({
        version: 1,
        teams: [
          { id: 't1', name: '불꽃', color: '#b0463c', logoAssetId: 'logo_t1' },
          { id: 't2', name: '파도', color: '#3a6ea5' },
        ],
        teamCount: 4,
        ledger: [
          { id: 'L00001', ts: T0, teamId: 't1', delta: 100, reason: '컬링 1회 1위', ref: 'p1:curling' },
        ],
        seq: 1,
        assets: [
          { id: 'a1', name: 'open.mov', type: 'video', size: 10, mime: 'video/quicktime', playMode: 'transition' },
        ],
        hiddenMedia: ['old.mp4'],
        settings: { tieWindowSec: 9, title: '우리 행사', keyVisualAssetId: 'kv-1' },
      }),
    );

    expect(back.teams[0].name).toBe('불꽃');
    expect(back.teams[0].logoAssetId).toBe('logo_t1');
    expect(back.teamCount).toBe(4);
    expect(back.ledger).toHaveLength(1);
    expect(computeScores(back).t1.total).toBe(100);
    expect(back.assets[0].playMode).toBe('transition');
    expect(back.hiddenMedia).toEqual(['old.mp4']);
    expect(back.settings.tieWindowSec).toBe(9);
    expect(back.settings.title).toBe('우리 행사');
    expect(back.settings.keyVisualAssetId).toBe('kv-1');
  });

  it('손상된 transitionRules는 기본값으로 떨어진다', () => {
    for (const broken of ['nope', 42, [], null, true]) {
      const back = deserialize(JSON.stringify({ version: 1, transitionRules: broken }));
      expect(back.transitionRules).toEqual({ defaultAssetId: null, byTo: {}, pairs: [] });
    }
  });

  it('전환 규칙의 잘못된 씬 키·타입만 골라 버리고 나머지는 살린다', () => {
    const back = deserialize(
      JSON.stringify({
        version: 1,
        transitionRules: {
          defaultAssetId: 123,
          byTo: { score: 'ok', nosuchscene: 'bad', award: 42 },
          pairs: [
            { from: 'live', to: 'score', assetId: 'pair-ok' },
            { from: 'live', to: 'nosuchscene', assetId: 'bad-to' },
            { from: 'live', to: 'award' },
            'not-an-object',
            { from: 'live', to: 'score', assetId: 'pair-later' },
          ],
        },
      }),
    );

    expect(back.transitionRules.defaultAssetId).toBeNull();
    expect(back.transitionRules.byTo).toEqual({ score: 'ok' });
    // (live→score) 중복은 뒤엣것이 이긴다
    expect(back.transitionRules.pairs).toEqual([
      { from: 'live', to: 'score', assetId: 'pair-later' },
    ]);
  });

  it('fadeSec이 숫자가 아니거나 음수면 기본값으로 되돌린다', () => {
    expect(deserialize(JSON.stringify({ settings: { fadeSec: '0.5' } })).settings.fadeSec).toBe(0.5);
    expect(deserialize(JSON.stringify({ settings: { fadeSec: -1 } })).settings.fadeSec).toBe(0.5);
    expect(deserialize(JSON.stringify({ settings: { fadeSec: 0 } })).settings.fadeSec).toBe(0);
  });

  it('진행 중인 페이드 단계는 migrate가 건드리지 않는다 (display가 사건을 봐야 한다)', () => {
    // display는 모든 상태 방송을 deserialize() → migrate()로 받는다. 여기서 phase를 리셋하면
    // display가 covering/playing/revealing을 한 번도 못 보고 페이드가 통째로 죽는다.
    const back = deserialize(
      JSON.stringify({
        version: 1,
        scene: 'video',
        sceneOpts: {
          video: { assetId: 'a1', phase: 'playing', phaseToken: 7, fadeSec: 1, returnScene: 'live' },
        },
      }),
    );
    expect(back.sceneOpts.video.phase).toBe('playing');
    expect(back.sceneOpts.video.phaseToken).toBe(7);
    expect(back.sceneOpts.video.fadeSec).toBe(1);
    expect(back.sceneOpts.video.returnScene).toBe('live');
    expect(back.sceneOpts.video.assetId).toBe('a1');
  });

  it('알 수 없는 phase 문자열만 idle로 떨군다', () => {
    // display의 phase 분기가 어디에도 안 걸리면 검정이 걷히지 않은 채 굳는다
    const broken = deserialize(
      JSON.stringify({ version: 1, sceneOpts: { video: { phase: 'zzz' } } }),
    );
    expect(broken.sceneOpts.video.phase).toBe('idle');

    for (const phase of ['idle', 'covering', 'playing', 'revealing']) {
      const ok = deserialize(JSON.stringify({ version: 1, sceneOpts: { video: { phase } } }));
      expect(ok.sceneOpts.video.phase).toBe(phase);
    }
  });

  it('phaseToken·fadeSec·returnScene의 손상된 값만 보정한다', () => {
    const back = deserialize(
      JSON.stringify({
        version: 1,
        sceneOpts: { video: { phaseToken: 'x', fadeSec: -2, returnScene: 'nosuchscene' } },
      }),
    );
    expect(back.sceneOpts.video.phaseToken).toBe(0);
    expect(back.sceneOpts.video.fadeSec).toBe(0.5);
    expect(back.sceneOpts.video.returnScene).toBeNull();
  });

  it('phaseToken은 0 이상의 정수로 좁힌다 (음수·소수는 토큰 대조를 영영 어긋나게 한다)', () => {
    const neg = deserialize(
      JSON.stringify({ version: 1, sceneOpts: { video: { phaseToken: -3 } } }),
    );
    expect(neg.sceneOpts.video.phaseToken).toBe(0);

    const frac = deserialize(
      JSON.stringify({ version: 1, sceneOpts: { video: { phaseToken: 4.7 } } }),
    );
    expect(frac.sceneOpts.video.phaseToken).toBe(4);

    // 정상 값은 손대지 않는다
    const ok = deserialize(JSON.stringify({ version: 1, sceneOpts: { video: { phaseToken: 9 } } }));
    expect(ok.sceneOpts.video.phaseToken).toBe(9);
  });

  it('resetRuntimeVideoPhase만이 얼어붙은 단계를 푼다 (control 인수 경로)', () => {
    const frozen = deserialize(
      JSON.stringify({ version: 1, sceneOpts: { video: { phase: 'playing', phaseToken: 7 } } }),
    );
    const reset = resetRuntimeVideoPhase(frozen);
    expect(reset.sceneOpts.video.phase).toBe('idle');
    // 인수 직전에 날아다니던 사건까지 함께 무효화한다
    expect(reset.sceneOpts.video.phaseToken).toBe(8);

    // 이미 idle이면 같은 참조 (불필요한 저장·방송 방지)
    expect(resetRuntimeVideoPhase(reset)).toBe(reset);
    const fresh = createInitialState();
    expect(resetRuntimeVideoPhase(fresh)).toBe(fresh);
  });

  it('control 인수 시 저장본에 남은 매치 오버레이도 안전하게 내린다', () => {
    const frozen = reducer(createInitialState(), {
      type: 'overlay/play',
      assetId: 'match-blue-red',
      holdEndFrame: true,
      now: T0,
    });
    const reset = resetRuntimeVideoPhase(frozen);
    expect(reset.sceneOpts.overlayVideo).toMatchObject({ active: false, assetId: null, held: false });
  });

  it('normalizeTransitionRules는 순수하고 원본을 공유하지 않는다', () => {
    const raw = { defaultAssetId: 'a', byTo: { score: 'b' }, pairs: [{ from: 'live', to: 'score', assetId: 'c' }] };
    const out = normalizeTransitionRules(raw);
    out.byTo.score = 'changed';
    out.pairs.push({ from: 'award', to: 'standby', assetId: 'x' });
    expect(raw.byTo.score).toBe('b');
    expect(raw.pairs).toHaveLength(1);
  });
});

describe('전환 규칙 액션', () => {
  it('기본 대판을 지정하고 해제한다', () => {
    const set = reducer(createInitialState(), {
      type: 'transitionRules/setDefault',
      assetId: 'sting-01',
    });
    expect(set.transitionRules.defaultAssetId).toBe('sting-01');

    const cleared = reducer(set, { type: 'transitionRules/setDefault', assetId: null });
    expect(cleared.transitionRules.defaultAssetId).toBeNull();

    // 같은 값으로 다시 지정하면 참조가 그대로다 (불필요한 저장·리렌더 방지)
    expect(reducer(set, { type: 'transitionRules/setDefault', assetId: 'sting-01' })).toBe(set);
  });

  it('도착 씬별 지정은 null로 해제하면 키 자체가 사라진다', () => {
    const set = run(
      createInitialState(),
      { type: 'transitionRules/setByTo', to: 'score', assetId: 'sting-score' },
      { type: 'transitionRules/setByTo', to: 'award', assetId: 'sting-award' },
    );
    expect(set.transitionRules.byTo).toEqual({ score: 'sting-score', award: 'sting-award' });

    const cleared = reducer(set, { type: 'transitionRules/setByTo', to: 'score', assetId: null });
    // 빈 문자열이 아니라 키 제거여야 해석기가 다음 우선순위로 폴백한다
    expect('score' in cleared.transitionRules.byTo).toBe(false);
    expect(cleared.transitionRules.byTo).toEqual({ award: 'sting-award' });

    // 이미 없는 키를 해제하면 상태가 그대로다
    expect(reducer(cleared, { type: 'transitionRules/setByTo', to: 'score', assetId: null })).toBe(
      cleared,
    );
  });

  it('같은 (from,to) pair를 다시 지정하면 자리를 유지한 채 덮어쓴다', () => {
    const s = run(
      createInitialState(),
      { type: 'transitionRules/setPair', from: 'live', to: 'score', assetId: 'p1' },
      { type: 'transitionRules/setPair', from: 'standby', to: 'live', assetId: 'p2' },
      { type: 'transitionRules/setPair', from: 'live', to: 'score', assetId: 'p1-new' },
    );
    expect(s.transitionRules.pairs).toEqual([
      { from: 'live', to: 'score', assetId: 'p1-new' },
      { from: 'standby', to: 'live', assetId: 'p2' },
    ]);

    // 같은 값 재지정은 무변경
    expect(
      reducer(s, { type: 'transitionRules/setPair', from: 'live', to: 'score', assetId: 'p1-new' }),
    ).toBe(s);
  });

  it('pair 삭제는 해당 조합만 지우고, 없는 조합이면 무변경이다', () => {
    const s = run(
      createInitialState(),
      { type: 'transitionRules/setPair', from: 'live', to: 'score', assetId: 'p1' },
      { type: 'transitionRules/setPair', from: 'standby', to: 'live', assetId: 'p2' },
    );
    const removed = reducer(s, { type: 'transitionRules/removePair', from: 'live', to: 'score' });
    expect(removed.transitionRules.pairs).toEqual([
      { from: 'standby', to: 'live', assetId: 'p2' },
    ]);
    expect(reducer(removed, { type: 'transitionRules/removePair', from: 'live', to: 'score' })).toBe(
      removed,
    );
  });

  it('전환 규칙은 직렬화 라운드트립에서 그대로 살아난다', () => {
    const s = run(
      createInitialState(),
      { type: 'transitionRules/setDefault', assetId: 'd' },
      { type: 'transitionRules/setByTo', to: 'award', assetId: 'a' },
      { type: 'transitionRules/setPair', from: 'live', to: 'score', assetId: 'p' },
    );
    expect(deserialize(serialize(s)).transitionRules).toEqual(s.transitionRules);
  });
});


describe('설명 영상 페이드 상태 머신', () => {
  /** payload는 assetId·nextScene·now 뿐 — 출발 씬과 페이드 길이는 reducer가 state에서 읽는다 */
  const playFull = (
    over: Partial<Extract<Action, { type: 'video/playFull' }>> = {},
  ): Extract<Action, { type: 'video/playFull' }> => ({
    type: 'video/playFull',
    assetId: 'clip-01',
    nextScene: 'score',
    now: T0,
    ...over,
  });

  it('playFull → covered → tail → revealed 정상 전이와 각 단계의 씬', () => {
    const covering = reducer(createInitialState(), playFull());
    // 검정이 덮기 전에는 씬이 그대로여야 한다 — 여기서 바뀌면 전환이 화면에 튄다
    expect(covering.scene).toBe('standby');
    expect(covering.sceneOpts.video).toMatchObject({
      assetId: 'clip-01',
      nextScene: 'score',
      paused: false,
      restartToken: T0,
      phase: 'covering',
      phaseToken: 1,
      fadeSec: 0.5,
      returnScene: 'standby',
    });

    const playing = reducer(covering, { type: 'video/covered', token: 1 });
    expect(playing.scene).toBe('video');
    expect(playing.sceneOpts.video.phase).toBe('playing');

    const revealing = reducer(playing, { type: 'video/tail', token: 1 });
    expect(revealing.scene).toBe('score');
    expect(revealing.sceneOpts.video.phase).toBe('revealing');

    const idle = reducer(revealing, { type: 'video/revealed', token: 1 });
    expect(idle.scene).toBe('score');
    expect(idle.sceneOpts.video.phase).toBe('idle');
  });

  it('마지막 프레임 유지 에셋은 종료 시 holding으로 멈추고 수동 진행 전까지 씬을 바꾸지 않는다', () => {
    const before = createInitialState();
    before.assets = [
      {
        id: 'clip-01',
        name: '사회자 멘트 홀드',
        type: 'video',
        size: 1,
        mime: 'video/webm',
        holdEndFrame: true,
      },
    ];

    const covering = reducer(before, playFull());
    expect(covering.sceneOpts.video.holdEndFrame).toBe(true);
    const playing = reducer(covering, { type: 'video/covered', token: 1 });
    const holding = reducer(playing, { type: 'video/held', token: 1 });

    expect(holding.scene).toBe('video');
    expect(holding.sceneOpts.video.phase).toBe('holding');
    expect(holding.sceneOpts.video.paused).toBe(true);
    expect(reducer(holding, { type: 'video/tail', token: 1 })).toBe(holding);

    const replaying = reducer(holding, { type: 'video/restart', now: T0 + 1 });
    expect(replaying.sceneOpts.video.phase).toBe('playing');
    expect(replaying.sceneOpts.video.paused).toBe(false);
  });

  it('holding 영상에서 직접 scene/set을 실행해도 stale 영상 runtime을 닫는다', () => {
    const before = createInitialState();
    before.assets = [
      { id: 'clip-01', name: '홀드', type: 'video', size: 1, mime: 'video/webm', holdEndFrame: true },
    ];
    const holding = run(
      before,
      playFull(),
      { type: 'video/covered', token: 1 },
      { type: 'video/held', token: 1 },
    );
    const advanced = reducer(holding, { type: 'scene/set', scene: 'score' });
    expect(advanced.scene).toBe('score');
    expect(advanced.sceneOpts.video.phase).toBe('idle');
    expect(advanced.sceneOpts.video.phaseToken).toBeGreaterThan(holding.sceneOpts.video.phaseToken);
  });

  it('홀드 옵션이 없는 영상은 held 사건을 무시한다', () => {
    const playing = run(createInitialState(), playFull(), { type: 'video/covered', token: 1 });
    expect(playing.sceneOpts.video.holdEndFrame).toBe(false);
    expect(reducer(playing, { type: 'video/held', token: 1 })).toBe(playing);
  });

  it('출발 씬과 페이드 길이는 payload가 아니라 state에서 스냅샷된다', () => {
    // cueActions 같은 순수 함수가 state 없이도 이 액션을 만들 수 있어야 한다
    const before = run(
      createInitialState(),
      { type: 'scene/set', scene: 'live' },
      { type: 'settings/patch', patch: { fadeSec: 1.5 } },
    );
    const s = reducer(before, playFull({ nextScene: null }));
    expect(s.sceneOpts.video.returnScene).toBe('live');
    expect(s.sceneOpts.video.fadeSec).toBe(1.5);

    // 재생 도중 설정을 바꿔도 이번 재생은 흔들리지 않는다
    const changed = reducer(s, { type: 'settings/patch', patch: { fadeSec: 0 } });
    expect(changed.sceneOpts.video.fadeSec).toBe(1.5);
    expect(changed.settings.fadeSec).toBe(0);
  });

  it('stale 토큰 사건은 각 단계에서 상태를 전혀 바꾸지 않는다 (참조 동일)', () => {
    const covering = reducer(createInitialState(), playFull());
    expect(reducer(covering, { type: 'video/covered', token: 0 })).toBe(covering);

    const playing = reducer(covering, { type: 'video/covered', token: 1 });
    expect(reducer(playing, { type: 'video/tail', token: 0 })).toBe(playing);

    const revealing = reducer(playing, { type: 'video/tail', token: 1 });
    expect(reducer(revealing, { type: 'video/revealed', token: 0 })).toBe(revealing);
  });

  it('순서를 건너뛴 사건은 무시된다', () => {
    const covering = reducer(createInitialState(), playFull());
    expect(reducer(covering, { type: 'video/tail', token: 1 })).toBe(covering);
    expect(reducer(covering, { type: 'video/revealed', token: 1 })).toBe(covering);

    const playing = reducer(covering, { type: 'video/covered', token: 1 });
    expect(reducer(playing, { type: 'video/revealed', token: 1 })).toBe(playing);
    expect(reducer(playing, { type: 'video/covered', token: 1 })).toBe(playing);
  });

  it('idle 상태에서 온 사건은 전부 무시된다', () => {
    const s = createInitialState();
    expect(reducer(s, { type: 'video/covered', token: 0 })).toBe(s);
    expect(reducer(s, { type: 'video/tail', token: 0 })).toBe(s);
    expect(reducer(s, { type: 'video/revealed', token: 0 })).toBe(s);
    expect(reducer(s, { type: 'video/abort' })).toBe(s);
  });

  it('nextScene이 null이면 재생 직전 씬으로 복귀한다', () => {
    const from = reducer(createInitialState(), { type: 'scene/set', scene: 'live' });
    const s = run(from, playFull({ nextScene: null }), { type: 'video/covered', token: 1 });
    expect(s.sceneOpts.video.returnScene).toBe('live');
    expect(reducer(s, { type: 'video/tail', token: 1 }).scene).toBe('live');
  });

  it('nextScene도 returnScene도 없으면 대기 화면으로 간다', () => {
    let s = reducer(createInitialState(), playFull({ nextScene: null }));
    // returnScene까지 비어 있는 손상 상태를 직접 만들어 최종 폴백을 확인한다
    s = { ...s, sceneOpts: { ...s.sceneOpts, video: { ...s.sceneOpts.video, returnScene: null } } };
    s = reducer(s, { type: 'video/covered', token: 1 });
    expect(reducer(s, { type: 'video/tail', token: 1 }).scene).toBe('standby');
  });

  it("'video' 씬에서 또 재생하면 복귀 씬이 대기 화면이 된다", () => {
    const onVideo = reducer(createInitialState(), { type: 'scene/set', scene: 'video' });
    const s = reducer(onVideo, playFull({ nextScene: null }));
    // 자기 자신으로 복귀하면 영상 씬에 갇힌다
    expect(s.sceneOpts.video.returnScene).toBe('standby');
  });

  it('fadeSec은 설정값이 손상돼도 안전한 값으로 떨어진다', () => {
    const zero = run(createInitialState(), { type: 'settings/patch', patch: { fadeSec: 0 } });
    expect(reducer(zero, playFull()).sceneOpts.video.fadeSec).toBe(0);

    // settings/patch는 검증을 안 하므로 reducer가 마지막 방어선이다
    const broken = run(createInitialState(), {
      type: 'settings/patch',
      patch: { fadeSec: Number.NaN },
    });
    expect(reducer(broken, playFull()).sceneOpts.video.fadeSec).toBe(0.5);

    const negative = run(createInitialState(), { type: 'settings/patch', patch: { fadeSec: -3 } });
    expect(reducer(negative, playFull()).sceneOpts.video.fadeSec).toBe(0);
  });

  it('abort는 토큰을 올려 이후 늦게 온 사건을 전부 무효화한다', () => {
    const covering = reducer(createInitialState(), playFull());
    const aborted = reducer(covering, { type: 'video/abort' });

    expect(aborted.sceneOpts.video.phase).toBe('idle');
    expect(aborted.sceneOpts.video.phaseToken).toBe(2);
    expect(aborted.scene).toBe('standby'); // 취소는 씬을 옮기지 않는다

    // 취소 직후 도착한 옛 사건이 씬을 'video'로 되돌리면 안 된다
    expect(reducer(aborted, { type: 'video/covered', token: 1 })).toBe(aborted);
    expect(reducer(aborted, { type: 'video/tail', token: 1 })).toBe(aborted);
    expect(reducer(aborted, { type: 'video/revealed', token: 1 })).toBe(aborted);
  });

  it('abort 직후 같은 ms에 다시 재생해도 이전 재생의 토큰은 거부된다', () => {
    // phaseToken이 now였다면 같은 ms에서 토큰이 겹쳐 stale 사건이 통과한다 → 순수 카운터여야 한다
    const playing = run(createInitialState(), playFull(), { type: 'video/covered', token: 1 });
    const aborted = reducer(playing, { type: 'video/abort' });
    const again = reducer(aborted, playFull({ now: T0 })); // 같은 시각

    expect(again.sceneOpts.video.restartToken).toBe(T0); // 되감기 트리거는 시각 그대로
    expect(again.sceneOpts.video.phaseToken).toBe(3); // 1 → (abort) 2 → 3
    expect(again.sceneOpts.video.phase).toBe('covering');

    // 이전 재생의 covered(token 1)는 거부, 새 재생의 covered(token 3)만 통과
    expect(reducer(again, { type: 'video/covered', token: 1 })).toBe(again);
    expect(reducer(again, { type: 'video/covered', token: 3 }).sceneOpts.video.phase).toBe('playing');
  });

  it('2부 잠금 중에는 tail이 잠긴 씬으로 보내도 렌더가 대기 화면으로 강등된다', () => {
    // 잠금은 reducer가 아니라 pickScene(렌더 경계)이 강제한다 — scene/set과 동일한 규칙.
    const locked = run(
      createInitialState(),
      playFull({ nextScene: 'suspects' }),
      { type: 'video/covered', token: 1 },
      { type: 'video/tail', token: 1 },
    );
    expect(locked.p2.unlocked).toBe(false);
    expect(locked.scene).toBe('suspects');
    expect(pickScene(locked)).toBe('standby');
    expect(isDegraded(locked)).toBe(true);

    const unlocked = reducer(locked, { type: 'p2/unlock' });
    expect(pickScene(unlocked)).toBe('suspects');
  });

  it('페이드 상태는 직렬화 라운드트립에서 통째로 보존된다', () => {
    // display는 방송을 deserialize로 받는다 — 여기서 뭉개지면 페이드 사건을 못 본다
    const playing = run(
      createInitialState(),
      { type: 'scene/set', scene: 'live' },
      playFull({ nextScene: null }),
      { type: 'video/covered', token: 1 },
    );
    const back = deserialize(serialize(playing));
    expect(back.sceneOpts.video).toEqual(playing.sceneOpts.video);
    expect(back.sceneOpts.video.phase).toBe('playing');
    expect(back.sceneOpts.video.phaseToken).toBe(1);
    expect(back.sceneOpts.video.returnScene).toBe('live');
    expect(back.sceneOpts.video.fadeSec).toBe(0.5);
    expect(back.scene).toBe('video');
  });
});

describe('설명 영상 페이드 ↔ 전환 스팅어 충돌', () => {
  const sting = (now: number): Action => ({
    type: 'transition/play',
    assetId: 'sting-01',
    nextScene: 'score',
    switchAtSec: 0.8,
    now,
  });

  it('playFull은 진행 중인 스팅어를 scene/set과 똑같이 무효화한다', () => {
    const playing = run(createInitialState(), sting(T0));
    expect(playing.sceneOpts.transitionVideo.active).toBe(true);

    const full = reducer(playing, {
      type: 'video/playFull',
      assetId: 'clip-01',
      nextScene: 'award',
      now: T0 + 100,
    });
    expect(full.sceneOpts.transitionVideo).toMatchObject({
      active: false,
      assetId: null,
      nextScene: null,
      switched: false,
    });
    // 토큰은 남겨야 stale 사건 대조가 계속 성립한다
    expect(full.sceneOpts.transitionVideo.restartToken).toBe(T0);

    // 늦게 도착한 스팅어 사건이 씬을 'score'로 끌고 가면 안 된다
    expect(reducer(full, { type: 'transition/switched', token: T0 })).toBe(full);
    expect(reducer(full, { type: 'transition/finish', token: T0 })).toBe(full);
    expect(full.scene).toBe('standby');
  });

  it('playFull은 진행 중인 컬러 페이드도 무효화해 늦은 switch가 video 진입을 덮지 못하게 한다', () => {
    const fading = reducer(createInitialState(), {
      type: 'sceneFade/play',
      color: '#000000',
      nextScene: 'score',
      durationSec: 0.5,
      now: T0,
    });
    const full = reducer(fading, {
      type: 'video/playFull',
      assetId: 'clip-01',
      nextScene: 'award',
      now: T0 + 1,
    });

    expect(full.sceneOpts.sceneFade.active).toBe(false);
    expect(reducer(full, { type: 'sceneFade/switched', token: T0 })).toBe(full);
    expect(reducer(full, { type: 'video/covered', token: full.sceneOpts.video.phaseToken }).scene).toBe('video');
  });

  it('페이드가 도는 동안에는 스팅어 사건이 씬을 절대 바꾸지 않는다 (이중 안전)', () => {
    // transitionVideo가 어떤 경로로든 active인 채 페이드가 시작된 상황을 직접 만든다
    const full = run(createInitialState(), {
      type: 'video/playFull',
      assetId: 'clip-01',
      nextScene: 'award',
      now: T0,
    });
    const contrived: AppState = {
      ...full,
      sceneOpts: {
        ...full.sceneOpts,
        transitionVideo: {
          active: true,
          assetId: 'sting-01',
          nextScene: 'score',
          switchAtSec: 0.8,
          restartToken: T0,
          switched: false,
          nextStandbyMode: null,
        },
      },
    };

    const switched = reducer(contrived, { type: 'transition/switched', token: T0 });
    expect(switched.scene).toBe('standby'); // 씬은 페이드 상태 머신의 것
    expect(switched.sceneOpts.transitionVideo.switched).toBe(true); // 전환 상태 정리는 수행
    expect(switched.sceneOpts.video.phase).toBe('covering');

    const finished = reducer(contrived, { type: 'transition/finish', token: T0 });
    expect(finished.scene).toBe('standby');
    expect(finished.sceneOpts.transitionVideo.active).toBe(false);
    expect(finished.sceneOpts.transitionVideo.assetId).toBeNull();
  });

  it('페이드가 idle이면 스팅어는 기존대로 씬을 바꾼다 (회귀)', () => {
    const playing = run(createInitialState(), sting(T0));
    expect(reducer(playing, { type: 'transition/switched', token: T0 }).scene).toBe('score');
    expect(reducer(playing, { type: 'transition/finish', token: T0 }).scene).toBe('score');
  });
});

describe('sceneOpts/patch는 설명 영상 런타임 필드를 덮지 못한다 (계획 §11 L4)', () => {
  /** 재생 중 상태 — phase/phaseToken/returnScene/fadeSec 이 전부 기본값이 아니다 */
  function playing(): AppState {
    const s = run(createInitialState(), { type: 'scene/set', scene: 'live' });
    return reducer(s, {
      type: 'video/playFull',
      assetId: 'clip-1',
      nextScene: 'award',
      now: T0,
    });
  }

  it('phase·phaseToken·returnScene·fadeSec 은 패치로 바뀌지 않는다', () => {
    const before = playing();
    const after = reducer(before, {
      type: 'sceneOpts/patch',
      patch: {
        video: {
          phase: 'idle',
          phaseToken: 999,
          returnScene: 'standby',
          fadeSec: 12,
        },
      },
    });

    expect(after.sceneOpts.video.phase).toBe(before.sceneOpts.video.phase);
    expect(after.sceneOpts.video.phaseToken).toBe(before.sceneOpts.video.phaseToken);
    expect(after.sceneOpts.video.returnScene).toBe(before.sceneOpts.video.returnScene);
    expect(after.sceneOpts.video.fadeSec).toBe(before.sceneOpts.video.fadeSec);
  });

  it('같은 패치 안의 조작 가능한 필드는 그대로 반영된다 (통째로 버리지 않는다)', () => {
    const after = reducer(playing(), {
      type: 'sceneOpts/patch',
      patch: {
        video: { assetId: 'clip-2', nextScene: 'score', paused: true, phaseToken: 999 },
        prompt: { text: '제시어' },
      },
    });

    expect(after.sceneOpts.video.assetId).toBe('clip-2');
    expect(after.sceneOpts.video.nextScene).toBe('score');
    expect(after.sceneOpts.video.paused).toBe(true);
    expect(after.sceneOpts.prompt.text).toBe('제시어');
    expect(after.sceneOpts.video.phaseToken).toBe(playing().sceneOpts.video.phaseToken);
  });

  it('video 키가 없는 패치는 원본 객체를 그대로 흘려보낸다 (불필요한 복사 없음)', () => {
    const s = playing();
    const after = reducer(s, { type: 'sceneOpts/patch', patch: { submit: { stageId: 's2' } } });
    expect(after.sceneOpts.submit.stageId).toBe('s2');
    expect(after.sceneOpts.video).toEqual(s.sceneOpts.video);
  });
});

// ---------------------------------------------------------------- 현장 사진

function photoMeta(id: string, over: Partial<PhotoMeta> = {}): PhotoMeta {
  return {
    id,
    name: `${id}.jpg`,
    takenAt: 1_756_000_000_000,
    addedAt: 1_756_000_000_000,
    w: 1920,
    h: 1440,
    bytes: 412_345,
    hidden: false,
    p2: false,
    ...over,
  };
}

describe('photos — 씬 편입', () => {
  it("SCENE_IDS에 'photos'가 video 뒤·suspects 앞으로 들어간다", () => {
    expect(SCENE_IDS).toContain('photos');
    expect(SCENE_IDS.indexOf('photos')).toBe(SCENE_IDS.indexOf('video') + 1);
    expect(SCENE_IDS.indexOf('photos')).toBeLessThan(SCENE_IDS.indexOf('suspects'));
  });

  it("저장본의 scene: 'photos'가 그대로 복원된다", () => {
    expect(deserialize(JSON.stringify({ version: 2, scene: 'photos' })).scene).toBe('photos');
  });
});

describe('photos — migration (v2 → v3)', () => {
  it('v2 저장본이 version 3 + 사진 기본값으로 올라온다', () => {
    const back = deserialize(JSON.stringify({ version: 2, scene: 'live', ledger: [] }));
    expect(back.version).toBe(3);
    expect(back.photos).toEqual({
      items: [],
      settings: {
        intervalSec: 5,
        kenBurns: true,
        order: 'time',
        autoIntake: false,
        sepia: false,
        vignette: false,
        grain: false,
        standbyBackdrop: false,
      },
    });
  });

  it('v1 저장본도 한 번에 v3로 올라오고 기존 필드가 보존된다', () => {
    const back = deserialize(
      JSON.stringify({
        version: 1,
        scene: 'score',
        teams: [{ id: 't1', name: '레드', color: '#c0453b' }],
        ledger: [{ id: 'L00001', ts: 1, teamId: 't1', delta: 100, reason: '컬링', ref: 'p1:curling' }],
      }),
    );
    expect(back.version).toBe(3);
    expect(back.photos.items).toEqual([]);
    expect(back.teams[0].name).toBe('레드');
    expect(back.ledger).toHaveLength(1);
  });

  it('사용자가 지정한 설정은 보존하고, 범위를 벗어난 값만 보정한다', () => {
    const back = deserialize(
      JSON.stringify({
        version: 2,
        photos: {
          items: [],
          settings: {
            intervalSec: 8,
            kenBurns: false,
            order: 'random',
            autoIntake: true,
            sepia: true,
            vignette: true,
            grain: true,
            standbyBackdrop: true,
          },
        },
      }),
    );
    expect(back.photos.settings).toEqual({
      intervalSec: 8,
      kenBurns: false,
      order: 'random',
      autoIntake: true,
      sepia: true,
      vignette: true,
      grain: true,
      standbyBackdrop: true,
    });
  });

  it('intervalSec 999 → 30, 0.5 → 2로 클램프하고 알 수 없는 order는 time', () => {
    const hi = deserialize(JSON.stringify({ version: 2, photos: { settings: { intervalSec: 999, order: 'zzz' } } }));
    expect(hi.photos.settings.intervalSec).toBe(30);
    expect(hi.photos.settings.order).toBe('time');

    const lo = deserialize(JSON.stringify({ version: 2, photos: { settings: { intervalSec: 0.5 } } }));
    expect(lo.photos.settings.intervalSec).toBe(2);

    const bad = deserialize(JSON.stringify({ version: 2, photos: { settings: { intervalSec: 'abc' } } }));
    expect(bad.photos.settings.intervalSec).toBe(5);
  });

  it('손상된 items는 불량 항목만 버리고 정상 항목은 전부 보존한다', () => {
    const good = photoMeta('pkeep');
    const back = normalizePhotos({
      items: [
        'not-an-object',
        null,
        { name: 'id 없음.jpg' },
        good,
        { id: 'pfix', name: 42, takenAt: 'x', addedAt: null, w: Number.NaN, h: undefined, bytes: '1', hidden: 'yes' },
      ],
      settings: {},
    });
    expect(back.items).toHaveLength(2);
    expect(back.items[0]).toEqual(good);
    expect(back.items[1]).toEqual({
      id: 'pfix',
      name: '',
      takenAt: 0,
      addedAt: 0,
      w: 0,
      h: 0,
      bytes: 0,
      hidden: false, // 'yes'는 불리언이 아니다 → 숨김으로 보지 않는다(송출에서 조용히 빠지는 쪽이 더 나쁘다)
      p2: false, // 옛 저장본에는 2부 스탬프가 없다 → 1부 사진으로 본다
    });
  });

  it('중복 id는 처음 것만 남는다', () => {
    const back = normalizePhotos({
      items: [photoMeta('pdup', { name: 'first.jpg' }), photoMeta('pdup', { name: 'second.jpg' })],
    });
    expect(back.items).toHaveLength(1);
    expect(back.items[0].name).toBe('first.jpg');
  });

  it('items가 배열이 아니거나 photos 자체가 손상돼도 기본값으로 산다', () => {
    expect(normalizePhotos({ items: 'nope' }).items).toEqual([]);
    expect(normalizePhotos(null).settings.intervalSec).toBe(5);
    expect(normalizePhotos([]).items).toEqual([]);
    expect(deserialize(JSON.stringify({ version: 2, photos: 'broken' })).photos.items).toEqual([]);
  });

  it('손상된 photos가 migrate의 스프레드(`...r`)로 그대로 새지 않는다', () => {
    // `{ ...base, ...r }`는 raw를 통과시키므로 `photos`는 반드시 **명시 키로 덮어야** 한다.
    // 이 테스트가 깨지면 손상 저장본이 그대로 런타임으로 들어간다.
    const back = deserialize(
      JSON.stringify({
        version: 3,
        photos: {
          items: [{ id: 'ok', name: 'a.jpg', takenAt: 1, addedAt: 1, w: 1, h: 1, bytes: 1, hidden: false }, 'junk', { noId: true }],
          settings: {
            intervalSec: 1000,
            order: 'zzz',
            kenBurns: 'yes',
            autoIntake: 'yes',
            sepia: 'yes',
            vignette: 1,
            grain: {},
            standbyBackdrop: 'on',
          },
        },
      }),
    );
    expect(back.photos.items.map((p) => p.id)).toEqual(['ok']);
    expect(back.photos.items[0].p2).toBe(false);
    expect(back.photos.settings).toEqual({
      intervalSec: 30,
      kenBurns: false,
      order: 'time',
      autoIntake: false,
      sepia: false,
      vignette: false,
      grain: false,
      standbyBackdrop: false,
    });
  });

  it('저장된 p2 스탬프는 복원 시 보존된다 (재부팅해도 2부 사진이 1부에 새지 않는다)', () => {
    const back = deserialize(
      JSON.stringify({
        version: 3,
        photos: { items: [photoMeta('p2shot', { p2: true }), photoMeta('p1shot')] },
      }),
    );
    expect(back.photos.items.find((p) => p.id === 'p2shot')?.p2).toBe(true);
    expect(back.photos.items.find((p) => p.id === 'p1shot')?.p2).toBe(false);
    expect(photoQueue(back.photos.items, 'time', 0, false)).toEqual(['p1shot']);
  });

  it('많은 사진도 잘라내지 않는다 — 조용한 데이터 소실 금지', () => {
    const many = Array.from({ length: 500 }, (_, i) => photoMeta(`p${i}`));
    expect(normalizePhotos({ items: many }).items).toHaveLength(500);
  });
});

describe('photos — reducer', () => {
  it('배치로 추가하고, 이미 있는 id는 무시한다(멱등)', () => {
    const s0 = createInitialState();
    const s1 = reducer(s0, { type: 'photos/add', items: [photoMeta('p1'), photoMeta('p2')] });
    expect(s1.photos.items.map((p) => p.id)).toEqual(['p1', 'p2']);

    const s2 = reducer(s1, { type: 'photos/add', items: [photoMeta('p2'), photoMeta('p3')] });
    expect(s2.photos.items.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('추가된 게 0건이면 같은 참조를 돌려준다 — 폴링이 저장·방송을 깨우지 않는다', () => {
    const s1 = reducer(createInitialState(), { type: 'photos/add', items: [photoMeta('p1')] });
    expect(reducer(s1, { type: 'photos/add', items: [photoMeta('p1')] })).toBe(s1);
    expect(reducer(s1, { type: 'photos/add', items: [] })).toBe(s1);
  });

  it('한 배치 안의 중복도 한 번만 들어간다', () => {
    const s = reducer(createInitialState(), {
      type: 'photos/add',
      items: [photoMeta('p1'), photoMeta('p1'), photoMeta('p2')],
    });
    expect(s.photos.items.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('숨김 토글 — 값이 같거나 없는 id면 같은 참조', () => {
    const s1 = reducer(createInitialState(), { type: 'photos/add', items: [photoMeta('p1')] });
    const hidden = reducer(s1, { type: 'photos/hidden', id: 'p1', hidden: true });
    expect(hidden.photos.items[0].hidden).toBe(true);
    expect(reducer(hidden, { type: 'photos/hidden', id: 'p1', hidden: true })).toBe(hidden);
    expect(reducer(hidden, { type: 'photos/hidden', id: 'nope', hidden: true })).toBe(hidden);
    expect(reducer(hidden, { type: 'photos/hidden', id: 'p1', hidden: false }).photos.items[0].hidden).toBe(false);
  });

  it('숨김 전체 해제 — 한 액션으로 전부 되돌리고, 숨긴 게 없으면 같은 참조', () => {
    const s1 = reducer(createInitialState(), {
      type: 'photos/add',
      items: [photoMeta('p1'), photoMeta('p2'), photoMeta('p3')],
    });
    // 숨긴 게 하나도 없는 상태에서는 저장·방송을 깨우지 않는다
    expect(reducer(s1, { type: 'photos/unhideAll' })).toBe(s1);

    const h1 = reducer(s1, { type: 'photos/hidden', id: 'p1', hidden: true });
    const h2 = reducer(h1, { type: 'photos/hidden', id: 'p3', hidden: true });
    expect(h2.photos.items.filter((p) => p.hidden).map((p) => p.id)).toEqual(['p1', 'p3']);

    const back = reducer(h2, { type: 'photos/unhideAll' });
    expect(back.photos.items.map((p) => p.hidden)).toEqual([false, false, false]);
    // 순서·개수는 그대로, 손대지 않은 항목은 **같은 객체 참조**를 유지한다
    expect(back.photos.items.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(back.photos.items[1]).toBe(h2.photos.items[1]);
    // 멱등: 이미 전부 해제된 뒤에는 같은 참조
    expect(reducer(back, { type: 'photos/unhideAll' })).toBe(back);
  });

  it('숨김 전체 해제는 잠긴(2부) 사진도 되돌린다 — 숨김은 잠금과 다른 축이다', () => {
    const s0 = reducer(createInitialState(), { type: 'p2/unlock' });
    const s1 = reducer(s0, { type: 'photos/add', items: [photoMeta('a'), photoMeta('b')] });
    expect(s1.photos.items.every((p) => p.p2)).toBe(true);
    const hid = reducer(s1, { type: 'photos/hidden', id: 'b', hidden: true });
    const back = reducer(hid, { type: 'photos/unhideAll' });
    expect(back.photos.items.find((p) => p.id === 'b')?.hidden).toBe(false);
    expect(back.photos.items.find((p) => p.id === 'b')?.p2).toBe(true);
  });

  it('숨김 전체 해제 300장이 한 번에 끝난다 (액션 1개 · O(n))', () => {
    const many = Array.from({ length: 300 }, (_, i) => photoMeta(`p${i}`));
    let s = reducer(createInitialState(), { type: 'photos/add', items: many });
    for (const p of many) s = reducer(s, { type: 'photos/hidden', id: p.id, hidden: true });
    expect(s.photos.items.every((p) => p.hidden)).toBe(true);

    const t0 = performance.now();
    const back = reducer(s, { type: 'photos/unhideAll' });
    const ms = performance.now() - t0;
    expect(back.photos.items.every((p) => !p.hidden)).toBe(true);
    // 넉넉한 상한 — O(n²)로 돌아가면(장당 액션 1개) 여기서 자릿수가 달라진다
    expect(ms).toBeLessThan(50);
  });

  it('전체 비우기 — 이미 비어 있으면 같은 참조, 설정은 남는다', () => {
    const s0 = createInitialState();
    expect(reducer(s0, { type: 'photos/clear' })).toBe(s0);
    const s1 = reducer(s0, { type: 'photos/add', items: [photoMeta('p1')] });
    const patched = reducer(s1, { type: 'photos/settings', patch: { order: 'random' } });
    const cleared = reducer(patched, { type: 'photos/clear' });
    expect(cleared.photos.items).toEqual([]);
    expect(cleared.photos.settings.order).toBe('random');
  });

  it('설정 패치는 클램프되고, 값이 그대로면 같은 참조', () => {
    const s0 = createInitialState();
    const s1 = reducer(s0, { type: 'photos/settings', patch: { intervalSec: 99 } });
    expect(s1.photos.settings.intervalSec).toBe(30);
    expect(reducer(s1, { type: 'photos/settings', patch: { intervalSec: 30 } })).toBe(s1);
    expect(reducer(s0, { type: 'photos/settings', patch: {} })).toBe(s0);
    // 값이 실리지 않은 키(undefined)는 현재 값을 덮지 않는다 — 기본값으로 되돌아가면 안 된다
    const off = reducer(s0, { type: 'photos/settings', patch: { kenBurns: false } });
    expect(reducer(off, { type: 'photos/settings', patch: { kenBurns: undefined } })).toBe(off);

    const s2 = reducer(s1, {
      type: 'photos/settings',
      patch: {
        kenBurns: false,
        autoIntake: true,
        sepia: true,
        vignette: true,
        grain: true,
        standbyBackdrop: true,
      },
    });
    expect(s2.photos.settings).toEqual({
      intervalSec: 30,
      kenBurns: false,
      order: 'time',
      autoIntake: true,
      sepia: true,
      vignette: true,
      grain: true,
      standbyBackdrop: true,
    });
    expect(reducer(s2, { type: 'photos/settings', patch: { grain: undefined } })).toBe(s2);
  });

  it('2부 스탬프는 reducer가 흡수 시점의 p2.unlocked로 찍는다', () => {
    const locked = createInitialState();
    expect(locked.p2.unlocked).toBe(false);
    const p1shot = reducer(locked, { type: 'photos/add', items: [photoMeta('p1shot')] });
    expect(p1shot.photos.items[0].p2).toBe(false);

    const unlocked = reducer(p1shot, { type: 'p2/unlock' });
    const p2shot = reducer(unlocked, { type: 'photos/add', items: [photoMeta('p2shot')] });
    expect(p2shot.photos.items.find((p) => p.id === 'p2shot')?.p2).toBe(true);
    // 이미 들어온 1부 사진의 스탬프는 사후에 바뀌지 않는다
    expect(p2shot.photos.items.find((p) => p.id === 'p1shot')?.p2).toBe(false);

    // 다시 잠가도 이미 찍힌 도장은 남는다 (잠금 중 큐에서 빠지는 근거가 사라지면 안 된다)
    const relocked = reducer(p2shot, { type: 'p2/lock' });
    expect(relocked.photos.items.find((p) => p.id === 'p2shot')?.p2).toBe(true);
  });

  it('payload에 실린 p2는 무시하고 상태 기준으로 찍는다 (유출 경로 차단)', () => {
    // 호출부가 실수로 p2를 실어 보내도 1부 화면에 2부 사진이 뜨는 일이 없어야 한다
    const forced = { ...photoMeta('forced'), p2: true } as PhotoIntakeMeta;
    const s = reducer(createInitialState(), { type: 'photos/add', items: [forced] });
    expect(s.photos.items[0].p2).toBe(false);
  });

  it('잠금 중 흡수한 사진은 큐에 뜨고, 2부 사진은 잠금이 풀려야 뜬다', () => {
    const locked = createInitialState();
    const withP1 = reducer(locked, { type: 'photos/add', items: [photoMeta('a', { takenAt: 1 })] });
    const unlocked = reducer(withP1, { type: 'p2/unlock' });
    const both = reducer(unlocked, { type: 'photos/add', items: [photoMeta('b', { takenAt: 2 })] });

    expect(photoQueue(both.photos.items, 'time', 0, false)).toEqual(['a']);
    expect(photoQueue(both.photos.items, 'time', 0, true)).toEqual(['a', 'b']);
  });

  it('사진 액션은 원장·씬을 건드리지 않고 updatedAt만 흐른다', () => {
    const base = run(withCurlingRanks(), { type: 'p1/confirm', eventId: 'curling', now: T0 });
    const after = reducer(base, { type: 'photos/add', items: [photoMeta('p1')] });
    expect(after.ledger).toEqual(base.ledger);
    expect(after.scene).toBe(base.scene);
    expect(after.seq).toBe(base.seq);
  });

  it('불량 메타는 dispatch 경로에서도 걸러진다', () => {
    const s = reducer(createInitialState(), {
      type: 'photos/add',
      items: [photoMeta('p1'), { id: '', name: 'x.jpg' } as PhotoMeta],
    });
    expect(s.photos.items.map((p) => p.id)).toEqual(['p1']);
  });
});

describe('photos — 직렬화 예산 (§1-6)', () => {
  it('사진 500건을 담아도 상태 직렬화가 512KB 미만이다', () => {
    const items = Array.from({ length: 500 }, (_, i) =>
      photoMeta(`p1k9x2af${i}`, { name: `IMG_20260827_1830${String(i).padStart(3, '0')}.jpg` }),
    );
    const s = reducer(createInitialState(), { type: 'photos/add', items });
    expect(s.photos.items).toHaveLength(500);
    expect(serialize(s).length).toBeLessThan(512 * 1024);
  });

  it('사진 500건이 상태 크기를 5배 이상 부풀리지 않는다 (썸네일을 상태에 넣지 않은 근거)', () => {
    const empty = serialize(createInitialState()).length;
    const items = Array.from({ length: 500 }, (_, i) => photoMeta(`p${i}`));
    const withPhotos = serialize(reducer(createInitialState(), { type: 'photos/add', items })).length;
    expect(withPhotos - empty).toBeLessThan(120 * 1024);
  });
});

describe('행사 음악 플레이어', () => {
  it('곡 재생·스크럽·일시정지를 단일 writer 상태로 보존한다', () => {
    const base = createInitialState();
    const playing = reducer(base, { type: 'music/play', trackId: '23', now: 100 });
    expect(playing.music).toEqual({ trackId: '23', playing: true, positionSec: 0, commandToken: 100, ducked: false, bookmarks: {}, fadeIn: true });

    const sought = reducer(playing, { type: 'music/seek', positionSec: 61.25, now: 101 });
    expect(sought.music).toEqual({ trackId: '23', playing: true, positionSec: 61.25, commandToken: 101, ducked: false, bookmarks: {}, fadeIn: true });

    const paused = reducer(sought, { type: 'music/pause', positionSec: 62 });
    expect(paused.music).toEqual({ trackId: '23', playing: false, positionSec: 62, commandToken: 101, ducked: false, bookmarks: {}, fadeIn: true });
  });

  it('다른 곡은 0초부터 시작하고 종료 보고는 현재 곡에만 적용한다', () => {
    const first = reducer(createInitialState(), { type: 'music/play', trackId: '23', now: 1 });
    const second = reducer(first, { type: 'music/play', trackId: '24', now: 2 });
    expect(second.music.positionSec).toBe(0);
    expect(second.music.trackId).toBe('24');
    expect(reducer(second, { type: 'music/ended', trackId: '23' })).toBe(second);
    const ended = reducer(second, { type: 'music/ended', trackId: '24' });
    expect(ended.music).toEqual({ trackId: '24', playing: false, positionSec: 0, commandToken: 3, ducked: false, bookmarks: {}, fadeIn: true });
    expect(reducer(ended, { type: 'music/resume' }).music.playing).toBe(true);
  });

  it('재생 오류는 현재 곡만 fail-closed로 정지하고 stale 오류는 무시한다', () => {
    const playing = reducer(createInitialState(), { type: 'music/play', trackId: '23', now: 10 });
    expect(reducer(playing, { type: 'music/failed', trackId: '24' })).toBe(playing);
    expect(reducer(playing, { type: 'music/failed', trackId: '23' }).music).toEqual({
      trackId: null,
      playing: false,
      positionSec: 0,
      commandToken: 11,
      ducked: false,
      bookmarks: {},
      fadeIn: true,
    });
  });

  it('구 저장본에는 안전한 정지 상태를 채우고 잘못된 위치를 보정한다', () => {
    expect(deserialize('{}').music).toEqual({ trackId: null, playing: false, positionSec: 0, commandToken: 0, ducked: false, bookmarks: {}, fadeIn: true });
    expect(
      deserialize(JSON.stringify({ music: { trackId: 99, playing: 'yes', positionSec: -4, commandToken: null } })).music,
    ).toEqual({ trackId: null, playing: false, positionSec: 0, commandToken: 0, ducked: false, bookmarks: {}, fadeIn: true });
    expect(
      deserialize(
        JSON.stringify({ music: { trackId: 'missing-track', playing: true, positionSec: 9, commandToken: 4 } }),
      ).music,
    ).toEqual({ trackId: null, playing: false, positionSec: 0, commandToken: 4, ducked: false, bookmarks: {}, fadeIn: true });
  });

  it('music/play는 fadeIn을 명시적으로 왕복한다 (U122)', () => {
    const state = createInitialState();
    const cut = reducer(state, { type: 'music/play', trackId: '23', now: 1, fadeIn: false });
    expect(cut.music.fadeIn).toBe(false);

    // 생략하면 U18 기본(크로스페이드)
    const faded = reducer(state, { type: 'music/play', trackId: '23', now: 1 });
    expect(faded.music.fadeIn).toBe(true);

    // 저장본 왕복에서도 살아남는다 — commandToken과 같은 계약
    const round = deserialize(serialize(cut));
    expect(round.music.fadeIn).toBe(false);

    // 필드가 아예 없던 구 저장본은 U18 기본(true)으로 채운다
    const legacy = deserialize(JSON.stringify({ music: { trackId: '23', playing: true, positionSec: 0, commandToken: 1 } }));
    expect(legacy.music.fadeIn).toBe(true);
  });

  it('catalog에 없는 track ID 재생 action은 현재 음악 상태를 바꾸지 않는다', () => {
    const state = createInitialState();
    expect(reducer(state, { type: 'music/play', trackId: 'missing-track', now: 10 })).toBe(state);
  });
});

describe('페이드 길이 설정 (U18 · U19 · U23)', () => {
  it('기본값은 음악 5초 · 사진 배경 크로스 10초다', () => {
    const s = createInitialState();
    expect(s.settings.musicFadeSec).toBe(DEFAULT_MUSIC_FADE_SEC);
    expect(s.settings.musicFadeSec).toBe(5);
    expect(s.settings.backdropCrossfadeSec).toBe(DEFAULT_BACKDROP_CROSSFADE_SEC);
    expect(s.settings.backdropCrossfadeSec).toBe(10);
  });

  it('필드가 없는 구 저장본은 기본값으로 채우고 나머지 설정은 그대로 보존한다', () => {
    const legacy = JSON.parse(serialize(createInitialState())) as {
      settings: Record<string, unknown>;
    };
    delete legacy.settings.musicFadeSec;
    delete legacy.settings.backdropCrossfadeSec;
    legacy.settings.title = '현장에서 고친 타이틀';
    legacy.settings.fadeSec = 1.25;

    const migrated = deserialize(JSON.stringify(legacy));
    expect(migrated.settings.musicFadeSec).toBe(DEFAULT_MUSIC_FADE_SEC);
    expect(migrated.settings.backdropCrossfadeSec).toBe(DEFAULT_BACKDROP_CROSSFADE_SEC);
    expect(migrated.settings.title).toBe('현장에서 고친 타이틀');
    expect(migrated.settings.fadeSec).toBe(1.25);
  });

  it('손상된 값은 기본값으로, 범위 밖 값은 0~60초로 클램프한다', () => {
    expect(normalizeFadeSetting(Number.NaN, 5)).toBe(5);
    expect(normalizeFadeSetting('7' as unknown, 5)).toBe(5);
    expect(normalizeFadeSetting(-3, 5)).toBe(0);
    expect(normalizeFadeSetting(999, 5)).toBe(MAX_FADE_SETTING_SEC);
    expect(normalizeFadeSetting(0, 5)).toBe(0);

    const broken = JSON.parse(serialize(createInitialState())) as {
      settings: Record<string, unknown>;
    };
    broken.settings.musicFadeSec = 'soon';
    broken.settings.backdropCrossfadeSec = -4;
    const migrated = deserialize(JSON.stringify(broken));
    expect(migrated.settings.musicFadeSec).toBe(DEFAULT_MUSIC_FADE_SEC);
    expect(migrated.settings.backdropCrossfadeSec).toBe(0);
  });

  it('settings/patch로 저장되고 직렬화 왕복에서 살아남는다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'settings/patch', patch: { musicFadeSec: 2.5 } });
    s = reducer(s, { type: 'settings/patch', patch: { backdropCrossfadeSec: 0 } });
    expect(s.settings.musicFadeSec).toBe(2.5);
    expect(s.settings.backdropCrossfadeSec).toBe(0);

    const round = deserialize(serialize(s));
    expect(round.settings.musicFadeSec).toBe(2.5);
    expect(round.settings.backdropCrossfadeSec).toBe(0);
  });
});

describe('페이드 아웃 종료 위치 보고 (U18 A3)', () => {
  const play = (s: ReturnType<typeof createInitialState>, trackId: string) =>
    reducer(s, { type: 'music/play', trackId, now: 1000 });

  it('일시정지 뒤 실제로 멎은 위치로 positionSec을 갱신한다', () => {
    let s = play(createInitialState(), '01');
    s = reducer(s, { type: 'music/pause', positionSec: 30 });
    expect(s.music.positionSec).toBe(30);
    // 5초 페이드 아웃 동안 재생이 계속됐다 → display가 실제 위치를 돌려준다
    s = reducer(s, { type: 'music/pausedAt', positionSec: 35, commandToken: s.music.commandToken });
    expect(s.music.positionSec).toBe(35);
    expect(s.music.playing).toBe(false);
  });

  it('다시 재생을 눌렀으면 늦게 온 보고를 버린다', () => {
    let s = play(createInitialState(), '01');
    s = reducer(s, { type: 'music/pause', positionSec: 30 });
    s = reducer(s, { type: 'music/resume' });
    const after = reducer(s, {
      type: 'music/pausedAt',
      positionSec: 35,
      commandToken: s.music.commandToken,
    });
    expect(after).toBe(s);
  });

  it('그 사이 새 명령이 갔으면(토큰 상승) 옛 위치로 덮지 않는다', () => {
    let s = play(createInitialState(), '01');
    s = reducer(s, { type: 'music/pause', positionSec: 30 });
    s = reducer(s, { type: 'music/seek', positionSec: 90, now: 2000 });
    const after = reducer(s, { type: 'music/pausedAt', positionSec: 35, commandToken: 1 });
    expect(after).toBe(s);
    expect(after.music.positionSec).toBe(90);
  });

  it('트랙이 없거나 값이 같으면 상태를 새로 만들지 않는다', () => {
    const empty = createInitialState();
    expect(reducer(empty, { type: 'music/pausedAt', positionSec: 5, commandToken: 0 })).toBe(empty);

    let s = play(createInitialState(), '01');
    s = reducer(s, { type: 'music/pause', positionSec: 30 });
    expect(reducer(s, { type: 'music/pausedAt', positionSec: 30, commandToken: s.music.commandToken })).toBe(s);
  });

  it('음수·비정상 값은 0으로 정규화한다', () => {
    let s = play(createInitialState(), '01');
    s = reducer(s, { type: 'music/pause', positionSec: 30 });
    s = reducer(s, { type: 'music/pausedAt', positionSec: Number.NaN, commandToken: s.music.commandToken });
    expect(s.music.positionSec).toBe(0);
  });
});

describe('분위기 반전 설정 (U26)', () => {
  it('기본값은 전체 15초 · 암전 2.5초 · 세기 0.8 · 세로 픽셀 소터다 (U53)', () => {
    const s = createInitialState();
    expect(s.settings.moodTotalSec).toBe(DEFAULT_MOOD_TOTAL_SEC);
    expect(s.settings.moodTotalSec).toBe(15);
    expect(s.settings.moodBlackoutSec).toBe(DEFAULT_MOOD_BLACKOUT_SEC);
    expect(s.settings.moodBlackoutSec).toBe(2.5);
    expect(s.settings.moodGlitchStrength).toBe(DEFAULT_MOOD_GLITCH_STRENGTH);
    expect(s.settings.moodGlitchStrength).toBe(0.8);
    expect(s.settings.moodDistortMode).toBe('pixel-sort-vertical');
  });

  it('전환 전체 길이는 5~30초로 묶인다 (U53)', () => {
    expect(normalizeRangedSetting(30, 15, MOOD_TOTAL_SEC_RANGE)).toBe(30);
    expect(normalizeRangedSetting(31, 15, MOOD_TOTAL_SEC_RANGE)).toBe(30);
    expect(normalizeRangedSetting(4, 15, MOOD_TOTAL_SEC_RANGE)).toBe(5);
  });

  it('알 수 없는 디스토션 방식은 기본값으로 정규화한다', () => {
    const broken = JSON.parse(serialize(createInitialState())) as { settings: Record<string, unknown> };
    broken.settings.moodDistortMode = 'kaleidoscope';
    expect(deserialize(JSON.stringify(broken)).settings.moodDistortMode).toBe('pixel-sort-vertical');

    const legacy = JSON.parse(serialize(createInitialState())) as { settings: Record<string, unknown> };
    delete legacy.settings.moodDistortMode;
    expect(deserialize(JSON.stringify(legacy)).settings.moodDistortMode).toBe('pixel-sort-vertical');
  });

  it('세 방식 모두 저장되고 왕복에서 살아남는다', () => {
    for (const mode of ['pixel-sort-vertical', 'pixel-sort-horizontal', 'glitch-only'] as const) {
      const s = reducer(createInitialState(), { type: 'settings/patch', patch: { moodDistortMode: mode } });
      expect(deserialize(serialize(s)).settings.moodDistortMode).toBe(mode);
    }
  });

  it('필드가 없는 구 저장본은 기본값으로 채우고 나머지를 보존한다', () => {
    const legacy = JSON.parse(serialize(createInitialState())) as { settings: Record<string, unknown> };
    delete legacy.settings.moodTotalSec;
    delete legacy.settings.moodGlitchSec;
    delete legacy.settings.moodBlackoutSec;
    delete legacy.settings.moodGlitchStrength;
    legacy.settings.title = '보존되어야 하는 타이틀';

    const migrated = deserialize(JSON.stringify(legacy));
    expect(migrated.settings.moodTotalSec).toBe(DEFAULT_MOOD_TOTAL_SEC);
    expect(migrated.settings.moodBlackoutSec).toBe(DEFAULT_MOOD_BLACKOUT_SEC);
    expect(migrated.settings.moodGlitchStrength).toBe(DEFAULT_MOOD_GLITCH_STRENGTH);
    expect(migrated.settings.title).toBe('보존되어야 하는 타이틀');
  });

  it('전체 길이는 하한이 있다 — 너무 짧으면 글리치가 읽히지 않는다', () => {
    expect(normalizeRangedSetting(0, 15, MOOD_TOTAL_SEC_RANGE)).toBe(MOOD_TOTAL_SEC_RANGE.min);
    expect(normalizeRangedSetting(99, 15, MOOD_TOTAL_SEC_RANGE)).toBe(MOOD_TOTAL_SEC_RANGE.max);
    expect(normalizeRangedSetting(Number.NaN, 15, MOOD_TOTAL_SEC_RANGE)).toBe(15);
  });

  it('손상된 값은 기본값으로, 범위 밖은 클램프한다', () => {
    const broken = JSON.parse(serialize(createInitialState())) as { settings: Record<string, unknown> };
    broken.settings.moodTotalSec = 'soon';
    broken.settings.moodBlackoutSec = -3;
    broken.settings.moodGlitchStrength = 5;
    const migrated = deserialize(JSON.stringify(broken));
    expect(migrated.settings.moodTotalSec).toBe(DEFAULT_MOOD_TOTAL_SEC);
    expect(migrated.settings.moodBlackoutSec).toBe(0);
    expect(migrated.settings.moodGlitchStrength).toBe(1);
  });

  it('settings/patch로 저장되고 직렬화 왕복에서 살아남는다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'settings/patch', patch: { moodTotalSec: 12, moodBlackoutSec: 0, moodGlitchStrength: 0.3 } });
    const round = deserialize(serialize(s));
    expect(round.settings.moodTotalSec).toBe(12);
    expect(round.settings.moodBlackoutSec).toBe(0);
    expect(round.settings.moodGlitchStrength).toBe(0.3);
  });
});

describe('분위기 반전 길이 이름 변경 승격 (U53)', () => {
  /**
   * `moodGlitchSec`(글리치 단계 길이) → `moodTotalSec`(전환 전체 길이)로 **이름이 바뀌었다**.
   * 두 값의 합이 곧 예전의 전체 길이이므로 그대로 옮긴다. 기본값 승격(U26b)과 달리
   * 사용자의 선택을 덮는 것이 아니라 같은 뜻의 값을 새 이름으로 읽는 것뿐이라 `migrate()`에 있다.
   */
  const savedWith = (patch: Record<string, unknown>) => {
    const raw = JSON.parse(serialize(createInitialState())) as { settings: Record<string, unknown> };
    delete raw.settings.moodTotalSec;
    Object.assign(raw.settings, patch);
    return deserialize(JSON.stringify(raw));
  };

  it('옛 저장본의 글리치 + 암전 합이 전체 길이가 된다', () => {
    expect(savedWith({ moodGlitchSec: 10, moodBlackoutSec: 2.5 }).settings.moodTotalSec).toBe(12.5);
    expect(savedWith({ moodGlitchSec: 17.5, moodBlackoutSec: 2.5 }).settings.moodTotalSec).toBe(20);
  });

  it('합이 범위를 벗어나면 클램프한다', () => {
    // 첫 U26 기본값(1.5 + 0.8)은 새 하한보다 짧다
    expect(savedWith({ moodGlitchSec: 1.5, moodBlackoutSec: 0.8 }).settings.moodTotalSec).toBe(
      MOOD_TOTAL_SEC_RANGE.min,
    );
    expect(savedWith({ moodGlitchSec: 40, moodBlackoutSec: 2.5 }).settings.moodTotalSec).toBe(
      MOOD_TOTAL_SEC_RANGE.max,
    );
  });

  it('두 이름이 다 없으면 새 기본값 15초다', () => {
    const raw = JSON.parse(serialize(createInitialState())) as { settings: Record<string, unknown> };
    delete raw.settings.moodTotalSec;
    delete raw.settings.moodGlitchSec;
    expect(deserialize(JSON.stringify(raw)).settings.moodTotalSec).toBe(DEFAULT_MOOD_TOTAL_SEC);
  });

  it('새 이름이 이미 있으면 옛 이름을 보지 않는다 — 사용자의 값이 이긴다', () => {
    const raw = JSON.parse(serialize(createInitialState())) as { settings: Record<string, unknown> };
    raw.settings.moodTotalSec = 22;
    raw.settings.moodGlitchSec = 3;
    const migrated = deserialize(JSON.stringify(raw));
    expect(migrated.settings.moodTotalSec).toBe(22);
    // 매 상태 방송이 migrate를 타므로, 왕복에서도 값이 흔들리면 안 된다
    expect(deserialize(serialize(migrated)).settings.moodTotalSec).toBe(22);
  });
});

describe('색 이름 기본 팀 (U30)', () => {
  /** 옛 기본값 그대로인 저장본 6슬롯 */
  const legacySaved = () =>
    LEGACY_TEAM_DEFAULTS.map((d, i) => ({ id: `t${i + 1}`, name: d.name, color: d.color }));

  /** 저장본 인수 경로 — `loadLocal()`이 하는 일과 같다 */
  const savedTeams = (teams: { id: string; name: string; color: string }[]) => {
    const raw = JSON.parse(serialize(createInitialState())) as {
      teams: unknown;
      settings: Record<string, unknown>;
    };
    raw.teams = teams;
    delete raw.settings.teamDefaultsPromoted;
    return promoteLegacyDefaults(deserialize(JSON.stringify(raw)));
  };

  it('신규 행사 4팀은 색 이름과 그 색을 그대로 쓴다', () => {
    const s = createInitialState();
    expect(activeTeams(s).map((t) => t.name)).toEqual(['YELLOW', 'BLUE', 'RED', 'GREEN']);
    expect(activeTeams(s).map((t) => t.name)).toEqual(DEFAULT_TEAM_NAMES.slice(0, 4));
    expect(activeTeams(s).map((t) => t.color)).toEqual(DEFAULT_TEAM_COLORS.slice(0, 4));
  });

  it('팀명 첫 글자 배지가 서로 겹치지 않는다', () => {
    const initials = DEFAULT_TEAM_NAMES.map((n) => n[0]);
    expect(initials.slice(0, 4)).toEqual(['Y', 'B', 'R', 'G']);
    expect(new Set(initials).size).toBe(DEFAULT_TEAM_NAMES.length);
  });

  it('옛 A~F 기본 저장본은 새 이름·색으로 한 번 승격된다', () => {
    const promoted = savedTeams(legacySaved());
    expect(promoted.teams.map((t) => t.name)).toEqual([...DEFAULT_TEAM_NAMES]);
    expect(promoted.teams.map((t) => t.color)).toEqual([...DEFAULT_TEAM_COLORS]);
    expect(promoted.settings.teamDefaultsPromoted).toBe(true);
  });

  it('사용자가 바꾼 이름·색은 승격이 건드리지 않는다', () => {
    const saved = legacySaved();
    saved[0] = { id: 't1', name: '해적단', color: '#123456' };
    const promoted = savedTeams(saved);
    expect(promoted.teams[0]).toMatchObject({ name: '해적단', color: '#123456' });
    expect(promoted.teams[1].name).toBe(DEFAULT_TEAM_NAMES[1]);
  });

  it('이름만 바꾼 팀은 색만, 색만 바꾼 팀은 이름만 승격된다', () => {
    const saved = legacySaved();
    saved[1] = { id: 't2', name: '파랑단', color: LEGACY_TEAM_DEFAULTS[1].color };
    saved[2] = { id: 't3', name: LEGACY_TEAM_DEFAULTS[2].name, color: '#abcdef' };
    const promoted = savedTeams(saved);
    expect(promoted.teams[1]).toMatchObject({ name: '파랑단', color: DEFAULT_TEAM_COLORS[1] });
    expect(promoted.teams[2]).toMatchObject({ name: DEFAULT_TEAM_NAMES[2], color: '#abcdef' });
  });

  it('승격은 1회 플래그로 끝난다 — 뒤에 A로 되돌려도 다시 올리지 않는다', () => {
    const once = savedTeams(legacySaved());
    expect(promoteLegacyDefaults(once)).toBe(once);

    const back = reducer(once, {
      type: 'team/patch',
      teamId: 't1',
      patch: { name: LEGACY_TEAM_DEFAULTS[0].name, color: LEGACY_TEAM_DEFAULTS[0].color },
    });
    const reloaded = promoteLegacyDefaults(deserialize(serialize(back)));
    expect(reloaded.teams[0]).toMatchObject({
      name: LEGACY_TEAM_DEFAULTS[0].name,
      color: LEGACY_TEAM_DEFAULTS[0].color,
    });
  });

  it('승격은 migrate가 아니라 저장본 인수에서만 일어난다', () => {
    const raw = JSON.parse(serialize(createInitialState())) as {
      teams: unknown;
      settings: Record<string, unknown>;
    };
    raw.teams = legacySaved();
    delete raw.settings.teamDefaultsPromoted;

    // 방송 경로 — 저장본 값을 그대로 돌려준다
    const broadcast = deserialize(JSON.stringify(raw));
    expect(broadcast.teams[0].name).toBe(LEGACY_TEAM_DEFAULTS[0].name);

    // 인수 경로 — 여기서만 새 기본값으로 올라간다
    expect(promoteLegacyDefaults(broadcast).teams[0].name).toBe(DEFAULT_TEAM_NAMES[0]);
  });

  it('표식은 구 저장본에서 false로 시작하고 왕복에서 보존된다', () => {
    const raw = JSON.parse(serialize(createInitialState())) as { settings: Record<string, unknown> };
    delete raw.settings.teamDefaultsPromoted;
    expect(deserialize(JSON.stringify(raw)).settings.teamDefaultsPromoted).toBe(false);

    const marked = promoteLegacyDefaults(deserialize(JSON.stringify(raw)));
    expect(deserialize(serialize(marked)).settings.teamDefaultsPromoted).toBe(true);
  });
});

/**
 * 체크포인트 리뷰 수정 — 확정 직후 토스트의 [되돌리기]가 **확정 당시 회차**를 지운다.
 * 그 사이 [다음 회차 +]를 눌렀다면 지금 회차를 지우는 것이 아니다.
 */
describe('p1/revoke 회차 지정', () => {
  function confirmed() {
    let s = createInitialState();
    s = reducer(s, { type: 'p1/rank', eventId: 'curling', teamId: 't1', rank: 1 });
    s = reducer(s, { type: 'p1/rank', eventId: 'curling', teamId: 't2', rank: 2 });
    return reducer(s, { type: 'p1/confirm', eventId: 'curling', now: 1 });
  }

  it('회차를 주지 않으면 예전처럼 현재 회차를 역분개한다', () => {
    const s = confirmed();
    const after = reducer(s, { type: 'p1/revoke', eventId: 'curling', now: 2 });
    expect(activeLedger(after.ledger).filter((e) => e.ref.startsWith('p1:curling'))).toHaveLength(0);
    expect(getEvent(after, 'curling').confirmedAt).toBeNull();
  });

  it('다음 회차를 연 뒤에도 지정한 회차만 역분개한다', () => {
    const s = confirmed();
    const round1 = getEvent(s, 'curling').round;
    const opened = reducer(s, { type: 'p1/nextRound', eventId: 'curling' });
    expect(getEvent(opened, 'curling').round).toBe(round1 + 1);

    const after = reducer(opened, { type: 'p1/revoke', eventId: 'curling', round: round1, now: 4 });
    const ref1 = p1RoundRef('curling', round1);
    expect(activeLedger(after.ledger).filter((e) => e.ref === ref1)).toHaveLength(0);
    // 지난 회차를 되돌린 것이므로 지금 회차의 상태는 건드리지 않는다
    expect(getEvent(after, 'curling').round).toBe(round1 + 1);
  });

  it('역분개도 삭제가 아니라 항목 추가다 (append-only)', () => {
    const s = confirmed();
    const before = s.ledger.length;
    const after = reducer(s, { type: 'p1/revoke', eventId: 'curling', now: 2 });
    expect(after.ledger.length).toBeGreaterThan(before);
  });
});

/**
 * Q5 슬로우 리플레이 (A안 · 2026-09-04 00:43 사용자 선택).
 *
 * 재생 지시는 **런타임 필드**다. 저장본에서 되살아나면 안 되지만, migrate가 지우면
 * display가 방송으로 그 지시를 한 번도 못 본다(설명 영상 phase와 같은 계약).
 */
describe('슬로우 리플레이 상태 (Q5)', () => {
  const live = (over: Partial<AppState['settings']> = {}): AppState => {
    const base = reducer(createInitialState(), { type: 'scene/set', scene: 'live' });
    return Object.keys(over).length
      ? reducer(base, { type: 'settings/patch', patch: over })
      : base;
  };

  it('설정 기본값 — 켬 · 10초 · 0.5배속 (U85에서 0.1로 내렸다가 U107에서 복귀)', () => {
    const s = createInitialState().settings;
    expect(s.replayEnabled).toBe(true);
    expect(s.replaySec).toBe(REPLAY_DEFAULTS.sec);
    expect(s.replayRate).toBe(REPLAY_DEFAULTS.rate);
    // 사용자 원문 "중계 0.1배속은 너무 느리네. 0.5배속으로 하자" — 기본이 0.5여야 한다 (U107)
    expect(REPLAY_DEFAULTS.rate).toBe(0.5);
    expect(REPLAY_SEC_RANGE).toEqual({ min: 3, max: 30 });
    // 0.1은 U85가 남긴 선택지로 그대로 남는다 — 기본값만 바뀌었다
    expect(REPLAY_RATES).toEqual([0.1, 0.25, 0.5, 0.75, 1]);
    // 배지·상단 칩·설정 드롭다운이 같은 포맷터를 쓰므로 여기서 한 번만 잠근다
    expect(formatReplayRate(0.1)).toBe('0.1');
    expect(formatReplayRate(0.5)).toBe('0.5');
  });

  it('초기 상태의 재생 지시는 비어 있고 토큰은 0이다', () => {
    const o = createInitialState().sceneOpts.liveOverlay;
    expect(o.replay).toBeNull();
    expect(o.replayToken).toBe(0);
    expect(o.replayMarkAt).toBeNull();
  });

  it('live/replay는 설정을 스냅샷으로 굳힌다 — 재생 도중 설정을 바꿔도 흔들리지 않는다', () => {
    const started = reducer(live({ replaySec: 6, replayRate: 0.25 }), {
      type: 'live/replay',
      now: T0,
    });
    expect(started.sceneOpts.liveOverlay.replay).toEqual({
      token: 1,
      seconds: 6,
      rate: 0.25,
      startedAt: T0,
    });

    const changed = reducer(started, {
      type: 'settings/patch',
      patch: { replaySec: 30, replayRate: 1 },
    });
    expect(changed.sceneOpts.liveOverlay.replay).toEqual({
      token: 1,
      seconds: 6,
      rate: 0.25,
      startedAt: T0,
    });
  });

  it('토큰은 정지·재시작을 건너 단조 증가한다 — 옛 종료 보고가 새 재생을 죽이지 못한다', () => {
    const first = reducer(live(), { type: 'live/replay', now: T0 });
    const stopped = reducer(first, { type: 'live/replayStop' });
    const second = reducer(stopped, { type: 'live/replay', now: T0 + 5_000 });

    expect(second.sceneOpts.liveOverlay.replay?.token).toBe(2);
    expect(second.sceneOpts.liveOverlay.replayToken).toBe(2);

    // 1번 재생의 늦은 종료 보고는 2번 재생을 건드리지 못한다
    const stale = reducer(second, { type: 'live/replayEnded', token: 1 });
    expect(stale.sceneOpts.liveOverlay.replay?.token).toBe(2);
  });

  it('live/replayEnded는 토큰이 맞을 때만 비운다', () => {
    const started = reducer(live(), { type: 'live/replay', now: T0 });
    expect(reducer(started, { type: 'live/replayEnded', token: 99 })).toBe(started);
    expect(
      reducer(started, { type: 'live/replayEnded', token: 1 }).sceneOpts.liveOverlay.replay,
    ).toBeNull();
  });

  it('live/replayStop은 토큰과 무관하게 무조건 비운다 (라이브 복귀 · 오류 복구)', () => {
    const started = reducer(live(), { type: 'live/replay', now: T0 });
    expect(reducer(started, { type: 'live/replayStop' }).sceneOpts.liveOverlay.replay).toBeNull();
    // 이미 비어 있으면 같은 참조 — 불필요한 방송·저장을 만들지 않는다
    const idle = live();
    expect(reducer(idle, { type: 'live/replayStop' })).toBe(idle);
  });

  it('중계 화면이 아니면 live/replay는 아무 일도 하지 않는다', () => {
    const board = createInitialState();
    expect(reducer(board, { type: 'live/replay', now: T0 })).toBe(board);
  });

  it('중계 화면을 떠나면 재생 지시가 즉시 사라진다 (스팅어 헤드룸 보수안)', () => {
    const started = reducer(live(), { type: 'live/replay', now: T0 });
    const left = reducer(started, { type: 'scene/set', scene: 'score' });
    expect(left.sceneOpts.liveOverlay.replay).toBeNull();
    // 토큰은 살려 둔다 — 지우면 다시 들어와 튼 재생이 옛 종료 보고와 우연히 맞아떨어진다
    expect(left.sceneOpts.liveOverlay.replayToken).toBe(1);
  });

  it('중계 화면 안에서 하는 조작은 재생을 끊지 않는다', () => {
    const started = reducer(live(), { type: 'live/replay', now: T0 });
    const toggled = reducer(started, {
      type: 'sceneOpts/patch',
      patch: { liveOverlay: { scorebar: false } },
    });
    expect(toggled.sceneOpts.liveOverlay.replay?.token).toBe(1);
  });

  it('리더 인수(resetRuntimeVideoPhase)에서만 런타임 지시를 끊는다', () => {
    const started = reducer(live(), { type: 'live/replay', now: T0 });
    expect(resetRuntimeVideoPhase(started).sceneOpts.liveOverlay.replay).toBeNull();
    // 끊을 것이 없으면 같은 참조 그대로
    const idle = live();
    expect(resetRuntimeVideoPhase(idle)).toBe(idle);
  });

  it('방송(역직렬화)은 재생 지시를 그대로 통과시킨다 — migrate가 지우면 display가 못 본다', () => {
    const started = reducer(live(), { type: 'live/replay', now: T0 });
    const round = deserialize(serialize(started));
    expect(round.sceneOpts.liveOverlay.replay).toEqual({
      token: 1,
      seconds: REPLAY_DEFAULTS.sec,
      rate: REPLAY_DEFAULTS.rate,
      startedAt: T0,
    });
  });

  it('모양이 깨진 재생 지시·토큰은 null과 0으로 정규화한다', () => {
    const broken = deserialize(
      JSON.stringify({
        ...createInitialState(),
        sceneOpts: {
          ...createInitialState().sceneOpts,
          liveOverlay: {
            scorebar: true,
            timer: true,
            badge: null,
            versus: null,
            replay: { token: 'x', seconds: null, rate: 0.5, startedAt: 1 },
            replayToken: -4.5,
          },
        },
      }),
    );
    expect(broken.sceneOpts.liveOverlay.replay).toBeNull();
    expect(broken.sceneOpts.liveOverlay.replayToken).toBe(0);
  });

  it('설정 결측·범위 밖 값은 기본값·클램프로 채운다 (구 저장본 호환)', () => {
    const legacy = deserialize(
      JSON.stringify({ settings: { replaySec: 900, replayRate: 3, title: '테스트' } }),
    );
    expect(legacy.settings.replaySec).toBe(REPLAY_SEC_RANGE.max);
    expect(legacy.settings.replayRate).toBe(REPLAY_DEFAULTS.rate);
    expect(legacy.settings.replayEnabled).toBe(true);

    const off = deserialize(JSON.stringify({ settings: { replayEnabled: false, replaySec: 0.4 } }));
    expect(off.settings.replayEnabled).toBe(false);
    expect(off.settings.replaySec).toBe(REPLAY_SEC_RANGE.min);
  });

  it('되감기 길이는 정수 초로만 저장한다 (세그먼트 주기 계산의 입력이다)', () => {
    const s = deserialize(JSON.stringify({ settings: { replaySec: 12.7 } }));
    expect(Number.isInteger(s.settings.replaySec)).toBe(true);
    expect(s.settings.replaySec).toBe(13);
  });
});

/**
 * U85 — [지금부터] 구간 잡기.
 *
 * 사용자 원문: "10초는 좀 긴 것 같아. 버튼을 반으로 쪼개고 '지금부터' 버튼을 만들어줘.
 * 그걸 누르면 누른 시점 1초 전부터 메모리에 담겨서 그 구간만큼만 재생되도록."
 */
describe('[지금부터] 구간 리플레이 (U85)', () => {
  const live = (): AppState => reducer(createInitialState(), { type: 'scene/set', scene: 'live' });

  it('마크는 누른 시점보다 1초 앞을 찍는다 — 손이 갈 때는 그 장면이 이미 지났다', () => {
    const marked = reducer(live(), { type: 'live/replayMark', now: T0 });
    expect(marked.sceneOpts.liveOverlay.replayMarkAt).toBe(T0 - REPLAY_MARK_LEAD_MS);
    expect(REPLAY_MARK_LEAD_MS).toBe(1000);
  });

  it('중계 화면이 아니면 찍히지 않는다 — 링이 안 도는 씬에서는 되감을 녹화본이 없다', () => {
    const board = createInitialState();
    expect(reducer(board, { type: 'live/replayMark', now: T0 })).toBe(board);
  });

  it('취소는 마크만 지우고, 지울 것이 없으면 같은 참조 그대로', () => {
    const marked = reducer(live(), { type: 'live/replayMark', now: T0 });
    expect(reducer(marked, { type: 'live/replayMarkClear' }).sceneOpts.liveOverlay.replayMarkAt).toBeNull();
    const idle = live();
    expect(reducer(idle, { type: 'live/replayMarkClear' })).toBe(idle);
  });

  it('명시 구간이 설정값을 이기고, 소수 초가 반올림되지 않는다', () => {
    const started = reducer(live(), { type: 'live/replay', now: T0, seconds: 4.3 });
    expect(started.sceneOpts.liveOverlay.replay).toEqual({
      token: 1,
      seconds: 4.3,
      rate: REPLAY_DEFAULTS.rate,
      startedAt: T0,
    });
    // 설정값(기본 10초)은 명시 구간에 밀린다
    expect(started.sceneOpts.liveOverlay.replay?.seconds).not.toBe(REPLAY_DEFAULTS.sec);
  });

  it('명시 구간은 세그먼트 범위로 클램프한다 — 설정 범위(3초 하한)와 다르다', () => {
    const short = reducer(live(), { type: 'live/replay', now: T0, seconds: 0.2 });
    expect(short.sceneOpts.liveOverlay.replay?.seconds).toBe(REPLAY_SEGMENT_SEC_RANGE.min);
    // 1초짜리 구간은 뜻이 있다(찍자마자 다시 누른 경우가 정확히 1초다)
    expect(REPLAY_SEGMENT_SEC_RANGE.min).toBe(1);

    const long = reducer(live(), { type: 'live/replay', now: T0, seconds: 900 });
    expect(long.sceneOpts.liveOverlay.replay?.seconds).toBe(REPLAY_SEGMENT_SEC_RANGE.max);
  });

  it('seconds를 생략하면 예전처럼 설정값을 굳힌다', () => {
    const started = reducer(live(), { type: 'live/replay', now: T0 });
    expect(started.sceneOpts.liveOverlay.replay?.seconds).toBe(REPLAY_DEFAULTS.sec);
  });

  it('재생이 시작되면 마크는 소비된다 — 남으면 버튼이 아직 찍은 게 있다고 거짓말한다', () => {
    const marked = reducer(live(), { type: 'live/replayMark', now: T0 });
    const started = reducer(marked, { type: 'live/replay', now: T0 + 4_300, seconds: 4.3 });
    expect(started.sceneOpts.liveOverlay.replayMarkAt).toBeNull();
  });

  it('중계 화면을 떠나면 마크도 함께 버린다 — 링이 폐기돼 그 구간의 녹화본이 사라진다', () => {
    const marked = reducer(live(), { type: 'live/replayMark', now: T0 });
    const left = reducer(marked, { type: 'scene/set', scene: 'score' });
    expect(left.sceneOpts.liveOverlay.replayMarkAt).toBeNull();
  });

  it('리더 인수(resetRuntimeVideoPhase)도 마크를 끊는다', () => {
    const marked = reducer(live(), { type: 'live/replayMark', now: T0 });
    expect(resetRuntimeVideoPhase(marked).sceneOpts.liveOverlay.replayMarkAt).toBeNull();
  });

  it('방송은 마크를 그대로 나른다 — migrate가 지우면 보조 창의 버튼이 리더와 다른 말을 한다', () => {
    const marked = reducer(live(), { type: 'live/replayMark', now: T0 });
    const round = deserialize(serialize(marked));
    expect(round.sceneOpts.liveOverlay.replayMarkAt).toBe(T0 - REPLAY_MARK_LEAD_MS);
  });

  it('모양이 깨진 마크는 null로 접는다', () => {
    const broken = deserialize(
      JSON.stringify({
        sceneOpts: { liveOverlay: { replayMarkAt: 'yesterday' } },
      }),
    );
    expect(broken.sceneOpts.liveOverlay.replayMarkAt).toBeNull();
  });

  it('명시 구간의 소수 초는 방송을 건너도 살아남는다 (정수 반올림 금지)', () => {
    const started = reducer(live(), { type: 'live/replay', now: T0, seconds: 4.3 });
    expect(deserialize(serialize(started)).sceneOpts.liveOverlay.replay?.seconds).toBe(4.3);
  });
});

/**
 * U85 — 배속 기본값 `0.5` → `0.1` 일회성 승격 (은퇴, U107이 역방향으로 대체).
 * U107 — 배속 기본값 `0.1` → `0.5` 복귀 일회성 승격.
 *
 * 사용자 원문 "중계 0.1배속은 너무 느리네. 0.5배속으로 하자"(2026-09-05 04:52). U85가 이미
 * 훑고 지나간 저장본(`replayRatePromoted === true`)의 `0.1`은 "U85 자동 승격 결과"인지
 * "그 뒤 사용자가 직접 고른 0.1"인지 구분할 수 없어 일괄로 0.5까지 올린다.
 */
describe('리플레이 배속 승격 (U85 → U107 복귀)', () => {
  const saved = (over: Record<string, unknown>): AppState =>
    deserialize(JSON.stringify({ settings: { ...over } }));

  it('U85가 자동 승격한 저장본(0.1 + replayRatePromoted)을 U107이 한 번만 0.5로 되돌린다', () => {
    const legacy = saved({ replayRate: U107_LEGACY_REPLAY_RATE, replayRatePromoted: true });
    expect(legacy.settings.replayRatePromoted2).toBe(false);

    const promoted = promoteLegacyDefaults(legacy);
    expect(promoted.settings.replayRate).toBe(REPLAY_DEFAULTS.rate);
    expect(promoted.settings.replayRate).toBe(0.5);
    expect(promoted.settings.replayRatePromoted2).toBe(true);
  });

  it('승격 뒤에 사용자가 다시 고른 0.1은 덮지 않는다 — 표식이 그 선택을 지킨다', () => {
    const chosen = promoteLegacyDefaults(
      saved({
        replayRate: U107_LEGACY_REPLAY_RATE,
        replayRatePromoted: true,
        replayRatePromoted2: true,
      }),
    );
    expect(chosen.settings.replayRate).toBe(U107_LEGACY_REPLAY_RATE);
  });

  it('0.1이 아닌 값(0.25)은 건드리지 않고 표식만 남긴다', () => {
    const picked = promoteLegacyDefaults(saved({ replayRate: 0.25, replayRatePromoted: true }));
    expect(picked.settings.replayRate).toBe(0.25);
    expect(picked.settings.replayRatePromoted2).toBe(true);
  });

  it('승격은 migrate가 아니라 promoteLegacyDefaults에만 있다 — 방송마다 돌면 선택을 덮는다', () => {
    // migrate(=deserialize)만 지나면 0.1이 그대로 남는다
    expect(
      saved({ replayRate: U107_LEGACY_REPLAY_RATE, replayRatePromoted: true }).settings.replayRate,
    ).toBe(U107_LEGACY_REPLAY_RATE);
  });

  it('U85 방향(0.5→0.1) 승격은 은퇴했다 — 옛 기본값 0.5가 박힌 저장본을 더 이상 0.1로 내리지 않는다', () => {
    const legacyOld = saved({ replayRate: LEGACY_REPLAY_RATE, replayRatePromoted: false });
    const promoted = promoteLegacyDefaults(legacyOld);
    expect(promoted.settings.replayRate).toBe(LEGACY_REPLAY_RATE);
  });
});

/** 공개본은 특정 행사 곡을 자동 선택하지 않는다. */
describe('승리 음악 공개 기본값', () => {
  const saved119 = (over: Record<string, unknown>): AppState =>
    deserialize(
      JSON.stringify({ settings: { victoryMusicTrackId: null, victoryMusicPromoted: false, ...over } }),
    );

  it('명시적 null 저장본을 인수해도 특정 곡으로 올리지 않는다', () => {
    const legacy = saved119({});
    expect(legacy.settings.victoryMusicTrackId).toBeNull();
    expect(legacy.settings.victoryMusicPromoted).toBe(false);

    const promoted = promoteLegacyDefaults(legacy);
    expect(promoted.settings.victoryMusicTrackId).toBeNull();
    expect(promoted.settings.victoryMusicPromoted).toBe(true);
  });

  it('승격 뒤에 운영자가 다시 비운 null은 덮지 않는다 — 표식이 그 선택을 지킨다', () => {
    const clearedByOperator = promoteLegacyDefaults(saved119({ victoryMusicPromoted: true }));
    expect(clearedByOperator.settings.victoryMusicTrackId).toBeNull();
  });

  it('운영자가 이미 다른 곡을 고른 저장본은 건드리지 않고 표식만 남긴다', () => {
    const chosen = promoteLegacyDefaults(saved119({ victoryMusicTrackId: '05' }));
    expect(chosen.settings.victoryMusicTrackId).toBe('05');
    expect(chosen.settings.victoryMusicPromoted).toBe(true);
  });

  it('승격은 migrate가 아니라 promoteLegacyDefaults에만 있다 — 방송마다 돌면 선택을 덮는다', () => {
    // migrate(=deserialize)만 지나면 명시적으로 저장된 null이 그대로 남는다
    expect(saved119({}).settings.victoryMusicTrackId).toBeNull();
  });

  it('키 자체가 없는 저장본도 미지정 기본값을 물려받는다', () => {
    expect(deserialize(JSON.stringify({})).settings.victoryMusicTrackId).toBeNull();
  });

  it('신규 행사도 미지정으로 시작하고 인수 표식만 남긴다', () => {
    const fresh = createInitialState();
    expect(fresh.settings.victoryMusicTrackId).toBeNull();
    expect(fresh.settings.victoryMusicPromoted).toBe(false);
    const passed = promoteLegacyDefaults(fresh);
    expect(passed.settings.victoryMusicTrackId).toBeNull();
    expect(passed.settings.victoryMusicPromoted).toBe(true);
  });
});

/**
 * Q5 #12 — **전환을 거쳐** 중계 화면을 떠날 때도 재생 지시가 놓인다.
 *
 * 4174 격리 Playwright 실측에서 나온 결함이다. `scene/set` 한 곳만 리플레이를 끊고 있어서,
 * F1을 누르면 `scene-routing.ts`가 그것을 `sceneFade/play` → `sceneFade/switched`로 감싸
 * 최종 상태가 `scene: 'standby'`인데 `liveOverlay.replay`가 살아남았다. display는 자기 가드로
 * 그림만은 지켰지만 조작 화면의 상단 REPLAY 칩과 런처 [라이브 복귀] 라벨이 굳었다.
 */
describe('리플레이 이탈 정리 — 전환 경유 (Q5 #12)', () => {
  const T = 1_700_000_000_000;

  /** 중계 화면 + 리플레이 재생 중 */
  const playing = (mode: AppState['settings']['sceneTransitionMode'] = 'black'): AppState => {
    const onLive = reducer(createInitialState(), { type: 'scene/set', scene: 'live' });
    const withMode = reducer(onLive, {
      type: 'settings/patch',
      patch: { sceneTransitionMode: mode },
    });
    return reducer(withMode, { type: 'live/replay', now: T });
  };

  /** 액션 배열을 순서대로 흘려 넣는다 (control의 dispatch 배열과 같은 취급) */
  const runAll = (state: AppState, actions: Action[]): AppState =>
    actions.reduce((acc, action) => reducer(acc, action), state);

  it('컬러 페이드로 감싼 F1 — switch 시점에 replay가 놓인다', () => {
    const start = playing('black');
    expect(start.sceneOpts.liveOverlay.replay).not.toBeNull();

    // 런처 F1이 실제로 내보내는 배열 그대로
    const routed = routeSceneActionsThroughDefaultTransition(
      start,
      [{ type: 'scene/set', scene: 'standby', opts: { standby: { mode: 'main' } } }],
      T + 1_000,
    );
    const fade = routed.find((a) => a.type === 'sceneFade/play');
    expect(fade).toBeDefined();

    // 페이드를 걸고 나면 화면은 아직 중계다 — 지시도 그대로 살아 있어야 한다
    const covering = runAll(start, routed);
    expect(covering.scene).toBe('live');
    expect(covering.sceneOpts.liveOverlay.replay).not.toBeNull();

    // 검정이 덮은 순간 씬이 넘어가고, 그때 지시가 놓인다
    const token = covering.sceneOpts.sceneFade.restartToken;
    const switched = reducer(covering, { type: 'sceneFade/switched', token });
    expect(switched.scene).toBe('standby');
    expect(switched.sceneOpts.liveOverlay.replay).toBeNull();
    // 토큰은 남는다 — 지우면 다시 들어와 튼 재생이 옛 종료 보고와 맞아떨어진다
    expect(switched.sceneOpts.liveOverlay.replayToken).toBe(1);
  });

  it('switch 없이 finish만 와도(짧은 페이드·오류 수렴) 놓는다', () => {
    const start = playing('black');
    const routed = routeSceneActionsThroughDefaultTransition(
      start,
      [{ type: 'scene/set', scene: 'score' }],
      T + 1_000,
    );
    const covering = runAll(start, routed);
    const token = covering.sceneOpts.sceneFade.restartToken;
    const done = reducer(covering, { type: 'sceneFade/finish', token });
    expect(done.scene).toBe('score');
    expect(done.sceneOpts.liveOverlay.replay).toBeNull();
  });

  it('전환 영상(스팅어) switch·finish 경로도 같다', () => {
    const start = playing('stinger');
    const played = reducer(start, {
      type: 'transition/play',
      assetId: 'a1',
      nextScene: 'standby',
      switchAtSec: 0.5,
      now: T + 1_000,
    });
    expect(played.sceneOpts.liveOverlay.replay).not.toBeNull();

    const switched = reducer(played, {
      type: 'transition/switched',
      token: played.sceneOpts.transitionVideo.restartToken,
    });
    expect(switched.scene).toBe('standby');
    expect(switched.sceneOpts.liveOverlay.replay).toBeNull();

    // switch를 놓친 경우 finish가 목표 씬으로 수렴하며 같은 정리를 한다
    const settled = reducer(played, {
      type: 'transition/finish',
      token: played.sceneOpts.transitionVideo.restartToken,
    });
    expect(settled.scene).toBe('standby');
    expect(settled.sceneOpts.liveOverlay.replay).toBeNull();
  });

  it('설명 영상 covered(씬을 video로 옮김)도 놓는다', () => {
    const start = playing('black');
    const full = reducer(start, {
      type: 'video/playFull',
      assetId: 'v1',
      nextScene: null,
      now: T + 1_000,
    });
    const covered = reducer(full, {
      type: 'video/covered',
      token: full.sceneOpts.video.phaseToken,
    });
    expect(covered.scene).toBe('video');
    expect(covered.sceneOpts.liveOverlay.replay).toBeNull();
  });

  it('중계 화면 안에서 도는 전환은 지시를 건드리지 않는다', () => {
    const start = playing('black');
    const staying = reducer(start, {
      type: 'sceneFade/play',
      color: '#000000',
      nextScene: 'live',
      durationSec: 0.5,
      now: T + 1_000,
    });
    const switched = reducer(staying, {
      type: 'sceneFade/switched',
      token: staying.sceneOpts.sceneFade.restartToken,
    });
    expect(switched.scene).toBe('live');
    expect(switched.sceneOpts.liveOverlay.replay).not.toBeNull();
  });
});

/**
 * U52 — 종목 이름이 `일심동체` → `몸으로 말해요`로 바뀌었지만 **id(`sync`)는 그대로**다.
 *
 * 저장본에는 이름이 통째로 들어 있고 migrate가 `{ ...base, ...saved }`로 병합하므로 저장된
 * 옛 이름이 새 기본값을 덮었다. 그래서 U52 이후 빌드에서도 저장본을 이어 쓰면 화면·패널·
 * 큐시트가 계속 옛 이름을 보였다. 개명은 사용자의 선택이 아니라 명칭 정정이라 여기서 올린다.
 */
describe('종목 이름 승격 (U52)', () => {
  /** 옛 저장본 한 벌 — 이름만 옛 것이고 나머지는 정상이다 */
  const legacySave = (syncName: string): unknown => {
    const base = createInitialState();
    return {
      ...base,
      p1: {
        events: base.p1.events.map((e) => (e.id === 'sync' ? { ...e, name: syncName } : e)),
      },
    };
  };

  it('저장본의 옛 이름을 새 공식 이름으로 올린다', () => {
    const migrated = migrate(JSON.parse(JSON.stringify(legacySave('일심동체'))));
    expect(migrated.p1.events.find((e) => e.id === 'sync')!.name).toBe('몸으로 말해요');
  });

  it('사용자가 직접 고친 이름은 보존한다 — 이름은 원래 편집 가능한 값이다', () => {
    const migrated = migrate(JSON.parse(JSON.stringify(legacySave('몸으로 말해요 (수정)'))));
    expect(migrated.p1.events.find((e) => e.id === 'sync')!.name).toBe('몸으로 말해요 (수정)');
  });

  it('다른 종목 이름은 건드리지 않는다', () => {
    const migrated = migrate(JSON.parse(JSON.stringify(legacySave('일심동체'))));
    expect(migrated.p1.events.map((e) => e.name)).toEqual([
      '컬링',
      '신문지 달리기',
      '끈끈이 낚시',
      '몸으로 말해요',
    ]);
  });

  it('이름이 아예 없는 저장본은 기본값으로 채운다', () => {
    const base = createInitialState();
    const raw = {
      ...base,
      p1: {
        events: base.p1.events.map(({ name: _name, ...rest }) => rest),
      },
    };
    const migrated = migrate(JSON.parse(JSON.stringify(raw)));
    expect(migrated.p1.events.map((e) => e.name)).toEqual([
      P1_EVENT_NAMES.curling,
      P1_EVENT_NAMES.newspaper,
      P1_EVENT_NAMES.sticky,
      P1_EVENT_NAMES.sync,
    ]);
  });

  it('승격 판정은 순수 함수 하나이고 런타임 값은 건드리지 않는다', () => {
    expect(promoteLegacyEventName('sync', '일심동체')).toBe('몸으로 말해요');
    expect(promoteLegacyEventName('sync', '몸으로 말해요')).toBe('몸으로 말해요');
    expect(promoteLegacyEventName('sync', '우리끼리')).toBe('우리끼리');
    expect(promoteLegacyEventName('sync', undefined)).toBe('몸으로 말해요');
    // 옛 이름을 다른 종목에 붙여도 그 종목은 올리지 않는다 (id별 정본만 본다)
    expect(promoteLegacyEventName('curling', '일심동체')).toBe('일심동체');

    // 이름 승격이 확정·순위·회차 같은 런타임 값을 흔들지 않는다
    const played = reducer(
      reducer(createInitialState(), { type: 'p1/rank', eventId: 'sync', teamId: 't1', rank: 1 }),
      { type: 'p1/nextRound', eventId: 'sync' },
    );
    const stale = {
      ...played,
      p1: {
        events: played.p1.events.map((e) => (e.id === 'sync' ? { ...e, name: '일심동체' } : e)),
      },
    };
    const migrated = migrate(JSON.parse(JSON.stringify(stale)));
    const sync = migrated.p1.events.find((e) => e.id === 'sync')!;
    expect(sync.name).toBe('몸으로 말해요');
    expect(sync.round).toBe(played.p1.events.find((e) => e.id === 'sync')!.round);
    expect(migrated.ledger).toEqual(played.ledger);
  });
});
