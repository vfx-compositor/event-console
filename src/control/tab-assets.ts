/**
 * 영상·에셋 탭 — 행사에는 영상이 **여러 개** 들어간다(게임 설명, 반전, 검거 연결, 범행 동기, 종결…).
 *
 * 설계:
 *  - blob은 IndexedDB에 **복사 없이** 그대로 넣는다(File은 이미 Blob이다). 27MB짜리도 문제없다.
 *  - 등록 시 첫 프레임 썸네일과 길이를 뽑아 목록에서 바로 구분할 수 있게 한다.
 *  - 각 영상마다 "재생 후 다음 씬"과 "큐시트 위치(cueAfter)"를 지정한다 → [다음] 버튼 하나로 재생된다.
 *  - 재생 제어(재생/일시정지/처음으로/스킵)는 상태를 통해 display에 전달한다(리더는 control 하나).
 */

import { CUE, effectiveCueAfter, isScriptedCueAsset } from '../cue';
import { MUSIC_TRACKS, musicTrack } from '../music';
import { assetMusicTrackId, introMusicDefaultForAsset, musicTrackUpgrades } from '../asset-music';
import {
  assetCardMeta,
  assetSections,
  assetThumbFallback,
  nextAssetCardFocus,
  type AssetSectionId,
} from './asset-sections';
import { countRulesUsing } from '../transition-rules';
import { deleteAsset, listMediaAssets, patchAsset, playableBlob, putAsset } from '../db';
import { describeRulesUsing, effectiveDefaultAssetId, renderTransitionRules } from './transition-rules-ui';
import { getMediaStatus, isMediaAsset, mediaFileFromId } from '../media-manifest';
import { scriptedOutroForAsset } from '../scripted-outro';
import { el } from './dom';
import { openModal } from './modal';
import { toast } from './toast';
import type { AssetMeta, SceneId, VideoPlayMode } from '../types';
import type { Ctx } from './ctx';

export const meta = { id: 'assets', label: '영상·에셋' };

export function fmtDuration(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 오디오 트랙 판정에 쓰는 무음 재생 시간(ms)과 확인 간격 (U84).
 * 300ms 면 Chromium 이 첫 오디오 패킷을 디코딩하기에 충분하고, 등록 한 편당 비용도 무시할 만하다.
 */
const AUDIO_PROBE_MS = 300;
const AUDIO_PROBE_STEP_MS = 50;

/**
 * 이 영상에 **오디오 트랙이 있는가** (U84). 모르면 `undefined` — 절대 추측하지 않는다.
 *
 * 왜 필요한가: 브라우저는 "소리가 있는 파일인가"를 표준 API 로 알려 주지 않는다. 그래서 U55 는
 * manifest 에 손으로 적게 했는데, 그 표가 틀리면(2026-09-04 사고) 무음으로 굳는다. 파일을 갈아
 * 끼울 때마다 표를 고치는 것도 잊기 쉽다 — 파일이 정답을 갖고 있으니 파일에게 묻는다.
 *
 * 두 경로:
 *  ① `audioTracks` — 표준 API 지만 Chromium 에는 없다. 있으면 그걸로 끝난다.
 *  ② `webkitAudioDecodedByteCount` — Chromium 전용. **디코딩된 오디오 바이트 수**라 muted
 *     재생에도 올라간다(음소거는 출력만 끊지 디코딩을 멈추지 않는다). 0 이면 잠깐 틀어 보고
 *     다시 센다. 둘 다 없으면 `undefined`(모른다)를 돌려주고 판단은 상위 규칙에 맡긴다.
 *
 * 재생하다 남긴 엘리먼트가 백그라운드에서 계속 돌면 안 되므로 반드시 `pause()` 하고 나온다
 * (호출부의 `finally` 가 `src` 해제·`revokeObjectURL` 까지 마무리한다).
 */
async function detectAudioTrack(v: HTMLVideoElement): Promise<boolean | undefined> {
  const tracks = (v as unknown as { audioTracks?: { length: number } }).audioTracks;
  if (tracks && typeof tracks.length === 'number') return tracks.length > 0;

  const decoded = (): number | undefined =>
    (v as unknown as { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount;
  if (typeof decoded() !== 'number') return undefined;
  if ((decoded() ?? 0) > 0) return true;

  try {
    // muted 재생이라 자동재생 정책에 걸리지 않는다. 그래도 거부되면 "모른다"로 남긴다 —
    // 여기서 false 를 돌려주면 소리 있는 영상이 조용히 무음으로 굳는다(바로 그 사고).
    await v.play();
  } catch {
    return undefined;
  }
  try {
    for (let waited = 0; waited < AUDIO_PROBE_MS; waited += AUDIO_PROBE_STEP_MS) {
      await new Promise<void>((r) => window.setTimeout(r, AUDIO_PROBE_STEP_MS));
      if ((decoded() ?? 0) > 0) return true;
    }
  } finally {
    v.pause();
  }
  return (decoded() ?? 0) > 0;
}

/** 첫 프레임 썸네일 + 길이 + 오디오 트랙 유무. 실패해도 등록 자체는 계속된다. */
export async function probeVideo(
  blob: Blob,
  name: string,
): Promise<{ durationSec?: number; thumbDataUrl?: string; hasAudio?: boolean }> {
  const url = URL.createObjectURL(playableBlob({ blob, mime: blob.type, name }));
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const to = window.setTimeout(() => reject(new Error('timeout')), 8000);
      v.onloadeddata = () => {
        window.clearTimeout(to);
        resolve();
      };
      v.onerror = () => {
        window.clearTimeout(to);
        reject(new Error('load'));
      };
    });
    const durationSec = Number.isFinite(v.duration) ? v.duration : undefined;
    // 0초 프레임은 검은 화면인 경우가 많아 살짝 뒤에서 뽑는다
    await new Promise<void>((resolve) => {
      const to = window.setTimeout(resolve, 1500);
      v.onseeked = () => {
        window.clearTimeout(to);
        resolve();
      };
      v.currentTime = Math.min(0.6, (durationSec ?? 1) / 2);
    });
    const w = 160;
    const h = Math.max(1, Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * w));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.drawImage(v, 0, 0, w, h);
    const thumbDataUrl = canvas.toDataURL('image/jpeg', 0.6);
    // 썸네일을 뽑은 **뒤에** 판정한다 — 재생이 currentTime 을 움직이므로 순서를 바꾸면 그림이 흔들린다
    const hasAudio = await detectAudioTrack(v);
    return { durationSec, thumbDataUrl, ...(hasAudio !== undefined ? { hasAudio } : {}) };
  } catch {
    return {};
  } finally {
    v.pause();
    v.src = '';
    URL.revokeObjectURL(url);
  }
}

