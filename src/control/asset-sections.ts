/**
 * 영상·에셋 탭의 카드 분류와 카드 머리글 값 (U39) — 순수 계산만.
 *
 * 왜 분류가 필요한가: 목록이 18개를 넘어가면서 "대본이 자리를 정해 둔 영상"과 "운영자가 방금
 * 올린 영상"이 같은 줄에 섞여 보였다. 현장에서 급히 찾는 것은 늘 후자인데, 앞에 고정 영상이
 * 길게 깔려 스크롤을 내려야 한다. 성격이 다른 다섯으로 나눠 각 묶음을 접을 수 있게 한다.
 *
 * 뷰에서 분리한 이유: 분류 규칙이 뷰 안에 있으면 테스트가 DOM을 만들어야 확인된다.
 * 여기 있으면 규칙만 단독으로 고정할 수 있다.
 */

import { isScriptedCueAsset } from '../cue';
import { assetMusicTrackId } from '../asset-music';
import { musicTrack } from '../music';
import { isMatchVideoAsset } from '../match-video';
import { isWinnerVideoAsset } from '../winner-video';
import { isMediaAsset, mediaFileFromId } from '../media-manifest';
import type { AssetMeta, VideoPlayMode } from '../types';

export type AssetSectionId = 'scripted' | 'match' | 'winner' | 'ambient' | 'user';

export interface AssetSection {
  id: AssetSectionId;
  label: string;
  /** 섹션 머리글 hover 상세 — 이 묶음이 무엇인지, 왜 따로 있는지 */
  hint: string;
  assets: AssetMeta[];
}

const SECTION_META: Record<AssetSectionId, { label: string; hint: string }> = {
  scripted: {
    label: '대본 고정 영상',
    hint: '진행 대본이 큐 위치를 정해 둔 영상입니다(1부 소개 영상·올림픽 인트로·2부 파트 영상). 큐 위치 셀렉트가 잠겨 있고, 저장된 값과 무관하게 앱이 정한 자리에 들어갑니다.',
  },
  match: {
    label: '매치 영상',
    hint: '대결 조합별 알파 오버레이입니다. 큐 자리는 종목마다 하나(`매치 영상 · 종목`)이고, 재생할 파일은 그때의 대결 조합이 정합니다. 런처 대결 타일을 눌러도 재생됩니다.',
  },
  winner: {
    label: '승리 영상',
    hint: '종목 승리 팀 발표용 알파 오버레이입니다 (U100). 큐 자리는 종목마다 하나(`종목 · 승리 팀`)이고, 재생할 파일은 [1부 컨트롤] 탭에서 고른 승리 팀이 정합니다. 도입 페이드가 영상 알파에 들어 있어 씬 전환 없이 지금 화면 위로 바로 올라옵니다.',
  },
  ambient: {
    label: '대기·전환',
    hint: 'media 폴더에서 자동으로 들어온 대기 화면 영상과 씬 전환 스팅어입니다. 어느 PC·브라우저에서 열어도 같은 목록이 뜹니다.',
  },
  user: {
    label: '운영자 등록',
    hint: '이 브라우저에 직접 올린 파일입니다. IndexedDB에 있으므로 다른 PC에서는 보이지 않습니다.',
  },
};

/** 순서 — 위에서부터 "손댈 일이 적은 것"이 아니라 "성격이 굳어 있는 것" 순이다. */
export const ASSET_SECTION_ORDER: AssetSectionId[] = ['scripted', 'match', 'winner', 'ambient', 'user'];

/**
 * 이 에셋이 속하는 묶음.
 *
 * 판정 순서가 계약이다 — 대본 고정과 매치 영상은 둘 다 media 폴더 유래이므로,
 * `ambient`를 먼저 보면 전부 거기로 빨려 들어간다.
 */
export function assetSectionOf(asset: AssetMeta): AssetSectionId {
  if (isScriptedCueAsset(asset.id)) return 'scripted';
  if (isMatchVideoAsset(asset.id)) return 'match';
  if (isWinnerVideoAsset(asset.id)) return 'winner';
  if (isMediaAsset(asset.id)) return 'ambient';
  return 'user';
}

