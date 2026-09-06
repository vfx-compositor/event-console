// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
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
  CUE,
  cueActions,
  cueWithVideos,
  defaultBreakingVideoId,
  effectiveCueAfter,
  HEAT_ROSTER_EVENTS,
  isScriptedCueAsset,
  MATCH_EVENTS,
  matchCueBlock,
  matchCueOnRightScene,
  nextCueIndex,
  prevCueIndex,
  resolveCurrentCueIndex,
  ROSTER_EVENTS,
  victoryCueNotice,
  victoryCueVideo,
  victoryMusicOf,
  victoryOutputActions,
  victoryOutputBlock,
  cueOverlayAssetId,
} from './cue';
import { needsMusicDuck, videoAudioOwnsOutput } from './music-duck';
import { createInitialState, migrate, P1_EVENT_ORDER, reducer } from './state';
import type { AssetMeta, P1EventId } from './types';

/**
 * 한 종목이 큐에서 차지하는 항목들, **대본 순서 그대로**.
 *
 * `id.endsWith('-<종목>')` 필터를 쓰지 않는다 — 접미사가 붙는 항목(`roster-newspaper-heat`)이
 * 조용히 빠져 순서 검사가 통과해 버린다. 기대 목록을 한 곳에 적고 필터도 그 목록으로 건다.
 */
function eventCueIds(eventId: P1EventId): string[] {
  return [
    `game-standby-${eventId}`,
    // U36 — 출전 명단 직전에 대결 매치 영상 자리. 대결로 진행하지 않는 종목은 없다(U52).
    ...(MATCH_EVENTS.includes(eventId) ? [`match-${eventId}`] : []),
    // U61 — 조가 있는 종목(신문지 달리기)은 이번 조 명단이 전체 명단 앞에 하나 더 있다.
    ...(HEAT_ROSTER_EVENTS.includes(eventId) ? [`roster-${eventId}-heat`] : []),
    // U55 — 전원 참가 종목(몸으로 말해요)은 명단 자리 자체가 없다.
    ...(ROSTER_EVENTS.includes(eventId) ? [`roster-${eventId}`] : []),
    `live-${eventId}`,
    // U71 — 승리 팀 발표는 점수 공개 앞이다.
    `victory-${eventId}`,
    `score-${eventId}`,
  ];
}

