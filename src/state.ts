/**
 * 단일 상태 + 순수 reducer + 파생 점수 + 영속화 (SPEC §2, P4 생존)
 *
 * 설계 결정:
 *  - 점수는 절대 상태에 직접 쓰지 않는다. 원장(ledger)이 유일한 진실이고 scores는 파생값이다.
 *    되돌리기는 삭제가 아니라 **역분개**(부호 반대 항목 추가) — append-only 이므로 사고 추적이 가능하다.
 *  - reducer는 `now`를 액션에 실어 받는다(순수성 유지 → 테스트 가능).
 */

import {
  clampIntervalSec,
  normalizePhotoOrder,
  PHOTO_INTERVAL_DEFAULT,
} from './photos';
import { blackoutDurationMs, blackoutOpacity, blackoutTarget } from './blackout';
import { pointsFromRanks, rankSubmissions } from './scoring';
import { remainingToAt } from './p2-remaining';
import { clampOutputVolume } from './output-audio';
import {
  DEFAULT_MUSIC_DUCK_SEC,
  MUSIC_DUCK_SEC_RANGE,
} from './music-duck';
import {
  DEFAULT_MASTER_RAMP_SEC,
  MASTER_RAMP_SEC_RANGE,
  effectiveVolume,
  emptyVolumeRamps,
  normalizeVolumeRamps,
  startVolumeRamp,
  volumeRampSettled,
  withStoredVolume,
} from './volume-ramp';
import {
  normalizeVideoOutro,
  outroRuntime,
  scriptedOutroForAsset,
} from './scripted-outro';
import { musicTrack } from './music';
import { clearBookmark, normalizeBookmarks, setBookmark } from './music-bookmarks';
import { isMusicRepeatMode } from './music-autoplay';
import { normalizeLiveFrameMode } from './live-frame';
import {
  hasCueTransitions,
  normalizeCueTransitions,
  setCueTransition,
} from './cue-transitions';
import {
  createCurlingBracket,
  curlingRanks,
  ranksFromHigherValues,
  setCurlingPair,
  setCurlingWinner,
} from './p1-results';
import {
  DEFAULT_TEAM_COUNT,
  CONFIRMED_TEAM_COUNT,
  MAX_TEAM_COUNT,
  TEAM_IDS,
  teamIdsFor,
  type AppState,
  type AssetMeta,
  type AwardStep,
  type CurlingMatchId,
  type LauncherExtraSceneId,
  type LedgerEntry,
  type LiveReplay,
  type MoodDistortMode,
  type MusicState,
  type P1Event,
  type P1EventId,
  type P2Stage,
  type P2StageId,
  type Phase,
  type PhotoMeta,
  type PhotoSettings,
  type PhotosState,
  type RankMap,
  type SceneId,
  type SceneOpts,
  type Settings,
  type Submission,
  type TeamId,
  type TeamScore,
  type TimerPreset,
  type TransitionPairRule,
  type TransitionRules,
  VolumeAxis,
  SceneTransitionMode,
} from './types';

/**
 * 모든 씬 id의 런타임 목록 — 저장본의 문자열 키를 `SceneId`로 검증할 때 쓴다.
 *
 * Record로 먼저 선언하는 이유: `SceneId`에 새 씬이 추가되면 이 Record가 컴파일 에러를 내
 * 목록이 조용히 낡는 것을 막는다(배열 리터럴은 누락돼도 통과한다).
 */
const SCENE_ID_TABLE: Record<SceneId, true> = {
  standby: true,
  game: true,
  live: true,
  score: true,
  timer: true,
  roster: true,
  prompt: true,
  breaking: true,
  video: true,
  photos: true,
  suspects: true,
  submit: true,
  award: true,
};

export const SCENE_IDS = Object.keys(SCENE_ID_TABLE) as SceneId[];

export function isSceneId(value: unknown): value is SceneId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SCENE_ID_TABLE, value);
}

export const P1_EVENT_NAMES: Record<P1EventId, string> = {
  curling: '컬링',
  newspaper: '신문지 달리기',
  sticky: '끈끈이 낚시',
  sync: '몸으로 말해요',
};

export const P1_EVENT_ORDER: P1EventId[] = ['curling', 'newspaper', 'sticky', 'sync'];

/**
 * U52 이전에 쓰던 4종목 이름. **id는 그대로 두고 이름만 바뀌었다** (`sync`).
 *
 * 저장본에는 이름이 통째로 들어 있고 migrate가 `{ ...base, ...saved }`로 병합하므로,
 * 저장된 옛 이름이 새 기본값을 **덮는다** — 그래서 U52 이후 빌드에서도 저장본을 이어 쓰면
 * 화면·패널·큐시트가 계속 옛 이름을 보인다. 개명은 사용자의 선택이 아니라 명칭 정정이므로
 * migrate에서 올린다(이름만 — 런타임 phase는 여기서 절대 건드리지 않는다).
 */
export const LEGACY_P1_EVENT_NAMES: Partial<Record<P1EventId, string>> = {
  sync: '일심동체',
};

/**
 * 저장본 종목 이름 승격 (U52). 옛 공식 이름과 **정확히 같을 때만** 올린다.
 *
 * 사용자가 직접 고쳐 넣은 이름은 그대로 둔다 — 이름 필드는 원래 편집 가능한 값이고,
 * 여기서 무조건 덮으면 현장에서 바꿔 둔 표기가 새로고침마다 되돌아간다.
 * (팀 이름 승격 `promoteLegacyDefaults`가 옛 기본값과 같을 때만 올리는 것과 같은 원칙이다.)
 */
export function promoteLegacyEventName(id: P1EventId, name: string | undefined): string {
  if (name === undefined) return P1_EVENT_NAMES[id];
  return name === LEGACY_P1_EVENT_NAMES[id] ? P1_EVENT_NAMES[id] : name;
}

export const P2_STAGE_NAMES: Record<P2StageId, string> = {
  s1: '1단계',
  s2: '2단계',
  s3: '3단계',
};

/**
 * 슬롯별 기본 팀 색 — tokens.css `--team-1..6`과 같은 값·같은 순서다. 이름(`DEFAULT_TEAM_NAMES`)과 **같은 순서로 짝이 맞아야 한다** —
 * 팀 이름이 곧 색 이름이라 둘이 어긋나면 화면에서 바로 거짓말이 된다 (U30).
 * 노랑은 스코어보드 시안(`docs/proposals/ui-scoreboard-five-directions-preview.html`)의
 * `#ffd45b`. 검정 배경 대비 약 14:1이라 링·바·배지 어디에 써도 읽힌다.
 */
export const DEFAULT_TEAM_COLORS = [
  '#ffd45b',
  '#3f7fbe',
  '#c0453b',
  '#3f9b72',
  '#8d6bb4',
  '#3f9aa8',
];

/**
 * 기본 팀 이름 = 색 이름 (U30). 슬롯 1~4가 이번 행사의 확정 4팀이고,
 * 5·6은 저장 호환 슬롯이라 같은 규칙으로 색 이름을 붙인다.
 * 첫 글자(Y/B/R/G/P/T)가 서로 겹치지 않아 로고 없는 팀의 배지 글자로도 쓸 수 있다.
 */
export const DEFAULT_TEAM_NAMES = ['YELLOW', 'BLUE', 'RED', 'GREEN', 'PURPLE', 'TEAL'];

/**
 * 씬 런처에서 켜고 끌 수 있는 선택 씬 (U66). 순서의 정본은 `launcher.ts`의 `P1_BUTTONS`이고,
 * 이 배열은 **설정에 저장되는 키 집합**의 정본이다 — 설정 탭도 이 순서로 체크박스를 그린다.
 */
export const LAUNCHER_EXTRA_SCENES: readonly LauncherExtraSceneId[] = [
  'roster',
  'video',
  'photos',
  'award',
];

/**
 * 선택 씬 맵 정규화 (U66). 넷 다 기본 꺼짐이고, `true`로 **명시된 키만** 켠다.
 * 저장본에 모르는 키가 있어도 결과에 옮기지 않는다 — 씬 id는 빌드마다 바뀔 수 있고,
 * 사라진 씬의 잔재가 런처 필터에 남으면 없는 버튼을 켜려다 조용히 실패한다
 * (`normalizeCueTransitions`가 같은 문제를 푸는 선례다).
 */
export function normalizeLauncherExtraScenes(
  value: unknown,
): Record<LauncherExtraSceneId, boolean> {
  const src = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out = {} as Record<LauncherExtraSceneId, boolean>;
  for (const id of LAUNCHER_EXTRA_SCENES) out[id] = src[id] === true;
  return out;
}

/**
 * U30 이전 기본값(슬롯 문자 A~F + 옛 팔레트). **승격 판정에만** 쓴다 —
 * 저장본의 이름·색이 이 값 그대로면 사용자가 고른 적이 없다는 뜻이라
 * 새 색 이름으로 한 번 올린다. `promoteLegacyDefaults()` 참조.
 */
export const LEGACY_TEAM_DEFAULTS: readonly { name: string; color: string }[] = [
  { name: 'A', color: '#c0453b' },
  { name: 'B', color: '#3f7fbe' },
  { name: 'C', color: '#3f9b72' },
  { name: 'D', color: '#8d6bb4' },
  { name: 'E', color: '#c9922f' },
  { name: 'F', color: '#3f9aa8' },
];

/**
 * 순위·명단·제출 맵은 **항상 6슬롯을 모두 채운다.**
 * 비활성 호환 슬롯까지 키를 보존해 예전 저장본을 읽어도 데이터가 사라지지 않는다.
 */
function emptyRanks(): RankMap {
  const out = {} as RankMap;
  for (const id of TEAM_IDS) out[id] = null;
  return out;
}

function emptyRoster(): Record<TeamId, string> {
  const out = {} as Record<TeamId, string>;
  for (const id of TEAM_IDS) out[id] = '';
  return out;
}

function emptyValues(): Record<TeamId, number | null> {
  return emptyRanks();
}

function emptyNewspaperTimes(): Record<TeamId, [number | null, number | null]> {
  const out = {} as Record<TeamId, [number | null, number | null]>;
  for (const id of TEAM_IDS) out[id] = [null, null];
  return out;
}

function emptySubmissions(): Record<TeamId, Submission | null> {
  const out = {} as Record<TeamId, Submission | null>;
  for (const id of TEAM_IDS) out[id] = null;
  return out;
}

/**
 * 시상 박자의 초기값 — `createInitialState()`와 `game/restart`(U126b)가 공유한다.
 * 두 곳이 각자 리터럴을 들고 있으면 필드가 하나 늘 때 한쪽만 갱신되는 드리프트가 난다.
 */
function initialAwardOpts(): SceneOpts['award'] {
  return {
    step: 'p1',
    revealed: 0,
    rankRevealed: false,
    selectedRank: null,
    selectedTeamRevealed: false,
    revealedRanks: [],
    solo: false,
  };
}

/** 2부 한 단계의 초기값 — 진행(제출·순위·확정)만 지우고 이름/id는 유지한다. */
function freshP2Stage(stage: P2Stage): P2Stage {
  return {
    ...stage,
    status: 'pending',
    submissions: emptySubmissions(),
    ranks: emptyRanks(),
    confirmedAt: null,
  };
}

/**
 * 1부 한 종목의 초기값 (U126b 마지막 보강) — 진행(상태·회차·순위·확정·컬링 대진표·
 * 끈끈이/몸으로 말해요 값·신문지 기록)만 지우고 **id·이름·출전 명단(roster)은 유지한다.**
 * `createInitialState()`의 이벤트 리터럴, `p1/nextRound`의 회차 리셋과 같은 종목별 필드
 * 조합을 쓴다 — 종목이 늘어도 세 곳이 따로 놀지 않도록 여기서도 같은 패턴을 반복한다.
 */
function freshP1Event(event: P1Event): P1Event {
  return {
    ...event,
    status: 'pending',
    round: 1,
    ranks: emptyRanks(),
    confirmedAt: null,
    ...(event.id === 'curling' ? { curling: createCurlingBracket() } : {}),
    ...(event.id === 'sticky' || event.id === 'sync' ? { values: emptyValues() } : {}),
    ...(event.id === 'newspaper' ? { newspaperTimes: emptyNewspaperTimes() } : {}),
  };
}

function makeTeam(id: TeamId, i: number) {
  return { id, name: DEFAULT_TEAM_NAMES[i], color: DEFAULT_TEAM_COLORS[i] };
}

/** 설명 영상 앞뒤 검정 페이드 기본 길이(초). 0이면 컷 전환으로 강등된다. */
export const DEFAULT_FADE_SEC = 0.5;

/** 행사 BGM 페이드 기본 길이(초) — 재생·정지·곡 교체 모두 이 값을 쓴다 (U18). */
export const DEFAULT_MUSIC_FADE_SEC = 5;

/** 대기 화면 사진 배경 켬/끔 크로스디졸브 기본 길이(초) (U19). */
export const DEFAULT_BACKDROP_CROSSFADE_SEC = 10;

/**
 * 분위기 반전 **전체** 기본 길이(초) (U53).
 *
 * 반전 영상(Part 1)의 앞 15초가 검정으로 만들어져 있다. 그 길이에 맞춰야 검정이 걷히는
 * 순간과 영상의 첫 그림이 정확히 만난다.
 */
export const DEFAULT_MOOD_TOTAL_SEC = 15;

/** 글리치 뒤 검정으로 덮는 기본 시간(초) (U26b). */
export const DEFAULT_MOOD_BLACKOUT_SEC = 2.5;

/**
 * 첫 U26 빌드가 배포했던 기본값 쌍. 이 값 그대로 저장된 브라우저는 **사용자가 손대지 않은 것**으로
 * 보고 새 기본값으로 올린다 — 안 하면 "글리치 10초"가 이미 저장된 1.5초에 막혀 영영 적용되지 않는다.
 * 판단 근거가 되려면 **두 값이 모두** 옛 기본값이어야 한다. 하나라도 다르면 사람이 만진 것이다.
 *
 * ## `migrate()`가 아니라 `loadLocal()`이다
 * display는 모든 상태 방송을 `deserialize()` → `migrate()`로 받는다. 승격을 migrate에 두면
 * 사용자가 **실제로 1.5/0.8을 고른 뒤에도** 방송이 올 때마다 10/2.5로 덮인다 — 설정 탭에서
 * 값을 넣는 순간 되돌아가 손댈 수가 없다. 일회성 승격은 저장본을 인수하는 자리에서만 한다
 * (영상 페이드 단계를 migrate가 아니라 `resetRuntimeVideoPhase`에서 끊는 것과 같은 이유).
 */
export const LEGACY_MOOD_DEFAULTS = { glitchSec: 1.5, blackoutSec: 0.8 } as const;
// U53에서 이 승격은 은퇴했다 — `moodGlitchSec`가 `moodTotalSec`으로 이름이 바뀌면서
// migrate가 옛 값을 그대로 옮기고, 옛 기본값 쌍(2.3초)은 새 하한 5초에 클램프된다.
// 상수는 기록으로 남긴다.

/** 글리치 기본 세기 (0~1) (U26). */
export const DEFAULT_MOOD_GLITCH_STRENGTH = 0.8;

/** 급격한 전환에서 소리를 내리는 기본 시간(초) (U27). */
export const DEFAULT_AUDIO_CUT_FADE_SEC = 0.6;

/**
 * 슬로우 리플레이 기본값 (Q5 A안 · 2026-09-04 00:43 사용자 선택 / 배속은 U85 정정 후 U107 복귀).
 *
 * 10초는 spike 실측(클릭→첫 프레임 ≤200ms)에서 온 값이다. 되감기 길이는 세그먼트 주기(=2배)의
 * 입력이라 정수 초로만 다룬다.
 *
 * 배속 기본은 **0.5**다 (U107, 2026-09-05 04:52 사용자 지시). U85에서 "0.1배속을 요청했었으니까"로
 * 0.1로 내렸지만, 실제로 중계에 써 보니 "0.1배속은 너무 느리네. 0.5배속으로 하자"로 판단이
 * 바뀌었다. 0.1은 옵션 목록(`REPLAY_RATES`)에는 그대로 남아 있어 원하면 여전히 고를 수 있다.
 */
export const REPLAY_DEFAULTS = { enabled: true, sec: 10, rate: 0.5 } as const;

/**
 * U85가 썼던 배속 승격(`0.5`→`0.1`) 판별용 옛 기본값. **U107로 이 방향의 승격은 은퇴했다** —
 * 기본값이 다시 0.5로 돌아오면서 "0.5가 박힌 저장본"을 승격 대상으로 볼 이유가 없어졌다.
 * 상수와 `replayRatePromoted` 플래그는 기록으로만 남기고, `promoteLegacyDefaults()`는 더 이상
 * 참조하지 않는다. U107 쪽 승격은 `U107_LEGACY_REPLAY_RATE`를 본다.
 */
export const LEGACY_REPLAY_RATE = 0.5;

/**
 * U107 배속 복귀 승격(`0.1`→`0.5`) 판별에 쓰는 U85 시절 기본값.
 *
 * 저장본에 `replayRate: 0.1`이 박혀 있고 `replayRatePromoted`가 true면(= U85 코드가 이미 한
 * 번 훑고 지나간 저장본), 그 0.1이 "U85 자동 승격 결과"인지 "그 뒤 설정 탭에서 사용자가 직접
 * 고른 0.1"인지 저장된 값만으로는 구분할 수 없다 — 두 경우 모두 정확히 같은 필드값
 * (`replayRate: 0.1, replayRatePromoted: true`)을 남기기 때문이다. 사용자가 "0.1배속은 너무
 * 느리다"고 명시했으므로, 구분 불가를 이유로 승격을 미루지 않고 **0.1 → 0.5 일괄 승격**한다.
 */
export const U107_LEGACY_REPLAY_RATE = 0.1;

/** 되감기 길이 범위(초). 3초 미만은 리플레이로 안 읽히고 30초는 인코더 상주가 커진다. */
export const REPLAY_SEC_RANGE = { min: 3, max: 30 } as const;

/**
 * [지금부터] 구간 길이의 범위(초) (U85).
 *
 * `REPLAY_SEC_RANGE`와 **다른 범위**인 이유: 설정의 되감기 길이는 "링이 항상 덮고 있어야 하는
 * 길이"라 3초가 하한이지만, 운영자가 손으로 잡은 구간은 1초짜리도 뜻이 있다(찍자마자 다시 누른
 * 경우가 정확히 1초다 — 마크가 `now - 1000`이므로). 정수로 반올림하지도 않는다: 4.3초를 찍었는데
 * 4초나 5초가 나가면 찍은 구간과 화면이 어긋난다.
 */
export const REPLAY_SEGMENT_SEC_RANGE = { min: 1, max: REPLAY_SEC_RANGE.max } as const;

/**
 * [지금부터]가 실제 클릭보다 앞당겨 잡는 시간(ms) (U85).
 *
 * 사용자 원문: "누른 시점 1초 전부터". "지금이다" 싶어 손이 가는 순간에는 그 장면이 이미
 * 지나가 있기 때문이다.
 */
export const REPLAY_MARK_LEAD_MS = 1000;

/** 고를 수 있는 배속. 저장본 정규화용 화이트리스트이기도 하다. */
export const REPLAY_RATES: number[] = [0.1, 0.25, 0.5, 0.75, 1];

/** 컷 페이드 길이의 상·하한 (초) */
export const AUDIO_CUT_FADE_SEC_RANGE = { min: 0, max: 3 } as const;

/** 운영자 암전(U65) 기본 페이드 길이(초) — 사용자 지시가 "5초 페이드 아웃/인"이다. */
export const DEFAULT_BLACKOUT_SEC = 5;
/**
 * 암전 페이드 길이 범위(초). 상한이 30인 이유는 그 이상이면 "지금 램프 중인지 멈춘 건지"를
 * 운영자가 화면에서 구분하지 못하기 때문이다. 0은 컷(즉시 검정)으로 허용한다.
 */
export const BLACKOUT_SEC_RANGE = { min: 0, max: 30 } as const;

