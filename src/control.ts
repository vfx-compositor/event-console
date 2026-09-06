/**
 * control.html 엔트리 — 조작 패널이자 상태의 **유일한 리더**.
 *
 * 리더를 하나로 둔 이유: 두 창이 모두 상태를 바꾸면 새로고침·재연결 시 어느 쪽이 최신인지
 * 판단할 수 없다. display는 사건만 보고하고(영상 종료·카메라 실패) 전환 판단은 여기서 한다.
 */

import './styles/tokens.css';
import './styles/control.css';

import {
  COLLAPSED_TAB_IDS,
  TABS,
  findTab,
  isTabActivationKey,
  isTabMoreOpen,
  nextTabFocus,
  visibleTabIds,
} from './control/tabs';
import type { TabDef } from './control/tabs';
import { livePosition as musicLivePosition, musicScrubPaint } from './control/tab-music';
import { bookmarkOf } from './music-bookmarks';
import { audioActionBlocked, audioLockToast } from './audio-lock';
import { isUserMuteEvent } from './display-windowed';
import { musicAdvanceActions } from './music-autoplay';
import { createControlLeader, type ControlRole } from './control-leader';
import { createControlSync, type DisplayEvent } from './sync';
import {
  createInitialState,
  getSaveError,
  loadLocal,
  reducer,
  adoptStoredState,
  saveLocal,
  type Action,
} from './state';
import { clear, el } from './control/dom';
import { hidePassiveOverlay, setPassiveOverlayNotice, showPassiveOverlay } from './control/passive-overlay';
import { formatMMSS, isRunning, remainingSec } from './timer';
import { goNext, goPrev, renderCuesheet } from './control/cuesheet';
import { moodGlitchMs } from './mood-glitch';
import {
  releaseBlackoutForCue,
  routeReplayThroughStinger,
  routeSceneActionsThroughDefaultTransition,
  type ReplayStingerAction,
} from './scene-routing';
import { installHotkeys } from './hotkeys';
import { installTooltips } from './control/tooltip';
import { isModalOpen } from './control/modal';
import { primeLogos, setLogoListener } from './logos';
import { probeVideo, readAssetMetas } from './control/tab-assets';
import { deleteAsset, putAsset, saveSnapshot } from './db';
import {
  deadVideoAssetRef,
  isMediaAsset,
  mediaFileFromId,
  orphanVideoRefAction,
  orphanedMediaAssetIds,
  pendingOrphanVideoRefAction,
  syncMediaManifest,
} from './media-manifest';
import { assetMusicOf, defaultBreakingVideoId, fullVideoOutputActions } from './cue';
import { standbyKeyVisualId } from './standby-key-visual';
import { routeMoodSceneActions } from './mood-routing';
import { videoEndedFallbackScene } from './pending-scene';
import { pureCameraAction, renderLauncher, replayMarkLabel, sceneEntryAction } from './control/launcher';
import { pgmStatusView, renderPgmMonitor } from './control/pgm-monitor';
import { blackoutDurationMs, blackoutRemainingSec, blackoutTarget } from './blackout';
import {
  abortPhotoIntake,
  intakeFiles,
  isIntaking,
  primePhotoStorage,
  pruneOrphanPhotos,
  refreshPhotoIntegrity,
  restorePhotoDir,
  setDefaultIntakeDeps,
  startPhotoPolling,
  type IntakeStatus,
  type PollingOpts,
  type StopPolling,
} from './photo-intake';
import { loadBundledPhotoFiles, seedBundledPhotos } from './photo-seed';
import { renderTopbar, paintVolumeReadout } from './control/topbar';
import {
  IDLE_RENDER_HOLD,
  grabRender,
  isHeld,
  releaseAllRender,
  releaseRender,
  requestRender,
  type RenderHold,
  type RenderHoldOwner,
} from './control/render-hold';
import { installSidebarResizer } from './control/sidebar-resize';
import {
  VOLUME_AXES,
  anyVolumeRampActive,
  effectiveVolume,
  volumeRampSettled,
} from './volume-ramp';
import {
  duckedCueRemainingSec,
  fullVideoOwnsOutput,
  scheduleDuckedCue,
  videoAudioOwnsOutput,
  type DuckedCue,
} from './music-duck';
import { musicTrack } from './music';
import { toast } from './control/toast';
import {
  fullVideoWatchdogDeadlineMs,
  transitionWatchdogDeadlineMs,
  transitionWatchdogPhase,
  type TransitionWatchdogPhase,
} from './transition-video';
import type { AppState, AssetMeta, AudioSource, PhotoMeta, SceneId, VideoPlayMode } from './types';
import type { Ctx, StatusInfo } from './control/ctx';

const app = document.getElementById('app') as HTMLElement;

/**
 * 저장본이 설명 영상 페이드 도중(`phase !== 'idle'`)에 얼어붙어 있으면 그대로 복원했을 때
 * display가 영원히 오지 않을 완료 보고를 기다린다(검정 화면에 멈춘다). 리셋은 `migrate()`가
 * 아니라 **저장본을 실제로 인수하는 control**만 할 수 있다 — migrate에 넣으면 display가
 * `deserialize()`로 받는 모든 방송에서 covering/playing/revealing이 지워져 페이드가 죽는다.
 */
let state = adoptStoredState(loadLocal() ?? createInitialState());
let activeTab = 'p1';
let savedAt = Date.now();
let cameraOk: boolean | null = null;
/** display가 보고한 출력 창 오디오 autoplay 잠금 상태. null = 아직 보고 없음 */
let audioLocked: boolean | null = null;
/**
 * display가 보고한 **운영자 음소거** 여부 (U88). null = 아직 보고 없음.
 *
 * `audioLocked`와 끝까지 분리한다 — 저쪽은 브라우저 정책이 막은 사고고 이쪽은 운영자가
 * 누른 상태다. 합치면 고칠 것 없는 잠금 배너가 상시로 떠 진짜 잠금을 가린다.
 * 창 단위 선택이라 상태 원장에는 오르지 않는다 — 여기 로컬 변수가 전부다.
 */
let displayUserMuted: boolean | null = null;
/**
 * display가 보고한 슬로우 리플레이 버퍼 길이(초) (Q5).
 *
 * 상태가 아니라 순간 값이다 — 1초마다 원장에 쓰면 persist·방송이 쉬지 않고 돈다
 * (영상 진행 바 `videoProgress`와 같은 관례).
 */
let replayBufferSec = 0;

/**
 * 스팅어가 화면을 덮는 순간에 낼 리플레이 액션 (U81 진입 · U85 복귀).
 *
 * 컷을 지금 내면 되감기 영상이 스팅어보다 먼저 드러난다 — 감싸는 의미가 사라진다.
 * display가 `transition-switch:<token>`을 보고한 프레임에 `transition/switched`와 **한
 * 배열로** 낸다(방송 1회). 토큰을 함께 들고 있어야 늦게 도착한 옛 전환의 switch가 다음
 * 리플레이를 대신 열지 못한다.
 *
 * 액션을 통째로 들고 있는 이유(U85): 감쌀 대상이 셋으로 늘었고 둘은 값을 나른다 —
 * `live/replayEnded`는 토큰을, `live/replay`는 [지금부터]가 잡은 구간 길이를 실어 온다.
 * 예전처럼 `'start' | 'stop'` 두 글자만 기억하면 그 값을 되살릴 방법이 없다.
 */
let replayUnderStinger: { token: number; action: ReplayStingerAction } | null = null;

/** 보류 중인 리플레이 액션을 꺼낸다. 토큰이 다르면 남겨 둔다(옛 전환의 보고). */
function takeReplayUnderStinger(token: number): Action | null {
  if (!replayUnderStinger || replayUnderStinger.token !== token) return null;
  const { action } = replayUnderStinger;
  replayUnderStinger = null;
  // `startedAt`은 컷이 **실제로 일어나는** 이 순간이어야 한다 — 누른 순간을 그대로 쓰면
  // 스팅어가 덮는 동안의 시간만큼 어긋난다. 구간 길이(`seconds`)는 누를 때 잰 값 그대로다.
  return action.type === 'live/replay' ? { ...action, now: Date.now() } : action;
}

const status: StatusInfo = {
  displayConnected: false,
  cameraOk: null,
  savedAt,
  saveError: null,
};

/** display가 보고한 영상 재생 위치 — 전체 재렌더 없이 진행 바만 갱신한다 */
let videoProgress = { t: 0, d: 0, at: 0 };
/** display가 보고한 BGM 재생 위치 — 상태 원장에는 쓰지 않는다. */
let musicProgress = { trackId: null as string | null, t: 0, d: 0, playing: false, at: 0 };

// ---------------------------------------------------------------- 리더 락 (control 다중 인스턴스)

/**
 * 런처는 더블클릭마다 control 탭을 새로 연다. 두 창이 모두 상태를 바꾸면
 * display의 3초 `hello`에 양쪽이 응답해 씬이 3초 주기로 번갈아 튄다(실측).
 * 그래서 조작 권한은 언제나 한 창만 갖는다 — 나머지는 오버레이로 잠근다.
 */
let role: ControlRole = 'pending';
let booted = false;
/** 리더 자리를 다른 창에 넘겨준 경우 — 오버레이 문구가 달라진다 */
let yieldedAway = false;

/**
 * 덕킹 대기 큐 (U44) — 소리 있는 영상 큐는 음악이 다 내려간 뒤에 나간다.
 *
 * 이 대기는 **이 창의 타이머**일 뿐 상태가 아니다. 상태에 넣으면 보조 창이 같은 큐를 한 번 더
 * 실행한다. 선언이 여기 위쪽인 이유는 `applyRole()`이 리더 생성 중에도 불릴 수 있어
 * `clearDeferredCue()`가 TDZ에 걸리면 안 되기 때문이다. 판정 근거는 `music-duck.ts`.
 */
let duckedCue: DuckedCue | null = null;
let duckedCueTimer = 0;
let duckedCueRun: (() => void) | null = null;

function isLeader(): boolean {
  return role === 'leader';
}

const leader = createControlLeader({
  onChange: (next) => applyRole(next),
  beforeYield: () => {
    // 인수하는 창은 localStorage에서 상태를 다시 읽는다 → 넘기기 전에 반드시 밀어 넣는다.
    // 저장이 실패하면 자리를 넘기지 않는다(false) — 새 리더가 옛 상태를 읽어 원장이 유실된다.
    const ok = flushSave();
    if (ok) yieldedAway = true;
    return ok;
  },
  onTakeoverRefused: () => {
    setPassiveOverlayNotice(
      '기존 창의 저장이 실패해 인수할 수 없습니다. 기존 창에서 [설정] → JSON 내보내기로 백업 후 다시 시도하세요.',
    );
  },
});
role = leader.role();

function applyRole(next: ControlRole): void {
  role = next;

  if (next === 'leader') {
    // 인수 직후에는 직전 리더가 마지막으로 저장한 상태가 진실이다.
    // (2부 잠금·append-only 원장도 이 경로로 그대로 복원된다)
    // 직전 리더가 페이드 도중 죽었으면 그 단계가 저장본에 남아 있다 — 인수하는 창이 리셋한다.
    const stored = loadLocal();
    if (stored) state = adoptStoredState(stored);
    // 인수한 창의 예약은 없어야 한다 — 직전 역할에서 걸어 둔 타이머가 남으면 큐가 두 번 간다
    clearDeferredCue();
    yieldedAway = false;
    setAppInteractive(true);
    hidePassiveOverlay();
    if (booted) takeOverAsLeader();
    return;
  }

  // pending도 오버레이를 유지한다 — 잠깐 걷으면 그 사이 눌린 버튼 중 일부(에셋 등록·로고 삭제·
  // 전체 초기화)가 dispatch를 거치지 않고 IndexedDB를 직접 써서 리더 가드를 통과한다.
  clearTransitionWatchdog();
  clearFullVideoWatchdog();
  // 덕킹 대기 큐도 함께 버린다 (U44) — 조작 권한이 없는 창의 타이머가 뒤늦게 터지면
  // 리더가 이미 다른 데로 넘긴 큐를 되돌린다.
  clearDeferredCue();
  // 폴링 정지는 워치독 해제와 **짝**이다 — 한쪽만 넣으면 잠긴 창이 계속 폴더를 열고
  // IndexedDB에 사진을 밀어 넣어 리더의 상태와 어긋난다 (직전 계획 §11 L5의 교훈).
  stopPhotoIntake();
  setAppInteractive(false);
  showPassiveOverlay({
    phase: next === 'pending' ? 'pending' : 'passive',
    yielded: yieldedAway,
    onTakeover: () => leader.requestTakeover(),
  });
}

