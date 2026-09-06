import { el } from './dom';
import { renderBonusStrip } from './bonus-strip';
import { renderStandings } from './standings';
import { fmtPoints, pointsFromRanks } from '../scoring';
import { rankChoices } from '../p1-ranking';
import { createCurlingBracket } from '../p1-results';
import { activeTeamIds, getTeam, p1RoundRef, pointsByRef } from '../state';
import { victoryMusicOf, victoryOutputActions, victoryOutputBlock } from '../cue';
import { musicTrack } from '../music';
import { winnerVideoFile } from '../winner-video';
import { parseRoster } from '../scenes/roster';
import { openModal } from './modal';
import { toast } from './toast';
import type { CurlingMatchId, EventStatus, P1Event, P1EventId, TeamId } from '../types';
import type { Ctx } from './ctx';

export const meta = { id: 'p1', label: '1부 컨트롤' };

export function liveBadgeChoices(): { id: P1EventId | null; label: string }[] {
  return [
    { id: 'curling', label: '컬링' },
    { id: 'newspaper', label: '신문지 달리기' },
    { id: 'sticky', label: '끈끈이 낚시' },
    { id: 'sync', label: '몸으로 말해요' },
    { id: null, label: '배지 숨김' },
  ];
}

export function p1ValueInputSpec(
  eventId: P1EventId,
): { participation: string; label: string; suffix: string } | null {
  if (eventId === 'sticky') {
    // U64 — 끈끈이 낚시는 1v1·2v2 둘 다 가능하다. 명단 탭(`rosterParticipation`)과 같은 문구를
    // 써야 운영자가 두 화면에서 서로 다른 인원 규칙을 읽지 않는다.
    return { participation: '팀당 1~2명 출전', label: '획득 점수', suffix: '점' };
  }
  if (eventId === 'sync') {
    return { participation: '팀 전체 참여', label: '성공 라운드 수', suffix: '라운드' };
  }
  if (eventId === 'newspaper') {
    return { participation: '팀당 2명 출전', label: '선수별 기록', suffix: '초' };
  }
  return null;
}

/**
 * 신문지 달리기 주자 칸 라벨 (U38).
 *
 * `선수 1`/`선수 2`는 현장에서 "누구 기록을 어디에 넣는지"가 안 보인다. 출전 명단에
 * 이름이 들어오면 **즉시** 그 이름으로 바꾸되 순번은 남긴다(`1 · 샘플 참가자 19`) — 주자 순서가
 * 기록의 의미를 정하므로 이름만 남기면 순서를 잃는다.
 *
 * 이름 해석은 출력 화면과 **같은 `parseRoster`**를 쓴다. 명단 탭의 `rosterNames`는 중복을
 * 제거하고 `·`도 구분자로 보는데, 그러면 동명이인이 있을 때 번호가 한 칸씩 밀려
 * 화면에 나가는 명단과 여기 라벨이 서로 다른 사람을 가리키게 된다.
 */
export interface RunnerLabel {
  /** 칸에 적는 짧은 라벨. 길면 CSS가 ellipsis 처리한다 */
  text: string;
  /** hover·focus 상세 — 전체 이름과 이 라벨의 출처 */
  tip: string;
  /** 스크린리더·aria 용 전체 문장 */
  aria: string;
  /** 명단에서 이름을 찾았는가 (기본 라벨이면 false) */
  named: boolean;
}

export function newspaperRunnerLabel(
  rosterText: string | undefined,
  runner: number,
  teamName: string,
): RunnerLabel {
  const order = runner + 1;
  const name = parseRoster(rosterText)[runner];
  if (!name) {
    return {
      text: `선수 ${order}`,
      tip: `${teamName} ${order}번 주자. [출전 명단] 탭에 이름을 넣으면 여기 라벨이 바로 그 이름으로 바뀝니다.`,
      aria: `${teamName} 선수 ${order} 기록(초)`,
      named: false,
    };
  }
  return {
    text: `${order} · ${name}`,
    tip: `${teamName} ${order}번 주자 ${name} — [출전 명단] 탭에서 입력한 이름입니다. 기록은 주자 순서대로 저장됩니다.`,
    aria: `${teamName} ${order}번 주자 ${name} 기록(초)`,
    named: true,
  };
}

