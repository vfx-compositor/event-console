/**
 * `media/` 폴더 기본 영상 자동 등록.
 *
 * 왜 필요한가: 에셋은 IndexedDB(브라우저별 저장소)에만 있다. 즉 다른 브라우저·다른 PC로 옮기면
 * 등록해 둔 영상이 통째로 사라진다. 행사 당일 백업 노트북에서 앱을 열었더니 영상이 없더라 —
 * 는 상황을 막으려면 **파일로 배포되는 기본 영상**이 있어야 한다.
 *
 * 방식: `public/media/manifest.json` 에 "어떤 파일을 어떤 이름·어떤 위치로 넣을지"를 적어 두고,
 * control 로드 시 그 목록을 읽어 IndexedDB에 **없는 것만** 등록한다.
 *  - assetId 는 `media:<파일명>` 으로 **고정**한다 → 여러 번 로드해도 중복 등록되지 않는다.
 *  - 사용자가 지운 항목은 `hiddenMedia`(상태)에 남아 다음 로드에서 다시 들어오지 않는다.
 *  - manifest 가 없으면(=media 폴더를 안 쓰는 설치) 조용히 넘어간다. 실패는 행사 진행을 막지 않는다.
 *  - `revision` 이 실제로 바뀌어 파일이 교체되는 경우는 그 파일에 맞춘 manifest 의 switchAt/mode 가
 *    우선한다(단, manifest 가 그 값을 명시하지 않았으면 기존 값을 유지) — 옛 파일 기준 타이밍이 새 파일에
 *    그대로 남아 전환이 어긋나는 사고를 막는다. revision 이 같거나 없는 재등록은 기존 값을 그대로 지킨다.
 *
 * 영상 자체는 git에 넣지 않는다(.gitignore). manifest.json 만 추적하므로
 * "어떤 파일이 필요한지"는 저장소에 남고, 파일은 각자 media 폴더에 복사해 넣는다.
 *
 * 행사 개조 메모: 배포 기본값은 빈 목록이다. 알파 스팅어 변환·switchAt(초)·revision
 * 예시는 docs/OPERATION_TIPS.md에 있다. 실제 파일명에 참가자 개인정보를 넣지 말고,
 * 파일 교체와 타이밍 변경을 한 작업으로 검증한다. 빈 목록에서도 실행되는 계약을 유지한다.
 */

import type { AudioSource, SceneId, VideoPlayMode } from './types';

export const MEDIA_ID_PREFIX = 'media:';

/** manifest.json 한 줄 */
export interface MediaManifestItem {
  /** media 폴더 안의 파일명 (하위 경로 불가) */
  file: string;
  /** 목록에 보일 이름 */
  name: string;
  /** 재생이 끝나면 넘어갈 씬 */
  after: SceneId;
  /** 큐시트에서 이 항목 다음에 재생 (없으면 큐에 넣지 않음) */
  cueAfter: string | null;
  /** full=영상 씬, transition=씬 교체 전환, overlay=현재 씬 위 알파 그래픽 */
  mode: VideoPlayMode;
  /** transition 모드에서 다음 씬을 교체할 재생 시각 (생략 시 기본값 0.5 로 채워짐) */
  switchAt: number;
  /** manifest 에 switchAt 이 실제로 적혀 있었을 때만 원값 보존(생략 시 undefined) —
   *  revision 교체 시 "파일에 맞춰 새로 지정한 값"과 "그냥 기본값이 채워진 것"을 구분하는 데 쓴다 */
  switchAtRaw?: number;
  /** manifest 에 mode 가 실제로 적혀 있었을 때만 원값 보존(생략 시 undefined). switchAtRaw 와 같은 이유 */
  modeRaw?: VideoPlayMode;
  /** 같은 파일명으로 배포 영상을 교체할 때 한 번만 다시 가져오는 버전 키 */
  revision?: string;
  /** full 영상 종료 후 마지막 프레임 유지. 기본 false */
  holdEndFrame: boolean;
  /** manifest에 boolean으로 명시된 경우에만 revision 교체 시 원값을 덮는다 */
  holdEndFrameRaw?: boolean;
  /**
   * full 모드 소리 여부 (U55). 오디오 트랙이 없는 파일을 매번 [영상·에셋] 탭에서 손으로
   * 무음 처리하지 않도록, manifest에서도 명시할 수 있다. 명시하지 않으면(생략) "모른다"는
   * 뜻이라 `undefined`로 남긴다 — 여기서 기본값을 채우면 사람이 다시 [🔊 소리 켬]으로 되돌린
   * 값과 구분이 안 된다. 읽는 쪽의 실제 기본값은 `a.audio ?? true`(소리 있음으로 간주).
   *
   * 이 값은 **씨앗이자 정정본**이다 (U84): 여기서 값을 고치면 이미 등록된 프로필에도 전파된다.
   * 사람이 탭에서 고른 값(`audioSource: 'operator'`)만이 이 값을 이긴다. `resolveAudioMeta` 참고.
   */
  audio?: boolean;
}

