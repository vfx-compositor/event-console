import {
  cueActions,
  cueWithVideos,
  matchCueBlock,
  nextCueIndex,
  prevCueIndex,
  resolveCurrentCueIndex,
  assetMusicOf,
  victoryCueNotice,
  victoryMusicOf,
  type CueItem,
  type CueRuntime,
} from '../cue';
import { needsMusicDuck } from '../music-duck';
import { pendingScene } from '../pending-scene';
import {
  MODE_LABEL,
  cueTransitionChoices,
  cueTransitionOf,
  hasCueTransitions,
  lockedCueTransitionTip,
  type CueTransitions,
} from '../cue-transitions';
import { el, frag } from './dom';
import { toast } from './toast';
import type { Ctx } from './ctx';
import type { Phase, SceneTransitionMode } from '../types';

/** 큐 실행에 필요한 런타임 값 — 매치 영상은 실행 시점의 대결 조합으로 해석된다 (U36) */
function cueRuntime(ctx: Ctx, items?: CueItem[], index?: number): CueRuntime {
  return {
    versus: ctx.state.sceneOpts.liveOverlay.versus,
    assets: ctx.state.assets,
    /**
     * **지금 보이는 씬이 아니라 향하고 있는 씬**이다 (U125, `pending-scene.ts`).
     *
     * 매치 큐의 씬 판정(`matchCueOnRightScene`)이 이 값을 읽는다. 전환이 아직 컷 전이면
     * `state.scene`은 화면이 이미 떠난 씬이라, 그 0.3~1초 사이에 매치 큐를 누르면 "엉뚱한
     * 씬"으로 판정돼 **영상이 안 나가고 커서만 한 칸 물러난다.** 그러면 다음 [다음 →]이
     * 매치 영상을 한 번 더 재생한다(2026-09-05 U125 신고 "다시 매치 영상이 한 번 더 재생됨").
     * 전환이 없으면 두 값이 같으므로 평상시 판정은 그대로다.
     */
    scene: pendingScene(ctx.state),
    gameEventId: ctx.state.sceneOpts.game.eventId,
    // 승리 큐가 어느 팀 영상을 얹을지 (U100) — 값의 주인은 [1부 컨트롤] 탭이다 (U71).
    winner: ctx.state.sceneOpts.game.winner,
    // 그 영상과 함께 걸 승리 음악 (U110) — 곡은 [설정] 탭이 정하고 큐는 읽어 실을 뿐이다.
    victoryMusic: victoryMusicOf(ctx.state),
    // 이 항목의 full 영상이 데려오는 배경 곡 (U124) — 곡은 [영상·에셋] 카드(또는 대본 표)가
    // 정하고 큐는 읽어 실을 뿐이다. 항목을 모르는 호출(렌더용 `cueRuntime(ctx)`)에서는
    // 해석할 영상이 없으므로 `undefined`이고, 그 자리는 실행 경로가 아니다.
    assetMusic:
      items && index !== undefined ? assetMusicOf(ctx.state, items[index]?.assetId) : undefined,
    // 매치 큐가 씬만 옮기고 물러설 때 커서를 둘 자리 (U42 리뷰)
    prevCueId: items && index !== undefined ? (items[index - 1]?.id ?? null) : null,
  };
}

/** 등록된 영상까지 반영한 현재 큐 */
export function cueOf(ctx: Ctx): CueItem[] {
  return cueWithVideos(ctx.state.assets);
}

/**
 * 큐 항목 하나를 실행한다.
 *
 * `advanceOnBlock`은 **앞으로 가는 조작에서만** 켠다. 조합이 없는 매치 영상에서 멈춰 서면
 * 방향키 진행이 종목마다 막혀 뒤로도 못 가는 사고가 났다 — 재생할 것이 없으면 조용히 지나가는
 * 편이 진행을 막는 것보다 안전하다. 뒤로 가기와 직접 클릭은 그냥 통과시킨다(영상만 안 나온다).
 */
/**
 * @param sequential 대본을 따라 가는 조작인가 (`→`/`←`, [다음]/[이전]).
 *   큐 경계 지정(U42)은 **여기서만** 적용된다. 큐를 직접 클릭하거나 런처에서 점프하는 것은
 *   대본을 벗어난 조작이고, 그때 대본상의 전환이 걸리면 예상하지 못한 연출이 방송에 나간다.
 */
