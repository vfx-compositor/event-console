/**
 * Event Console — 단일 상태 모델 타입 정의
 *
 * 원칙:
 *  - 상태는 순수 JSON 직렬화 가능해야 한다 (P4 생존: localStorage / IndexedDB 스냅샷 / JSON 내보내기).
 *  - Blob(영상)만 IndexedDB에 별도 보관하고, 상태에는 메타(id/name/type)만 남긴다.
 */

// 순수 데이터 서술자(순환 없음: fade-ramp → fade, 둘 다 types를 import하지 않는다)
import type { ValueRamp } from './fade-ramp';
import type { MusicBookmarks } from './music-bookmarks';
import type { MusicRepeatMode } from './music-autoplay';
import type { LiveFrameMode } from './live-frame';
import type { CueTransitions } from './cue-transitions';

/**
 * 팀 슬롯은 저장본 호환을 위해 6개로 **고정**하고, 이번 행사에서 실제로 쓰는 팀은 앞 4개다.
 * (Record<TeamId, X> 를 항상 전부 채운 완전한 맵으로 유지하면 순위·제출·명단 맵에
 *  구멍이 생기지 않아 직렬화/마이그레이션이 단순해진다. 비활성 슬롯은 그냥 0점이다.)
 */
export type TeamId = 't1' | 't2' | 't3' | 't4' | 't5' | 't6';
export const TEAM_IDS: TeamId[] = ['t1', 't2', 't3', 't4', 't5', 't6'];

export const MIN_TEAM_COUNT = 4;
export const MAX_TEAM_COUNT = 6;
/** 이번 행사의 확정 참가 팀 수. 슬롯은 호환을 위해 6개 보존하지만 활성 팀은 항상 4개다. */
export const CONFIRMED_TEAM_COUNT = 4;
export const DEFAULT_TEAM_COUNT = CONFIRMED_TEAM_COUNT;

/** 앞에서부터 count개의 팀 슬롯 id */
export function teamIdsFor(count: number): TeamId[] {
  const n = Math.max(MIN_TEAM_COUNT, Math.min(MAX_TEAM_COUNT, Math.round(count)));
  return TEAM_IDS.slice(0, n);
}

export type Phase = 'pre' | 'p1' | 'break' | 'p2' | 'award' | 'end';

export type P1EventId = 'curling' | 'newspaper' | 'sticky' | 'sync';
export type P2StageId = 's1' | 's2' | 's3';
export type EventStatus = 'pending' | 'live' | 'done';

export type SceneId =
  | 'standby'
  | 'game'
  | 'live'
  | 'score'
  | 'timer'
  | 'roster'
  | 'prompt'
  | 'breaking'
  | 'video'
  | 'photos'
  | 'suspects'
  | 'submit'
  | 'award';

/** 1부 중에는 렌더 자체가 금지되는 씬 묶음 (P3 비밀 유지) */
export const P2_SCENES: SceneId[] = ['breaking', 'suspects', 'submit'];

export interface Team {
  id: TeamId;
  name: string;
  color: string;
  /**
   * 로고 이미지가 담긴 IndexedDB 에셋 id.
   * base64를 상태에 넣으면 localStorage 5MB 한도를 조용히 넘겨 **저장 전체가 실패**한다(P4 위반).
   * 그래서 blob은 IndexedDB에, 상태에는 id만 남긴다. 화면에서는 `logos.ts`가 objectURL로 풀어 준다.
   */
  logoAssetId?: string;
  /** 구버전 저장본 호환 — 새로 만들지 않는다 (마이그레이션 시 에셋으로 옮긴다) */
  logoDataUrl?: string;
}

export type RankMap = Record<TeamId, number | null>;

export type CurlingMatchId = 'semi1' | 'semi2' | 'bronze' | 'final';

export interface CurlingMatch {
  teams: [TeamId | null, TeamId | null];
  winner: TeamId | null;
}

export interface CurlingBracket {
  semi1: CurlingMatch;
  semi2: CurlingMatch;
  bronze: CurlingMatch;
  final: CurlingMatch;
}

export interface P1Event {
  id: P1EventId;
  name: string;
  status: EventStatus;
  /** 현재 입력·확정하는 경기 회차 (1부터 시작) */
  round: number;
  /** 1~N 순위(N = 팀 수). null = 미입력. 동점(같은 값) 허용 → 공동 순위 평균 점수 */
  ranks: RankMap;
  /** 확정되어 원장에 반영된 시각 (ISO). null = 미확정 */
  confirmedAt: string | null;
  /** 종목별 출전 명단 (팀별 자유 텍스트) */
  roster: Record<TeamId, string>;
  /** 컬링 전용 4팀 토너먼트 승패표 */
  curling?: CurlingBracket;
  /** 끈끈이 낚시 점수 / 몸으로 말해요 성공 라운드 수 */
  values?: Record<TeamId, number | null>;
  /** 신문지 달리기 팀별 2명 기록(초) */
  newspaperTimes?: Record<TeamId, [number | null, number | null]>;
}

export interface Submission {
  /**
   * epoch ms — **단, `remainingSec`이 있으면 시각이 아니라 `-remainingSec * 1000`이다** (U135).
   * 남은 시간이 많을수록 값이 작아 `rankSubmissions`의 오름차순 정렬에서 먼저 온다.
   */
  at: number;
  correct: boolean;
  /**
   * 수기로 적은 **남은 시간**(초). U135 — "많이 남은 팀이 승리".
   * 없으면 시각 제출(`at`이 실제 epoch ms). 사상 근거는 `src/p2-remaining.ts` 주석 참고.
   */
  remainingSec?: number;
}

export interface P2Stage {
  id: P2StageId;
  name: string;
  status: EventStatus;
  submissions: Record<TeamId, Submission | null>;
  ranks: RankMap;
  confirmedAt: string | null;
}

export interface P2State {
  unlocked: boolean;
  stages: P2Stage[];
  /** 탈락 처리된 용의자 코드 */
  eliminated: string[];
}

export interface LedgerEntry {
  id: string;
  /** epoch ms */
  ts: number;
  teamId: TeamId;
  delta: number;
  reason: string;
  /** 'p1:curling' | 'p2:s1' | 'manual' 등 — 역분개 대상 묶음 키 */
  ref: string;
  /** 역분개 항목이면 원본 entry id */
  reverseOf?: string;
}

