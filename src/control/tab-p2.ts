import { el } from './dom';
import { renderBonusStrip } from './bonus-strip';
import { renderStandings } from './standings';
import { fmtPoints, pointsFromRanks, rankSubmissions } from '../scoring';
import { fmtRemaining, parseRemaining } from '../p2-remaining';
import { activeTeamIds, getTeam, pointsByRef } from '../state';
import { openModal } from './modal';
import { toast } from './toast';
import type { EventStatus, P2StageId, TeamId } from '../types';
import type { Ctx } from './ctx';

export const meta = { id: 'p2', label: '2부 컨트롤' };

const STATUS_LABEL: Record<EventStatus, string> = { pending: '대기', live: '진행', done: '완료' };

function hhmmss(ts: number): string {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour12: false });
}

/**
 * 남은 시간 입력칸의 미확정 값 (U135). 키는 `단계:팀`.
 *
 * 원장 탭 수동 가감점(`tab-ledger.ts`)과 같은 이유로 상태가 아니라 모듈 로컬이다 — [기록]을
 * 누르기 전에는 아무 데도 반영되지 않아야 하고, 이 패널은 전체 재렌더가 잦아 상태에 두면
 * 입력 중인 값이 날아간다.
 */
const remainDraft: Record<string, string> = {};

function draftKey(stageId: P2StageId, teamId: TeamId): string {
  return `${stageId}:${teamId}`;
}

/** 테스트용 입력 시뮬레이션 — 실제 UI의 `input` 이벤트가 하는 일과 같다. */
export function setRemainingDraft(stageId: P2StageId, teamId: TeamId, raw: string): void {
  remainDraft[draftKey(stageId, teamId)] = raw;
}

/**
 * 지금 입력돼 있는 값으로 만든 기록 액션. 값이 없거나 못 읽으면 `null`.
 *
 * **호출 시점의 draft를 읽는 것이 계약이다** (D6 실사고) — 렌더 시점 값을 클로저에 담으면
 * 그 뒤 타이핑한 내용이 반영되지 않아 [기록]이 조용히 아무 일도 하지 않는다.
 */
export function remainingSubmitAction(
  stageId: P2StageId,
  teamId: TeamId,
): { type: 'p2/submitRemaining'; stageId: P2StageId; teamId: TeamId; remainingSec: number } | null {
  const sec = parseRemaining(remainDraft[draftKey(stageId, teamId)] ?? '');
  if (sec === null) return null;
  return { type: 'p2/submitRemaining', stageId, teamId, remainingSec: sec };
}

