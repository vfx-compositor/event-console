/**
 * 곡별 재생 시작 북마크 (U47).
 *
 * ## 왜 필요한가
 * 행사 BGM은 대부분 앞부분이 길게 깔린다 — 개회식 웅장 트랙은 후렴이 1분 뒤에 온다. 현장에서
 * 필요한 순간은 그 후렴이라, 운영자는 매번 틀어 놓고 스크럽으로 그 자리를 찾아 갔다. 리허설에서
 * 찾아 둔 자리를 곡마다 하나씩 기억해 두고, 다음부터 [북마크부터]로 곧장 들어간다.
 *
 * ## 곡마다 하나뿐이다
 * 여러 개를 두면 "지금 어느 북마크인가"를 화면에 띄워야 하고, 현장에서 그걸 고를 시간이 없다.
 * 하나면 버튼이 [처음부터]와 [북마크부터] 둘로 끝난다. 다시 찍으면 덮어쓴다.
 */

import { musicTrack } from './music';

/** 맨 앞 이 구간은 북마크로 받지 않는다 — [처음부터]와 구별되지 않아 버튼이 둘 다 같은 뜻이 된다. */
export const BOOKMARK_MIN_SEC = 1;

/** 곡 id → 시작 초 */
export type MusicBookmarks = Record<string, number>;

export function bookmarkOf(bookmarks: MusicBookmarks, trackId: string | null | undefined): number | null {
  if (!trackId) return null;
  const v = bookmarks[trackId];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 북마크를 찍는다. 받을 수 없는 값이면 **원본을 그대로** 돌려준다 —
 * 새 객체를 만들면 리듀서가 상태를 갈고 재렌더·방송이 헛돈다.
 */
export function setBookmark(
  bookmarks: MusicBookmarks,
  trackId: string | null | undefined,
  positionSec: number,
): MusicBookmarks {
  if (!trackId) return bookmarks;
  if (!Number.isFinite(positionSec) || positionSec < BOOKMARK_MIN_SEC) return bookmarks;
  if (bookmarks[trackId] === positionSec) return bookmarks;
  return { ...bookmarks, [trackId]: positionSec };
}

export function clearBookmark(bookmarks: MusicBookmarks, trackId: string | null | undefined): MusicBookmarks {
  if (!trackId || !(trackId in bookmarks)) return bookmarks;
  const next = { ...bookmarks };
  delete next[trackId];
  return next;
}

/**
 * 저장본에서 되살린다. catalog에 없는 곡·유효하지 않은 초는 버린다 —
 * 곡 목록이 바뀌면 옛 저장본에 죽은 id가 남고, 그게 화면에 "북마크 있음"으로 보인다.
 */
export function normalizeBookmarks(raw: unknown): MusicBookmarks {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: MusicBookmarks = {};
  for (const [trackId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!musicTrack(trackId)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < BOOKMARK_MIN_SEC) continue;
    out[trackId] = value;
  }
  return out;
}
