/**
 * 큐시트 — "다음" 하나로 씬 + 타이머 프리셋 + phase가 함께 넘어간다. (SPEC §4, P2 조작 1종)
 * 순서는 진행 대본(docx) 기준: 사전미션 → 올림픽 인트로(에셋 등록 시) → 개회식 → 1부 4종목(소개 영상→대기→명단→중계→점수) → 쉬는시간 → 속보 → 2부 3단계 → 시상 → 종료.
 * (U22, 2026-09-03 사용자 재지시: 올림픽 인트로는 **사전미션 다음 · 개회식 앞**이다 —
 *  `FORCED_CUE_AFTER`의 `'pre-mission'`. 처음 결정이던 '개회식 다음'은 대체됐다.)
 * (U94, 2026-09-05 사용자 지시: 마지막 항목이던 기획팀 소개(`planning-team`)는 제거됐다 —
 *  `end`(종료 · 대기 화면)가 다시 마지막 항목이다.)
 */

import { P1_EVENT_NAMES, P1_EVENT_ORDER, type Action } from './state';
import { assetMusicTrackId } from './asset-music';
import { findMatchVideo, isMatchVideoAsset } from './match-video';
import { findWinnerVideo, isWinnerVideoAsset, winnerVideoFile } from './winner-video';
import { mediaFileFromId } from './media-manifest';
import { bookmarkOf } from './music-bookmarks';
import { scriptedOutroForAsset } from './scripted-outro';
import { liveOverlayAllOff } from './live-frame';
import type { DeepPartialSceneOpts } from './state';
import { CONFIRMED_TEAM_COUNT } from './types';
import type {
  AppState,
  AssetMeta,
  P1EventId,
  P2StageId,
  Phase,
  SceneId,
  TeamId,
  TimerPreset,
  SceneTransitionMode,
  VideoPlayMode,
} from './types';

export interface CueItem {
  id: string;
  label: string;
  hint: string;
  scene: SceneId;
  phase?: Phase;
  opts?: DeepPartialSceneOpts;
  timer?: { preset: TimerPreset; sec: number };
  /** 2부 잠금 해제가 필요한 항목 */
  locked?: boolean;
  /** 영상 스텝이면 재생할 에셋 id (`video:<assetId>`) */
  assetId?: string;
  assetPlayMode?: VideoPlayMode;
  holdEndFrame?: boolean;
  switchAtSec?: number;
  /**
   * 영상 스텝(full·transition 공통)의 다음 씬. `null` = 지정 없음
   * (full: 재생 직전 씬으로 복귀 / transition: 대기 화면 등 상위 판단).
   */
  videoNextScene?: SceneId | null;
  /**
   * 매치 영상 스텝(U36). 재생할 파일은 **실행 시점의 대결 조합**이 정하므로 여기에 못 박을 수
   * 없다 — `assetId` 대신 종목만 들고 있고, 실제 에셋은 `cueActions`가 조합으로 해석한다.
   */
  matchEventId?: P1EventId;
  /**
   * 승리 영상 스텝(U100). 재생할 파일은 **실행 시점의 승리 팀**(`sceneOpts.game.winner`)이
   * 정하므로 여기에 못 박을 수 없다 — `matchEventId`와 같은 이유로 종목만 들고 있고,
   * 실제 에셋은 `cueActions`가 승리 팀으로 해석한다.
   */
  victoryEventId?: P1EventId;
}

/** `match-<종목>` 큐가 실행될 때 필요한 런타임 값 (조합은 상태에 있고 큐에는 없다) */
export interface CueRuntime {
  versus: [TeamId, TeamId] | null;
  assets: ReadonlyArray<{ id: string }>;
  /** 지금 송출 중인 씬 — 매치 영상을 얹어도 되는 화면인지 판정한다 */
  scene?: SceneId;
  /** 지금 `game` 씬이 그리고 있는 종목 (`sceneOpts.game.eventId`) */
  gameEventId?: P1EventId;
  /**
   * [1부 컨트롤] 탭에서 고른 승리 팀 (`sceneOpts.game.winner`, U71).
   * 승리 큐가 어느 팀의 영상을 얹을지 정하는 값이다 — 큐는 이 값을 **읽기만** 하고
   * 파생하지 않는다(원장에서 1위를 뽑으면 씬 소유자가 둘이 된다, U71).
   */
  winner?: TeamId | null;
  /**
   * 승리 발표와 함께 걸 음악 (U110) — `settings.victoryMusicTrackId`와 그 곡의 북마크(U47).
   * 큐가 곡을 고르지 않는다: 어느 곡인지는 [설정] 탭이 정하고 큐는 읽어 실을 뿐이다.
   */
  victoryMusic?: VictoryMusic;
  /**
   * 이 항목의 full 영상이 데려오는 배경 곡 (U124) — 에셋 메타의 `musicTrackId`와 그 곡의
   * 북마크(U47). 승리 음악과 같은 규칙이다: **큐가 곡을 고르지 않는다.** 어느 곡인지는
   * [영상·에셋] 카드(또는 대본 표)가 정하고 큐는 읽어 실을 뿐이다.
   */
  assetMusic?: AssetMusic;
  /**
   * 큐시트에서 이 항목 **바로 앞** 항목의 id (U42 리뷰).
   *
   * 매치 큐를 엉뚱한 씬에서 누르면 씬만 옮기고 영상은 다음 [다음]에 맡기는데, 그때 커서를
   * 그 항목 자신에 찍어 두면 `nextCueIndex`가 `i+1`을 줘서 **영상이 통째로 건너뛰어진다.**
   * 커서를 한 칸 앞에 두려면 그 자리의 id가 필요하고, 목록을 아는 것은 호출부뿐이다.
   */
  prevCueId?: string | null;
}

/**
 * 매치 영상을 **지금 화면 위에 그냥 얹어도 되는가**.
 *
 * 큐 순서대로 왔다면 바로 앞이 그 종목 대기화면이라 얹으면 된다. 큐시트에서 멀리 떨어진
 * 항목을 직접 눌렀다면 엉뚱한 화면(스코어보드 등) 위에 대결 영상이 올라간다. 그때는 먼저
 * 그 종목 대기화면으로 옮기고(전환 규칙이 그대로 적용된다) 영상은 다음 [다음]에서 재생한다 —
 * 스팅어와 오버레이를 한 프레임에 겹쳐 트는 것보다 한 박자 늦는 편이 낫다.
 */
export function matchCueOnRightScene(item: CueItem, runtime?: CueRuntime): boolean {
  if (!item.matchEventId) return true;
  if (!runtime || runtime.scene === undefined) return true;
  return runtime.scene === 'game' && runtime.gameEventId === item.matchEventId;
}

/**
 * 매치 영상 자리를 두는 종목 (U52, 21:38 갱신).
 *
 * **토너먼트로 두 팀이 맞붙는 종목은 컬링뿐이다.** 신문지 달리기와 끈끈이 낚시도 두 팀씩
 * 나오지만 대결이 아니라 기록·점수로 순위를 정하고, 몸으로 말해요는 팀이 돌아가며 진행한 뒤
 * 점수만 발표한다. 대결 소개 영상이 성립하지 않는 종목에 그 자리를 두면 운영자가 매번
 * 빈 항목을 지나쳐야 한다.
 *
 * **제외 집합이 아니라 포함 집합으로 적는다.** 종목이 늘 때 "빼는 것을 잊어서" 자리가
 * 생기는 쪽보다, "넣는 것을 잊어서" 자리가 없는 쪽이 안전하다.
 *
 * 런처 대결 타일과 컬러 보더는 종목과 무관하게 계속 쓴다 — 중계 화면에서 두 팀이 나올 때의
 * 보더 표시는 대결 여부와 별개다.
 */
export const MATCH_EVENTS: readonly P1EventId[] = ['curling'];

/**
 * 출전 명단 큐 자리를 두는 종목 (U55).
 *
 * **몸으로 말해요는 전원 참가다.** 팀별로 대표 몇 명이 나오는 게 아니라 팀원 전체가 돌아가며
 * 진행하므로 "출전 명단"이라는 개념 자체가 성립하지 않는다 — 다른 세 종목처럼 대표 선수 이름을
 * 미리 정해 공개할 일이 없다. 그래서 이 종목만 큐에서 명단 단계를 아예 건너뛴다: 게임 대기화면
 * 다음이 곧장 경기 중계다.
 *
 * `MATCH_EVENTS`와 같은 이유로 포함 집합을 쓴다 — 종목이 늘 때 "명단이 없는 종목을 빼는 것"을
 * 잊기보다 "명단이 있는 종목을 넣는 것"을 잊는 쪽이 안전하다.
 */
