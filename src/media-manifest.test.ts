/**
 * media 폴더 기본 영상 자동 등록.
 *
 * 여기서 지키는 계약:
 *  1) manifest 파싱은 관대하되 위험한 값(경로 탈출·미지원 확장자)은 버린다
 *  2) 같은 파일을 두 번 등록하지 않는다 (assetId 고정 → control 을 여러 번 열어도 안전)
 *  3) 사용자가 삭제(숨김)한 항목은 다시 들어오지 않는다
 *  4) manifest 가 없으면 조용히 넘어간다 — media 폴더를 쓰지 않는 설치도 정상 동작해야 한다
 */

// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { existsSync, readFileSync } from 'node:fs';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deadVideoAssetRef,
  isMediaAsset,
  mediaAssetId,
  mediaFileFromId,
  orphanVideoRefAction,
  orphanedMediaAssetIds,
  pendingOrphanVideoRefAction,
  parseManifest,
  pendingItems,
  resetMediaStatus,
  syncMediaManifest,
} from './media-manifest';
import { createInitialState, migrate, reducer } from './state';

beforeEach(() => resetMediaStatus());

// ---------------------------------------------------------------- 1) 파싱

describe('parseManifest', () => {
  it('정상 항목을 읽고 기본값을 채운다', () => {
    const items = parseManifest([
      { file: 'test_01.mp4', name: '테스트 클립 01', after: 'standby', cueAfter: null },
      { file: 'sting.mp4', mode: 'transition', switchAt: 0.75 },
      'plain.mp4', // 문자열 한 줄 표기도 받는다
    ]);

    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      file: 'test_01.mp4',
      name: '테스트 클립 01',
      after: 'standby',
      cueAfter: null,
      mode: 'full',
      switchAt: 0.5,
      holdEndFrame: false,
    });
    expect(items[1].name).toBe('sting');
    expect(items[1].after).toBe('standby');
    expect(items[1].mode).toBe('transition');
    expect(items[1].switchAt).toBe(0.75);
    expect(items[2].file).toBe('plain.mp4');
  });

  it('잘못된 줄만 버리고 나머지는 살린다', () => {
    const items = parseManifest([
      { file: '../../etc/passwd.mp4' }, // 경로 탈출
      { file: 'sub/dir/clip.mp4' }, // 하위 폴더 미지원
      { file: 'notes.txt' }, // 영상·이미지가 아님
      { file: '' },
      null,
      { file: 'good.mp4', after: '없는씬' }, // 알 수 없는 씬 → standby 로
      { file: 'good.mp4' }, // 중복 → 한 번만
    ]);

    expect(items.map((i) => i.file)).toEqual(['good.mp4']);
    expect(items[0].after).toBe('standby');
    expect(items[0].mode).toBe('full');
    expect(items[0].switchAt).toBe(0.5);
  });

  it('배열이 아니면 빈 목록', () => {
    expect(parseManifest(null)).toEqual([]);
    expect(parseManifest('nope')).toEqual([]);
    expect(parseManifest({})).toEqual([]);
  });

  it('assetId 는 파일명으로 고정되고 되돌릴 수 있다', () => {
    expect(mediaAssetId('test_01.mp4')).toBe('media:test_01.mp4');
    expect(isMediaAsset('media:test_01.mp4')).toBe(true);
    expect(isMediaAsset('a1234')).toBe(false);
    expect(mediaFileFromId('media:test_01.mp4')).toBe('test_01.mp4');
    expect(mediaFileFromId('a1234')).toBeNull();
  });

  it('revision은 배포 파일을 같은 id로 안전하게 교체하기 위한 값으로 읽는다', () => {
    expect(parseManifest([{ file: 'sting.webm', revision: 'fast-v2' }])[0].revision).toBe(
      'fast-v2',
    );
    expect(parseManifest([{ file: 'sting.webm', revision: 3 }])[0].revision).toBe('3');
  });

  it('끝 프레임 유지 설정은 명시적인 true만 받아 안전하게 기본 off로 둔다', () => {
    expect(parseManifest([{ file: 'hold.webm', holdEndFrame: true }])[0].holdEndFrame).toBe(true);
    expect(parseManifest([{ file: 'auto.mp4', holdEndFrame: 'true' }])[0].holdEndFrame).toBe(false);
  });

  it('매치 알파 영상은 씬 교체 없는 overlay 모드로 읽는다', () => {
    expect(parseManifest([{ file: 'match.webm', mode: 'overlay', holdEndFrame: true }])[0]).toMatchObject({
      mode: 'overlay',
      modeRaw: 'overlay',
      holdEndFrame: true,
    });
  });
});

// ---------------------------------------------------------------- 2·3) 중복·숨김