/**
 * 재생 방식별 `holdEndFrame` 기본값 (U50).
 *
 * 사용자 지시: "모든 미디어 영상들은 끝나고 마지막 프레임 홀드. 스팅어는 당연히 제외."
 * 현장에서 영상이 끝나자마자 화면이 튀는 것보다, 마지막 그림에서 멈춰 있다가 MC 멘트에 맞춰
 * 운영자가 넘기는 편이 안전하다. 전환 오버레이(스팅어)는 **끝나면 사라지는 것이 존재 이유**라
 * 예외다 — 홀드하면 화면에 스팅어 마지막 프레임이 눌어붙는다.
 */
export function defaultHoldEndFrame(playMode: VideoPlayMode | undefined): boolean {
  return (playMode ?? 'full') !== 'transition';
}

/**
 * `끝 프레임 유지` 토글이 **의미가 없어지는** 영상인가 (U88, U87 후속).
 *
 * 대본 고정 아웃트로가 붙은 영상은 끝을 아웃트로가 책임진다 — 마지막 5초에 오디오를 내리며
 * 화이트로 덮고 대기 화면으로 돌아간다. 여기서 마지막 프레임을 붙잡으면 그 꼬리 페이드가
 * **영영 시작되지 않아** 하얗게 얼어붙은 화면이 방송에 나간다(`scripted-outro.ts` 계약 3번).
 *
 * display는 이미 이 값을 무시하지만, 화면에 살아 있는 토글은 "눌렀는데 아무 일도 안 나는"
 * 손잡이다. 운영자가 본방 중에 그 앞에서 두 번 세 번 누르게 만드는 것이 이 잠금이 없앨 사고다.
 */
export function holdEndFrameLocked(assetId: string): boolean {
  return scriptedOutroForAsset(assetId) !== null;
}

/** 왜 못 누르는지 — 툴팁과 토스트가 **같은 문장**을 쓴다 */
export const HOLD_END_FRAME_LOCK_TIP =
  '대본 고정 아웃트로 — 이 영상은 끝 프레임 유지 대신 5초 오디오 페이드 후 화이트로 대기화면 복귀';

async function ingest(files: FileList | File[] | Blob[], ctx: Ctx, nameHint = ''): Promise<void> {
  let added = 0;
  const failed: string[] = [];
  let order = ctx.state.assets.length;
  for (const file of Array.from(files)) {
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    if (!isVideo && !isImage) continue;
    const name = (file as File).name || nameHint || (isVideo ? '영상' : '이미지');
    const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // `hasAudio` 는 레코드 필드가 아니라 판정 재료다 — 따로 뽑고 나머지만 펼친다 (U84)
    const { hasAudio, ...probe } = isVideo ? await probeVideo(file, name) : {};
    await putAsset({
      id,
      name,
      type: isVideo ? 'video' : 'image',
      kind: 'media',
      mime: file.type,
      size: file.size,
      blob: file,
      addedAt: Date.now(),
      order: order++,
      nextScene: 'standby',
      cueAfter: null,
      // 새로 올린 영상도 기본은 끝 프레임 홀드다 (U50). 카드에서 개별 해제할 수 있다.
      holdEndFrame: isVideo ? defaultHoldEndFrame('full') : false,
      // 파일에 오디오 트랙이 있는지 확인됐으면 그 값으로 시작한다 (U84). 판정에 실패하면 키를
      // 쓰지 않아 읽는 쪽의 `?? true`(소리 있음) 폴백이 그대로 걸린다.
      ...(hasAudio !== undefined ? { audio: hasAudio, audioSource: 'probe' as const } : {}),
      ...probe,
      // 길이를 못 읽었다면 브라우저가 이 파일을 열지 못한 것 — 현장에서 검은 화면이 되기 전에 알린다
      probeFailed: isVideo && probe.durationSec === undefined,
    });
    added += 1;
    if (isVideo && probe.durationSec === undefined) failed.push(name);
  }
  ctx.reloadAssets();
  toast(added ? `${added}개 등록했습니다` : '지원하지 않는 파일 형식입니다', added ? 'ok' : 'bad');
  if (failed.length) {
    toast(`${failed.join(', ')} — 브라우저가 열지 못했습니다. MP4로 변환해 다시 등록하세요`, 'bad');
  }
}

/** 파일이 교체됐는데 사람이 고른 소리 설정을 그대로 지킨 항목 안내 (U84) */
const AUDIO_RECHECK_HINT =
  '파일이 바뀌었습니다 — 소리 설정 확인. 이 항목은 소리를 직접 지정해 두셔서 새 파일에도 그 설정을 ' +
  '그대로 유지했습니다. 새 파일에 맞는지 확인하고 아래 [소리] 버튼을 한 번 누르면 이 안내가 사라집니다.';

/** 재생 불가 영상 안내 (QuickTime `qt` 브랜드 .mov 등) */
const REMUX_HINT =
  '이 브라우저가 파일을 열지 못했습니다. QuickTime(.mov) 원본은 Chrome이 재생하지 못하는 경우가 있습니다. ' +
  '터미널에서 `ffmpeg -i 원본.mov -c copy -movflags +faststart -brand mp42 변환본.mp4` 로 바꾼 뒤 다시 등록하세요.';

/**
 * 배경 곡 드롭다운 안내 (U124) — 이 자리가 왜 있는지, 무엇을 조심해야 하는지.
 *
 * 소리 있는 영상에도 열어 두는 이유: 어느 쪽이 맞는지는 현장이 정한다(내레이션 밑에 음악을
 * 깔고 싶을 수 있다). 대신 겹친다는 사실을 그 자리에서 말해 준다.
 */
function assetMusicFieldTip(asset: AssetMeta): string {
  const base =
    '이 영상이 나가는 순간 함께 걸릴 곡입니다 (U124). 영상 시작과 동시에 컷으로 들어가고' +
    '(페이드 없음), 그 곡에 북마크(U47)를 찍어 두었으면 그 지점부터 나갑니다. ' +
    '곡을 지정한 영상은 음악 자동 덕킹 대상에서 빠집니다 — 내렸다가 곧바로 새 곡을 올리는 ' +
    '왕복이 되기 때문입니다. 영상이 끝나도 곡은 계속 흐릅니다([음악] 탭이나 다음 큐가 정리).';
  return asset.audio === false
    ? `${base} 이 영상은 무음이라 이 곡이 그대로 장면의 소리가 됩니다.`
    : `${base} ⚠ 이 영상은 소리가 있어, 곡을 지정하면 영상 소리 위에 겹칩니다.`;
}

/** 지정 곡 칩 hover — 어디서 온 값인지가 근거다 (U124) */
function assetMusicChipTip(asset: AssetMeta, label: string): string {
  const source =
    asset.musicTrackId === undefined
      ? '진행 대본이 정한 기본값입니다(원본 파일에 오디오 트랙이 없어 곡을 빌려 왔습니다).'
      : '운영자가 아래 [배경 음악]에서 고른 값입니다.';
  const overlap =
    asset.audio === false
      ? '이 영상은 무음이라 이 곡이 그대로 장면의 소리가 됩니다.'
      : '⚠ 이 영상은 소리가 있어, 이 곡이 영상 소리 위에 겹칩니다.';
  return `배경 음악 · ${label} — ${source} ${overlap} 영상 시작과 동시에 컷으로 들어가고 자동 덕킹은 걸리지 않습니다.`;
}