describe('큐시트', () => {
  it('진행 순서가 대본 순서와 일치한다', () => {
    const labels = CUE.map((c) => c.label);
    // U60 — 개회식 다음이 선수 선서다
    expect(labels.slice(0, 3)).toEqual(['팀별 사전미션', '개회식', '선수 선서']);
    expect(labels).not.toContain('컬링 게임 오프닝');
    expect(labels).toContain('컬링 대기화면');
    expect(labels).toContain('컬링 · 출전 명단');
    expect(labels).toContain('컬링 · 경기 중계');
    expect(labels).toContain('컬링 · 점수 공개');
    expect(labels.indexOf('쉬는시간')).toBeGreaterThan(labels.indexOf('몸으로 말해요 · 점수 공개'));
    expect(CUE.findIndex((cue) => cue.id === 'award')).toBeGreaterThan(
      CUE.findIndex((cue) => cue.id === 'p2-steady-3'),
    );
    expect(CUE.find((cue) => cue.id === 'award')?.locked).toBe(true);
    // U94 — planning-team 큐는 제거됐다. `종료 · 대기 화면`이 다시 마지막 항목이다.
    expect(CUE.some((cue) => cue.id === 'planning-team')).toBe(false);
    expect(labels[labels.length - 1]).toBe('종료 · 대기 화면');
    expect(CUE[CUE.length - 1]).toMatchObject({ id: 'end', scene: 'standby', phase: 'end' });
    expect(CUE[0].opts).toEqual({ standby: { mode: 'pre-mission' } });
  });

  it.each(P1_EVENT_ORDER)('%s 게임 대기 cue는 사전미션 모드를 반드시 일반 대기로 닫는다', (eventId) => {
    expect(CUE.find((item) => item.id === `game-standby-${eventId}`)?.opts).toMatchObject({
      game: { eventId, mode: 'standby' },
      standby: { mode: 'main' },
    });
  });

  it('2부 기본 큐는 단계마다 대기화면 한 항목뿐이다 (U112 — 진행 중 제출 보드 큐 진입점 제거)', () => {
    const breakIndex = CUE.findIndex((item) => item.id === 'break');
    expect(CUE.slice(breakIndex, breakIndex + 7).map((item) => [item.id, item.label, item.scene])).toEqual([
      ['break', '쉬는시간', 'standby'],
      ['part2-live', '2부 전환 · 라이브 송출', 'live'],
      ['breaking', '▶ Part 1 · 글리치 → 분위기반전 영상', 'breaking'],
      ['p2-steady-1', '2부 1단계 · 대기화면', 'submit'],
      ['p2-steady-2', '2부 2단계 · 대기화면', 'submit'],
      ['p2-steady-3', '2부 3단계 · 대기화면', 'submit'],
      ['award', '시상 · 순위 집계', 'award'],
    ]);
    expect(CUE.some((item) => item.id.startsWith('board-'))).toBe(false);
    // U112 — 2부는 게임 진행 중 아무것도 공개하지 않는다. 큐에는 `submit-s<n>`(제출 보드) 자리가 없다.
    expect(CUE.some((item) => item.id.startsWith('submit-s'))).toBe(false);
    // 대기화면도 2부 항목이라 잠금 대상이고, 힌트가 어느 그림인지 못 박는다
    for (const n of [1, 2, 3] as const) {
      const item = CUE.find((c) => c.id === `p2-steady-${n}`)!;
      expect(item.locked).toBe(true);
      expect(item.phase).toBe('p2');
      expect(item.hint).toContain(`p2_steady_stage${n}.jpeg`);
      expect(item.opts).toEqual({ submit: { stageId: `s${n}`, mode: 'steady' } });
    }
    // 크롬은 전부 끄고 다크 프레임만 얹는다 (U118)
    expect(CUE[breakIndex + 1].opts).toEqual({
      liveOverlay: {
        badge: null,
        scorebar: false,
        timer: false,
        versus: null,
        frame: 'dark-standby',
      },
    });
  });

  it('잠금 상태에서는 잠긴 항목을 건너뛴다', () => {
    const breakIdx = CUE.findIndex((c) => c.id === 'break');
    const next = nextCueIndex(CUE, breakIdx, false);
    expect(CUE[next].locked).toBeFalsy();
    expect(CUE[next].id).toBe('end');

    // 해제 상태에서는 바로 다음(잠긴 항목)으로 간다
    expect(CUE[nextCueIndex(CUE, breakIdx, true)].id).toBe('part2-live');
  });

  it('이전 이동도 잠긴 항목을 건너뛴다', () => {
    const awardIdx = CUE.findIndex((c) => c.id === 'award');
    expect(CUE[prevCueIndex(CUE, awardIdx, false)].id).toBe('break');
    expect(CUE[prevCueIndex(CUE, awardIdx, true)].locked).toBe(true);
  });

  it('시상 큐에 다시 진입하면 등수·팀 공개 진행을 처음부터 닫는다', () => {
    let state = createInitialState();
    state = reducer(state, { type: 'award/selectRank', rank: 2 });
    state = reducer(state, { type: 'award/revealSelectedTeam' });
    expect(state.sceneOpts.award).toMatchObject({ selectedRank: 2, selectedTeamRevealed: true });

    const awardIdx = CUE.findIndex((c) => c.id === 'award');
    state = cueActions(CUE[awardIdx], awardIdx).reduce(reducer, state);
    expect(state.sceneOpts.award).toMatchObject({
      step: 'p1',
      selectedRank: null,
      selectedTeamRevealed: false,
      revealedRanks: [],
    });
  });

  /**
   * U127 — 최종 순위 발표는 등수마다 독립된 큐다. 커서 자체가 "지금 몇 위 차례인가"를 말한다.
   */
  describe('시상 등수 큐 (U127)', () => {
    it('시상 다음은 4위 → 3위 → 2위 → 1위 → 우승 세리머니 → 종료다', () => {
      const awardIdx = CUE.findIndex((c) => c.id === 'award');
      expect(CUE.slice(awardIdx, awardIdx + 7).map((item) => [item.id, item.label])).toEqual([
        ['award', '시상 · 순위 집계'],
        ['award-4', '시상 · 4위 발표'],
        ['award-3', '시상 · 3위 발표'],
        ['award-2', '시상 · 2위 발표'],
        ['award-1', '시상 · 1위 발표'],
        ['award-winner', '시상 · 우승 세리머니'],
        ['end', '종료 · 대기 화면'],
      ]);
    });

    it('등수 큐는 전부 2부 잠금 대상이고 시상 진행단계다', () => {
      for (const id of ['award-4', 'award-3', 'award-2', 'award-1', 'award-winner']) {
        const item = CUE.find((c) => c.id === id)!;
        expect(item.locked).toBe(true);
        expect(item.scene).toBe('award');
        expect(item.phase).toBe('award');
      }
    });

    it('등수 큐는 그 등수 자리만 열고 팀은 가려 둔다 (U70 두 박자)', () => {
      for (const rank of [4, 3, 2, 1] as const) {
        const idx = CUE.findIndex((c) => c.id === `award-${rank}`);
        const state = cueActions(CUE[idx], idx).reduce(reducer, createInitialState());
        expect(state.scene).toBe('award');
        expect(state.sceneOpts.award).toMatchObject({
          step: 'reveal',
          selectedRank: rank,
          selectedTeamRevealed: false,
          solo: true,
        });
      }
    });

    it('등수 큐는 이미 공개한 등수 이력을 지우지 않는다', () => {
      let state = createInitialState();
      state = reducer(state, { type: 'award/selectRank', rank: 4 });
      state = reducer(state, { type: 'award/revealSelectedTeam' });
      expect(state.sceneOpts.award.revealedRanks).toEqual([4]);

      const idx = CUE.findIndex((c) => c.id === 'award-3');
      state = cueActions(CUE[idx], idx).reduce(reducer, state);
      // 부분 패치라 이력은 남는다 — 지우면 [다음] 박자가 4위를 다시 제안한다
      expect(state.sceneOpts.award.revealedRanks).toEqual([4]);
      expect(state.sceneOpts.award.selectedRank).toBe(3);
    });

    it('우승 큐는 우승 세리머니 단계로 넘어간다', () => {
      const idx = CUE.findIndex((c) => c.id === 'award-winner');
      const state = cueActions(CUE[idx], idx).reduce(reducer, createInitialState());
      expect(state.sceneOpts.award.step).toBe('winner');
    });

    it('잠금 해제 상태에서 [다음]이 등수 큐를 차례로 밟는다', () => {
      let idx = CUE.findIndex((c) => c.id === 'award');
      for (const id of ['award-4', 'award-3', 'award-2', 'award-1', 'award-winner', 'end']) {
        idx = nextCueIndex(CUE, idx, true);
        expect(CUE[idx].id).toBe(id);
      }
    });

    it('저장된 등수 큐 cueId는 그 자리로 복원된다', () => {
      for (const id of ['award-4', 'award-1', 'award-winner']) {
        expect(CUE[resolveCurrentCueIndex(CUE, id, 0)].id).toBe(id);
      }
      // 옛 저장본의 `award`는 그대로 시상 진입(순위 집계) 자리다 — id가 살아 있다.
      expect(CUE[resolveCurrentCueIndex(CUE, 'award', 0)].id).toBe('award');
    });
  });

  it('큐 실행은 씬 · 진행단계 · 타이머 프리셋을 한 번에 적용한다', () => {
    const stickyLive = CUE.findIndex((c) => c.id === 'live-sticky');
    const s = cueActions(CUE[stickyLive], stickyLive).reduce(reducer, createInitialState());
    expect(s.scene).toBe('live');
    expect(s.phase).toBe('p1');
    expect(s.timer.durationSec).toBe(60);
    expect(s.sceneOpts.liveOverlay.badge).toBe('sticky');
    expect(s.cueIndex).toBe(stickyLive);
  });

  it.each([
    ['curling', '컬링'],
    ['newspaper', '신문지 달리기'],
    ['sticky', '끈끈이 낚시'],
    ['sync', '몸으로 말해요'],
  ] as const)('%s 기본 큐는 게임 대기화면→(매치 영상)→(명단)→중계→승리→점수 순서다', (eventId, name) => {
    const eventCues = CUE.filter((c) => eventCueIds(eventId).includes(c.id));
    expect(eventCues.map((c) => c.id)).toEqual(eventCueIds(eventId));
    expect(eventCues[0].label).toBe(`${name} 대기화면`);
    expect(CUE.find((c) => c.id === `victory-${eventId}`)?.label).toBe(`${name} · 승리 팀`);
  });

  it('선수 선서는 개회식 바로 다음이고 저장본 커서를 밀지 않는다 (U60)', () => {
    const ids = CUE.map((c) => c.id);
    expect(ids.indexOf('oath')).toBe(ids.indexOf('open') + 1);
    expect(CUE[ids.indexOf('oath')]).toMatchObject({
      label: '선수 선서',
      scene: 'standby',
      phase: 'pre',
      opts: { standby: { mode: 'oath' } },
    });

    // 큐를 실행하면 대기 화면이 선서 모드로 넘어간다
    const index = ids.indexOf('oath');
    const state = cueActions(CUE[index], index).reduce(reducer, createInitialState());
    expect(state.scene).toBe('standby');
    expect(state.sceneOpts.standby.mode).toBe('oath');

    // 안정 id가 있으므로 옛 저장본의 숫자 인덱스 복원은 `oath` 추가에 영향받지 않는다
    expect(resolveCurrentCueIndex(CUE, null, 0)).toBe(ids.indexOf('open'));
    expect(resolveCurrentCueIndex(CUE, 'oath', 0)).toBe(index);
  });

  it('신문지 달리기 명단은 이번 조 → 전체 두 항목이다 (U61)', () => {
    const ids = CUE.map((c) => c.id);
    expect(HEAT_ROSTER_EVENTS).toEqual(['newspaper']);
    expect(ids.indexOf('roster-newspaper')).toBe(ids.indexOf('roster-newspaper-heat') + 1);
    expect(CUE[ids.indexOf('roster-newspaper-heat')]).toMatchObject({
      label: '신문지 달리기 · 이번 조 명단',
      scene: 'roster',
      phase: 'p1',
      opts: { roster: { eventId: 'newspaper', scope: 'heat' } },
    });
    expect(CUE[ids.indexOf('roster-newspaper')]).toMatchObject({
      label: '신문지 달리기 · 전체 출전 명단',
      opts: { roster: { eventId: 'newspaper', scope: 'all' } },
    });

    // 조가 없는 종목은 항목도 라벨도 그대로다
    expect(ids).not.toContain('roster-curling-heat');
    expect(ids).not.toContain('roster-sticky-heat');
    expect(CUE.find((c) => c.id === 'roster-curling')?.label).toBe('컬링 · 출전 명단');

    // 전체 명단 큐를 실행하면 조별 잔여 scope가 남지 않는다
    const index = ids.indexOf('roster-newspaper');
    let state = reducer(createInitialState(), {
      type: 'sceneOpts/patch',
      patch: { roster: { scope: 'heat' } },
    });
    state = cueActions(CUE[index], index).reduce(reducer, state);
    expect(state.sceneOpts.roster).toEqual({ eventId: 'newspaper', scope: 'all' });
  });

  it('승리 팀 보드는 종목마다 점수 공개 바로 앞이다 (U71)', () => {
    for (const eventId of P1_EVENT_ORDER) {
      const victory = CUE.findIndex((c) => c.id === `victory-${eventId}`);
      const score = CUE.findIndex((c) => c.id === `score-${eventId}`);
      const live = CUE.findIndex((c) => c.id === `live-${eventId}`);
      expect(victory).toBeGreaterThan(-1);
      expect(score).toBe(victory + 1);
      expect(victory).toBe(live + 1);
    }
  });

  it('승리 큐는 승리 팀을 큐가 정하지 않는다 — 탭에서 고른 값을 그대로 쓴다 (U71 · U110)', () => {
    const index = CUE.findIndex((c) => c.id === 'victory-curling');
    expect(CUE[index]).toMatchObject({ scene: 'game', phase: 'p1', victoryEventId: 'curling' });
    // U110 — 세울 씬(승리 카드)이 폐기돼 `opts` 자체가 없다
    expect(CUE[index].opts).toBeUndefined();

    // 탭이 고른 승리 팀은 큐가 지나가도 그대로 남는다 (소유자가 하나다)
    let state = reducer(createInitialState(), {
      type: 'sceneOpts/patch',
      patch: { game: { winner: 't4' } },
    });
    const before = state.scene;
    state = cueActions(CUE[index], index, 1, {
      versus: null,
      assets: [{ id: 'media:winner_green.webm' }],
      winner: 't4',
    }).reduce(reducer, state);
    expect(state.sceneOpts.game.winner).toBe('t4');
    // 씬은 그대로고 화면의 주인은 오버레이다
    expect(state.scene).toBe(before);
    expect(state.sceneOpts.overlayVideo).toMatchObject({
      active: true,
      assetId: 'media:winner_green.webm',
      holdEndFrame: true,
    });
  });

  it('몸으로 말해요는 출전 명단 큐 자리가 없다 — 대기화면 다음이 곧장 경기 중계다 (U55)', () => {
    expect(CUE.some((c) => c.id === 'roster-sync')).toBe(false);
    const ids = CUE.map((c) => c.id);
    expect(ids.indexOf('live-sync')).toBe(ids.indexOf('game-standby-sync') + 1);
  });

  it('게임 대기 큐 실행과 재진입은 종목·표시 모드를 정확히 다시 적용한다', () => {
    const stickyStandby = CUE.findIndex((c) => c.id === 'game-standby-sticky');
    let state = cueActions(CUE[stickyStandby], stickyStandby).reduce(reducer, createInitialState());
    expect(state.scene).toBe('game');
    expect(state.phase).toBe('p1');
    expect(state.sceneOpts.game).toEqual({ eventId: 'sticky', mode: 'standby', winner: null });
    expect(state.cueIndex).toBe(stickyStandby);

    state = reducer(state, {
      type: 'sceneOpts/patch',
      patch: { game: { eventId: 'sync', mode: 'opening' } },
    });
    state = cueActions(CUE[stickyStandby], stickyStandby).reduce(reducer, state);
    expect(state.sceneOpts.game).toEqual({ eventId: 'sticky', mode: 'standby', winner: null });
  });

  it('다음·이전 이동은 게임 대기화면·매치 영상·명단을 한 단계씩 지난다', () => {
    // 매치 자리가 있는 종목 (컬링)
    const standby = CUE.findIndex((c) => c.id === 'game-standby-curling');
    const match = CUE.findIndex((c) => c.id === 'match-curling');
    const roster = CUE.findIndex((c) => c.id === 'roster-curling');
    expect(nextCueIndex(CUE, standby, false)).toBe(match);
    expect(nextCueIndex(CUE, match, false)).toBe(roster);
    expect(prevCueIndex(CUE, roster, false)).toBe(match);
    expect(prevCueIndex(CUE, match, false)).toBe(standby);

    // 매치 자리가 없는 종목 — 대기화면에서 곧장 명단으로
    const s2 = CUE.findIndex((c) => c.id === 'game-standby-sticky');
    const r2 = CUE.findIndex((c) => c.id === 'roster-sticky');
    expect(nextCueIndex(CUE, s2, false)).toBe(r2);
    expect(prevCueIndex(CUE, r2, false)).toBe(s2);

    // 명단 자리도 없는 종목(몸으로 말해요) — 대기화면에서 곧장 중계로 (U55)
    const s3 = CUE.findIndex((c) => c.id === 'game-standby-sync');
    const l3 = CUE.findIndex((c) => c.id === 'live-sync');
    expect(nextCueIndex(CUE, s3, false)).toBe(l3);
    expect(prevCueIndex(CUE, l3, false)).toBe(s3);
  });

  it('게임 대기 큐는 기존 타이머와 원장을 바꾸지 않는다', () => {
    const initial = {
      ...createInitialState(),
      ledger: [{ id: 'manual-1', ts: 1, teamId: 't1' as const, delta: 30, reason: '보너스', ref: 'manual' }],
    };
    const standby = CUE.findIndex((c) => c.id === 'game-standby-newspaper');
    const afterStandby = cueActions(CUE[standby], standby).reduce(reducer, initial);
    expect(afterStandby.timer).toEqual(initial.timer);
    expect(afterStandby.ledger).toEqual(initial.ledger);
  });

  it('몸으로 말해요는 제시어 큐를 추가하지 않는다', () => {
    expect(CUE.some((c) => c.scene === 'prompt')).toBe(false);

    const i = CUE.findIndex((c) => c.id === 'live-sync');
    const s = cueActions(CUE[i], i).reduce(reducer, createInitialState());
    expect(s.timer.preset).toBe('sync15');
    expect(s.timer.durationSec).toBe(15);
  });
});

