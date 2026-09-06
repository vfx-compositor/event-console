/**
 * 영상이 **데려오는 배경 곡** (U124).
 *
 * ## 무엇을 고치는가
 * 컬링(`intro_curling.mp4`)·신문지 달리기(`intro_newspaper_race.mp4`) 소개 영상은 원본 파일에
 * 오디오 트랙이 아예 없다(ffprobe: video+data만, U117·U123 실측). 그래서 이 두 영상이 나가는
 * 동안 방송은 통째로 무음이었다 — U117이 덕킹을 모드 기준으로 옮기면서 BGM이 정확히 내려갔고,
 * 그 자리를 채울 소리가 파일 안에 없었기 때문이다.
 *
 * 무음 영상에 사용자가 지정한 배경 음악을 연결할 수 있다.
 * 기본 배포에는 음원이나 영상별 음악 매핑을 포함하지 않는다.
 *
 * ## 왜 상수표 + 운영자 지정 두 층인가
 * 어느 영상에 어느 곡인지는 **대본이 정한 연출**이다. manifest 필드로 두면 이미 등록된
 * 프로필에는 영영 닿지 않는다(`syncMediaManifest`가 저장본을 manifest보다 우선한다 — U87
 * `scripted-outro.ts`가 상수표를 택한 것과 같은 이유). 그래서 파일 이름을 키로 여기 못 박고,
 * 저장본에 값이 없는 에셋만 **한 번** 승격한다(`musicTrackUpgrades`, U50 `holdEndFrameUpgrades`
 * 와 같은 형태). 승격 결과가 문자열이라 다음 부팅부터는 후보에서 빠진다 — 별도 플래그가 없다.
 *
 * 운영자가 [영상·에셋] 카드에서 고른 값은 **언제나 이긴다.** `null`("없음")도 사람이 고른
 * 값이므로 표가 도로 덮지 않는다 — `undefined`(한 번도 정한 적 없음)와 `null`(비우기로
 * 정함)을 구분하는 것이 이 필드의 계약이다.
 *
 * ## full 모드만이다
 * 겹치는 레이어(`transition` 스팅어 · `overlay` 매치·승리)는 아래 소리 **위에** 얹히는 것이
 * 정본이고(U102 · U113), 그 자리에서 곡을 새로 걸면 깔려 있던 BGM과 정면으로 부딪힌다.
 * 화면을 통째로 갈아 끼우는 `full`만이 "지금부터 이 곡이 이 장면의 음악"이라고 말할 수 있다.
 */

import { musicTrack } from './music';
import { mediaFileFromId } from './media-manifest';
import type { AssetMeta, VideoPlayMode } from './types';

/**
 * 대본이 정한 **파일 이름 → 배경 곡 id** (U124).
 *
 * 두 편뿐인 이유는 무음 파일이 이 둘뿐이기 때문이다. 소리가 있는 소개 영상(끈끈이 낚시·
 * 몸으로 말해요)은 제 소리가 메인이라 곡을 데려오지 않는다 — 지정하면 겹쳐서 나간다.
 */
export const INTRO_MUSIC_DEFAULTS: Readonly<Record<string, string>> = {};

/** manifest 파일 이름으로 찾는 기본 곡 (`scripted-outro.ts`와 같은 조회 관례) */
export function introMusicDefaultForFile(file: string | null | undefined): string | null {
  if (!file) return null;
  return INTRO_MUSIC_DEFAULTS[file] ?? null;
}

/** 에셋 id(`media:<file>`)로 찾는 기본 곡 */
export function introMusicDefaultForAsset(assetId: string | null | undefined): string | null {
  if (!assetId) return null;
  return introMusicDefaultForFile(mediaFileFromId(assetId));
}

/**
 * 이 에셋이 재생과 함께 데려오는 곡 id — **없으면 `null`** (U124).
 *
 * 라이브러리에 실재하는 곡일 때만 살린다(U110 승리 음악과 같은 규칙): 목록이 바뀌어 없는 id가
 * 남으면 `music/play` 리듀서가 조용히 무시해 영상만 무음으로 나가고, 그 자리에서는 아무도
 * 원인을 못 찾는다. 여기서 `null`로 접으면 카드 드롭다운이 "없음"으로 서서 눈에 보인다.
 */
export function assetMusicTrackId(asset: AssetMeta | undefined | null): string | null {
  if (!asset || asset.type !== 'video') return null;
  const mode: VideoPlayMode = asset.playMode ?? 'full';
  if (mode !== 'full') return null;
  // `undefined` = 한 번도 정한 적 없음 → 대본 표. `null` = 운영자가 비웠음 → 곡 없음.
  const raw = asset.musicTrackId === undefined ? introMusicDefaultForAsset(asset.id) : asset.musicTrackId;
  return raw && musicTrack(raw) ? raw : null;
}

/**
 * 이 영상이 **제 음악을 데려오는가** — 덕킹 제외 축 (U124 × U44 · U117).
 *
 * 참이면 `needsMusicDuck`·`fullVideoOwnsOutput`이 이 영상을 잡지 않는다. 내렸다가 곧바로
 * 새 곡을 올리는 왕복은 방송에 두 번 들린다: `musicDuckSec`(기본 2초)만큼 큐가 늦게 나가
 * 영상 도입이 밀리고, 그 2초 동안 화면도 소리도 비어 있다. 영상이 곡을 데려오는 자리에서는
 * 앞 곡을 내릴 주체가 `music/play`의 크로스페이드 하나면 충분하다.
 */
export function assetBringsOwnMusic(asset: AssetMeta | undefined | null): boolean {
  return assetMusicTrackId(asset) !== null;
}

/** 승격 대상 한 줄 — `{ id, musicTrackId }`를 그대로 `patchAsset`에 넘긴다 */
export interface MusicTrackUpgrade {
  id: string;
  musicTrackId: string;
}

/**
 * 대본 표 값으로 **한 번 올려야 하는** 에셋 (U124).
 *
 * 대상은 `musicTrackId`가 저장본에 **아예 없는**(`undefined`) 영상뿐이다. 운영자가 카드에서
 * 비운 값(`null`)은 저자가 있는 값이라 건드리지 않는다 — 여기서 덮으면 "껐는데 매 부팅마다
 * 다시 켜진다"가 된다(U110 승리 음악 승격이 `victoryMusicPromoted` 플래그를 둔 것과 같은 걱정).
 */
export function musicTrackUpgrades(
  rows: readonly { id: string; type: string; musicTrackId?: string | null }[],
): MusicTrackUpgrade[] {
  const out: MusicTrackUpgrade[] = [];
  for (const row of rows) {
    if (row.type !== 'video' || row.musicTrackId !== undefined) continue;
    const musicTrackId = introMusicDefaultForAsset(row.id);
    if (musicTrackId) out.push({ id: row.id, musicTrackId });
  }
  return out;
}
