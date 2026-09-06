import { classifyPlayRejection } from './audio-lock';
import type { MusicState } from './types';

export interface MusicPlaybackCommand {
  trackId: string | null;
  load: boolean;
  seekTo: number | null;
  play: boolean;
  pause: boolean;
  /** U122 — 이번 재생의 인커밍 크로스페이드 여부. `state.music.fadeIn`을 그대로 실어 나른다. */
  fadeIn: boolean;
}

export function musicEndedTrackId(
  elementEnded: boolean,
  boundTrackId: string | null,
  stateTrackId: string | null,
): string | null {
  return elementEnded && boundTrackId !== null && boundTrackId === stateTrackId ? boundTrackId : null;
}

export type MusicPlayRejection = 'ignore' | 'autoplay-lock' | 'playback-error';

/**
 * 음악은 여기에 **토큰 검사**가 하나 더 붙는다 — 이미 다른 곡으로 넘어간 뒤 도착한 거부는
 * 그 곡의 사정이지 지금 곡의 사정이 아니다. 거부 이름 자체의 해석은 `classifyPlayRejection`
 * 하나로 모은다 (U48 후속). 음악만 `AbortError`를 걸러 내고 영상·카메라는 잠금으로 세던
 * 불일치가 거짓 잠금 배너의 원인이었다.
 */
export function classifyMusicPlayRejection(
  error: unknown,
  attemptToken: number,
  currentToken: number,
): MusicPlayRejection {
  if (attemptToken !== currentToken) return 'ignore';
  const outcome = classifyPlayRejection(error);
  return outcome === 'error' ? 'playback-error' : outcome;
}

/**
 * 상태 방송은 unrelated action에도 반복되므로, display media element에 필요한 차이만 명령한다.
 * 특히 같은 commandToken은 currentTime을 되감지 않는다.
 */
export function musicPlaybackCommand(
  previous: MusicState,
  next: MusicState,
): MusicPlaybackCommand | null {
  const trackChanged = previous.trackId !== next.trackId;
  const commandChanged = previous.commandToken !== next.commandToken;
  const playChanged = previous.playing !== next.playing;
  if (!trackChanged && !commandChanged && !playChanged) return null;

  const load = trackChanged && next.trackId !== null;
  const pause = next.trackId === null || (previous.playing && !next.playing);
  const play = next.trackId !== null && next.playing && (load || playChanged);
  return {
    trackId: next.trackId,
    load,
    seekTo: next.trackId !== null && (load || commandChanged) ? Math.max(0, next.positionSec) : null,
    play,
    pause,
    fadeIn: next.fadeIn,
  };
}

/**
 * 페이드(U18)를 붙이면 "명령을 언제 실제로 element에 적용하는가"가 달라진다.
 *
 * `pause()`와 소스 해제는 **볼륨이 0에 닿은 뒤에** 일어나야 한다 — 명령이 온 순간 멈추면
 * 페이드 아웃이 들릴 자리가 없다. 반대로 재생·seek·load는 즉시 해야 한다(소리는 0에서 시작).
 * 그 판단만 여기 순수 함수로 빼고, 램프 자체는 `fade-ramp.ts`가 계산한다.
 */
export interface MusicFadePlan {
  /** 곡 교체 크로스페이드 — 새 곡을 반대편 덱에 올리고 옛 덱은 페이드 아웃시킨다 */
  swapDeck: boolean;
  /** 현재(= 나가는) 덱을 0까지 내린 뒤 할 일 ('release' = 소스까지 해제) */
  outgoing: 'none' | 'pause' | 'release';
  /**
   * 새로 소리를 낼 덱을 올릴 것인가.
   * `fade-in` = `musicFadeSec` 크로스페이드(U18 기본). `cut-in` = 램프 없이 즉시 목표 게인
   * (U122 — `command.fadeIn === false`, 파일 자체에 페이드가 bake된 곡용).
   * **`outgoing`의 페이드아웃은 이 값과 무관하게 그대로 걸린다** — 다른 곡이 울리고 있었다면
   * 그 곡은 여전히 `musicFadeSec`에 걸쳐 내려가고, 새 곡만 그 위에 즉시 올라온다.
   */
  incoming: 'none' | 'fade-in' | 'cut-in';
}

function incomingKind(command: MusicPlaybackCommand): 'fade-in' | 'cut-in' {
  return command.fadeIn ? 'fade-in' : 'cut-in';
}

/**
 * @param sounding 현재 덱이 실제로 소리를 낼 수 있는 상태인가(트랙이 물려 있고 볼륨이 남아 있음).
 *   아니라면 곡 교체도 크로스할 대상이 없으므로 같은 덱에 그대로 싣는다.
 */
export function musicFadePlan(command: MusicPlaybackCommand, sounding: boolean): MusicFadePlan {
  // 정지 — 트랙 해제는 페이드 아웃이 끝난 뒤에만
  if (command.trackId === null) {
    return { swapDeck: false, outgoing: 'release', incoming: 'none' };
  }
  if (command.load) {
    // 곡 교체: 울리고 있던 덱이 있으면 크로스, 없으면 같은 덱에서 페이드 인만
    return {
      swapDeck: sounding,
      outgoing: sounding ? 'release' : 'none',
      incoming: command.play ? incomingKind(command) : 'none',
    };
  }
  if (command.play) return { swapDeck: false, outgoing: 'none', incoming: incomingKind(command) };
  if (command.pause) return { swapDeck: false, outgoing: 'pause', incoming: 'none' };
  return { swapDeck: false, outgoing: 'none', incoming: 'none' };
}
