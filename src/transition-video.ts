import { classifyPlayRejection } from './audio-lock';
import type { AssetMeta, SceneId, SceneOpts } from './types';

/**
 * 제작 중 음량 조정으로 추가한 스팅어 트랙의 고정 게인.
 * 다른 출력과 같은 축(미디어 볼륨 × 마스터 × 암전)을 타되 그 위에
 * 이 상수를 한 번 더 곱한다. 램프는 여전히 걸지 않는다(효과음 겹침 계약 유지). 파일 자체를
 * 재렌더하지 않고 여기서 깎는 이유는 다음 스팅어 파일이 와도 같은 비율이 유지돼야 하기 때문.
 * `display.ts`가 DOM 부팅 시 부작용을 일으켜 테스트에서 직접 import할 수 없으므로, 실동작
 * 검증이 필요한 이 상수는 부작용 없는 이 파일에 둔다(`display.ts`는 여기서 import해 쓴다).
 * 초기 0.8에서 팀 내 확인 후 0.4로 낮췄다. 이 값은 dB가 아닌 선형 배율이다.
 * 다른 행사에 맞게 변경하면 실제 음향 경로와 transition-video.test.ts를 함께 확인한다.
 * 알파 스팅어 제작·OBS 합성 메모: docs/OPERATION_TIPS.md.
 */
export const TRANSITION_STINGER_GAIN = 0.4;

export interface TransitionPlaybackRateTarget {
  playbackRate: number;
  defaultPlaybackRate: number;
  loop: boolean;
  autoplay: boolean;
}

/**
 * 전환은 디버그 중 남은 DOM 속성에도 영향받지 않는 원속도 단발 재생이다.
 *
 * `autoplay`를 반드시 끈다: 전환 재생은 `ensureTransitionVideo()`가 `play()`를 명시 호출하므로
 * autoplay는 애초에 불필요한데, 켜져 있으면 **예열(`load()`)만으로도 재생이 시작된다**.
 * `hidden=true`라 화면에는 안 보이지만 1080p VP9 알파를 통째로 디코딩하는 "고스트 재생"이 되고
 * (실측: 41프레임 중 39 dropped), 그 카운터가 다음 전환의 `getVideoPlaybackQuality()`에 섞여
 * 실제 드롭 측정까지 오염시킨다.
 *
 * ## `muted`는 **여기서 손대지 않는다** (U102)
 * 예전에는 이 함수가 `muted = true`를 강제했다 — "알파 전환은 항상 무음"이 계약이던 시절이다.
 * 2026-09-05 04:08 지시로 그 계약이 폐기됐다: 스팅어는 **깔린 소리 위에 겹쳐 나는 효과음
 * 레이어**다. 그래서 `muted`의 주인은 다른 출력 미디어와 똑같이 `display.ts`의
 * `setOutputMuted()` 하나이고(모니터 · 창 음소거 · 에셋 판정 세 축), 이 함수는 재생 속도·루프·
 * autoplay라는 **시각 계약**만 다룬다. 두 주인이 같은 속성을 쓰면 예열이 재생의 음소거를
 * 되돌리는 자리가 생긴다 — 강제를 걷어낸 것이 바로 그 자리를 없앤 것이다.
 */
export function normalizeTransitionPlayback(video: TransitionPlaybackRateTarget): void {
  video.defaultPlaybackRate = 1;
  video.playbackRate = 1;
  video.loop = false;
  video.autoplay = false;
}

export interface TransitionPreloadTarget extends TransitionPlaybackRateTarget {
  src: string;
  load(): void;
}

/**
 * 다음 전환용 예열 — **디코딩 준비만** 하고 재생은 시작하지 않는다.
 *
 * `preload='auto'`는 그대로 두어 readyState 4까지 올려 두되, `load()` 이전에 autoplay를 끄는
 * 순서가 계약이다. 순서가 뒤집히면 그 프레임에 고스트 재생이 시작된다.
 */
export function preloadTransitionVideo(video: TransitionPreloadTarget, url: string): void {
  video.src = url;
  normalizeTransitionPlayback(video);
  video.load();
}

// ─────────────────────────────────────────────────────────────────────────────
// 재생 시작 사다리 — 소리가 막혀도 **그림은 반드시 나간다** (U102)
// ─────────────────────────────────────────────────────────────────────────────

export interface TransitionPlayTarget {
  play(): Promise<void>;
}