export const ROSTER_EVENTS: readonly P1EventId[] = P1_EVENT_ORDER.filter((id) => id !== 'sync');

/**
 * 명단을 **조별 · 전체 두 보드**로 내는 종목 (U61).
 *
 * 신문지 달리기는 두 팀씩 한 조로 달린다. 전체 4팀 명단만 띄우면 관객이 "지금 뛰는 두 팀이
 * 누구인지"를 화면에서 못 읽는다 — 그래서 이번 조 두 팀만 그리는 보드를 전체 명단 앞에 둔다.
 * 조는 런처 대결 타일이 고른 `liveOverlay.versus` 두 팀이다.
 *
 * `MATCH_EVENTS`·`ROSTER_EVENTS`와 같은 이유로 **포함 집합**을 쓴다 — 종목이 늘 때
 * "조가 없는 종목을 빼는 것"을 잊기보다 "조가 있는 종목을 넣는 것"을 잊는 쪽이 안전하다.
 */
export const HEAT_ROSTER_EVENTS: readonly P1EventId[] = ['newspaper'];

const EVENT_TIMER: Partial<Record<P1EventId, { preset: TimerPreset; sec: number }>> = {
  sticky: { preset: 'sticky60', sec: 60 },
  sync: { preset: 'sync15', sec: 15 },
};

export function buildCue(): CueItem[] {
  const items: CueItem[] = [
    {
      id: 'pre-mission',
      label: '팀별 사전미션',
      hint: '팀별 사전미션 안내 이미지만 송출',
      scene: 'standby',
      phase: 'pre',
      opts: { standby: { mode: 'pre-mission' } },
    },
    {
      id: 'open',
      label: '개회식',
      hint: '올림픽 인트로 종료 후 MC 개회식 진행',
      scene: 'standby',
      phase: 'pre',
      opts: { standby: { mode: 'main' } },
    },
    // 개회식 다음이 선수 선서다 (U60). 안내 이미지 한 장 — `pre-mission`과 같은 씬 붙박이 그림.
    {
      id: 'oath',
      label: '선수 선서',
      hint: '선수 대표 선서 — 안내 이미지 송출',
      scene: 'standby',
      phase: 'pre',
      opts: { standby: { mode: 'oath' } },
    },
  ];

  for (const id of P1_EVENT_ORDER) {
    const name = P1_EVENT_NAMES[id];
    items.push({
      id: `game-standby-${id}`,
      label: `${name} 대기화면`,
      hint: '경기 준비 중 대기 화면',
      scene: 'game',
      phase: 'p1',
      opts: { game: { eventId: id, mode: 'standby' }, standby: { mode: 'main' } },
    });
    // 출전 명단 **직전**이 매치 영상 자리다 (U36). 씬을 바꾸지 않고 지금 화면(그 종목 대기
    // 이미지) 위에 알파 오버레이로 얹는다 — 영상 자체가 도입 스팅어를 갖고 있어 전환이 필요 없다.
    // 대결로 진행하지 않는 종목은 자리 자체를 만들지 않는다 (U52).
    if (MATCH_EVENTS.includes(id)) {
      items.push({
        id: `match-${id}`,
        label: `▶ 매치 영상 · ${name}`,
        hint: '런처 매치 타일을 눌러 대결 조합을 고르면 영상이 재생됩니다',
        scene: 'game',
        phase: 'p1',
        matchEventId: id,
      });
    }
    // 전원 참가 종목(몸으로 말해요)은 명단 자리 자체가 없다 (U55).
    if (ROSTER_EVENTS.includes(id)) {
      // 조별 보드가 먼저다 (U61) — "지금 뛰는 두 팀"을 보여 준 다음 전체 명단으로 넓힌다.
      if (HEAT_ROSTER_EVENTS.includes(id)) {
        items.push({
          id: `roster-${id}-heat`,
          label: `${name} · 이번 조 명단`,
          hint: '런처 대결 타일에서 고른 두 팀만 공개',
          scene: 'roster',
          phase: 'p1',
          opts: { roster: { eventId: id, scope: 'heat' } },
        });
      }
      items.push({
        id: `roster-${id}`,
        label: HEAT_ROSTER_EVENTS.includes(id) ? `${name} · 전체 출전 명단` : `${name} · 출전 명단`,
        hint: '명단 카드 공개',
        scene: 'roster',
        phase: 'p1',
        opts: { roster: { eventId: id, scope: 'all' } },
      });
    }
    items.push({
      id: `live-${id}`,
      label: `${name} · 경기 중계`,
      hint: '카메라 + 스코어바 + 타이머',
      scene: 'live',
      phase: 'p1',
      opts: { liveOverlay: { badge: id, scorebar: true, timer: true } },
      timer: EVENT_TIMER[id],
    });
    // 승리 팀 발표는 **점수 공개 앞**이다 (U71) — 대본이 "경기 끝 → 승리 발표 → 점수 공개"다.
    // 어느 팀인지는 큐가 정하지 않는다. `sceneOpts.game.winner`는 [1부 컨트롤] 탭에서 고른
    // 값 그대로 두고, 이 항목은 씬과 모드만 세운다(큐가 원장을 파생하면 소유자가 둘이 된다).
    /**
     * 승리 발표 (U71 → U100 → U110). `winner_<색>.webm` 알파 오버레이를 **지금 화면 위에
     * 그대로** 얹고, 지정된 승리 음악을 함께 건다.
     *
     * **`opts`를 두지 않는다** — U110에서 승리 보드 카드가 폐기되면서 세울 씬이 없어졌다.
     * `scene`은 `CueItem`의 필수 필드라 남지만 이 항목에서는 쓰이지 않는다(`cueActions`의
     * 승리 갈래가 `scene/set`을 내기 전에 돌아간다). 옛 `opts: { game: { mode: 'victory' } }`를
     * 되살리면 이제 타입 자체가 없다 — 그 모드는 `SceneOpts`에서 사라졌다.
     */
    items.push({
      id: `victory-${id}`,
      label: `${name} · 승리 팀`,
      hint: '[1부 컨트롤] 탭에서 고른 승리 팀의 승리 영상 + 승리 음악',
      scene: 'game',
      phase: 'p1',
      victoryEventId: id,
    });
    items.push({
      id: `score-${id}`,
      label: `${name} · 점수 공개`,
      hint: '순위 확정 후 스코어보드',
      scene: 'score',
      phase: 'p1',
      opts: { score: { highlight: id } },
    });
  }

  items.push({
    id: 'break',
    label: '쉬는시간',
    hint: '평온 유지 — 대기 화면 그대로',
    scene: 'standby',
    phase: 'break',
    opts: { standby: { mode: 'main' } },
  });

  items.push({
    id: 'part2-live',
    label: '2부 전환 · 라이브 송출',
    hint: '쉬는시간 종료 — 대기화면 다크 프레임 위로 라이브를 송출. 전환 방식이 블랙으로 바뀝니다 (이후 런처에서 변경 가능)',
    scene: 'live',
    phase: 'p2',
    locked: true,
    /**
     * 크롬은 전부 끄고 **다크 프레임만** 얹는다 (U118, 2026-09-05 07:07 사용자 지시:
     * "대기화면 사진 배경 모드의 다크 모드를 얹은 채 배경만 라이브 중계하면 어때").
     *
     * 이 큐가 `frame`을 켜는 **유일한 자리**다. 다른 라이브 큐(1부 종목 중계·런처 F2)는
     * `frame`을 적지 않고, `scene/set`이 명시 없는 전환마다 `none`으로 되돌리므로 2부 톤이
     * 1부 중계로 새지 않는다. 크롬을 끄는 이유도 그대로다 — 다음 큐가 이 그림을 통째로
     * 글리치로 갈아 넣는데(`breaking`), 스코어바·타이머가 얹혀 있으면 그것들이 캔버스에
     * 한 프레임에 묻혀 화면이 튄다(U91이 0.6초 디졸브로 막은 바로 그 사고).
     */
    // 크롬 넷을 끄는 모양은 런처 [퓨어] 버튼(U131)과 공유한다 — 차이는 `frame`뿐이다.
    opts: {
      liveOverlay: liveOverlayAllOff('dark-standby'),
    },
  });

  items.push({
    id: 'breaking',
    label: '▶ Part 1 · 글리치 → 분위기반전 영상',
    hint: '라이브 위 글리치 후 분위기반전 영상을 시작',
    scene: 'breaking',
    phase: 'p2',
    locked: true,
  });

  for (const sid of ['s1', 's2', 's3'] as P2StageId[]) {
    const gameNumber = (['s1', 's2', 's3'] as P2StageId[]).indexOf(sid) + 1;
    /**
     * 단계 대기화면 (U97, U112) — 후반 각 단계의 큐는 이제 이 한 항목뿐이다.
     *
     * 1부의 `game-standby-<종목>`과 같은 자리다: 진행자가 규칙을 설명하는 동안 그 게임의
     * 그림 한 장을 띄워 둔다. **U112 사용자 지시** — "n번 게임 진행 이거 2부에 있는 것들인데
     * 다 제거해. 왜냐면 2부는 게임 다 끝나고 시상할 때 공개하는 시스템이라." 진행 중 제출
     * 상태 바(`N번 게임 진행`, `submit.mode:'board'`)를 큐에서 없앴다 — 2부는 게임이 진행되는
     * 동안 화면에 아무것도 공개하지 않고, 결과는 시상(`award` 씬 `② 2부 순위`)에서만 드러난다.
     * `board` 렌더·타입(`SceneOpts['submit']['mode']`)과 [2부 컨트롤] 탭의 제출/순위 입력
     * 기능은 그대로 남는다 — 초기 상태 기본값이자 `migrate()`의 안전 폴백이라 코드로는
     * 여전히 필요하다(`p2-steady.test.ts`가 그 계약을 지킨다). 없앤 것은 **큐 진입점**뿐이다.
     */
    items.push({
      id: `p2-steady-${gameNumber}`,
      label: `2부 ${gameNumber}단계 · 대기화면`,
      hint: `대기 이미지 한 장 (media/p2_steady_stage${gameNumber}.jpeg) — 진행자 설명 구간`,
      scene: 'submit',
      phase: 'p2',
      opts: { submit: { stageId: sid, mode: 'steady' } },
      locked: true,
    });
  }

  items.push({
    id: 'award',
    label: '시상 · 순위 집계',
    hint: '1부 순위표부터 — 종합 합산까지는 [시상] 탭 단계 버튼으로',
    scene: 'award',
    phase: 'award',
    locked: true,
    opts: {
      award: {
        step: 'p1',
        revealed: 0,
        rankRevealed: false,
        selectedRank: null,
        selectedTeamRevealed: false,
        revealedRanks: [],
        solo: false,
      },
    },
  });

  /**
   * 최종 순위 발표 — **한 등수당 큐 하나** (U127, 2026-09-05 10:56 사용자 지시:
   * "최종 순위 발표 때 다른 팀 안 보이게 하고 4위 팀만 공개, 이런 식으로 독립으로 구분").
   *
   * ## 왜 큐를 등수 수만큼 쪼갰나
   * 예전에는 `award` 한 항목이 시상 전체였고, 등수는 [시상] 탭 안에서만 넘어갔다. 큐시트를
   * 따라가는 운영자에게 "지금 몇 위를 발표할 차례인가"가 큐에 보이지 않았고, 무대는 이미
   * 공개한 등수를 왼쪽에 쌓아 두어 다음 등수 카드 옆에 다른 팀이 계속 남아 있었다.
   * 등수마다 독립된 큐를 두면 커서 자체가 진행 지점이 되고, 각 큐가 `award.solo`를 켜므로
   * 무대에는 **그 등수 한 장만** 선다.
   *
   * ## 이 큐가 여는 것은 "등수 자리"까지다
   * `selectedTeamRevealed: false` — 팀 이름·점수·누적 칩은 다음 박자다(U70 두 박자 계약:
   * 등수와 팀 사이가 MC의 뜸이다). 팀 공개는 [시상] 탭의 `[다음: N위 팀 공개]`가 맡는다.
   * 큐가 팀까지 한 번에 열면 그 뜸이 사라지고, 여기서 즉시 반영되는 opts 패치가 스팅어보다
   * 먼저 팀을 드러낸다(같은 씬 안 opts 전환은 `switchAtSec`까지 미뤄지지 않는다).
   *
   * ## `revealedRanks`를 건드리지 않는다
   * opts는 부분 패치(`mergeDeep`)라 여기 적지 않은 필드는 그대로 남는다. 이력을 비우면
   * `nextAwardBeat`의 "아직 공개하지 않은 가장 낮은 등수"가 되살아나 이미 발표한 등수를
   * 다시 제안한다 — 큐로 되돌아왔을 때도 진행은 이어져야 한다.
   *
   * 등수 수는 확정 팀 수(4)를 따른다. 큐는 정적 배열이라 운영 중 팀 수 변경을 반영하지
   * 않는다 — 참가 팀은 4팀으로 확정이고(`CONFIRMED_TEAM_COUNT`), 그보다 적은 팀으로 돌면
   * 남는 등수 큐는 리듀서의 범위 검사에서 무시된다.
   */
  for (let rank = CONFIRMED_TEAM_COUNT; rank >= 1; rank -= 1) {
    items.push({
      id: `award-${rank}`,
      label: `시상 · ${rank}위 발표`,
      hint: `${rank}위 자리만 무대에 — 팀 공개는 [시상] 탭 [다음] 한 번 더 (다른 팀은 화면에 없음)`,
      scene: 'award',
      phase: 'award',
      locked: true,
      opts: {
        award: {
          step: 'reveal',
          selectedRank: rank,
          selectedTeamRevealed: false,
          solo: true,
        },
      },
    });
  }

  items.push({
    id: 'award-winner',
    label: '시상 · 우승 세리머니',
    hint: '우승 팀 풀스크린 + 컨페티',
    scene: 'award',
    phase: 'award',
    locked: true,
    opts: { award: { step: 'winner' } },
  });

  items.push({
    id: 'end',
    label: '종료 · 대기 화면',
    hint: '엔딩 BGM',
    scene: 'standby',
    phase: 'end',
    opts: { standby: { mode: 'main' } },
  });

  return items;
}

