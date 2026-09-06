import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import {
  ROSTER_MEMBER_PRESETS,
  ROSTER_PRESET_LABEL,
  rosterCardStyle,
  rosterBroadcastButtons,
  rosterInputVisible,
  rosterParticipation,
  toggleRosterMember,
} from './tab-roster';

// 테스트 환경이 `environment: 'node'`(DOM 없음)라 render(ctx)를 직접 부를 수 없다 —
// 렌더가 실제로 이 분기를 쓰는지는 소스 텍스트로 확인한다 (tab-p1.test.ts·tab-ledger.test.ts와 같은 방식).
const source = readFileSync(new URL('./tab-roster.ts', import.meta.url), 'utf8');

it('종목별 출전 인원 계약을 명단 입력에 표시한다', () => {
  expect(rosterParticipation('curling')).toBe('팀당 2명 출전');
  expect(rosterParticipation('newspaper')).toBe('팀당 2명 출전');
  expect(rosterParticipation('sticky')).toBe('팀당 1~2명 출전');
  expect(rosterParticipation('sync')).toBe('팀 전체 참여');
});

it('기본 4팀에 7명씩 가상 프리셋을 제공한다', () => {
  for (const id of ['t1', 't2', 't3', 't4'] as const) {
    expect(ROSTER_MEMBER_PRESETS[id]).toHaveLength(7);
  }
});

it('프리셋 선택은 종목 정원을 지키며 같은 이름을 다시 누르면 해제한다', () => {
  expect(toggleRosterMember('curling', '샘플 참가자 19, 샘플 참가자 33', '샘플 참가자 12')).toEqual({
    text: '샘플 참가자 19, 샘플 참가자 33',
    limitReached: true,
  });
  expect(toggleRosterMember('curling', '샘플 참가자 19, 샘플 참가자 33', '샘플 참가자 19')).toEqual({
    text: '샘플 참가자 33',
    limitReached: false,
  });
  expect(toggleRosterMember('sync', '', '샘플 참가자 19')).toEqual({ text: '샘플 참가자 19', limitReached: false });
});

describe('끈끈이 낚시는 1v1·2v2 둘 다 가능하다 (U64)', () => {
  it('두 번째 선수까지 채울 수 있다 — 1명에서 막히지 않는다', () => {
    expect(toggleRosterMember('sticky', '', '샘플 참가자 19')).toEqual({ text: '샘플 참가자 19', limitReached: false });
    expect(toggleRosterMember('sticky', '샘플 참가자 19', '샘플 참가자 33')).toEqual({
      text: '샘플 참가자 19, 샘플 참가자 33',
      limitReached: false,
    });
  });

  it('세 번째 선수는 정원 초과로 막는다', () => {
    expect(toggleRosterMember('sticky', '샘플 참가자 19, 샘플 참가자 33', '샘플 참가자 12')).toEqual({
      text: '샘플 참가자 19, 샘플 참가자 33',
      limitReached: true,
    });
  });

  it('1명만 남겨도 되도록 해제는 언제나 열려 있다', () => {
    expect(toggleRosterMember('sticky', '샘플 참가자 19, 샘플 참가자 33', '샘플 참가자 33')).toEqual({
      text: '샘플 참가자 19',
      limitReached: false,
    });
    expect(toggleRosterMember('sticky', '샘플 참가자 19', '샘플 참가자 19')).toEqual({ text: '', limitReached: false });
  });

  it('안내 문구가 1~2명 계약을 그대로 말한다', () => {
    expect(rosterParticipation('sticky')).toBe('팀당 1~2명 출전');
    expect(rosterParticipation('sticky')).not.toContain('1명 출전');
  });
});

