/**
 * 팀 로고 해석기 — 상태의 `logoAssetId`를 화면에 붙일 수 있는 URL로 바꾼다.
 *
 * 왜 이 모듈이 필요한가:
 *  로고를 base64로 상태에 넣으면 팀 6개 × 수백 KB 만으로 localStorage 5MB 한도를 넘겨
 *  **저장 전체가 조용히 실패**한다(P4 생존 위반). 그래서 blob은 IndexedDB에 두고
 *  상태에는 id만 남긴다. 대신 화면을 그릴 때 id → objectURL 변환이 필요한데,
 *  그 변환은 비동기라 순수 뷰 함수 안에서 await할 수 없다.
 *
 *  해법: 캐시에 있으면 즉시 URL을 주고, 없으면 백그라운드로 로드한 뒤 리스너로 재렌더를 요청한다.
 *  (첫 프레임에만 로고가 비고, 곧바로 채워진다. control·display 모두 같은 방식.)
 */

import { getAsset } from './db';
import { DEFAULT_TEAM_NAMES } from './state';
import { CONFIRMED_TEAM_COUNT, TEAM_IDS } from './types';

interface LogoHost {
  /** 팀 슬롯 id — 업로드가 없을 때 슬롯 기본 로고를 고르는 열쇠 */
  id?: string;
  logoAssetId?: string;
  logoDataUrl?: string;
}

/**
 * 오피셜 팀 배지 (U31) — 슬롯 1~4의 기본 로고.
 *
 * 파일 이름은 **`DEFAULT_TEAM_NAMES`에서 파생**한다. 그 목록이 곧 슬롯 색 이름의 정본이라
 * (`YELLOW/BLUE/RED/GREEN` = `--team-1..4`), 여기서 색 이름을 다시 적으면 둘이 어긋나는 순간
 * 화면이 조용히 거짓말을 한다 (U30에서 이미 겪은 실패 모드).
 *
 * 슬롯 5·6은 이번 행사에 없는 호환 슬롯이라 오피셜 배지도 없다 — 기존 이니셜 배지로 남는다.
 * 사용자가 팀 **이름**을 바꿔도 슬롯 로고는 그대로다. 로고 교체 경로는 설정 탭 업로드 하나뿐.
 */
export const DEFAULT_TEAM_LOGOS: readonly string[] = DEFAULT_TEAM_NAMES.slice(
  0,
  CONFIRMED_TEAM_COUNT,
).map((name) => `./media/team_logo_${name.toLowerCase()}.svg`);

const DEFAULT_LOGO_SET = new Set(DEFAULT_TEAM_LOGOS);

/** 슬롯 기본 로고. 오피셜 배지가 없는 슬롯(t5·t6)이면 undefined */
export function defaultLogoUrl(team: LogoHost): string | undefined {
  const slot = team.id ? TEAM_IDS.indexOf(team.id as (typeof TEAM_IDS)[number]) : -1;
  return slot < 0 ? undefined : DEFAULT_TEAM_LOGOS[slot];
}

/** 이 URL이 오피셜 배지인가 — 아바타 링 두께를 정하는 CSS 훅 판정에 쓴다 */
export function isDefaultTeamLogo(url: string | undefined): boolean {
  return url !== undefined && DEFAULT_LOGO_SET.has(url);
}

/**
 * 로고 `<img>`의 클래스. 오피셜 배지일 때만 `team-badge`를 덧붙인다.
 *
 * 배지 원본이 이미 **팀 색 테두리를 가진 원형**이라, 아바타의 6px 팀 색 링을 그대로 두면
 * 이중 링이 된다. 사용자가 올린 임의 그림에는 그 링이 팀 식별의 유일한 신호라 손대지 않는다.
 */
export function logoClass(base: string, url: string): string {
  return isDefaultTeamLogo(url) ? `${base} team-badge` : base;
}

const urls = new Map<string, string>();
const pending = new Set<string>();
const missing = new Set<string>();
let onReady: (() => void) | null = null;

/** 새 로고가 준비되면 호출할 재렌더 콜백 */
export function setLogoListener(fn: (() => void) | null): void {
  onReady = fn;
}

function load(id: string): void {
  // 테스트(node)에는 IndexedDB가 없다 — 순수 뷰 함수에서 호출되므로 조용히 건너뛴다
  if (typeof indexedDB === 'undefined') return;
  if (pending.has(id) || urls.has(id) || missing.has(id)) return;
  pending.add(id);
  void getAsset(id)
    .then((rec) => {
      if (rec) urls.set(id, URL.createObjectURL(rec.blob));
      else missing.add(id);
    })
    .catch(() => missing.add(id))
    .finally(() => {
      pending.delete(id);
      onReady?.();
    });
}

/**
 * 화면에 쓸 로고 URL. 우선순위는 **업로드 → 구버전 dataUrl → 슬롯 기본 배지**다.
 *
 * 업로드 blob을 아직 읽는 중이면 undefined를 준다(로고 없이 그리고, 준비되면 재렌더).
 * 여기서 기본 배지로 채우면 한 프레임 뒤 사용자 로고로 갈아끼워지는 깜빡임이 생긴다.
 * 반대로 blob이 **정말 사라진** 경우(`missing`)는 되돌아올 것이 없으므로 기본 배지로 내린다.
 */
export function logoUrl(team: LogoHost): string | undefined {
  const id = team.logoAssetId;
  if (id) {
    const u = urls.get(id);
    if (u) return u;
    if (!missing.has(id)) {
      load(id);
      return undefined;
    }
  }
  return team.logoDataUrl ?? defaultLogoUrl(team);
}

/** 팀 목록의 로고를 미리 읽어 둔다 (첫 프레임 깜빡임 감소) */
export function primeLogos(teams: LogoHost[]): void {
  for (const t of teams) if (t.logoAssetId) load(t.logoAssetId);
}

/** 로고를 지웠을 때 캐시와 objectURL을 정리한다 */
export function forgetLogo(id: string): void {
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  missing.delete(id);
}