/**
 * 승리 보드(U71)에 프리필할 **현재 1위** — 지금 이 종목 점수가 가장 높은 팀 하나.
 *
 * 동점이면 `null`이다. 두 팀이 같은 점수인데 한쪽을 골라 추천하면 화면이 조용히 거짓말을
 * 한다 — 그 경우 운영자가 직접 고른다. 0점(미입력)뿐이어도 추천하지 않는다.
 */
export function victoryLeader(points: Partial<Record<TeamId, number>>, ids: TeamId[]): TeamId | null {
  let best: TeamId | null = null;
  let bestPts = 0;
  let tied = false;
  for (const id of ids) {
    const pts = points[id] ?? 0;
    if (pts <= 0) continue;
    if (pts > bestPts) {
      best = id;
      bestPts = pts;
      tied = false;
    } else if (pts === bestPts) {
      tied = true;
    }
  }
  return tied ? null : best;
}

export function p1EventInputLabel(eventId: P1EventId): string {
  const labels: Record<P1EventId, string> = {
    curling: '대진·승패 입력',
    newspaper: '기록·순위 입력',
    sticky: '획득 점수 입력',
    sync: '성공 라운드 입력',
  };
  return labels[eventId];
}

const STATUS_LABEL: Record<EventStatus, string> = { pending: '대기', live: '진행', done: '완료' };

/** 'HH:MM:SS'. ko-KR 기본 포맷('0시 40분 7초')은 폭이 들쭉날쭉해 카드 안에서 줄바꿈을 만든다. */
function hhmmss(ts: number | string): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 중계 씬 오버레이 조작 — 스코어바·타이머 토글과 좌상 종목 배지.
 * 대결 팀 보더는 씬 런처(`launcher.ts`)로 옮겼다 (U14): 카메라 전환과 같은 시선 안에서 고른다.
 */
function overlayControls(ctx: Ctx): HTMLElement {
  const o = ctx.state.sceneOpts.liveOverlay;

  const toggle = (on: boolean, label: string, tip: string, onClick: () => void) =>
    el('button', {
      class: `seg__btn${on ? ' is-on' : ''}`,
      type: 'button',
      // 토글은 색만이 아니라 아이콘 + 텍스트로도 상태를 알린다
      text: `${on ? '☑' : '☐'} ${label} ${on ? '켬' : '끔'}`,
      attrs: { 'aria-pressed': on ? 'true' : 'false' },
      data: { tip },
      on: { click: onClick },
    });

  return el(
    'div',
    { class: 'overlaybar' },
    el('span', { class: 'field__label', text: '중계 오버레이' }),
    el(
      'div',
      { class: 'seg' },
      toggle(o.scorebar, '스코어바', '중계 화면 하단의 팀별 누적 점수 바', () =>
        ctx.dispatch({ type: 'sceneOpts/patch', patch: { liveOverlay: { scorebar: !o.scorebar } } }),
      ),
      toggle(o.timer, '타이머', '중계 화면 우상단 타이머 배지', () =>
        ctx.dispatch({ type: 'sceneOpts/patch', patch: { liveOverlay: { timer: !o.timer } } }),
      ),
    ),
    el(
      'div',
      { class: 'badge-picker', attrs: { role: 'group', 'aria-label': '경기 중계 종목 배지' } },
      el('span', { class: 'field__label', text: '좌상단 종목' }),
      liveBadgeChoices().map((choice) => {
        const selected = o.badge === choice.id;
        return el('button', {
          class: `seg__btn${selected ? ' is-on' : ''}`,
          type: 'button',
          text: choice.label,
          attrs: { 'aria-pressed': selected ? 'true' : 'false' },
          data: { fid: `live-badge-${choice.id ?? 'none'}` },
          on: {
            click: () =>
              ctx.dispatch({ type: 'sceneOpts/patch', patch: { liveOverlay: { badge: choice.id } } }),
          },
        });
      }),
    ),
  );
}

const CURLING_MATCH_LABEL: Record<CurlingMatchId, string> = {
  semi1: '준결승 1',
  semi2: '준결승 2',
  final: '결승',
  bronze: '3·4위전',
};