export type TimerPreset =
  | 'sticky60'
  | 'sync15'
  | 'stage8'
  | 'stage10'
  | 'stage12'
  | 'custom';

export interface TimerState {
  preset: TimerPreset;
  durationSec: number;
  /** 구동 중이면 epoch ms, 정지 상태면 null */
  startedAt: number | null;
  /** 일시정지 시점의 잔여 초. 리셋 상태면 null */
  pausedRemaining: number | null;
}

/**
 * 슬로우 리플레이 재생 지시 (Q5 A안 · 2026-09-04 00:43 사용자 선택).
 *
 * `seconds`·`rate`를 여기 굳혀 두는 이유는 `video.fadeSec`과 같다 — 재생 도중 설정 탭에서
 * 값을 바꿔도 **이번 재생**은 흔들리지 않아야 한다.
 */
export interface LiveReplay {
  /** 이 재생의 단조 토큰. display의 종료 보고는 이 값과 맞을 때만 받아들인다 */
  token: number;
  /**
   * 이번 재생에 고정된 되감기 길이(초).
   *
   * 기본 경로(`R`·왼쪽 반쪽)에서는 `settings.replaySec`(정수 3~30)이 그대로 들어온다.
   * [지금부터] 경로(U85)는 **찍은 순간부터 지금까지**를 재므로 소수가 나온다(예: 4.3초).
   * 그래서 정규화가 `normalizeReplaySec`(정수·최소 3초)이 아니라
   * `normalizeReplaySegmentSec`(소수 허용·최소 1초)이다 — 정수로 반올림하면 운영자가
   * 찍은 구간보다 길거나 짧은 화면이 나간다.
   */
  seconds: number;
  /** 이번 재생에 고정된 배속 (`REPLAY_RATES` 중 하나 — 0.1 · 0.25 · 0.5 · 0.75 · 1) */
  rate: number;
  /** 재생을 건 시각 (epoch ms) */
  startedAt: number;
}