describe('배포 프리셋은 식별 가능한 가상 명단만 제공한다', () => {
  it('모든 이름에 샘플 표기와 팀·순번만 있다', () => {
    for (const name of Object.values(ROSTER_MEMBER_PRESETS).flat()) {
      expect(name).toMatch(/^샘플 [1-4]-[1-7]$/);
    }
  });

  it('다른 팀의 샘플을 잘못 표시하지 않는다', () => {
    for (const id of ['t1', 't2', 't3', 't4'] as const) {
      expect(ROSTER_MEMBER_PRESETS[id].every((name) => name.startsWith(`샘플 ${id.slice(1)}-`))).toBe(true);
    }
  });

  it('프리셋 이름은 팀 사이에 중복되지 않는다', () => {
    const all = Object.values(ROSTER_MEMBER_PRESETS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('추가 팀 슬롯에 실제 명단을 채워 두지 않는다', () => {
    expect(ROSTER_MEMBER_PRESETS.t5).toEqual([]);
    expect(ROSTER_MEMBER_PRESETS.t6).toEqual([]);
  });
});

describe('몸으로 말해요는 명단 입력 섹션이 없다 (U55)', () => {
  it('입력 섹션 노출 여부는 몸으로 말해요만 false다', () => {
    expect(rosterInputVisible('curling')).toBe(true);
    expect(rosterInputVisible('newspaper')).toBe(true);
    expect(rosterInputVisible('sticky')).toBe(true);
    expect(rosterInputVisible('sync')).toBe(false);
  });

  it('render는 입력 섹션이 안 보일 때 안내 문구로 대신한다', () => {
    expect(source).toContain('rosterInputVisible(evId)');
    expect(source).toContain('전원 참가 · 명단 없음');
    // rostergrid·송출 버튼 둘 다 같은 가드를 쓴다 — 입력칸만 숨고 버튼만 남는 반쪽 상태가 없다.
    expect(source.match(/rosterInputVisible\(evId\)/g)?.length).toBe(3);
  });
});

describe('명단 프리셋 슬롯 라벨·색 (U30)', () => {
  it('프리셋 라벨은 슬롯 번호만 말한다 — 색 이름은 팀 이름이 이미 들고 있다', () => {
    expect(ROSTER_PRESET_LABEL.t1).toBe('1팀');
    expect(ROSTER_PRESET_LABEL.t4).toBe('4팀');
    for (const label of Object.values(ROSTER_PRESET_LABEL)) {
      expect(label).not.toMatch(/YELLOW|BLUE|RED|GREEN/);
    }
  });

  it('프리셋 칩 색은 하드코딩 hex가 아니라 팀 색 하나에서 흐른다', () => {
    expect(rosterCardStyle({ color: '#123456' })).toBe('--team:#123456;--preset:#123456');
    expect(rosterCardStyle({ color: '#abcdef' })).toBe('--team:#abcdef;--preset:#abcdef');
  });
});

/**
 * U61 — 신문지 달리기 명단은 이번 조 / 전체 두 보드다.
 * 조 구성은 런처 대결 타일(`liveOverlay.versus`)이 이미 고르므로 이 탭에서 다시 고르지 않는다.
 */
describe('명단 송출 범위 (U61)', () => {
  it('신문지 달리기만 이번 조·전체 두 버튼을 낸다', () => {
    const newspaper = rosterBroadcastButtons('newspaper');
    expect(newspaper.map((b) => b.scope)).toEqual(['heat', 'all']);
    expect(newspaper[0].label).toBe('이번 조 명단 송출');
    expect(newspaper[1].label).toBe('전체 명단 송출');
  });

  it('조가 없는 종목은 버튼 하나에 예전 라벨 그대로다', () => {
    for (const eventId of ['curling', 'sticky', 'sync'] as const) {
      const buttons = rosterBroadcastButtons(eventId);
      expect(buttons.map((b) => b.scope)).toEqual(['all']);
      expect(buttons[0].label).toBe('명단 카드 송출');
    }
  });

  it('버튼마다 hover 상세가 붙는다 (무엇이 나가는지 그 자리에서 읽힌다)', () => {
    for (const eventId of ['newspaper', 'curling'] as const) {
      for (const button of rosterBroadcastButtons(eventId)) {
        expect(button.tip.length).toBeGreaterThan(10);
      }
    }
    expect(rosterBroadcastButtons('newspaper')[0].tip).toContain('대결 타일');
  });

  it('송출 액션이 범위를 함께 실어 보내고, 조 미선택이면 경고한다', () => {
    expect(source).toContain('opts: { roster: { eventId: evId, scope: button.scope } }');
    expect(source).toContain("!s.sceneOpts.liveOverlay.versus");
    expect(source).toContain('대결 타일에서 이번 조를 먼저 고르세요');
  });
});
