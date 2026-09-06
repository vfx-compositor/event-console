/**
 * 씬 공통 컴포넌트 (스토리보드 §V3-2 오버레이 G1~G8)
 *
 * 규칙: 시간에 따라 변하는 값(타이머·시계·카운트업 숫자)은 **vnode에 넣지 않는다.**
 * `data-bind` 슬롯만 만들어 두고 display의 tick()이 textContent로 채운다.
 * → HTML 문자열이 안 바뀌므로 CSS 애니메이션이 리셋되지 않는다.
 */

import {
  activeLedger,
  activeTeamIds,
  activeTeams,
  computeScores,
  getEvent,
  P1_EVENT_ORDER,
  pointsByRef,
  pointsByRefPrefix,
} from '../state';
import { logoClass, logoUrl } from '../logos';
import { fmtPoints } from '../scoring';
import { h, type VNode } from '../vdom';
import type { AppState, P1EventId, TeamId } from '../types';

/**
 * 열의 성격. `'1부'`·`'2부'`는 종목/단계 열이고 `'보너스'`는 종목이 아닌 가감점 합계 열이다.
 * 이 값 하나가 (a) 어떤 ref에서 점수를 뽑을지 (b) 시상에서 어떻게 접을지를 모두 가른다.
 */
export type ScoreColumnGroup = '1부' | '2부' | '보너스';

export interface ScoreColumn {
  key: string;
  /** 원장 ref — 이 열에서 팀별 획득 점수를 뽑는 키 */
  ref: string;
  label: string;
  group: ScoreColumnGroup;
}

/** BONUS 열의 열 키·라벨. 어떤 종목 id·단계 id와도 겹치지 않는다. */
export const BONUS_COL_KEY = 'bonus';
export const BONUS_COL_LABEL = 'BONUS';
/** hover·스크린리더가 읽는 설명. 화면에는 라벨만 보인다. */
export const BONUS_COL_TIP = '사회자 재량·수동 가감점 합';

/**
 * BONUS 열이 합치는 원장 ref (U138).
 *
 * `manual`(수동 가감점)과 `p1:bonus`는 `computeScores`에서 1부 소계로,
 * `p2:bonus`는 2부 소계로 들어간다. 세 ref 모두 **총점에는 들어가지만 종목 열에는 없어서**
 * "종목 열 합 ≠ TOTAL"이 되던 것이 이 열을 만든 이유다.
 *
 * **2부 잠금 중에는 `p2:bonus`를 합산하지 않는다.** 잠금 중에는 2부 탭이 잠겨 있어 애초에
 * 생길 수 없는 ref지만, 비정상 저장본(리허설 후 재잠금 등)에서도 2부 점수가 1부 화면에
 * 새지 않도록 ref 목록 자체를 잠금 상태로 좁힌다 (P3와 같은 원칙).
 */
export function bonusRefs(state: AppState): string[] {
  return state.p2.unlocked ? ['p1:bonus', 'manual', 'p2:bonus'] : ['p1:bonus', 'manual'];
}

/** 지금 유효 원장에 BONUS 열이 셀 항목이 하나라도 있는가. 없으면 열을 만들지 않는다. */
export function hasBonusEntries(state: AppState): boolean {
  const refs = new Set(bonusRefs(state));
  return activeLedger(state.ledger).some((e) => refs.has(e.ref));
}

/** BONUS 열의 팀별 값 = `bonusRefs()` 유효 합. ref 완전 일치로만 모은다. */
export function bonusPoints(state: AppState): Record<TeamId, number> {
  const per = bonusRefs(state).map((ref) => pointsByRef(state, ref));
  const out = { ...per[0] };
  for (const p of per.slice(1)) {
    for (const id of Object.keys(out) as TeamId[]) out[id] += p[id];
  }
  return out;
}