/** 영상이 없는 기본 큐 (테스트·초기 상태용) */
export const CUE: CueItem[] = buildCue();

const P1_INTRO_FILE: Record<P1EventId, string> = {
  curling: 'intro_curling.mp4',
  newspaper: 'intro_newspaper_race.mp4',
  sticky: 'intro_sticky_fishing.mp4',
  sync: 'intro_one_mind.mp4',
};

const P2_PART_FILE = {
  1: '260831_pt1_v001.mp4',
  2: '260831_pt2_v001.mp4',
  3: '260831_pt3_v001.mp4',
  4: '260831_pt4_v001.mp4',
} as const;

/**
 * 저장된 `cueAfter`를 무시하고 위치를 **강제**하는 영상 (U22, 2026-09-03 결정).
 *
 * 왜 하드코딩인가: `syncMediaManifest`는 재적재 때 사람이 고쳤을 수 있는 값을 지키려고
 * 기존 `cueAfter`를 manifest 값보다 **우선**한다. 그래서 결정 이전에 저장된 브라우저에서는
 * 올림픽 인트로가 `cueAfter: null`(=큐에서 빠짐)이나 옛 위치('open' 등)로 남고, 운영자가
 * 에셋 탭에서 한 번 잘못 건드려도 조용히 다른 자리로 되돌아간다. 진행 대본이 정한 순서는 앱이 알고
 * 있어야 하는 값이므로 `P1_INTRO_FILE`·`P2_PART_FILE`과 같은 방식으로 여기 못 박는다.
 */
const FORCED_CUE_AFTER: Record<string, string> = {
  // 사전미션 안내 이미지 다음, 개회식 **앞** (2026-09-03 사용자 재지시)
  'olympic_intro_v001.mp4': 'pre-mission',
};