function curlingBracketControls(ctx: Ctx, event: P1Event): HTMLElement {
  const bracket = event.curling ?? createCurlingBracket();
  const ids = activeTeamIds(ctx.state);

  const matchRow = (matchId: CurlingMatchId) => {
    const match = bracket[matchId];
    const editable = matchId === 'semi1' || matchId === 'semi2';
    const teamControl = (side: 0 | 1) =>
      editable
        ? el(
            'select',
            {
              class: 'input input--select',
              attrs: { 'aria-label': `${CURLING_MATCH_LABEL[matchId]} ${side + 1}번 팀` },
              on: {
                change: (inputEvent) => {
                  const value = (inputEvent.target as HTMLSelectElement).value as TeamId | '';
                  const teams: [TeamId | null, TeamId | null] = [...match.teams];
                  teams[side] = value || null;
                  ctx.dispatch({ type: 'p1/curlingPair', matchId, teams });
                },
              },
            },
            el('option', {
              value: '',
              text: '팀 선택',
              attrs: { selected: match.teams[side] ? undefined : 'selected' },
            }),
            ids.map((id) =>
              el('option', {
                value: id,
                text: getTeam(ctx.state, id).name,
                attrs: { selected: match.teams[side] === id ? 'selected' : undefined },
              }),
            ),
          )
        : el('span', {
            class: 'chip',
            text: match.teams[side] ? getTeam(ctx.state, match.teams[side]!).name : '준결승 결과 대기',
          });

    return el(
      'div',
      { class: 'curling-match' },
      el('span', { class: 'field__label', text: CURLING_MATCH_LABEL[matchId] }),
      teamControl(0),
      el('span', { class: 'mono-label', text: 'VS' }),
      teamControl(1),
      el(
        'div',
        { class: 'seg', attrs: { role: 'group', 'aria-label': `${CURLING_MATCH_LABEL[matchId]} 승자` } },
        match.teams.map((teamId) =>
          teamId
            ? el('button', {
                class: `seg__btn${match.winner === teamId ? ' is-on' : ''}`,
                type: 'button',
                text: `${match.winner === teamId ? '✓ ' : ''}${getTeam(ctx.state, teamId).name} 승`,
                attrs: { 'aria-pressed': match.winner === teamId ? 'true' : 'false' },
                on: {
                  click: () =>
                    ctx.dispatch({
                      type: 'p1/curlingWinner',
                      matchId,
                      winner: match.winner === teamId ? null : teamId,
                    }),
                },
              })
            : null,
        ),
      ),
    );
  };

  return el(
    'div',
    { class: 'curling-bracket' },
    el('p', {
      class: 'tabpane__hint',
      text: '팀당 2명 출전 · 준결승 승자를 고르면 결승과 3·4위전 대진이 자동으로 채워집니다.',
    }),
    matchRow('semi1'),
    matchRow('semi2'),
    matchRow('final'),
    matchRow('bronze'),
  );
}

function valueInputControls(ctx: Ctx, event: P1Event): HTMLElement | null {
  const spec = p1ValueInputSpec(event.id);
  if (!spec || (event.id !== 'sticky' && event.id !== 'sync')) return null;
  const values = event.values ?? { t1: null, t2: null, t3: null, t4: null, t5: null, t6: null };
  return el(
    'div',
    { class: 'p1-value-inputs' },
    el('p', { class: 'tabpane__hint', text: `${spec.participation} · ${spec.label}가 큰 팀부터 자동 순위` }),
    activeTeamIds(ctx.state).map((id) => {
      const team = getTeam(ctx.state, id);
      return el(
        'label',
        { class: 'p1-value-input' },
        el('span', { class: 'field__label', text: team.name }),
        el('input', {
          class: 'input mono-input',
          type: 'number',
          min: '0',
          step: '1',
          value: values[id] ?? '',
          attrs: { 'aria-label': `${team.name} ${spec.label}` },
          on: {
            change: (inputEvent) => {
              const raw = (inputEvent.target as HTMLInputElement).value;
              const value = raw === '' ? null : Math.max(0, Number(raw));
              ctx.dispatch({ type: 'p1/value', eventId: event.id as 'sticky' | 'sync', teamId: id, value });
            },
          },
        }),
        el('span', { class: 'mono-label', text: spec.suffix }),
      );
    }),
  );
}