export function goCue(ctx: Ctx, index: number, advanceOnBlock = false, sequential = false): void {
  const items = cueOf(ctx);
  const i = Math.max(0, Math.min(items.length - 1, index));
  const item = items[i];
  if (item.locked && !ctx.state.p2.unlocked) return;
  const runtime = cueRuntime(ctx, items, i);
  const blocked = matchCueBlock(item, runtime);
  if (blocked && advanceOnBlock) {
    const next = nextCueIndex(items, i, ctx.state.p2.unlocked);
    toast(`매치 영상 건너뜀 — ${blocked}`, 'warn');
    if (next !== i) {
      goCue(ctx, next, true, sequential);
      return;
    }
  } else if (blocked) {
    toast(blocked, 'warn');
  }
  /**
   * 승리 큐는 **막지 않는다** (U100 · U110). 승리 발표는 대본상 반드시 지나가는 자리라
   * 진행을 세우면 뒤로도 못 가는 사고가 난다 — 그래서 `nextCueIndex`로 건너뛰는 위 경로가
   * 아니라 여기서 사유만 알리고 그대로 실행한다.
   *
   * U110에서 승리 보드 카드가 폐기돼 이 토스트의 무게가 달라졌다: 예전에는 "영상 대신 카드가
   * 나갔다"였지만 이제는 **아무것도 안 나갔다**는 뜻이다. 그래서 문장이 빠진 파일 이름을
   * 그대로 말한다(`victoryOutputBlock`).
   */
  const victoryNotice = victoryCueNotice(item, runtime);
  if (victoryNotice) toast(victoryNotice, 'warn');
  const boundaryMode = sequential ? cueTransitionOf(ctx.state.cueTransitions, item.id) : null;
  const run = (): void => {
    // 막힌 항목도 인덱스·진행단계는 넘긴다 — `cueActions`가 오버레이만 빼고 돌려준다.
    ctx.dispatch(cueActions(item, i, Date.now(), runtime, boundaryMode));
  };

  /**
   * full 영상으로 들어가는데 음악이 울리고 있으면, 음악을 먼저 내리고 **다 내려간 뒤에**
   * 큐를 낸다 (U44 · U117). 화면이 넘어가는 순간에는 이미 조용해야 한다 — 동시에 내보내면
   * 페이드가 도는 2초 동안 BGM이 영상 소리(또는 MC의 설명) 위에 겹쳐 방송에 나간다.
   *
   * **파일에 오디오 트랙이 없어도 내린다** (U117) — 소리 없는 설명 영상일수록 BGM이 MC의
   * 목소리와 정면으로 부딪힌다. 근거는 `music-duck.ts` 머리말.
   *
   * **오버레이(매치·승리·반전)는 여기 걸리지 않는다** (U113) — 그쪽은 BGM 위에 겹쳐 나는 것이
   * 사용자 결정이라 실행 시점 파일 해석(`cueOverlayAssetId`)도 넘기지 않는다.
   */
  if (
    needsMusicDuck({
      item,
      assets: ctx.state.assets,
      musicPlaying: ctx.state.music.playing,
      ducked: ctx.state.music.ducked,
      autoDuck: ctx.state.settings.autoDuckOnVideoAudio,
    })
  ) {
    ctx.dispatch({ type: 'music/duck' });
    ctx.deferCue(i, run);
    return;
  }
  // 다른 큐로 넘어가면 기다리던 예약은 뜻을 잃는다 — 조용히 버린다(음악은 되돌린다).
  if (ctx.duckedCue) ctx.cancelDeferredCue();
  run();
}

export function goNext(ctx: Ctx): void {
  const items = cueOf(ctx);
  const current = resolveCurrentCueIndex(items, ctx.state.cueId, ctx.state.cueIndex);
  goCue(ctx, nextCueIndex(items, current, ctx.state.p2.unlocked), true, true);
}

export function goPrev(ctx: Ctx): void {
  const items = cueOf(ctx);
  const current = resolveCurrentCueIndex(items, ctx.state.cueId, ctx.state.cueIndex);
  goCue(ctx, prevCueIndex(items, current, ctx.state.p2.unlocked), false, true);
}

