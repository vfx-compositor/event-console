import { activeLedger, activeTeamIds, getTeam } from '../state';
import { el } from './dom';
import { renderStandings } from './standings';
import { fmtPoints } from '../scoring';
import { openModal } from './modal';
import { toast } from './toast';
import type { Ctx } from './ctx';
import type { TeamId } from '../types';

export const meta = { id: 'ledger', label: '점수 원장' };

/** 화면에 그리는 최근 기록 수. 원장 자체는 append-only라 잘라도 데이터는 남는다. */
const VISIBLE_ROWS = 200;

/** 'HH:MM:SS'. ko-KR 기본 포맷('0시 50분 4초')은 폭이 들쭉날쭉해 표 열에서 줄바꿈을 만든다. */
function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 수동 가감점 입력의 미확정 값.
 *
 * 상태(AppState)가 아니라 탭 로컬 값이다 — [기록]을 누르기 전에는 원장에 아무것도 없어야 하고,
 * 출력 화면과도 무관하다. 전체 재렌더가 잦은 패널이라 모듈 로컬에 둬야 입력 중인 값이 살아남는다.
 */
const draft: { teamId: TeamId | null; delta: string; reason: string } = {
  teamId: null,
  delta: '',
  reason: '',
};

/**
 * 수동 가감점 입력값 파싱.
 *
 * 0과 빈 값은 기록하지 않는다 — 원장에 '변동 없음' 줄이 쌓이면 되돌리기 대상을 찾기 어려워진다.
 */
export function parseManualDelta(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/** 테스트용 입력 시뮬레이션 — 실제 UI의 `input` 이벤트가 하는 일과 같다 */
export function setManualDraft(patch: Partial<typeof draft>): void {
  Object.assign(draft, patch);
}

/**
 * 지금 입력돼 있는 값으로 만든 원장 액션. 값이 없으면 `null`.
 *
 * **호출 시점의 draft를 읽는 것이 계약이다.** 렌더 시점 값을 클로저에 담아 두면 그 뒤 타이핑한
 * 내용이 반영되지 않아 [기록]이 조용히 아무 일도 하지 않는다(D6 실사고). `input` 이벤트는
 * 재렌더를 일으키지 않으므로 렌더 스냅샷은 항상 낡아 있다.
 */
export function manualLedgerAction(
  teamId: TeamId | null,
  now: number,
): { type: 'ledger/manual'; teamId: TeamId; delta: number; reason: string; now: number } | null {
  const delta = parseManualDelta(draft.delta);
  if (!teamId || delta === null) return null;
  return { type: 'ledger/manual', teamId, delta, reason: draft.reason.trim() || '수동 조정', now };
}

function manualForm(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const ids = activeTeamIds(s);
  if (draft.teamId === null || !ids.includes(draft.teamId)) draft.teamId = ids[0] ?? null;
  const teamId = draft.teamId;
  // 버튼 disabled 판정용 스냅샷. **제출은 이 값을 쓰지 않는다** — 렌더 시점 값이라 그 뒤
  // 타이핑한 내용이 반영되지 않아 [기록]이 조용히 아무 일도 안 하는 사고가 났다(D6).
  const deltaAtRender = parseManualDelta(draft.delta);

  const submit = (): void => {
    // 누르는 순간의 입력값으로 액션을 만든다 (렌더 스냅샷을 쓰면 D6 재발)
    const action = manualLedgerAction(teamId, Date.now());
    if (!action) return;
    const team = getTeam(s, action.teamId);
    const sign = action.delta > 0 ? '+' : '';
    openModal({
      title: '수동 가감점',
      body: `${team.name}에 ${sign}${fmtPoints(action.delta)}점을 기록합니다. (${action.reason})`,
      confirmLabel: '기록',
      onConfirm: () => {
        ctx.dispatch(action);
        draft.delta = '';
        draft.reason = '';
        toast(`${team.name} ${sign}${fmtPoints(action.delta)}점을 기록했습니다`);
        ctx.refresh();
      },
    });
  };

  return el(
    'section',
    { class: 'ledger-manual' },
    el('h3', { class: 'ledger-manual__title', text: '수동 가감점' }),
    el(
      'div',
      { class: 'ledger-manual__teams' },
      ids.map((id) => {
        const team = getTeam(s, id);
        return el('button', {
          class: `ledger-manual__chip${teamId === id ? ' is-on' : ''}`,
          type: 'button',
          text: team.name,
          style: `--team:${team.color}`,
          data: { fid: `ledger-manual-team-${id}`, tip: `${team.name}에 점수를 직접 더하거나 뺍니다.` },
          attrs: { 'aria-pressed': teamId === id ? 'true' : 'false' },
          on: {
            click: () => {
              draft.teamId = id;
              ctx.refresh();
            },
          },
        });
      }),
    ),
    el(
      'div',
      { class: 'ledger-manual__row' },
      el('input', {
        class: 'input ledger-manual__delta',
        type: 'number',
        step: 10,
        value: draft.delta,
        placeholder: '±점수',
        data: { fid: 'ledger-manual-delta', tip: '음수를 넣으면 감점입니다. 0과 빈 칸은 기록되지 않습니다.' },
        attrs: { 'aria-label': '가감점' },
        on: {
          input: (ev) => {
            draft.delta = (ev.target as HTMLInputElement).value;
            const btn = document.querySelector<HTMLButtonElement>('[data-fid="ledger-manual-submit"]');
            if (btn) btn.disabled = parseManualDelta(draft.delta) === null;
          },
          keydown: (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') submit();
          },
        },
      }),
      el('input', {
        class: 'input ledger-manual__reason',
        type: 'text',
        value: draft.reason,
        placeholder: '사유 (비우면 "수동 조정")',
        data: { fid: 'ledger-manual-reason', tip: '나중에 원장에서 이 줄을 찾을 때 쓰는 설명입니다.' },
        attrs: { 'aria-label': '사유' },
        on: {
          input: (ev) => {
            draft.reason = (ev.target as HTMLInputElement).value;
          },
          keydown: (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') submit();
          },
        },
      }),
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: '기록',
        disabled: deltaAtRender === null || !teamId,
        data: { fid: 'ledger-manual-submit', tip: '원장에 한 줄을 추가합니다. 되돌리기는 역분개로 남습니다.' },
        on: { click: submit },
      }),
    ),
  );
}