function newspaperTimeControls(ctx: Ctx, event: P1Event): HTMLElement | null {
  if (event.id !== 'newspaper') return null;
  const spec = p1ValueInputSpec('newspaper')!;
  const times = event.newspaperTimes ?? {
    t1: [null, null],
    t2: [null, null],
    t3: [null, null],
    t4: [null, null],
    t5: [null, null],
    t6: [null, null],
  };
  return el(
    'div',
    { class: 'p1-value-inputs is-newspaper' },
    el('p', { class: 'tabpane__hint', text: `${spec.participation} · 선수별 기록은 보존하고 팀 순위는 아래에서 선택` }),
    activeTeamIds(ctx.state).map((id) => {
      const team = getTeam(ctx.state, id);
      return el(
        'div',
        { class: 'p1-newspaper-input' },
        el('span', { class: 'field__label', text: team.name }),
        ([0, 1] as const).map((runner) => {
          const runnerLabel = newspaperRunnerLabel(event.roster[id], runner, team.name);
          return el(
            'label',
            { class: 'p1-runner-time' },
            el('span', {
              class: `mono-label p1-runner-time__who${runnerLabel.named ? ' is-named' : ''}`,
              text: runnerLabel.text,
              data: { tip: runnerLabel.tip },
              tabIndex: 0,
            }),
            el('input', {
              class: 'input mono-input',
              type: 'number',
              min: '0',
              step: '0.01',
              value: times[id][runner] ?? '',
              attrs: { 'aria-label': runnerLabel.aria },
              on: {
                change: (inputEvent) => {
                  const raw = (inputEvent.target as HTMLInputElement).value;
                  const value = raw === '' ? null : Math.max(0, Number(raw));
                  ctx.dispatch({ type: 'p1/newspaperTime', teamId: id, runner, value });
                },
              },
            }),
            el('span', { class: 'mono-label', text: spec.suffix }),
          );
        }),
      );
    }),
  );
}

/**
 * 승리 팀 **선택**과 **송출**을 나눈 행 (U71 → U109).
 *
 * ## 왜 나눴나 (U109, 2026-09-05 04:55 사용자 지시)
 * "승리보드 송출은 송출할지 선택만 할지 고를 수 있게 해줘." U71에서는 팀 버튼 하나가
 * 고르기와 송출을 함께 했다 — 경기 직후 몇 초를 아끼려는 선택이었지만, **미리 골라 두는 것이
 * 불가능**했다. 순위를 확정하며 승리 팀을 정해 두고 발표 타이밍은 MC에 맞추고 싶은데,
 * 누르는 순간 화면이 나가 버리니 큐 [다음]이 올 때까지 아예 손을 못 댔다.
 *
 * 이제 팀 버튼은 **기록만** 한다(출력 화면 변화 없음). 내보내는 것은 행 끝의 `[송출]` 하나다.
 * 급할 때를 위해 **Shift+클릭 = 선택 + 즉시 송출**을 남겨 두었다(U71의 한 번 조작).
 *
 * ## 송출은 큐시트와 **같은 빌더**를 쓴다
 * `victoryOutputActions`(cue.ts)가 정본이다 — 승리 영상이 있으면 알파 오버레이(U100),
 * 없으면 승리 보드 카드. U109 이전 이 버튼은 `scene/set`을 직접 냈고, 그래서 **탭에서 누르면
 * 승리 영상이 영영 안 나오고 카드만 나갔다**(큐시트로 눌러야만 영상이 나오는 어긋남).
 *
 * ## 선택은 종목별이 아니라 하나다
 * `sceneOpts.game.winner`는 "승리 보드에 띄울 팀" **한 칸**이지 종목별 원장이 아니다(U71).
 * 그래서 고른 팀은 네 종목 행에 똑같이 `● 선택됨`으로 보인다 — 발표할 종목은 **누른 행**이
 * 정한다(`[송출]`이 그 행의 `event.id`를 싣는다). 여기서 종목별 저장소를 새로 만들면
 * `game.winner`와 주인이 둘이 되므로 만들지 않았다.
 *
 * 추천(★)은 지금 이 종목의 1위다. 동점이면 아무것도 추천하지 않는다(`victoryLeader`).
 */
