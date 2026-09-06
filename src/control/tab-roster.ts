/**
 * 출전 명단 탭.
 *
 * 제시어(몸으로 말해요) 기능은 이 탭에서 **의도적으로 빠져 있다** —
 * 몸으로 말해요는 MC가 전적으로 진행하기로 확정되어, 앱은 [1부 컨트롤] 탭에서
 * 성공 라운드 수 입력만 담당한다. (display의 `prompt` 씬도 런처·큐시트에서 내렸다.)
 */

import { activeTeams } from '../state';
import { HEAT_ROSTER_EVENTS } from '../cue';
import { el } from './dom';
import { toast } from './toast';
import type { Ctx } from './ctx';
import type { P1EventId, Team, TeamId } from '../types';

export const meta = { id: 'roster', label: '출전 명단' };

/** 공개용 가상 명단. 실제 참가자는 브라우저 입력으로 관리하고 Git에 넣지 않는다.
 * 행사별 입력 구조를 바꾸면 docs/AI_CUSTOMIZATION.md의 명단·개인정보 계약도 함께 본다. */
export const ROSTER_MEMBER_PRESETS: Record<TeamId, readonly string[]> = {
  t1: Array.from({ length: 7 }, (_, i) => `샘플 1-${i + 1}`),
  t2: Array.from({ length: 7 }, (_, i) => `샘플 2-${i + 1}`),
  t3: Array.from({ length: 7 }, (_, i) => `샘플 3-${i + 1}`),
  t4: Array.from({ length: 7 }, (_, i) => `샘플 4-${i + 1}`),
  t5: [],
  t6: [],
};

/**
 * 샘플 프리셋의 팀 슬롯을 알리는 표식.
 * 색 이름은 팀 이름이 이미 들고 있으므로(U30 기본값 YELLOW/BLUE/RED/GREEN) 여기서는
 * 슬롯 번호만 말한다 — 사용자가 팀 이름을 바꿔도 어느 조의 명단인지가 남는다.
 */
export const ROSTER_PRESET_LABEL: Partial<Record<TeamId, string>> = {
  t1: '1팀',
  t2: '2팀',
  t3: '3팀',
  t4: '4팀',
};

/**
 * 명단 카드의 색 변수. `--team`(카드 액센트 바)과 `--preset`(프리셋 칩)이 **같은 팀 색** 하나에서
 * 나온다 — 프리셋 쪽에 하드코딩 hex를 따로 두면 팀 설정에서 색을 바꿔도 칩만 옛 색에 남는다.
 */
export function rosterCardStyle(team: Pick<Team, 'color'>): string {
  return `--team:${team.color};--preset:${team.color}`;
}

function rosterNames(text: string): string[] {
  return [...new Set(text.split(/[\n,·]+/).map((name) => name.trim()).filter(Boolean))];
}

function rosterLimit(eventId: P1EventId): number {
  if (eventId === 'curling' || eventId === 'newspaper') return 2;
  // U64: 끈끈이 낚시는 1v1·2v2 둘 다 가능하다 — 상한만 2로 두고 1명 출전도 그대로 허용한다.
  if (eventId === 'sticky') return 2;
  return Number.POSITIVE_INFINITY;
}

export function toggleRosterMember(
  eventId: P1EventId,
  current: string,
  member: string,
): { text: string; limitReached: boolean } {
  const names = rosterNames(current);
  const index = names.indexOf(member);
  if (index >= 0) {
    names.splice(index, 1);
    return { text: names.join(', '), limitReached: false };
  }
  if (names.length >= rosterLimit(eventId)) return { text: names.join(', '), limitReached: true };
  names.push(member);
  return { text: names.join(', '), limitReached: false };
}

export function rosterParticipation(eventId: P1EventId): string {
  if (eventId === 'curling' || eventId === 'newspaper') return '팀당 2명 출전';
  if (eventId === 'sticky') return '팀당 1~2명 출전';
  return '팀 전체 참여';
}

/**
 * 명단 입력 섹션(프리셋 칩·textarea·[명단 카드 송출])을 보여 줄지 (U55).
 *
 * 몸으로 말해요는 전원 참가라 미리 고를 대표 선수가 없다 — 큐시트에도 이 종목의 명단 자리가
 * 없다(`ROSTER_EVENTS`, `src/cue.ts`). 입력할 게 없는 종목에 빈 입력칸 4팀 분을 그대로 두면
 * 운영자가 매번 "여긴 뭘 넣어야 하지" 하고 멈춘다 — 안내 한 줄로 대체한다.
 */
export function rosterInputVisible(eventId: P1EventId): boolean {
  return eventId !== 'sync';
}

