/**
 * full 영상 큐 진입 시 행사 BGM 자동 덕킹 (U44 · U117).
 *
 * ## 무엇을 고치는가
 * 큐를 눌러 설명 영상으로 넘어가면 BGM과 영상 소리가 **그대로 겹쳐** 나갔다. 운영자는 영상
 * 큐를 누르기 전에 음악 탭으로 가서 손으로 멈춰야 했고, 그 두 조작 사이가 방송에 그대로 나간다.
 *
 * 고친 방식: 음악을 `musicDuckSec`(기본 2초) 동안 내리고 **그동안 큐를 잡아 둔다**. 음악이
 * 다 내려간 뒤에 큐 액션이 나가므로, 화면이 넘어가는 순간에는 이미 조용하다. 영상이 끝나
 * 화면을 놓으면 **지연 없이** 같은 길이로 되돌린다 — 돌아올 때까지 기다릴 이유는 없다.
 *
 * ## 왜 pause가 아니라 게인인가
 * `music/pause`는 명령 토큰을 올려 display가 되감기·재로드를 하고, 페이드가 끝난 뒤 실제
 * `pause()`까지 간다. 영상 하나 트는 동안 그 왕복을 돌면 돌아올 때 곡이 처음부터 시작하거나
 * 위치가 어긋난다. 덕킹은 **소리만** 내리는 별도 축이라 곡·위치·재생 여부를 건드리지 않는다.
 *
 * ## 덕킹 대상 판정 근거 — 신호는 **재생 모드**다 (U117)
 * 판정 신호는 `asset.playMode`이고, `full`이면 덕킹한다. **파일에 오디오 트랙이 있는지는 보지
 * 않는다.**
 *
 * U116까지는 `asset.audio`(U84 실측 플래그)를 함께 봤다. 그래서 오디오 트랙이 아예 없는
 * 설명 영상에서는 덕킹이 걸리지 않았다 — 2026-09-05 07:0x 사용자 신고(U117) "게임 소개 영상이
 * 나올 땐 음악이 내려가야지"가 정확히 그 자리다. `intro_curling.mp4`·`intro_newspaper_race.mp4`는
 * 오디오 스트림이 없는 파일이라(ffprobe: video+data만) 컬링·신문지 달리기 소개 영상 위로 BGM이
 * 100%로 계속 흘렀고, 소리가 있는 끈끈이 낚시·몸으로 말해요만 정상 덕킹됐다.
 *
 * 판정을 모드로 옮긴 근거: `full`은 **화면을 통째로 갈아 끼우는** 자리다. 앞 장면을 받쳐 주던
 * BGM은 그 순간부터 남의 장면 음악이 된다 — 설명이 파일 안의 내레이션으로 나오든 MC의 마이크로
 * 나오든 마찬가지다. 소리 없는 설명 영상일수록 BGM이 MC 목소리와 정면으로 부딪힌다.
 * `asset.audio` 축은 없어지지 않는다: 오디오 잠금 경고(U48, `videoAudioOwnsOutput`)와 오버레이
 * 음소거(U101, `overlayPlaysAudio`)는 여전히 "실제로 소리가 나가는가"를 물으므로 그 자리에 남는다.
 *
 * 겹치는 레이어는 그대로 제외된다 — 아래 두 갈래가 U117 이후에도 변하지 않는 이유다:
 *  - `transition`(스팅어)은 U102부터 **소리를 낸다.** 그러나 덕킹 대상이 아니다 — 효과음
 *    레이어라 깔린 소리 **위에 겹쳐서** 나는 것이 사용자 결정이다(2026-09-05 04:08).
 *    울릴 때마다 BGM이 내려갔다 올라오면 겹치기가 성립하지 않는다.
 *  - `overlay`(매치·승리·반전)도 **덕킹 대상이 아니다** — U113(2026-09-05 06:21 사용자 지시)
 *    "매치 영상은 배경음악과 미디어 사운드가 함께 나오길 바라." U101b가 소리 있는 오버레이를
 *    이 자리에 넣었던 것을 되돌린다. 오버레이는 스팅어와 같은 **겹치는 레이어**다: 아래 화면을
 *    갈아 끼우지 않고 그 위에 얹히므로, BGM이 계속 흐르는 편이 사용자가 원하는 소리 그림이다.
 *    덕킹이 걸리면 큐가 `musicDuckSec`만큼 늦게 나가 매치 영상 도입도 그만큼 밀린다.
 *    오버레이 **소리 자체**는 그대로다 — `overlayPlaysAudio`/`overlayMuted`(U101) 축은 살아 있고,
 *    여기서 빠지는 것은 "BGM을 내릴 것인가"뿐이다.
 * 그래서 덕킹이 붙는 영상 = **full 모드** — 로 판정한다 (U117).
 *
 * ## 예외 하나 — 제 곡을 데려오는 영상 (U124)
 * `full`이라도 그 에셋에 배경 곡이 지정돼 있으면(`assetBringsOwnMusic`) 덕킹하지 않는다.
 * 컬링·신문지 소개 영상이 그 자리다: 파일에 오디오가 없어 U120·U121에서 팝송을 빌려 왔고,
 * 영상이 나가는 순간 그 곡이 `music/play`로 함께 실린다(`cue.ts`의 `fullVideoOutputActions`).
 * 여기서 덕킹까지 걸면 **내렸다가 곧바로 새 곡을 올리는 왕복**이 된다 — `musicDuckSec`(기본
 * 2초)만큼 큐가 늦게 나가 영상 도입이 밀리고, 그 2초 동안 화면도 소리도 비어 있다.
 * 앞 곡을 정리하는 일은 `music/play`의 크로스페이드가 이미 한다.
 *
 * 진입(`cueOwnsScreen`)과 복귀(`fullVideoOwnsOutput`)가 **둘 다** 이 예외를 본다 — 이 파일의
 * 대칭 규칙 그대로다. 한쪽만 빼면 복귀 훅이 남의 덕킹을 대신 풀거나(음악이 예상보다 일찍
 * 올라온다) 되올릴 주인이 사라진다.
 */

