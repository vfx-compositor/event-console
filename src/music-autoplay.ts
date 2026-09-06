/**
 * 음악 자동 이어재생 (U49).
 *
 * ## 왜 필요한가
 * 행사 BGM은 "깔아 두는" 소리다. 곡이 끝나면 정적이 흐르고, 운영자는 그때 점수 입력이나 큐
 * 진행 중이라 몇 초 뒤에야 알아챈다. 대기 시간이 긴 구간(개회 전·쉬는시간)에서 특히 티가 난다.
 *
 * ## 모드 넷
 *  - `off` — 끝나면 멈춘다. 지금까지의 동작이고 기본값이다(운영자가 켜지 않은 자동 재생이
 *    본방에 소리를 내는 것보다, 안 나는 편이 낫다).
 *  - `one` — 같은 곡을 다시. 한 곡으로 구간을 채울 때.
 *  - `section` — 같은 섹션 안에서 다음 곡, 끝나면 그 섹션 처음으로. 섹션이 곧 행사 구간이라
 *    이게 현장에서 제일 자주 쓰인다.
 *  - `all` — 전체 목록 다음 곡, 끝나면 처음으로.
 *
 * 감기(wrap)를 넣은 이유: 안 넣으면 마지막 곡에서 조용히 멈춰 `off`와 구별되지 않고,
 * 운영자는 자동 재생이 고장 난 줄로 읽는다.
 */

import { MUSIC_TRACKS, type MusicTrack } from './music';
// 타입만 가져온다 — 런타임 import가 아니라 순환이 생기지 않는다 (state.ts가 이 파일을 쓴다)
import type { Action } from './state';

export type MusicRepeatMode = 'off' | 'one' | 'section' | 'all';

/** 설정·칩에 그리는 고정 순서 */
export const MUSIC_REPEAT_MODES: readonly MusicRepeatMode[] = ['off', 'one', 'section', 'all'];

export const MUSIC_REPEAT_LABEL: Record<MusicRepeatMode, string> = {
  off: '없음',
  one: '한 곡',
  section: '구간',
  all: '전체',
};

/** 미니 플레이어 칩에 쓰는 짧은 기호 — 상단 바에 글자를 늘리지 않는다 */
export const MUSIC_REPEAT_MARK: Record<MusicRepeatMode, string> = {
  off: '→|',
  one: '↻1',
  section: '↻⌗',
  all: '↻∞',
};

export const MUSIC_REPEAT_TIP: Record<MusicRepeatMode, string> = {
  off: '곡이 끝나면 멈춥니다.',
  one: '곡이 끝나면 같은 곡을 처음부터 다시 재생합니다.',
  section: '곡이 끝나면 같은 구간(섹션)의 다음 곡으로 넘어가고, 구간 끝에서는 그 구간의 첫 곡으로 돌아옵니다.',
  all: '곡이 끝나면 전체 목록의 다음 곡으로 넘어가고, 목록 끝에서는 첫 곡으로 돌아옵니다.',
};

export function isMusicRepeatMode(value: unknown): value is MusicRepeatMode {
  return MUSIC_REPEAT_MODES.includes(value as MusicRepeatMode);
}

/**
 * 이 곡이 끝난 뒤 이어서 틀 곡. `null`이면 이어재생하지 않는다.
 *
 * 목록을 인자로 받는 이유는 테스트가 catalog 전체에 의존하지 않기 위해서다 —
 * 실제 호출은 `MUSIC_TRACKS`를 그대로 넘긴다.
 */
