import * as assets from './tab-assets';
import * as award from './tab-award';
import * as ledger from './tab-ledger';
import * as music from './tab-music';
import * as p1 from './tab-p1';
import * as p2 from './tab-p2';
import * as photos from './tab-photos';
import * as roster from './tab-roster';
import * as settings from './tab-settings';
import * as teams from './tab-teams';
import * as timer from './tab-timer';
import type { Ctx } from './ctx';

export interface TabDef {
  meta: { id: string; label: string };
  render(ctx: Ctx): HTMLElement;
}

/**
 * 탭 순서 — **진행 중에 손이 가는 순서**다. `p1`이 맨 앞이고, 뒤로 갈수록 덜 만진다(U78).
 *
 * `p2`(2부 컨트롤)는 `p1`(1부 컨트롤) 바로 옆이다(U69) — 짝이 되는 두 탭이 세 칸 떨어져 있으면
 * 진행 중에 눈이 한 번 더 훑어야 한다. 잠금 중에도 안전하다: `p2`는 `enabledIds`에서 빠져
 * 방향키가 건너뛰고, 클릭해도 `tab-p2`가 잠금 화면만 그린다(2부 문자열 0 계약 유지).
 *
 * `photos`는 `assets` 옆(수집물 관리끼리)이 아니라 뒤쪽 숨김 묶음으로 내려갔다 — 사진은
 * 행사 중에 **찍히기만** 하고 조작 화면에서 손댈 일이 거의 없다. 잠금 대상은 아니다:
 * 사진 자체는 1부에도 찍히고, 2부에 수집된 사진은 탭 안에서 `PhotoMeta.p2` 도장으로
 * 걸러진다(계획 §11 H2).
 *
 * `teams`(팀 설정)는 `settings` 바로 **뒤**다(U78) — 행사 시작 전에 한 번 채우면 그날 다시
 * 열 일이 없는데 맨 앞에 있어 매번 눈에 걸렸다. 같은 이유로 `ledger`도 `award` 옆을 떠났다:
 * 점수의 원본 기록은 사고가 났을 때만 여는 화면이다(우측 상시 레일 → 탭으로 내린 U34의 연장).
 * 잠금 대상이 아니다: 2부 항목은 잠금이 풀린 뒤에야 기록되므로 1부 중에는 나타날 수 없다.
 */
export const TABS: TabDef[] = [p1, p2, timer, roster, award, music, assets, settings, ledger, photos, teams];

/**
 * 꺽쇠 뒤에 접어 두는 탭 묶음 (U78). 사용자 지시: "점수원장이랑 팀설정이랑 현장사진은
 * 숨기고 싶음. 펼치면 그 메뉴가 나오게 꺽쇠 아이콘 하나 넣어놔."
 *
 * **`TABS`의 꼬리와 같은 순서·같은 원소**여야 한다 — 묶음이 중간에 끼면 꺽쇠 앞뒤로
 * 탭이 갈라져 DOM 순서와 방향키 순서가 어긋난다. `tabs.test.ts`가 이 못을 박는다.
 */
export const COLLAPSED_TAB_IDS: readonly string[] = ['ledger', 'photos', 'teams'];

/**
 * 접힌 묶음이 실제로 펼쳐져 있는가.
 *
 * 저장된 플래그(`settings.tabbarMoreOpen`)와 무관하게, **활성 탭이 묶음 안이면 무조건 펼친다** —
 * 저장본을 열었더니 지금 보고 있는 탭이 화면에 없는 상태를 만들지 않기 위해서다.
 */
export function isTabMoreOpen(moreOpen: boolean, activeId: string): boolean {
  return moreOpen || COLLAPSED_TAB_IDS.includes(activeId);
}

/**
 * 지금 화면에 보이고 방향키가 닿을 수 있는 탭 id (U78).
 *
 * `enabled`에서 시작한다(잠긴 `p2`는 이미 빠져 있다) → 접힌 묶음을 마저 뺀다.
 * 렌더와 키보드 내비게이션이 **같은 한 함수**를 쓰기 위한 순수 함수다.
 */
export function visibleTabIds(
  order: readonly string[],
  enabled: readonly string[],
  moreOpen: boolean,
  activeId: string,
): string[] {
  const open = isTabMoreOpen(moreOpen, activeId);
  const enabledSet = new Set(enabled);
  return order.filter((id) => enabledSet.has(id) && (open || !COLLAPSED_TAB_IDS.includes(id)));
}

export function findTab(id: string): TabDef {
  return TABS.find((t) => t.meta.id === id) ?? TABS[0];
}

export function isTabActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function nextTabFocus(
  currentId: string,
  key: string,
  enabledIds: readonly string[],
  orderedIds: readonly string[] = enabledIds,
): string | null {
  if (enabledIds.length === 0) return null;
  if (key === 'Home') return enabledIds[0];
  if (key === 'End') return enabledIds[enabledIds.length - 1];
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;

  const current = orderedIds.indexOf(currentId);
  if (current < 0) return null;
  const offset = key === 'ArrowRight' ? 1 : -1;
  const enabled = new Set(enabledIds);
  for (let step = 1; step <= orderedIds.length; step += 1) {
    const candidate = orderedIds[(current + offset * step + orderedIds.length) % orderedIds.length];
    if (enabled.has(candidate)) return candidate;
  }
  return null;
}
