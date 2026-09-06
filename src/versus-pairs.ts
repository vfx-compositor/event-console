import {
  findMatchVideo,
  matchPairFileOrder,
  matchPairOrderIndex,
  type MatchAssetLike,
} from './match-video';
import type { Team, TeamId } from './types';

export function teamPairChoices(ids: TeamId[]): [TeamId, TeamId][] {
  const pairs: [TeamId, TeamId][] = [];
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      pairs.push([ids[left], ids[right]]);
    }
  }
  return pairs;
}

export function swapTeamPair(pair: [TeamId, TeamId] | null): [TeamId, TeamId] | null {
  return pair ? [pair[1], pair[0]] : null;
}

/** 조합 타일 한 면 — 팀 이름과 실제 팀 색(설정에서 바꾸면 따라온다) */
export interface VersusSideView {
  id: TeamId;
  name: string;
  color: string;
}

export interface VersusPairOption {
  /** 조합의 정규 순서(팀 번호 오름차순). 아직 고르지 않은 조합을 누를 때 쓰는 값 */
  pair: [TeamId, TeamId];
  left: VersusSideView;
  right: VersusSideView;
  selected: boolean;
  /**
   * 눌렀을 때 실제로 보낼 좌·우 순서.
   *
   * 매치 영상이 있으면 **영상 파일이 정한 순서**다(U36) — 영상 안 팀 배치와 보더 방향이
   * 어긋나면 안 되기 때문이다. 영상이 없을 때만 예전 규칙(선택된 조합은 현재 방향 유지)이다.
   */
  apply: [TeamId, TeamId];
  /** 이 조합의 매치 영상 에셋 id. `null`이면 보더만 설정한다. */
  matchAssetId: string | null;
  fid: string;
  tip: string;
}

type TeamLookup = (id: TeamId) => Team | undefined;

function sideView(team: Team): VersusSideView {
  return { id: team.id, name: team.name, color: team.color };
}

/**
 * 씬 런처의 "대결팀 보더" 타일 모델 (시안 A · Split Color Tiles).
 *
 * ## 타일은 움직이지 않는다 (U57)
 * 목록 순서는 **매치 영상 파일 이름 순**으로 고정하고(`matchPairOrderIndex`), 좌·우도
 * **파일이 정한 배치 그대로** 그린다 — 고르기 전이든 고른 뒤든 같은 그림이다.
 *
 * 예전에는 선택된 조합만 현재 출력 방향으로 뒤집어 그려, 버튼이 출력 보더의 방향을 미리
 * 보여 주는 설계였다. 그런데 [↔ 좌우 바꾸기]를 누를 때마다 색 면과 팀명이 통째로 뒤집혀
 * 운영자 눈에는 타일이 자리를 옮긴 것처럼 보였다("타일이 튄다"). 6개 타일 중 하나를 눈으로
 * 찾는 일이 조작보다 오래 걸리면 안 되므로, 지금은 **위치·좌우 모두 불변**이 규칙이다.
 * 출력 방향은 상단 상태 칩(`versusStatusLabel`)이 글자로 알린다.
 *
 * `apply`(실제로 내보내는 순서)는 이 표시 규칙과 별개다 — 영상이 있으면 파일 순서,
 * 없으면 예전 규칙(선택된 조합은 현재 방향 유지)을 그대로 지킨다.
 */