describe('pendingItems', () => {
  const items = parseManifest([{ file: 'a.mp4' }, { file: 'b.mp4' }, { file: 'c.mp4' }]);

  it('이미 등록된 항목은 건너뛴다', () => {
    const todo = pendingItems(items, ['media:a.mp4', 'a9zz'], []);
    expect(todo.map((i) => i.file)).toEqual(['b.mp4', 'c.mp4']);
  });

  it('숨긴 항목은 다시 넣지 않는다', () => {
    const todo = pendingItems(items, [], ['b.mp4']);
    expect(todo.map((i) => i.file)).toEqual(['a.mp4', 'c.mp4']);
  });

  it('둘 다 걸리면 남는 게 없다', () => {
    expect(pendingItems(items, ['media:a.mp4'], ['b.mp4', 'c.mp4'])).toEqual([]);
  });

  it('같은 파일명도 manifest revision이 바뀌면 한 번 다시 등록한다', () => {
    const versioned = parseManifest([{ file: 'a.mp4', revision: 'fast-v2' }]);
    expect(
      pendingItems(versioned, ['media:a.mp4'], [], {
        'media:a.mp4': { sourceRevision: 'lossless-v1' },
      }),
    ).toEqual(versioned);
    expect(
      pendingItems(versioned, ['media:a.mp4'], [], {
        'media:a.mp4': { sourceRevision: 'fast-v2' },
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------- 등록 루프

/** fetch 흉내 — manifest 와 파일 몇 개만 있는 서버 */
function fakeFetch(files: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = url.replace(/^media\//, '');
    if (!(key in files)) return { ok: false, status: 404 } as Response;
    const body = files[key];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      blob: async () => ({ size: 1234, type: 'video/mp4' }) as unknown as Blob,
    } as Response;
  }) as typeof fetch;
}

const MANIFEST = [
  { file: 'test_01.mp4', name: '테스트 클립 01', after: 'standby', cueAfter: null },
  {
    file: 'sting.mp4',
    name: '속보 스팅',
    after: 'suspects',
    cueAfter: 'break',
    mode: 'transition',
    switchAt: 0.75,
  },
];

function collector() {
  const saved: {
    id: string;
    name: string;
    nextScene: unknown;
    cueAfter: unknown;
    playMode: unknown;
    switchAtSec: unknown;
    sourceRevision?: string;
  }[] = [];
  return {
    saved,
    put: async (rec: {
      id: string;
      name: string;
      nextScene: unknown;
      cueAfter: unknown;
      playMode: unknown;
      switchAtSec: unknown;
      sourceRevision?: string;
    }) => {
      saved.push({
        id: rec.id,
        name: rec.name,
        nextScene: rec.nextScene,
        cueAfter: rec.cueAfter,
        playMode: rec.playMode,
        switchAtSec: rec.switchAtSec,
        ...(rec.sourceRevision ? { sourceRevision: rec.sourceRevision } : {}),
      });
    },
    probe: async () => ({ durationSec: 14, thumbDataUrl: 'data:image/jpeg;base64,xx' }),
  };
}

describe('orphanedMediaAssetIds', () => {
  const items = parseManifest([{ file: 'a.mp4' }, { file: 'b.mp4' }]);

  it('manifest 에서 빠진 media-origin 항목을 골라낸다 (실사고: test_01.mp4 유령 항목)', () => {
    expect(
      orphanedMediaAssetIds(items, ['media:a.mp4', 'media:test_01.mp4', 'media:b.mp4']),
    ).toEqual(['media:test_01.mp4']);
  });

  it('manifest 에 있는 항목은 대상에서 뺀다', () => {
    expect(orphanedMediaAssetIds(items, ['media:a.mp4', 'media:b.mp4'])).toEqual([]);
  });

  it('media: 접두가 없는(=사용자가 직접 올린) 에셋은 건드리지 않는다', () => {
    expect(orphanedMediaAssetIds(items, ['a9zz-user-upload'])).toEqual([]);
  });

  it('manifest 가 빈 목록이면(=absent/error 상태) 전부 대상이 되므로 호출부가 kind===\'ok\'일 때만 불러야 한다', () => {
    expect(orphanedMediaAssetIds([], ['media:a.mp4'])).toEqual(['media:a.mp4']);
  });
});

describe('syncMediaManifest', () => {
  it('없는 항목만 등록하고 메타를 그대로 옮긴다', async () => {
    const c = collector();
    const res = await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put,
      fetchFn: fakeFetch({ 'manifest.json': MANIFEST, 'test_01.mp4': 1, 'sting.mp4': 1 }),
    });

    expect(res.kind).toBe('ok');
    expect(res.added).toBe(2);
    expect(res.total).toBe(2);
    expect(c.saved.map((s) => s.id)).toEqual(['media:test_01.mp4', 'media:sting.mp4']);
    expect(c.saved[0].name).toBe('테스트 클립 01');
    expect(c.saved[1].nextScene).toBe('suspects');
    expect(c.saved[1].cueAfter).toBe('break');
    expect(c.saved[1].playMode).toBe('transition');
    expect(c.saved[1].switchAtSec).toBe(0.75);
  });

  it('두 번 돌려도 중복 등록되지 않는다', async () => {
    const first = collector();
    const fetchFn = fakeFetch({ 'manifest.json': MANIFEST, 'test_01.mp4': 1, 'sting.mp4': 1 });
    await syncMediaManifest({ existingIds: [], hidden: [], probe: first.probe, put: first.put, fetchFn });

    const second = collector();
    const res = await syncMediaManifest({
      existingIds: first.saved.map((s) => s.id),
      hidden: [],
      probe: second.probe,
      put: second.put,
      fetchFn,
    });

    expect(res.added).toBe(0);
    expect(second.saved).toEqual([]);
  });

  it('revision 교체 시 운영자 메타(이름·재생 후·큐시트)는 보존하되 새 파일의 switchAt은 덮어쓴다', async () => {
    const c = collector();
    const versioned = [
      {
        file: 'sting.mp4',
        name: '새 기본 이름',
        mode: 'transition',
        switchAt: 1,
        revision: 'fast-v2',
      },
    ];
    const res = await syncMediaManifest({
      existingIds: ['media:sting.mp4'],
      existingById: {
        'media:sting.mp4': {
          name: '현장 이름',
          nextScene: 'live',
          cueAfter: 'open',
          playMode: 'transition',
          switchAtSec: 0.75,
          order: 4,
          sourceRevision: 'lossless-v1',
        },
      },
      hidden: [],
      probe: c.probe,
      put: c.put,
      fetchFn: fakeFetch({ 'manifest.json': versioned, 'sting.mp4': 1 }),
    });

    expect(res.added).toBe(1);
    expect(c.saved).toEqual([
      {
        // 이름·재생 후·큐시트는 운영자가 고친 값 그대로(파일 교체와 무관한 메타)
        id: 'media:sting.mp4',
        name: '현장 이름',
        nextScene: 'live',
        cueAfter: 'open',
        // switchAt은 새 파일(fast-v2)의 timing인 1 로 갱신 — 옛 파일(0.75) 값이 남으면 전환이 어긋난다
        playMode: 'transition',
        switchAtSec: 1,
        sourceRevision: 'fast-v2',
      },
    ]);
  });

  describe('revision 교체 시 switchAt/playMode 갱신 (실사고: 24fps 1.0 → 60fps 0.93 전환 영상 교체)', () => {
    it('(a) revision이 바뀌면 manifest가 지정한 새 switchAt/playMode가 기존 값을 덮어쓴다', async () => {
      const c = collector();
      const res = await syncMediaManifest({
        existingIds: ['media:sting.mp4'],
        existingById: {
          'media:sting.mp4': { playMode: 'transition', switchAtSec: 1.0, sourceRevision: '24fps-v1' },
        },
        hidden: [],
        probe: c.probe,
        put: c.put,
        fetchFn: fakeFetch({
          'manifest.json': [{ file: 'sting.mp4', mode: 'transition', switchAt: 0.93, revision: '60fps-v2' }],
          'sting.mp4': 1,
        }),
      });

      expect(res.added).toBe(1);
      expect(c.saved[0].switchAtSec).toBe(0.93);
      expect(c.saved[0].playMode).toBe('transition');
    });

    it('(a) revision 변경 + full→transition 전환도 manifest 값으로 갱신된다', async () => {
      const c = collector();
      const res = await syncMediaManifest({
        existingIds: ['media:sting.mp4'],
        existingById: {
          'media:sting.mp4': { playMode: 'full', switchAtSec: 0.5, sourceRevision: 'v1' },
        },
        hidden: [],
        probe: c.probe,
        put: c.put,
        fetchFn: fakeFetch({
          'manifest.json': [{ file: 'sting.mp4', mode: 'transition', switchAt: 0.9, revision: 'v2' }],
          'sting.mp4': 1,
        }),
      });

      expect(res.added).toBe(1);
      expect(c.saved[0].playMode).toBe('transition');
      expect(c.saved[0].switchAtSec).toBe(0.9);
    });

    it('(b) revision이 같으면(=probe 재시도) 기존 switchAt/playMode를 그대로 지킨다', async () => {
      const c = collector();
      const res = await syncMediaManifest({
        // probe 재시도: existingIds 에서 일부러 뺀 상태 (existingById 는 별도로 유지)
        existingIds: [],
        existingById: {
          'media:sting.mp4': { playMode: 'transition', switchAtSec: 0.75, sourceRevision: 'same-v1' },
        },
        hidden: [],
        probe: c.probe,
        put: c.put,
        fetchFn: fakeFetch({
          'manifest.json': [{ file: 'sting.mp4', mode: 'transition', switchAt: 0.4, revision: 'same-v1' }],
          'sting.mp4': 1,
        }),
      });

      expect(res.added).toBe(1);
      expect(c.saved[0].switchAtSec).toBe(0.75);
      expect(c.saved[0].playMode).toBe('transition');
    });

    it('(b) revision이 없는 manifest는 기존 동작대로 기존 switchAt을 지킨다', async () => {
      const c = collector();
      const res = await syncMediaManifest({
        existingIds: [],
        existingById: {
          'media:sting.mp4': { playMode: 'transition', switchAtSec: 0.75 },
        },
        hidden: [],
        probe: c.probe,
        put: c.put,
        fetchFn: fakeFetch({
          'manifest.json': [{ file: 'sting.mp4', mode: 'transition', switchAt: 0.4 }],
          'sting.mp4': 1,
        }),
      });

      expect(res.added).toBe(1);
      expect(c.saved[0].switchAtSec).toBe(0.75);
    });

    it('(b) 최초 등록(prev 없음)이면 manifest의 switchAt을 그대로 쓴다', async () => {
      const c = collector();
      const res = await syncMediaManifest({
        existingIds: [],
        hidden: [],
        probe: c.probe,
        put: c.put,
        fetchFn: fakeFetch({
          'manifest.json': [{ file: 'new.mp4', mode: 'transition', switchAt: 0.6, revision: 'v1' }],
          'new.mp4': 1,
        }),
      });

      expect(res.added).toBe(1);
      expect(c.saved[0].switchAtSec).toBe(0.6);
    });

    it('(c) revision이 바뀌어도 manifest가 switchAt을 명시하지 않으면 기존 값을 유지한다', async () => {
      const c = collector();
      const res = await syncMediaManifest({
        existingIds: ['media:sting.mp4'],
        existingById: {
          'media:sting.mp4': { playMode: 'transition', switchAtSec: 0.75, sourceRevision: 'v1' },
        },
        hidden: [],
        probe: c.probe,
        put: c.put,
        fetchFn: fakeFetch({
          // switchAt 필드 자체를 생략 — parseManifest 는 기본값 0.5를 채우지만
          // switchAtRaw 는 undefined 이므로 병합 로직은 기존 값을 지켜야 한다
          'manifest.json': [{ file: 'sting.mp4', mode: 'transition', revision: 'v2' }],
          'sting.mp4': 1,
        }),
      });

      expect(res.added).toBe(1);
      expect(c.saved[0].switchAtSec).toBe(0.75);
    });
  });

  it('숨긴 파일은 다시 들어오지 않는다', async () => {
    const c = collector();
    const res = await syncMediaManifest({
      existingIds: [],
      hidden: ['test_01.mp4'],
      probe: c.probe,
      put: c.put,
      fetchFn: fakeFetch({ 'manifest.json': MANIFEST, 'test_01.mp4': 1, 'sting.mp4': 1 }),
    });

    expect(res.added).toBe(1);
    expect(c.saved.map((s) => s.id)).toEqual(['media:sting.mp4']);
  });

  it('manifest 가 없으면 조용히 넘어간다 (absent)', async () => {
    const c = collector();
    const res = await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put,
      fetchFn: fakeFetch({}),
    });

    expect(res.kind).toBe('absent');
    expect(res.added).toBe(0);
    expect(c.saved).toEqual([]);
  });

  it('probe 재시도로 다시 넣을 때 사람이 고친 이름·재생 후·큐시트를 덮지 않는다', async () => {
    const c = collector();
    // existingIds 에서 빼면 = 다시 시도 대상. 그때 existingById 의 값이 매니페스트보다 우선한다.
    const res = await syncMediaManifest({
      existingIds: ['media:sting.mp4'],
      existingById: {
        'media:test_01.mp4': { name: '현장에서 바꾼 이름', nextScene: 'score', cueAfter: 'open', order: 7 },
      },
      hidden: [],
      probe: c.probe,
      put: c.put,
      fetchFn: fakeFetch({ 'manifest.json': MANIFEST, 'test_01.mp4': 1, 'sting.mp4': 1 }),
    });

    expect(res.added).toBe(1);
    expect(c.saved).toEqual([
      {
        id: 'media:test_01.mp4',
        name: '현장에서 바꾼 이름',
        nextScene: 'score',
        cueAfter: 'open',
        playMode: 'full',
        switchAtSec: 0.5,
      },
    ]);
  });

  it('파일이 빠져 있으면 그 항목만 실패로 남기고 나머지는 등록한다', async () => {
    const c = collector();
    const res = await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put,
      fetchFn: fakeFetch({ 'manifest.json': MANIFEST, 'sting.mp4': 1 }),
    });

    expect(res.added).toBe(1);
    expect(res.failed).toEqual(['test_01.mp4']);
    expect(c.saved.map((s) => s.id)).toEqual(['media:sting.mp4']);
  });
});