/** 분위기 반전 단계 길이의 상·하한 (초). 글리치는 0이면 단계 자체가 사라지므로 하한이 있다. */
/** 분위기 반전 전체 길이 범위(초) (U53). 5초 미만은 글리치가 읽히지 않고 30초는 지루하다. */
export const MOOD_TOTAL_SEC_RANGE = { min: 5, max: 30 } as const;
export const MOOD_BLACKOUT_SEC_RANGE = { min: 0, max: 5 } as const;

/** 디스토션 방식 — 저장본 정규화용 목록 */
export const MOOD_DISTORT_MODES: MoodDistortMode[] = [
  'pixel-sort-vertical',
  'pixel-sort-horizontal',
  'glitch-only',
];
export const DEFAULT_MOOD_DISTORT_MODE: MoodDistortMode = 'pixel-sort-vertical';

/** 범위가 있는 초 단위 설정 정규화 — 유한하지 않으면 기본값, 벗어나면 클램프. */
export function normalizeRangedSetting(
  raw: unknown,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(range.min, Math.min(range.max, raw));
}

/** 페이드 길이 입력의 공통 상한(초). 설정 UI와 저장본 정규화가 같은 값을 쓴다. */
export const MAX_FADE_SETTING_SEC = 60;

/** 초 단위 페이드 설정값 정규화 — 유한하지 않으면 기본값, 범위를 벗어나면 클램프. */
export function normalizeFadeSetting(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(MAX_FADE_SETTING_SEC, raw));
}

/** 설명 영상 페이드 단계 (저장본 검증용) */
/** 분위기 반전 단계 (저장본 검증용) */
export const MOOD_PHASES: SceneOpts['moodTransition']['phase'][] = [
  'idle',
  'glitch',
  'blackout',
  'crossfade',
];

export const VIDEO_PHASES: SceneOpts['video']['phase'][] = [
  'idle',
  'covering',
  'playing',
  'holding',
  'revealing',
];

function emptyTransitionRules(): TransitionRules {
  return { defaultAssetId: null, byTo: {}, pairs: [] };
}

/**
 * 저장본의 전환 규칙을 스키마에 맞게 정규화한다.
 *
 * migrate의 `{ ...base, ...r }` 스프레드는 raw 값을 **그대로** 통과시키므로, 손상된
 * 저장본(문자열·배열·잘못된 씬 키)이 들어오면 해석기가 런타임에 터진다. 방어를 여기 한 곳에 모은다.
 * 규칙 자체는 **버리지 않는다** — 없는 에셋을 가리키는 dangling 규칙은 해석기가 폴백으로 흘리고
 * UI가 경고 칩으로 알린다(§1-6). 여기서 거르는 것은 "타입이 틀린 것"뿐이다.
 */
export function normalizeTransitionRules(raw: unknown): TransitionRules {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyTransitionRules();
  const r = raw as { defaultAssetId?: unknown; byTo?: unknown; pairs?: unknown };

  const defaultAssetId =
    typeof r.defaultAssetId === 'string' && r.defaultAssetId ? r.defaultAssetId : null;

  const byTo: Partial<Record<SceneId, string>> = {};
  if (r.byTo && typeof r.byTo === 'object' && !Array.isArray(r.byTo)) {
    for (const [key, value] of Object.entries(r.byTo as Record<string, unknown>)) {
      if (isSceneId(key) && typeof value === 'string' && value) byTo[key] = value;
    }
  }

  const pairs: TransitionPairRule[] = [];
  if (Array.isArray(r.pairs)) {
    for (const item of r.pairs) {
      if (!item || typeof item !== 'object') continue;
      const p = item as { from?: unknown; to?: unknown; assetId?: unknown };
      if (!isSceneId(p.from) || !isSceneId(p.to)) continue;
      if (typeof p.assetId !== 'string' || !p.assetId) continue;
      const entry: TransitionPairRule = { from: p.from, to: p.to, assetId: p.assetId };
      const dup = pairs.findIndex((x) => x.from === entry.from && x.to === entry.to);
      // (from,to)는 유일해야 한다. 중복이면 뒤엣것이 이긴다(마지막 저장이 사용자의 최신 의사).
      if (dup >= 0) pairs[dup] = entry;
      else pairs.push(entry);
    }
  }

  return { defaultAssetId, byTo, pairs };
}

/**
 * 현장 사진 기본 설정.
 *
 * `autoIntake`는 **기본 off**다 — 폴더가 연결되지 않은 채로 자동 수집이 켜져 있으면
 * 새 설치·새 프로필마다 "자동 수집이 켜져 있는데 권한이 없다"는 경고(§R1)가 상시로 뜬다.
 * 폴더를 고르는 조작 자체가 켜겠다는 의사 표시이므로 그때 함께 켠다.
 * (계획 §1-5는 기본 true였다 — 리뷰에서 뒤집힌 결정.)
 */
function defaultPhotoSettings(): PhotoSettings {
  return {
    intervalSec: PHOTO_INTERVAL_DEFAULT,
    kenBurns: true,
    order: 'time',
    autoIntake: false,
    sepia: false,
    vignette: false,
    grain: false,
    standbyBackdrop: false,
  };
}

function emptyPhotos(): PhotosState {
  return { items: [], settings: defaultPhotoSettings() };
}

/**
 * 저장본·액션의 사진 한 장 — 필드 타입을 확정하고, 살릴 수 없으면 null(그 항목만 버린다).
 *
 * `fallbackP2`는 `p2`가 실려 있지 않을 때 찍을 도장이다. 흡수 경로에서는 **현재
 * `state.p2.unlocked`**, 저장본 정규화에서는 **false**(옛 저장본에는 2부 사진이 없다).
 */
function normalizePhotoMeta(raw: unknown, fallbackP2: boolean): PhotoMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Partial<Record<keyof PhotoMeta, unknown>>;
  if (typeof p.id !== 'string' || !p.id) return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : '',
    takenAt: n(p.takenAt),
    addedAt: n(p.addedAt),
    w: n(p.w),
    h: n(p.h),
    bytes: n(p.bytes),
    hidden: p.hidden === true,
    p2: typeof p.p2 === 'boolean' ? p.p2 : fallbackP2,
  };
}

function normalizePhotoSettings(raw: unknown): PhotoSettings {
  const base = defaultPhotoSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const s = raw as Partial<Record<keyof PhotoSettings, unknown>>;
  return {
    intervalSec: clampIntervalSec(s.intervalSec),
    kenBurns: s.kenBurns === undefined ? base.kenBurns : s.kenBurns === true,
    order: normalizePhotoOrder(s.order),
    autoIntake: s.autoIntake === true,
    sepia: s.sepia === true,
    vignette: s.vignette === true,
    grain: s.grain === true,
    standbyBackdrop: s.standbyBackdrop === true,
  };
}

/**
 * 저장본의 `photos`를 스키마에 맞게 정규화한다 (migration v2 → v3).
 *
 * **목록을 상한으로 잘라내지 않는다** — 조용한 데이터 소실은 이 프로젝트가 금지하는 패턴이다.
 * 여기서 버리는 것은 "id가 없어 손댈 수 없는 항목"과 중복 id뿐이고, 정상 항목은 전부 보존한다.
 */
export function normalizePhotos(raw: unknown): PhotosState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyPhotos();
  const r = raw as { items?: unknown; settings?: unknown };
  const items: PhotoMeta[] = [];
  if (Array.isArray(r.items)) {
    const seen = new Set<string>();
    for (const entry of r.items) {
      // 저장본에 `p2`가 없다 = 2부 스탬프 개념이 없던 시절의 사진 → 1부 사진으로 본다
      const item = normalizePhotoMeta(entry, false);
      if (!item || seen.has(item.id)) continue; // 중복 id는 처음 것만 남긴다
      seen.add(item.id);
      items.push(item);
    }
  }
  return { items, settings: normalizePhotoSettings(r.settings) };
}

export function createInitialState(): AppState {
  return {
    version: 3,
    teams: TEAM_IDS.map(makeTeam),
    teamCount: DEFAULT_TEAM_COUNT,
    phase: 'pre',
    p1: {
      events: P1_EVENT_ORDER.map((id) => ({
        id,
        name: P1_EVENT_NAMES[id],
        status: 'pending' as const,
        round: 1,
        ranks: emptyRanks(),
        confirmedAt: null,
        roster: emptyRoster(),
        ...(id === 'curling' ? { curling: createCurlingBracket() } : {}),
        ...(id === 'sticky' || id === 'sync' ? { values: emptyValues() } : {}),
        ...(id === 'newspaper' ? { newspaperTimes: emptyNewspaperTimes() } : {}),
      })),
    },
    p2: {
      unlocked: false,
      stages: (['s1', 's2', 's3'] as P2StageId[]).map((id) => ({
        id,
        name: P2_STAGE_NAMES[id],
        status: 'pending' as const,
        submissions: emptySubmissions(),
        ranks: emptyRanks(),
        confirmedAt: null,
      })),
      eliminated: [],
    },
    ledger: [],
    timer: { preset: 'sticky60', durationSec: 60, startedAt: null, pausedRemaining: null },
    scene: 'standby',
    sceneOpts: {
      standby: { mode: 'main' },
      game: { eventId: 'curling', mode: 'opening', winner: null },
      liveOverlay: {
        scorebar: true,
        timer: true,
        badge: null,
        versus: null,
        frame: 'none',
        replay: null,
        replayToken: 0,
        replayMarkAt: null,
      },
      video: {
        assetId: null,
        nextScene: null,
        paused: false,
        restartToken: 0,
        phase: 'idle',
        phaseToken: 0,
        fadeSec: DEFAULT_FADE_SEC,
        returnScene: null,
        holdEndFrame: false,
        outro: null,
      },
      transitionVideo: {
        active: false,
        assetId: null,
        nextScene: null,
        switchAtSec: 0.5,
        restartToken: 0,
        switched: false,
        nextStandbyMode: null,
      },
      blackout: { active: false, startedAt: 0, fromOpacity: 0 },
      sceneFade: {
        active: false,
        color: '#000000',
        nextScene: null,
        durationSec: DEFAULT_FADE_SEC,
        restartToken: 0,
        switched: false,
        nextStandbyMode: null,
      },
      overlayVideo: {
        active: false,
        assetId: null,
        restartToken: 0,
        holdEndFrame: false,
        held: false,
      },
      moodTransition: { active: false, phase: 'idle', assetId: null, token: 0 },
      roster: { eventId: 'curling', scope: 'all' },
      prompt: { category: '', text: '', round: 1, countdown: null },
      submit: { stageId: 's1', mode: 'board' },
      award: initialAwardOpts(),
      score: { highlight: null },
    },
    assets: [],
    hiddenMedia: [],
    transitionRules: emptyTransitionRules(),
    photos: emptyPhotos(),
    music: { trackId: null, playing: false, positionSec: 0, commandToken: 0, ducked: false, bookmarks: {}, fadeIn: true },
    settings: {
      // 참가 팀은 4팀으로 확정 — 1~4위 기본 배점도 확정 상태다.
      scoreTable: { p1: [100, 80, 50, 30, 20, 10], p2: [300, 200, 150, 100, 70, 40] },
      scoreTableProvisional: false,
      tieWindowSec: 5,
      masterVolume: 1,
      mediaVolume: 1,
      musicVolume: 1,
      volumeAxesPromoted: false,
      // 중계 카메라 오디오는 기본 off — 같은 방에서 출력 화면을 열면 즉시 하울링이 난다
      camera: { deviceId: null, flipX: false, flipY: false, audio: false },
      suspects: ['A', 'B', 'C', 'D', 'E', 'F'].map((code) => ({ code, name: '', sport: '' })),
      breakStingSec: 1,
      keyVisualAssetId: null,
      title: 'EVENT CONSOLE',
      subtitle: '행사를 준비하고 있습니다',
      fadeSec: DEFAULT_FADE_SEC,
      blackoutSec: DEFAULT_BLACKOUT_SEC,
      musicFadeSec: DEFAULT_MUSIC_FADE_SEC,
      backdropCrossfadeSec: DEFAULT_BACKDROP_CROSSFADE_SEC,
      luxeGlow: true,
      moodTotalSec: DEFAULT_MOOD_TOTAL_SEC,
      moodBlackoutSec: DEFAULT_MOOD_BLACKOUT_SEC,
      moodGlitchStrength: DEFAULT_MOOD_GLITCH_STRENGTH,
      moodDistortMode: DEFAULT_MOOD_DISTORT_MODE,
      moodDefaultsPromoted: false,
      teamDefaultsPromoted: false,
      audioCutFadeSec: DEFAULT_AUDIO_CUT_FADE_SEC,
      sceneTransitionMode: 'stinger',
      masterRampSec: DEFAULT_MASTER_RAMP_SEC,
      musicDuckSec: DEFAULT_MUSIC_DUCK_SEC,
      autoDuckOnVideoAudio: true,
      // 공개본은 행사별 승리 음악을 자동 지정하지 않는다.
      victoryMusicTrackId: null,
      victoryMusicPromoted: false,
      musicRepeat: 'section',
      musicRepeatPromoted: false,
      replayEnabled: REPLAY_DEFAULTS.enabled,
      replaySec: REPLAY_DEFAULTS.sec,
      replayRate: REPLAY_DEFAULTS.rate,
      replayRatePromoted: false,
      replayRatePromoted2: false,
      launcherVersusCollapsed: false,
      launcherExtraScenes: normalizeLauncherExtraScenes(undefined),
      tabbarMoreOpen: false,
    },
    pgm: { frozen: false },
    volumeRamps: emptyVolumeRamps(),
    cueTransitions: {},
    cueIndex: 0,
    cueId: 'pre-mission',
    seq: 0,
    updatedAt: 0,
  };
}

// ---------------------------------------------------------------- 파생값

/** 역분개되지 않은(=유효한) 원장 항목만 */
export function activeLedger(ledger: LedgerEntry[]): LedgerEntry[] {
  const reversed = new Set<string>();
  for (const e of ledger) if (e.reverseOf) reversed.add(e.reverseOf);
  return ledger.filter((e) => !e.reverseOf && !reversed.has(e.id));
}

/** 이번 행사에 실제로 참가하는 팀 id (확정 4개). 모든 순회는 이 목록을 기준으로 한다. */
export function activeTeamIds(state: AppState): TeamId[] {
  return teamIdsFor(state.teamCount);
}

/** 참가 팀 객체 목록 (화면에 그릴 팀) */
export function activeTeams(state: AppState) {
  return state.teams.slice(0, teamIdsFor(state.teamCount).length);
}

export function computeScores(state: AppState): Record<TeamId, TeamScore> {
  const out = {} as Record<TeamId, TeamScore>;
  for (const id of TEAM_IDS) out[id] = { teamId: id, p1: 0, p2: 0, total: 0 };
  for (const e of activeLedger(state.ledger)) {
    const t = out[e.teamId];
    if (!t) continue;
    if (e.ref.startsWith('p2:')) t.p2 += e.delta;
    else t.p1 += e.delta;
    t.total += e.delta;
  }
  return out;
}

/** 총점 내림차순 정렬된 팀 id (동점은 팀 순서 유지) */
export function rankedTeams(state: AppState): TeamId[] {
  const s = computeScores(state);
  const ids = activeTeamIds(state);
  return [...ids].sort((a, b) => s[b].total - s[a].total || ids.indexOf(a) - ids.indexOf(b));
}

/** 특정 ref(종목/단계)에서 각 팀이 받은 유효 점수 */
export function pointsByRef(state: AppState, ref: string): Record<TeamId, number> {
  const out = {} as Record<TeamId, number>;
  for (const id of TEAM_IDS) out[id] = 0;
  for (const e of activeLedger(state.ledger)) if (e.ref === ref) out[e.teamId] += e.delta;
  return out;
}

/** 1부 다회차를 종목 하나의 점수표 열로 표시할 때 사용한다. */
export function pointsByRefPrefix(state: AppState, refPrefix: string): Record<TeamId, number> {
  const out = {} as Record<TeamId, number>;
  for (const id of TEAM_IDS) out[id] = 0;
  for (const entry of activeLedger(state.ledger)) {
    if (entry.ref === refPrefix || entry.ref.startsWith(`${refPrefix}:r`)) {
      out[entry.teamId] += entry.delta;
    }
  }
  return out;
}

/** 1회차는 기존 저장본 ref를 그대로 쓰고, 2회차부터 회차를 구분한다. */
export function p1RoundRef(eventId: P1EventId, round: number): string {
  return round <= 1 ? `p1:${eventId}` : `p1:${eventId}:r${round}`;
}

export function getEvent(state: AppState, id: P1EventId) {
  return state.p1.events.find((e) => e.id === id)!;
}

export function getStage(state: AppState, id: P2StageId) {
  return state.p2.stages.find((s) => s.id === id)!;
}

export function getTeam(state: AppState, id: TeamId) {
  return state.teams.find((t) => t.id === id)!;
}

// ---------------------------------------------------------------- 액션

/**
 * 흡수 파이프라인이 만드는 사진 메타 — `p2` 스탬프는 **reducer가 찍는다.**
 *
 * `photo-intake.ts`는 상태를 보지 않으므로(리더 판정·dispatch가 두 갈래가 되지 않게)
 * "지금 2부가 해제돼 있는가"를 알 수 없다. 그 판정은 `state.p2.unlocked`를 들고 있는
 * reducer만 정확히 할 수 있고, 흡수 시점 말고는 사후에 되살릴 방법이 없다(`p2/unlock`에는
 * 타임스탬프가 없다).
 *
 * payload에 `p2`를 **넣을 수 없게** 뺀 이유: 호출부가 실수로 `false`를 실으면 2부 사진이
 * 1부 화면에 뜨는 유출 경로가 그대로 열린다. `photos/add`에서는 reducer가 무조건 덮어쓴다.
 * (저장본 복원 경로는 다르다 — `normalizePhotos`는 저장된 `p2`를 그대로 보존한다.)
 */
export type PhotoIntakeMeta = Omit<PhotoMeta, 'p2'>;

