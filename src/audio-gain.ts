/**
 * 출력 창에서 **소리가 나는 모든 미디어**의 볼륨을 한 곳에서 다루기 위한 순수 계산 (U27).
 *
 * ## 왜 매니저 하나인가
 * 소리를 내는 엘리먼트가 다섯이다(음악 덱 2 · 설명 영상 · 오버레이 영상 · 중계 카메라).
 * 각자 `el.volume`을 쓰면 "누가 마지막에 썼는가"가 프레임마다 달라지고, 어떤 경로는 페이드를
 * 걸고 어떤 경로는 그냥 끊는다. 실제로 스킵·중단·워치독·씬 컷에서 소리가 뚝 끊기는 자리가
 * 경로마다 따로 있었다. 여기서 계산하고 display가 **한 곳에서만** element에 심는다.
 *
 * ## 계약: 소리는 0에 닿은 뒤에 끊는다
 * `pause()`·`src` 해제·DOM 제거는 게인이 0이 된 다음에만 한다(`after`). 시각은 기다리지 않는다 —
 * 화면에서는 즉시 감추고 소리만 남겨 내리는 "고스트 테일"이다. 화면이 페이드를 기다리면
 * 컷이 뭉개지고, 소리가 안 기다리면 뚝 끊긴다. 둘은 다른 속도로 가야 한다.
 *
 * 램프 산수는 `fade-ramp.ts`를 그대로 쓴다 — 검정 페이드·음악 페이드·배경 크로스와 같은 곡선이다.
 */

import { blackoutDurationMs, blackoutOpacity, blackoutTarget } from './blackout';
import { isRampDone, makeRamp, rampTarget, rampValueAt, type ValueRamp } from './fade-ramp';
import { outputVolume } from './output-audio';

/**
 * 게인이 0에 닿았을 때 할 일.
 * `mute`는 카메라처럼 **멈출 수 없는 스트림**용이다 — `pause()`하면 미리보기가 죽는다.
 */
export type GainTeardown = 'none' | 'pause' | 'release' | 'mute';

export interface GainTrack {
  /** 마스터 볼륨과 곱하기 전의 게인 (0~1) */
  gain: number;
  ramp: ValueRamp | null;
  after: GainTeardown;
}

export function idleTrack(gain = 0): GainTrack {
  return { gain, ramp: null, after: 'none' };
}

/**
 * "이 소스가 제 소리를 다 내는" 트랙 게인.
 *
 * 마스터 볼륨과 덕킹(U44)은 **트랙 게인이 아니라 별도 축**이며 `tickAudioGains`가 매 프레임
 * 곱으로 합성한다. 그러므로 재생·페이드 인의 목표는 언제나 이 값이고, "지금 덕킹 중이니
 * 목표를 낮춰야 하나"를 호출자가 물을 필요가 없다 — 낮추면 두 축이 이중으로 걸려 영상이
 * 끝나고 덕킹이 풀려도 소리가 절반만 돌아온다.
 */
export const TRACK_FULL_GAIN = 1;

/**
 * 목표 게인으로 램프를 건다. 시작값은 **언제나 현재 게인**이라 어떤 순서로 뒤집어도 튀지 않는다.
 * `after`는 0에 닿았을 때 할 정리이며, 0이 아닌 목표로 램프하면 예약이 취소된다
 * (페이드 아웃 중에 다시 재생을 누른 경우 — 내려가다 말고 올라가는데 정리가 남아 있으면 안 된다).
 */
export function rampGain(
  track: GainTrack,
  to: number,
  fadeSec: number,
  now: number,
  after: GainTeardown = 'none',
): GainTrack {
  return {
    gain: track.gain,
    ramp: makeRamp(track.gain, to, fadeSec, now),
    after: to <= 0 ? after : 'none',
  };
}

/**
 * 예약된 정리를 취소한다 — 페이드 아웃 도중 새 소스가 붙어 이 엘리먼트가 다시 살아난 경우.
 * 안 하면 뒤늦게 도착한 정리가 **방금 붙인 새 소스**를 떼어 낸다.
 */
export function cancelTeardown(track: GainTrack): GainTrack {
  return { gain: track.gain, ramp: track.ramp, after: 'none' };
}

