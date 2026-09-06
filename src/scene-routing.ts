import type { Action } from './state';
import type { AppState, SceneOpts } from './types';
import { pendingScene, pendingStandbyMode } from './pending-scene';
import { resolveTransitionAsset } from './transition-rules';

/**
 * 제거된 내장 로고 스윕은 알파 전환 자산이 비었거나 로딩되지 않아도 다시 사용하지 않는다.
 * 프리렌더 전환을 해석하지 못한 씬 변경은 즉시 하드컷으로 수렴한다.
 */
export function shouldUseBuiltInSceneFx(_state: AppState): boolean {
  return false;
}

type StandbyMode = SceneOpts['standby']['mode'];

/**
 * 시상 무대가 **지금 무엇을 보여 주고 있는가**를 한 문자열로 (U127).
 *
 * 대기 화면 모드(U35)와 같은 문제다: 최종 순위 발표는 등수마다 큐가 따로인데 씬은 전부
 * `award`라, 씬 id만 비교하면 `4위 → 3위` 큐가 "안 바뀌었다"로 읽혀 전환이 통째로 빠졌다.
 * 게다가 전환이 없으면 U103(암전 중 큐 실행)의 출력 판정에도 걸리지 않아, 암전 상태에서
 * 등수 큐를 눌러도 검정이 그대로 남았다.
 *
 * 키에 넣는 값은 **화면 그림을 바꾸는 축 셋**뿐이다 — 단계(`step`), 고른 등수(`selectedRank`),
 * 팀 공개 여부(`selectedTeamRevealed`). `revealedRanks`·`revealed`는 독립 공개 무대에 그려지지
 * 않으므로 넣지 않는다(넣으면 화면이 그대로인 조작에도 스팅어가 돈다).
 */
export function awardRevealKey(award: SceneOpts['award']): string {
  return [award.step, award.selectedRank ?? '-', award.selectedTeamRevealed ? 'team' : 'rank'].join('|');
}

/** `scene/set`이 실어 온 부분 패치를 현재 시상 opts 위에 얹었을 때의 키. */
function nextAwardRevealKey(
  award: SceneOpts['award'],
  opts: Extract<Action, { type: 'scene/set' }>['opts'],
): string {
  const patch = opts?.award;
  if (!patch) return awardRevealKey(award);
  return awardRevealKey({
    ...award,
    ...(patch.step !== undefined ? { step: patch.step } : {}),
    ...(patch.selectedRank !== undefined ? { selectedRank: patch.selectedRank } : {}),
    ...(patch.selectedTeamRevealed !== undefined
      ? { selectedTeamRevealed: patch.selectedTeamRevealed }
      : {}),
  });
}

/**
 * 이 `scene/set`이 만드는 **눈에 보이는 변화**가 무엇인가 (U35).
 *
 * 팀별 사전미션과 메인 대기 화면은 씬이 둘 다 `standby`이고 `sceneOpts.standby.mode`만
 * 다르다. 씬 id만 비교하면 "안 바뀌었다"고 판정돼 스팅어가 통째로 빠졌다.
 *
 * - `'scene'` — 씬 자체가 바뀐다 (기존 경로 그대로).
 * - `'standby-mode'` — 씬은 그대로지만 대기 화면 모드가 바뀐다. 전환을 걸되 모드는
 *   즉시 패치하지 않고 `switchAtSec`까지 미룬다 (안 그러면 스팅어가 덮기 전에 배경이 바뀐다).
 * - `'award-reveal'` — 씬은 그대로지만 시상 무대가 다른 등수·단계를 그린다 (U127). 전환을
 *   걸되 opts는 즉시 반영한다 — 등수 큐는 팀을 열지 않으므로(`selectedTeamRevealed: false`)
 *   스팅어보다 먼저 드러날 비밀이 없다. 대기 모드처럼 미루려면 전환 액션이 시상 opts를
 *   들고 다녀야 하는데, 그 값을 지연시켜야 할 만큼 새는 정보가 없다.
 * - `null` — 아무것도 바뀌지 않는다. 전환 없음.
 *
 * `fromAward`는 지금 무대의 시상 opts다. 생략하면 시상 축을 보지 않는다 —
 * 시상 씬을 다루지 않는 호출부(대기 모드 검사 등)가 그대로 남을 수 있게 한다.
 */