/**
 * [새 게임 시작 (점수 되돌리기)] (U126 — 사용자 지시 "점수 리셋", 10:51 → 보강 10:5x
 * "점수만 되돌리는 거야. 게임을 오늘 새로 시작할 수 있도록.").
 *
 * 목적이 "리셋 한 줄"이 아니라 **새 게임 시작**이라, 점수(원장 일괄 역분개)만으로는 부족하다
 * — 승리 팀 선택·점수 공개 강조가 남아 있으면 다음 큐에서 옛 화면이 새고, 1부 종목이 "확정
 * 완료·N회차"로 남아 있으면 종목 카드가 끝난 게임인 척하며, 단계별 제출 기록이 남아 있으면
 * 진행 탭도 마찬가지다. 그래서 `game/restart` 하나가 점수 역분개 + 진행 상태 리셋을 리듀서
 * 한 곳에서 함께 처리한다 (`state.ts` 참고 — 되돌리는 것/두는 것 목록). 1부 종목의 **id·이름·
 * 출전 명단(roster)**은 진행이 아니라 설정성 값이라 그대로 둔다(`freshP1Event`).
 * 삭제가 아니라 **일괄 역분개**다 — append-only 계약(SPEC §P4)은 그대로다.
 *
 * **이 탭은 어느 진행 단계에서도 열리므로, 여기서 만드는 문자열은 아직 해제되지 않은 단계의
 * 존재를 드러내는 낱말을 쓰지 않는다** — "단계별 제출 기록"처럼 중립 표현만 쓴다. 이 파일
 * 전체에서 해당 낱말 부재를 지키는 테스트가 이미 있다(`tab-ledger.test.ts`).
 *
 * 위험 동작이라 줄 단위 `되돌리기`와 같은 관례(빨간 버튼 + `openModal` danger 확인)를 쓴다.
 * 점수뿐 아니라 진행 상태까지 건드리는 조작이라 **점수가 이미 0이어도 모달을 생략하지 않는다**
 * — 큐 위치·단계별 제출 기록만 남아 있는 상태에서 조용히 넘어가면 "눌렀는데 안 됐다"가 된다.
 * 대신 본문 첫 줄이 점수 역분개 유무를 그대로 말한다. 단축키는 없다(실수 방지).
 */
