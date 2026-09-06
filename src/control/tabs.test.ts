import { describe, expect, it } from 'vitest';

import * as tabs from './tabs';

const ORDERED = [
  'p1',
  'p2',
  'timer',
  'roster',
  'award',
  'music',
  'assets',
  'settings',
  'ledger',
  'photos',
  'teams',
];
/** 잠긴 `p2`만 빠진 목록 — 숨긴 묶음까지 펼쳐진 상태 */
const ENABLED = ORDERED.filter((id) => id !== 'p2');
/** 잠긴 `p2` + 접힌 꼬리 세 탭이 빠진, 실제 화면에 보이는 목록 (U78 기본 상태) */
const VISIBLE = ENABLED.filter((id) => !['ledger', 'photos', 'teams'].includes(id));

function navigationDecision(): (
  currentId: string,
  key: string,
  enabledIds: readonly string[],
  orderedIds?: readonly string[],
) => string | null {
  const decision = (tabs as Record<string, unknown>).nextTabFocus;
  expect(decision).toBeTypeOf('function');
  return decision as (
    currentId: string,
    key: string,
    enabledIds: readonly string[],
    orderedIds?: readonly string[],
  ) => string | null;
}

describe('nextTabFocus', () => {
  it('행사 음악 탭을 시상과 영상 에셋 사이에 둔다', () => {
    expect(tabs.TABS.map((tab) => tab.meta.id)).toEqual(ORDERED);
  });

  /** U69 — 짝이 되는 두 컨트롤 탭을 붙여 둔다. 이름도 `1부/2부`로 대칭이다. */
  it('2부 컨트롤을 1부 컨트롤 바로 뒤에 두고 이름을 대칭으로 맞춘다', () => {
    const ids = tabs.TABS.map((tab) => tab.meta.id);
    expect(ids.indexOf('p2')).toBe(ids.indexOf('p1') + 1);
    expect(tabs.findTab('p1').meta.label).toBe('1부 컨트롤');
    expect(tabs.findTab('p2').meta.label).toBe('2부 컨트롤');
  });

  /**
   * U78 — 사용자 지시: "팀 설정도 처음 하면 다시 할일 없으니까 설정 뒤로 빼줘."
   * 행사 전에 한 번 채우면 그날 다시 열 일이 없는 탭이 맨 앞을 차지하고 있었다.
   */
  it('팀 설정을 설정 바로 뒤로 빼고, 1부 컨트롤을 맨 앞에 둔다', () => {
    const ids = tabs.TABS.map((tab) => tab.meta.id);
    expect(ids[0]).toBe('p1');
    // 설정보다 뒤이고, 숨김 묶음 안에서도 마지막이다 — 그날 가장 덜 여는 탭
    expect(ids.indexOf('teams')).toBeGreaterThan(ids.indexOf('settings'));
    expect(ids[ids.length - 1]).toBe('teams');
    expect(tabs.findTab('teams').meta.label).toBe('팀 설정');
  });

  /** 숨김 묶음은 **꼬리에 통째로** 있어야 한다 — 중간에 끼면 꺽쇠 앞뒤로 탭이 갈라진다. */
  it('숨긴 세 탭을 순서 꼬리에 모아 둔다', () => {
    const ids = tabs.TABS.map((tab) => tab.meta.id);
    expect(tabs.COLLAPSED_TAB_IDS).toEqual(['ledger', 'photos', 'teams']);
    expect(ids.slice(-tabs.COLLAPSED_TAB_IDS.length)).toEqual([...tabs.COLLAPSED_TAB_IDS]);
    expect(tabs.findTab('ledger').meta.label).toBe('점수 원장');
  });

  it('wraps ArrowRight from the last visible tab to the first', () => {
    expect(navigationDecision()('settings', 'ArrowRight', VISIBLE)).toBe('p1');
  });

  it('wraps ArrowLeft from the first visible tab to the last', () => {
    expect(navigationDecision()('p1', 'ArrowLeft', VISIBLE)).toBe('settings');
  });

  it('moves Home and End to the first and last visible tabs', () => {
    const decide = navigationDecision();
    expect(decide('timer', 'Home', VISIBLE)).toBe('p1');
    expect(decide('timer', 'End', VISIBLE)).toBe('settings');
  });

  /** U78 — 접힌 탭은 화면에 없다. 방향키가 거기 멈추면 보이지 않는 탭에 포커스가 갇힌다. */
  it('접힌 상태에서는 방향키가 숨긴 탭을 건너뛰고 처음으로 돌아온다', () => {
    const decide = navigationDecision();
    expect(decide('settings', 'ArrowRight', VISIBLE, ORDERED)).toBe('p1');
    expect(decide('p1', 'ArrowLeft', VISIBLE, ORDERED)).toBe('settings');
  });

  it('펼친 상태에서는 설정 오른쪽으로 숨긴 탭이 이어진다', () => {
    const decide = navigationDecision();
    expect(decide('settings', 'ArrowRight', ENABLED, ORDERED)).toBe('ledger');
    expect(decide('teams', 'ArrowRight', ENABLED, ORDERED)).toBe('p1');
    expect(decide('teams', 'End', ENABLED)).toBe('teams');
  });

  it('ignores keys that do not navigate tabs', () => {
    expect(navigationDecision()('timer', 'Enter', ENABLED)).toBeNull();
  });

  it('moves out of an active locked tab to adjacent enabled tabs', () => {
    const decide = navigationDecision();
    expect(decide('p2', 'ArrowLeft', ENABLED, ORDERED)).toBe('p1');
    expect(decide('p2', 'ArrowRight', ENABLED, ORDERED)).toBe('timer');
  });

  /**
   * U69 — `2부 컨트롤`을 `1부 컨트롤` 옆으로 옮기면서 잠금 계약이 그대로인지 못을 박는다.
   * 잠긴 `p2`는 `enabledIds`에 없으므로 방향키가 건너뛴다. 두 탭이 붙어 있어도
   * 1부 진행 중 방향키만으로는 2부 탭에 닿을 수 없다.
   */
  it('잠금 중에는 1부 컨트롤에서 방향키로 2부 컨트롤에 닿지 않는다 (건너뛰고 타이머로)', () => {
    const decide = navigationDecision();
    expect(ENABLED).not.toContain('p2');
    expect(decide('p1', 'ArrowRight', ENABLED, ORDERED)).toBe('timer');
    expect(decide('timer', 'ArrowLeft', ENABLED, ORDERED)).toBe('p1');
  });

  it('잠금이 풀리면 1부 컨트롤 바로 오른쪽이 2부 컨트롤이다', () => {
    const decide = navigationDecision();
    expect(decide('p1', 'ArrowRight', ORDERED, ORDERED)).toBe('p2');
    expect(decide('p2', 'ArrowRight', ORDERED, ORDERED)).toBe('timer');
  });
});