/**
 * 음악이 내려가는 동안 큐가 붙잡혀 있다는 사실을 그 자리에 띄운다 (U44).
 *
 * 없으면 [다음 →]을 눌렀는데 2초 동안 아무 일도 일어나지 않는 것으로 보여, 운영자가 한 번 더
 * 누른다. 남은 초는 200ms 라이브 갱신이 채우고(`data-live="duck-count"`), [취소]는 예약을
 * 버리고 음악을 되돌린다 — 기다리는 것보다 지금 넘어가는 편이 나을 때가 있다.
 */
function duckWaitChip(ctx: Ctx): HTMLElement | null {
  if (!ctx.duckedCue) return null;
  return el(
    'div',
    {
      class: 'duck-wait',
      attrs: { role: 'status', 'aria-live': 'polite' },
      data: {
        tip: `이 큐의 영상에 소리가 있어 행사 BGM을 ${ctx.state.settings.musicDuckSec}초에 걸쳐 내리는 중입니다. 다 내려가면 큐가 자동으로 진행됩니다. [취소]를 누르면 진행을 멈추고 음악을 원래대로 되돌립니다. 이 동작은 [설정] → [영상 소리에 음악 자동 덕킹]에서 끕니다.`,
      },
      tabIndex: 0,
    },
    el('span', { class: 'duck-wait__mark', text: '♪', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'duck-wait__label', text: '음악 내리는 중 · 곧 진행' }),
    el('span', { class: 'duck-wait__count mono-label', data: { live: 'duck-count' }, text: '' }),
    el('button', {
      class: 'btn btn--tiny',
      type: 'button',
      text: '취소',
      on: { click: () => ctx.cancelDeferredCue() },
    }),
  );
}

/**
 * 두 큐 **사이의 경계**에 얹는 전환 선택 (U42).
 *
 * 항목 안이 아니라 **이음선 위**에 두는 이유: 전환은 "이 항목의 속성"이 아니라 "여기서 저기로
 * 넘어가는 방식"이다. 항목 안에 두면 어느 쪽 경계인지가 매번 헷갈린다. 이음선 위의 넷 중
 * 하나가 항상 켜져 있고, 기본은 `·`(전역 따르기)다.
 *
 * 영상 항목은 `scene/set`을 내지 않아 이 선택이 걸릴 자리가 **시작 전 씬 이동뿐**이다.
 * 그 사실을 툴팁에 적는다 — 걸리지도 않을 선택을 걸리는 것처럼 보이게 두면 안 된다.
 */
function cueBoundary(ctx: Ctx, item: CueItem, isVideo: boolean): HTMLElement {
  const globalMode = ctx.state.settings.sceneTransitionMode;
  const current = cueTransitionOf(ctx.state.cueTransitions, item.id);
  /**
   * 대본이 전환까지 못 박은 경계 (U87). 고정된 방식 하나만 켜 두고 나머지는 누르지 못하게 한다.
   *
   * `disabled`가 아니라 `aria-disabled`를 쓰는 이유: `disabled` 버튼은 포커스도 hover 이벤트도
   * 받지 못해 **왜 못 누르는지 알려 줄 툴팁이 뜨지 않는다.** 운영자에게는 고장 난 버튼으로 보인다.
   * 포커스·hover는 그대로 두고 누르면 이유를 토스트로 답한다.
   */
  const lockTip = lockedCueTransitionTip(item.id);
  return el(
    'div',
    {
      class: `cue-boundary${lockTip ? ' cue-boundary--locked' : ''}`,
      attrs: { role: 'group', 'aria-label': `${item.label} 경계 전환 방식` },
      data: lockTip ? { tip: lockTip } : undefined,
    },
    el('span', { class: 'cue-boundary__line', attrs: { 'aria-hidden': 'true' } }),
    cueTransitionChoices(globalMode).map((choice) => {
      const on = choice.mode === current;
      return el('button', {
        class: `cue-boundary__btn${on ? ' is-on' : ''}${lockTip ? ' is-locked' : ''}`,
        type: 'button',
        text: choice.mark,
        attrs: {
          'aria-pressed': on ? 'true' : 'false',
          'aria-label': lockTip
            ? `${item.label} 경계 ${choice.label} (대본 고정 — 변경 불가)`
            : `${item.label} 경계 ${choice.label}`,
          ...(lockTip ? { 'aria-disabled': 'true' } : {}),
        },
        data: {
          fid: `cue-boundary-${item.id}-${choice.mode ?? 'global'}`,
          tip: lockTip
            ? `${lockTip}. 이 경계의 전환은 대본으로 고정돼 있어 바꿀 수 없습니다 — 영상이 자기 끝을 연출하므로 여기서 다른 방식을 골라도 걸리지 않습니다.`
            : isVideo
              ? `${choice.tip} 이 항목은 영상이라 자기 페이드·스팅어를 스스로 씁니다 — 이 선택은 영상이 시작되기 전에 씬을 옮기는 경우에만 걸립니다. 순차 진행(→ ←)에서만 적용되고 항목을 직접 누르면 전역을 씁니다.`
              : `${choice.tip} 순차 진행(→ ←)에서만 적용됩니다 — 항목을 직접 누르거나 런처에서 점프하면 전역을 씁니다.`,
        },
        on: {
          click: () => {
            if (lockTip) {
              toast(lockTip, 'warn');
              return;
            }
            ctx.dispatch({ type: 'cueTransitions/set', cueId: item.id, mode: choice.mode });
          },
        },
      });
    }),
  );
}