describe('영상 큐 스텝', () => {
  const video = (over: Partial<AssetMeta> = {}): AssetMeta => ({
    id: 'a1',
    name: '컬링 설명',
    type: 'video',
    size: 1000,
    mime: 'video/mp4',
    nextScene: 'standby',
    cueAfter: 'open',
    order: 0,
    ...over,
  });

  it('사전미션 다음에 지정한 영상은 사전미션과 개회식 사이에 들어간다 (U22, 2026-09-03 재지시)', () => {
    // media 폴더 밖 id라 강제 배치 대상이 아니다 — 저장된 cueAfter 그대로 꽂히는 일반 경로
    const items = cueWithVideos([
      video({
        id: 'olympic-intro',
        name: '올림픽 인트로',
        cueAfter: 'pre-mission',
        nextScene: 'standby',
      }),
    ]);
    expect(items.slice(0, 3).map((item) => [item.id, item.label, item.scene])).toEqual([
      ['pre-mission', '팀별 사전미션', 'standby'],
      ['video:olympic-intro', '▶ 올림픽 인트로', 'video'],
      ['open', '개회식', 'standby'],
    ]);
  });

  it('U24 — media/manifest.json에 등록된 실제 올림픽 인트로 값으로도 사전미션 → 인트로 → 개회식이 나온다', () => {
    // public/media/manifest.json의 olympic_intro_v001.mp4 항목과 같은 값
    // (name/cueAfter/nextScene=after) — 등록되면 syncMediaManifest가 이 모양의 AssetMeta로 넣는다.
    const items = cueWithVideos([
      video({
        id: 'media:olympic_intro_v001.mp4',
        name: '올림픽 인트로',
        cueAfter: 'pre-mission',
        nextScene: 'standby',
      }),
    ]);
    const introIndex = items.findIndex((item) => item.id === 'video:media:olympic_intro_v001.mp4');
    expect(items.slice(introIndex - 1, introIndex + 2).map((item) => item.id)).toEqual([
      'pre-mission',
      'video:media:olympic_intro_v001.mp4',
      'open',
    ]);
    expect(items[introIndex]).toMatchObject({
      label: '▶ 올림픽 인트로',
      // 아웃트로가 대본으로 고정된 유일한 영상이다 (U87) — 힌트가 실제 연출을 말한다
      hint: '영상 재생 — 끝 5초 오디오 페이드 아웃, 화이트로 덮은 뒤 대기 화면으로 (대본 고정)',
      scene: 'video',
      assetId: 'media:olympic_intro_v001.mp4',
      assetPlayMode: 'full',
      videoNextScene: 'standby',
      locked: false,
    });
  });

  it.each([
    [0, 'open'],
    [1, 'roster-curling'],
    // U55 — legacy 배열의 옛 10번(`roster-sync`)은 더는 없는 큐라, 자리를 비우는 대신
    // 그 종목 대기화면으로 대체한다(정렬을 지키지 않으면 이 뒤 모든 숫자 위치가 밀린다).
    [10, 'game-standby-sync'],
    [13, 'break'],
    // U97 — 옛 `board-s1` 자리는 이제 그 단계의 대기화면이다(제출 보드 **앞** 항목이라는
    // 뜻은 그대로다). 아래 Next 테스트가 이 자리에서 1번 게임을 건너뛰지 않음을 확인한다.
    [15, 'p2-steady-1'],
    [21, 'award'],
    [22, 'end'],
  ] as const)('구 저장본 숫자 %s는 신규 큐가 없는 당시의 %s로 복원한다', (legacyIndex, cueId) => {
    expect(resolveCurrentCueIndex(CUE, null, legacyIndex)).toBe(CUE.findIndex((item) => item.id === cueId));
  });

  it('구 숫자 board-s1 위치는 1단계 대기화면으로 복원되고, Next는 2단계 대기화면이다 (U112)', () => {
    const restored = resolveCurrentCueIndex(CUE, null, 15);
    expect(CUE[restored].id).toBe('p2-steady-1');
    // U112 — 진행 중 제출 보드(submit-s1) 큐가 없어져 다음은 곧장 다음 단계 대기화면이다.
    expect(CUE[nextCueIndex(CUE, restored, true)].id).toBe('p2-steady-2');
  });

  it('구 cueId board-sN · submit-sN 모두 그 단계의 대기화면으로 접힌다 (U97, U112)', () => {
    for (const n of [1, 2, 3] as const) {
      const fromBoard = resolveCurrentCueIndex(CUE, `board-s${n}`, 0);
      expect(CUE[fromBoard].id).toBe(`p2-steady-${n}`);
      // U112 배포 직전까지 실제로 저장될 수 있던 cueId(submit-s<n>)도 같은 대기화면으로 접힌다.
      const fromSubmit = resolveCurrentCueIndex(CUE, `submit-s${n}`, 0);
      expect(CUE[fromSubmit].id).toBe(`p2-steady-${n}`);
    }
    // 3단계 대기화면 다음은 시상이다 (더 이상 게임 진행 큐가 없다)
    const restored = resolveCurrentCueIndex(CUE, 'submit-s3', 0);
    expect(CUE[nextCueIndex(CUE, restored, true)].id).toBe('award');
  });

  it('큐 실행은 숫자 위치와 함께 안정적인 cue ID를 저장한다', () => {
    const openIndex = CUE.findIndex((item) => item.id === 'open');
    const actions = cueActions(CUE[openIndex], openIndex, 12345);
    expect(actions[0]).toEqual({ type: 'cue/index', index: openIndex, cueId: 'open' });
    expect(actions.reduce(reducer, createInitialState()).cueId).toBe('open');
  });

  it('migration은 구 저장본의 cue ID 부재와 새 저장본의 유효 ID를 구분한다', () => {
    const legacy = { ...createInitialState(), cueIndex: 3 } as Record<string, unknown>;
    delete legacy.cueId;
    expect(migrate(legacy).cueId).toBeNull();
    expect(migrate({ ...createInitialState(), cueId: 'live-curling' }).cueId).toBe('live-curling');
  });

  it('안정적인 cue ID는 인트로 영상 추가·삭제·재정렬 뒤에도 같은 논리 큐를 가리킨다', () => {
    const withoutIntro = cueWithVideos([]);
    const withIntro = cueWithVideos([video({ id: 'olympic-intro', cueAfter: 'pre-mission' })]);
    const reordered = cueWithVideos([
      video({ id: 'intro-a', cueAfter: 'pre-mission', order: 2 }),
      video({ id: 'intro-b', cueAfter: 'pre-mission', order: 1 }),
    ]);

    expect(resolveCurrentCueIndex(withoutIntro, 'open', 1)).toBe(withoutIntro.findIndex((item) => item.id === 'open'));
    expect(resolveCurrentCueIndex(withIntro, 'open', 1)).toBe(withIntro.findIndex((item) => item.id === 'open'));
    expect(resolveCurrentCueIndex(reordered, 'video:intro-a', 1)).toBe(
      reordered.findIndex((item) => item.id === 'video:intro-a'),
    );
  });

  it('현재 동적 영상을 삭제하면 직전 큐를 anchor로 삼아 Next가 후속 큐를 건너뛰지 않는다', () => {
    const withIntro = cueWithVideos([video({ id: 'olympic-intro', cueAfter: 'open' })]);
    const withoutIntro = cueWithVideos([]);
    const removedIndex = withIntro.findIndex((item) => item.id === 'video:olympic-intro');
    const resolved = resolveCurrentCueIndex(withoutIntro, 'video:olympic-intro', removedIndex);

    expect(withoutIntro[resolved].id).toBe('open');
    // U60 — 개회식 다음은 선수 선서다
    expect(withoutIntro[nextCueIndex(withoutIntro, resolved, false)].id).toBe('oath');
  });

  it('등록된 종목 소개 영상은 기존 게임 오프닝 없이 `OO게임 소개 영상` 한 항목으로 표시한다', () => {
    const items = cueWithVideos([
      video({
        id: 'intro-curling',
        name: '컬링게임 소개 영상',
        cueAfter: 'open',
        nextScene: 'standby',
      }),
    ]);
    expect(items.some((item) => item.id === 'game-opening-curling')).toBe(false);
    expect(items.filter((item) => item.label.includes('컬링') && /오프닝|인트로|소개 영상/.test(item.label))).toEqual([
      expect.objectContaining({ id: 'video:intro-curling', label: '▶ 컬링게임 소개 영상', assetId: 'intro-curling' }),
    ]);
  });

  it('올림픽 인트로는 저장된 cueAfter와 무관하게 사전미션 다음이다 (U22 강도)', () => {
    const file = 'olympic_intro_v001.mp4';
    // syncMediaManifest가 prev 값을 우선하므로 옛 저장본에는 지난 위치가 남아 있다.
    // 'open'은 재지시 이전의 배포 값이라 특히 살아 있을 가능성이 높다.
    for (const stale of ['open', 'break', 'award'] as const) {
      const items = cueWithVideos([video({ id: `media:${file}`, name: '올림픽 인트로', cueAfter: stale })]);
      const preIndex = items.findIndex((item) => item.id === 'pre-mission');
      expect(items.slice(preIndex, preIndex + 3).map((item) => item.id)).toEqual([
        'pre-mission',
        `video:media:${file}`,
        'open',
      ]);
      // 옛 위치에는 남지 않는다 — 큐에 두 번 끼지 않는다
      expect(items.filter((item) => item.id === `video:media:${file}`)).toHaveLength(1);
    }
  });

  it('올림픽 인트로는 cueAfter가 비어 있어도(큐에서 빠진 저장본) 사전미션 다음에 살아난다', () => {
    const file = 'olympic_intro_v001.mp4';
    const items = cueWithVideos([video({ id: `media:${file}`, name: '올림픽 인트로', cueAfter: null })]);
    const preIndex = items.findIndex((item) => item.id === 'pre-mission');
    expect(items[preIndex + 1].id).toBe(`video:media:${file}`);
    expect(items[preIndex + 2].id).toBe('open');
  });

  it('강제 목록에 없는 영상은 저장된 cueAfter를 그대로 따른다', () => {
    expect(effectiveCueAfter(video({ id: 'media:some_other.mp4', cueAfter: 'break' }))).toBe('break');
    expect(effectiveCueAfter(video({ id: 'media:olympic_intro_v001.mp4', cueAfter: 'break' }))).toBe(
      'pre-mission',
    );
    // media 폴더 밖(사용자가 직접 올린) 에셋은 강제 대상이 아니다
    expect(effectiveCueAfter(video({ id: 'olympic_intro_v001.mp4', cueAfter: 'break' }))).toBe('break');
  });

  it('공식 1부 소개 영상은 저장된 cueAfter와 무관하게 소개→대기→명단→중계→점수 순서다', () => {
    const intros = [
      ['curling', '컬링', 'intro_curling.mp4'],
      ['newspaper', '신문지 달리기', 'intro_newspaper_race.mp4'],
      ['sticky', '끈끈이 낚시', 'intro_sticky_fishing.mp4'],
      ['sync', '몸으로 말해요', 'intro_one_mind.mp4'],
    ] as const;
    const items = cueWithVideos(
      intros.map(([eventId, name, file], order) =>
        video({
          id: `media:${file}`,
          name: `게임 인트로 · ${name}`,
          cueAfter: `roster-${eventId}`,
          nextScene: 'live',
          order,
        }),
      ),
    );

    for (const [eventId, name, file] of intros) {
      const introIndex = items.findIndex((item) => item.id === `video:media:${file}`);
      const expected = [`video:media:${file}`, ...eventCueIds(eventId)];
      expect(items.slice(introIndex, introIndex + expected.length).map((item) => item.id)).toEqual(
        expected,
      );
      expect(items[introIndex]).toMatchObject({
        label: `▶ ${name}게임 소개 영상`,
        videoNextScene: 'standby',
      });
    }
  });

  it.each([
    ['curling', 'intro_curling.mp4'],
    ['newspaper', 'intro_newspaper_race.mp4'],
    ['sticky', 'intro_sticky_fishing.mp4'],
    ['sync', 'intro_one_mind.mp4'],
  ] as const)('삭제된 game-opening-%s 안정 ID는 현재 소개 영상으로 복원한다', (eventId, file) => {
    const items = cueWithVideos([video({ id: `media:${file}`, cueAfter: `roster-${eventId}` })]);
    const resolved = resolveCurrentCueIndex(items, `game-opening-${eventId}`, 0);
    expect(items[resolved].id).toBe(`video:media:${file}`);
    expect(items[nextCueIndex(items, resolved, false)].id).toBe(`game-standby-${eventId}`);
  });

  it('공식 소개 영상이 없으면 삭제된 game-opening ID를 대기화면 직전 anchor로 복원한다', () => {
    const resolved = resolveCurrentCueIndex(CUE, 'game-opening-sticky', 0);
    expect(CUE[resolved].id).toBe('score-newspaper');
    expect(CUE[nextCueIndex(CUE, resolved, false)].id).toBe('game-standby-sticky');
  });

  it('공식 소개 영상은 재생 시작 frame을 유지하고 standby release 시점에 pre-mission 복귀를 닫는다', () => {
    const items = cueWithVideos([video({ id: 'media:intro_curling.mp4', cueAfter: 'roster-curling' })]);
    const introIndex = items.findIndex((item) => item.id === 'video:media:intro_curling.mp4');
    let state = createInitialState();
    state.sceneOpts.standby.mode = 'pre-mission';
    state = cueActions(items[introIndex], introIndex, 123).reduce(reducer, state);
    expect(state.sceneOpts.standby.mode).toBe('pre-mission');
    const token = state.sceneOpts.video.phaseToken;
    state = reducer(state, { type: 'video/covered', token });
    state = reducer(state, { type: 'video/tail', token });
    expect(state.sceneOpts.standby.mode).toBe('main');
  });

  it('공식 2부 영상은 각 게임 종료 직후 Part 2→3→4 순서로 들어가고 Part 4가 범행동기를 리빌한다 (U112)', () => {
    const parts = [1, 2, 3, 4].map((part) =>
      video({
        id: `media:260831_pt${part}_v001.mp4`,
        name: `stale part ${part}`,
        cueAfter: 'award',
      }),
    );
    const items = cueWithVideos(parts);
    const start = items.findIndex((item) => item.id === 'breaking');
    // U112 — 진행 중 제출 보드(submit-s<n>) 큐가 없어졌다. 게임 종료 영상은 그 단계 대기화면
    // 바로 다음(=다음 단계 대기화면 직전, 마지막은 시상 직전)에 붙는다.
    expect(items.slice(start, start + 8).map((item) => [item.id, item.label])).toEqual([
      ['breaking', '▶ Part 1 · 글리치 → 분위기반전 영상'],
      ['p2-steady-1', '2부 1단계 · 대기화면'],
      ['video:media:260831_pt2_v001.mp4', '▶ Part 2 · 1번 게임 종료 영상'],
      ['p2-steady-2', '2부 2단계 · 대기화면'],
      ['video:media:260831_pt3_v001.mp4', '▶ Part 3 · 2번 게임 종료 영상'],
      ['p2-steady-3', '2부 3단계 · 대기화면'],
      ['video:media:260831_pt4_v001.mp4', '▶ Part 4 · 범인·범행동기·사건 종결 리빌'],
      ['award', '시상 · 순위 집계'],
    ]);
    expect(items.some((item) => item.id.startsWith('board-'))).toBe(false);
    expect(items.some((item) => item.id.startsWith('submit-s'))).toBe(false);

    const steady1 = items.findIndex((item) => item.id === 'p2-steady-1');
    const part2 = items.findIndex((item) => item.id === 'video:media:260831_pt2_v001.mp4');
    const steady2 = items.findIndex((item) => item.id === 'p2-steady-2');
    const part3 = items.findIndex((item) => item.id === 'video:media:260831_pt3_v001.mp4');
    expect(nextCueIndex(items, steady1, true)).toBe(part2);
    expect(nextCueIndex(items, part2, true)).toBe(steady2);
    expect(prevCueIndex(items, steady2, true)).toBe(part2);

    // 옛 board-s2 · submit-s2(U112 직전까지의 cueId) 모두 2단계 대기화면으로 접히고,
    // 거기서 Next는 곧장 그 단계 종료 영상이다.
    for (const cueId of ['board-s2', 'submit-s2']) {
      const restored = resolveCurrentCueIndex(items, cueId, 0);
      expect(items[restored].id).toBe('p2-steady-2');
      expect(items[nextCueIndex(items, restored, true)].id).toBe(items[part3].id);
    }
  });

  it('cueAfter를 지정한 영상만 그 항목 바로 다음에 끼어든다', () => {
    const items = cueWithVideos([video()]);
    const openIdx = items.findIndex((c) => c.id === 'open');
    expect(items[openIdx + 1].id).toBe('video:a1');
    expect(items[openIdx + 1].scene).toBe('video');
    expect(items.length).toBe(CUE.length + 1);
  });

  it('cueAfter가 없으면 큐에 넣지 않는다 (에셋 탭에서 직접 재생)', () => {
    expect(cueWithVideos([video({ cueAfter: null })])).toHaveLength(CUE.length);
    expect(cueWithVideos([])).toHaveLength(CUE.length);
  });

  it('영상 스텝 실행은 video/playFull 하나만 내고 scene/set은 내지 않는다 (§11 M1)', () => {
    const items = cueWithVideos([video({ nextScene: 'score' })]);
    const i = items.findIndex((c) => c.id === 'video:a1');
    const actions = cueActions(items[i], i, 12345);

    expect(actions).toEqual([
      { type: 'cue/index', index: i, cueId: 'video:a1' },
      { type: 'video/playFull', assetId: 'a1', nextScene: 'score', now: 12345 },
    ]);
    expect(actions.some((a) => a.type === 'scene/set')).toBe(false);
    expect(actions.some((a) => a.type === 'video/restart')).toBe(false);

    const s = actions.reduce(reducer, createInitialState());
    // 검정이 화면을 완전히 덮은 뒤(covered)에만 씬이 'video'로 바뀐다 — playFull 직후엔 그대로.
    expect(s.scene).toBe('standby');
    expect(s.sceneOpts.video.assetId).toBe('a1');
    expect(s.sceneOpts.video.nextScene).toBe('score');
    expect(s.sceneOpts.video.phase).toBe('covering');
    expect(s.sceneOpts.video.paused).toBe(false);
    expect(s.sceneOpts.video.restartToken).toBe(12345);
  });

  it('nextScene을 지정하지 않은 영상 큐는 "직전 씬으로 복귀" 힌트 + playFull(nextScene:null)로 나간다', () => {
    const items = cueWithVideos([video({ nextScene: null })]);
    const i = items.findIndex((c) => c.id === 'video:a1');
    expect(items[i].videoNextScene).toBeNull();
    expect(items[i].hint).toContain('직전 씬으로 복귀');

    const actions = cueActions(items[i], i, 999);
    expect(actions).toContainEqual({ type: 'video/playFull', assetId: 'a1', nextScene: null, now: 999 });
  });

  it('2부 씬으로 이어지는 영상 스텝은 잠금 대상이라 잠금 중에는 건너뛴다', () => {
    const items = cueWithVideos([video({ cueAfter: 'break', nextScene: 'suspects' })]);
    const breakIdx = items.findIndex((c) => c.id === 'break');
    expect(items[breakIdx + 1].locked).toBe(true);
    expect(items[nextCueIndex(items, breakIdx, false)].id).toBe('end');
    expect(items[nextCueIndex(items, breakIdx, true)].id).toBe('video:a1');
  });

  it('전환 영상 큐는 현재 씬을 유지한 채 overlay 재생을 시작한다', () => {
    const items = cueWithVideos([
      video({ playMode: 'transition', switchAtSec: 0.7, nextScene: 'score' }),
    ]);
    const i = items.findIndex((c) => c.id === 'video:a1');
    const s = cueActions(items[i], i, 12345).reduce(reducer, createInitialState());

    expect(items[i].scene).toBe('standby');
    expect(items[i].hint).toContain('전환');
    expect(s.scene).toBe('standby');
    expect(s.sceneOpts.transitionVideo).toMatchObject({
      active: true,
      assetId: 'a1',
      nextScene: 'score',
      switchAtSec: 0.7,
      restartToken: 12345,
    });
  });

  it('매치 오버레이 큐는 bake된 도입 스팅어를 직접 시작해 기본 전환을 중복시키지 않는다', () => {
    const items = cueWithVideos([
      video({ playMode: 'overlay', holdEndFrame: true, nextScene: null }),
    ]);
    const i = items.findIndex((c) => c.id === 'video:a1');
    const actions = cueActions(items[i], i, 12345);

    expect(actions).toEqual([
      { type: 'cue/index', index: i, cueId: 'video:a1' },
      { type: 'overlay/play', assetId: 'a1', holdEndFrame: true, now: 12345 },
    ]);
    expect(actions.some((action) => action.type === 'transition/play')).toBe(false);
    expect(actions.some((action) => action.type === 'scene/set')).toBe(false);
  });
});