const VALID_SCENES: SceneId[] = [
  'standby',
  'live',
  'score',
  'timer',
  'roster',
  'prompt',
  'breaking',
  'video',
  'photos',
  'suspects',
  'submit',
  'award',
];

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;

export function mediaAssetId(file: string): string {
  return `${MEDIA_ID_PREFIX}${file}`;
}

export function isMediaAsset(id: string): boolean {
  return id.startsWith(MEDIA_ID_PREFIX);
}

/** `media:test_01.mp4` → `test_01.mp4`. 매니페스트 항목이 아니면 null */
export function mediaFileFromId(id: string): string | null {
  return isMediaAsset(id) ? id.slice(MEDIA_ID_PREFIX.length) : null;
}

/** 확장자로 판정한 종류. 알 수 없으면 null (등록 대상에서 제외) */
export function mediaKindOf(file: string): 'video' | 'image' | null {
  if (VIDEO_EXT.test(file)) return 'video';
  if (IMAGE_EXT.test(file)) return 'image';
  return null;
}

function baseName(file: string): string {
  return file.replace(/\.[^.]+$/, '');
}

/**
 * manifest.json 파싱 — 손으로 고치는 파일이라 관대하게 읽는다.
 * 잘못된 줄은 **버리고 나머지는 살린다**(한 줄 오타로 전체가 안 들어오면 현장에서 원인을 못 찾는다).
 */
export function parseManifest(raw: unknown): MediaManifestItem[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { files?: unknown })?.files) ? (raw as { files: unknown[] }).files : null;
  if (!arr) return [];

  const out: MediaManifestItem[] = [];
  const seen = new Set<string>();
  for (const entry of arr) {
    // 문자열 한 줄만 적어도 받아 준다: "test_01.mp4"
    const rec = typeof entry === 'string' ? { file: entry } : (entry as Record<string, unknown> | null);
    if (!rec || typeof rec !== 'object') continue;

    const file = typeof rec.file === 'string' ? rec.file.trim() : '';
    // 경로 탈출·하위 폴더는 받지 않는다 (media 폴더 한 겹만 지원 — 규칙이 단순해야 현장에서 안 헷갈린다)
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) continue;
    if (!mediaKindOf(file)) continue;
    if (seen.has(file)) continue;
    seen.add(file);

    const rawAfter = typeof rec.after === 'string' ? (rec.after as SceneId) : null;
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : baseName(file);
    const cueAfter = typeof rec.cueAfter === 'string' && rec.cueAfter.trim() ? rec.cueAfter.trim() : null;
    const hasMode = rec.mode === 'transition' || rec.mode === 'overlay' || rec.mode === 'full';
    const mode: VideoPlayMode = rec.mode === 'transition' || rec.mode === 'overlay' ? rec.mode : 'full';
    const hasSwitchAt = typeof rec.switchAt === 'number' && Number.isFinite(rec.switchAt);
    const hasHoldEndFrame = typeof rec.holdEndFrame === 'boolean';
    const hasAudio = typeof rec.audio === 'boolean';
    const rawSwitchAt = hasSwitchAt ? (rec.switchAt as number) : 0.5;
    const revision =
      typeof rec.revision === 'string' || typeof rec.revision === 'number'
        ? String(rec.revision).trim()
        : '';

    out.push({
      file,
      name,
      after: rawAfter && VALID_SCENES.includes(rawAfter) ? rawAfter : 'standby',
      cueAfter,
      mode,
      switchAt: Math.max(0, rawSwitchAt),
      holdEndFrame: rec.holdEndFrame === true,
      ...(hasSwitchAt ? { switchAtRaw: Math.max(0, rawSwitchAt) } : {}),
      ...(hasMode ? { modeRaw: mode } : {}),
      ...(hasHoldEndFrame ? { holdEndFrameRaw: rec.holdEndFrame === true } : {}),
      ...(hasAudio ? { audio: rec.audio === true } : {}),
      ...(revision ? { revision } : {}),
    });
  }
  return out;
}

