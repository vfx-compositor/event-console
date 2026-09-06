import { describe, expect, it } from 'vitest';
import { rankChoices } from './p1-ranking';

describe('클릭형 1부 순위 입력', () => {
  it('미정과 팀 수만큼의 순위를 노출하고 현재 선택을 표시한다', () => {
    expect(rankChoices(5, 3)).toEqual([
      { rank: null, label: '미정', pressed: false },
      { rank: 1, label: '1위', pressed: false },
      { rank: 2, label: '2위', pressed: false },
      { rank: 3, label: '3위', pressed: true },
      { rank: 4, label: '4위', pressed: false },
      { rank: 5, label: '5위', pressed: false },
    ]);
  });
});