/**
 * 강제 위치가 있으면 그 값, 없으면 에셋에 저장된 `cueAfter`.
 *
 * ## 대본 고정 장치는 **두 갈래**다 (통합하지 않는다)
 *  1) `P1_INTRO_FILE`·`P2_PART_FILE` — 큐 항목 사이에 **직접 삽입**하고, 일반 `videos` 목록에서는
 *     제외한다. 라벨·힌트·`videoNextScene`이 항목마다 다르고(“게임 소개 영상”, “Part 4 · 범인 리빌”)
 *     삽입 위치도 `cueAfter` 한 문자열로 표현되지 않는다(소개 영상은 대기화면 **앞**에 온다).
 *  2) `FORCED_CUE_AFTER` — 위치만 못 박고 라벨·힌트는 일반 영상과 같은 경로로 만든다.
 *     올림픽 인트로처럼 “사전미션 다음”이라는 위치 하나만 정해져 있으면 이쪽이 맞다.
 *
 * 둘을 한 표로 합치면 (1)의 라벨·앞뒤 배치 규칙이 데이터로 표현되지 않아 결국 분기가 되살아난다.
 */
export function effectiveCueAfter(asset: AssetMeta): string | null {
  const file = mediaFileFromId(asset.id);
  const forced = file ? FORCED_CUE_AFTER[file] : undefined;
  return forced ?? asset.cueAfter ?? null;
}

/** 대본이 위치를 정해 둔 파일 — 운영자가 자유롭게 옮길 수 없고, 자동 기본값 후보도 아니다. */
export const SCRIPTED_CUE_FILES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(FORCED_CUE_AFTER),
  ...Object.values(P1_INTRO_FILE),
  ...Object.values(P2_PART_FILE),
]);

/** 위치가 대본으로 고정된 에셋인가 (에셋 탭에서 `cueAfter` 셀렉트를 잠그는 기준) */
export function isScriptedCueAsset(assetId: string): boolean {
  const file = mediaFileFromId(assetId);
  return file !== null && SCRIPTED_CUE_FILES.has(file);
}

/**
 * F9 속보 체인이 물고 갈 기본 영상.
 *
 * 1순위는 `260831_pt1_v001.mp4`(2부 Part 1)다. 이 파일은 큐 어디에도 나타나지 않고
 * `scheduleBreakingChain` 전용으로만 쓰인다 — 즉 "속보의 그 영상"이 대본상 이것 하나다.
 * 없으면 **대본이 자리를 정해 둔 파일을 빼고** 첫 본편(full) 영상으로 폴백한다. 그 제외가
 * 없으면 manifest 첫 full인 올림픽 인트로가 속보 자리에 걸린다(개회식 영상이 속보로 나간다).
 * 전환 오버레이(0.2초 알파 스팅어)는 애초에 full이 아니라 후보에서 빠진다.
 */
export function defaultBreakingVideoId(
  metas: readonly { id: string; type: string; playMode?: VideoPlayMode }[],
): string | null {
  const isFullMedia = (m: { id: string; type: string; playMode?: VideoPlayMode }) =>
    m.type === 'video' && mediaFileFromId(m.id) !== null && (m.playMode ?? 'full') === 'full';

  const chainId = `media:${P2_PART_FILE[1]}`;
  const chain = metas.find((m) => m.id === chainId && isFullMedia(m));
  if (chain) return chain.id;

  const fallback = metas.find((m) => isFullMedia(m) && !isScriptedCueAsset(m.id));
  return fallback ? fallback.id : null;
}

const P2_PART_LABEL: Record<2 | 3 | 4, string> = {
  2: '▶ Part 2 · 1번 게임 종료 영상',
  3: '▶ Part 3 · 2번 게임 종료 영상',
  4: '▶ Part 4 · 범인·범행동기·사건 종결 리빌',
};

/**
 * 등록된 영상을 큐에 끼워 넣은 최종 큐.
 *
 * 영상은 행사 곳곳에 들어간다(게임 설명 7편, 반전, 검거 연결, 범행 동기, 종결…).
 * 어디에 넣을지는 앱이 알 수 없으므로 각 에셋의 `cueAfter`(어느 큐 항목 **다음**에 재생할지)를
 * 사람이 정하게 하고, 여기서는 그 지시대로 꽂기만 한다. 지정이 없으면 큐에 넣지 않는다
 * (에셋 탭의 [재생] 버튼으로는 언제든 틀 수 있다).
 */
export function cueWithVideos(assets: AssetMeta[]): CueItem[] {
  const officialIntroIds = new Set(Object.values(P1_INTRO_FILE).map((file) => `media:${file}`));
  const officialP2Ids = new Set(Object.values(P2_PART_FILE).map((file) => `media:${file}`));
  const introByEvent = new Map<P1EventId, AssetMeta>();
  for (const eventId of P1_EVENT_ORDER) {
    const asset = assets.find((candidate) => candidate.id === `media:${P1_INTRO_FILE[eventId]}`);
    if (asset) introByEvent.set(eventId, asset);
  }
  const p2ByPart = new Map<1 | 2 | 3 | 4, AssetMeta>();
  for (const part of [1, 2, 3, 4] as const) {
    const asset = assets.find((candidate) => candidate.id === `media:${P2_PART_FILE[part]}`);
    if (asset) p2ByPart.set(part, asset);
  }
  const videos = assets
    .filter(
      (a) =>
        a.type === 'video' &&
        effectiveCueAfter(a) &&
        !officialIntroIds.has(a.id) &&
        !officialP2Ids.has(a.id) &&
        // 매치 영상의 큐 자리는 `match-<종목>` 항목이다. `cueAfter`가 붙어 있어도 두 번 넣지 않는다.
        !isMatchVideoAsset(a.id) &&
        // 승리 영상도 같다 — 큐 자리는 `victory-<종목>`이 이미 갖고 있다 (U100).
        !isWinnerVideoAsset(a.id),
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!videos.length && introByEvent.size === 0 && p2ByPart.size === 0) return CUE;

  const out: CueItem[] = [];
  for (const item of CUE) {
    const eventId = P1_EVENT_ORDER.find((candidate) => item.id === `game-standby-${candidate}`);
    const intro = eventId ? introByEvent.get(eventId) : undefined;
    if (eventId && intro) {
      out.push({
        id: `video:${intro.id}`,
        label: `▶ ${P1_EVENT_NAMES[eventId]}게임 소개 영상`,
        hint: '게임 소개 영상 재생 — 끝나면 대기 화면',
        scene: 'video',
        phase: 'p1',
        assetId: intro.id,
        assetPlayMode: 'full',
        holdEndFrame: intro.holdEndFrame === true,
        videoNextScene: 'standby',
      });
    }
    out.push(item);
    // U112 — 진행 중 제출 보드(`submit-s<n>`)가 큐에서 빠지면서, "게임 N 종료 직후" 영상은
    // 그 단계의 대기화면(`p2-steady-<n>`) 바로 다음으로 끼운다. 배열 안에서 p2-steady-<n> 다음은
    // 이제 곧장 p2-steady-<n+1>(또는 마지막 단계면 `award`)이므로 자리는 그대로 "게임 종료 직후"다.
    const part = item.id === 'p2-steady-1' ? 2 : item.id === 'p2-steady-2' ? 3 : item.id === 'p2-steady-3' ? 4 : null;
    const p2Asset = part ? p2ByPart.get(part) : undefined;
    if (part && p2Asset) {
      out.push({
        id: `video:${p2Asset.id}`,
        label: P2_PART_LABEL[part],
        hint:
          part === 4
            ? '최종 범인 공개부터 범행동기·사건 종결까지 재생'
            : `${part - 1}번 게임 종료 직후 재생`,
        scene: 'video',
        phase: 'p2',
        locked: true,
        assetId: p2Asset.id,
        assetPlayMode: 'full',
        holdEndFrame: p2Asset.holdEndFrame === true,
        videoNextScene: 'suspects',
      });
    }
    for (const v of videos.filter((a) => effectiveCueAfter(a) === item.id)) {
      const mode = v.playMode ?? 'full';
      /**
       * 대본 아웃트로가 붙은 영상은 끝나는 자리도 대본이 정한다 (U87) — `video/playFull`이
       * 어차피 `nextScene`을 덮으므로, 큐시트 힌트도 같은 값을 말해야 한다. 여기서 에셋의
       * `nextScene`(null = 직전 씬 복귀)을 그대로 보여 주면 화면과 실제 동작이 어긋난다.
       */
      const outro = scriptedOutroForAsset(v.id);
      // null = 지정 없음. full은 "재생 직전 씬으로 복귀", transition은 상위(대기 화면 등) 판단 —
      // 여기서 'standby'로 뭉개지 않고 그대로 들고 다닌다(§11 M2).
      const nextScene = outro ? outro.nextScene : (v.nextScene ?? null);
      const afterPhrase =
        nextScene === null ? '직전 씬으로 복귀' : `${SCENE_AFTER_LABEL[nextScene] ?? '대기 화면'}으로`;
      out.push({
        id: `video:${v.id}`,
        label: `▶ ${v.name}`,
        hint:
          mode === 'transition'
            ? `전환 오버레이 — ${afterPhrase}`
            : mode === 'overlay'
              ? '매치 알파 오버레이 — 영상 자체 도입 스팅어 사용'
              : outro
                ? `영상 재생 — 끝 ${outro.fadeSec}초 오디오 페이드 아웃, 화이트로 덮은 뒤 ${afterPhrase} (대본 고정)`
                : `영상 재생 — 끝나면 ${afterPhrase}`,
        scene: mode === 'full' ? 'video' : 'standby',
        assetId: v.id,
        assetPlayMode: mode,
        // 아웃트로가 끝을 책임지므로 마지막 프레임을 붙잡지 않는다 (`video/playFull`과 같은 판단).
        holdEndFrame: !outro && v.holdEndFrame === true,
        switchAtSec: v.switchAtSec ?? 0.5,
        videoNextScene: nextScene,
        // 2부 씬으로 이어지는 영상은 잠금 해제 후에만 노출한다
        locked: nextScene === 'suspects' || nextScene === 'submit',
      });
    }
  }
  return out;
}

