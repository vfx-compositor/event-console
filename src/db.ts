/**
 * IndexedDB — 영상/이미지 Blob(assets)과 상태 스냅샷(snapshots).
 *
 * 왜 IndexedDB인가: localStorage는 5MB·문자열 전용이라 영상 보관이 불가능하고,
 * 매 변경 저장(P4)에 스냅샷 이력을 남기려면 용량이 필요하다.
 * display 창은 같은 오리진이므로 assetId만 받아 Blob을 직접 읽는다 (창 간 Blob 전송 불필요).
 */

import type { AppState, AudioSource, SceneId, VideoPlayMode } from './types';

const DB_NAME = 'nsdh-console';
/**
 * 1 → 2: 현장 사진용 스토어 3개 추가 (`photos`/`photoThumbs`/`kv`).
 * 업그레이드는 **추가만** 한다 — 기존 프로필의 `assets`/`snapshots`가 날아가면 행사 자료가 사라진다.
 */
const DB_VERSION = 2;
export const STORE_ASSETS = 'assets';
export const STORE_SNAPSHOTS = 'snapshots';
export const STORE_PHOTOS = 'photos';
export const STORE_PHOTO_THUMBS = 'photoThumbs';
export const STORE_KV = 'kv';
const MAX_SNAPSHOTS = 200;

/** 이 DB가 가져야 할 스토어 전부 — `applyUpgrade()`가 유일한 근거로 삼는다 */
export const DB_STORES: ReadonlyArray<{ name: string; keyPath: string }> = [
  { name: STORE_ASSETS, keyPath: 'id' },
  { name: STORE_SNAPSHOTS, keyPath: 'ts' },
  { name: STORE_PHOTOS, keyPath: 'id' },
  { name: STORE_PHOTO_THUMBS, keyPath: 'id' },
  { name: STORE_KV, keyPath: 'k' },
];

/**
 * `onupgradeneeded`의 순수한 알맹이 — IndexedDB 없이도 테스트할 수 있게 분리했다.
 *
 * 없는 스토어만 만들고 **기존 스토어는 손대지 않는다**(삭제·재생성 금지).
 * 반환값은 실제로 만든 스토어 이름 목록.
 */
export interface UpgradeTarget {
  has(name: string): boolean;
  create(name: string, keyPath: string): void;
}

export function applyUpgrade(target: UpgradeTarget): string[] {
  const created: string[] = [];
  for (const { name, keyPath } of DB_STORES) {
    if (target.has(name)) continue;
    target.create(name, keyPath);
    created.push(name);
  }
  return created;
}

export interface AssetRecord {
  id: string;
  name: string;
  type: 'video' | 'image';
  /** 'logo' = 팀 로고(영상·에셋 목록에 노출하지 않는다). 기본은 'media'. */
  kind?: 'media' | 'logo';
  mime: string;
  size: number;
  blob: Blob;
  addedAt: number;
  /** 영상 길이(초) */
  durationSec?: number;
  /** 첫 프레임 썸네일 dataURL (160px) */
  thumbDataUrl?: string;
  /** 재생이 끝나면 넘어갈 씬 */
  nextScene?: SceneId | null;
  /** 풀스크린 영상, 씬 교체 전환, 또는 현재 씬 위 알파 오버레이 */
  playMode?: VideoPlayMode;
  /** 전환 오버레이가 underlying scene을 교체할 재생 시각 */
  switchAtSec?: number;
  /** 큐시트에서 이 항목 다음에 재생 (기본 큐 항목 id) */
  cueAfter?: string | null;
  /** 목록 정렬 순서 */
  order?: number;
  /** 등록 시 브라우저가 열지 못한 파일 */
  probeFailed?: boolean;
  /** media manifest의 동일 파일 교체 여부를 판별하는 버전 키 */
  sourceRevision?: string;
  /** full 모드 전용 — 재생 시 소리를 낸다. 기본 true. transition 모드에서는 무시(항상 무음) */
  audio?: boolean;
  /** `audio` 를 누가 정했는가 — 사람·manifest·파일 실측(probe) 중 어디서 온 값인지 (U84) */
  audioSource?: AudioSource;
  /** 파일이 교체됐는데 사람이 고른 소리 설정을 지킨 상태 — 카드에 확인 칩을 띄운다 (U84) */
  audioRecheck?: boolean;
  /** full 모드 전용 — 재생 종료 후 마지막 프레임을 유지한다 */
  holdEndFrame?: boolean;
  /**
   * full 모드 전용 — 재생과 함께 데려오는 배경 곡 (U124, 음악 라이브러리 id).
   * `undefined`(미지정, 대본 표가 한 번 승격) / `null`(운영자가 비움) / 문자열(그 곡)을 구분한다.
   */
  musicTrackId?: string | null;
}