/**
 * `SCENE_AFTER_LABEL`은 exhaustive `Record<SceneId, string>`이어야 하고,
 * 대표 목적지의 실제 안내도 fallback인 "대기 화면으로"로 새지 않아야 한다.
 */
describe('영상 큐 힌트 — 새 씬 라벨', () => {
  it('재생 후 현장 사진으로 넘어가는 영상은 그 이름을 그대로 알린다', () => {
    const items = cueWithVideos([
      {
        id: 'a1',
        name: '사진 앞 영상',
        type: 'video',
        size: 1,
        mime: 'video/mp4',
        cueAfter: 'open',
        nextScene: 'photos',
        order: 0,
      } as AssetMeta,
    ]);
    const i = items.findIndex((c) => c.id === 'video:a1');
    expect(i).toBeGreaterThan(-1);
    expect(items[i].hint).toContain('현장 사진으로');
    expect(items[i].hint).not.toContain('대기 화면으로');
  });

  it('재생 후 게임 화면으로 넘어가는 영상도 대기 화면으로 잘못 표시하지 않는다', () => {
    const items = cueWithVideos([
      {
        id: 'a1',
        name: '게임 앞 영상',
        type: 'video',
        size: 1,
        mime: 'video/mp4',
        cueAfter: 'open',
        nextScene: 'game',
        order: 0,
      } as AssetMeta,
    ]);
    const i = items.findIndex((c) => c.id === 'video:a1');
    expect(i).toBeGreaterThan(-1);
    expect(items[i].hint).toContain('게임 화면으로');
    expect(items[i].hint).not.toContain('대기 화면으로');
  });
});