/**
 * 1부 접기 상태 (U59) — 상태 원장이 아니라 이 창의 표시 값이다.
 *
 * `launcher.ts`의 `versusPlaysVideo`와 같은 관례다. 출력 화면과 무관하고 되돌리기 대상도
 * 아니며, 새로고침하면 펼친 상태로 돌아오는 편이 사고가 적다 — 접힌 채로 복원되면 1부로
 * 되돌아가야 하는 상황에서 항목이 없어진 것처럼 보인다.
 */
let p1Collapsed = false;

/**
 * 큐 경계 전환을 고치는 중인가 (U90) — `p1Collapsed`와 같은 이 창의 표시 값이다.
 *
 * 이음선(`cue-boundary`)은 큐 **사이마다** 한 줄씩 들어가서, 켜 둔 채로 두면 큐시트가
 * "항목 · 아이콘 넷 · 항목 · 아이콘 넷"으로 갈려 대본이 한눈에 안 들어온다(2026-09-05 지시).
 * 그래서 기본은 꺼짐이고, [트랜지션 수정]을 누른 동안에만 이음선이 나타난다.
 *
 * 상태 원장에 넣지 않는다: 출력 화면과 무관하고 되돌리기 대상도 아니며, 새로고침하면
 * **읽기 좋은 목록**으로 돌아오는 편이 사고가 적다 — 켜진 채 복원되면 왜 목록이 갈려 보이는지
 * 알 수 없는 상태로 행사를 시작하게 된다.
 */
let transitionEdit = false;

export interface FoldPlanInput {
  /** 지금 진행 단계 (`AppState.phase`) — 1부가 끝나기 전에는 접기를 내놓지 않는다 */
  phase: Phase;
  /** 운영자가 접기를 눌러 두었는가 */
  collapsed: boolean;
  /** 지금 큐 커서가 있는 **배열 인덱스** */
  currentIndex: number;
}

export interface FoldPlan {
  /** 접기 토글을 머리에 내놓을 것인가 */
  showToggle: boolean;
  /** 실제로 접힌 화면을 그릴 것인가 (자동 펼침이 이긴 뒤의 값) */
  effectiveCollapsed: boolean;
  /** 요약 줄을 끼워 넣을 배열 인덱스. `null`이면 요약 줄 없음 */
  summaryAt: number | null;
  /** `hidden`을 걸 배열 인덱스들 */
  hiddenIndexes: readonly number[];
  /** 접힌 항목 수 (요약 줄 문구) */
  foldedCount: number;
}

