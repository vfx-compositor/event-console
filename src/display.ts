/**
 * display.html 엔트리 — 프로젝터 출력 창.
 *
 * 역할은 셋뿐이다: (1) 상태 구독 (2) 씬 렌더 (3) 런타임 리소스(카메라·영상·컨페티) 부착.
 * **상태를 바꾸지 않는다.** 영상 종료 같은 사건만 control에 보고하고, 전환 판단은 control이 한다.
 */

import './styles/tokens.css';
import './styles/display.css';

import { createDisplaySync, type DisplayEvent } from './sync';
import { activeLedger, createInitialState, loadLocal, normalizeReplaySec } from './state';
import {
  SegmentRing,
  isReplayOwner,
  pickMimeType,
  replayBufferedSec,
  segmentMsFor,
  shouldRecordReplay,
  videoOnlyStream,
} from './replay-ring';
import { ReplayPlayback } from './replay-playback';
import { formatMMSS, formatTenths, isRunning, remainingSec } from './timer';
import { getAsset, getPhoto, playableBlob } from './db';
import { cameraTransform, CameraSession } from './camera-session';
import {
  fadeOpacityAt,
  isFadeComplete,
  volumeForOpacity,
  type FadeDirection,
} from './fade';
import { DEFAULT_TEAM_LOGOS, primeLogos, setLogoListener } from './logos';
import { EVENT_MARK_SRC, reorderSignature } from './scenes/luxe-grid';
import {
  AUDIO_LOCK_FIX,
  AUDIO_LOCK_TITLE,
  classifyPlayRejection,
  pendingAudioResumePlan,
} from './audio-lock';
import {
  advancePhoto,
  clampIntervalSec,
  kenBurnsFor,
  nextPhotoSessionSeed,
  photoOrderForScene,
  photoQueue,
  type KenBurns,
} from './photos';
import { pickScene, renderScene, tickScene } from './scenes';
import { GAME_STEADY_IMAGES } from './scenes/game';
import { P2_STEADY_IMAGES } from './scenes/submit';
import {
  photoFilterClasses,
  photoLayerAttrs,
  photoPlaybackEnabled,
  photoTransitionPresentation,
} from './scenes/photos';
import { shouldUseBuiltInSceneFx } from './scene-routing';
import { animatedNumber, resetAnimations } from './scenes/anim';
import { FX_DURATION, SceneFx } from './scenes/transition';
import { Confetti } from './scenes/confetti';
import { Ambient } from './scenes/ambient';
import { fmtPoints } from './scoring';
import { musicTrack } from './music';
import {
  classifyMusicPlayRejection,
  musicEndedTrackId,
  musicFadePlan,
  musicPlaybackCommand,
} from './music-playback';
import {
  blackoutAudioAxis,
  blackoutAudioMoving,
  cameraMuted,
  cancelTeardown,
  idleTrack,
  isAudible,
  outputMuted,
  overlayMuted,
  policyGain,
  rampGain,
  requiresDocumentPresence,
  setGain,
  stepGain,
  teardownDecision,
  trackVolume,
  TRACK_FULL_GAIN,
  type GainTeardown,
  type GainTrack,
} from './audio-gain';
import { anyVolumeRampActive, effectiveVolume } from './volume-ramp';
import { isRampDone, makeRamp, rampValueAt, type ValueRamp } from './fade-ramp';
import {
  backdropRuntimeOn,
  initialBackdropFade,
  standbyBackdropLayers,
  standbyCrossfadeScene,
  standbyPhotoEntryCut,
  standbyVideoResyncTime,
  stepBackdropFade,
} from './standby-crossfade';
import { displayScaleForShortcut, fitDisplayScale } from './display-scale';
import { createFullscreenGate, isFullscreenToggleKey } from './display-fullscreen';
import {
  effectiveUserMute,
  parseStoredUserMute,
  storedUserMuteValue,
  userMuteButtonHidden,
  userMuteEvent,
  userMuteHint,
  userMuteLabel,
  userMuteTip,
  USER_MUTE_KEY,
} from './display-windowed';
import {
  displayOperatorControlHidden,
  displayOperatorOverlayVisible,
} from './display-presentation';
import { shouldEnterVideoAudioTail, shouldEnterVideoTail } from './video-hold';
import { FADE_BASE_COLOR } from './scripted-outro';
import { sceneFadeFrame } from './scene-fade';
import { selectVisualState } from './pgm';
import { blackoutDurationMs, blackoutOpacity, blackoutTarget } from './blackout';
import { moodGlitchOpacity, moodOverlayLayer, moodOwnsOverlay, moodVisualState } from './mood-visual';
import { LIVE_FRAME_DARK_SRC, LIVE_FRAME_SCRIM_FILL, liveFrameVisible } from './live-frame';
// 소리 있는 오버레이 판정은 덕킹과 **같은 함수**를 쓴다 (U101b) — 두 곳이 기준을 달리하면
// 음악은 내려갔는데 오버레이는 무음이거나, 그 반대가 된다.
import { overlayPlaysAudio } from './music-duck';
import {
  coverSourceRect,
  glitchFrame,
  glitchIntensityAt,
  moodBlackAt,
  sortCoverageAt,
  sortThresholdAt,
  moodGlitchMs,
  moodTotalMs,
} from './mood-glitch';
import { pixelSortInPlace } from './pixel-sort';
import { overlayEndEvent } from './overlay-video';
import {
  isTransitionSwitchDue,
  normalizeTransitionPlayback,
  pickTransitionPreloadAssetId,
  playTransitionWithAudioFallback,
  preloadTransitionVideo,
  shouldRepeatTransitionEnd,
  transitionAmbientPresentation,
  TRANSITION_STINGER_GAIN,
} from './transition-video';
import {
  P2_SCENES,
  TEAM_IDS,
  type AppState,
  type MusicState,
  type PhotoMeta,
  type PhotoOrder,
  type PhotoSettings,
  type SceneId,
} from './types';

const stage = document.getElementById('stage') as HTMLElement;
const viewport = document.getElementById('viewport') as HTMLElement;
const fsBtn = document.getElementById('fs-btn') as HTMLButtonElement;

/**
 * 이 창이 **PGM 모니터**인가 (U72) — 조작 패널 좌측에 뜨는 `display.html?monitor=1` iframe.
 *
 * 모니터는 진짜 출력 창과 **같은 코드**로 같은 그림을 그린다. 그래야 씬·전환·오버레이·동결이
 * 따로 놀지 않는다. 다른 것은 넷뿐이다: 사건을 보내지 않고(중복 처리 방지), 카메라를 열지 않고
 * (같은 장치를 두 창이 잡으면 프레임이 떨어진다), 소리를 내지 않고, rAF를 15fps로 줄인다
 * (출력 창과 같은 머신에서 60fps 루프가 두 벌 도는 것을 막는다).
 *
 * `?monitor=1`은 리플레이 소유권 판정(`isReplayOwner`)이 이미 쓰던 표식이다 — 같은 질문에
 * 두 개의 답이 생기지 않게 아래에서 둘을 묶어 둔다.
 */
const MONITOR = new URLSearchParams(location.search).has('monitor');

// ---------------------------------------------------------------- 창 모드 음소거 버튼 (U88)
//
// 운영자가 **이 창에서만** 소리를 끄는 토글이다. 왜 자동이 아니라 버튼인지, 왜 창 단위인지는
// `display-windowed.ts` 헤더에 있다(자동 무음으로 만들었다 되돌린 경위 포함).

/** 운영자가 기억시킨 선택. `sessionStorage`에만 남고 방송하지 않는다 */
let userMuteWish = parseStoredUserMute(readStoredUserMute());
/** 지금 전체화면인가. `fullscreenchange`와 부팅에서만 갱신된다 */
let displayFullscreen = Boolean(document.fullscreenElement);
/** 실제로 미디어에 걸리는 음소거 — 전체화면에서는 언제나 거짓이다 */
let userMuted = effectiveUserMute(userMuteWish, displayFullscreen, MONITOR);

/**
 * `sessionStorage` 읽기. 접근 자체가 던지는 환경(사생활 모드·서드파티 차단)이 있으므로
 * 감싼다 — 저장이 안 되는 것은 "이번 창에서 기억하지 않는다"일 뿐 기능이 죽을 이유가 아니다.
 */
function readStoredUserMute(): string | null {
  try {
    return sessionStorage.getItem(USER_MUTE_KEY);
  } catch {
    return null;
  }
}

function writeStoredUserMute(muted: boolean): void {
  try {
    sessionStorage.setItem(USER_MUTE_KEY, storedUserMuteValue(muted));
  } catch {
    /* 저장 못 해도 이번 창에서는 정상 동작한다 */
  }
}

/**
 * 각 출력 미디어가 마지막으로 요구한 **"소스 자체의 음소거"** 판정.
 *
 * 음소거를 켜고 끌 때 여섯 엘리먼트의 `muted`를 다시 계산해야 하는데, 그 값의 절반은
 * 여기서 알 수 없다(에셋 메타·카메라 설정·정책 폴백·오버레이 소유권). 각 호출부가 이미 답을
 * 알고 있으므로 그 답을 적어 두고, 토글 순간에는 **세 축을 다시 곱하기만** 한다.
 * 이 표가 없으면 토글 핸들러가 여섯 곳의 판정을 전부 복제하게 되고, 그 복제본이 원본과
 * 어긋나는 날 소리가 한 자리에서만 안 난다.
 */
const assetMuteWish = new Map<HTMLMediaElement, boolean>();

/**
 * **모든 출력 미디어의 유일한 `muted` 쓰기 경로.** (§3 계약의 muted 판)
 *
 * `replayEl`만 예외다 — 녹화 스트림에 오디오 트랙이 아예 없어 소리의 주인이 없다.
 */
function setOutputMuted(el: HTMLMediaElement, assetMuted: boolean): void {
  assetMuteWish.set(el, assetMuted);
  el.muted = outputMuted({ monitor: MONITOR, userMuted, assetMuted });
}

/**
 * 소리가 나갈 수 있는 출력 미디어 **전부** — 음악 덱 2 · 설명 영상 · 오버레이 · 카메라 ·
 * 전환 스팅어(U102).
 *
 * `replayEl`은 없다. 녹화 스트림에 오디오 트랙이 아예 없어 영구 muted이고, 소리의 주인이 없다.
 *
 * 목록을 함수로 두는 이유는 선언 순서다 — 이 여섯은 모듈 본문 여기저기서 만들어지고
 * `refreshOutputMute`는 그보다 위에 있다. 호출은 전부 부팅 이후라 실행 시점에는 다 존재한다.
 */
function outputMediaElements(): HTMLMediaElement[] {
  return [musicDecks[0].el, musicDecks[1].el, videoEl, overlayVideoEl, camEl, transitionVideoEl];
}

/**
 * 음소거 상태가 바뀌었다 — 여섯 엘리먼트의 `muted`를 그 자리에서 다시 계산한다.
 *
 * **`assetMuteWish`가 아니라 위 목록을 돈다.** 표에만 의존하면 아직 한 번도 소리 판정을 받지
 * 않은 엘리먼트가 통째로 빠진다 — 실측 사고: 음소거를 눌렀는데 `video.video-el`(그 시점 idle,
 * `src` 없음)만 `muted: false`로 남았다. `applyVideoAudioPolicy`는 재생 진입에서야 처음 도는데,
 * 그 재생이 토글 **직후**에 시작되면 첫 프레임이 소리를 내고 나서야 꺼진다.
 * 기록이 없는 엘리먼트는 `assetMuted: false`(소스 자체는 멀쩡하다)로 보아, 음소거 중이면
 * 지금 당장 muted가 되고 해제하면 원래대로 돌아간다.
 *
 * 램프는 건드리지 않는다. 게인 계산은 음소거 중에도 계속 돌았으므로, `muted`가 걷히는 순간
 * **진행 중이던 페이드가 그 위치에서 그대로 들린다.** 여기서 별도 페이드를 걸면 두 곡선이
 * 겹쳐 오히려 튄다.
 */
function refreshOutputMute(): void {
  for (const el of outputMediaElements()) setOutputMuted(el, assetMuteWish.get(el) ?? false);
}

/**
 * 음소거 버튼 — 전체화면 버튼 **옆**에 둔다.
 *
 * 마크업은 `display.html`에 있다(`#fs-btn`과 짝이라 같은 자리에 있어야 셸만 보고도 두 손잡이가
 * 보인다). 라벨·툴팁·`aria-pressed`는 아래 `updateMuteBtn()`이 한 곳에서 그린다.
 */
const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
const muteBtnLabel = document.createElement('span');
muteBtnLabel.className = 'mute-btn__label';
const muteBtnHint = document.createElement('span');
muteBtnHint.className = 'mute-btn__hint';
muteBtn.append(muteBtnLabel, muteBtnHint);

/**
 * 게임 대기 화면의 종목별 고정 이미지를 부팅 때 미리 받아 둔다 (U29).
 *
 * 큐 순서상 이 화면 바로 앞은 소개 영상이고, 그 영상은 마지막 프레임에서 멈춰 있다가
 * 씬이 바뀐다. 그 순간 디코딩을 시작하면 1920×1080 JPEG가 뜨기 전 한두 프레임이 비어
 * 검정으로 새어 나온다 — 전환 영상을 `preload='auto'`로 예열하는 것과 같은 이유다.
 * 네 장뿐이고 씬에 붙박인 그림이라 조건 없이 전부 받는다.
 */
for (const src of Object.values(GAME_STEADY_IMAGES)) {
  const warm = new Image();
  warm.decoding = 'async';
  warm.src = src;
}

/**
 * 2부 단계 대기 이미지는 **잠금이 풀린 뒤에** 받는다 (U97).
 *
 * 1부 대기 이미지와 달리 부팅 때 조건 없이 받지 않는다: 1부 내내 잠겨 있는 화면의 파일을
 * 미리 긁어 오면 네트워크 탭에 후반 에셋이 그대로 드러난다(P3 비밀 유지의 정신). 해제 순간
 * 한 번만 받아 두면 큐가 대기화면으로 넘어가는 프레임에서 검정이 새지 않는다 — U29와 같은 이유.
 */
let p2SteadyWarmed = false;
function warmP2SteadyImages(): void {
  if (p2SteadyWarmed) return;
  p2SteadyWarmed = true;
  for (const src of Object.values(P2_STEADY_IMAGES)) {
    const warm = new Image();
    warm.decoding = 'async';
    warm.src = src;
  }
}

/**
 * 오피셜 팀 배지 4장도 같은 이유로 부팅 때 받아 둔다 (U31).
 * 스코어바·리더보드·명단·시상이 전부 이 그림을 쓰는데, 씬이 바뀌는 프레임에서 받기 시작하면
 * 아바타가 한두 프레임 빈 원으로 보인다. 512px PNG 네 장뿐이라 조건 없이 전부 받는다.
 */
for (const src of [...DEFAULT_TEAM_LOGOS, EVENT_MARK_SRC]) {
  const warm = new Image();
  warm.decoding = 'async';
  warm.src = src;
}

let state: AppState = loadLocal() ?? createInitialState();

/**
 * PGM FREEZE (U75) — 얼어붙은 순간의 상태 사본. 얼지 않았으면 `null`.
 *
 * 상태가 아니라 **이 창의 로컬 값**이다. 상태 안에 상태를 복사해 넣으면 저장·방송 크기가
 * 두 배가 되고 스냅샷이 스냅샷을 품는 재귀가 된다. `frozen` 불린 하나만 방송하고, 무엇을
 * 얼릴지는 그리는 쪽이 각자 판단한다 — 창이 여럿이어도 같은 프레임에서 같은 그림이 나온다.
 */
let frozenSnapshot: AppState | null = null;

/**
 * 지금 **화면이 그려야 할** 상태 (U75).
 *
 * 시각 경로는 전부 이 게터 하나를 읽는다. 경로마다 "얼었나?"를 따로 물으면 한 프레임 안에서
 * 어떤 것은 옛 상태를, 어떤 것은 새 상태를 그린다 — 스코어바만 갱신된 얼어붙은 화면이
 * 나가는 사고다. 반대로 **소리(음악 덱·볼륨 축·게인)·리플레이·암전·카메라**는 라이브
 * `state`를 그대로 읽는다. 자세한 경계는 `pgm.ts` 첫 주석에 있다.
 */
function visualState(): AppState {
  return selectVisualState(state.pgm.frozen, frozenSnapshot, state);
}

/**
 * 스냅샷 수명 — false→true에 잡고 true→false에 버린다. paint의 **맨 앞**에서 한 번만 돈다.
 * 해제는 전환으로 감싸지 않는다: 라우팅 경계는 control 쪽이고 display는 상태를 그대로 그린다.
 */
function syncFreezeSnapshot(): void {
  if (state.pgm.frozen) {
    if (!frozenSnapshot) frozenSnapshot = state;
  } else if (frozenSnapshot) {
    frozenSnapshot = null;
  }
}

/**
 * 지금 실제로 들려야 하는 마스터 볼륨 (U43).
 *
 * `settings.masterVolume`을 직접 읽는 자리는 여기 하나뿐이다. 램프가 도는 동안에는 저장값이
 * 아직 옛 값이므로, 어딘가 한 군데라도 저장값을 그대로 쓰면 그 엘리먼트만 5초 뒤에 뚝 바뀐다.
 * 램프 서술자는 control이 방송하고 계산은 창마다 각자 한다 — 같은 서술자에서 같은 곡선이
 * 나오므로 창이 몇 개든 어긋나지 않는다.
 */
function heardMaster(now = Date.now()): number {
  return effectiveVolume(state.settings, state.volumeRamps, 'media', now);
}

/** 행사 BGM 축 (U45). 덕킹(U44)은 여기에만 곱해진다. */
function heardMusic(now = Date.now()): number {
  return effectiveVolume(state.settings, state.volumeRamps, 'music', now);
}

/**
 * 행사 BGM 덕킹 축 (U44) — 소리 있는 영상이 화면을 쥐는 동안 **음악만** 내린다.
 *
 * 트랙 게인(`deck.track`)과 **곱**으로 합성한다. 같은 게인을 두고 다투게 하면 덕킹이 끝나는
 * 순간 재생·크로스페이드 램프가 덮여 소리가 튄다 — 마스터 볼륨을 매 프레임 곱으로만 합성하는
 * 것과 같은 이유다. 영상·카메라에는 걸리지 않는다(U45가 이 축을 정식으로 나눈다).
 */
const musicDuck = { value: 1, ramp: null as ValueRamp | null, applied: false };

function tickMusicDuck(now: number): void {
  if (state.music.ducked !== musicDuck.applied) {
    musicDuck.applied = state.music.ducked;
    // 시작값은 언제나 **현재 값** — 다 내려가기 전에 영상이 끝나도 그 자리에서 되올라온다
    musicDuck.ramp = makeRamp(
      musicDuck.value,
      state.music.ducked ? 0 : 1,
      state.settings.musicDuckSec,
      now,
    );
  }
  if (!musicDuck.ramp) return;
  musicDuck.value = rampValueAt(musicDuck.ramp, now);
  if (isRampDone(musicDuck.ramp, now)) {
    musicDuck.value = musicDuck.ramp.to;
    musicDuck.ramp = null;
  }
}

/**
 * 운영자 암전의 오디오 축 값 (U95) — 마지막으로 적용한 값만 들고 있는다.
 *
 * 덕킹처럼 로컬 램프를 굴리지 않는 이유: 암전의 램프 서술자는 **이미 상태에 있다**
 * (`fromOpacity`·`startedAt` + 거리 비례 길이). 값만 파생하면 창이 몇 개든, 도중에 새로
 * 열려도 같은 곡선의 같은 지점에서 이어진다. 이 변수는 50ms 오디오 루프가 "아직 움직이는가"를
 * 판정하는 데만 쓴다.
 */
let blackoutAudio = 1;



/**
 * 화면에는 보이지 않지만 display/OBS 출력에 붙는 행사 BGM. **덱 두 개**인 이유는 곡 교체
 * 크로스페이드다(U18) — 하나뿐이면 `src`를 바꾸는 순간 이전 곡이 그 자리에서 끊긴다.
 *
 * 상태에는 여전히 요청(trackId·playing·commandToken)만 있고, 페이드 상태 머신은 전부 여기 로컬이다.
 */
interface MusicDeck {
  el: HTMLAudioElement;
  boundTrackId: string | null;
  pendingSeek: number | null;
  /** 볼륨·램프·정리 예약 — 다른 미디어와 **같은 매니저**를 쓴다 (U27) */
  track: GainTrack;
}

let appliedMusic: MusicState = {
  trackId: null,
  playing: false,
  positionSec: 0,
  commandToken: -1,
  ducked: false,
  bookmarks: {},
  fadeIn: true,
};
let lastMusicProgressAt = 0;
/** 페이드 아웃이 끝나 멎은 뒤 마지막 보고를 이미 보냈는가 (같은 값 반복 방송 중단) */
let musicProgressParked = false;
let musicDeckIndex = 0;

function createMusicDeck(): MusicDeck {
  const el = document.createElement('audio');
  el.hidden = true;
  // 'metadata'로는 재생 시작에 버퍼링이 걸려 musicFadeSec=0(컷)일 때 첫 음절이 잘린다.
  // BGM은 몇 MB짜리 로컬 파일이라 통째로 미리 받아 두는 비용이 실질적으로 없다.
  el.preload = 'auto';
  el.controls = false;
  // 새 덱은 무음에서 시작한다. 값 자체는 매니저 계산을 그대로 쓴다 — 볼륨을 쓰는 규칙이
  // 여기만 예외가 되면 "el.volume은 매니저만 쓴다"는 계약에 구멍이 생긴다.
  el.volume = trackVolume(heardMusic(), idleTrack(0));
  // PGM 모니터는 그림만 본다 — 음악까지 두 벌 나가면 현장에서 에코가 된다 (U72).
  // 창 모드에서도 같은 이유로 무음이다 (U88) — 판정은 `setOutputMuted` 한 곳이 한다.
  setOutputMuted(el, false);
  document.body.appendChild(el);
  const deck: MusicDeck = { el, boundTrackId: null, pendingSeek: null, track: idleTrack(0) };
  el.addEventListener('loadedmetadata', () => {
    if (deck.pendingSeek === null) return;
    el.currentTime = Math.min(
      deck.pendingSeek,
      Number.isFinite(el.duration) ? el.duration : deck.pendingSeek,
    );
    deck.pendingSeek = null;
  });
  el.addEventListener('ended', () => {
    // 페이드 아웃 중인 옛 덱의 ended는 상태와 무관하다 (교체 직전 곡의 queued ended와 같은 이유)
    if (deck !== currentMusicDeck()) return;
    const trackId = musicEndedTrackId(el.ended, deck.boundTrackId, state.music.trackId);
    if (trackId) emit(`music-ended:${trackId}`);
  });
  return deck;
}

const musicDecks: [MusicDeck, MusicDeck] = [createMusicDeck(), createMusicDeck()];

function currentMusicDeck(): MusicDeck {
  return musicDecks[musicDeckIndex];
}

const sync = createDisplaySync((next) => {
  state = next;
  // **여기서 스냅 플래그를 세우지 않는다.** 매 방송마다 세우면 `stepBackdropFade`가 늘 스냅
  // 분기로 가서 램프가 한 번도 만들어지지 않는다 — 크로스디졸브가 통째로 죽는다.
  // 첫 방송을 받았다는 사실만 알리고, 스냅 종료 판단은 순수 함수 하나가 한다.
  sawFirstSyncState = true;
  // 상태가 오면 즉시 그린다. rAF만 믿으면 창이 가려졌을 때(백그라운드 탭 throttling)
  // 화면이 이전 씬에 멈춘 채로 남는다 — 송출 화면에서는 치명적이다.
  paint();
}, { monitor: MONITOR });

function emit(name: DisplayEvent) {
  sync.emit(name);
}

function clearMusicDeck(deck: MusicDeck): void {
  deck.el.pause();
  deck.el.removeAttribute('src');
  deck.el.load();
  deck.pendingSeek = null;
  deck.boundTrackId = null;
  deck.track = idleTrack(0);
}

function playMusicDeck(deck: MusicDeck, trackId: string, commandToken: number): void {
  void deck.el.play().catch((error: unknown) => {
    const outcome = classifyMusicPlayRejection(error, commandToken, state.music.commandToken);
    if (outcome === 'ignore') return;
    if (outcome === 'autoplay-lock') {
      needsAudioUnlock = true;
      reportAudioState();
      return;
    }
    clearMusicDeck(deck);
    emit(`music-error:${trackId}`);
  });
}

function startMusicRamp(
  deck: MusicDeck,
  to: number,
  now: number,
  after: GainTeardown,
  fadeSec: number = state.settings.musicFadeSec,
): void {
  // 시작값은 항상 **현재 게인** — 페이드 중 pause→play 같은 역전에서 볼륨이 튀지 않는다
  deck.track = rampGain(deck.track, to, fadeSec, now, after);
}