describe('속보 연결 영상 기본값', () => {
  const meta = (
    id: string,
    over: { type?: string; playMode?: 'full' | 'transition' | 'overlay' } = {},
  ) => ({ id, type: 'video', ...over });

  const CHAIN = 'media:260831_pt1_v001.mp4';

  it('2부 Part 1(속보 체인 전용 영상)이 있으면 무조건 그것을 고른다', () => {
    expect(
      defaultBreakingVideoId([
        meta('media:bridge_stinger_short.webm', { playMode: 'transition' }),
        meta('media:olympic_intro_v001.mp4', { playMode: 'full' }),
        meta(CHAIN, { playMode: 'full' }),
      ]),
    ).toBe(CHAIN);
  });

  it('대본이 자리를 정한 영상은 폴백 후보가 아니다 — 개회식 인트로가 속보로 나가지 않는다', () => {
    expect(
      defaultBreakingVideoId([
        meta('media:olympic_intro_v001.mp4', { playMode: 'full' }),
        meta('media:intro_curling.mp4', { playMode: 'full' }),
        meta('media:260831_pt4_v001.mp4', { playMode: 'full' }),
        meta('media:free_clip.mp4', { playMode: 'full' }),
      ]),
    ).toBe('media:free_clip.mp4');
  });

  it('전환 오버레이(0.2초 스팅어)와 매치 오버레이는 후보가 아니다', () => {
    expect(
      defaultBreakingVideoId([
        meta('media:bridge_stinger_short.webm', { playMode: 'transition' }),
        meta('media:bridge_stinger.webm', { playMode: 'transition' }),
        meta('media:match.webm', { playMode: 'overlay' }),
      ]),
    ).toBeNull();
  });

  it('playMode가 없으면 full로 본다 (구 저장본)', () => {
    expect(defaultBreakingVideoId([meta('media:old.mp4')])).toBe('media:old.mp4');
  });

  it('이미지·media 폴더 밖 항목은 후보가 아니다', () => {
    expect(
      defaultBreakingVideoId([
        meta('media:cover.jpg', { type: 'image' }),
        meta('user-upload-1', { playMode: 'full' }),
      ]),
    ).toBeNull();
    expect(defaultBreakingVideoId([])).toBeNull();
  });

  it('대본 고정 판정은 세 세트(강제 cueAfter · 1부 소개 · 2부 파트)를 모두 덮는다', () => {
    expect(isScriptedCueAsset('media:olympic_intro_v001.mp4')).toBe(true);
    expect(isScriptedCueAsset('media:intro_one_mind.mp4')).toBe(true);
    expect(isScriptedCueAsset(CHAIN)).toBe(true);
    expect(isScriptedCueAsset('media:free_clip.mp4')).toBe(false);
    expect(isScriptedCueAsset('user-upload-1')).toBe(false);
  });
});

/**
 * 에셋 탭 배선 잠금 — 대본 고정 영상은 `cueAfter` 셀렉트가 잠기고 요약도 실제 배치값을 보여 준다.
 * (DOM 없는 vitest라 소스 단언으로 고정한다 — `video-hold.test.ts`와 같은 방식.)
 */
describe('에셋 탭 배선 잠금 — 대본 고정 큐 위치', () => {
  const assets = readFileSync(new URL('./control/tab-assets.ts', import.meta.url), 'utf8');

  it('요약과 셀렉트가 저장값 대신 effectiveCueAfter를 쓴다', () => {
    expect(assets).toContain('const cueAfter = effectiveCueAfter(a)');
    expect(assets).toContain('const scriptedCue = isScriptedCueAsset(a.id)');
    expect(assets).not.toContain("큐 ${a.cueAfter ? '등록' : '없음'}");
    expect(assets).not.toContain('selected: a.cueAfter ? undefined');
    expect(assets).not.toContain('a.cueAfter === c.id');
  });

  it('대본 고정 영상은 셀렉트를 잠그고 "대본 고정"으로 표기한다', () => {
    expect(assets).toContain("scriptedCue ? '대본 고정'");
    expect(assets).toContain("disabled: 'disabled'");
    expect(assets).toContain('진행 대본이 위치를 고정한 영상입니다');
  });
});

describe('manifest와 대본 고정 배치의 정합', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../public/media/manifest.json', import.meta.url), 'utf8'),
  ) as Array<{ file: string; cueAfter: string | null }>;
  if (!manifest.length) manifest.push({ file: 'olympic_intro_v001.mp4', cueAfter: 'pre-mission' });

  /**
   * `syncMediaManifest`는 재적재 때 기존 `cueAfter`를 manifest보다 우선한다. 그래서 manifest가
   * 강제 위치와 다른 값을 들고 있으면, 그 값이 그대로 저장본에 박혀 다음 배포 때까지 남는다.
   * 화면상으로는 `effectiveCueAfter`가 이겨서 티가 안 나지만, 에셋 탭 셀렉트와 저장값이
   * 어긋난 채로 굳는다. 두 곳을 같은 값으로 묶어 둔다.
   */
  it('강제 배치 파일은 manifest의 cueAfter도 같은 값이다', () => {
    for (const item of manifest) {
      if (!isScriptedCueAsset(`media:${item.file}`)) continue;
      const forced = effectiveCueAfter({
        id: `media:${item.file}`,
        name: item.file,
        type: 'video',
        size: 0,
        mime: 'video/mp4',
        nextScene: 'standby',
        cueAfter: item.cueAfter,
        order: 0,
      } as AssetMeta);
      expect([item.file, item.cueAfter]).toEqual([item.file, forced]);
    }
  });

  it('올림픽 인트로는 manifest에서도 사전미션 다음이다', () => {
    const intro = manifest.find((item) => item.file === 'olympic_intro_v001.mp4');
    expect(intro?.cueAfter).toBe('pre-mission');
  });
});

/**
 * U36 — 출전 명단 **직전**에 매치 영상 자리를 둔다. 재생할 파일은 큐에 못 박을 수 없고
 * (실행 시점의 대결 조합이 정한다) 조합이 없으면 큐가 그 자리에 머물러야 한다.
 */
