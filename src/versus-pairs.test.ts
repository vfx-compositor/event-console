import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import {
  nextVersusFocus,
  swapTeamPair,
  teamPairChoices,
  versusIconSides,
  versusPairOptions,
  versusStatusLabel,
  versusStatusTip,
  versusTileHalf,
} from './versus-pairs';
import { DEFAULT_TEAM_NAMES, activeTeamIds, createInitialState, getTeam } from './state';
import type { Team, TeamId } from './types';

const teams = ['t1', 't2', 't3', 't4'] as const;

const state = createInitialState();
const teamOf = (id: TeamId) => getTeam(state, id);

describe('4팀 대결 보더 조합', () => {
  it('중복 없이 정확히 6개 무순서 조합을 만든다', () => {
    expect(teamPairChoices([...teams])).toEqual([
      ['t1', 't2'],
      ['t1', 't3'],
      ['t1', 't4'],
      ['t2', 't3'],
      ['t2', 't4'],
      ['t3', 't4'],
    ]);
  });

  it('좌우 바꾸기는 선택된 두 팀만 뒤집는다', () => {
    expect(swapTeamPair(['t1', 't4'])).toEqual(['t4', 't1']);
    expect(swapTeamPair(null)).toBeNull();
  });
});

describe('씬 런처 대결팀 타일 모델', () => {
  /**
   * U57 — 타일 순서는 매치 영상 **파일 이름 순**으로 고정한다. 슬롯 번호 조합 순서가 아니다.
   * (`match-video.test.ts`가 이 배열이 실제 파일 목록과 어긋나지 않는지 따로 지킨다.)
   */
  const FILE_ORDER_FIDS = [
    'versus-t2-t3', // blue_red
    'versus-t1-t2', // blue_yellow
    'versus-t2-t4', // green_blue
    'versus-t3-t4', // green_red
    'versus-t1-t4', // green_yellow
    'versus-t1-t3', // red_yellow
  ];

  it('참가 팀 수만큼 조합을 만들고 팀 설정의 실제 이름·색을 그대로 쓴다', () => {
    const options = versusPairOptions(activeTeamIds(state), null, teamOf);

    expect(options).toHaveLength(6);
    expect(options[0].left).toEqual({
      id: 't2',
      name: DEFAULT_TEAM_NAMES[1],
      color: state.teams[1].color,
    });
    expect(options[0].right).toEqual({
      id: 't3',
      name: DEFAULT_TEAM_NAMES[2],
      color: state.teams[2].color,
    });
    expect(options.every((o) => !o.selected)).toBe(true);
  });

  it('타일 순서는 매치 영상 파일 이름 순으로 고정된다 (U57)', () => {
    const options = versusPairOptions(activeTeamIds(state), null, teamOf);

    expect(options.map((o) => o.fid)).toEqual(FILE_ORDER_FIDS);
  });

  /**
   * U57 보정 — 실측에서 순서는 맞았는데 타일 **안**이 슬롯 오름차순으로 그려졌다
   * (`YELLOW VS BLUE`, 파일은 `match_blue_yellow`). 원인은 좌·우를 `findMatchVideo`로 갈랐던 것 —
   * 그 함수는 **에셋 등록**을 보므로 매니페스트가 들어오기 전에는 null이었다.
   * 좌·우는 파일 이름만으로 알 수 있으니 등록과 무관해야 한다.
   */
  it('타일 안의 좌·우도 파일 이름 순이다 — 에셋이 아직 안 들어와도 같다', () => {
    const options = versusPairOptions(activeTeamIds(state), null, teamOf);

    expect(options.map((o) => `${o.left.name} VS ${o.right.name}`)).toEqual([
      'BLUE VS RED',
      'BLUE VS YELLOW',
      'GREEN VS BLUE',
      'GREEN VS RED',
      'GREEN VS YELLOW',
      'RED VS YELLOW',
    ]);
  });

  it('색 면 변수도 같은 좌·우를 쓴다 — 색과 이름이 어긋날 수 없다', () => {
    const options = versusPairOptions(activeTeamIds(state), null, teamOf);
    const byId = new Map(state.teams.map((t) => [t.id, t.color]));

    for (const option of options) {
      expect(option.left.color).toBe(byId.get(option.left.id));
      expect(option.right.color).toBe(byId.get(option.right.id));
    }
  });

  it('타일 DOM은 왼쪽 면·이름을 오른쪽보다 먼저 낸다', () => {
    const launcher = readFileSync(new URL('./control/launcher.ts', import.meta.url), 'utf8');

    expect(launcher.indexOf('vspair__face--l')).toBeLessThan(launcher.indexOf('vspair__face--r'));
    expect(launcher.indexOf('vspair__name--l')).toBeLessThan(launcher.indexOf('vspair__name--r'));
    expect(launcher).toContain('--vs-l:${option.left.color};--vs-r:${option.right.color}');
    expect(launcher).toContain("text: option.left.name");
    expect(launcher).toContain("text: option.right.name");
  });

  it('조합을 골라도 순서가 흔들리지 않는다 — 타일이 자리를 옮기면 눈으로 못 찾는다', () => {
    const before = versusPairOptions(activeTeamIds(state), null, teamOf).map((o) => o.fid);
    const after = versusPairOptions(activeTeamIds(state), ['t2', 't1'], teamOf).map((o) => o.fid);

    expect(after).toEqual(before);
  });

  it('팀 이름·색을 바꾸면 타일도 따라간다 (하드코딩 없음)', () => {
    const renamed: Team[] = state.teams.map((t) =>
      t.id === 't1' ? { ...t, name: '불꽃', color: '#123456' } : t,
    );
    const options = versusPairOptions(activeTeamIds(state), null, (id) =>
      renamed.find((t) => t.id === id),
    );
    // t1(YELLOW)은 여섯 파일 모두에서 뒤 이름이라 타일 오른쪽에 선다
    const picked = options.find((o) => o.fid === 'versus-t1-t2')!;

    expect(picked.right).toEqual({ id: 't1', name: '불꽃', color: '#123456' });
    expect(picked.tip).toContain('불꽃');
  });

  /**
   * U57 — 예전에는 선택된 조합만 현재 출력 방향으로 뒤집어 그렸다. [↔ 좌우 바꾸기]마다 색 면과
   * 팀명이 통째로 뒤집혀 운영자 눈에는 타일이 튀었다. 지금은 좌·우도 불변이고, 출력 방향은
   * 상태 칩이 글자로 알린다. `apply`(실제로 내보내는 순서)만 예전 규칙을 그대로 지킨다.
   */
  it('좌우를 바꿔도 타일의 좌·우는 그대로다 — 보내는 순서(apply)만 따라간다', () => {
    const options = versusPairOptions(activeTeamIds(state), ['t2', 't1'], teamOf);
    const picked = options.find((o) => o.selected)!;
    const unselected = versusPairOptions(activeTeamIds(state), null, teamOf).find(
      (o) => o.fid === picked.fid,
    )!;

    expect(picked.pair).toEqual(['t1', 't2']);
    // 고르기 전과 고른 뒤가 같은 그림이다
    expect(picked.left.id).toBe(unselected.left.id);
    expect(picked.right.id).toBe(unselected.right.id);
    // 이미 고른 조합을 다시 눌러도 방향이 되돌아가지 않는다
    expect(picked.apply).toEqual(['t2', 't1']);
    expect(options.filter((o) => o.selected)).toHaveLength(1);
  });

  it('선택되지 않은 조합은 정규 순서를 그대로 보낸다', () => {
    const options = versusPairOptions(activeTeamIds(state), ['t2', 't1'], teamOf);
    const other = options.find((o) => o.fid === 'versus-t3-t4')!;

    expect(other.selected).toBe(false);
    expect(other.apply).toEqual(['t3', 't4']);
  });

  it('현재 조합을 색이 아니라 글자로도 알린다', () => {
    expect(versusStatusLabel(['t2', 't1'], teamOf)).toBe(
      `${DEFAULT_TEAM_NAMES[1]} ↔ ${DEFAULT_TEAM_NAMES[0]}`,
    );
    expect(versusStatusLabel(null, teamOf)).toBe('보더 꺼짐');
  });

  it('상태 칩 상세는 요약 라벨을 되파싱하지 않고 좌·우 팀을 직접 읽는다', () => {
    // 팀 이름에 구분자가 들어 있어도 좌·우가 뒤바뀌면 안 된다
    const tricky = (id: TeamId) =>
      id === 't1'
        ? { id, name: '레드 ↔ 화이트', color: '#c0453b' }
        : { id, name: '블루', color: '#3f7fbe' };

    expect(versusStatusTip(['t1', 't2'], tricky)).toBe(
      '중계 화면 왼쪽이 레드 ↔ 화이트, 오른쪽이 블루입니다. 좌우 컬러 보더와 상단 팀 아이콘이 같은 방향으로 나갑니다.',
    );
    expect(versusStatusTip(null, teamOf)).toContain('지금은 공통 톤입니다');
  });
});