/**
 * 1부 항목을 **표시 레이어에서만** 접는 계획을 세운다 (U59).
 *
 * 배열은 절대 건드리지 않는다 — `goCue(ctx, i)`가 인덱스를 그대로 쓰고 `cueActions(item, i, …)`가
 * 그 인덱스를 상태에 저장한다. 걸러 내면 큐 커서가 통째로 어긋난다. 그래서 여기서 나오는 것은
 * "몇 번째 줄을 숨기고 어디에 요약을 끼울지"뿐이고, 인덱스 자체는 원본 그대로다.
 *
 * 지금 큐가 접힐 구간 안에 있으면 **접기 의사보다 자동 펼침이 이긴다**. 숨은 줄에는
 * `control.ts`의 `.cue.is-current` `scrollIntoView`가 걸리지 않아, 현재 큐가 어디인지
 * 화면에서 사라지는 형태로 조용히 실패한다.
 */
export function foldPlan(items: readonly CueItem[], input: FoldPlanInput): FoldPlan {
  const foldable: number[] = [];
  items.forEach((item, i) => {
    if (item.phase === 'p1') foldable.push(i);
  });
  // 1부가 끝나기 전에는 아예 내놓지 않는다 — 진행 중에 실수로 접는 사고를 원천 차단한다.
  const showToggle = foldable.length > 0 && input.phase !== 'pre' && input.phase !== 'p1';
  const currentInside = foldable.includes(input.currentIndex);
  const effectiveCollapsed = showToggle && input.collapsed && !currentInside;
  return {
    showToggle,
    effectiveCollapsed,
    summaryAt: effectiveCollapsed ? foldable[0] : null,
    hiddenIndexes: effectiveCollapsed ? foldable : [],
    foldedCount: foldable.length,
  };
}

/**
 * 큐시트 머리의 [1부 접기] 토글 (U59).
 *
 * 접기 의사를 눌러 뒀는데 큐 커서가 아직 1부 안이라 자동 펼침이 이긴 상태는 **문구로도**
 * 알린다 — 눌렀는데 아무 일도 없는 것으로 보이면 운영자는 버튼이 고장 난 줄 안다.
 */
function foldToggle(ctx: Ctx, plan: FoldPlan): HTMLElement | null {
  if (!plan.showToggle) return null;
  const pending = p1Collapsed && !plan.effectiveCollapsed;
  const label = plan.effectiveCollapsed ? '1부 펼치기' : pending ? '1부 접기 · 대기' : '1부 접기';
  return el('button', {
    class: `btn btn--tiny cuesheet__fold-toggle${plan.effectiveCollapsed ? ' is-on' : ''}${pending ? ' is-pending' : ''}`,
    type: 'button',
    text: label,
    attrs: {
      'aria-expanded': plan.effectiveCollapsed ? 'false' : 'true',
      'aria-controls': 'cuesheet-list',
    },
    data: {
      fid: 'cuesheet-fold-toggle',
      tip: pending
        ? `1부 ${plan.foldedCount}개 항목을 접어 두라고 눌러 두었지만, 지금 큐가 아직 1부 안이라 접기를 미뤄 두었습니다. 접으면 현재 큐가 화면에서 사라져 어디까지 왔는지 보이지 않습니다. 1부를 벗어나면 저절로 접힙니다.`
        : plan.effectiveCollapsed
          ? `접어 둔 1부 ${plan.foldedCount}개 항목을 다시 펼칩니다. 접혀 있어도 큐 번호와 [← 이전]·[다음 →] 진행은 그대로라, 접은 채로도 1부 항목으로 되돌아갈 수 있습니다.`
          : `끝난 1부 ${plan.foldedCount}개 항목을 요약 한 줄로 접어 남은 대본만 봅니다. 화면 표시만 접는 것이라 큐 번호·진행 순서는 그대로입니다. 1부로 되돌아가면 저절로 펼쳐집니다.`,
    },
    on: {
      click: () => {
        p1Collapsed = !p1Collapsed;
        ctx.refresh();
      },
    },
  });
}

/** 접힌 1부 구간을 대신하는 요약 한 줄 (U59). 누르면 그 자리에서 펼친다. */
function foldSummary(ctx: Ctx, plan: FoldPlan): HTMLElement {
  return el(
    'li',
    { class: 'cue cue--fold' },
    el(
      'button',
      {
        class: 'cuesheet__fold-btn',
        type: 'button',
        attrs: { 'aria-expanded': 'false', 'aria-label': `1부 ${plan.foldedCount}개 항목 펼치기` },
        data: {
          fid: 'cuesheet-fold-summary',
          tip: '접어 둔 1부 항목을 다시 펼칩니다. 접혀 있는 동안에도 큐 번호와 진행 순서는 그대로입니다.',
        },
        on: {
          click: () => {
            p1Collapsed = false;
            ctx.refresh();
          },
        },
      },
      el('span', { class: 'cuesheet__fold-mark', text: '⌄', attrs: { 'aria-hidden': 'true' } }),
      el('span', {
        class: 'cuesheet__fold-label',
        text: `1부 ${plan.foldedCount}개 항목 접힘 (펼치기)`,
      }),
    ),
  );
}

