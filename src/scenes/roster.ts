import { activeTeams, getEvent } from '../state';
import { MATCH_EVENTS } from '../cue';
import { eventMark, rowIntroDelayMs } from './luxe-grid';
import { h, renderInto, type VNode } from '../vdom';
import { logoClass, logoUrl } from '../logos';
import type { AppState, Team, TeamId } from '../types';

/**
 * G7 출전 명단 (U28) — Broadcast Luxe 언어를 **명단 콘텐츠에 맞게 응용**한 레이아웃.
 *
 * 리더보드의 행 표를 그대로 쓰지 않는다. 명단에서 가장 중요한 건 순위가 아니라 **선수 이름**이라
 * 팀마다 패널을 주고 이름을 흰 캡슐에 크게 앉힌다. 공유하는 것은 디자인 언어뿐이다 —
 * 보드 인셋·마스트헤드·아바타 링·흰 캡슐·보라 구조색·자간 규칙(`--luxe-*` 토큰).
 *
 *   기본     4팀 2×2 / 5~6팀 3열 패널 그리드
 *   조별     versus 두 팀만 두 칸 그리드로 (U61) — VS 타이포·대결 보더 없음
 *   대결     versus 두 팀만 좌·우 큰 패널로, 가운데는 큰 VS 타이포
 *
 * 종목은 `sceneOpts.roster.eventId`(P1EventId)라 구조상 1부 종목만 렌더한다 (2부 잠금).
 *
 * 대결 레이아웃은 `MATCH_EVENTS`(컬링)에서만 나온다 (U55). 신문지 달리기·끈끈이 낚시도 두 팀씩
 * 나오지만 대결이 아니라 기록·점수로 순위를 정하므로, `liveOverlay.versus`가 남아 있어도(직전
 * 컬링 대결의 잔여값 등) 4팀 그리드를 그대로 유지한다.
 *
 * U61은 그 U55 결정을 **좁힐 뿐 뒤집지 않는다.** 신문지 달리기가 두 팀만 보여 주는 것은
 * `scope: 'heat'`을 명시했을 때뿐이고, 그때도 대결 레이아웃(`rs__duel` + `rs__vs`)이 아니라
 * 같은 패널 두 칸이다 — versus 잔여값이 조용히 대결 화면을 만들어 내던 문제는 그대로 막혀 있다.
 */

