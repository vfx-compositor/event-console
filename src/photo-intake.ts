/**
 * 현장 사진 흡수 파이프라인 (계획 §3 · §11 T3).
 *
 * 계약의 핵심 3가지:
 *  1. **리더만 돈다.** 보조 창이 IndexedDB에 사진을 밀어 넣으면 리더의 상태와 어긋난다.
 *  2. **상태에 저장하지 않는 진행 정보**(`IntakeStatus`)는 모듈 로컬이다 — 창마다 다르고,
 *     매 스캔마다 상태를 저장·방송하면 원장·리더 락 경로가 오염된다.
 *  3. 드롭·파일 선택·폴링이 **같은 흡수 함수**를 쓴다. 경로가 갈리면 중복 방지 규칙이 갈린다.
 *
 * 파일 구성: 앞쪽 절반은 **순수 로직**(스캔 안정화 판정·재시도·배치 플러시·중복 판정·무결성 비교)이라
 * `photo-intake.test.ts`가 node 환경에서 그대로 검증한다. 뒤쪽 절반만 DOM/IndexedDB에 닿는다.
 */

import {
  deletePhotos,
  kvDelete,
  kvGet,
  kvSet,
  listPhotoIds,
  putPhoto,
  type PhotoRecord,
} from './db';
import {
  PHOTO_LONG_EDGE,
  PHOTO_THUMB_LONG_EDGE,
  fitLongEdge,
  photoFileKind,
  photoKey,
  readExifTakenAt,
} from './photos';
import type { PhotoIntakeMeta } from './state';

// ---------------------------------------------------------------- 상수 (T3·T4 공용)

/** 폴더 폴링 주기(ms). 스캔이 진행 중이면 그 틱은 건너뛴다(재진입 금지) */
export const PHOTO_POLL_MS = 3000;
/** `photos/add` 배치 상한 — 10장 또는 `PHOTO_BATCH_MS` 중 먼저 오는 쪽 */
export const PHOTO_BATCH_MAX = 10;
export const PHOTO_BATCH_MS = 500;
/**
 * **L1** 동시 디코드 상한 상수(`PHOTO_INTAKE_CONCURRENCY`)는 삭제했다 —
 * 값은 2인데 구현은 직렬 1이라 주석과 코드가 어긋났고, 어디서도 import하지 않았다.
 * 병렬화는 워커(§3-3 유보 항목)와 함께 와야 하며 그때 상수도 같이 들어온다.
 */
/** 패널에 보관하는 실패 파일명 개수 */
export const PHOTO_FAILED_KEEP = 20;
/** IndexedDB `kv` 스토어에서 폴더 핸들을 담는 키 */
export const PHOTO_DIR_KEY = 'photoDir';

/**
 * **H5** — 같은 (size, lastModified)로 연속 몇 번 보여야 "복사가 끝났다"고 볼 것인가.
 *
 * AirDrop·카톡·탐색기 복사는 파일을 **먼저 만들고 나중에 채운다**. 생성 직후 `getFile()`하면
 * 0바이트거나 잘린 JPEG라 `createImageBitmap`이 실패하고, 그 한 장은 영영 안 들어온다.
 * 2회 × 3초 = **약 6초 안정화**를 기다린다.
 */
export const PHOTO_STABLE_SCANS = 2;
/** 흡수 실패를 몇 번까지 다시 시도할 것인가. 넘으면 `failed`로 확정하고 더는 열지 않는다 */
export const PHOTO_MAX_TRIES = 3;

/** 다운스케일 JPEG 품질 (원본 1920 / 썸네일 320) */
export const PHOTO_JPEG_QUALITY = 0.85;
export const PHOTO_THUMB_QUALITY = 0.7;
/** EXIF를 훑을 때 읽는 앞부분 바이트 수 — APP1은 SOI 직후에 온다 */
export const PHOTO_EXIF_HEAD_BYTES = 65536;

// ---------------------------------------------------------------- 폴더 권한

/**
 * - `'none'` 폴더를 고른 적 없음
 * - `'granted'` 즉시 폴링 가능
 * - `'prompt'` 재부팅 후 정상 경로 — `requestPermission`은 **사용자 제스처**에서만 부를 수 있다
 * - `'denied'` 거부됨
 * - `'unsupported'` Chrome 외 브라우저 → 폴더 UI를 감추고 드롭/파일 선택만 남긴다
 */
export type DirState = 'none' | 'granted' | 'prompt' | 'denied' | 'unsupported';

/** File System Access의 권한 상태 (TS DOM lib에 없어 여기서 정의한다) */
export type FsPermissionState = 'granted' | 'denied' | 'prompt';

/**
 * `FileSystemDirectoryHandle` + 권한 API.
 * `queryPermission`/`requestPermission`은 표준 DOM 타입에 없으므로 선택 메서드로 얹는다.
 */
export interface PhotoDirHandle extends FileSystemDirectoryHandle {
  /**
   * `for await (const [name, handle] of dir.entries())`.
   * TS의 DOM lib(5.6)에는 아직 없어 여기서 선언한다 — Chrome에는 있다.
   */
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<FsPermissionState>;
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<FsPermissionState>;
}