export function nextTrackId(
  mode: MusicRepeatMode,
  currentId: string | null,
  tracks: readonly MusicTrack[] = MUSIC_TRACKS,
): string | null {
  if (mode === 'off' || !currentId) return null;
  const index = tracks.findIndex((t) => t.id === currentId);
  if (index < 0) return null;
  if (mode === 'one') return currentId;

  // `section`은 같은 섹션만 추린 뒤 그 안에서 감는다. 목록 전체에서 다음을 찾고
  // 섹션이 다르면 멈추는 식으로 두면, 섹션이 목록에서 흩어져 있을 때 조용히 끊긴다.
  const pool =
    mode === 'section' ? tracks.filter((t) => t.section === tracks[index].section) : tracks;
  const at = pool.findIndex((t) => t.id === currentId);
  if (at < 0) return null;
  // 곡이 하나뿐인 구간에서도 멈추지 않는다 — 그러면 `off`와 구별되지 않는다
  return pool[(at + 1) % pool.length].id;
}

/**
 * 손으로 넘기는 앞/뒤 곡 (U49 미니 플레이어 ⏮ ⏭).
 *
 * **이어재생 모드와 무관하게 전체 목록** 기준이다. 손 조작까지 구간에 가두면 다른 구간의
 * 곡으로 갈 방법이 상단 바에서 사라진다(모드는 "끝났을 때 무엇을 할까"의 규칙이지
 * "어디로 갈 수 있는가"의 규칙이 아니다). 양 끝에서 감긴다.
 */
export function stepTrackId(
  currentId: string | null,
  delta: 1 | -1,
  tracks: readonly MusicTrack[] = MUSIC_TRACKS,
): string | null {
  if (!currentId || tracks.length === 0) return null;
  const at = tracks.findIndex((t) => t.id === currentId);
  if (at < 0) return null;
  return tracks[(at + delta + tracks.length) % tracks.length].id;
}

/**
 * 곡이 끝난 **뒤에** 이어서 낼 액션들 (U49 × U44).
 *
 * ## 왜 한 배열인가 — 리뷰가 잡은 실사고
 * full 영상이 화면을 쥔 동안 곡이 끝나면, 자동 이어재생의 `music/play`가 리듀서에서
 * `ducked: false`를 쓴다. 그 자체는 **맞는** 동작이다 — 사람이 손으로 고른 곡 교체까지 덕킹에
 * 갇히면 "왜 안 들리지"가 된다. 문제는 복귀 훅이 `fullVideoOwnsOutput`의 참→거짓 **전이**에서만
 * 돌아, 자동으로 걸린 이 재생에는 다시 내려 줄 주인이 없다는 것이었다. 다음 곡이 영상 소리 위에
 * 100%로 겹쳐 나갔다.
 *
 * 그래서 리듀서가 아니라 **여기서** `music/duck`을 이어 붙인다. 한 배열로 돌려주는 것이 핵심이다 —
 * `dispatch`는 배열을 한 번에 리듀스하고 방송을 **한 번만** 낸다. 두 번 나눠 내면 그 사이의
 * `ducked: false` 상태가 출력 창에 방송되어 한 프레임이 100%로 울린다.
 *
 * `music/ended`는 여기 넣지 않는다 — 그것은 **따로** 방송돼야 한다. 한 곡 반복(`one`)에서
 * display의 `musicPlaybackCommand`가 `playing` 변화를 못 보면 같은 곡이 다시 재생되지 않는다.
 */
export function musicAdvanceActions(input: {
  endedTrackId: string;
  mode: MusicRepeatMode;
  now: number;
  /** full 영상이 지금 화면을 쥐고 있는가 (`fullVideoOwnsOutput`, U117) */
  fullVideoOwns: boolean;
  autoDuck: boolean;
  tracks?: readonly MusicTrack[];
}): Action[] {
  const next = nextTrackId(input.mode, input.endedTrackId, input.tracks ?? MUSIC_TRACKS);
  if (!next) return [];
  const play: Action = { type: 'music/play', trackId: next, now: input.now };
  if (!input.fullVideoOwns || !input.autoDuck) return [play];
  // 순서가 중요하다 — `music/play`가 먼저여야 그 `ducked:false`를 이 덕킹이 덮는다
  return [play, { type: 'music/duck' }];
}