export interface SceneOpts {
  standby: {
    /**
     * `oath`는 선수 선서 안내 이미지 한 장이다 (U60). `pre-mission`과 같은 "씬 붙박이 그림"
     * 이라 매니페스트에 올리지 않는다 — 등록 여부에 따라 화면이 달라지면 안 된다.
     */
    mode: 'main' | 'pre-mission' | 'oath';
  };
  game: {
    eventId: P1EventId;
    /**
     * `victory` 모드는 **폐기됐다** (U110, 2026-09-05 04:56 사용자 지시: "송출보드 저건 폐기해.
     * 내가 준 영상과 음악으로 대체하고."). 승리 발표는 이제 씬이 아니라 `winner_<색>.webm`
     * 알파 오버레이 + 승리 음악이다 — 이 씬은 다시 오프닝·대기 둘뿐이다.
     * 저장본에 남은 `'victory'`는 `migrate`가 `'standby'`로 접는다.
     */
    mode: 'opening' | 'standby';
    /**
     * 승리 발표에 쓸 팀 (U71 → U110).
     *
     * 원장에서 1위를 파생하지 않고 **명시 필드**로 둔다 — 동점·미입력일 때 화면이 무엇을
     * 띄울지가 애매해지고, "화면이 조용히 거짓말하지 않는다"는 원칙이 깨진다. 컨트롤이
     * 원장 1위를 기본 선택으로 프리필하고, 최종 결정은 운영자가 누른 버튼이다.
     *
     * U110 이후 이 값이 고르는 것은 **어느 승리 영상을 트는가**다(`winner-video.ts`).
     * `null`이면 발표할 영상이 없어 아무것도 나가지 않는다(카드 폴백은 폐기됐다).
     * 씬 렌더에는 더 이상 쓰이지 않지만, 값의 주인이 [1부 컨트롤] 탭이라는 계약(U71)과
     * 큐·탭 두 입구가 같은 값을 읽는다는 계약(U109)은 그대로다.
     */
    winner: TeamId | null;
  };
  liveOverlay: {
    scorebar: boolean;
    timer: boolean;
    /** 좌상 종목 배지에 쓸 1부 종목 id (null이면 배지 숨김) */
    badge: P1EventId | null;
    /** 좌우 컬러 보더로 강조할 대결 팀 (없으면 공통 톤) */
    versus: [TeamId, TeamId] | null;
    /**
     * 카메라 위에 얹는 붙박이 프레임 (U118). `none`이면 맨 카메라 그대로다.
     *
     * `dark-standby`는 대기 화면의 알파 다크 영상(`main_05_dark.webm`) 한 장을 카메라 위에
     * 얹는다 — 사진 백드롭 자리를 라이브가 대신한다. 근거·판정은 `src/live-frame.ts`.
     *
     * **화이트리스트 계약이다** (`standby.mode`·`submit.mode`와 같은 자리) — 모르는 값은
     * migrate가 `none`으로 접는다. 지금 이 값을 켜는 곳은 `part2-live` 큐 하나이고,
     * `scene/set`이 **명시하지 않은 씬 전환마다 `none`으로 되돌린다**(끈적임 방지).
     */
    frame: LiveFrameMode;
    /**
     * 지금 돌고 있는 슬로우 리플레이 (Q5 A안). `null`이면 라이브 그대로다.
     *
     * **런타임 필드다** — 저장본에서 되살아나면 안 되지만 `migrate()`가 지우면 display가
     * 방송으로 이 지시를 한 번도 못 본다(설명 영상 `video.phase`와 같은 계약). 끊는 자리는
     * 저장본을 인수하는 `resetRuntimeVideoPhase()`와 중계 화면을 떠나는 `scene/set`뿐이다.
     */
    replay: LiveReplay | null;
    /**
     * 단조 증가 리플레이 토큰. `replay`가 null이 되어도 **줄지 않는다** —
     * 재생마다 0부터 세면 정지 직후 다시 튼 재생이 이전 재생의 늦은 종료 보고와
     * 우연히 맞아떨어져 그 자리에서 죽는다(설명 영상 `phaseToken`과 같은 방어).
     */
    replayToken: number;
    /**
     * [지금부터] 구간 시작점 (epoch ms). `null`이면 찍어 둔 구간이 없다 (U85).
     *
     * ## 왜 이 필드가 필요한가
     * 사용자 원문: "10초는 좀 긴 것 같아 … '지금부터' 버튼을 만들어줘. 그걸 누르면 누른 시점
     * 1초 전부터 메모리에 담겨서 그 구간만큼만 재생되도록." 되감을 길이를 미리 정해 두는
     * 대신 **운영자가 두 번 눌러 구간을 잡는다** — 찍고(`now - 1000`), 다시 눌러 그 구간을 튼다.
     * 1초를 앞당겨 잡는 이유는 "지금이다" 싶어 손이 가는 순간에는 이미 그 장면이 지나갔기 때문이다.
     *
     * **런타임 필드다** — `replay`와 같은 계약이다. 저장본에서 되살아나면 안 되지만
     * `migrate()`가 지우면 방송이 이 값을 나르지 못해 보조 창의 버튼이 거짓말을 한다.
     * 끊는 자리는 `resetRuntimeVideoPhase()`와 중계 화면을 떠나는 `moveScene()`뿐이고,
     * 재생이 시작되면(`live/replay`) 그 자리에서 비워진다.
     */
    replayMarkAt: number | null;
  };
  video: {
    assetId: string | null;
    nextScene: SceneId | null;
    /** 패널에서 건 일시정지 (display가 그대로 따른다) */
    paused: boolean;
    /** 값이 바뀌면 display가 처음부터 다시 재생한다 */
    restartToken: number;
    /** 페이드 래핑 단계. 'idle'이면 기존(페이드 없는) 동작 그대로 */
    phase: 'idle' | 'covering' | 'playing' | 'holding' | 'revealing';
    /** 단조 토큰 — stale 사건 거부용 (전환 영상의 restartToken과 같은 역할) */
    phaseToken: number;
    /** 이 재생에 적용된 페이드 길이(초) — 재생 도중 설정을 바꿔도 이번 재생은 흔들리지 않는다 */
    fadeSec: number;
    /** nextScene이 null일 때 복귀할 씬 (재생 직전 씬) */
    returnScene: SceneId | null;
    /** 이번 재생이 끝난 뒤 마지막 프레임을 유지하는가 */
    holdEndFrame: boolean;
    /**
     * 대본이 못 박은 아웃트로 (U87). `null`이면 지금까지대로 검정 꼬리 페이드다.
     *
     * 꼬리(`playing`의 tail)와 `revealing`에만 걸린다 — `covering`(영상으로 들어가는 페이드)은
     * 언제나 검정이다. 들어갈 때까지 흰색으로 덮으면 아무도 요청하지 않은 화이트 플래시가
     * 영상 **앞**에도 생긴다.
     */
    outro: { fadeSec: number; color: string; revealSec: number } | null;
  };
  transitionVideo: {
    active: boolean;
    assetId: string | null;
    nextScene: SceneId | null;
    /** 영상이 화면을 충분히 덮은 뒤 underlying scene을 교체할 재생 시각 */
    switchAtSec: number;
    /** 동일 에셋 재실행·stale 이벤트 구분용 단조 토큰 */
    restartToken: number;
    /** 다음 씬 교체 이벤트를 이미 반영했는지 */
    switched: boolean;
    /**
     * 씬 교체와 **같은 순간에** 적용할 대기 화면 모드 (U35).
     *
     * 사전미션 ↔ 메인 대기는 씬이 둘 다 `standby`이고 이 모드만 다르다. 그래서 모드를
     * 액션과 함께 즉시 패치하면 스팅어가 화면을 덮기 전에 배경이 바뀌어 버린다.
     * `nextScene`과 똑같이 `switchAtSec`까지 들고 있다가 한 번에 넘긴다. `null`이면 변경 없음.
     */
    nextStandbyMode: SceneOpts['standby']['mode'] | null;
  };
  /**
   * 운영자 암전 (U65) — **화면만** 검게 덮는다. 소리는 건드리지 않는다.
   *
   * `sceneFade`와 다른 축인 이유는 `blackout.ts` 첫 주석에 있다(왕복이 아니라 머무는 상태이고,
   * 씬을 바꾸지 않으므로 `scene-routing.ts` 경계를 타지 않는다).
   *
   * **런타임 필드다** — 새로고침 뒤 검은 화면으로 깨어나면 안 되지만, 끊는 자리는 migrate가
   * 아니라 저장본을 인수하는 `resetRuntimeVideoPhase()`다(영상 페이드·리플레이와 같은 계약).
   * migrate가 지우면 display가 방송으로 암전 지시를 한 번도 못 본다.
   */
  blackout: {
    /** 목표 상태. true면 검정으로, false면 투명으로 향한다 */
    active: boolean;
    /** 이번 램프가 시작된 시각(epoch ms) */
    startedAt: number;
    /**
     * 램프 시작 순간의 **실제 불투명도**. 램프 도중 뒤집어도 값이 튀지 않는 유일한 근거다
     * (`fade-ramp.ts`의 `ValueRamp.from`과 같은 역할). 지속시간은 여기서 목표까지의
     * 거리로 파생되므로 상태에 따로 두지 않는다.
     */
    fromOpacity: number;
  };
  /** 화이트/블랙 컬러 페이드 씬 전환 */
  sceneFade: {
    active: boolean;
    color: '#000000' | '#ffffff';
    nextScene: SceneId | null;
    durationSec: number;
    restartToken: number;
    switched: boolean;
    /** 페이드가 화면을 덮은 순간에 적용할 대기 화면 모드 (U35). `null`이면 변경 없음. */
    nextStandbyMode: SceneOpts['standby']['mode'] | null;
  };
  /** 현재 씬 위 알파 그래픽. 매치 영상은 도입 스팅어가 bake되어 별도 전환 없이 시작한다. */
  overlayVideo: {
    active: boolean;
    assetId: string | null;
    restartToken: number;
    holdEndFrame: boolean;
    held: boolean;
  };
  moodTransition: {
    active: boolean;
    /**
     * `glitch`(현재 화면을 망가뜨림) → `blackout`(검정으로 덮음) → `crossfade`(사전렌더 영상).
     * 반전 영상이 검정에서 시작하므로 그 앞에 검정 단계를 두어야 컷이 아니라 넘어감이 된다.
     */
    phase: 'idle' | 'glitch' | 'blackout' | 'crossfade';
    assetId: string | null;
    token: number;
  };
  roster: {
    eventId: P1EventId;
    /**
     * 명단 보드가 보여 줄 범위 (U61).
     *
     * `all` — 활성 4팀 전체 그리드 (기본, 지금까지의 동작).
     * `heat` — 이번 조 두 팀만. 조는 런처 대결 타일이 고른 `liveOverlay.versus`를 그대로
     *   쓴다(따로 조 필드를 두면 운영자가 같은 조를 두 번 고르게 된다). 대결이 아니므로
     *   `rs__vs`·`rs__duel`이 아니라 두 칸짜리 그리드로 그린다.
     */
    scope: 'all' | 'heat';
  };
  prompt: { category: string; text: string; round: number; countdown: number | null };
  submit: {
    stageId: P2StageId;
    /**
     * 후반 각 단계의 화면 모드 (U97).
     *
     * `board` — 지금까지의 제출 상태 바 (기본값).
     * `steady` — 그 단계의 대기 이미지 한 장 (`P2_STEADY_IMAGES`). 게임을 설명하기 전,
     *   진행자가 말하는 동안 띄워 두는 화면이다.
     *
     * **모드를 `suspects`가 아니라 여기 두는 이유**: 단계 id(`stageId`)가 이미 여기 있다.
     * 다른 씬에 모드를 두면 "지금 몇 단계인가"가 두 곳에 생겨, 큐가 한쪽만 갱신했을 때
     * 대기 이미지와 보드가 서로 다른 단계를 그린다.
     */
    mode: 'board' | 'steady';
  };
  award: {
    step: AwardStep;
    /** 구 순차 공개 저장본 호환 슬롯 */
    revealed: number;
    rankRevealed: boolean;
    /** 현장 운영자가 직접 선택한 1-based 등수 */
    selectedRank: number | null;
    selectedTeamRevealed: boolean;
    /** 팀까지 공개 완료한 등수의 운영 이력 */
    revealedRanks: number[];
    /**
     * 한 팀씩 **독립** 공개인가 (U127, 2026-09-05 사용자 지시:
     * "최종 순위 발표 때 다른 팀 안 보이게 하고 4위 팀만 공개, 이런 식으로 독립으로 구분").
     *
     * 켜져 있으면 `reveal` 단계 무대에 **지금 고른 등수 한 장만** 선다 — 이미 공개한 등수의
     * 이력 카드(`award__reveal-history`)를 만들지 않는다. "가리는" 것이 아니라 **DOM에 넣지
     * 않는다**: U89 점수 공개 씬이 다른 종목을 렌더하지 않는 것과 같은 규칙이고, 미공개 팀
     * 비노출 계약(`scenes/award.ts` 첫 주석)이 여기서도 그대로 성립한다.
     *
     * `false`면 U70까지의 누적 무대(왼쪽 이력 + 오른쪽 스포트라이트) 그대로다. 옛 저장본은
     * 이 필드가 없어 `migrate()`에서 `false`로 내려앉고, 새 선택(`award/selectRank`)은
     * 기본이 `true`다 — 최종 순위 발표의 정상 모양이 독립 공개이기 때문이다.
     *
     * 등수만 노출하고 팀을 가리는 **두 박자**(U70 `selectedTeamRevealed`)와는 다른 축이다.
     * 독립 공개 안에서도 두 박자는 그대로 돈다: `solo && !selectedTeamRevealed` = 그 등수
     * 자리만, `solo && selectedTeamRevealed` = 그 팀 카드 한 장만.
     */
    solo: boolean;
  };
  score: { highlight: P1EventId | null };
}