export interface SnapshotRecord {
  ts: number;
  json: string;
}

/**
 * 다른 창이 옛 버전 연결을 쥐고 있어 업그레이드가 시작조차 못 한 상태.
 *
 * **정상 운영에서 일어난다**: control 1 + display 1~2가 동시에 열린 채로 새 빌드를 배포하고
 * 창을 하나씩 새로고침하면, 아직 v1 연결을 쥔 창 때문에 v2 `open`이 영원히 pending으로 남는다.
 * 이때 에러도 안 나고 화면도 안 죽고 **영상·로고만 조용히 안 뜬다** → 반드시 표면화한다.
 */
export const DB_BLOCKED_MESSAGE =
  'IndexedDB 업그레이드가 다른 창에 막혔습니다 — 열려 있는 조작·출력 창을 모두 새로고침하세요.';

/**
 * **M4** `onblocked` 직후 재시도를 잠그는 시간(ms).
 *
 * blocked는 `dbPromise` 캐시를 버리므로, 그 상태에서 `openDB()`를 부르는 경로가 여럿이면
 * (5초 스냅샷 · 3초 사진 폴링 · 에셋 재적재) 매 호출이 새 `indexedDB.open()`을 띄우고
 * 전부 다시 blocked로 떨어진다 — 경고 로그가 초당 수십 줄로 흐르고 원인 줄이 묻힌다.
 * 2초 동안은 **같은 거절을 재사용**해 요청 자체를 만들지 않는다.
 */
export const DB_BLOCKED_COOLDOWN_MS = 2000;

/**
 * 방금 blocked로 거절한 요청을 그대로 다시 돌려줄 것인가 — `openDB()`의 순수한 알맹이.
 * `blockedAt`이 null이면(아직 막힌 적 없음) 항상 false, 쿨다운을 지났으면 다시 열어 본다.
 */
export function isBlockedCooldown(blockedAt: number | null, now: number): boolean {
  if (blockedAt === null) return false;
  const elapsed = now - blockedAt;
  // 시계가 뒤로 갔으면(수동 조정·절전 복귀) 쿨다운을 신뢰하지 않고 다시 연다
  return elapsed >= 0 && elapsed < DB_BLOCKED_COOLDOWN_MS;
}

export interface DbNegotiationDeps {
  /** 이 창의 연결을 닫는다 (다른 창의 업그레이드를 통과시키기 위해) */
  closeConnection(): void;
  /** 모듈 캐시(`dbPromise`)를 버려 다음 호출이 새로 열도록 한다 */
  resetCache(): void;
  warn(message: string): void;
}

export interface DbNegotiation {
  /** 다른 창이 더 높은 `DB_VERSION`으로 열려 한다 → 닫아 주고 캐시를 버린다 */
  versionChange(): void;
  /** 연결이 밖에서 끊겼다(브라우저 정리·프로필 삭제) → 캐시만 버린다 */
  closed(): void;
  /** 업그레이드가 다른 창에 막혔다 → 호출부에 돌려줄 에러 */
  blocked(): Error;
}

/**
 * 다중 창 DB 협상 규칙 — `openDB()`가 쓰는 순수한 알맹이(IndexedDB 없이 테스트 가능).
 *
 * 규칙이 셋 다 있어야 성립한다: `onversionchange`에서 **닫지 않으면** 다른 창이 영원히
 * 막히고, 캐시를 버리지 **않으면** 닫힌 연결을 계속 돌려주며, `onblocked`을 **잡지 않으면**
 * 아무 일도 일어나지 않는 채로 사용자가 원인을 알 수 없다.
 */