import { assetBringsOwnMusic } from './asset-music';
import type { AppState, AssetMeta, P1EventId, VideoPlayMode } from './types';

/** 음악을 내리는 데 쓰는 기본 시간(초). 이 시간만큼 큐가 늦게 나간다. */
export const DEFAULT_MUSIC_DUCK_SEC = 2;

/** 0이면 지연 없이 그 자리에서 큐가 나간다(덕킹은 여전히 컷으로 걸린다). */
export const MUSIC_DUCK_SEC_RANGE = { min: 0, max: 10 } as const;

/** 판정에 필요한 최소한만 받는다 — 큐 항목 전체를 요구하면 테스트가 무거워진다. */
export interface DuckCueLike {
  assetId?: string;
  assetPlayMode?: VideoPlayMode;
  matchEventId?: P1EventId;
}

/** 이 에셋 자체가 소리를 내는가 — 재생 모드와 무관한 파일·운영자 판정 (U84). */
function hasAudioTrack(asset: AssetMeta | undefined | null): boolean {
  return !!asset && asset.audio !== false;
}

/**
 * 이 에셋이 화면을 **통째로 갈아 끼우는** full 영상인가 (U117) — 덕킹 축의 유일한 신호다.
 *
 * 오디오 트랙 유무를 묻지 않는 이유는 이 파일 머리말 "덕킹 대상 판정 근거" 참고.
 * 등록되지 않은 에셋(`undefined`)은 거짓이다 — 무엇이 나갈지 모르는데 음악을 내리면,
 * 결국 아무 영상도 안 나가는 자리에서 BGM만 사라진다.
 */
export function assetOwnsScreen(asset: AssetMeta | undefined | null): boolean {
  if (!asset) return false;
  const mode: VideoPlayMode = asset.playMode ?? 'full';
  return mode === 'full';
}