// ---------------------------------------------------------------- 진행 상태 (상태 저장 아님)

export interface IntakeStatus {
  dir: DirState;
  dirName: string | null;
  scanning: boolean;
  /** 마지막 성공 스캔 epoch ms */
  lastScanAt: number | null;
  /** 마지막 신규 편입 epoch ms */
  lastAddAt: number | null;
  /** 처리 대기 장수 */
  pending: number;
  /** 진행 표시용 — 이번 흡수에서 처리를 끝낸 장수 (`pending`과 짝) */
  done: number;
  /**
   * **M10** Chrome이 디코드하지 못해 건너뛴 HEIC 장수 — **폴더 스캔 전용 누적치**다.
   *
   * 드롭·파일 선택·붙여넣기는 여기에 더하지 않고 `IntakeResult.skippedHeic`로만 알린다
   * (T4가 그 자리에서 토스트로 띄운다). 섞으면 폴더에 HEIC 3장이 있는 채로 드롭을 반복할 때
   * 패널의 `건너뜀 N`이 실제 폴더 상황과 무관하게 계속 불어나고, 폴더를 바꿔도(=`resetScan`)
   * 0으로 돌아가지 않는 것처럼 보인다.
   */
  skippedHeic: number;
  /** 최근 실패 파일명 (최대 `PHOTO_FAILED_KEEP`건) */
  failed: string[];
  /**
   * **M5** 상태에는 있는데 IndexedDB에 blob이 없는 사진 수.
   *
   * display 이벤트가 아니라 **control이 직접** `listPhotoIds()` ↔ `state.photos.items`를
   * 양방향으로 비교해 센다(`sync.ts` 불변). 부팅·리더 인수·배치 후에 갱신된다.
   */
  broken: number;
  /** **M8** `navigator.storage.estimate()` — 상태 줄 hover 상세용. 모르면 null */
  usage: number | null;
  quota: number | null;
}

// ---------------------------------------------------------------- 흡수 계약

/**
 * 흡수 호출부가 제공하는 의존성. **상태를 직접 읽지 않는다** —
 * `photo-intake`가 `state.ts`에 의존하면 리더 판정·dispatch 경로가 두 갈래가 된다.
 */
export interface IntakeDeps {
  /** 이미 상태에 있는 사진 id (`state.photos.items`에서 파생) */
  knownIds(): ReadonlySet<string>;
  /**
   * 배치 dispatch — `{ type: 'photos/add', items }`.
   *
   * **`putPhoto()`가 resolve(= 트랜잭션 커밋)된 항목만 여기에 싣는다.** `db.ts`의 `txMulti`가
   * `oncomplete`에서 resolve하므로 그 시점이면 blob이 확실히 남아 있다. 요청 성공만 보고
   * 미리 dispatch하면, 뒤늦은 abort로 blob이 사라진 사진이 상태에만 남아 display가
   * 렌더할 때마다 조용히 건너뛰는 "깨진 사진"이 된다.
   *
   * `p2` 필드는 넣지 않아도 된다 — reducer가 흡수 시점의 `state.p2.unlocked`로 찍는다.
   */
  onBatch(items: PhotoIntakeMeta[]): void;
  /** 패널 갱신 콜백 (상태 저장 아님) */
  onStatus(status: IntakeStatus): void;
}

export interface IntakeResult {
  /** 실제로 IndexedDB에 저장되고 `onBatch`로 나간 장수 */
  added: number;
  /** 중복·사진 아님으로 건너뛴 장수 */
  skipped: number;
  /** HEIC라 건너뛴 장수 (skipped에 포함된다) */
  skippedHeic: number;
  /** 디코드·저장에 실패한 파일명 */
  failed: string[];
  /**
   * **H4** 리더 자리를 잃어 도중에 끊었다 — 남은 파일은 **처리하지 않았다**.
   *
   * `failed`와 구분해야 한다: 실패가 아니라 아예 시도하지 않은 것이라, 호출부가
   * "N장을 열지 못했습니다"로 알리면 거짓말이 된다. 남은 파일은 다시 리더가 된 창의
   * 폴링이 **처음부터** 집는다 — `abortPhotoIntake()`가 스캔 엔트리를 통째로 비우므로
   * `done`으로 확정돼 있던 파일도 다음 스캔에 다시 관측된다.
   */
  aborted: boolean;
}

export interface PollingOpts extends IntakeDeps {
  /** 리더가 아니면 스캔하지 않는다 */
  isLeader(): boolean;
  /** `state.photos.settings.autoIntake` */
  enabled(): boolean;
}

/** 폴링 정지 함수 — `applyRole()`의 비리더 분기에서 **반드시 짝으로** 부른다 */
export type StopPolling = () => void;

// ================================================================
// 순수 로직 — node 환경에서 그대로 테스트된다 (`photo-intake.test.ts`)
// ================================================================

/**
 * **H5** 폴더 스캔 필터의 한 항목. 키는 파일명이다.
 *
 * `done`이 true면 다음 스캔부터 **`getFile()`을 부르지 않는다** — 500장 폴더를 3초마다
 * 전부 여는 것을 피하는 실질이 이 플래그다(계획 §3-2의 "이름 우선 필터"의 정확한 형태).
 */