export function sceneSetChange(
  from: AppState['scene'],
  fromStandbyMode: StandbyMode,
  action: Extract<Action, { type: 'scene/set' }>,
  fromAward?: SceneOpts['award'],
): 'scene' | 'standby-mode' | 'award-reveal' | null {
  if (action.scene !== from) return 'scene';
  if (action.scene === 'award') {
    if (!fromAward) return null;
    return nextAwardRevealKey(fromAward, action.opts) !== awardRevealKey(fromAward)
      ? 'award-reveal'
      : null;
  }
  if (action.scene !== 'standby') return null;
  // opts는 부분 패치다 — `standby`를 지정하지 않은 재진입은 모드를 바꾸지 않는다.
  const to = action.opts?.standby?.mode;
  return to !== undefined && to !== fromStandbyMode ? 'standby-mode' : null;
}

/** 대기 모드 전환에서 **즉시** 반영해도 되는 나머지 opts (모드만 빼고 그대로 통과). */
function optsWithoutStandby(
  opts: Extract<Action, { type: 'scene/set' }>['opts'],
): Extract<Action, { type: 'scene/set' }>['opts'] | null {
  if (!opts) return null;
  const { standby: _standby, ...rest } = opts;
  return Object.keys(rest).length ? rest : null;
}

/**
 * `scene/set`을 기본 전환 영상으로 감싸는 중앙 경계.
 *
 * 배치 안에서 씬이 여러 번 바뀔 수 있으므로(§2-2) `from`을 추적하며 각 `scene/set`을
 * `(from → action.scene)`으로 개별 해석한다. `video/playFull`·`transitionRules/*` 등
 * `scene/set`이 아닌 새 액션은 그대로 통과한다(§2-3 — 설명 영상 페이드는 이 경계를
 * 구조적으로 타지 않는다).
 *
 * 대기 화면 모드(사전미션 ↔ 메인)는 씬 변경과 동등하게 취급한다(U35) — `from`과 함께
 * 모드도 추적해 배치 안 두 번째 전환까지 올바르게 해석한다.
 *
 * 출발점은 **지금 보이는 씬이 아니라 향하고 있는 씬**이다 (U125, `pending-scene.ts`).
 * 전환은 `switchAtSec`이 지난 뒤에야 씬을 갈아 끼우므로, 그 0.3~1초 사이에 들어온 다음 큐를
 * 옛 씬과 비교하면 도착 씬과 같은 큐가 "바뀌는 것 없음"으로 읽힌다 — 전환이 걸리지 않고
 * 그대로 흘러간 `scene/set`이 돌던 스팅어를 뜯어내, 애니메이션만 돌고 화면은 그대로 남는다.
 * 전환이 없으면 두 값이 같으므로 평상시 경로는 그대로다.
 */