/**
 * 조작 권한이 없을 때 패널 본문을 통째로 비활성화한다.
 *
 * dispatch 가드만으로는 부족하다 — 에셋 등록/삭제, 팀 로고 put/delete, 전체 초기화는
 * reducer를 거치지 않고 IndexedDB를 직접 쓴다. `inert`는 클릭·포커스·키 입력을 한 번에 끊는다.
 *
 * `#modal-root`도 함께 끈다 — 확인 모달(전체 초기화 등)은 `#app` 밖에 뜨므로,
 * 모달이 열린 채 권한을 잃으면 그 확인 버튼만 살아남는다.
 *
 * `is-locked` 클래스는 `inert`를 모르는 브라우저용 폴백이다(`pointer-events: none`).
 * 키보드까지 막지는 못하지만, 잠긴 창에서 클릭 한 번으로 IndexedDB가 바뀌는 것은 막는다.
 */
function setAppInteractive(on: boolean): void {
  for (const id of ['app', 'modal-root']) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.inert = !on;
    node.classList.toggle('is-locked', !on);
    if (on) node.removeAttribute('aria-hidden');
    else node.setAttribute('aria-hidden', 'true');
  }
}

/** 리더가 된 순간 해야 할 일 — 상태 방송 + 에셋 재적재 + 워치독 재무장 */
function takeOverAsLeader(): void {
  // 비리더로 있는 동안 dispatch가 막혀 있었으므로 보류 중이던 무효화·죽은 참조가 남아 있을 수
  // 있다. 인수 직후 한 번 태워 정리한다 (dispatch를 거치지 않는 유일한 상태 진입점이다).
  state = sweepDeadVideoRef(applyPendingOrphanVideoClear(state));
  reloadAssets();
  reloadMedia();
  startPhotoIntake();
  // 인수하며 상태를 다시 읽었으므로 팀 로고도 새 팀 구성 기준으로 예열한다 (이미 받은 건 건너뛴다)
  primeLogos(state.teams);
  sync.publish(state);
  syncTransitionWatchdog();
  syncFullVideoWatchdog();
  render();
}

const sync = createControlSync(
  () => state,
  (name: DisplayEvent) => onDisplayEvent(name),
  (p) => {
    videoProgress = { t: p.t, d: p.d, at: Date.now() };
  },
  isLeader,
  (p) => {
    musicProgress = { ...p, at: Date.now() };
    status.musicProgress = musicProgress;
    paintMusicProgress(Date.now());
  },
);

// ---------------------------------------------------------------- 영속화 (P4 생존)

/**
 * 저장은 **모든 변경마다** 하되 150ms 디바운스로 묶는다.
 * (이름을 타이핑할 때마다 수십 KB를 직렬화하면 패널이 버벅인다. 150ms면 사람이 체감할 수 없고,
 *  창이 닫히기 전에는 beforeunload에서 강제로 한 번 더 밀어 넣는다.)
 */
let saveTimer = 0;

/** 저장 성공 여부를 반환한다 — 리더 인계(beforeYield)가 이 값으로 자리 양보를 결정한다. */
function flushSave(): boolean {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  // 조작 권한이 없는 창은 절대 쓰지 않는다 — 리더가 방금 저장한 상태를 덮어쓴다
  if (!isLeader()) return false;
  const ok = saveLocal(state);
  if (ok) savedAt = Date.now();
  const err = getSaveError();
  if (err !== status.saveError) {
    status.saveError = err;
    if (err) toast(err, 'bad');
    render();
  }
  return ok;
}

function schedulePersist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 150);
}

// ---------------------------------------------------------------- 속보 체인

let stingTimer = 0;

function scheduleBreakingChain(): void {
  window.clearTimeout(stingTimer);
  const sec = Math.max(0.2, state.settings.breakStingSec);
  stingTimer = window.setTimeout(() => {
    if (state.scene !== 'breaking') return;
    const assetId = state.sceneOpts.video.assetId;
    if (!assetId) {
      // 영상이 없으면 스팅 다음 단계로 바로 넘어간다 (행사가 멈추지 않게)
      dispatch({ type: 'scene/set', scene: 'suspects' });
      return;
    }
    // 검정 페이드 3단계 상태 머신으로 들어간다 — `scene/set 'video'`가 아니다.
    // (scene/set이면 스팅어 라우팅을 타서 검정 페이드 위에 알파 전환이 겹친다)
    // full 영상 송출은 큐시트·에셋 탭과 **같은 빌더**를 쓴다 (U124) — 이 영상에 배경 곡이
    // 지정돼 있으면 여기서도 함께 나가야 한다. 지정이 없으면 예전과 같은 한 액션이다.
    playAsset(assetId, 'suspects');
  }, sec * 1000);
}

let moodTimer: number | null = null;
let moodTimerToken = -1;
/** 지금 무장된 타이머가 어느 단계 것인가 — 단계가 바뀌면 다시 건다 */
let moodTimerPhase: AppState['sceneOpts']['moodTransition']['phase'] | null = null;
/**
 * 분위기 반전 단계 타이머 — `glitch` → `blackout` → `crossfade`를 순서대로 넘긴다 (U26).
 *
 * 단계마다 타이머를 다시 걸되 **같은 단계·같은 토큰이면 재무장하지 않는다** — 무관한 상태
 * 방송이 올 때마다 시계를 되감으면 글리치가 영영 안 끝난다.
 */
function moodStageDelayMs(phase: AppState['sceneOpts']['moodTransition']['phase']): number | null {
  // 전체 길이가 정본이고 글리치는 파생값이다 (U53) — 두 값을 따로 두면 합이 15초가 아니게 된다.
  if (phase === 'glitch') return moodGlitchMs(state.settings) ;
  if (phase === 'blackout') return Math.max(0, state.settings.moodBlackoutSec) * 1000;
  return null;
}

function syncMoodTransitionTimer(): void {
  const mood = state.sceneOpts.moodTransition;
  const delay = mood.active ? moodStageDelayMs(mood.phase) : null;
  if (delay === null) {
    if (moodTimer !== null) window.clearTimeout(moodTimer);
    moodTimer = null;
    moodTimerToken = -1;
    moodTimerPhase = null;
    return;
  }
  if (moodTimer !== null && moodTimerToken === mood.token && moodTimerPhase === mood.phase) return;
  if (moodTimer !== null) window.clearTimeout(moodTimer);
  moodTimerToken = mood.token;
  moodTimerPhase = mood.phase;
  const armedPhase = mood.phase;
  moodTimer = window.setTimeout(() => {
    moodTimer = null;
    const current = state.sceneOpts.moodTransition;
    if (!current.active || current.phase !== armedPhase || current.token !== moodTimerToken) return;
    if (armedPhase === 'glitch') {
      // 반전 영상이 없으면 검정만 깔고 끝낼 이유가 없다 — 곧바로 씬을 넘긴다
      if (!current.assetId) {
        dispatch({ type: 'mood/finish', token: current.token });
        return;
      }
      dispatch({ type: 'mood/blackout', token: current.token });
      return;
    }
    if (!current.assetId) {
      dispatch({ type: 'mood/finish', token: current.token });
      return;
    }
    // 영상은 `mood/start`에서 이미 돌고 있다 (U53) — 여기서는 레이어만 넘긴다.
    dispatch({ type: 'mood/crossfade', token: current.token });
  }, delay);
}

// ---------------------------------------------------------------- 전환 영상 stall 워치독

/**
 * display 탭이 background(hidden)면 Chrome이 video decoding을 미뤄 `#transition-video`가
 * readyState 0에 머문다. 이때는 `ended`도 `error`도 오지 않아 `transitionVideo.active`가
 * 영원히 true로 남고 씬이 바뀌지 않는다(앰비언트도 숨겨진 채). 조기 종료는 기존 token guard가
 * 수렴시키지만 **무응답**에는 안전장치가 없었다 → control이 스스로 컷으로 끊는다.
 *
 * 기존 token guard·display의 local hide/ended 재전송은 그대로 두고 **추가만** 한다.
 */
let watchdogTimer = 0;
let watchdogToken = -1;
let watchdogPhase: TransitionWatchdogPhase | null = null;
/**
 * display가 실제로 재생을 시작했다고 보고한 토큰.
 *
 * reducer를 거치지 않고 control 로컬에만 둔다 — 워치독 마감 기준일 뿐 상태가 아니고,
 * state에 넣으면 원장·직렬화 계약이 이 런타임 신호에 오염된다.
 */
let transitionBoundToken = -1;

function clearTransitionWatchdog(): void {
  if (watchdogTimer) window.clearTimeout(watchdogTimer);
  watchdogTimer = 0;
  watchdogToken = -1;
  watchdogPhase = null;
  transitionBoundToken = -1;
}

/**
 * 현재 transitionVideo 상태에 맞춰 워치독을 재무장한다.
 * 무장 기준은 (restartToken, phase) 쌍 — 새 전환이 시작되거나 단계가 넘어가면 다시 건다.
 */
function syncTransitionWatchdog(): void {
  // 조작 권한이 없는 창의 state는 인수 시점에 얼어붙어 있다(active=true인 채로 멈춘다).
  // 그대로 두면 잠긴 창 위로 "전환 영상 응답 없음" 토스트가 전환마다 떠오른다.
  if (!isLeader()) {
    clearTransitionWatchdog();
    return;
  }
  const transition = state.sceneOpts.transitionVideo;
  if (!transition.active) {
    clearTransitionWatchdog();
    return;
  }

  const phase = transitionWatchdogPhase(transition, transitionBoundToken);

  if (watchdogTimer && watchdogToken === transition.restartToken && watchdogPhase === phase) return;
  if (watchdogTimer) window.clearTimeout(watchdogTimer);

  const token = transition.restartToken;
  watchdogToken = token;
  watchdogPhase = phase;

  const asset = state.assets.find((item) => item.id === transition.assetId);
  const deadline = transitionWatchdogDeadlineMs(
    {
      durationSec: asset?.durationSec,
      switchAtSec: transition.switchAtSec,
      nextScene: transition.nextScene,
    },
    phase,
  );

  watchdogTimer = window.setTimeout(() => {
    watchdogTimer = 0;
    const current = state.sceneOpts.transitionVideo;
    if (!current.active || current.restartToken !== token) return;
    toast('전환 영상 응답 없음 — 즉시 컷으로 전환', 'bad');
    // reducer가 switched=false면 nextScene으로 수렴시킨다 — 씬이 멈춰 있는 사고를 끊는다
    dispatch({ type: 'transition/finish', token });
  }, deadline);
}

// ---------------------------------------------------------------- 설명 영상(full) 페이드 워치독

/**
 * 설명 영상 페이드 3단계(`covering → playing → revealing`) 무응답 안전장치.
 *
 * 전환 워치독과 같은 원칙이되 **끊지 않고 전진시킨다** — 마감이 지나면 해당 단계의 완료 액션을
 * 현재 토큰으로 직접 내서 다음 단계로 넘긴다. 씬이 검정에 멈춰 있는 것이 최악이기 때문이다.
 *
 * 무장 기준은 `(phaseToken, phase, 일시정지 여부)` 세 값이다. 앞의 둘만 보면 재생 중 일시정지가
 * 워치독에 반영되지 않아, 정지해 둔 영상이 원래 길이만큼 지난 뒤 강제로 끝나 버린다.
 */
type FullVideoPhase = 'covering' | 'playing' | 'revealing';

let fullWatchdogTimer = 0;
/** 현재 무장된 상황의 키 — 같으면 재무장하지 않는다(타이머가 매 dispatch마다 리셋되면 영영 안 터진다) */
let fullWatchdogKey: string | null = null;

function fullWatchdogKeyOf(video: AppState['sceneOpts']['video']): string {
  const paused = video.phase === 'playing' && video.paused ? 'paused' : 'run';
  return `${video.phaseToken}|${video.phase}|${paused}`;
}