export type Action =
  | { type: 'state/replace'; state: AppState }
  | {
      type: 'team/patch';
      teamId: TeamId;
      patch: Partial<{ name: string; color: string; logoAssetId?: string; logoDataUrl?: string }>;
    }
  | { type: 'teams/count'; count: number }
  | { type: 'phase/set'; phase: Phase }
  /**
   * `transitionMode`는 이 씬 변경 **한 번**에만 적용되는 전환 방식이다 (U42 큐 경계 지정).
   * 생략하면 전역(`settings.sceneTransitionMode`)을 따른다. 해석은 `scene-routing.ts` 한 곳뿐이다.
   */
  | { type: 'scene/set'; scene: SceneId; opts?: DeepPartialSceneOpts; transitionMode?: SceneTransitionMode }
  | { type: 'sceneOpts/patch'; patch: DeepPartialSceneOpts }
  /**
   * 슬로우 리플레이 시작 (Q5). 배속은 **reducer가 설정에서 읽어 굳힌다** —
   * `video/playFull`이 `fadeSec`을 고정하는 것과 같은 이유다. 중계 씬이 아니면 no-op.
   *
   * `seconds`를 주면 그것이 `settings.replaySec`을 **이긴다** (U85 [지금부터]) — 운영자가
   * 손으로 잡은 구간이라 소수 초가 온다. 생략하면 예전대로 설정값을 굳힌다.
   * 링이 실제로 덮는 길이로의 클램프는 여기서 하지 않는다 — 버퍼 길이를 아는 곳은
   * display의 보고를 들고 있는 control뿐이고, 못 채우는 경우 토스트로 그 사실을 말해야 한다.
   *
   * 어느 경로든 [지금부터] 마크(`replayMarkAt`)를 함께 비운다 — 재생이 시작되면 그 구간은
   * 소비된 것이고, 남겨 두면 버튼이 아직 찍어 둔 구간이 있는 것처럼 거짓말한다.
   */
  | { type: 'live/replay'; now: number; seconds?: number }
  /** display의 재생 종료 보고. 토큰이 맞을 때만 비운다 (늦게 온 보고는 무시) */
  | { type: 'live/replayEnded'; token: number }
  /** 라이브 복귀 — 토큰과 무관하게 무조건 비운다 (버튼·단축키·오류 복구 공통) */
  | { type: 'live/replayStop' }
  /**
   * [지금부터] 구간 시작점 찍기 (U85). `now - REPLAY_MARK_LEAD_MS`를 남긴다.
   * 중계 씬이 아니면 no-op — 링이 돌지 않는 씬에서 찍어 둬 봐야 되감을 것이 없다.
   */
  | { type: 'live/replayMark'; now: number }
  /** 찍어 둔 구간 취소 (U85 — Shift+클릭). 이미 비어 있으면 같은 참조 그대로. */
  | { type: 'live/replayMarkClear' }
  | { type: 'p1/status'; eventId: P1EventId; status: 'pending' | 'live' | 'done' }
  | { type: 'p1/rank'; eventId: P1EventId; teamId: TeamId; rank: number | null }
  | { type: 'p1/value'; eventId: 'sticky' | 'sync'; teamId: TeamId; value: number | null }
  | { type: 'p1/newspaperTime'; teamId: TeamId; runner: 0 | 1; value: number | null }
  | { type: 'p1/curlingPair'; matchId: 'semi1' | 'semi2'; teams: [TeamId | null, TeamId | null] }
  | { type: 'p1/curlingWinner'; matchId: CurlingMatchId; winner: TeamId | null }
  | { type: 'p1/confirm'; eventId: P1EventId; now: number }
  /**
   * 확정 취소. `round`를 주면 **그 회차**를 역분개한다 — 확정 직후 토스트의 [되돌리기]는
   * 확정 당시 회차를 실어 보낸다. 그 사이 [다음 회차 +]를 눌렀다면 지금 회차를 지우는 것이
   * 아니라 원래 되돌리려던 회차를 지워야 한다. 생략하면 현재 회차(카드 버튼 경로).
   */
  | { type: 'p1/revoke'; eventId: P1EventId; round?: number; now: number }
  | { type: 'p1/nextRound'; eventId: P1EventId }
  | { type: 'p1/roster'; eventId: P1EventId; teamId: TeamId; text: string }
  | { type: 'p2/unlock' }
  | { type: 'p2/lock' }
  | { type: 'p2/status'; stageId: P2StageId; status: 'pending' | 'live' | 'done' }
  | { type: 'p2/submit'; stageId: P2StageId; teamId: TeamId; at: number }
  | { type: 'p2/submitRemaining'; stageId: P2StageId; teamId: TeamId; remainingSec: number }
  | { type: 'p2/unsubmit'; stageId: P2StageId; teamId: TeamId }
  | { type: 'p2/correct'; stageId: P2StageId; teamId: TeamId; correct: boolean }
  | { type: 'p2/confirm'; stageId: P2StageId; now: number }
  | { type: 'p2/revoke'; stageId: P2StageId; now: number }
  | { type: 'p2/eliminate'; code: string; on: boolean }
  | { type: 'ledger/reverse'; entryId: string; now: number }
  /**
   * 점수 전부 되돌리기 (U126) — 지금 유효한(=역분개되지 않은) 모든 원장 항목을 일괄 역분개한다.
   * 삭제가 아니라 대량 역분개이므로 append-only 계약은 그대로다. 유효 항목이 하나도 없으면
   * `reverseEntriesFor`가 빈 배열을 만들고 reducer는 no-op으로 `state`를 그대로 돌려준다.
   */
  | { type: 'ledger/reverseAll'; reason: string; now: number }
  /**
   * 새 게임 시작 (U126b — 사용자 보강 2026-09-05 10:5x: "점수만 되돌리는 거야. 게임을 오늘
   * 새로 시작할 수 있도록"). `ledger/reverseAll`과 같은 일괄 역분개에 더해 **점수가 아닌
   * 진행 상태**도 함께 초기 위치로 되돌리는 복합 액션이다 — 리듀서 한 곳에서 처리해 두 조작을
   * 따로 눌러야 하는 자리를 만들지 않는다. 되돌리는 것: 점수(원장 일괄 역분개), 승리 팀 선택
   * (`sceneOpts.game.winner`), 점수 공개 강조(`sceneOpts.score.highlight`), 2부 제출 기록
   * (`p2.stages[].submissions/ranks/confirmedAt/status`, `p2.eliminated`), 1부 종목 진행
   * (`p1.events[].status/round/ranks/confirmedAt` + 컬링 대진표·끈끈이·몸으로 말해요 값·
   * 신문지 기록 — U126b 마지막 보강, `freshP1Event`), 시상 박자(`sceneOpts.award`), 전체
   * 진행 단계(`phase`), 큐 커서(`cueIndex`/`cueId`).
   * **손대지 않는 것**: 설정(`settings`)·에셋(`assets`)·팀(`teams`)·음악 재생/북마크·현재
   * 출력 씬(`scene`)·`p2.unlocked`(2부 잠금 상태)·타이머·암전·1부 종목의 **id·이름·출전
   * 명단**(`p1.events[].id/name/roster` — `freshP1Event`가 이 셋은 그대로 스프레드한다).
   */
  | { type: 'game/restart'; reason: string; now: number }
  | { type: 'ledger/manual'; teamId: TeamId; delta: number; reason: string; now: number }
  /**
   * 사회자 재량 보너스 (U132). `ledger/manual`과 같은 append-only 한 줄이지만 두 가지가 다르다.
   *
   * 1. **`ref`가 `p1:bonus` / `p2:bonus`로 갈린다.** `computeScores`가 `p2:` 접두로 소계를
   *    가르므로, 누른 탭의 소계에 그대로 얹히려면 ref에 부(part)가 들어가야 한다.
   *    `manual`(접두 없음)은 항상 1부 소계로만 들어간다.
   * 2. **입력이 프리셋 버튼 하나뿐**이라 확인 모달이 없다. 대신 되돌리기를 토스트에 붙인다.
   *
   * `p1:bonus`·`p2:bonus`는 어떤 종목/단계 id와도 겹치지 않으므로 종목 열에는 잡히지 않는다
   * — `manual`과 같은 처리다. 그래서 한동안 "종목 열 합 ≠ 총점"이었는데, U138에서
   * `scoreColumns()`가 이 셋을 합친 **BONUS 열**을 맨 뒤에 붙여 열 합과 총점을 일치시켰다.
   */
  | {
      type: 'ledger/bonus';
      teamId: TeamId;
      delta: number;
      part: 'p1' | 'p2';
      reason?: string;
      now: number;
    }
  | { type: 'timer/preset'; preset: TimerPreset; durationSec: number }
  | { type: 'timer/start'; now: number }
  | { type: 'timer/pause'; now: number }
  | { type: 'timer/reset' }
  | { type: 'assets/set'; assets: AssetMeta[] }
  | { type: 'media/hide'; file: string }
  | { type: 'media/unhideAll' }
  | { type: 'video/pause'; paused: boolean }
  | { type: 'video/restart'; now: number }
  | {
      type: 'transition/play';
      assetId: string;
      nextScene: SceneId | null;
      /** 씬 교체와 같은 순간에 적용할 대기 화면 모드 (U35). 생략/`null` = 변경 없음 */
      nextStandbyMode?: SceneOpts['standby']['mode'] | null;
      switchAtSec: number;
      now: number;
    }
  | { type: 'transition/switched'; token: number }
  | { type: 'transition/finish'; token: number }
  | {
      type: 'sceneFade/play';
      color: '#000000' | '#ffffff';
      nextScene: SceneId;
      /** 페이드가 화면을 덮은 순간에 적용할 대기 화면 모드 (U35). 생략/`null` = 변경 없음 */
      nextStandbyMode?: SceneOpts['standby']['mode'] | null;
      durationSec: number;
      now: number;
    }
  | { type: 'sceneFade/switched'; token: number }
  | { type: 'sceneFade/finish'; token: number }
  /**
   * 운영자 암전 토글 (U65). 토글 하나로 왕복하고, 램프 길이는 `settings.blackoutSec`이 정한다.
   * 램프 도중 뒤집으면 **지금 화면에 보이는 불투명도**에서 출발한다 — 그래서 `now`가 필요하다.
   */
  | { type: 'blackout/set'; on: boolean; now: number }
  /** 출력 화면 동결 토글 (U75). 상태는 이 불린 하나뿐이고 스냅샷은 display 로컬이다. */
  | { type: 'pgm/freeze'; on: boolean }
  | { type: 'overlay/play'; assetId: string; holdEndFrame: boolean; now: number }
  | { type: 'overlay/held'; token: number }
  | { type: 'overlay/finish'; token: number }
  | { type: 'mood/start'; assetId: string | null }
  | { type: 'mood/blackout'; token: number }
  | { type: 'mood/crossfade'; token: number }
  | { type: 'mood/finish'; token: number }
  | { type: 'mood/abort'; token: number }
  /** 큐 경계별 전환 지정 (U42). `mode: null`이면 지정을 **지운다**(전역 따르기). */
  | { type: 'cueTransitions/set'; cueId: string; mode: SceneTransitionMode | null }
  /** 전부 전역으로 되돌린다 */
  | { type: 'cueTransitions/clear' }
  | { type: 'transitionRules/setDefault'; assetId: string | null }
  /** assetId === null 이면 그 도착 씬의 지정을 **해제**한다 (키 자체를 지운다) */
  | { type: 'transitionRules/setByTo'; to: SceneId; assetId: string | null }
  | { type: 'transitionRules/setPair'; from: SceneId; to: SceneId; assetId: string }
  | { type: 'transitionRules/removePair'; from: SceneId; to: SceneId }
  /**
   * 설명 영상(playMode: 'full') 재생 시작 — 검정 페이드로 감싼 3단계 상태 머신의 진입점.
   * `scene/set`을 내지 않으므로 scene-routing의 스팅어 래핑을 구조적으로 타지 않는다(§2-3).
   *
   * 출발 씬(`state.scene`)과 페이드 길이(`state.settings.fadeSec`)는 **reducer가 직접 읽어**
   * 스냅샷한다 — payload에 실으면 state를 못 보는 순수 함수(`cueActions`)와 큐시트 경로까지
   * 시그니처를 넓혀야 한다.
   */
  | { type: 'video/playFull'; assetId: string; nextScene: SceneId | null; now: number }
  | { type: 'video/covered'; token: number }
  | { type: 'video/held'; token: number }
  | { type: 'video/tail'; token: number }
  | { type: 'video/revealed'; token: number }
  | { type: 'video/abort' }
  /**
   * 흡수한 사진 **배치** 편입. 이미 있는 id는 조용히 무시한다(멱등).
   *
   * 1장마다 내면 200장 = 전체 상태 직렬화·저장·BroadcastChannel 방송 200회다 →
   * 호출부(`photo-intake.ts`)가 10장 또는 500ms 중 먼저 오는 쪽으로 모아서 낸다.
   */
  | { type: 'photos/add'; items: PhotoIntakeMeta[] }
  | { type: 'photos/hidden'; id: string; hidden: boolean }
  /**
   * 숨김 **전체 해제**. `photos/hidden`을 N번 내면 dispatch·저장·방송이 N번 돌아
   * 300장이면 조작 패널이 눈에 띄게 멈춘다 → 한 번에 끝내는 액션을 따로 둔다.
   * (`media/unhideAll`과 같은 이유·같은 모양이다.)
   */
  | { type: 'photos/unhideAll' }
  | { type: 'photos/clear' }
  | { type: 'photos/settings'; patch: Partial<PhotoSettings> }
  /**
   * `startSec`을 주면 그 자리에서 시작한다 (U47 북마크부터 재생). 생략하면 처음부터.
   * `fadeIn: false`를 주면 인커밍 크로스페이드 없이 즉시 목표 게인으로 올린다(U122 —
   * 파일 자체에 페이드가 bake된 승리 음악용). 생략하면 U18 기본(`musicFadeSec` 페이드).
   */
  | { type: 'music/play'; trackId: string; startSec?: number; now: number; fadeIn?: boolean }
  /** 곡별 시작 북마크를 찍는다/지운다 (U47). 곡마다 하나뿐이라 다시 찍으면 덮어쓴다. */
  | { type: 'music/bookmark'; trackId: string; positionSec: number }
  | { type: 'music/bookmarkClear'; trackId: string }
  | { type: 'music/resume' }
  | { type: 'music/pause'; positionSec: number }
  /** 페이드 아웃이 끝나 실제로 멈춘 위치 (display 보고). stale token은 무시한다. */
  | { type: 'music/pausedAt'; positionSec: number; commandToken: number }
  | { type: 'music/seek'; positionSec: number; now: number }
  | { type: 'music/stop'; now: number }
  | { type: 'music/ended'; trackId: string }
  | { type: 'music/failed'; trackId: string }
  /**
   * 소리 있는 영상이 화면을 쥐는 동안 음악만 내린다 (U44). 곡·위치·재생 여부는 그대로다 —
   * 명령 토큰을 올리지 않으므로 display가 되감기·재로드를 하지 않는다.
   */
  | { type: 'music/duck' }
  | { type: 'music/unduck' }
  | { type: 'settings/patch'; patch: DeepPartial<Settings> }
  /**
   * `axis` 볼륨을 `target`으로 `sec`초에 걸쳐 옮긴다 (U43 · U45). 저장값은 그대로 두고 램프만
   * 세운다 — 매 프레임 값을 상태에 쓰면 5초 동안 persist·방송이 수십 번 돈다.
   */
  | { type: 'volume/rampTo'; axis: VolumeAxis; target: number; sec: number; now: number }
  /** 램프가 끝났다. **리더만** 낸다 — 최종값을 저장값으로 확정하고 램프를 지운다. */
  | { type: 'volume/rampSettle'; axis: VolumeAxis; now: number }
  /** 슬라이더를 잡았다 — 지금 들리는 값에서 램프를 끊는다. 값은 튀지 않는다. */
  | { type: 'volume/rampCancel'; axis: VolumeAxis; now: number }
  /** 슬라이더 조작. 그 축의 램프는 여기서 진다. */
  | { type: 'volume/set'; axis: VolumeAxis; value: number }
  | { type: 'cue/index'; index: number; cueId?: string }
  | { type: 'award/step'; step: AwardStep }
  | { type: 'award/reveal'; revealed: number }
  | { type: 'award/revealNext' }
  | { type: 'award/revealPrevious' }
  /**
   * 공개할 등수를 고른다. `solo`를 생략하면 **독립 공개**다 (U127) — 그 등수 한 장만 무대에
   * 세우고 이미 공개한 등수의 이력 카드는 만들지 않는다. `solo: false`를 명시하면 U70까지의
   * 누적 무대(왼쪽 이력 + 오른쪽 스포트라이트)로 돌아간다.
   */
  | { type: 'award/selectRank'; rank: number; solo?: boolean }
  | { type: 'award/revealSelectedTeam' };

