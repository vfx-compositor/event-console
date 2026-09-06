/**
 * 현장 사진 슬라이드쇼 — 순수 함수 모음 (계획 §2)
 *
 * 왜 별도 모듈인가: vitest 환경이 `environment: 'node'`라 DOM 테스트가 없다.
 * 재생 순서·중복 판정·치수 계산·EXIF 파싱을 전부 여기로 빼면 흡수 파이프라인(`photo-intake.ts`)과
 * display 렌더(`display.ts`)에는 "브라우저 API를 부르는 껍데기"만 남아 검증면이 좁아진다.
 *
 * 이 파일은 **worker-safe**하다 — DOM·IndexedDB·window를 참조하지 않는다.
 * (초기 흡수가 버벅이면 다운스케일 단계만 Worker로 옮길 수 있게 열어 둔 여지다.)
 */

import type { PhotoMeta, PhotoOrder, SceneId } from './types';

/** 다운스케일 후 긴 변 상한 (송출용 원본) */
export const PHOTO_LONG_EDGE = 1920;
/** 썸네일 긴 변 (조작 패널 그리드용) */
export const PHOTO_THUMB_LONG_EDGE = 320;

export const PHOTO_INTERVAL_MIN = 2;
export const PHOTO_INTERVAL_MAX = 30;
export const PHOTO_INTERVAL_DEFAULT = 5;

export const PHOTO_ORDERS: PhotoOrder[] = ['time', 'random'];

// ---------------------------------------------------------------- 파일 신원 → 결정적 id

/**
 * 파일 신원 키 = **사진 id 그 자체**. 같은 파일이면 재부팅·재선택·다른 경로에서도 같은 값.
 *
 * **키를 다시 해시해 id로 줄이지 않는다** (계획 §2의 `photoIdFromKey`는 폐기했다).
 * 32bit 해시가 충돌하면 나중 사진이 "이미 있는 id"로 판정돼 **조용히 버려지는데**, 현장에서는
 * 그 한 장이 사라진 것을 알아챌 방법이 없다. 500건에 +20KB를 내고 충돌 가능성을 0으로 만든다.
 * `bytes`·`lastModified`는 항상 숫자라 파일명에 `|`가 들어가도 뒤에서부터 읽으면 모호하지 않다.
 *
 * 내용 해시가 아니라 (이름, 크기, 수정시각) 조합인 이유: 200장을 3초마다 전부 읽어 해시할 수
 * 없다(§3-2의 이름 우선 필터와 같은 이유). 세 값이 모두 같은 서로 다른 사진은 현장에서 나오지 않는다.
 */
export function photoKey(name: string, bytes: number, lastModified: number): string {
  const n = typeof name === 'string' ? name : '';
  const b = Number.isFinite(bytes) ? Math.trunc(bytes) : 0;
  const m = Number.isFinite(lastModified) ? Math.trunc(lastModified) : 0;
  return `${n}|${b}|${m}`;
}

/** djb2(xor 변형) — 32bit unsigned */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** sdbm — 32bit unsigned. djb2와 섞어 64bit급 id를 만든다 */
function sdbm(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (s.charCodeAt(i) + (h << 6) + (h << 16) - h) >>> 0;
  return h >>> 0;
}

// ---------------------------------------------------------------- 치수 · 확장자
//
// (위의 `djb2`·`sdbm`은 **Ken Burns 시드 전용**이다 — id 생성에는 쓰지 않는다. `photoKey` 주석 참고.)

/**
 * 긴 변을 `max`에 맞춘 정수 치수.
 *
 * **원본이 이미 작으면 확대하지 않는다** — 확대는 용량만 늘리고 화질은 그대로다.
 */
export function fitLongEdge(w: number, h: number, max: number): { w: number; h: number } {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { w: 0, h: 0 };
  const rw = Math.max(1, Math.round(w));
  const rh = Math.max(1, Math.round(h));
  if (!Number.isFinite(max) || max <= 0) return { w: rw, h: rh };
  const long = Math.max(w, h);
  if (long <= max) return { w: rw, h: rh };
  const limit = Math.max(1, Math.round(max));
  const s = max / long;
  return w >= h
    ? { w: limit, h: Math.max(1, Math.round(h * s)) }
    : { w: Math.max(1, Math.round(w * s)), h: limit };
}