/**
 * 이 에셋이 **덕킹 대상인가** — 진입·복귀 두 축이 함께 쓰는 단 하나의 문장 (U117 · U124).
 *
 * `assetOwnsScreen`(화면을 갈아 끼우는가)에서 곡을 데려오는 영상만 빼낸다. 두 문장을 갈라 둔
 * 이유: `assetOwnsScreen`은 오디오 잠금 경고 축(`assetPlaysAudio`, U48)도 읽는 값이라, 거기에
 * 곡 지정을 섞으면 "곡이 걸려 있으니 무음 사고가 아니다"라는 엉뚱한 추론이 그 배너에 들어간다.
 */
export function assetNeedsMusicDuck(asset: AssetMeta | undefined | null): boolean {
  return assetOwnsScreen(asset) && !assetBringsOwnMusic(asset);
}

/**
 * 이 에셋이 실제로 소리를 내며 재생되는가 — **오디오 잠금 경고(U48) 축**이다.
 *
 * U117에서 덕킹은 이 판정을 떠났다(`assetOwnsScreen`). 여기 남은 독자는 "지금 나가야 할
 * 소리가 나가지 않고 있다"를 말하는 자리뿐이라, 파일에 트랙이 없으면 거짓이어야 한다 —
 * 소리 없는 영상에서 빨강 배너를 띄우면 정작 진짜 무음 사고에서 아무도 안 본다.
 */
export function assetPlaysAudio(asset: AssetMeta | undefined | null): boolean {
  if (!assetOwnsScreen(asset)) return false;
  return hasAudioTrack(asset);
}

/**
 * 오버레이 슬롯(`#overlay-video`)에 실리는 에셋이 소리를 내는가 (U101).
 *
 * **덕킹과 무관하다** (U113) — 이 문장의 독자는 `display.ts`의 `applyOverlayMute()`뿐이고,
 * "오버레이를 음소거할 것인가"만 답한다. `assetPlaysAudio`와 갈라 두는 이유는 슬롯마다
 * 문장을 따로 둬야 모드가 잘못 등록된 에셋이 다른 슬롯 판정을 조용히 통과하지 않기 때문이다.
 */
export function overlayPlaysAudio(asset: AssetMeta | undefined | null): boolean {
  if (!asset) return false;
  if ((asset.playMode ?? 'full') !== 'overlay') return false;
  return hasAudioTrack(asset);
}

/**
 * 이 큐 항목이 화면을 갈아 끼우는 full 영상으로 진입하는가 (U117).
 *
 * 모드를 **두 번** 본다 — 큐 항목의 `assetPlayMode`와 에셋 자신의 `playMode`. 둘 다 봐야
 * 모드가 잘못 등록된 에셋이 큐 쪽 선언만으로 조용히 통과하지 않는다.
 */
export function cueOwnsScreen(item: DuckCueLike, assets: ReadonlyArray<AssetMeta>): boolean {
  // 매치·승리 큐는 실행 시점에 오버레이 파일이 정해지지만, 오버레이는 덕킹 대상이 아니므로
  // (U113) 그 해석을 여기서 할 이유가 없다 — 어느 파일이 나가든 답은 거짓이다.
  if (!item.assetId) return false;
  if (item.matchEventId) return false;
  if ((item.assetPlayMode ?? 'full') !== 'full') return false;
  // 제 곡을 데려오는 영상은 여기서 빠진다 (U124) — 근거는 이 파일 머리말 "예외 하나".
  return assetNeedsMusicDuck(assets.find((a) => a.id === item.assetId));
}