/**
 * 사다리가 바깥 세계에 손대는 **네 자리**. display 가 자기 단일 경로를 여기에 꽂는다
 * (`muted` 는 `setOutputMuted()`, 잠금은 `needsAudioUnlock` + `reportAudioState()`).
 * 이 함수가 element 의 `muted` 를 직접 쓰지 않는 이유가 그것이다 — 축이 셋(모니터·창 음소거·
 * 에셋)인 판정을 여기서 흉내 내면 단일 경로가 깨진다.
 */
export interface TransitionPlayHandlers {
  /** 소리를 포기하고 무음으로 내린다 (display: `setOutputMuted(el, true)`) */
  demoteToMuted(): void;
  /** 자동재생 정책에 막혔음을 운영자에게 알린다 (잠금 배너) */
  reportAudioLock(): void;
  /** 시각 계약 재적용 — 재시도 전에 autoplay·속도·loop 를 다시 세운다 */
  normalize(): void;
  /** 재생이 실제로 시작됐다 (display: `markBound`) */
  onStarted(): void;
  /** 더는 방법이 없다 (display: `finishTransitionLocally(token)`) */
  onFailed(): void;
}

/**
 * 전환 재생을 시작하고, 거부를 **분류해서** 최대 세 번까지 되살린다.
 *
 * ## 왜 사다리인가 — 두 종류의 거부가 섞여 들어온다
 *  · `AbortError` — 소스 교체·되감기가 이 재생을 밀어냈다. 정상 신호라 잠금으로 세면 안 되고
 *    (U48 후속: 거짓 배너 + 이어지는 클릭이 오디오를 겹쳐 틀었다), 그냥 한 번 더 틀면 된다.
 *  · `NotAllowedError` — 자동재생 정책이 **소리 있는 재생**을 막았다. 이건 무음으로 내려야 풀린다.
 *
 * ## 리뷰 m5가 잡은 구멍
 * 예전 구현은 첫 거부만 분류했다. 첫 거부가 `AbortError` 라 강등 없이 재시도했는데 **그 재시도가
 * `NotAllowedError`** 로 떨어지면, 두 번째 catch 가 곧장 `onFailed()` 로 가서 **전환 그림이
 * 통째로 스킵**됐다 — 소리 하나 때문에 컷이 사라지는, U102 가 막으려던 바로 그 사고다.
 * 지금은 매 거부를 같은 규칙으로 분류하므로 순서에 관계없이 강등 기회가 정확히 한 번 온다.
 *
 * ## 왜 강등은 한 번뿐인가
 * 이미 무음인데 또 `NotAllowedError` 가 나면 정책이 아니라 다른 문제다(소스·디코딩). 거기서
 * 계속 되살리면 죽은 전환을 붙잡고 워치독 마감까지 씬이 멈춘다. 한 번 내려 보고 안 되면 놓는다.
 *
 * 시도 상한 3 = 최초 + 비잠금 재시도 + 강등 재시도. `switchAt` 컷·워치독·token guard 는
 * 호출부가 그대로 쥐고 있으므로 여기서는 건드리지 않는다.
 */
export async function playTransitionWithAudioFallback(
  video: TransitionPlayTarget,
  handlers: TransitionPlayHandlers,
): Promise<void> {
  let demoted = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await video.play();
      handlers.onStarted();
      return;
    } catch (error) {
      const outcome = classifyPlayRejection(error);

      // 소리 때문에 막혔다 — 무음으로 내리고 다시 시도한다 (강등은 한 번뿐).
      if (outcome === 'autoplay-lock' && !demoted) {
        demoted = true;
        handlers.demoteToMuted();
        handlers.reportAudioLock();
        handlers.normalize();
        continue;
      }

      // 소스 교체가 밀어낸 첫 거부 — 강등 없이 한 번만 더. 여기서 muted 로 내리면
      // **다음 재생이 이유 없이 무음**으로 시작하고 거짓 잠금 배너까지 뜬다.
      if (attempt === 0) {
        handlers.normalize();
        continue;
      }

      break;
    }
  }

  handlers.onFailed();
}

/**
 * 1080p 알파 영상과 screen 합성 canvas를 동시에 올리면 Chrome 합성기가 프레임을 놓친다.
 * 전환이 떠 있거나 bake 이미지 하나만 보여야 하는 standby에서는 앰비언트를 즉시 합성에서
 * 빼고 기존 off 씬을 빌려 루프도 접는다.
 */
export function transitionAmbientPresentation(
  scene: SceneId,
  transitionActive: boolean,
): { scene: SceneId; hidden: boolean } {
  return transitionActive || scene === 'standby' ? { scene: 'video', hidden: true } : { scene, hidden: false };
}