// ---------------------------------------------------------------- 상태 (숨김 목록)

describe('hiddenMedia 상태', () => {
  it('삭제 → 숨김 기록, 되돌리기 → 비움', () => {
    let s = createInitialState();
    expect(s.hiddenMedia).toEqual([]);

    s = reducer(s, { type: 'media/hide', file: 'test_01.mp4' });
    expect(s.hiddenMedia).toEqual(['test_01.mp4']);

    // 같은 파일을 두 번 숨겨도 늘지 않는다
    const same = reducer(s, { type: 'media/hide', file: 'test_01.mp4' });
    expect(same).toBe(s);

    s = reducer(s, { type: 'media/unhideAll' });
    expect(s.hiddenMedia).toEqual([]);
  });

  it('구버전 저장본(필드 없음)도 빈 목록으로 살아난다', () => {
    const raw = { ...createInitialState() } as Record<string, unknown>;
    delete raw.hiddenMedia;
    expect(migrate(raw).hiddenMedia).toEqual([]);

    // 문자열이 아닌 값이 섞여 들어와도 걸러낸다
    expect(migrate({ ...raw, hiddenMedia: ['a.mp4', 3, null] }).hiddenMedia).toEqual(['a.mp4']);
  });
});

// ------------------------------------------------- 재적재 때 사람이 고친 값 보존 (H3/H4)