export function routeSceneActionsThroughDefaultTransition(
  state: AppState,
  actions: Action[],
  now: number,
): Action[] {
  let from = pendingScene(state);
  let standbyMode: StandbyMode = pendingStandbyMode(state);
  /**
   * 시상 무대 축도 `from`·`standbyMode`와 같이 배치 안에서 추적한다 (U127) — 한 배열이
   * 시상 opts를 두 번 건드리면 두 번째가 낡은 값과 비교돼 전환이 한 겹 더 걸린다.
   * 시상 opts는 전환 뒤로 미루지 않으므로(`'award-reveal'` 주석) 출발값은 지금 상태 그대로다.
   */
  let award = state.sceneOpts.award;

  return actions.flatMap((action): Action[] => {
    if (action.type !== 'scene/set') return [action];

    const change = sceneSetChange(from, standbyMode, action, award);
    // 시상 씬을 목표로 하는 `scene/set`은 전환 여부와 무관하게 무대 축을 옮긴다 —
    // 시상으로 **들어오는** 큐(`change === 'scene'`)도 opts를 함께 싣고 오기 때문이다.
    if (action.scene === 'award' && action.opts?.award) {
      award = { ...award, ...action.opts.award } as typeof award;
    }
    if (!change) return [action];

    const to = action.scene;
    const nextStandbyMode = change === 'standby-mode' ? action.opts!.standby!.mode! : null;
    // 씬이 바뀌는 경우의 opts는 예전대로 전부 즉시 반영한다 — 지금 보이는 화면은 `from`이라
    // 도착 씬의 opts를 미리 세팅해도 드러나지 않는다.
    const immediateOpts = change === 'scene' ? action.opts ?? null : optsWithoutStandby(action.opts);
    const patch: Action[] = immediateOpts ? [{ type: 'sceneOpts/patch', patch: immediateOpts }] : [];

    /**
     * 암전이 덮고 있으면 **전환을 걸지 않는다** (U96).
     *
     * 사용자 지시(01:04) — "영상 틀다가 → 암전 → 대기화면 누르면(블랙 전환 방식일 때)
     * 대기화면 켜질 때 잠깐 영상이 배경에 보임(영상이 안 끝난 경우). 블랙에서 스윽 올라오도록."
     *
     * ## 왜 전환이 문제인가
     * 씬 페이드·스팅어는 **자기도 화면을 덮는 연출**이다. 이미 검게 덮인 위에서 도는 동안
     * 아무도 그것을 볼 수 없고(덮개가 둘), 대신 컷 시점만 `switchAtSec`만큼 뒤로 밀린다.
     * 그 사이에 운영자가 암전을 풀면 아직 넘어가지 않은 **옛 씬**(재생 중인 영상)이 그대로
     * 드러난다 — 사용자가 본 "잠깐 영상이 배경에 보임"이 이 어긋남이다. 덮개가 이미 있는데
     * 덮개를 하나 더 거는 것 자체가 군더더기다.
     *
     * ## 그래서 컷 + 해제를 **한 배열**로
     * 씬은 검정 뒤에서 즉시 갈아치우고(`scene/set` 그대로 — `resetRuntimeVideoPhase`가 영상
     * 단계를, 리듀서가 오버레이를 그 자리에서 놓는다), 같은 배열에 암전 해제를 붙인다.
     * 방송 1회 안에서 둘이 함께 도착하므로 display는 "이미 바뀐 씬"을 `blackoutSec` 동안
     * 검정에서 끌어올린다 — 이것이 지시의 "블랙에서 스윽"이다.
     *
     * 배열 순서는 `scene/set` → `blackout/set`이다. `blackout/set`의 출발값은 **지금 보이는
     * 불투명도**라 씬 교체가 먼저 끝나 있어야 램프가 100% 검정에서 출발한다.
     *
     * 암전을 켠 채로 다음 순서를 준비하고 싶으면 씬을 고른 뒤 토글을 **한 번 더** 누른다
     * (그 조작은 이 경로를 타지 않는 `blackout/set` 하나다).
     */
    if (state.sceneOpts.blackout.active) {
      from = to;
      if (nextStandbyMode) standbyMode = nextStandbyMode;
      return [action, { type: 'blackout/set' as const, on: false, now }];
    }

    /**
     * 분위기 반전이 화면을 덮고 있어도 **전환을 걸지 않는다** (U98) — 암전과 같은 규칙, 같은 이유.
     *
     * 사용자 지시(03:18) — "분위기 반전 영상 틀어지다가 1단계 대기화면 넘어갈 때 잠깐 중계
     * 영상이 보임."
     *
     * ## 어긋남의 정체
     * 반전이 도는 동안 화면의 주인은 `#overlay-video`(반전 영상)와 그 아래 검정 레이어다.
     * 운영자가 다음 큐를 누르면 `routeMoodSceneActions`가 같은 배열 앞에 `mood/abort`를 넣어
     * **덮개를 그 자리에서 놓는다.** 그런데 여기서 `scene/set`을 씬 페이드로 감싸면 씬 교체는
     * `fadeSec` 뒤로 밀린다 — 덮개는 이미 없고 스테이지는 아직 `live`인 그 구간 동안
     * **중계 카메라가 그대로 드러난다.** 검정 페이드는 0에서 시작하므로 가려 주지도 못한다.
     *
     * ## 그래서 컷
     * 씬을 덮개 뒤에서 즉시 갈아치우면 `mood/abort`와 `scene/set`이 **한 배열 · 한 방송**으로
     * 도착하고, display는 한 프레임 안에서 `renderScene()`(새 씬) → `updateMoodVisual()` ·
     * `ensureOverlayVideo()`(덮개 해체) 순서로 처리한다. 두 일이 같은 합성에 들어가므로
     * 옛 씬이 드러나는 프레임 자체가 없다. 반전 영상의 자연 종료(`mood/finish`)가 이미
     * 이 모양이다 — 씬 교체와 덮개 해체를 한 액션에 담아 컷으로 넘긴다.
     *
     * 덮개가 아직 얇은 글리치 초입(0.6초 디졸브 중)에 눌러도 컷이 옳다. 그때 드러날 수 있는
     * 것은 어차피 반쯤 비치던 화면이고, 페이드를 걸면 그 반쯤이 **완전히** 드러난다.
     */
    if (state.sceneOpts.moodTransition.active) {
      from = to;
      if (nextStandbyMode) standbyMode = nextStandbyMode;
      return [action];
    }

    /**
     * 큐 경계 지정(U42)이 있으면 그것이 전역을 이긴다.
     *
     * 액션에 실어 보내는 이유: 적용은 **이 중앙 경계 하나**에서만 일어나야 한다. 큐가 자기
     * 경로로 `sceneFade/play`를 직접 내면 씬 소유자가 둘이 되어, 늦게 도착한 쪽이 이미 넘어간
     * 화면을 다시 덮는다(스팅어와 컬러 페이드가 겹치던 사고와 같은 형태다).
     */
    const mode = action.transitionMode ?? state.settings.sceneTransitionMode;
    if (mode === 'black' || mode === 'white') {
      from = to;
      if (nextStandbyMode) standbyMode = nextStandbyMode;
      return [
        ...patch,
        {
          type: 'sceneFade/play' as const,
          color: mode === 'black' ? ('#000000' as const) : ('#ffffff' as const),
          nextScene: to,
          ...(nextStandbyMode ? { nextStandbyMode } : {}),
          durationSec: state.settings.fadeSec,
          now,
        },
      ];
    }
    const assetId = resolveTransitionAsset(state.transitionRules, state.assets, from, to);
    from = to;
    // 대기 모드는 어느 경로로 가든 이 액션으로 바뀐다 — 하드컷에서 추적을 빼먹으면
    // 같은 배치의 다음 `scene/set`이 낡은 모드와 비교해 전환을 한 번 더 건다.
    if (nextStandbyMode) standbyMode = nextStandbyMode;
    // 쓸 전환 에셋이 없으면 예전처럼 즉시 하드컷 — 대기 모드도 액션 그대로 반영된다.
    if (!assetId) return [action];

    const asset = state.assets.find((item) => item.id === assetId)!;
    return [
      ...patch,
      {
        type: 'transition/play' as const,
        assetId,
        nextScene: to,
        ...(nextStandbyMode ? { nextStandbyMode } : {}),
        switchAtSec: asset.switchAtSec ?? 0.5,
        now,
      },
    ];
  });
}