export interface ScanEntry {
  size: number;
  lastModified: number;
  /** 같은 (size, lastModified)로 **연속** 관측된 횟수 */
  stable: number;
  /** 흡수 실패 횟수 */
  tries: number;
  /** 확정 — 처리했거나(성공), 포기했거나, 애초에 열 필요가 없는 파일 */
  done: boolean;
}

export type ScanVerdict =
  /** 아직 복사 중일 수 있다 — 기록만 하고 넘어간다 */
  | 'wait'
  /** 연속 `PHOTO_STABLE_SCANS`회 동일 — 처리 큐로 */
  | 'ready'
  /** 이미 확정된 항목 */
  | 'done';

/** 열 필요가 없는(또는 이미 끝난) 파일을 확정 상태로 만든다 */
export function scanDone(size = 0, lastModified = 0): ScanEntry {
  return { size, lastModified, stable: PHOTO_STABLE_SCANS, tries: 0, done: true };
}

/**
 * 한 번의 관측을 반영한다. **불변** — 새 엔트리를 돌려준다.
 *
 * 처음 보이거나 size/lastModified가 직전 스캔과 다르면 `stable`을 1로 되돌리고 `'wait'`.
 * 연속 2회 동일해야 `'ready'`가 나온다.
 */
export function scanObserve(
  prev: ScanEntry | undefined,
  obs: { size: number; lastModified: number },
): { entry: ScanEntry; verdict: ScanVerdict } {
  const size = Number.isFinite(obs.size) ? obs.size : 0;
  const lastModified = Number.isFinite(obs.lastModified) ? obs.lastModified : 0;

  if (prev?.done) return { entry: prev, verdict: 'done' };
  if (!prev) {
    return { entry: { size, lastModified, stable: 1, tries: 0, done: false }, verdict: 'wait' };
  }
  if (prev.size !== size || prev.lastModified !== lastModified) {
    // 복사가 아직 진행 중이다 — 처음부터 다시 센다
    return { entry: { size, lastModified, stable: 1, tries: prev.tries, done: false }, verdict: 'wait' };
  }
  const stable = prev.stable + 1;
  const ready = stable >= PHOTO_STABLE_SCANS;
  return {
    // ready면 그 자리에서 확정해 둔다 — 흡수가 도는 동안 다음 틱이 같은 파일을 또 집지 않는다
    entry: { size, lastModified, stable, tries: prev.tries, done: ready },
    verdict: ready ? 'ready' : 'wait',
  };
}

/**
 * 흡수 실패를 반영한다. `PHOTO_MAX_TRIES`에 닿으면 포기(`done`)하고 `giveUp: true`.
 *
 * 포기 전이면 `done`을 풀고 `stable`을 0으로 되돌린다 → 다시 연속 2회(≈6초)를 기다린 뒤 재시도.
 * 실패의 흔한 원인이 "아직 다 안 써진 파일"이라, 즉시 재시도는 같은 실패를 3번 반복할 뿐이다.
 */
export function scanRetry(prev: ScanEntry): { entry: ScanEntry; giveUp: boolean } {
  const tries = prev.tries + 1;
  const giveUp = tries >= PHOTO_MAX_TRIES;
  return { entry: { ...prev, tries, stable: giveUp ? prev.stable : 0, done: giveUp }, giveUp };
}

/** 배치를 지금 내보낼 것인가 — 10장 또는 500ms 중 먼저 오는 쪽 */
export function shouldFlushBatch(pending: number, elapsedMs: number): boolean {
  if (pending <= 0) return false;
  return pending >= PHOTO_BATCH_MAX || elapsedMs >= PHOTO_BATCH_MS;
}

/** 실패 파일명 누적 — 같은 이름은 한 번만, 최근 `PHOTO_FAILED_KEEP`건만 */
export function pushFailed(list: readonly string[], name: string): string[] {
  const next = list.filter((n) => n !== name);
  next.push(name);
  return next.length > PHOTO_FAILED_KEEP ? next.slice(next.length - PHOTO_FAILED_KEEP) : next;
}

/** 파일 한 건의 흡수 판정 */
export type IntakeVerdict =
  /** 새 사진 — 처리한다 */
  | { kind: 'accept'; id: string }
  /** 상태에 이미 있거나 같은 배치에 두 번 들어왔다 */
  | { kind: 'duplicate'; id: string }
  /** Chrome이 디코드하지 못한다 — 건너뛰고 패널에 안내 */
  | { kind: 'heic' }
  /** 사진이 아니다 — 카운트도 하지 않는다 */
  | { kind: 'ignore' };

/**
 * 파일 신원만으로 내리는 판정 — 디코드 **전에** 부른다.
 *
 * `batchIds`는 같은 호출 안에서 이미 받아들인 id다. 드롭 한 번에 같은 파일이 두 번 들어오면
 * (파인더 다중 선택 + 붙여넣기 조합) `knownIds()`는 아직 갱신되기 전이라 여기서 걸러야 한다.
 */