export function versusPairOptions(
  ids: TeamId[],
  current: [TeamId, TeamId] | null,
  teamOf: TeamLookup,
  assets: ReadonlyArray<MatchAssetLike> = [],
): VersusPairOption[] {
  const options: VersusPairOption[] = [];
  // 파일 순서로 고정. 파일이 없는 조합은 Infinity라 뒤로 밀리고, 그 안에서는 조합 순서를
  // 그대로 유지한다(Array#sort는 안정 정렬이다).
  const pairs = [...teamPairChoices(ids)].sort(
    (a, b) => matchPairOrderIndex(a[0], a[1]) - matchPairOrderIndex(b[0], b[1]),
  );
  for (const pair of pairs) {
    const selected = !!current && current.includes(pair[0]) && current.includes(pair[1]);
    const match = findMatchVideo(assets, pair[0], pair[1]);
    /**
     * 타일에 그리는 순서 — 선택 여부와도, **에셋 등록 여부와도** 무관하다.
     *
     * `match`(= `findMatchVideo`)로 가르면 매니페스트가 들어오기 전에는 슬롯 오름차순으로,
     * 들어온 뒤에는 파일 순서로 그려져 조작 화면이 로딩 도중 한 번 뒤집힌다. 파일 이름은
     * 등록과 무관하게 알 수 있으므로 `matchPairFileOrder`로 판정한다.
     */
    const view = matchPairFileOrder(pair[0], pair[1]) ?? pair;
    const left = teamOf(view[0]);
    const right = teamOf(view[1]);
    if (!left || !right) continue;
    const applyOrder = selected ? (current as [TeamId, TeamId]) : pair;
    const apply = match ? match.order : ([applyOrder[0], applyOrder[1]] as [TeamId, TeamId]);
    options.push({
      pair,
      left: sideView(left),
      right: sideView(right),
      selected,
      apply,
      matchAssetId: match ? match.assetId : null,
      fid: `versus-${pair[0]}-${pair[1]}`,
      tip: match
        ? `타일 왼쪽 절반 클릭 = 대결 보더만 설정. 오른쪽 절반 클릭 = 보더 설정 + 매치 영상 즉시 재생(▶ 표시가 그 절반입니다). 어느 쪽이든 Shift+클릭이면 보더만 바꿉니다. 키보드는 Enter·Space가 보더만, Shift+Enter가 재생까지입니다. 보더는 영상이 정한 배치대로 왼쪽 ${left.name} · 오른쪽 ${right.name}로 나갑니다.`
        : `클릭: 대결 보더만 설정 (이 조합의 매치 영상이 없어 오른쪽 절반을 눌러도 같습니다). 중계 화면 왼쪽 ${left.name} · 오른쪽 ${right.name} 컬러 보더와 팀 아이콘으로 출력합니다.`,
    });
  }
  return options;
}

/** `versusTileHalf`가 보는 최소 사각형 — 테스트에서 DOMRect 없이 부를 수 있게 좁혀 둔다 */
export interface VersusTileRect {
  left: number;
  width: number;
}

/**
 * 타일 활성화 한 번이 무엇을 하는가 (U63) — 좌측 절반은 선택만, 우측 절반은 선택 + 즉시 재생.
 *
 * 예전에는 카드 안 [클릭 시 영상 재생] 토글이 이 갈림을 정했다. 토글은 "지금 켜져 있나"를
 * 매번 다시 읽어야 하는 숨은 상태라, 리허설에서 보더만 고치려다 7.5초짜리 영상이 송출로
 * 나가는 사고가 났다. 절반으로 가르면 **누르는 자리 자체가 의도**라 읽을 상태가 없다.
 *
 * 키보드 활성화는 좌표가 없다(`clientX === 0`) — `detail === 0`으로 갈라내지 않으면 Enter가
 * 항상 좌측으로 떨어져 키보드로는 영상을 영영 못 튼다. 키보드에서는 Shift가 그 역할을 한다.
 */
export function versusTileHalf(
  clientX: number,
  rect: VersusTileRect,
  shiftKey: boolean,
  detail: number,
): 'select' | 'play' {
  // Shift는 어느 경로에서도 "이번 한 번만 보더만"의 뜻이다 — 단, 키보드에서는 반대로
  // "재생까지"의 유일한 통로다. 두 규칙이 부딪히지 않게 키보드를 먼저 가른다.
  if (detail === 0) return shiftKey ? 'play' : 'select';
  if (shiftKey) return 'select';
  return clientX > rect.left + rect.width / 2 ? 'play' : 'select';
}

/**
 * 조합 타일 클릭이 내보내는 액션 — 보더 설정(항상) + 매치 영상 재생.
 *
 * `playVideo`가 false면 **보더만** 고친다. 보더 방향만 손보고 싶은데 매번 7.5초짜리 영상이
 * 송출로 나가면 리허설에서 쓸 수 없다 — 타일 좌측 절반·Shift+클릭·키보드 Enter가 이 인자를
 * 내린다(`versusTileHalf`). 우측 절반과 Shift+Enter만 올린다.
 */