export function createDbNegotiation(deps: DbNegotiationDeps): DbNegotiation {
  return {
    versionChange() {
      deps.warn('다른 창이 새 버전으로 IndexedDB를 여는 중 — 이 창의 연결을 닫습니다.');
      deps.closeConnection();
      deps.resetCache();
    },
    closed() {
      deps.resetCache();
    },
    blocked() {
      deps.warn(DB_BLOCKED_MESSAGE);
      deps.resetCache();
      return new Error(DB_BLOCKED_MESSAGE);
    },
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;
/** **M4** 마지막 `onblocked` 시각과 그때 돌려준 거절 — 쿨다운 동안 그대로 재사용한다 */
let blockedAt: number | null = null;
let blockedRejection: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  // **M4** 방금 막혔다면 새 open을 띄우지 않는다 (호출부는 같은 에러를 받는다)
  if (blockedRejection && isBlockedCooldown(blockedAt, Date.now())) return blockedRejection;
  blockedRejection = null;
  blockedAt = null;
  const pending: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // blocked로 이미 거절한 요청이 뒤늦게 열리는 경우를 구분한다
    let settled = false;
    const dropCache = () => {
      if (dbPromise === pending) dbPromise = null;
    };

    req.onupgradeneeded = () => {
      const db = req.result;
      applyUpgrade({
        has: (name) => db.objectStoreNames.contains(name),
        create: (name, keyPath) => {
          db.createObjectStore(name, { keyPath });
        },
      });
    };

    req.onblocked = () => {
      // 캐시를 버려 두면 다른 창이 닫힌 뒤 다음 호출이 다시 시도할 수 있다
      const nego = createDbNegotiation({
        closeConnection: () => undefined,
        resetCache: dropCache,
        warn: (m) => console.warn(`[db] ${m}`),
      });
      const err = nego.blocked();
      settled = true;
      // **M4** 이 거절을 쿨다운 동안 재사용한다 — 첫 호출부가 이미 붙잡으므로 미처리 거절이 아니다
      blockedAt = Date.now();
      blockedRejection = pending;
      reject(err);
    };

    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        // blocked로 이미 거절된 요청 — 연결을 쥐고 있으면 다음 업그레이드를 또 막는다
        db.close();
        return;
      }
      const nego = createDbNegotiation({
        closeConnection: () => db.close(),
        resetCache: dropCache,
        warn: (m) => console.warn(`[db] ${m}`),
      });
      db.onversionchange = () => nego.versionChange();
      db.onclose = () => nego.closed();
      settled = true;
      // 열렸다 = 막은 창이 사라졌다. 남은 쿨다운을 즉시 푼다
      blockedAt = null;
      blockedRejection = null;
      resolve(db);
    };

    req.onerror = () => {
      settled = true;
      dropCache();
      reject(req.error);
    };
  });
  dbPromise = pending;
  return pending;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/**
 * 재생 가능한 형태의 Blob.
 *
 * `.mov`는 브라우저에 `video/quicktime`으로 들어오는데 Chrome은 이 MIME을 아예 거부한다
 * (`canPlayType('video/quicktime') === ''`). 내용물이 H.264/AAC면 컨테이너는 MP4와 호환되므로
 * **데이터 복사 없이** slice()로 타입만 바꿔 주면 재생 판단이 통과한다.
 *
 * 주의: 그래도 major brand가 `qt  `인 파일은 Chrome의 MP4 파서가 거부한다 →
 * 이때는 등록 시 경고 배지를 띄우고 mp4로 리먹스(ffmpeg -c copy)하도록 안내한다.
 */
export function playableBlob(rec: Pick<AssetRecord, 'blob' | 'mime' | 'name'>): Blob {
  const isQuickTime = rec.mime === 'video/quicktime' || /\.(mov|qt)$/i.test(rec.name);
  if (!isQuickTime) return rec.blob;
  return rec.blob.slice(0, rec.blob.size, 'video/mp4');
}

export function putAsset(rec: AssetRecord): Promise<IDBValidKey> {
  return tx(STORE_ASSETS, 'readwrite', (s) => s.put(rec));
}

export function getAsset(id: string): Promise<AssetRecord | undefined> {
  return tx<AssetRecord | undefined>(STORE_ASSETS, 'readonly', (s) => s.get(id));
}