/**
 * 음악 덱을 "울리는" 상태로 올리는 **유일한** 자리 (U48 후속).
 *
 * 정상 재생 경로(`applyMusic`의 `plan.incoming === 'fade-in'`)와 잠금 해제 재개
 * (`resumePendingAudio`)가 같은 목표를 써야 한다. 예전에는 두 곳이 각자 `1`을 적고 있어서,
 * 목표를 바꾸면 한쪽만 고칠 수 있는 구조였다.
 *
 * ## 왜 목표가 트랙 게인 만점인가 — 덕킹은 여기서 빼지 않는다
 * U44 덕킹은 `tickAudioGains`가 `musicDuck.value`로 **곱해 합성하는 별도 축**이다
 * (`heardMusic(now) * musicDuck.value`). 트랙 게인과 다투지 않으므로 여기서 목표를 내리면
 * 두 축이 **이중으로** 걸려, 영상이 끝나 덕킹이 1로 돌아와도 음악이 절반만 돌아온다.
 * 지금 덕킹 중인지 아닌지를 이 함수가 알 필요가 없다는 것이 그 축 분리의 요점이다.
 */
function fadeInMusicDeck(deck: MusicDeck, now: number): void {
  startMusicRamp(deck, TRACK_FULL_GAIN, now, 'none');
}

/**
 * `fadeInMusicDeck`과 목표는 같지만 램프 없이 즉시 올린다 (U122).
 *
 * `fadeSec: 0`을 주면 `makeRamp`가 즉시-완료 램프를 만들어(U18 컷 강등과 같은 경로 —
 * `teardownDecision`의 `fadeSec<=0` 분기와 같은 산수), 바로 뒤에 도는 `tickAudioGains`가
 * 같은 프레임에서 게인을 목표까지 밀어 올린다. 목표가 트랙 게인 만점인 이유는
 * `fadeInMusicDeck`과 동일 — 덕킹은 여기서 빼지 않는 별도 축이다.
 */
function cutInMusicDeck(deck: MusicDeck, now: number): void {
  startMusicRamp(deck, TRACK_FULL_GAIN, now, 'none', 0);
}

/**
 * 게인 램프를 한 프레임 전진시키고 마스터 볼륨과 곱해 element에 심는다.
 *
 * 마스터 볼륨은 **매 프레임 곱으로만** 합성한다 — 램프에 섞어 넣으면 페이드 도중 마스터를
 * 움직였을 때 페이드가 그 자리에서 튄다. 이렇게 두면 마스터 변경은 언제나 즉시 반영된다.
 */
/**
 * 소리가 나는 **모든** 미디어의 게인을 한 프레임 전진시키고 element에 심는다 (U27).
 *
 * `el.volume`을 쓰는 자리는 여기 하나뿐이다. 마스터 볼륨은 매 프레임 곱으로만 합성하므로
 * 페이드 도중 마스터를 움직여도 페이드가 튀지 않고 즉시 반영된다.
 */
function tickAudioGains(now: number): void {
  tickMusicDuck(now);
  /**
   * 운영자 암전의 오디오 축 (U95) — **모든** 출력 엘리먼트에 곱한다.
   *
   * 값은 화면과 **같은 서술자**(`state.sceneOpts.blackout` + `settings.blackoutSec`)에서 나오므로
   * 그림이 절반 어두워진 순간 소리도 절반이다. 트랙 게인·`.muted`는 건드리지 않는다 —
   * 영상 꼬리 페이드는 이 아래에서 그대로 흐르고, U88의 창 음소거도 제 축으로 남는다.
   *
   * 라이브 `state`를 읽는다(`visualState()`가 아니다). PGM FREEZE 중에도 암전은 즉시 듣는
   * 것이 U65의 계약이고, 소리가 그림보다 늦게 꺼지면 그것이 더 큰 사고다.
   */
  blackoutAudio = blackoutAudioAxis(state.sceneOpts.blackout, state.settings.blackoutSec, now);
  const master = heardMaster(now) * blackoutAudio;
  // 음악 덱은 `music` 축 × 덕킹(U44·U45) × 암전(U95). 영상·카메라는 `media` 축 × 암전이다.
  const musicMaster = heardMusic(now) * musicDuck.value * blackoutAudio;

  for (const deck of musicDecks) {
    const stepped = stepGain(deck.track, now);
    deck.track = stepped.track;
    if (stepped.finish === 'pause') {
      deck.el.pause();
      // 명령 시각이 아니라 **실제로 멎은 위치**를 돌려준다 — control의 positionSec이
      // 페이드 길이만큼 뒤처진 채 남으면 다음에 열리는 display가 거기로 seek한다.
      if (deck === currentMusicDeck()) {
        // 소수 3자리로 자른다 — 아주 작은 값이 지수 표기(1e-7)로 직렬화되면 control의
        // 파서가 못 읽고 조용히 버린다.
        const at = Math.max(0, Math.round((deck.el.currentTime || 0) * 1000) / 1000);
        emit(`music-paused-at:${state.music.commandToken}:${at}`);
      }
    } else if (stepped.finish === 'release') {
      clearMusicDeck(deck);
    }
    deck.el.volume = trackVolume(musicMaster, deck.track);
  }

  for (const media of gatedMedia) {
    // 소리가 남았는데 문서 밖이면 브라우저가 **이미** 멈춘 뒤다 (HTML 명세). 그대로 두면
    // 페이드가 정지된 엘리먼트 위에서 헛돈다 — 도로 붙여 남은 페이드를 살린다.
    // 새 경로가 파킹을 빠뜨려도 여기서 자가 복구된다 (D5 재발 방지 그물).
    if (requiresDocumentPresence(media.track) && !media.el.isConnected) parkMedia(media.el);
    const stepped = stepGain(media.track, now);
    media.track = stepped.track;
    if (stepped.finish !== 'none') media.finish(stepped.finish);
    media.el.volume = trackVolume(master, media.track);
  }
}

/**
 * 페이드 아웃이 끝난 뒤에만 실제로 멈추는 미디어들.
 *
 * `finish`는 게인이 0에 닿았을 때 딱 한 번 불린다 — 여기서만 `pause()`·`src` 해제를 한다.
 * 시각적 정리(숨김)는 요청 시점에 이미 끝나 있다("고스트 테일").
 */
interface GatedMedia {
  el: HTMLMediaElement;
  track: GainTrack;
  finish: (mode: GainTeardown) => void;
}
const gatedMedia: GatedMedia[] = [];

/**
 * 급격한 전환에서 소리를 정리한다 — 화면은 이미 넘어갔고 소리만 남았을 때 부른다.
 * 무음이면 그 자리에서 끝내고, 소리가 남았으면 `audioCutFadeSec` 동안 내린 뒤 정리한다.
 */
function requestAudioTeardown(media: GatedMedia, mode: Exclude<GainTeardown, 'none'>, now: number): void {
  const fadeSec = state.settings.audioCutFadeSec;
  if (teardownDecision(media.track, fadeSec) === 'now') {
    media.track = idleTrack(0);
    media.el.volume = trackVolume(heardMaster(), media.track);
    media.finish(mode);
    return;
  }
  media.track = rampGain(media.track, 0, fadeSec, now, mode);
}

function applyMusic(now: number): void {
  const command = musicPlaybackCommand(appliedMusic, state.music);
  appliedMusic = { ...state.music };
  if (command) {
    const outgoing = currentMusicDeck();
    // "울리고 있다" = 트랙이 물려 있고 볼륨이 남았거나 아직 재생 중 — 크로스할 상대가 있는가
    const sounding = outgoing.boundTrackId !== null && (isAudible(outgoing.track) || !outgoing.el.paused);
    const plan = musicFadePlan(command, sounding);

    if (plan.outgoing !== 'none') startMusicRamp(outgoing, 0, now, plan.outgoing);
    if (plan.swapDeck) musicDeckIndex = 1 - musicDeckIndex;

    const deck = currentMusicDeck();
    if (command.trackId !== null) {
      if (command.load) {
        const track = musicTrack(command.trackId);
        if (!track) {
          clearMusicDeck(deck);
          emit(`music-error:${command.trackId}`);
          tickAudioGains(now);
          return;
        }
        if (plan.swapDeck) {
          // 새 덱은 무음에서 시작한다 (직전 곡의 잔여 게인을 물려받으면 크로스가 아니라 점프다)
          deck.track = idleTrack(0);
        }
        // **덱은 둘뿐이다.** 페이드 창(musicFadeSec) 안에서 A→B→C로 연달아 바꾸면 아직
        // 페이드 아웃 중인 A의 덱이 C 자리로 재사용된다. 그때 볼륨이 남은 채로 `src`를 갈면
        // 재생 헤드가 튀면서 클릭 노이즈가 난다. 교체 직전에 element 볼륨을 실제로 0으로
        // 내려 두고, 그 뒤 `tickMusicGain`이 새 램프로 다시 올린다.
        deck.el.volume = trackVolume(heardMusic(), idleTrack(0));
        deck.el.src = new URL(track.src, document.baseURI).href;
        deck.boundTrackId = track.id;
        deck.el.load();
      }
      if (command.seekTo !== null) {
        // seek는 페이드 아웃 중이어도 **즉시** 반영한다(의도). 운영자가 위치를 옮긴 순간
        // 소리가 그 위치로 가는 것이 기대 동작이고, 페이드가 끝날 때까지 옛 위치를 계속
        // 들려주면 "슬라이더를 옮겼는데 몇 초 동안 딴 데가 나온다"가 된다.
        if (deck.el.readyState >= HTMLMediaElement.HAVE_METADATA) {
          deck.el.currentTime = Math.min(
            command.seekTo,
            Number.isFinite(deck.el.duration) ? deck.el.duration : command.seekTo,
          );
        } else {
          deck.pendingSeek = command.seekTo;
        }
      }
      if (plan.incoming === 'fade-in') fadeInMusicDeck(deck, now);
      else if (plan.incoming === 'cut-in') cutInMusicDeck(deck, now);
      if (command.play) playMusicDeck(deck, command.trackId, state.music.commandToken);
    }
  }
  tickAudioGains(now);
}

// ---------------------------------------------------------------- 배경 앰비언트
//
// 씬별 은은한 배경 모션. 캔버스는 stage **밖**(viewport 자식)에 겹쳐 screen 합성한다 —
// 씬 렌더가 stage.innerHTML을 통째로 갈아치우고 씬 배경이 불투명하기 때문(ambient.ts 주석 참조).
// fx보다 **먼저** 붙여 전환 오버레이가 항상 위에 오게 한다.
const ambient = new Ambient();
viewport.appendChild(ambient.canvas);

// ---------------------------------------------------------------- 레터박스 스케일

let displayGuiScale = 1;

function fitStage(): void {
  const s = fitDisplayScale(window.innerWidth, window.innerHeight, displayGuiScale);
  stage.style.transform = `scale(${s})`;
  ambient.canvas.style.transform = `translate(-50%, -50%) scale(${s})`;
  viewport.style.setProperty('--scale', String(s));
}
window.addEventListener('resize', fitStage);
fitStage();

const scaleBadge = document.createElement('div');
scaleBadge.className = 'display-scale-badge';
scaleBadge.hidden = true;
document.body.appendChild(scaleBadge);
let scaleBadgeTimer = 0;

function showScaleBadge(): void {
  if (
    !displayOperatorOverlayVisible(
      shownScene,
      true,
      visualState().sceneOpts.standby.mode,
      visualState().sceneOpts.game.mode,
    )
  ) {
    scaleBadge.hidden = true;
    return;
  }
  scaleBadge.textContent = `GUI ${Math.round(displayGuiScale * 100)}%`;
  scaleBadge.hidden = false;
  window.clearTimeout(scaleBadgeTimer);
  scaleBadgeTimer = window.setTimeout(() => {
    scaleBadge.hidden = true;
  }, 1200);
}

// ---------------------------------------------------------------- 씬 전환 (엠블럼 스윕)

/**
 * 오버레이는 stage **밖**에 붙인다 — 씬 렌더가 stage.innerHTML을 통째로 갈아치우기 때문.
 * 스케일은 #viewport의 `--scale`(fitStage가 갱신)을 그대로 물려받는다.
 */
const fx = new SceneFx();
viewport.appendChild(fx.root);

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- 대기 배경 크로스디졸브 상태 (U19)
//
// 값 자체는 여기 선언한다 — 사진 런타임 게이트(`wantPhotoRuntimeFor`)가 이 값을 읽는데,
// 그 게이트는 모듈 초기화 중(`photoRuntimeEnabled`)에도 한 번 불린다. 아래쪽에 두면 TDZ다.

/**
 * 크로스디졸브 상태 전부. **쓰는 곳은 `stepBackdropFade` 하나뿐이다** — 필드를 바깥에서
 * 만지면 스냅 플래그가 계속 되살아나 램프가 영영 안 생긴다(실사고).
 *
 * 첫 상태 방송까지 스냅으로 두는 이유: display 창은 localStorage 스냅샷으로 먼저 뜨고 곧바로
 * 리더 상태를 받는다. 두 값이 다르면(저장본은 배경 OFF인데 리더는 ON) 창을 열자마자 10초짜리
 * 페이드 인이 한 번 보인다 — 아무도 토글하지 않았는데 화면이 서서히 바뀌니 사고로 읽힌다.
 */
let backdropFade = initialBackdropFade(state.photos.settings.standbyBackdrop);
/** 첫 상태 방송을 받았는가 — 받기 전에는 계속 스냅으로 둔다 */
let sawFirstSyncState = false;

/**
 * 사진 재생기를 돌릴 것인가 — **이 함수 하나가 유일한 판정**이다.
 *
 * 예전에는 `setShownScene`이 옛 2인자 시그니처로 따로 판정해서 게임 대기 씬을 사진 씬으로
 * 세지 못했다. 그 결과 (1) 게임 대기에서 사진이 도는 중 다른 씬으로 나가면 `releasePhotos()`가
 * 돌지 않아 objectURL이 세션 내내 쌓이고 (2) standby ↔ game(standby) 이동에서는 필요 없는
 * release 후 재획득이 일어났다. 판정을 한 곳으로 모아 두 방향 모두 닫는다.
 */
function wantPhotoRuntimeFor(target: SceneId): boolean {
  return photoPlaybackEnabled(target, effectivePhotoSettings(), {
    standbyMode: visualState().sceneOpts.standby.mode,
  });
}

/** 화면에 실제로 떠 있는 씬. 상태의 씬보다 최대 한 번의 전환만큼 뒤처진다. */
let shownScene: SceneId = pickScene(state);
/** 전환이 도는 동안 새 전환을 시작하지 않는다 (연타 시 마지막 요청 씬으로 수렴) */
let txBusy = false;

/**
 * 화면에 실제로 떠 있는 씬이 바뀌는 **유일한 관문** (§11 M9).
 *
 * 씬 교체 지점이 넷(전환 영상 중 즉시 교체 · 프리렌더 설치 · 모션 최소화/가려짐 · fx 스윕 콜백)이라
 * 진입/이탈 처리를 각 분기에 흩어 두면 반드시 한 곳이 빠진다. 사진 씬은 **이탈 시 objectURL을
 * 전부 반납**해야 하는데(안 하면 revoke되지 않은 blob URL이 세션 내내 쌓인다) 그 한 곳이
 * 빠지는 것이 정확히 이 사고다. 그래서 `shownScene` 대입을 이 함수 하나로 모은다.
 */
function setShownScene(next: SceneId): void {
  const prev = shownScene;
  shownScene = next;

  // 카운트업은 씬에 들어올 때마다 0부터 다시 오른다
  if (next === 'score') resetAnimations('score:');
  if (next === 'award') resetAnimations('award:');

  if (prev === next) return;
  const prevPhotos = wantPhotoRuntimeFor(prev);
  const nextPhotos = wantPhotoRuntimeFor(next);
  // 전체 사진 씬과 대기 배경 사이 이동도 대기 화면 진입이면 새 무작위 세션으로 시작한다.
  // 판정은 크로스디졸브와 같은 기준이다 — 두 곳에 조건을 따로 쓰면 다시 어긋난다.
  if (
    visualState().photos.settings.standbyBackdrop &&
    standbyCrossfadeScene(next, visualState().sceneOpts.standby.mode)
  ) {
    restartStandbyPhotoSession(Date.now());
  }
  if (prevPhotos && !nextPhotos) releasePhotos();
  // 들어올 때는 hold 델타 계산의 기준 시각을 지금으로 맞춘다 (떠나 있던 시간이 델타로 들어오면 안 된다)
  if (!prevPhotos && nextPhotos) photoLastTickAt = Date.now();
  photoRuntimeEnabled = nextPhotos;
}

function maybeTransition(): void {
  const vis = visualState();
  const want = pickScene(vis);
  if (want === shownScene) return;

  // 영상 전환이 화면을 덮고 있는 동안에는 내장 엠블럼 스윕을 겹치지 않는다.
  // display가 보고한 실제 재생 시각에 control이 scene을 바꾸므로 즉시 underlying scene만 교체한다.
  //
  // 설명 영상 페이드(phase !== 'idle')도 같다 — 씬 교체는 검정이 화면을 완전히 덮은 순간에만
  // 일어나므로 그 위에 CSS 스윕을 또 돌릴 이유가 없고, 스윕이 도는 0.45초 동안 shownScene이
  // 뒤처지면 covered 직후 "소리만 나고 화면은 이전 씬"인 구간이 생긴다 (§11 M3).
  if (vis.sceneOpts.transitionVideo.active || vis.sceneOpts.video.phase !== 'idle') {
    setShownScene(want);
    return;
  }

  // 기본 프리렌더가 등록된 설치에서는 로고 CSS 스윕을 다시 띄우지 않는다.
  // control을 우회한 안전 조작·복구 경로는 영상 없이 즉시 cut으로 수렴한다.
  if (!shouldUseBuiltInSceneFx(state)) {
    setShownScene(want);
    return;
  }

  // 모션 최소화 설정이면 스윕 없이 크로스페이드(.scene의 scene-in)로 강등한다.
  // 창이 가려져 있을 때도 마찬가지다 — 백그라운드 탭에서는 setTimeout이 스로틀링되어
  // 전환이 덮은 채로 멈춘 것처럼 보인다(송출 화면에서 치명적). 이때는 즉시 교체한다.
  if (reduceMotion.matches || document.hidden) {
    setShownScene(want);
    return;
  }
  if (txBusy) return;

  txBusy = true;
  fx.play(P2_SCENES.includes(want) ? 'red' : 'gold', () => {
    // 덮인 순간에 교체 — 전환 도중 더 눌렸다면 그 시점의 마지막 요청으로 수렴한다
    setShownScene(pickScene(state));
    paint();
  });
  window.setTimeout(() => {
    txBusy = false;
    maybeTransition(); // 전환 중 들어온 요청이 남아 있으면 한 번 더
  }, FX_DURATION + 60);
}

// ---------------------------------------------------------------- 커서 자동 숨김

let cursorTimer = 0;
function pokeCursor(): void {
  document.body.classList.remove('cursor-hidden');
  window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => document.body.classList.add('cursor-hidden'), 2500);
}
window.addEventListener('mousemove', pokeCursor);
pokeCursor();

// ---------------------------------------------------------------- 전체화면

/**
 * 전환이 끝나기 전에 들어온 두 번째 요청을 버리는 잠금 (U141).
 *
 * 09-06 사고: f를 아주 잠깐만 길게 눌러도 macOS 키 반복이 전환 애니메이션 중에 두 번째
 * keydown을 만들어 전체화면에 들어갔다가 곧바로 `exitFullscreen()`으로 되돌아왔다("빕 하고
 * 풀스크린됐다 축소"). 키 쪽은 `isFullscreenToggleKey`의 `repeat` 가드로 막고, 버튼 연타·
 * 키와 버튼이 겹치는 경로는 이 잠금으로 받는다. 판정과 상태 머신은 `display-fullscreen.ts`.
 */
const fsGate = createFullscreenGate();

function toggleFullscreen(): void {
  if (!fsGate.begin()) return;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => fsGate.settle());
  else void document.documentElement.requestFullscreen().catch(() => fsGate.settle());
}
fsBtn.addEventListener('click', toggleFullscreen);
// 잠금 해제는 음소거 동기화(U88)와 **별도 리스너**다 — 소리 경로에 손대지 않는다
document.addEventListener('fullscreenchange', () => fsGate.settle());
document.addEventListener('fullscreenerror', () => fsGate.settle());

/**
 * 음소거·전체화면 상태를 한 곳에서 다시 계산한다 (U88).
 *
 * 전체화면 감지는 `requestFullscreen()`의 성공/실패가 아니라 **브라우저 이벤트**로 한다.
 * `Esc`·macOS 창 버튼·다른 창의 전체화면 요청이 토글 함수를 거치지 않기 때문이다.
 *
 * 전체화면에 들어가면 음소거가 **저절로 풀린다** — 프로젝터로 나가는 창이 무음인 것이
 * 가장 큰 사고다. 기억된 선택(`userMuteWish`)은 지우지 않으므로 창 모드로 돌아오면 되살아난다.
 * 램프는 건드리지 않는다: 게인 계산은 음소거 중에도 계속 돌았으므로 해제는 그 램프의
 * 현재 위치에서 이어진다.
 */
function syncUserMute(force = false): void {
  displayFullscreen = Boolean(document.fullscreenElement);
  const next = effectiveUserMute(userMuteWish, displayFullscreen, MONITOR);
  const changed = next !== userMuted;
  userMuted = next;
  if (changed || force) {
    refreshOutputMute();
    reportUserMuteState();
  }
  // 라벨·표시 여부는 값이 그대로여도 갱신한다 — 전체화면 여부가 버튼의 표시를 정한다
  updateMuteBtn();
}
document.addEventListener('fullscreenchange', () => syncUserMute());

/**
 * 음소거 토글. 기억은 **이 창에만** 남는다(`sessionStorage`).
 *
 * 전체화면에서는 버튼이 감춰져 있어 이 경로로 들어올 일이 없지만, 들어오더라도
 * `effectiveUserMute`가 거짓을 내므로 소리는 그대로 나간다 — 기억만 바뀐다.
 */
function toggleUserMute(): void {
  userMuteWish = !userMuteWish;
  writeStoredUserMute(userMuteWish);
  syncUserMute();
}
muteBtn.addEventListener('click', toggleUserMute);

/** 버튼의 라벨·툴팁·`aria-pressed`·표시 여부를 한 곳에서 그린다 */
function updateMuteBtn(): void {
  muteBtn.hidden = userMuteButtonHidden(fsBtn.hidden, displayFullscreen);
  muteBtnLabel.textContent = userMuteLabel(userMuteWish);
  const hint = userMuteHint(userMuteWish);
  muteBtnHint.textContent = hint ?? '';
  muteBtnHint.hidden = hint === null;
  muteBtn.classList.toggle('is-muted', userMuteWish);
  muteBtn.setAttribute('aria-pressed', userMuteWish ? 'true' : 'false');
  const tip = userMuteTip(userMuteWish);
  muteBtn.title = tip;
  muteBtn.setAttribute('aria-label', `${userMuteLabel(userMuteWish)} — ${tip}`);
}
window.addEventListener('keydown', (ev) => {
  const nextScale = displayScaleForShortcut(displayGuiScale, ev);
  if (nextScale !== null) {
    ev.preventDefault();
    displayGuiScale = nextScale;
    fitStage();
    showScaleBadge();
    return;
  }
  if (isFullscreenToggleKey(ev)) {
    ev.preventDefault();
    toggleFullscreen();
  }
});

// ---------------------------------------------------------------- 런타임 리소스

/** 카메라: 싱글턴 <video>. HTML이 교체돼도 이 엘리먼트를 다시 붙여 스트림을 유지한다. */
const camEl = document.createElement('video');
camEl.className = 'cam-video';
camEl.autoplay = true;
setOutputMuted(camEl, true);
camEl.playsInline = true;

/**
 * 자동재생 정책에 막혀 카메라를 강제 음소거로 떨어뜨렸는가 (§11 M8).
 *
 * paint()가 매 프레임 `camEl.muted`를 설정값에 맞추므로, 이 플래그가 없으면 폴백으로 음소거한
 * 다음 프레임에 다시 소리를 켜려다 재생이 멈춘다. 언락(pointerdown)이나 재협상에서 풀린다.
 */
let cameraAudioBlocked = false;
/**
 * 중계 카메라를 화면 밖으로 치웠는가 (U27 D5-3).
 *
 * 페이드가 끝나면 `track.after`가 `'none'`으로 돌아가므로 그것만으로는 "치워 둔 상태"를
 * 표현할 수 없다. 이 플래그가 없으면 정리 완료 다음 프레임에 정책이 게인을 1로 되돌리고
 * unmute해 카메라 소리가 되살아난다(실측 +880ms 복귀).
 * 중계 씬으로 다시 들어오고 설정이 켜져 있을 때만 풀린다.
 */
let cameraAudioParked = false;

/**
 * 슬로우 리플레이 재생용 싱글턴 <video> (Q5 A안).
 *
 * **항상 muted이고 audio-gain 매니저에 등록하지 않는다.** 녹화 스트림 자체가 비디오 트랙만
 * 담고 있어 오디오 트랙이 존재하지 않으므로 `.volume`을 만질 이유도, 만질 주인도 없다
 * (모든 `.volume` 쓰기는 `audio-gain.ts`만 한다는 계약을 이 엘리먼트는 아예 비켜 간다).
 * camEl과 같은 슬롯에 나란히 붙어 HTML이 교체돼도 유지된다.
 */
