import { describe, expect, it, vi } from 'vitest';

vi.mock('./music', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./music')>();
  const fixture = await import('./test-music-fixture');
  return {
    ...actual,
    MUSIC_TRACKS: fixture.SYNTHETIC_MUSIC_TRACKS,
    musicTrack: fixture.syntheticMusicTrack,
  };
});

import {
  BOOKMARK_MIN_SEC,
  bookmarkOf,
  clearBookmark,
  normalizeBookmarks,
  setBookmark,
} from './music-bookmarks';
import { createInitialState, deserialize, reducer, serialize } from './state';

describe('곡별 북마크 (U47)', () => {
  it('없는 곡은 북마크도 없다', () => {
    expect(bookmarkOf({}, '01')).toBeNull();
    expect(bookmarkOf({ '01': 42 }, '02')).toBeNull();
    expect(bookmarkOf({ '01': 42 }, null)).toBeNull();
  });

  it('찍고 지울 수 있고 원본을 건드리지 않는다', () => {
    const base = { '01': 10 };
    const next = setBookmark(base, '02', 33.5);
    expect(next).toEqual({ '01': 10, '02': 33.5 });
    expect(base).toEqual({ '01': 10 });
    expect(clearBookmark(next, '02')).toEqual({ '01': 10 });
    // 없는 것을 지우면 **같은 참조** — 헛 재렌더·방송을 만들지 않는다
    expect(clearBookmark(base, '99')).toBe(base);
  });

  /**
   * 0초 북마크는 "처음부터"와 구별되지 않는다. 버튼이 둘 다 같은 자리를 가리키면
   * 운영자는 어느 쪽을 눌러도 같은 결과를 보고 북마크가 고장 났다고 읽는다.
   */
  it('맨 앞 구간은 북마크로 받지 않는다', () => {
    expect(setBookmark({}, '01', 0)).toEqual({});
    expect(setBookmark({}, '01', BOOKMARK_MIN_SEC - 0.01)).toEqual({});
    expect(setBookmark({}, '01', BOOKMARK_MIN_SEC)).toEqual({ '01': BOOKMARK_MIN_SEC });
  });

  it('찍은 자리에 다시 찍으면 덮어쓴다', () => {
    expect(setBookmark({ '01': 10 }, '01', 90)).toEqual({ '01': 90 });
  });

  it('유한하지 않은 값·없는 곡 id는 무시한다', () => {
    expect(setBookmark({}, '01', Number.NaN)).toEqual({});
    expect(setBookmark({}, '01', Number.POSITIVE_INFINITY)).toEqual({});
    expect(setBookmark({}, null, 30)).toEqual({});
  });

  it('저장본은 catalog에 있는 곡·유효한 초만 되살린다', () => {
    expect(normalizeBookmarks(null)).toEqual({});
    expect(normalizeBookmarks('nope')).toEqual({});
    expect(normalizeBookmarks({ '01': 30, 'no-such-track': 30, '02': -5, '03': 'x' })).toEqual({
      '01': 30,
    });
  });
});

describe('북마크 액션과 재생 시작점 (U47)', () => {
  const played = (): ReturnType<typeof createInitialState> =>
    reducer(createInitialState(), { type: 'music/play', trackId: '01', now: 0 });

  it('music/play는 기본이 처음부터다', () => {
    expect(played().music.positionSec).toBe(0);
  });

  it('startSec을 주면 그 자리에서 시작한다 — 북마크부터 재생의 유일한 경로', () => {
    const s = reducer(createInitialState(), {
      type: 'music/play',
      trackId: '01',
      startSec: 61.5,
      now: 0,
    });
    expect(s.music.positionSec).toBe(61.5);
    expect(s.music.playing).toBe(true);
    // 명령 토큰이 올라야 display가 그 자리로 seek한다
    expect(s.music.commandToken).toBeGreaterThan(createInitialState().music.commandToken);
  });

  it('음수·비유한 startSec은 처음부터로 떨어진다', () => {
    for (const startSec of [-10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = reducer(createInitialState(), { type: 'music/play', trackId: '01', startSec, now: 0 });
      expect(s.music.positionSec).toBe(0);
    }
  });

  it('북마크는 곡을 바꿔도·정지해도 남는다 — 그게 존재 이유다', () => {
    let s = reducer(played(), { type: 'music/bookmark', trackId: '01', positionSec: 45 });
    expect(bookmarkOf(s.music.bookmarks, '01')).toBe(45);

    s = reducer(s, { type: 'music/play', trackId: '02', now: 1 });
    expect(bookmarkOf(s.music.bookmarks, '01')).toBe(45);
    s = reducer(s, { type: 'music/stop', now: 2 });
    expect(bookmarkOf(s.music.bookmarks, '01')).toBe(45);
  });

  it('북마크 해제는 그 곡만 지운다', () => {
    let s = reducer(played(), { type: 'music/bookmark', trackId: '01', positionSec: 45 });
    s = reducer(s, { type: 'music/bookmark', trackId: '02', positionSec: 12 });
    s = reducer(s, { type: 'music/bookmarkClear', trackId: '01' });
    expect(bookmarkOf(s.music.bookmarks, '01')).toBeNull();
    expect(bookmarkOf(s.music.bookmarks, '02')).toBe(12);
  });

  it('바뀌는 것이 없으면 같은 상태 참조를 돌려준다', () => {
    const s = played();
    expect(reducer(s, { type: 'music/bookmarkClear', trackId: '01' })).toBe(s);
    expect(reducer(s, { type: 'music/bookmark', trackId: '01', positionSec: 0 })).toBe(s);
  });

  it('북마크는 저장·방송 왕복에서 살아남는다', () => {
    const s = reducer(played(), { type: 'music/bookmark', trackId: '01', positionSec: 45 });
    expect(deserialize(serialize(s)).music.bookmarks).toEqual({ '01': 45 });
  });

  /**
   * 실사고 후보: `normalizeMusic()`은 trackId가 catalog에 없으면 이른 반환으로 기본 상태를
   * 돌려준다. 북마크를 그 뒤에 두면 **곡이 지워진 저장본에서 북마크가 통째로 날아간다.**
   */
  it('현재 곡이 무효한 저장본에서도 북마크는 남는다', () => {
    const raw = JSON.parse(serialize(reducer(played(), { type: 'music/bookmark', trackId: '01', positionSec: 45 })));
    raw.music.trackId = 'no-such-track';
    const revived = deserialize(JSON.stringify(raw));
    expect(revived.music.trackId).toBeNull();
    expect(revived.music.bookmarks).toEqual({ '01': 45 });
  });

  it('북마크 키가 없는 옛 저장본은 빈 맵으로 인수된다', () => {
    const raw = JSON.parse(serialize(createInitialState()));
    delete raw.music.bookmarks;
    expect(deserialize(JSON.stringify(raw)).music.bookmarks).toEqual({});
  });
});