/**
 * 즉시 목표값으로 (소유자가 자기 곡선을 가진 경우 — 설명 영상 검정 페이드 등).
 *
 * ## 정리 예약 중에는 **무시한다**
 * 실사고: `⏭ 스킵`이 `requestAudioTeardown(... 'pause')`로 램프를 걸어 두면, 다음 프레임에
 * `tickFade`의 idle 분기가 매 프레임 `setGain(track, 1)`을 부른다. 예전 구현은 여기서 `ramp`를
 * null로 덮어 버려 게인이 1로 되돌아가고 `after: 'pause'`는 **영영 실행되지 않았다.**
 * 화면은 다음 씬인데 떼어 낸 설명 영상 소리만 끝까지 나오는 상태가 된다.
 *
 * 정리가 예약된 트랙의 주인은 이미 그 정리다. 곡선 소유자의 매 프레임 갱신보다 우선한다.
 */
export function setGain(track: GainTrack, gain: number): GainTrack {
  if (track.after !== 'none') return track;
  return { gain: Math.max(0, Math.min(1, gain)), ramp: null, after: 'none' };
}

/**
 * 한 프레임 전진. `finish`가 'none'이 아니면 그 정리를 **지금** 실행해야 한다는 뜻이다.
 * 정리는 한 번만 나온다 — 반환된 track의 `after`는 이미 비워져 있다.
 */
export function stepGain(track: GainTrack, now: number): { track: GainTrack; finish: GainTeardown } {
  if (!track.ramp) return { track, finish: 'none' };
  const gain = rampValueAt(track.ramp, now);
  if (!isRampDone(track.ramp, now)) {
    return { track: { gain, ramp: track.ramp, after: track.after }, finish: 'none' };
  }
  const settled = track.ramp.to;
  const finish: GainTeardown = settled <= 0 ? track.after : 'none';
  return { track: { gain: settled, ramp: null, after: 'none' }, finish };
}

/** 지금 소리가 나고 있는가 (게인이 남았거나 아직 내려가는 중) */
export function isAudible(track: GainTrack): boolean {
  return track.gain > 0 || rampTarget(track.ramp, track.gain) > 0;
}

/**
 * 이 엘리먼트가 **문서 안에 남아 있어야 하는가** (U27 D5).
 *
 * HTML 명세상 media element가 문서에서 제거되면 브라우저가 알아서 `pause()`한다. 씬이 바뀌며
 * stage의 innerHTML이 갈릴 때 `<video>`가 그대로 떨어져 나가면, 볼륨 램프는 멀쩡히 돌지만
 * **소리는 이미 하드 컷**이다 — 페이드가 정지된 엘리먼트 위에서 헛돈다.
 * 소리가 남았거나 정리가 예약된 동안에는 화면에서 감추더라도 문서에는 남겨야 한다.
 */
export function requiresDocumentPresence(track: GainTrack): boolean {
  return track.after !== 'none' || isAudible(track);
}

/**
 * 정리를 지금 해도 되는가.
 *
 * 이미 무음이면 기다릴 이유가 없다(`now`). 소리가 남아 있으면 페이드를 걸어야 한다(`fade`).
 * 페이드 길이가 0이면 사용자가 컷을 고른 것이므로 그대로 끊는다.
 */
export function teardownDecision(track: GainTrack, fadeSec: number): 'now' | 'fade' {
  if (!(fadeSec > 0)) return 'now';
  return isAudible(track) ? 'fade' : 'now';
}

/**
 * 마스터 볼륨과 트랙 게인의 합성 — element에 실제로 심는 값.
 * 클램프 규칙은 `output-audio.ts` 하나를 그대로 쓴다(카메라도 같은 함수를 쓴다).
 */
export function trackVolume(masterVolume: number, track: GainTrack): number {
  return outputVolume(masterVolume, track.gain);
}