const replayEl = document.createElement('video');
replayEl.className = 'cam-replay';
replayEl.muted = true;
replayEl.playsInline = true;
replayEl.controls = false;
replayEl.hidden = true;

/**
 * 라이브 다크 프레임 (U118) — 싱글턴 래퍼 + 알파 영상. 판정은 `src/live-frame.ts`.
 *
 * **항상 muted이고 audio-gain 매니저에 등록하지 않는다** — 대기 화면의 같은 파일과 똑같이
 * 소리 트랙이 없는 붙박이 그림이다(`replayEl`이 매니저를 비켜 가는 것과 글자 그대로 같은
 * 이유). 이 엘리먼트의 `.volume`을 쓰는 자리는 어디에도 없다.
 *
 * **`src`는 처음 켤 때 붙인다** (`ensureLiveFrameSource`). 9MB 알파 webm이라, 부팅에서
 * 물려 두면 프레임을 한 번도 안 쓰는 1부 중계 내내 받아 두고 디코딩까지 돈다.
 */
const liveFrameEl = document.createElement('div');
liveFrameEl.className = 'live-frame';
const liveFrameScrimEl = document.createElement('div');
liveFrameScrimEl.className = 'live-frame__scrim';
const liveFrameVideoEl = document.createElement('video');
liveFrameVideoEl.className = 'live-frame__video';
liveFrameVideoEl.muted = true;
liveFrameVideoEl.loop = true;
liveFrameVideoEl.playsInline = true;
liveFrameVideoEl.controls = false;
liveFrameEl.append(liveFrameScrimEl, liveFrameVideoEl);

/**
 * 지금 다크 프레임이 화면에 있는가 — 글리치 캔버스가 이 값을 보고 같은 그림을 다시 그린다.
 * DOM을 매 프레임 뒤지지 않으려고 `syncLiveFrame()`이 한 번만 갱신한다.
 */
let liveFrameOn = false;

/**
 * 카메라 재생 — 소리 있는 재생이 **정책에** 막히면 영상은 계속 나오도록 음소거로 떨어뜨린다.
 *
 * `AbortError`(씬 전환·소스 교체 중 정상 발생)까지 잠금으로 세면 소리가 멀쩡한데도 배지와
 * 조작 패널 배너가 뜬다 (U48 후속). 잠금은 `NotAllowedError` 하나뿐이다.
 */
function playCamera(): void {
  void camEl.play().catch((error: unknown) => {
    const outcome = classifyPlayRejection(error);
    if (outcome === 'ignore') return;
    if (outcome === 'error') {
      console.warn('[camera] play() 실패', error);
      return;
    }
    cameraAudioBlocked = true;
    setOutputMuted(camEl, true);
    needsAudioUnlock = true;
    void camEl.play().catch(() => undefined);
  });
}

const camera = new CameraSession(
  async (deviceId, audio) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 브라우저에서 카메라를 쓸 수 없습니다');
    return navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      // 끄면 트랙을 아예 요청하지 않는다 → 마이크 권한 프롬프트도 뜨지 않는다
      audio,
    });
  },
  (stream) => {
    camEl.srcObject = stream;
    // 새 스트림이므로 이전 협상에서 걸린 정책 폴백은 무효다
    cameraAudioBlocked = false;
    setOutputMuted(camEl, !state.settings.camera.audio);
    playCamera();
    emit('camera-ok');
    // 초기 렌더는 NO SIGNAL을 꽂았을 수 있으므로, 스트림 준비 즉시 싱글턴 video로 교체한다.
    attachSlots();
  },
  () => {
    emit('camera-fail');
    attachSlots();
  },
);

// 출력창을 열자마자 한 번만 예열해, 라이브 씬 진입 시 카메라 시작 지연을 숨긴다.
// 모니터는 열지 않는다 — 같은 장치를 두 창이 잡으면 실패하거나 프레임이 떨어진다 (U72).
if (!MONITOR) void camera.ensure(state.settings.camera.deviceId, state.settings.camera.audio);

/**
 * PGM 모니터의 카메라 자리 (U72).
 *
 * 모니터는 카메라를 열지 않으므로 그 자리에 NO SIGNAL을 그대로 띄우면 "출력이 죽었다"로
 * 읽힌다 — 정확히 반대의 오보다. **여기가 모니터라는 사실**을 그 자리에서 말한다.
 */
function buildMonitorPlaceholder(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'nosignal nosignal--monitor';
  const msg = document.createElement('div');
  msg.className = 'nosignal__msg';
  const strong = document.createElement('strong');
  strong.textContent = 'PGM 모니터';
  const span = document.createElement('span');
  span.textContent = '카메라는 출력 창에만 나갑니다';
  msg.append(strong, span);
  wrap.append(msg);
  return wrap;
}

function buildNoSignal(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'nosignal';
  const bars = document.createElement('div');
  bars.className = 'nosignal__bars';
  for (const c of ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0']) {
    const b = document.createElement('span');
    b.style.background = c;
    bars.appendChild(b);
  }
  const msg = document.createElement('div');
  msg.className = 'nosignal__msg';
  const strong = document.createElement('strong');
  strong.textContent = 'NO SIGNAL';
  const span = document.createElement('span');
  span.textContent = camera.error || '카메라를 선택하세요 (패널 → 설정 탭)';
  msg.append(strong, span);
  wrap.append(bars, msg);
  return wrap;
}

/** 영상: 싱글턴 <video>. objectURL은 assetId별로 캐시해 재생성 비용을 없앤다. */
const videoEl = document.createElement('video');
videoEl.className = 'video-el';
videoEl.autoplay = true;
videoEl.playsInline = true;
videoEl.controls = false;
videoEl.addEventListener('ended', () => {
  const video = visualState().sceneOpts.video;
  if (video.phase === 'playing' && video.holdEndFrame) {
    emit(`fullvideo-held:${video.phaseToken}`);
    return;
  }
  // tail 판정용 로컬 플래그 (§11 M12 — tailStartSec 도달과 ended 중 먼저 오는 쪽).
  // duration을 못 읽는 에셋에서는 이 이벤트가 유일한 꼬리 페이드 트리거다.
  fadeEndedSeen = true;
  // 기존 의미 보존: control은 phase !== 'idle'이면 이 메시지를 무시한다 (§4-7)
  emit('video-ended');
});

const urlCache = new Map<string, string>();
/** `ensureVideo()`가 "이 영상을 붙이겠다"고 **예약**한 값 — 재진입 가드 전용 */
let videoAssetId: string | null = null;
let videoRestartToken = -1;
/**
 * `videoEl`이 **실제로 물고 있는** 소스. `videoEl.src` 대입·되감기가 끝난 뒤에만 갱신한다.
 *
 * 예약 값(`videoAssetId`)과 갈라 두는 이유: `ensureVideo()`는 blob URL 조회를 `await`하므로
 * 예약과 실제 부착 사이에 프레임이 여러 번 지나가고, 조회가 실패하면 영영 부착되지 않는다.
 * 그 구간에서 예약 값으로 꼬리 페이드를 판정하면 옛 영상의 `currentTime`으로 tail이 성립한다 (D1).
 */
let videoSrcAssetId: string | null = null;
let videoSrcRestartToken = -1;

/**
 * 현재 씬을 유지한 채 위에 얹는 프리렌더 전환 영상.
 *
 * **소리가 난다 (U102).** 스팅어는 효과음 레이어라 깔려 있는 음악·영상 소리 **위에 겹쳐서**
 * 난다 — 그래서 덕킹(U44)도, 카메라 파킹도, 꼬리 페이드도 걸지 않는다. 볼륨만 다른 출력과
 * 같은 매니저 축(미디어 볼륨 × 마스터 × 암전 U95)을 타고, `muted`는 `setOutputMuted()`가 쥔다.
 */
const transitionVideoEl = document.createElement('video');
transitionVideoEl.id = 'transition-video';
// autoplay는 켜지 않는다 — 재생은 ensureTransitionVideo()가 play()로 명시 시작한다.
// (켜 두면 prewarmTransitionVideo()의 load()만으로 hidden 상태에서 통째로 디코딩되는
//  "고스트 재생"이 매 전환 종료 직후 발생한다. normalizeTransitionPlayback()이 계속 꺼 준다.)
transitionVideoEl.playsInline = true;
transitionVideoEl.controls = false;
// preload는 유지 — readyState 4 예열이 전환 첫 프레임 드롭을 막는다
transitionVideoEl.preload = 'auto';
transitionVideoEl.hidden = true;
normalizeTransitionPlayback(transitionVideoEl);
// 소스가 붙기 전에는 무음이다 — 에셋의 오디오 판정은 ensureTransitionVideo()가 심는다.
setOutputMuted(transitionVideoEl, true);
viewport.appendChild(transitionVideoEl);

/**
 * 분위기 반전 오버레이 (U26). 안에 두 겹이 산다.
 *  · `.mood-transition__glitch` — 글리치 단계에만 붙는 캔버스. 실제 화면 내용을 그려서 망가뜨린다.
 *  · `.mood-transition__black` — 검정 단계의 암전. 오버레이 영상 **아래**라 영상이 뜨면 가려진다.
 *
 * 캔버스는 글리치 단계에만 존재한다 — 1080p 합성이 도는 동안 쓰지 않는 캔버스를 붙여 두면
 * 실제 Chrome에서 프레임이 떨어진다(전환 중 ambient canvas를 내리는 것과 같은 이유).
 */
const moodTransitionEl = document.createElement('div');
moodTransitionEl.id = 'mood-transition';
moodTransitionEl.hidden = true;
const moodBlackEl = document.createElement('div');
moodBlackEl.className = 'mood-transition__black';
moodTransitionEl.appendChild(moodBlackEl);
viewport.appendChild(moodTransitionEl);

/**
 * 글리치 캔버스의 내부 해상도 (U26b).
 *
 * 960×540인 이유는 두 가지가 맞물린다. 픽셀 정렬이 CPU에서 도므로(매 프레임 `getImageData`로
 * 518,400픽셀을 읽고 계수 정렬한 뒤 되쓴다) 해상도가 곧 비용이다. 반대로 너무 낮추면 1920×1080
 * 출력까지 4배로 늘어나며 bilinear 보간이 스트릭을 뭉개 버린다 — 픽셀 소트의 날카로운 경계가
 * 사라지면 효과 자체가 죽는다. 2배 업스케일이 비용(실측 p95 기준)과 선명함이 만나는 지점이다.
 * `image-rendering`은 기본값을 그대로 둔다: 2배에서는 보간이 오히려 계단을 부드럽게 정리해 주고,
 * `pixelated`로 강제하면 카메라 원본 화면까지 각져 보인다.
 * 화면비는 스테이지와 **정확히 같다**(16:9) — 여기가 어긋나면 라이브에서 넘어올 때 화면이 튄다.
 */
const MOOD_GLITCH_W = 960;
const MOOD_GLITCH_H = 540;
let moodGlitchCanvas: HTMLCanvasElement | null = null;
let moodGlitchCtx: CanvasRenderingContext2D | null = null;
/** 글리치 단계 시작 시각 — 세기 상승 곡선의 기준 */
let moodGlitchStartedAt = 0;
/** 지금 그리고 있는 단계 (`token:phase`) — 단계가 바뀌면 기준 시각을 다시 잡는다 */
let moodPhaseKey = '';
let moodPhaseStartedAt = 0;

/** 캔버스가 걷히는 시간 — CSS `.mood-transition__glitch`의 transition과 같은 값이어야 한다 */
const MOOD_GLITCH_FADE_MS = 300;

/**
 * 진입 디졸브가 도는 동안만 붙는 클래스 (U91).
 *
 * 나갈 때의 0.3초 페이드는 CSS transition이 맡는다(값을 한 번만 쓰고 브라우저가 보간한다).
 * 들어올 때는 반대로 **매 프레임 곡선을 직접 심는다** — 그 위에 transition이 겹치면 브라우저가
 * 매 프레임 새 보간을 시작해 실제 화면이 0.6초 곡선을 1.5초쯤 뒤따라가고, `moodGlitchOpacity`가
 * 정본이라는 계약이 깨진다. 검정 레이어가 CSS transition을 아예 쓰지 않는 것과 같은 이유다.
 * 그래서 램프 구간에만 transition을 끄고, 램프가 끝나면(또는 캔버스를 뗄 때) 되돌린다.
 */
const MOOD_GLITCH_FADE_IN_CLASS = 'is-mood-fade-in';