describe('매치 영상 큐 (U36)', () => {
  const matchAssets = (): AssetMeta[] =>
    ['match_blue_red.webm', 'match_green_yellow.webm'].map((file) => ({
      id: `media:${file}`,
      name: file,
      type: 'video',
      size: 1,
      mime: 'video/webm',
      playMode: 'overlay',
      holdEndFrame: true,
      cueAfter: null,
    })) as AssetMeta[];

  it.each(MATCH_EVENTS)('%s 매치 영상은 게임 대기화면과 출전 명단 사이에 온다', (eventId) => {
    const ids = CUE.map((item) => item.id);
    const standby = ids.indexOf(`game-standby-${eventId}`);
    const match = ids.indexOf(`match-${eventId}`);
    const roster = ids.indexOf(`roster-${eventId}`);
    expect(match).toBe(standby + 1);
    expect(roster).toBe(match + 1);
    expect(CUE[match]).toMatchObject({ matchEventId: eventId, phase: 'p1' });
    expect(CUE[match].assetId).toBeUndefined();
  });

  /**
   * U52 — 몸으로 말해요는 팀이 돌아가며 진행하고 점수만 발표한다. 두 팀이 맞붙는 대결
   * 소개가 성립하지 않으므로 큐 자리 자체를 만들지 않는다(런처 타일로는 여전히 재생 가능).
   */
  /**
   * U52(21:38) — 토너먼트로 맞붙는 종목은 컬링뿐이다. 신문지·끈끈이는 두 팀씩 나오지만
   * 기록·점수로 순위를 정하고, 몸으로 말해요는 팀별 순환이라 대결 소개가 성립하지 않는다.
   */
  it('매치 영상 자리는 컬링에만 둔다', () => {
    expect(MATCH_EVENTS).toEqual(['curling']);
    expect(CUE.filter((item) => item.matchEventId)).toHaveLength(1);
    const ids = CUE.map((item) => item.id);
    for (const eventId of ['newspaper', 'sticky', 'sync'] as const) {
      expect(CUE.some((item) => item.id === `match-${eventId}`)).toBe(false);
    }
    for (const eventId of ['newspaper', 'sticky'] as const) {
      // 대기화면 바로 다음이 명단이다 (신문지 달리기는 조별 명단이 한 칸 먼저 온다 — U61)
      const rosterStart = HEAT_ROSTER_EVENTS.includes(eventId)
        ? ids.indexOf(`roster-${eventId}-heat`)
        : ids.indexOf(`roster-${eventId}`);
      expect(rosterStart).toBe(ids.indexOf(`game-standby-${eventId}`) + 1);
    }
    // 몸으로 말해요는 명단 자리조차 없다 — 대기화면 바로 다음이 중계다 (U55)
    expect(ids.indexOf('live-sync')).toBe(ids.indexOf('game-standby-sync') + 1);
  });

  it('조합이 정해지면 그 조합의 영상을 오버레이로 얹고 보더를 영상 순서로 맞춘다', () => {
    const item = CUE.find((cue) => cue.id === 'match-curling')!;
    const actions = cueActions(item, 4, 99, { versus: ['t3', 't2'], assets: matchAssets() });
    expect(actions).toEqual([
      { type: 'cue/index', index: 4, cueId: 'match-curling' },
      { type: 'phase/set', phase: 'p1' },
      { type: 'overlay/play', assetId: 'media:match_blue_red.webm', holdEndFrame: true, now: 99 },
      { type: 'sceneOpts/patch', patch: { liveOverlay: { versus: ['t2', 't3'] } } },
    ]);
    // 씬은 건드리지 않는다 — 지금 화면(그 종목 대기 이미지) 위에 그대로 얹는다
    expect(actions.some((a) => a.type === 'scene/set')).toBe(false);
  });

  it('조합이 없거나 그 조합 영상이 없으면 실행을 막는다', () => {
    const item = CUE.find((cue) => cue.id === 'match-curling')!;
    expect(matchCueBlock(item, { versus: null, assets: matchAssets() })).toMatch(/대결 조합/);
    expect(matchCueBlock(item, { versus: ['t1', 't2'], assets: matchAssets() })).toMatch(/등록/);
    expect(matchCueBlock(item, { versus: ['t3', 't2'], assets: matchAssets() })).toBeNull();
    // 매치 항목이 아닌 큐는 이 판정에 걸리지 않는다
    expect(matchCueBlock(CUE.find((cue) => cue.id === 'roster-curling')!, undefined)).toBeNull();
  });

  it('막힌 매치 큐는 씬도 인덱스도 바꾸지 않는다', () => {
    const item = CUE.find((cue) => cue.id === 'match-curling')!;
    const actions = cueActions(item, 4, 99, { versus: null, assets: [] });
    expect(actions.some((a) => a.type === 'overlay/play' || a.type === 'scene/set')).toBe(false);
  });

  it('매치 영상은 cueAfter가 붙어 있어도 큐에 두 번 들어가지 않는다', () => {
    const assets = matchAssets().map((asset) => ({ ...asset, cueAfter: 'open' }));
    const items = cueWithVideos(assets);
    expect(items.filter((item) => item.id.startsWith('video:media:match_'))).toHaveLength(0);
    expect(items.filter((item) => item.id.startsWith('match-'))).toHaveLength(MATCH_EVENTS.length);
  });

  it('매치 항목이 늘어도 저장된 cueId·legacy 인덱스 해석이 깨지지 않는다', () => {
    const items = cueWithVideos([]);
    const rosterIndex = items.findIndex((item) => item.id === 'roster-curling');
    expect(resolveCurrentCueIndex(items, 'roster-curling', 0)).toBe(rosterIndex);
    expect(resolveCurrentCueIndex(items, 'match-curling', 0)).toBe(rosterIndex - 1);
    // cueId가 없는 옛 저장본: legacy 배열의 1번(`roster-curling`)이 그대로 잡혀야 한다
    expect(items[resolveCurrentCueIndex(items, null, 1)].id).toBe('roster-curling');
  });
});

/**
 * 체크포인트 리뷰 수정 — 매치 큐가 방향키 진행을 막던 문제와, 엉뚱한 화면 위 오버레이.
 */
describe('매치 큐 진행·화면 가드 (리뷰 수정)', () => {
  const runtimeOn = (eventId: string, versus: ['t2', 't3'] | null = ['t2', 't3']) => ({
    versus,
    assets: [{ id: 'media:match_blue_red.webm' }],
    scene: 'game' as const,
    gameEventId: eventId as never,
  });

  it('큐 순서대로 왔으면 화면을 그대로 두고 오버레이만 얹는다', () => {
    const item = CUE.find((cue) => cue.id === 'match-curling')!;
    expect(matchCueOnRightScene(item, runtimeOn('curling'))).toBe(true);
    const actions = cueActions(item, 4, 9, runtimeOn('curling'));
    expect(actions.some((a) => a.type === 'scene/set')).toBe(false);
    expect(actions.some((a) => a.type === 'overlay/play')).toBe(true);
  });

  it('다른 화면에서 직접 누르면 먼저 그 종목 대기화면으로 옮기고 영상은 다음 박자에 든다', () => {
    const item = CUE.find((cue) => cue.id === 'match-curling')!;
    const far = { ...runtimeOn('curling'), scene: 'score' as const };
    expect(matchCueOnRightScene(item, far)).toBe(false);
    const actions = cueActions(item, 4, 9, far);
    expect(actions).toEqual([
      { type: 'cue/index', index: 4, cueId: 'match-curling' },
      { type: 'phase/set', phase: 'p1' },
      {
        type: 'scene/set',
        scene: 'game',
        opts: { game: { eventId: 'curling', mode: 'standby' }, standby: { mode: 'main' } },
      },
    ]);
    // 스팅어가 도는 위에 오버레이를 겹치지 않는다
    expect(actions.some((a) => a.type === 'overlay/play')).toBe(false);
  });

  it('같은 game 씬이어도 다른 종목이면 옮긴다', () => {
    const item = CUE.find((cue) => cue.id === 'match-curling')!;
    expect(matchCueOnRightScene(item, runtimeOn('sticky'))).toBe(false);
  });

  it('화면을 옮겨야 하는 상태는 "막힘"이 아니다 — 이 항목이 할 일이 남아 있다', () => {
    const item = CUE.find((cue) => cue.id === 'match-curling')!;
    const far = { ...runtimeOn('curling', null), scene: 'score' as const };
    expect(matchCueBlock(item, far)).toBeNull();
    // 화면이 맞은 뒤에야 조합 없음이 막힘으로 보고된다
    expect(matchCueBlock(item, runtimeOn('curling', null))).toMatch(/대결 조합/);
  });

  it('런타임을 안 주면 예전처럼 화면 판정을 하지 않는다', () => {
    const item = CUE.find((cue) => cue.id === 'match-curling')!;
    expect(matchCueOnRightScene(item, undefined)).toBe(true);
    expect(matchCueOnRightScene(CUE.find((cue) => cue.id === 'roster-curling')!, undefined)).toBe(true);
  });
});

describe('큐 진행이 매치 항목에서 막히지 않는다 (리뷰 수정)', () => {
  // `goCue`는 DOM(toast)을 건드려 node 환경에서 호출할 수 없다 — 배선만 고정한다.
  const cuesheet = readFileSync(new URL('./control/cuesheet.ts', import.meta.url), 'utf8');

  it('앞으로 가는 조작만 건너뛰기를 켠다', () => {
    expect(cuesheet).toContain(
      'export function goCue(ctx: Ctx, index: number, advanceOnBlock = false, sequential = false)',
    );
    expect(cuesheet).toMatch(/goNext[\s\S]{0,260}nextCueIndex\([^)]*\), true, true\)/);
    // 뒤로 가기는 건너뛰기를 켜지 않는다 (`advanceOnBlock: false`) —
    // U42로 네 번째 인자(순차 진행)가 붙었지만 세 번째는 그대로 false다.
    expect(cuesheet).toMatch(/goPrev[\s\S]{0,260}goCue\(ctx, prevCueIndex\([^)]*\), false, true\);/);
  });

  /**
   * U42 — 큐 경계 전환은 **대본을 따라 갈 때만** 적용된다. 항목을 직접 누르거나 런처에서
   * 점프하는 것은 대본을 벗어난 조작이고, 그때 대본상의 전환이 걸리면 예상하지 못한 연출이
   * 방송에 나간다. `goNext`·`goPrev`만 네 번째 인자를 참으로 준다.
   */
  it('큐 경계 전환은 순차 진행에서만 실린다', () => {
    expect(cuesheet).toContain('const boundaryMode = sequential ? cueTransitionOf(');
    expect(cuesheet).toContain('cueActions(item, i, Date.now(), runtime, boundaryMode)');
    // 항목 직접 클릭은 순차가 아니다
    expect(cuesheet).toMatch(/click: \(\) => goCue\(ctx, i\)/);
  });

  it('막힌 항목을 건너뛸 때 알리고, 끝이면 그 자리에서 멈춘다', () => {
    expect(cuesheet).toContain('매치 영상 건너뜀');
    expect(cuesheet).toContain('if (next !== i)');
  });

  /**
   * U125 — 넘기는 씬은 **지금 보이는 씬이 아니라 향하고 있는 씬**이다.
   *
   * 전환은 `switchAtSec`이 지난 뒤에 씬을 갈아 끼우므로 그 0.3~1초 동안 `state.scene`은
   * 화면이 이미 떠난 씬이다. 그 값을 넘기면 매치 큐가 "엉뚱한 씬"으로 판정돼 영상 없이
   * 커서만 물러나고, 다음 [다음 →]이 매치 영상을 한 번 더 재생한다(2026-09-05 신고).
   */
  it('큐 실행에 도착 씬·종목을 함께 넘긴다 (U125)', () => {
    expect(cuesheet).toContain('scene: pendingScene(ctx.state)');
    expect(cuesheet).toContain("import { pendingScene } from '../pending-scene'");
    expect(cuesheet).toContain('gameEventId: ctx.state.sceneOpts.game.eventId');
  });
});


/**
 * [Medium 리뷰] 매치 큐를 엉뚱한 씬에서 누르면 영상이 통째로 건너뛰어지던 자리.
 *
 * 그 경로는 씬만 옮기고 영상은 다음 [다음]에 맡긴다(스팅어 위에 오버레이를 겹치지 않기 위해서다).
 * 그런데 커서를 **그 항목 자신**에 찍어 두는 바람에 `nextCueIndex`가 `i+1`을 돌려줬고,
 * 다음 [다음]이 매치 영상을 건너뛰고 그 뒤 항목으로 갔다. 커서를 한 칸 앞에 둬야 다시 밟는다.
 */