function victoryControls(
  ctx: Ctx,
  event: P1Event,
  points: Partial<Record<TeamId, number>>,
): HTMLElement {
  const s = ctx.state;
  const ids = activeTeamIds(s);
  const leader = victoryLeader(points, ids);
  const g = s.sceneOpts.game;
  const blocked = victoryOutputBlock(g.winner, s.assets);
  /**
   * 고른 팀의 승리 발표를 지금 내보낸다 — 큐시트 `victory-<종목>`과 **같은 배열**.
   * 영상 + 승리 음악(U110)이 함께 나가고, 곡은 [설정] 탭이 정한다.
   */
  const send = (winner: TeamId | null): void => {
    ctx.dispatch(victoryOutputActions(winner, s.assets, Date.now(), victoryMusicOf(s)));
  };
  /**
   * 지금 이 팀의 승리 영상이 오버레이로 돌고 있는가 (U110).
   *
   * U109까지는 `game.mode === 'victory'`(카드 씬)로 판정했는데, U110에서 그 씬이 폐기돼
   * 판정 근거 자체가 사라졌다. 이제 화면의 주인은 `#overlay-video`라 **거기 실린 파일**을
   * 본다 — 종목이 아니라 팀이 파일을 정하므로(`winner_<색>.webm`) 같은 팀 줄 넷이 함께
   * 켜지는데, 그것이 사실이다(어느 종목의 발표인지는 파일에 없다).
   */
  const onAirAssetId = s.sceneOpts.overlayVideo.active ? s.sceneOpts.overlayVideo.assetId : null;

  return el(
    'div',
    { class: 'overlaybar', attrs: { role: 'group', 'aria-label': `${event.name} 승리 팀` } },
    el('span', {
      class: 'field__label',
      text: '승리 팀',
      data: {
        tip: `팀 버튼은 **선택만** 합니다 — 화면은 그대로입니다. 내보내려면 오른쪽 [송출]을 누르세요(급하면 팀 버튼 Shift+클릭 = 선택 + 즉시 송출). 큐시트 '${event.name} · 승리 팀'도 여기서 고른 팀을 씁니다.`,
      },
      tabIndex: 0,
    }),
    el(
      'div',
      { class: 'seg' },
      ids.map((id) => {
        const team = getTeam(s, id);
        const picked = g.winner === id;
        // 지금 그 팀의 승리 영상이 나가고 있는가 (선택됨과 다른 상태다)
        const winnerFile = winnerVideoFile(id);
        const onAir = winnerFile !== null && onAirAssetId === `media:${winnerFile}`;
        const suggested = leader === id;
        return el('button', {
          class: `seg__btn${picked ? ' is-on' : ''}`,
          type: 'button',
          // 색만이 아니라 텍스트로도 상태를 알린다 — ✓ 송출 중 / ● 선택됨 / ★ 추천(현재 1위)
          text: `${onAir ? '✓ ' : picked ? '● ' : suggested ? '★ ' : ''}${team.name}`,
          attrs: { 'aria-pressed': picked ? 'true' : 'false' },
          data: {
            fid: `victory-${event.id}-${id}`,
            tip: picked
              ? `${team.name} 선택됨${onAir ? ' · 지금 송출 중' : ''}. 다시 누르면 선택을 해제합니다. 내보내려면 [송출], Shift+클릭이면 바로 송출합니다.`
              : suggested
                ? `${team.name} — 지금 ${event.name} 1위입니다. 누르면 **선택만** 하고 화면은 그대로입니다(Shift+클릭 = 즉시 송출).`
                : `${team.name}을 승리 팀으로 **선택만** 합니다 — 화면은 그대로입니다(Shift+클릭 = 즉시 송출).`,
          },
          on: {
            click: (ev) => {
              // 이미 고른 팀을 다시 누르면 해제 — 잘못 누른 것을 되돌릴 자리가 있어야 한다
              const next = picked && !ev.shiftKey ? null : id;
              ctx.dispatch({ type: 'sceneOpts/patch', patch: { game: { winner: next } } });
              // Shift는 U71의 한 번 조작 — 고른 뒤 같은 손짓으로 내보낸다
              if (ev.shiftKey) send(id);
            },
          },
        });
      }),
    ),
    el('button', {
      class: 'btn btn--tiny',
      type: 'button',
      text: '송출',
      disabled: blocked !== null,
      data: {
        fid: `victory-send-${event.id}`,
        tip: blocked
          ? g.winner
            ? `${blocked}. 그 파일을 media 폴더에 넣고 [영상·에셋] 탭에서 다시 불러오세요.`
            : `${blocked} — 왼쪽에서 팀을 누르면 이 버튼이 열립니다.`
          : `${getTeam(s, g.winner!).name}의 승리 영상이 전환 없이 화면 위로 올라오고, ${
              victoryMusicOf(s).trackId
                ? `승리 음악(${musicTrack(victoryMusicOf(s).trackId)?.label ?? '지정 곡'})이 함께 나갑니다`
                : '승리 음악은 [설정] 탭에서 아직 고르지 않아 영상만 나갑니다'
            }. 큐시트 '${event.name} · 승리 팀'과 같은 동작입니다.`,
      },
      on: { click: () => send(g.winner) },
    }),
  );
}

