/**
 * 매치 영상 해석기 (U36) — 대결 조합 두 팀 → `match_<좌>_<우>.webm` 에셋.
 *
 * ## 좌·우는 파일이 정한다
 * 6개 영상은 각각 조합 하나를 **고정된 좌·우 배치로** 그려 두었다. 앱이 순서를 다시 정하면
 * 화면의 팀 배치와 보더 방향이 어긋난다. 그래서 두 순서(`a_b`, `b_a`)를 모두 만들어 보고
 * **실제로 존재하는 파일 쪽**을 쓴다 — 파일 목록 자체가 좌·우의 정본이고, 앱에는 조합표가 없다.
 *
 * ## 색 이름은 파생한다
 * `DEFAULT_TEAM_NAMES`가 슬롯 색 이름의 정본이다(`YELLOW/BLUE/RED/GREEN` = `--team-1..4`).
 * 여기서 색 이름을 다시 적으면 U30에서 겪은 "화면이 조용히 거짓말하는" 실패가 되살아난다.
 * 팀 **이름**을 설정에서 바꿔도 파일은 슬롯을 따른다 — 로고(`logos.ts`)와 같은 규칙이다.
 */

import { DEFAULT_TEAM_NAMES } from './state';
import { TEAM_IDS } from './types';
import type { TeamId } from './types';

/** 매치 영상 후보를 찾을 때 필요한 최소 에셋 정보 */
export interface MatchAssetLike {
  id: string;
}

export interface MatchVideo {
  assetId: string;
  file: string;
  /** 영상 안 좌·우 순서 = 파일명 순서. 대결 보더도 이 순서로 맞춘다. */
  order: [TeamId, TeamId];
}

/** 슬롯 색 이름 (소문자). 오피셜 4팀 밖 슬롯이면 null */
function slotColor(id: TeamId): string | null {
  const slot = TEAM_IDS.indexOf(id);
  const name = slot >= 0 ? DEFAULT_TEAM_NAMES[slot] : undefined;
  return name ? name.toLowerCase() : null;
}

/** 좌·우가 정해진 한 방향의 파일 이름. 슬롯 색이 없으면 null */
export function matchVideoFile(left: TeamId, right: TeamId): string | null {
  const l = slotColor(left);
  const r = slotColor(right);
  return l && r && l !== r ? `match_${l}_${r}.webm` : null;
}

/**
 * 대결 타일 정본 순서 (U57) — `public/media/`에 실제로 놓인 매치 영상 파일 이름 순서다.
 *
 * 사용자가 "타일 순서를 매치 파일 이름 순으로 고정해 달라"고 지정했다. 파일 이름 알파벳순이
 * 곧 그 순서이고, 이 배열은 **디스크 목록의 거울**이다 — 슬롯↔색 매핑을 여기서 다시 적는 것이
 * 아니다(그 매핑은 아래 `matchVideoFile`이 `slotColor`로만 만든다, U30). 파일이 늘거나
 * 이름이 바뀌면 여기도 같이 고친다. `match-video.test.ts`가 manifest와 대조해 어긋남을 잡는다.
 */
export const MATCH_FILE_ORDER: readonly string[] = [
  'match_blue_red.webm',
  'match_blue_yellow.webm',
  'match_green_blue.webm',
  'match_green_red.webm',
  'match_green_yellow.webm',
  'match_red_yellow.webm',
];

/**
 * 이 조합의 파일 자리와 좌·우. 두 방향 파일 이름을 모두 만들어 보고(색 이름은 `slotColor`가
 * 낸다) `MATCH_FILE_ORDER`에서 찾는다.
 *
 * **에셋 등록 여부를 보지 않는다** — `findMatchVideo`와 다른 점이다. 타일이 무엇을 어느 쪽에
 * 그릴지는 매니페스트가 아직 안 들어왔을 때도 같아야 한다. 등록 전에는 슬롯 순서로, 등록 뒤에는
 * 파일 순서로 그리면 조작 화면이 로딩 도중 한 번 뒤집힌다(U57 실사고).
 */
function matchFileSeat(a: TeamId, b: TeamId): { index: number; order: [TeamId, TeamId] } | null {
  for (const [left, right] of [
    [a, b],
    [b, a],
  ] as const) {
    const file = matchVideoFile(left, right);
    if (!file) continue;
    const index = MATCH_FILE_ORDER.indexOf(file);
    if (index >= 0) return { index, order: [left, right] };
  }
  return null;
}

/** 타일 목록에서 갖는 자리. 파일이 없는 조합(5·6 슬롯 등)은 `Infinity`라 뒤로 밀린다. */
export function matchPairOrderIndex(a: TeamId, b: TeamId): number {
  return matchFileSeat(a, b)?.index ?? Number.POSITIVE_INFINITY;
}

/**
 * 파일 이름이 정한 좌·우 (= 영상 안 팀 배치, U36). 파일이 없는 조합이면 null이라
 * 부르는 쪽이 슬롯 오름차순으로 떨어진다.
 */
export function matchPairFileOrder(a: TeamId, b: TeamId): [TeamId, TeamId] | null {
  return matchFileSeat(a, b)?.order ?? null;
}

/** 파일 이름 → 에셋 id (manifest 유래 에셋의 `media:` 규약) */
export function matchAssetId(file: string): string {
  return `media:${file}`;
}

/**
 * 두 팀의 매치 영상. 등록된 에셋 중 존재하는 방향을 쓰고, 그 방향이 곧 좌·우다.
 * 어느 방향도 없으면 null (= 영상 없음, 보더만 설정).
 */
export function findMatchVideo(
  assets: ReadonlyArray<MatchAssetLike>,
  a: TeamId,
  b: TeamId,
): MatchVideo | null {
  for (const [left, right] of [
    [a, b],
    [b, a],
  ] as const) {
    const file = matchVideoFile(left, right);
    if (!file) continue;
    const assetId = matchAssetId(file);
    if (assets.some((asset) => asset.id === assetId)) return { assetId, file, order: [left, right] };
  }
  return null;
}

/** 이 에셋이 매치 영상인가 — 큐 자동 편입에서 제외하는 기준 (큐 자리는 `match-<종목>`이 갖는다) */
export function isMatchVideoAsset(assetId: string): boolean {
  return /^media:match_[a-z]+_[a-z]+\.webm$/.test(assetId);
}