/**
 * 화면에 **새 그림을 내보내는** 액션 — 암전 중 큐 실행에서는 이것이 곧 해제 신호다 (U103).
 *
 * `cue/index`·`phase/set`·`timer/preset`·`sceneOpts/patch`는 커서·배지·설정만 움직여
 * 검정 뒤에서도 아무 문제가 없다. 그래서 표식은 "출력이 바뀌는가" 하나뿐이다.
 */
const CUE_OUTPUT_TYPES: ReadonlySet<Action['type']> = new Set([
  'scene/set',
  'video/playFull',
  'overlay/play',
  'transition/play',
  'mood/start',
]);

/**
 * 암전 중에 큐시트 항목을 누르면 그 항목을 **실행하며 암전을 푼다** (U103).
 *
 * 사용자 지시(04:14) — "화면 암전 상태에서 큐시트의 항목을 누르면 해당 항목이 실행되게 해줘."
 *
 * ## 왜 U96만으로는 부족했나
 * U96의 해제는 `routeSceneActionsThroughDefaultTransition`의 `scene/set` 분기에만 붙어 있다.
 * 그래서 **`scene/set`을 내지 않는 큐**(매치·승리 `overlay/play`, full 영상 `video/playFull`,
 * 스팅어 영상 `transition/play`)와 **같은 씬에서 opts만 바뀌는 큐**(`roster-heat→roster-all`,
 * `game-A→game-B` — `sceneSetChange`가 `null`을 준다), 그리고 `mood/start`로 치환되는 반전 큐는
 * 검정이 그대로 덮인 채 소진됐다. 액션은 다 적용되고 커서만 움직이니 운영자에게는
 * "큐를 눌렀는데 아무 일도 안 일어난" 것으로 보인다.
 *
 * ## 규칙 한 줄
 * **큐 실행 배치(`cue/index`가 있다)가 화면 출력을 바꾸면, 배열 끝에 암전 해제를 붙인다.**
 * 출력을 바꾸지 않는 큐(자막·타이머만 있는 항목)는 검정을 유지한다 — 암전을 켠 채 다음 순서를
 * 준비하는 조작이 그대로 살아 있어야 한다.
 *
 * ## 왜 배열 **끝**인가
 * U96과 같은 이유다. `blackout/set`의 출발값은 **지금 보이는 불투명도**(`state.ts` 리듀서)라,
 * 그림을 바꾸는 액션이 먼저 적용돼 있어야 해제 램프가 100% 검정에서 출발한다. 앞에 붙이면
 * 램프가 도는 중간 불투명도에서 시작해 "스윽"이 반쯤 잘린다.
 *
 * ## 전환은 걸리지 않는다 (컷 + 해제 램프)
 * 큐 경계 전환(U42)은 `scene/set.transitionMode`에만 실리고, 그 분기는 암전 중이면
 * `transitionMode`를 읽기 전에 컷으로 빠져나간다(위 U96 분기). 스팅어(z45)가 암전(z47) 아래서
 * 돌다 해제 램프 중에 반쯤 드러나는 일이 구조적으로 없다. 큐 **내용 자체가** 전환 영상인
 * 스팅어 영상 큐(`assetPlayMode: 'transition'`)는 내용이므로 그대로 재생된다.
 *
 * ## 오디오
 * 추가 작업이 없다. 해제 램프를 `blackoutAudioAxis`(U95)가 `1 − opacity`로 읽어 마스터·음악을
 * 같은 곡선으로 끌어올린다.
 */