function clearFullVideoWatchdog(): void {
  if (fullWatchdogTimer) window.clearTimeout(fullWatchdogTimer);
  fullWatchdogTimer = 0;
  fullWatchdogKey = null;
}

/**
 * `playing` 마감의 기준 길이(초).
 *
 * 일시정지에서 **재개한 경우**에는 이미 재생된 만큼을 빼야 한다 — 전체 길이로 다시 걸면
 * 마감이 실제 종료보다 한참 늦어 무응답을 못 잡는다. 진행 보고(`videoProgress`)가 신선할 때만
 * 쓰고, 아니면 에셋 전체 길이로 되돌아간다(짧게 잡아 정상 재생을 끊는 쪽이 더 나쁘다).
 */
function playingWatchdogDurationSec(resumed: boolean, assetDurationSec: number | undefined): number | undefined {
  if (!resumed) return assetDurationSec;
  const fresh = Date.now() - videoProgress.at < 2000;
  if (fresh && videoProgress.d > 0) return Math.max(0, videoProgress.d - videoProgress.t);
  return assetDurationSec;
}

/** 마감 시 낼 완료 액션 — 단계를 건너뛰지 않고 **한 칸만** 전진시킨다 */
function fullVideoAdvanceAction(phase: FullVideoPhase, token: number): Action {
  if (phase === 'covering') return { type: 'video/covered', token };
  if (phase === 'playing') return { type: 'video/tail', token };
  return { type: 'video/revealed', token };
}

function syncFullVideoWatchdog(): void {
  // 잠긴 창의 state는 인수 시점에 얼어붙는다 — 그대로 두면 토스트가 계속 떠오른다(전환 워치독과 동일)
  if (!isLeader()) {
    clearFullVideoWatchdog();
    return;
  }
  const video = state.sceneOpts.video;
  if (video.phase === 'idle' || video.phase === 'holding') {
    clearFullVideoWatchdog();
    return;
  }
  const phase: FullVideoPhase = video.phase;

  const key = fullWatchdogKeyOf(video);
  if (fullWatchdogKey === key) return;
  const resumed = fullWatchdogKey === `${video.phaseToken}|playing|paused`;

  if (fullWatchdogTimer) window.clearTimeout(fullWatchdogTimer);
  fullWatchdogTimer = 0;
  fullWatchdogKey = key;

  // 일시정지 중에는 무장하지 않는다. 키가 'paused'로 남아 있으므로 재개하면 위에서 재무장된다.
  if (phase === 'playing' && video.paused) return;

  const asset = state.assets.find((item) => item.id === video.assetId);
  const durationSec =
    phase === 'playing' ? playingWatchdogDurationSec(resumed, asset?.durationSec) : asset?.durationSec;
  const deadline = fullVideoWatchdogDeadlineMs(phase, video.fadeSec, durationSec);
  // null = 길이 미상 → 미무장. 정상 재생을 끊는 것이 무응답보다 나쁘다(패널 `⏭ 스킵`이 수동 탈출구).
  if (deadline === null) return;

  const token = video.phaseToken;
  fullWatchdogTimer = window.setTimeout(() => {
    fullWatchdogTimer = 0;
    fullWatchdogKey = null;
    const current = state.sceneOpts.video;
    if (current.phase !== phase || current.phaseToken !== token) return;
    toast('설명 영상 응답 없음 — 다음 단계로 넘어갑니다', 'bad');
    dispatch(fullVideoAdvanceAction(phase, token));
  }, deadline);
}

function onDisplayEvent(name: DisplayEvent): void {
  const musicEnded = /^music-ended:(.+)$/.exec(name);
  if (musicEnded) {
    const endedId = musicEnded[1];
    /**
     * 자동 이어재생 (U49). **리더만** 다음 곡을 건다 — 보조 창까지 걸면 같은 곡이 두 번
     * 명령되고 명령 토큰이 엇갈린다. `music/ended`를 먼저 내는 이유는 그 곡이 실제로 끝났다는
     * 사실을 상태에 남기기 위해서다(모드가 `off`면 거기서 끝난다).
     */
    dispatch({ type: 'music/ended', trackId: endedId });
    if (!isLeader()) return;
    // 이어붙는 덕킹까지 **한 배열**로 낸다 — 계약과 근거는 `musicAdvanceActions()` 주석 참고.
    const follow = musicAdvanceActions({
      endedTrackId: endedId,
      mode: state.settings.musicRepeat,
      now: Date.now(),
      fullVideoOwns: fullVideoOwnsOutput(state),
      autoDuck: state.settings.autoDuckOnVideoAudio,
    });
    if (follow.length) dispatch(follow);
    return;
  }
  const musicPausedAt = /^music-paused-at:(\d+):([\d.]+)$/.exec(name);
  if (musicPausedAt) {
    dispatch({
      type: 'music/pausedAt',
      commandToken: Number(musicPausedAt[1]),
      positionSec: Number(musicPausedAt[2]),
    });
    return;
  }
  const musicError = /^music-error:(.+)$/.exec(name);
  if (musicError) {
    dispatch({ type: 'music/failed', trackId: musicError[1] });
    toast('음악 파일을 재생하지 못했습니다 — 파일을 확인하세요', 'bad');
    return;
  }
  if (name === 'camera-ok' || name === 'camera-fail') {
    const next = name === 'camera-ok';
    if (cameraOk !== next) {
      cameraOk = next;
      render();
    }
    return;
  }
  const replayEnded = /^replay-ended:(\d+)$/.exec(name);
  if (replayEnded) {
    /**
     * 되감기가 끝까지 돌았다 — **나가는 컷도 스팅어가 덮는다** (U85).
     *
     * U81은 진입만 감쌌고 이 자리는 그대로 하드컷이었다("리플레이 끝날 때 스팅어가 안 나온다").
     * 들어오는 컷과 같은 함수를 타므로 짝이 맞고, 스팅어가 없으면 예전처럼 즉시 컷이다.
     * 토큰 대조는 reducer가 한다 — 늦게 온 보고가 다음 재생을 죽이지 못한다.
     * display는 이 왕복이 도착할 때까지 마지막 프레임을 붙잡고 있다(`replay-playback.ts`).
     */
    playReplayWithStinger({ type: 'live/replayEnded', token: Number(replayEnded[1]) });
    return;
  }
  if (name === 'replay-unavailable') {
    toast('되감을 화면이 아직 없습니다 — 중계 화면을 몇 초 더 두고 다시 누르세요', 'warn');
    dispatch({ type: 'live/replayStop' });
    return;
  }
  const replayBuffer = /^replay-buffer:(\d+)$/.exec(name);
  if (replayBuffer) {
    const next = Number(replayBuffer[1]);
    // 매초 같은 값이 와도 다시 그리지 않는다 (display는 재접속 창을 위해 계속 알린다)
    if (next !== replayBufferSec) {
      replayBufferSec = next;
      render();
    }
    return;
  }
  if (name === 'audio-locked' || name === 'audio-ok') {
    const next = name === 'audio-locked';
    if (audioLocked !== next) {
      audioLocked = next;
      render();
    }
    return;
  }
  if (isUserMuteEvent(name)) {
    // 출력 창에서 운영자가 음소거를 눌렀다 (U88). 3초마다 재통보가 오므로 값이 그대로일 때
    // 다시 그리지 않는다 (카메라·잠김 보고와 같은 관례).
    const next = name === 'audio-user-muted';
    if (displayUserMuted !== next) {
      displayUserMuted = next;
      render();
    }
    return;
  }
  if (name === 'video-ended') {
    /**
     * 영상 종료 폴백. 판단은 **`videoEndedFallbackScene()` 하나**가 한다 (U125b) —
     * 페이드 상태 머신이 도는 동안에는 `fullvideo-tail`이 종료를 맡고, 다음 큐의 전환이 이미
     * 화면을 데려가는 중이면 이 폴백은 물러난다. 근거는 `pending-scene.ts` 머리말.
     */
    const next = videoEndedFallbackScene(state);
    if (next) dispatch({ type: 'scene/set', scene: next, opts: { video: { nextScene: null } } });
    return;
  }
  const fullCovered = /^fullvideo-covered:(\d+)$/.exec(name);
  if (fullCovered) {
    dispatch({ type: 'video/covered', token: Number(fullCovered[1]) });
    return;
  }
  const fullHeld = /^fullvideo-held:(\d+)$/.exec(name);
  if (fullHeld) {
    dispatch({ type: 'video/held', token: Number(fullHeld[1]) });
    return;
  }
  const fullTail = /^fullvideo-tail:(\d+)$/.exec(name);
  if (fullTail) {
    dispatch({ type: 'video/tail', token: Number(fullTail[1]) });
    return;
  }
  const fullRevealed = /^fullvideo-revealed:(\d+)$/.exec(name);
  if (fullRevealed) {
    dispatch({ type: 'video/revealed', token: Number(fullRevealed[1]) });
    return;
  }
  const overlayHeld = /^overlay-held:(\d+)$/.exec(name);
  if (overlayHeld) {
    dispatch({ type: 'overlay/held', token: Number(overlayHeld[1]) });
    return;
  }
  const overlayEnded = /^overlay-ended:(\d+)$/.exec(name);
  if (overlayEnded) {
    const token = Number(overlayEnded[1]);
    const mood = state.sceneOpts.moodTransition;
    if (
      mood.active &&
      mood.phase === 'crossfade' &&
      state.sceneOpts.overlayVideo.active &&
      state.sceneOpts.overlayVideo.restartToken === token
    ) {
      dispatch({ type: 'mood/finish', token: mood.token });
    } else {
      dispatch({ type: 'overlay/finish', token });
    }
    return;
  }
  const sceneFadeSwitched = /^scenefade-switched:(\d+)$/.exec(name);
  if (sceneFadeSwitched) {
    dispatch({ type: 'sceneFade/switched', token: Number(sceneFadeSwitched[1]) });
    return;
  }
  const sceneFadeFinished = /^scenefade-finished:(\d+)$/.exec(name);
  if (sceneFadeFinished) {
    dispatch({ type: 'sceneFade/finish', token: Number(sceneFadeFinished[1]) });
    return;
  }
  const transitionBound = /^transition-bound:(\d+)$/.exec(name);
  if (transitionBound) {
    // 상태 변경이 아니라 워치독 기준점 이동뿐 — dispatch도 render도 필요 없다
    transitionBoundToken = Number(transitionBound[1]);
    syncTransitionWatchdog();
    return;
  }
  const transitionSwitch = /^transition-switch:(\d+)$/.exec(name);
  if (transitionSwitch) {
    const token = Number(transitionSwitch[1]);
    // 스팅어가 화면을 덮은 순간 = 리플레이 컷을 낼 순간 (U81). 한 배열로 내 방송을 한 번만 한다.
    const replay = takeReplayUnderStinger(token);
    const switched = { type: 'transition/switched' as const, token };
    dispatch(replay ? [switched, replay] : switched);
    return;
  }
  const transitionEnded = /^transition-ended:(\d+)$/.exec(name);
  if (transitionEnded) {
    const token = Number(transitionEnded[1]);
    /**
     * 안전망 — switch를 못 보고 끝난 전환(에셋 오류·워치독 강제 종료)에서도 운영자가 누른
     * 리플레이가 삼켜지지 않게 한다. 화면은 이미 걷혔으므로 여기서는 그냥 컷이다.
     */
    const replay = takeReplayUnderStinger(token);
    const finish = { type: 'transition/finish' as const, token };
    dispatch(replay ? [finish, replay] : finish);
  }
}

// ---------------------------------------------------------------- 디스패치

/**
 * 설명 영상 페이드 도중에 들어온 **씬 조작**은 페이드를 즉시 취소시킨다.
 *
 * 방송 중 오조작 복구가 페이드 완주보다 우선한다. `video/abort`를 배치 맨 앞에 끼워 넣으면
 * 진행 중 단계가 무효화되고(`phaseToken` 증가) 뒤따르는 `scene/set`은 평소대로 스팅어 라우팅을
 * 탄다. 타이머(Space)·원장·팀 편집처럼 씬과 무관한 조작은 그대로 통과시킨다.
 */