export type MoodDistortMode = 'pixel-sort-vertical' | 'pixel-sort-horizontal' | 'glitch-only';

export type AwardStep = 'p1' | 'p2' | 'total' | 'reveal' | 'winner';

/**
 * 출력 볼륨 축 (U45) — **엘리먼트 종류**로 나눈다.
 * 씬이나 상황으로 나누면 같은 엘리먼트가 프레임마다 다른 축에 속해 그 경계에서 소리가 튄다.
 */
export type VolumeAxis = 'media' | 'music';

export type VolumeRamps = Record<VolumeAxis, ValueRamp | null>;

export type VideoPlayMode = 'full' | 'transition' | 'overlay';
export type SceneTransitionMode = 'black' | 'white' | 'stinger';

/** 출발→도착 조합 예외 규칙. 규칙 중 가장 높은 우선순위 */
export interface TransitionPairRule {
  from: SceneId;
  to: SceneId;
  assetId: string;
}

export interface TransitionRules {
  /** 아무 규칙도 안 걸린 전환에 쓸 기본 대판. null이면 legacy 폴백(첫 정상 transition 에셋) */
  defaultAssetId: string | null;
  /** 도착 씬별 지정 */
  byTo: Partial<Record<SceneId, string>>;
  /** 출발→도착 조합 예외 (가장 높은 우선순위) */
  pairs: TransitionPairRule[];
}

export interface AssetMeta {
  id: string;
  name: string;
  type: 'video' | 'image';
  size: number;
  mime: string;
  /** 영상 길이(초). 등록 시 첫 프레임과 함께 뽑아 둔다 */
  durationSec?: number;
  /** 목록용 썸네일 (첫 프레임, 160px 축소 — 작아서 상태에 둬도 안전) */
  thumbDataUrl?: string;
  /** 재생이 끝나면 넘어갈 씬 (기본 standby) */
  nextScene?: SceneId | null;
  /** full=풀스크린, transition=씬 교체 스팅어, overlay=현재 씬 위 알파 그래픽 */
  playMode?: VideoPlayMode;
  /** transition 모드에서 underlying scene을 교체할 재생 시각 */
  switchAtSec?: number;
  /** 큐시트에서 이 항목 **다음**에 재생한다 (기본 큐 항목 id). 없으면 큐에 넣지 않는다 */
  cueAfter?: string | null;
  /** 목록·큐시트 정렬 순서 */
  order?: number;
  /** 등록 시 브라우저가 이 영상을 열지 못했다 — 재생도 실패할 가능성이 높다 */
  probeFailed?: boolean;
  /** media manifest의 동일 파일 교체 여부를 판별하는 버전 키 */
  sourceRevision?: string;
  /** full 모드 전용 — 재생 시 소리를 낸다. 기본 true. transition 모드에서는 무시(항상 무음) */
  audio?: boolean;
  /** `audio` 값을 **누가** 정했는가 (U84). {@link AudioSource} */
  audioSource?: AudioSource;
  /**
   * 파일이 교체됐는데(revision 변경) 사람이 고른 소리 설정을 그대로 지킨 상태 (U84).
   * 카드에 [⚠ 소리 확인] 칩을 띄워 새 파일에 그 설정이 맞는지 한 번 보게 한다.
   * 소리 버튼을 다시 누르면 내려간다.
   */
  audioRecheck?: boolean;
  /** full 모드 전용 — 종료 시 자동 전환하지 않고 마지막 프레임에서 사회자 진행을 기다린다 */
  holdEndFrame?: boolean;
  /**
   * full 모드 전용 — 이 영상이 재생과 함께 **데려오는 배경 곡** (U124, 음악 라이브러리 id).
   *
   * 세 상태를 구분한다: `undefined`(한 번도 정한 적 없음 → `INTRO_MUSIC_DEFAULTS` 표 값이
   * 한 번 승격된다), `null`(운영자가 "없음"으로 비웠다 → 표가 도로 덮지 않는다), 문자열(그 곡).
   * `asset.audio`(U84 무음 판정)와 **독립된 축**이다 — 소리 있는 영상에 곡을 걸면 겹쳐서 나간다.
   * 근거와 해석 규칙은 `asset-music.ts` 머리말.
   */
  musicTrackId?: string | null;
}