describe('visibleTabIds (U78 숨긴 탭 묶음)', () => {
  it('접혀 있으면 숨긴 세 탭이 목록에서 빠진다', () => {
    expect(tabs.visibleTabIds(ORDERED, ENABLED, false, 'p1')).toEqual(VISIBLE);
  });

  it('펼치면 숨긴 세 탭이 꼬리에 그대로 붙는다', () => {
    expect(tabs.visibleTabIds(ORDERED, ENABLED, true, 'p1')).toEqual(ENABLED);
  });

  /**
   * 저장본을 열었더니 지금 보고 있는 탭이 화면에 없는 상태를 만들지 않는다 —
   * 활성 탭이 묶음 안이면 저장된 플래그와 무관하게 펼친다.
   */
  it('활성 탭이 숨긴 묶음 안이면 접힘 플래그를 무시하고 펼친다', () => {
    expect(tabs.isTabMoreOpen(false, 'ledger')).toBe(true);
    expect(tabs.isTabMoreOpen(false, 'p1')).toBe(false);
    expect(tabs.visibleTabIds(ORDERED, ENABLED, false, 'photos')).toEqual(ENABLED);
    expect(tabs.visibleTabIds(ORDERED, ENABLED, false, 'photos')).toContain('photos');
  });

  it('잠긴 2부 컨트롤은 펼침 여부와 무관하게 계속 빠져 있다', () => {
    expect(tabs.visibleTabIds(ORDERED, ENABLED, true, 'p1')).not.toContain('p2');
    expect(tabs.visibleTabIds(ORDERED, ENABLED, false, 'teams')).not.toContain('p2');
  });
});

describe('isTabActivationKey', () => {
  it('isolates native Enter and Space activation from global hotkeys', () => {
    const predicate = (tabs as Record<string, unknown>).isTabActivationKey;
    expect(predicate).toBeTypeOf('function');
    const isActivation = predicate as (key: string) => boolean;
    expect(isActivation('Enter')).toBe(true);
    expect(isActivation(' ')).toBe(true);
    expect(isActivation('ArrowRight')).toBe(false);
  });
});