/**
 * 확장자 판정.
 * - `'image'` — Chrome이 디코드할 수 있는 형식
 * - `'heic'` — 아이폰 기본 포맷. **Chrome은 디코드하지 못한다** → 건너뛰고 패널에 안내한다
 * - `null` — 사진이 아니다(카운트도 하지 않는다)
 */
export function photoFileKind(name: string): 'image' | 'heic' | null {
  if (typeof name !== 'string') return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp') return 'image';
  if (ext === 'heic' || ext === 'heif') return 'heic';
  return null;
}

// ---------------------------------------------------------------- 재생 순서

/** mulberry32 — 시드 하나로 재현되는 난수열 (테스트 가능한 셔플의 전제) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 시간순 비교 — 동률이면 name → id로 tiebreak해 **항상 결정적**이다 */
function byTakenAt(a: PhotoMeta, b: PhotoMeta): number {
  const at = num(a.takenAt);
  const bt = num(b.takenAt);
  if (at !== bt) return at - bt;
  const an = typeof a.name === 'string' ? a.name : '';
  const bn = typeof b.name === 'string' ? b.name : '';
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * "이 사진이 지금 송출 대상인가" — **송출 여부 판정의 유일한 정의**.
 *
 * `unlocked === false`면 `p2 === true`인 사진(2부 대목에서 찍힌 것)을 `hidden`과 똑같이 뺀다.
 * 1부 화면에 2부 현장 사진이 한 장이라도 뜨면 그 자체가 스포일러라, 이 판정은 display의
 * 렌더 분기가 아니라 여기 한 곳에 둔다(빠뜨릴 자리를 하나로 줄인다).
 *
 * `photoQueue`(재생 큐)와 조작 패널의 `표시 N`(개수)이 **같은 술어**를 쓰게 하려고 따로 뺐다.
 * 개수를 세려고 큐를 통째로 만들면 패널 렌더마다 500장을 정렬하게 된다 — 정렬 없이 세려면
 * 판정만 빌려 쓸 수 있어야 한다.
 */
export function isPhotoPlayable(p: PhotoMeta | null | undefined, unlocked: boolean): boolean {
  if (!p || typeof p.id !== 'string' || !p.id) return false;
  if (p.hidden) return false;
  return unlocked || p.p2 !== true;
}

/**
 * 송출할 사진 id 목록 — `isPhotoPlayable`로 거른 뒤 정렬.
 *
 * `'random'`도 **시간순을 밑바탕으로** 섞는다: 입력 배열의 순서가 달라도 같은 집합·같은 seed면
 * 같은 순열이 나온다(상태 방송 순서에 재생이 흔들리지 않게).
 * seed는 사이클 번호를 쓴다 → 한 바퀴 안에서는 고정, 루프마다 다시 섞인다.
 */
export function photoQueue(
  items: readonly PhotoMeta[],
  order: PhotoOrder,
  seed: number,
  unlocked: boolean,
): string[] {
  const shown = (Array.isArray(items) ? items : [])
    .filter((p) => isPhotoPlayable(p, unlocked))
    .sort(byTakenAt);
  const ids = shown.map((p) => p.id);
  if (order !== 'random' || ids.length < 2) return ids;

  const rnd = mulberry32((Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = ids[i];
    ids[i] = ids[j];
    ids[j] = tmp;
  }
  return ids;
}

/** 운영 검수 목록은 표시 사진을 먼저, 비파괴 제외(hidden) 사진을 나중에 안정 정렬한다. */
export function photoGridOrder(items: readonly PhotoMeta[]): PhotoMeta[] {
  const source = Array.isArray(items) ? items : [];
  return [...source.filter((item) => !item.hidden), ...source.filter((item) => item.hidden)];
}

/** Delete로 현재 사진을 제외한 뒤 이어서 검수할 다음 표시 사진(끝에서는 처음으로 wrap). */
export function nextPhotoFocusAfterHide(
  items: readonly PhotoMeta[],
  currentId: string,
): string | null {
  const shown = photoGridOrder(items).filter((item) => !item.hidden);
  const index = shown.findIndex((item) => item.id === currentId);
  if (index < 0 || shown.length < 2) return null;
  return shown[(index + 1) % shown.length].id;
}

/** 대기 배경은 매번 새 인상을 주도록 운영자가 고른 사진 씬 순서와 무관하게 random을 쓴다. */
export function photoOrderForScene(scene: SceneId, configured: PhotoOrder): PhotoOrder {
  return scene === 'standby' ? 'random' : configured;
}

/** 같은 밀리초에 연속 진입해도 이전 값 자체를 entropy에 섞어 다른 세션 seed를 만든다. */
export function nextPhotoSessionSeed(current: number, entropy: number): number {
  const prev = (Number.isFinite(current) ? Math.trunc(current) : 0) >>> 0;
  let value = (prev + 0x9e3779b9 + ((Number.isFinite(entropy) ? Math.trunc(entropy) : 0) >>> 0)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
  value = (value ^ (value >>> 15)) >>> 0;
  if (value === prev) value = (value + 0x6d2b79f5) >>> 0;
  return value || 1;
}

/**
 * 다음 사진. 위치는 **인덱스가 아니라 id로** 추적한다 — 재생 중 새 사진이 편입돼도 점프가 없다.
 *
 * `prevQueue`(선택)는 "현재 사진이 큐에서 사라진 경우"(숨김·삭제)에 **같은 자리의 다음**을 찾기
 * 위한 직전 큐다. 없으면 큐의 처음으로 되돌아간다. 계획 §2 시그니처(3인자)와 호환된다.
 */
export function advancePhoto(
  queue: readonly string[],
  currentId: string | null,
  cycle: number,
  prevQueue?: readonly string[],
): { id: string | null; cycle: number } {
  const q = Array.isArray(queue) ? queue : [];
  const c = Number.isFinite(cycle) ? Math.trunc(cycle) : 0;
  if (!q.length) return { id: null, cycle: c };
  if (currentId === null) return { id: q[0], cycle: c };

  const idx = q.indexOf(currentId);
  if (idx >= 0) {
    const next = idx + 1;
    return next >= q.length ? { id: q[0], cycle: c + 1 } : { id: q[next], cycle: c };
  }

  // 현재 사진이 큐에서 사라졌다 → 직전 큐에서 "그 자리 다음으로 아직 살아 있는 사진"을 찾는다
  if (prevQueue && prevQueue.length) {
    const p = prevQueue.indexOf(currentId);
    if (p >= 0) {
      for (let k = 1; k <= prevQueue.length; k++) {
        const j = p + k;
        const wrapped = j >= prevQueue.length;
        const cand = prevQueue[j % prevQueue.length];
        if (q.indexOf(cand) >= 0) return { id: cand, cycle: wrapped ? c + 1 : c };
      }
    }
  }
  return { id: q[0], cycle: c };
}

// ---------------------------------------------------------------- EXIF

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_DATETIME = 0x0132;

/**
 * `"YYYY:MM:DD HH:MM:SS"` → epoch ms.
 *
 * EXIF의 이 필드에는 타임존이 없다 → **로컬 시각**으로 해석한다(찍은 사람의 시계 그대로).
 * `0000:00:00 00:00:00` 같은 미설정 placeholder는 null.
 */
function parseExifDateTime(s: string): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = Number(m[6]);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || sec > 60) return null;
  const t = new Date(y, mo - 1, d, h, mi, Math.min(59, sec)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * JPEG 앞부분(APP1)에서 촬영 시각을 읽는다. 없거나 손상되면 **null** (절대 throw하지 않는다).
 *
 * `file.lastModified`는 AirDrop·복사 과정에서 "옮긴 시각"으로 덮이므로 시간순 정렬이
 * 촬영 순서와 어긋난다 → EXIF DateTimeOriginal을 우선으로 삼는다(계획 §10 Q2).
 * 앞 64KB만 넘겨도 동작하도록 **모든 접근에 경계 검사**를 건다(잘린 세그먼트 = null).
 */
export function readExifTakenAt(head: Uint8Array | ArrayBuffer): number | null {
  try {
    const bytes = head instanceof Uint8Array ? head : new Uint8Array(head);
    const len = bytes.length;
    if (len < 12) return null;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // SOI가 아니면 JPEG가 아니다

    let off = 2;
    while (off + 4 <= len) {
      if (bytes[off] !== 0xff) {
        off++; // fill/정렬 이탈 — 다음 0xFF까지 흘려보낸다
        continue;
      }
      const marker = bytes[off + 1];
      if (marker === 0xff) {
        off++;
        continue;
      }
      // 길이 필드가 없는 마커
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      // SOS/EOI = 메타 구간 끝
      if (marker === 0xda || marker === 0xd9) return null;

      const segLen = (bytes[off + 2] << 8) | bytes[off + 3];
      if (segLen < 2) return null;
      if (marker === 0xe1 && off + 10 <= len && isExifHeader(bytes, off + 4)) {
        const v = readTiffDateTime(bytes, off + 10);
        if (v !== null) return v;
      }
      off += 2 + segLen;
    }
    return null;
  } catch {
    return null;
  }
}

function isExifHeader(b: Uint8Array, p: number): boolean {
  return (
    b[p] === 0x45 && b[p + 1] === 0x78 && b[p + 2] === 0x69 && b[p + 3] === 0x66 && b[p + 4] === 0x00
  );
}

function readTiffDateTime(bytes: Uint8Array, tiff: number): number | null {
  const len = bytes.length;
  if (tiff + 8 > len) return null;
  const le = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const be = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!le && !be) return null;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number): number | null => (p + 2 <= len ? dv.getUint16(p, le) : null);
  const u32 = (p: number): number | null => (p + 4 <= len ? dv.getUint32(p, le) : null);

  if (u16(tiff + 2) !== 42) return null;
  const ifd0Rel = u32(tiff + 4);
  if (ifd0Rel === null) return null;

  /** IFD에서 원하는 태그의 엔트리 시작 위치를 모은다 */
  const scan = (base: number, want: readonly number[]): Map<number, number> => {
    const out = new Map<number, number>();
    const count = u16(base);
    if (count === null || count > 512) return out;
    for (let i = 0; i < count; i++) {
      const entry = base + 2 + i * 12;
      if (entry + 12 > len) break;
      const tag = u16(entry);
      if (tag !== null && want.includes(tag) && !out.has(tag)) out.set(tag, entry);
    }
    return out;
  };

  const ascii = (entry: number): string | null => {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    if (type !== 2 || count === null || count === 0 || count > 64) return null;
    let data = entry + 8;
    if (count > 4) {
      const rel = u32(entry + 8);
      if (rel === null) return null;
      data = tiff + rel;
    }
    if (data < 0 || data + count > len) return null;
    let s = '';
    for (let i = 0; i < count; i++) {
      const c = bytes[data + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const ifd0 = scan(tiff + ifd0Rel, [TAG_EXIF_IFD, TAG_DATETIME]);

  const exifPtr = ifd0.get(TAG_EXIF_IFD);
  if (exifPtr !== undefined) {
    const rel = u32(exifPtr + 8);
    if (rel !== null) {
      const sub = scan(tiff + rel, [TAG_DATETIME_ORIGINAL, TAG_DATETIME_DIGITIZED]);
      for (const tag of [TAG_DATETIME_ORIGINAL, TAG_DATETIME_DIGITIZED]) {
        const entry = sub.get(tag);
        if (entry === undefined) continue;
        const s = ascii(entry);
        const t = s ? parseExifDateTime(s) : null;
        if (t !== null) return t;
      }
    }
  }

  // 촬영 시각이 없으면 IFD0의 DateTime(파일 수정 시각과 달리 카메라가 쓴 값)이라도 쓴다
  const dt = ifd0.get(TAG_DATETIME);
  if (dt !== undefined) {
    const s = ascii(dt);
    const t = s ? parseExifDateTime(s) : null;
    if (t !== null) return t;
  }
  return null;
}

// ---------------------------------------------------------------- Ken Burns

export interface KenBurns {
  /** 시작 배율 */
  fromScale: number;
  /** 끝 배율 */
  toScale: number;
  /** 끝 지점 가로 이동 — **레이어 크기에 대한 %** (translate(dx%, dy%)) */
  dx: number;
  /** 끝 지점 세로 이동 (%) */
  dy: number;
}

export const KEN_BURNS_MAX_SCALE = 1.15;

/** 소수 3자리 — 값 자체를 0 쪽으로 자른다(경계를 넘지 않기 위해) */
function trunc3(v: number): number {
  return Math.trunc(v * 1000) / 1000;
}

/**
 * id에서 파생된 결정적 Ken Burns — 같은 사진은 늘 같게 움직인다.
 *
 * 이동량은 **작은 쪽 배율**이 만드는 여백 안으로 제한한다(`(scale-1)/2` × 100%).
 * 그래서 어느 시점에도 확대된 이미지 바깥이 드러나지 않는다.
 */
export function kenBurnsFor(id: string): KenBurns {
  const key = typeof id === 'string' ? id : '';
  // 두 해시를 그냥 XOR하면 `p0`·`p1`처럼 짧고 비슷한 id에서 서로 상쇄돼 시드가 뭉친다
  // (50개 중 20개만 남는 것을 테스트가 잡았다) → 한쪽을 곱셈으로 흩뜨린 뒤 섞는다.
  const rnd = mulberry32((Math.imul(djb2(key), 0x85ebca6b) ^ sdbm(key)) >>> 0);
  const fromScale = trunc3(1 + rnd() * 0.04); // 1.000 ~ 1.040
  const toScale = trunc3(1.06 + rnd() * 0.09); // 1.060 ~ 1.150
  const bound = ((Math.min(fromScale, toScale) - 1) / 2) * 100;
  const dx = trunc3((rnd() * 2 - 1) * bound);
  const dy = trunc3((rnd() * 2 - 1) * bound);
  return { fromScale, toScale, dx, dy };
}

// ---------------------------------------------------------------- 설정 정규화 · 용량

/** 표시 시간 클램프 (2~30초). 숫자가 아니면 기본 5 */
export function clampIntervalSec(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return PHOTO_INTERVAL_DEFAULT;
  return Math.min(PHOTO_INTERVAL_MAX, Math.max(PHOTO_INTERVAL_MIN, v));
}

/** 알 수 없는 값은 `'time'` */
export function normalizePhotoOrder(v: unknown): PhotoOrder {
  return v === 'random' ? 'random' : 'time';
}

/**
 * 상태에 실릴 사진 메타의 직렬화 바이트 추정 (localStorage 5MB 예산 감시용).
 *
 * 실제 직렬화 길이를 쓴다 — 500건이라도 비용이 밀리초 미만이고, 추정식보다 정확하다.
 */
export function estimatePhotosBytes(items: readonly PhotoMeta[]): number {
  try {
    return JSON.stringify(items ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * 사진 메타에 허용하는 상태 예산.
 *
 * §1-6 재계산: 500건이면 `estimatePhotosBytes`가 재는 **직렬화 길이**가 대략 7만 자다.
 * localStorage는 문자열을 UTF-16으로 담으므로 실제 차지하는 바이트는 그 두 배 —
 * **≈145KB, 5MB 한도의 약 2.9%**다(원래 주석의 `75KB → 1.5%`는 길이를 바이트로 착각한 값이다.
 * 파일명 길이에 따라 위아래로 움직인다). 여기서는 그 5MB 중 **사진 메타 몫**만 512KB로
 * 끊어 놓고, `photosBudgetRatio`가 이 몫에 대한 사용률을 패널에 띄운다.
 */
export const PHOTOS_STATE_BUDGET_BYTES = 512 * 1024;

/** 예산 대비 사용률 0~1+ (패널 상태 줄이 경고를 띄우는 근거) */
export function photosBudgetRatio(items: readonly PhotoMeta[]): number {
  return estimatePhotosBytes(items) / PHOTOS_STATE_BUDGET_BYTES;
}