export interface CueRowPlanInput {
  /** [트랜지션 수정]이 켜져 있는가 (U90) */
  editing: boolean;
  /** 2부 잠금이 풀렸는가 */
  unlocked: boolean;
  /** `foldPlan`이 숨기기로 한 배열 인덱스 (U59) */
  hiddenIndexes: readonly number[];
  /** 큐별 전환 지정 */
  transitions: CueTransitions;
}

export interface CueRowPlan {
  /** 원본 배열 인덱스 — `goCue(ctx, i)`가 쓰는 값 그대로다 */
  index: number;
  cueId: string;
  /** 접혀서 줄 전체가 `hidden`인가 */
  folded: boolean;
  /** 잠긴 항목인가 */
  locked: boolean;
  /** 이 줄 밑에 경계 이음선을 그리는가 */
  boundary: boolean;
  /** 이음선이 숨어 있을 때 줄 오른쪽에 찍을 점이 가리키는 방식. 없으면 `null` */
  dot: SceneTransitionMode | null;
  /** 그 점이 대본 고정 경계(U87)인가 — 운영자가 지정한 것과 구분해서 안내한다 */
  dotLocked: boolean;
}

/**
 * 줄마다 이음선을 그릴지, 점을 찍을지 정한다 (U90).
 *
 * `foldPlan`과 같은 규율이다 — **배열은 절대 건드리지 않는다.** 여기서 나오는 것은 원본
 * 인덱스가 그대로 붙은 표시 계획뿐이고, `renderCuesheet`는 `items.map`의 인덱스로 이 표를
 * 찾아 쓴다. 걸러 내면 `goCue(ctx, i)`·`cueActions(item, i, …)`가 쓰는 커서가 통째로 어긋난다.
 *
 * 점(`dot`)은 **꺼져 있을 때만** 찍는다. 이음선이 보이는 동안에는 켜진 아이콘이 이미 같은 것을
 * 말하고 있어, 둘을 함께 두면 같은 사실을 두 군데서 알리는 꼴이 된다.
 */
export function cueRowPlans(
  items: readonly CueItem[],
  input: CueRowPlanInput,
): CueRowPlan[] {
  const hidden = new Set(input.hiddenIndexes);
  return items.map((item, index) => {
    const locked = Boolean(item.locked) && !input.unlocked;
    const folded = hidden.has(index);
    const mode = cueTransitionOf(input.transitions, item.id);
    return {
      index,
      cueId: item.id,
      folded,
      locked,
      // 잠긴 항목에는 예나 지금이나 경계를 그리지 않는다 — 라벨이 '잠김'이라 무엇의 경계인지
      // 알 수 없고, 아직 쓰지 않는 자리의 연출을 미리 고르게 하면 잠금의 뜻이 흐려진다.
      boundary: input.editing && !locked && !folded,
      dot: !input.editing && !locked && !folded ? mode : null,
      dotLocked: Boolean(lockedCueTransitionTip(item.id)),
    };
  });
}

/**
 * 큐시트 머리의 [트랜지션 수정] 토글 (U90).
 *
 * 켜짐을 **색·형태·문구 셋**으로 알린다 — 이 버튼 하나로 목록의 생김새가 통째로 바뀌므로,
 * 지금 어느 쪽인지 헷갈리면 "왜 갑자기 줄이 늘었지"가 된다.
 */