/**
 * 출력 창에서 이 엘리먼트가 소리를 내면 안 되는가 — **모든 미디어의 단일 음소거 판정** (U72 · U88).
 *
 * ## 세 축이 OR로 합쳐진다
 *  1. `monitor` — PGM 모니터 창 (U72). 같은 상태를 두 창이 그리면 영상·음악이 **두 번**
 *     들린다. 모니터는 그림만 보는 창이므로 전부 무음이다.
 *  2. `userMuted` — 운영자가 **이 창에서** 음소거 버튼을 눌렀다 (U88). 서브 모니터에 확인용으로
 *     display를 하나 더 띄울 때 쓰는 손잡이다. 창 단위 선택이라 상태 원장에도, 방송에도 오르지
 *     않는다 — 진짜 출력 창의 소리를 이 버튼이 끌 수 있으면 그것이 더 큰 사고다.
 *  3. `assetMuted` — 이 소스 자체의 판정 (에셋의 `audio: false`, 카메라 설정 끔,
 *     자동재생 정책 폴백, 분위기 반전이 아닌 오버레이 등).
 *
 * ## `.volume`이 아니라 `muted`로 끄는 이유
 *  1. §3 계약 — 모든 `.volume` 쓰기는 이 매니저만 한다. 호출부가 볼륨을 0으로 덮으면
 *     그 규칙에 구멍이 생긴다.
 *  2. 게인·램프 계산은 모니터·음소거 중에도 그대로 돌아야 한다. 값을 0으로 눌러 버리면
 *     램프 상태가 창마다 갈려, 음소거를 풀 때 소리가 엉뚱한 값에서 시작한다. `muted`만 걷으면
 *     진행 중이던 램프가 그 자리에서 이어진다 — 해제에 별도 페이드를 걸지 않는 근거이기도 하다.
 */
export interface OutputMuteInput {
  /** PGM 모니터 창인가 (`?monitor=1`) */
  monitor: boolean;
  /** 운영자가 이 창을 음소거했는가 (창 단위 토글, 전체화면에서는 언제나 false) */
  userMuted: boolean;
  /** 이 소스 자체가 무음이어야 하는가 */
  assetMuted: boolean;
}

export function outputMuted(input: OutputMuteInput): boolean {
  return input.monitor || input.userMuted || input.assetMuted;
}

/**
 * 중계 카메라 음소거 판정 (U27 D5-3).
 *
 * ## 왜 `parked`가 따로 필요한가
 * 카메라는 스트림이라 `pause()`할 수 없어 정리가 **mute**다. 그런데 정리가 끝나는 순간
 * `after`가 `'none'`으로 돌아가므로, 매 프레임 게인을 1로 되돌리던 정책이 그 다음 프레임부터
 * 다시 통했다. 실측: 씬 컷 후 volume이 1 → 0으로 잘 내려갔다가 **+880ms에 1로 복귀**하고
 * unmute되어 카메라 소리가 되살아났다.
 *
 * 화면 밖으로 치운 동안에는 게인의 주인이 "정리"다. 그 사실을 `after`가 아니라 **별도 플래그**로
 * 들고 있어야 한다 — `after`는 정리가 끝나면 사라지는 값이라 상태를 표현하지 못한다.
 */
export function cameraMuted(input: {
  /** 설정에서 카메라 소리를 켰는가 */
  audioEnabled: boolean;
  /** 자동재생 정책에 막혔는가 */
  policyBlocked: boolean;
  /** 화면 밖으로 치웠는가 (중계 씬이 아니다) */
  parked: boolean;
  gain: number;
}): boolean {
  // 치웠다는 사실만으로 끄지 않는다. 그러면 램프가 **이미 음소거된** 엘리먼트 위에서 돌아
  // 페이드가 들릴 자리가 없다(실측: 컷 첫 샘플부터 muted=true — U27이 막으려던 하드 컷 그대로다).
  // 실제로 끄는 것은 게인이 0에 닿았을 때뿐이다.
  return !input.audioEnabled || input.policyBlocked || (input.parked && input.gain <= 0);
}