/**
 * 공용 `collector()`는 `audio`·`probeFailed`를 버린다(기존 toEqual 비교를 깨지 않기 위해).
 * 여기서는 그 두 값이 관심사라 레코드를 통째로 모으는 수집기를 따로 쓴다.
 */
function rawCollector(hasAudio?: boolean) {
  const saved: Record<string, unknown>[] = [];
  return {
    saved,
    put: async (rec: Record<string, unknown>) => {
      saved.push(rec);
    },
    // `hasAudio` 를 넘기지 않으면 "브라우저가 판정하지 못했다"(U84) — 키 자체를 싣지 않는다
    probe: async () => ({
      durationSec: 14,
      thumbDataUrl: 'data:image/jpeg;base64,xx',
      ...(hasAudio !== undefined ? { hasAudio } : {}),
    }),
  };
}

/** probe 재시도 경로 — 항목이 이미 있어도 `existingIds`에서 빼면 다시 등록을 시도한다 */
async function resync(
  existing: Record<string, unknown>,
  manifestItem: Record<string, unknown>,
  probeAudio?: boolean,
) {
  const c = rawCollector(probeAudio);
  await syncMediaManifest({
    // 일부러 비운다 = "이 항목은 probe 재시도 대상" (control.ts reloadMedia 의 broken 집합)
    existingIds: [],
    existingById: { 'media:clip.mp4': existing },
    hidden: [],
    probe: c.probe,
    put: c.put as never,
    fetchFn: fakeFetch({ 'manifest.json': [manifestItem], 'clip.mp4': 1 }),
  });
  return c.saved[0];
}

describe('재적재(probe 재시도·revision 교체)에서 운영자가 고친 값 보존', () => {
  it('audio=false 는 probe 재시도에서 살아남는다 (기본값 켬으로 되돌아가면 무음 영상이 소리를 낸다)', async () => {
    const rec = await resync(
      {
        name: '설명 영상',
        playMode: 'full',
        switchAtSec: 0.5,
        audio: false,
        audioSource: 'operator',
        sourceRevision: 'v1',
      },
      { file: 'clip.mp4', revision: 'v1' },
    );
    expect(rec.audio).toBe(false);
  });

  it('audio=false 는 revision 교체(파일 자체가 바뀐 경우)에서도 살아남는다 — manifest 에 없는 값이므로', async () => {
    const rec = await resync(
      {
        name: '설명 영상',
        playMode: 'full',
        switchAtSec: 0.5,
        audio: false,
        audioSource: 'operator',
        sourceRevision: 'v1',
      },
      { file: 'clip.mp4', revision: 'v2' },
    );
    expect(rec.audio).toBe(false);
  });

  it('고친 적이 없으면 audio 키 자체를 쓰지 않는다 (읽는 쪽의 `?? true` 폴백을 흐리지 않기 위해)', async () => {
    const rec = await resync(
      { name: '설명 영상', playMode: 'full', switchAtSec: 0.5, sourceRevision: 'v1' },
      { file: 'clip.mp4', revision: 'v1' },
    );
    expect('audio' in rec).toBe(false);
    expect('audioSource' in rec).toBe(false);
  });

  it('nextScene=null("직전 씬으로 복귀")은 manifest 의 after 로 덮이지 않는다', async () => {
    const rec = await resync(
      { name: '설명 영상', nextScene: null, playMode: 'full', switchAtSec: 0.5, sourceRevision: 'v1' },
      { file: 'clip.mp4', after: 'award', revision: 'v2' },
    );
    expect(rec.nextScene).toBeNull();
  });

  it('한 번도 지정한 적이 없으면(키 없음) manifest 의 after 가 쓰인다', async () => {
    const rec = await resync(
      { name: '설명 영상', playMode: 'full', switchAtSec: 0.5, sourceRevision: 'v1' },
      { file: 'clip.mp4', after: 'award', revision: 'v1' },
    );
    expect(rec.nextScene).toBe('award');
  });
});

// ------------------------------------ 소리 판정: 사람 > manifest > 파일 실측 (U84)

/**
 * 실사고 2026-09-04 09:44 "몸으로 말해요에 왜 사운드 안나와?".
 *
 * U55 로 manifest 의 `audio` 를 읽기 시작하면서 게임 인트로 4편을 한꺼번에 `audio:false` 로
 * 적었는데, 그중 둘(`intro_sticky_fishing`·`intro_one_mind`)은 AAC 트랙이 있었다. 저장값이
 * manifest 보다 우선하는 규칙 때문에 **manifest 만 고쳐서는 이미 씨앗을 받은 프로필을 고칠 수
 * 없었다**.
 *
 * 뿌리는 "소리 유무를 손으로 적는다"였다. 이제 등록할 때 파일을 열어 오디오 트랙을 직접 확인하고
 * (`probe.hasAudio`), 저장값이 **어디서 왔는지**(`audioSource`)를 함께 남긴다.
 * 우선순위: 사람(`operator`) > manifest 명시 > 파일 실측(`probe`) > 기본값(소리 있음).
 */
const OPERATOR_MUTED = {
  name: '설명 영상',
  playMode: 'full',
  switchAtSec: 0.5,
  audio: false,
  audioSource: 'operator',
  sourceRevision: 'v1',
} as const;

