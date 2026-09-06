import { describe, expect, it } from 'vitest';
import {
  advancePhoto,
  clampIntervalSec,
  estimatePhotosBytes,
  fitLongEdge,
  isPhotoPlayable,
  kenBurnsFor,
  normalizePhotoOrder,
  nextPhotoFocusAfterHide,
  nextPhotoSessionSeed,
  photoFileKind,
  photoGridOrder,
  photoKey,
  photoOrderForScene,
  photoQueue,
  readExifTakenAt,
  PHOTOS_STATE_BUDGET_BYTES,
  PHOTO_LONG_EDGE,
  PHOTO_THUMB_LONG_EDGE,
} from './photos';
import {
  applyUpgrade,
  createDbNegotiation,
  DB_BLOCKED_MESSAGE,
  DB_STORES,
  STORE_ASSETS,
  STORE_KV,
  STORE_PHOTOS,
  STORE_PHOTO_THUMBS,
  STORE_SNAPSHOTS,
} from './db';
import type { PhotoMeta } from './types';

function photo(over: Partial<PhotoMeta> & { id: string }): PhotoMeta {
  return {
    name: `${over.id}.jpg`,
    takenAt: 0,
    addedAt: 0,
    w: 1920,
    h: 1080,
    bytes: 400_000,
    hidden: false,
    p2: false,
    ...over,
  };
}

// ---------------------------------------------------------------- 파일 신원 → id

describe('photoKey — 키가 곧 id다 (해시 없음)', () => {
  it('같은 (이름, 크기, 수정시각)이면 같은 id — 몇 번을 흡수해도 하나다', () => {
    const a = photoKey('IMG_0001.jpg', 2_412_345, 1_756_300_000_000);
    const b = photoKey('IMG_0001.jpg', 2_412_345, 1_756_300_000_000);
    expect(a).toBe(b);
    expect(a).toBe('IMG_0001.jpg|2412345|1756300000000');
  });

  it('셋 중 하나만 달라도 다른 id', () => {
    const base = photoKey('IMG_0001.jpg', 2_412_345, 1_756_300_000_000);
    expect(photoKey('IMG_0002.jpg', 2_412_345, 1_756_300_000_000)).not.toBe(base);
    expect(photoKey('IMG_0001.jpg', 2_412_346, 1_756_300_000_000)).not.toBe(base);
    expect(photoKey('IMG_0001.jpg', 2_412_345, 1_756_300_000_001)).not.toBe(base);
  });

  it('파일명에 구분자가 들어가도 다른 파일과 겹치지 않는다', () => {
    expect(photoKey('a|1', 2, 3)).not.toBe(photoKey('a', 1, 23));
    expect(photoKey('a|1', 2, 3)).toBe('a|1|2|3');
  });

  it('손상된 인자도 결정적으로 처리한다 (throw 금지)', () => {
    expect(photoKey('x.jpg', Number.NaN, 1)).toBe('x.jpg|0|1');
    expect(photoKey('x.jpg', 1.9, 2.9)).toBe('x.jpg|1|2');
  });

  it('500장 규모에서 id 충돌이 없다 — 해시가 아니므로 구조적으로 0이다', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) ids.add(photoKey(`IMG_${i}.jpg`, 1_000_000 + i, 1_700_000_000_000 + i * 1000));
    expect(ids.size).toBe(500);
  });
});

// ---------------------------------------------------------------- 치수