function withFullVideoAbort(requested: Action[]): Action[] {
  if (state.sceneOpts.video.phase === 'idle') return requested;
  const touchesScene = requested.some((a) => a.type === 'scene/set' || a.type === 'transition/play');
  return touchesScene ? [{ type: 'video/abort' }, ...requested] : requested;
}

/**
 * orphan 정리로 사라졌지만 **재생 중이라 아직 못 지운** 속보 연결 영상 id.
 * 다음 idle dispatch에서 반영된다 (`applyPendingOrphanVideoClear`).
 */
let pendingOrphanVideoAssetId: string | null = null;

/**
 * 속보 연결 영상을 대본 기본값으로 다시 채운다.
 *
 * 그냥 `null`로 비우면 F9 속보 체인이 영상 없이 보드로 건너뛴다. `reloadMedia`의 재충전 블록은
 * "assetId가 비어 있을 때"만 도는데, 미뤄 둔 무효화는 그 블록이 지나간 **뒤에** 반영되므로
 * 그 경로로는 영영 채워지지 않는다. 그래서 비우는 자리에서 곧바로 채운다.
 */
function refillBreakingVideo(next: AppState): AppState {
  const replacement = defaultBreakingVideoId(next.assets);
  return reducer(next, {
    type: 'sceneOpts/patch',
    patch: { video: { assetId: replacement, nextScene: replacement ? 'suspects' : null } },
  });
}

function applyPendingOrphanVideoClear(next: AppState): AppState {
  if (pendingOrphanVideoAssetId === null) return next;
  const outcome = pendingOrphanVideoRefAction(
    pendingOrphanVideoAssetId,
    next.sceneOpts.video.assetId,
    next.sceneOpts.video.phase,
  );
  if (outcome === 'wait') return next;
  pendingOrphanVideoAssetId = null;
  // `drop` = 그 사이 사람이 다른 영상을 골랐다. 미뤄 둔 값으로 그 선택을 덮지 않는다.
  if (outcome === 'drop') return next;
  return refillBreakingVideo(next);
}

/**
 * 저장본에 남은 죽은 속보 연결 영상 참조를 쓸어낸다 (`pendingOrphanVideoAssetId`는 새로고침에
 * 사라지므로 그 경로만으로는 부족하다). 에셋 목록이 아직 비어 있으면(부팅 직후 `assets/set` 전)
 * 판단 근거가 없으므로 건드리지 않는다.
 */
function sweepDeadVideoRef(next: AppState): AppState {
  if (!next.assets.length) return next;
  const dead = deadVideoAssetRef(
    next.sceneOpts.video.assetId,
    next.sceneOpts.video.phase,
    next.assets.map((a) => a.id),
  );
  return dead ? refillBreakingVideo(next) : next;
}

function dispatch(action: Action | Action[]): void {
  // 리더가 아닌 창의 조작은 여기서 전부 막힌다 (버튼·단축키·타이머 체인 공통 경로)
  if (!isLeader()) return;
  const requested = routeMoodSceneActions(
    state,
    withFullVideoAbort(Array.isArray(action) ? action : [action]),
  );
  const now = Date.now();
  // 암전 중 큐 실행은 출력이 바뀌는 배치에 해제를 붙인다 (U103). 전환 래핑이 끝난 뒤에
  // 감싸는 이유: U96이 이미 해제를 붙였는지 여기서 봐야 이중 해제가 나지 않는다.
  const list = releaseBlackoutForCue(
    state,
    routeSceneActionsThroughDefaultTransition(state, requested, now),
    now,
  );
  const before = state.scene;
  const photosBefore = state.photos.items;
  // 두 축을 따로 잡는다 (U117) — 경고는 "소리가 나가야 하는가", 덕킹 복귀는 "full 영상이
  // 화면을 쥐고 있는가"를 묻는다. 소리 없는 설명 영상에서 둘의 답이 갈린다.
  const videoAudioBefore = videoAudioOwnsOutput(state);
  const fullVideoBefore = fullVideoOwnsOutput(state);
  for (const a of list) state = reducer(state, a);
  // 미뤄 둔 orphan 무효화는 재생이 끝난 첫 idle에서 반영한다 (여기서 dispatch를 다시 부르면
  // publish·render가 두 번 돈다 — 같은 funnel 안에서 reducer만 한 번 더 태운다)
  state = applyPendingOrphanVideoClear(state);
  // 새로고침으로 보류 슬롯을 잃었어도 죽은 참조는 여기서 걸린다 (B3 — F9 워치독 미무장 방지)
  state = sweepDeadVideoRef(state);
  // **T4** 사진 목록이 바뀌었으면 `깨진 N`을 다시 센다 (`photos/clear`·`photos/remove`·흡수 배치).
  // reducer가 "바뀐 게 없으면 같은 참조"를 보장하므로 참조 비교로 충분하다.
  if (state.photos.items !== photosBefore) schedulePhotoIntegrity();
  schedulePersist();
  sync.publish(state);
  syncTransitionWatchdog();
  syncFullVideoWatchdog();
  syncMoodTransitionTimer();
  if (before !== 'breaking' && state.scene === 'breaking') scheduleBreakingChain();
  warnIfAudioLocked(list, videoAudioBefore);
  /**
   * 복귀는 **한 자리**에서 낸다 (U44 · U117). full 영상이 화면을 놓는 순간이 곧 복귀 지점이고,
   * 정상 종료·[⏭ 스킵]·워치독·씬 컷이 전부 여기로 모인다. 경로마다 unduck을 심으면
   * 반드시 한 군데를 빠뜨려 음악이 무음으로 남는다. 지연은 두지 않는다 — 스윽 올라온다.
   *
   * 진입 판정(`needsMusicDuck` → `cueOwnsScreen`)과 **같은 신호**를 써야 한다: 진입은 모드로
   * 걸고 복귀만 오디오 트랙으로 풀면, 소리 없는 설명 영상에서 내려간 음악이 영영 안 올라온다.
   */
  if (fullVideoBefore && !fullVideoOwnsOutput(state) && state.music.ducked) {
    state = reducer(state, { type: 'music/unduck' });
    schedulePersist();
    sync.publish(state);
  }
  render();
  // 램프가 걸렸으면 200ms 주기를 기다리지 않고 그 프레임부터 읽기값이 움직인다 (U43)
  if (anyVolumeRampActive(state.volumeRamps)) armMasterRamp();
}

/**
 * 에셋 재생 — 검정 페이드 3단계 상태 머신으로 들어간다.
 *
 * `scene/set 'video'`를 쓰지 않는 것이 계약이다: 그러면 스팅어 라우팅을 타서 검정 페이드 위에
 * 알파 전환이 겹친다. `restartToken`·`fadeSec`·`returnScene`은 reducer가 한 번에 세운다.
 *
 * 배열을 만드는 곳은 `fullVideoOutputActions` 하나다 (U124) — 큐시트도 같은 함수를 부른다.
 * 그 에셋에 배경 곡이 지정돼 있으면(컬링·신문지 소개 영상) `music/play`가 영상 **앞에** 실려
 * 한 배열로 나간다. 두 입구가 각자 배열을 만들면 에셋 탭에서 누를 때만 곡이 빠진다.
 */
function playAsset(assetId: string, nextScene: SceneId | null): void {
  dispatch(fullVideoOutputActions(assetId, nextScene, Date.now(), assetMusicOf(state, assetId)));
}

function reloadAssets(): void {
  void readAssetMetas().then((metas) => {
    dispatch({ type: 'assets/set', assets: metas });
  });
}

/**
 * `media/` 폴더 기본 영상 등록.
 *
 * 부팅 때 한 번 돌고, 에셋 탭 버튼으로 다시 돌릴 수 있다.
 * 이미 들어와 있는 항목은 건드리지 않으므로(assetId 고정) 몇 번을 눌러도 안전하다.
 * manifest 가 없으면 조용히 지나간다 — media 폴더를 쓰지 않는 설치가 정상 동작해야 하기 때문.
 */
let mediaBusy = false;

function reloadMedia(opts: { manual?: boolean } = {}): void {
  // 보조 창이 IndexedDB에 기본 영상을 밀어 넣으면 리더의 에셋 목록과 어긋난다
  if (mediaBusy || !isLeader()) return;
  mediaBusy = true;
  void (async () => {
    try {
      const metas = await readAssetMetas();
      // 썸네일·길이를 못 뽑은 매니페스트 영상은 건너뛰지 **않는다** → 다시 시도한다.
      // (백그라운드 탭에서 control을 열면 Chrome이 디코딩을 미뤄 probe가 실패한다.
      //  그대로 두면 목록에 영원히 썸네일 없는 항목이 남는다.)
      const broken = new Set(
        metas.filter((m) => isMediaAsset(m.id) && m.type === 'video' && m.probeFailed).map((m) => m.id),
      );
      const existingById: Record<
        string,
        {
          name: string;
          nextScene: SceneId | null;
          cueAfter: string | null;
          playMode: VideoPlayMode;
          switchAtSec: number;
          order?: number;
          sourceRevision?: string;
          audio?: boolean;
          audioSource?: AudioSource;
          audioRecheck?: boolean;
          holdEndFrame?: boolean;
        }
      > = {};
      for (const m of metas) {
        if (!isMediaAsset(m.id)) continue;
        existingById[m.id] = {
          name: m.name,
          // `null`은 "재생 직전 씬으로 복귀"라는 **사람이 고른 값**이다. `?? 'standby'`로
          // 채우면 다시 불러오기(=probe 재시도·revision 교체)마다 그 설정이 대기 화면으로
          // 되돌아간다. readAssetMetas가 이미 null을 보존해 주므로 그대로 넘긴다.
          nextScene: m.nextScene ?? null,
          cueAfter: m.cueAfter ?? null,
          playMode: m.playMode ?? 'full',
          switchAtSec: m.switchAtSec ?? 0.5,
          order: m.order,
          sourceRevision: m.sourceRevision,
          // 소리 여부도 사람이 고친 값이다 — 넘기지 않으면 재적재 때 기본값(소리 켬)으로 돌아간다.
          // 출처(U84)까지 넘겨야 "manifest 씨앗"과 "사람이 고른 값"을 구분해 정정을 전파할 수 있다.
          audio: m.audio,
          audioSource: m.audioSource,
          audioRecheck: m.audioRecheck,
          holdEndFrame: m.holdEndFrame,
        };
      }

      const res = await syncMediaManifest({
        existingIds: metas.filter((m) => !broken.has(m.id)).map((m) => m.id),
        existingById,
        hidden: state.hiddenMedia,
        probe: probeVideo,
        put: putAsset,
        orderStart: metas.length,
      });

      // manifest 에서 빠진(=파일이 지워지거나 항목이 삭제된) media 폴더 에셋은 IndexedDB 에서도
      // 지운다 — syncMediaManifest 는 추가만 하므로, 안 하면 영원히 유령으로 남는다
      // (실사고: `test_01.mp4` — manifest 에서 빠진 뒤에도 27.7MB blob 이 계속 목록에 노출됨,
      //  `docs/DEV_LOG.md` 2026-08-27 기록). `kind !== 'ok'`(manifest 없음/파싱 실패)일 때는
      // "선언된 게 하나도 없다"를 "전부 지워라"로 오독하면 안 되므로 건너뛴다.
      const orphanIds = res.kind === 'ok' ? orphanedMediaAssetIds(res.items, metas.map((m) => m.id)) : [];
      let orphanDeleteFailures = 0;
      if (orphanIds.length) {
        // 한 건이 실패해도(IndexedDB blocked 등) 나머지 정리·reloadAssets·키비주얼 재조정·
        // 재probe 예약을 통째로 건너뛰지 않는다. Promise.all은 첫 reject에서 이 블록 전체를
        // catch로 던져 버려, 지워지지 않은 유령 하나가 뒷정리 전부를 막는다.
        const deleteFailures: string[] = [];
        for (const id of orphanIds) {
          try {
            await deleteAsset(id);
          } catch {
            deleteFailures.push(mediaFileFromId(id) ?? id);
          }
        }
        orphanDeleteFailures = deleteFailures.length;
        if (deleteFailures.length) {
          toast(`${deleteFailures.join(', ')} — 목록에서 지우지 못했습니다 (다시 불러오기로 재시도)`, 'bad');
        }
        // 사라진 에셋을 속보 연결 영상으로 물고 있었으면 참조를 무효화한다(필드는 유지, 값만 초기화) —
        // scheduleBreakingChain·scenes/video 둘 다 이미 null 을 "미지정"으로 정상 처리한다.
        // 단 **재생 중에는 미룬다** — 슬롯이 null이 되면 display가 src를 잃어 tail이 오지 않는다.
        const refAction = orphanVideoRefAction(
          state.sceneOpts.video.assetId,
          state.sceneOpts.video.phase,
          orphanIds,
        );
        if (refAction === 'clear') {
          dispatch({ type: 'sceneOpts/patch', patch: { video: { assetId: null, nextScene: null } } });
        } else if (refAction === 'defer') {
          pendingOrphanVideoAssetId = state.sceneOpts.video.assetId;
        }
      }

      if (res.added || orphanIds.length) {
        if (res.added) toast(`기본 영상 ${res.added}개 불러왔습니다`);
        // 실제로 지운 수만 센다 — 실패한 항목은 아직 목록에 남아 있으므로 "정리했다"가 거짓말이 된다
        const cleaned = orphanIds.length - orphanDeleteFailures;
        if (cleaned > 0) toast(`media 폴더에서 사라진 항목 ${cleaned}개를 목록에서 정리했습니다`, 'warn');
        reloadAssets();
        // 속보 연결 영상이 아직 비어 있으면 첫 항목을 기본으로 걸어 둔다.
        // (F9 속보 체인이 영상 없이 보드로 건너뛰는 사고를 막는다. 이미 고른 게 있으면 손대지 않는다.)
        if (!state.sceneOpts.video.assetId) {
          const first = defaultBreakingVideoId(await readAssetMetas());
          if (first) {
            dispatch({
              type: 'sceneOpts/patch',
              patch: { video: { assetId: first, nextScene: 'suspects' } },
            });
          }
        }
      } else if (opts.manual) {
        if (res.kind === 'absent') toast('media 폴더에 manifest.json 이 없습니다', 'warn');
        else if (res.kind === 'error') toast('manifest.json 을 읽지 못했습니다 (JSON 형식 확인)', 'bad');
        else toast('새로 불러올 기본 영상이 없습니다');
        render();
      } else {
        render();
      }

      if (res.failed.length) {
        toast(`${res.failed.join(', ')} — media 폴더에서 찾지 못했습니다`, 'bad');
      }
      // 상태 반영은 비동기라 IndexedDB를 다시 읽어 판단한다
      const syncedMetas = await readAssetMetas();
      const keyVisualAssetId = standbyKeyVisualId(
        state.settings.keyVisualAssetId,
        syncedMetas.map((meta) => meta.id),
      );
      if (keyVisualAssetId !== state.settings.keyVisualAssetId) {
        dispatch({ type: 'settings/patch', patch: { keyVisualAssetId } });
      }
      scheduleReprobeWhenVisible(syncedMetas);
    } finally {
      mediaBusy = false;
    }
  })();
}