/** 큐시트 배치 선택지 — 기본 큐 항목들 */
const CUE_CHOICES = CUE.map((c) => ({ id: c.id, label: c.label }));

/**
 * `재생 후` 드롭다운의 씬 목록.
 * `video`는 넣지 않는다(영상 다음에 다시 영상 씬), `breaking`도 넣지 않는다(F9 속보 체인 소유).
 * `suspects`·`submit`의 `(잠금)` 표기는 이미 배포된 현행 그대로 둔다.
 */
const NEXT_SCENES: { id: SceneId; label: string }[] = [
  { id: 'standby', label: '대기 화면' },
  { id: 'live', label: '경기 중계' },
  { id: 'score', label: '스코어보드' },
  { id: 'timer', label: '타이머' },
  { id: 'roster', label: '출전 명단' },
  { id: 'prompt', label: '제시어 카드' },
  { id: 'photos', label: '현장 사진' },
  { id: 'suspects', label: '보드 (잠금)' },
  { id: 'submit', label: '단계 진행 (잠금)' },
  { id: 'award', label: '시상' },
];

/** `null` = 지정 없음 = 재생 직전 씬으로 복귀. `undefined`(구 저장본)는 기존대로 standby */
function nextSceneOf(a: AssetMeta): SceneId | null {
  return a.nextScene === null ? null : (a.nextScene ?? 'standby');
}