export function classifyIntakeFile(
  file: { name: string; size: number; lastModified: number },
  knownIds: ReadonlySet<string>,
  batchIds: ReadonlySet<string>,
): IntakeVerdict {
  const kind = photoFileKind(file.name);
  if (kind === null) return { kind: 'ignore' };
  if (kind === 'heic') return { kind: 'heic' };
  const id = photoKey(file.name, file.size, file.lastModified);
  if (knownIds.has(id) || batchIds.has(id)) return { kind: 'duplicate', id };
  return { kind: 'accept', id };
}

export interface PhotoIntegrity {
  /** IndexedDB에는 있는데 상태에 없는 blob — 흡수 도중 크래시의 잔해. 지운다 */
  orphans: string[];
  /** 상태에는 있는데 blob이 없는 사진 수 — display가 조용히 건너뛴다(패널에 `깨진 N`) */
  broken: number;
}

/** **M5** 양방향 비교. `listPhotoIds()`는 `getAllKeys()`라 blob을 읽지 않는다 */
export function comparePhotoIds(
  dbIds: readonly string[],
  knownIds: ReadonlySet<string>,
): PhotoIntegrity {
  const inDb = new Set(dbIds);
  const orphans = dbIds.filter((id) => !knownIds.has(id));
  let broken = 0;
  for (const id of knownIds) if (!inDb.has(id)) broken++;
  return { orphans, broken };
}

/** 초기 상태 스냅샷 (테스트·리셋 공용) */
export function emptyIntakeStatus(): IntakeStatus {
  return {
    dir: 'none',
    dirName: null,
    scanning: false,
    lastScanAt: null,
    lastAddAt: null,
    pending: 0,
    done: 0,
    skippedHeic: 0,
    failed: [],
    broken: 0,
    usage: null,
    quota: null,
  };
}

// ================================================================
// 모듈 상태
// ================================================================

let dirHandle: PhotoDirHandle | null = null;
const status: IntakeStatus = emptyIntakeStatus();
/** 파일명 → 스캔 엔트리. 폴더를 바꾸면 통째로 비운다 */
const scan = new Map<string, ScanEntry>();
let pollTimer = 0;
let scanning = false;
let intaking = false;
let persistAsked = false;
/** 진행 중인 `intakeFiles` 호출 수 — control이 무결성 재계산을 미룰 때 본다 */
let activeIntakes = 0;

/**
 * **H4** 흡수 세대 토큰.
 *
 * 리더 자리를 잃는 순간 `abortPhotoIntake()`가 이 값을 올린다. 진행 중인 `intakeFiles`는
 * **매 장** 자기가 시작한 세대와 비교해, 달라졌으면 남은 파일을 건드리지 않고 끊는다.
 *
 * 토큰이 없으면: 200장을 흡수하는 도중 자리를 넘겨도 루프가 끝까지 돌아 비리더 창이
 * IndexedDB에 blob을 계속 밀어 넣고(=`dispatch`는 막혀 있으니 전부 고아), 그 뒤늦은
 * `emit`이 `stopPhotoIntake()`가 비워 둔 `status.photoDir`를 되살려 잠긴 창에 폴더 칩이
 * 다시 뜬다. 판정을 `isLeader()` 하나에 맡기지 않는 이유는 `intakeFiles`가 폴링 밖
 * (드롭·붙여넣기)에서도 불리고 그 경로에는 `isLeader`가 없기 때문이다.
 */
let intakeGen = 0;

/** 현재 세대 — 테스트·진단용 */
export function intakeGeneration(): number {
  return intakeGen;
}

/**
 * 진행 중인 흡수를 **다음 장 경계에서** 끊는다. control의 `stopPhotoIntake()`가 부른다.
 *
 * 스캔 엔트리를 함께 비우는 것이 짝이다 — 끊긴 파일은 `done`으로 확정돼 있어서,
 * 비우지 않으면 이 창이 나중에 리더를 되찾아도 그 파일들을 영영 다시 보지 않는다.
 */
export function abortPhotoIntake(): number {
  intakeGen++;
  resetScan();
  return intakeGen;
}

/** 흡수가 돌고 있는가 — 무결성 재계산이 커밋 직후·dispatch 직전의 blob을 고아로 오인하지 않게 */
export function isIntaking(): boolean {
  return activeIntakes > 0;
}

/**
 * control이 부팅 때 등록하는 기본 의존성.
 *
 * T4의 드롭·파일 선택·붙여넣기 경로가 `ctx`에서 deps를 따로 조립하면 중복 방지 규칙이 갈린다
 * (§3-3의 "같은 함수" 계약). 그래서 `intakeFiles(files)`를 deps 없이 부르면 이 값을 쓴다.
 */
let defaultDeps: IntakeDeps | null = null;

export function setDefaultIntakeDeps(deps: IntakeDeps | null): void {
  defaultDeps = deps;
}

/** 현재 진행 상태 스냅샷 — 패널이 다시 그릴 때 읽는다 */
export function intakeStatus(): IntakeStatus {
  return { ...status, failed: [...status.failed] };
}

function emit(deps?: IntakeDeps | null): void {
  const d = deps ?? defaultDeps;
  if (!d) return;
  try {
    d.onStatus(intakeStatus());
  } catch {
    /* 패널 렌더 실패가 흡수를 멈추게 두지 않는다 */
  }
}