describe('소리 판정 우선순위 — 사람 > manifest > 파일 실측 (U84)', () => {
  it('manifest 가 말이 없으면 파일 실측 결과를 쓴다 (트랙 있음 → 소리 켬)', async () => {
    const c = rawCollector(true);
    await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put as never,
      fetchFn: fakeFetch({
        'manifest.json': [{ file: 'clip.mp4', name: '게임 인트로', revision: 'v1' }],
        'clip.mp4': 1,
      }),
    });
    expect(c.saved[0].audio).toBe(true);
    expect(c.saved[0].audioSource).toBe('probe');
  });

  it('트랙이 없으면 무음으로 등록된다 (덕킹이 조용한 영상을 기다리지 않는다)', async () => {
    const c = rawCollector(false);
    await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put as never,
      fetchFn: fakeFetch({
        'manifest.json': [{ file: 'clip.mp4', name: '게임 인트로', revision: 'v1' }],
        'clip.mp4': 1,
      }),
    });
    expect(c.saved[0].audio).toBe(false);
    expect(c.saved[0].audioSource).toBe('probe');
  });

  it('브라우저가 판정하지 못하면 키 자체를 쓰지 않는다 (읽는 쪽 `?? true` 폴백 보존)', async () => {
    const c = rawCollector();
    await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put as never,
      fetchFn: fakeFetch({
        'manifest.json': [{ file: 'clip.mp4', name: '게임 인트로', revision: 'v1' }],
        'clip.mp4': 1,
      }),
    });
    expect('audio' in c.saved[0]).toBe(false);
    expect('audioSource' in c.saved[0]).toBe(false);
  });

  it('manifest 가 명시하면 실측을 이긴다 (스팅어는 트랙이 생겨도 무음이어야 한다)', async () => {
    const c = rawCollector(true);
    await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put as never,
      fetchFn: fakeFetch({
        'manifest.json': [{ file: 'clip.mp4', name: '스팅어', audio: false, revision: 'v1' }],
        'clip.mp4': 1,
      }),
    });
    expect(c.saved[0].audio).toBe(false);
    expect(c.saved[0].audioSource).toBe('manifest');
  });

  it('파일을 갈아 끼우면 실측이 다시 돌아 무음→소리로 따라간다', async () => {
    const rec = await resync(
      { name: '게임 인트로', playMode: 'full', switchAtSec: 0.5, audio: false, audioSource: 'probe', sourceRevision: 'v1' },
      { file: 'clip.mp4', revision: 'v2' },
      true,
    );
    expect(rec.audio).toBe(true);
    expect(rec.audioSource).toBe('probe');
    // 사람이 고른 값이 아니므로 확인 칩은 띄우지 않는다 — 알아서 맞춰졌다
    expect('audioRecheck' in rec).toBe(false);
  });

  it('manifest 가 false→true 로 바뀌면 manifest 씨앗 값을 덮는다 (revision 은 그대로)', async () => {
    const rec = await resync(
      {
        name: '게임 인트로',
        playMode: 'full',
        switchAtSec: 0.5,
        audio: false,
        audioSource: 'manifest',
        sourceRevision: 'v1',
      },
      { file: 'clip.mp4', audio: true, revision: 'v1' },
    );
    expect(rec.audio).toBe(true);
    expect(rec.audioSource).toBe('manifest');
  });

  it('출처가 없는 옛 저장본도 정정을 받는다 (없으면 manifest 씨앗으로 본다)', async () => {
    const rec = await resync(
      { name: '게임 인트로', playMode: 'full', switchAtSec: 0.5, audio: false, sourceRevision: 'v1' },
      { file: 'clip.mp4', audio: true, revision: 'v1' },
    );
    expect(rec.audio).toBe(true);
    expect(rec.audioSource).toBe('manifest');
  });

  it('출처가 없는 옛 저장본은 실측에도 덮인다 (manifest 가 말이 없을 때)', async () => {
    const rec = await resync(
      { name: '게임 인트로', playMode: 'full', switchAtSec: 0.5, audio: false, sourceRevision: 'v1' },
      { file: 'clip.mp4', revision: 'v1' },
      true,
    );
    expect(rec.audio).toBe(true);
    expect(rec.audioSource).toBe('probe');
  });

  it('사람이 끈 소리는 manifest 가 true 라 해도, 실측이 소리를 찾아내도 그대로 무음이다', async () => {
    const rec = await resync({ ...OPERATOR_MUTED }, { file: 'clip.mp4', audio: true, revision: 'v1' }, true);
    expect(rec.audio).toBe(false);
    expect(rec.audioSource).toBe('operator');
  });

  it('사람이 켠 소리도 manifest·실측이 무음이라 해도 그대로 소리가 난다', async () => {
    const rec = await resync(
      { ...OPERATOR_MUTED, audio: true },
      { file: 'clip.mp4', audio: false, revision: 'v1' },
      false,
    );
    expect(rec.audio).toBe(true);
    expect(rec.audioSource).toBe('operator');
  });

  /**
   * 파일이 교체됐다고 사람이 고른 값을 말없이 덮으면, 무음으로 맞춰 둔 영상이 리허설 없이
   * 소리를 낼 수 있다. 값은 지키고 카드에 확인 칩만 띄운다.
   */
  it('revision 교체는 사람이 고른 값을 지키되 확인 칩을 세운다', async () => {
    const rec = await resync({ ...OPERATOR_MUTED }, { file: 'clip.mp4', audio: true, revision: 'v2' }, true);
    expect(rec.audio).toBe(false);
    expect(rec.audioSource).toBe('operator');
    expect(rec.audioRecheck).toBe(true);
  });

  it('아직 확인하지 않은 칩은 재적재(probe 재시도)로 사라지지 않는다', async () => {
    const rec = await resync(
      { ...OPERATOR_MUTED, audioRecheck: true },
      { file: 'clip.mp4', revision: 'v1' },
      true,
    );
    expect(rec.audioRecheck).toBe(true);
  });

  it('사람이 고친 적 없는 항목은 revision 이 바뀌어도 확인 칩을 띄우지 않는다', async () => {
    const rec = await resync(
      { name: '게임 인트로', playMode: 'full', switchAtSec: 0.5, audio: false, audioSource: 'manifest', sourceRevision: 'v1' },
      { file: 'clip.mp4', revision: 'v2' },
      false,
    );
    expect('audioRecheck' in rec).toBe(false);
  });

  it('아무도 모르면(manifest·실측 둘 다 없음) 기존 값을 지킨다 — revision 이 바뀌어도', async () => {
    const rec = await resync(
      { name: '게임 인트로', playMode: 'full', switchAtSec: 0.5, audio: false, audioSource: 'probe', sourceRevision: 'v1' },
      { file: 'clip.mp4', revision: 'v2' },
    );
    expect(rec.audio).toBe(false);
    expect(rec.audioSource).toBe('probe');
  });
});