/**
 * 숨은 탭에서는 Chrome이 영상 디코딩을 아예 스케줄하지 않아 썸네일·길이 추출이 통째로 실패한다
 * (readyState 0 인 채로 멈춘다). 그 상태로 두면 목록에 썸네일 없는 항목이 남으므로,
 * 탭이 처음 보이는 순간 한 번 다시 시도한다. 이미 정상인 항목은 건너뛰므로 비용은 0이다.
 */
let reprobeArmed = false;

function scheduleReprobeWhenVisible(metas: AssetMeta[]): void {
  if (reprobeArmed || document.visibilityState !== 'hidden') return;
  if (!metas.some((a) => isMediaAsset(a.id) && a.type === 'video' && a.probeFailed)) return;
  reprobeArmed = true;
  const once = (): void => {
    if (document.visibilityState === 'hidden') return;
    document.removeEventListener('visibilitychange', once);
    reprobeArmed = false;
    reloadMedia();
  };
  document.addEventListener('visibilitychange', once);
}

// ---------------------------------------------------------------- 현장 사진 흡수 (리더 전용)

/**
 * 폴더 폴링 정지 함수. `null`이면 돌고 있지 않다.
 *
 * **시작(`takeOverAsLeader`)과 정지(`applyRole` 비리더 분기)는 반드시 짝이다.** 보조 창이
 * 계속 폴더를 훑으면 같은 사진을 두 창이 흡수해 IndexedDB와 상태가 어긋난다.
 */
let stopPhotoPolling: StopPolling | null = null;

/**
 * `state.photos.items` → id 집합. **items 참조로 메모이즈**한다 —
 * reducer가 "추가된 게 0건이면 같은 참조"를 보장하므로(계획 §1-4), 3초마다 500장을
 * 다시 Set으로 말아 올릴 이유가 없다.
 */
let photoIdCache: { items: readonly PhotoMeta[]; ids: ReadonlySet<string> } | null = null;

function photoKnownIds(): ReadonlySet<string> {
  const items = state.photos.items;
  if (photoIdCache && photoIdCache.items === items) return photoIdCache.ids;
  const ids = new Set(items.map((p) => p.id));
  photoIdCache = { items, ids };
  return ids;
}

/**
 * 흡수 진행 상태 → 패널 갱신. **상태(`AppState`)에 저장하지 않는다** —
 * 창마다 다르고, 매 스캔마다 저장·방송하면 원장·리더 락 경로가 오염된다.
 *
 * 흡수 중에는 장당 한 번씩 들어오므로 200ms로 묶는다(200장이면 렌더 200회가 된다).
 * 다만 폴더 권한 상태가 바뀌는 순간은 상단 경고 점이 걸린 값이라 즉시 그린다.
 */
let photoStatusTimer = 0;

function onIntakeStatus(s: IntakeStatus): void {
  // **H4** 강등된 창에는 아무것도 반영하지 않는다 — 흡수가 끊기는 사이 도착한 뒤늦은 보고가
  // `stopPhotoIntake()`가 비워 둔 `status.photoDir`을 되살려 잠긴 창에 폴더 칩이 다시 뜬다.
  if (!isLeader()) return;
  if (status.photoDir !== s.dir) {
    status.photoDir = s.dir;
    window.clearTimeout(photoStatusTimer);
    photoStatusTimer = 0;
    render();
    return;
  }
  if (photoStatusTimer) return;
  photoStatusTimer = window.setTimeout(() => {
    photoStatusTimer = 0;
    render();
  }, 200);
}

const photoDeps: PollingOpts = {
  isLeader,
  enabled: () => state.photos.settings.autoIntake,
  knownIds: photoKnownIds,
  // 커밋된 항목만 실려 온다(`putPhoto`의 oncomplete 이후) — 그대로 원장 밖 전용 액션으로 넘긴다.
  // `p2` 스탬프는 reducer가 흡수 시점의 `state.p2.unlocked`로 찍는다.
  onBatch: (items) => dispatch({ type: 'photos/add', items }),
  onStatus: onIntakeStatus,
};

/**
 * 리더가 된 순간의 사진 배선 — 저장소 영속 요청 → 폴더 권한 복원 → 고아 정리 → 폴링 시작.
 *
 * 폴더 권한은 **자동으로 요청하지 않는다**(제스처 밖 `requestPermission`은 거부되고, 거부가
 * 쌓이면 Chrome이 그 origin의 요청을 아예 무시한다). `'prompt'`면 칩·상단 경고 점만 띄우고
 * 실제 재요청은 포토 탭의 `[폴더 다시 연결]` 버튼(T4)이 한다.
 */
function startPhotoIntake(): void {
  if (!isLeader()) return;
  stopPhotoIntake();
  // 드롭·파일 선택·붙여넣기(T4)가 폴링과 **같은 중복 방지 규칙**을 타도록 기본 의존성을 건다
  setDefaultIntakeDeps(photoDeps);
  void (async () => {
    // **M8** 리더 확정 직후 1회 — 디스크 압박에 사진 blob이 조용히 evict되는 경로를 막는다
    await primePhotoStorage();
    status.photoDir = await restorePhotoDir();
    // §3-5 고아 blob 회수 + **M5** `깨진 N` 갱신 (양방향 비교)
    await pruneOrphanPhotos(photoKnownIds());
    // 위 await 사이에 자리를 넘겼을 수 있다 — 넘겼으면 폴링을 켜지 않는다
    if (!isLeader()) return;
    // 운영 origin(4173)의 사진함이 비어 있으면 로컬 AI 테스트 사진을 정상 흡수 경로로 채운다.
    // 포트별 IndexedDB에 기대지 않으므로 다른 preview에서 검증한 사진이 사라지는 사고가 없다.
    await seedBundledPhotos({
      isLeader,
      photoCount: () => state.photos.items.length,
      loadFiles: () =>
        loadBundledPhotoFiles(
          (input) => window.fetch(input),
          new URL('./photo-seed/manifest.json', document.baseURI).href,
        ),
      intake: (files) => intakeFiles(files),
      enableStandbyBackdrop: () =>
        dispatch({ type: 'photos/settings', patch: { standbyBackdrop: true } }),
    });
    if (!isLeader()) return;
    stopPhotoPolling = startPhotoPolling(photoDeps);
    render();
  })();
}

function stopPhotoIntake(): void {
  if (stopPhotoPolling) {
    stopPhotoPolling();
    stopPhotoPolling = null;
  }
  // **H4** 타이머를 끄는 것만으로는 **이미 돌고 있는** 흡수가 멈추지 않는다. 200장 배치의
  // 중간이면 남은 장수만큼 비리더 창이 IndexedDB에 blob을 계속 밀어 넣는다(dispatch는 막혀
  // 있으니 전부 고아가 된다). 세대 토큰을 올려 다음 장 경계에서 끊는다.
  abortPhotoIntake();
  // 조작 권한이 없는 창에서는 드롭 경로도 막는다 — `intakeFiles`는 dispatch를 거치지 않고
  // IndexedDB를 직접 쓰므로 리더 가드를 통과한다(에셋 등록·로고 삭제와 같은 부류).
  setDefaultIntakeDeps(null);
  // 폴더 권한 경고 점(R1)은 리더의 관심사다 — 잠긴 창에서는 값을 비워 오해를 남기지 않는다
  status.photoDir = null;
  window.clearTimeout(photoStatusTimer);
  photoStatusTimer = 0;
  window.clearTimeout(photoIntegrityTimer);
  photoIntegrityTimer = 0;
}

/**
 * **T4** `깨진 N` 재계산 예약 — `state.photos.items` **참조가 바뀔 때마다** 건다.
 *
 * 없으면: 사진 전체 삭제(`photos/clear`) 직후 패널이 `총 0 · 깨진 340`을 띄운다. `broken`은
 * 흡수가 끝날 때만 갱신되던 값이라, 상태에서 340장을 지워도 마지막으로 센 수가 그대로 남는다
 * (`refreshPhotoIntegrity`가 그때 340개를 고아로 지우고 `broken`을 0으로 되돌린다).
 *
 * 렌더와 같은 200ms로 묶는다 — `photos/add` 배치가 연달아 오는 흡수 중에 매번 `getAllKeys()`를
 * 부를 이유가 없다. **흡수가 도는 동안에는 미룬다**: `putPhoto` 커밋과 `photos/add` dispatch
 * 사이에 있는 blob은 아직 상태에 없어 고아로 오인되고, 그대로 지우면 방금 넣은 사진이 깨진다.
 */
let photoIntegrityTimer = 0;

function schedulePhotoIntegrity(): void {
  if (!isLeader() || photoIntegrityTimer) return;
  photoIntegrityTimer = window.setTimeout(() => {
    photoIntegrityTimer = 0;
    if (!isLeader()) return;
    if (isIntaking()) {
      schedulePhotoIntegrity(); // 흡수가 끝나고 나서 센다 (끝나면 흡수가 스스로 한 번 더 부른다)
      return;
    }
    void refreshPhotoIntegrity(photoKnownIds());
  }, 200);
}