/**
 * 저장된 소리 값이 **주인을 잃은 manifest 씨앗**인가 (U111).
 *
 * manifest 에서 `audio` 키를 지우면(U84) 그 값의 저자가 사라진다. 그런데 값은 이미 남의
 * IndexedDB 안에 들어가 있고, `pendingItems`가 revision 이 같은 항목을 통째로 건너뛰므로
 * `resolveAudioMeta`가 **한 번도 돌지 않는다** — 정정이 영영 전파되지 않는다.
 *
 * 실사고(U111, 2026-09-05 06:2x): U55 시절 `audio:false`로 등록된 끈끈이 낚시·몸으로 말해요
 * 인트로가, U84 가 manifest 에서 그 키를 지운 뒤에도 사용자 프로필에서 계속 무음으로 나갔다.
 * 09-04 실측이 통과했던 이유는 그때 **새 프로필**로 쟀기 때문이다 — 새 프로필은 애초에
 * 씨앗이 없으니 프로브가 정답을 넣는다. 남아 있던 프로필만 틀린 채로 남았다.
 *
 * 운영자가 카드에서 고른 값(`audioSource: 'operator'`)은 대상이 아니다 — 그 값의 저자는
 * manifest 가 아니라 사람이고, manifest 가 침묵한다고 사라질 이유가 없다.
 */
function staleManifestAudio(
  it: MediaManifestItem,
  prev: { audio?: boolean; audioSource?: AudioSource } | undefined,
): boolean {
  if (it.audio !== undefined) return false;
  if (!prev || prev.audio === undefined) return false;
  // 출처가 없으면 옛 저장본 → manifest 씨앗으로 본다 (resolveAudioMeta 와 같은 판정)
  return (prev.audioSource ?? 'manifest') === 'manifest';
}

/** 아직 등록되지 않았고, 사용자가 숨기지도 않은 항목만 */
export function pendingItems(
  items: MediaManifestItem[],
  existingIds: Iterable<string>,
  hidden: Iterable<string>,
  existingById: Record<string, { sourceRevision?: string; audio?: boolean; audioSource?: AudioSource }> = {},
): MediaManifestItem[] {
  const have = new Set(existingIds);
  const skip = new Set(hidden);
  return items.filter((it) => {
    if (skip.has(it.file)) return false;
    const id = mediaAssetId(it.file);
    if (!have.has(id)) return true;
    const prev = existingById[id];
    if (it.revision && prev?.sourceRevision !== it.revision) return true;
    // 주인 잃은 manifest 씨앗은 다시 실측해야 한다 (U111). `resolveAudioMeta`가 그 값을
    // 폐기하므로 이 조건은 **한 번만** 참이다 — 매 부팅 재적재로 돌지 않는다.
    return staleManifestAudio(it, prev);
  });
}

/**
 * manifest 에서 빠진(=파일이 삭제되거나 항목이 지워진) media-origin 에셋 id.
 *
 * `syncMediaManifest`/`pendingItems`는 **추가만** 한다 — manifest 에 더는 없는 항목을 IndexedDB
 * 에서 지우는 경로가 없어서, 한 번 등록된 media 폴더 에셋은 manifest 에서 빼도 에셋 탭에
 * 유령처럼 계속 남는다(실사고: `test_01.mp4`— 2026-08-27 등록 후 나중에 manifest 에서 제거됐지만
 * 사용자 IndexedDB 엔 27.7MB blob 이 그대로 남아 계속 노출됨, `docs/DEV_LOG.md` 2026-08-27 기록).
 * 이 함수는 그 정리 대상만 골라낸다 — 실제 삭제·상태 참조 무효화는 호출부 책임.
 *
 * 사용자가 직접 올린 에셋(`media:` 접두 없음)은 대상에서 제외한다 — manifest 와 무관하게 살아야 한다.
 */
