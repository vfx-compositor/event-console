/**
 * 출력 창 오디오 잠금 경고 (U48).
 *
 * ## 무엇이 문제였나
 * 브라우저 자동재생 정책은 "사용자 제스처가 한 번도 없었던 탭"에서 소리 있는 재생을 막는다.
 * 출력 창은 프로젝터로 밀어 두고 **손대지 않는 창**이라 이 조건에 정확히 걸린다. 화면은
 * 멀쩡히 나가고 **소리만 없다** — 리허설에서 알아채지 못하면 본방 첫 영상에서 발견한다.
 *
 * 기존에는 상단 바의 작은 상태 점 하나가 전부였다. 점 하나는 열 개 남짓한 다른 지표 사이에서
 * 눈에 띄지 않는다. 그래서 두 단계로 나눈다:
 *  - `warn` — 잠겨 있지만 지금 당장 죽는 소리는 없다. 상시 빨강 배너로 알린다.
 *  - `critical` — **지금 소리가 나가야 하는데 안 나가는 중**이다. 배너를 강조하고 토스트를 띄운다.
 *
 * 출력 창을 한 번 클릭하면 브라우저가 오디오 재생을 허용하고 밀렸던 재생이 이어진다.
 * 상태 동기화를 위해 조작 창과 출력 창은 같은 브라우저 프로필에서 열어야 한다.
 */

export type AudioLockLevel = 'none' | 'warn' | 'critical';

/**
 * @param locked `null` = 출력 창이 아직 보고하지 않음. 모르는 것을 빨강으로 칠하지 않는다 —
 *   창을 열자마자 1~2초 동안 경고가 떴다 사라지면 그 다음부터 아무도 안 본다.
 * @param musicPlaying 행사 BGM이 울려야 하는 상태인가
 * @param videoAudioOwnsOutput 소리 있는 영상이 지금 화면을 쥐고 있는가 (`music-duck.ts`와 같은 판정)
 */
export function audioLockLevel(
  locked: boolean | null | undefined,
  musicPlaying: boolean,
  videoAudioOwnsOutput: boolean,
): AudioLockLevel {
  if (locked !== true) return 'none';
  return musicPlaying || videoAudioOwnsOutput ? 'critical' : 'warn';
}

/** 지금 이 조작이 잠금 때문에 소리 없이 끝나는가 — 토스트를 띄울 자리 */
export function audioActionBlocked(locked: boolean | null | undefined): boolean {
  return locked === true;
}

export const AUDIO_LOCK_TITLE = '출력 창 소리 잠김';

export const AUDIO_LOCK_FIX =
  '출력 창을 한 번 클릭해 소리를 허용하세요. 조작 창과 출력 창은 같은 브라우저 프로필에서 열어야 상태가 동기화됩니다.';

export function audioLockMessage(level: AudioLockLevel): string {
  if (level === 'critical') {
    return `지금 나가야 할 소리가 나가지 않고 있습니다. ${AUDIO_LOCK_FIX}`;
  }
  return `아직 소리를 낸 적이 없어 상태를 알 수 없습니다 — 영상·음악을 트는 순간 무음으로 나갑니다. ${AUDIO_LOCK_FIX}`;
}

/**
 * [출력창 열기] 버튼 툴팁.
 *
 * 브라우저 자동재생 정책 때문에 새 출력 창은 클릭 전까지 무음일 수 있다. 조작 창과 다른
 * 프로필에서 열면 상태 동기화도 끊기므로 버튼을 누르기 전에 두 조건을 함께 안내한다.
 */
export const AUDIO_LOCK_OPEN_DISPLAY_TIP =
  '새 창으로 display.html을 엽니다. 조작 창과 같은 브라우저 프로필에서 열고, 프로젝터로 옮긴 뒤 창을 한 번 클릭해 소리를 허용하세요. 창 우하단 [전체화면] 또는 F 키로 전체화면을 켭니다.';