/** 테스트·재부팅 경로용 리셋 (폴더를 바꾸거나 잊을 때) */
function resetScan(): void {
  scan.clear();
  status.skippedHeic = 0;
  status.failed = [];
  status.pending = 0;
  status.done = 0;
}

// ================================================================
// 폴더 핸들 — 획득 · 영속 · 권한 재요청
// ================================================================

interface DirPickerWindow {
  showDirectoryPicker?(opts?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }): Promise<FileSystemDirectoryHandle>;
}

/** `'showDirectoryPicker' in window` — 127.0.0.1도 secure context라 Chrome이면 뜬다 */
export function isDirPickerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as DirPickerWindow).showDirectoryPicker === 'function'
  );
}

function setDir(handle: PhotoDirHandle | null, state: DirState): DirState {
  const changed = handle !== dirHandle;
  dirHandle = handle;
  status.dir = state;
  status.dirName = handle?.name ?? null;
  if (changed) resetScan();
  return state;
}

async function permissionOf(handle: PhotoDirHandle): Promise<DirState> {
  // queryPermission이 없는 구현(구 Chrome·폴리필)은 낙관적으로 granted로 본다 —
  // 실제로 막혀 있으면 첫 entries()에서 걸리고 그때 'prompt'로 떨어진다.
  if (typeof handle.queryPermission !== 'function') return 'granted';
  try {
    const p = await handle.queryPermission({ mode: 'read' });
    return p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'prompt';
  }
}

/** **사용자 제스처에서만** 호출 가능. `showDirectoryPicker({ id: 'nsdh-console-photos', mode: 'read' })` → kv 저장 */
export async function pickPhotoDir(): Promise<DirState> {
  if (!isDirPickerSupported()) {
    setDir(null, 'unsupported');
    emit();
    return 'unsupported';
  }
  let handle: PhotoDirHandle;
  try {
    handle = (await (window as unknown as Required<DirPickerWindow>).showDirectoryPicker({
      id: 'nsdh-console-photos',
      mode: 'read',
    })) as PhotoDirHandle;
  } catch {
    // 사용자가 취소했다 — 기존 연결을 건드리지 않는다
    emit();
    return status.dir;
  }
  const state = await permissionOf(handle);
  setDir(handle, state);
  try {
    await kvSet(PHOTO_DIR_KEY, handle);
  } catch {
    /* 핸들 영속에 실패해도 이번 세션은 동작한다 */
  }
  emit();
  return state;
}

/** 부팅·리더 인수 시: kv에서 핸들 복원 + `queryPermission`. 제스처 없이 안전하다 */
export async function restorePhotoDir(): Promise<DirState> {
  if (!isDirPickerSupported()) {
    setDir(null, 'unsupported');
    emit();
    return 'unsupported';
  }
  let handle: PhotoDirHandle | undefined;
  try {
    handle = await kvGet<PhotoDirHandle>(PHOTO_DIR_KEY);
  } catch {
    handle = undefined;
  }
  if (!handle || typeof handle.entries !== 'function') {
    setDir(null, 'none');
    emit();
    return 'none';
  }
  // 'prompt'여도 **자동으로 requestPermission을 부르지 않는다** — 제스처 밖에서는 거부되고,
  // 거부가 쌓이면 Chrome이 그 origin의 요청을 아예 무시한다. 칩만 "권한 필요"로 띄운다.
  const state = await permissionOf(handle);
  setDir(handle, state);
  emit();
  return state;
}

/** **사용자 제스처에서만**. `requestPermission`으로 `'prompt'`를 `'granted'`로 되돌린다 */
export async function regrantPhotoDir(): Promise<DirState> {
  if (!dirHandle) return restorePhotoDir();
  if (typeof dirHandle.requestPermission !== 'function') {
    status.dir = 'granted';
    emit();
    return 'granted';
  }
  let state: DirState;
  try {
    const p = await dirHandle.requestPermission({ mode: 'read' });
    state = p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'prompt';
  } catch {
    state = 'denied';
  }
  status.dir = state;
  emit();
  return state;
}

/**
 * **L4** 연결 해제 — kv에서 핸들을 지우고 폴더 상태를 `'none'`으로 되돌린다.
 *
 * **타이머는 끄지 않는다**(옛 주석은 "폴링을 멈춘다"고 적혀 있었으나 코드는 그런 적이 없다).
 * 핸들이 없으면 `pollTick`이 첫 줄에서 되돌아 나오므로 도는 비용이 0이고, 타이머를 살려 두는
 * 덕에 사용자가 [폴더 선택]으로 다시 연결하면 **새로고침 없이** 그 자리에서 수집이 재개된다.
 * 진짜로 멈춰야 하는 경우(리더 강등)는 `applyRole()`의 비리더 분기가 정지 함수를 부른다.
 */
export async function forgetPhotoDir(): Promise<void> {
  setDir(null, 'none');
  try {
    await kvDelete(PHOTO_DIR_KEY);
  } catch {
    /* 지우지 못해도 핸들은 이미 놓았다 */
  }
  emit();
}

/** 현재 폴더 상태·이름 (렌더 직전 조회용. 저장하지 않는다) */
export function currentDirState(): DirState {
  return status.dir;
}

export function currentDirName(): string | null {
  return status.dirName;
}

