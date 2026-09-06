import { tailStartSec } from './fade';

/**
 * **소리**의 꼬리 페이드를 시작할 때인가 (U93).
 *
 * ## 왜 시각 판정과 갈라 두는가
 * `holdEndFrame`은 "마지막 프레임을 화면에 붙잡아 둔다"는 **시각** 지시다. 그런데 그 값이
 * `shouldStartVideoTail`의 첫 줄에서 꼬리 자체를 막고 있었고, 꼬리가 오디오 게인까지 함께
 * 움직이는 유일한 자리라서 **소리도 같이 페이드를 잃었다.** 결과: 2부 Part 1~4처럼
 * `holdEndFrame: true`인 영상은 마지막 샘플까지 최대 볼륨으로 울리다가 파일이 끝나는 순간
 * 뚝 끊긴다(그 다음 `holding` 분기가 게인을 0으로 못 박는다). U87이 올림픽 인트로 한 편에
 * 대본 아웃트로를 붙여 우회했던 바로 그 증상이고, 나머지 전편이 같은 자리에 남아 있었다.
 *
 * 소리는 U27의 전역 계약("들리는 매체는 어떤 경로로도 곡선 없이 끊기지 않는다")을 따르므로
 * `holdEndFrame`을 보지 않는다. 화면만 마지막 프레임에 서고, 소리는 `duration − fadeSec`부터
 * 같은 `easeInOutQuad` 곡선으로 내려온다.
 */
export function shouldStartVideoAudioTail(
  ended: boolean,
  currentTime: number,
  duration: number | undefined,
  fadeSec: number,
): boolean {
  if (ended) return true;
  const tailAt = tailStartSec(duration, fadeSec);
  return tailAt !== null && currentTime >= tailAt;
}

export function shouldStartVideoTail(
  holdEndFrame: boolean,
  ended: boolean,
  currentTime: number,
  duration: number | undefined,
  fadeSec: number,
): boolean {
  if (holdEndFrame) return false;
  return shouldStartVideoAudioTail(ended, currentTime, duration, fadeSec);
}

/** `HTMLMediaElement.HAVE_METADATA` — duration/currentTime이 새 소스의 값이 된 시점 */
const HAVE_METADATA = 1;

/**
 * `<video>`가 **지금 실제로 물고 있는** 소스. `videoEl.src`에 대입한 그 순간에만 갱신되는 값을
 * 넘겨야 한다 — `ensureVideo()`가 `await assetUrl()` **앞**에서 동기로 적어 두는 예약 값
 * (`videoAssetId`)을 넘기면 게이트에 구멍이 뚫린다.
 */
export interface VideoSourceBinding {
  /** `videoEl.src`에 실제로 붙은 에셋 id */
  srcAssetId: string | null;
  /** 그 소스로 되감기(`currentTime = 0`)까지 끝낸 restartToken */
  srcRestartToken: number;
  /** `videoEl.readyState` */
  readyState: number;
}

/** 지금 재생하려는 영상 (`state.sceneOpts.video`에서 뽑는다) */
export interface VideoTailRequest {
  assetId: string | null;
  restartToken: number;
  holdEndFrame: boolean;
  fadeSec: number;
}

/** `<video>`에서 읽은 재생 위치 */
export interface VideoPlaybackSample {
  currentTime: number;
  duration: number | undefined;
  ended: boolean;
}

/**
 * 꼬리 페이드 판정을 **지금 요청된 영상이 실제로 물려 있는** `<video>`에서만 하도록 거른다 (D1).
 *
 * `paint()`는 `tickFade()` → `ensureVideo()` 순서다. 그래서 `playing` 진입 첫 틱의 엘리먼트는
 * 아직 **직전 영상**을 물고 있다. 직전 영상이 끝까지 재생돼 멈춰 있었다면
 * `currentTime === duration`이라 새 영상의 `fadeSec`으로 재도 그 자리에서 tail 조건이 성립해,
 * 시작 1초 만에 `fullvideo-tail`이 나가고 씬이 `nextScene`으로 넘어간다(2부 Part 2 통째 스킵).
 *
 * `ensureVideo()`는 blob URL 조회를 `await`하므로 "요청은 새 영상, 엘리먼트는 옛 영상"인 구간이
 * 한 프레임이 아니라 **여러 프레임** 이어질 수 있고, blob 조회가 실패하면 영영 이어진다.
 * 그래서 예약 값이 아니라 `videoEl.src` 대입 시점에 기록된 값만 받는다. 소스가 끝내 안 붙는
 * 경우는 control의 full-video 워치독이 따로 받아 낸다.
 */
export function canMeasureVideoTail(binding: VideoSourceBinding, request: VideoTailRequest): boolean {
  if (!request.assetId) return false;
  if (binding.srcAssetId !== request.assetId) return false;
  if (binding.srcRestartToken !== request.restartToken) return false;
  return binding.readyState >= HAVE_METADATA;
}

/**
 * `playing` 단계에서 꼬리 페이드로 들어가야 하는가 — display가 부르는 단일 진입점.
 * 게이트(`canMeasureVideoTail`)와 시각 판정(`shouldStartVideoTail`)을 한 곳에서 묶어,
 * 호출부가 게이트를 빠뜨릴 수 없게 한다.
 */
export function shouldEnterVideoTail(
  binding: VideoSourceBinding,
  request: VideoTailRequest,
  sample: VideoPlaybackSample,
): boolean {
  if (!canMeasureVideoTail(binding, request)) return false;
  return shouldStartVideoTail(
    request.holdEndFrame,
    sample.ended,
    sample.currentTime,
    sample.duration,
    request.fadeSec,
  );
}

/**
 * `playing` 단계에서 **소리**의 꼬리 페이드로 들어가야 하는가 (U93) — display의 단일 진입점.
 *
 * 게이트는 시각 판정과 **같은 것**을 쓴다(`canMeasureVideoTail`). 소스가 아직 옛 영상인 구간에서
 * 열리면 새 영상이 시작 1초 만에 무음이 되는, D1과 똑같은 사고가 소리 쪽에서 재현된다.
 *
 * 일반 영상(`holdEndFrame: false`)에서는 이 판정이 `shouldEnterVideoTail`과 **같은 프레임에
 * 같은 값**으로 열린다 — 그래서 display는 두 곡선을 따로 그리지 않고 한 곡선을 공유한다.
 */
export function shouldEnterVideoAudioTail(
  binding: VideoSourceBinding,
  request: VideoTailRequest,
  sample: VideoPlaybackSample,
): boolean {
  if (!canMeasureVideoTail(binding, request)) return false;
  return shouldStartVideoAudioTail(
    sample.ended,
    sample.currentTime,
    sample.duration,
    request.fadeSec,
  );
}