function transitionEditToggle(ctx: Ctx): HTMLElement {
  const on = transitionEdit;
  return el('button', {
    class: `btn btn--tiny cuesheet__edit-toggle${on ? ' is-on' : ''}`,
    type: 'button',
    text: on ? '트랜지션 수정 · 켜짐' : '트랜지션 수정',
    attrs: {
      'aria-pressed': on ? 'true' : 'false',
      'aria-controls': 'cuesheet-list',
    },
    data: {
      fid: 'cuesheet-transition-edit',
      tip: on
        ? '큐 사이 전환 방식을 고칩니다 — 켜면 이음선이 보입니다. 지금 켜져 있어 항목 사이마다 이음선(·◻◼◆)이 나와 있습니다. 다시 누르면 이음선을 감추고 대본 목록만 봅니다 — 지정한 전환은 그대로 남고, 지정이 있는 줄에는 오른쪽에 점이 찍힙니다.'
        : '큐 사이 전환 방식을 고칩니다 — 켜면 이음선이 보입니다. 평소에는 감춰 두어 큐시트가 대본 그대로 한눈에 들어옵니다. 전역과 다른 전환을 지정해 둔 줄에는 오른쪽에 작은 점이 찍혀 있습니다.',
    },
    on: {
      click: () => {
        transitionEdit = !transitionEdit;
        ctx.refresh();
      },
    },
  });
}

/**
 * 이음선을 감춘 동안, 전역과 다른 전환이 걸린 줄에 찍는 점 (U90).
 *
 * 없으면 지정해 둔 사실 자체가 화면에서 사라진다 — 리허설에서 걸어 둔 스팅어가 본 행사에서
 * 소리 없이 나가는 사고가 난다. 점은 6px짜리 한 점이라 목록의 결을 흐리지 않고, hover·focus·tap
 * 어느 쪽에서도 어떤 방식인지 그 자리에서 답한다.
 */
function transitionDot(plan: CueRowPlan): HTMLElement | null {
  if (!plan.dot) return null;
  const label = MODE_LABEL[plan.dot];
  const lockTip = plan.dotLocked ? lockedCueTransitionTip(plan.cueId) : null;
  return el('span', {
    class: `cue__tdot${plan.dotLocked ? ' is-locked' : ''}`,
    tabIndex: 0,
    attrs: { role: 'img', 'aria-label': `전환 지정 ${label}` },
    data: {
      fid: `cue-tdot-${plan.cueId}`,
      tip: lockTip
        ? `${lockTip}. 이 경계의 전환은 대본으로 고정돼 있어 [트랜지션 수정]을 켜도 바꿀 수 없습니다.`
        : `이 큐로 넘어갈 때 전역 방식 대신 ${label} 전환을 씁니다. 순차 진행(→ ←)에서만 걸립니다. [트랜지션 수정]을 켜면 이 자리의 이음선에서 바꾸거나 전역으로 되돌립니다.`,
    },
  });
}