/**
 * `#overlay-video` 음소거 판정 (U101) — 카메라(`cameraMuted`)와 **같은 규칙, 같은 이유**.
 *
 * 사용자 신고(04:06) — "파트1 글리치+분위기반전영상에서 다른 컷 넘어가면 오디오가 툭 끊김.
 * 여기만 페이드가 적용이 안 돼 있어."
 *
 * ## 왜 소유권만으로 끄면 안 되는가
 * `mood/abort`는 `moodTransition.active`와 `overlayVideo.active`를 **같은 프레임에** 내린다.
 * 그 프레임의 `updateMoodVisual()`이 "이제 주인이 아니다"만 보고 곧장 `muted = true`를 심으면,
 * 바로 뒤 `ensureOverlayVideo()`가 거는 `audioCutFadeSec` 램프는 **이미 음소거된 엘리먼트
 * 위에서** 돈다. 게인은 곱게 내려가는데 귀에 들리는 것은 하드 컷이다 — U27이 막으려던
 * 바로 그 모양이고, 카메라가 D5-3에서 겪은 사고와 글자 그대로 같다.
 *
 * ## 그래서 게인이 0에 닿을 때까지 연다
 * 주인이 손을 놓아도 **그 소스가 반전이 튼 것이었다면**(`moodSource`) 소리의 주인은 아직
 * 꼬리 램프다. 게인이 0에 닿는 순간 정리(`release`)가 돌고 `moodSource`도 함께 내려가므로
 * 그 뒤로는 영구히 muted다.
 *
 * `moodSource`가 `moodOwned`와 따로 필요한 이유는 카메라의 `parked`가 `after`와 따로 필요했던
 * 이유와 같다 — 상태에서 사라진 사실을 게인이 다 빠질 때까지 들고 있어야 한다.
 *
 * ## 반전이 아닌 오버레이는 **에셋이 정한다** (U101b · 리뷰 C1)
 * 첫 판(U101)은 `moodSource`가 아닌 오버레이를 무조건 음소거했다. 그 시점에는 이 슬롯을
 * 쓰는 매치 6편·승리 4편이 전부 무음 파일이라 결과가 같았지만, 04:49에 매치 영상이 Opus
 * 트랙이 있는 v003으로 교체되면서 **소리가 있는데 영영 안 들리는** 자리가 됐다.
 * 사용자 정책(U102, 04:08) — "미디어 자료들은 소리 다 켜는 게 맞아 … 다른 꼭지들은 해당
 * 미디어의 사운드만 재생되는 게 메인". 그래서 판정 문장을 설명 영상·스팅어와 **같은 것**으로
 * 맞춘다: `asset?.audio === false`(U84 프로브 실측 + 운영자 카드 덮어쓰기)를 그대로 존중한다.
 *
 * 축은 넷이고 순서가 곧 우선순위다.
 *  1. `policyBlocked` — 자동재생 거부 폴백. 무엇보다 먼저 (풀면 브라우저가 재생을 멈춘다).
 *  2. `moodOwned` — 반전이 지금 주인이면 언제나 연다.
 *  3. `moodSource && gain > 0` — 반전이 손을 놓은 직후의 꼬리 램프.
 *  4. `assetAudio` — 그 밖의 오버레이(매치·승리)는 제 에셋 플래그를 따른다. 컷 꼬리 구간에도
 *     이 값이 참인 동안 열려 있으므로 `audioCutFadeSec` 페이드가 실제로 들린다.
 */
export function overlayMuted(input: {
  /** 지금 이 오버레이의 주인이 분위기 반전인가 (`moodOwnsOverlay`) */
  moodOwned: boolean;
  /** 자동재생 정책에 막혀 무음으로 강등됐는가 */
  policyBlocked: boolean;
  /** 엘리먼트에 물려 있는 소스가 반전이 튼 것인가 (주인이 손을 놓아도 남는 사실) */
  moodSource: boolean;
  /** 물려 있는 오버레이 에셋이 소리를 내야 하는가 (`asset?.audio !== false`) */
  assetAudio: boolean;
  gain: number;
}): boolean {
  if (input.policyBlocked) return true;
  if (input.moodOwned) return false;
  if (input.moodSource && input.gain > 0) return false;
  return !input.assetAudio;
}