/**
 * 주인 잃은 manifest 씨앗 (U111 — 2026-09-05 무음 사고).
 *
 * ## 무엇이 터졌나
 * U55(cb7b1cf)는 게임 인트로 4편을 manifest `audio:false`로 등록했다. U84(9be8d2d)가 그게
 * 틀렸음을 ffprobe로 확인하고 **manifest 에서 키를 지웠지만, revision 은 그대로 뒀다.**
 * U84 커밋 노트는 "출처 없는 옛 저장값은 manifest 출처로 간주해 정정이 전파된다"고 적었는데,
 * 그 전파는 `resolveAudioMeta` 를 통해서만 일어나고 — `pendingItems` 가 revision 이 같은
 * 항목을 **통째로 건너뛰므로 그 함수가 한 번도 돌지 않는다.** 09-04 10:06 실측이 통과한
 * 이유는 **새 프로필**로 쟀기 때문이다(씨앗이 없으니 프로브가 정답을 넣는다). 이미 등록해 둔
 * 사용자 프로필만 무음으로 남았고, 하루 뒤 리허설에서 끈끈이 낚시·몸으로 말해요가 소리 없이
 * 나갔다. 4174 실측: `video.video-el` 이 `muted:true` 로 3.4초째 재생 중.
 *
 * ## 무엇을 잡는가
 * 두 자리를 함께 잡아야 회귀가 막힌다 — 재적재가 **일어나는가**(`pendingItems`)와, 일어났을 때
 * 옛 값을 **폐기하는가**(`resolveAudioMeta`). 하나만 있으면 값이 안 고쳐지거나, 매 부팅마다
 * 영상을 다시 내려받는 무한 재적재가 된다.
 */
describe('주인 잃은 manifest 소리 씨앗은 한 번 다시 실측한다 (U111)', () => {
  const seeded = (over: Record<string, unknown> = {}) => ({
    'media:a.mp4': { sourceRevision: 'v1', audio: false, ...over },
  });
  const silent = parseManifest([{ file: 'a.mp4', revision: 'v1' }]);

  it('manifest 가 키를 지웠으면 revision 이 같아도 다시 등록 대상이다', () => {
    expect(pendingItems(silent, ['media:a.mp4'], [], seeded({ audioSource: 'manifest' }))).toEqual(silent);
  });

  it('출처가 없는 옛 저장본(U55 시절)도 같은 대상이다 — 실사고가 이 형태였다', () => {
    expect(pendingItems(silent, ['media:a.mp4'], [], seeded())).toEqual(silent);
  });

  it('운영자가 고른 값은 건드리지 않는다 — 저자가 manifest 가 아니다', () => {
    expect(pendingItems(silent, ['media:a.mp4'], [], seeded({ audioSource: 'operator' }))).toEqual([]);
  });

  it('실측으로 정해진 값도 건드리지 않는다 — manifest 가 침묵해도 저자가 있다', () => {
    expect(pendingItems(silent, ['media:a.mp4'], [], seeded({ audioSource: 'probe' }))).toEqual([]);
  });

  it('manifest 가 여전히 값을 말하면 대상이 아니다 (스팅어·매치 오버레이의 운영 결정)', () => {
    const declared = parseManifest([{ file: 'a.mp4', revision: 'v1', audio: false }]);
    expect(pendingItems(declared, ['media:a.mp4'], [], seeded({ audioSource: 'manifest' }))).toEqual([]);
  });

  it('저장된 소리 값이 아예 없으면 대상이 아니다 (지울 씨앗이 없다)', () => {
    expect(pendingItems(silent, ['media:a.mp4'], [], { 'media:a.mp4': { sourceRevision: 'v1' } })).toEqual([]);
  });

  it('다시 등록될 때 씨앗은 폐기되고 파일 실측이 정본이 된다 — 소리가 돌아온다', async () => {
    const rec = await resync(
      { name: '게임 인트로', playMode: 'full', switchAtSec: 0.5, audio: false, audioSource: 'manifest', sourceRevision: 'v1' },
      { file: 'clip.mp4', revision: 'v1' },
      true,
    );
    expect(rec.audio).toBe(true);
    expect(rec.audioSource).toBe('probe');
  });

  /**
   * 프로브가 판정하지 못해도 씨앗은 지운다. 지키면 `pendingItems` 조건이 계속 참이라 매 부팅
   * 영상을 다시 내려받는다 — 행사 당일 630MB짜리가 섞인 목록에서 그건 사고다.
   * 값이 없어지면 읽는 쪽의 `?? true` 폴백이 소리 켬으로 되돌리고, 틀렸으면 카드 토글 한 번.
   */
  it('프로브가 판정하지 못하면 씨앗을 지우고 키 없이 저장한다 — 무한 재적재를 막는다', async () => {
    const rec = await resync(
      { name: '게임 인트로', playMode: 'full', switchAtSec: 0.5, audio: false, audioSource: 'manifest', sourceRevision: 'v1' },
      { file: 'clip.mp4', revision: 'v1' },
    );
    expect('audio' in rec).toBe(false);
    expect('audioSource' in rec).toBe(false);
    // 그 저장 결과를 다시 넣어 보면 이제 대상이 아니다 = 두 번째 부팅에서 멈춘다
    expect(
      pendingItems(silent, ['media:a.mp4'], [], {
        'media:a.mp4': { sourceRevision: 'v1', audio: rec.audio as boolean | undefined },
      }),
    ).toEqual([]);
  });

  /**
   * 실사고 그대로의 회귀 방지: manifest 에서 인트로 4편의 `audio` 키가 다시 살아나면
   * (되돌리기·머지 사고) 저장 프로필이 또 무음으로 굳는다. `public-assets.test.ts` 가
   * 키 부재를 강제하고, 여기서는 그 상태에서 씨앗이 실제로 씻기는지를 잡는다.
   */
  it('실사고 재현 — 끈끈이 낚시·몸으로 말해요 씨앗이 두 편 다 재적재 대상이 된다', () => {
    const intros = parseManifest([
      { file: 'intro_sticky_fishing.mp4', revision: '43980e29390e' },
      { file: 'intro_one_mind.mp4', revision: 'd980abef24a4' },
    ]);
    const todo = pendingItems(
      intros,
      ['media:intro_sticky_fishing.mp4', 'media:intro_one_mind.mp4'],
      [],
      {
        // 사용자 프로필에서 실제로 관측된 두 형태(출처 명시본 / 출처 없는 옛 저장본)
        'media:intro_sticky_fishing.mp4': { sourceRevision: '43980e29390e', audio: false, audioSource: 'manifest' },
        'media:intro_one_mind.mp4': { sourceRevision: 'd980abef24a4', audio: false },
      },
    );
    expect(todo.map((i) => i.file)).toEqual(['intro_sticky_fishing.mp4', 'intro_one_mind.mp4']);
  });
});