export function render(ctx: Ctx): HTMLElement {
  const s = ctx.state;

  if (!s.p2.unlocked) {
    return el(
      'div',
      { class: 'tabpane tabpane--locked' },
      el('div', { class: 'locked__icon', text: 'LOCK' }),
      el('p', { class: 'locked__msg', text: '이 탭은 잠겨 있습니다. 좌측 [잠금 해제]로 확인 2단계를 거친 뒤 열립니다.' }),
      el('p', { class: 'locked__sub', text: '잠금 상태에서는 출력 화면 어디에도 관련 요소가 렌더되지 않습니다.' }),
    );
  }

  const ids = activeTeamIds(s);
  const table = s.settings.scoreTable.p2.slice(0, ids.length);
  const win = s.settings.tieWindowSec;

  return el(
    'div',
    { class: 'tabpane' },
    /**
     * [다시 잠그기]는 여기 있다 (U49). 런처의 `UNLOCKED · 별도 묶음` 퀵 카드를 걷어내면서
     * 옮겼다 — 해제된 뒤의 조작은 전부 이 탭에 모으는 편이 "잠금은 이 탭의 문제"라는
     * 모델과 맞는다. 반대로 [잠금 해제]는 런처에 남는다: 잠긴 동안에는 이 탭 자체가
     * 비활성이라 여기 두면 열 방법이 사라진다.
     */
    el(
      'div',
      { class: 'p2-lockbar' },
      el('span', { class: 'p2-lockbar__label mono-label', text: 'UNLOCKED' }),
      el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        text: '다시 잠그기',
        data: {
          fid: 'p2-relock',
          tip: '다시 잠그면 후반부 씬은 즉시 대기 화면으로 강등되고 이 탭도 닫힙니다. 출력 화면에는 관련 요소가 다시 렌더되지 않습니다.',
        },
        on: {
          click: () =>
            openModal({
              title: '다시 잠그기',
              body: '잠그면 해당 씬은 즉시 대기 화면으로 강등됩니다. 진행할까요?',
              confirmLabel: '잠그기',
              onConfirm: () => {
                ctx.dispatch({ type: 'p2/lock' });
                toast('다시 잠갔습니다');
              },
            }),
        },
      }),
    ),
    renderStandings(ctx),
    renderBonusStrip(ctx, 'p2'),
    el('p', {
      class: 'tabpane__hint',
      text: `[제출]을 누른 시각이 기록됩니다. 정답 확정 시 제출 순서로 순위가 매겨지고 점수표 ${table.join(' / ')}이 배분됩니다. 선두로부터 ${win}초 이내 제출은 공동 순위(평균 점수)입니다. 남은 시간을 직접 적어 [기록]하면 많이 남은 팀이 앞 순위입니다 — 선두와 ${win}초 이내 차이는 똑같이 공동 순위. 한 단계에서는 시각 제출과 남은 시간 중 한 방식만 쓰세요.`,
    }),
    el(
      'div',
      { class: 'eventgrid' },
      s.p2.stages.map((st) => {
        const live = rankSubmissions(st.submissions, win, ids);
        const ranks = st.confirmedAt ? st.ranks : live;
        const preview = pointsFromRanks(ranks, table, ids);
        const recorded = pointsByRef(s, `p2:${st.id}`);
        const anySub = ids.some((id) => st.submissions[id]);
        // 한 단계 안에서 시각 제출과 수기 남은 시간이 섞이면 수기 팀이 항상 앞선다(U135).
        // 막지는 않고 [제출] 버튼 tip으로 경고만 한다 — 코드로 막으면 오조작 복구가 어려워진다.
        const anyRemaining = ids.some((id) => st.submissions[id]?.remainingSec != null);

        return el(
          'div',
          { class: `eventcard is-${st.status}` },
          el(
            'div',
            { class: 'eventcard__head' },
            el('span', { class: 'eventcard__name', text: st.name }),
            el(
              'div',
              { class: 'seg' },
              (['pending', 'live', 'done'] as EventStatus[]).map((v) =>
                el('button', {
                  class: `seg__btn${st.status === v ? ' is-on' : ''}`,
                  type: 'button',
                  text: STATUS_LABEL[v],
                  on: { click: () => ctx.dispatch({ type: 'p2/status', stageId: st.id, status: v }) },
                }),
              ),
            ),
          ),
          el(
            'div',
            { class: 'ranklist' },
            ids.map((id) => {
              const team = getTeam(s, id);
              const sub = st.submissions[id];
              const pts = st.confirmedAt ? recorded[id] : preview[id];
              const isRemaining = sub?.remainingSec != null;
              // 누르는 순간의 draft로 액션을 만든다 (렌더 스냅샷을 쓰면 D6 재발)
              const recordRemaining = (): void => {
                const action = remainingSubmitAction(st.id, id);
                if (!action) {
                  toast('남은 시간을 읽지 못했습니다 — 12:34 · 90 · 7분 형태로 적어 주세요', 'warn');
                  return;
                }
                ctx.dispatch(action);
                remainDraft[draftKey(st.id, id)] = '';
                toast(`${team.name} 남은 ${fmtRemaining(action.remainingSec)}을 기록했습니다`);
                ctx.refresh();
              };
              return el(
                'div',
                { class: 'rankrow', style: `--team:${team.color}` },
                el('span', { class: 'rankrow__team', text: team.name }),
                sub
                  ? el(
                      'span',
                      { class: `rankrow__sub${sub.correct ? ' is-ok' : ' is-ng'}` },
                      el('span', { text: sub.correct ? '✓ ' : '✗ ' }),
                      el('span', {
                        class: 'mono-label',
                        text: isRemaining ? `남은 ${fmtRemaining(sub.remainingSec!)}` : hhmmss(sub.at),
                      }),
                    )
                  : el('span', { class: 'rankrow__sub is-wait', text: '대기' }),
                /**
                 * 남은 시간 수기 입력 (U135). [제출](시각) 옆에 나란히 두고, 이미 기록이 있어도
                 * 그대로 남긴다 — 잘못 적은 시간을 [취소] 없이 덮어쓸 수 있어야 현장에서 빠르다.
                 */
                el('input', {
                  class: 'input rankrow__remain',
                  type: 'text',
                  value: remainDraft[draftKey(st.id, id)] ?? '',
                  placeholder: 'mm:ss',
                  data: {
                    fid: `p2-remain-${st.id}-${id}`,
                    tip: '남은 시간을 적고 [기록]을 누르면 그 값으로 순위가 매겨집니다. 많이 남은 팀이 앞 순위. 12:34 · 90(초) · 7분 형태를 읽습니다.',
                  },
                  attrs: { 'aria-label': `${team.name} 남은 시간` },
                  on: {
                    input: (ev) => {
                      remainDraft[draftKey(st.id, id)] = (ev.target as HTMLInputElement).value;
                    },
                    keydown: (ev) => {
                      // 전역 단축키(스페이스·화살표)가 입력 중에 새지 않게 막는다
                      ev.stopPropagation();
                      if (ev.key === 'Enter') recordRemaining();
                    },
                  },
                }),
                el('button', {
                  class: 'btn btn--tiny',
                  type: 'button',
                  text: '기록',
                  data: {
                    fid: `p2-remain-save-${st.id}-${id}`,
                    tip: '왼쪽 칸의 남은 시간으로 이 팀의 기록을 덮어씁니다 (정답 처리로 시작)',
                  },
                  on: { click: recordRemaining },
                }),
                el(
                  'div',
                  { class: 'rankrow__btns' },
                  !sub
                    ? el('button', {
                        class: 'btn btn--tiny btn--primary',
                        type: 'button',
                        text: '제출',
                        data: {
                          tip: anyRemaining
                            ? '누른 시각이 제출 시각으로 기록됩니다 — 주의: 이 단계에는 남은 시간 기록이 있습니다. 섞으면 남은 시간 팀이 항상 앞 순위가 되니 한 방식만 쓰세요.'
                            : '누른 시각이 제출 시각으로 기록됩니다',
                        },
                        on: {
                          click: () =>
                            ctx.dispatch({ type: 'p2/submit', stageId: st.id, teamId: id, at: Date.now() }),
                        },
                      })
                    : el(
                        'span',
                        { class: 'rankrow__btns' },
                        el('button', {
                          /**
                           * 라벨은 두 글자다 (U139). `오답 처리`/`정답 처리`는 이 줄에서
                           * 17px을 더 먹었고, 팀 이름이 그만큼 밀려 `YELL…`로 잘렸다.
                           * 줄바꿈으로 세로를 부풀리는 대신 라벨을 줄이고 뜻은 tip으로
                           * 내린다(Priority+ 관례). `aria-label`은 원래 문장을 그대로 들고
                           * 있어 스크린 리더에서는 줄어들지 않는다.
                           */
                          class: 'btn btn--tiny',
                          type: 'button',
                          text: sub.correct ? '오답' : '정답',
                          attrs: {
                            'aria-label': sub.correct
                              ? `${team.name} 오답 처리`
                              : `${team.name} 정답 처리`,
                          },
                          data: {
                            tip: sub.correct
                              ? '이 팀을 오답으로 바꿉니다 — 오답은 순위에서 제외되어 점수를 받지 않습니다'
                              : '이 팀을 정답으로 되돌립니다 — 다시 순위에 들어가 점수를 받습니다',
                          },
                          on: {
                            click: () =>
                              ctx.dispatch({
                                type: 'p2/correct',
                                stageId: st.id,
                                teamId: id,
                                correct: !sub.correct,
                              }),
                          },
                        }),
                        el('button', {
                          class: 'btn btn--tiny btn--danger',
                          type: 'button',
                          text: '취소',
                          data: { tip: '제출 기록 자체를 지웁니다' },
                          on: { click: () => ctx.dispatch({ type: 'p2/unsubmit', stageId: st.id, teamId: id }) },
                        }),
                      ),
                ),
                el('span', {
                  class: `rankrow__pts${pts ? '' : ' is-zero'}`,
                  text: pts ? `${fmtPoints(pts)}점` : '—',
                  data: {
                    tip: ranks[id]
                      ? `${isRemaining ? '남은 시간' : '제출 순서'} ${ranks[id]}위 → 점수표 ${table.join('/')} 기준 ${fmtPoints(pts)}점${st.confirmedAt ? ' (확정 반영됨)' : ' (확정 전 예상)'}`
                      : sub && !sub.correct
                        ? '오답 — 점수 없음'
                        : '미제출',
                  },
                  tabIndex: 0,
                }),
              );
            }),
          ),
          el(
            'div',
            { class: 'eventcard__actions' },
            el('button', {
              class: 'btn btn--primary',
              type: 'button',
              disabled: !anySub,
              text: st.confirmedAt ? '재확정 (역분개 후 재기록)' : '정답 확정 · 점수 반영',
              on: {
                click: () => {
                  const run = () => {
                    ctx.dispatch({ type: 'p2/confirm', stageId: st.id, now: Date.now() });
                    // 1부 확정과 같은 안전망 — 원장 탭으로 이동하지 않고 그 자리에서 역분개(U34).
                    toast(`${st.name} 점수를 확정했습니다`, 'ok', {
                      label: '되돌리기',
                      tip: '방금 확정한 이 단계 점수를 전부 역분개합니다 (기록은 남습니다).',
                      onClick: () => {
                        ctx.dispatch({ type: 'p2/revoke', stageId: st.id, now: Date.now() });
                        toast(`${st.name} 점수를 역분개했습니다`, 'warn');
                      },
                    });
                  };
                  if (st.confirmedAt) {
                    openModal({
                      title: '재확정',
                      body: `${st.name}의 기존 기록을 역분개하고 현재 제출 상태로 다시 기록합니다.`,
                      danger: true,
                      confirmLabel: '재확정',
                      onConfirm: run,
                    });
                  } else run();
                },
              },
            }),
            st.confirmedAt
              ? el('button', {
                  class: 'btn btn--danger',
                  type: 'button',
                  text: '확정 취소',
                  on: {
                    click: () =>
                      openModal({
                        title: '확정 취소',
                        body: `${st.name}에서 기록된 점수를 모두 역분개합니다.`,
                        danger: true,
                        confirmLabel: '역분개',
                        onConfirm: () => {
                          ctx.dispatch({ type: 'p2/revoke', stageId: st.id, now: Date.now() });
                          toast(`${st.name} 점수를 역분개했습니다`, 'warn');
                        },
                      }),
                  },
                })
              : null,
            /**
             * 대기화면만 송출한다 (U97, U112).
             *
             * U112 사용자 지시로 진행 중 제출 상태 바(옛 "이 단계 화면으로" · `mode:'board'`)
             * 송출 버튼을 없앴다 — 2부는 게임이 진행되는 동안 화면에 아무것도 공개하지 않고,
             * 결과는 시상(`award` 씬)에서만 드러난다. 제출/순위 입력(위 카드)은 그대로 여기서
             * 하되, 화면에는 이 대기 이미지만 나간다.
             */
            el('button', {
              class: 'btn btn--ghost',
              type: 'button',
              text: '대기화면',
              data: { tip: '이 단계의 대기 이미지 한 장을 띄웁니다 (진행자 설명 구간)' },
              on: {
                click: () =>
                  ctx.dispatch({
                    type: 'scene/set',
                    scene: 'submit',
                    opts: { submit: { stageId: st.id as P2StageId, mode: 'steady' } },
                  }),
              },
            }),
          ),
        );
      }),
    ),

    el('h3', { class: 'section__title', text: '보드 · 탈락 지정' }),
    el(
      'div',
      { class: 'suspectgrid' },
      s.settings.suspects.map((sp, i) => {
        const out = s.p2.eliminated.includes(sp.code);
        return el(
          'div',
          { class: `suspectcard${out ? ' is-out' : ''}` },
          el('span', { class: 'suspectcard__code mono-label', text: sp.code }),
          el('input', {
            class: 'input',
            type: 'text',
            value: sp.name,
            placeholder: '이름',
            data: { fid: `sus-name-${sp.code}` },
            on: {
              change: (e) => {
                const next = s.settings.suspects.map((x, j) =>
                  j === i ? { ...x, name: (e.target as HTMLInputElement).value } : x,
                );
                ctx.dispatch({ type: 'settings/patch', patch: { suspects: next } });
              },
            },
          }),
          el('input', {
            class: 'input',
            type: 'text',
            value: sp.sport,
            placeholder: '종목',
            data: { fid: `sus-sport-${sp.code}` },
            on: {
              change: (e) => {
                const next = s.settings.suspects.map((x, j) =>
                  j === i ? { ...x, sport: (e.target as HTMLInputElement).value } : x,
                );
                ctx.dispatch({ type: 'settings/patch', patch: { suspects: next } });
              },
            },
          }),
          el('button', {
            class: `btn btn--tiny${out ? ' btn--danger' : ''}`,
            type: 'button',
            text: out ? '탈락됨' : '생존',
            data: { tip: out ? '되살립니다' : '탈락 처리하면 출력 보드에 스탬프가 찍힙니다' },
            on: { click: () => ctx.dispatch({ type: 'p2/eliminate', code: sp.code, on: !out }) },
          }),
        );
      }),
    ),
  );
}