/** 배열은 통째로 교체(부분 병합하지 않음) — 팀·용의자 목록 같은 순서 있는 데이터의 의도치 않은 병합을 막는다 */
export type DeepPartial<T> = T extends (infer _U)[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
export type DeepPartialSceneOpts = DeepPartial<AppState['sceneOpts']>;

/**
 * 깊은 병합. patch를 `unknown`으로 받는 이유: `DeepPartial<T>`가 조건부 타입이라
 * 두 번째 인자에서 T가 잘못 추론되면 반환 타입까지 부분 타입으로 좁혀진다.
 * 호출부의 안전성은 Action 타입(`DeepPartial<Settings>` 등)이 이미 보장한다.
 */
function mergeDeep<T>(base: T, patch: unknown): T {
  if (!patch) return base;
  const out: Record<string, unknown> = Array.isArray(base) ? [...(base as unknown[])] as unknown as Record<string, unknown> : { ...(base as object) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const prev = (base as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev)) {
      out[k] = mergeDeep(prev, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * `sceneOpts/patch`가 손대면 안 되는 **설명 영상 런타임 필드**.
 *
 * 이 값들은 `video/playFull` → `covered` → `tail` → `revealed` 상태 머신만 쓴다.
 * 아무 UI나(에셋 탭의 `video.assetId` 지정, 큐시트, 속보 체인) 부분 패치로 이걸 덮으면
 * display가 대조하는 `phaseToken`이 어긋나 검정 페이드가 걷히지 않거나, `returnScene`이
 * 지워져 영상이 끝난 뒤 엉뚱한 씬으로 나간다. 타입(`DeepPartialSceneOpts`)으로는 막을 수
 * 없으므로(전 필드가 optional) reducer 입구에서 떨군다.
 */
const RUNTIME_VIDEO_KEYS = [
  'phase',
  'phaseToken',
  'returnScene',
  'fadeSec',
  'holdEndFrame',
  // 대본 아웃트로(U87)도 재생 시작에 한 번 정해지는 런타임 값이다. 부분 패치가 색만 덮으면
  // 5초에 걸쳐 검정으로 덮는, 아무도 고르지 않은 연출이 나간다.
  'outro',
] as const;

function stripRuntimeVideoKeys(patch: DeepPartialSceneOpts): DeepPartialSceneOpts {
  const video = patch.video;
  if (!video) return patch;
  if (!RUNTIME_VIDEO_KEYS.some((k) => k in video)) return patch;
  const next: Record<string, unknown> = { ...video };
  for (const k of RUNTIME_VIDEO_KEYS) delete next[k];
  return { ...patch, video: next as DeepPartialSceneOpts['video'] };
}

/**
 * 진행 중인 전환 오버레이를 무효화한다 — 늦게 도착한 switch/ended가 최신 조작을 덮지 못하게.
 *
 * `restartToken`은 **일부러 유지한다**: 토큰 비교로 stale 사건을 걸러야 하는데 여기서 지우면
 * 옛 토큰이 우연히 다시 맞아떨어질 수 있다. `scene/set`과 `video/playFull`이 같은 헬퍼를 쓴다.
 */
function cancelTransitionVideo(t: SceneOpts['transitionVideo']): SceneOpts['transitionVideo'] {
  if (!t.active && t.assetId === null && t.nextScene === null && !t.switched && t.nextStandbyMode === null) {
    return t;
  }
  return { ...t, active: false, assetId: null, nextScene: null, switched: false, nextStandbyMode: null };
}

/**
 * 미뤄 둔 대기 화면 모드를 적용한다 (U35). `mode`가 `null`이거나 이미 같으면 **같은 참조**를
 * 돌려줘 불필요한 재렌더·재방송을 만들지 않는다.
 */
function standbyWith(
  standby: SceneOpts['standby'],
  mode: SceneOpts['standby']['mode'] | null,
): SceneOpts['standby'] {
  if (mode === null || standby.mode === mode) return standby;
  return { ...standby, mode };
}

/** 되감기 길이 정규화 — 유한하지 않으면 기본값, 벗어나면 클램프, 항상 정수 초. */
export function normalizeReplaySec(raw: unknown): number {
  return Math.round(normalizeRangedSetting(raw, REPLAY_DEFAULTS.sec, REPLAY_SEC_RANGE));
}

/**
 * [지금부터] 구간 길이 정규화 (U85) — 클램프만 하고 **반올림하지 않는다**.
 *
 * `normalizeReplaySec`과 나뉘어 있는 이유는 `REPLAY_SEGMENT_SEC_RANGE` 주석 참조.
 * 이 함수가 `LiveReplay.seconds`의 정본 정규화다 — 설정 경로에서 온 값(정수 3~30)도
 * 이 범위 안이라 그대로 통과한다.
 */
export function normalizeReplaySegmentSec(raw: unknown): number {
  return normalizeRangedSetting(raw, REPLAY_DEFAULTS.sec, REPLAY_SEGMENT_SEC_RANGE);
}

/** 배속 정규화 — 화이트리스트 밖 값은 기본값으로 접는다. */
export function normalizeReplayRate(raw: unknown): number {
  return typeof raw === 'number' && REPLAY_RATES.includes(raw) ? raw : REPLAY_DEFAULTS.rate;
}

/** [지금부터] 마크 정규화 (U85) — 유한한 숫자가 아니면 "찍은 것 없음"이다. */
export function normalizeReplayMarkAt(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * 저장본·방송에서 온 재생 지시의 모양 검증.
 *
 * **값을 지우지 않는다** — display는 모든 방송을 `deserialize()`로 받으므로 여기서 비우면
 * 재생 지시가 display에 도달하지 못한다(설명 영상 `video.phase`와 같은 계약). 숫자가 아닌
 * 필드가 섞여 있을 때만 null로 접는다.
 */
export function normalizeLiveReplay(raw: unknown): LiveReplay | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nums = ['token', 'seconds', 'rate', 'startedAt'] as const;
  if (!nums.every((k) => typeof r[k] === 'number' && Number.isFinite(r[k] as number))) return null;
  return {
    token: Math.max(0, Math.trunc(r.token as number)),
    // 정수 반올림을 하지 않는다 — [지금부터]가 잡은 4.3초짜리 구간이 방송을 건너며
    // 4초로 뭉개지면 display가 운영자가 찍은 것과 다른 구간을 튼다 (U85)
    seconds: normalizeReplaySegmentSec(r.seconds),
    rate: normalizeReplayRate(r.rate),
    startedAt: r.startedAt as number,
  };
}

/**
 * 중계 화면을 떠나면 재생 지시와 [지금부터] 마크를 함께 놓는다. 그대로면 같은 참조를 돌려준다.
 *
 * 마크도 같이 버리는 이유(U85): 씬을 떠나면 링이 폐기되어 그 구간의 녹화본 자체가 사라진다.
 * 마크만 남겨 두면 다시 중계로 들어왔을 때 버튼이 "여기까지 47초"처럼 실재하지 않는 구간을
 * 가리키고, 눌러 보면 버퍼가 못 채워 짧게 나간다 — 화면이 조용히 거짓말하는 형태다.
 */
function cancelReplayIfLeaving(
  overlay: SceneOpts['liveOverlay'],
  scene: SceneId,
): SceneOpts['liveOverlay'] {
  if (scene === 'live' || (overlay.replay === null && overlay.replayMarkAt === null)) {
    return overlay;
  }
  return { ...overlay, replay: null, replayMarkAt: null };
}

/**
 * 리듀서에서 **`state.scene`이 실제로 움직이는 모든 자리**가 지나는 관문 (Q5).
 *
 * ## 왜 필요했나 — 실제 사고
 * 예전에는 `scene/set` 한 곳만 `cancelReplayIfLeaving`을 불렀다. 그런데 씬이 움직이는 자리는
 * 그 밖에도 여섯이다: 전환 영상 `switched`/`finish`, 컬러 페이드 `switched`/`finish`,
 * 분위기 반전 `finish`, 설명 영상 `covered`. 리플레이가 도는 중에 `F1`을 누르면
 * `scene-routing.ts`가 그것을 `sceneFade/play` → `sceneFade/switched`로 **감싸기 때문에**
 * 최종 상태가 `scene: 'standby'`인데 `liveOverlay.replay`는 살아남았다. display는 자기 가드
 * (`scene === 'live' && replayOwner`)로 그림만은 지켰지만, 조작 화면의 상단 REPLAY 칩과
 * 런처의 [라이브 복귀] 라벨이 굳어 **조작 화면만 거짓말을 했다**(Playwright 격리 실측).
 *
 * ## 왜 쌍으로 돌려주는가
 * 씬과 오버레이를 한 쌍으로 내보내야 다음 사람이 한쪽만 쓰고 지나갈 수 없다. `scene:`만
 * 쓰는 새 케이스가 생기면 그 자리에서 눈에 띈다.
 *
 * `replayToken`은 건드리지 않는다 — 지우면 다시 중계로 들어와 튼 재생이 이전 재생의 늦은
 * `replay-ended` 보고와 우연히 맞아떨어져 그 자리에서 죽는다.
 */
function moveScene(
  overlay: SceneOpts['liveOverlay'],
  next: SceneId,
): { scene: SceneId; liveOverlay: SceneOpts['liveOverlay'] } {
  return { scene: next, liveOverlay: cancelReplayIfLeaving(overlay, next) };
}

/** 명시적인 씬 선택 뒤 늦게 도착한 컬러 페이드 사건을 무효화한다. */
function cancelSceneFade(fade: SceneOpts['sceneFade']): SceneOpts['sceneFade'] {
  if (!fade.active && fade.nextScene === null && !fade.switched && fade.nextStandbyMode === null) return fade;
  return { ...fade, active: false, nextScene: null, switched: false, nextStandbyMode: null };
}

/**
 * 설명 영상 페이드가 진행 중인가 = 지금 `state.scene`의 주인이 페이드 상태 머신인가.
 * 이 동안 도착한 전환 오버레이 사건은 씬을 건드리면 안 된다(이중 안전 가드).
 */
function fullVideoOwnsScene(state: AppState): boolean {
  return state.sceneOpts.video.phase !== 'idle';
}

/**
 * 전환을 정리하며 알파 오버레이를 걷는다 — 단, **그 전환보다 뒤에 올라온 오버레이는 남긴다** (U125).
 *
 * ## 무엇을 고치는가
 * 씬이 바뀌면 그 위에 얹혀 있던 오버레이(매치·승리 영상)는 남의 그림이 되므로 걷어야 한다.
 * 그런데 `transition/switched`·`transition/finish`가 **무조건** 걷고 있었다. 스팅어는 컷
 * (`switchAtSec`, 0.28초) 뒤에도 1초 남짓 더 도는데, 그 사이에 운영자가 매치 큐를 누르면
 * `overlay/play`로 영상이 시작됐다가 **스팅어가 끝나는 순간 함께 꺼졌다** — 화면에서는
 * 매치 영상이 잠깐 나오다 사라지고, 운영자가 다시 누르면서 "매치 영상이 한 번 더 재생"된다
 * (2026-09-05 U125 신고). 컷 **전에** 눌러도 같은 자리에서 `transition/switched`가 지웠다.
 *
 * ## 판정은 토큰 하나
 * 두 `restartToken`은 모두 `Date.now()`라 그대로 시간 비교가 된다. 오버레이가 이 전환보다
 * **뒤에** 시작했으면 그것은 이 전환이 데려온 새 그림이므로 남긴다. 앞에 있었으면 지난 씬의
 * 그림이므로 예전대로 걷는다. 한 배치가 전환과 오버레이를 함께 내는 경로는 없어(`cueActions`의
 * 매치·승리 갈래는 `scene/set`을 내기 전에 돌아간다) 같은 값이 맞부딪히는 자리가 없다.
 */
function overlayAfterTransition(
  overlay: SceneOpts['overlayVideo'],
  transitionToken: number,
): SceneOpts['overlayVideo'] {
  if (overlay.active && overlay.restartToken > transitionToken) return overlay;
  return { ...overlay, active: false, assetId: null, held: false };
}

/**
 * 설명 영상 페이드 단계를 초기화한다 (control 부팅·리더 인수 경로 전용).
 *
 * **migrate()에 넣으면 안 된다** — display는 `deserialize()`로 모든 상태 방송을 받으므로
 * migrate가 리셋하면 display가 covering/playing/revealing을 한 번도 못 보고 페이드가 죽는다.
 * 리셋의 목적은 "재생 도중 죽은 저장본이 복원되며 얼어붙는 것"을 막는 것이고, 그 판단은
 * 저장본을 실제로 인수하는 control만 할 수 있다.
 *
 * `phaseToken`을 올려 인수 직전에 날아다니던 사건까지 함께 무효화한다.
 */
export function resetRuntimeVideoPhase(state: AppState): AppState {
  const video = state.sceneOpts.video;
  const overlay = state.sceneOpts.overlayVideo;
  const mood = state.sceneOpts.moodTransition;
  const liveOverlay = state.sceneOpts.liveOverlay;
  if (
    video.phase === 'idle' &&
    !overlay.active &&
    !mood.active &&
    !state.music.ducked &&
    liveOverlay.replay === null &&
    liveOverlay.replayMarkAt === null
  ) {
    return state;
  }
  return {
    ...state,
    /**
     * 자동 덕킹(U44)도 여기서 푼다. 직전 리더가 소리 있는 영상 도중에 죽으면 저장본에
     * `ducked: true`가 남는다 — 그 영상은 이미 끝났는데 unduck을 낼 주인이 없어져
     * 인수한 창의 음악이 영영 무음으로 남는다. 영상 단계 리셋과 같은 이유·같은 자리다.
     */
    music: state.music.ducked ? { ...state.music, ducked: false } : state.music,
    sceneOpts: {
      ...state.sceneOpts,
      video:
        video.phase === 'idle'
          ? video
          : { ...video, phase: 'idle', phaseToken: video.phaseToken + 1 },
      overlayVideo: overlay.active
        ? { ...overlay, active: false, assetId: null, held: false }
        : overlay,
      /**
       * 분위기 반전도 같이 끊는다 — `phase: 'crossfade'`인 저장본을 인수하면 control은 그
       * 단계에 타이머를 걸지 않고(끝은 영상 `ended`가 낸다) display는 검정을 100%로 유지한다.
       * 아무도 끝내지 않아 검정 화면이 고착된다.
       *
       * migrate가 아니라 여기다. display는 모든 상태 방송을 `deserialize()` → `migrate()`로
       * 받으므로 migrate가 리셋하면 단계 전이 자체가 display에 도달하지 못한다(영상 페이드와 같은 계약).
       */
      // token을 함께 올려 **인플라이트 이벤트를 무효화**한다 — 인수 직전에 떠난
      // `mood/blackout`·`mood/crossfade`가 뒤늦게 도착해 끝난 반전을 되살리지 못하게
      // (설명 영상의 `phaseToken` 방어와 같은 이유).
      moodTransition: mood.active
        ? { ...mood, active: false, phase: 'idle', assetId: null, token: mood.token + 1 }
        : mood,
      /**
       * 슬로우 리플레이도 같이 끊는다 (Q5). 재생 도중 리더가 죽으면 저장본에 `replay`가
       * 남는데, 그 링은 이미 사라졌으므로 `replay-ended`를 낼 주인이 없어 배지가 영영
       * 화면에 붙어 있게 된다. 여기가 자리인 이유도 영상 페이드와 같다 — migrate에 넣으면
       * display가 재생 지시 자체를 못 본다.
       *
       * [지금부터] 마크도 같이 끊는다 (U85) — 인수한 창의 링은 방금 새로 돌기 시작해
       * 옛 마크가 가리키는 구간을 덮지 못한다. 남겨 두면 버튼이 없는 구간을 가리킨다.
       */
      liveOverlay:
        liveOverlay.replay === null && liveOverlay.replayMarkAt === null
          ? liveOverlay
          : { ...liveOverlay, replay: null, replayMarkAt: null },
    },
  };
}

/**
 * 저장본을 **인수**할 때의 리셋 — control 전용 (U65 · U96에서 분리).
 *
 * 런타임 단계 리셋에 **운영자 암전 해제**를 더한 것이다. 검게 덮은 채로 리더가 죽으면 저장본에
 * `active: true`가 남고 새로고침한 창은 **검은 화면으로 깨어난다** — 화면에 아무 단서가 없어
 * 현장에서 원인을 찾을 수 없는 형태의 사고다. `fromOpacity`까지 0으로 되돌려야 다음 토글이
 * 검정 한복판에서 출발하지 않는다. migrate가 아니라 여기인 이유는 영상 페이드와 같다 —
 * migrate에 넣으면 display가 암전 지시 자체를 못 본다.
 *
 * ## 왜 `resetRuntimeVideoPhase()`에서 떼어 냈나 — U96 실측 사고
 * 그 함수는 **리듀서 안에서도** 불린다(`scene/set` · `video/abort`). 암전 해제가 거기 얹혀 있는
 * 동안, 영상 재생 중 `F1`을 누르면 `withFullVideoAbort`가 앞에 끼운 `video/abort`가
 * `{active:false, startedAt:0, fromOpacity:0}`으로 **스냅**시켰다 — 뒤따르는 `blackout/set off`는
 * `active === on`이라 무시되고, 검정이 곡선 없이 한 프레임에 걷혔다(실측: 상태가 뒤집힌 뒤
 * 0.7초에 `#blackout` opacity가 이미 0. U96이 요구한 5초 램프가 통째로 사라진다).
 *
 * 암전은 **화면 축**이지 런타임 영상 단계가 아니다. 리듀서 안의 리셋이 그것을 소유하면 안 되고,
 * 푸는 자리는 저장본을 실제로 인수하는 이 경로 하나뿐이다. 앞으로 어떤 액션이
 * `resetRuntimeVideoPhase()`를 새로 부르더라도 암전은 저절로 안전하다.
 */
export function adoptStoredState(state: AppState): AppState {
  const next = resetRuntimeVideoPhase(state);
  const blackout = next.sceneOpts.blackout;
  if (!blackout.active && blackout.fromOpacity === 0) return next;
  return {
    ...next,
    sceneOpts: {
      ...next.sceneOpts,
      blackout: { active: false, startedAt: 0, fromOpacity: 0 },
    },
  };
}

function nextId(state: AppState, seqOffset: number): string {
  return `L${String(state.seq + seqOffset).padStart(5, '0')}`;
}

/** ref 묶음의 유효 항목을 모두 역분개하는 항목 배열 생성 */
function reverseEntriesFor(
  state: AppState,
  predicate: (e: LedgerEntry) => boolean,
  now: number,
  reasonPrefix: string,
): LedgerEntry[] {
  const targets = activeLedger(state.ledger).filter(predicate);
  return targets.map((t, i) => ({
    id: nextId(state, i + 1),
    ts: now,
    teamId: t.teamId,
    delta: -t.delta,
    reason: `${reasonPrefix} · ${t.reason}`,
    ref: t.ref,
    reverseOf: t.id,
  }));
}

function withLedger(state: AppState, added: LedgerEntry[]): AppState {
  return { ...state, ledger: [...state.ledger, ...added], seq: state.seq + added.length };
}

export function reducer(state: AppState, action: Action): AppState {
  const next = applyAction(state, action);
  if (next === state) return state;
  const now = (action as { now?: number }).now;
  return { ...next, updatedAt: typeof now === 'number' ? Math.max(next.updatedAt, now) : next.updatedAt };
}

function applyAction(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'state/replace':
      return migrate(action.state);

    case 'team/patch':
      return {
        ...state,
        teams: state.teams.map((t) => (t.id === action.teamId ? { ...t, ...action.patch } : t)),
      };

    case 'teams/count': {
      // 4팀 확정 뒤에는 구 UI·가져온 액션이 다른 수를 요청해도 활성 팀 수를 바꾸지 않는다.
      const count = CONFIRMED_TEAM_COUNT;
      if (count === state.teamCount) return state;
      return {
        ...state,
        teamCount: count,
        // 공개 수가 팀 수보다 많으면 시상 리빌이 어긋난다
        sceneOpts: {
          ...state.sceneOpts,
          award: { ...state.sceneOpts.award, revealed: Math.min(state.sceneOpts.award.revealed, count) },
        },
      };
    }

    case 'phase/set':
      return { ...state, phase: action.phase };

    case 'scene/set': {
      const runtimeSafe = resetRuntimeVideoPhase(state);
      const sceneOpts = mergeDeep(runtimeSafe.sceneOpts, action.opts);
      // 오퍼레이터의 명시적인 씬 선택은 진행 중인 프리렌더 전환보다 항상 우선한다.
      // 늦게 도착한 switch/ended 이벤트가 최신 조작을 덮지 못하게 활성 토큰을 무효화한다.
      // 중계 화면을 떠나면 리플레이 링과 재생을 즉시 놓는다 (스팅어 헤드룸 보수안).
      const move = moveScene(sceneOpts.liveOverlay, action.scene);
      return {
        ...state,
        scene: move.scene,
        sceneOpts: {
          ...sceneOpts,
          standby:
            action.scene === 'standby' && action.opts?.standby?.mode === undefined
              ? { mode: 'main' }
              : sceneOpts.standby,
          /**
           * 다크 프레임은 **씬을 옮길 때마다 꺼진다** (U118) — 이 `scene/set`이 명시하지
           * 않았다면 `none`이다.
           *
           * 대기 화면 모드가 바로 위에서 같은 처리를 받는 이유와 같다. `mergeDeep`은 없는
           * 키를 그대로 두므로, 켠 채 두면 `part2-live` 다음에 실행한 **다른 라이브 큐**
           * (`opts.liveOverlay`에 `frame`이 없다)가 2부 톤을 그대로 물려받는다. 프레임은
           * 그 큐의 연출이지 화면의 성질이 아니다. 씬 안에서의 켬/끔은 `sceneOpts/patch`가
           * 계속 할 수 있다(런처·1부 컨트롤이 쓸 자리).
           */
          liveOverlay: {
            ...move.liveOverlay,
            frame: normalizeLiveFrameMode(action.opts?.liveOverlay?.frame),
          },
          // 운영자 암전(`blackout`)은 여기서 건드리지 않는다 (U96). `resetRuntimeVideoPhase()`가
          // 더 이상 그것을 소유하지 않으므로 서술자가 그대로 흘러온다 — 해제는
          // `scene-routing.ts`가 같은 배열에 붙이는 `blackout/set off` 하나가 내고, 그 액션이
          // **지금 보이는 불투명도**에서 출발해야 "블랙에서 스윽"이 성립한다.
          transitionVideo: cancelTransitionVideo(sceneOpts.transitionVideo),
          sceneFade: cancelSceneFade(sceneOpts.sceneFade),
          overlayVideo: {
            ...sceneOpts.overlayVideo,
            active: false,
            assetId: null,
            held: false,
          },
        },
      };
    }

    case 'sceneOpts/patch':
      return { ...state, sceneOpts: mergeDeep(state.sceneOpts, stripRuntimeVideoKeys(action.patch)) };

    case 'live/replay': {
      // 중계 화면 밖에서는 링 자체가 돌지 않는다 — 지시만 남으면 display가 영원히 못 끝낸다
      if (state.scene !== 'live') return state;
      const o = state.sceneOpts.liveOverlay;
      const token = o.replayToken + 1;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          liveOverlay: {
            ...o,
            replayToken: token,
            replay: {
              token,
              // 명시 구간(U85 [지금부터])이 설정값을 이긴다. 둘 다 같은 정규화를 지나
              // display가 받는 값의 모양이 경로에 따라 갈리지 않는다.
              seconds:
                action.seconds === undefined
                  ? normalizeReplaySec(state.settings.replaySec)
                  : normalizeReplaySegmentSec(action.seconds),
              rate: normalizeReplayRate(state.settings.replayRate),
              startedAt: action.now,
            },
            // 찍어 둔 구간은 소비됐다 — 남겨 두면 버튼이 아직 찍은 게 있는 것처럼 보인다
            replayMarkAt: null,
          },
        },
      };
    }

    case 'live/replayEnded': {
      const o = state.sceneOpts.liveOverlay;
      if (!o.replay || o.replay.token !== action.token) return state;
      return {
        ...state,
        sceneOpts: { ...state.sceneOpts, liveOverlay: { ...o, replay: null } },
      };
    }

    case 'live/replayStop': {
      const o = state.sceneOpts.liveOverlay;
      if (!o.replay) return state;
      return {
        ...state,
        sceneOpts: { ...state.sceneOpts, liveOverlay: { ...o, replay: null } },
      };
    }

    case 'live/replayMark': {
      // 링이 돌지 않는 씬에서 찍어 둬 봐야 되감을 녹화본이 없다 (`live/replay`와 같은 가드)
      if (state.scene !== 'live') return state;
      const o = state.sceneOpts.liveOverlay;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          liveOverlay: { ...o, replayMarkAt: action.now - REPLAY_MARK_LEAD_MS },
        },
      };
    }

    case 'live/replayMarkClear': {
      const o = state.sceneOpts.liveOverlay;
      if (o.replayMarkAt === null) return state;
      return {
        ...state,
        sceneOpts: { ...state.sceneOpts, liveOverlay: { ...o, replayMarkAt: null } },
      };
    }

    case 'p1/status':
      return {
        ...state,
        p1: {
          events: state.p1.events.map((e) =>
            e.id === action.eventId ? { ...e, status: action.status } : e,
          ),
        },
      };

    case 'p1/rank': {
      return {
        ...state,
        p1: {
          events: state.p1.events.map((e) =>
            e.id === action.eventId
              ? { ...e, ranks: { ...e.ranks, [action.teamId]: action.rank } }
              : e,
          ),
        },
      };
    }

    case 'p1/value':
      return {
        ...state,
        p1: {
          events: state.p1.events.map((event) => {
            if (event.id !== action.eventId) return event;
            const normalized =
              action.value !== null && Number.isFinite(action.value) && action.value >= 0 ? action.value : null;
            const values = { ...(event.values ?? emptyValues()), [action.teamId]: normalized };
            return {
              ...event,
              values,
              ranks: ranksFromHigherValues(values, activeTeamIds(state)),
            };
          }),
        },
      };

    case 'p1/newspaperTime':
      return {
        ...state,
        p1: {
          events: state.p1.events.map((event) => {
            if (event.id !== 'newspaper') return event;
            const times = event.newspaperTimes ?? emptyNewspaperTimes();
            const teamTimes: [number | null, number | null] = [...times[action.teamId]];
            teamTimes[action.runner] =
              action.value !== null && Number.isFinite(action.value) && action.value >= 0 ? action.value : null;
            return { ...event, newspaperTimes: { ...times, [action.teamId]: teamTimes } };
          }),
        },
      };

    case 'p1/curlingPair':
      return {
        ...state,
        p1: {
          events: state.p1.events.map((event) => {
            if (event.id !== 'curling') return event;
            const curling = setCurlingPair(event.curling ?? createCurlingBracket(), action.matchId, action.teams);
            return { ...event, curling, ranks: curlingRanks(curling) };
          }),
        },
      };

    case 'p1/curlingWinner':
      return {
        ...state,
        p1: {
          events: state.p1.events.map((event) => {
            if (event.id !== 'curling') return event;
            const curling = setCurlingWinner(event.curling ?? createCurlingBracket(), action.matchId, action.winner);
            return { ...event, curling, ranks: curlingRanks(curling) };
          }),
        },
      };

    case 'p1/roster':
      return {
        ...state,
        p1: {
          events: state.p1.events.map((e) =>
            e.id === action.eventId
              ? { ...e, roster: { ...e.roster, [action.teamId]: action.text } }
              : e,
          ),
        },
      };

    case 'p1/confirm': {
      const ev = getEvent(state, action.eventId);
      const ref = p1RoundRef(ev.id, ev.round);
      // 재확정 = 기존 유효 항목 역분개 후 새로 기록
      const reversals = reverseEntriesFor(state, (e) => e.ref === ref, action.now, '역분개');
      let next = withLedger(state, reversals);
      const ids = activeTeamIds(state);
      const pts = pointsFromRanks(ev.ranks, state.settings.scoreTable.p1, ids);
      const added: LedgerEntry[] = [];
      for (const id of ids) {
        if (!pts[id]) continue;
        added.push({
          id: nextId(next, added.length + 1),
          ts: action.now,
          teamId: id,
          delta: pts[id],
          reason: `${ev.name} ${ev.round}회 ${ev.ranks[id]}위`,
          ref,
        });
      }
      next = withLedger(next, added);
      return {
        ...next,
        p1: {
          events: next.p1.events.map((e) =>
            e.id === ev.id
              ? { ...e, status: 'done' as const, confirmedAt: new Date(action.now).toISOString() }
              : e,
          ),
        },
      };
    }

    case 'p1/revoke': {
      const ev = getEvent(state, action.eventId);
      const round = typeof action.round === 'number' ? action.round : ev.round;
      const ref = p1RoundRef(action.eventId, round);
      const reversals = reverseEntriesFor(state, (e) => e.ref === ref, action.now, '역분개');
      const next = withLedger(state, reversals);
      // 지난 회차를 되돌린 것이라면 지금 회차의 확정 상태는 건드리지 않는다.
      if (round !== ev.round) return next;
      return {
        ...next,
        p1: {
          events: next.p1.events.map((e) =>
            e.id === action.eventId ? { ...e, status: 'live' as const, confirmedAt: null } : e,
          ),
        },
      };
    }

    case 'p1/nextRound': {
      const ev = getEvent(state, action.eventId);
      if (!ev.confirmedAt) return state;
      return {
        ...state,
        p1: {
          events: state.p1.events.map((event) =>
            event.id === action.eventId
              ? {
                  ...event,
                  round: event.round + 1,
                  ranks: emptyRanks(),
                  ...(event.id === 'curling' ? { curling: createCurlingBracket() } : {}),
                  ...(event.id === 'sticky' || event.id === 'sync' ? { values: emptyValues() } : {}),
                  ...(event.id === 'newspaper' ? { newspaperTimes: emptyNewspaperTimes() } : {}),
                  status: 'live' as const,
                  confirmedAt: null,
                }
              : event,
          ),
        },
      };
    }

    case 'p2/unlock':
      return { ...state, p2: { ...state.p2, unlocked: true } };

    case 'p2/lock':
      return { ...state, p2: { ...state.p2, unlocked: false } };

    case 'p2/status':
      return {
        ...state,
        p2: {
          ...state.p2,
          stages: state.p2.stages.map((st) =>
            st.id === action.stageId ? { ...st, status: action.status } : st,
          ),
        },
      };

    case 'p2/submit':
      return {
        ...state,
        p2: {
          ...state.p2,
          stages: state.p2.stages.map((st) =>
            st.id === action.stageId
              ? {
                  ...st,
                  submissions: {
                    ...st.submissions,
                    [action.teamId]: { at: action.at, correct: true },
                  },
                }
              : st,
          ),
        },
      };

    /**
     * 남은 시간 수기 입력 (U135). `p2/submit`과 **상태 전이 규칙이 같다** — 단계 status를
     * 건드리지 않고 해당 팀 칸만 덮어쓴다. 다른 점은 `at`이 시각이 아니라
     * `-remainingSec * 1000`이라는 것뿐이고, 그 덕에 순위·점수 경로는 손대지 않는다.
     *
     * 가드: 유한하지 않거나 음수인 값은 그냥 무시한다(state 그대로). 0은 유효 —
     * "남은 시간 0"은 시간을 다 쓴 팀이고 순위상 맨 뒤가 된다.
     */
    case 'p2/submitRemaining': {
      const sec = action.remainingSec;
      if (!Number.isFinite(sec) || sec < 0) return state;
      return {
        ...state,
        p2: {
          ...state.p2,
          stages: state.p2.stages.map((st) =>
            st.id === action.stageId
              ? {
                  ...st,
                  submissions: {
                    ...st.submissions,
                    [action.teamId]: { at: remainingToAt(sec), correct: true, remainingSec: sec },
                  },
                }
              : st,
          ),
        },
      };
    }

    case 'p2/unsubmit':
      return {
        ...state,
        p2: {
          ...state.p2,
          stages: state.p2.stages.map((st) =>
            st.id === action.stageId
              ? { ...st, submissions: { ...st.submissions, [action.teamId]: null } }
              : st,
          ),
        },
      };

    case 'p2/correct':
      return {
        ...state,
        p2: {
          ...state.p2,
          stages: state.p2.stages.map((st) => {
            if (st.id !== action.stageId) return st;
            const cur = st.submissions[action.teamId];
            if (!cur) return st;
            return {
              ...st,
              submissions: { ...st.submissions, [action.teamId]: { ...cur, correct: action.correct } },
            };
          }),
        },
      };

    case 'p2/confirm': {
      const stage = getStage(state, action.stageId);
      const ref = `p2:${stage.id}`;
      const ids = activeTeamIds(state);
      const ranks = rankSubmissions(stage.submissions, state.settings.tieWindowSec, ids);
      const pts = pointsFromRanks(ranks, state.settings.scoreTable.p2, ids);
      const reversals = reverseEntriesFor(state, (e) => e.ref === ref, action.now, '역분개');
      let next = withLedger(state, reversals);
      const added: LedgerEntry[] = [];
      for (const id of ids) {
        if (!pts[id]) continue;
        added.push({
          id: nextId(next, added.length + 1),
          ts: action.now,
          teamId: id,
          delta: pts[id],
          reason: `${stage.name} ${ranks[id]}위`,
          ref,
        });
      }
      next = withLedger(next, added);
      return {
        ...next,
        p2: {
          ...next.p2,
          stages: next.p2.stages.map((st) =>
            st.id === stage.id
              ? {
                  ...st,
                  ranks,
                  status: 'done' as const,
                  confirmedAt: new Date(action.now).toISOString(),
                }
              : st,
          ),
        },
      };
    }

    case 'p2/revoke': {
      const ref = `p2:${action.stageId}`;
      const reversals = reverseEntriesFor(state, (e) => e.ref === ref, action.now, '역분개');
      const next = withLedger(state, reversals);
      return {
        ...next,
        p2: {
          ...next.p2,
          stages: next.p2.stages.map((st) =>
            st.id === action.stageId
              ? { ...st, ranks: emptyRanks(), status: 'live' as const, confirmedAt: null }
              : st,
          ),
        },
      };
    }

    case 'p2/eliminate': {
      const set = new Set(state.p2.eliminated);
      if (action.on) set.add(action.code);
      else set.delete(action.code);
      return { ...state, p2: { ...state.p2, eliminated: [...set] } };
    }

    case 'ledger/reverse': {
      const reversals = reverseEntriesFor(
        state,
        (e) => e.id === action.entryId,
        action.now,
        '역분개',
      );
      return withLedger(state, reversals);
    }

    case 'ledger/reverseAll': {
      // predicate가 항상 true라 `activeLedger`가 돌려주는 유효 항목 전부(1부·2부·수동 가감점
      // 가리지 않고) 대상이 된다. 이미 전부 0이면 reversals가 비어 있으므로 state 참조를
      // 그대로 돌려줘 호출부(UI)가 "변동 없음"을 식별할 수 있게 한다 — no-op 토스트용.
      const reversals = reverseEntriesFor(state, () => true, action.now, action.reason);
      if (reversals.length === 0) return state;
      return withLedger(state, reversals);
    }

    case 'game/restart': {
      const reversals = reverseEntriesFor(state, () => true, action.now, action.reason);
      return {
        ...state,
        ledger: [...state.ledger, ...reversals],
        seq: state.seq + reversals.length,
        phase: 'pre',
        cueIndex: 0,
        cueId: 'pre-mission',
        p1: {
          ...state.p1,
          events: state.p1.events.map(freshP1Event),
        },
        p2: {
          ...state.p2,
          stages: state.p2.stages.map(freshP2Stage),
          eliminated: [],
        },
        sceneOpts: {
          ...state.sceneOpts,
          game: { ...state.sceneOpts.game, winner: null },
          score: { ...state.sceneOpts.score, highlight: null },
          award: initialAwardOpts(),
        },
      };
    }

    case 'ledger/manual':
      return withLedger(state, [
        {
          id: nextId(state, 1),
          ts: action.now,
          teamId: action.teamId,
          delta: action.delta,
          reason: action.reason || '수동 조정',
          ref: 'manual',
        },
      ]);

    case 'ledger/bonus': {
      // 0과 비유한 값은 줄을 만들지 않는다 — 원장에 '변동 없음' 줄이 쌓이면 되돌릴 대상을
      // 찾기 어려워진다(`parseManualDelta`와 같은 판정).
      if (!Number.isFinite(action.delta) || action.delta === 0) return state;
      return withLedger(state, [
        {
          id: nextId(state, 1),
          ts: action.now,
          teamId: action.teamId,
          delta: action.delta,
          reason: action.reason?.trim() || '사회자 보너스',
          ref: action.part === 'p2' ? 'p2:bonus' : 'p1:bonus',
        },
      ]);
    }

    case 'timer/preset':
      return {
        ...state,
        timer: {
          preset: action.preset,
          durationSec: action.durationSec,
          startedAt: null,
          pausedRemaining: null,
        },
      };

    case 'timer/start':
      if (state.timer.startedAt !== null) return state;
      return { ...state, timer: { ...state.timer, startedAt: action.now } };

    case 'timer/pause': {
      if (state.timer.startedAt === null) return state;
      const base = state.timer.pausedRemaining ?? state.timer.durationSec;
      const remaining = Math.max(0, base - (action.now - state.timer.startedAt) / 1000);
      return { ...state, timer: { ...state.timer, startedAt: null, pausedRemaining: remaining } };
    }

    case 'timer/reset':
      return { ...state, timer: { ...state.timer, startedAt: null, pausedRemaining: null } };

    case 'assets/set':
      return { ...state, assets: action.assets };

    case 'media/hide': {
      if (state.hiddenMedia.includes(action.file)) return state;
      return { ...state, hiddenMedia: [...state.hiddenMedia, action.file] };
    }

    case 'media/unhideAll':
      if (!state.hiddenMedia.length) return state;
      return { ...state, hiddenMedia: [] };

    case 'photos/add': {
      const seen = new Set(state.photos.items.map((p) => p.id));
      const added: PhotoMeta[] = [];
      for (const raw of action.items) {
        const item = normalizePhotoMeta(raw, state.p2.unlocked);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        // 2부 스탬프는 **여기서 무조건** 찍는다 — payload가 실어 보낸 값은 신뢰하지 않는다.
        // 흡수 시점의 `p2.unlocked`가 유일한 근거이고, 이 한 줄이 1부 유출을 막는 지점이다.
        added.push({ ...item, p2: state.p2.unlocked });
      }
      // 추가된 게 0건이면 **같은 참조**를 돌려준다 — 폴링이 3초마다 저장·방송을 깨우지 않게
      if (!added.length) return state;
      return { ...state, photos: { ...state.photos, items: [...state.photos.items, ...added] } };
    }

    case 'photos/hidden': {
      const idx = state.photos.items.findIndex((p) => p.id === action.id);
      if (idx < 0 || state.photos.items[idx].hidden === action.hidden) return state;
      const items = state.photos.items.map((p, i) =>
        i === idx ? { ...p, hidden: action.hidden } : p,
      );
      return { ...state, photos: { ...state.photos, items } };
    }

    case 'photos/unhideAll': {
      // 숨긴 게 하나도 없으면 **같은 참조** — 저장·방송을 괜히 깨우지 않는다.
      if (!state.photos.items.some((p) => p.hidden)) return state;
      const items = state.photos.items.map((p) => (p.hidden ? { ...p, hidden: false } : p));
      return { ...state, photos: { ...state.photos, items } };
    }

    case 'photos/clear':
      if (!state.photos.items.length) return state;
      return { ...state, photos: { ...state.photos, items: [] } };

    case 'photos/settings': {
      const cur = state.photos.settings;
      // `{ kenBurns: undefined }` 같은 패치가 스프레드로 현재 값을 지우고 기본값으로 되돌리지
      // 않도록, 실제로 값이 실린 키만 덮는다.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(action.patch)) if (v !== undefined) patch[k] = v;
      const next = normalizePhotoSettings({ ...cur, ...patch });
      if (
        next.intervalSec === cur.intervalSec &&
        next.kenBurns === cur.kenBurns &&
        next.order === cur.order &&
        next.autoIntake === cur.autoIntake &&
        next.sepia === cur.sepia &&
        next.vignette === cur.vignette &&
        next.grain === cur.grain &&
        next.standbyBackdrop === cur.standbyBackdrop
      ) {
        return state;
      }
      return { ...state, photos: { ...state.photos, settings: next } };
    }

    case 'music/play':
      if (!musicTrack(action.trackId)) return state;
      return {
        ...state,
        music: {
          ...state.music,
          trackId: action.trackId,
          playing: true,
          // 북마크부터 재생(U47)은 여기 하나로 들어온다 — 재생 후 seek을 따로 내면
          // display가 0초에서 잠깐 소리를 낸 뒤 건너뛴다.
          positionSec:
            typeof action.startSec === 'number' && Number.isFinite(action.startSec)
              ? Math.max(0, action.startSec)
              : 0,
          commandToken: Math.max(state.music.commandToken + 1, Math.trunc(action.now)),
          // 새 곡을 거는 것은 명시적 조작이다 — 내려간 채로 시작하면 "안 나온다"가 된다
          ducked: false,
          // U122 — 생략하면 U18 기본(크로스페이드). `false`만 컷으로 강등한다.
          fadeIn: action.fadeIn !== false,
        },
      };

    case 'music/resume':
      return state.music.trackId && !state.music.playing
        ? { ...state, music: { ...state.music, playing: true } }
        : state;

    case 'music/pause': {
      if (!state.music.trackId) return state;
      const positionSec = Number.isFinite(action.positionSec) ? Math.max(0, action.positionSec) : 0;
      return { ...state, music: { ...state.music, playing: false, positionSec } };
    }

    case 'music/pausedAt': {
      // 아직 재생 중이거나(다시 눌렀다) 그 사이 다른 명령이 갔으면(토큰이 올랐다) 버린다 —
      // 늦게 도착한 보고가 새 위치를 옛 위치로 덮는 사고를 막는다.
      if (!state.music.trackId || state.music.playing) return state;
      if (state.music.commandToken !== action.commandToken) return state;
      const positionSec = Number.isFinite(action.positionSec) ? Math.max(0, action.positionSec) : 0;
      if (positionSec === state.music.positionSec) return state;
      return { ...state, music: { ...state.music, positionSec } };
    }

    case 'music/seek': {
      if (!state.music.trackId) return state;
      const positionSec = Number.isFinite(action.positionSec) ? Math.max(0, action.positionSec) : 0;
      return {
        ...state,
        music: {
          ...state.music,
          positionSec,
          commandToken: Math.max(state.music.commandToken + 1, Math.trunc(action.now)),
        },
      };
    }

    case 'music/stop':
      return {
        ...state,
        music: {
          // 북마크는 정지해도 남는다 (U47) — 곡을 껐다 켜는 것이 가장 흔한 사용 흐름이다
          ...state.music,
          trackId: null,
          playing: false,
          positionSec: 0,
          commandToken: Math.max(state.music.commandToken + 1, Math.trunc(action.now)),
          ducked: false,
        },
      };

    case 'music/ended':
      return state.music.trackId === action.trackId && state.music.playing
        ? {
            ...state,
            music: {
              ...state.music,
              playing: false,
              positionSec: 0,
              commandToken: state.music.commandToken + 1,
            },
          }
        : state;

    case 'music/failed':
      return state.music.trackId === action.trackId
        ? {
            ...state,
            music: {
              ...state.music,
              trackId: null,
              playing: false,
              positionSec: 0,
              commandToken: state.music.commandToken + 1,
              ducked: false,
            },
          }
        : state;

    /**
     * 덕킹은 `playing`과 **다른 축**이다 (U44) — 곡·위치·명령 토큰을 건드리지 않는다.
     * 토큰을 올리면 display가 되감기·재로드를 해서 영상이 끝난 뒤 곡이 처음부터 시작한다.
     */
    case 'music/duck':
      return state.music.ducked ? state : { ...state, music: { ...state.music, ducked: true } };

    case 'music/unduck':
      return state.music.ducked ? { ...state, music: { ...state.music, ducked: false } } : state;

    case 'music/bookmark': {
      const bookmarks = setBookmark(state.music.bookmarks, action.trackId, action.positionSec);
      return bookmarks === state.music.bookmarks ? state : { ...state, music: { ...state.music, bookmarks } };
    }

    case 'music/bookmarkClear': {
      const bookmarks = clearBookmark(state.music.bookmarks, action.trackId);
      return bookmarks === state.music.bookmarks ? state : { ...state, music: { ...state.music, bookmarks } };
    }

    case 'video/pause':
      return {
        ...state,
        sceneOpts: { ...state.sceneOpts, video: { ...state.sceneOpts.video, paused: action.paused } },
      };

    case 'video/restart':
      // display는 restartToken이 바뀌는 것만 보고 currentTime=0 후 재생한다
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          video: {
            ...state.sceneOpts.video,
            restartToken: action.now,
            paused: false,
            phase: state.sceneOpts.video.phase === 'holding' ? 'playing' : state.sceneOpts.video.phase,
          },
        },
      };

    case 'transition/play':
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          sceneFade: cancelSceneFade(state.sceneOpts.sceneFade),
          transitionVideo: {
            active: true,
            assetId: action.assetId,
            nextScene: action.nextScene,
            switchAtSec: Math.max(0, action.switchAtSec),
            restartToken: action.now,
            switched: false,
            nextStandbyMode: action.nextStandbyMode ?? null,
          },
        },
      };

    case 'overlay/play':
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          overlayVideo: {
            active: true,
            assetId: action.assetId,
            restartToken: action.now,
            holdEndFrame: action.holdEndFrame,
            held: false,
          },
        },
      };

    case 'overlay/held': {
      const overlay = state.sceneOpts.overlayVideo;
      if (!overlay.active || overlay.restartToken !== action.token || !overlay.holdEndFrame) return state;
      return {
        ...state,
        sceneOpts: { ...state.sceneOpts, overlayVideo: { ...overlay, held: true } },
      };
    }

    case 'overlay/finish': {
      const overlay = state.sceneOpts.overlayVideo;
      if (!overlay.active || overlay.restartToken !== action.token) return state;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          overlayVideo: { ...overlay, active: false, assetId: null, held: false },
        },
      };
    }

    case 'mood/start': {
      const mood = state.sceneOpts.moodTransition;
      if (mood.active) return state;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          moodTransition: {
            active: true,
            phase: 'glitch',
            assetId: action.assetId,
            token: mood.token + 1,
          },
          /**
           * 반전 영상은 **누르는 순간** 돌기 시작한다 (U53).
           *
           * 영상 앞 15초가 검정으로 만들어져 있어 그동안은 소리만 깔리고, 글리치가 끝나는
           * 시점에 검정이 걷히면 영상의 첫 그림이 그 자리에서 이어진다. 예전처럼 `crossfade`
           * 단계에서 로드를 시작하면 IndexedDB 조회·디코딩 시간만큼 검정이 더 머문다.
           *
           * `holdEndFrame`은 false다 — 반전 영상이 끝나면 보드로 넘어가는 것이 대본이다.
           */
          overlayVideo: action.assetId
            ? {
                active: true,
                assetId: action.assetId,
                restartToken: mood.token + 1,
                holdEndFrame: false,
                held: false,
              }
            : state.sceneOpts.overlayVideo,
        },
      };
    }

    case 'mood/blackout': {
      const mood = state.sceneOpts.moodTransition;
      if (!mood.active || mood.phase !== 'glitch' || mood.token !== action.token) return state;
      return {
        ...state,
        sceneOpts: { ...state.sceneOpts, moodTransition: { ...mood, phase: 'blackout' } },
      };
    }

    case 'mood/crossfade': {
      const mood = state.sceneOpts.moodTransition;
      // 검정 단계를 건너뛴 크로스페이드는 받지 않는다 — 영상이 글리치 위에서 바로 시작하면
      // 검정으로 넘어가는 그림이 사라진다. 단계 순서는 여기 한 곳에서만 강제된다.
      if (!mood.active || mood.phase !== 'blackout' || mood.token !== action.token) return state;
      return {
        ...state,
        sceneOpts: { ...state.sceneOpts, moodTransition: { ...mood, phase: 'crossfade' } },
      };
    }

    case 'mood/finish': {
      const mood = state.sceneOpts.moodTransition;
      if (!mood.active || mood.token !== action.token) return state;
      const moved = moveScene(state.sceneOpts.liveOverlay, 'suspects');
      return {
        ...state,
        scene: moved.scene,
        sceneOpts: {
          ...state.sceneOpts,
          liveOverlay: moved.liveOverlay,
          moodTransition: { ...mood, active: false, phase: 'idle', assetId: null },
          overlayVideo: { ...state.sceneOpts.overlayVideo, active: false, assetId: null, held: false },
        },
      };
    }

    case 'mood/abort': {
      const mood = state.sceneOpts.moodTransition;
      if (!mood.active || mood.token !== action.token) return state;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          moodTransition: { ...mood, active: false, phase: 'idle', assetId: null },
          overlayVideo: { ...state.sceneOpts.overlayVideo, active: false, assetId: null, held: false },
        },
      };
    }

    case 'transition/switched': {
      const transition = state.sceneOpts.transitionVideo;
      if (!transition.active || transition.restartToken !== action.token || transition.switched) return state;
      const owned = fullVideoOwnsScene(state);
      // 설명 영상 페이드가 도는 중이면 씬의 주인은 그쪽이다 — 전환 상태만 정리하고 씬은 두 손 뗀다
      const moved = moveScene(
        state.sceneOpts.liveOverlay,
        owned ? state.scene : transition.nextScene ?? state.scene,
      );
      return {
        ...state,
        scene: moved.scene,
        sceneOpts: {
          ...state.sceneOpts,
          liveOverlay: moved.liveOverlay,
          // 대기 화면 모드도 씬과 같은 순간에 넘긴다 (U35). 씬의 주인이 설명 영상 페이드면
          // 여기서 화면을 건드리지 않는 것이 맞으므로 모드도 함께 손을 뗀다.
          standby: standbyWith(state.sceneOpts.standby, owned ? null : transition.nextStandbyMode),
          transitionVideo: { ...transition, switched: true, nextStandbyMode: null },
          // 이 전환보다 뒤에 올라온 오버레이는 남긴다 (U125)
          overlayVideo: overlayAfterTransition(state.sceneOpts.overlayVideo, transition.restartToken),
        },
      };
    }

    case 'transition/finish': {
      const transition = state.sceneOpts.transitionVideo;
      if (!transition.active || transition.restartToken !== action.token) return state;
      const settle = !transition.switched && !fullVideoOwnsScene(state);
      // switch 시각 전에 ended/error가 와도 목표 씬으로 안전하게 수렴한다.
      const moved = moveScene(
        state.sceneOpts.liveOverlay,
        settle ? transition.nextScene ?? state.scene : state.scene,
      );
      return {
        ...state,
        scene: moved.scene,
        sceneOpts: {
          ...state.sceneOpts,
          liveOverlay: moved.liveOverlay,
          standby: standbyWith(state.sceneOpts.standby, settle ? transition.nextStandbyMode : null),
          transitionVideo: {
            ...transition,
            active: false,
            assetId: null,
            nextScene: null,
            switched: true,
          },
          // 이 전환보다 뒤에 올라온 오버레이는 남긴다 (U125) — 스팅어는 컷 뒤에도 1초쯤 더 돌고,
          // 그 사이에 시작한 매치 영상이 여기서 함께 꺼지던 것이 신고된 증상이다.
          overlayVideo: overlayAfterTransition(state.sceneOpts.overlayVideo, transition.restartToken),
        },
      };
    }

    case 'sceneFade/play':
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          transitionVideo: cancelTransitionVideo(state.sceneOpts.transitionVideo),
          sceneFade: {
            active: true,
            color: action.color,
            nextScene: action.nextScene,
            durationSec: Math.max(0, action.durationSec),
            restartToken: action.now,
            switched: false,
            nextStandbyMode: action.nextStandbyMode ?? null,
          },
        },
      };

    case 'sceneFade/switched': {
      const fade = state.sceneOpts.sceneFade;
      if (!fade.active || fade.restartToken !== action.token || fade.switched) return state;
      const moved = moveScene(state.sceneOpts.liveOverlay, fade.nextScene ?? state.scene);
      return {
        ...state,
        scene: moved.scene,
        sceneOpts: {
          ...state.sceneOpts,
          liveOverlay: moved.liveOverlay,
          standby: standbyWith(state.sceneOpts.standby, fade.nextStandbyMode),
          sceneFade: { ...fade, switched: true, nextStandbyMode: null },
        },
      };
    }

    case 'sceneFade/finish': {
      const fade = state.sceneOpts.sceneFade;
      if (!fade.active || fade.restartToken !== action.token) return state;
      const moved = moveScene(
        state.sceneOpts.liveOverlay,
        fade.switched ? state.scene : fade.nextScene ?? state.scene,
      );
      return {
        ...state,
        scene: moved.scene,
        sceneOpts: {
          ...state.sceneOpts,
          liveOverlay: moved.liveOverlay,
          standby: standbyWith(state.sceneOpts.standby, fade.switched ? null : fade.nextStandbyMode),
          sceneFade: { ...fade, active: false, nextScene: null, switched: false, nextStandbyMode: null },
        },
      };
    }

    /**
     * 암전 토글 (U65). 화면만 바꾼다 — 소리·씬·큐 어디도 건드리지 않는다.
     *
     * 출발값은 **지금 보이는 불투명도**다. 이전 램프가 아직 도는 중이면 그 자리에서 방향만
     * 꺾이고, 다 끝난 뒤면 그 끝값에서 출발한다. 지속시간은 거리 비례라 display가
     * `from`·`startedAt`·목표 셋만으로 같은 곡선을 다시 만든다(상태에 길이를 두지 않는 이유).
     */
    case 'blackout/set': {
      const b = state.sceneOpts.blackout;
      if (b.active === action.on) return state;
      const prevTo = blackoutTarget(b.active);
      const from = blackoutOpacity(
        action.now - b.startedAt,
        blackoutDurationMs(state.settings.blackoutSec, b.fromOpacity, prevTo),
        b.fromOpacity,
        prevTo,
      );
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          blackout: { active: action.on, startedAt: action.now, fromOpacity: from },
        },
      };
    }

    /**
      * 화면 동결 (U75). 여기서는 **불린 하나만** 바꾼다.
      *
      * 스냅샷은 상태에 두지 않는다 — 전체 상태를 상태 안에 복사해 넣으면 저장·방송 크기가
      * 두 배가 되고, 그 스냅샷이 다시 스냅샷을 품는 재귀가 된다. 무엇을 얼릴지는 그리는
      * 쪽(display)이 자기 로컬에서 판단한다(`pgm.ts` 참고).
      */
    case 'pgm/freeze': {
      if (state.pgm.frozen === action.on) return state;
      return { ...state, pgm: { frozen: action.on } };
    }

    case 'transitionRules/setDefault': {
      if (state.transitionRules.defaultAssetId === action.assetId) return state;
      return {
        ...state,
        transitionRules: { ...state.transitionRules, defaultAssetId: action.assetId },
      };
    }

    case 'transitionRules/setByTo': {
      const byTo = { ...state.transitionRules.byTo };
      if (action.assetId === null) {
        // 해제는 "빈 문자열"이 아니라 **키 제거**여야 한다 — 그래야 다음 우선순위로 정상 폴백한다
        if (!(action.to in byTo)) return state;
        delete byTo[action.to];
      } else {
        if (byTo[action.to] === action.assetId) return state;
        byTo[action.to] = action.assetId;
      }
      return { ...state, transitionRules: { ...state.transitionRules, byTo } };
    }

    case 'transitionRules/setPair': {
      const prev = state.transitionRules.pairs;
      const idx = prev.findIndex((p) => p.from === action.from && p.to === action.to);
      const entry: TransitionPairRule = { from: action.from, to: action.to, assetId: action.assetId };
      if (idx >= 0 && prev[idx].assetId === action.assetId) return state;
      // 덮어쓸 때 자리를 그대로 둔다 — 목록 순서가 튀면 오퍼레이터가 방금 고친 행을 놓친다
      const pairs = idx >= 0 ? prev.map((p, i) => (i === idx ? entry : p)) : [...prev, entry];
      return { ...state, transitionRules: { ...state.transitionRules, pairs } };
    }

    case 'transitionRules/removePair': {
      const pairs = state.transitionRules.pairs.filter(
        (p) => !(p.from === action.from && p.to === action.to),
      );
      if (pairs.length === state.transitionRules.pairs.length) return state;
      return { ...state, transitionRules: { ...state.transitionRules, pairs } };
    }

    case 'video/playFull': {
      // 'video' 씬에서 또 full 영상을 틀면 복귀할 곳이 자기 자신이 된다 → 대기 화면으로 빠진다
      const returnScene: SceneId = state.scene === 'video' ? 'standby' : state.scene;
      // 이번 재생에 쓸 페이드 길이를 여기서 **고정**한다 — 재생 도중 설정을 바꿔도 흔들리지 않는다
      const raw = state.settings.fadeSec;
      const fadeSec = Number.isFinite(raw) ? Math.max(0, raw) : DEFAULT_FADE_SEC;
      /**
       * 대본 아웃트로가 있으면 그 영상의 끝은 **아웃트로가 책임진다** (U87).
       *  - `holdEndFrame`은 강제로 false다. 마지막 프레임을 붙잡으면 `shouldStartVideoTail`이
       *    영영 false라 꼬리 페이드가 시작되지 않고, 소리는 `holding` 진입에서 0으로 뚝 끊긴다
       *    (올림픽 인트로의 manifest 값이 실제로 `holdEndFrame: true`였고, 그게 이 지시의 발단이다).
       *  - `nextScene`도 대본 값으로 덮는다. 에셋 탭에서 누가 바꿔 놓아도, 런처에서 곧장 틀어도
       *    같은 자리로 나온다 — 아웃트로는 "이 영상의 끝"이지 "이 큐의 끝"이 아니다.
       */
      const outro = scriptedOutroForAsset(action.assetId);
      const holdEndFrame =
        !outro && state.assets.find((asset) => asset.id === action.assetId)?.holdEndFrame === true;
      return {
        ...state,
        // scene은 그대로 둔다 — 검정이 화면을 완전히 덮은 뒤(covered)에만 'video'로 간다
        sceneOpts: {
          ...state.sceneOpts,
          video: {
            ...state.sceneOpts.video,
            assetId: action.assetId,
            nextScene: outro ? outro.nextScene : action.nextScene,
            paused: false,
            // restartToken은 display의 되감기 트리거라 시각(now)이어야 한다.
            // phaseToken은 사건 대조용 순수 카운터 — 같은 ms에 두 번 재생해도 반드시 달라진다.
            restartToken: action.now,
            phase: 'covering',
            phaseToken: state.sceneOpts.video.phaseToken + 1,
            fadeSec,
            returnScene,
            holdEndFrame,
            outro: outro ? outroRuntime(outro) : null,
          },
          // 스팅어가 돌고 있었다면 무효화한다 — scene/set과 같은 규칙.
          // 안 하면 늦게 온 transition/switched가 페이드 도중 씬을 덮어쓴다.
          transitionVideo: cancelTransitionVideo(state.sceneOpts.transitionVideo),
          // color fade도 같은 씬 소유자다. 늦은 switch가 full-video 진입을 덮지 못하게 함께 내린다.
          sceneFade: cancelSceneFade(state.sceneOpts.sceneFade),
        },
      };
    }

    case 'video/covered': {
      const video = state.sceneOpts.video;
      if (video.phase !== 'covering' || video.phaseToken !== action.token) return state;
      const moved = moveScene(state.sceneOpts.liveOverlay, 'video');
      return {
        ...state,
        scene: moved.scene,
        sceneOpts: {
          ...state.sceneOpts,
          liveOverlay: moved.liveOverlay,
          video: { ...video, phase: 'playing' },
        },
      };
    }

    case 'video/held': {
      const video = state.sceneOpts.video;
      if (video.phase !== 'playing' || video.phaseToken !== action.token || !video.holdEndFrame) return state;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          video: { ...video, phase: 'holding', paused: true },
        },
      };
    }

    case 'video/tail': {
      const video = state.sceneOpts.video;
      if (video.phase !== 'playing' || video.phaseToken !== action.token) return state;
      // nextScene 미지정(null) = 재생 직전 씬으로 복귀. 그것도 없으면 대기 화면.
      const scene = video.nextScene ?? video.returnScene ?? 'standby';
      return {
        ...state,
        scene,
        sceneOpts: {
          ...state.sceneOpts,
          standby: scene === 'standby' ? { mode: 'main' } : state.sceneOpts.standby,
          video: { ...video, phase: 'revealing' },
        },
      };
    }

    case 'video/revealed': {
      const video = state.sceneOpts.video;
      if (video.phase !== 'revealing' || video.phaseToken !== action.token) return state;
      return {
        ...state,
        sceneOpts: { ...state.sceneOpts, video: { ...video, phase: 'idle' } },
      };
    }

    case 'video/abort': {
      const video = state.sceneOpts.video;
      if (video.phase === 'idle') return state;
      // 토큰을 올려야 취소 직후 늦게 도착한 covered/tail/revealed가 씬을 되돌리지 못한다.
      // scene은 건드리지 않는다 — 어느 씬으로 갈지는 **뒤따르는 액션이 정한다**
      // (조작 패널의 [⏭ 스킵]은 `video/abort` 다음에 `scene/set`을 이어 낸다).
      return resetRuntimeVideoPhase(state);
    }

    case 'settings/patch':
      return { ...state, settings: mergeDeep(state.settings, action.patch) };

    /** 슬라이더 조작 — 그 축의 램프는 진다. 안 그러면 사용자가 방금 놓은 값을 램프가 도로 끈다. */
    case 'volume/set':
      return {
        ...state,
        settings: withStoredVolume(state.settings, action.axis, action.value),
        volumeRamps: { ...state.volumeRamps, [action.axis]: null },
      };

    case 'volume/rampTo':
      return {
        ...state,
        volumeRamps: {
          ...state.volumeRamps,
          [action.axis]: startVolumeRamp(
            state.settings,
            state.volumeRamps,
            action.axis,
            action.target,
            action.sec,
            action.now,
          ),
        },
      };

    case 'volume/rampSettle': {
      const ramp = state.volumeRamps[action.axis];
      // 아직 도는 중이면 **같은 참조**를 돌려준다 — rAF마다 새 상태를 내면 재렌더가 매 프레임 돈다.
      if (!volumeRampSettled(ramp, action.now)) return state;
      return {
        ...state,
        settings: withStoredVolume(state.settings, action.axis, ramp!.to),
        volumeRamps: { ...state.volumeRamps, [action.axis]: null },
      };
    }

    case 'volume/rampCancel': {
      if (!state.volumeRamps[action.axis]) return state;
      return {
        ...state,
        settings: withStoredVolume(
          state.settings,
          action.axis,
          effectiveVolume(state.settings, state.volumeRamps, action.axis, action.now),
        ),
        volumeRamps: { ...state.volumeRamps, [action.axis]: null },
      };
    }

    case 'cueTransitions/set': {
      const cueTransitions = setCueTransition(state.cueTransitions, action.cueId, action.mode);
      return cueTransitions === state.cueTransitions ? state : { ...state, cueTransitions };
    }

    case 'cueTransitions/clear':
      return hasCueTransitions(state.cueTransitions) ? { ...state, cueTransitions: {} } : state;

    case 'cue/index':
      return {
        ...state,
        cueIndex: Math.max(0, action.index),
        cueId: typeof action.cueId === 'string' && action.cueId.length > 0 ? action.cueId : state.cueId,
      };

    case 'award/step':
      return {
        ...state,
        sceneOpts: { ...state.sceneOpts, award: { ...state.sceneOpts.award, step: action.step } },
      };

    case 'award/reveal':
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          award: {
            ...state.sceneOpts.award,
            revealed: Math.max(0, Math.min(teamIdsFor(state.teamCount).length, action.revealed)),
            rankRevealed: false,
          },
        },
      };

    case 'award/selectRank': {
      const teamCount = teamIdsFor(state.teamCount).length;
      if (!Number.isInteger(action.rank) || action.rank < 1 || action.rank > teamCount) return state;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          award: {
            ...state.sceneOpts.award,
            step: 'reveal',
            selectedRank: action.rank,
            selectedTeamRevealed: false,
            // U127 — 생략은 독립 공개다. 최종 순위 발표의 정상 모양이 "그 등수 한 장만"이라
            // 기본값을 그쪽에 둔다. 누적 무대가 필요하면 호출부가 `solo: false`를 명시한다.
            solo: action.solo !== false,
          },
        },
      };
    }

    case 'award/revealSelectedTeam': {
      const award = state.sceneOpts.award;
      if (award.selectedRank === null || award.selectedTeamRevealed) return state;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          award: {
            ...award,
            selectedTeamRevealed: true,
            revealedRanks: award.revealedRanks.includes(award.selectedRank)
              ? award.revealedRanks
              : [...award.revealedRanks, award.selectedRank],
          },
        },
      };
    }

    case 'award/revealNext': {
      const award = state.sceneOpts.award;
      const teamCount = teamIdsFor(state.teamCount).length;
      if (award.revealed >= teamCount) return state;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          award: award.rankRevealed
            ? { ...award, revealed: award.revealed + 1, rankRevealed: false }
            : { ...award, rankRevealed: true },
        },
      };
    }

    case 'award/revealPrevious': {
      const award = state.sceneOpts.award;
      if (!award.rankRevealed && award.revealed <= 0) return state;
      return {
        ...state,
        sceneOpts: {
          ...state.sceneOpts,
          award: award.rankRevealed
            ? { ...award, rankRevealed: false }
            : { ...award, revealed: award.revealed - 1, rankRevealed: true },
        },
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------- 직렬화 / 영속화

/** 공개 배포본 전용 저장소. 기존 행사 빌드의 운영 데이터와 같은 origin에서 섞이지 않는다. */
export const LS_KEY = 'nsdh.console.state.v1';

/** 6슬롯을 모두 채운 완전한 맵으로 보정 (구버전은 4슬롯만 있다) */
function fillMap<T>(partial: Partial<Record<TeamId, T>> | undefined, fallback: T): Record<TeamId, T> {
  const out = {} as Record<TeamId, T>;
  for (const id of TEAM_IDS) out[id] = partial?.[id] ?? fallback;
  return out;
}

/** 점수표를 팀 수만큼 늘린다 — 모자라는 뒷자리는 마지막 값의 절반으로 임시 채움 */
function padTable(table: unknown, fallback: number[]): number[] {
  const src = Array.isArray(table) && table.every((v) => typeof v === 'number') ? [...(table as number[])] : [...fallback];
  while (src.length < MAX_TEAM_COUNT) {
    src.push(Math.max(0, Math.round((src[src.length - 1] ?? 0) / 2)));
  }
  return src.slice(0, MAX_TEAM_COUNT);
}

function normalizeMusic(raw: unknown): MusicState {
  const base: MusicState = {
    trackId: null,
    playing: false,
    positionSec: 0,
    commandToken: 0,
    ducked: false,
    bookmarks: {},
    fadeIn: true,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const value = raw as Record<string, unknown>;
  const commandToken =
    typeof value.commandToken === 'number' && Number.isFinite(value.commandToken)
      ? Math.max(0, Math.trunc(value.commandToken))
      : 0;
  // 덕킹은 **리셋하지 않는다** — display는 모든 방송을 이 경로로 받으므로 여기서 지우면
  // 소리가 내려가는 것을 한 번도 못 본다(영상 페이드·분위기 반전과 같은 계약).
  // 저장본 인수 시 해제는 `resetRuntimeVideoPhase()`가 한다.
  const ducked = value.ducked === true;
  // fadeIn(U122)도 ducked와 같은 이유로 리셋하지 않는다 — 명시적으로 `false`(컷)를 저장한
  // 저장본은 다시 열어도 그 값을 지킨다. 필드가 아예 없던 구 저장본은 U18 기본인 `true`.
  const fadeIn = value.fadeIn !== false;
  /**
   * 북마크는 이른 반환 **앞에서** 되살린다 (U47). 현재 곡이 catalog에서 사라진 저장본은
   * 아래에서 기본 상태로 떨어지는데, 그 뒤에 두면 멀쩡한 다른 곡의 북마크까지 통째로 날아간다.
   */
  const bookmarks = normalizeBookmarks(value.bookmarks);
  if (typeof value.trackId !== 'string' || !musicTrack(value.trackId)) {
    return { ...base, commandToken, bookmarks };
  }
  const positionSec =
    typeof value.positionSec === 'number' && Number.isFinite(value.positionSec)
      ? Math.max(0, value.positionSec)
      : 0;
  return {
    trackId: value.trackId,
    playing: value.playing === true,
    positionSec,
    commandToken,
    ducked,
    bookmarks,
    fadeIn,
  };
}

/** 저장본을 현재 스키마로 보정 — 필드 누락 시 초기값으로 채운다 */
export function migrate(raw: unknown): AppState {
  const base = createInitialState();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<AppState>;

  // 슬롯 6개는 구 저장본의 이름·컬러·로고 보존을 위해 채우되 활성 팀은 확정값 4로 올린다.
  const rawTeams = Array.isArray(r.teams) ? r.teams.filter((t) => t && TEAM_IDS.includes(t.id)) : [];
  const legacyDefaultTeams =
    rawTeams.length === TEAM_IDS.length &&
    TEAM_IDS.every((id, i) => rawTeams.find((team) => team.id === id)?.name === `${i + 1}팀`);
  const teams = legacyDefaultTeams
    ? TEAM_IDS.map(makeTeam)
    : TEAM_IDS.map((id, i) => rawTeams.find((t) => t.id === id) ?? makeTeam(id, i));
  const teamCount = CONFIRMED_TEAM_COUNT;

  const p1 =
    r.p1 && Array.isArray(r.p1.events) && r.p1.events.length === base.p1.events.length
      ? {
          events: r.p1.events.map((e, i) => ({
            ...base.p1.events[i],
            ...e,
            // U52 개명 — 저장된 옛 이름이 새 기본값을 덮는 것을 여기서 되돌린다.
            // **이름만** 손댄다(런타임 phase는 migrate에서 절대 건드리지 않는다).
            name: promoteLegacyEventName(e.id, e.name),
            round:
              typeof e.round === 'number' && Number.isFinite(e.round)
                ? Math.max(1, Math.floor(e.round))
                : 1,
            ranks: fillMap<number | null>(e.ranks, null),
            roster: fillMap<string>(e.roster, ''),
          })),
        }
      : base.p1;

  const p2 =
    r.p2 && Array.isArray(r.p2.stages) && r.p2.stages.length === base.p2.stages.length
      ? {
          ...base.p2,
          ...r.p2,
          stages: r.p2.stages.map((st, i) => ({
            ...base.p2.stages[i],
            ...st,
            ranks: fillMap<number | null>(st.ranks, null),
            submissions: fillMap<Submission | null>(st.submissions, null),
          })),
        }
      : base.p2;

  const settings = mergeDeep(base.settings, (r.settings ?? {}) as DeepPartial<Settings>);
  // 사용자가 직접 쓴 문구는 보존하고, 이전 배포판의 기본 문구만 중립 기본값으로 올린다.
  if (settings.title === 'y9 올출데이 올림픽') settings.title = base.settings.title;
  if (settings.subtitle === '잠시 후 시작합니다' || settings.subtitle === 'YEAR NINE SUMMER GAMES') {
    settings.subtitle = base.settings.subtitle;
  }
  settings.scoreTable = {
    p1: padTable(settings.scoreTable?.p1, base.settings.scoreTable.p1),
    p2: padTable(settings.scoreTable?.p2, base.settings.scoreTable.p2),
  };
  // 참가 팀은 4팀으로 확정됐다. 5·6위 임시 배점 경고가 예전 저장본에서 되살아나지 않게 한다.
  settings.scoreTableProvisional = false;
  // 페이드·마스터 볼륨·카메라 오디오는 애니메이션 산수와 하울링에 직결된다 → 타입을 여기서 확정한다.
  if (typeof settings.fadeSec !== 'number' || !Number.isFinite(settings.fadeSec) || settings.fadeSec < 0) {
    settings.fadeSec = base.settings.fadeSec;
  }
  // U65 암전 길이 — 0(컷)부터 허용하므로 범위 클램프만 한다.
  settings.blackoutSec = normalizeRangedSetting(
    settings.blackoutSec,
    base.settings.blackoutSec,
    BLACKOUT_SEC_RANGE,
  );
  // U18·U19에서 추가된 필드 — 구 저장본에는 아예 없으므로 mergeDeep이 기본값을 넣고
  // 여기서 타입·범위만 확정한다 (없다고 저장본을 깨지 않는다).
  settings.musicFadeSec = normalizeFadeSetting(settings.musicFadeSec, base.settings.musicFadeSec);
  settings.backdropCrossfadeSec = normalizeFadeSetting(
    settings.backdropCrossfadeSec,
    base.settings.backdropCrossfadeSec,
  );
  /**
   * U53 승격 — 옛 저장본에는 `moodTotalSec`이 없고 `moodGlitchSec`(글리치 단계 길이)만 있다.
   * 두 값의 합이 곧 예전의 전체 길이이므로 그대로 옮긴다. 그러면 사용자가 맞춰 둔 길이가
   * 살아 있고, 아무것도 손대지 않은 저장본은 새 기본값 15초로 온다.
   * 여기가 migrate인 이유: 필드 **이름이 바뀐 것**이라 방송마다 해석해도 값이 흔들리지 않는다
   * (기본값 승격과 달리 사용자의 선택을 덮지 않는다).
   */
  // 판정은 **저장본 원본**을 본다 — `mergeDeep`이 이미 새 기본값을 채워 넣었으므로
  // 병합 결과로는 "없었다"를 알 수 없다.
  const rawSettings = r.settings as { moodTotalSec?: unknown; moodGlitchSec?: unknown } | undefined;
  const legacyGlitchSec = rawSettings?.moodGlitchSec;
  if (
    !Number.isFinite(rawSettings?.moodTotalSec as number) &&
    typeof legacyGlitchSec === 'number' &&
    Number.isFinite(legacyGlitchSec)
  ) {
    settings.moodTotalSec = legacyGlitchSec + (Number(settings.moodBlackoutSec) || 0);
  }
  settings.moodTotalSec = normalizeRangedSetting(
    settings.moodTotalSec,
    base.settings.moodTotalSec,
    MOOD_TOTAL_SEC_RANGE,
  );
  settings.moodBlackoutSec = normalizeRangedSetting(
    settings.moodBlackoutSec,
    base.settings.moodBlackoutSec,
    MOOD_BLACKOUT_SEC_RANGE,
  );
  settings.moodGlitchStrength = normalizeRangedSetting(
    settings.moodGlitchStrength,
    base.settings.moodGlitchStrength,
    { min: 0, max: 1 },
  );
  if (!MOOD_DISTORT_MODES.includes(settings.moodDistortMode)) {
    settings.moodDistortMode = base.settings.moodDistortMode;
  }
  settings.moodDefaultsPromoted = settings.moodDefaultsPromoted === true;
  settings.teamDefaultsPromoted = settings.teamDefaultsPromoted === true;
  settings.audioCutFadeSec = normalizeRangedSetting(
    settings.audioCutFadeSec,
    base.settings.audioCutFadeSec,
    AUDIO_CUT_FADE_SEC_RANGE,
  );
  settings.masterVolume =
    typeof settings.masterVolume === 'number'
      ? clampOutputVolume(settings.masterVolume)
      : base.settings.masterVolume;
  // 두 축(U45)은 각자 검증한다. 옛 마스터 값의 **승격**은 여기가 아니라
  // `promoteLegacyDefaults()`에서 한 번만 한다 — migrate는 방송마다 도는 경로라
  // 여기서 값을 옮기면 사용자가 나중에 바꾼 축 값을 매 방송이 도로 덮는다.
  settings.mediaVolume =
    typeof settings.mediaVolume === 'number'
      ? clampOutputVolume(settings.mediaVolume)
      : base.settings.mediaVolume;
  settings.musicVolume =
    typeof settings.musicVolume === 'number'
      ? clampOutputVolume(settings.musicVolume)
      : base.settings.musicVolume;
  settings.volumeAxesPromoted = settings.volumeAxesPromoted === true;
  settings.musicDuckSec = normalizeRangedSetting(
    settings.musicDuckSec,
    base.settings.musicDuckSec,
    MUSIC_DUCK_SEC_RANGE,
  );
  // U44 이전 저장본에는 이 키가 없다 — 기본은 켬이므로 `false`로 **명시된 경우만** 끈다.
  settings.autoDuckOnVideoAudio = settings.autoDuckOnVideoAudio !== false;
  /**
   * 승리 음악(U110)은 **라이브러리에 실재하는 곡 id일 때만** 살린다.
   *
   * 곡 목록이 바뀌어 없는 id가 남으면 `music/play` 리듀서가 조용히 무시해(`musicTrack` 미스)
   * 승리 발표에 음악만 빠진 채 나간다 — 그 자리에서는 아무도 원인을 못 찾는다.
   * 여기서 `null`로 접으면 [설정]의 드롭다운이 "지정 안 함"으로 서서 눈에 보인다.
   */
  settings.victoryMusicTrackId =
    typeof settings.victoryMusicTrackId === 'string' && musicTrack(settings.victoryMusicTrackId)
      ? settings.victoryMusicTrackId
      : null;
  // U119 — 승격(null → '48')은 여기가 아니라 `promoteLegacyDefaults()`에서 한 번만 한다
  // (바로 위 승리 음악 주석과 같은 이유: migrate는 방송마다 도는 경로라 여기서 옮기면
  // 운영자가 나중에 비운 선택을 매 방송이 도로 덮는다).
  settings.victoryMusicPromoted = settings.victoryMusicPromoted === true;
  if (!isMusicRepeatMode(settings.musicRepeat)) settings.musicRepeat = base.settings.musicRepeat;
  settings.musicRepeatPromoted = settings.musicRepeatPromoted === true;
  // Q5 이전 저장본에는 이 세 키가 없다 — 기본은 켬이므로 `false`로 **명시된 경우만** 끈다.
  settings.replayEnabled = settings.replayEnabled !== false;
  settings.replaySec = normalizeReplaySec(settings.replaySec);
  settings.replayRate = normalizeReplayRate(settings.replayRate);
  // 배속 승격(U85/U107)은 여기가 아니라 `promoteLegacyDefaults()`에서 한 번만 한다 —
  // migrate는 방송마다 도는 경로라 여기서 옮기면 사용자가 나중에 고른 값을 매 방송이 덮는다.
  settings.replayRatePromoted = settings.replayRatePromoted === true;
  settings.replayRatePromoted2 = settings.replayRatePromoted2 === true;
  // U57·U66 — 조작 화면 배치 설정. 둘 다 기본 꺼짐이라 `true`로 명시된 경우만 켠다.
  // 출력에 아무 영향이 없는 순수 UI 값이므로 런타임 phase 리셋과는 무관하다.
  settings.launcherVersusCollapsed = settings.launcherVersusCollapsed === true;
  settings.launcherExtraScenes = normalizeLauncherExtraScenes(settings.launcherExtraScenes);
  // U78 — 숨긴 탭 묶음도 기본 접힘이라 `true`로 명시된 경우만 펼친다.
  settings.tabbarMoreOpen = settings.tabbarMoreOpen === true;
  settings.masterRampSec = normalizeRangedSetting(
    settings.masterRampSec,
    base.settings.masterRampSec,
    MASTER_RAMP_SEC_RANGE,
  );
  if (!['black', 'white', 'stinger'].includes(settings.sceneTransitionMode)) {
    settings.sceneTransitionMode = base.settings.sceneTransitionMode;
  }
  settings.camera = { ...settings.camera, audio: settings.camera?.audio === true };
  // U41 이전 저장본에는 이 키가 없다 — 기본은 켬이므로 `false`로 **명시된 경우만** 끈다.
  settings.luxeGlow = settings.luxeGlow !== false;

  // 페이드 단계(`sceneOpts.video.phase`)는 여기서 리셋하지 않는다.
  // display는 모든 상태 방송을 deserialize() → migrate()로 받으므로, migrate가 리셋하면
  // display가 covering/playing/revealing을 한 번도 못 보고 페이드 자체가 죽는다.
  // 얼어붙은 저장본 방어는 저장본을 인수하는 control이 `resetRuntimeVideoPhase()`로 한다.
  const sceneOpts = mergeDeep(base.sceneOpts, (r.sceneOpts ?? {}) as DeepPartialSceneOpts);
  /**
   * 대기 화면 모드 화이트리스트. **한 곳에 적는다** — 지금 화면 모드와 미뤄 둔 모드(U35)가
   * 서로 다른 목록을 보면, 새 모드를 추가할 때 한쪽만 늘어나 페이드·스팅어가 모드를 조용히
   * 버린다(선서 화면이 안 나오고 개회식 대기로 남는 형태, U60).
   */
  const STANDBY_MODES: readonly SceneOpts['standby']['mode'][] = ['main', 'pre-mission', 'oath'];
  const standbyModeOr = <T extends SceneOpts['standby']['mode'] | null>(
    v: unknown,
    fallback: T,
  ): SceneOpts['standby']['mode'] | T =>
    STANDBY_MODES.includes(v as SceneOpts['standby']['mode'])
      ? (v as SceneOpts['standby']['mode'])
      : fallback;
  sceneOpts.standby = { mode: standbyModeOr(sceneOpts.standby?.mode, 'main' as const) };
  // 미뤄 둔 대기 모드(U35)도 같은 화이트리스트다 — 저장본에 이상한 문자열이 들어 있으면
  // 다음 전환이 끝나는 순간 대기 화면이 알 수 없는 모드로 튄다.
  const standbyModeOrNull = (v: unknown): SceneOpts['standby']['mode'] | null =>
    standbyModeOr(v, null);
  sceneOpts.transitionVideo.nextStandbyMode = standbyModeOrNull(
    sceneOpts.transitionVideo.nextStandbyMode,
  );
  sceneOpts.sceneFade.nextStandbyMode = standbyModeOrNull(sceneOpts.sceneFade.nextStandbyMode);
  /**
   * 후반 단계 화면 모드도 같은 화이트리스트 계약이다 (U97). 알 수 없는 문자열이 남아 있으면
   * `steady`도 `board`도 아닌 값으로 분기가 어디에도 안 걸려 **빈 씬**이 나간다.
   * 모르는 값의 안전한 쪽은 지금까지의 화면인 `board`다 (대기 이미지가 아니라 제출 보드).
   * 단계 id는 여기서 손대지 않는다 — 큐·패널이 같이 쓰는 값이라 되돌리면 진행이 어긋난다.
   */
  const SUBMIT_MODES: readonly SceneOpts['submit']['mode'][] = ['board', 'steady'];
  sceneOpts.submit = {
    ...sceneOpts.submit,
    mode: SUBMIT_MODES.includes(sceneOpts.submit?.mode as SceneOpts['submit']['mode'])
      ? (sceneOpts.submit.mode as SceneOpts['submit']['mode'])
      : 'board',
  };
  sceneOpts.video.holdEndFrame = sceneOpts.video.holdEndFrame === true;
  /**
   * 리플레이 런타임 필드는 **지우지 않고 모양만 본다** (Q5). display가 이 경로로 방송을
   * 받으므로 여기서 비우면 재생 지시가 도달하지 못한다. 토큰은 `+1`만 하는 단조 카운터라
   * 음수·소수가 들어오면 종료 보고 대조가 영영 어긋난다 — `phaseToken`과 같은 방어다.
   */
  const rawReplayToken = sceneOpts.liveOverlay.replayToken;
  sceneOpts.liveOverlay = {
    ...sceneOpts.liveOverlay,
    /**
     * 다크 프레임 모드는 **화이트리스트**다 (U118 · `standby.mode`·`submit.mode`와 같은 계약).
     * 리플레이·마크와 달리 런타임 값이 아니라 큐가 정하는 연출 값이라, 모르는 문자열은
     * 여기서 `none`으로 접어도 잃을 지시가 없다.
     */
    frame: normalizeLiveFrameMode(sceneOpts.liveOverlay.frame),
    replay: normalizeLiveReplay(sceneOpts.liveOverlay.replay),
    replayToken:
      typeof rawReplayToken === 'number' && Number.isFinite(rawReplayToken)
        ? Math.max(0, Math.trunc(rawReplayToken))
        : 0,
    // [지금부터] 마크도 같은 계약이다 (U85) — 지우지 않고 모양만 본다. 보조 창의 버튼이
    // 방송으로 이 값을 받아 리더와 같은 라벨을 그린다.
    replayMarkAt: normalizeReplayMarkAt(sceneOpts.liveOverlay.replayMarkAt),
  };
  /**
   * 암전 런타임 필드도 **지우지 않고 모양만 본다** (U65 · 리플레이와 같은 계약).
   * display가 모든 방송을 이 경로로 받으므로 여기서 끄면 암전 지시가 도달하지 못한다.
   * `fromOpacity`가 0~1 밖이면 램프가 화면 밖 값에서 출발해 첫 프레임이 튄다.
   */
  const rawBlackout: unknown = sceneOpts.blackout;
  const blackoutRaw =
    rawBlackout !== null && typeof rawBlackout === 'object'
      ? (rawBlackout as Record<string, unknown>)
      : {};
  sceneOpts.blackout = {
    active: blackoutRaw.active === true,
    startedAt:
      typeof blackoutRaw.startedAt === 'number' && Number.isFinite(blackoutRaw.startedAt)
        ? blackoutRaw.startedAt
        : 0,
    /**
     * 0~1 **밖이면 클램프가 아니라 0**이다. 5 같은 값은 "덜 어두운 화면"이 아니라 손상된
     * 저장본이고, 1로 클램프하면 새 창이 완전 검정에서 깨어나 원인 없는 검은 화면이 된다.
     * 모르는 값의 안전한 쪽은 투명이다.
     */
    fromOpacity:
      typeof blackoutRaw.fromOpacity === 'number' &&
      Number.isFinite(blackoutRaw.fromOpacity) &&
      blackoutRaw.fromOpacity >= 0 &&
      blackoutRaw.fromOpacity <= 1
        ? blackoutRaw.fromOpacity
        : 0,
  };
  const rawAwardRevealed = sceneOpts.award.revealed;
  const awardRevealed =
    typeof rawAwardRevealed === 'number' && Number.isFinite(rawAwardRevealed)
      ? Math.max(0, Math.min(teamCount, Math.trunc(rawAwardRevealed)))
      : 0;
  const rawSelectedRank = sceneOpts.award.selectedRank;
  const selectedRank =
    typeof rawSelectedRank === 'number' &&
    Number.isInteger(rawSelectedRank) &&
    rawSelectedRank >= 1 &&
    rawSelectedRank <= teamCount
      ? rawSelectedRank
      : null;
  const revealedRanks = Array.isArray(sceneOpts.award.revealedRanks)
    ? [...new Set(sceneOpts.award.revealedRanks)].filter(
        (rank): rank is number => typeof rank === 'number' && Number.isInteger(rank) && rank >= 1 && rank <= teamCount,
      )
    : [];
  sceneOpts.award = {
    ...sceneOpts.award,
    revealed: awardRevealed,
    rankRevealed: sceneOpts.award.rankRevealed === true && awardRevealed < teamCount,
    selectedRank,
    selectedTeamRevealed: sceneOpts.award.selectedTeamRevealed === true && selectedRank !== null,
    revealedRanks,
    /**
     * U127 — 독립 공개는 **고른 등수가 있을 때만** 성립한다. 등수 없이 solo만 살아 있으면
     * 무대에 세울 카드가 없는데 이력까지 지워져 빈 화면이 된다. 필드가 없는 옛 저장본은
     * `undefined !== true`라 자연히 누적 무대로 내려앉는다(원래 모양 그대로 복원).
     */
    solo: sceneOpts.award.solo === true && selectedRank !== null,
  };
  // 유효한 단계는 그대로 흘려보내되, 알 수 없는 문자열은 idle로 떨군다 —
  // display의 phase 분기가 어디에도 안 걸려 검정이 걷히지 않는 상태로 굳는 것을 막는다.
  // 알 수 없는 단계 값은 idle로 접는다. token이 NaN이면 **모든 단계 전이가 토큰 비교에서
  // 거부되어** 글리치에 영원히 갇힌다(어느 액션도 상태를 못 바꾼다).
  if (!MOOD_PHASES.includes(sceneOpts.moodTransition.phase)) {
    sceneOpts.moodTransition = { ...sceneOpts.moodTransition, phase: 'idle', active: false };
  }
  if (!Number.isFinite(sceneOpts.moodTransition.token)) {
    sceneOpts.moodTransition = { ...sceneOpts.moodTransition, token: 0 };
  } else {
    sceneOpts.moodTransition = {
      ...sceneOpts.moodTransition,
      token: Math.trunc(sceneOpts.moodTransition.token),
    };
  }
  if (!VIDEO_PHASES.includes(sceneOpts.video.phase)) {
    sceneOpts.video = { ...sceneOpts.video, phase: 'idle' };
  }
  // JSON 가져오기·구 저장본에서 알 수 없는 게임 값이 들어와도 빈 제목/무효 CSS class를 만들지 않는다.
  const rawGame: unknown = sceneOpts.game;
  const game = rawGame !== null && typeof rawGame === 'object' ? (rawGame as Record<string, unknown>) : {};
  const eventId = game.eventId;
  const mode = game.mode;
  const winner = game.winner;
  sceneOpts.game = {
    eventId:
      typeof eventId === 'string' && P1_EVENT_ORDER.includes(eventId as P1EventId)
        ? (eventId as P1EventId)
        : base.sceneOpts.game.eventId,
    /**
     * 값이 **없으면** 기본값(오프닝), 값이 있는데 **모르는 값이면** `standby`로 접는다 (U71).
     * 둘을 가르는 이유: 알 수 없는 모드가 들어왔을 때 빈 타이틀 카드가 아니라 그 종목 그림
     * 한 장이 나와야 한다. 반대로 키 자체가 없는 옛 저장본까지 대기로 떨구면 예전
     * 동작(오프닝)이 이유 없이 달라진다.
     *
     * **U110에서 `'victory'`가 화이트리스트에서 빠졌다** — 승리 카드 씬이 폐기됐으므로
     * 그 모드를 살려 두면 렌더할 것이 없는 씬 id가 상태에 남는다. 이제 이 값은 위의
     * "모르는 값" 갈래로 떨어져 `'standby'`(그 종목 대기 이미지)가 된다: 승리 발표 도중
     * 창을 닫았다 다시 열어도 검정이 아니라 그림 한 장이 나간다.
     */
    mode: mode === undefined ? base.sceneOpts.game.mode : mode === 'opening' ? 'opening' : 'standby',
    // 승리 팀은 지금 팀 수 안의 실재하는 슬롯일 때만 살린다. 없는 팀 id가 남으면 승리 영상
    // 해석(`findWinnerVideo`)이 영영 null을 돌려준다.
    winner:
      typeof winner === 'string' && (teamIdsFor(teamCount) as string[]).includes(winner)
        ? (winner as TeamId)
        : null,
  };
  // 명단 보드의 범위(U61)도 화이트리스트다. 알 수 없는 값이면 전체 명단으로 접는다 —
  // 조를 못 고른 채 조별 보드가 나가면 화면이 어느 두 팀인지 말하지 못한다.
  const rawRoster: unknown = sceneOpts.roster;
  const roster = rawRoster !== null && typeof rawRoster === 'object' ? (rawRoster as Record<string, unknown>) : {};
  sceneOpts.roster = {
    eventId:
      typeof roster.eventId === 'string' && P1_EVENT_ORDER.includes(roster.eventId as P1EventId)
        ? (roster.eventId as P1EventId)
        : base.sceneOpts.roster.eventId,
    scope: roster.scope === 'heat' ? 'heat' : 'all',
  };
  // phaseToken은 `+1`만 하는 단조 카운터다. 음수·소수가 들어오면(손으로 고친 저장본,
  // 옛 형식) `covered/tail/revealed`의 토큰 대조가 영영 어긋나 검정이 걷히지 않는다.
  // 유한한 정수 0 이상으로 좁혀 둔다.
  const rawPhaseToken = sceneOpts.video.phaseToken;
  if (typeof rawPhaseToken !== 'number' || !Number.isFinite(rawPhaseToken)) {
    sceneOpts.video = { ...sceneOpts.video, phaseToken: 0 };
  } else {
    const clamped = Math.max(0, Math.trunc(rawPhaseToken));
    if (clamped !== rawPhaseToken) sceneOpts.video = { ...sceneOpts.video, phaseToken: clamped };
  }
  if (typeof sceneOpts.video.fadeSec !== 'number' || !Number.isFinite(sceneOpts.video.fadeSec) || sceneOpts.video.fadeSec < 0) {
    sceneOpts.video = { ...sceneOpts.video, fadeSec: settings.fadeSec };
  }
  if (sceneOpts.video.returnScene !== null && !isSceneId(sceneOpts.video.returnScene)) {
    sceneOpts.video = { ...sceneOpts.video, returnScene: null };
  }
  // 대본 아웃트로(U87). 이 필드가 없던 저장본은 `undefined`로 들어오고, 그대로 두면 display가
  // `v.outro?.color`를 못 읽는 것이 아니라 **`outro` 키 자체가 없는 상태**를 방송한다.
  // 모양이 맞지 않으면 null(= 지금까지의 검정 꼬리 페이드)로 통일한다 — 다음 재생이 상수표에서
  // 다시 채우므로 옛 저장본에서도 올림픽 인트로는 정상으로 돌아온다.
  sceneOpts.video = { ...sceneOpts.video, outro: normalizeVideoOutro(sceneOpts.video.outro) };

  const merged: AppState = {
    ...base,
    ...r,
    version: 3,
    teams,
    teamCount,
    p1,
    p2,
    ledger: Array.isArray(r.ledger) ? r.ledger : [],
    timer: { ...base.timer, ...(r.timer ?? {}) },
    sceneOpts,
    settings,
    assets: Array.isArray(r.assets) ? r.assets : [],
    hiddenMedia: Array.isArray(r.hiddenMedia) ? r.hiddenMedia.filter((f) => typeof f === 'string') : [],
    transitionRules: normalizeTransitionRules((r as { transitionRules?: unknown }).transitionRules),
    // v2 이하 저장본에는 `photos` 자체가 없다 → 기본값. v3는 필드별로 검증해서 통과시킨다.
    photos: normalizePhotos((r as { photos?: unknown }).photos),
    music: normalizeMusic((r as { music?: unknown }).music),
    // **리셋하지 않는다** — display는 모든 방송을 이 경로로 받으므로, 여기서 지우면
    // display가 램프를 한 번도 못 보고 마스터 볼륨이 5초 뒤 뚝 바뀐다 (U43).
    // 모양이 어긋난 값만 버린다. 저장본에서 되살아난 램프는 이미 끝난 시각이라
    // 리더의 첫 `volume/rampSettle`이 곧바로 최종값으로 확정한다.
    volumeRamps: normalizeVolumeRamps((r as { volumeRamps?: unknown }).volumeRamps),
    /**
     * 화면 동결(U75)은 **불린 정규화만** 한다 — 리셋하지 않는다.
     *
     * display는 모든 상태 방송을 이 경로로 받으므로 여기서 끄면 동결 지시가 도달하지 못한다
     * (영상 페이드·리플레이·암전과 같은 계약). 저장본에서 살아 돌아와도 상단 바에 큰 빨강
     * 토글과 점멸 배지가 상시 떠 있어 숨은 상태가 되지 않는다 — 그래서 암전과 달리
     * `resetRuntimeVideoPhase()`도 이 값을 건드리지 않는다.
     */
    pgm: { frozen: (r as { pgm?: { frozen?: unknown } }).pgm?.frozen === true },
    cueTransitions: normalizeCueTransitions((r as { cueTransitions?: unknown }).cueTransitions),
    cueIndex:
      typeof r.cueIndex === 'number' && Number.isFinite(r.cueIndex) ? Math.max(0, Math.trunc(r.cueIndex)) : 0,
    cueId: typeof r.cueId === 'string' && r.cueId.length > 0 ? r.cueId : null,
    seq: typeof r.seq === 'number' ? r.seq : (r.ledger?.length ?? 0),
  };
  // 제시어 씬은 패널에서 사라졌다(몸으로 말해요는 MC 진행). 예전 저장본이 그 씬을 가리키면 대기 화면으로.
  if (merged.scene === 'prompt') merged.scene = 'standby';
  return merged;
}

export function serialize(state: AppState): string {
  return JSON.stringify(state);
}

export function deserialize(json: string): AppState {
  return migrate(JSON.parse(json));
}

/**
 * 마지막 저장 실패 사유. null이면 정상.
 * 조용히 실패하면 행사 도중 새로고침 한 번에 모든 기록이 날아간다 → 화면에 배지로 띄운다.
 */
let lastSaveError: string | null = null;

export function getSaveError(): string | null {
  return lastSaveError;
}

/** 저장 성공 여부를 반환한다 (호출부가 상태 점·경고 배지를 갱신할 수 있도록) */
export function saveLocal(state: AppState): boolean {
  try {
    localStorage.setItem(LS_KEY, serialize(state));
    lastSaveError = null;
    return true;
  } catch (err) {
    const quota =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    lastSaveError = quota
      ? '브라우저 저장 용량 초과 — 이미지·영상은 자동으로 IndexedDB에 들어갑니다. [설정 → 전체 초기화] 전에 JSON을 내보내세요.'
      : `저장 실패: ${err instanceof Error ? err.message : String(err)}`;
    return false;
  }
}

/**
 * 옛 슬롯 문자 기본값(A~F + 옛 팔레트)을 색 이름 기본값으로 올린다 (U30).
 *
 * 이름과 색을 **따로** 판정한다 — 이름만 바꾸고 색은 그대로 둔 저장본에서
 * 색까지 옛 팔레트에 묶여 버리면 팀명과 화면 색이 어긋난다.
 */
function promoteLegacyTeams(state: AppState): AppState {
  return {
    ...state,
    teams: state.teams.map((team, i) => {
      const legacy = LEGACY_TEAM_DEFAULTS[i];
      if (!legacy) return team;
      const name = team.name === legacy.name ? DEFAULT_TEAM_NAMES[i] : team.name;
      const color = team.color === legacy.color ? DEFAULT_TEAM_COLORS[i] : team.color;
      return name === team.name && color === team.color ? team : { ...team, name, color };
    }),
  };
}

/**
 * 저장본을 인수할 때 한 번만 하는 일회성 승격 (U26b · U30).
 * 여기가 아니라 `migrate()`에 두면 매 상태 방송마다 사용자 설정을 덮는다 —
 * `LEGACY_MOOD_DEFAULTS` 주석 참조.
 *
 * 승격 항목마다 표식이 따로다. 분위기 승격을 이미 겪은 저장본도 U30 팀 승격은
 * 아직 안 봤을 수 있어서, 표식 하나로 묶으면 그런 저장본이 A~D에 갇힌다.
 */
export function promoteLegacyDefaults(state: AppState): AppState {
  const {
    moodDefaultsPromoted,
    teamDefaultsPromoted,
    volumeAxesPromoted,
    musicRepeatPromoted,
    replayRatePromoted2,
    victoryMusicPromoted,
  } = state.settings;
  if (
    moodDefaultsPromoted &&
    teamDefaultsPromoted &&
    volumeAxesPromoted &&
    musicRepeatPromoted &&
    replayRatePromoted2 &&
    victoryMusicPromoted
  ) {
    return state;
  }

  /**
   * 분위기 반전 길이 승격은 U53에서 **필요 없어졌다.**
   *
   * `moodGlitchSec`(단계 길이)가 `moodTotalSec`(전체 길이)로 이름이 바뀌면서, migrate가
   * 옛 값을 `글리치 + 암전`으로 읽어 그대로 옮긴다. 이름 변경은 사용자의 선택을 덮는 것이
   * 아니라 같은 뜻을 새 이름으로 읽는 것이라 migrate에 있어도 값이 흔들리지 않는다.
   * 게다가 옛 기본값 쌍(1.5 + 0.8 = 2.3초)은 새 하한 5초에 클램프돼 판별 자체가 불가능하다.
   *
   * 플래그는 남긴다 — 이미 저장된 값이고, 지우면 그 저장본이 다음 빌드에서 다시 후보가 된다.
   */
  const withTeams = teamDefaultsPromoted ? state : promoteLegacyTeams(state);
  /**
   * 단일 마스터 볼륨 → `media`/`music` 두 축 (U45).
   *
   * **여기서 한 번만** 한다. migrate는 상태 방송마다 도는 경로라 거기서 옮기면 사용자가
   * 나중에 축 값을 바꿔도 다음 방송이 옛 마스터 값으로 도로 덮는다.
   * 승격 뒤에는 `masterVolume`을 읽지 않으므로 값은 그대로 남겨 둔다(되돌리기 근거).
   */
  const legacyMaster = withTeams.settings.masterVolume;
  const promoteVolume = !volumeAxesPromoted && legacyMaster !== 1;
  /**
   * 이어재생 기본값 `off` → `section` (U49 정정).
   *
   * 사용자 원문이 "음악은 자동으로 이어서 진행되게 해줘"라 기본이 켜짐이어야 하는데 첫 판이
   * `off`로 나갔다. 그 사이 저장된 상태에는 `off`가 **명시적으로** 박혀 있어 migrate만으로는
   * 못 고친다(키가 있으니 기본값이 안 먹는다). 다른 승격과 같은 자리·같은 규칙으로 한 번만.
   * 옛 기본값과 같은 값(`off`)일 때만 올린다 — 사용자가 고른 `one`/`all`을 덮지 않는다.
   */
  const promoteRepeat = !musicRepeatPromoted && withTeams.settings.musicRepeat === 'off';
  /**
   * 리플레이 배속 기본값 `0.5` → `0.1` (U85 정정)은 **U107에서 은퇴했다.**
   *
   * 기본값이 다시 0.5로 돌아오면서 "0.5가 박힌 저장본을 0.1로 올린다"는 승격은 방향이
   * 거꾸로가 됐다 — 지금 그대로 두면 아주 옛 저장본(U85조차 못 본 pre-U85 0.5 저장본)을
   * 엉뚱하게 0.1로 내려버린다. `LEGACY_REPLAY_RATE`·`replayRatePromoted` 플래그는 기록으로만
   * 남기고 이 함수는 더 이상 참조하지 않는다.
   *
   * 대신 U107 복귀 승격을 반대 방향(`0.1` → `0.5`)으로 새로 둔다. 사용자 원문 "중계 0.1배속은
   * 너무 느리네. 0.5배속으로 하자"(2026-09-05 04:52). U85가 이미 훑고 지나간 저장본
   * (`replayRatePromoted === true`)에 `0.1`이 남아 있으면 그것이 "U85 자동 승격 결과"인지
   * "그 뒤 사용자가 직접 고른 0.1"인지 구분할 수 없다 — `U107_LEGACY_REPLAY_RATE` 주석 참조.
   * 구분 불가를 이유로 막지 않고 **일괄로 0.5까지 올린다.** 새 표식 `replayRatePromoted2`로
   * 한 번만 — 이후 사용자가 설정 탭에서 0.1을 다시 고르면 그 선택은 덮지 않는다.
   */
  const promoteRate2 =
    !replayRatePromoted2 &&
    withTeams.settings.replayRatePromoted &&
    withTeams.settings.replayRate === U107_LEGACY_REPLAY_RATE;
  return {
    ...withTeams,
    settings: {
      ...withTeams.settings,
      ...(promoteVolume ? { mediaVolume: legacyMaster, musicVolume: legacyMaster } : {}),
      ...(promoteRepeat ? { musicRepeat: 'section' as const } : {}),
      ...(promoteRate2 ? { replayRate: REPLAY_DEFAULTS.rate } : {}),
      // 승격 여부와 무관하게 "새 빌드가 이 저장본을 봤다"를 남긴다 — 안 그러면 승격 뒤에
      // 사용자가 직접 고른 0.1이 다음 실행에서 다시 승격 후보가 되어 그 선택을 덮는다.
      replayRatePromoted2: true,
      // 승격 여부와 무관하게 "새 빌드가 이 저장본을 봤다"를 남긴다 — 안 그러면 승격 뒤에
      // 사용자가 직접 끈 `off`가 다음 실행에서 다시 승격 후보가 되어 그 선택을 덮는다.
      musicRepeatPromoted: true,
      // 승격 여부와 무관하게 "새 빌드가 이 저장본을 봤다"를 남긴다 — 안 그러면 나중에
      // 축을 1로 맞춘 저장본이 다시 승격 후보가 되어 사용자의 선택을 덮는다.
      volumeAxesPromoted: true,
      // 승격 여부와 무관하게 "새 빌드가 이 저장본을 봤다"를 남긴다. 안 그러면 옛 기본값이
      // 아니었던 저장본이 나중에 1.5/0.8로 바뀌었을 때 그 선택을 승격이 덮는다.
      moodDefaultsPromoted: true,
      teamDefaultsPromoted: true,
      // 공개본은 행사별 승리 음악을 자동 지정하지 않는다. 기존 표식은 저장본 호환을 위해 남긴다.
      victoryMusicPromoted: true,
    },
  };
}

export function loadLocal(): AppState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const restored = promoteLegacyDefaults(deserialize(raw));
    return restored.music.playing
      ? { ...restored, music: { ...restored.music, playing: false } }
      : restored;
  } catch {
    return null;
  }
}