/** 콤마·줄바꿈으로 적은 명단 문자열을 이름 배열로 — 빈 칸은 버린다. */
export function parseRoster(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 패널 그리드 열 수. 4팀은 2×2, 5~6팀은 3열로 두 줄을 유지한다. */
export function panelColumns(teamCount: number): number {
  return teamCount <= 4 ? 2 : 3;
}

/**
 * 한 패널에 그리는 이름 칸의 최대 개수. 3열 × 3행이 세로 예산의 한계다.
 * 이보다 많으면 8명까지만 적고 마지막 칸을 "외 n명" 배지로 쓴다.
 */
export const MAX_SEATS = 9;

/**
 * 이름 캡슐이 앉는 열 수. **칸 수**(이름 + 넘침 배지)를 받는다 — 이름 수를 받으면
 * `data-seats` 구간과 서로 다른 값을 보게 되어 행 수가 어긋난다.
 * 1~3칸은 한 줄씩 크게, 4~6칸은 2열, 7칸부터 3열. 어느 경우도 3행을 넘지 않는다.
 */
export function seatColumns(seatCount: number): number {
  if (seatCount >= 7) return 3;
  return seatCount >= 4 ? 2 : 1;
}

/** CSS 규격 구간. 7 이상은 한 구간으로 묶는다(3열 × 3행이 상한이라 규격이 같다). */
export function seatBucket(seatCount: number): number {
  return Math.min(seatCount, 7);
}

/**
 * 패널에 실제로 그릴 칸. 상한을 넘으면 8명까지 적고 넘침 배지를 한 칸 쓴다.
 * 몸으로 말해요는 `rosterLimit`이 없어 "팀 전체"(프리셋 7명 이상)가 그대로 들어온다.
 */
export function seatCells(names: string[]): { names: string[]; overflow: number } {
  if (names.length <= MAX_SEATS) return { names, overflow: 0 };
  return { names: names.slice(0, MAX_SEATS - 1), overflow: names.length - (MAX_SEATS - 1) };
}

interface Entry {
  team: Team;
  names: string[];
  side: 'left' | 'right' | null;
}

export function view(state: AppState): VNode {
  const { eventId, scope } = state.sceneOpts.roster;
  const ev = getEvent(state, eventId);
  // 대결 레이아웃도, 좌·우 side 표식도 이 종목이 실제 대결 종목일 때만 의미가 있다 — 아니면
  // 직전 컬링 대결의 잔여 versus 값이 그리드 모드에 `data-side`만 새어 들어간다 (U55).
  const versus = MATCH_EVENTS.includes(ev.id) ? state.sceneOpts.liveOverlay.versus : null;
  const entries: Entry[] = activeTeams(state).map((team) => ({
    team,
    names: parseRoster(ev.roster[team.id]),
    side: versusSide(versus, team.id),
  }));
  const duel = versus ? orderedDuel(entries, versus) : null;
  // 조별 보드 (U61). 조를 고르지 않았으면(versus가 비었으면) 두 팀을 지어내지 않고 전체
  // 명단으로 떨어진다 — 화면이 아무 두 팀이나 "이번 조"라고 말하면 안 된다.
  const heat =
    scope === 'heat' && !duel
      ? orderedHeat(entries, state.sceneOpts.liveOverlay.versus)
      : null;

  return h(
    'div',
    { class: 'scene scene--roster' },
    h(
      'div',
      { class: 'luxe-board', 'data-teams': String(entries.length) },
      h(
        'div',
        { class: 'luxe-mast' },
        // U46 — 세 보드 씬 통일
        eventMark(),
        h(
          'div',
          { class: 'luxe-mast__text' },
          h('div', { class: 'luxe-mast__eyebrow' }, '출전명단'),
          h('div', { class: 'luxe-mast__title' }, ev.name),
        ),
      ),
      duel ? duelBody(duel) : heat ? heatBody(heat) : gridBody(entries),
    ),
  );
}

/** 기본 — 팀 패널 그리드 */
function gridBody(entries: Entry[]): VNode {
  const cols = panelColumns(entries.length);
  return h(
    'div',
    { class: 'rs__grid', 'data-cols': String(cols), style: `--panel-cols:${cols}` },
    entries.map((e, i) => panel(e, i, entries.length)),
  );
}

/**
 * 조별 명단 (U61) — 이번 조 두 팀만.
 *
 * `duelBody`를 재사용하지 **않는다.** `rs__vs`의 "VS" 글자와 `rs__duel-stage`의 대칭 구도는
 * "이 둘이 맞붙는다"는 뜻을 담고 있다. 신문지 달리기는 두 팀이 같은 조에서 각자 기록을
 * 낼 뿐이라 그 뜻이 틀린다. 그래서 전체 명단과 **같은 패널**을 두 칸만 그린다 — 화면 언어가
 * 전체 ↔ 조별 사이에서 갈리지 않는다.
 */
function heatBody(heat: [Entry, Entry]): VNode {
  return h(
    'div',
    { class: 'rs__grid rs__grid--heat', 'data-cols': '2', style: '--panel-cols:2' },
    heat.map((e, i) => panel(e, i, heat.length)),
  );
}

/** 대결 종목 — 현재 대결하는 좌·우 두 팀만 보여 준다. */
function duelBody(duel: [Entry, Entry]): VNode {
  return h(
    'div',
    { class: 'rs__duel' },
    h(
      'div',
      { class: 'rs__duel-stage' },
      panel(duel[0], 0, 2, 'duel'),
      h('div', { class: 'rs__vs' }, 'VS'),
      panel(duel[1], 1, 2, 'duel'),
    ),
  );
}

function panel(entry: Entry, index: number, total: number, variant?: 'duel'): VNode {
  const { team, names, side } = entry;
  const cells = seatCells(names);
  // 이름 칸 + 넘침 배지 = 실제 칸 수. 열 수와 규격 구간이 같은 수를 봐야 행이 안 어긋난다.
  const seatCount = Math.max(1, cells.names.length + (cells.overflow ? 1 : 0));
  const cls = [
    'rs__panel',
    variant === 'duel' ? 'rs__panel--duel' : null,
    names.length ? null : 'is-empty',
  ]
    .filter(Boolean)
    .join(' ');

  return h(
    'div',
    {
      class: cls,
      'data-team': team.id,
      'data-seats': String(seatBucket(seatCount)),
      ...(side ? { 'data-side': side } : {}),
      style:
        `--team:${team.color}; --panel-delay:${rowIntroDelayMs(index, total)}ms;` +
        ` --seat-cols:${seatColumns(seatCount)}`,
    },
    h(
      'div',
      { class: 'rs__head' },
      h('span', { class: 'luxe-avatar' }, teamLogo(team)),
      h('span', { class: 'rs__team' }, team.name),
      h('span', { class: 'rs__count' }, countLabel(names.length)),
    ),
    h(
      'div',
      { class: 'rs__seats' },
      names.length
        ? [
            ...cells.names.map((n) =>
              h('div', { class: 'rs__seat' }, h('span', { class: 'rs__seat-name' }, n)),
            ),
            cells.overflow
              ? h(
                  'div',
                  { class: 'rs__seat rs__seat--more' },
                  h('span', { class: 'rs__seat-name' }, `외 ${cells.overflow}명`),
                )
              : null,
          ]
        : h('div', { class: 'rs__seat rs__seat--none' }, h('span', { class: 'rs__seat-name' }, '명단 미정')),
    ),
  );
}

function countLabel(n: number): string {
  return n ? `${n}명` : '미정';
}

function teamLogo(team: Team): VNode {
  const url = logoUrl(team);
  return url
    ? h('img', { class: logoClass('luxe-logo', url), src: url, alt: '' })
    : h('span', { class: 'luxe-logo-fallback', 'aria-hidden': 'true' }, 'EC');
}

/** 대결 종목이면 좌·우 어느 쪽인지 — 없으면 null이라 마크업 자체가 생기지 않는다. */
function versusSide(versus: [TeamId, TeamId] | null, id: TeamId): 'left' | 'right' | null {
  if (!versus) return null;
  if (versus[0] === id) return 'left';
  if (versus[1] === id) return 'right';
  return null;
}

/** 좌·우 순서는 오버레이 컬러 보더와 같게 versus 배열 순서를 그대로 따른다. */
function orderedDuel(entries: Entry[], versus: [TeamId, TeamId]): [Entry, Entry] | null {
  const left = entries.find((e) => e.team.id === versus[0]);
  const right = entries.find((e) => e.team.id === versus[1]);
  return left && right ? [left, right] : null;
}

/**
 * 이번 조 두 팀 (U61). 순서는 대결과 같은 규칙 — 런처에서 고른 배열 순서 그대로라
 * 중계 화면의 좌·우 컬러 보더와 자리가 어긋나지 않는다.
 * 조합이 없거나 그 팀이 지금 활성 팀에 없으면 `null`이고, 호출부가 전체 명단으로 떨어진다.
 */
function orderedHeat(entries: Entry[], versus: [TeamId, TeamId] | null): [Entry, Entry] | null {
  return versus ? orderedDuel(entries, versus) : null;
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