describe('fitLongEdge', () => {
  it('가로가 긴 사진은 가로를 max에 맞춘다', () => {
    expect(fitLongEdge(4000, 3000, PHOTO_LONG_EDGE)).toEqual({ w: 1920, h: 1440 });
    expect(fitLongEdge(3000, 2000, PHOTO_LONG_EDGE)).toEqual({ w: 1920, h: 1280 });
  });

  it('세로가 긴 사진은 세로를 max에 맞춘다', () => {
    expect(fitLongEdge(3024, 4032, PHOTO_LONG_EDGE)).toEqual({ w: 1440, h: 1920 });
  });

  it('정사각형', () => {
    expect(fitLongEdge(2500, 2500, PHOTO_LONG_EDGE)).toEqual({ w: 1920, h: 1920 });
  });

  it('원본이 max보다 작으면 확대하지 않는다', () => {
    expect(fitLongEdge(800, 600, PHOTO_LONG_EDGE)).toEqual({ w: 800, h: 600 });
    expect(fitLongEdge(1920, 1080, PHOTO_LONG_EDGE)).toEqual({ w: 1920, h: 1080 });
  });

  it('극단적인 비율에서도 최소 1px를 지킨다', () => {
    const r = fitLongEdge(10_000, 3, PHOTO_LONG_EDGE);
    expect(r.w).toBe(1920);
    expect(r.h).toBeGreaterThanOrEqual(1);
  });

  it('비율 오차가 1px 이내다', () => {
    for (const [w, h] of [[4032, 3024], [1600, 1200], [2048, 1365], [900, 1600]] as const) {
      const out = fitLongEdge(w, h, PHOTO_THUMB_LONG_EDGE);
      const long = Math.max(w, h);
      const expectW = long <= PHOTO_THUMB_LONG_EDGE ? w : (w * PHOTO_THUMB_LONG_EDGE) / long;
      const expectH = long <= PHOTO_THUMB_LONG_EDGE ? h : (h * PHOTO_THUMB_LONG_EDGE) / long;
      expect(Math.abs(out.w - expectW)).toBeLessThanOrEqual(1);
      expect(Math.abs(out.h - expectH)).toBeLessThanOrEqual(1);
    }
  });

  it('손상된 치수는 0으로 떨어뜨린다(throw 금지)', () => {
    expect(fitLongEdge(0, 100, 1920)).toEqual({ w: 0, h: 0 });
    expect(fitLongEdge(Number.NaN, 100, 1920)).toEqual({ w: 0, h: 0 });
    expect(fitLongEdge(-10, -10, 1920)).toEqual({ w: 0, h: 0 });
  });
});

// ---------------------------------------------------------------- 확장자

describe('photoFileKind', () => {
  it('디코드 가능한 이미지', () => {
    for (const n of ['a.jpg', 'a.jpeg', 'a.png', 'a.webp']) expect(photoFileKind(n)).toBe('image');
  });

  it('대문자 확장자도 같게 본다', () => {
    expect(photoFileKind('IMG_0001.JPG')).toBe('image');
    expect(photoFileKind('IMG_0001.HEIC')).toBe('heic');
  });

  it('HEIC/HEIF는 별도 분류 — Chrome이 디코드하지 못한다', () => {
    expect(photoFileKind('a.heic')).toBe('heic');
    expect(photoFileKind('a.heif')).toBe('heic');
  });

  it('사진이 아닌 것은 null', () => {
    for (const n of ['a.mp4', 'a.txt', 'noext', 'a.', '.gitignore', '']) {
      expect(photoFileKind(n)).toBeNull();
    }
  });

  it('점이 여럿이어도 마지막 확장자로 판정한다', () => {
    expect(photoFileKind('사진 2.복사본.png')).toBe('image');
  });
});

// ---------------------------------------------------------------- 재생 순서