function resetAllButton(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const activeCount = activeLedger(s.ledger).length;
  return el('button', {
    class: 'btn btn--tiny btn--danger',
    type: 'button',
    text: '새 게임 시작 (점수 되돌리기)',
    data: {
      tip: '점수를 0으로 되돌리고 승리 팀 선택·점수 공개·1부 진행·단계별 제출 기록·시상 진행·큐 위치를 초기화합니다. 설정·에셋·팀·음악·현재 화면은 그대로입니다.',
    },
    on: {
      click: () => {
        const scoreNote = activeCount > 0 ? `점수(유효 항목 ${activeCount}건 역분개)` : '점수(이미 0)';
        openModal({
          title: '새 게임 시작',
          body: el(
            'div',
            {},
            el('p', { text: `초기화: ${scoreNote}·승리 팀·점수 공개·1부 진행·단계별 제출·시상 진행·큐 커서` }),
            el('p', { text: '유지: 설정·에셋·팀·음악(라이브러리·북마크)·현재 화면·타이머' }),
          ),
          danger: true,
          confirmLabel: '새 게임 시작',
          onConfirm: () => {
            ctx.dispatch({ type: 'game/restart', reason: '새 게임 시작', now: Date.now() });
            toast(`새 게임을 시작했습니다${activeCount > 0 ? ` (점수 ${activeCount}건 역분개)` : ''}`);
            ctx.refresh();
          },
        });
      },
    },
  });
}

export function render(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const active = new Set(activeLedger(s.ledger).map((e) => e.id));
  const rows = [...s.ledger].reverse().slice(0, VISIBLE_ROWS);

  return el(
    'div',
    { class: 'tabpane' },
    el('p', {
      class: 'tabpane__hint',
      text: '점수의 진실은 이 원장뿐입니다. 화면 점수는 유효 항목의 합계이고, 되돌리기는 삭제가 아니라 부호가 반대인 항목을 더하는 역분개입니다.',
    }),
    renderStandings(ctx, { compact: true }),
    manualForm(ctx),
    el(
      'div',
      { class: 'ledger__head' },
      el('h3', { class: 'ledger-manual__title', text: '기록' }),
      el(
        'div',
        { class: 'ledger__head-actions' },
        el('span', {
          class: 'ledger__count mono-label',
          text: `${s.ledger.length} entries`,
          data: {
            tip:
              s.ledger.length > VISIBLE_ROWS
                ? `총 ${s.ledger.length}건 중 최근 ${VISIBLE_ROWS}건만 표시합니다. 기록은 지워지지 않습니다.`
                : '기록은 지워지지 않습니다. 되돌리기는 삭제가 아니라 부호가 반대인 항목을 추가하는 역분개입니다.',
          },
          tabIndex: 0,
        }),
        resetAllButton(ctx),
      ),
    ),
    el(
      'ul',
      { class: 'ledger__list' },
      rows.length
        ? rows.map((e) => {
            const team = getTeam(s, e.teamId);
            const isActive = active.has(e.id);
            const isReversal = Boolean(e.reverseOf);
            return el(
              'li',
              {
                class: `ledger__row${isActive ? '' : ' is-void'}${isReversal ? ' is-reversal' : ''}`,
                style: `--team:${team.color}`,
              },
              el('span', { class: 'ledger__time mono-label', text: hhmmss(e.ts) }),
              el('span', { class: 'ledger__team', text: team.name }),
              el('span', {
                class: `ledger__delta${e.delta >= 0 ? ' is-plus' : ' is-minus'}`,
                text: `${e.delta > 0 ? '+' : ''}${fmtPoints(e.delta)}`,
              }),
              el('span', { class: 'ledger__reason', text: e.reason, data: { tip: `${e.reason} · ref ${e.ref}` } }),
              isActive && !isReversal
                ? el('button', {
                    class: 'btn btn--tiny',
                    type: 'button',
                    text: '되돌리기',
                    data: { tip: '이 항목만 역분개합니다 (기록은 남습니다).' },
                    on: {
                      click: () =>
                        openModal({
                          title: '되돌리기',
                          body: `${team.name} · ${e.reason} (${e.delta > 0 ? '+' : ''}${fmtPoints(e.delta)}) 을 역분개합니다.`,
                          danger: true,
                          confirmLabel: '역분개',
                          onConfirm: () => {
                            ctx.dispatch({ type: 'ledger/reverse', entryId: e.id, now: Date.now() });
                            toast('역분개했습니다');
                          },
                        }),
                    },
                  })
                : el('span', { class: 'ledger__flag', text: isReversal ? '역분개' : '무효' }),
            );
          })
        : el('li', { class: 'ledger__empty', text: '아직 기록이 없습니다' }),
    ),
  );
}
