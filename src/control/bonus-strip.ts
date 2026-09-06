/**
 * 사회자 재량 보너스 점수 스트립 (U132)
 *
 * 지시: "사회자 재량으로 아무렇게나 점수 추가도 가능하도록 해줘. 그냥 뽀너스 점수"
 *
 * [점수 원장] 탭의 **수동 가감점**과 목적은 같지만 쓰는 상황이 다르다. 그쪽은 탭 이동 →
 * 숫자 타이핑 → 확인 모달 3단계라 사후 정정용이고, 이쪽은 사회자가 말하는 도중에 누르는
 * 것이라 **원클릭 즉시 기록**이다. 확인 모달을 두지 않는 대신 되돌리기를 토스트에 붙여,
 * 잘못 눌러도 그 자리에서 역분개할 수 있게 했다.
 *
 * 컨트롤 탭 두 곳이 같은 컴포넌트를 쓰고 `part`만 다르다. 이 파일이 만드는 문자열에는
 * 잠금 대상 낱말이 하나도 없어야 한다 — 잠금 해제 전 컨트롤 탭에 그려지기 때문이다.
 * `part`는 원장 `ref`의
 * 접두(`p1:bonus` / `p2:bonus`)가 되어 `computeScores`의 소계 분기를 탄다 — 어느 탭에서
 * 눌렀는지가 그대로 어느 소계에 얹히는지가 된다.
 */

import { activeTeamIds, getTeam } from '../state';
import { fmtPoints } from '../scoring';
import { el } from './dom';
import { toast } from './toast';
import type { Ctx } from './ctx';
import type { TeamId } from '../types';

/**
 * 원클릭 프리셋. 사회자가 입으로 부르는 단위(십점·오십점·백점)에 맞춘 다섯 개다.
 * 그 사이 값이나 소수점은 [직접 입력…]으로 원장 탭의 수동 가감점에 맡긴다.
 */
export const BONUS_PRESETS = [10, 20, 30, 50, 100];

/** 감점 표시에 쓰는 진짜 마이너스 기호. 하이픈보다 폭이 넓어 `+`와 시각적으로 짝이 맞는다. */
const MINUS = '−';

export type BonusPart = 'p1' | 'p2';

/**
 * 버튼 하나가 만드는 원장 액션.
 *
 * `minus`(= Shift+클릭)면 같은 프리셋을 음수로 뒤집는다. 감점 전용 버튼을 따로 두면 줄이
 * 두 배가 되는데, 감점은 드물어서 그만한 자리를 줄 이유가 없다.
 */
export function bonusAction(
  teamId: TeamId,
  preset: number,
  opts: { minus: boolean },
  part: BonusPart,
  now: number,
): { type: 'ledger/bonus'; teamId: TeamId; delta: number; part: BonusPart; reason: string; now: number } {
  return {
    type: 'ledger/bonus',
    teamId,
    delta: opts.minus ? -preset : preset,
    part,
    reason: opts.minus ? '사회자 감점' : '사회자 보너스',
    now,
  };
}

/** 기록 직후 토스트 문구. 부호를 문장 안에서 한 번 더 말해 준다 (잘못 누른 걸 눈으로 잡으라고). */
export function bonusToastMessage(teamName: string, delta: number): string {
  return delta < 0
    ? `${teamName} ${MINUS}${fmtPoints(-delta)} 감점`
    : `${teamName} +${fmtPoints(delta)} 보너스`;
}

/**
 * 방금 dispatch한 보너스 줄의 id.
 *
 * `ctx.dispatch`는 동기다(`control.ts`가 `for (const a of list) state = reducer(state, a)`를
 * 그 자리에서 돌리고 `ctx.state`는 그 변수를 읽는 getter다). 그래서 호출 직후의 마지막
 * 원장 항목이 방금 만든 줄이다. 다만 dispatch 경로에 라우팅·배치가 끼어 있으므로
 * **세 필드가 모두 맞을 때만** 그 id를 신뢰하고, 아니면 `null`을 돌려 되돌리기 버튼 없는
 * 토스트로 떨어진다 — 엉뚱한 줄을 역분개하느니 버튼이 없는 편이 낫다.
 */
export function lastBonusEntryId(
  ctx: Ctx,
  expect: { teamId: TeamId; delta: number; ref: string },
): string | null {
  const ledger = ctx.state.ledger;
  const last = ledger[ledger.length - 1];
  if (!last) return null;
  if (last.teamId !== expect.teamId || last.delta !== expect.delta || last.ref !== expect.ref) {
    return null;
  }
  return last.id;
}