/** 음악·오디오 영상 조작 순간에 띄우는 토스트 문구 */
export function audioLockToast(what: '음악' | '영상'): string {
  return `${what} 소리가 출력 창에서 막혀 있습니다 — 출력 창을 한 번 클릭하세요`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 거짓 잠금 판정 방지 (U48 후속)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `HTMLMediaElement.play()`가 던진 거부를 분류한다.
 *
 * ## 무엇이 문제였나
 * 출력 창의 세 재생 자리(카메라·오버레이 영상·설명 영상)가 **거부를 전부 자동재생 잠금으로**
 * 취급했다. 그런데 `play()`는 잠금 말고도 routine하게 거부된다 —
 *
 *  - `AbortError` — "play() interrupted by a new load request / by pause()".
 *    씬을 바꾸거나 소스를 갈아 끼우는 매 순간, 그리고 배경 탭 throttling에서 정상적으로 난다.
 *  - 그 밖의 오류(`NotSupportedError` 등) — 소스 문제지 정책 문제가 아니다.
 *
 * 이걸 잠금으로 세니 **소리는 멀쩡히 나가는데** 배지와 조작 패널 빨강 배너가 떴고
 * ("창을 클릭하세요"), 이어지는 클릭이 `resumePendingAudio()`를 돌려 이미 울리는 것들을
 * 한 번 더 붙여 **오디오가 겹쳐** 나갔다. 실제 현장 증상이 이것이다.
 *
 * 잠금은 `NotAllowedError` 하나뿐이다 — 자동재생 정책이 던지는 이름이 그것이다.
 */
export type PlayRejection = 'autoplay-lock' | 'ignore' | 'error';

export function classifyPlayRejection(error: unknown): PlayRejection {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  if (name === 'AbortError') return 'ignore';
  if (name === 'NotAllowedError') return 'autoplay-lock';
  return 'error';
}

/**
 * 잠금이 풀린 뒤 **지금 실제로 울려야 하는 것만** 고른다 (U48 후속).
 *
 * ## 무엇이 문제였나
 * 기존 `resumePendingAudio()`는 상태를 보지 않고 셋을 전부 다시 붙였다 — 설명 영상은 씬이
 * `video`가 아니어도 `play()`했고, 카메라는 치워 둔(parked) 동안에도 `play()` + unmute했다.
 * 화면에 없는 소스가 소리만 내며 지금 씬의 소리 위에 얹히는 것이 **오디오 겹침**의 정체다.
 *
 * ## 판정 근거: "muted 재생은 애초에 막히지 않는다"
 * 자동재생 정책은 **소리 있는** 재생만 막는다. 그러므로 잠금 해제가 되살릴 대상은
 * "지금 소리를 내고 있어야 하는데 정책 때문에 못 내는 것"뿐이다. 무음으로 도는 소스는
 * 애초에 막힌 적이 없으므로 여기서 건드릴 이유가 없다 — 건드리면 그게 겹침이다.
 *
 * 상태 객체 대신 필요한 값만 받는다. `AppState` 전체를 요구하면 이 판정 하나를 테스트하려고
 * 씬·에셋·음악을 다 만들어야 하고, 그러면 경계 케이스를 안 쓰게 된다.
 */
export interface PendingAudioResumeInput {
  /** 지금 **실제로 그려지고 있는** 씬 (상태의 씬이 아니다 — 전환 스윕 도중에는 다르다) */
  shownScene: string;
  /** 설명 영상이 조작 패널에서 일시정지되어 있는가 */
  videoPaused: boolean;
  /** 중계 카메라 소리 설정 */
  cameraAudioEnabled: boolean;
  /** 카메라를 화면 밖으로 치웠는가 (중계 씬이 아니다) */
  cameraParked: boolean;
  musicPlaying: boolean;
  musicTrackId: string | null;
}

export interface PendingAudioResumePlan {
  /** 설명 영상을 다시 붙이고 오디오 정책을 재적용할 것인가 */
  video: boolean;
  /** 중계 카메라를 다시 붙일 것인가 */
  camera: boolean;
  /** 음악 덱을 다시 붙일 것인가 */
  music: boolean;
}

export function pendingAudioResumePlan(input: PendingAudioResumeInput): PendingAudioResumePlan {
  return {
    // 씬이 `video`일 때만. 다른 씬에서 되살리면 화면에 없는 영상 소리가 얹힌다.
    video: input.shownScene === 'video' && !input.videoPaused,
    // 치워 둔 카메라는 게인의 주인이 정리다. 소리 설정이 꺼져 있으면 muted라 막힌 적도 없다.
    camera: input.shownScene === 'live' && input.cameraAudioEnabled && !input.cameraParked,
    // 음악만은 씬과 무관하다 — 행사 BGM은 어느 씬 위에서도 울린다.
    // 덕킹(U44)은 `deck.track`과 **곱으로 합성되는 별도 축**이라 여기서 목표를 낮추지 않는다.
    // 낮추면 영상이 끝나 덕킹이 1로 돌아올 때 음악이 두 배로 작아진 채 남는다.
    music: input.musicPlaying && input.musicTrackId !== null,
  };
}