/**
 * 소리를 내려는 조작이 나갔는데 출력 창이 잠겨 있으면 그 자리에서 알린다 (U48).
 *
 * 배너는 상시 떠 있지만 운영자의 눈은 방금 누른 버튼에 있다. **누른 순간** 같은 자리에서
 * 말해 주지 않으면 "왜 소리가 안 나지"를 몇 초 뒤에야 묻게 된다. 토스트는 조작당 한 번이고,
 * 잠금이 풀려 있으면 아무 일도 하지 않는다.
 */
function warnIfAudioLocked(actions: Action[], videoAudioBefore: boolean): void {
  if (!audioActionBlocked(audioLocked)) return;
  const startsMusic = actions.some((a) => a.type === 'music/play' || a.type === 'music/resume');
  if (startsMusic) {
    toast(audioLockToast('음악'), 'bad');
    return;
  }
  // **진입하는 순간에만** 띄운다. 재생 중 매 dispatch마다 검사하면 점수 하나를 고쳐도
  // 토스트가 쌓여 정작 중요한 알림이 묻힌다. 소리 있는 영상 판정은 덕킹(U44)과
  // **같은 함수**를 쓴다 — 두 곳이 다른 기준을 쓰면 음악은 내려갔는데 경고는 안 뜬다.
  if (!videoAudioBefore && videoAudioOwnsOutput(state)) toast(audioLockToast('영상'), 'bad');
}

// ---------------------------------------------------------------- 덕킹 대기 큐 (U44)

function clearDeferredCue(): void {
  if (duckedCueTimer) window.clearTimeout(duckedCueTimer);
  duckedCueTimer = 0;
  duckedCue = null;
  duckedCueRun = null;
}

function deferCue(cueIndex: number, run: () => void): void {
  clearDeferredCue();
  const sec = state.settings.musicDuckSec;
  duckedCue = scheduleDuckedCue(cueIndex, Date.now(), sec);
  duckedCueRun = run;
  duckedCueTimer = window.setTimeout(() => {
    const go = duckedCueRun;
    clearDeferredCue();
    // 리더가 아니게 됐으면 실행하지 않는다 — dispatch도 막히지만 여기서 먼저 끊는다
    if (go && isLeader()) go();
    render();
  }, Math.max(0, sec * 1000));
  render();
}

function cancelDeferredCue(): void {
  if (!duckedCue) return;
  clearDeferredCue();
  // 취소하면 음악은 원래대로 — 내려간 채로 두면 무엇이 소리를 죽였는지 알 길이 없다
  dispatch({ type: 'music/unduck' });
  render();
}

/**
 * 슬로우 리플레이 토글 (Q5). 버튼과 단축키 `R`이 함께 쓰는 유일한 입구다.
 *
 * 거절 사유를 토스트로 **말한다** — 눌렀는데 아무 일도 안 일어나는 것이 현장에서 가장 나쁘다.
 * 되감기 길이·배속은 여기서 읽지 않는다: reducer가 설정에서 스냅샷으로 굳힌다.
 */
function toggleReplay(): void {
  if (state.sceneOpts.liveOverlay.replay) {
    playReplayWithStinger({ type: 'live/replayStop' });
    return;
  }
  if (state.scene !== 'live') {
    toast('중계 화면에서만 리플레이할 수 있습니다', 'warn');
    return;
  }
  if (!state.settings.replayEnabled) {
    toast('슬로우 리플레이가 꺼져 있습니다 — [설정] 탭에서 켜세요', 'warn');
    return;
  }
  if (replayBufferSec < 1) {
    toast('되감을 화면이 아직 없습니다 — 중계 화면을 몇 초 더 두고 다시 누르세요', 'warn');
    return;
  }
  playReplayWithStinger({ type: 'live/replay', now: Date.now() });
}

/**
 * [지금부터] 반쪽 (U85). 씬 런처 리플레이 버튼의 오른쪽 절반과 단축키 `Shift+R`의 입구다.
 *
 * 사용자 원문: "10초는 좀 긴 것 같아. 버튼을 반으로 쪼개고 '지금부터' 버튼을 만들어줘.
 * 그걸 누르면 누른 시점 1초 전부터 메모리에 담겨서 그 구간만큼만 재생되도록."
 *
 * 세 갈래다. ① 재생 중이면 정지 — `R`과 같다(운영자가 두 반쪽 중 어느 쪽을 눌러도 멈춘다).
 * ② 찍어 둔 구간이 없으면 지금을 찍는다. ③ 있으면 그 구간을 튼다.
 * 거절 사유는 `toggleReplay()`와 **같은 문장**으로 말한다 — 두 반쪽이 다른 말을 하면
 * 현장에서 무엇이 막고 있는지 판단이 갈린다.
 */
function toggleReplayMark(): void {
  if (state.sceneOpts.liveOverlay.replay) {
    playReplayWithStinger({ type: 'live/replayStop' });
    return;
  }
  if (state.scene !== 'live') {
    toast('중계 화면에서만 리플레이할 수 있습니다', 'warn');
    return;
  }
  if (!state.settings.replayEnabled) {
    toast('슬로우 리플레이가 꺼져 있습니다 — [설정] 탭에서 켜세요', 'warn');
    return;
  }
  const markAt = state.sceneOpts.liveOverlay.replayMarkAt;
  const now = Date.now();
  if (markAt === null) {
    dispatch({ type: 'live/replayMark', now });
    toast('구간 시작점을 찍었습니다 — 다시 누르면 여기까지를 되감습니다', 'ok');
    return;
  }
  if (replayBufferSec < 1) {
    toast('되감을 화면이 아직 없습니다 — 중계 화면을 몇 초 더 두고 다시 누르세요', 'warn');
    return;
  }
  /**
   * 찍은 구간이 링이 덮는 길이보다 길 수 있다 — 링은 `settings.replaySec`만큼만 보장한다.
   * 그때는 **있는 만큼만** 틀고 그 사실을 말한다. 조용히 짧게 나가면 운영자는 자기가 찍은
   * 시작점이 화면에 나온 줄 알고 다음 판단을 한다.
   */
  const wantedSec = (now - markAt) / 1000;
  const seconds = Math.min(wantedSec, replayBufferSec);
  if (wantedSec - seconds > 0.05) {
    toast(`버퍼가 ${replayBufferSec}초뿐이라 그만큼만 되감습니다`, 'warn');
  }
  playReplayWithStinger({ type: 'live/replay', now, seconds });
}

/** 찍어 둔 구간 취소 (U85 — [지금부터] Shift+클릭). 없으면 아무 말도 하지 않는다. */
function clearReplayMark(): void {
  if (state.sceneOpts.liveOverlay.replayMarkAt === null) return;
  dispatch({ type: 'live/replayMarkClear' });
  toast('찍어 둔 구간을 지웠습니다', 'ok');
}

/**
 * 리플레이 컷을 스팅어로 감싸 낸다 (U81 진입 · U85 복귀). 감쌀지 말지는 `scene-routing.ts`가
 * 정한다 — 화면을 덮는 주인이 둘이 되지 않게 판단을 그 한 곳에 모아 둔 계약이다.
 *
 * 이미 전환이 돌고 있으면 새로 감싸지 않는다. 스팅어 위에 스팅어를 얹으면 앞 전환의 switch
 * 보고가 뒤 전환의 컷을 대신 열어 순서가 뒤집힌다. 그때 갈 길이 둘이다:
 * - 돌고 있는 것이 **우리 스팅어**(보류분이 있다)면 보류분을 **교체**한다. 지금 따로 내면
 *   그 컷과 곧 터질 보류분이 **둘 다** 나가 재생이 두 번 열린다(U85에서 반쪽이 둘로 늘며
 *   현실적인 경로가 됐다 — 찍고, 스팅어가 도는 0.5초 안에 다시 누르는 조작).
 * - 남의 전환(씬 이동 등)이면 보류할 자리가 없으므로 예전대로 즉시 낸다.
 */
function playReplayWithStinger(action: ReplayStingerAction): void {
  if (state.sceneOpts.transitionVideo.active) {
    if (replayUnderStinger) replayUnderStinger = { ...replayUnderStinger, action };
    else dispatch(action);
    return;
  }
  const plan = routeReplayThroughStinger(state, action, Date.now());
  if (!plan.transition) {
    dispatch(plan.deferred);
    return;
  }
  replayUnderStinger = {
    // reducer가 `now`를 restartToken으로 쓴다 — 같은 값을 여기서도 들고 있어야 보고와 맞는다
    token: plan.transition.now,
    action: plan.deferred,
  };
  dispatch(plan.transition);
}

const ctx: Ctx = {
  get state() {
    return state;
  },
  dispatch,
  refresh: () => render(),
  holdRender,
  get duckedCue() {
    return duckedCue;
  },
  deferCue,
  cancelDeferredCue,
  status,
  get tab() {
    return activeTab;
  },
  setTab(id: string) {
    activeTab = id;
    render();
  },
  playAsset,
  toggleReplay,
  toggleReplayMark,
  clearReplayMark,
  reloadAssets,
  reloadMedia,
};

// ---------------------------------------------------------------- 렌더

function captureFocus(): { fid: string; start: number | null; end: number | null } | null {
  const a = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (!a || !a.dataset?.fid) return null;
  const canSelect = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement;
  return {
    fid: a.dataset.fid,
    start: canSelect ? a.selectionStart : null,
    end: canSelect ? a.selectionEnd : null,
  };
}

function restoreFocus(snap: ReturnType<typeof captureFocus>): void {
  if (!snap) return;
  const node = app.querySelector<HTMLElement>(`[data-fid="${snap.fid}"]`);
  if (!node) return;
  node.focus();
  if (snap.start !== null && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
    try {
      node.setSelectionRange(snap.start, snap.end);
    } catch {
      /* number/color 등 selection 미지원 입력 */
    }
  }
}

const COMPACT_TAB_LABEL: Record<string, string> = {
  teams: '팀',
  p1: '1부',
  timer: '타이머',
  roster: '명단',
  p2: '2부',
  award: '시상',
  ledger: '원장',
  music: '음악',
  assets: '에셋',
  photos: '사진',
  settings: '설정',
};

/**
 * 상단 탭 바. 꼬리의 세 탭(`COLLAPSED_TAB_IDS`)은 꺽쇠 하나 뒤로 접힌다 (U78).
 *
 * 접힘 묶음은 `display: contents`라 펼쳐도 탭들이 같은 flex 줄에 그대로 이어 붙는다 —
 * 별도 상자가 생기지 않으므로 펼침/접힘에 레이아웃 점프가 없다.
 * 방향키가 접힌 탭을 건너뛰는 근거는 `visibleTabIds` 한 곳뿐이다(렌더와 같은 함수).
 */