/**
 * U63 — 타일 좌/우 절반 클릭 분리. 예전 [클릭 시 영상 재생] 토글을 대체한다.
 * 숨은 상태를 읽지 않고 **누르는 자리 자체가 의도**가 되게 만드는 것이 목적이다.
 */
describe('대결팀 타일 좌·우 절반 판정', () => {
  // 타일이 화면 x=100에서 200px 폭으로 서 있다 → 경계는 200
  const rect = { left: 100, width: 200 };

  it('마우스 좌측 절반은 보더만, 우측 절반은 재생까지', () => {
    expect(versusTileHalf(120, rect, false, 1)).toBe('select');
    expect(versusTileHalf(280, rect, false, 1)).toBe('play');
  });

  it('정확히 가운데는 좌측(보더만)으로 떨어진다 — 애매하면 안전한 쪽', () => {
    expect(versusTileHalf(200, rect, false, 1)).toBe('select');
    expect(versusTileHalf(201, rect, false, 1)).toBe('play');
  });

  it('Shift+클릭은 어느 절반이든 보더만 바꾼다', () => {
    expect(versusTileHalf(280, rect, true, 1)).toBe('select');
    expect(versusTileHalf(120, rect, true, 1)).toBe('select');
  });

  /**
   * 키보드 활성화는 `clientX === 0`이라 그대로 두면 항상 좌측으로 떨어져 Enter로는 영상을
   * 영영 못 튼다. `detail === 0`으로 갈라내고 키보드에서는 Shift가 재생 통로가 된다.
   */
  it('키보드(detail=0)는 Enter·Space가 보더만, Shift+Enter가 재생까지', () => {
    expect(versusTileHalf(0, rect, false, 0)).toBe('select');
    expect(versusTileHalf(0, rect, true, 0)).toBe('play');
  });

  it('키보드 경로는 좌표를 아예 보지 않는다', () => {
    expect(versusTileHalf(9999, rect, false, 0)).toBe('select');
    expect(versusTileHalf(-9999, rect, true, 0)).toBe('play');
  });
});