export function listAssets(): Promise<AssetRecord[]> {
  return tx<AssetRecord[]>(STORE_ASSETS, 'readonly', (s) => s.getAll());
}

/** 팀 로고를 제외한 미디어 에셋만 (영상·에셋 탭 목록용) */
export async function listMediaAssets(): Promise<AssetRecord[]> {
  const all = await listAssets();
  return all.filter((a) => a.kind !== 'logo');
}

/** 에셋 메타 일부만 갱신 (blob은 그대로 둔다) */
export async function patchAsset(id: string, patch: Partial<AssetRecord>): Promise<void> {
  const cur = await getAsset(id);
  if (!cur) return;
  await putAsset({ ...cur, ...patch, id: cur.id, blob: cur.blob });
}

export function deleteAsset(id: string): Promise<undefined> {
  return tx<undefined>(STORE_ASSETS, 'readwrite', (s) => s.delete(id));
}

// ---------------------------------------------------------------- 현장 사진 (계획 §1-3)

/**
 * 사진 원본(다운스케일 후) 레코드. **`assets` 스토어에 넣지 않는다** —
 * `listAssets()`가 `getAll()`이라 사진 500장이 섞이면 부팅·삭제·manifest 재적재마다
 * 200MB를 메모리로 끌어올린다. 목록 조회 비용을 분리하는 것이 스토어를 나눈 이유다.
 */
export interface PhotoRecord {
  /** `photoKey(name, size, lastModified)` **그 자체**가 id다 — 별도 `key` 필드를 두지 않는다 */
  id: string;
  name: string;
  mime: string;
  bytes: number;
  w: number;
  h: number;
  takenAt: number;
  addedAt: number;
  blob: Blob;
}

/**
 * 여러 스토어를 한 트랜잭션으로 다루고 **커밋(`oncomplete`)까지** 기다린다.
 *
 * 위의 `tx()`는 `req.onsuccess`에서 resolve한다 — 요청이 성공했을 뿐 **트랜잭션은 아직
 * 커밋 전**이라, 그 시점에 "저장됐다"고 판단하면 뒤늦은 abort로 사라진 사진이 상태에만 남는다.
 * 사진 경로는 전부 이 헬퍼를 쓴다. (`tx()`는 에셋 경로 회귀를 피해 그대로 둔다.)
 */
export function txMulti(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => void,
): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        fn(t);
      }),
  );
}

/** 원본과 썸네일을 **한 트랜잭션**으로 기록 — 반쪽만 남은 사진이 생기지 않게 */
export function putPhoto(rec: PhotoRecord, thumb: Blob): Promise<void> {
  return txMulti([STORE_PHOTOS, STORE_PHOTO_THUMBS], 'readwrite', (t) => {
    t.objectStore(STORE_PHOTOS).put(rec);
    t.objectStore(STORE_PHOTO_THUMBS).put({ id: rec.id, blob: thumb });
  });
}

export function getPhoto(id: string): Promise<PhotoRecord | undefined> {
  return tx<PhotoRecord | undefined>(STORE_PHOTOS, 'readonly', (s) => s.get(id));
}

export async function getPhotoThumb(id: string): Promise<Blob | undefined> {
  const rec = await tx<{ id: string; blob: Blob } | undefined>(STORE_PHOTO_THUMBS, 'readonly', (s) =>
    s.get(id),
  );
  return rec?.blob;
}

/**
 * 사진 id 목록. `getAllKeys()`라 **blob을 읽지 않는다** → 고아 정리(§3-5)를 싸게 할 수 있다.
 * (IndexedDB에는 프로젝션이 없어 `getAll()`은 blob까지 통째로 끌어온다.)
 */
export async function listPhotoIds(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>(STORE_PHOTOS, 'readonly', (s) => s.getAllKeys());
  return keys.map((k) => String(k));
}

export function deletePhotos(ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  return txMulti([STORE_PHOTOS, STORE_PHOTO_THUMBS], 'readwrite', (t) => {
    const photos = t.objectStore(STORE_PHOTOS);
    const thumbs = t.objectStore(STORE_PHOTO_THUMBS);
    for (const id of ids) {
      photos.delete(id);
      thumbs.delete(id);
    }
  });
}