const SCENE_AFTER_LABEL: Record<SceneId, string> = {
  standby: '대기 화면',
  game: '게임 화면',
  live: '경기 중계',
  score: '스코어보드',
  roster: '출전 명단',
  timer: '타이머',
  prompt: '제시어',
  breaking: '속보',
  video: '영상',
  photos: '현장 사진',
  suspects: '보드',
  submit: '단계 진행',
  award: '시상',
};

/** 이 매치 큐가 지금 재생할 영상. 조합이 없거나 그 조합 영상이 없으면 null */
export function matchCueVideo(item: CueItem, runtime?: CueRuntime) {
  if (!item.matchEventId || !runtime?.versus) return null;
  return findMatchVideo(runtime.assets, runtime.versus[0], runtime.versus[1]);
}

/**
 * 이 승리 큐가 지금 얹을 영상 (U100). 승리 팀이 없거나 그 팀 영상이 등록돼 있지 않으면 null.
 *
 * 런타임 없이 부르면(순수 큐 검사) 항상 null이다 — 어느 팀이 이겼는지는 상태에만 있다.
 */
export function victoryCueVideo(item: CueItem, runtime?: CueRuntime) {
  if (!item.victoryEventId || !runtime) return null;
  return findWinnerVideo(runtime.assets, runtime.winner ?? null);
}

/**
 * 이 큐가 지금 `overlay/play`로 **실제로 틀 파일**. 없으면 null (U101b).
 *
 * ## 왜 필요한가
 * 매치·승리 영상은 큐 항목에 파일이 박혀 있지 않다 — 실행 시점의 대결 조합(`versus`)과
 * 승리 팀(`winner`)이 정한다. 큐를 내기 **전에** "이번에 어느 파일이 나가는가"를 물어야
 * 하는 자리가 있으면 여기를 쓴다.
 *
 * ## 왜 여기인가
 * 해석의 정본은 `cueActions`다. 부르는 쪽이 자기 해석을 따로 쓰면 두 곳이 다른 파일을 볼 수
 * 있으므로, `cueActions`가 쓰는 것과 **같은 함수·같은 게이트**(`matchCueOnRightScene`)를
 * 여기서 한 번 더 지난다 — 씬부터 옮겨야 하는 매치 큐는 이번 실행에서 영상을 내지 않는다.
 *
 * **지금 프로덕션 호출자는 없다** (U113). U101b가 음악 덕킹 판정에 넘기려고 만든 자리인데,
 * 오버레이가 덕킹 대상에서 빠지면서 그 호출이 사라졌다(`control/cuesheet.ts`). 해석 규칙
 * 자체는 계약이라 테스트와 함께 남긴다 — 다시 필요해지면 여기가 정본이다.
 */
export function cueOverlayAssetId(item: CueItem, runtime?: CueRuntime): string | null {
  if (item.matchEventId) {
    if (!matchCueOnRightScene(item, runtime)) return null;
    return matchCueVideo(item, runtime)?.assetId ?? null;
  }
  if (item.victoryEventId) return victoryCueVideo(item, runtime)?.assetId ?? null;
  return null;
}

/** 승리 발표와 함께 걸 음악 (U110). `trackId`가 `null`이면 영상만 나간다. */
export interface VictoryMusic {
  /** `settings.victoryMusicTrackId` — 라이브러리 곡 id */
  trackId: string | null;
  /** 그 곡의 북마크(U47). 없으면 0(처음부터) */
  startSec: number;
}

/**
 * 지금 상태가 말하는 승리 음악 (U110) — 곡 id와 시작 지점을 한자리에서 뽑는다.
 *
 * 시작 지점이 북마크인 이유: 승리 음악은 후렴부터 나가야 하는 곡일 가능성이 높고, 그 자리를
 * 기억해 두는 장치가 이미 있다(U47). 큐시트와 [1부 컨트롤] 탭 두 입구가 **이 함수 하나**를
 * 통해야 두 곳에서 다른 지점부터 나가는 일이 없다.
 */
export function victoryMusicOf(state: AppState): VictoryMusic {
  const trackId = state.settings.victoryMusicTrackId;
  return { trackId, startSec: bookmarkOf(state.music.bookmarks, trackId) ?? 0 };
}

/**
 * 승리 발표를 **실제로 송출하는** 액션 (U100 · U109 · U110).
 *
 * ## 왜 함수로 뽑았나 (U109)
 * 송출 입구가 둘이다 — 큐시트의 `victory-<종목>`과 [1부 컨트롤] 탭의 `[송출]` 버튼.
 * 두 곳이 각자 배열을 만들면 한쪽만 오버레이를 타는 어긋남이 생긴다(U109 이전 실제 상태가
 * 그랬다: 탭 버튼은 `scene/set`만 내 승리 영상이 영영 안 나왔다).
 * **송출의 정본은 이 함수 하나**이고, 두 입구는 이것을 부르기만 한다.
 *
 * ## 무엇이 나가는가 (U110, 04:56 사용자 지시)
 * "송출보드 저건 폐기해. 내가 준 영상과 음악으로 대체하고. 영상이 더 짧을텐데 이것도
 * 마찬가지로 엔드프레임 홀드." — 그래서 **영상 + 음악** 두 액션이다:
 *  - `overlay/play`(`holdEndFrame: true`) — 승리 영상 14.31초가 음악보다 짧으므로 끝
 *    프레임(알파 100% 불투명한 승리 보드)을 붙잡아 둔다. 음악은 그 위에서 계속 흐른다.
 *  - `music/play` — `settings.victoryMusicTrackId`가 정해져 있을 때만. 이 음악이 **메인**이라
 *    덕킹 대상이 아니다: 승리 영상은 오디오 트랙이 없어 `overlayPlaysAudio`가 거짓이고,
 *    그래서 `needsMusicDuck`도 `videoAudioOwnsOutput`도 이 자리를 잡지 않는다(U101b·U102 정합).
 *
 * 정지 액션은 넣지 않는다 — 음악을 멈추는 것은 음악 덱의 일이다(다음 큐의 곡이 교체하거나
 * 운영자가 [음악] 탭에서 내린다). 여기서 멈추면 발표가 끝나는 시점을 큐가 정하게 되는데,
 * 그 시점은 MC가 정한다.
 *
 * ## 영상이 없으면 **아무것도 내보내지 않는다** (U110)
 * U100의 "파일 없으면 승리 보드 카드" 폴백은 카드와 함께 폐기됐다. 빈 배열을 돌려주고,
 * 부르는 쪽이 `victoryOutputBlock`의 문장을 토스트로 띄운다 — 아래 화면은 그대로 남는다
 * (검정이 아니다). 카드가 대신 나가면 운영자는 파일이 빠진 것을 모른 채 넘어간다.
 *
 * **승리 팀을 기록하지 않는다.** `game.winner`의 주인은 [1부 컨트롤] 탭이고(U71), 송출은
 * 그 값을 읽기만 한다 — 여기서 같이 쓰면 소유자가 둘이 된다.
 */