function ensureMoodGlitchCanvas(on: boolean): void {
  if (on === (moodGlitchCanvas !== null)) return;
  if (!on) {
    // 검정이 이미 1이라 화면에는 변화가 없지만, 즉시 제거하면 마지막 프레임이 한 번 깜빡인다.
    // 0.3초 페이드로 내린 뒤 떼어 낸다 (U53). 그 사이 다시 켜지면 아래 분기가 같은 노드를 살린다.
    const leaving = moodGlitchCanvas;
    moodGlitchCanvas = null;
    moodGlitchCtx = null;
    if (leaving) {
      // 진입 램프 도중에 끊겼다면(중단 큐) transition을 되돌려 놓아야 아래 페이드가 실제로 돈다
      leaving.classList.remove(MOOD_GLITCH_FADE_IN_CLASS);
      // 이미 투명하게 내려 둔 뒤라면(`tickMoodGlitch`가 15초 직전에 시작한다) 곧바로 뗀다.
      // 그래야 "제거 완료"가 전환 끝(15.0s)과 같은 시각이 된다 (D8).
      if (leaving.style.opacity === '0') leaving.remove();
      else {
        leaving.style.opacity = '0';
        window.setTimeout(() => leaving.remove(), MOOD_GLITCH_FADE_MS);
      }
    }
    // 채널 분리·슬라이스용 임시 캔버스도 함께 놓는다 — 글리치가 끝나면 960×540 × 2장이
    // 계속 붙들려 있을 이유가 없다.
    moodGlitchScratchPool.length = 0;
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'mood-transition__glitch is-mood-fade-in';
  // 첫 프레임은 **완전히 투명**하다 (U91). 붙자마자 불투명하면 카메라 위의 크롬(스코어바·
  // VS 바·배지)과 앰비언트 그레인이 한 프레임에 사라져 화면이 튄다 — `moodGlitchOpacity` 참조.
  canvas.style.opacity = '0';
  canvas.width = MOOD_GLITCH_W;
  canvas.height = MOOD_GLITCH_H;
  // 검정 레이어보다 아래에 꽂는다 — 암전이 시작되면 글리치를 덮어야 한다
  moodTransitionEl.insertBefore(canvas, moodBlackEl);
  moodGlitchCanvas = canvas;
  // 매 프레임 `getImageData`로 되읽으므로 GPU 백업 캔버스는 오히려 느리다 — 브라우저에
  // CPU 쪽에 두라고 알려 준다(픽셀 정렬이 CPU에서 돈다).
  moodGlitchCtx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
}

/**
 * 라이브 화면을 **그대로** 캔버스에 옮긴다 (U26b).
 *
 * `.cam-video`는 `object-fit: cover` + `cameraTransform`(좌우·상하 반전)으로 그려진다.
 * 캔버스가 영상을 통째로 늘려 그리면 카메라가 4:3일 때 화면비가 달라져, 라이브에서 글리치로
 * 넘어가는 순간 그림이 살짝 튄다(사용자 관찰). 같은 크롭과 같은 반전을 여기서 재현한다.
 */
function drawLiveFrame(ctx: CanvasRenderingContext2D): void {
  const rect = coverSourceRect(camEl.videoWidth, camEl.videoHeight, MOOD_GLITCH_W, MOOD_GLITCH_H);
  const { flipX, flipY } = state.settings.camera;
  ctx.save();
  if (flipX || flipY) {
    ctx.translate(flipX ? MOOD_GLITCH_W : 0, flipY ? MOOD_GLITCH_H : 0);
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  }
  ctx.drawImage(camEl, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, MOOD_GLITCH_W, MOOD_GLITCH_H);
  ctx.restore();
  drawLiveDarkFrame(ctx);
}

/**
 * 다크 프레임을 캔버스에도 **같은 순서로** 얹는다 (U118).
 *
 * ## 왜 캔버스가 합성을 다시 그리는가 (레이어로 남기지 않는 이유)
 * 대안은 프레임 영상을 DOM 레이어로 글리치 캔버스(z 42) **위**에 남기는 것이었다. 그러면
 * 카메라만 찢어지고 프레임은 멀쩡히 선명하다 — 사용자가 말한 "그 상태로 위에 글리치"는
 * 합성된 그림 한 장이 무너지는 그림이지, 액자만 남고 속만 무너지는 그림이 아니다. 게다가
 * 그렇게 두면 `blackout`에서 프레임을 따로 걷어야 하고(검정은 z 42 안에 있다), 층 규칙이
 * 두 개 더 늘어난다.
 *
 * 캔버스가 그리면 U91 계약이 **더 정확해진다**. `part2-live`는 크롬을 전부 끈 큐라, 화면에
 * 있는 것이 카메라 + 어둡힘 + 프레임 셋뿐이고 캔버스가 그 셋을 그대로 옮겨 그린다 —
 * t=0의 캔버스는 라이브와 픽셀 단위로 같다. 0.6초 디졸브가 덮어 줄 차이는 `#ambient`
 * 그레인 하나만 남는다.
 *
 * 카메라 반전(`cameraTransform`)은 **걸지 않는다**. 프레임은 카메라 그림이 아니라 그 위에
 * 얹는 붙박이 그래픽이라, 거울모드에서 액자까지 뒤집히면 그것이 사고다(리플레이가 카메라와
 * 같은 반전을 쓰는 것과 정반대의 이유).
 */
function drawLiveDarkFrame(ctx: CanvasRenderingContext2D): void {
  if (!liveFrameOn) return;
  ctx.save();
  ctx.fillStyle = LIVE_FRAME_SCRIM_FILL;
  ctx.fillRect(0, 0, MOOD_GLITCH_W, MOOD_GLITCH_H);
  if (liveFrameVideoEl.readyState >= 2 && liveFrameVideoEl.videoWidth > 0) {
    const frameRect = coverSourceRect(
      liveFrameVideoEl.videoWidth,
      liveFrameVideoEl.videoHeight,
      MOOD_GLITCH_W,
      MOOD_GLITCH_H,
    );
    ctx.drawImage(
      liveFrameVideoEl,
      frameRect.sx,
      frameRect.sy,
      frameRect.sw,
      frameRect.sh,
      0,
      0,
      MOOD_GLITCH_W,
      MOOD_GLITCH_H,
    );
  }
  ctx.restore();
}

/**
 * 픽셀 정렬 패스 — 이번 디스토션의 **주효과** (U26b).
 * 세기가 0이면 아예 건드리지 않는다(첫 프레임이 라이브와 픽셀 단위로 같아야 한다).
 */
function applyPixelSort(ctx: CanvasRenderingContext2D, intensity: number, now: number): void {
  const mode = visualState().settings.moodDistortMode;
  if (mode === 'glitch-only' || intensity <= 0) return;
  const frame = ctx.getImageData(0, 0, MOOD_GLITCH_W, MOOD_GLITCH_H);
  pixelSortInPlace(frame.data, {
    width: MOOD_GLITCH_W,
    height: MOOD_GLITCH_H,
    axis: mode === 'pixel-sort-horizontal' ? 'horizontal' : 'vertical',
    threshold: sortThresholdAt(intensity),
    coverage: sortCoverageAt(intensity),
    // seed를 천천히 움직여 무너지는 열이 프레임마다 깜빡이지 않고 **번져 나가게** 한다
    seed: Math.floor((now - moodGlitchStartedAt) / 220),
  });
  ctx.putImageData(frame, 0, 0);
}

/**
 * 글리치 한 프레임. 소스는 중계 카메라 화면이다 — 반전 직전 화면이 곧 라이브이기 때문.
 * 카메라가 아직 안 열렸으면(readyState < 2) 원본 없이 노이즈와 스캔라인만 올린다.
 */
function drawMoodGlitch(now: number): void {
  const ctx = moodGlitchCtx;
  const canvas = moodGlitchCanvas;
  if (!ctx || !canvas) return;
  const elapsedMs = now - moodGlitchStartedAt;
  // U53: 기준은 **전환 전체**다. 글리치 단계만으로 재면 암전이 시작되는 순간 세기가 최대에
  // 닿아 그 뒤로 변화가 없고, 사용자가 말한 "가다가 마는 느낌"이 된다.
  const durationMs = moodTotalMs(visualState().settings);
  const intensity = glitchIntensityAt(elapsedMs, durationMs, visualState().settings.moodGlitchStrength);
  const spec = glitchFrame({
    elapsedMs,
    durationMs,
    strength: visualState().settings.moodGlitchStrength,
    width: MOOD_GLITCH_W,
    height: MOOD_GLITCH_H,
    rand: Math.random,
  });
  const w = MOOD_GLITCH_W;
  const h = MOOD_GLITCH_H;
  const hasSource = camEl.readyState >= 2 && camEl.videoWidth > 0;

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  if (hasSource) {
    ctx.filter = spec.brightness === 1 ? 'none' : `brightness(${spec.brightness.toFixed(3)})`;
    drawLiveFrame(ctx);
    ctx.filter = 'none';

    // 주효과가 먼저다 — 정렬한 그림 위에 보조 글리치를 얹는다
    applyPixelSort(ctx, intensity, now);

    // 가로 슬라이스 밀림. 캔버스 자기 자신을 소스로 쓰면 브라우저가 매번 백업본을 뜨므로
    // (프레임당 최대 10회) scratch에 **한 번만** 복사해 두고 거기서 읽는다.
    if (spec.slices.length) {
      const shelf = moodGlitchScratch();
      const sctx = shelf?.getContext('2d');
      if (shelf && sctx) {
        sctx.globalCompositeOperation = 'source-over';
        sctx.globalAlpha = 1;
        sctx.filter = 'none';
        sctx.clearRect(0, 0, shelf.width, shelf.height);
        sctx.drawImage(canvas, 0, 0);
        for (const slice of spec.slices) {
          ctx.drawImage(shelf, 0, slice.y, w, slice.h, slice.dx, slice.y, w, slice.h);
        }
      }
    }

    // RGB 분리 — 빨강 채널만 남긴 사본을 왼쪽, 시안(초록+파랑) 사본을 오른쪽으로 밀어 더한다.
    // 두 사본을 `lighter`로 합치면 원본 색이 복원되고, 어긋난 만큼만 색테두리가 남는다.
    if (spec.rgbSplitPx > 0) {
      if (moodGlitchScratch()) {
        const dx = spec.rgbSplitPx;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000';
        // 원본을 지우기 전에 두 채널 사본을 먼저 뜬다
        const red = channelCopy(canvas, '#ff0000');
        const cyan = channelCopy(canvas, '#00ffff', red);
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        if (red) ctx.drawImage(red, -dx, 0, w, h);
        if (cyan) ctx.drawImage(cyan, dx, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  // 블록 노이즈
  for (const block of spec.blocks) {
    ctx.fillStyle = block.bright ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.9)';
    ctx.fillRect(block.x, block.y, block.w, block.h);
  }
  // 라인 드롭아웃
  ctx.fillStyle = '#000';
  for (const drop of spec.dropouts) ctx.fillRect(0, drop.y, w, drop.h);

  // 스캔라인
  ctx.globalAlpha = spec.scanlineAlpha;
  ctx.fillStyle = '#000';
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  ctx.globalAlpha = 1;

  if (!hasSource) {
    // 원본이 없으면 노이즈만으로는 심심하다 — 밝기 플리커를 전면 플래시로 대신한다
    ctx.globalAlpha = Math.max(0, spec.brightness - 1) * 0.6;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}

/**
 * 임시 캔버스 두 장을 준비하고 첫 장을 돌려준다. 매 프레임 새로 만들면 GC가 튄다.
 * 슬라이스 밀림의 읽기 원본과 RGB 채널 사본이 이 둘을 나눠 쓴다.
 */
const moodGlitchScratchPool: HTMLCanvasElement[] = [];
function moodGlitchScratch(): HTMLCanvasElement | null {
  while (moodGlitchScratchPool.length < 2) {
    const c = document.createElement('canvas');
    c.width = MOOD_GLITCH_W;
    c.height = MOOD_GLITCH_H;
    moodGlitchScratchPool.push(c);
  }
  return moodGlitchScratchPool[0] ?? null;
}

/**
 * `multiply`로 한 채널만 남긴 사본. 빨강 마스크를 곱하면 R만 살아남는다.
 * `skip`은 이미 다른 채널이 쓰고 있는 캔버스라 피해야 할 장이다.
 */
function channelCopy(
  source: HTMLCanvasElement,
  mask: string,
  skip?: HTMLCanvasElement | null,
): HTMLCanvasElement | null {
  const target = moodGlitchScratchPool.find((c) => c !== skip);
  if (!target) return null;
  const tctx = target.getContext('2d');
  if (!tctx) return null;
  tctx.globalCompositeOperation = 'source-over';
  tctx.globalAlpha = 1;
  tctx.filter = 'none';
  tctx.clearRect(0, 0, target.width, target.height);
  tctx.drawImage(source, 0, 0, target.width, target.height);
  tctx.globalCompositeOperation = 'multiply';
  tctx.fillStyle = mask;
  tctx.fillRect(0, 0, target.width, target.height);
  tctx.globalCompositeOperation = 'source-over';
  return target;
}

function tickMoodGlitch(now: number): void {
  const mood = visualState().sceneOpts.moodTransition;
  const visual = moodVisualState(mood.active, mood.phase);
  ensureMoodGlitchCanvas(visual.glitchCanvas);
  if (!mood.active) {
    moodPhaseKey = '';
    return;
  }
  // 단계가 바뀌면 그 단계의 기준 시각을 새로 잡는다 (겹침 곡선이 이어지려면 필요하다)
  const phaseKey = `${mood.token}:${mood.phase}`;
  if (moodPhaseKey !== phaseKey) {
    moodPhaseKey = phaseKey;
    moodPhaseStartedAt = now;
    if (mood.phase === 'glitch') moodGlitchStartedAt = now;
  }
  moodBlackEl.style.opacity = String(
    moodBlackAt({
      phase: visual.phase,
      phaseElapsedMs: now - moodPhaseStartedAt,
      glitchMs: moodGlitchMs(visualState().settings),
      blackoutMs: Math.max(0, visualState().settings.moodBlackoutSec) * 1000,
    }),
  );
  if (visual.glitchCanvas) {
    drawMoodGlitch(now);
    // 전환이 끝나기 0.3초 전부터 캔버스를 내린다 — 그래야 검정이 1에 닿는 15.0초에
    // 페이드까지 끝나 있다. 검정이 이미 다 덮은 구간이라 화면에는 변화가 없다 (D8).
    const blackoutMs = Math.max(0, visualState().settings.moodBlackoutSec) * 1000;
    const remainMs = mood.phase === 'blackout' ? blackoutMs - (now - moodPhaseStartedAt) : Infinity;
    const canvas = moodGlitchCanvas;
    if (canvas) {
      if (remainMs <= MOOD_GLITCH_FADE_MS) canvas.style.opacity = '0';
      else {
        // 진입 디졸브 (U91) — 기준은 글리치 시작 시각이라 나가는 페이드와 겹치지 않는다.
        const fadeIn = moodGlitchOpacity((now - moodGlitchStartedAt) / 1000);
        canvas.style.opacity = String(fadeIn);
        // 램프가 끝나면 transition을 되돌린다 — 나가는 0.3초 페이드는 다시 CSS가 맡는다
        if (fadeIn >= 1) canvas.classList.remove(MOOD_GLITCH_FADE_IN_CLASS);
      }
    }
  }
}

/**
 * 고스트 테일 보관함 (U27 D5).
 *
 * 씬이 바뀌면 `renderInto`가 stage의 innerHTML을 통째로 갈고, 그 안에 있던 `<video>`는
 * 문서에서 **떨어져 나간다**. HTML 명세상 그 순간 브라우저가 알아서 `pause()`하므로 소리는
 * 하드 컷이 되고, 우리 볼륨 램프는 멈춘 엘리먼트 위에서 헛돈다(D5 재발의 정체).
 *
 * 그래서 슬롯이 사라지는 자리에서 **문서에 남긴 채** 여기로 옮긴다. `#overlay-video`가
 * 처음부터 viewport 직속이라 멀쩡했던 것과 같은 조건을 만들어 주는 것이다.
 * 이관은 stage를 갈아엎는 것과 **같은 동기 턴 안**에서 일어나므로(명세의 "await a stable
 * state" 전에 다시 붙는다) 자동 pause 자체가 발생하지 않는다.
 */
const mediaTailEl = document.createElement('div');
mediaTailEl.id = 'media-tail';
viewport.appendChild(mediaTailEl);

const overlayVideoEl = document.createElement('video');
overlayVideoEl.id = 'overlay-video';
overlayVideoEl.playsInline = true;
overlayVideoEl.controls = false;
overlayVideoEl.preload = 'auto';
setOutputMuted(overlayVideoEl, true);
overlayVideoEl.hidden = true;
viewport.appendChild(overlayVideoEl);

let overlayAssetId: string | null = null;
let overlayRestartToken = -1;
let overlayLoadGeneration = 0;

/**
 * 오버레이 영상은 소리가 난다(분위기 반전 사전렌더). 화면에서는 즉시 감추고 소리만 내려간 뒤
 * 실제로 멈춘다 — "고스트 테일"(U27). 이미 무음이면 그 자리에서 끝난다.
 */
const overlayMedia: GatedMedia = {
  el: overlayVideoEl,
  track: idleTrack(1),
  finish: () => {
    overlayVideoEl.pause();
    overlayVideoEl.removeAttribute('src');
    // 꼬리가 다 빠졌다 — 이 소스가 무엇이었는지도 여기서 놓는다 (U101 · U101b).
    // 남겨 두면 다음에 붙는 무음 오버레이가 판정 하나를 물려받는다.
    overlayMoodSource = false;
    overlaySourceAudio = false;
  },
};
gatedMedia.push(overlayMedia);

/**
 * 지금 `#overlay-video`에 물려 있는 소스가 **분위기 반전이 튼 것**인가 (U101).
 *
 * `moodOwnsOverlay()`는 상태를 보므로 `mood/abort`가 도착하는 순간 false가 된다. 그런데 그때
 * 소리는 아직 `audioCutFadeSec` 동안 내려가는 중이다 — 그 구간의 주인이 누구였는지를 상태가
 * 아니라 **여기**서 들고 있어야 한다. 카메라의 `cameraAudioParked`와 같은 자리·같은 이유다.
 */
let overlayMoodSource = false;

/**
 * 물려 있는 소스가 **소리를 내야 하는 파일**인가 (U101b · 리뷰 C1).
 *
 * `overlayMoodSource`와 같은 이유로 별도 플래그다 — 컷 직후에는 상태의 `overlayVideo`가 이미
 * 비어 에셋을 되찾을 수 없는데, 그 구간이 바로 꼬리 페이드가 들려야 하는 구간이다.
 * 재생 중에는 매 프레임 상태의 에셋 플래그로 갱신되므로, 운영자가 카드에서 소리를 끄면
 * 그 자리에서 먹는다(U84 수동 덮어쓰기 존중).
 */
let overlaySourceAudio = false;

/**
 * 오버레이 영상이 자동재생 정책에 막혀 음소거로 강등됐는가.
 *
 * 없으면 폴백으로 세운 `muted = true`가 **다음 프레임** `updateMoodVisual`의
 * `muted = !visual.videoAudio`에 곧바로 덮여, 브라우저가 다시 막고 영상이 멎는다.
 * 카메라의 `cameraAudioBlocked`와 같은 자리·같은 이유다.
 */
let overlayAudioBlocked = false;

/**
 * `#overlay-video`의 `muted`를 정하는 **단일 자리** (U101).
 *
 * 판정은 `overlayMuted()` 하나가 하고 여기서는 값을 모아 넘기기만 한다. 인라인으로 흩어져
 * 있던 시절에는 `updateMoodVisual`의 매 프레임 갱신이 컷 직후의 꼬리 램프를 음소거로 덮어
 * 페이드가 통째로 사라졌다 — 판정이 한 곳이어야 그런 덮어쓰기가 구조적으로 불가능해진다.
 */
function applyOverlayMute(): void {
  const vis = visualState();
  const overlay = vis.sceneOpts.overlayVideo;
  /**
   * 재생 중이면 **지금 상태의 에셋 플래그**가 정본이다 — 운영자가 카드에서 소리를 끄면 그
   * 프레임부터 먹는다. 컷 뒤 꼬리 구간에는 상태가 이미 비어 있으므로 붙일 때 기록해 둔 값을
   * 쓴다(그 구간이 바로 `audioCutFadeSec` 페이드가 들려야 하는 자리다).
   */
  if (overlay.active && overlay.assetId !== null && overlay.assetId === overlayAssetId) {
    overlaySourceAudio = overlayPlaysAudio(vis.assets.find((a) => a.id === overlay.assetId));
  }
  setOutputMuted(
    overlayVideoEl,
    overlayMuted({
      moodOwned: moodOwnsOverlay(vis.sceneOpts.moodTransition, overlay.assetId),
      policyBlocked: overlayAudioBlocked,
      moodSource: overlayMoodSource,
      assetAudio: overlaySourceAudio,
      gain: overlayMedia.track.gain,
    }),
  );
}

function clearOverlayVideo(): void {
  // 시각은 기다리지 않는다 — 컷은 컷대로 두고 소리만 뒤따라 사라진다
  overlayVideoEl.hidden = true;
  requestAudioTeardown(overlayMedia, 'release', Date.now());
}

function updateMoodVisual(): void {
  const vis = visualState();
  const mood = vis.sceneOpts.moodTransition;
  const visual = moodVisualState(mood.active, mood.phase);
  moodTransitionEl.hidden = visual.hidden;
  moodTransitionEl.dataset.phase = visual.phase;
  // 불투명도는 `tickMoodGlitch`가 매 프레임 곡선으로 심는다 (U26b) — 여기서는 표시 여부만 정한다.
  // CSS transition을 쓰면 디스토션 붕괴와 검정이 서로 다른 곡선으로 움직여 겹침이 어긋난다.
  if (visual.hidden) moodBlackEl.style.opacity = '0';
  overlayVideoEl.classList.toggle('is-mood-crossfade', visual.crossfadeVisual);
  /**
   * U77 — 반전 영상 앞 15초의 **흰 자막**을 글리치 위로 띄운다.
   *
   * U53에서는 영상의 검정 배경이 글리치를 가리는 것을 막으려고 영상을 글리치 아래로
   * 내렸는데, 그러면 자막까지 묻혔다. 층 대신 합성을 바꾼다 —
   * `screen`은 검정을 항등원으로 두므로 배경은 아무것도 덮지 않고 흰 자막만 타 오른다.
   * 판단은 순수 함수 하나가 한다(`moodOverlayLayer`).
   */
  const layer = moodOverlayLayer(mood.active, mood.phase);
  overlayVideoEl.classList.toggle('is-mood-caption', layer.blend === 'screen');
  /**
   * `#overlay-video`는 **분위기 반전 크로스페이드 단계에서만** 소리를 낸다.
   *
   * 이 엘리먼트를 공유하는 다른 손님은 매치 영상 6개(U36)인데 전부 오디오 트랙이 없어
   * 강제 muted가 결과적으로 무해하다. 소리 있는 오버레이를 새로 등록하면 여기서 조용히
   * 음소거되므로, 그때는 `moodVisualState`가 아니라 에셋 단위 판정이 필요하다.
   * 분위기 전환이 시작되면 재생 중이던 매치 오버레이를 즉시 끊는 것도 **의도**다 —
   * 반전 연출이 화면의 주인이고, 그 위에 대결 그래픽이 남아 있으면 안 된다.
   *
   * ⚠️ U101 — 소유권만으로 끄지 않는다. 반전이 손을 놓은 직후에도 게인이 남아 있으면 그
   * 소리의 주인은 아직 꼬리 램프다. 판정은 `applyOverlayMute()` 한 곳이 한다.
   */
  applyOverlayMute();
}

overlayVideoEl.addEventListener('ended', () => {
  const overlay = visualState().sceneOpts.overlayVideo;
  if (!overlay.active || overlay.restartToken !== overlayRestartToken) return;
  if (!overlay.holdEndFrame) clearOverlayVideo();
  emit(overlayEndEvent(overlay.restartToken, overlay.holdEndFrame));
});
overlayVideoEl.addEventListener('error', () => {
  const overlay = visualState().sceneOpts.overlayVideo;
  if (!overlay.active || overlay.restartToken !== overlayRestartToken) return;
  clearOverlayVideo();
  emit(overlayEndEvent(overlay.restartToken, false));
});

async function ensureOverlayVideo(): Promise<void> {
  const overlay = visualState().sceneOpts.overlayVideo;
  if (!overlay.active || !overlay.assetId) {
    if (overlayAssetId !== null) {
      overlayLoadGeneration += 1;
      clearOverlayVideo();
      overlayAssetId = null;
      overlayRestartToken = -1;
    }
    return;
  }
  if (overlay.assetId === overlayAssetId && overlay.restartToken === overlayRestartToken) return;

  // 새 소스를 붙이기 전에 남아 있던 소리를 정리한다 (테일이 물린 채 src를 갈면 클릭이 난다)
  overlayMedia.track = idleTrack(0);
  overlayMedia.finish('release');
  overlayVideoEl.hidden = true;
  overlayAssetId = overlay.assetId;
  overlayRestartToken = overlay.restartToken;
  const generation = ++overlayLoadGeneration;
  const url = await assetUrl(overlay.assetId);
  if (
    generation !== overlayLoadGeneration ||
    !url ||
    !visualState().sceneOpts.overlayVideo.active ||
    visualState().sceneOpts.overlayVideo.restartToken !== overlay.restartToken
  ) {
    return;
  }
  overlayVideoEl.src = url;
  overlayVideoEl.hidden = false;
  const moodVisual = moodVisualState(
    visualState().sceneOpts.moodTransition.active,
    visualState().sceneOpts.moodTransition.phase,
  );
  // 새 재생이다 — 지난 재생에서 막혔던 기록은 여기서 푼다
  overlayAudioBlocked = false;
  const moodOwned = moodOwnsOverlay(visualState().sceneOpts.moodTransition, overlay.assetId);
  // 이 소스가 반전이 튼 것인가 — 반전이 손을 놓은 뒤에도 꼬리가 다 빠질 때까지 남는다 (U101)
  overlayMoodSource = moodOwned;
  // 소리 있는 파일인가 (U101b) — 매치 v003처럼 트랙이 있는 오버레이가 여기서 갈린다
  overlaySourceAudio = overlayPlaysAudio(visualState().assets.find((a) => a.id === overlay.assetId));
  // 반전 영상은 t0부터 소리가 있다 (앞 15초가 검정이라 그동안 들리는 것은 소리뿐이다 — D8).
  // 0에서 0.6초 램프로 올려 붙이는 순간의 클릭을 없앤다. **소리 있는 매치·승리 오버레이도
  // 같은 램프를 탄다** (U101b) — 붙는 순간의 클릭은 파일이 무엇이든 똑같이 난다.
  // 무음 파일만 정상 게인에서 바로 시작한다(올릴 소리가 없으므로 램프가 무의미하다).
  overlayMedia.track =
    moodOwned || overlaySourceAudio
      ? rampGain(idleTrack(0), 1, MOOD_AUDIO_RAMP_SEC, Date.now())
      : idleTrack(1);
  // 게인을 심은 **뒤에** 판정한다 — `overlayMuted()`가 그 값을 본다
  applyOverlayMute();
  try {
    overlayVideoEl.currentTime = 0;
  } catch {
    /* 메타데이터 로드 전이면 0에서 시작한다 */
  }
  void overlayVideoEl.play().catch((error: unknown) => {
    // `AbortError`는 다음 오버레이가 이 재생을 밀어낸 것이다 — 그 재생이 끝을 보고할 것이므로
    // 여기서 종료 이벤트를 쏘면 **다음 재생의 끝**을 앞당겨 죽인다 (U48 후속).
    const outcome = classifyPlayRejection(error);
    if (outcome === 'ignore') return;
    if (outcome === 'autoplay-lock' && moodVisual.videoAudio) {
      overlayAudioBlocked = true;
      applyOverlayMute();
      needsAudioUnlock = true;
      reportAudioState();
      void overlayVideoEl.play().catch(() => emit(overlayEndEvent(overlay.restartToken, false)));
      return;
    }
    emit(overlayEndEvent(overlay.restartToken, false));
  });
}

/**
 * 설명 영상은 검정 페이드가 자기 볼륨 곡선을 갖는다(`volumeForOpacity`). 그래서 램프가 아니라
 * `setGain`으로 그 곡선을 매 프레임 그대로 싣고, 매니저는 마스터와의 곱만 담당한다.
 * 중단·스킵처럼 곡선 없이 끊기는 경로만 `requestAudioTeardown`으로 페이드 아웃시킨다.
 */
const videoMedia: GatedMedia = {
  el: videoEl,
  track: idleTrack(1),
  finish: (mode) => {
    videoEl.pause();
    if (mode === 'release') videoEl.removeAttribute('src');
  },
};
gatedMedia.push(videoMedia);

/**
 * 중계 카메라. `pause()`하면 미리보기가 죽으므로 정리는 **mute**다.
 * 소리가 실제로 나가는지는 아래 매 프레임 갱신이 게인까지 함께 보고 정한다.
 */
const camMedia: GatedMedia = {
  el: camEl,
  track: idleTrack(1),
  finish: () => {
    setOutputMuted(camEl, true);
  },
};
gatedMedia.push(camMedia);

/**
 * 전환 스팅어 — **효과음 레이어** (U102).
 *
 * ## 왜 여섯 번째 트랙인가
 * 2026-09-05 04:08 지시: "스팅어의 경우는 깔리고있는 오디오 위에 사운드가 겹쳐져서 나야하고
 * (그쪽은 효과음 위주라) 다른 꼭지들은 해당 미디어의 사운드만 재생되는 게 메인인 셈임."
 * 소리가 나가는 이상 볼륨의 주인은 매니저 하나여야 한다 — `.volume`을 직접 쓰는 순간
 * §3 계약("모든 `.volume` 쓰기는 `audio-gain.ts` 경유")에 구멍이 생기고, 마스터 볼륨과
 * 암전 오디오 축(U95)이 이 엘리먼트에만 걸리지 않는다.
 *
 * ## 겹치기 위해 **하지 않는** 것들
 *  · 음악 덕킹(U44) — `videoAudioOwnsOutput(state)`는 `sceneOpts.video`(full 설명 영상)만 본다.
 *    스팅어는 `sceneOpts.transitionVideo`라 애초에 그 판정에 들어가지 않는다. 넣으면 효과음이
 *    울릴 때마다 BGM이 2초씩 내려갔다 올라와 "겹쳐서 난다"가 성립하지 않는다.
 *  · 카메라 파킹 — 스팅어는 씬을 바꾸지 않는 자리(리플레이 래핑)에서도 돌고, 씬을 바꾸는
 *    자리에서는 씬 쪽 경로가 이미 자기 정리를 한다. 여기서 손대면 주인이 둘이 된다.
 *  · 꼬리 페이드·`#media-tail` 보관 — 1.5초 컷 클립이라 남길 꼬리가 없다. 게인은 언제나
 *    `TRANSITION_STINGER_GAIN`(0.4, U116 0.8 → U129) 고정이고 램프를 걸지 않으므로 `requiresDocumentPresence`도 참이 되지 않는다(엘리먼트는 어차피
 *    `viewport`에 붙박이라 문서에서 떨어질 일 자체가 없다).
 *
 * 그래서 `finish`는 **실제로 불릴 일이 없다**(0으로 내리는 램프가 없다). 그럼에도 매니저 계약을
 * 지키려고 채워 둔다 — 나중에 누가 램프를 걸어도 정리가 매니저 경유로 남는다.
 */
// U116: 스팅어 게인 상수(`TRANSITION_STINGER_GAIN` = 0.4, U129)는 `transition-video.ts`에 있다 —
// 이 파일은 DOM 부팅 시 부작용이 있어 테스트가 직접 import할 수 없으므로, 부작용 없는
// 그 파일에서 정의하고 여기서는 import해 쓴다.
const transitionMedia: GatedMedia = {
  el: transitionVideoEl,
  track: idleTrack(TRANSITION_STINGER_GAIN),
  finish: (mode) => {
    transitionVideoEl.pause();
    if (mode === 'release') transitionVideoEl.removeAttribute('src');
  },
};
gatedMedia.push(transitionMedia);

let transitionAssetId: string | null = null;
let transitionRestartToken = -1;
let transitionBoundAssetId: string | null = null;
let transitionBoundToken = -1;
let transitionLoadGeneration = 0;
let transitionSwitchReportedToken = -1;
let transitionLocallyEndedToken = -1;
let transitionEndLastReportedAt = 0;
let transitionPreloadedAssetId: string | null = null;
let transitionPreloadRequestedAssetId: string | null = null;

async function assetUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const rec = await getAsset(id);
  if (!rec) return null;
  // .mov는 MIME이 video/quicktime이라 Chrome이 재생 자체를 거부한다 → mp4 타입으로 바꿔 준다
  const url = URL.createObjectURL(playableBlob(rec));
  urlCache.set(id, url);
  return url;
}

/**
 * 영상 소스·재생 상태를 상태에 맞춘다.
 * `restartToken`이 바뀌면 같은 영상이라도 처음부터 다시 튼다 (큐시트에서 같은 영상을 두 번 쓰는 경우).
 */
async function ensureVideo(assetId: string | null, restartToken: number, paused: boolean): Promise<void> {
  const changed = assetId !== videoAssetId;
  const restart = restartToken !== videoRestartToken;
  videoRestartToken = restartToken;

  if (changed) {
    videoAssetId = assetId;
    if (!assetId) {
      // 소리는 `audioCutFadeSec` 동안 내려간 뒤에 소스가 떨어진다 (U27)
      requestAudioTeardown(videoMedia, 'release', Date.now());
      videoSrcAssetId = null;
      videoSrcRestartToken = restartToken;
      return;
    }
    const url = await assetUrl(assetId);
    // blob 조회를 기다리는 사이에 다음 영상이 예약됐다면 이 continuation은 낡았다 —
    // 여기서 src를 붙이면 새 영상을 옛 영상으로 덮어쓴다.
    if (videoAssetId !== assetId) return;
    // 조회 실패면 소스를 붙이지 않는다. `videoSrcAssetId`가 옛 값으로 남아 꼬리 페이드 판정이
    // 막히고, 그 무응답은 control의 full-video 워치독이 받아 낸다.
    // 단, 그 워치독은 만능이 아니다 — `syncFullVideoWatchdog`(control.ts:437-440)은 에셋의
    // `durationSec`을 모르면 `deadline === null`로 아예 무장하지 않는다. 길이 미상 에셋이
    // 여기서 걸리면 조작자가 패널의 `⏭ 스킵`을 누를 때까지 검정 화면에 머문다.
    if (!url) return;
    // 새 소스가 붙었으니 페이드 아웃 중이던 정리 예약을 취소한다 — 뒤늦게 도착하면
    // 방금 붙인 이 소스를 떼어 낸다.
    // 순서가 중요하다 — `setGain`은 정리 예약 중이면 무시하므로 **먼저 예약을 취소**해야
    // 게인이 1로 올라간다. 뒤집으면 새 소스에 옛 페이드 아웃 램프가 그대로 남는다.
    videoMedia.track = setGain(cancelTeardown(videoMedia.track), 1);
    videoEl.src = url;
    videoSrcAssetId = assetId;
  }
  if (!assetId) return;
  if (changed || restart) {
    // 되감았으니 이번 재생의 'ended' 기록도 함께 지운다 — 남겨 두면 다음 playing 진입이
    // 시작하자마자 꼬리 페이드로 들어간다 (리뷰 M1). phase가 idle인 경로까지 여기서 덮는다.
    fadeEndedSeen = false;
    try {
      videoEl.currentTime = 0;
    } catch {
      /* 메타데이터 로드 전이면 무시 — loadeddata 이후 0에서 시작한다 */
    }
    // 소스가 실제로 붙은 뒤에만 도달한다 (조회 실패는 위에서 return). 이제부터 이 엘리먼트의
    // 시간은 이번 재생의 것이다.
    videoSrcRestartToken = restartToken;
  }
  if (paused) {
    // AUDIO-CUT-EXEMPT: 조작 패널의 일시정지는 **화면도 함께 멎어야 한다.** 같은 엘리먼트라
    // 소리만 늦출 방법이 없고, 그림이 0.6초 더 흐르는 쪽이 훨씬 나쁘다. 이건 컷이 아니라
    // 일시정지이므로 U27의 고스트 테일 대상이 아니다.
    if (!videoEl.paused) {
      videoEl.pause();
      videoMedia.track = setGain(videoMedia.track, 0);
    }
  } else if (videoEl.paused) {
    videoMedia.track = setGain(videoMedia.track, 1);
    void videoEl.play().catch((error: unknown) => {
      // `AbortError`는 소스 교체·되감기가 이 재생을 밀어낸 것이다. 여기서 muted로 떨어뜨리면
      // **다음 재생이 이유 없이 무음**으로 시작하고 거짓 잠금 배너까지 뜬다 (U48 후속).
      const outcome = classifyPlayRejection(error);
      if (outcome === 'ignore') return;
      if (outcome === 'error') {
        console.warn('[video] play() 실패', error);
        return;
      }
      // 자동재생 정책(소리 있는 재생 차단)에 걸리면 **일단 음소거로라도 틀고**
      // 배지로 클릭을 유도한다. 화면이 검은 채로 멈추는 것이 제일 나쁘다.
      setOutputMuted(videoEl, true);
      needsAudioUnlock = true;
      reportAudioState();
      void videoEl.play().catch(() => undefined);
    });
  }
}

function clearTransitionElement(preservePreload = false): void {
  transitionVideoEl.pause();
  transitionVideoEl.hidden = true;
  // 붙어 있던 스팅어를 놓는 자리다 — 소리 판정도 함께 되돌린다 (U102).
  // 예열(`load()`)은 autoplay가 꺼져 있어 재생되지 않지만, 판정이 남아 있으면 다음 소스가
  // 아직 자기 값을 심기 전 한 프레임 동안 남의 판정으로 서 있게 된다.
  setOutputMuted(transitionVideoEl, true);
  if (!preservePreload) {
    transitionVideoEl.removeAttribute('src');
    transitionPreloadedAssetId = null;
  }
  transitionPreloadRequestedAssetId = null;
  transitionBoundAssetId = null;
  transitionBoundToken = -1;
}

/** 첫 알파 전환을 누르기 전에 Blob 조회·미디어 파서를 백그라운드에서 예열한다. */
async function prewarmTransitionVideo(): Promise<void> {
  if (visualState().sceneOpts.transitionVideo.active || transitionAssetId !== null) return;
  const assetId = pickTransitionPreloadAssetId(visualState().assets);
  if (!assetId || assetId === transitionPreloadedAssetId || assetId === transitionPreloadRequestedAssetId) {
    return;
  }

  transitionPreloadRequestedAssetId = assetId;
  const url = await assetUrl(assetId);
  if (
    transitionPreloadRequestedAssetId !== assetId ||
    !url ||
    visualState().sceneOpts.transitionVideo.active ||
    transitionAssetId !== null ||
    pickTransitionPreloadAssetId(visualState().assets) !== assetId
  ) {
    return;
  }

  transitionPreloadRequestedAssetId = null;
  clearTransitionElement();
  // 디코딩 준비만 — 재생은 시작하지 않는다 (autoplay를 끈 뒤 load()하는 순서가 계약)
  preloadTransitionVideo(transitionVideoEl, url);
  transitionPreloadedAssetId = assetId;
}

function reportTransitionEnded(token: number, now = performance.now()): void {
  if (token < 0) return;
  transitionEndLastReportedAt = now;
  emit(`transition-ended:${token}`);
}

function finishTransitionLocally(token: number): void {
  if (token < 0 || token !== transitionRestartToken) return;
  transitionLocallyEndedToken = token;
  clearTransitionElement();
  reportTransitionEnded(token);
}

transitionVideoEl.addEventListener('ended', () => finishTransitionLocally(transitionBoundToken));
transitionVideoEl.addEventListener('error', () => finishTransitionLocally(transitionBoundToken));

async function ensureTransitionVideo(): Promise<void> {
  const transition = visualState().sceneOpts.transitionVideo;
  if (!transition.active || !transition.assetId) {
    if (transitionAssetId !== null) {
      transitionLoadGeneration += 1;
      clearTransitionElement();
      transitionAssetId = null;
      transitionRestartToken = -1;
      transitionLocallyEndedToken = -1;
    }
    return;
  }

  // 종료 프레임은 display에서 즉시 숨긴다. control이 그 순간 없어
  // 상태 이벤트를 놓친 경우에도 돌아올 때까지 동일 토큰을 주기적으로 재전송한다.
  if (transitionLocallyEndedToken === transition.restartToken) {
    const now = performance.now();
    if (
      shouldRepeatTransitionEnd(
        transition,
        transitionLocallyEndedToken,
        now,
        transitionEndLastReportedAt,
      )
    ) {
      reportTransitionEnded(transition.restartToken, now);
    }
    return;
  }

  const changed =
    transition.assetId !== transitionAssetId || transition.restartToken !== transitionRestartToken;
  if (!changed) return;

  // 새 소스가 IndexedDB에서 로드되는 동안 이전 영상의 시간/종료 이벤트를
  // 새 토큰으로 착각하지 않도록 먼저 바인딩을 끊는다.
  const reusePreload = transitionPreloadedAssetId === transition.assetId;
  clearTransitionElement(reusePreload);
  transitionAssetId = transition.assetId;
  transitionRestartToken = transition.restartToken;
  transitionSwitchReportedToken = -1;
  transitionLocallyEndedToken = -1;
  const generation = ++transitionLoadGeneration;
  const assetId = transition.assetId;
  const token = transition.restartToken;
  const url = await assetUrl(assetId);

  // IndexedDB 조회 중 새 전환이 들어오면 예전 응답은 절대 DOM에 붙이지 않는다.
  if (
    generation !== transitionLoadGeneration ||
    !visualState().sceneOpts.transitionVideo.active ||
    visualState().sceneOpts.transitionVideo.assetId !== assetId ||
    visualState().sceneOpts.transitionVideo.restartToken !== token
  ) {
    return;
  }
  if (!url) {
    finishTransitionLocally(token);
    return;
  }

  if (!reusePreload || transitionVideoEl.src !== url) transitionVideoEl.src = url;
  transitionPreloadedAssetId = null;
  transitionVideoEl.hidden = false;
  normalizeTransitionPlayback(transitionVideoEl);
  // 스팅어의 소리 판정은 에셋 메타 하나다 (U102) — 설명 영상과 **같은 문장**이라 두 자리가
  // 갈라질 여지가 없다. 게인은 매니저가 1로 들고 있고, 여기서는 세 축(모니터·창 음소거·에셋)만 곱한다.
  setOutputMuted(
    transitionVideoEl,
    visualState().assets.find((a) => a.id === assetId)?.audio === false,
  );
  try {
    transitionVideoEl.currentTime = 0;
  } catch {
    /* 메타데이터 로드 전이면 0에서 자연스럽게 시작한다 */
  }
  const markBound = () => {
    if (
      generation === transitionLoadGeneration &&
      visualState().sceneOpts.transitionVideo.active &&
      visualState().sceneOpts.transitionVideo.assetId === assetId &&
      visualState().sceneOpts.transitionVideo.restartToken === token
    ) {
      transitionBoundAssetId = assetId;
      transitionBoundToken = token;
      // control의 stall 워치독이 "로딩 여유"에서 "재생 시계"로 기준을 바꾸는 신호
      emit(`transition-bound:${token}`);
    }
  };
  // **시각은 절대 실패하지 않는다** (U102). 스팅어가 소리를 갖게 되면서 자동재생 정책에 걸릴
  // 수 있는 자리가 생겼다 — 그때 전환 그림까지 함께 죽으면 씬이 멈춘다. 거부를 분류해 되살리는
  // 사다리는 `transition-video.ts`가 쥐고(순수 로직이라 테스트가 실제로 돌린다), 여기서는
  // **바깥 세계에 손대는 네 자리**만 자기 단일 경로로 꽂는다.
  //
  // 잠금은 배너 경로에 태우되 `pendingAudioResumePlan`에는 스팅어를 넣지 않는다 — 1.5초 컷이라
  // 잠금이 풀릴 즈음이면 이미 끝나 있고, 되살리면 화면에 없는 효과음만 뒤늦게 울린다.
  // 복구는 **다음 스팅어부터** 저절로 된다.
  void playTransitionWithAudioFallback(transitionVideoEl, {
    demoteToMuted: () => setOutputMuted(transitionVideoEl, true),
    reportAudioLock: () => {
      needsAudioUnlock = true;
      reportAudioState();
    },
    normalize: () => normalizeTransitionPlayback(transitionVideoEl),
    onStarted: markBound,
    onFailed: () => finishTransitionLocally(token),
  });
}

// ---------------------------------------------------------------- 현장 사진 슬라이드쇼 (§4-2)
//
// 두 레이어(A/B) 크로스페이드 + Ken Burns. **CSS transition만 쓴다** — rAF 수동 보간이 아니다.
// 크로스페이드는 opacity 한 값이고 Ken Burns는 transform 하나라, 둘 다 합성만 하는 애니메이션이라
// GPU에서 끝난다(레이아웃·페인트 0). `#fade-black`(z 44)·`#transition-video`(z 45)는 `#stage`
// **위** 레이어이므로 스팅어가 사진 전환에 겹쳐도 z 경합이 없다.
//
// **재생 위치는 이 창의 로컬 값이다** — 상태에 넣지 않는다. 매 4초마다 전체 상태를 저장·방송하면
// 원장·리더 락 경로가 오염되고, 두 display가 같은 사진을 보일 이유도 없다.

/** 크로스페이드 길이. 사진 간격 하한 2초의 30% 이내 */
const PHOTO_FADE_MS = 600;
/** `prefers-reduced-motion: reduce`일 때 (Ken Burns도 함께 꺼진다) */
const PHOTO_FADE_REDUCED_MS = 150;
/** objectURL LRU 상한 — 현재·다음·직전 몇 장이면 충분하다 */
const PHOTO_URL_LRU = 8;

function createPhotoLayer(): HTMLImageElement {
  const el = document.createElement('img');
  // 사진 메타 문자열을 DOM에 **절대** 싣지 않는다 (§11 H3) — 붙는 것은 objectURL src뿐이다.
  // 속성 집합 자체는 `scenes/photos.ts`의 순수 팩토리가 소유한다: 여기서 손으로 붙이면
  // node 테스트가 검사할 수 있는 자리가 없어 "alt 말고 아무것도 없다"가 무검증으로 남는다.
  for (const [name, value] of Object.entries(photoLayerAttrs())) el.setAttribute(name, value);
  return el;
}

const photoA = createPhotoLayer();
const photoB = createPhotoLayer();
let photoSlotEl: HTMLElement | null = null;
let photoFilterSignature: string | null = null;
let photoRuntimeEnabled = wantPhotoRuntimeFor(shownScene);
/** 지금 보이는(=`is-on`) 레이어. 다음 사진은 항상 반대쪽에 실린다. */
let photoFront: HTMLImageElement = photoA;
let photoId: string | null = null;
/**
 * **front 레이어에 실제로 실려 있는** 사진 id (§11 L6).
 *
 * `photoId`는 "지금 재생 중이어야 할 사진"이라 `showPhoto`가 디코드를 기다리는 동안 이미 새 값이다.
 * 그 사이에 `resumePhotoMotion`이 `photoId`로 Ken Burns를 계산하면 **아직 옛 사진이 떠 있는
 * 레이어에 새 사진의 궤적**을 심어 화면이 튄다. 그래서 "레이어가 지금 무엇을 보여 주는가"는
 * 별도로 들고, 모션 복원은 이쪽을 근거로 한다.
 */
let photoFrontId: string | null = null;
/** 현재 사진이 뜬 시각 — `paint()`의 `now`(=`Date.now()`) 한 시계만 쓴다 (§11 L8) */
let photoShownAt = 0;
let photoCycle = 0;
/** 무작위 셔플 시드 = 사이클 번호. 한 바퀴 안에서는 고정, 루프마다 다시 섞인다. */
let photoSeed = 0;
/** 직전 큐 — 재생 중인 사진이 숨겨졌을 때 "같은 자리의 다음"을 찾는 근거 */
let photoPrevQueue: readonly string[] = [];
let photoLastTickAt = 0;
/** 비동기 로드가 뒤늦게 끝나 이미 지난 사진을 페이드시키는 것을 막는 세대 토큰 */
let photoSwapGeneration = 0;
/** 스팅어·설명 영상이 덮고 있는 동안 정지 상태인가 (§11 M3) */
let photoHeld = false;
/**
 * 상태에는 있는데 IndexedDB blob이 없는 사진 (흡수 중 크래시·수동 삭제).
 * 큐에서 빼지 않으면 그 사진 차례마다 화면이 검은 채로 간격만큼 멈춘다.
 *
 * 값은 **깨진 것으로 판정하던 순간의 메타 객체 참조**다 (§11 M5). 같은 id가 나중에 다시
 * 흡수되면(삭제 후 재선택 등) reducer가 새 객체를 만들어 넣으므로 참조가 달라지고,
 * `pruneBrokenPhotos`가 그 한 건만 골라 재시도 대상으로 되돌린다. 참조가 그대로면
 * blob이 생겼을 리 없으니 계속 제외한다 — 매번 전부 풀면 진짜로 없는 사진이 items가
 * 바뀔 때마다 큐에 복귀해 검은 프레임을 한 번씩 만든다.
 */
const photoBroken = new Map<string, PhotoMeta | null>();
/** `pruneBrokenPhotos`가 마지막으로 훑은 `items` 참조 */
let photoBrokenItems: readonly PhotoMeta[] | null = null;
const photoUrls = new Map<string, string>();

/**
 * 2부 잠금 상태의 **직전 값**. `true → false`(재잠금) 전이를 잡아 "지금 떠 있는 2부 사진을
 * 크로스페이드 없이 즉시 끊는다"를 판단한다 (§11 M9).
 * 첫 틱에는 비교 대상이 없으므로 `null`로 시작한다(전이로 오인하지 않게).
 */
let photoUnlockedSeen: boolean | null = null;
/**
 * 재잠금이 있었지만 아직 화면에 반영하지 못한 상태(스팅어 hold 중이면 틱이 일찍 돌아간다).
 * 큐 판정에 도달할 때까지 들고 있다가 그 자리에서 소비한다.
 */
let photoRelockPending = false;

interface PhotoQueueSnapshot {
  list: string[];
  /** 포함 판정 O(1) — `paint()`가 매 프레임 `Array.includes`로 500장을 훑지 않게 (§11 H4) */
  set: Set<string>;
}

/**
 * 큐 메모이즈 (§11 H4).
 *
 * 캐시 키는 `(items 참조, order, seed, p2.unlocked, 깨진 장수)`다. `items` 참조 비교가 성립하는
 * 근거는 reducer의 **"변화가 없으면 같은 참조를 반환한다"** 계약이다(`photos/add`가 0건 추가면
 * 같은 상태를 그대로 돌려주는 등). 이게 없으면 60fps × 500장 정렬/셔플이 매 프레임 돈다.
 */
let photoQueueCache: {
  items: readonly PhotoMeta[];
  order: PhotoOrder;
  seed: number;
  unlocked: boolean;
  broken: number;
  snap: PhotoQueueSnapshot;
} | null = null;

/**
 * `items` 참조가 갈릴 때만 도는 깨진 목록 정리 (§11 M5).
 *
 * · 목록에서 사라진 사진 → 더 들고 있을 이유가 없다(큐에도 못 들어온다).
 * · 같은 id인데 **다른 메타 객체**로 다시 들어온 사진 → 재흡수다. blob이 새로 쓰였을 수 있으니
 *   한 번 더 시도한다. 다시 실패하면 그 자리에서 도로 깨진 것으로 표시된다.
 */
function pruneBrokenPhotos(items: readonly PhotoMeta[]): void {
  if (photoBrokenItems === items) return;
  photoBrokenItems = items;
  if (!photoBroken.size) return;
  const byId = new Map(items.map((p) => [p.id, p] as const));
  for (const [id, meta] of [...photoBroken]) {
    const now = byId.get(id);
    if (now === undefined || now !== meta) photoBroken.delete(id);
  }
}

function currentPhotoQueue(): PhotoQueueSnapshot {
  const { items, settings } = visualState().photos;
  const unlocked = visualState().p2.unlocked;
  const order = photoOrderForScene(shownScene, settings.order);
  pruneBrokenPhotos(items);
  const c = photoQueueCache;
  if (
    c &&
    c.items === items &&
    c.order === order &&
    c.seed === photoSeed &&
    c.unlocked === unlocked &&
    c.broken === photoBroken.size
  ) {
    return c.snap;
  }
  // hidden 제외·2부 잠금 반영·정렬은 photos.ts의 순수 함수가 한다 (테스트 가능한 유일한 자리)
  const list = photoQueue(items, order, photoSeed, unlocked).filter(
    (id) => !photoBroken.has(id),
  );
  const snap: PhotoQueueSnapshot = { list, set: new Set(list) };
  photoQueueCache = {
    items,
    order,
    seed: photoSeed,
    unlocked,
    broken: photoBroken.size,
    snap,
  };
  return snap;
}

function photoFadeMs(): number {
  return reduceMotion.matches ? PHOTO_FADE_REDUCED_MS : PHOTO_FADE_MS;
}

function photoIntervalMs(): number {
  return clampIntervalSec(visualState().photos.settings.intervalSec) * 1000;
}

/** 설정이 켜져 있어도 **모션 최소화면 무조건 끈다** (사용자 시스템 설정이 이긴다) */
function photoMotionOn(): boolean {
  return visualState().photos.settings.kenBurns && !reduceMotion.matches;
}

/** 상태 변화가 있을 때만 슬롯 클래스를 바꿔 60fps paint에서 불필요한 DOM 쓰기를 피한다. */
function syncPhotoFilters(): void {
  if (!photoSlotEl) return;
  const active = photoFilterClasses(visualState().photos.settings);
  const signature = active.join(' ');
  if (signature === photoFilterSignature) return;
  const enabled = new Set(active);
  for (const name of ['is-sepia', 'is-vignette', 'is-grain']) {
    photoSlotEl.classList.toggle(name, enabled.has(name));
  }
  photoFilterSignature = signature;
}

/**
 * translate를 scale보다 **앞**에 쓴다: 이 순서에서 translate의 %는 확대 전 박스 크기를 기준으로
 * 계산되므로, `kenBurnsFor`가 `(scale-1)/2`로 잡아 둔 여백 한계와 단위가 맞는다
 * (뒤집으면 이동량이 배율만큼 커져 확대된 이미지 바깥이 드러난다).
 */
function photoTransformStart(kb: KenBurns): string {
  return `translate(0%, 0%) scale(${kb.fromScale})`;
}

function photoTransformEnd(kb: KenBurns): string {
  return `translate(${kb.dx}%, ${kb.dy}%) scale(${kb.toScale})`;
}

/** blob → objectURL (LRU). 화면에 떠 있는 사진은 축출 대상에서 뺀다 — revoke하면 그 자리에서 깨진다. */
async function photoUrl(id: string): Promise<string | null> {
  const cached = photoUrls.get(id);
  if (cached) {
    photoUrls.delete(id); // 최근 사용으로 끌어올린다
    photoUrls.set(id, cached);
    return cached;
  }
  const rec = await getPhoto(id);
  if (!rec?.blob) return null;
  const url = URL.createObjectURL(rec.blob);
  photoUrls.set(id, url);
  if (photoUrls.size > PHOTO_URL_LRU) {
    // 크로스페이드 중에는 **두 장**이 동시에 떠 있다 (§11 L8): 새로 싣는 `id`와, 아직 사라지는
    // 중인 front 레이어의 사진. front는 `photoId`와 다를 수 있으므로(다음 사진이 이미
    // 결정됐지만 스왑 전) id 비교만으로는 부족하다 — 실제로 붙어 있는 src를 직접 뺀다.
    // revoke하면 그 자리에서 이미지가 깨진 채로 페이드가 진행된다.
    const frontUrl = photoFront.getAttribute('src');
    for (const key of [...photoUrls.keys()]) {
      if (photoUrls.size <= PHOTO_URL_LRU) break;
      if (key === id || key === photoId || key === photoFrontId) continue;
      const dead = photoUrls.get(key);
      if (!dead || dead === frontUrl) continue;
      URL.revokeObjectURL(dead);
      photoUrls.delete(key);
    }
  }
  return url;
}

/**
 * 다음 사진을 뒷 레이어에 실어 크로스페이드한다.
 *
 * **디코드가 끝난 뒤에 페이드를 시작한다** — 안 하면 첫 프레임이 빈 채로 600ms가 흘러
 * "사진이 늦게 뜬다"로 보인다.
 */
async function showPhoto(id: string): Promise<void> {
  const gen = ++photoSwapGeneration;
  const url = await photoUrl(id);
  if (gen !== photoSwapGeneration) return;
  if (!url) {
    // 상태에는 있는데 blob이 없다 → 큐에서 빼고 다음 틱에 즉시 다음 사진으로 넘어간다.
    // 함께 적어 두는 메타 참조가 "나중에 다시 흡수되면 재시도"의 근거다 (§11 M5).
    photoBroken.set(id, visualState().photos.items.find((p) => p.id === id) ?? null);
    if (photoId === id) {
      photoId = null;
      photoShownAt = 0;
    }
    return;
  }

  const back = photoFront === photoA ? photoB : photoA;
  if (back.src !== url) back.src = url;
  try {
    await back.decode();
  } catch {
    /* 디코드 실패·중도 src 교체 — 아래 세대 가드가 잡는다. 실패해도 페이드는 진행한다. */
  }
  if (gen !== photoSwapGeneration) return;

  // 진입 스냅이면 첫 장은 0ms — 플래그는 여기서 소비한다 (U40). 두 번째 장부터는 평소 페이드다.
  const fadeMs = photoCutFirstSwap ? 0 : photoFadeMs();
  photoCutFirstSwap = false;
  // 덮개(스팅어·설명 영상) 아래에서 첫 사진을 싣는 경우에는 Ken Burns를 **켜지 않는다** (§11 M1·M3):
  // 아무도 못 보는 궤적에 합성기를 쓸 이유가 없다. 덮개가 걷힐 때 `resumePhotoMotion`이
  // 남은 시간만큼 궤적을 깔아 준다.
  const motion = photoMotionOn() && !photoHeld;
  const kb = kenBurnsFor(id);
  if (!photoHeld) back.style.willChange = ''; // 인라인 해제 → CSS의 will-change로 복귀
  // 시작 transform을 transition 없이 심고 → 강제 reflow → 끝 transform.
  // 키프레임을 만들지 않는 이유: 사진마다 방향이 다르므로 @keyframes를 동적으로 주입해야 하는데,
  // 그러면 스타일시트가 사진 수만큼 늘어난다.
  back.style.transition = 'none';
  back.style.transform = motion ? photoTransformStart(kb) : 'none';
  void back.offsetWidth;
  back.style.transition = motion
    ? `opacity ${fadeMs}ms linear, transform ${photoIntervalMs() + fadeMs}ms linear`
    : `opacity ${fadeMs}ms linear`;
  if (motion) back.style.transform = photoTransformEnd(kb);

  back.classList.add('is-on');
  photoFront.classList.remove('is-on');
  photoFront = back;
  photoFrontId = id;
}

/**
 * 다음 사진으로 넘어간다.
 *
 * `cut`이면 크로스페이드 없이 **끊는다** — 2부 재잠금처럼 "지금 떠 있는 사진이 더는 보이면
 * 안 되는" 경우다 (§11 M9). front의 `is-on`을 먼저 떼어 그 프레임에 사라지게 하고,
 * 새 사진은 그 뒤에 평소대로 실린다(600ms 동안 2부 사진이 비쳐 보이는 일이 없다).
 */
function advanceToNextPhoto(q: PhotoQueueSnapshot, now: number, cut = false): void {
  if (cut) {
    photoSwapGeneration += 1; // 진행 중인 로드가 뒤늦게 옛 사진을 되살리지 않게
    // `is-on`만 떼면 **인라인 `transition: opacity 600ms`가 그대로 살아 있어** 600ms 동안
    // 2부 사진이 점점 옅어지며 보인다(CSS에는 transition이 없다 — 전부 showPhoto가 심은 인라인이다).
    // transition을 끄고 강제 reflow로 확정한 뒤에 떼어야 그 프레임에 사라진다.
    for (const el of [photoA, photoB]) {
      el.style.transition = 'none';
      void el.offsetWidth;
      el.classList.remove('is-on');
    }
    photoFront.classList.remove('is-on');
    photoFrontId = null;
  }
  const next = advancePhoto(q.list, photoId, photoCycle, photoPrevQueue);
  photoPrevQueue = q.list;
  if (!next.id) {
    if (cut) photoId = null;
    return;
  }
  let id = next.id;
  if (next.cycle !== photoCycle) {
    photoCycle = next.cycle;
    photoSeed = nextPhotoSessionSeed(photoSeed, next.cycle); // 다음 바퀴도 직전과 다른 순서로 섞는다
    // **새 시드로 즉시 다시 섞고 그 큐의 첫 장부터 간다** (§11 H1).
    // `next.id`는 방금 끝난 바퀴의 큐 기준 `q[0]`이라, 다시 섞인 큐에서는 한가운데에 있을 수
    // 있다. 그 자리를 이어받으면 두 바퀴째부터는 **꼬리만** 재생되고 앞쪽 사진이 통째로
    // 건너뛰어진다. 캐시를 버리고 다시 만들어야 seed 변경이 이번 바퀴부터 반영된다.
    photoQueueCache = null;
    const fresh = currentPhotoQueue();
    if (!fresh.list.length) {
      if (cut) photoId = null;
      return;
    }
    id = fresh.list[0];
    photoPrevQueue = fresh.list;
  }
  photoId = id;
  photoShownAt = now;
  void showPhoto(id);
}

/** 스팅어가 덮은 동안 Ken Burns를 **현재 위치 그대로** 세운다 (§11 M3) */
function freezePhotoMotion(): void {
  for (const el of [photoA, photoB]) {
    const at = window.getComputedStyle(el).transform;
    el.style.transition = 'none';
    if (at && at !== 'none') el.style.transform = at;
    // 합성 레이어를 반납해 1080p 알파 영상 쪽에 GPU를 양보한다
    el.style.willChange = 'auto';
  }
}

/** 덮개가 걷히면 남은 시간만큼 Ken Burns를 이어서 굴린다 */
function resumePhotoMotion(now: number): void {
  for (const el of [photoA, photoB]) el.style.willChange = '';
  // 근거는 `photoId`가 아니라 **front가 실제로 보여 주는 사진**이다 (§11 L6): 덮개가 걷히는
  // 순간에 `showPhoto`가 디코드 대기 중이면 `photoId`는 이미 다음 사진이고, 그 궤적을 아직
  // 옛 사진이 떠 있는 레이어에 심으면 화면이 튄다. 스왑이 끝나면 `showPhoto`가 새 레이어에
  // 제 궤적을 다시 깔아 주므로 여기서 건너뛰어도 잃는 것이 없다.
  if (!photoFrontId || photoFrontId !== photoId || !photoMotionOn()) return;
  const remain = Math.max(0, photoIntervalMs() + photoFadeMs() - (now - photoShownAt));
  const kb = kenBurnsFor(photoFrontId);
  void photoFront.offsetWidth;
  photoFront.style.transition = `opacity ${photoFadeMs()}ms linear, transform ${remain}ms linear`;
  photoFront.style.transform = photoTransformEnd(kb);
}

/**
 * 두 레이어를 모두 투명으로.
 *
 * `cut`이면 인라인 transition을 끊고 그 프레임에 사라지게 한다 — 2부 재잠금으로 큐가 통째로
 * 비는 경우(§11 M9)와 씬을 떠나는 경우다. 평소(사진을 전부 숨김·삭제)에는 남겨 두는 편이
 * 자연스러워 페이드 그대로 둔다.
 */
function clearPhotoLayers(cut = false): void {
  photoSwapGeneration += 1; // 진행 중인 로드가 뒤늦게 페이드를 시작하지 않게
  if (cut) {
    for (const el of [photoA, photoB]) {
      el.style.transition = 'none';
      void el.offsetWidth;
    }
  }
  photoA.classList.remove('is-on');
  photoB.classList.remove('is-on');
  photoId = null;
  photoFrontId = null;
}

/** 사진 씬을 떠날 때 objectURL을 **전부** 반납한다 (§11 M9) */
function releasePhotos(): void {
  clearPhotoLayers(true);
  photoA.removeAttribute('src');
  photoB.removeAttribute('src');
  for (const url of photoUrls.values()) URL.revokeObjectURL(url);
  photoUrls.clear();
  photoPrevQueue = [];
  photoQueueCache = null;
  photoHeld = false;
  // 깨진 목록도 씬을 떠날 때 함께 버린다 (§11 M5) — 일회성 IndexedDB 실패나 흡수 중 크래시로
  // 들어온 id가 세션 내내 남아 "다시 넣어도 안 나온다"가 되는 것을 막는다. 다음 진입 때
  // 한 번 더 시도해 보고, 진짜로 없으면 그때 다시 채워진다(첫 바퀴 한 번의 비용).
  photoBroken.clear();
  photoBrokenItems = null;
  photoUnlockedSeen = null;
  photoRelockPending = false;
}

/**
 * 첫 장을 페이드 없이 끊어 넣을 것인가 (U40). `showPhoto`가 한 번 쓰고 내린다 —
 * 세션 하나의 **첫 장에만** 해당하므로 플래그로 두고 소비한다.
 */
let photoCutFirstSwap = false;

/**
 * 대기 화면을 다시 부를 때마다 첫 장과 순서를 새로 고른다.
 *
 * 크로스디졸브가 이미 끝난 채로 들어왔으면(다른 씬에서 켜고 진입 — U40) 첫 장도 끊어 넣는다.
 * 안 그러면 스택은 켜져 있는데 그 안이 잠깐 비어 "켜진 채로 로드"가 되지 않는다.
 */
function restartStandbyPhotoSession(now: number): void {
  clearPhotoLayers(true);
  photoCutFirstSwap = standbyPhotoEntryCut(
    backdropFade.progress,
    visualState().photos.settings.standbyBackdrop ? 1 : 0,
  );
  photoCycle = 0;
  photoSeed = nextPhotoSessionSeed(photoSeed, now);
  photoPrevQueue = [];
  photoQueueCache = null;
  photoShownAt = 0;
  photoLastTickAt = now;
}

/**
 * 사진 씬이 화면에 떠 있는 동안만 도는 틱 (`paint()` 안).
 *
 * 큐는 **매 틱 상태에서 다시 만들되**(메모이즈로 값이 같으면 재계산 없음) 위치는 **id로** 추적한다.
 * 그래서 재생 중 새 사진이 편입돼도 현재 사진이 튀지 않고, 시간순이면 새 사진이 큐 뒤에 붙어
 * 이번 바퀴 끝에 나온다. 숨김·삭제는 큐에서 사라지는 것으로 표현되어 다음 틱에 즉시 반영된다.
 */
function tickPhotos(now: number): void {
  const sinceLast = Math.max(0, now - photoLastTickAt);
  photoLastTickAt = now;

  // 2부 재잠금(true → false)은 hold 중에 일어나도 놓치면 안 되므로 **틱의 맨 앞**에서 본다.
  // 플래그는 큐 판정에 도달할 때 소비된다 (§11 M9).
  const unlocked = visualState().p2.unlocked;
  if (photoUnlockedSeen === true && !unlocked) photoRelockPending = true;
  photoUnlockedSeen = unlocked;

  const pres = photoTransitionPresentation(
    visualState().sceneOpts.transitionVideo.active,
    visualState().sceneOpts.video.phase,
  );
  if (pres.hold) {
    // `hold === true`면 `motion`·`willChange`는 정의상 항상 false다(같은 `covered` 한 값에서
    // 나온다) → 조건 분기는 죽은 코드였다 (§11 L2). 덮이면 무조건 세운다.
    if (!photoHeld) {
      photoHeld = true;
      freezePhotoMotion();
    }
    // 덮여 있는 동안 시계를 멈춘다 — 안 그러면 아무도 못 본 채로 사진이 소모된다.
    // **단 아직 한 장도 안 띄웠으면 그대로 진행한다** (§11 M1): 첫 사진은 스팅어에 가려진 채로
    // 로드·표시돼야 덮개가 걷히는 순간 이미 떠 있다. 여기서 막으면 스팅어가 끝난 뒤에야
    // 로딩이 시작돼 검은 화면이 한 박자 보인다.
    if (photoId !== null) {
      photoShownAt += sinceLast;
      return;
    }
  } else if (photoHeld) {
    photoHeld = false;
    resumePhotoMotion(now);
  }

  const q = currentPhotoQueue();
  const relocked = photoRelockPending;
  photoRelockPending = false;
  if (!q.list.length) {
    // 빈 상태 = 두 레이어 모두 투명. 브랜드 배경만 남는다(안내 문구는 프로젝터에 띄우지 않는다).
    if (photoId !== null || photoA.classList.contains('is-on') || photoB.classList.contains('is-on')) {
      // 재잠금으로 큐가 통째로 빈 경우 = 떠 있던 것이 2부 사진이다 → 페이드 없이 끊는다 (§11 M9)
      clearPhotoLayers(relocked);
    }
    return;
  }
  const dropped = photoId !== null && !q.set.has(photoId);
  if (photoId === null || dropped || now - photoShownAt >= photoIntervalMs()) {
    // 재잠금 때문에 현재 사진이 큐에서 빠졌다 = 2부 사진이 떠 있다 → 페이드 없이 끊는다
    advanceToNextPhoto(q, now, relocked && dropped);
  }
}

const confetti = new Confetti();

// ---------------------------------------------------------------- 설명 영상 검정 페이드 (§4-1·4-3)
//
// control이 소유하는 3단계 상태 머신(covering → playing → revealing)의 **표시 담당**이다.
// display는 상태를 바꾸지 않는다 — 검정 레이어 애니메이션과 볼륨 램프를 로컬로 돌린 뒤
// 토큰이 붙은 완료 사건만 보고하고, 다음 단계 결정은 control이 한다.
// 전환 영상의 token/generation guard 패턴을 그대로 복제한다.

type VideoPhase = AppState['sceneOpts']['video']['phase'];

/** 페이드 취소(video/abort) 시 현재 opacity에서 0까지 되돌리는 시간. fadeSec과 무관한 고정값 (§4-5) */
const FADE_RETURN_MS = 150;

const fadeBlack = document.createElement('div');
fadeBlack.id = 'fade-black';
viewport.appendChild(fadeBlack);

const sceneFade = document.createElement('div');
sceneFade.id = 'scene-fade';
viewport.appendChild(sceneFade);

/**
 * 운영자 암전 레이어 (U65).
 *
 * z-order 근거: #fade-black(44) < #transition-video(45) < #scene-fade(46) < **#blackout(47)**
 * < #fs-btn(50) < .audio-unlock(60).
 *  - 스팅어·씬 페이드보다 **위**여야 암전이 진짜 검정이다. 아래에 두면 전환이 도는 동안
 *    암전이 걷혀 보인다(계획 R9 (d) 첫 항목).
 *  - 운영 크롬(전체화면 버튼·오디오 잠금 해제)보다는 **아래**다. 화면을 껐다고 해서
 *    출력 창을 되살릴 손잡이까지 덮어 버리면 안 된다.
 *
 * opacity만 쓴다 — 값은 rAF가 매 프레임 직접 쓰고 CSS transition은 걸지 않는다
 * (#fade-black·#scene-fade와 같은 이유: 두 곡선이 갈라진다).
 */
const blackoutEl = document.createElement('div');
blackoutEl.id = 'blackout';
viewport.appendChild(blackoutEl);

/**
 * 암전은 **라이브 상태**를 읽는다 — PGM FREEZE(U75)가 걸려 있어도 즉시 듣는다.
 * 얼어붙은 화면을 끄는 것이 프리즈보다 급한 조작이기 때문이다(배치 스펙 F4 단서).
 */
function tickBlackout(now: number): void {
  const b = state.sceneOpts.blackout;
  const to = blackoutTarget(b.active);
  const durationMs = blackoutDurationMs(state.settings.blackoutSec, b.fromOpacity, to);
  blackoutEl.style.opacity = blackoutOpacity(now - b.startedAt, durationMs, b.fromOpacity, to).toFixed(4);
}

let sceneFadeToken = -1;
let sceneFadeStartedAt = 0;
let sceneFadeEvent: 'switch' | 'finish' | null = null;

function tickSceneFade(now: number): void {
  const fade = visualState().sceneOpts.sceneFade;
  if (!fade.active) {
    sceneFade.style.opacity = '0';
    sceneFadeEvent = null;
    return;
  }
  if (fade.restartToken !== sceneFadeToken) {
    sceneFadeToken = fade.restartToken;
    sceneFadeStartedAt = now;
    sceneFadeEvent = null;
  }
  sceneFade.style.background = fade.color;
  const frame = sceneFadeFrame((now - sceneFadeStartedAt) / 1000, fade.durationSec, fade.switched);
  sceneFade.style.opacity = frame.opacity.toFixed(4);
  if (frame.event && frame.event !== sceneFadeEvent) {
    sceneFadeEvent = frame.event;
    emit(`${frame.event === 'switch' ? 'scenefade-switched' : 'scenefade-finished'}:${fade.restartToken}`);
  }
}

/** 화면에 실제로 적용된 검정 불투명도 */
let fadeOpacity = 0;
/** 이 display가 로컬 타임라인을 잡고 있는 phase/token. 상태와 다르면 새 단계 진입이다. */
let fadePhase: VideoPhase = 'idle';
let fadeBoundToken = -1;
let fadePhaseStartedAt = 0;
/** 현재 단계의 완료를 이미 보고했는가 (토큰당 1회) */
let fadeReported = false;
/** playing 단계에서 꼬리 페이드에 들어갔는가 */
let fadeInTail = false;
let fadeTailStartedAt = 0;
/**
 * **소리**의 꼬리 페이드에 들어갔는가 (U93).
 *
 * 마지막 프레임을 붙잡는 영상(`holdEndFrame`)은 화면이 서 있어야 하므로 시각 꼬리가 열리지
 * 않는다. 그런데 게인이 그 시각 꼬리에 얹혀 있어서 소리까지 함께 페이드를 잃었다 —
 * 2부 Part 1~4가 최대 볼륨에서 뚝 끊기던 자리다. 소리만 따로 여는 축이 필요하다.
 * 일반 영상에서는 `fadeInTail`과 같은 프레임에 같은 값으로 열려 곡선이 하나로 남는다.
 */
let audioInTail = false;
let audioTailStartedAt = 0;
/** 이번 재생에서 'ended'를 봤는가 (M12) */
let fadeEndedSeen = false;
/** idle 복귀 페이드의 시작 불투명도 */
let fadeReturnFrom = 0;
/** 직전 tickFade 호출 시각 — 일시정지 중 페이드 시계를 멈추는 데 쓴다 (리뷰 M7) */
let fadeLastTickAt = Date.now();

function setFadeOpacity(next: number): void {
  const clamped = Math.max(0, Math.min(1, next));
  if (clamped === fadeOpacity) return;
  fadeOpacity = clamped;
  fadeBlack.style.opacity = clamped.toFixed(4);
}

/** 지금 `#fade-black`에 칠해 둔 색 — 매 프레임 style에 쓰지 않기 위한 캐시 */
let fadeColor = FADE_BASE_COLOR;

/**
 * 페이드 레이어의 색 (U87). 기본은 검정이고, 대본 아웃트로가 붙은 영상의 **꼬리·되드러냄**에만
 * 그 색으로 바뀐다.
 *
 * `idle`에서는 부르지 않는다 — 화이트로 덮이던 도중 취소(`video/abort`)되면 남은 불투명도가
 * 0으로 돌아가는 동안 색이 유지돼야 한다. 여기서 검정으로 되돌리면 흰 화면이 한 프레임 만에
 * 검게 번쩍인 뒤 걷힌다. 다음 `covering`이 어차피 검정으로 되돌린다.
 */
function setFadeColor(next: string): void {
  if (next === fadeColor) return;
  fadeColor = next;
  fadeBlack.style.background = next;
}

/**
 * 이 구간에 적용할 페이드 길이(ms).
 *
 * 셋을 나누는 이유: 대본 아웃트로는 **끝만** 정한다. 영상으로 들어가는 `covering`과 재생 머리의
 * `from-black`은 전역 `fadeSec` 그대로여야 한다 — 아웃트로 길이(5초)를 머리에도 쓰면 영상 앞에
 * 5초짜리 암전이 붙고, 색까지 따라가면 아무도 요청하지 않은 화이트 플래시가 생긴다.
 */
function videoFadeMs(
  v: { fadeSec: number; outro: { fadeSec: number; revealSec: number } | null },
  part: 'head' | 'tail' | 'reveal',
): number {
  if (v.outro && part === 'tail') return Math.max(0, v.outro.fadeSec * 1000);
  if (v.outro && part === 'reveal') return Math.max(0, v.outro.revealSec * 1000);
  return Math.max(0, v.fadeSec * 1000);
}

/**
 * 지금 불투명도를 그대로 잇는 페이드 경과 시각을 되돌려 준다 (리뷰 M6).
 *
 * 곡선(easing)을 여기서 다시 구현하면 `fade.ts`와 두 벌이 되어 언젠가 어긋난다 —
 * `fadeOpacityAt`이 단조 함수라는 성질만 쓰고 이분 탐색으로 역을 구한다. 매 프레임이 아니라
 * **단계 진입에 한 번**만 도는 계산이므로 반복 비용은 문제가 되지 않는다.
 */
function elapsedForOpacity(target: number, fadeMs: number, dir: FadeDirection): number {
  if (fadeMs <= 0) return 0;
  let lo = 0;
  let hi = fadeMs;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const at = fadeOpacityAt(mid, fadeMs, dir);
    // to-black은 증가, from-black은 감소 — 방향에 맞춰 구간을 좁힌다
    if (dir === 'to-black' ? at < target : at > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** playing 진입 시 오디오 정책을 에셋 메타에 맞춘다. **양방향** — 정책 폴백으로 muted가 된 뒤에도 복구 (§11 M6) */
function applyVideoAudioPolicy(assetId: string | null): void {
  const asset = assetId ? visualState().assets.find((a) => a.id === assetId) : undefined;
  setOutputMuted(videoEl, asset?.audio === false);
  videoMedia.track = setGain(videoMedia.track, 1);
}

function enterFadePhase(now: number): void {
  const v = visualState().sceneOpts.video;
  // "이 phaseToken의 **시작**(covering)을 이 창이 봤는가"로 판정한다 (리뷰 M3).
  // 전역 1회성 플래그(fadeSynced)로 두면 부팅 직후 stale한 idle을 한 번 본 것만으로 "동기화됨"이
  // 굳어, 뒤이어 재접속으로 받은 playing을 정상 진입으로 착각해 재생 중 영상을 0초로 되감는다.
  // covering을 resume에서 빼는 이유: 새 covering은 언제나 진짜 시작이므로 페이드를 그대로 돌린다.
  const isNewToken = v.phaseToken !== fadeBoundToken;
  const resume = isNewToken && v.phase !== 'idle' && v.phase !== 'covering';
  const fadeMs = videoFadeMs(v, 'head');
  // 재접속 점프는 **그 단계의 길이**로 재야 한다 — `revealing`은 대본 아웃트로에서 길이가 다르다.
  const resumeMs = v.phase === 'revealing' ? videoFadeMs(v, 'reveal') : fadeMs;

  if (v.phase === 'idle') fadeReturnFrom = fadeOpacity;
  fadePhase = v.phase;
  fadeBoundToken = v.phaseToken;
  fadePhaseStartedAt = now;
  fadeReported = false;
  fadeInTail = false;
  fadeTailStartedAt = 0;
  audioInTail = false;
  audioTailStartedAt = 0;
  fadeEndedSeen = false;

  if (v.phase === 'playing') {
    // 되감지 않는다: 상태의 restartToken을 먼저 흡수해 ensureVideo의 restart 분기를 막는다 (§11 H3)
    if (resume) {
      videoRestartToken = v.restartToken;
      // 이미 이 영상이 붙어 있는 재접속이면 되감기 없이 "이번 재생"으로 인정한다 —
      // 안 그러면 ensureVideo가 restart 분기를 타지 않아 꼬리 페이드 게이트가 영영 닫힌다.
      if (videoSrcAssetId === v.assetId) videoSrcRestartToken = v.restartToken;
    }
    applyVideoAudioPolicy(v.assetId);
  }
  // 검정이 이미 깔려 있는데(꼬리 페이드·revealing 도중 새 재생) covering을 0부터 다시 그리면
  // 화면이 한 번 번쩍인다 (리뷰 M6). 지금 불투명도에 해당하는 지점부터 이어 간다 —
  // idle 복귀가 fadeReturnFrom으로 현재 값에서 출발하는 것과 같은 방식이다.
  if (v.phase === 'covering' && fadeOpacity > 0) {
    fadePhaseStartedAt = now - elapsedForOpacity(fadeOpacity, fadeMs, 'to-black');
  }
  // revealing 재접속: 페이드 없이 끝값으로 점프하고 같은 프레임에 완료를 보고한다.
  // playing 재접속: head는 이미 지난 것으로 보고 볼륨 1(=opacity 0)에서 이어 간다.
  if (resume) fadePhaseStartedAt = now - resumeMs;
}

/**
 * 매 프레임 검정 불투명도·볼륨을 갱신하고, 단계가 끝나면 **토큰당 한 번** 보고한다.
 * paint() 앞쪽에서 부른다 — playing 진입의 muted/restartToken 세팅이 ensureVideo보다 먼저여야 한다.
 */
function tickFade(now: number): void {
  const v = visualState().sceneOpts.video;
  // 프레임 델타는 단계 진입보다 **먼저** 잡는다 — 일시정지 중 시계 보정에 쓴다 (리뷰 M7)
  const sinceLastTick = Math.max(0, now - fadeLastTickAt);
  fadeLastTickAt = now;
  if (v.phase !== fadePhase || v.phaseToken !== fadeBoundToken) enterFadePhase(now);

  const fadeMs = videoFadeMs(v, 'head');

  if (v.phase === 'covering') {
    // 들어가는 페이드는 언제나 검정이다 (아웃트로는 끝만 정한다).
    setFadeColor(FADE_BASE_COLOR);
    const elapsed = now - fadePhaseStartedAt;
    const opacity = fadeOpacityAt(elapsed, fadeMs, 'to-black');
    setFadeOpacity(opacity);
    // 화면에 남아 있는 이전 영상의 소리도 검정과 같은 곡선으로 함께 내린다 (리뷰 M2).
    // 이 구간에서는 paint()가 새 영상을 붙이지 않으므로 이 볼륨이 새 재생으로 새지 않는다.
    videoMedia.track = setGain(videoMedia.track, volumeForOpacity(opacity));
    if (!fadeReported && isFadeComplete(elapsed, fadeMs)) {
      fadeReported = true;
      emit(`fullvideo-covered:${v.phaseToken}`);
    }
    return;
  }

  if (v.phase === 'playing') {
    // `video/restart`는 restartToken만 바꿀 뿐 phase/phaseToken을 건드리지 않아 enterFadePhase를
    // 타지 않는다. 꼬리 페이드에 들어간 채로 되감으면 검정이 걷히지 않고, 이미 보고한 tail 때문에
    // 다시 보고하지도 못해 재생이 검은 화면에 갇힌다 (리뷰 M1). 여기서 꼬리 상태를 되돌린다.
    if (videoRestartToken !== v.restartToken) {
      fadeInTail = false;
      fadeTailStartedAt = 0;
      // 소리 꼬리도 함께 되돌린다 — 안 그러면 되감은 영상이 처음부터 무음으로 재생된다.
      audioInTail = false;
      audioTailStartedAt = 0;
      fadeEndedSeen = false;
      fadeReported = false;
      fadePhaseStartedAt = now;
    }
    // 정지 중에는 페이드 시계도 멈춘다 — 안 그러면 멈춘 화면 위에서 꼬리 페이드가 혼자 완주해
    // `fullvideo-tail`이 나가고 씬이 다음으로 넘어간다 (리뷰 M7). 시작 시각을 델타만큼 밀면
    // 경과 시간이 그대로 얼어붙고, 재개 시점부터 정확히 이어서 흐른다.
    if (v.paused) {
      fadePhaseStartedAt += sinceLastTick;
      if (fadeInTail) fadeTailStartedAt += sinceLastTick;
      // 소리 꼬리도 같은 시계를 쓴다 — 일시정지 중에 혼자 완주하면 재개했을 때 무음이다.
      if (audioInTail) audioTailStartedAt += sinceLastTick;
    }
    // 꼬리 페이드 진입 = tailStartSec 도달 **또는** ended, 먼저 오는 쪽 (§11 M12).
    // duration <= fadeSec이면 tailStartSec이 0으로 클램프되어 head를 건너뛴다.
    // 단, 판정은 **이번 재생의 소스가 실제로 물린 뒤**에만 한다 (D1). tickFade는 ensureVideo보다
    // 먼저 도므로, 진입 직후의 엘리먼트는 아직 직전 영상(t=duration, 끝까지 재생됨)이다.
    // 게이트·요청·샘플은 **한 벌**이다 — 시각 꼬리와 소리 꼬리가 다른 값을 보면 둘이 어긋난다.
    const tailBinding = {
      srcAssetId: videoSrcAssetId,
      srcRestartToken: videoSrcRestartToken,
      readyState: videoEl.readyState,
    };
    const tailRequest = {
      assetId: v.assetId,
      restartToken: v.restartToken,
      holdEndFrame: v.holdEndFrame,
      // 대본 아웃트로가 있으면 꼬리는 `duration − outro.fadeSec`에서 시작한다 (U87).
      // 전역 `fadeSec`(0.5초)으로 재면 소리가 마지막 0.5초에만 내려가 지시(5초)와 어긋난다.
      fadeSec: v.outro ? v.outro.fadeSec : v.fadeSec,
    };
    const tailSample = {
      currentTime: videoEl.currentTime,
      duration: Number.isFinite(videoEl.duration) ? videoEl.duration : undefined,
      ended: fadeEndedSeen,
    };
    if (!fadeInTail) {
      if (shouldEnterVideoTail(tailBinding, tailRequest, tailSample)) {
        fadeInTail = true;
        fadeTailStartedAt = now;
      }
    }
    // 소리는 `holdEndFrame`을 보지 않는다 (U93) — 화면만 마지막 프레임에 서고 소리는 내려온다.
    // 일반 영상에서는 위와 같은 프레임에 열리므로 두 시작 시각이 같고, 곡선이 갈라지지 않는다.
    if (!audioInTail) {
      if (shouldEnterVideoAudioTail(tailBinding, tailRequest, tailSample)) {
        audioInTail = true;
        audioTailStartedAt = now;
      }
    }
    // tail에 들어가면 head 계산은 즉시 버린다 — 두 곡선을 섞으면 불투명도가 튄다
    const tailMs = videoFadeMs(v, 'tail');
    // 꼬리에 들어간 뒤에만 아웃트로 색으로 바꾼다 — 재생 중 화면 위에서 색이 바뀔 일은 없다
    // (불투명도가 0이므로 보이지 않고, 꼬리가 시작되는 프레임에 이미 제 색이다).
    setFadeColor(fadeInTail && v.outro ? v.outro.color : FADE_BASE_COLOR);
    const opacity = fadeInTail
      ? fadeOpacityAt(now - fadeTailStartedAt, tailMs, 'to-black')
      : fadeOpacityAt(now - fadePhaseStartedAt, fadeMs, 'from-black');
    setFadeOpacity(opacity);
    // 볼륨은 덮는 색과 **같은 곡선 하나**에서 나온다 (fade.ts 주석).
    // 꼬리가 5초면 오디오 페이드 아웃도 그 5초다 — 두 값을 따로 계산하지 않는다.
    //
    // 마지막 프레임을 붙잡는 영상만 예외다 (U93): 화면은 서 있어야 하니 `opacity`가 0에 머물고,
    // 소리는 같은 함수·같은 길이의 `to-black` 곡선을 **자기 시작 시각**에서 탄다. 같은 산수를
    // 두 벌 쓰지 않으려고 값이 아니라 **시작 시각만** 갈라 둔다.
    const audioOpacity = audioInTail
      ? fadeOpacityAt(now - audioTailStartedAt, tailMs, 'to-black')
      : opacity;
    videoMedia.track = setGain(videoMedia.track, volumeForOpacity(audioOpacity));
    if (fadeInTail && !fadeReported && isFadeComplete(now - fadeTailStartedAt, tailMs)) {
      fadeReported = true;
      emit(`fullvideo-tail:${v.phaseToken}`);
    }
    return;
  }

  if (v.phase === 'holding') {
    setFadeOpacity(0);
    /**
     * 화면은 마지막 프레임에 선다. **소리는 곡선 없이 끊지 않는다** (U27 계약 · U93).
     *
     * 정상 경로에서는 위 `playing`의 소리 꼬리가 이미 0까지 데려다 놓은 뒤에 여기로 온다 —
     * 그때는 `isAudible`이 false라 아래 램프가 걸리지 않고 예전처럼 0을 유지한다.
     * 남는 경로는 **꼬리를 잴 수 없었던 경우**다: duration을 못 읽는 에셋이나 소스 바인딩이
     * 끝내 안 맞은 재생은 `ended` 한 방으로 여기 떨어지고, 그 순간 게인은 아직 1이다.
     * 예전 구현은 그 자리에서 `setGain(track, 0)` — 최대 볼륨에서 무음으로 뚝 끊었다.
     *
     * 램프는 **한 번만** 건다(`ramp === null` 가드). 매 프레임 다시 걸면 시작값이 계속 현재
     * 게인으로 갱신되어 페이드가 영영 0에 닿지 못한다. `after`는 두지 않는다 — 마지막 프레임을
     * 화면에 붙잡고 있어야 하므로 이 엘리먼트를 떼거나 놓아서는 안 된다(`ended`라 이미 멎어 있다).
     */
    if (isAudible(videoMedia.track)) {
      if (videoMedia.track.ramp === null) {
        videoMedia.track = rampGain(videoMedia.track, 0, state.settings.audioCutFadeSec, now);
      }
    } else {
      videoMedia.track = setGain(videoMedia.track, 0);
    }
    return;
  }

  if (v.phase === 'revealing') {
    // 덮은 색 그대로 걷는다 — 화이트로 덮었으면 화이트에서 페이드 인이다.
    setFadeColor(v.outro ? v.outro.color : FADE_BASE_COLOR);
    const revealMs = videoFadeMs(v, 'reveal');
    const elapsed = now - fadePhaseStartedAt;
    setFadeOpacity(fadeOpacityAt(elapsed, revealMs, 'from-black'));
    if (!fadeReported && isFadeComplete(elapsed, revealMs)) {
      fadeReported = true;
      emit(`fullvideo-revealed:${v.phaseToken}`);
    }
    return;
  }

  // idle — 검정 없음. 페이드 도중 취소(video/abort)됐다면 현재 값에서 0까지 150ms로 되돌린다.
  const t = FADE_RETURN_MS <= 0 ? 1 : Math.min(1, (now - fadePhaseStartedAt) / FADE_RETURN_MS);
  setFadeOpacity(fadeReturnFrom * (1 - t));
  /**
   * 게인 복원은 **이 영상이 아직 화면의 주인일 때만** 한다 (U93 후속 · 간헐 컷의 정체).
   *
   * `video/abort`로 취소만 되고 영상은 계속 도는 경우에는 소리를 1로 되돌리는 것이 맞다.
   * 그러나 씬이 이미 영상을 놓았다면(`scene/set`이 `resetRuntimeVideoPhase`로 phase를 idle로
   * 내린 직후가 정확히 이 모양이다) 다음 순서는 `paint()`의 정리 페이드이고, 그 페이드는
   * **지금 게인에서 이어받아야** 한다. 예전에는 여기서 무조건 1로 올려서, 머리 페이드 인
   * (첫 `fadeSec`)이나 꼬리 오디오 페이드 도중에 빠져나온 재생이 **한 프레임 최대 볼륨으로 튄 뒤**
   * 내려갔다. 스팅어 스윕이 도는 경로에서는 그 최대 볼륨이 스윕 길이(0.45초)만큼 이어져,
   * "페이드가 걸리다 말고 갑자기 커졌다 끊긴" 소리가 된다. 페이드가 되는 때와 안 되는 때가
   * 갈리던 간헐성의 정체다.
   *
   * 판정은 `shownScene`이 아니라 **상태가 원하는 씬**(`pickScene`)으로 한다 — `maybeTransition()`이
   * `tickFade()`보다 뒤에 돌아서, 씬이 바뀌는 첫 프레임의 `shownScene`은 아직 `'video'`다.
   * `pickScene`은 2부 잠금 강등(`P2_SCENES` → `standby`)까지 같은 자리에서 받아 낸다.
   */
  if (pickScene(visualState()) === 'video') videoMedia.track = setGain(videoMedia.track, 1);
}

// ---------------------------------------------------------------- 오디오 언락
//
// 브라우저 자동재생 정책은 "사용자 제스처가 없는 탭"에서 소리 있는 재생을 막는다.
// 출력 창은 조작하지 않는 창이라 이 상황에 걸리기 쉬우므로, 막히면 배지로 클릭을 안내한다.

let needsAudioUnlock = false;
let lastProgressAt = 0;

const audioBadge = document.createElement('div');
audioBadge.className = 'audio-unlock';
audioBadge.textContent = '화면을 한 번 클릭하면 소리가 나옵니다';
audioBadge.hidden = true;
document.body.appendChild(audioBadge);

function updateAudioBadge(): void {
  audioBadge.hidden = !displayOperatorOverlayVisible(
    shownScene,
    needsAudioUnlock,
    visualState().sceneOpts.standby.mode,
    visualState().sceneOpts.game.mode,
  );
}

/** 이 창에 사용자 제스처가 한 번이라도 있었는가 */
let userActivated = false;
let audioLockReported: 'audio-locked' | 'audio-ok' | null = null;

/**
 * 소리 있는 재생이 정책에 막혀 있는가 — **선제 판정** (§11 H5).
 *
 * 재생을 시도해 봐야 아는 구조면 본방 첫 영상에서야 잠금을 발견한다. Chrome은
 * `getAutoplayPolicy()`로 시도 전에 답을 주므로 부팅 즉시 판정해 control에 알린다.
 * 미지원 브라우저는 사용자 활성화 여부로 근사한다(정책의 실제 근거 중 하나다).
 */
function isAudioAutoplayBlocked(): boolean {
  if (userActivated) return false;
  const getPolicy = (
    navigator as Navigator & { getAutoplayPolicy?: (type: string) => string }
  ).getAutoplayPolicy;
  if (typeof getPolicy === 'function') {
    try {
      return getPolicy.call(navigator, 'mediaelement') !== 'allowed';
    } catch {
      /* 인자 형식이 다른 구현 — 아래 근사로 내려간다 */
    }
  }
  return (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } })
    .userActivation?.hasBeenActive === false;
}

/**
 * 오디오 잠김 상태를 control에 알린다. `force`면 값이 그대로여도 다시 보낸다 —
 * control이 새로고침되면 이 정보를 잃어버리기 때문(카메라 상태 재통보와 같은 이유).
 */
function reportAudioState(force = false): void {
  // 모니터는 iframe이라 언제나 자동재생 정책에 걸려 있다. 보고하면 조작 패널 상단에
  // 있지도 않은 잠금 경고가 뜬다 (U72).
  if (MONITOR) return;
  const name: DisplayEvent =
    needsAudioUnlock || isAudioAutoplayBlocked() ? 'audio-locked' : 'audio-ok';
  if (!force && name === audioLockReported) return;
  audioLockReported = name;
  emit(name);
}

/** 마지막으로 보고한 음소거 상태 (같은 값 반복 방송 중단) */
let userMuteReported: 'audio-user-muted' | 'audio-user-unmuted' | null = null;

/**
 * 운영자 음소거를 control에 알린다 (U88).
 *
 * `reportAudioState`와 **별도 함수·별도 이벤트**다. 자동재생 잠금은 고칠 사고이고 음소거는
 * 운영자가 누른 상태라, 하나로 합치면 조작 패널이 고칠 것 없는 빨강 잠금 배너를 상시로 띄운다.
 * 모니터가 보고하지 않는 이유는 저쪽과 같다 — 모니터는 애초에 이 버튼이 없다.
 *
 * 보내는 값은 기억된 선택이 아니라 **실제로 걸린 음소거**(`userMuted`)다. 전체화면에서
 * 자동 해제된 창이 "음소거 중"이라고 알리면 조작 패널이 나가고 있는 소리를 없다고 말한다.
 */
function reportUserMuteState(force = false): void {
  if (MONITOR) return;
  const name = userMuteEvent(userMuted);
  if (!force && name === userMuteReported) return;
  userMuteReported = name;
  emit(name);
}

/**
 * 잠금이 풀린 뒤, **울려야 하는데 멎어 있는 것들**을 다시 붙인다 (U48).
 *
 * 잠긴 동안 나간 재생 명령은 브라우저가 거부했고 그 거부는 되돌아오지 않는다. 제스처 한 번으로
 * 정책이 풀린 그 순간, 상태가 "재생 중"이라고 말하는 것들을 실제로 다시 재생시켜야 한다 —
 * 안 하면 배지만 사라지고 소리는 계속 없다.
 *
 * `needsAudioUnlock`(실제 거부를 본 경우)뿐 아니라 **첫 제스처 자체**에서 돈다. 선제 판정
 * (`getAutoplayPolicy`)으로 잠김을 알고 있던 창은 거부를 겪기 전에도 무음으로 서 있을 수 있다.
 */
function resumePendingAudio(): void {
  // **지금 울려야 하는 것만** 고른다 (U48 후속). 예전에는 씬을 보지 않고 셋을 전부 다시
  // 붙여서, 화면에 없는 설명 영상이나 치워 둔 카메라의 소리가 지금 씬 위에 겹쳐 나갔다.
  const plan = pendingAudioResumePlan({
    shownScene,
    videoPaused: state.sceneOpts.video.paused,
    cameraAudioEnabled: state.settings.camera.audio,
    cameraParked: cameraAudioParked,
    musicPlaying: state.music.playing,
    musicTrackId: state.music.trackId,
  });

  // 막혔다는 **기록**은 무엇을 되살리든 지운다 — 제스처가 있었으니 더는 참이 아니다.
  // 이건 소리를 내는 행위가 아니라 플래그 정리라 겹침과 무관하다.
  cameraAudioBlocked = false;
  overlayAudioBlocked = false;

  if (plan.video) {
    // 설명 영상은 에셋 메타(audio)를 따라 푼다. 알파 전환(스팅어)은 소리를 갖게 됐지만(U102)
    // 여기서도 되살리지 않는다 — 1.5초 컷이라 잠금이 풀릴 즈음이면 이미 끝나 있고, 되살리면
    // 화면에 없는 효과음만 뒤늦게 울린다. 다음 스팅어부터 저절로 소리가 난다.
    // 씬이 `video`가 아닐 때 부르면 게인까지 1로 올려 화면 밖 영상이 소리를 낸다.
    applyVideoAudioPolicy(state.sceneOpts.video.assetId);
    // 멎어 있는 것만 다시 붙인다 — 조건 없이 play()를 부르면 이미 끝난 영상이 되살아난다.
    if (videoEl.paused) void videoEl.play().catch(() => undefined);
  }
  // 카메라의 muted는 paint()의 `cameraMuted()`가 매 프레임 정한다. 여기서 직접 쓰면
  // parked·정책 판정을 건너뛰고 치워 둔 카메라의 소리를 켠다.
  if (plan.camera && camEl.paused) void camEl.play().catch(() => undefined);
  if (plan.music && state.music.trackId) {
    const deck = currentMusicDeck();
    // 잠김 동안 게인이 0으로 남아 있었다면 여기서 페이드 인을 다시 건다 (무음 재생 방지).
    // 정상 재생 경로와 **같은 함수**를 쓴다 — 목표를 두 곳에 따로 적으면 한쪽만 고치게 된다.
    if (!isAudible(deck.track)) fadeInMusicDeck(deck, Date.now());
    playMusicDeck(deck, state.music.trackId, state.music.commandToken);
  }
}

window.addEventListener(
  'pointerdown',
  () => {
    // **제스처 전에** 판정한다 — `isAudioAutoplayBlocked()`는 `userActivated`를 보므로
    // 플래그를 먼저 세우면 언제나 false가 되어 되살릴 기회를 놓친다.
    const wasBlocked = needsAudioUnlock || isAudioAutoplayBlocked();
    userActivated = true;
    // 잠긴 적이 없으면 아무것도 하지 않는다 (U48 후속). 예전에는 **첫 제스처라는 사실만으로**
    // 재개를 돌려서, 정책이 이미 허용된 창(런처·기기 정책)에서도 클릭 한 번에 영상·카메라·음악이
    // 한 겹 더 붙어 소리가 겹쳤다.
    if (wasBlocked) {
      needsAudioUnlock = false;
      resumePendingAudio();
      updateAudioBadge();
    }
    reportAudioState();
  },
  { capture: true },
);

// 부팅 즉시 선제 통보 — 운영자가 본방 전에 알 수 있어야 한다 (§4-4 위험 R2)
reportAudioState(true);
// 음소거 상태도 부팅에서 한 번 확정한다 (U88). 새로고침한 창이 `sessionStorage`에 남은 선택을
// 되살리므로, 그 사실이 버튼과 조작 패널에 **처음부터** 반영되어 있어야 한다.
syncUserMute(true);
// 콘솔에도 한 줄 남긴다 — 현장에서 "소리가 안 난다"를 원격으로 진단할 때, 조작 패널 배너를
// 못 보고 개발자 도구만 열어 보는 경우가 있다. 해결 문구를 배너와 **같은 상수**로 찍는다.
if (isAudioAutoplayBlocked()) console.warn(`[${AUDIO_LOCK_TITLE}] ${AUDIO_LOCK_FIX}`);

let kvAssetId: string | null = null;
async function ensureKeyVisual(id: string | null): Promise<void> {
  if (id === kvAssetId) return;
  kvAssetId = id;
  if (!id) {
    stage.style.removeProperty('--kv-image');
    return;
  }
  const url = await assetUrl(id);
  if (url) stage.style.setProperty('--kv-image', `url("${url}")`);
}

/** 씬 HTML이 교체된 직후 런타임 엘리먼트를 다시 꽂는다 */
function attachSlots(): void {
  const now = Date.now();
  const camSlot = stage.querySelector('[data-cam-slot]');
  if (camSlot) {
    camSlot.innerHTML = '';
    if (MONITOR) {
      // 모니터는 카메라를 잡지 않는다 (U72) — 소리 정리 경로도 타지 않으므로 여기서 끝낸다
      camSlot.appendChild(buildMonitorPlaceholder());
    } else if (camera.stream) {
      camSlot.appendChild(camEl);
      // 리플레이는 카메라 **바로 뒤**에 붙는다 — 크롬(보더·배지·스코어바)은 슬롯 밖이라
      // DOM 순서만으로 "카메라 위, 크롬 아래"가 정확히 나온다.
      camSlot.appendChild(replayEl);
      playCamera();
      // 중계 화면으로 돌아왔다 — 예약된 정리를 취소하고 소리를 램프로 올린다.
      // (컷으로 되돌리면 씬이 바뀌자마자 카메라 소리가 튀어나온다.)
      cameraAudioParked = false;
      camMedia.track = rampGain(
        cancelTeardown(camMedia.track),
        1,
        state.settings.audioCutFadeSec,
        now,
      );
    } else {
      camSlot.appendChild(buildNoSignal());
    }
  } else {
    // 카메라는 스트림이라 pause하면 미리보기가 죽는다 — 소리만 램프로 내린 뒤 mute한다.
    // 플래그를 먼저 세워야 이번 프레임부터 정책이 게인을 되돌리지 않는다.
    cameraAudioParked = true;
    parkMedia(camEl);
    requestAudioTeardown(camMedia, 'mute', now);
  }
  const videoSlot = stage.querySelector('[data-video-slot]');
  if (videoSlot) {
    videoSlot.innerHTML = '';
    videoSlot.appendChild(videoEl);
  } else {
    parkMedia(videoEl);
  }
  photoSlotEl = null;
  photoFilterSignature = null;
  const photoSlot = stage.querySelector<HTMLElement>('[data-photo-slot]');
  if (photoSlot) {
    // 씬 HTML은 고정이라 이 재부착은 사진 씬 진입 때 한 번뿐이다 (§11 L9)
    photoSlot.innerHTML = '';
    photoSlot.append(photoA, photoB);
    photoSlotEl = photoSlot;
    syncPhotoFilters();
  }
  const confettiSlot = stage.querySelector('[data-confetti]');
  if (confettiSlot) {
    confettiSlot.innerHTML = '';
    confettiSlot.appendChild(confetti.canvas);
  }
}

// ---------------------------------------------------------------- 시간 바인딩

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function tickBindings(now: number): void {
  const clock = stage.querySelector<HTMLElement>('[data-bind="clock"]');
  if (clock) {
    const d = new Date(now);
    clock.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // 스냅샷을 읽어도 타이머는 멈추지 않는다 — `startedAt`이 절대 시각이라 남은 시간은
  // 계속 줄어든다. 화면을 얼려도 시계는 흐른다는 U75의 계약이 여기서 저절로 성립한다.
  const vis = visualState();
  const remaining = remainingSec(vis.timer, now);
  const running = isRunning(vis.timer);
  const timerEls = stage.querySelectorAll<HTMLElement>('[data-bind="timer"]');
  for (const el of timerEls) {
    el.textContent = remaining <= 10 && remaining > 0 ? formatTenths(remaining) : formatMMSS(remaining);
  }
  for (const box of stage.querySelectorAll<HTMLElement>('[data-bind="timerbox"]')) {
    box.classList.toggle('is-danger', remaining <= 10 && running);
    box.classList.toggle('is-done', remaining <= 0 && vis.timer.pausedRemaining === null && !running);
  }
  const fill = stage.querySelector<HTMLElement>('[data-bind="timerfill"]');
  if (fill) fill.style.width = `${(remaining / Math.max(1, vis.timer.durationSec)) * 100}%`;

  // 하단 스코어바 누적 + 직전 획득 플로팅
  const recent = new Map<string, number>();
  for (const e of activeLedger(vis.ledger)) {
    if (now - e.ts > 6000) continue;
    recent.set(e.teamId, (recent.get(e.teamId) ?? 0) + e.delta);
  }
  for (const id of TEAM_IDS) {
    const totalEl = stage.querySelector<HTMLElement>(`.scorebar__score[data-team="${id}"]`);
    if (totalEl) {
      let sum = 0;
      for (const e of activeLedger(vis.ledger)) if (e.teamId === id) sum += e.delta;
      totalEl.textContent = fmtPoints(Math.round(animatedNumber(`bar:${id}`, sum, now)));
    }
    const gainEl = stage.querySelector<HTMLElement>(`.scorebar__gain[data-team="${id}"]`);
    if (gainEl) {
      const g = recent.get(id) ?? 0;
      gainEl.textContent = g ? `${g > 0 ? '+' : ''}${fmtPoints(g)}` : '';
      gainEl.classList.toggle('is-on', g !== 0);
    }
  }
}

// ---------------------------------------------------------------- 대기 배경 크로스디졸브 (U19)

/**
 * 사진 배경 토글을 opacity 크로스디졸브로 옮긴다.
 *
 * 대기 영상이 떠 있지 않은 화면(다른 씬·사전미션)에서 토글하면 크로스 없이 목표로 스냅한다 —
 * 늦게 돌아왔을 때 10초짜리 페이드가 뒤늦게 시작되면 운영자가 원인을 못 찾는다.
 */
function tickStandbyBackdrop(now: number, scene: SceneId): void {
  const vis = visualState();
  const crossfadeHere = standbyCrossfadeScene(scene, vis.sceneOpts.standby.mode);
  backdropFade = stepBackdropFade(backdropFade, {
    target: vis.photos.settings.standbyBackdrop ? 1 : 0,
    crossfadeHere,
    sawFirstSyncState,
    fadeSec: vis.settings.backdropCrossfadeSec,
    now,
  });
  if (!crossfadeHere) return;

  const layers = standbyBackdropLayers(backdropFade.progress);
  applyStandbyStack('off', layers.off);
  applyStandbyStack('on', layers.on);
  keepStandbyVideosInStep();
}

/**
 * 문서에 남긴 채 화면 밖으로 옮긴다. 이미 보관함에 있으면 건드리지 않는다
 * (매 프레임 appendChild를 반복하면 재생이 끊길 수 있다).
 */
function parkMedia(el: HTMLMediaElement): void {
  if (el.parentElement !== mediaTailEl) mediaTailEl.appendChild(el);
}

/**
 * 라이브 다크 프레임을 붙이고 뗀다 (U118). 판정은 `liveFrameVisible()` 하나가 한다.
 *
 * ## 왜 `attachSlots()`가 아니라 매 프레임인가
 * `attachSlots()`는 **씬 HTML이 바뀐 프레임에만** 돈다. 그런데 `liveOverlay.frame`은 씬
 * vnode에 없는 값이라(있으면 켤 때마다 씬이 통째로 교체돼 영상이 처음부터 다시 돈다 —
 * U68이 오버레이 토글을 vnode 밖으로 뺀 그 이유), 모드만 바뀌는 프레임에는 `changed`가
 * 거짓이고 `attachSlots()`가 아예 안 돈다. 비용은 부모 비교 하나다.
 *
 * `attachSlots()`가 `camSlot.innerHTML = ''`로 슬롯을 비우므로 **그 뒤에** 불려야 한다.
 * 문서에서 잠깐 떨어져도 재생은 끊기지 않고(브라우저는 detach로 pause하지 않는다) 같은
 * 프레임 안에서 다시 붙으므로 화면에는 아무 일도 일어나지 않는다.
 */
function syncLiveFrame(scene: SceneId): void {
  const vis = visualState();
  const mood = vis.sceneOpts.moodTransition;
  const want = liveFrameVisible({
    scene,
    mode: vis.sceneOpts.liveOverlay.frame,
    moodActive: mood.active,
    moodPhase: mood.phase,
  });
  liveFrameOn = want;
  if (!want) {
    if (liveFrameEl.parentElement !== mediaTailEl) mediaTailEl.appendChild(liveFrameEl);
    if (!liveFrameVideoEl.paused) liveFrameVideoEl.pause();
    return;
  }
  // 파일은 처음 켤 때 한 번만 물린다 — 안 쓰는 중계에서 9MB를 받아 두지 않는다.
  if (!liveFrameVideoEl.getAttribute('src')) liveFrameVideoEl.src = LIVE_FRAME_DARK_SRC;
  const camSlot = stage.querySelector('[data-cam-slot]');
  if (!camSlot) {
    // 씬은 live인데 슬롯이 아직 없다(전환 한복판). 다음 프레임에 다시 본다.
    if (liveFrameEl.parentElement !== mediaTailEl) mediaTailEl.appendChild(liveFrameEl);
    return;
  }
  // 카메라·리플레이 **뒤**에 붙는다 — 슬롯 안 DOM 순서가 곧 층이다(`.cam-replay` 주석).
  if (liveFrameEl.parentElement !== camSlot) camSlot.appendChild(liveFrameEl);
  if (liveFrameVideoEl.paused) void liveFrameVideoEl.play().catch(() => undefined);
}

function standbyVideoEl(stack: 'off' | 'on'): HTMLVideoElement | null {
  return stage.querySelector<HTMLVideoElement>(
    `[data-standby-stack="${stack}"] [data-standby-video]`,
  );
}

/**
 * 스택 하나의 opacity를 심고, 보이지 않는 쪽 영상은 디코딩까지 멈춘다.
 * (1080p 두 장을 동시에 돌리면 실제 Chrome에서 프레임이 떨어진다 — 전환 중 ambient canvas를
 * 내리는 것과 같은 이유. 크로스가 도는 동안에는 두 장 다 필요하므로 그때만 함께 돈다.)
 */
function applyStandbyStack(stack: 'off' | 'on', opacity: number): void {
  const el = stage.querySelector<HTMLElement>(`[data-standby-stack="${stack}"]`);
  if (!el) return;
  el.style.opacity = String(opacity);
  const video = standbyVideoEl(stack);
  if (!video) return;
  if (opacity <= 0) {
    if (!video.paused) video.pause();
    return;
  }
  if (video.paused) {
    // 재생을 **켜기 직전에** 반대쪽 시각으로 맞춘다. 멈춰 있던 낡은 프레임에서 시작하면
    // 같은 장면 두 벌이 다른 시점을 보여 주며 겹쳐 물체가 갈라진 것처럼 보인다.
    syncStandbyVideoFrom(standbyVideoEl(stack === 'off' ? 'on' : 'off'), video);
    void video.play().catch(() => undefined);
  }
}

function syncStandbyVideoFrom(source: HTMLVideoElement | null, target: HTMLVideoElement): void {
  if (!source) return;
  const at = standbyVideoResyncTime(source.currentTime, target.currentTime, target.duration);
  if (at !== null) target.currentTime = at;
}

/**
 * 크로스가 도는 동안 두 영상의 재생 시각이 벌어지지 않게 유지한다.
 * 둘 다 실제로 돌고 있을 때만 손댄다 — 멈춘 쪽의 currentTime을 기준으로 삼으면 낡은 값이
 * 살아 있는 쪽을 되감는다. 기준은 항상 **아래 스택(off)**이라 매 프레임 서로 끌어당기지 않는다.
 */
function keepStandbyVideosInStep(): void {
  const off = standbyVideoEl('off');
  const on = standbyVideoEl('on');
  if (!off || !on || off.paused || on.paused) return;
  syncStandbyVideoFrom(off, on);
}

/**
 * 사진 재생기 게이트용 설정 — 크로스가 남아 있는 동안에는 설정이 꺼져도 계속 돌린다.
 * 값이 같으면 원본을 그대로 돌려준다 (프레임마다 객체를 새로 만들지 않는다).
 */
function effectivePhotoSettings(): PhotoSettings {
  const vis = visualState();
  const on = backdropRuntimeOn(vis.photos.settings.standbyBackdrop, backdropFade.progress);
  return on === vis.photos.settings.standbyBackdrop
    ? vis.photos.settings
    : { ...vis.photos.settings, standbyBackdrop: on };
}

// ---------------------------------------------------------------- 메인 루프

let confettiOn = false;

/**
 * 순위 재정렬 트윈이 끝나는 시각 (D7).
 *
 * 재정렬은 `.sb__row { transition: transform 0.4s }` — CSS transition이라 JS 신호가 없다.
 * 행 순서 서명이 바뀐 프레임에 창을 열어 두고, 그동안 글로우를 멈춘다. 두 애니메이션이
 * 같은 프레임에서 합성기를 나눠 쓰면 실측 p95가 두 배가 됐다.
 */
/** 반전 영상 소리를 0에서 올리는 시간(초) — 붙이는 순간의 클릭만 없애는 짧은 램프다 (D8) */
const MOOD_AUDIO_RAMP_SEC = 0.6;

/**
 * 분위기 반전이 도는 동안 카메라 소리를 내려 둔다 (D8).
 *
 * 글리치 15초 내내 중계 카메라 소리가 그대로 나가면 반전 영상의 오디오와 겹쳐 지저분하다.
 * 씬은 아직 `live`라 `attachSlots`의 파킹 규칙이 돌지 않으므로 여기서 같은 규칙을 쓴다.
 * 되돌리는 것은 **카메라 슬롯이 아직 화면에 있을 때만** — 반전이 끝나면 보통 씬이 넘어가
 * `attachSlots`가 이미 파킹해 두었고, 여기서 풀면 그 정리가 무효가 된다.
 */
let moodCameraParked = false;

function syncMoodCameraAudio(now: number): void {
  const active = state.sceneOpts.moodTransition.active;
  if (active === moodCameraParked) return;
  moodCameraParked = active;
  if (active) {
    cameraAudioParked = true;
    requestAudioTeardown(camMedia, 'mute', now);
    return;
  }
  if (camera.stream && stage.querySelector('[data-cam-slot]')) {
    cameraAudioParked = false;
    camMedia.track = rampGain(cancelTeardown(camMedia.track), 1, state.settings.audioCutFadeSec, now);
  }
}

/* ── 슬로우 리플레이 (Q5 A안) ──────────────────────────────────────────────
 * 링은 **중계 화면에 서 있는 동안만** 돈다. 씬을 떠나면 즉시 폐기해 인코더가 상주하지
 * 않게 한다 — 스팅어 1080p 알파 합성이 60fps 헤드룸을 다 쓰기 때문이다(보수안).
 */

/**
 * 이 창이 리플레이의 **주인**인가.
 *
 * 출력 창을 두 개 이상 열면(예정된 PGM 모니터 iframe은 `display.html?monitor=1`로 뜬다)
 * 창마다 링이 돌아 인코더가 두 벌 상주하고, `replay-buffer:`·`replay-ended:`가 서로
 * 경쟁해 control이 어느 쪽 보고를 믿어야 할지 알 수 없게 된다. 모니터 창은 녹화도 재생도
 * 하지 않고 라이브 카메라만 비춘다 — 되감기는 PGM 한 창의 일이다.
 */
const replayOwner = isReplayOwner(location.search) && !MONITOR;

let replayRing: SegmentRing | null = null;
/** 링이 물고 있는 스트림·되감기 길이. 둘 중 하나라도 바뀌면 세그먼트 주기가 달라져 재생성한다. */
let replayRingStream: MediaStream | null = null;
let replayRingSec = 0;
/** MediaRecorder가 아무 코덱도 못 쓰는 환경 — 매 프레임 다시 시도하지 않는다. */
let replayCodecMissing = false;
/** control에 마지막으로 알린 버퍼 초. `-1`은 "아직 알린 적 없음" */
let replayBufferReported = -1;
let replayBufferReportedAt = 0;

const replayPlayback = new ReplayPlayback({
  video: replayEl,
  ring: () => replayRing,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  // 모니터 창은 어떤 리플레이 사건도 내지 않는다 (경쟁 보고 방지)
  emit: (event) => {
    if (replayOwner) emit(event);
  },
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
});

/**
 * 버퍼 보고 — 값이 바뀌면 즉시, 그 외에는 1초에 한 번 같은 값을 다시 낸다.
 *
 * 같은 값을 계속 내는 것이 낭비로 보이지만 **재접속 창을 위한 것**이다. 정상 상태의 버퍼는
 * 상한에 붙어 정수 초가 영영 바뀌지 않으므로, 변화 시에만 내면 그 사이에 새로고침한 control은
 * 버퍼를 0으로 알고 [리플레이] 버튼을 영영 잠근다. control은 값이 그대로면 재렌더를 건너뛰므로
 * 받는 쪽 비용은 0이다(카메라·오디오 상태를 3초마다 재통보하는 것과 같은 관례).
 */
function reportReplayBuffer(sec: number, now: number): void {
  if (sec === replayBufferReported && now - replayBufferReportedAt < 1000) return;
  replayBufferReported = sec;
  replayBufferReportedAt = now;
  emit(`replay-buffer:${sec}`);
}

function disposeReplayRing(now: number): void {
  if (!replayRing) return;
  replayRing.dispose();
  replayRing = null;
  replayRingStream = null;
  replayRingSec = 0;
  // 패널의 버퍼 칩이 옛 숫자로 남지 않게 0을 알린다
  reportReplayBuffer(0, now);
}

/**
 * 링 수명 — `live` 씬 + 카메라 스트림 + 설정 켬, 셋이 모두 참일 때만 녹화한다.
 * 스트림이 바뀌면(장치 교체) 재생성하고, `replaySec`가 바뀌면 세그먼트 주기가 달라지므로
 * 역시 재생성한다. 모니터 창은 어느 경우에도 만들지 않는다.
 */
function syncReplayRing(scene: SceneId, now: number): void {
  const stream = camera.stream;
  const record = shouldRecordReplay({
    owner: replayOwner,
    scene,
    hasStream: stream !== null,
    enabled: state.settings.replayEnabled,
  });
  if (!record || !stream) {
    disposeReplayRing(now);
    return;
  }
  const sec = normalizeReplaySec(state.settings.replaySec);
  if (replayRing && (replayRingStream !== stream || replayRingSec !== sec)) disposeReplayRing(now);
  if (!replayRing) {
    if (replayCodecMissing) return;
    const mimeType =
      typeof MediaRecorder === 'undefined'
        ? null
        : pickMimeType((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      replayCodecMissing = true;
      return;
    }
    replayRing = new SegmentRing(videoOnlyStream(stream), {
      mimeType,
      segmentMs: segmentMsFor(sec),
      timesliceMs: 1000,
    });
    replayRing.start();
    replayRingStream = stream;
    replayRingSec = sec;
    // 새 링은 처음부터 다시 센다 — 첫 값이 반드시 나가게 한다
    replayBufferReported = -1;
    replayBufferReportedAt = 0;
  }
  reportReplayBuffer(replayBufferedSec(replayRing.bufferedMs(), sec), now);
}

/**
 * 재생 구동. **로컬 가드가 먼저다** — `shownScene`이 `live`가 아니면 상태가 무엇이든
 * 재생하지 않고 정리한다(전환 토큰·2부 잠금을 건드리지 않는 이중 안전장치).
 * 사슬의 실패 처리·정리는 전부 `ReplayPlayback`이 한다(`src/replay-playback.ts`).
 */
function tickReplay(scene: SceneId): void {
  const request = scene === 'live' && replayOwner ? state.sceneOpts.liveOverlay.replay : null;
  if (!request) {
    replayPlayback.stop();
    return;
  }
  replayPlayback.request(request);
}

let reorderUntil = 0;
let reorderSig = '';
/** `.sb__row { transition: transform 0.4s }`와 같은 값이어야 한다 */
const REORDER_TWEEN_MS = 400;

/**
 * 지금 보드가 보여 주는 순위 배치. 값이 바뀌면 그 프레임부터 트윈이 돈다.
 *
 * **DOM 순서가 아니라 순위(`data-rank`)를 본다** (D9). 재정렬은 DOM을 재배치하지 않고
 * `translateY`만 바꾸므로, DOM 순서 서명은 영영 그대로다.
 */
function paintReorderWindow(now: number): void {
  const rows = stage.querySelectorAll<HTMLElement>('[data-rank][data-team]');
  const sig = reorderSignature(
    [...rows].map((row) => ({ team: row.dataset.team ?? '', rank: row.dataset.rank ?? '' })),
  );
  if (sig !== reorderSig) {
    // 첫 렌더(빈 서명 → 값)는 재정렬이 아니라 진입이다 — 진입은 `animation-delay`가 담당한다.
    if (reorderSig !== '') reorderUntil = now + REORDER_TWEEN_MS;
    reorderSig = sig;
  }
}

function paint(): void {
  const now = Date.now();
  // 동결 스냅샷이 **맨 먼저**다 (U75). 이 프레임의 모든 시각 경로가 같은 상태를 읽어야
  // "스코어바만 갱신된 얼어붙은 화면"이 나가지 않는다.
  syncFreezeSnapshot();
  const vis = visualState();
  // 해제 순간 한 번만 도는 예열 (U97). 이후 프레임은 boolean 비교 하나로 즉시 빠진다.
  if (vis.p2.unlocked) warmP2SteadyImages();
  // 검정 페이드가 먼저다 — playing 진입의 muted/restartToken 세팅이 ensureVideo보다 앞서야 한다.
  tickFade(now);
  tickSceneFade(now);
  tickBlackout(now);
  maybeTransition();

  // 렌더는 상태가 아니라 `shownScene`을 따른다 — 전환 스윕이 덮은 순간에만 씬이 바뀐다.
  /**
   * ⚠️ 순서 계약 (U98): **새 씬을 먼저 그리고, 덮개는 그 뒤에 해체한다.**
   *
   * `renderScene()` → `updateMoodVisual()`(반전 검정·글리치) → `ensureOverlayVideo()`
   * (`#overlay-video`). 셋 다 이 함수의 같은 동기 턴 안이라 한 번의 합성에 들어간다 —
   * 덮개를 먼저 걷으면 아직 갈아끼우지 않은 옛 씬(중계 카메라)이 한 프레임 드러난다.
   * 이 순서를 뒤집지 말 것. `src/mood-scene-cover.test.ts`가 소스 스캔으로 고정한다.
   */
  const scene = shownScene;
  const changed = renderScene(vis, stage, scene);
  // 여기부터 tickScene까지는 레이아웃을 읽지 않는다(offsetWidth·getBoundingClientRect 등).
  // 방금 innerHTML을 갈아끼운 직후라 읽는 순간 강제 리플로가 걸려 매 프레임 비용이 된다.
  const operatorControlHidden = displayOperatorControlHidden(
    scene,
    vis.sceneOpts.standby.mode,
    vis.sceneOpts.game.mode,
  );
  // 모니터에는 운영 크롬을 띄우지 않는다 — 조작 패널 안의 작은 그림에서 눌릴 것이 없다 (U72)
  fsBtn.hidden = MONITOR || operatorControlHidden;
  // 음소거 버튼은 그 버튼을 따라간다 (U88) — 전체화면에서는 한 겹 더 감춘다
  updateMuteBtn();
  if (MONITOR || operatorControlHidden) scaleBadge.hidden = true;
  // 카메라·소리는 **라이브** 상태를 따른다 (U75) — 스트림은 상태가 아니라 장치라 동결 중에도
  // 계속 움직이고, 그 그림의 반전/음소거를 옛 설정으로 되돌리면 화면과 설정이 어긋난다.
  const camTransform = cameraTransform(
    state.settings.camera.flipX,
    state.settings.camera.flipY,
  );
  camEl.style.transform = camTransform;
  // 리플레이도 같은 반전을 쓴다 — 거울모드에서 되감기만 좌우가 뒤집히면 사고다
  replayEl.style.transform = camTransform;
  // 카메라 소리는 설정이 켜져 있을 때만. 정책 폴백으로 막힌 동안에는 음소거를 유지한다 (§11 M8).
  // 치워 둔 동안에는 게인의 주인이 정리다 — 여기서 되돌리면 페이드가 끝나자마자 소리가 살아난다.
  setOutputMuted(
    camEl,
    cameraMuted({
      audioEnabled: state.settings.camera.audio,
      policyBlocked: cameraAudioBlocked,
      parked: cameraAudioParked,
      gain: camMedia.track.gain,
    }),
  );
  camMedia.track = policyGain(camMedia.track, cameraAudioParked, 1);
  // 상태 동기화 직후에도 소리 있는 오버레이의 mute/volume과 시각 phase를 한 프레임 안에 맞춘다.
  updateMoodVisual();

  // 1080p 알파 전환과 screen 합성 canvas를 동시에 올리면 실제 Chrome에서 프레임 드롭이 난다.
  // 전환 중에는 canvas를 즉시 합성에서 빼고 off 모드로 내려 GPU/CPU를 영상에 양보한다.
  const ambientPresentation = transitionAmbientPresentation(
    scene,
    vis.sceneOpts.transitionVideo.active,
  );
  ambient.canvas.hidden = ambientPresentation.hidden;
  ambient.setScene(ambientPresentation.scene);

  if (changed) attachSlots();
  // 다크 프레임은 슬롯을 비운 **뒤에** 다시 붙어야 한다 (U118).
  syncLiveFrame(scene);

  // 엣지 호흡 글로우 (U41) — CSS만으로 도는 애니메이션이라 여기서는 스위치 세 개만 심는다.
  // 스팅어가 덮은 동안에는 `.is-tx`, 순위 재정렬 트윈(0.4s)이 도는 동안에는 `.is-reordering`으로
  // 멈춘다 (D7) — 안 보이거나 다른 애니메이션이 프레임 예산을 쓰는 구간에 겹치지 않는다.
  document.body.classList.toggle('is-luxe-glow', vis.settings.luxeGlow);
  document.body.classList.toggle('is-tx', vis.sceneOpts.transitionVideo.active);
  paintReorderWindow(now);
  syncMoodCameraAudio(now);
  document.body.classList.toggle('is-reordering', now < reorderUntil);

  // 사진 재생기 판정보다 **먼저** 크로스를 전진시킨다 — 진행률이 사진 게이트의 입력이다.
  tickStandbyBackdrop(now, scene);

  // 전체 사진 씬 또는 사용자가 켠 대기 배경에서만 같은 큐를 재생한다.
  const wantPhotoRuntime = wantPhotoRuntimeFor(scene);
  if (wantPhotoRuntime !== photoRuntimeEnabled) {
    photoRuntimeEnabled = wantPhotoRuntime;
    if (wantPhotoRuntime) {
      if (standbyCrossfadeScene(scene, vis.sceneOpts.standby.mode)) {
        restartStandbyPhotoSession(now);
      } else photoLastTickAt = now;
    }
    else releasePhotos();
  }
  if (wantPhotoRuntime) {
    syncPhotoFilters();
    tickPhotos(now);
  }

  const wantConfetti = scene === 'award' && vis.sceneOpts.award.step === 'winner';
  if (wantConfetti !== confettiOn) {
    confettiOn = wantConfetti;
    if (wantConfetti) confetti.start();
    else confetti.stop();
  }

  // 카메라만은 전환보다 먼저 예열한다 (0.45s 전환 뒤에 열면 첫 화면이 비어 보인다)
  if (!MONITOR && (scene === 'live' || pickScene(vis) === 'live')) {
    void camera.ensure(state.settings.camera.deviceId, state.settings.camera.audio);
  }
  // 링은 카메라가 열린 뒤에 판단한다 (같은 프레임에 스트림이 막 준비됐을 수 있다)
  syncReplayRing(scene, now);
  tickReplay(scene);
  // `phase === 'playing'`이면 씬 렌더가 아직 따라오지 않았어도 영상을 붙인다 (§11 M3).
  // 반대로 `covering` 동안에는 씬이 아직 'video'여도 **붙이지 않는다** — 검정이 다 덮이기 전에
  // 새 영상의 소리가 먼저 새어 나온다 (리뷰 M2. 영상 씬에서 다음 영상을 트는 경로가 정확히 이것).
  // 화면에 남은 이전 영상은 그대로 두고, tickFade의 covering 분기가 볼륨만 같이 내린다.
  const videoPhase = vis.sceneOpts.video.phase;
  if (videoPhase === 'playing' || (videoPhase !== 'covering' && scene === 'video')) {
    void ensureVideo(
      vis.sceneOpts.video.assetId,
      vis.sceneOpts.video.restartToken,
      vis.sceneOpts.video.paused,
    );
    // 패널 진행 바용 보고 (BroadcastChannel 전용, 상태를 바꾸지 않는다)
    if (now - lastProgressAt > 200) {
      lastProgressAt = now;
      sync.progress(videoEl.currentTime || 0, Number.isFinite(videoEl.duration) ? videoEl.duration : 0);
    }
  } else if (videoPhase !== 'covering' && videoAssetId !== null) {
    // covering은 예외다 — 여기서 pause하면 볼륨 램프가 무의미해지고 소리가 그 자리에서 끊긴다.
    // 이전 영상은 검정이 완전히 덮일 때까지 계속 재생하고, playing 진입에서 새 소스로 갈린다.
    // 소리는 `audioCutFadeSec` 동안 내려간 뒤에 멈춘다 — 화면은 이미 다음 씬이다 (U27)
    requestAudioTeardown(videoMedia, 'pause', now);
    videoAssetId = null;
    videoSrcAssetId = null;
    // 예약·바인딩을 한 쌍으로 되돌린다 — 한쪽만 남기면 다음 재생이 우연히 같은 토큰을 들고 왔을 때
    // 옛 값과 맞아떨어질 수 있다.
    videoSrcRestartToken = -1;
  }
  void ensureTransitionVideo();
  void ensureOverlayVideo();
  applyMusic(now);
  if (now - lastMusicProgressAt > 200) {
    lastMusicProgressAt = now;
    // 진행 보고는 언제나 **현재 덱** 기준이다 — 페이드 아웃 중인 옛 덱의 시각을 보내면
    // 곡 교체 직후 패널 진행 바가 이전 곡 위치로 튄다.
    const deck = currentMusicDeck();
    // 페이드 아웃이 끝나 실제로 멎었으면 **마지막 한 번만** 보내고 멈춘다. 계속 보내 봐야
    // 같은 값이고, 페이드 도중에는 소리가 실제로 나가는 중이므로 t가 오르는 것이 맞다.
    const musicLive = state.music.trackId !== null && (!deck.el.paused || deck.track.ramp !== null);
    if (musicLive) musicProgressParked = false;
    if (musicLive || !musicProgressParked) {
      sync.musicProgress({
        trackId: state.music.trackId,
        t: deck.el.currentTime || 0,
        d: Number.isFinite(deck.el.duration) ? deck.el.duration : 0,
        playing: state.music.playing && !deck.el.paused,
      });
      musicProgressParked = !musicLive;
    }
  }
  if (!vis.sceneOpts.transitionVideo.active) void prewarmTransitionVideo();
  const transition = vis.sceneOpts.transitionVideo;
  if (
    isTransitionSwitchDue(transition, {
      boundAssetId: transitionBoundAssetId,
      boundToken: transitionBoundToken,
      currentTime: transitionVideoEl.currentTime,
      durationSec: transitionVideoEl.duration,
      reportedToken: transitionSwitchReportedToken,
    })
  ) {
    transitionSwitchReportedToken = transition.restartToken;
    emit(`transition-switch:${transition.restartToken}`);
  }
  updateAudioBadge();
  void ensureKeyVisual(vis.settings.keyVisualAssetId);
  primeLogos(vis.teams);

  tickBindings(now);
  tickMoodGlitch(now);
  tickScene(stage, vis, now, scene);
}

/**
 * 모니터의 프레임 예산 (U72). 출력 창과 **같은 머신**에서 60fps 루프가 두 벌 돌면 조작
 * 패널이 있는 PC의 CPU가 두 배가 된다 — 1080p 알파 스팅어가 이미 헤드룸을 다 쓴다.
 * 15fps면 씬·오버레이·전환을 확인하는 데 충분하고, 상태 방송이 오면 그 즉시 따로 그린다.
 */
const MONITOR_FRAME_MS = 1000 / 15;
let monitorPaintedAt = 0;

function frame(): void {
  if (MONITOR) {
    const now = Date.now();
    if (now - monitorPaintedAt >= MONITOR_FRAME_MS) {
      monitorPaintedAt = now;
      paint();
    }
  } else {
    paint();
  }
  requestAnimationFrame(frame);
}

// 로고가 IndexedDB에서 풀리면 다음 프레임에서 자연스럽게 반영된다
setLogoListener(() => paint());

requestAnimationFrame(frame);
// rAF가 멈추는 상황(가려진 창·절전)에서도 최소한의 갱신은 유지한다
window.setInterval(paint, 400);

// 음악 게인만은 그 400ms로 부족하다 — 5초 페이드가 12단 계단으로 들린다. 램프가 실제로
// 도는 동안만 짧은 주기로 따로 굴린다(평소에는 첫 줄에서 곧바로 빠져나가 비용 0).
// rAF에 얹지 않는 이유는 백그라운드 탭에서 rAF가 아예 멈추기 때문이다.
window.setInterval(() => {
  const live = [...musicDecks.map((d) => d.track), ...gatedMedia.map((m) => m.track)];
  // 볼륨 램프(U43·U45)·덕킹(U44)도 같은 이유로 여기 얹는다 — 400ms면 램프가 계단으로 들린다.
  const duckMoving = musicDuck.ramp !== null || state.music.ducked !== musicDuck.applied;
  // 암전 오디오 축(U95)도 같은 이유로 여기 얹는다 — 이 루프가 유일한 갱신 경로라
  // 빠뜨리면 소리가 아예 안 내려간다(paint는 tickAudioGains를 부르지 않는다).
  const blackoutMoving = blackoutAudioMoving(blackoutAudio, state.sceneOpts.blackout.active);
  if (
    !anyVolumeRampActive(state.volumeRamps) &&
    !duckMoving &&
    !blackoutMoving &&
    !live.some((track) => track.ramp !== null)
  ) {
    return;
  }
  tickAudioGains(Date.now());
}, 50);

// 카메라 상태를 주기적으로 재통보 — 조작 패널이 새로고침되면 이 정보를 잃어버리기 때문에
// (패널의 상태 점이 영영 '확인 안 됨'으로 남는 것을 막는다)
window.setInterval(() => {
  if (MONITOR) return;
  if (camera.stream) emit('camera-ok');
  else if (camera.error) emit('camera-fail');
  // 오디오 잠김도 같은 주기로 재통보한다 (§11 H5) — control이 새로고침되면 이 정보를 잃는다
  reportAudioState(true);
  // 운영자 음소거도 같은 이유로 재통보한다 (U88). 조작 패널이 새로고침된 뒤 "출력 창이
  // 음소거 중"이라는 사실만 조용히 사라지면, 소리가 왜 없는지 아무도 모르게 된다.
  reportUserMuteState(true);
}, 3000);