export function orphanedMediaAssetIds(items: MediaManifestItem[], existingIds: Iterable<string>): string[] {
  const declared = new Set(items.map((it) => mediaAssetId(it.file)));
  const out: string[] = [];
  for (const id of existingIds) {
    if (isMediaAsset(id) && !declared.has(id)) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------- orphan 정리 뒤처리

/** `sceneOpts.video.phase` — control이 그대로 넘겨준다 (여기서 types를 끌어오지 않는다) */
export type OrphanVideoPhase = 'idle' | 'covering' | 'playing' | 'holding' | 'revealing';

/**
 * 사라진 에셋을 속보 연결 영상으로 물고 있을 때 그 참조를 **지금 지울 것인가**.
 *
 * 재생 중(`phase !== 'idle'`)에 슬롯을 비우면 display가 `src`를 잃는다. 그러면 tail 이벤트가
 * 영영 오지 않아 `revealing`으로 넘어가지 못하고 화면이 검정에 머문다 — 본방에서 복구할 방법이
 * 리로드밖에 없는 사고다. 그래서 재생 중이면 미뤘다가 다음 idle에서 지운다.
 */
export type OrphanVideoRefAction = 'clear' | 'defer' | 'none';

export function orphanVideoRefAction(
  currentAssetId: string | null,
  phase: OrphanVideoPhase,
  orphanIds: readonly string[],
): OrphanVideoRefAction {
  if (!currentAssetId || !orphanIds.includes(currentAssetId)) return 'none';
  return phase === 'idle' ? 'clear' : 'defer';
}

/**
 * 미뤄 둔 무효화를 실제로 반영할 때가 됐는가.
 * `drop`은 그 사이 사람이 다른 영상을 골랐다는 뜻 — 미뤄 둔 값으로 덮어쓰면 안 된다.
 */
export function pendingOrphanVideoRefAction(
  pendingAssetId: string,
  currentAssetId: string | null,
  phase: OrphanVideoPhase,
): 'clear' | 'wait' | 'drop' {
  if (phase !== 'idle') return 'wait';
  return currentAssetId === pendingAssetId ? 'clear' : 'drop';
}

/**
 * 저장본에 남은 **죽은** 속보 연결 영상 참조인가 — 목록에 없는 assetId를 물고 있는 상태.
 *
 * `pendingOrphanVideoAssetId`는 모듈 변수라 새로고침에 사라진다. 재생 중에 orphan이 생기고
 * 그대로 창을 닫으면 저장본에 없는 에셋 id가 영구히 남아, F9를 눌러도 `durationSec`이
 * undefined라 워치독이 무장하지 않는다(=속보 체인이 멈춘 채로 남는다). 부팅·에셋 갱신마다
 * 이 판정으로 쓸어낸다. 재생 중에는 건드리지 않는 것이 여전히 계약이다.
 */
export function deadVideoAssetRef(
  currentAssetId: string | null,
  phase: OrphanVideoPhase,
  knownIds: Iterable<string>,
): boolean {
  if (!currentAssetId || phase !== 'idle') return false;
  for (const id of knownIds) {
    if (id === currentAssetId) return false;
  }
  return true;
}

// ---------------------------------------------------------------- 로드 상태 (에셋 탭 안내용)

export type MediaStatusKind = 'idle' | 'ok' | 'absent' | 'error';

export interface MediaStatus {
  kind: MediaStatusKind;
  /** manifest 에 적힌 항목 수 */
  total: number;
  /** 이번 로드에서 새로 등록한 수 */
  added: number;
  /** 내려받지 못한 파일명 */
  failed: string[];
}

let status: MediaStatus = { kind: 'idle', total: 0, added: 0, failed: [] };

export function getMediaStatus(): MediaStatus {
  return status;
}

/** 테스트·재로드용 */
export function resetMediaStatus(): void {
  status = { kind: 'idle', total: 0, added: 0, failed: [] };
}

// ---------------------------------------------------------------- 실제 로드

/** 이미 등록된 항목의 현재 메타 — 다시 넣을 때 사람이 고친 값을 덮지 않기 위해 들고 다닌다 */
export interface ExistingMeta {
  name?: string;
  nextScene?: SceneId | null;
  cueAfter?: string | null;
  playMode?: VideoPlayMode;
  switchAtSec?: number;
  order?: number;
  sourceRevision?: string;
  /**
   * full 모드 소리 여부. manifest 가 명시할 수도 있고(U55), 사람이 [영상·에셋] 탭에서 고칠
   * 수도 있다 — **사람이 고친 값이 항상 우선**이다. 다시 넣을 때 실어 주지 않으면
   * 재적재(=probe 재시도·revision 교체)마다 기본값(켬)으로 되돌아가, 무음으로 맞춰 둔
   * 영상이 리허설 없이 소리를 낸다.
   */
  audio?: boolean;
  /**
   * `audio` 를 누가 정했는가 (U84). 없으면 `'manifest'` 로 본다 — 옛 저장본은 manifest 씨앗과
   * 사람이 고친 값을 구분할 수 없으므로 "manifest 정정이 전파되는" 쪽을 택한다.
   */
  audioSource?: AudioSource;
  /** 파일 교체 후 사람이 고른 소리 설정을 확인해야 하는 상태 (U84) */
  audioRecheck?: boolean;
  /** 사람이 에셋 탭에서 고른 마지막 프레임 유지 여부 */
  holdEndFrame?: boolean;
}

/** {@link resolveAudioMeta} 의 결과 — 그대로 저장 레코드에 펼친다 */
export interface ResolvedAudioMeta {
  audio?: boolean;
  audioSource?: AudioSource;
  audioRecheck?: boolean;
}

/**
 * 다시 넣을 때 저장할 `audio`/`audioSource`/`audioRecheck` 를 정한다 (U84).
 *
 * **우선순위: 사람 > manifest 명시 > 파일 실측(probe) > 기본값(소리 있음).**
 *
 *  1. 사람이 [영상·에셋] 탭에서 고른 값(`audioSource === 'operator'`)은 **언제나** 이긴다.
 *     단 revision 이 바뀌었으면(=파일 자체가 교체됨) 그 판단이 옛 파일 기준일 수 있으므로
 *     값은 지키되 `audioRecheck` 를 세워 카드에 확인 칩을 띄운다. 사람 선택을 말없이 덮는 것보다
 *     "새 파일이 왔으니 한 번 보라"고 말하는 편이 안전하다.
 *  2. manifest 가 `audio` 를 boolean 으로 명시하면 그 값을 쓴다. 파일이 무엇이든 이 선언을 따르는
 *     것이 운영 결정인 자리가 있다(스팅어·매치 오버레이는 트랙이 있어도 절대 소리를 내면 안 된다).
 *     여기서 값을 고치면 이미 등록된 프로필까지 **정정이 전파된다**.
 *  3. 등록할 때 파일을 열어 확인한 오디오 트랙 유무(`probeAudio`)를 쓴다. 파일이 정답이므로
 *     **파일을 갈아 끼우면 자동으로 따라간다** — manifest 표를 손볼 필요가 없다.
 *  4. 아무도 말이 없으면 기존 값을 그대로 둔다(없으면 키 자체를 쓰지 않는다 — 읽는 쪽의
 *     `?? true` 폴백을 흐리지 않기 위해). revision 이 바뀌었더라도 **모를 때는 지운 것보다 지킨
 *     것이 낫다** — 새로 알아낸 사실이 하나도 없는데 기본값(켬)으로 되돌리면, 무음 파일이
 *     교체될 때마다 음악 덕킹이 2초씩 헛돈다.
 *     **예외(U111): 지키는 것은 저자가 있는 값뿐이다.** 출처가 `manifest` 인데 manifest 가 더는
 *     그 키를 말하지 않으면 저자가 사라진 값이므로 폐기한다 — 아래 주석 참고.
 */
export function resolveAudioMeta(
  prev: Pick<ExistingMeta, 'audio' | 'audioSource' | 'audioRecheck'> | undefined,
  manifestAudio: boolean | undefined,
  probeAudio: boolean | undefined,
  revisionChanged: boolean,
): ResolvedAudioMeta {
  // 값이 없으면 출처도 없다. 값이 있는데 출처가 없으면 옛 저장본 → manifest 씨앗으로 본다.
  const prevSource: AudioSource | undefined =
    prev?.audio === undefined ? undefined : (prev.audioSource ?? 'manifest');

  if (prevSource === 'operator') {
    // 아직 확인하지 않은 알림은 재적재(probe 재시도)로 조용히 사라지면 안 된다 — 사람이 소리
    // 버튼을 다시 누를 때까지 들고 있는다.
    const recheck = revisionChanged || prev?.audioRecheck === true;
    return {
      audio: prev!.audio,
      audioSource: 'operator',
      ...(recheck ? { audioRecheck: true } : {}),
    };
  }
  if (manifestAudio !== undefined) return { audio: manifestAudio, audioSource: 'manifest' };
  if (probeAudio !== undefined) return { audio: probeAudio, audioSource: 'probe' };
  /**
   * manifest 씨앗인데 manifest 가 더는 그 값을 말하지 않으면 **폐기한다** (U111).
   *
   * 규칙 4의 "모를 때는 지킨다"는 값에 저자가 있을 때의 이야기다(운영자·프로브). manifest 가
   * 키를 지웠다는 것은 "이 값은 내 것이 아니다"라는 선언이므로, 지키면 저자 없는 값이
   * 영원히 남는다 — U111 무음 사고가 정확히 그것이다. 지우면 읽는 쪽의 `?? true` 폴백이
   * 소리 켬으로 되돌리고, 그 판단이 틀렸으면 카드 토글 한 번으로 `operator` 로 고정된다.
   * 프로브가 실패해 여기까지 온 경우도 같다: 매 부팅 재적재를 도는 것보다 한 번 지우는 편이
   * 낫다(`staleManifestAudio` 가 다음 부팅부터 거짓이 된다).
   */
  if (prevSource === 'manifest') return {};
  return prev?.audio === undefined ? {} : { audio: prev.audio, audioSource: prevSource };
}

export interface SyncDeps {
  /**
   * **건너뛸** 에셋 id. 보통 "이미 등록된 것 전부"지만,
   * 썸네일·길이를 못 뽑은 항목은 일부러 빼서 다시 시도하게 할 수 있다.
   * (백그라운드 탭에서 열면 Chrome이 영상 디코딩을 미뤄 probe가 실패한다 — 그때 [다시 불러오기]로 복구)
   */
  existingIds: string[];
  /** id → 현재 메타. 다시 넣을 때 이름·재생 후·큐시트·순서를 그대로 유지한다 */
  existingById?: Record<string, ExistingMeta>;
  /** 사용자가 삭제해 다시 넣지 않을 파일명 */
  hidden: string[];
  /**
   * 영상 썸네일·길이·오디오 트랙 유무 추출 (control/tab-assets 의 probeVideo 재사용).
   * `hasAudio` 는 **판정에 성공했을 때만** 실린다 — 브라우저가 알려 주지 않으면 생략한다(U84).
   */
  probe(
    blob: Blob,
    name: string,
  ): Promise<{ durationSec?: number; thumbDataUrl?: string; hasAudio?: boolean }>;
  /** IndexedDB 저장 */
  put(rec: {
    id: string;
    name: string;
    type: 'video' | 'image';
    kind: 'media';
    mime: string;
    size: number;
    blob: Blob;
    addedAt: number;
    order: number;
    nextScene: SceneId | null;
    cueAfter: string | null;
    playMode: VideoPlayMode;
    switchAtSec: number;
    durationSec?: number;
    thumbDataUrl?: string;
    probeFailed?: boolean;
    sourceRevision?: string;
    audio?: boolean;
    audioSource?: AudioSource;
    audioRecheck?: boolean;
    holdEndFrame?: boolean;
  }): Promise<unknown>;
  /** 다음 order 시작값 */
  orderStart?: number;
  /** 기본 `media/` — 테스트에서 갈아 끼운다 */
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface SyncResult extends MediaStatus {
  /** manifest 에 있는 항목 전체 (등록 여부 무관) */
  items: MediaManifestItem[];
}

/**
 * manifest 를 읽어 없는 항목만 등록한다.
 * 반환값의 `kind`:
 *  - `absent`  manifest 자체가 없다 (media 폴더를 쓰지 않는 설치) → 안내 한 줄만
 *  - `error`   manifest 는 있는데 읽지 못했다 (JSON 오타 등)
 *  - `ok`      정상. added 가 0이어도 ok (이미 다 들어와 있는 정상 상태)
 */
export async function syncMediaManifest(deps: SyncDeps): Promise<SyncResult> {
  const base = deps.baseUrl ?? 'media/';
  const doFetch = deps.fetchFn ?? fetch;

  let raw: unknown;
  try {
    const res = await doFetch(`${base}manifest.json`, { cache: 'no-cache' });
    if (!res.ok) {
      status = { kind: 'absent', total: 0, added: 0, failed: [] };
      return { ...status, items: [] };
    }
    raw = await res.json();
  } catch {
    // 404 도, JSON 오타도 여기로 온다. 파일 유무는 구분할 수 없으므로 '없음'으로 본다.
    status = { kind: 'absent', total: 0, added: 0, failed: [] };
    return { ...status, items: [] };
  }

  const items = parseManifest(raw);
  if (!items.length) {
    status = { kind: 'error', total: 0, added: 0, failed: [] };
    return { ...status, items: [] };
  }

  const todo = pendingItems(items, deps.existingIds, deps.hidden, deps.existingById);
  let order = deps.orderStart ?? deps.existingIds.length;
  let added = 0;
  const failed: string[] = [];

  for (const it of todo) {
    const type = mediaKindOf(it.file)!;
    const id = mediaAssetId(it.file);
    // 이미 있던 항목을 다시 넣는 경우(=probe 재시도) 사람이 고친 값이 우선이다.
    // 단, revision 이 실제로 바뀌어 파일 자체가 교체된 경우엔 그 파일에 맞춘 manifest 값이 우선한다
    // (manifest 가 값을 명시하지 않았으면 여전히 기존 값을 지킨다 — *Raw 가 undefined 인 경우).
    const prev = deps.existingById?.[id];
    const revisionChanged = Boolean(prev && prev.sourceRevision !== it.revision);
    try {
      const res = await doFetch(`${base}${encodeURIComponent(it.file)}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      // `hasAudio` 는 저장 레코드의 필드가 아니라 판정 재료다 — 따로 뽑아 두고 나머지만 펼친다
      const { hasAudio, ...probe } = type === 'video' ? await deps.probe(blob, it.file) : {};
      // 소리 여부는 "누가 정했는가"까지 보고 정한다 (U84) — 자세한 순서는 resolveAudioMeta 주석.
      const resolvedAudio = resolveAudioMeta(prev, it.audio, hasAudio, revisionChanged);
      await deps.put({
        id,
        name: prev?.name || it.name,
        type,
        kind: 'media',
        mime: blob.type || (type === 'video' ? 'video/mp4' : 'image/png'),
        size: blob.size,
        blob,
        addedAt: Date.now(),
        order: prev?.order ?? order++,
        nextScene: prev?.nextScene !== undefined ? prev.nextScene : it.after,
        cueAfter: prev?.cueAfter !== undefined ? prev.cueAfter : it.cueAfter,
        playMode: revisionChanged ? (it.modeRaw ?? prev?.playMode ?? it.mode) : (prev?.playMode ?? it.mode),
        switchAtSec: revisionChanged
          ? (it.switchAtRaw ?? prev?.switchAtSec ?? it.switchAt)
          : (prev?.switchAtSec ?? it.switchAt),
        // (조건부 스프레드인 이유: 값이 없을 때 `audio: undefined`를 쓰면 IndexedDB 레코드에
        //  undefined 키가 남아 `a.audio ?? true` 폴백과 구분이 흐려진다. resolveAudioMeta 는
        //  값이 없으면 빈 객체를 돌려주므로 여기서는 그대로 펼치면 된다)
        ...resolvedAudio,
        holdEndFrame: revisionChanged
          ? (it.holdEndFrameRaw ?? prev?.holdEndFrame ?? it.holdEndFrame)
          : (prev?.holdEndFrame ?? it.holdEndFrame),
        ...probe,
        probeFailed: type === 'video' && probe.durationSec === undefined,
        ...(it.revision ? { sourceRevision: it.revision } : {}),
      });
      added += 1;
    } catch {
      failed.push(it.file);
    }
  }

  status = { kind: 'ok', total: items.length, added, failed };
  return { ...status, items };
}