export function victoryOutputActions(
  winner: TeamId | null,
  assets: ReadonlyArray<{ id: string }>,
  now: number,
  music: VictoryMusic = { trackId: null, startSec: 0 },
): Action[] {
  const video = findWinnerVideo(assets, winner);
  if (!video) return [];
  const out: Action[] = [{ type: 'overlay/play', assetId: video.assetId, holdEndFrame: true, now }];
  if (music.trackId) {
    // U122 — 승리 음악 파일 자체에 이미 페이드가 걸려 있다(사용자 지시, 09-05 07:5x).
    // 인커밍 크로스페이드를 건너뛰고 즉시 목표 게인으로 올린다. 다른 곡이 울리고 있었다면
    // 그 곡은 여전히 musicFadeSec에 걸쳐 내려가고, 승리 음악만 그 위에 즉시 겹친다 —
    // 승리 영상이 같은 순간 얹히므로 겹침이 자연스럽다.
    out.push({ type: 'music/play', trackId: music.trackId, startSec: music.startSec, now, fadeIn: false });
  }
  return out;
}

/**
 * 승리 발표가 **나가지 못하는 이유** (없으면 null, U109 · U110).
 *
 * U110에서 승리 보드 카드가 폐기되면서 "영상이 없어도 무언가는 나간다"가 성립하지 않는다 —
 * 파일이 없으면 정말로 아무것도 안 나가므로, 그 사실이 두 입구 모두에서 보여야 한다:
 *  - [1부 컨트롤] 탭의 `[송출]`은 **비활성**된다(눌러도 할 일이 없는 버튼을 열어 두지 않는다).
 *  - 큐시트는 **막지 않고** 이 문장을 토스트·줄 표식으로 띄운다(`victoryCueNotice`) —
 *    승리 발표는 대본이 반드시 밟는 자리라 진행을 세우면 뒤로도 못 간다.
 *
 * 파일 이름을 그대로 말하는 이유: 현장에서 필요한 정보는 "왜 안 나왔나"가 아니라
 * "어느 파일을 media 폴더에 넣어야 하나"다.
 */
export function victoryOutputBlock(
  winner: TeamId | null,
  assets: ReadonlyArray<{ id: string }>,
): string | null {
  if (!winner) return '승리 팀을 먼저 고르세요';
  if (findWinnerVideo(assets, winner)) return null;
  return `승리 영상 없음: ${winnerVideoFile(winner) ?? 'winner_<색>.webm'}`;
}

/** full 영상이 데려오는 배경 곡 (U124). `trackId`가 `null`이면 영상만 나간다. */
export interface AssetMusic {
  /** 에셋 메타의 `musicTrackId`(또는 대본 표 기본값) — 음악 라이브러리 곡 id */
  trackId: string | null;
  /** 그 곡의 북마크(U47). 없으면 0(처음부터) */
  startSec: number;
}

/** 곡 없음 — 빌더의 기본값이자, 큐 런타임이 값을 싣지 않았을 때의 뜻이다 */
const NO_ASSET_MUSIC: AssetMusic = { trackId: null, startSec: 0 };

/**
 * 지금 상태가 말하는 **이 영상의 배경 곡** (U124) — `victoryMusicOf`와 같은 자리다.
 *
 * 시작 지점이 북마크인 이유도 같다(U47): 빌려 온 팝송은 후렴부터 나가야 할 때가 있고, 그
 * 자리를 기억해 두는 장치가 이미 있다. 큐시트·런처·에셋 탭 세 입구가 **이 함수 하나**를
 * 통해야 세 곳에서 다른 지점부터 나가는 일이 없다.
 */
export function assetMusicOf(state: AppState, assetId: string | null | undefined): AssetMusic {
  const trackId = assetMusicTrackId(state.assets.find((a) => a.id === assetId));
  return { trackId, startSec: bookmarkOf(state.music.bookmarks, trackId) ?? 0 };
}

/**
 * full 영상을 **실제로 송출하는** 액션 (U124).
 *
 * ## 왜 함수로 뽑았나
 * 송출 입구가 셋이다 — 큐시트(`cueActions`), [영상·에셋] 카드의 `[▶ 재생]`(`ctx.playAsset`),
 * 속보 체인(`scheduleBreakingChain`). 각자 배열을 만들면 한쪽만 곡을 데려오는 어긋남이
 * 생긴다(U109 승리 송출에서 실제로 그랬다: 탭 버튼만 `scene/set`을 내 영상이 영영 안 나왔다).
 * **full 영상 송출의 정본은 이 함수 하나**이고, 세 입구는 이것을 부르기만 한다.
 *
 * ## 곡이 영상보다 **먼저** 실린다
 * 배열 순서가 계약이다. `dispatch`는 배열을 한 번에 리듀스하고 방송을 **한 번만** 내므로 두
 * 액션은 같은 프레임에 도착하지만, `music/play` 리듀서가 `ducked: false`를 쓰기 때문에 순서가
 * 뒤집히면 앞선 덕킹 상태 위에 영상만 얹히는 조합이 생길 수 있다. 곡을 먼저 세워 둔다.
 *
 * `fadeIn: false`(U122 컷인)인 이유: 이 곡은 영상이 시작되는 **그 순간** 들려야 한다.
 * U18 기본 크로스페이드(5초)를 타면 소개 영상의 앞부분이 사실상 무음으로 나간다 — 파일에
 * 오디오가 없어서 곡을 빌려 온 자리인데 그 앞 5초가 다시 비는 셈이다. 다른 곡이 울리고
 * 있었다면 그 곡의 페이드아웃(`musicFadeSec`)은 그대로 걸리고, 새 곡만 그 위에 즉시 겹친다.
 *
 * 정지 액션은 넣지 않는다 — 영상이 끝나도 곡은 계속 흐른다(승리 음악과 같은 규칙, U110).
 * 멈추는 시점은 다음 큐의 곡이 교체하거나 운영자가 [음악] 탭에서 정한다.
 */
export function fullVideoOutputActions(
  assetId: string,
  nextScene: SceneId | null,
  now: number,
  music: AssetMusic = NO_ASSET_MUSIC,
): Action[] {
  const out: Action[] = [];
  if (music.trackId) {
    out.push({ type: 'music/play', trackId: music.trackId, startSec: music.startSec, now, fadeIn: false });
  }
  // full 영상은 검정 페이드 상태 머신(covering→playing→revealing) 하나로 처리한다.
  // scene/set을 내지 않으므로 scene-routing의 스팅어 래핑을 타지 않는다(§11 M1).
  out.push({ type: 'video/playFull', assetId, nextScene, now });
  return out;
}

/**
 * 승리 큐를 눌렀을 때 **발표가 나가지 못하는 이유** (없으면 null, U100 · U110).
 *
 * 매치 큐의 `matchCueBlock`과 달리 이것은 **막지 않는다.** 승리 발표는 대본상 반드시
 * 지나가야 하는 자리라, 진행을 세우면 뒤로도 못 가는 사고가 난다(U36 실사고와 같은 이유).
 * 대신 "지금 무엇이 안 나갔는지"만 알린다 — 그래서 `goCue`의 건너뛰기 경로
 * (`matchCueBlock`)에는 이 값을 넘기지 않는다.
 */
export function victoryCueNotice(item: CueItem, runtime?: CueRuntime): string | null {
  if (!item.victoryEventId || !runtime) return null;
  return victoryOutputBlock(runtime.winner ?? null, runtime.assets);
}

/**
 * 이 큐 항목을 지금 실행할 수 없는 이유 (없으면 null).
 *
 * 매치 영상은 **조합을 고른 뒤에만** 의미가 있다. 조합 없이 [다음]을 누르면 조용히 지나가는
 * 대신 그 자리에 머물러야 운영자가 런처에서 조합을 고르고 다시 누를 수 있다.
 */