function tabbar(): HTMLElement {
  const orderedIds = TABS.map((t) => t.meta.id);
  const unlockedIds = TABS.filter((t) => t.meta.id !== 'p2' || state.p2.unlocked).map((t) => t.meta.id);
  const storedMoreOpen = state.settings.tabbarMoreOpen;
  const moreOpen = isTabMoreOpen(storedMoreOpen, activeTab);
  // 잠긴 `p2`와 접힌 꼬리를 함께 걷어낸 목록 — 방향키·Home·End가 쓰는 유일한 기준
  const enabledIds = visibleTabIds(orderedIds, unlockedIds, storedMoreOpen, activeTab);
  const focusTab = (id: string): void => {
    app.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${id}"]`)?.focus();
  };
  const tabButton = (t: TabDef): HTMLElement => {
    const locked = t.meta.id === 'p2' && !state.p2.unlocked;
    // 잠김은 라벨 뒤에 붙이는 글자가 아니라 별도 칩 — 탭 폭이 들쭉날쭉해지지 않는다
    return el(
      'button',
      {
        class: `tabbar__btn${activeTab === t.meta.id ? ' is-on' : ''}${locked ? ' is-locked' : ''}`,
        type: 'button',
        tabIndex: activeTab === t.meta.id ? 0 : -1,
        data: { tabId: t.meta.id },
        attrs: {
          role: 'tab',
          'aria-label': locked ? `${t.meta.label}, 잠김` : t.meta.label,
          'aria-selected': activeTab === t.meta.id ? 'true' : 'false',
        },
        on: {
          click: () => {
            ctx.setTab(t.meta.id);
            focusTab(t.meta.id);
          },
          keydown: (event) => {
            if (isTabActivationKey(event.key)) {
              event.stopPropagation();
              return;
            }
            const nextId = nextTabFocus(t.meta.id, event.key, enabledIds, orderedIds);
            if (!nextId) return;
            event.preventDefault();
            event.stopPropagation();
            focusTab(nextId);
          },
        },
      },
      el('span', { class: 'tabbar__label tabbar__label--full', text: t.meta.label }),
      el('span', {
        class: 'tabbar__label tabbar__label--compact',
        text: COMPACT_TAB_LABEL[t.meta.id] ?? t.meta.label,
        attrs: { 'aria-hidden': 'true' },
      }),
      locked ? el('span', { class: 'tabbar__lock', text: '잠김' }) : null,
    );
  };
  const collapsedLabels = COLLAPSED_TAB_IDS.map((id) => findTab(id).meta.label).join(' · ');
  const activeIsCollapsed = COLLAPSED_TAB_IDS.includes(activeTab);
  return el(
    'nav',
    { class: 'tabbar', attrs: { role: 'tablist' } },
    TABS.filter((t) => !COLLAPSED_TAB_IDS.includes(t.meta.id)).map(tabButton),
    el(
      'button',
      {
        class: `tabbar__more-btn${moreOpen ? ' is-on' : ''}`,
        type: 'button',
        data: {
          fid: 'tabbar-more',
          tip: `${
            moreOpen
              ? `자주 쓰지 않는 탭(${collapsedLabels})을 다시 접습니다.`
              : `숨긴 탭(${collapsedLabels})을 펼칩니다.`
          } 행사 전에 한 번 채우면 그날 다시 열 일이 거의 없는 탭들입니다. 펼침 여부는 저장되어 다음에 열 때도 유지됩니다.${
            activeIsCollapsed ? ' 지금은 이 묶음 안의 탭을 보고 있어 접어도 화면에서 사라지지 않습니다.' : ''
          }`,
        },
        attrs: {
          'aria-expanded': moreOpen ? 'true' : 'false',
          'aria-controls': 'tabbar-more',
          'aria-label': moreOpen ? '숨긴 탭 접기' : '숨긴 탭 펼치기',
        },
        on: {
          // 강제로 펼쳐진 상태(활성 탭이 묶음 안)에서 눌러도 플래그는 내려간다 —
          // 그 탭을 떠나는 순간 사용자가 의도한 대로 접힌다.
          click: () => dispatch({ type: 'settings/patch', patch: { tabbarMoreOpen: !moreOpen } }),
        },
      },
      // 펼침 상태를 색이 아니라 형태(꺽쇠 회전)로도 알린다
      el('span', { class: 'tabbar__more-caret', text: '›', attrs: { 'aria-hidden': 'true' } }),
    ),
    el(
      'div',
      {
        class: 'tabbar__more',
        // `role="presentation"`이라 안의 탭들은 접근성 트리에서 `tablist`의 직계로 남는다
        attrs: { id: 'tabbar-more', role: 'presentation', hidden: moreOpen ? undefined : 'hidden' },
      },
      TABS.filter((t) => COLLAPSED_TAB_IDS.includes(t.meta.id)).map(tabButton),
    ),
  );
}

/**
 * 재렌더 보류 (U43). 볼륨 슬라이더를 끄는 동안 `paintApp()`이 돌면 포인터를 붙잡고 있던
 * `<input type="range">`가 교체되며 드래그가 끊긴다 — 클릭만 먹던 실사고의 원인이다.
 * 소유자 집합(`owners`)인 이유는 U104 리뷰 m2/m4 — 볼륨·음악 두 슬라이더가 이 계약을
 * 공유하면서, boolean 하나로는 한쪽을 잡아도 다른 쪽 라이브 갱신이 같이 얼어붙거나(m2)
 * 동시에 잡은 채 한쪽만 놓아도 둘 다 풀리는(m4) 문제가 났다. 계약과 그 근거는
 * `control/render-hold.ts`.
 */
let renderHold: RenderHold = IDLE_RENDER_HOLD;

function render(): void {
  const requested = requestRender(renderHold);
  renderHold = requested.hold;
  if (requested.run) paintApp();
}

function holdRender(owner: RenderHoldOwner, on: boolean): void {
  if (on) {
    renderHold = grabRender(renderHold, owner);
    return;
  }
  const released = releaseRender(renderHold, owner);
  renderHold = released.hold;
  if (released.flush) paintApp();
}

/**
 * 마지막 안전망 — 어떤 경로로든 놓는 이벤트를 놓치면 화면이 영영 멈춘 채로 남는다.
 * 창 어디서든 포인터를 떼거나 창이 포커스를 잃으면 보류를 푼다 (본체 배선은 topbar.ts·
 * control/tab-music.ts). **누가** 잡고 있었는지 여기서는 알 수 없으므로(전역 이벤트라
 * 어느 소유자의 포인터가 떨어졌는지 구분이 안 된다) `holdRender(owner, false)`가 아니라
 * `releaseAllRender`로 소유자 전원을 놓는다.
 */
function releaseAllRenderHolds(): void {
  const released = releaseAllRender(renderHold);
  renderHold = released.hold;
  if (released.flush) paintApp();
}
window.addEventListener('pointerup', releaseAllRenderHolds);
window.addEventListener('pointercancel', releaseAllRenderHolds);
window.addEventListener('blur', releaseAllRenderHolds);

/**
 * 재렌더 사이에 **살아남는 뼈대** (U72).
 *
 * `<iframe>`은 DOM에서 떨어졌다 다시 붙는 순간 브라우징 컨텍스트가 폐기되고 통째로 다시
 * 로드된다(HTML 명세). PGM 모니터를 매 렌더마다 새 트리에 옮겨 담으면 조작 한 번마다 출력
 * 미리보기가 검게 깜빡여 아무것도 확인할 수 없는 화면이 된다. 그래서 모니터에서 문서 루트까지의
 * 조상 사슬(`#app > .shell > .main > .col--left`)을 한 번만 만들고 그대로 둔다.
 *
 * 매 렌더에 갈아 끼우는 것은 **내용물**뿐이다. 감싸개 둘(`.shell__slot`)은 `display: contents`라
 * flex 배치에 아무 영향이 없다 — 기존 `.shell`·`.col--left` CSS가 그대로 통한다.
 * 좌측 열이 살아남으므로 스크롤 위치 복원도 저절로 맞는다.
 */
const topbarSlot = el('div', { class: 'shell__slot' });
const leftSlot = el('div', { class: 'shell__slot' });
const leftCol = el('div', { class: 'col col--left', data: { scroll: 'left' } });
const centerCol = el('section', { class: 'col col--center' });
const mainRoot = el('div', { class: 'main' }, leftCol, centerCol);
const shellRoot = el('div', { class: 'shell' }, topbarSlot, mainRoot);

/**
 * 좌측 열 폭 구분선 (U137). **여기서 딱 한 번 설치한다** — `.main`은 재렌더에서 살아남는
 * 뼈대(U72)라 매 렌더에 다시 부르면 구분선과 리스너가 중복으로 쌓인다. 폭은 상태가 아니라
 * 이 창의 보기 설정이라 `localStorage`만 쓰고 원장·persist·출력 창 방송에는 태우지 않는다.
 */
installSidebarResizer(mainRoot, ctx);

/**
 * PGM 카드의 출력 창 상태 한 줄 (U72). 카드는 재렌더에서 살아남는 노드라 전체 렌더로는
 * 갱신되지 않는다 — 암전 카운트다운과 같은 자리에서 텍스트만 다시 쓴다.
 */
function paintPgmStatus(connected: boolean): void {
  const view = pgmStatusView(connected);
  for (const node of document.querySelectorAll<HTMLElement>('[data-live="pgm-status"]')) {
    node.textContent = view.text;
    node.dataset.tip = view.tip;
    node.classList.toggle('is-on', connected);
  }
}

function paintApp(): void {
  status.displayConnected = Date.now() - sync.lastHelloAt() < 8000;
  status.cameraOk = cameraOk;
  // 출력 창 오디오 잠김 칩 — 선언은 `control/ctx.ts`(T6), 값 세팅은 여기(§11 L4)
  status.audioLocked = audioLocked;
  // 운영자 음소거 칩 (U88) — 잠김과 같은 관례, 다른 축
  status.displayUserMuted = displayUserMuted;
  status.savedAt = savedAt;
  status.musicProgress = musicProgress;
  // 리플레이 버퍼 칩 (Q5) — 선언은 `control/ctx.ts`, 값 세팅은 여기(오디오 잠김과 같은 관례)
  status.replayBufferSec = replayBufferSec;

  const focus = captureFocus();
  const scrollTops = new Map<string, number>();
  for (const node of app.querySelectorAll<HTMLElement>('[data-scroll]')) {
    scrollTops.set(node.dataset.scroll!, node.scrollTop);
  }

  if (!shellRoot.isConnected) {
    clear(app);
    // 좌측 열 맨 위 = PGM 모니터. 여기 한 번만 붙이고 이후 렌더는 이 노드를 건드리지 않는다.
    leftCol.append(renderPgmMonitor(ctx), leftSlot);
    app.appendChild(shellRoot);
  }
  clear(topbarSlot);
  topbarSlot.appendChild(renderTopbar(ctx));
  clear(leftSlot);
  leftSlot.append(renderLauncher(ctx), renderCuesheet(ctx));
  clear(centerCol);
  centerCol.append(
    tabbar(),
    el('div', { class: 'tabbody', data: { scroll: 'center' } }, findTab(activeTab).render(ctx)),
  );

  for (const node of app.querySelectorAll<HTMLElement>('[data-scroll]')) {
    const v = scrollTops.get(node.dataset.scroll!);
    if (v !== undefined) node.scrollTop = v;
  }
  restoreFocus(focus);

  // 현재 큐가 목록 밖으로 밀려 있으면 보이는 자리까지만 끌어온다.
  // ('nearest'라 이미 보이면 아무 일도 하지 않는다 — 조작 중 목록이 튀지 않게)
  app.querySelector('.cue.is-current')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- 라이브 갱신 (전체 재렌더 없이 숫자만)

function paintVideoProgress(now: number): void {
  const fresh = now - videoProgress.at < 2000;
  const t = fresh ? videoProgress.t : 0;
  const d = fresh ? videoProgress.d : 0;
  const pct = d > 0 ? Math.min(100, (t / d) * 100) : 0;
  const mmss = (v: number) =>
    `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(Math.floor(v % 60)).padStart(2, '0')}`;
  for (const node of document.querySelectorAll<HTMLElement>('[data-live="vtime"]')) {
    node.textContent = fresh ? `${mmss(t)} / ${mmss(d)}` : '--:-- / --:--';
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-live="vfill"]')) {
    node.style.width = `${pct}%`;
  }
}

/**
 * 200ms마다 음악 핸들·fill·시간 텍스트를 다시 그린다. 계산은 전부 `musicScrubPaint`
 * (tab-music.ts, U104 리뷰 m7) **한 곳**에서 나온다 — 여기서는 신선도 판정으로 `t`/`d`를
 * 구하고 소유자 상태(`isHeld`)를 넘기는 것, 돌아온 값을 DOM에 그대로 옮겨 쓰는 것뿐이다.
 *
 * `musicScrubPaint`가 `null`(잡고 있는 동안, U104 근본 수정)이면 **셋 다** 손대지 않고
 * 돌아온다 — 그 동안은 `updateScrubPreview`가 입력값 그대로 그리고 있다. 텍스트·fill만
 * 따로 갱신하면 잡고 있는 동안 그 둘이 옛 텔레메트리로 되돌아가거나 매 200ms 두 그림이
 * 서로 덮어써 깜빡인다(m7 리뷰에서 드러난, 기존엔 핸들에만 있던 가드가 텍스트·fill엔
 * 없었던 사각지대).
 */