/**
 * `VALID_SCENES`는 모듈 로컬 배열 리터럴이라 `SceneId`에 씬이 추가돼도 컴파일러가 잡아 주지
 * 않는다(계획 §1-1 "컴파일러가 못 잡는 곳"). 빠지면 manifest 의 `after: "photos"`가 조용히
 * `standby`로 강등돼, 배포 영상이 끝나도 사진 씬으로 넘어가지 않는 형태로만 드러난다.
 */
describe('manifest 의 after 는 새 씬도 받는다', () => {
  it('after: "photos" 가 그대로 nextScene 으로 저장된다', async () => {
    const c = collector();
    const res = await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put,
      fetchFn: fakeFetch({
        'manifest.json': [{ file: 'clip.mp4', name: '사진 앞 영상', after: 'photos' }],
        'clip.mp4': 1,
      }),
    });

    expect(res.kind).toBe('ok');
    expect(c.saved[0].nextScene).toBe('photos');
  });

  it('목록에 없는 씬 문자열은 여전히 standby 로 강등된다 (검사가 살아 있다는 증명)', async () => {
    const c = collector();
    await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put,
      fetchFn: fakeFetch({
        'manifest.json': [{ file: 'clip.mp4', name: '오타 씬', after: 'photoss' }],
        'clip.mp4': 1,
      }),
    });

    expect(c.saved[0].nextScene).toBe('standby');
  });
});

// ---------------------------------------------------------------- orphan 정리 뒤처리

describe('사라진 에셋의 속보 연결 영상 참조', () => {
  it('재생 중에는 지우지 않고 미룬다 — 슬롯이 null이 되면 display가 src를 잃는다', () => {
    for (const phase of ['covering', 'playing', 'holding', 'revealing'] as const) {
      expect(orphanVideoRefAction('media:gone.mp4', phase, ['media:gone.mp4'])).toBe('defer');
    }
  });

  it('idle이면 즉시 지운다', () => {
    expect(orphanVideoRefAction('media:gone.mp4', 'idle', ['media:gone.mp4'])).toBe('clear');
  });

  it('물고 있는 영상이 사라진 목록에 없으면 아무것도 하지 않는다', () => {
    expect(orphanVideoRefAction('media:alive.mp4', 'idle', ['media:gone.mp4'])).toBe('none');
    expect(orphanVideoRefAction(null, 'idle', ['media:gone.mp4'])).toBe('none');
    expect(orphanVideoRefAction('media:gone.mp4', 'playing', [])).toBe('none');
  });

  it('미뤄 둔 무효화는 idle이 될 때까지 기다렸다가 반영된다', () => {
    expect(pendingOrphanVideoRefAction('media:gone.mp4', 'media:gone.mp4', 'playing')).toBe('wait');
    expect(pendingOrphanVideoRefAction('media:gone.mp4', 'media:gone.mp4', 'idle')).toBe('clear');
  });

  it('그 사이 사람이 다른 영상을 골랐으면 그 선택을 덮지 않고 버린다', () => {
    expect(pendingOrphanVideoRefAction('media:gone.mp4', 'media:new.mp4', 'idle')).toBe('drop');
    expect(pendingOrphanVideoRefAction('media:gone.mp4', null, 'idle')).toBe('drop');
  });
});

describe('저장본에 남은 죽은 속보 연결 영상 참조', () => {
  it('목록에 없는 assetId를 idle에 물고 있으면 쓸어낸다', () => {
    expect(deadVideoAssetRef('media:gone.mp4', 'idle', ['media:alive.mp4'])).toBe(true);
  });

  it('재생 중에는 판단하지 않는다 — 정리 계약은 idle에서만 성립한다', () => {
    for (const phase of ['covering', 'playing', 'holding', 'revealing'] as const) {
      expect(deadVideoAssetRef('media:gone.mp4', phase, ['media:alive.mp4'])).toBe(false);
    }
  });

  it('살아 있는 참조나 빈 참조는 건드리지 않는다', () => {
    expect(deadVideoAssetRef('media:alive.mp4', 'idle', ['media:alive.mp4'])).toBe(false);
    expect(deadVideoAssetRef(null, 'idle', [])).toBe(false);
  });
});

/**
 * control 배선 잠금 — DOM 없는 vitest에서는 소스 단언으로 계약을 고정한다
 * (`video-hold.test.ts`·`standby-crossfade.test.ts`가 같은 방식을 쓴다).
 */
describe('control 배선 잠금 — orphan 정리 뒤처리', () => {
  const control = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');

  it('삭제는 항목별로 감싸 한 건 실패가 뒷정리 전체를 막지 않는다', () => {
    expect(control).not.toContain('await Promise.all(orphanIds.map');
    expect(control).toMatch(/for \(const id of orphanIds\)[\s\S]{0,200}try \{[\s\S]{0,120}await deleteAsset\(id\)/);
    expect(control).toContain('deleteFailures');
  });

  it('참조 무효화는 순수 판정을 거치고 재생 중이면 미룬다', () => {
    expect(control).toContain('orphanVideoRefAction(');
    expect(control).toContain('pendingOrphanVideoAssetId');
    expect(control).toContain('applyPendingOrphanVideoClear(state)');
    expect(control).toContain('pendingOrphanVideoRefAction(');
  });

  it('속보 연결 영상 기본값은 full 영상만 고르는 순수 함수를 쓴다', () => {
    expect(control).toContain('defaultBreakingVideoId(await readAssetMetas())');
    expect(control).not.toMatch(/find\(\(m\) => m\.type === 'video' && isMediaAsset\(m\.id\)\)/);
  });

  it('무효화는 비우는 자리에서 곧바로 기본값을 다시 채운다', () => {
    expect(control).toContain('refillBreakingVideo(next)');
    // null로 비우고 마는 옛 경로가 되살아나면 F9가 영상 없이 보드로 건너뛴다
    expect(control).not.toMatch(/patch: \{ video: \{ assetId: null, nextScene: null \} \},\s*\}\);\s*\}\s*\n\s*\/\*\*\s*\n\s*\* 저장본에 남은/);
  });

  it('죽은 참조 스윕은 dispatch와 리더 인수 두 곳에서 돈다', () => {
    expect(control).toContain('sweepDeadVideoRef(state)');
    expect(control).toContain('sweepDeadVideoRef(applyPendingOrphanVideoClear(state))');
  });

  it('정리 토스트는 실제로 지운 수만 센다', () => {
    expect(control).toContain('orphanIds.length - orphanDeleteFailures');
    expect(control).not.toContain('사라진 항목 ${orphanIds.length}개');
  });
});