export function matchCueBlock(item: CueItem, runtime?: CueRuntime): string | null {
  if (!item.matchEventId) return null;
  // 화면부터 옮겨야 하는 경우는 "막힘"이 아니다 — 이 항목이 할 일(씬 이동)이 남아 있다.
  if (!matchCueOnRightScene(item, runtime)) return null;
  if (!runtime?.versus) return '대결 조합을 먼저 고르세요 — 런처 [대결팀 보더] 타일';
  return matchCueVideo(item, runtime) ? null : '이 조합의 매치 영상이 등록되어 있지 않습니다';
}

/** 큐 항목 하나를 상태에 적용하는 액션 목록 */
/**
 * @param transitionMode 이 큐 경계에만 적용할 전환 방식 (U42). `null`이면 전역을 따른다.
 *   여기서 하는 일은 **`scene/set`에 실어 보내는 것뿐**이다 — 해석은 중앙 경계
 *   (`scene-routing.ts`)가 한다. 큐가 직접 전환 액션을 내면 씬 소유자가 둘이 된다.
 *   영상 큐는 `scene/set`을 내지 않으므로(§2-3) 자연히 "시작 전 전환"에만 걸린다.
 */
export function cueActions(
  item: CueItem,
  index: number,
  now = Date.now(),
  runtime?: CueRuntime,
  transitionMode: SceneTransitionMode | null = null,
): Action[] {
  const out: Action[] = [{ type: 'cue/index', index, cueId: item.id }];
  const withMode = <T extends { type: 'scene/set' }>(action: T): T =>
    transitionMode ? { ...action, transitionMode } : action;
  if (item.phase) out.push({ type: 'phase/set', phase: item.phase });
  if (item.timer) out.push({ type: 'timer/preset', preset: item.timer.preset, durationSec: item.timer.sec });
  if (item.matchEventId) {
    // 다른 화면에서 곧장 눌렀으면 먼저 그 종목 대기화면으로 옮긴다 (전환 규칙 적용).
    // 영상은 여기서 얹지 않는다 — 스팅어가 도는 위에 오버레이를 겹치지 않기 위해서다.
    if (!matchCueOnRightScene(item, runtime)) {
      /**
       * 씬만 옮겼을 뿐 **이 큐를 실행하지 않았다.** 커서를 한 칸 앞에 두어야 다음 [다음]이
       * 이 항목을 다시 밟는다 — 여기 찍어 두면 `nextCueIndex`가 `i+1`을 줘서 매치 영상이
       * 통째로 건너뛰어진다(실제로 그랬다). 첫 항목이면 물러설 자리가 없으므로 그대로 둔다.
       */
      if (index > 0 && runtime?.prevCueId) {
        out[0] = { type: 'cue/index', index: index - 1, cueId: runtime.prevCueId };
      }
      out.push(
        withMode({
          type: 'scene/set',
          scene: 'game',
          opts: { game: { eventId: item.matchEventId, mode: 'standby' }, standby: { mode: 'main' } },
        } satisfies Extract<Action, { type: 'scene/set' }>),
      );
      return out;
    }
    // 조합이 없거나 그 조합의 영상이 없으면 오버레이만 빠진다. 진행 판정은 `matchCueBlock()`이 한다.
    const video = matchCueVideo(item, runtime);
    if (!video) return out;
    out.push({ type: 'overlay/play', assetId: video.assetId, holdEndFrame: true, now });
    // 영상 안 좌·우와 출력 보더 방향을 한 값에서 맞춘다.
    out.push({ type: 'sceneOpts/patch', patch: { liveOverlay: { versus: video.order } } });
    return out;
  }
  /**
   * 승리 영상 (U100, 2026-09-05 사용자 지시: "알파 포함된 영상이라 별도 트랜지션 없이 바로
   * 오버레이로 올라와야 해").
   *
   * ## 왜 여기에 전환이 안 걸리는가 — 구조로 보장한다
   * 씬 전환 래핑(`scene-routing.ts`의 `routeSceneActionsThroughDefaultTransition`)은
   * **`scene/set`만** 감싼다. 이 갈래는 `overlay/play` 하나만 내고 `scene/set`도
   * `transition/play`도 내지 않으므로, 전환을 "끄는" 코드가 따로 없어도 구조적으로 걸리지
   * 않는다(§2-3, 매치 영상과 같은 이유). 도입 페이드는 영상 알파에 bake 되어 있다.
   *
   * ## 아래 화면은 건드리지 않는다
   * `sceneOpts.game`도 패치하지 않는다 — 지금 보이는 화면(중계든 스코어보드든)이 그대로
   * 남아야 하고, 운영자가 `game` 씬에 서 있을 때 아래 그림이 말없이 바뀌는 것도 막는다.
   *
   * ## 끝은 매치 오버레이와 같은 규칙
   * `holdEndFrame: true` — 이 4편은 마지막 프레임 알파가 100% 불투명한 승리 보드다
   * (`ffmpeg alphaextract` 실측 YAVG=255). 매치 영상과 같은 관례로 붙잡아 두고, 다음 큐의
   * `scene/set`이 오버레이를 걷으며 그때의 전환 규칙을 그대로 탄다 — 끝 처리는 U100에서
   * 바뀌지 않았다.
   *
   * ## 영상 + 음악이다 (U110, 04:56 사용자 지시)
   * "송출보드 저건 폐기해. 내가 준 영상과 음악으로 대체하고." — 승리 보드 카드는 폐기됐고
   * 지정된 승리 음악이 있으면 `music/play`가 같은 배열에 함께 실린다. 영상이 없으면
   * **아무것도 내보내지 않는다**(빈 배열): 아래 화면이 그대로 남고 `victoryCueNotice`가
   * 어느 파일이 빠졌는지 토스트로 말한다.
   *
   * ## 송출의 정본은 `victoryOutputActions` 하나다 (U109)
   * [1부 컨트롤] 탭의 `[송출]` 버튼도 같은 함수를 부른다 — 두 입구가 각자 배열을 만들면
   * 한쪽만 오버레이를 타는 어긋남이 생긴다(U109 이전 탭 버튼이 실제로 그랬다).
   * 큐 경계 전환(U42)은 이 갈래에 실릴 자리가 없다 — `scene/set`을 아예 내지 않으므로
   * `withMode`가 감쌀 것이 없다(U110에서 카드 폴백이 사라져 그 마지막 자리도 없어졌다).
   */
  if (item.victoryEventId) {
    out.push(
      ...victoryOutputActions(
        runtime?.winner ?? null,
        runtime?.assets ?? [],
        now,
        runtime?.victoryMusic,
      ),
    );
    return out;
  }
  if (item.assetId) {
    if (item.assetPlayMode === 'transition') {
      out.push({
        type: 'transition/play',
        assetId: item.assetId,
        nextScene: item.videoNextScene ?? null,
        switchAtSec: item.switchAtSec ?? 0.5,
        now,
      });
      return out;
    }
    if (item.assetPlayMode === 'overlay') {
      out.push({
        type: 'overlay/play',
        assetId: item.assetId,
        holdEndFrame: item.holdEndFrame === true,
        now,
      });
      return out;
    }
    /**
     * full 영상은 **송출 정본 하나**를 부른다 (U124) — 배경 곡이 지정된 영상이면 `music/play`가
     * `video/playFull` **앞에** 같은 배열로 실린다. 컬링·신문지 소개 영상이 그 자리다:
     * 원본에 오디오 트랙이 없어 U120·U121에서 팝송을 빌려 왔고, 영상이 나가는 순간 그 곡이
     * 함께 걸려야 한다(2026-09-05 08:1x 사용자 지시). 이 영상들은 **덕킹 대상이 아니다** —
     * 내렸다가 곧바로 올리는 왕복은 `musicDuckSec`만큼 큐를 늦추기만 한다(`music-duck.ts`).
     *
     * 곡을 고르는 것은 큐가 아니다 — `runtime.assetMusic`을 읽어 싣기만 한다(승리 음악과 같은
     * 규칙, U110). 런타임이 없으면(테스트·간이 호출) 영상만 나간다.
     */
    out.push(
      ...fullVideoOutputActions(item.assetId, item.videoNextScene ?? null, now, runtime?.assetMusic),
    );
    return out;
  }
  /**
   * U92: '2부 전환 · 라이브 송출' 큐가 실행되는 순간 전역 전환 방식을 블랙으로 고정한다
   * (2026-09-04 사용자 지시). 이 큐 자체의 `scene/set`이 이미 블랙을 보도록 먼저 실어 보낸다.
   * 일회성 스위치다 — 락이 아니라서 이후 런처에서 사용자가 다시 바꿀 수 있고, 여기서
   * 다른 큐에 재적용하지 않는다.
   */
  if (item.id === 'part2-live') {
    out.push({ type: 'settings/patch', patch: { sceneTransitionMode: 'black' } });
  }
  out.push(
    withMode({ type: 'scene/set', scene: item.scene, opts: item.opts } satisfies Extract<
      Action,
      { type: 'scene/set' }
    >),
  );
  return out;
}

