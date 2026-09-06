/**
 * 승리 영상 해석기 (U100) — 승리 팀 → `winner_<색>.webm` 알파 오버레이 에셋.
 *
 * ## 왜 별도 모듈인가
 * 매치 영상(`match-video.ts`)은 **두 팀 조합**이 파일을 정하고 좌·우 배치까지 파일이 쥔다.
 * 승리 영상은 **한 팀**이 정하고 배치 개념이 없다 — 규칙이 다르므로 같은 파일에 섞지 않는다.
 * 공통점(슬롯 색에서 파일 이름을 파생한다)은 `DEFAULT_TEAM_NAMES`라는 같은 정본을 보는 것으로
 * 지킨다.
 *
 * ## 색 이름은 파생한다 (U30과 같은 규칙)
 * `DEFAULT_TEAM_NAMES`가 슬롯 색 이름의 정본이다(`YELLOW/BLUE/RED/GREEN` = `--team-1..4`).
 * 여기서 색 이름을 다시 적으면 "화면이 조용히 거짓말하는" 실패가 되살아난다. 팀 **이름**을
 * 설정에서 바꿔도 파일은 슬롯을 따른다 — 로고(`logos.ts`)·매치 영상과 같은 규칙이다.
 *
 * ## 왜 전환이 없는가
 * 이 4편은 **알파(yuva420p, `alpha_mode=1`)를 갖고 완전 투명에서 시작한다.** 즉 도입 페이드가
 * 영상 안에 bake 되어 있어, 씬 전환·스팅어로 한 번 더 덮으면 오히려 이중 연출이 된다.
 * 그래서 `cueActions`의 승리 경로는 `scene/set`을 내지 않고 `overlay/play` 하나만 낸다 —
 * `scene-routing.ts`의 전환 래핑은 `scene/set`만 감싸므로, 액션을 내지 않는 것 자체가
 * "전환 없음"의 구조적 보장이다(§2-3, 매치 영상과 같은 이유).
 */

import { DEFAULT_TEAM_NAMES } from './state';
import { TEAM_IDS } from './types';
import type { TeamId } from './types';

/** 승리 영상 후보를 찾을 때 필요한 최소 에셋 정보 */
export interface WinnerAssetLike {
  id: string;
}

export interface WinnerVideo {
  assetId: string;
  file: string;
  /** 이 영상이 그리는 팀 (= 슬롯) */
  teamId: TeamId;
}

/**
 * 승리 영상이 있는 슬롯 색 (소문자). `public/media/`에 실제로 놓인 파일 이름의 거울이다 —
 * `winner-video.test.ts`가 manifest·디스크와 대조해 어긋남을 잡는다.
 *
 * 오피셜 4팀(슬롯 1~4) 밖(PURPLE·TEAL)은 영상이 없다. 그 슬롯이 이겼으면 승리 보드 카드로
 * 떨어진다 — 없는 파일을 기다리며 검정이 나가는 것보다 낫다.
 */
export const WINNER_FILE_COLORS: readonly string[] = ['blue', 'green', 'red', 'yellow'];

/** 슬롯 색 이름 (소문자). 오피셜 4팀 밖 슬롯이면 null */
function slotColor(id: TeamId): string | null {
  const slot = TEAM_IDS.indexOf(id);
  const name = slot >= 0 ? DEFAULT_TEAM_NAMES[slot] : undefined;
  return name ? name.toLowerCase() : null;
}

/** 이 팀의 승리 영상 파일 이름. 영상이 없는 슬롯이면 null */
export function winnerVideoFile(teamId: TeamId): string | null {
  const color = slotColor(teamId);
  return color && WINNER_FILE_COLORS.includes(color) ? `winner_${color}.webm` : null;
}

/** 파일 이름 → 에셋 id (manifest 유래 에셋의 `media:` 규약) */
export function winnerAssetId(file: string): string {
  return `media:${file}`;
}

/**
 * 이 팀의 승리 영상. 파일 자리가 없거나 **에셋으로 등록돼 있지 않으면** null이라,
 * 부르는 쪽이 승리 보드 카드로 떨어진다(검정 금지 계약).
 */
export function findWinnerVideo(
  assets: ReadonlyArray<WinnerAssetLike>,
  teamId: TeamId | null,
): WinnerVideo | null {
  if (!teamId) return null;
  const file = winnerVideoFile(teamId);
  if (!file) return null;
  const assetId = winnerAssetId(file);
  return assets.some((asset) => asset.id === assetId) ? { assetId, file, teamId } : null;
}

/**
 * 이 에셋이 **재생될 수 있는** 승리 영상인가 — 큐 자동 편입에서 제외하는 기준.
 * 큐 자리는 `victory-<종목>`이 이미 갖고 있다(매치 영상과 같은 규칙).
 *
 * ## 판정 근거는 `WINNER_FILE_COLORS` 하나다 (리뷰 n1)
 * 이름 모양만 보고(`winner_[a-z]+\.webm`) 참을 돌려주면 목록 밖 색이 **유령 에셋**이 된다:
 * `winner_purple.webm`을 media 폴더에 넣으면 `cueWithVideos`의 자동 편입에서는 "승리 영상이니
 * 빼라"고 걸러지는데, `findWinnerVideo`는 그 색을 모르니 null을 준다 — 등록만 되고 어디서도
 * 재생되지 않는다. 두 판정이 **같은 목록**을 보면 그런 자리가 생기지 않는다: 목록 밖 색은
 * 승리 영상이 아니므로 `ambient`로 등록되고 `cueAfter`로 평범하게 큐에 꽂을 수 있다.
 */
export function isWinnerVideoAsset(assetId: string): boolean {
  const match = /^media:winner_([a-z]+)\.webm$/.exec(assetId);
  return match !== null && WINNER_FILE_COLORS.includes(match[1]);
}