/**
 * 저장된 `audio` 값의 출처 (U84).
 *
 * 왜 필요한가: manifest 가 `audio` 를 명시하면(U55) 그 값이 새 프로필의 씨앗이 되어 그대로
 * IndexedDB 에 저장된다. 그 뒤로는 저장값이 manifest 보다 우선하므로, **manifest 를 고쳐도
 * 이미 씨앗을 받은 프로필에는 영원히 닿지 않는다** — `intro_one_mind.mp4`(몸으로 말해요)가
 * AAC 트랙을 가졌는데도 manifest 오기재 때문에 무음으로 굳은 실사고(2026-09-04)의 원인이다.
 *
 * 우선순위는 `'operator'` > `'manifest'` > `'probe'` > 기본값(소리 있음).
 *
 * - `'operator'` 사람이 [영상·에셋] 탭의 [🔊 소리 켬 / 🔇 무음]으로 고른 값. 항상 이긴다.
 * - `'manifest'` manifest 가 `audio` 로 못 박은 값. 파일이 무엇이든 이 선언을 따른다
 *   (스팅어·매치 오버레이처럼 "절대 소리 내지 않는다"가 운영 결정인 경우).
 * - `'probe'` 등록할 때 파일을 직접 열어 오디오 트랙 유무를 확인한 값. **파일이 정답이므로**
 *   파일을 갈아 끼우면 다시 확인해 자동으로 따라간다 — manifest 표를 손보지 않아도 된다.
 *
 * 이 필드가 없는 옛 저장본은 `'manifest'` 로 본다 — 저장값이 그때의 manifest 선언과 같은지
 * 알 수 없으므로, 정정이 전파되는 쪽을 택한다. 사람이 고쳐 둔 값이 한 번 되돌아갈 수 있고,
 * 그때는 토글을 한 번 더 눌러 `'operator'` 로 굳히면 된다.
 */
export type AudioSource = 'manifest' | 'operator' | 'probe';

export type PhotoOrder = 'time' | 'random';

/**
 * 현장에서 수집한 사진 한 장의 **메타만** 담는다 — blob·썸네일은 IndexedDB(`photos`/`photoThumbs`).
 *
 * 썸네일 dataURL을 여기에 넣으면 500장 = 약 6MB로 localStorage 저장 전체가 즉사한다
 * (`AssetMeta.thumbDataUrl`은 에셋이 한 자릿수라 성립한 예외다).
 */
export interface PhotoMeta {
  /**
   * 파일 신원 키 그 자체 = `name|bytes|lastModified` — 같은 파일은 몇 번을 흡수해도 같은 id.
   * 해시를 쓰지 않는 이유: 충돌하면 "사진 한 장이 조용히 안 들어온다"는 형태로 사고가 나는데
   * 현장에서 알아챌 방법이 없다. 500건에 +20KB를 내고 충돌 가능성을 0으로 만든다.
   */
  id: string;
  /** 원본 파일명. **display는 이 값을 절대 렌더하지 않는다** (1부 잠금 계약) */
  name: string;
  /** 촬영 시각(EXIF DateTimeOriginal). 없으면 파일 수정 시각. epoch ms */
  takenAt: number;
  /** 콘솔이 흡수한 시각. epoch ms */
  addedAt: number;
  /** 다운스케일 **후** 픽셀 크기 */
  w: number;
  h: number;
  /** 다운스케일 후 blob 바이트 (원본 크기가 아니다 — 원본은 보관하지 않는다) */
  bytes: number;
  /** 운영자가 송출에서 뺀 사진. 목록에는 남는다(되돌릴 수 있어야 한다) */
  hidden: boolean;
  /**
   * **흡수 시점에 2부가 해제돼 있었는가** (reducer가 `state.p2.unlocked`를 읽어 찍는 도장).
   *
   * 1부 송출 화면에 2부 현장 사진(속보·수사·용의자 대목에서 찍힌 것)이 섞이면 그 자체가
   * 스포일러다. `p2/unlock`에는 타임스탬프가 없어 사후에 "이 사진이 2부 것인가"를 판정할
   * 방법이 없으므로, 판정이 가능한 유일한 시점인 **흡수할 때** 스탬프를 남긴다.
   * 잠금 중에는 `photoQueue(..., unlocked=false)`가 `hidden`과 똑같이 큐에서 뺀다.
   */
  p2: boolean;
}

export interface PhotoSettings {
  /** 사진 한 장 표시 시간(초). 2~30 클램프, 기본 5 */
  intervalSec: number;
  /** 느린 Ken Burns. reduce-motion이면 이 값과 무관하게 꺼진다 */
  kenBurns: boolean;
  order: PhotoOrder;
  /** 폴더 자동 수집 on/off. 폴더 핸들 자체는 IndexedDB(상태는 순수 JSON이어야 한다) */
  autoIntake: boolean;
  /** 사진 색조를 따뜻한 인화지 톤으로 바꾼다 */
  sepia: boolean;
  /** 사진 가장자리를 어둡게 눌러 중앙을 강조한다 */
  vignette: boolean;
  /** 사진 위에 저강도 필름 입자를 얹는다 */
  grain: boolean;
  /** 대기 화면의 그래픽 뒤에 같은 사진 큐를 은은하게 재생한다 */
  standbyBackdrop: boolean;
}