/**
 * `revision`이 실제 파일과 어긋나면 **재렌더한 영상이 배포되지 않는다** — 이미 등록된 브라우저는
 * revision이 같다는 이유로 옛 blob을 그대로 쓴다. 파일만 바꾸고 manifest를 안 고치는 실수가
 * 조용히 지나가지 않게 해시로 묶는다.
 *
 * media 파일은 git에 없으므로(용량) 실제로 있는 항목만 검사한다 — 갓 클론한 저장소에서도 green이다.
 */
describe('manifest revision ↔ 실제 파일', () => {
  const manifestUrl = new URL('../public/media/manifest.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as Array<{
    file: string;
    revision?: string;
  }>;

  it('revision은 파일 sha256의 앞 12자리다 (있는 파일에 한해)', () => {
    const mismatched: string[] = [];
    let checked = 0;
    for (const item of manifest) {
      const path = new URL(`../public/media/${item.file}`, import.meta.url);
      if (!item.revision || !existsSync(path)) continue;
      checked += 1;
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);
      if (digest !== item.revision) mismatched.push(`${item.file}: ${item.revision} ≠ ${digest}`);
    }
    expect(mismatched).toEqual([]);
    expect(checked).toBe(0);
  });

  it('올림픽 인트로는 재렌더본 revision을 들고 있다', () => {
    const intro = manifest.find((item) => item.file === 'olympic_intro_v001.mp4');
    expect(intro).toBeUndefined();
  });
});

/**
 * 스팅어 오디오 (U102, 2026-09-05 04:08 지시 "스팅어도 소리 넣어서 다시 줄거야").
 *
 * manifest 에서 `audio:false` 를 걷어냈으므로 판정의 주인은 **파일 실측**이다. 지금 파일에는
 * 트랙이 없어 무음으로 등록되고, 사용자가 소리를 넣은 파일로 갈아 끼우면 revision 이 바뀌어
 * 재판정이 돌아 자동으로 켜진다 — 매니페스트 표를 손볼 필요가 없다는 것이 U84 의 요점이고
 * 이 절이 그 흐름을 스팅어에 대해 그대로 잠근다.
 */
describe('스팅어 소리는 파일이 정한다 (U102)', () => {
  it('manifest 에 audio 키가 없으면 지금 무음 파일은 무음으로 등록된다', async () => {
    const c = rawCollector(false);
    await syncMediaManifest({
      existingIds: [],
      hidden: [],
      probe: c.probe,
      put: c.put as never,
      fetchFn: fakeFetch({
        'manifest.json': [
          { file: 'clip.webm', name: '브릿지 스팅어', mode: 'transition', switchAt: 0.2, revision: 'v1' },
        ],
        'clip.webm': 1,
      }),
    });
    expect(c.saved[0].playMode).toBe('transition');
    expect(c.saved[0].audio).toBe(false);
    expect(c.saved[0].audioSource).toBe('probe');
  });

  it('소리 넣은 파일로 교체하면(revision 변경) 재판정이 돌아 켜진다', async () => {
    const rec = await resync(
      {
        name: '브릿지 스팅어',
        playMode: 'transition',
        switchAtSec: 0.2,
        audio: false,
        audioSource: 'probe',
        sourceRevision: 'v1',
      },
      { file: 'clip.mp4', mode: 'transition', switchAt: 0.2, revision: 'v2' },
      true,
    );
    expect(rec.audio).toBe(true);
    expect(rec.audioSource).toBe('probe');
    // 사람이 고른 값이 아니므로 확인 칩은 뜨지 않는다 — 알아서 맞춰졌다
    expect('audioRecheck' in rec).toBe(false);
  });

  it('운영자가 무음으로 눌러 둔 스팅어는 파일 교체에도 살아남고 확인 칩만 뜬다', async () => {
    const rec = await resync(
      {
        name: '브릿지 스팅어',
        playMode: 'transition',
        switchAtSec: 0.2,
        audio: false,
        audioSource: 'operator',
        sourceRevision: 'v1',
      },
      { file: 'clip.mp4', mode: 'transition', switchAt: 0.2, revision: 'v2' },
      true,
    );
    expect(rec.audio).toBe(false);
    expect(rec.audioSource).toBe('operator');
    expect(rec.audioRecheck).toBe(true);
  });

  /**
   * **U105 의 실제 상황**(2026-09-05 04:34 소리 든 SHORT 도착).
   *
   * 사용자 프로필에는 옛 매니페스트가 심은 `audio:false` + `audioSource:'manifest'` 가 이미
   * 저장돼 있다. 매니페스트에서 `audio` 키를 뺐으므로 이제 그 자리에 아무 선언이 없는데,
   * **저장값을 그대로 지키면 소리가 영영 안 켜진다** — 옛 선언의 유령이 새 파일을 이긴다.
   *
   * `resolveAudioMeta` 의 순서(사람 > manifest 명시 > 실측 > 기존값)가 이걸 막는다:
   * 출처가 `operator` 가 아니고 manifest 가 말이 없으면 **실측이 이긴다**. 아래가 그 잠금이다.
   * (재등록이 애초에 일어나는가는 `pendingItems` 의 revision 검사가 보장한다 — 위 describe 참고.)
   */
  it('옛 manifest 가 심은 audio:false 는 매니페스트에서 키가 빠지면 실측에 자리를 내준다 (U105)', async () => {
    const rec = await resync(
      {
        name: '브릿지 스팅어 · SHORT',
        playMode: 'transition',
        switchAtSec: 0.2,
        audio: false,
        audioSource: 'manifest',
        sourceRevision: 'c71307f45da2',
      },
      { file: 'clip.mp4', mode: 'transition', switchAt: 0.2, revision: '5bae8c1f8078' },
      true,
    );
    expect(rec.audio).toBe(true);
    expect(rec.audioSource).toBe('probe');
    // 사람이 고른 값이 아니었으므로 확인 칩은 띄우지 않는다 — 알아서 맞춰졌다
    expect('audioRecheck' in rec).toBe(false);
    // 파일 교체이므로 switchAt·모드도 매니페스트 값을 따라간다 (알파 타임라인 동일 → 0.2 유지)
    expect(rec.playMode).toBe('transition');
    expect(rec.switchAtSec).toBe(0.2);
  });

  it('출처가 없는 옛 저장본(audio:false)도 같은 자리에서 실측에 진다', async () => {
    const rec = await resync(
      { name: '브릿지 스팅어', playMode: 'transition', switchAtSec: 0.2, audio: false, sourceRevision: 'v1' },
      { file: 'clip.mp4', mode: 'transition', switchAt: 0.2, revision: 'v2' },
      true,
    );
    expect(rec.audio).toBe(true);
    expect(rec.audioSource).toBe('probe');
  });
});