/** 지금 이 큐를 실행하기 **전에** 음악을 내려야 하는가 */
export function needsMusicDuck(input: {
  item: DuckCueLike;
  assets: ReadonlyArray<AssetMeta>;
  /** 음악이 실제로 울리고 있는가 */
  musicPlaying: boolean;
  /** 이미 내려가 있는가 — 연속 영상 큐에서 두 번 기다리게 하지 않는다 */
  ducked: boolean;
  autoDuck: boolean;
}): boolean {
  if (!input.autoDuck) return false;
  if (!input.musicPlaying || input.ducked) return false;
  return cueOwnsScreen(input.item, input.assets);
}

/** 음악이 내려가는 동안 붙잡아 둔 큐 */
export interface DuckedCue {
  cueIndex: number;
  startedAt: number;
  runAt: number;
}

export function scheduleDuckedCue(cueIndex: number, now: number, duckSec: number): DuckedCue {
  const sec = Number.isFinite(duckSec) ? Math.max(0, duckSec) : 0;
  return { cueIndex, startedAt: now, runAt: now + sec * 1000 };
}

export function duckedCueDue(pending: DuckedCue, now: number): boolean {
  return now >= pending.runAt;
}

/**
 * 칩에 띄울 남은 초. **올림**이라 0.1초 남았을 때 `0`이 뜨지 않는다 —
 * 카운트다운이 0에서 한참 머무르면 멈춘 줄 안다.
 */
export function duckedCueRemainingSec(pending: DuckedCue, now: number): number {
  return Math.max(0, Math.ceil((pending.runAt - now) / 1000));
}

/**
 * full 영상이 **지금 화면을 쥐고 있는가** — 덕킹 복귀 축 (U44 · U117).
 *
 * 이 값이 참에서 거짓으로 떨어지는 순간이 복귀 지점이다 — 정상 종료·[⏭ 스킵]·워치독·씬 컷이
 * 전부 같은 자리로 모인다. 경로마다 unduck을 심으면 반드시 한 군데를 빠뜨리고 음악이 무음으로
 * 남는다. **진입(`cueOwnsScreen`)과 같은 신호를 써야 한다** — 한쪽만 오디오 트랙을 보면
 * 소리 없는 영상에서 내려간 음악을 되올릴 주인이 사라져 영영 무음이 된다(U117 도입 시 이
 * 대칭을 깨는 것이 가장 큰 위험이었다).
 *
 * **설명 영상(`sceneOpts.video`) 하나만 본다** (U113). U101b가 여기에 오버레이 갈래를 더했던
 * 것을 되돌렸다 — 오버레이는 덕킹에 걸지 않으므로 복귀도 걸 것이 없고, 오버레이가 화면을
 * 쥔 동안 이 값이 참으로 남으면 앞선 full 영상의 복귀가 그만큼 늦어진다.
 */
export function fullVideoOwnsOutput(state: AppState): boolean {
  const video = state.sceneOpts.video;
  if (video.phase === 'idle' || video.assetId === null) return false;
  // 진입과 **같은 문장**을 쓴다 (U124 포함) — 곡을 데려온 영상은 애초에 덕킹을 만든 적이 없어
  // 복귀에서도 거짓이어야 한다. 참으로 남기면 이 영상이 끝날 때 남의 덕킹을 대신 풀어 준다.
  return assetNeedsMusicDuck(state.assets.find((a) => a.id === video.assetId));
}

/**
 * **소리 있는** 영상이 지금 화면을 쥐고 있는가 — 오디오 잠금 경고 축 (U48).
 *
 * `fullVideoOwnsOutput`과 갈라 둔 이유(U117): 이 값은 "지금 나가야 할 소리가 잠겨 있다"를
 * `critical`로 올리는 신호다. 오디오 트랙이 없는 설명 영상까지 참이 되면, 잠기든 말든 원래
 * 소리가 없는 자리에서 빨강 배너가 뜬다 — 경고가 흔해지면 아무도 안 본다.
 */
export function videoAudioOwnsOutput(state: AppState): boolean {
  const video = state.sceneOpts.video;
  if (video.phase === 'idle' || video.assetId === null) return false;
  return assetPlaysAudio(state.assets.find((a) => a.id === video.assetId));
}