export interface PhotosState {
  items: PhotoMeta[];
  settings: PhotoSettings;
}

export interface MusicState {
  /** `music-catalog.ts`의 안정적인 두 자리 트랙 id */
  trackId: string | null;
  playing: boolean;
  /** 마지막 명시적 seek/pause 위치. 재생 중 실시간 값은 sync telemetry로만 보낸다. */
  positionSec: number;
  /**
   * 소리 있는 영상이 화면을 쥐고 있는 동안 음악만 내려 둔 상태 (U44).
   *
   * `playing`과 **별개 축**이다 — 곡·위치·재생 여부는 그대로 두고 게인만 `musicDuckSec` 동안
   * 오르내린다. `pause`로 대신하면 명령 토큰이 올라 display가 되감기·재로드를 하고, 돌아올 때
   * 위치가 어긋난다. 저장본을 인수하는 control이 `resetRuntimeVideoPhase()`에서 푼다.
   */
  ducked: boolean;
  /**
   * 곡별 재생 시작 북마크 (U47). 곡 id → 초. 곡마다 **하나뿐**이다 —
   * 여럿을 두면 "지금 어느 북마크인가"를 골라야 하고 현장에 그럴 시간이 없다.
   * 곡을 바꾸거나 정지해도 남는다. 그게 존재 이유다.
   */
  bookmarks: MusicBookmarks;
  /** track/play/seek 명령을 display가 정확히 한 번 적용하기 위한 단조 토큰 */
  commandToken: number;
  /**
   * 이번 재생의 인커밍 크로스페이드를 걸 것인가 (U122).
   *
   * 기본은 `true`(U18의 `musicFadeSec` 인 그대로). 승리 발표(`victoryOutputActions`)처럼
   * 파일 자체에 이미 페이드가 bake돼 있는 곡은 `false`로 걸어 인커밍 덱을 램프 없이 즉시
   * 목표 게인으로 올린다 — **아웃고잉 곡의 페이드아웃은 그대로 걸린다**(다른 축이다).
   * `commandToken`과 같은 왕복 규칙으로 control이 이 한 칸에 적고 display가 읽기만 한다.
   */
  fadeIn: boolean;
}

export interface Suspect {
  code: string;
  name: string;
  sport: string;
}