/** 첫 정상 transition 에셋을 출력창의 idle prewarm 대상으로 고른다. */
export function pickTransitionPreloadAssetId(
  assets: ReadonlyArray<Pick<AssetMeta, 'id' | 'type' | 'playMode' | 'probeFailed'>>,
): string | null {
  return (
    assets.find(
      (asset) =>
        asset.type === 'video' && asset.playMode === 'transition' && !asset.probeFailed,
    )?.id ?? null
  );
}

export interface TransitionPlaybackSnapshot {
  /** 현재 video element에 실제로 연결되어 재생을 시작한 에셋. */
  boundAssetId: string | null;
  /** 현재 video element에 실제로 연결되어 재생을 시작한 토큰. */
  boundToken: number;
  currentTime: number;
  /** 브라우저가 실제 디코드한 전환 영상 길이. 아직 metadata가 없으면 undefined/NaN. */
  durationSec?: number;
  reportedToken: number;
}

/** 스코어보드는 스팅어 꼬리 0.5초와 행 인트로를 겹치고, 다른 씬은 에셋 marker를 유지한다. */
export function transitionSwitchThresholdSec(
  transition: Pick<SceneOpts['transitionVideo'], 'nextScene' | 'switchAtSec'>,
  durationSec: number | undefined,
): number {
  if (
    transition.nextScene === 'score' &&
    typeof durationSec === 'number' &&
    Number.isFinite(durationSec)
  ) {
    return Math.max(0, durationSec - 0.5);
  }
  return transition.switchAtSec;
}

/** 예전 미디어의 currentTime을 새 전환의 교체 시점으로 오판하지 않게 한다. */
export function isTransitionSwitchDue(
  transition: SceneOpts['transitionVideo'],
  playback: TransitionPlaybackSnapshot,
): boolean {
  const switchAtSec = transitionSwitchThresholdSec(transition, playback.durationSec);
  return Boolean(
    transition.active &&
      transition.assetId &&
      transition.assetId === playback.boundAssetId &&
      transition.restartToken === playback.boundToken &&
      transition.restartToken !== playback.reportedToken &&
      playback.currentTime >= switchAtSec,
  );
}

/**
 * 전환 재생의 진행 단계 — 워치독 마감을 정하는 기준.
 *  · `loading`  — control이 `transition/play`를 낸 직후. display 왕복 + IndexedDB 조회 + `play()`가 남아 있다.
 *  · `bound`    — display가 실제로 재생을 시작해 `transition-bound`를 보고한 뒤. 여기부터 재생 시계가 흐른다.
 *  · `switched` — 교체 시점을 지나 underlying scene이 이미 바뀐 뒤. 남은 건 꼬리 재생뿐이다.
 */
export type TransitionWatchdogPhase = 'loading' | 'bound' | 'switched';

/**
 * 현재 전환이 어느 단계인지 판정한다.
 *
 * `boundToken`은 display가 마지막으로 "재생 시작"을 보고한 토큰이다. 새 전환이 시작되면
 * 토큰이 달라지므로, 이전 전환의 bound 보고를 새 전환의 재생 시작으로 오판하지 않는다
 * (오판하면 아직 로딩 중인 전환에 짧은 `bound` 마감이 걸려 정상 재생을 끊는다).
 */
export function transitionWatchdogPhase(
  transition: Pick<SceneOpts['transitionVideo'], 'switched' | 'restartToken'>,
  boundToken: number,
): TransitionWatchdogPhase {
  if (transition.switched) return 'switched';
  return boundToken === transition.restartToken ? 'bound' : 'loading';
}