describe('대결팀 타일 키보드 이동', () => {
  it('좌우는 끝에서 반대편으로 감싼다', () => {
    expect(nextVersusFocus('ArrowRight', 5, 6)).toBe(0);
    expect(nextVersusFocus('ArrowLeft', 0, 6)).toBe(5);
  });

  it('상하는 열 수만큼 옮기고 끝에서 멈춘다', () => {
    expect(nextVersusFocus('ArrowDown', 0, 6)).toBe(2);
    expect(nextVersusFocus('ArrowUp', 3, 6)).toBe(1);
    expect(nextVersusFocus('ArrowDown', 5, 6)).toBe(5);
    expect(nextVersusFocus('ArrowUp', 1, 6)).toBe(0);
  });

  it('Home/End는 처음과 끝으로 간다', () => {
    expect(nextVersusFocus('Home', 4, 6)).toBe(0);
    expect(nextVersusFocus('End', 1, 6)).toBe(5);
  });

  it('다루지 않는 키는 null이라 전역 단축키를 막지 않는다', () => {
    expect(nextVersusFocus('Enter', 0, 6)).toBeNull();
    expect(nextVersusFocus('F2', 0, 6)).toBeNull();
    expect(nextVersusFocus('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('중계 화면 대결 팀 아이콘 모델', () => {
  const noLogo = () => undefined;

  it('versus가 없으면 아이콘을 만들지 않는다', () => {
    expect(versusIconSides(null, teamOf, noLogo)).toBeNull();
  });

  it('좌·우 순서는 컬러 보더와 같은 배열에서 나온다', () => {
    const sides = versusIconSides(['t3', 't1'], teamOf, noLogo)!;

    expect(sides[0]).toMatchObject({ side: 'left', teamId: 't3', name: DEFAULT_TEAM_NAMES[2] });
    expect(sides[1]).toMatchObject({ side: 'right', teamId: 't1', name: DEFAULT_TEAM_NAMES[0] });
    expect(sides[0].color).toBe(state.teams[2].color);
  });

  it('로고가 있으면 로고를, 없으면 팀명 첫 글자 배지를 쓴다', () => {
    const withLogo = versusIconSides(['t1', 't2'], teamOf, (team) =>
      team.id === 't1' ? 'blob:logo-1' : undefined,
    )!;

    expect(withLogo[0].logo).toBe('blob:logo-1');
    expect(withLogo[1].logo).toBeUndefined();
    expect(withLogo[1].initial).toBe('B');
  });

  it('한글 팀명도 첫 글자를 그대로 배지에 쓴다', () => {
    const sides = versusIconSides(
      ['t1', 't2'],
      (id) => (id === 't1' ? { id, name: '불꽃', color: '#123456' } : teamOf(id)),
      () => undefined,
    )!;

    expect(sides[0].initial).toBe('불');
  });
});