export interface Settings {
  /** 순위별 배점. 배열 길이는 팀 수 이상이어야 한다 (부족하면 0점 처리) */
  scoreTable: { p1: number[]; p2: number[] };
  /** 미확정 배점이 남아 있는가. 4팀 확정 뒤 기본 배점은 확정 상태다. */
  scoreTableProvisional: boolean;
  tieWindowSec: number;
  /**
   * **레거시** 단일 마스터 볼륨 (0~1). U45에서 `mediaVolume`/`musicVolume` 두 축으로 갈렸다.
   * 값은 남겨 둔다 — 옛 저장본을 두 축 초기값으로 **한 번** 승격하는 근거이고
   * (`promoteLegacyDefaults`), 지우면 그 저장본이 다음 빌드에서 기본값 1로 튄다.
   * 새 코드는 이 값을 읽지 않는다.
   */
  masterVolume: number;
  /** 설명 영상·오버레이·중계 카메라 오디오의 볼륨 (0~1) (U45) */
  mediaVolume: number;
  /** 행사 BGM 덱의 볼륨 (0~1). 자동 덕킹(U44)은 이 축에만 걸린다. */
  musicVolume: number;
  /** `masterVolume` → 두 축 승격을 이미 한 번 했는가 (U45). 저장본을 인수할 때만 세운다. */
  volumeAxesPromoted: boolean;
  camera: {
    deviceId: string | null;
    /** 거울모드(좌우 반전) */
    flipX: boolean;
    /** 천장형 카메라 등을 위한 상하 반전 */
    flipY: boolean;
    /** 중계 카메라 오디오. 기본 false — 하울링 방지 */
    audio: boolean;
  };
  suspects: Suspect[];
  breakStingSec: number;
  /** standby 씬 키비주얼로 쓸 이미지 에셋 id */
  keyVisualAssetId: string | null;
  title: string;
  subtitle: string;
  /** 설명 영상 앞뒤 검정 페이드 길이(초). 0이면 컷 */
  fadeSec: number;
  /**
   * 운영자 암전(U65) 페이드 길이(초). **0 → 1 전 구간 기준**이라 램프 도중 뒤집으면
   * 남은 거리만큼만 걸린다. 0이면 컷으로 강등된다.
   */
  blackoutSec: number;
  /**
   * 행사 BGM 페이드 길이(초). 재생·재개는 페이드 인, 일시정지·정지는 페이드 아웃 뒤 멈춤,
   * 곡 교체는 이 길이만큼 크로스페이드한다. 0이면 즉시(컷).
   */
  musicFadeSec: number;
  /**
   * 대기 화면 사진 배경 켬/끔 크로스디졸브 길이(초). light↔dark 대기 영상과 사진 백드롭이
   * 같은 곡선으로 겹쳐 넘어간다. 0이면 즉시 교체.
   */
  backdropCrossfadeSec: number;
  /**
   * 보드 씬(순위·출전 명단·시상)의 엣지 호흡 글로우 (U41).
   *
   * 가만히 있는 표가 심심해 보이는 것을 엣지에서만 아주 느리게 달랜다. 합성 전용
   * (`opacity`/`transform`만) 애니메이션이라 재정렬 트윈·카운트업과 프레임을 다투지 않는다.
   * 끄면 CSS 애니메이션 자체가 붙지 않는다. `prefers-reduced-motion`이면 이 값과 무관하게 정지.
   */
  luxeGlow: boolean;
  /**
   * 분위기 반전 **전체** 길이(초) (U53). 큐를 누른 순간부터 "영상만 보이는" 시점까지다.
   *
   * 반전 영상은 앞 15초가 검정으로 만들어져 있고 큐를 누르는 순간 백그라운드에서 재생을
   * 시작한다. 이 값이 그 검정 구간과 맞아야 소리와 그림이 어긋나지 않는다.
   * 글리치 구간은 파생값이다 — `moodTotalSec - moodBlackoutSec`.
   */
  moodTotalSec: number;
  /** 전체 길이의 **끝 구간**에서 검정이 마저 차오르는 시간(초). 0이면 컷으로 검정에 들어간다. */
  moodBlackoutSec: number;
  /** 글리치 세기 (0~1). 픽셀 정렬 범위와 보조 효과 양을 한 번에 조절한다. */
  moodGlitchStrength: number;
  /** 디스토션 방식 — 픽셀 소트 방향, 또는 소트 없이 보조 글리치만 */
  moodDistortMode: MoodDistortMode;
  /**
   * 옛 기본값(1.5/0.8) 승격을 이미 한 번 했는가. 저장본을 인수할 때만 세운다.
   * 이 값이 true면 사용자가 1.5/0.8을 **직접 고른 것**이므로 다시 올리지 않는다.
   */
  moodDefaultsPromoted: boolean;
  /**
   * 옛 슬롯 문자 기본 팀(A~F + 옛 팔레트) 승격을 이미 한 번 했는가 (U30).
   * 이 값이 true면 지금 이름이 'A'라도 사용자가 **직접 넣은 것**이므로 다시 올리지 않는다.
   */
  teamDefaultsPromoted: boolean;
  /**
   * 급격한 전환에서 소리를 내리는 시간(초) — 스킵·중단·씬 컷·워치독 공통.
   * 화면은 즉시 넘어가고 소리만 이 길이로 내려간 뒤 실제로 멈춘다. 0이면 컷.
   * 음악은 `musicFadeSec`가 따로 정한다(훨씬 길다).
   */
  audioCutFadeSec: number;
  /** 상단 운영 선택기에서 고른 다음 씬 전환 방식 */
  sceneTransitionMode: SceneTransitionMode;
  /**
   * 상단 바 `→40%`·`→100%` 램프 버튼이 쓰는 길이(초) (U43 · U74). 0 → 1 전 구간 기준이라
   * 이동 거리가 짧으면 그만큼 짧게 끝난다. 0이면 버튼이 컷으로 강등된다.
   */
  masterRampSec: number;
  /**
   * 소리 있는 영상 큐로 넘어가기 전에 행사 BGM을 내리는 시간(초) (U44).
   * **큐가 이 시간만큼 늦게 나간다** — 화면이 넘어가는 순간에는 이미 조용해야 한다.
   * 영상이 끝나 돌아올 때는 지연 없이 같은 길이로 되돌린다.
   */
  musicDuckSec: number;
  /** 위 자동 덕킹을 쓸 것인가 (U44). 끄면 큐가 지연 없이 나가고 음악도 그대로 겹친다. */
  autoDuckOnVideoAudio: boolean;
  /** 승리 발표와 함께 트는 `MUSIC_TRACKS` 곡 id. `null`이면 영상만 나간다. */
  victoryMusicTrackId: string | null;
  /** 이전 저장본 호환을 위해 유지하는 승리 음악 마이그레이션 표식. */
  victoryMusicPromoted: boolean;
  /**
   * 행사 BGM 자동 이어재생 (U49). 기본은 `section`(구간 루프) — 사용자 지시가
   * "음악은 자동으로 이어서 진행되게 해줘. 한 곡 끝나더라도"이므로 켜진 채로 시작한다.
   * `all`이 아니라 `section`인 이유는 섹션이 곧 행사 구간이라, 개회식 음악이 끝나고
   * 1부 게임 음악으로 저절로 넘어가는 편이 더 놀라운 사고이기 때문이다.
   * 바꿔도 **다음 곡부터** 적용되고, [설정]에서 `off`로 끌 수 있다.
   */
  musicRepeat: MusicRepeatMode;
  /**
   * 옛 기본값(`off`)이 박힌 저장본을 `section`으로 이미 한 번 올렸는가 (U49 정정).
   * 이 값이 true면 지금 `off`인 것은 사용자가 **직접 끈 것**이므로 다시 올리지 않는다.
   */
  musicRepeatPromoted: boolean;
  /**
   * 슬로우 리플레이(Q5 A안)를 쓸 것인가. 기본 켬.
   *
   * 끄면 중계 화면에서 링 녹화 자체가 돌지 않는다 — 인코더가 상주하지 않으므로
   * 스팅어 60fps 헤드룸을 아예 건드리지 않는다.
   */
  replayEnabled: boolean;
  /** 되감을 길이(초). 3~30, 기본 10. 세그먼트 주기(=2배)의 입력이라 정수로만 저장한다 */
  replaySec: number;
  /** 재생 배속. 0.1 · 0.25 · 0.5 · 0.75 · 1 중 하나, 기본 0.5 (U85에서 0.1로 내렸다가 U107에서 복귀) */
  replayRate: number;
  /**
   * 옛 기본값(`0.5`)이 박힌 저장본을 `0.1`로 이미 한 번 올렸는가 (U85).
   *
   * **U107로 이 승격은 은퇴했다** — 기본값이 다시 0.5로 돌아와 참조하지 않는다. 필드는 옛
   * 저장본과의 호환, 그리고 `replayRatePromoted2`가 "U85 자동 승격 결과인 0.1"과 "그 뒤
   * 사용자가 직접 고른 0.1"을 구분하려 할 때 판별 재료로 남긴다 (`promoteLegacyDefaults()`
   * 주석 참조 — 실제로는 둘을 구분하지 못해 일괄 승격한다).
   */
  replayRatePromoted: boolean;
  /**
   * U85가 박아 둔 `0.1`을 `0.5`로 이미 한 번 되돌렸는가 (U107).
   *
   * 사용자 원문 "중계 0.1배속은 너무 느리네. 0.5배속으로 하자"(2026-09-05 04:52). 이 값이
   * true면 지금 저장된 배속이 무엇이든 사용자가 **직접 고른 것**이므로 덮지 않는다.
   * (`musicRepeatPromoted`와 같은 자리·같은 규칙 — `promoteLegacyDefaults()`에서 한 번만.)
   */
  replayRatePromoted2: boolean;
  /**
   * 씬 런처의 대결팀 보더 카드를 접어 두었는가 (U57). 기본 펼침.
   *
   * 출력 화면과 무관한 순수 조작 화면 설정이라 런타임 phase와 아무 관계가 없다.
   * 모듈 로컬 변수로 두면 창을 새로 열 때마다 다시 펼쳐지므로 저장본에 남긴다.
   */
  launcherVersusCollapsed: boolean;
  /**
   * 씬 런처에 **추가로** 띄울 씬 버튼 (U66). 넷 다 기본 꺼짐.
   *
   * 사용자 지시가 "런처에서 시상·현장사진·출전 명단·영상 재생을 빼 달라"이므로 기본이 숨김이다.
   * 이 씬들은 큐시트로도 갈 수 있고 `photos`는 F6도 살아 있다 — 버튼을 내려도 막히지 않는다.
   * 배열이 아니라 불린 맵인 이유는 저장본에 모르는 씬 id가 들어와도 조용히 버리기 위해서다
   * (순서의 정본은 `launcher.ts`의 `P1_BUTTONS`가 계속 쥔다).
   */
  launcherExtraScenes: Record<LauncherExtraSceneId, boolean>;
  /**
   * 상단 탭 바 꼬리의 숨긴 탭 묶음(점수 원장·현장 사진·팀 설정)을 펼쳐 두었는가 (U78).
   * 기본 접힘. 활성 탭이 그 묶음 안이면 이 값과 무관하게 펼쳐진다(`isTabMoreOpen`).
   *
   * 출력 화면과 무관한 순수 조작 화면 설정이라 런타임 phase와 아무 관계가 없다.
   * 모듈 로컬 변수로 두면 창을 새로 열 때마다 다시 접히므로 저장본에 남긴다.
   */
  tabbarMoreOpen: boolean;
}