function move(ctx: Ctx, id: string, dir: -1 | 1): void {
  const list = [...ctx.state.assets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const i = list.findIndex((a) => a.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const next = list.map((a, k) => ({ ...a, order: k }));
  ctx.dispatch({ type: 'assets/set', assets: next });
  for (const a of next) void patchAsset(a.id, { order: a.order });
}

/**
 * 섹션 접힘 상태 (U39).
 *
 * 상태(AppState)가 아니라 탭 로컬 값이다 — 출력 화면과 무관하고 되돌리기 대상도 아니다.
 * 모듈 로컬이라야 전체 재렌더가 잦은 이 패널에서 접어 둔 묶음이 다시 펴지지 않는다
 * (음악 탭 섹션에서 겪은 문제와 같은 이유).
 */
const collapsedSections = new Set<AssetSectionId>();

/** 카드 그리드 열 수 — CSS `minmax(260px, 1fr)`와 같은 값에서 나온다(키보드 상하 이동용). */
function assetGridCols(gridEl: HTMLElement | null): number {
  if (!gridEl) return 1;
  const cols = getComputedStyle(gridEl).gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, cols);
}

function assetCard(ctx: Ctx, a: AssetMeta, i: number, total: number): HTMLElement {
  const s = ctx.state;
  const isBreak = s.sceneOpts.video.assetId === a.id && s.scene !== 'video';
  const isKv = s.settings.keyVisualAssetId === a.id;
  // 규칙이 없는 전환에 **실제로** 쓰이는 에셋 (명시 기본값 → 없거나 못 쓰면 첫 전환 에셋 폴백)
  const isDefaultTransition = effectiveDefaultAssetId(s) === a.id;
  const mode: VideoPlayMode = a.playMode ?? 'full';
  const ruleCount = mode === 'transition' ? countRulesUsing(s.transitionRules, a.id) : 0;
  const nextScene = nextSceneOf(a);
  // 큐 표시·조작은 저장값이 아니라 실제 배치값 기준이다 (대본 고정 영상은 저장값을 무시한다)
  const scriptedCue = isScriptedCueAsset(a.id);
  const cueAfter = effectiveCueAfter(a);
  const transitionPlaying =
    s.sceneOpts.transitionVideo.active && s.sceneOpts.transitionVideo.assetId === a.id;
  const overlayPlaying = s.sceneOpts.overlayVideo.active && s.sceneOpts.overlayVideo.assetId === a.id;
  const playing =
    (s.scene === 'video' && s.sceneOpts.video.assetId === a.id) || transitionPlaying || overlayPlaying;

  const patch = (p: Partial<AssetMeta>) => {
    ctx.dispatch({
      type: 'assets/set',
      assets: s.assets.map((x) => (x.id === a.id ? { ...x, ...p } : x)),
    });
    void patchAsset(a.id, p);
  };

  const cardMeta = assetCardMeta(a);
  const play = () => {
    if (a.type !== 'video') {
      ctx.dispatch({ type: 'settings/patch', patch: { keyVisualAssetId: a.id } });
      toast('키비주얼로 지정했습니다');
      return;
    }
    if (mode === 'transition') {
      ctx.dispatch({
        type: 'transition/play',
        assetId: a.id,
        // 전환 오버레이는 반드시 도착 씬이 있어야 한다 — 미지정은 대기 화면
        nextScene: nextScene ?? 'standby',
        switchAtSec: a.switchAtSec ?? 0.5,
        now: Date.now(),
      });
    } else if (mode === 'overlay') {
      ctx.dispatch({
        type: 'overlay/play',
        assetId: a.id,
        holdEndFrame: a.holdEndFrame === true,
        now: Date.now(),
      });
    } else {
      // null이면 "재생 직전 씬으로 복귀" — control이 returnScene을 스냅샷한다
      ctx.playAsset(a.id, nextScene);
    }
  };

  return el(
    'li',
    {
      class: `assetcard${playing ? ' is-playing' : ''}`,
      // roving tabindex — Tab 한 번에 묶음 안으로 들어오고, 안에서는 방향키로 옮긴다
      tabIndex: i === 0 ? 0 : -1,
      data: { cardIndex: String(i), fid: `asset-card-${a.id}` },
      attrs: {
        'aria-label': playing
          ? `${a.name}, ${transitionPlaying ? '전환 재생 중' : overlayPlaying ? '매치 오버레이 재생 중' : '재생 중'}`
          : a.name,
      },
      on: {
        keydown: (ev) => {
          // 카드 안 입력·셀렉트를 조작하는 중에는 끼어들지 않는다 (전역 규칙)
          const target = ev.target as HTMLElement;
          if (target !== ev.currentTarget) return;
          if (ev.key === 'Enter') {
            ev.preventDefault();
            play();
            return;
          }
          const grid = (ev.currentTarget as HTMLElement).parentElement;
          const next = nextAssetCardFocus(ev.key, i, total, assetGridCols(grid));
          if (next === null) return;
          ev.preventDefault();
          ev.stopPropagation();
          const card = grid?.querySelector<HTMLElement>(`[data-card-index="${next}"]`);
          if (!card) return;
          for (const other of grid!.querySelectorAll<HTMLElement>('.assetcard')) other.tabIndex = -1;
          card.tabIndex = 0;
          card.focus();
        },
      },
    },
    el(
      'div',
      {
        class: 'assetcard__thumb',
        data: {
          tip: `${cardMeta.file ? `media/${cardMeta.file}` : '이 브라우저에 등록된 파일'} · ${a.mime} · ${cardMeta.size}${cardMeta.revision ? ` · rev ${cardMeta.revision}` : ''}`,
        },
      },
      a.thumbDataUrl
        ? el('img', { class: 'assetcard__thumb-img', src: a.thumbDataUrl, alt: '' })
        : el('span', { class: 'assetcard__thumb-empty mono-label', text: assetThumbFallback(a) }),
      a.type === 'video'
        ? el('span', { class: 'assetcard__dur mono-label', text: cardMeta.duration })
        : null,
      playing ? el('span', { class: 'assetcard__playing', text: '● ON AIR' }) : null,
    ),
    el(
      'div',
      { class: 'assetcard__body' },
      el(
        'div',
        { class: 'assetcard__badges' },
        el('input', {
          class: 'input assetcard__name-input',
          type: 'text',
          value: a.name,
          data: { fid: `asset-name-${a.id}`, tip: a.name },
          attrs: { 'aria-label': '에셋 이름' },
          on: { change: (ev) => patch({ name: (ev.target as HTMLInputElement).value }) },
        }),
        el('span', {
          class: 'chip chip--quiet mono-label',
          text: cardMeta.modeLabel,
          data: { tip: `${a.mime} · ${cardMeta.size}${cardMeta.revision ? ` · rev ${cardMeta.revision}` : ''}` },
          tabIndex: 0,
        }),
        cardMeta.audio
          ? el('span', {
              class: 'chip chip--quiet',
              text: cardMeta.audio === '무음' ? '🔇' : '🔊',
              data: { tip: `${cardMeta.audio} — 아래 [소리] 버튼으로 바꿉니다.` },
              tabIndex: 0,
            })
          : null,
        /**
         * 지정된 배경 곡 (U124). 화면에는 곡 이름만, hover에 근거를 둔다 —
         * 어디서 온 값인지(대본 기본표 / 운영자 지정)와 영상 소리와 겹치는지가 근거다.
         */
        cardMeta.music
          ? el('span', {
              class: 'chip chip--gold',
              text: `♪ ${cardMeta.music.label}`,
              data: {
                fid: `asset-music-chip-${a.id}`,
                tip: assetMusicChipTip(a, cardMeta.music.label),
              },
              tabIndex: 0,
            })
          : null,
        a.audioRecheck === true
          ? el('span', {
              class: 'chip chip--warn',
              text: '소리 확인',
              data: { tip: AUDIO_RECHECK_HINT },
              tabIndex: 0,
            })
          : null,
        a.probeFailed
          ? el('span', {
              class: 'chip chip--warn',
              text: '재생 불가?',
              data: { tip: REMUX_HINT },
              tabIndex: 0,
            })
          : null,
        isMediaAsset(a.id)
          ? el('span', {
              class: 'chip',
              text: '📁 폴더',
              data: {
                tip: `media 폴더의 ${mediaFileFromId(a.id)} — manifest.json 에 적혀 있어 어느 PC·브라우저에서 열어도 자동으로 들어옵니다. 삭제하면 이 브라우저에서만 숨겨집니다.`,
              },
              tabIndex: 0,
            })
          : null,
        isBreak ? el('span', { class: 'chip chip--gold', text: '속보 영상' }) : null,
        isKv ? el('span', { class: 'chip chip--gold', text: '키비주얼' }) : null,
        isDefaultTransition
          ? el('span', {
              class: 'chip chip--gold',
              text: '기본 씬 전환',
              data: {
                tip:
                  s.transitionRules.defaultAssetId === a.id
                    ? '전환 할당의 [기본]으로 지정돼 있어, 규칙이 없는 모든 전환에 재생됩니다.'
                    : '[기본]이 지정되지 않아 첫 전환 오버레이 에셋인 이 영상이 자동으로 쓰입니다. 규칙이 없는 모든 전환에 재생됩니다.',
              },
              tabIndex: 0,
            })
          : null,
        ruleCount
          ? el('span', {
              class: 'chip chip--gold',
              text: `규칙 ${ruleCount}개`,
              data: { tip: describeRulesUsing(s, a.id) },
              tabIndex: 0,
            })
          : null,
        transitionPlaying
          ? el('span', {
              class: 'chip chip--live',
              text: '전환 재생 중',
              attrs: { role: 'status', 'aria-live': 'polite' },
            })
          : null,
      ),
      a.type === 'video'
        ? el(
            'details',
            { class: 'assetcard__settings' },
            el('summary', {
              class: 'assetcard__settings-summary',
              // 큐 표기는 저장값이 아니라 **실제로 큐에 꽂히는 값**을 보여 준다 — 대본 고정 영상은
              // 저장된 cueAfter가 비어 있어도 큐에 들어가므로 '없음'이라고 쓰면 거짓말이 된다.
              text: `재생 후 ${nextScene === null ? '직전 씬' : (NEXT_SCENES.find((item) => item.id === nextScene)?.label ?? '대기 화면')} · 큐 ${scriptedCue ? '대본 고정' : cueAfter ? '등록' : '없음'}`,
            }),
            el(
              'div',
              { class: 'assetcard__fields' },
            el('span', { class: 'field__label', text: '재생 후' }),
            el(
              'select',
              {
                class: 'input input--select',
                data: { fid: `asset-next-${a.id}` },
                attrs: { 'aria-label': '재생이 끝나면 넘어갈 씬' },
                on: {
                  change: (ev) => {
                    // 빈 값 = 지정 없음 = 재생 직전 씬으로 복귀. `''`이 아니라 **null**로 저장해야
                    // 상태·IndexedDB 양쪽에서 "지정 없음"으로 읽힌다
                    const v = (ev.target as HTMLSelectElement).value;
                    patch({ nextScene: v ? (v as SceneId) : null });
                  },
                },
              },
              el('option', {
                value: '',
                text: '직전 씬으로 복귀',
                attrs: { selected: nextScene === null ? 'selected' : undefined },
              }),
              NEXT_SCENES.map((n) =>
                el('option', {
                  value: n.id,
                  text: n.label,
                  attrs: { selected: nextScene === n.id ? 'selected' : undefined },
                }),
              ),
            ),
            el('span', { class: 'field__label', text: '방식' }),
            el(
              'select',
              {
                class: 'input input--select',
                data: { fid: `asset-mode-${a.id}` },
                attrs: { 'aria-label': '영상 재생 방식' },
                on: {
                  change: (ev) => {
                    const playMode = (ev.target as HTMLSelectElement).value as VideoPlayMode;
                    // 전환 오버레이로 바꾸면 홀드는 의미가 없다 — 기본값을 함께 맞춘다 (U50)
                    patch({ playMode, holdEndFrame: defaultHoldEndFrame(playMode) });
                  },
                },
              },
              el('option', {
                value: 'full',
                text: '풀스크린',
                attrs: { selected: mode === 'full' ? 'selected' : undefined },
              }),
              el('option', {
                value: 'transition',
                text: '전환 오버레이',
                attrs: { selected: a.playMode === 'transition' ? 'selected' : undefined },
              }),
              el('option', {
                value: 'overlay',
                text: '매치 알파 오버레이',
                attrs: { selected: a.playMode === 'overlay' ? 'selected' : undefined },
              }),
            ),
            // 전환 스팅어도 소리를 낸다 (U102) — 토글을 숨기면 운영자가 효과음을 끌 방법이 없다.
            // 매치·승리 오버레이도 마찬가지다 (U101b) — v003 교체로 실제 트랙이 생겼다.
            mode
              ? el('button', {
                  class: `seg__btn${a.audio === false ? '' : ' is-on'}`,
                  type: 'button',
                  text: a.audio === false ? '🔇 무음' : '🔊 소리 켬',
                  attrs: { 'aria-pressed': a.audio === false ? 'false' : 'true' },
                  data: {
                    fid: `asset-audio-${a.id}`,
                    tip:
                      mode === 'transition'
                        ? '스팅어는 효과음 레이어입니다 — 깔려 있는 음악·영상 소리 위에 겹쳐서 납니다(덕킹 없음). 무음으로 두면 그림만 나갑니다.'
                        : mode === 'overlay'
                          ? '매치·승리 오버레이는 제 소리를 냅니다 — 큐를 누르면 음악이 먼저 내려가고(자동 덕킹), 다음 컷에서 소리만 꼬리로 페이드됩니다. 무음으로 두면 그림만 얹힙니다.'
                          : '설명 영상은 검정 페이드와 함께 볼륨도 같이 오르내립니다. 무음으로 두면 화면만 페이드되고 소리는 나지 않습니다.',
                  },
                  // 사람이 고른 값은 manifest 정정·파일 실측에도 덮이지 않도록 출처를 함께 박는다 (U84).
                  // 파일 교체 확인 알림(audioRecheck)은 이 클릭이 "봤다"는 뜻이므로 함께 내린다.
                  on: {
                    click: () =>
                      patch({ audio: a.audio === false, audioSource: 'operator', audioRecheck: false }),
                  },
                })
              : null,
            mode === 'full' || mode === 'overlay'
              ? (() => {
                  // 대본 고정 아웃트로가 붙은 영상은 이 토글이 무의미하다 (U88).
                  // `disabled`가 아니라 `aria-disabled`로 막는다 — `disabled`면 hover·포커스가
                  // 죽어 **왜 못 누르는지 알려 줄 툴팁 자체가 뜨지 않는다** (큐시트 잠금과 같은 판단).
                  const locked = holdEndFrameLocked(a.id);
                  return el('button', {
                    class: `seg__btn${a.holdEndFrame === true && !locked ? ' is-on' : ''}${locked ? ' is-locked' : ''}`,
                    type: 'button',
                    text: locked
                      ? '☐ 대본 아웃트로'
                      : a.holdEndFrame === true
                        ? '☑ 끝 프레임 유지'
                        : '☐ 끝나면 자동 전환',
                    attrs: locked
                      ? { 'aria-disabled': 'true', 'aria-pressed': 'false' }
                      : { 'aria-pressed': a.holdEndFrame === true ? 'true' : 'false' },
                    data: {
                      fid: `asset-hold-${a.id}`,
                      tip: locked
                        ? HOLD_END_FRAME_LOCK_TIP
                        : '켜면 영상의 마지막 화면에서 멈춥니다. 사회자 멘트가 끝난 뒤 [다음 씬으로]으로 진행하세요.',
                    },
                    on: {
                      click: () => {
                        // 막힌 자리를 눌렀다 — 아무 일도 안 일어나면 고장으로 읽힌다.
                        // 툴팁과 같은 문장을 토스트로 한 번 더 답한다.
                        if (locked) {
                          toast(HOLD_END_FRAME_LOCK_TIP, 'warn');
                          return;
                        }
                        patch({ holdEndFrame: a.holdEndFrame !== true });
                      },
                    },
                  });
                })()
              : null,
            mode === 'transition'
              ? el(
                  'label',
                  { class: 'field__inline' },
                  el('span', { class: 'field__label', text: '씬 교체' }),
                  el('input', {
                    class: 'input input--compact',
                    type: 'number',
                    value: String(a.switchAtSec ?? 0.5),
                    attrs: { min: '0', max: '30', step: '0.05', 'aria-label': '씬 교체 시각(초)' },
                    on: {
                      change: (ev) => {
                        const value = Number((ev.target as HTMLInputElement).value);
                        patch({ switchAtSec: Number.isFinite(value) ? Math.max(0, value) : 0.5 });
                      },
                    },
                  }),
                  el('span', { class: 'field__unit', text: '초' }),
                )
              : null,
            /**
             * 배경 음악 (U124) — full 모드에만 연다.
             *
             * 겹치는 레이어(스팅어·매치 오버레이)는 깔린 소리 **위에** 얹히는 것이 정본이라
             * (U102 · U113) 거기서 곡을 새로 걸면 BGM과 정면으로 부딪힌다. 위젯은 [설정] 탭의
             * 승리 음악 드롭다운(U110/U119)과 같은 모양이다 — 두 자리가 같은 라이브러리에서
             * 같은 방식으로 고르게 해야 운영자가 규칙을 두 번 배우지 않는다.
             */
            mode === 'full'
              ? el('span', {
                  class: 'field__label',
                  text: '배경 음악',
                  data: { tip: assetMusicFieldTip(a) },
                  tabIndex: 0,
                })
              : null,
            mode === 'full'
              ? el(
                  'select',
                  {
                    class: 'input input--select',
                    data: { fid: `asset-music-${a.id}`, tip: assetMusicFieldTip(a) },
                    attrs: { 'aria-label': '재생과 함께 걸 배경 음악' },
                    on: {
                      change: (ev) => {
                        const v = (ev.target as HTMLSelectElement).value;
                        // 빈 값은 **`null`**로 저장한다 — `undefined`로 두면 "정한 적 없음"이 되어
                        // 대본 표 기본값이 다음 부팅에 다시 올라온다(끈 것이 도로 켜진다).
                        patch({ musicTrackId: v || null });
                        toast(
                          v
                            ? `배경 음악: ${musicTrack(v)?.label ?? v}`
                            : `${a.name} 배경 음악을 비웠습니다 — 영상 소리만 나갑니다`,
                          v ? 'ok' : 'warn',
                        );
                      },
                    },
                  },
                  el('option', {
                    value: '',
                    text: '없음 (영상 소리만)',
                    attrs: { selected: assetMusicTrackId(a) ? undefined : 'selected' },
                  }),
                  MUSIC_TRACKS.map((track) =>
                    el('option', {
                      value: track.id,
                      // 섹션까지 보여야 라이브러리에서 고를 수 있다 ([음악] 탭·승리 음악과 같은 표기)
                      text: `${track.section} · ${track.label}${
                        introMusicDefaultForAsset(a.id) === track.id ? ' (대본 기본)' : ''
                      }`,
                      attrs: {
                        selected: assetMusicTrackId(a) === track.id ? 'selected' : undefined,
                      },
                    }),
                  ),
                )
              : null,
            el('span', { class: 'field__label', text: '큐시트' }),
            el(
              'select',
              {
                class: 'input input--select',
                data: { fid: `asset-cue-${a.id}` },
                attrs: {
                  'aria-label': '큐시트에서 이 항목 다음에 재생',
                  // 대본이 자리를 정해 둔 영상은 바꿔도 `effectiveCueAfter`가 이기므로,
                  // 조작할 수 있는 것처럼 보여 주면 "바꿨는데 그대로다"가 된다.
                  ...(scriptedCue ? { disabled: 'disabled', title: '진행 대본이 위치를 고정한 영상입니다' } : {}),
                },
                on: {
                  change: (ev) => {
                    const v = (ev.target as HTMLSelectElement).value;
                    patch({ cueAfter: v || null });
                  },
                },
              },
              el('option', {
                value: '',
                text: '넣지 않음',
                attrs: { selected: cueAfter ? undefined : 'selected' },
              }),
              CUE_CHOICES.map((c) =>
                el('option', {
                  value: c.id,
                  text: `${c.label} 다음`,
                  attrs: { selected: cueAfter === c.id ? 'selected' : undefined },
                }),
              ),
            ),
            ),
          )
        : null,
    ),
    el(
      'div',
      { class: 'assetcard__actions' },
      a.type === 'video'
        ? el(
            'span',
            { class: 'assetcard__actions-play' },
            el('button', {
              class: 'btn btn--tiny btn--primary',
              type: 'button',
              text: mode === 'transition' ? '▶ 전환 재생' : mode === 'overlay' ? '▶ 오버레이' : '▶ 재생',
              data: {
                tip:
                  mode === 'transition'
                    ? '현재 송출 씬 위에 영상을 재생하고 지정 시각에 다음 씬으로 교체합니다 (카드에 포커스를 두고 Enter도 같은 동작)'
                    : mode === 'overlay'
                      ? '현재 송출 씬 위에 알파 영상을 얹습니다. 영상 자체 도입 스팅어를 사용하므로 별도 전환을 붙이지 않습니다. (카드 Enter도 같은 동작)'
                      : '출력 화면에서 이 영상을 처음부터 풀스크린 재생합니다 (카드에 포커스를 두고 Enter도 같은 동작)',
              },
              on: { click: play },
            }),
            el('button', {
              class: 'btn btn--tiny',
              type: 'button',
              text: '속보 영상으로',
              data: { tip: '속보 단축키(F9)를 눌렀을 때 스팅 다음에 재생될 영상으로 지정합니다' },
              on: {
                click: () => {
                  ctx.dispatch({
                    type: 'sceneOpts/patch',
                    patch: { video: { assetId: a.id, nextScene: 'suspects' } },
                  });
                  toast('속보 영상으로 지정했습니다');
                },
              },
            }),
          )
        : el('button', {
            class: `btn btn--tiny${isKv ? ' btn--primary' : ''}`,
            type: 'button',
            text: '키비주얼로',
            data: { tip: '대기 화면 배경 이미지로 사용합니다 (카드 Enter도 같은 동작)' },
            on: { click: play },
          }),
      el('button', {
        class: 'btn btn--tiny',
        type: 'button',
        text: '↑',
        disabled: i === 0,
        attrs: { 'aria-label': '위로' },
        data: { tip: '목록 순서를 올립니다. 가장 위 전환 오버레이가 기본 씬 전환이 됩니다.' },
        on: { click: () => move(ctx, a.id, -1) },
      }),
      el('button', {
        class: 'btn btn--tiny',
        type: 'button',
        text: '↓',
        disabled: i === total - 1,
        attrs: { 'aria-label': '아래로' },
        on: { click: () => move(ctx, a.id, 1) },
      }),
      el('button', {
        class: 'btn btn--tiny btn--danger',
        type: 'button',
        text: '삭제',
        on: {
          click: () => {
            const file = mediaFileFromId(a.id);
            openModal({
              title: '에셋 삭제',
              body: file
                ? `${a.name} 은 media 폴더 항목입니다. 삭제하면 이 브라우저 목록에서 숨겨집니다 ` +
                  `(media/${file} 파일 자체는 남습니다). [media 폴더 다시 불러오기]로 되돌릴 수 있습니다.`
                : `${a.name} 을 삭제합니다. 되돌릴 수 없습니다.`,
              danger: true,
              confirmLabel: '삭제',
              onConfirm: () => {
                // 숨김 표시를 먼저 남긴다 — 지우기만 하면 다음 로드에 그대로 다시 들어온다
                if (file) ctx.dispatch({ type: 'media/hide', file });
                void deleteAsset(a.id).then(() => {
                  ctx.reloadAssets();
                  toast(file ? '목록에서 숨겼습니다' : '삭제했습니다', 'warn');
                });
              },
            });
          },
        },
      }),
    ),
  );
}

/** 현재 재생 중인 영상의 제어 + 진행 바 (진행 값은 display가 보고한 것을 tick에서 채운다) */
function playerBar(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const transitionActive = s.sceneOpts.transitionVideo.active;
  const overlayActive = s.sceneOpts.overlayVideo.active;
  const activeAssetId = transitionActive
    ? s.sceneOpts.transitionVideo.assetId
    : overlayActive
      ? s.sceneOpts.overlayVideo.assetId
      : s.sceneOpts.video.assetId;
  const cur = s.assets.find((a) => a.id === activeAssetId);
  const paused = s.sceneOpts.video.paused;
  const onVideoScene = s.scene === 'video';
  const canControlFullVideo = Boolean(cur && onVideoScene && !transitionActive);
  const phase = s.sceneOpts.video.phase;
  const fading = phase !== 'idle';
  /**
   * 일시정지·처음으로는 영상이 실제로 돌고 있을 때만 의미가 있다.
   * 페이드 래핑을 쓰면 `playing`이 그 구간이고, 페이드를 안 쓰는 legacy 경로
   * (['영상 씬으로'] 버튼)는 `idle`인 채로 재생되므로 기존 조건을 그대로 남긴다.
   */
  const canPlayPause = phase === 'playing' || (phase === 'idle' && canControlFullVideo);
  const canRestart = canPlayPause || phase === 'holding';
  /**
   * 스킵은 **수동 탈출구**다 — 워치독이 안 걸리는 긴 영상에서 검정에 멈추면 이것뿐이므로
   * covering/revealing 구간에서도 항상 눌린다 (계획 위험 R1).
   */
  const canSkip = fading || canControlFullVideo || overlayActive;
  const PHASE_LABEL: Record<typeof phase, string> = {
    idle: '',
    covering: '검정으로 덮는 중',
    playing: '설명 영상 재생 중',
    holding: '마지막 프레임 유지 중',
    revealing: '검정에서 나오는 중',
  };

  return el(
    'div',
    { class: 'playerbar' },
    el(
      'div',
      { class: 'playerbar__head' },
      el('span', {
        class: 'field__label',
        text: transitionActive ? '전환 재생 중' : overlayActive ? '매치 오버레이' : '재생 중',
      }),
      el('span', { class: 'playerbar__name', text: cur ? cur.name : '없음' }),
      transitionActive ? el('span', { class: 'chip chip--live', text: '오버레이' }) : null,
      overlayActive
        ? el('span', {
            class: 'chip chip--live',
            text: s.sceneOpts.overlayVideo.held ? '끝 프레임 유지 중' : '알파 재생 중',
          })
        : null,
      fading
        ? el('span', {
            class: 'chip chip--live',
            text: PHASE_LABEL[phase],
            data: {
              tip: `설명 영상은 검정 페이드 ${s.sceneOpts.video.fadeSec.toFixed(2)}초로 감싸 재생합니다. 씬 교체는 검정이 화면을 완전히 덮은 뒤에만 일어납니다. 중간에 끊으려면 [⏭ 스킵].`,
            },
            tabIndex: 0,
            attrs: { role: 'status', 'aria-live': 'polite' },
          })
        : null,
      el('span', { class: 'playerbar__time mono-label', data: { live: 'vtime' }, text: '--:-- / --:--' }),
    ),
    el(
      'div',
      { class: 'playerbar__track', data: { live: 'vtrack' } },
      el('div', { class: 'playerbar__fill', data: { live: 'vfill' } }),
    ),
    el(
      'div',
      { class: 'btnrow' },
      el('button', {
        class: 'btn btn--tiny',
        type: 'button',
        disabled: !canPlayPause,
        text: paused ? '재생' : '일시정지',
        attrs: { 'aria-pressed': paused ? 'true' : 'false' },
        on: { click: () => ctx.dispatch({ type: 'video/pause', paused: !paused }) },
      }),
      el('button', {
        class: 'btn btn--tiny',
        type: 'button',
        disabled: !canRestart,
        text: '⏮ 처음으로',
        on: { click: () => ctx.dispatch({ type: 'video/restart', now: Date.now() }) },
      }),
      el('button', {
        class: 'btn btn--tiny',
        type: 'button',
        disabled: !canSkip,
        text: overlayActive ? '✕ 매치 오버레이 닫기' : phase === 'holding' ? '⏭ 다음 씬으로' : '⏭ 스킵',
        data: {
          tip: fading
            ? '페이드를 즉시 중단하고 지정된 다음 씬으로 넘어갑니다. 응답이 없어 검정에 멈췄을 때의 탈출구입니다.'
            : '재생을 중단하고 지정된 다음 씬으로 넘어갑니다',
        },
        on: {
          click: () => {
            const overlay = ctx.state.sceneOpts.overlayVideo;
            if (overlay.active) {
              ctx.dispatch({ type: 'overlay/finish', token: overlay.restartToken });
              return;
            }
            const v = ctx.state.sceneOpts.video;
            if (v.phase !== 'idle') {
              // abort가 phaseToken을 올려 늦게 도착한 display 사건을 전부 무효화한다.
              // 뒤따르는 scene/set은 평소대로 라우팅을 타 스팅어가 한 번 재생된다(의도).
              ctx.dispatch([
                { type: 'video/abort' },
                { type: 'scene/set', scene: v.nextScene ?? v.returnScene ?? 'standby' },
              ]);
              return;
            }
            ctx.dispatch({
              type: 'scene/set',
              scene: (cur ? nextSceneOf(cur) : null) ?? 'standby',
              opts: { video: { nextScene: null } },
            });
          },
        },
      }),
      el('button', {
        class: 'btn btn--tiny btn--ghost',
        type: 'button',
        text: '영상 씬으로',
        on: { click: () => ctx.dispatch({ type: 'scene/set', scene: 'video' }) },
      }),
    ),
  );
}

/**
 * media 폴더 줄 — 파일로 배포되는 기본 영상의 상태와 다시 불러오기.
 *
 * IndexedDB는 브라우저마다 따로라 백업 노트북에서 열면 에셋이 비어 있다.
 * 그래서 "폴더에 넣어 두면 자동으로 들어온다"는 경로를 화면에서도 보이게 둔다.
 */
function mediaBar(ctx: Ctx): HTMLElement {
  const st = getMediaStatus();
  const hidden = ctx.state.hiddenMedia;

  const note =
    st.kind === 'absent'
      ? 'media 폴더 매니페스트 없음 — public/media/manifest.json 이 없어 기본 영상을 자동으로 넣지 않았습니다.'
      : st.kind === 'error'
        ? 'manifest.json 을 읽지 못했습니다 — JSON 형식(쉼표·따옴표)을 확인하세요.'
        : st.kind === 'ok'
          ? `media 폴더 항목 ${st.total}개${st.failed.length ? ` · ${st.failed.length}개는 파일을 찾지 못했습니다` : ''}`
          : 'media 폴더 확인 중…';

  return el(
    'div',
    { class: 'field' },
    el(
      'div',
      { class: 'btnrow' },
      el('button', {
        class: 'btn btn--tiny',
        type: 'button',
        text: '📁 media 폴더 다시 불러오기',
        data: {
          tip: 'public/media/manifest.json 을 다시 읽어 아직 등록되지 않은 기본 영상을 넣습니다. 이미 있는 항목은 건드리지 않으니 여러 번 눌러도 안전합니다.',
        },
        on: { click: () => ctx.reloadMedia({ manual: true }) },
      }),
      hidden.length
        ? el('button', {
            class: 'btn btn--tiny btn--ghost',
            type: 'button',
            text: `숨긴 폴더 항목 ${hidden.length}개 되돌리기`,
            data: { tip: `숨김: ${hidden.join(', ')}` },
            on: {
              click: () => {
                ctx.dispatch({ type: 'media/unhideAll' });
                ctx.reloadMedia({ manual: true });
              },
            },
          })
        : null,
    ),
    el('p', { class: 'tabpane__hint', text: note }),
  );
}

export function render(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const list = [...s.assets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const drop = el(
    'div',
    {
      class: 'dropzone',
      tabIndex: 0,
      data: {
        tip: '영상(mp4/mov) · 이미지(png/jpg)를 끌어다 놓으면 브라우저 안(IndexedDB)에 보관됩니다. 인터넷 불필요, 창을 닫아도 남습니다.',
      },
      on: {
        dragover: (ev) => {
          ev.preventDefault();
          drop.classList.add('is-over');
        },
        dragleave: () => drop.classList.remove('is-over'),
        drop: (ev) => {
          ev.preventDefault();
          drop.classList.remove('is-over');
          const files = (ev as DragEvent).dataTransfer?.files;
          if (files?.length) void ingest(files, ctx);
        },
        paste: (ev) => {
          const items = (ev as ClipboardEvent).clipboardData?.files;
          if (items?.length) {
            ev.preventDefault();
            void ingest(items, ctx);
          }
        },
      },
    },
    el('div', { class: 'dropzone__icon' }),
    el('div', { class: 'dropzone__title', text: '여기로 파일을 끌어다 놓기' }),
    el('div', {
      class: 'dropzone__sub',
      text: '또는 아래 [파일 선택] · 이 칸을 클릭한 뒤 ⌘V 로 붙여넣기 · 여러 개 한 번에 가능',
    }),
    el('label', { class: 'btn btn--tiny', attrs: { for: 'asset-file' } }, '파일 선택'),
    el('input', {
      class: 'visually-hidden',
      id: 'asset-file',
      type: 'file',
      accept: 'video/*,image/*',
      multiple: true,
      data: { fid: 'asset-file' },
      on: {
        change: (ev) => {
          const files = (ev.target as HTMLInputElement).files;
          if (files?.length) void ingest(files, ctx);
        },
      },
    }),
  );

  return el(
    'div',
    { class: 'tabpane' },
    drop,
    mediaBar(ctx),
    renderTransitionRules(ctx),
    playerBar(ctx),
    el('h3', { class: 'section__title', text: `등록된 에셋 (${list.length})` }),
    list.length
      ? assetSections(list).map((section) => {
          const collapsed = collapsedSections.has(section.id);
          return el(
            'section',
            { class: `assetgroup${collapsed ? ' is-collapsed' : ''}` },
            el(
              'button',
              {
                class: 'assetgroup__head',
                type: 'button',
                data: { fid: `assetgroup-${section.id}`, tip: section.hint },
                attrs: { 'aria-expanded': collapsed ? 'false' : 'true' },
                on: {
                  click: () => {
                    if (collapsed) collapsedSections.delete(section.id);
                    else collapsedSections.add(section.id);
                    ctx.refresh();
                  },
                },
              },
              el('span', { class: 'assetgroup__caret', text: collapsed ? '▸' : '▾' }),
              el('span', { class: 'assetgroup__label', text: section.label }),
              el('span', { class: 'assetgroup__count mono-label', text: String(section.assets.length) }),
            ),
            collapsed
              ? null
              : el(
                  'ul',
                  { class: 'assetgrid', attrs: { role: 'list' } },
                  section.assets.map((a, i) =>
                    assetCard(ctx, a, i, section.assets.length),
                  ),
                ),
          );
        })
      : el('p', { class: 'empty', text: '등록된 에셋이 없습니다.' }),
  );
}

/**
 * 끝 프레임 홀드 기본값으로 **한 번 올려야 하는** 에셋 id (U50).
 *
 * `syncMediaManifest`는 revision이 바뀌지 않으면 저장된 값을 manifest보다 우선한다. 그래서
 * manifest에 `holdEndFrame: true`를 적어도 이미 등록된 브라우저에서는 옛 `false`가 그대로 남는다.
 *
 * 승격 대상은 둘뿐이다.
 *  - **media 폴더 유래**: 값의 주인이 앱이다. 대본이 정한 기본값으로 맞춘다.
 *  - **값이 아예 없는 운영자 업로드**: 기본값을 정한 적이 없는 옛 저장본이다.
 *
 * 운영자가 카드에서 **직접 끈** 업로드(`false`가 실제로 저장된 것)는 건드리지 않는다.
 * 전환 오버레이는 끝나면 사라지는 것이 존재 이유라 애초에 대상이 아니다.
 * 승격 결과가 `true`라 다음 부팅에는 후보에서 빠진다 — 별도 플래그가 필요 없다.
 */
export function holdEndFrameUpgrades(
  rows: readonly { id: string; type: string; playMode?: VideoPlayMode; holdEndFrame?: boolean }[],
): string[] {
  return rows
    .filter(
      (row) =>
        row.type === 'video' &&
        defaultHoldEndFrame(row.playMode) &&
        row.holdEndFrame !== true &&
        (isMediaAsset(row.id) || row.holdEndFrame === undefined),
    )
    .map((row) => row.id);
}

/** control이 부팅·삭제 후 호출 — IndexedDB가 진실이고 상태는 그 사본이다 */
export async function readAssetMetas(): Promise<AssetMeta[]> {
  const all = await listMediaAssets();
  // 옛 저장본을 끝 프레임 홀드 기본으로 한 번 올린다 (U50). IndexedDB가 진실이므로 여기서 쓴다.
  const upgrade = new Set(holdEndFrameUpgrades(all));
  for (const id of upgrade) void patchAsset(id, { holdEndFrame: true });
  /**
   * 무음 소개 영상의 배경 곡도 같은 방식으로 한 번 올린다 (U124, U50과 같은 형태).
   *
   * 대상은 `musicTrackId`가 저장본에 **아예 없는** 항목뿐이라, 운영자가 카드에서 비운 값
   * (`null`)은 건드리지 않는다. 승격 결과가 문자열이라 다음 부팅에는 후보에서 빠진다.
   */
  const music = new Map(musicTrackUpgrades(all).map((u) => [u.id, u.musicTrackId]));
  for (const [id, musicTrackId] of music) void patchAsset(id, { musicTrackId });
  return all
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      size: a.size,
      mime: a.mime,
      durationSec: a.durationSec,
      thumbDataUrl: a.thumbDataUrl,
      probeFailed: a.probeFailed,
      // `null`은 "지정 없음 = 직전 씬으로 복귀"라는 **의미 있는 값**이라 뭉개지 않는다.
      // 값이 아예 없는 구 저장본만 기존 기본값 standby로 채운다.
      nextScene: a.nextScene === null ? null : (a.nextScene ?? 'standby'),
      playMode: a.playMode ?? 'full',
      audio: a.audio ?? true,
      // 출처는 채우지 않는다 — 없으면 "옛 저장본"이라는 뜻이고, 그 판단은 resolveAudioMeta 몫이다
      audioSource: a.audioSource,
      audioRecheck: a.audioRecheck === true,
      holdEndFrame: upgrade.has(a.id) || a.holdEndFrame === true,
      // `null`("운영자가 비웠다")과 `undefined`("정한 적 없다")를 구분해 넘긴다 (U124) —
      // `?? null`로 뭉개면 표 기본값이 영영 걸리지 않는다.
      musicTrackId: music.get(a.id) ?? a.musicTrackId,
      switchAtSec: a.switchAtSec ?? 0.5,
      cueAfter: a.cueAfter ?? null,
      order: a.order ?? 0,
      sourceRevision: a.sourceRevision,
    }))
    .sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
}