describe('매치 큐 씬 이동만 한 경우의 커서 (Medium 리뷰)', () => {
  const item = { id: 'match-curling', label: '컬링 대결', hint: '', scene: 'game' as const, matchEventId: 'curling' as const };
  const runtime = {
    versus: ['t1', 't2'] as [import('./types').TeamId, import('./types').TeamId],
    assets: [],
    // 지금 화면이 스코어보드 — 매치 영상을 그 위에 얹으면 안 되는 자리
    scene: 'score' as const,
    gameEventId: 'curling' as const,
    prevCueId: 'game-standby-curling',
  };

  it('씬만 옮겼으면 커서를 그 항목 **앞**에 둔다 — 다음 진행이 매치 항목을 다시 밟는다', () => {
    const out = cueActions(item, 7, 1000, runtime);
    const cursor = out.find((a) => a.type === 'cue/index');
    expect(cursor).toMatchObject({ type: 'cue/index', index: 6, cueId: 'game-standby-curling' });
    // 영상은 아직 얹지 않는다
    expect(out.some((a) => a.type === 'overlay/play')).toBe(false);
    expect(out.some((a) => a.type === 'scene/set')).toBe(true);
  });

  it('제 화면에서 눌렀으면 커서는 그 항목 자신이다 (기존 동작)', () => {
    const out = cueActions(item, 7, 1000, { ...runtime, scene: 'game' as const });
    expect(out[0]).toMatchObject({ type: 'cue/index', index: 7, cueId: 'match-curling' });
  });

  it('첫 항목이면 앞으로 물러설 자리가 없으므로 그대로 둔다', () => {
    const out = cueActions(item, 0, 1000, runtime);
    expect(out[0]).toMatchObject({ type: 'cue/index', index: 0 });
  });
});

/**
 * U92 (2026-09-04 사용자 지시) — '2부 전환 · 라이브 송출' 큐가 실행되는 순간 씬런처의
 * 전역 전환 방식을 블랙으로 고정한다. 일회성 스위치다: 그 이후 사용자가 런처에서 다시
 * 바꿀 수 있어야 하므로 다른 큐가 이 패치를 재적용해서는 안 된다.
 */
describe('2부 전환 · 라이브 송출 큐가 전역 전환 방식을 블랙으로 바꾼다 (U92)', () => {
  const item = CUE.find((c) => c.id === 'part2-live')!;
  const index = CUE.findIndex((c) => c.id === 'part2-live');

  it('settings/patch(sceneTransitionMode: black)이 정확히 한 번, scene/set보다 먼저 실린다', () => {
    const out = cueActions(item, index, 1000);
    const patchIdx = out.findIndex(
      (a) => a.type === 'settings/patch' && (a as { patch?: { sceneTransitionMode?: string } }).patch?.sceneTransitionMode === 'black',
    );
    const sceneIdx = out.findIndex((a) => a.type === 'scene/set');
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(sceneIdx).toBeGreaterThanOrEqual(0);
    expect(patchIdx).toBeLessThan(sceneIdx);
    expect(out.filter((a) => a.type === 'settings/patch').length).toBe(1);
  });

  it('다른 어떤 큐 항목도 이 패치를 싣지 않는다 — 일회성 스위치이지 락이 아니다', () => {
    for (const [i, other] of CUE.entries()) {
      if (other.id === 'part2-live') continue;
      const out = cueActions(other, i, 1000);
      expect(out.some((a) => a.type === 'settings/patch')).toBe(false);
    }
  });

  it('힌트가 전환 방식 변경과 이후 재조작 가능함을 안내한다', () => {
    expect(item.hint).toContain('블랙');
    expect(item.hint).toContain('런처');
  });
});

/**
 * U100 (2026-09-05 04:05 사용자 지시) — "`01_FINALS/game_winner` 여기 영상 4개 넣어놨어.
 * 주의점은 알파 포함된 영상이라 **별도 트랜지션 없이 바로 오버레이로 올라와야 해**.
 * 엔드는 트랜지션 적용하는 거 그대로 두고."
 *
 * 지키는 계약:
 *  1) 승리 팀이 정해져 있고 그 팀 영상이 있으면 `overlay/play` **하나만** 낸다 —
 *     `scene/set`도 `transition/*`도 내지 않으므로 `scene-routing`의 전환 래핑을
 *     구조적으로 타지 않는다(전환을 "끄는" 코드가 아니라, 감쌀 액션이 없다는 것이 보장이다).
 *  2) 끝 처리는 매치 오버레이와 같다 — `holdEndFrame: true`. 다음 큐의 `scene/set`이
 *     오버레이를 걷으며 그때의 전환 규칙을 그대로 탄다(U100에서 바뀐 것이 없다).
 *  3) 승리 팀이 없거나 영상이 없으면 **승리 보드 카드**가 나간다 (검정 금지 계약).
 */
describe('승리 영상 알파 오버레이 (U100)', () => {
  const item = CUE.find((c) => c.id === 'victory-curling')!;
  const index = CUE.findIndex((c) => c.id === 'victory-curling');
  const winnerAssets = [{ id: 'media:winner_red.webm' }, { id: 'media:winner_blue.webm' }];
  const runtime = (winner: 't1' | 't2' | 't3' | 't4' | 't5' | null, assets = winnerAssets) => ({
    versus: null,
    assets,
    scene: 'live' as const,
    gameEventId: 'curling' as const,
    winner,
  });

  it('승리 큐는 종목만 들고 있고 세울 씬이 없다 (U110 — 카드 폐기)', () => {
    expect(item.victoryEventId).toBe('curling');
    // 카드가 사라져 `opts`도 사라졌다. 되살리면 `mode: 'victory'`는 타입 자체가 없다.
    expect(item.opts).toBeUndefined();
    // 종목마다 하나씩, 그 자리에만 있다
    expect(CUE.filter((c) => c.victoryEventId)).toHaveLength(P1_EVENT_ORDER.length);
  });

  it('승리 팀 영상이 있으면 오버레이 하나만 낸다 — 전환 액션이 아예 없다', () => {
    const actions = cueActions(item, index, 777, runtime('t3'));
    expect(actions).toEqual([
      { type: 'cue/index', index, cueId: 'victory-curling' },
      { type: 'phase/set', phase: 'p1' },
      { type: 'overlay/play', assetId: 'media:winner_red.webm', holdEndFrame: true, now: 777 },
    ]);
    // 계약: 감쌀 `scene/set`이 없으므로 `routeSceneActionsThroughDefaultTransition`이 지나간다
    expect(actions.some((a) => a.type === 'scene/set')).toBe(false);
    expect(actions.some((a) => a.type.startsWith('transition/'))).toBe(false);
    // 아래 화면도 건드리지 않는다 — 중계든 스코어보드든 그대로 남는다
    expect(actions.some((a) => a.type === 'sceneOpts/patch')).toBe(false);
  });

  it('슬롯마다 자기 색 영상을 얹는다', () => {
    const red = cueActions(item, index, 1, runtime('t3')).find((a) => a.type === 'overlay/play');
    const blue = cueActions(item, index, 1, runtime('t2')).find((a) => a.type === 'overlay/play');
    expect(red).toMatchObject({ assetId: 'media:winner_red.webm' });
    expect(blue).toMatchObject({ assetId: 'media:winner_blue.webm' });
  });

  /**
   * U110 — 카드 폴백이 폐기됐다. 영상이 없으면 **아무것도 내보내지 않고** 아래 화면이
   * 그대로 남는다(검정이 아니다). 카드를 내보내면 운영자가 파일 부재를 모른 채 넘어간다.
   */
  it('승리 팀이 없으면 커서·진행단계만 넘기고 화면은 그대로 둔다', () => {
    const actions = cueActions(item, index, 1, runtime(null));
    expect(actions).toEqual([
      { type: 'cue/index', index, cueId: 'victory-curling' },
      { type: 'phase/set', phase: 'p1' },
    ]);
  });

  it('그 팀 영상이 등록돼 있지 않아도 화면은 그대로 둔다 — 카드가 대신 나가지 않는다', () => {
    const actions = cueActions(item, index, 1, runtime('t4', []));
    expect(actions.some((a) => a.type === 'overlay/play')).toBe(false);
    expect(actions.some((a) => a.type === 'scene/set')).toBe(false);
    expect(actions.some((a) => a.type === 'music/play')).toBe(false);
  });

  it('런타임을 안 주면 아무것도 내보내지 않는다 — 어느 팀인지 알 수 없다', () => {
    const actions = cueActions(item, index);
    expect(actions.some((a) => a.type === 'overlay/play')).toBe(false);
    expect(actions.some((a) => a.type === 'scene/set')).toBe(false);
    expect(victoryCueVideo(item, undefined)).toBeNull();
    expect(victoryCueNotice(item, undefined)).toBeNull();
  });

  it('발표가 못 나가는 이유를 알리되 **막지는 않는다** — 파일 이름을 그대로 말한다', () => {
    expect(victoryCueNotice(item, runtime(null))).toMatch(/승리 팀/);
    // U110 — 어느 파일을 media 폴더에 넣어야 하는지가 현장에서 필요한 정보다
    expect(victoryCueNotice(item, runtime('t4', []))).toBe('승리 영상 없음: winner_green.webm');
    expect(victoryCueNotice(item, runtime('t3'))).toBeNull();
    // 승리 큐는 매치 큐의 건너뛰기 판정에 걸리지 않는다 — 대본상 반드시 지나가는 자리다
    expect(matchCueBlock(item, runtime(null))).toBeNull();
    // 승리 항목이 아닌 큐는 이 판정 자체에 걸리지 않는다
    expect(victoryCueNotice(CUE.find((c) => c.id === 'score-curling')!, runtime(null))).toBeNull();
  });

  it('승리 영상은 cueAfter가 붙어 있어도 큐에 두 번 들어가지 않는다', () => {
    const assets = ['winner_red.webm', 'winner_blue.webm', 'winner_green.webm', 'winner_yellow.webm'].map(
      (file) =>
        ({
          id: `media:${file}`,
          name: file,
          type: 'video',
          size: 1,
          mime: 'video/webm',
          playMode: 'overlay',
          cueAfter: 'open',
        }) as AssetMeta,
    );
    const items = cueWithVideos(assets);
    expect(items.filter((i) => i.id.startsWith('video:media:winner_'))).toHaveLength(0);
    expect(items.filter((i) => i.victoryEventId)).toHaveLength(P1_EVENT_ORDER.length);
  });
});