export function renderCuesheet(ctx: Ctx): HTMLElement {
  const unlocked = ctx.state.p2.unlocked;
  const items = cueOf(ctx);
  const cur = resolveCurrentCueIndex(items, ctx.state.cueId, ctx.state.cueIndex);
  const runtime = cueRuntime(ctx);
  const plan = foldPlan(items, {
    phase: ctx.state.phase,
    collapsed: p1Collapsed,
    currentIndex: cur,
  });
  const rows = cueRowPlans(items, {
    editing: transitionEdit,
    unlocked,
    hiddenIndexes: plan.hiddenIndexes,
    transitions: ctx.state.cueTransitions,
  });

  return el(
    'section',
    { class: 'cuesheet' },
    el(
      'div',
      { class: 'cuesheet__head' },
      el('h2', { class: 'panel__title', text: '큐시트' }),
      transitionEditToggle(ctx),
      foldToggle(ctx, plan),
      el(
        'div',
        { class: 'cuesheet__nav' },
        el('button', {
          class: 'btn btn--tiny',
          type: 'button',
          text: '← 이전',
          data: { tip: '단축키 ←' },
          on: { click: () => goPrev(ctx) },
        }),
        el('button', {
          class: 'btn btn--primary btn--big',
          type: 'button',
          text: '다음 →',
          data: { tip: '단축키 → · 씬 + 타이머 프리셋 + 진행 단계가 함께 넘어갑니다' },
          on: { click: () => goNext(ctx) },
        }),
      ),
    ),
    hasCueTransitions(ctx.state.cueTransitions)
      ? el('button', {
          class: 'btn btn--tiny cuesheet__reset',
          type: 'button',
          text: '전환 전부 전역으로',
          data: {
            fid: 'cue-transitions-reset',
            tip: '큐 경계마다 지정한 전환 방식을 모두 지우고 전역 방식(런처의 화이트/블랙/스팅어)을 따르게 합니다. 리허설에서 이것저것 해 본 뒤 원점으로 돌릴 때 씁니다.',
          },
          on: { click: () => ctx.dispatch({ type: 'cueTransitions/clear' }) },
        })
      : null,
    duckWaitChip(ctx),
    el(
      'ol',
      { id: 'cuesheet-list', class: 'cuesheet__list', data: { scroll: 'cuelist' } },
      items.map((item, i) => {
        const rp = rows[i];
        const locked = rp.locked;
        const blocked = item.matchEventId ? matchCueBlock(item, runtime) : null;
        // 승리 큐는 막히지 않는다 — 영상 대신 카드가 나간다는 사실만 그 자리에서 알린다 (U100).
        const victoryNotice = victoryCueNotice(item, runtime);
        const folded = rp.folded;
        const row = el(
          'li',
          {
            class: `cue${i === cur ? ' is-current' : ''}${i < cur ? ' is-done' : ''}${locked ? ' is-locked' : ''}${item.assetId || item.matchEventId ? ' is-video' : ''}${blocked ? ' is-blocked' : ''}${folded ? ' cue--folded' : ''}${rp.dot ? ' has-tdot' : ''}`,
            // 접힌 줄은 `hidden`으로 통째로 내린다 — 안에 있는 큐 버튼도 경계 전환 선택도
            // 함께 사라져야 한다. 버튼만 숨기면 전환 선택 버튼 줄만 줄줄이 남고,
            // `display:none`이 아니면 Tab 순서에도 계속 걸린다.
            attrs: folded ? { hidden: 'hidden' } : undefined,
          },
          el(
            'button',
            {
              class: 'cue__btn',
              type: 'button',
              disabled: locked,
              data: {
                tip: locked
                  ? '잠긴 항목입니다'
                  : blocked
                    ? `${blocked}. 조합을 고르면 이 자리에서 매치 영상이 재생됩니다.`
                    : victoryNotice
                      ? `${victoryNotice}. 이대로 누르면 화면이 그대로 남습니다(승리 보드 카드는 U110에서 폐기). 승리 팀을 고르고 그 영상이 media 폴더에 있으면 전환 없이 바로 올라옵니다.`
                      : `${item.hint}${item.timer ? ` · 타이머 ${Math.round(item.timer.sec / 60) || item.timer.sec}${item.timer.sec >= 60 ? '분' : '초'}` : ''}`,
              },
              on: { click: () => goCue(ctx, i) },
            },
            el('span', { class: 'cue__idx mono-label', text: String(i + 1).padStart(2, '0') }),
            el('span', { class: 'cue__label', text: locked ? '잠김' : item.label }),
            // 매치 영상은 조합이 정해져야 재생된다 — 눌러 보기 전에 그 자리에서 알린다
            blocked ? el('span', { class: 'cue__flag', text: '조합 없음' }) : null,
            // 승리 영상도 같다. U110에서 카드 폴백이 폐기돼 이제는 **아무것도 안 나간다**는 예고다.
            victoryNotice ? el('span', { class: 'cue__flag', text: '송출 불가' }) : null,
          ),
          // 이음선을 감춘 동안에도 지정해 둔 전환은 점 하나로 남긴다 (U90).
          // 버튼 **밖**에 둔다 — 안에 넣으면 점을 눌렀을 때 큐가 통째로 실행된다.
          transitionDot(rp),
          // [트랜지션 수정]이 켜졌을 때만 경계를 그린다 (U90). 잠긴 항목과 접힌 줄은 예나
          // 지금이나 제외한다 — 판단은 전부 `cueRowPlans`가 한다.
          rp.boundary ? cueBoundary(ctx, item, Boolean(item.assetId || item.matchEventId)) : null,
        );
        // 요약 줄은 접힌 구간의 **첫 자리**에 끼운다. 원래 줄은 지우지 않고 숨기기만 해서
        // `items.map`의 인덱스가 한 칸도 밀리지 않게 한다.
        return i === plan.summaryAt ? frag(foldSummary(ctx, plan), row) : row;
      }),
    ),
  );
}