/** 잠금 상태에서 실행 가능한 다음 인덱스 (2부 항목은 건너뛴다) */
export function nextCueIndex(items: CueItem[], current: number, unlocked: boolean): number {
  let i = current + 1;
  while (i < items.length && items[i].locked && !unlocked) i += 1;
  return Math.min(i, items.length - 1);
}

export function prevCueIndex(items: CueItem[], current: number, unlocked: boolean): number {
  let i = current - 1;
  while (i >= 0 && items[i].locked && !unlocked) i -= 1;
  return Math.max(i, 0);
}

/**
 * `pre-mission`, 게임 대기, `part2-live`가 추가되기 전 배포 큐 순서. (U94, 2026-09-05: 한때 마지막
 * 항목이던 `planning-team`은 아예 제거됐다 — 이 배열에도 원래 없었으니 손댈 곳이 없다.)
 *
 * **여기에 새 항목을 넣지 않는다.** U60의 `oath`(개회식 다음)와 U71의 `victory-<종목>`
 * (점수 공개 앞)도 이 배열에는 없다 — 이 목록은 "그 시절 큐가 무엇이었나"의 기록이라
 * 나중에 늘어난 항목을 끼우면 옛 숫자 인덱스가 통째로 어긋난다. 새 항목은 안정 id를
 * 가지므로 `resolveCurrentCueIndex`의 cueId 경로로 복원된다.
 */
const LEGACY_CUE_IDS = [
  'open',
  ...P1_EVENT_ORDER.flatMap((eventId) => [`roster-${eventId}`, `live-${eventId}`, `score-${eventId}`]),
  'break',
  'breaking',
  ...(['s1', 's2', 's3'] as P2StageId[]).flatMap((stageId) => [`board-${stageId}`, `submit-${stageId}`]),
  'award',
  'end',
];

function legacyCueItems(items: CueItem[]): CueItem[] {
  const out: CueItem[] = [];
  for (const cueId of LEGACY_CUE_IDS) {
    const index = items.findIndex((item) => item.id === cueId);
    if (index < 0) {
      // `board-s<n>`(U97 이전 옛 자리)과 `submit-s<n>`(U112에서 큐 진입점을 없앤 제출 보드) 둘 다
      // 이제 그 단계의 대기화면(`p2-steady-<n>`)으로 접는다 — 둘 다 원래 "그 단계가 진행 중"을
      // 가리키던 자리이고, 큐에는 대기화면 하나만 남았기 때문이다. `submit-s<n>` 자체는 더 이상
      // 옛날 기록만이 아니라 **U112 배포 직전까지 실제로 저장될 수 있던 최신 cueId**이기도 해서
      // board-s<n>와 같은 폴백이 필요하다(그냥 건너뛰면 이 뒤 모든 legacy 숫자 위치가 밀린다).
      const formerBoardOrSubmit = /^(?:board|submit)-(s1|s2|s3)$/.exec(cueId);
      if (formerBoardOrSubmit) {
        const gameNumber = formerBoardOrSubmit[1].slice(1);
        const steadyIndex = items.findIndex((item) => item.id === `p2-steady-${gameNumber}`);
        if (steadyIndex >= 0) out.push(items[steadyIndex]);
      }
      // roster-sync는 U55에서 없앤 자리다. 대체 항목을 넣지 않고 그냥 건너뛰면 이 뒤(live-sync 이후)
      // 모든 legacy 숫자 위치가 한 칸씩 당겨져 옛 저장본의 숫자 인덱스 복원이 전부 어긋난다
      // (board-*와 같은 이유 — 한 legacy id당 반드시 하나씩 push해 정렬을 지킨다).
      const formerRoster = /^roster-(curling|newspaper|sticky|sync)$/.exec(cueId);
      if (formerRoster) {
        const standbyIndex = items.findIndex((item) => item.id === `game-standby-${formerRoster[1]}`);
        if (standbyIndex >= 0) out.push(items[standbyIndex]);
        /**
         * **알려진 한계** (리뷰 지적): 아래 정상 경로는 항목 뒤에 붙은 `video:` 항목까지 이어
         * 담지만, 이 폴백은 대체 항목 하나만 담는다. 그래서 그 대기 항목 뒤에 영상이 등록돼
         * 있으면 여기서부터 legacy 숫자 위치가 그 영상 수만큼 어긋난다.
         *
         * 지금 고치지 않는 이유: 이 경로는 **숫자 인덱스만 있고 `cueId`가 없는** 아주 오래된
         * 저장본에서만 탄다(`resolveCurrentCueIndex`는 `cueId`가 있으면 그쪽을 먼저 쓴다).
         * 그런 저장본에는 운영자가 올린 동적 영상도 없다시피 해 실제로 어긋날 자리가 거의 없고,
         * 폴백에 수집 루프를 붙이면 `board-*` 폴백과 규칙이 갈려 다음 사람이 어느 쪽이 맞는지
         * 판단할 근거를 잃는다. 옛 저장본 복원이 실제로 어긋나는 사례가 나오면 그때 두 폴백을
         * 함께 정상 경로와 같은 수집 규칙으로 올린다.
         */
      }
      continue;
    }
    out.push(items[index]);
    for (let i = index + 1; i < items.length && items[i].id.startsWith('video:'); i += 1) out.push(items[i]);
  }
  return out;
}

/**
 * 현재 큐의 안정적인 ID를 우선 사용한다. cueId가 없는 저장본은 `pre-mission`이
 * 추가되기 전 배열(첫 항목 `open`)의 숫자 위치로 해석해 기존 진행점을 보존한다.
 */
export function resolveCurrentCueIndex(items: CueItem[], cueId: string | null | undefined, legacyIndex: number): number {
  if (items.length === 0) return 0;
  const safeIndex = Number.isFinite(legacyIndex) ? Math.max(0, Math.trunc(legacyIndex)) : 0;

  if (cueId) {
    // `board-s<n>`(옛 자리)과 `submit-s<n>`(U112에서 큐 진입점을 없앤 제출 보드 — U112 배포
    // 직전까지는 실제로 저장될 수 있던 cueId다) 둘 다 그 단계의 대기화면으로 접는다.
    const formerBoardOrSubmit = /^(?:board|submit)-(s1|s2|s3)$/.exec(cueId);
    if (formerBoardOrSubmit) {
      const gameNumber = formerBoardOrSubmit[1].slice(1);
      const steadyIndex = items.findIndex((item) => item.id === `p2-steady-${gameNumber}`);
      if (steadyIndex >= 0) return steadyIndex;
    }
    const formerOpening = /^game-opening-(curling|newspaper|sticky|sync)$/.exec(cueId);
    if (formerOpening) {
      const eventId = formerOpening[1] as P1EventId;
      const introId = `video:media:${P1_INTRO_FILE[eventId]}`;
      const introIndex = items.findIndex((item) => item.id === introId);
      if (introIndex >= 0) return introIndex;
      const standbyIndex = items.findIndex((item) => item.id === `game-standby-${eventId}`);
      if (standbyIndex >= 0) return Math.max(0, standbyIndex - 1);
    }
    const byId = items.findIndex((item) => item.id === cueId);
    // 현재 동적 영상이 삭제됐다면 그 직전 슬롯을 현재 anchor로 삼는다.
    // 그러면 다음 조작이 삭제된 영상의 후속 큐를 정확히 실행하며 건너뛰지 않는다.
    return byId >= 0 ? byId : Math.min(Math.max(0, safeIndex - 1), items.length - 1);
  }

  const legacyItems = legacyCueItems(items);
  const legacyItem = legacyItems[Math.min(safeIndex, Math.max(0, legacyItems.length - 1))];
  if (!legacyItem) return 0;
  const currentIndex = items.findIndex((item) => item.id === legacyItem.id);
  return currentIndex >= 0 ? currentIndex : 0;
}