export function clearPhotos(): Promise<void> {
  return txMulti([STORE_PHOTOS, STORE_PHOTO_THUMBS], 'readwrite', (t) => {
    t.objectStore(STORE_PHOTOS).clear();
    t.objectStore(STORE_PHOTO_THUMBS).clear();
  });
}

/**
 * 작은 키-값 저장소. 지금 용도는 폴더 핸들(`'photoDir'`) 하나다 —
 * `FileSystemDirectoryHandle`은 structured-clone은 되지만 **JSON 직렬화가 안 되므로**
 * 상태(localStorage)에 넣을 수 없다.
 */
export async function kvGet<T>(k: string): Promise<T | undefined> {
  const rec = await tx<{ k: string; v: T } | undefined>(STORE_KV, 'readonly', (s) => s.get(k));
  return rec?.v;
}

export function kvSet(k: string, v: unknown): Promise<void> {
  return txMulti([STORE_KV], 'readwrite', (t) => {
    t.objectStore(STORE_KV).put({ k, v });
  });
}

export function kvDelete(k: string): Promise<void> {
  return txMulti([STORE_KV], 'readwrite', (t) => {
    t.objectStore(STORE_KV).delete(k);
  });
}

/**
 * **M3** 스냅샷에서 떼어 낸 `photos.items`의 **최신본 1부**가 사는 kv 키.
 *
 * 사진 목록은 스냅샷 200개에 200번 복사할 이유가 없다 — 사진은 append-only 자료이고,
 * "2분 전 점수로 되돌리기"가 "2분 전 사진 목록으로 되돌리기"를 뜻하지도 않는다.
 * 스냅샷에는 빈 배열을 저장하고, 읽을 때 이 최신본을 다시 끼워 넣는다.
 */
export const SNAPSHOT_PHOTOS_KEY = 'snapshotPhotos';

/** 직전에 저장한 스냅샷/사진목록 직렬화 — 같으면 쓰기를 건너뛴다(**M3**) */
let lastSnapshotJson: string | null = null;
let lastPhotoItemsJson: string | null = null;

/**
 * **M3** 스냅샷 본문 — `photos.items`를 뺀 직렬화.
 *
 * 5초마다 도는 경로라 여기가 곧 비용이다. 사진 200장이면 items만 ~72KB로,
 * 스냅샷 하나의 대부분을 차지한다. 뺀 자리는 `injectPhotoItems()`가 읽을 때 채운다.
 */
export function leanSnapshotJson(state: AppState): string {
  const photos = (state as { photos?: { items?: unknown } }).photos;
  if (!photos || !Array.isArray(photos.items)) return JSON.stringify(state);
  return JSON.stringify({ ...state, photos: { ...photos, items: [] } });
}

/**
 * **M3** 읽기 경로 — 스냅샷 JSON의 빈 `photos.items`에 최신 사진 목록을 끼워 넣는다.
 *
 * 이미 items가 들어 있는 **옛 스냅샷은 건드리지 않는다**(이 변경 이전에 저장된 것).
 * 복원의 의미는 "그때의 점수·원장 + 지금의 사진"이다 — 사진 blob은 IndexedDB에 그대로 있고,
 * 옛 목록으로 되돌리면 그 뒤에 들어온 사진이 상태에서 사라져 고아 정리에 지워진다.
 */
export function injectPhotoItems(json: string, items: readonly unknown[]): string {
  if (!items.length) return json;
  try {
    const obj = JSON.parse(json) as { photos?: { items?: unknown } };
    if (!obj || typeof obj !== 'object') return json;
    const photos = obj.photos;
    if (!photos || typeof photos !== 'object') return json;
    if (Array.isArray(photos.items) && photos.items.length) return json;
    photos.items = [...items];
    return JSON.stringify(obj);
  } catch {
    return json;
  }
}