describe('photoQueue', () => {
  const items = [
    photo({ id: 'c', takenAt: 300 }),
    photo({ id: 'a', takenAt: 100 }),
    photo({ id: 'b', takenAt: 200, hidden: true }),
    photo({ id: 'd', takenAt: 400 }),
  ];

  it('숨김은 제외한다', () => {
    expect(photoQueue(items, 'time', 0, true)).toEqual(['a', 'c', 'd']);
  });

  it("'time'은 takenAt 오름차순", () => {
    expect(photoQueue(items, 'time', 0, true)).toEqual(['a', 'c', 'd']);
  });

  it('동률이면 name → id로 결정적 tiebreak', () => {
    const tie = [
      photo({ id: 'z1', name: 'b.jpg', takenAt: 100 }),
      photo({ id: 'z2', name: 'a.jpg', takenAt: 100 }),
      photo({ id: 'z0', name: 'a.jpg', takenAt: 100 }),
    ];
    expect(photoQueue(tie, 'time', 0, true)).toEqual(['z0', 'z2', 'z1']);
  });

  it('입력 배열 순서가 달라도 같은 결과 — 상태 방송 순서에 재생이 흔들리지 않는다', () => {
    const shuffledInput = [items[3], items[0], items[1], items[2]];
    expect(photoQueue(shuffledInput, 'time', 0, true)).toEqual(photoQueue(items, 'time', 0, true));
    expect(photoQueue(shuffledInput, 'random', 7, true)).toEqual(photoQueue(items, 'random', 7, true));
  });

  it("'random'은 같은 seed에 같은 순서, 다른 seed에 다른 순서", () => {
    const many = Array.from({ length: 12 }, (_, i) => photo({ id: `p${i}`, takenAt: i }));
    expect(photoQueue(many, 'random', 1, true)).toEqual(photoQueue(many, 'random', 1, true));
    expect(photoQueue(many, 'random', 1, true)).not.toEqual(photoQueue(many, 'random', 2, true));
  });

  it("'random'은 항상 같은 집합의 순열이다 — 사진이 빠지거나 겹치지 않는다", () => {
    const many = Array.from({ length: 30 }, (_, i) => photo({ id: `p${i}`, takenAt: i }));
    for (const seed of [0, 1, 5, 99, 123456]) {
      const q = photoQueue(many, 'random', seed, true);
      expect(q).toHaveLength(30);
      expect(new Set(q).size).toBe(30);
      expect([...q].sort()).toEqual(photoQueue(many, 'time', 0, true).sort());
    }
  });

  it('2부 잠금 중에는 p2 사진이 큐에 없다 — 1부 화면 스포일러 차단', () => {
    const mixed = [
      photo({ id: 'a', takenAt: 100 }),
      photo({ id: 'p2-shot', takenAt: 200, p2: true }),
      photo({ id: 'c', takenAt: 300 }),
    ];
    expect(photoQueue(mixed, 'time', 0, false)).toEqual(['a', 'c']);
    expect(photoQueue(mixed, 'time', 0, true)).toEqual(['a', 'p2-shot', 'c']);
    // 무작위 순서에서도 같은 규칙
    expect(photoQueue(mixed, 'random', 5, false)).not.toContain('p2-shot');
  });

  it('잠금 중 p2 사진은 숨김과 똑같이 취급된다 (전부 p2면 빈 큐)', () => {
    const onlyP2 = [photo({ id: 'x', p2: true }), photo({ id: 'y', p2: true })];
    expect(photoQueue(onlyP2, 'time', 0, false)).toEqual([]);
    expect(photoQueue(onlyP2, 'time', 0, true)).toEqual(['x', 'y']);
  });

  it('빈 목록·전부 숨김이면 빈 큐', () => {
    expect(photoQueue([], 'time', 0, true)).toEqual([]);
    expect(photoQueue([photo({ id: 'a', hidden: true })], 'random', 3, true)).toEqual([]);
  });
});

describe('사진 검수 그리드', () => {
  it('제외한 사진은 삭제하지 않고 기존 순서를 유지한 채 목록 하단으로 모은다', () => {
    const items = [
      photo({ id: 'hidden-first', hidden: true }),
      photo({ id: 'shown-a' }),
      photo({ id: 'hidden-second', hidden: true }),
      photo({ id: 'shown-b' }),
    ];

    expect(photoGridOrder(items).map((item) => item.id)).toEqual([
      'shown-a',
      'shown-b',
      'hidden-first',
      'hidden-second',
    ]);
  });

  it('Delete로 제외한 뒤 다음 표시 사진에 포커스를 이어 빠르게 검수한다', () => {
    const items = [photo({ id: 'a' }), photo({ id: 'b' }), photo({ id: 'c' })];

    expect(nextPhotoFocusAfterHide(items, 'b')).toBe('c');
    expect(nextPhotoFocusAfterHide(items, 'c')).toBe('a');
    expect(nextPhotoFocusAfterHide([photo({ id: 'only' })], 'only')).toBeNull();
    expect(nextPhotoFocusAfterHide([photo({ id: 'hidden', hidden: true })], 'hidden')).toBeNull();
  });
});