/** 이 스트립이 쓰는 원장 ref. 리듀서(`ledger/bonus`)와 같은 규칙을 한 자리에서 만든다. */
export function bonusRef(part: BonusPart): string {
  return part === 'p2' ? 'p2:bonus' : 'p1:bonus';
}

export function renderBonusStrip(ctx: Ctx, part: BonusPart): HTMLElement {
  const s = ctx.state;
  const ids = activeTeamIds(s);

  const give = (teamId: TeamId, preset: number, minus: boolean): void => {
    const action = bonusAction(teamId, preset, { minus }, part, Date.now());
    // 클릭 시점의 상태를 읽는다 — 렌더 스냅숏(`s`)은 팀 이름이 바뀐 뒤면 낡아 있다 (리뷰 m2).
    const team = getTeam(ctx.state, teamId);
    ctx.dispatch(action);
    const entryId = lastBonusEntryId(ctx, {
      teamId,
      delta: action.delta,
      ref: bonusRef(part),
    });
    const message = bonusToastMessage(team.name, action.delta);
    if (entryId) {
      toast(message, 'ok', {
        label: '되돌리기',
        tip: '방금 기록한 이 한 줄만 역분개합니다. 원장은 지워지지 않고 상쇄 줄이 한 줄 더 쌓입니다.',
        onClick: () => {
          // 결과를 확인하고 말한다 (리뷰 Major): 사라지는 토스트의 버튼이 한 번 더 눌리거나(이미 역분개
          // 됨 → `reverseEntriesFor`가 빈 배열) 리더가 아닌 창이면 dispatch가 조용히 막혀 원장 길이가
          // 늘지 않는다. 그때 "되돌렸습니다"라고 하면 거짓 확인이다. 원장 자체는 두 경우 모두 안전하다.
          const before = ctx.state.ledger.length;
          ctx.dispatch({ type: 'ledger/reverse', entryId, now: Date.now() });
          if (ctx.state.ledger.length > before) toast(`${team.name} 보너스를 되돌렸습니다`);
          else toast('되돌리지 못했습니다 — 이미 되돌렸거나 이 창에 조작 권한이 없습니다', 'warn');
        },
      });
    } else {
      toast(message);
    }
    // `ctx.refresh()`는 부르지 않는다 — `dispatch`가 이미 재렌더를 돌리고, 비리더 창은 `inert`라
    // 여기까지 오지 못한다 (리뷰 m1: 클릭당 전체 재렌더 2회 제거).
  };

  return el(
    'section',
    { class: 'bonus-strip' },
    el(
      'div',
      { class: 'bonus-strip__head' },
      el('h3', { class: 'bonus-strip__title', text: '보너스 점수' }),
      el('button', {
        class: 'btn btn--ghost btn--tiny bonus-strip__more',
        type: 'button',
        text: '직접 입력…',
        data: {
          fid: `bonus-more-${part}`,
          tip: '프리셋에 없는 값·소수점·사유를 넣으려면 [점수 원장] 탭의 수동 가감점을 씁니다.',
        },
        on: { click: () => ctx.setTab('ledger') },
      }),
    ),
    el('p', {
      class: 'bonus-strip__hint',
      text: '사회자 재량. 누르는 즉시 원장에 기록되고 토스트 [되돌리기] 또는 [점수 원장] 탭에서 역분개할 수 있습니다. Shift+클릭은 감점입니다.',
    }),
    el(
      'div',
      { class: 'bonus-strip__rows' },
      ids.map((id) => {
        const team = getTeam(s, id);
        return el(
          'div',
          { class: 'bonus-strip__row', style: `--team:${team.color}` },
          el('span', { class: 'bonus-strip__team', text: team.name }),
          el(
            'div',
            { class: 'bonus-strip__btns' },
            BONUS_PRESETS.map((preset) =>
              el('button', {
                class: 'bonus-strip__btn',
                type: 'button',
                text: `+${preset}`,
                data: {
                  fid: `bonus-${part}-${id}-${preset}`,
                  tip: `${team.name}에 ${preset}점을 즉시 더합니다. 확인 창 없이 원장에 기록되고, 토스트 [되돌리기]로 취소할 수 있습니다. Shift+클릭은 ${MINUS}${preset}점 감점입니다.`,
                },
                attrs: {
                  'aria-label': `${team.name} ${preset}점 보너스 (Shift+클릭은 ${preset}점 감점)`,
                },
                on: {
                  click: (ev: MouseEvent) => give(id, preset, ev.shiftKey),
                },
              }),
            ),
          ),
        );
      }),
    ),
  );
}