/**
 * 매 프레임 기본 게인 복원. **두 경우에는 손대지 않는다.**
 *
 *  1. 화면 밖으로 치운 동안 — 없으면 페이드가 끝난 바로 다음 프레임이 소리를 도로 켠다.
 *  2. **램프가 도는 동안** — 없으면 램프를 그 자리에서 지우고 목표값으로 점프한다.
 *     실측: 페이드 도중 중계로 돌아오면 volume 0.344에서 1로 튀었다. `attachSlots`가 건
 *     램프 인을 바로 다음 paint가 덮어 버린 것이다. 진행 중인 램프의 주인은 그 램프다.
 */
export function policyGain(track: GainTrack, parked: boolean, target: number): GainTrack {
  if (parked || track.ramp !== null) return track;
  return setGain(track, target);
}

/**
 * 운영자 암전의 **오디오 축** (U95).
 *
 * 사용자 지시(01:02) — "화면 암전 버튼 누를 시 사운드도 페이드아웃 되게 해줘." U65의 암전은
 * 화면만 덮었다. 무대에서 화면을 껐는데 영상 소리와 BGM이 그대로 나가면 "끈 것"으로 읽히지
 * 않는다.
 *
 * ## 왜 별도 축인가 — 덕킹(U44)과 같은 형태다
 * 트랙 게인(`GainTrack`)을 건드리지 않고 `tickAudioGains`가 **곱으로 합성**한다. 트랙 게인을
 * 내리면 암전이 걸린 동안 진행 중이던 꼬리 페이드·크로스페이드가 이 값과 다투고, 암전을 풀 때
 * 두 축이 이중으로 걸려 소리가 절반만 돌아온다. 마스터 볼륨·덕킹과 정확히 같은 이유다.
 *
 * ## 왜 `muted`가 아닌가
 * `.muted`는 U88의 **창 단위 운영자 음소거** 축이다. 암전으로 그 값을 건드리면 암전을 풀 때
 * 운영자가 눌러 둔 음소거까지 함께 풀린다. 축은 섞지 않는다.
 *
 * ## 곡선을 새로 쓰지 않는다 — 화면과 **같은 서술자**에서 나온다
 * `blackoutOpacity`를 그대로 통과시키고 `1 −`만 취한다(`easeInOutQuad` 하나). 그래서
 *  - 그림이 절반 어두워진 순간 소리도 정확히 절반이고,
 *  - 램프 도중 뒤집어도 시작값(`fromOpacity`)이 **지금 보이는 값**이라 소리가 튀지 않으며,
 *  - 거리 비례 지속시간(`blackoutDurationMs`)이 그대로 따라와 몇 번을 뒤집어도 속도가 같다.
 * 값을 따로 계산하는 순간 같은 화면에서 그림과 소리가 다른 속도로 움직인다.
 */
export function blackoutAudioGain(
  elapsedMs: number,
  durationMs: number,
  from: number,
  to: number,
): number {
  return 1 - blackoutOpacity(elapsedMs, durationMs, from, to);
}

/** 상태의 암전 서술자만으로 지금 곱할 오디오 축 값을 구한다 (0 = 완전 무음, 1 = 그대로). */
export function blackoutAudioAxis(
  blackout: { active: boolean; startedAt: number; fromOpacity: number },
  blackoutSec: number,
  now: number,
): number {
  const to = blackoutTarget(blackout.active);
  return blackoutAudioGain(
    now - blackout.startedAt,
    blackoutDurationMs(blackoutSec, blackout.fromOpacity, to),
    blackout.fromOpacity,
    to,
  );
}

/**
 * 이 축이 아직 움직이는가 — 50ms 오디오 루프를 깨워 둘지 판정한다.
 *
 * 400ms 페인트 주기에 얹으면 5초 페이드가 12단 계단으로 들린다(음악 램프와 같은 이유).
 * 엡실론을 두는 이유: 램프 끝값은 `from + (to - from)`이라 부동소수 잔차가 남을 수 있고
 * (`0.3 + 0.7 = 0.9999999999999999`), 정확히 같아질 때까지 기다리면 루프가 영영 안 멎는다.
 * 1e-4는 16bit 출력에서 들리지 않는 크기다.
 */
export function blackoutAudioMoving(value: number, active: boolean): boolean {
  return Math.abs(value - (1 - blackoutTarget(active))) > 1e-4;
}