async function savedPhotoItems(): Promise<unknown[]> {
  try {
    const v = await kvGet<unknown[]>(SNAPSHOT_PHOTOS_KEY);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 5초 주기 스냅샷 (P4 생존). **바뀐 게 없으면 아무것도 쓰지 않는다** —
 * 행사 중 대기 구간에서 상태가 몇 분씩 그대로인 것이 정상이라, 그때마다 수십 KB를
 * 직렬화·커밋하면 200칸짜리 이력이 같은 내용으로 가득 차 정작 되돌릴 지점이 사라진다.
 */
export async function saveSnapshot(state: AppState): Promise<void> {
  const items = (state as { photos?: { items?: unknown } }).photos?.items;
  const itemsJson = JSON.stringify(Array.isArray(items) ? items : []);
  const json = leanSnapshotJson(state);
  if (json === lastSnapshotJson && itemsJson === lastPhotoItemsJson) return;
  try {
    if (itemsJson !== lastPhotoItemsJson) {
      await kvSet(SNAPSHOT_PHOTOS_KEY, Array.isArray(items) ? [...items] : []);
      lastPhotoItemsJson = itemsJson;
    }
    if (json !== lastSnapshotJson) {
      const rec: SnapshotRecord = { ts: Date.now(), json };
      await tx(STORE_SNAPSHOTS, 'readwrite', (s) => s.put(rec));
      lastSnapshotJson = json;
      await pruneSnapshots();
    }
  } catch {
    // 쓰지 못했으면 직렬화 기억도 되돌린다 — 다음 틱이 다시 시도해야 한다
    lastSnapshotJson = null;
    lastPhotoItemsJson = null;
  }
}

/**
 * 오래된 스냅샷 정리 — **키(ts)만 읽는다.**
 *
 * `getAll()`이면 저장할 때마다 스냅샷 200개의 JSON 전문을 통째로 읽는다.
 * 키가 곧 `ts`라 정렬·삭제에는 키만으로 충분하다.
 *
 * (스냅샷 하나를 +72KB로 부풀리던 사진 메타는 **M3**에서 본문 밖으로 뺐지만, 그건 쓰기 쪽
 *  이야기다. 여기서 전문을 읽지 않는 이유는 그와 별개로 여전히 유효하다.)
 */
async function pruneSnapshots(): Promise<void> {
  const keys = await tx<IDBValidKey[]>(STORE_SNAPSHOTS, 'readonly', (s) => s.getAllKeys());
  if (keys.length <= MAX_SNAPSHOTS) return;
  const ts = keys
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const drop = ts.slice(0, Math.max(0, ts.length - MAX_SNAPSHOTS));
  for (const d of drop) await tx(STORE_SNAPSHOTS, 'readwrite', (s) => s.delete(d));
}

export async function latestSnapshot(): Promise<SnapshotRecord | null> {
  try {
    const all = await tx<SnapshotRecord[]>(STORE_SNAPSHOTS, 'readonly', (s) => s.getAll());
    if (!all.length) return null;
    const newest = all.sort((a, b) => b.ts - a.ts)[0];
    const items = await savedPhotoItems();
    return { ts: newest.ts, json: injectPhotoItems(newest.json, items) };
  } catch {
    return null;
  }
}

export async function listSnapshots(): Promise<SnapshotRecord[]> {
  try {
    const all = await tx<SnapshotRecord[]>(STORE_SNAPSHOTS, 'readonly', (s) => s.getAll());
    // **M3** 저장할 때 뺀 사진 목록을 여기서 되돌린다 (복구 UI가 그대로 `state/replace`에 싣는다)
    const items = await savedPhotoItems();
    return all
      .sort((a, b) => b.ts - a.ts)
      .map((sn) => ({ ts: sn.ts, json: injectPhotoItems(sn.json, items) }));
  } catch {
    return [];
  }
}

/**
 * 설정 → 전체 초기화. **신규 스토어를 빠뜨리면 초기화 후 유령 blob이 남는다**
 * (상태에는 없는데 IndexedDB에는 있는 사진 = 용량만 먹고 영영 못 지운다).
 */
export async function clearAll(): Promise<void> {
  // 초기화 뒤 첫 스냅샷이 "직전과 같다"는 이유로 건너뛰지 않게 기억을 함께 버린다(**M3**)
  lastSnapshotJson = null;
  lastPhotoItemsJson = null;
  await tx(STORE_ASSETS, 'readwrite', (s) => s.clear());
  await tx(STORE_SNAPSHOTS, 'readwrite', (s) => s.clear());
  await clearPhotos();
  await tx(STORE_KV, 'readwrite', (s) => s.clear());
}