/** 씬 런처에서 켜고 끌 수 있는 선택 씬 (U66) */
export type LauncherExtraSceneId = 'roster' | 'video' | 'photos' | 'award';

export interface AppState {
  /** 상태 스키마 버전 — 가져오기 호환 확인용 */
  version: 3;
  /**
   * 팀 슬롯 6개는 구 저장본 호환을 위해 **항상** 들고 있지만 실제 활성 팀은 앞 4개다.
   */
  teams: Team[];
  /** 이번 행사에 실제로 참가하는 팀 수 (확정값 4) */
  teamCount: number;
  phase: Phase;
  p1: { events: P1Event[] };
  p2: P2State;
  ledger: LedgerEntry[];
  timer: TimerState;
  scene: SceneId;
  sceneOpts: SceneOpts;
  assets: AssetMeta[];
  /**
   * `media/manifest.json` 항목 중 사용자가 삭제한 파일명.
   * 삭제만으로는 다음 로드에 다시 들어오므로, "다시 넣지 말라"는 의사를 여기에 남긴다.
   */
  hiddenMedia: string[];
  /**
   * 전환 영상("대판") 할당 규칙. `settings`와 분리한 이유는 `mergeDeep`으로 통째 병합되는
   * settings와 달리 `byTo`/`pairs`는 삭제(키 제거·배열 축소)가 정상 조작이라 mergeDeep이
   * 삭제를 표현하지 못하기 때문 — 최상위에 두고 전용 액션으로만 바꾼다.
   */
  transitionRules: TransitionRules;
  /**
   * 현장 사진 슬라이드쇼. `settings` 안이 아니라 최상위인 이유는 `transitionRules`와 같다 —
   * `settings/patch`는 `mergeDeep`이라 `items`처럼 자주·대량으로 바뀌는 컬렉션을 태우면
   * 부분 병합 사고가 난다. 전용 액션(`photos/*`)으로만 바꾼다.
   *
   * **재생 위치(현재 사진·경과)는 여기 넣지 않는다** — display 로컬 값이다.
   * 매 4초마다 전체 상태를 저장·방송하면 원장·리더 락 경로가 오염된다.
   */
  photos: PhotosState;
  /** 행사 BGM 명령. 실제 currentTime은 display 로컬이며 상태에 매 200ms 저장하지 않는다. */
  music: MusicState;
  settings: Settings;
  /**
   * 축별로 진행 중인 볼륨 램프 (U43 · U45). `settings` 안이 아니라 최상위인 이유는 `photos`와
   * 같다 — `settings/patch`는 mergeDeep이라 "램프를 지운다"(null)를 표현하지 못한다.
   *
   * 값 자체는 여기 없다. **서술자만** 두고 지금 들리는 볼륨은 control·display가 각자
   * `effectiveVolume()`으로 매 프레임 계산한다 — 매 프레임 상태를 갈면 5초 동안
   * persist·방송이 수십 번 돈다. 끝난 뒤 저장값 확정은 리더가 `volume/rampSettle`로 한 번만.
   */
  volumeRamps: VolumeRamps;
  /**
   * 큐 경계별 전환 방식 (U42). 큐 id → 방식. 없는 키 = 전역 따르기.
   *
   * `settings` 안이 아니라 최상위인 이유는 `transitionRules`와 같다 — `settings/patch`는
   * mergeDeep이라 "지정을 지운다"(키 제거)를 표현하지 못한다. 전용 액션으로만 바꾼다.
   */
  cueTransitions: CueTransitions;
  /**
   * 출력 화면 동결 (U75 · PGM FREEZE).
   *
   * `sceneOpts` 안이 아니라 최상위인 이유: 이것은 **어떤 씬을 어떻게 그리느냐**가 아니라
   * "지금 화면이 상태를 따라가는가"라는 한 단계 위의 스위치다. 씬 옵션 안에 두면
   * `scene/set` 계열이 `sceneOpts`를 갈아끼울 때마다 같이 쓸려 다닐 위험이 있다.
   *
   * **런타임 리셋 대상이 아니다** — 상단 바에 큰 빨강 토글과 점멸 배지가 상시 떠 있어
   * 숨은 상태가 될 수 없다. 저장본에서 살아 돌아와도 운영자가 즉시 알아보고 끌 수 있다.
   * (검은 화면으로 깨어나는 암전과 다른 점이 바로 이 가시성이다.)
   */
  pgm: { frozen: boolean };
  /** 큐시트 현재 위치 — 숫자는 구 저장본 호환·표시용 */
  cueIndex: number;
  /** 동적 영상 삽입·재정렬에도 현재 논리 큐를 보존하는 안정적인 ID */
  cueId: string | null;
  /** 원장 id 생성용 단조 증가 시퀀스 (결정적 직렬화) */
  seq: number;
  /** 마지막 변경 시각 (표시용) */
  updatedAt: number;
}

export interface TeamScore {
  teamId: TeamId;
  p1: number;
  p2: number;
  total: number;
}