export function render(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const ids = activeTeamIds(s);
  // 점수표는 팀 수만큼만 보여 준다 (6칸짜리 표에 4팀이면 뒤 2칸은 의미가 없다)
  const table = s.settings.scoreTable.p1.slice(0, ids.length);

  return el(
    'div',
    { class: 'tabpane tabpane--p1' },
    overlayControls(ctx),
    renderStandings(ctx),
    renderBonusStrip(ctx, 'p1'),
    el('p', {
      class: 'tabpane__hint',
      text: `종목별 지정 입력 방식으로 결과를 넣고 [확정]을 누르면 원장에 기록됩니다. 점수표 ${table.join(' / ')}.`,
    }),
    el(
      'div',
      { class: 'eventgrid' },
      s.p1.events.map((ev) => {
        const preview = pointsFromRanks(ev.ranks, table, ids);
        const recorded = pointsByRef(s, p1RoundRef(ev.id, ev.round));
        const anyRank = ids.some((id) => ev.ranks[id]);

        return el(
          'div',
          { class: `eventcard is-${ev.status}` },
          el(
            'div',
            { class: 'eventcard__head' },
            el(
              'div',
              { class: 'eventcard__title' },
              el('span', { class: 'eventcard__name', text: ev.name }),
              el('span', { class: 'eventcard__input-kind', text: p1EventInputLabel(ev.id) }),
              el('span', { class: 'eventcard__round mono-label', text: `${ev.round}회차` }),
            ),
            el(
              'div',
              { class: 'seg' },
              (['pending', 'live', 'done'] as EventStatus[]).map((st) =>
                el('button', {
                  class: `seg__btn${ev.status === st ? ' is-on' : ''}`,
                  type: 'button',
                  text: STATUS_LABEL[st],
                  data: { tip: `${ev.name} 상태를 '${STATUS_LABEL[st]}'로` },
                  on: { click: () => ctx.dispatch({ type: 'p1/status', eventId: ev.id, status: st }) },
                }),
              ),
            ),
          ),
          ev.id === 'curling'
            ? curlingBracketControls(ctx, ev)
            : ev.id === 'newspaper'
              ? newspaperTimeControls(ctx, ev)
              : valueInputControls(ctx, ev),
          el(
            'div',
            { class: 'ranklist' },
            ids.map((id) => {
              const team = getTeam(s, id);
              const pts = ev.confirmedAt ? recorded[id] : preview[id];
              return el(
                'div',
                { class: 'rankrow', style: `--team:${team.color}` },
                el('span', { class: 'rankrow__team', text: team.name }),
                el(
                  'div',
                  {
                    class: 'rankpick',
                    attrs: { role: 'group', 'aria-label': `${team.name} 순위 선택` },
                  },
                  rankChoices(ids.length, ev.ranks[id]).map((choice) =>
                    el('button', {
                      class: `rankpick__btn${choice.pressed ? ' is-on' : ''}${choice.rank === null ? ' is-clear' : ''}`,
                      type: 'button',
                      disabled: ev.id === 'curling' || ev.id === 'sticky' || ev.id === 'sync',
                      text: choice.label,
                      attrs: { 'aria-pressed': choice.pressed ? 'true' : 'false' },
                      data: { fid: `rank-${ev.id}-${id}-${choice.rank ?? 'none'}` },
                      on: {
                        click: () =>
                          ctx.dispatch({
                            type: 'p1/rank',
                            eventId: ev.id,
                            teamId: id,
                            rank: choice.rank,
                          }),
                      },
                    }),
                  ),
                ),
                el('span', {
                  class: `rankrow__pts${pts ? '' : ' is-zero'}`,
                  text: pts ? `${fmtPoints(pts)}점` : '—',
                  data: {
                    tip: ev.ranks[id]
                      ? `${ev.name} ${ev.ranks[id]}위 → 점수표 ${table.join('/')} 기준 ${fmtPoints(pts)}점${ev.confirmedAt ? ' (확정 반영됨)' : ' (확정 전 예상)'}`
                      : '순위 미입력',
                  },
                  tabIndex: 0,
                }),
              );
            }),
          ),
          victoryControls(ctx, ev, ev.confirmedAt ? recorded : preview),
          el(
            'div',
            { class: 'eventcard__actions' },
            el('button', {
              // 강조(솔리드)는 아직 확정 전일 때만. 재확정은 교정 동작이라 조용한 버튼으로 둔다.
              class: `btn${ev.confirmedAt ? '' : ' btn--primary'}`,
              type: 'button',
              disabled: !anyRank,
              text: ev.confirmedAt ? '재확정 (역분개 후 재기록)' : '확정',
              data: {
                tip: ev.confirmedAt
                  ? '기존 기록을 역분개하고 현재 순위로 다시 기록합니다.'
                  : '현재 순위로 원장에 점수를 기록합니다.',
              },
              on: {
                click: () => {
                  const run = () => {
                    // 확정 **당시** 회차를 스냅샷해 둔다 — 그 사이 [다음 회차 +]를 누르면
                    // 지금 회차를 지우게 되어 엉뚱한 점수가 사라진다.
                    const revokeRound = ev.round;
                    ctx.dispatch({ type: 'p1/confirm', eventId: ev.id, now: Date.now() });
                    // 확정은 잘못 누르기 가장 쉬운 버튼이다. 원장 탭까지 가지 않고
                    // 그 자리에서 되돌릴 수 있게 토스트에 역분개 액션을 붙인다(U34).
                    toast(`${ev.name} 점수를 확정했습니다`, 'ok', {
                      label: '되돌리기',
                      tip: `방금 확정한 ${ev.name} ${revokeRound}회차 점수를 전부 역분개합니다 (기록은 남습니다).`,
                      onClick: () =>
                        openModal({
                          title: '되돌리기',
                          body: `${ev.name} ${revokeRound}회차에서 기록된 점수를 모두 역분개합니다.`,
                          danger: true,
                          confirmLabel: '역분개',
                          onConfirm: () => {
                            ctx.dispatch({
                              type: 'p1/revoke',
                              eventId: ev.id,
                              round: revokeRound,
                              now: Date.now(),
                            });
                            toast(`${ev.name} ${revokeRound}회차 점수를 역분개했습니다`, 'warn');
                          },
                        }),
                    });
                  };
                  if (ev.confirmedAt) {
                    openModal({
                      title: '재확정',
                      body: `${ev.name}의 기존 기록을 역분개하고 현재 순위로 다시 기록합니다.`,
                      danger: true,
                      confirmLabel: '재확정',
                      onConfirm: run,
                    });
                  } else run();
                },
              },
            }),
            ev.confirmedAt
              ? el('button', {
                  class: 'btn btn--danger',
                  type: 'button',
                  text: '확정 취소',
                  data: { tip: '이 종목 점수를 전부 역분개합니다 (기록은 남습니다).' },
                  on: {
                    click: () =>
                      openModal({
                        title: '확정 취소',
                        body: `${ev.name}에서 기록된 점수를 모두 역분개합니다.`,
                        danger: true,
                        confirmLabel: '역분개',
                        onConfirm: () => {
                          ctx.dispatch({ type: 'p1/revoke', eventId: ev.id, now: Date.now() });
                          toast(`${ev.name} 점수를 역분개했습니다`, 'warn');
                        },
                      }),
                  },
                })
              : null,
            ev.confirmedAt
              ? el('button', {
                  class: 'btn btn--primary',
                  type: 'button',
                  text: '다음 회차 +',
                  data: { tip: '현재 회차 점수는 유지하고 새 순위표를 엽니다.' },
                  on: {
                    click: () => {
                      ctx.dispatch({ type: 'p1/nextRound', eventId: ev.id });
                      toast(`${ev.name} ${ev.round + 1}회차를 열었습니다`);
                    },
                  },
                })
              : null,
            el('button', {
              class: 'btn btn--ghost',
              type: 'button',
              text: '이 종목 중계로',
              data: { tip: '중계 씬으로 전환하고 좌상 배지를 이 종목으로 맞춥니다.' },
              on: {
                click: () =>
                  ctx.dispatch({
                    type: 'scene/set',
                    scene: 'live',
                    opts: { liveOverlay: { badge: ev.id } },
                  }),
              },
            }),
            ev.confirmedAt
              ? el('span', {
                  class: 'eventcard__stamp',
                  text: `${ev.round}회차 확정 ${hhmmss(ev.confirmedAt)}`,
                })
              : null,
          ),
        );
      }),
    ),
  );
}