/** 비어 있지 않은 묶음만, 고정 순서로. 각 묶음 안의 순서는 넘겨받은 순서를 그대로 둔다. */
export function assetSections(assets: readonly AssetMeta[]): AssetSection[] {
  const bucket = new Map<AssetSectionId, AssetMeta[]>(
    ASSET_SECTION_ORDER.map((id) => [id, [] as AssetMeta[]]),
  );
  for (const asset of assets) bucket.get(assetSectionOf(asset))!.push(asset);
  return ASSET_SECTION_ORDER.filter((id) => bucket.get(id)!.length > 0).map((id) => ({
    id,
    label: SECTION_META[id].label,
    hint: SECTION_META[id].hint,
    assets: bucket.get(id)!,
  }));
}

export const PLAY_MODE_LABEL: Record<VideoPlayMode, string> = {
  full: '풀스크린',
  transition: '전환',
  overlay: '오버레이',
};

/** 썸네일이 없을 때 자리를 채우는 글자 — 무엇인지는 알려 준다 */
export function assetThumbFallback(asset: AssetMeta): string {
  if (asset.type !== 'video') return 'IMAGE';
  return PLAY_MODE_LABEL[asset.playMode ?? 'full'];
}

export interface AssetCardMeta {
  /** 모드 배지 (이미지면 `null`) */
  mode: VideoPlayMode | null;
  modeLabel: string;
  /** `mm:ss` 또는 `--:--` */
  duration: string;
  size: string;
  /**
   * 소리 배지 — 풀스크린 영상과 전환 스팅어에 의미가 있다 (U102).
   *
   * 매치 알파 오버레이(`overlay`)만 `null`이다. 그 슬롯의 음소거는 에셋 플래그가 아니라
   * **분위기 반전이 주인인가**(`overlayMuted()`)로 정해지므로, 카드에 칩을 띄우면
   * 누르지도 못하는 값을 읽는 셈이 된다.
   */
  audio: '소리 켬' | '무음' | null;
  /**
   * 이 영상이 재생과 함께 데려오는 **배경 곡** (U124) — 없으면 `null`.
   *
   * 카드에 `♪ 곡 이름` 칩으로 뜬다. `audio` 배지와 **다른 축**이다: 소리가 있는 영상에도
   * 곡을 걸 수 있고(그러면 겹쳐서 나간다) 무음 영상이 곡을 데려오는 것이 이 기능의 출발점이다.
   */
  music: { trackId: string; label: string } | null;
  /** media 폴더 파일 이름 (없으면 null) */
  file: string | null;
  /** manifest revision 앞 7자리 — 같은 파일명으로 다시 렌더한 것을 구분한다 */
  revision: string | null;
}

function fmtSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function fmtDuration(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '--:--';
  const total = Math.round(sec);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** 카드 배지 행에 그대로 뿌리는 값 묶음 — 뷰는 이 결과를 배열로 늘어놓기만 한다. */
export function assetCardMeta(asset: AssetMeta): AssetCardMeta {
  const isVideo = asset.type === 'video';
  const mode: VideoPlayMode | null = isVideo ? (asset.playMode ?? 'full') : null;
  // 라이브러리에 실재하는 곡일 때만 값이 선다 (`assetMusicTrackId`가 이미 걸러 준다).
  const musicTrackId = assetMusicTrackId(asset);
  const track = musicTrack(musicTrackId);
  return {
    mode,
    modeLabel: mode ? PLAY_MODE_LABEL[mode] : 'IMAGE',
    duration: isVideo ? fmtDuration(asset.durationSec) : '--:--',
    size: fmtSize(asset.size),
    // 소리가 나갈 수 있는 영상 모드 **전부**에 붙인다 (U101b) — `overlay`(매치·승리)도
    // U102 정책상 제 소리를 내므로, 배지가 없으면 운영자가 무음 여부를 화면에서 못 읽는다.
    audio: mode ? (asset.audio === false ? '무음' : '소리 켬') : null,
    music: musicTrackId && track ? { trackId: musicTrackId, label: track.label } : null,
    file: mediaFileFromId(asset.id),
    revision: asset.sourceRevision ? asset.sourceRevision.slice(0, 7) : null,
  };
}

/**
 * 카드 방향키 이동 — 그리드라 좌우는 wrap, 상하는 열 수만큼 이동(끝에서 멈춤).
 * 대결 타일(`nextVersusFocus`)과 같은 규칙이고, 처리하지 않는 키는 `null`이라
 * 전역 단축키가 그대로 흐른다.
 */
export function nextAssetCardFocus(
  key: string,
  index: number,
  count: number,
  cols: number,
): number | null {
  if (count <= 0 || index < 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'ArrowDown':
      return Math.min(count - 1, index + Math.max(1, cols));
    case 'ArrowUp':
      return Math.max(0, index - Math.max(1, cols));
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