/**
 * U100 — 큐시트 배선. `goCue`는 DOM(toast)을 건드려 node 환경에서 호출할 수 없으므로
 * 소스에 배선이 남아 있는지로 고정한다(매치 큐와 같은 방식).
 */
describe('승리 큐 배선 (U100)', () => {
  const cuesheet = readFileSync(new URL('./control/cuesheet.ts', import.meta.url), 'utf8');

  it('런타임에 승리 팀을 실어 보낸다 — 값의 주인은 [1부 컨트롤] 탭이다', () => {
    expect(cuesheet).toContain('winner: ctx.state.sceneOpts.game.winner');
  });

  it('사유는 토스트로 알리되 `nextCueIndex` 건너뛰기 경로에는 넣지 않는다', () => {
    expect(cuesheet).toContain('const victoryNotice = victoryCueNotice(item, runtime);');
    expect(cuesheet).toContain('if (victoryNotice) toast(victoryNotice,');
    // 건너뛰기(advanceOnBlock)는 여전히 `matchCueBlock` 하나만 본다
    expect(cuesheet).toMatch(/if \(blocked && advanceOnBlock\)/);
    expect(cuesheet).not.toMatch(/victoryNotice && advanceOnBlock/);
  });
});

/**
 * U109 (2026-09-05 04:55 사용자 지시) — "승리보드 송출은 송출할지 선택만 할지 고를 수 있게
 * 해줘. 1부 컨트롤에서."
 *
 * 송출 입구가 둘(큐시트 · [1부 컨트롤] 탭)이 되므로 **배열을 만드는 곳은 하나**여야 한다.
 * 여기서 그 빌더의 계약을 잠근다.
 */
describe('승리 송출 빌더 — 큐시트와 1부 탭의 공유 정본 (U109 · U110)', () => {
  const assets = [{ id: 'media:winner_red.webm' }, { id: 'media:winner_blue.webm' }];
  const noMusic = { trackId: null, startSec: 0 };
  const withMusic = { trackId: '03', startSec: 42.5 };

  it('영상 하나 — scene/set이 없으므로 전환 래핑을 타지 않는다', () => {
    expect(victoryOutputActions('t3', assets, 42, noMusic)).toEqual([
      { type: 'overlay/play', assetId: 'media:winner_red.webm', holdEndFrame: true, now: 42 },
    ]);
  });

  it('승리 음악이 지정돼 있으면 영상과 **같은 배열**에 실린다 (U110)', () => {
    expect(victoryOutputActions('t3', assets, 42, withMusic)).toEqual([
      { type: 'overlay/play', assetId: 'media:winner_red.webm', holdEndFrame: true, now: 42 },
      { type: 'music/play', trackId: '03', startSec: 42.5, now: 42, fadeIn: false },
    ]);
  });

  it('곡을 안 골랐으면 영상만 나간다 — 음악 액션이 아예 없다', () => {
    const actions = victoryOutputActions('t2', assets, 42, noMusic);
    expect(actions.some((a) => a.type === 'music/play')).toBe(false);
    // 기본 인자도 같은 뜻이다 (곡 미지정)
    expect(victoryOutputActions('t2', assets, 42)).toEqual(actions);
  });

  it('음악을 멈추는 액션은 넣지 않는다 — 끝나는 시점은 MC가 정한다 (U110)', () => {
    const actions = victoryOutputActions('t3', assets, 42, withMusic);
    for (const type of ['music/pause', 'music/duck', 'music/stop']) {
      expect(actions.some((a) => a.type === type)).toBe(false);
    }
  });

  it('영상이 없으면 **아무것도** 내보내지 않는다 — 카드 폴백은 U110에서 폐기됐다', () => {
    // 오피셜 4팀 밖 슬롯(영상 없음)
    expect(victoryOutputActions('t5', assets, 42, withMusic)).toEqual([]);
    // 등록되지 않은 팀
    expect(victoryOutputActions('t3', [], 42, withMusic)).toEqual([]);
    // 승리 팀 미선택
    expect(victoryOutputActions(null, assets, 42, withMusic)).toEqual([]);
  });

  it('영상이 없으면 음악도 걸지 않는다 — 그림 없는 노래만 나가지 않게', () => {
    expect(victoryOutputActions('t3', [], 42, withMusic).some((a) => a.type === 'music/play')).toBe(
      false,
    );
  });

  it('승리 팀을 기록하지 않는다 — `game.winner`의 주인은 [1부 컨트롤] 탭이다 (U71)', () => {
    for (const winner of ['t1', 't3', null] as const) {
      const actions = victoryOutputActions(winner, assets, 42, withMusic);
      expect(actions.some((a) => a.type === 'sceneOpts/patch')).toBe(false);
    }
  });

  it('큐 경계 전환이 실릴 자리가 없다 — scene/set을 아예 내지 않는다', () => {
    const item = CUE.find((c) => c.id === 'victory-curling')!;
    const index = CUE.findIndex((c) => c.id === 'victory-curling');
    const runtime = (a: { id: string }[]) => ({
      versus: null,
      assets: a,
      scene: 'live' as const,
      gameEventId: 'curling' as const,
      winner: 't3' as const,
    });
    for (const a of [assets, []]) {
      const actions = cueActions(item, index, 42, runtime(a), 'black');
      expect(actions.some((x) => 'transitionMode' in x)).toBe(false);
      expect(actions.some((x) => x.type === 'scene/set')).toBe(false);
    }
  });

  it('큐도 승리 음악을 그대로 실어 보낸다 (U110)', () => {
    const item = CUE.find((c) => c.id === 'victory-sticky')!;
    const index = CUE.findIndex((c) => c.id === 'victory-sticky');
    const actions = cueActions(item, index, 7, {
      versus: null,
      assets,
      scene: 'live',
      gameEventId: 'sticky',
      winner: 't2',
      victoryMusic: withMusic,
    });
    expect(actions).toEqual([
      { type: 'cue/index', index, cueId: 'victory-sticky' },
      { type: 'phase/set', phase: 'p1' },
      { type: 'overlay/play', assetId: 'media:winner_blue.webm', holdEndFrame: true, now: 7 },
      { type: 'music/play', trackId: '03', startSec: 42.5, now: 7, fadeIn: false },
    ]);
  });

  it('[송출] 차단 사유는 승리 팀 미선택과 영상 부재 둘이다 (U110)', () => {
    expect(victoryOutputBlock(null, assets)).toMatch(/승리 팀/);
    expect(victoryOutputBlock('t3', assets)).toBeNull();
    // U110 — 카드가 없으니 영상 부재도 "나갈 것이 없다"이고, 어느 파일인지 그대로 말한다
    expect(victoryOutputBlock('t4', assets)).toBe('승리 영상 없음: winner_green.webm');
    expect(victoryOutputBlock('t3', [])).toBe('승리 영상 없음: winner_red.webm');
    // 영상이 아예 없는 슬롯(PURPLE·TEAL)도 파일 이름 대신 자리표시자로 말한다
    expect(victoryOutputBlock('t5', assets)).toBe('승리 영상 없음: winner_<색>.webm');
  });

  it('승리 음악은 설정 곡 + 그 곡의 북마크에서 나온다 (U110 → U119)', () => {
    const state = createInitialState();
    // 공개본에는 행사별 기본 곡이 없으므로 운영자가 고르기 전에는 영상만 나간다.
    expect(victoryMusicOf(state)).toEqual({ trackId: null, startSec: 0 });

    const picked = reducer(state, { type: 'settings/patch', patch: { victoryMusicTrackId: '03' } });
    expect(victoryMusicOf(picked)).toEqual({ trackId: '03', startSec: 0 });

    const marked = reducer(picked, { type: 'music/bookmark', trackId: '03', positionSec: 12.5 });
    expect(victoryMusicOf(marked)).toEqual({ trackId: '03', startSec: 12.5 });
    // 다른 곡의 북마크는 섞이지 않는다
    const other = reducer(marked, { type: 'music/bookmark', trackId: '04', positionSec: 90 });
    expect(victoryMusicOf(other).startSec).toBe(12.5);
  });
});

/**
 * U110 · 오디오 정책 정합 (U101b · U102) — 승리 영상은 **무음**이므로 승리 음악이 그대로
 * 들려야 한다. 덕킹이 걸리면 이 음악이 2초 동안 내려갔다 올라오고(메인 소리가 스스로 숨는다),
 * 큐도 `musicDuckSec`만큼 붙잡혀 발표가 늦게 나간다.
 */
describe('승리 발표의 음악은 덕킹 대상이 아니다 (U110)', () => {
  const item = CUE.find((c) => c.id === 'victory-curling')!;
  const winnerAsset = {
    id: 'media:winner_red.webm',
    name: 'winner_red.webm',
    type: 'video',
    size: 1,
    mime: 'video/webm',
    playMode: 'overlay',
    // 무음 파일이라 등록 시 probe가 false로 판정한다 (U84)
    audio: false,
  } as AssetMeta;
  const runtime = {
    versus: null,
    assets: [winnerAsset],
    scene: 'live' as const,
    gameEventId: 'curling' as const,
    winner: 't3' as const,
    victoryMusic: { trackId: '03', startSec: 0 },
  };

  it('큐가 해석하는 오버레이 파일은 승리 팀이 정한다', () => {
    expect(cueOverlayAssetId(item, runtime)).toBe('media:winner_red.webm');
  });

  it('승리 영상은 덕킹을 부르지 않는다 — 큐가 붙잡히지 않는다 (U113: 오버레이는 덕킹 밖)', () => {
    expect(
      needsMusicDuck({
        item,
        assets: [winnerAsset],
        musicPlaying: true,
        ducked: false,
        autoDuck: true,
      }),
    ).toBe(false);
  });

  it('오버레이가 도는 동안에도 영상이 소리의 주인이 아니다 — 음악이 그대로 들린다', () => {
    const state = cueActions(item, 0, 5, runtime).reduce(reducer, {
      ...createInitialState(),
      assets: [winnerAsset],
    });
    expect(state.sceneOpts.overlayVideo.assetId).toBe('media:winner_red.webm');
    expect(videoAudioOwnsOutput(state)).toBe(false);
    // 승리 음악은 걸렸고 내려가 있지 않다
    expect(state.music).toMatchObject({ trackId: '03', playing: true, ducked: false });
  });
});