export function render(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const evId = s.sceneOpts.roster.eventId;
  const ev = s.p1.events.find((e) => e.id === evId)!;

  return el(
    'div',
    { class: 'tabpane' },
    el(
      'div',
      { class: 'seg seg--wide' },
      s.p1.events.map((e) =>
        el('button', {
          class: `seg__btn${e.id === evId ? ' is-on' : ''}`,
          type: 'button',
          text: e.name,
          on: {
            click: () =>
              ctx.dispatch({ type: 'sceneOpts/patch', patch: { roster: { eventId: e.id as P1EventId } } }),
          },
        }),
      ),
    ),
    rosterInputVisible(evId)
      ? el('p', {
          class: 'tabpane__hint',
          text: `${rosterParticipation(evId)} · 팀별 출전 선수를 입력하세요. 쉼표 또는 줄바꿈으로 구분합니다.`,
        })
      : el('p', { class: 'tabpane__hint', text: '전원 참가 · 명단 없음' }),
    rosterInputVisible(evId)
      ? el(
          'div',
          { class: 'rostergrid' },
          activeTeams(s).map((team) => {
            const current = ev.roster[team.id] ?? '';
            const selected = rosterNames(current);
            const members = ROSTER_MEMBER_PRESETS[team.id];
            const setRoster = (text: string) =>
              ctx.dispatch({ type: 'p1/roster', eventId: evId, teamId: team.id, text });
            return el(
              'div',
              {
                class: 'rostercard',
                style: rosterCardStyle(team),
              },
              el(
                'div',
                { class: 'rostercard__head' },
                el('label', {
                  class: 'field__label',
                  text: team.name,
                  attrs: { for: `roster-${evId}-${team.id}` },
                }),
                ROSTER_PRESET_LABEL[team.id]
                  ? el('span', { class: 'mono-label roster-preset__label', text: ROSTER_PRESET_LABEL[team.id] })
                  : null,
                el('span', { class: 'chip', text: `${selected.length}명 선택` }),
              ),
              members.length
                ? el(
                    'div',
                    { class: 'roster-presets', attrs: { 'aria-label': `${team.name} 선수 프리셋` } },
                    members.map((member) =>
                      el('button', {
                        class: `roster-preset__chip${selected.includes(member) ? ' is-on' : ''}`,
                        type: 'button',
                        text: member,
                        attrs: { 'aria-pressed': selected.includes(member) ? 'true' : 'false' },
                        on: {
                          click: () => {
                            const result = toggleRosterMember(evId, current, member);
                            if (result.limitReached) {
                              toast(`${rosterParticipation(evId)} — 기존 선수를 해제한 뒤 선택하세요`, 'warn');
                              return;
                            }
                            setRoster(result.text);
                          },
                        },
                      }),
                    ),
                    el('button', {
                      class: 'roster-preset__chip roster-preset__chip--clear',
                      type: 'button',
                      text: '비우기',
                      on: { click: () => setRoster('') },
                    }),
                  )
                : null,
              el('textarea', {
                class: 'input input--area',
                id: `roster-${evId}-${team.id}`,
                rows: 4,
                placeholder: `${rosterParticipation(evId)} · 이름을 쉼표 또는 줄바꿈으로 구분`,
                value: current,
                data: { fid: `roster-${evId}-${team.id}` },
                on: {
                  change: (e) => setRoster((e.target as HTMLTextAreaElement).value),
                },
              }),
            );
          }),
        )
      : null,
    rosterInputVisible(evId)
      ? el(
          'div',
          { class: 'eventcard__actions' },
          rosterBroadcastButtons(evId).map((button) =>
            el('button', {
              class: 'btn btn--ghost',
              type: 'button',
              text: button.label,
              data: { fid: `roster-send-${evId}-${button.scope}`, tip: button.tip },
              on: {
                click: () => {
                  if (button.scope === 'heat' && !s.sceneOpts.liveOverlay.versus) {
                    toast('대결 타일에서 이번 조를 먼저 고르세요 — 지금은 전체 명단이 나갑니다', 'warn');
                  }
                  ctx.dispatch({
                    type: 'scene/set',
                    scene: 'roster',
                    opts: { roster: { eventId: evId, scope: button.scope } },
                  });
                },
              },
            }),
          ),
        )
      : null,
  );
}

/**
 * 명단 송출 버튼 목록 (U61).
 *
 * 조가 있는 종목(신문지 달리기)은 **이번 조 / 전체** 두 버튼이다. 큐시트의 두 항목과
 * 같은 자리·같은 라벨을 써서, 큐로 넘기든 탭에서 누르든 같은 화면이 나가게 한다.
 * 조 구성은 런처 대결 타일이 고른 `liveOverlay.versus`이므로 여기서 따로 고르지 않는다.
 */
export function rosterBroadcastButtons(
  eventId: P1EventId,
): { scope: 'all' | 'heat'; label: string; tip: string }[] {
  const all = {
    scope: 'all' as const,
    label: HEAT_ROSTER_EVENTS.includes(eventId) ? '전체 명단 송출' : '명단 카드 송출',
    tip: '활성 4팀의 출전 명단을 모두 보여 줍니다.',
  };
  if (!HEAT_ROSTER_EVENTS.includes(eventId)) return [all];
  return [
    {
      scope: 'heat',
      label: '이번 조 명단 송출',
      tip: '런처 대결 타일에서 고른 두 팀만 보여 줍니다. 조를 고르지 않았으면 전체 명단으로 나갑니다.',
    },
    all,
  ];
}