function paintMusicProgress(now: number): void {
  const current = musicTrack(state.music.trackId);
  const fresh = now - musicProgress.at < 2000 && musicProgress.trackId === state.music.trackId;
  const t = fresh ? musicProgress.t : state.music.positionSec;
  const d = fresh && musicProgress.d > 0 ? musicProgress.d : current?.durationSec ?? 0;
  const scrub = musicScrubPaint({ held: isHeld(renderHold, 'music-scrub'), t, d });
  if (!scrub) return;
  for (const node of document.querySelectorAll<HTMLElement>('[data-live="music-time"]')) {
    node.textContent = scrub.timeText;
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-live="music-duration"]')) {
    node.textContent = scrub.durationText;
  }
  for (const node of document.querySelectorAll<HTMLElement>('.music-player')) {
    node.style.setProperty('--music-progress', `${scrub.fillPercent}%`);
  }
  for (const node of document.querySelectorAll<HTMLInputElement>('.music-player__range')) {
    node.max = String(scrub.max);
    node.value = String(scrub.value);
    node.setAttribute('aria-valuetext', scrub.ariaValueText);
  }
}

/**
 * 마스터 볼륨 램프의 상단 바 읽기값 (U43).
 *
 * 소리 자체는 출력 창이 자기 프레임에서 같은 서술자로 계산한다 — 여기서 하는 일은 슬라이더와
 * `%` 글자를 따라가게 하는 것과, 램프가 끝났을 때 **리더가 한 번** 최종값을 저장값으로
 * 확정하는 것뿐이다. 200ms 라이브 갱신에 얹으면 5초 램프가 25칸으로 끊겨 보이므로 rAF로 돈다.
 */
let masterRampRaf = 0;

function armMasterRamp(): void {
  if (masterRampRaf) return;
  masterRampRaf = requestAnimationFrame(tickMasterRamp);
}

function tickMasterRamp(): void {
  masterRampRaf = 0;
  if (!anyVolumeRampActive(state.volumeRamps)) return;
  const now = Date.now();
  let moving = false;
  for (const axis of VOLUME_AXES) {
    const ramp = state.volumeRamps[axis];
    if (!ramp) continue;
    paintVolumeReadout(axis, effectiveVolume(state.settings, state.volumeRamps, axis, now));
    if (!volumeRampSettled(ramp, now)) {
      moving = true;
      continue;
    }
    // 비리더 창에서는 dispatch가 막힌다 — 확정은 리더가 하고 보조 창은 그 방송으로 받는다.
    dispatch({ type: 'volume/rampSettle', axis, now });
  }
  if (moving) armMasterRamp();
}

/**
 * 덕킹 대기 칩의 남은 초 (U44). 전체 재렌더를 돌리지 않는 이유는 다른 라이브 값과 같다 —
 * 매 200ms 트리를 새로 만들면 포커스·스크롤이 리셋된다.
 */
function paintDuckCountdown(now: number): void {
  const text = duckedCue ? `${duckedCueRemainingSec(duckedCue, now)}초` : '';
  for (const node of document.querySelectorAll<HTMLElement>('[data-live="duck-count"]')) {
    node.textContent = text;
  }
}

/**
 * 암전 램프의 남은 초 (U65) — 덕킹 카운트다운과 같은 관례다.
 *
 * 전체 재렌더로 갱신하면 5초 동안 200ms마다 트리가 통째로 새로 만들어져 큐시트 스크롤과
 * 입력 포커스가 흔들린다. 숫자 하나만 제자리에 다시 쓴다.
 */
function paintBlackoutCountdown(now: number): void {
  const b = state.sceneOpts.blackout;
  const remaining = blackoutRemainingSec(
    now - b.startedAt,
    blackoutDurationMs(state.settings.blackoutSec, b.fromOpacity, blackoutTarget(b.active)),
  );
  const text = remaining > 0 ? `${remaining}초` : '';
  for (const node of document.querySelectorAll<HTMLElement>('[data-live="blackout-count"]')) {
    node.textContent = text;
    node.parentElement?.classList.toggle('is-ramping', remaining > 0);
  }
}

/**
 * [지금부터]로 찍어 둔 구간이 자라는 것을 라벨에 그대로 비춘다 (U85).
 *
 * 전체 재렌더가 아니라 텍스트만 갈아 끼우는 이유는 타이머·영상 진행 바와 같다 —
 * 200ms마다 `render()`를 돌리면 조작 중인 입력의 포커스·드래그가 끊긴다.
 */
function paintReplayMark(now: number): void {
  const markAt = state.sceneOpts.liveOverlay.replayMarkAt;
  const text = markAt === null ? '' : replayMarkLabel(now - markAt);
  for (const node of document.querySelectorAll<HTMLElement>('[data-live="replay-mark"]')) {
    node.textContent = text;
  }
}

window.setInterval(() => {
  const now = Date.now();
  paintVideoProgress(now);
  paintMusicProgress(now);
  paintBlackoutCountdown(now);
  paintReplayMark(now);
  // 램프는 dispatch·방송 어느 쪽으로 들어와도 여기서 다시 물린다 (보조 창 포함)
  if (anyVolumeRampActive(state.volumeRamps)) armMasterRamp();
  paintDuckCountdown(now);
  const remaining = remainingSec(state.timer, now);
  const txt = formatMMSS(remaining);
  const danger = remaining <= 10 && isRunning(state.timer);
  for (const node of document.querySelectorAll<HTMLElement>('[data-live="timer"], .topbar__timer-time')) {
    node.textContent = txt;
    node.classList.toggle('is-danger', danger);
  }
  const connected = now - sync.lastHelloAt() < 8000;
  paintPgmStatus(connected);
  if (connected !== status.displayConnected) render();
}, 200);

// 5초마다 IndexedDB 스냅샷 (P4 생존) — 리더만. 보조 창이 스냅샷을 덮으면 복구가 거꾸로 간다.
window.setInterval(() => {
  if (!isLeader()) return;
  void saveSnapshot(state);
}, 5000);

// ---------------------------------------------------------------- 단축키

/**
 * F1~F10이 씬으로 가는 유일한 자리. 액션은 **런처 버튼과 같은 빌더**가 만든다 (U86).
 *
 * 예전에는 여기서 `{type:'scene/set', scene}`을 맨몸으로 냈다. 그 결과 팀별 사전미션
 * (`standby/pre-mission`)에서 `F1`을 누르면 액션에 목적지 모드가 없어 `sceneSetChange()`가
 * "바뀌는 것이 없다"고 읽고 전환을 걸지 않았다 — 화면은 리듀서 폴백으로 메인 대기 화면에
 * 도착하지만 스팅어 없는 하드컷이었다(사용자 보고: "F1을 누르면 장면 전환 효과가 안 뜸").
 * 같은 조작의 액션을 두 곳에서 따로 만들면 이런 어긋남이 조용히 생긴다.
 */
function setScene(scene: SceneId): void {
  dispatch(sceneEntryAction(scene, state.sceneOpts.liveOverlay));
}

installHotkeys(
  {
    F1: () => setScene('standby'),
    F2: () => setScene('live'),
    // 퓨어 카메라 (U131) — 크롬 넷을 한 번에 끄는 프리셋. 런처 [퓨어] 버튼과 같은 빌더.
    'Shift+F2': () => dispatch(pureCameraAction()),
    F3: () => setScene('score'),
    F4: () => setScene('timer'),
    // F5는 Chrome 새로고침이라 쓰지 않는다 — 실수로 새면 콘솔이 리로드되어 리더 락 재획득
    // (300ms 조작 불가) + 잠금 상태 재확인이 필요해 현장 리스크가 크다.
    F6: () => setScene('photos'),
    F9: () => {
      if (!state.p2.unlocked) {
        toast('잠겨 있습니다 — 좌측에서 잠금을 해제하세요', 'bad');
        return;
      }
      setScene('breaking');
    },
    F10: () => {
      if (!state.p2.unlocked) {
        toast('잠겨 있습니다 — 좌측에서 잠금을 해제하세요', 'bad');
        return;
      }
      setScene('suspects');
    },
    Space: () => {
      dispatch(
        isRunning(state.timer)
          ? { type: 'timer/pause', now: Date.now() }
          : { type: 'timer/start', now: Date.now() },
      );
    },
    /**
     * 지금 울리는 자리를 이 곡의 시작 북마크로 찍는다 (U47).
     *
     * 단축키가 필요한 이유: 리허설에서 "여기다" 싶은 순간은 **듣는 도중**에 온다. 그때 음악
     * 탭으로 옮겨 버튼을 찾으면 이미 몇 초가 지나 있다. 버튼과 같은 `livePosition()`을 쓰므로
     * 두 경로가 다른 자리를 찍지 않는다. 텍스트 입력 중에는 hotkeys.ts가 개입하지 않는다.
     */
    // `hotkeys.ts`가 `event.code`를 'KeyB' → 'B'로 정규화한다 (레이아웃·IME 무관)
    B: () => {
      const trackId = state.music.trackId;
      if (!trackId) {
        toast('선택된 음악이 없습니다', 'warn');
        return;
      }
      const positionSec = musicLivePosition(ctx).t;
      dispatch({ type: 'music/bookmark', trackId, positionSec });
      // 찍혔는지·어디에 찍혔는지를 그 자리에서 알린다 — 음악 탭이 아니어도 눌리는 키다
      const saved = bookmarkOf(state.music.bookmarks, trackId);
      toast(
        saved === null
          ? '맨 앞 1초 안쪽은 북마크로 잡지 않습니다 — [처음부터]와 같은 자리입니다'
          : `북마크 ${formatMMSS(Math.round(saved))} — [음악] 탭에서 [북마크부터]로 재생합니다`,
        saved === null ? 'warn' : 'ok',
      );
    },
    /**
     * 슬로우 리플레이 토글 (Q5). 되감기가 필요한 순간은 **경기 도중**에 오고, 그때
     * 패널에서 버튼을 찾으면 이미 몇 초가 지나 있다(음악 북마크 `B`와 같은 이유).
     * 버튼과 같은 `toggleReplay()`를 쓰므로 두 경로가 다른 조건으로 갈리지 않는다.
     */
    R: () => toggleReplay(),
    /**
     * [지금부터] (U85). `R`이 "마지막 n초"를 맡고 `Shift+R`이 "여기서부터 여기까지"를 맡는다.
     * 버튼 오른쪽 절반과 같은 `toggleReplayMark()`를 쓰므로 두 경로가 갈리지 않는다.
     */
    'Shift+R': () => toggleReplayMark(),
    ArrowRight: () => goNext(ctx),
    ArrowLeft: () => goPrev(ctx),
    'Meta+Comma': () => ctx.setTab('settings'),
    'Ctrl+Comma': () => ctx.setTab('settings'),
  },
  { isBlocked: () => isModalOpen() || !isLeader() },
);

// ---------------------------------------------------------------- 부팅

installTooltips();
render();

// 로고가 IndexedDB에서 풀리면 그때 한 번 다시 그린다 (첫 프레임에만 비어 보인다).
// 리더 배선보다 **먼저** 걸어야 한다 — BroadcastChannel이 없는 환경은 곧바로 리더가 되어
// takeOverAsLeader()에서 primeLogos를 부르는데, 그때 리스너가 없으면 로고가 영영 안 그려진다.
setLogoListener(() => render());
primeLogos(state.teams);

booted = true;
// 리더가 확정된 뒤에야 에셋 적재·상태 방송을 시작한다.
// (기본 영상은 IndexedDB가 아니라 파일로 배포된다 — 첫 실행에 바로 보여야 하지만,
//  보조 창이 IndexedDB와 localStorage를 건드리면 리더의 상태를 덮어쓴다.)
applyRole(leader.role());

// 창이 닫히기 직전에는 디바운스를 기다리지 않고 즉시 저장한다
window.addEventListener('beforeunload', () => {
  flushSave();
});

// 정상 종료를 남은 창에 알린다 — 없으면 heartbeat 단절 3초 + probe 700ms 동안 아무도
// 조작할 수 없다(리더 탭을 닫는 순간 ~3.7초 먹통). beforeunload와 달리 pagehide는
// bfcache·모바일 종료 경로에서도 확실히 불린다.
window.addEventListener('pagehide', () => {
  flushSave();
  leader.close();
});

// pagehide로 리더 락을 반납했으므로, bfcache에서 되살아난 창은 조작 권한을 영영 못 얻는다.
// 그 좀비 상태로 두느니 새로 부팅한다 — 상태는 방금 localStorage에 밀어 넣었으므로 손실이 없다.
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted) window.location.reload();
});