/**
 * 전환 영상이 **아무 이벤트도 보내지 않을 때** control이 스스로 컷으로 수렴하기까지의 시간.
 *
 * 왜 필요한가: display 탭이 background(hidden)이면 Chrome이 video preload/decoding을 미뤄
 * `#transition-video`가 readyState 0에 머문다. `ended`도 `error`도 오지 않아
 * `transitionVideo.active=true`가 영원히 남고 씬이 바뀌지 않는다(앰비언트도 숨겨진 채).
 * 조기 종료(ended/error)는 기존 token guard가 이미 수렴시키지만, **무응답**에는 안전장치가 없었다.
 *
 * 규칙 (마감은 **각 단계가 시작된 시각**부터 잰다)
 *  · `loading` — `max(4초, switchAtSec + 1.5초)`, 상한 8초.
 *    control의 dispatch 시점부터 재는 구간이라 재생 시간이 아니라 **왕복·로딩 여유**가 기준이다.
 *    여기서 `switchAtSec + 1.5초`만 주면 큰 스팅어의 IndexedDB 로드가 그 안에 못 끝나
 *    정상 재생을 stall로 오판하고 하드컷을 때린다.
 *  · `bound`   — 기본은 `switchAtSec + 1.5초`, 상한 8초. score 목적지는 finite duration이 있으면
 *    `(durationSec - 0.5초) + 1.5초`를 쓰고 상한을 두지 않는다 — 의도한 overlap 전에 자르면 안 된다.
 *  · `switched`— `(durationSec ?? switchAtSec + 3) + 1.5초`. **상한 없음** — 긴 영상을 정상 재생
 *    중인데 8초에 끊어 버리면 스팅어 꼬리가 잘린다. 이 단계는 이미 씬이 바뀐 뒤라 늦게 끊겨도 안전하다.
 *  · 하한 1초 — 그보다 짧으면 정상 재생을 stall로 오판한다.
 */
export function transitionWatchdogDeadlineMs(
  asset: Pick<AssetMeta, 'durationSec' | 'switchAtSec'> & { nextScene?: SceneId | null },
  phase: TransitionWatchdogPhase,
): number {
  // probe 실패한 에셋은 durationSec이 NaN/undefined로 들어올 수 있다 — 워치독이 죽으면 안 된다
  const sec = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;

  const switchAt = sec(asset.switchAtSec, 0.5);
  const duration =
    typeof asset.durationSec === 'number' && Number.isFinite(asset.durationSec)
      ? Math.max(0, asset.durationSec)
      : undefined;
  const effectiveSwitchAt = transitionSwitchThresholdSec(
    { nextScene: asset.nextScene ?? null, switchAtSec: switchAt },
    duration,
  );

  if (phase === 'switched') {
    const total = duration ?? switchAt + 3;
    return Math.max(1_000, (total + 1.5) * 1_000);
  }

  const play = Math.max(1_000, (effectiveSwitchAt + 1.5) * 1_000);
  const floor = phase === 'loading' ? 4_000 : 1_000;
  // bound score 재생은 실제 종료 0.5초 전까지 기다려야 하므로 8초 상한으로 정상 영상을 자르지 않는다.
  if (phase === 'bound' && asset.nextScene === 'score' && duration !== undefined) {
    return Math.max(floor, play);
  }
  return Math.min(8_000, Math.max(floor, play));
}

/**
 * 설명 영상(full) 검정 페이드 3단계 상태 머신의 워치독 마감(ms).
 *
 * 전환 워치독(`transitionWatchdogDeadlineMs`)과 같은 원칙 — 씬이 멈춰 있는 것이
 * 최악이므로 무응답이면 다음 단계로 강제 전진시킨다. 단계별 근거:
 *  · `covering`/`revealing` — 검정 페이드 애니메이션뿐이라 display 왕복 + 렌더 여유만 있으면
 *    된다. `max(1.5초, fadeSec + 1.5초)`, 상한 8초.
 *  · `playing` — durationSec을 알면 `(durationSec + fadeSec + 2)초`로 **상한 없음**
 *    (설명 영상이 길 수 있다). 모르면 `null`(워치독 미무장) — 정상 재생을 끊는 것이
 *    무응답보다 나쁘다. 이 경우 패널의 `⏭ 스킵` 버튼이 수동 탈출구다.
 */
export function fullVideoWatchdogDeadlineMs(
  phase: 'covering' | 'playing' | 'revealing',
  fadeSec: number,
  durationSec: number | undefined,
): number | null {
  const fade = Number.isFinite(fadeSec) ? Math.max(0, fadeSec) : 0;

  if (phase === 'playing') {
    if (typeof durationSec === 'number' && Number.isFinite(durationSec)) {
      return (Math.max(0, durationSec) + fade + 2) * 1_000;
    }
    return null;
  }

  return Math.min(8_000, Math.max(1_500, (fade + 1.5) * 1_000));
}

/** control이 종료 순간 재로딩되어도 active 상태를 수렴시키는 재전송 가드. */
export function shouldRepeatTransitionEnd(
  transition: SceneOpts['transitionVideo'],
  locallyEndedToken: number,
  now: number,
  lastReportedAt: number,
  intervalMs = 1_000,
): boolean {
  return (
    transition.active &&
    transition.restartToken === locallyEndedToken &&
    now - lastReportedAt >= intervalMs
  );
}