/**
 * 스코어보드 열 구성. **2부 잠금 중에는 2부 열을 아예 만들지 않는다.** (P3 / AC-2)
 * 화면에서 숨기는 게 아니라 데이터 자체를 생성하지 않는 것이 요점.
 *
 * 마지막에 BONUS 열이 **가감점이 실제로 있을 때만** 붙는다 (U138). 늘 붙이면 아무것도 없는
 * 행사에서도 열 하나가 가로 예산과 글자 급수를 먹는다.
 */
export function scoreColumns(state: AppState): ScoreColumn[] {
  const cols: ScoreColumn[] = P1_EVENT_ORDER.map((id) => ({
    key: id,
    ref: `p1:${id}`,
    label: getEvent(state, id).name,
    group: '1부' as const,
  }));
  if (state.p2.unlocked) {
    for (const st of state.p2.stages) {
      cols.push({ key: st.id, ref: `p2:${st.id}`, label: st.name, group: '2부' });
    }
  }
  if (hasBonusEntries(state)) {
    cols.push({
      key: BONUS_COL_KEY,
      ref: BONUS_COL_KEY,
      label: BONUS_COL_LABEL,
      group: '보너스',
    });
  }
  return cols;
}

export interface ScoreRow {
  teamId: TeamId;
  name: string;
  color: string;
  /** 준비된 로고 URL (IndexedDB에서 풀린 objectURL). 아직 없으면 undefined */
  logo?: string;
  total: number;
  cells: { key: string; points: number; label: string; group: ScoreColumnGroup }[];
}

/** 시상 누적 내역 한 칸. */
export interface AwardCell {
  key: string;
  label: string;
  points: number;
}

/**
 * 열 하나의 팀별 점수. 1부는 회차(`p1:x:r2`)까지 접두로 모으고, 2부는 ref 완전 일치,
 * BONUS는 `bonusRefs()` 여러 ref의 합이다.
 */
function columnPoints(state: AppState, c: ScoreColumn): Record<TeamId, number> {
  if (c.group === '보너스') return bonusPoints(state);
  if (c.group === '1부') return pointsByRefPrefix(state, c.ref);
  return pointsByRef(state, c.ref);
}

export function scoreRows(state: AppState): ScoreRow[] {
  const scores = computeScores(state);
  const cols = scoreColumns(state);
  const byRef = new Map(cols.map((c) => [c.ref, columnPoints(state, c)]));
  return activeTeams(state).map((t) => ({
    teamId: t.id,
    name: t.name,
    color: t.color,
    logo: logoUrl(t),
    total: scores[t.id].total,
    cells: cols.map((c) => ({
      key: c.key,
      label: c.label,
      group: c.group,
      points: byRef.get(c.ref)![t.id],
    })),
  }));
}

/**
 * 시상용 누적 내역 — 1부는 종목별 그대로, 2부는 **합계 한 칸**으로 접는다 (U33).
 *
 * 합산은 새로 하지 않는다. 리더보드와 같은 `scoreRows()`(= 원장 파생)를 그대로 받아 쓰므로
 * 시상 화면과 스코어보드가 다른 숫자를 말할 수 없다.
 * **2부 잠금 중에는 `scoreColumns()`가 2부 열 자체를 만들지 않으므로** 2부 칸도 생기지 않는다 (P3).
 *
 * BONUS는 접지 않고 **맨 뒤 한 칸 그대로** 둔다 (U138). 종목이 아니므로 1부 순번에 섞이면
 * 안 되고, 2부 합계와도 다른 층이다. 가감점이 없으면 열 자체가 없으니 칸도 없다.
 */
export function awardCells(row: ScoreRow): AwardCell[] {
  const cells: AwardCell[] = [];
  let p2Total = 0;
  let hasP2 = false;
  let bonus: AwardCell | null = null;
  for (const c of row.cells) {
    if (c.group === '보너스') {
      bonus = { key: c.key, label: c.label, points: c.points };
    } else if (c.group === '1부') {
      cells.push({ key: c.key, label: c.label, points: c.points });
    } else {
      hasP2 = true;
      p2Total += c.points;
    }
  }
  if (hasP2) cells.push({ key: 'p2', label: '2부', points: p2Total });
  if (bonus) cells.push(bonus);
  return cells;
}