describe('대기화면 사진 세션', () => {
  it('대기화면은 사진 탭의 시간순 설정과 무관하게 무작위 순서를 쓴다', () => {
    expect(photoOrderForScene('standby', 'time')).toBe('random');
    expect(photoOrderForScene('photos', 'time')).toBe('time');
    expect(photoOrderForScene('photos', 'random')).toBe('random');
  });

  it('같은 시각에 연속 진입해도 이전 세션과 다른 seed를 만든다', () => {
    const first = nextPhotoSessionSeed(0, 1234);
    const second = nextPhotoSessionSeed(first, 1234);

    expect(first).not.toBe(0);
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------- 송출 판정(술어) 단일화

describe('isPhotoPlayable', () => {
  it('숨김·잠긴 2부 사진을 뺀다', () => {
    expect(isPhotoPlayable(photo({ id: 'a' }), true)).toBe(true);
    expect(isPhotoPlayable(photo({ id: 'a' }), false)).toBe(true);
    expect(isPhotoPlayable(photo({ id: 'a', hidden: true }), true)).toBe(false);
    expect(isPhotoPlayable(photo({ id: 'p', p2: true }), false)).toBe(false);
    expect(isPhotoPlayable(photo({ id: 'p', p2: true }), true)).toBe(true);
    // 잠금 해제 중이라도 숨김은 그대로 빠진다 (두 축은 독립이다)
    expect(isPhotoPlayable(photo({ id: 'p', p2: true, hidden: true }), true)).toBe(false);
  });

  it('망가진 항목은 조용히 false — 절대 throw하지 않는다', () => {
    expect(isPhotoPlayable(null, true)).toBe(false);
    expect(isPhotoPlayable(undefined, true)).toBe(false);
    expect(isPhotoPlayable(photo({ id: '' }), true)).toBe(false);
    expect(isPhotoPlayable({ id: 123 } as unknown as PhotoMeta, true)).toBe(false);
  });

  it('photoQueue 길이 === filter(isPhotoPlayable) 길이 — 큐와 패널의 `표시 N`이 어긋나지 않는다', () => {
    const mixed = [
      photo({ id: 'a', takenAt: 100 }),
      photo({ id: 'b', takenAt: 200, hidden: true }),
      photo({ id: 'p2-shot', takenAt: 300, p2: true }),
      photo({ id: 'both', takenAt: 400, p2: true, hidden: true }),
      photo({ id: 'c', takenAt: 500 }),
    ];
    for (const unlocked of [true, false]) {
      const expected = mixed.filter((p) => isPhotoPlayable(p, unlocked));
      for (const order of ['time', 'random'] as const) {
        const q = photoQueue(mixed, order, 3, unlocked);
        expect(q).toHaveLength(expected.length);
        expect([...q].sort()).toEqual(expected.map((p) => p.id).sort());
      }
    }
  });

  it('500장에서도 두 경로가 같은 집합을 낸다', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      photo({ id: `p${i}`, takenAt: i, hidden: i % 7 === 0, p2: i % 5 === 0 }),
    );
    for (const unlocked of [true, false]) {
      expect(photoQueue(many, 'time', 0, unlocked)).toHaveLength(
        many.filter((p) => isPhotoPlayable(p, unlocked)).length,
      );
    }
  });
});

describe('advancePhoto', () => {
  const q = ['a', 'b', 'c'];

  it('다음 사진으로 이동한다', () => {
    expect(advancePhoto(q, 'a', 0)).toEqual({ id: 'b', cycle: 0 });
    expect(advancePhoto(q, 'b', 0)).toEqual({ id: 'c', cycle: 0 });
  });

  it('마지막 다음은 첫 항목 + cycle+1', () => {
    expect(advancePhoto(q, 'c', 4)).toEqual({ id: 'a', cycle: 5 });
  });

  it('현재 사진이 없으면(시작) 큐의 첫 항목, cycle은 그대로', () => {
    expect(advancePhoto(q, null, 2)).toEqual({ id: 'a', cycle: 2 });
  });

  it('큐가 비면 null', () => {
    expect(advancePhoto([], 'a', 1)).toEqual({ id: null, cycle: 1 });
    expect(advancePhoto([], null, 0)).toEqual({ id: null, cycle: 0 });
  });

  it('1장짜리 큐는 자기 자신 + cycle+1', () => {
    expect(advancePhoto(['only'], 'only', 0)).toEqual({ id: 'only', cycle: 1 });
  });

  it('현재 사진이 큐에서 사라지면(숨김) 직전 큐 기준 같은 자리의 다음', () => {
    // 재생 중이던 'b'를 숨겼다 → 처음으로 되감지 않고 'c'로 이어진다
    expect(advancePhoto(['a', 'c'], 'b', 0, ['a', 'b', 'c'])).toEqual({ id: 'c', cycle: 0 });
  });

  it('사라진 사진이 직전 큐의 마지막이었으면 한 바퀴를 넘긴 것으로 센다', () => {
    expect(advancePhoto(['a', 'b'], 'c', 2, ['a', 'b', 'c'])).toEqual({ id: 'a', cycle: 3 });
  });

  it('직전 큐가 없으면 큐의 처음으로 안전 복귀한다', () => {
    expect(advancePhoto(q, 'zzz', 1)).toEqual({ id: 'a', cycle: 1 });
  });

  it('재생 중 새 사진이 뒤에 붙어도 현재 위치가 튀지 않는다', () => {
    // 'a' 재생 중에 'd'가 편입 → 다음은 여전히 'b'
    expect(advancePhoto(['a', 'b', 'c', 'd'], 'a', 0, q)).toEqual({ id: 'b', cycle: 0 });
  });
});

// ---------------------------------------------------------------- EXIF

/** DateTimeOriginal 하나만 든 최소 JPEG (APP1 → TIFF → Exif IFD) */
function buildExifJpeg(dt: string, opts: { bigEndian?: boolean; tag?: number } = {}): Uint8Array {
  const le = !opts.bigEndian;
  const tag = opts.tag ?? 0x9003;
  const ascii = `${dt}\0`;
  const tiff = new Uint8Array(44 + ascii.length);
  const dv = new DataView(tiff.buffer);
  tiff[0] = opts.bigEndian ? 0x4d : 0x49;
  tiff[1] = tiff[0];
  dv.setUint16(2, 42, le);
  dv.setUint32(4, 8, le); // IFD0 offset
  dv.setUint16(8, 1, le); // IFD0 엔트리 1개
  dv.setUint16(10, 0x8769, le); // ExifIFDPointer
  dv.setUint16(12, 4, le); // LONG
  dv.setUint32(14, 1, le);
  dv.setUint32(18, 26, le); // Exif IFD 위치
  dv.setUint32(22, 0, le); // 다음 IFD 없음
  dv.setUint16(26, 1, le); // Exif IFD 엔트리 1개
  dv.setUint16(28, tag, le);
  dv.setUint16(30, 2, le); // ASCII
  dv.setUint32(32, ascii.length, le);
  dv.setUint32(36, 44, le); // 값 위치 (4바이트 초과라 오프셋)
  dv.setUint32(40, 0, le);
  for (let i = 0; i < ascii.length; i++) tiff[44 + i] = ascii.charCodeAt(i);

  const head = 'Exif\0\0';
  const segLen = 2 + head.length + tiff.length;
  const out = new Uint8Array(4 + segLen + 2);
  out.set([0xff, 0xd8, 0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff], 0);
  for (let i = 0; i < head.length; i++) out[6 + i] = head.charCodeAt(i);
  out.set(tiff, 6 + head.length);
  out.set([0xff, 0xda], out.length - 2); // SOS
  return out;
}

describe('readExifTakenAt', () => {
  it('DateTimeOriginal을 로컬 시각 epoch ms로 읽는다', () => {
    const bytes = buildExifJpeg('2026:08:27 18:30:45');
    expect(readExifTakenAt(bytes)).toBe(new Date(2026, 7, 27, 18, 30, 45).getTime());
  });

  it('빅엔디안(MM) TIFF도 읽는다', () => {
    const bytes = buildExifJpeg('2026:01:02 03:04:05', { bigEndian: true });
    expect(readExifTakenAt(bytes)).toBe(new Date(2026, 0, 2, 3, 4, 5).getTime());
  });

  it('ArrayBuffer로 넘겨도 같다 (file.slice(0, 65536) 경로)', () => {
    const bytes = buildExifJpeg('2026:08:27 18:30:45');
    const ab = bytes.slice().buffer as ArrayBuffer;
    expect(readExifTakenAt(ab)).toBe(readExifTakenAt(bytes));
  });

  it('DateTimeDigitized만 있으면 그것을 쓴다', () => {
    const bytes = buildExifJpeg('2026:03:04 05:06:07', { tag: 0x9004 });
    expect(readExifTakenAt(bytes)).toBe(new Date(2026, 2, 4, 5, 6, 7).getTime());
  });

  it('EXIF 없는 JPEG → null', () => {
    const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xda]);
    expect(readExifTakenAt(plain)).toBeNull();
  });

  it('PNG 헤더 → null', () => {
    expect(readExifTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBeNull();
  });

  it('placeholder 날짜(0000:00:00)는 null', () => {
    expect(readExifTakenAt(buildExifJpeg('0000:00:00 00:00:00'))).toBeNull();
  });

  it('손상·절단된 바이트에도 throw하지 않고 null', () => {
    const full = buildExifJpeg('2026:08:27 18:30:45');
    for (const cut of [0, 1, 8, 20, 40, full.length - 4]) {
      expect(() => readExifTakenAt(full.slice(0, cut))).not.toThrow();
      expect(readExifTakenAt(full.slice(0, cut))).toBeNull();
    }
    const garbage = full.slice();
    garbage.fill(0xab, 10, 30);
    expect(() => readExifTakenAt(garbage)).not.toThrow();
  });

  it('길이가 0인 세그먼트에도 무한 루프에 빠지지 않는다', () => {
    const evil = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
    expect(readExifTakenAt(evil)).toBeNull();
  });
});

// ---------------------------------------------------------------- Ken Burns

describe('kenBurnsFor', () => {
  const ids = ['pabc0001xyz0001', 'p0000000zzzzzzz', 'photo-42', ''];

  it('같은 id는 늘 같은 움직임', () => {
    for (const id of ids) expect(kenBurnsFor(id)).toEqual(kenBurnsFor(id));
  });

  it('배율이 1.0~1.15 범위이고 확대 방향이다', () => {
    for (const id of ids) {
      const kb = kenBurnsFor(id);
      expect(kb.fromScale).toBeGreaterThanOrEqual(1);
      expect(kb.toScale).toBeLessThanOrEqual(1.15);
      expect(kb.toScale).toBeGreaterThan(kb.fromScale);
    }
  });

  it('이동량이 확대 여백을 넘지 않는다 — 화면 밖이 드러나지 않는다', () => {
    for (let i = 0; i < 200; i++) {
      const kb = kenBurnsFor(`p${i}`);
      const bound = ((Math.min(kb.fromScale, kb.toScale) - 1) / 2) * 100;
      expect(Math.abs(kb.dx)).toBeLessThanOrEqual(bound);
      expect(Math.abs(kb.dy)).toBeLessThanOrEqual(bound);
    }
  });

  it('사진마다 움직임이 다르다', () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(kenBurnsFor(`p${i}`))));
    expect(seen.size).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------- 설정 · 용량

describe('설정 정규화', () => {
  it('intervalSec은 2~30으로 클램프하고, 숫자가 아니면 기본 5', () => {
    expect(clampIntervalSec(5)).toBe(5);
    expect(clampIntervalSec(0.5)).toBe(2);
    expect(clampIntervalSec(999)).toBe(30);
    expect(clampIntervalSec('7')).toBe(5);
    expect(clampIntervalSec(Number.NaN)).toBe(5);
  });

  it("알 수 없는 order는 'time'", () => {
    expect(normalizePhotoOrder('random')).toBe('random');
    expect(normalizePhotoOrder('time')).toBe('time');
    expect(normalizePhotoOrder('zzz')).toBe('time');
    expect(normalizePhotoOrder(undefined)).toBe('time');
  });
});

describe('상태 용량 예산', () => {
  it('사진 메타 500건이 예산의 한 조각에 그친다 (썸네일을 상태에 넣지 않은 근거)', () => {
    const items = Array.from({ length: 500 }, (_, i) =>
      photo({ id: photoKey(`IMG_20260827_1830${i}.jpg`, 400_000 + i, 1_756_000_000_000 + i), name: `IMG_20260827_1830${i}.jpg`, takenAt: 1_756_000_000_000 + i }),
    );
    const bytes = estimatePhotosBytes(items);
    expect(bytes).toBeLessThan(PHOTOS_STATE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(150 * 1024);
  });
});

// ---------------------------------------------------------------- IndexedDB 업그레이드

describe('db 업그레이드 (DB_VERSION 2)', () => {
  function fakeTarget(existing: string[]) {
    const stores = new Set(existing);
    const created: Array<{ name: string; keyPath: string }> = [];
    return {
      stores,
      created,
      target: {
        has: (n: string) => stores.has(n),
        create: (n: string, keyPath: string) => {
          created.push({ name: n, keyPath });
          stores.add(n);
        },
      },
    };
  }

  it('빈 DB에는 다섯 스토어를 모두 만든다', () => {
    const f = fakeTarget([]);
    expect(applyUpgrade(f.target)).toEqual(DB_STORES.map((s) => s.name));
    expect(f.created.map((c) => c.keyPath)).toEqual(['id', 'ts', 'id', 'id', 'k']);
  });

  it('기존 프로필(v1)에는 사진 스토어만 **추가**한다 — assets/snapshots를 건드리지 않는다', () => {
    const f = fakeTarget([STORE_ASSETS, STORE_SNAPSHOTS]);
    expect(applyUpgrade(f.target)).toEqual([STORE_PHOTOS, STORE_PHOTO_THUMBS, STORE_KV]);
    expect(f.created.some((c) => c.name === STORE_ASSETS || c.name === STORE_SNAPSHOTS)).toBe(false);
    expect(f.stores.has(STORE_ASSETS)).toBe(true);
    expect(f.stores.has(STORE_SNAPSHOTS)).toBe(true);
  });

  it('이미 최신이면 아무것도 만들지 않는다 (재실행 안전)', () => {
    const f = fakeTarget(DB_STORES.map((s) => s.name));
    expect(applyUpgrade(f.target)).toEqual([]);
  });
});

describe('db 다중 창 협상 (control 1 + display 2)', () => {
  function spyDeps() {
    const log: string[] = [];
    return {
      log,
      deps: {
        closeConnection: () => log.push('close'),
        resetCache: () => log.push('reset'),
        warn: (m: string) => log.push(`warn:${m}`),
      },
    };
  }

  it('다른 창이 새 버전으로 열면 이 창은 연결을 닫고 캐시를 버린다', () => {
    const s = spyDeps();
    createDbNegotiation(s.deps).versionChange();
    // 닫기가 빠지면 다른 창의 업그레이드가 영원히 막힌다
    expect(s.log).toContain('close');
    // 캐시가 남으면 닫힌 연결을 계속 돌려준다
    expect(s.log.indexOf('reset')).toBeGreaterThan(s.log.indexOf('close'));
  });

  it('연결이 밖에서 끊기면 캐시만 버린다 (닫기를 다시 부르지 않는다)', () => {
    const s = spyDeps();
    createDbNegotiation(s.deps).closed();
    expect(s.log).toEqual(['reset']);
  });

  it('업그레이드가 막히면 사용자가 읽을 수 있는 에러 + 재시도 가능 상태로 만든다', () => {
    const s = spyDeps();
    const err = createDbNegotiation(s.deps).blocked();
    expect(err.message).toBe(DB_BLOCKED_MESSAGE);
    expect(err.message).toMatch(/새로고침/);
    expect(s.log).toContain('reset'); // 캐시를 버려야 다른 창이 닫힌 뒤 다시 시도된다
    expect(s.log).toContain(`warn:${DB_BLOCKED_MESSAGE}`);
    expect(s.log).not.toContain('close'); // 열리지도 않은 연결을 닫을 수는 없다
  });
});
