import { describe, expect, it } from 'vitest';

import { createCurlingBracket, curlingRanks, ranksFromHigherValues, setCurlingPair, setCurlingWinner } from './p1-results';

describe('컬링 4팀 토너먼트', () => {
  it('준결승 승패로 결승과 3·4위전 대진을 자동 구성한다', () => {
    let bracket = createCurlingBracket();
    bracket = setCurlingPair(bracket, 'semi1', ['t1', 't2']);
    bracket = setCurlingPair(bracket, 'semi2', ['t3', 't4']);
    bracket = setCurlingWinner(bracket, 'semi1', 't1');
    bracket = setCurlingWinner(bracket, 'semi2', 't4');

    expect(bracket.final.teams).toEqual(['t1', 't4']);
    expect(bracket.bronze.teams).toEqual(['t2', 't3']);
  });

  it('결승과 3·4위전 승자로 1~4위를 자동 산출한다', () => {
    let bracket = createCurlingBracket();
    bracket = setCurlingPair(bracket, 'semi1', ['t1', 't2']);
    bracket = setCurlingPair(bracket, 'semi2', ['t3', 't4']);
    bracket = setCurlingWinner(bracket, 'semi1', 't1');
    bracket = setCurlingWinner(bracket, 'semi2', 't4');
    bracket = setCurlingWinner(bracket, 'final', 't4');
    bracket = setCurlingWinner(bracket, 'bronze', 't2');

    expect(curlingRanks(bracket)).toMatchObject({ t4: 1, t1: 2, t2: 3, t3: 4 });
  });

  it('대진을 바꾸면 더는 유효하지 않은 승자와 후속 대진을 초기화한다', () => {
    let bracket = createCurlingBracket();
    bracket = setCurlingPair(bracket, 'semi1', ['t1', 't2']);
    bracket = setCurlingPair(bracket, 'semi2', ['t3', 't4']);
    bracket = setCurlingWinner(bracket, 'semi1', 't1');
    bracket = setCurlingWinner(bracket, 'semi2', 't3');
    bracket = setCurlingPair(bracket, 'semi1', ['t2', 't4']);

    expect(bracket.semi1.winner).toBeNull();
    expect(bracket.final.teams).toEqual([null, 't3']);
    expect(bracket.bronze.teams).toEqual([null, 't4']);
    expect(curlingRanks(bracket).t1).toBeNull();
  });
});

describe('점수·성공 라운드 자동 순위', () => {
  it('큰 값 우선이며 동점은 공동 순위와 다음 건너뛴 순위를 만든다', () => {
    expect(
      ranksFromHigherValues({ t1: 12, t2: 20, t3: 20, t4: 3, t5: null, t6: null }, ['t1', 't2', 't3', 't4']),
    ).toMatchObject({ t1: 3, t2: 1, t3: 1, t4: 4 });
  });

  it('미입력 팀은 순위에 넣지 않는다', () => {
    expect(
      ranksFromHigherValues({ t1: null, t2: 5, t3: null, t4: 1, t5: null, t6: null }, ['t1', 't2', 't3', 't4']),
    ).toMatchObject({ t1: null, t2: 1, t3: null, t4: 2 });
  });
});