export function versusTileActions(
  option: Pick<VersusPairOption, 'apply' | 'matchAssetId'>,
  now: number,
  playVideo = true,
): (
  | { type: 'sceneOpts/patch'; patch: { liveOverlay: { versus: [TeamId, TeamId] } } }
  | { type: 'overlay/play'; assetId: string; holdEndFrame: boolean; now: number }
)[] {
  const out: ReturnType<typeof versusTileActions> = [
    { type: 'sceneOpts/patch', patch: { liveOverlay: { versus: option.apply } } },
  ];
  if (playVideo && option.matchAssetId) {
    out.push({ type: 'overlay/play', assetId: option.matchAssetId, holdEndFrame: true, now });
  }
  return out;
}

/** 현재 조합 요약 — 색에 기대지 않고 글자로도 상태를 알린다 */
export function versusStatusLabel(current: [TeamId, TeamId] | null, teamOf: TeamLookup): string {
  if (!current) return '보더 꺼짐';
  const left = teamOf(current[0]);
  const right = teamOf(current[1]);
  if (!left || !right) return '보더 꺼짐';
  return `${left.name} ↔ ${right.name}`;
}

/**
 * 상태 칩 hover/포커스 상세. 요약 라벨을 되파싱하지 않고 팀을 직접 읽는다 —
 * 팀 이름 안에 구분자(' ↔ ')가 들어 있어도 좌·우가 뒤바뀌지 않게.
 */
export function versusStatusTip(current: [TeamId, TeamId] | null, teamOf: TeamLookup): string {
  const left = current ? teamOf(current[0]) : undefined;
  const right = current ? teamOf(current[1]) : undefined;
  if (!left || !right) {
    return '조합을 고르면 중계 화면에 좌우 컬러 보더와 팀 아이콘이 들어갑니다. 지금은 공통 톤입니다.';
  }
  return `중계 화면 왼쪽이 ${left.name}, 오른쪽이 ${right.name}입니다. 좌우 컬러 보더와 상단 팀 아이콘이 같은 방향으로 나갑니다.`;
}

/**
 * 조합 타일 방향키 이동. 좌우는 wrap, 상하는 열 수만큼 이동(끝에서 멈춤),
 * Home/End는 처음·끝. 처리하지 않는 키는 null이라 전역 단축키가 그대로 흐른다.
 */
export function nextVersusFocus(
  key: string,
  index: number,
  count: number,
  cols = 2,
): number | null {
  if (count <= 0 || index < 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'ArrowDown':
      return Math.min(count - 1, index + cols);
    case 'ArrowUp':
      return Math.max(0, index - cols);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** 중계 화면 상단 대결 아이콘 한 쪽 */
export interface VersusIconSide {
  side: 'left' | 'right';
  teamId: TeamId;
  name: string;
  color: string;
  /** 준비된 로고 URL. 없으면 팀 색 배지로 대신한다 */
  logo?: string;
  /** 로고가 없을 때 배지에 넣는 글자 */
  initial: string;
}

function initialOf(name: string): string {
  return [...name.trim()][0] ?? '?';
}

/**
 * live 씬 상단 팀 아이콘 모델. `versus`가 없으면 null이라 아이콘 자체를 만들지 않는다.
 * 좌·우 순서는 컬러 보더와 같은 배열을 그대로 쓰므로 방향이 어긋날 수 없다.
 */
export function versusIconSides(
  current: [TeamId, TeamId] | null,
  teamOf: TeamLookup,
  logoOf: (team: Team) => string | undefined,
): [VersusIconSide, VersusIconSide] | null {
  if (!current) return null;
  const left = teamOf(current[0]);
  const right = teamOf(current[1]);
  if (!left || !right) return null;
  const make = (side: 'left' | 'right', team: Team): VersusIconSide => ({
    side,
    teamId: team.id,
    name: team.name,
    color: team.color,
    logo: logoOf(team),
    initial: initialOf(team.name),
  });
  return [make('left', left), make('right', right)];
}