export function releaseBlackoutForCue(state: AppState, actions: Action[], now: number): Action[] {
  if (!state.sceneOpts.blackout.active) return actions;
  // 큐 실행의 표식 — `cueActions`만이 내는 액션이다(런처·단축키 경로에는 없다).
  if (!actions.some((a) => a.type === 'cue/index')) return actions;
  // U96이 이미 붙였으면 그대로 둔다 (해제가 둘이면 뒤엣것이 앞엣것의 램프를 다시 세운다)
  if (actions.some((a) => a.type === 'blackout/set')) return actions;
  if (!actions.some((a) => CUE_OUTPUT_TYPES.has(a.type))) return actions;
  return [...actions, { type: 'blackout/set' as const, on: false, now }];
}

/** 스팅어가 감쌀 수 있는 리플레이 액션 — 진입 하나, 복귀 둘(운영자 정지 · 자연 종료). */
export type ReplayStingerAction = Extract<
  Action,
  { type: 'live/replay' | 'live/replayStop' | 'live/replayEnded' }
>;

/**
 * 리플레이 진입·복귀를 짧은 스팅어로 감싼다 (U81 진입 · U85 복귀 완성).
 *
 * ## 왜 여기인가
 * 전환을 걸지 말지는 **이 파일 하나**가 정한다(§3 계약). 리플레이는 씬을 바꾸지 않아
 * `routeSceneActionsThroughDefaultTransition`을 타지 않으므로 별도 입구가 필요하지만,
 * 판단은 같은 경계 안에 있어야 한다 — control이 자기 경로로 `transition/play`를 직접 내면
 * 화면을 덮는 주인이 둘이 된다.
 *
 * ## 왜 씬을 바꾸지 않는 전환인가
 * `nextScene`이 지금 씬(`live`)과 같다. 스팅어는 화면을 **덮기 위해서만** 쓴다 —
 * 리플레이 컷은 씬 이동이 아니라 같은 씬 안에서 카메라와 되감기 영상이 바뀌는 것이다.
 * `transition/switched`가 `scene: 'live' → 'live'`로 흘러 아무것도 바꾸지 않고,
 * `moveScene`의 이탈 정리(Q5 #12)도 걸리지 않는다.
 *
 * ## 컷 시각
 * 실제 컷은 **스팅어가 화면을 덮은 순간**이어야 한다. 그래서 리플레이 액션을 지금 내지 않고
 * `deferred`로 넘긴다 — control이 display의 `transition-switch:<token>` 보고를 받은 프레임에
 * `transition/switched`와 **한 배열로** 낸다(방송 1회). 스팅어가 없거나 못 쓰면 `transition`이
 * `null`이고 `deferred`를 그 자리에서 낸다(지금까지의 하드컷 그대로).
 *
 * ## 나가는 컷도 같은 경로다 (U85)
 * 사용자 지적: "지금 리플레이 끝날 때 스팅어가 안 나오거든." U81은 **진입**만 감쌌고,
 * 되감기가 끝까지 돌아 display가 `replay-ended:<token>`을 보고하는 자연 종료는 그대로
 * 하드컷이었다(운영자가 `R`로 끊는 `live/replayStop`은 이미 감싸고 있었다). 그래서 이 함수의
 * `deferred`에 `live/replayEnded`를 받아들인다 — 나가는 컷도 들어온 컷과 **같은 스팅어**가 덮는다.
 * 짝이 맞아야 되감기 구간이 스팅어 두 장 사이에 놓인 하나의 묶음으로 읽힌다.
 *
 * ## 소리
 * 이 경로는 오디오를 건드리지 않는다. 스팅어는 언제나 muted이고(§3 계약), 되감기 재생
 * `<video>`도 항상 muted이며, 카메라 오디오는 씬이 그대로라 파킹·복원 경로 자체가 돌지 않는다.
 */
export interface ReplayStingerPlan {
  /** 화면을 덮을 스팅어. `null`이면 감쌀 것이 없어 즉시 컷이다. */
  transition: Extract<Action, { type: 'transition/play' }> | null;
  /** 스팅어가 덮은 순간(또는 즉시) 낼 리플레이 액션 */
  deferred: ReplayStingerAction;
}

export function routeReplayThroughStinger(
  state: AppState,
  deferred: ReplayStingerAction,
  now: number,
): ReplayStingerPlan {
  // 중계 화면이 아니면 감쌀 화면 자체가 없다 (복귀 액션은 어느 씬에서든 안전하게 통과)
  if (state.scene !== 'live') return { transition: null, deferred };
  const assetId = resolveTransitionAsset(state.transitionRules, state.assets, 'live', 'live');
  if (!assetId) return { transition: null, deferred };
  const asset = state.assets.find((item) => item.id === assetId);
  return {
    transition: {
      type: 'transition/play',
      assetId,
      // 씬은 그대로다 — 스팅어는 컷을 가리는 용도로만 쓴다
      nextScene: 'live',
      switchAtSec: asset?.switchAtSec ?? 0.5,
      now,
    },
    deferred,
  };
}
