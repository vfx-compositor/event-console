/**
 * Broadcast Luxe 공용 격자 — 리더보드(S4)·출전명단·시상이 같은 수치를 쓴다.
 * 값 근거: docs/decisions/2026-09-03-console-open-decisions.md Q1.
 *
 * 1920×1080 스테이지에서
 *   보드 1536×876 · 테두리 1px 두 겹 · 패딩 72/72/76 → 콘텐츠 1390×726
 *   세로 = 매스트헤드 120 + 헤더바 76 + 간격 20 + 행 영역 510
 *   가로 = 순위 pill 168 + 팀 448 + 가변 1fr(1부 550) + 우측 값 224
 *   순위 pill은 흰 캡슐을 22px 덮어 190px, 캡슐은 left 168px에서 시작
 *
 * CSS는 이 값을 직접 읽을 수 없으므로 display.css에 같은 수를 적고
 * 테스트(`luxe-grid.test.ts`)가 두 곳이 어긋나지 않는지 검사한다.
 */

import { h, type VNode } from '../vdom';
/**
 * Event Console 공용 모노그램.
 *
 * 공개 배포판은 특정 행사의 로고를 포함하지 않는다. 리더보드·시상·출전명단과 조작 화면이
 * 같은 중립 벡터 표식을 공유해, 사용자가 자신의 행사 로고를 넣기 전에도 일관되게 보인다.
 */
/** 공개본에는 행사 로고 파일을 포함하지 않으므로, 항상 표시 가능한 벡터 표식을 사용한다. */
export const EVENT_MARK_SRC =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 88"%3E%3Crect width="128" height="88" rx="12" fill="%23121722"/%3E%3Cpath d="M24 18h80v12H24zm0 20h52v12H24zm0 20h80v12H24z" fill="%23fff"/%3E%3C/svg%3E';

/** 마스트헤드(120px) 안에서의 마크 높이. 폭은 비율대로 따라간다. */
export const EVENT_MARK_H = 88;

/** 보드 마스트헤드에 얹는 모노그램 이미지 노드 — 세 씬이 같은 것을 쓴다. */
export function eventMark(): VNode {
  return h('img', {
    class: 'luxe-mast__mark',
    src: EVENT_MARK_SRC,
    alt: '',
    'aria-hidden': 'true',
  });
}

export const LUXE = {
  boardW: 1536,
  boardH: 876,
  padTop: 72,
  padX: 72,
  padBottom: 76,
  /** = boardW − 좌우 테두리 1px 두 겹 − 좌우 패딩 */
  contentW: 1390,
  mastH: 120,
  headH: 76,
  headGap: 20,
  colRank: 168,
  colTeam: 448,
  colValue: 224,
  /** 순위 pill이 흰 캡슐 위로 넘어오는 폭 */
  pillOverlap: 22,
  /** = colRank + pillOverlap */
  pillW: 190,
  /** 캡슐 안에서 아바타가 시작하는 x (열 시작 기준) */
  idPadLeft: 56,
} as const;

/** 행 블록이 쓸 수 있는 세로 공간. 726 − 120 − 76 − 20 = 510 */
export const ROWS_AREA = 510;
/** 행 사이 여백. 행 높이 = step − ROW_GAP (4팀 109 / 5팀 84 / 6팀 67) */
export const ROW_GAP = 18;
/** 4팀에서의 상한 = 510 / 4. 시안 A의 step 25% · 행 21.5% 비율(0.86)을 만든다. */
const ROW_STEP_MAX = 127;
/** 행 하나가 화면에 나타나는 데 걸리는 시간 */
export const ROW_REVEAL_MS = 267;

/** 팀(행) 수에 따른 행 간격. 4팀 127 / 5팀 102 / 6팀 85 */
export function rowStep(count: number): number {
  return Math.floor(Math.min(ROW_STEP_MAX, ROWS_AREA / Math.max(1, count)));
}

/**
 * 행 블록(= count·step − ROW_GAP)을 행 영역 안에서 세로 중앙에 맞추는 오프셋.
 * step을 내림하면 팀 수마다 아래쪽에 잔여가 생겨 보드가 위로 쏠려 보인다.
 */
export function rowsTop(count: number): number {
  const block = Math.max(1, count) * rowStep(count) - ROW_GAP;
  return Math.max(0, Math.round((ROWS_AREA - block) / 2));
}

/**
 * 캡슐 안 보조 정보(종목 점수·선수 이름)의 열 수. 항상 2줄로 유지해 행 높이를 넘기지 않는다.
 * 4개 → 2열, 7개 → 4열.
 */
export function eventColumns(itemCount: number): number {
  return Math.max(2, Math.ceil(itemCount / 2));
}

/** 4팀은 레퍼런스의 5F(167ms), 5~6팀은 마지막 행까지 1초 안에 끝나도록 간격을 줄인다. */
export function rowIntroDelayMs(index: number, count: number): number {
  if (index <= 0 || count <= 1) return 0;
  const maxStagger = (1000 - ROW_REVEAL_MS) / (count - 1);
  return Math.round(index * Math.min(1000 / 6, maxStagger));
}

/**
 * 행 하나가 쓰는 CSS 변수 묶음 — 세 씬이 같은 문자열을 만든다.
 *
 * `--row-index`가 세로 배치를 만든다. 행은 absolute라 이 값이 없으면 전부 같은 자리에 겹친다.
 * 리더보드는 tick()이 순위대로 inline transform을 덮어써 재정렬 트윈을 돌리고,
 * tick이 없는 출전명단·시상 표는 이 값만으로 배치가 끝난다.
 */
export function rowStyle(color: string, index: number, count: number): string {
  const delay = rowIntroDelayMs(index, count);
  return (
    `--team:${color}; --row-index:${index};` +
    ` --row-delay:${delay}ms; --rank-delay:${Math.min(delay, 467)}ms`
  );
}

/**
 * 지금 보드가 보여 주는 **순위 배치**의 서명 (D9).
 *
 * 재정렬 트윈은 DOM 순서를 바꾸지 않고 `translateY`만 움직인다. DOM 순서로 서명을 만들면
 * 값이 영영 그대로라 "재정렬 중" 판정이 한 번도 켜지지 않는다(실측 0건). 팀과 그 팀이 지금
 * 몇 번째 칸에 있는지를 함께 적어야 순위만 바뀐 경우가 잡힌다.
 */
export function reorderSignature(rows: readonly { team: string; rank: string }[]): string {
  return rows.map((row) => `${row.team}:${row.rank}`).join(',');
}

/** 행 컨테이너가 쓰는 CSS 변수 묶음. */
export function rowsStyle(count: number, itemColumns: number): string {
  return `--step:${rowStep(count)}px; --rows-top:${rowsTop(count)}px; --event-cols:${itemColumns}`;
}