// ================================================================
// **M8** 저장소 — 영속 요청 1회 + 사용량
// ================================================================

interface StorageManagerLike {
  persist?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

function storageManager(): StorageManagerLike | null {
  return typeof navigator !== 'undefined'
    ? ((navigator as { storage?: StorageManagerLike }).storage ?? null)
    : null;
}

/**
 * 리더 확정 직후 1회. 영속 저장을 요청해 두면 Chrome이 디스크 압박 때 사진 blob을
 * 조용히 evict하지 않는다 — 행사 중 사진이 통째로 사라지는 유일한 경로를 막는다.
 */
export async function primePhotoStorage(): Promise<void> {
  const sm = storageManager();
  if (!sm) return;
  if (!persistAsked) {
    persistAsked = true;
    try {
      void sm.persist?.();
    } catch {
      /* 지원하지 않으면 그만 */
    }
  }
  await refreshStorageEstimate();
}

async function refreshStorageEstimate(): Promise<void> {
  const sm = storageManager();
  if (typeof sm?.estimate !== 'function') return;
  try {
    const e = await sm.estimate();
    status.usage = typeof e.usage === 'number' ? e.usage : null;
    status.quota = typeof e.quota === 'number' ? e.quota : null;
  } catch {
    /* 값이 없으면 hover 상세에서 감춘다 */
  }
}

// ================================================================
// 무결성 — 고아 정리 · 깨진 사진 세기 (**M5**)
// ================================================================

/**
 * `listPhotoIds()` ↔ 상태의 id를 양방향 비교한다.
 * - IndexedDB에만 있는 blob(고아) → 삭제
 * - 상태에만 있는 사진(깨짐) → `status.broken`
 *
 * 부팅·리더 인수·배치 후에 부른다.
 */
export async function refreshPhotoIntegrity(knownIds: ReadonlySet<string>): Promise<PhotoIntegrity> {
  let ids: string[];
  try {
    ids = await listPhotoIds();
  } catch {
    return { orphans: [], broken: status.broken };
  }
  const result = comparePhotoIds(ids, knownIds);
  status.broken = result.broken;
  if (result.orphans.length) {
    try {
      await deletePhotos(result.orphans);
    } catch {
      /* 다음 부팅에 다시 시도한다 */
    }
  }
  emit();
  return result;
}

/**
 * 고아 blob 정리 (부팅·리더 인수 시 1회).
 * `listPhotoIds()`(blob 미읽음) ∖ 상태의 id → `deletePhotos()`. 삭제한 개수를 돌려준다.
 */
export async function pruneOrphanPhotos(knownIds: ReadonlySet<string>): Promise<number> {
  const { orphans } = await refreshPhotoIntegrity(knownIds);
  return orphans.length;
}

// ================================================================
// 디코드 · 다운스케일
// ================================================================

interface Rendered {
  blob: Blob;
  w: number;
  h: number;
}

async function renderJpeg(
  bmp: ImageBitmap,
  max: number,
  quality: number,
): Promise<Rendered> {
  const { w, h } = fitLongEdge(bmp.width, bmp.height, max);
  if (w <= 0 || h <= 0) throw new Error('치수 0');

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('OffscreenCanvas 2d 컨텍스트 없음');
    g.drawImage(bmp, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return { blob, w, h };
  }

  // 폴백 — OffscreenCanvas가 없는 환경(구 Safari 등)
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas 2d 컨텍스트 없음');
  g.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new Error('toBlob 실패');
  return { blob, w, h };
}

/** EXIF 촬영 시각. 실패하면 `file.lastModified` (계획 §10 Q2) */
async function takenAtOf(file: File): Promise<number> {
  try {
    const head = await file.slice(0, PHOTO_EXIF_HEAD_BYTES).arrayBuffer();
    const t = readExifTakenAt(new Uint8Array(head));
    if (t !== null) return t;
  } catch {
    /* 읽기 실패 → 폴백 */
  }
  return Number.isFinite(file.lastModified) ? file.lastModified : Date.now();
}

/** 한 장을 디코드·다운스케일·저장한다. 성공하면 상태에 실을 메타를 돌려준다 */
async function ingestOne(file: File, id: string): Promise<PhotoIntakeMeta> {
  // `imageOrientation: 'from-image'` — EXIF 회전 플래그를 픽셀에 굽는다.
  // 안 하면 아이폰 세로 사진이 디스플레이에서 눕는다(브라우저 img 태그와 달리 canvas는 무시한다).
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let main: Rendered;
  let thumb: Rendered;
  try {
    main = await renderJpeg(bmp, PHOTO_LONG_EDGE, PHOTO_JPEG_QUALITY);
    thumb = await renderJpeg(bmp, PHOTO_THUMB_LONG_EDGE, PHOTO_THUMB_QUALITY);
  } finally {
    bmp.close();
  }

  const addedAt = Date.now();
  const takenAt = await takenAtOf(file);
  const rec: PhotoRecord = {
    id,
    name: file.name,
    mime: 'image/jpeg',
    bytes: main.blob.size,
    w: main.w,
    h: main.h,
    takenAt,
    addedAt,
    blob: main.blob,
  };
  // `txMulti`의 oncomplete까지 기다린다 → 여기서 resolve됐다면 blob이 확실히 남아 있다
  await putPhoto(rec, thumb.blob);
  return {
    id,
    name: file.name,
    takenAt,
    addedAt,
    w: main.w,
    h: main.h,
    bytes: main.blob.size,
    hidden: false,
  };
}

/** **L4** 메인스레드 양보 — 배치 사이에 끼워 패널 진행 카운트가 갱신되게 한다 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ================================================================
// 흡수 — 드롭 · 파일 선택 · 붙여넣기 · 폴링 공통 경로
// ================================================================

/**
 * 파일 배치를 흡수한다 — **드롭 · 파일 선택 · 붙여넣기 · 폴링이 모두 이 함수를 쓴다.**
 *
 * 흐름: `createImageBitmap`(EXIF orientation 반영) → `fitLongEdge(…, 1920)` 다운스케일 JPEG q0.85
 * → 같은 bitmap으로 320 썸네일 q0.7 → `takenAt = readExifTakenAt(앞 64KB) ?? file.lastModified`
 * → `putPhoto(rec, thumb)` → 성공분만 배치로 `onBatch`.
 *
 * `deps`를 생략하면 control이 등록한 기본 의존성(`setDefaultIntakeDeps`)을 쓴다.
 */
export async function intakeFiles(
  files: readonly File[] | FileList,
  deps?: IntakeDeps,
): Promise<IntakeResult> {
  const d = deps ?? defaultDeps;
  if (!d) throw new Error('photo-intake: IntakeDeps가 없다 (setDefaultIntakeDeps 미호출)');

  // **H4** 이 호출이 속한 세대. 강등되면 `abortPhotoIntake()`가 올려 이 값과 어긋난다
  const gen = intakeGen;
  const live = (): boolean => gen === intakeGen;
  /** 세대가 살아 있을 때만 패널을 갱신한다 — 뒤늦은 emit이 비워 둔 `photoDir`을 되살리지 않게 */
  const emitLive = (): void => {
    if (live()) emit(d);
  };

  const list = Array.from(files as ArrayLike<File>);
  const result: IntakeResult = { added: 0, skipped: 0, skippedHeic: 0, failed: [], aborted: false };

  // ---- 1단계: 디코드 전에 신원만으로 거른다 (중복·HEIC·사진 아님)
  const accepted: { file: File; id: string }[] = [];
  const batchIds = new Set<string>();
  for (const file of list) {
    const verdict = classifyIntakeFile(file, d.knownIds(), batchIds);
    if (verdict.kind === 'accept') {
      batchIds.add(verdict.id);
      accepted.push({ file, id: verdict.id });
    } else if (verdict.kind === 'duplicate') {
      result.skipped++;
    } else if (verdict.kind === 'heic') {
      // **M10** 이번 호출의 결과로만 알린다 — 누적 `status.skippedHeic`은 폴더 스캔 전용이다
      result.skipped++;
      result.skippedHeic++;
    }
    // 'ignore'는 세지 않는다
  }

  if (!live()) {
    result.aborted = true;
    return result;
  }
  if (!accepted.length) {
    emitLive();
    return result;
  }

  // ---- 2단계: 직렬 디코드 · 저장 · 배치 dispatch
  activeIntakes++;
  status.pending += accepted.length;
  emitLive();

  const batch: PhotoIntakeMeta[] = [];
  let batchAt = Date.now();
  const flush = (): void => {
    if (!batch.length) return;
    const items = batch.splice(0, batch.length);
    d.onBatch(items);
    status.lastAddAt = Date.now();
    batchAt = Date.now();
  };

  let idx = 0;
  try {
    for (; idx < accepted.length; idx++) {
      // **H4** 매 장 확인한다 — 200장 중간에 자리를 넘겼으면 여기서 끊는다
      if (!live()) break;
      const { file, id } = accepted[idx];
      try {
        batch.push(await ingestOne(file, id));
        result.added++;
      } catch {
        result.failed.push(file.name);
        status.failed = pushFailed(status.failed, file.name);
      }
      status.pending = Math.max(0, status.pending - 1);
      status.done++;

      if (shouldFlushBatch(batch.length, Date.now() - batchAt)) {
        flush();
        emitLive();
        // 배치를 낸 직후에만 양보한다 — 장당 양보하면 200장 흡수가 눈에 띄게 느려진다
        await yieldToMain();
      } else {
        emitLive();
      }
    }
  } finally {
    activeIntakes = Math.max(0, activeIntakes - 1);
    if (idx < accepted.length) result.aborted = true;
    // 이미 커밋된 항목은 그대로 내보낸다 — 비리더면 `dispatch`가 막고, 그때 남는 blob은
    // 다음 리더의 고아 정리가 회수한다. 여기서 버리면 성공한 장수와 상태가 어긋난다.
    flush();
    // 손대지 않고 남긴 장수를 대기 카운트에서 뺀다 (패널에 영원한 `대기 N`이 남지 않게)
    status.pending = Math.max(0, status.pending - (accepted.length - idx));
    if (status.pending === 0) status.done = 0;
    emitLive();
  }

  // 배치 후 무결성 재확인(**M5**) — 방금 넣은 것이 상태에 반영될 시간을 준 뒤에 센다
  if (result.added > 0 && live()) {
    await yieldToMain();
    void refreshPhotoIntegrity(d.knownIds());
    void refreshStorageEstimate();
  }
  return result;
}

// ================================================================
// 폴링
// ================================================================

/** 폴더를 한 번 훑어 처리 준비가 끝난 파일만 골라낸다 (**H5**) */
async function collectReadyFiles(knownIds: ReadonlySet<string>): Promise<File[]> {
  const handle = dirHandle;
  if (!handle) return [];

  const ready: File[] = [];
  const seen = new Set<string>();

  // 이름만 먼저 본다 — done 엔트리는 `getFile()`을 부르지 않는다
  for await (const [name, child] of handle.entries()) {
    seen.add(name);
    if (child.kind !== 'file') continue;

    const kind = photoFileKind(name);
    if (kind === null) {
      // 사진이 아니다 — 즉시 확정(카운트도 안 한다)
      if (!scan.get(name)?.done) scan.set(name, scanDone());
      continue;
    }
    if (kind === 'heic') {
      // Chrome이 디코드하지 못한다 — 즉시 확정하고 한 번만 센다
      if (!scan.get(name)?.done) {
        scan.set(name, scanDone());
        status.skippedHeic++;
      }
      continue;
    }

    const prev = scan.get(name);
    if (prev?.done) continue;

    let file: File;
    try {
      file = await (child as FileSystemFileHandle).getFile();
    } catch {
      // 복사 중 잠긴 파일 — 다음 틱에 다시 본다
      continue;
    }

    const id = photoKey(name, file.size, file.lastModified);
    if (knownIds.has(id)) {
      scan.set(name, scanDone(file.size, file.lastModified));
      continue;
    }

    const { entry, verdict } = scanObserve(prev, {
      size: file.size,
      lastModified: file.lastModified,
    });
    scan.set(name, entry);
    if (verdict === 'ready') ready.push(file);
  }

  // 폴더에서 사라진 파일의 엔트리는 버린다 (같은 이름으로 다시 오면 처음부터 안정화)
  for (const name of [...scan.keys()]) if (!seen.has(name)) scan.delete(name);

  return ready;
}

async function pollTick(opts: PollingOpts): Promise<void> {
  if (scanning || intaking) return; // 재진입 금지
  if (!opts.isLeader() || !opts.enabled()) return;
  if (status.dir !== 'granted' || !dirHandle) return;

  scanning = true;
  status.scanning = true;
  emit(opts);
  let ready: File[] = [];
  try {
    ready = await collectReadyFiles(opts.knownIds());
    status.lastScanAt = Date.now();
  } catch {
    // entries()가 실패했다 — 권한이 풀렸을 가능성이 높다. 상태를 다시 물어본다
    if (dirHandle) status.dir = await permissionOf(dirHandle);
  } finally {
    scanning = false;
    status.scanning = false;
    emit(opts);
  }

  if (!ready.length) return;

  intaking = true;
  try {
    const res = await intakeFiles(ready, opts);
    // **H4** 강등으로 끊긴 흡수는 재시도 대상이 아니다 — 스캔 맵도 이미 비워졌으므로
    // 여기서 엔트리를 되살리면 다음 리더의 관측과 어긋난 잔재만 남는다
    if (!res.aborted) {
      // 실패한 파일은 `tries`를 올려 두었다가 최대 3회까지 다시 시도한다
      for (const name of res.failed) {
        const entry = scan.get(name);
        if (!entry) continue;
        const { entry: next } = scanRetry(entry);
        scan.set(name, next);
      }
    }
  } catch {
    /* 흡수 전체 실패 — 다음 틱에 다시 본다 */
  } finally {
    intaking = false;
    // 강등된 창의 패널은 건드리지 않는다 (`stopPhotoIntake()`가 비운 `photoDir` 보존)
    if (opts.isLeader()) emit(opts);
  }
}

/**
 * 폴더 폴링 시작. `PHOTO_POLL_MS` 주기로 `dirHandle.entries()`를 훑되
 * **이름 우선 필터**(`ScanEntry.done`)로 아직 확정되지 않은 이름만 `getFile()`한다 —
 * 500장 폴더를 3초마다 전부 여는 것을 피하는 유일한 방법이다.
 *
 * `applyRole()`의 비리더 분기에서 반드시 정지 함수를 부른다(짝).
 */
export function startPhotoPolling(opts: PollingOpts): StopPolling {
  stopPolling(); // 중복 시작 방지 — 인수/재부팅에서 두 번 불려도 타이머는 하나다
  pollTimer = window.setInterval(() => {
    void pollTick(opts);
  }, PHOTO_POLL_MS);
  // 첫 스캔은 기다리지 않는다 (부팅 직후 폴더에 이미 사진이 있는 정상 경로)
  void pollTick(opts);
  return stopPolling;
}

function stopPolling(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }
  if (status.scanning) {
    status.scanning = false;
    emit();
  }
}

/** 폴링이 돌고 있는가 — 리더 분기 회귀 테스트·패널 상세용 */
export function isPolling(): boolean {
  return pollTimer !== 0;
}