/** 팀 id → 누적 내역. 시상 씬이 한 번 만들어 표·이력·스포트라이트가 함께 쓴다. */
export function awardBreakdown(state: AppState): Map<TeamId, AwardCell[]> {
  return new Map(scoreRows(state).map((r) => [r.teamId, awardCells(r)]));
}

/** 총점 내림차순 팀 순서 (동점은 팀 번호 순). 참가 팀만 대상으로 한다. */
export function orderByTotal(state: AppState): TeamId[] {
  const s = computeScores(state);
  const ids = activeTeamIds(state);
  return [...ids].sort((a, b) => s[b].total - s[a].total || ids.indexOf(a) - ids.indexOf(b));
}

// ---------------------------------------------------------------- 오버레이

/**
 * G1 하단 스코어바 (1920×120, U25 Broadcast Luxe).
 * 팀 식별은 좌측 컬러 바 대신 **아바타 링** 하나로 — 리더보드·명단·시상과 같은 신호다.
 * 카메라를 가리는 면적은 바뀌지 않는다(높이 `--scorebar-h` 그대로).
 */
export function scorebar(state: AppState): VNode {
  const rows = scoreRows(state);
  return h(
    'div',
    { class: 'scorebar', 'data-teams': String(rows.length), style: `--cols:${rows.length}` },
    rows.map((r) =>
      h(
        'div',
        { class: 'scorebar__team', 'data-team': r.teamId, style: `--team:${r.color}` },
        h(
          'span',
          { class: 'scorebar__avatar luxe-avatar' },
          r.logo
            ? h('img', { class: logoClass('luxe-logo', r.logo), src: r.logo, alt: '' })
            : h('span', { class: 'luxe-logo-fallback', 'aria-hidden': 'true' }, 'EC'),
        ),
        h('span', { class: 'scorebar__name' }, r.name),
        h('span', { class: 'scorebar__score', 'data-bind': 'total', 'data-team': r.teamId }, fmtPoints(r.total)),
        h('span', { class: 'scorebar__gain', 'data-bind': 'gain', 'data-team': r.teamId }),
      ),
    ),
  );
}

/** G3 타이머 배지 (우상). 숫자 굵기·대비는 유지하고 면만 luxe 캡슐로 바꿨다. */
export function timerBadge(): VNode {
  return h(
    'div',
    { class: 'timer-badge', 'data-bind': 'timerbox' },
    h('span', { class: 'timer-badge__time', 'data-bind': 'timer' }, '00:00'),
  );
}

/** G4 좌상 종목 배지 + LIVE 점멸 */
export function eventBadge(state: AppState, eventId: P1EventId | null): VNode | null {
  if (!eventId) return null;
  const ev = getEvent(state, eventId);
  return h(
    'div',
    { class: 'event-badge' },
    h('span', { class: 'event-badge__live' }, 'LIVE'),
    h('span', { class: 'event-badge__name' }, ev.name),
  );
}

export function wallClock(): VNode {
  return h('div', { class: 'wall-clock', 'data-bind': 'clock' }, '--:--');
}

/** 카메라 신호 없음 — SMPTE 컬러바 (외부 이미지 없이 CSS만) */
export function noSignal(message: string): VNode {
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  return h(
    'div',
    { class: 'nosignal' },
    h(
      'div',
      { class: 'nosignal__bars' },
      bars.map((c) => h('span', { style: `background:${c}` })),
    ),
    h(
      'div',
      { class: 'nosignal__msg' },
      h('strong', null, 'NO SIGNAL'),
      h('span', null, message),
    ),
  );
}
