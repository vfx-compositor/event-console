/**
 * 현장 사진 탭 — 행사장에서 방금 찍은 사진을 모으고, 송출에서 뺄 것을 골라내는 자리.
 *
 * 설계 근거 (계획 §6 · §11 T4):
 *  - **상태에는 메타만.** 썸네일 blob은 IndexedDB(`photoThumbs`)에서 읽어 objectURL로 붙인다.
 *    500장 썸네일을 상태에 넣으면 localStorage 저장이 통째로 죽는다(§1-6).
 *  - **흡수 경로는 하나.** 드롭·파일 선택·붙여넣기·폴더 폴링이 전부 `intakeFiles()`를 쓴다.
 *    경로가 갈리면 중복 방지 규칙이 갈린다.
 *  - **잠금 중에는 2부에 수집된 사진의 셀을 아예 그리지 않는다**(§11 H2). 파일명이 곧
 *    스포일러가 될 수 있고(`용의자_후보.jpg`), 조작 패널도 1부 중에는 후반 어휘를 내지 않는
 *    것이 이 프로젝트의 잠금 규약이다. 개수만 중립적인 라벨(`잠긴 항목 N`)로 알린다.
 *  - **개별 삭제 UI는 없다**(§11 L7). 되돌릴 수 있는 [숨김]과, 확인을 받는 [전체 삭제] 둘뿐이다.
 *    현장에서 손이 미끄러져 사진 한 장이 조용히 사라지는 경로를 만들지 않는다.
 *
 * UI 관례:
 *  - 네이티브 `<button>`·`<input>`·`<select>`만 쓴다. 포커스 트랩은 걸지 않는다(모달 전용).
 *  - 그리드는 **roving tabindex** — Tab 한 번에 들어오고 나간다. 그리드가 처리한 키는
 *    `stopPropagation()`으로 막는다. 안 하면 방향키가 `window`까지 올라가 큐시트가 같이 넘어간다.
 *  - 화면엔 요약, hover/focus/tap에 근거(`data-tip` + `tabIndex: 0`). native `title` 금지.
 */

import { clearPhotos, getPhotoThumb } from '../db';
import { el } from './dom';
import {
  PHOTO_INTERVAL_MAX,
  PHOTO_INTERVAL_MIN,
  clampIntervalSec,
  isPhotoPlayable,
  nextPhotoFocusAfterHide,
  photoGridOrder,
  photosBudgetRatio,
} from '../photos';
import { openModal } from './modal';
import { toast } from './toast';
import {
  currentDirName,
  currentDirState,
  intakeFiles,
  intakeStatus,
  isDirPickerSupported,
  pickPhotoDir,
  regrantPhotoDir,
  forgetPhotoDir,
  PHOTO_POLL_MS,
  type DirState,
  type IntakeStatus,
} from '../photo-intake';
import type { Ctx } from './ctx';
import type { PhotoMeta, PhotoSettings } from '../types';

export const meta = { id: 'photos', label: '현장 사진' };

/** 처음에 그리는 셀 수 상한. 그 이상은 [더 보기]로 한 뭉치씩 늘린다(§6-3 · 위험 R2) */
const GRID_INITIAL = 300;
const GRID_STEP = 300;

// ---------------------------------------------------------------- 모듈 로컬 상태
//
// 전부 "이 창에서만 의미가 있는" 값이다. `AppState`에 넣으면 창마다 다른 값이 상태 저장·
// 방송 경로를 매번 깨운다(계획 §3-4와 같은 이유).

/** id → 썸네일 objectURL. 상태에서 사라진 id는 revoke한다 */
const thumbUrls = new Map<string, string>();
/** 지금 IndexedDB를 읽고 있는 id (중복 요청 방지) */
const thumbPending = new Set<string>();
/** 뷰포트에 들어와 요청 차례를 기다리는 id. Set이라 삽입 순서 = 요청 순서다 */
const thumbQueue = new Set<string>();
let thumbInflight = 0;
/**
 * 썸네일 blob이 없어 그릴 수 없는 사진.
 *
 * `깨진 N` **개수**는 `IntakeStatus.broken`(control이 `listPhotoIds()`와 대조해 센 값, §11 M5)이
 * 진실이다. 이 집합은 그와 별개로, 그리다가 실제로 blob이 없던 셀에 표시를 남기기 위한
 * 것이다 — 어느 사진이 깨졌는지는 그리는 쪽만 안다.
 */
const brokenIds = new Set<string>();

/**
 * 그리드 DOM을 재렌더 사이에 **재사용**한다.
 *
 * `control.ts`의 `render()`는 매 dispatch마다 트리를 통째로 다시 만든다. 숨김 토글 한 번에
 * 300장 `<img>`를 새로 만들면 디코드가 몰려 패널이 눈에 띄게 멈춘다. 셀 목록(=id 배열)이
 * 그대로면 같은 노드를 옮겨 붙이고 상태 클래스만 갱신한다.
 */
let gridEl: HTMLElement | null = null;
const gridCells = new Map<string, HTMLElement>();
let gridSig = '';

/** roving tabindex의 현재 지점 */
let focusId: string | null = null;
let shownLimit = GRID_INITIAL;
/** 재사용한 그리드 리스너가 항상 최신 상태·dispatch를 보도록 render 때 갱신한다. */
let gridCtx: Ctx | null = null;

let intakeWarned = false;

/**
 * `photo-intake`는 T3가 구현 중이고(껍데기 함수는 `throw`한다), 구현된 뒤에도 File System
 * Access·IndexedDB라는 실패할 수 있는 경로를 감싼다. 흡수 모듈이 던졌다고 조작 패널 전체가
 * 하얗게 죽으면 안 되므로 한 겹 감싼다. 삼키되 **한 번은 콘솔에 남긴다**.
 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    if (!intakeWarned) {
      intakeWarned = true;
      console.warn('[photos] 흡수 모듈 호출 실패 — 드롭·파일 선택만 동작합니다', err);
    }
    return fallback;
  }
}

/** 흡수 모듈이 아직 말을 걸 수 없을 때 쓰는 중립값 — 상태 줄이 빈 화면이 되지 않게 */
const EMPTY_STATUS: IntakeStatus = {
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

function status(): IntakeStatus {
  return safe(intakeStatus, EMPTY_STATUS);
}

function dirState(): DirState {
  return safe(currentDirState, 'none');
}

function dirName(): string | null {
  return safe(currentDirName, null);
}

function pickerSupported(): boolean {
  return safe(isDirPickerSupported, false);
}

// ---------------------------------------------------------------- 포맷

/**
 * `18:42:07`. `toLocaleTimeString('ko-KR')`을 쓰지 않는다 — 브라우저에 따라
 * `22시 15분 10초`로 나와 한 줄짜리 상태 줄을 세 배로 밀어낸다(nowrap이라 그만큼 잘린다).
 */
function hhmmss(ms: number | null): string {
  if (!ms || !Number.isFinite(ms)) return '--:--:--';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function fmtDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '시각 없음';
  return new Date(ms).toLocaleString('ko-KR', { hour12: false });
}

// ---------------------------------------------------------------- 흡수 배선

/**
 * 드롭 · 파일 선택 · 붙여넣기 — 전부 이 한 경로다.
 *
 * **`intakeFiles(files)`를 deps 인자 없이 부른다.** control이 부팅 때 `setDefaultIntakeDeps()`로
 * 등록한 의존성을 쓰라는 것이 T3의 계약이다. 여기서 `ctx`로 deps를 조립해 넘기면 리더 가드를
 * 우회하게 되고(보조 창이 IndexedDB에 사진을 밀어 넣는다), 중복 방지 규칙도 폴링 경로와
 * 갈린다. 비리더 창에서는 `intakeFiles`가 throw하므로 그 자리에서 안내한다.
 */
async function ingest(files: FileList | readonly File[], ctx: Ctx): Promise<void> {
  let result;
  try {
    result = await intakeFiles(files);
  } catch (err) {
    console.warn('[photos] 흡수 실패', err);
    toast('이 창에서는 사진을 가져올 수 없습니다 — 조작 리더 창에서 넣으세요', 'bad');
    return;
  }
  ctx.refresh();

  if (result.added) {
    toast(`사진 ${result.added}장을 가져왔습니다`);
  } else if (result.skippedHeic) {
    toast(`HEIC ${result.skippedHeic}장은 이 브라우저가 열지 못합니다 — 아이폰 [설정 → 카메라 → 포맷]을 '높은 호환성'으로 두세요`, 'warn');
  } else if (result.failed.length) {
    toast(`${result.failed.length}장을 열지 못했습니다`, 'bad');
  } else {
    toast('새 사진이 없습니다 — 이미 들어와 있는 파일입니다');
  }
}

// ---------------------------------------------------------------- 상단: 수집 소스

/** 폴더 상태 칩 — 색 + 형태(●▲○■) + 텍스트 셋으로 동시에 알린다 */
function dirChip(): HTMLElement {
  const dir = dirState();
  const name = dirName();
  const st = status();
  const shape: Record<DirState, string> = {
    granted: '●',
    prompt: '▲',
    none: '○',
    denied: '■',
    unsupported: '○',
  };
  const label: Record<DirState, string> = {
    granted: `폴더 연결됨${name ? ` · ${name}` : ''}`,
    prompt: '권한 필요',
    none: '폴더 미연결',
    denied: '권한 거부됨',
    unsupported: '폴더 수집 미지원',
  };
  const cls =
    dir === 'granted' ? 'chip chip--gold' : dir === 'prompt' || dir === 'denied' ? 'chip chip--warn' : 'chip';

  const tip = [
    name ? `폴더: ${name}` : '연결된 폴더가 없습니다.',
    `자동 수집 주기: ${Math.round(PHOTO_POLL_MS / 1000)}초마다 새 파일만 확인합니다.`,
    `마지막 스캔: ${hhmmss(st.lastScanAt)}`,
    dir === 'granted'
      ? '브라우저를 재시작하면 권한이 [권한 필요]로 돌아갑니다 — 그때 [폴더 다시 연결]을 한 번 누르면 복구됩니다.'
      : dir === 'prompt'
        ? '브라우저를 재시작하면 원래 이렇게 됩니다. [폴더 다시 연결]을 누르면 그대로 이어집니다.'
        : dir === 'denied'
          ? '브라우저가 이 폴더 접근을 거부했습니다. [폴더 다시 선택]으로 폴더를 새로 지정하세요.'
          : dir === 'unsupported'
            ? 'Chrome에서만 폴더 자동 수집이 됩니다. 끌어다 놓기·[파일 선택]은 어느 브라우저에서나 됩니다.'
            : '아직 수집할 폴더를 지정하지 않았습니다.',
  ].join('\n');

  return el(
    'span',
    { class: `photo-chip ${cls}`, data: { tip }, tabIndex: 0, attrs: { role: 'status' } },
    el('span', { class: 'photo-chip__mark', text: shape[dir], attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'photo-chip__text', text: label[dir] }),
  );
}

function sourceSection(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const dir = dirState();
  const supported = pickerSupported();
  const auto = s.photos.settings.autoIntake;

  const applyDir = (next: DirState, okMsg: string) => {
    ctx.status.photoDir = next;
    if (next === 'granted') {
      // `autoIntake` 기본값은 off다(T1). 폴더를 고르는 행위 자체가 "자동으로 가져와 달라"는
      // 뜻이므로 여기서 함께 켠다 — 폴더를 연결해 놓고 사진이 안 들어와서 토글을 찾아
      // 헤매는 것이 이 기능의 가장 흔한 실패 모양이다. 토글은 **끄는 용도**로 남는다.
      // (`ctx.dispatch`가 동기로 다시 그리므로 별도 refresh는 필요 없다.)
      ctx.dispatch({ type: 'photos/settings', patch: { autoIntake: true } });
      toast(okMsg);
      return;
    }
    ctx.refresh();
    if (next === 'denied') toast('폴더 권한이 거부되었습니다', 'bad');
  };

  const folderRow = supported
    ? el(
        'div',
        { class: 'field photo-source' },
        dirChip(),
        el('button', {
          class: 'btn btn--tiny',
          type: 'button',
          text: dir === 'none' || dir === 'denied' ? '폴더 선택' : '폴더 바꾸기',
          data: {
            fid: 'photo-pick-dir',
            tip: '사진이 떨어지는 폴더를 지정합니다. AirDrop·메신저로 이 PC에 받은 사진을 그 폴더에 옮기면 자동으로 들어옵니다. 폴더의 원본 파일은 읽기만 하고 건드리지 않습니다.',
          },
          // showDirectoryPicker는 **사용자 제스처에서만** 뜬다 — click 핸들러 안에서 직접 부른다
          on: {
            click: () =>
              void safe(pickPhotoDir, Promise.resolve(dir))
                .then((r) => applyDir(r, '폴더를 연결했습니다'))
                // 사용자가 폴더 선택 창을 그냥 닫아도 reject가 온다 — 조용히 넘어간다
                .catch(() => undefined),
          },
        }),
        dir === 'prompt'
          ? el('button', {
              class: 'btn btn--tiny btn--primary',
              type: 'button',
              text: '폴더 다시 연결',
              data: {
                fid: 'photo-regrant-dir',
                tip: '브라우저 재시작으로 풀린 권한을 되돌립니다. 폴더를 다시 고를 필요는 없습니다 — 한 번 누르면 그대로 이어집니다.',
              },
              on: {
                click: () =>
                  void safe(regrantPhotoDir, Promise.resolve(dir))
                    .then((r) => applyDir(r, '폴더 권한을 되찾았습니다'))
                    .catch(() => undefined),
              },
            })
          : null,
        dir === 'granted' || dir === 'prompt'
          ? el('button', {
              class: 'btn btn--tiny btn--ghost',
              type: 'button',
              text: '연결 해제',
              data: { tip: '폴더 자동 수집을 끊습니다. 이미 들어온 사진은 그대로 남습니다.' },
              on: {
                click: () =>
                  void safe(forgetPhotoDir, Promise.resolve())
                    .then(() => {
                      ctx.status.photoDir = 'none';
                      ctx.refresh();
                      toast('폴더 연결을 해제했습니다');
                    })
                    .catch(() => undefined),
              },
            })
          : null,
        el('button', {
          class: `seg__btn${auto ? ' is-on' : ''}`,
          type: 'button',
          text: `${auto ? '☑ 자동 수집 켬' : '☐ 자동 수집 끔'}`,
          attrs: { 'aria-pressed': auto ? 'true' : 'false' },
          data: {
            fid: 'photo-auto',
            tip: '켜면 연결한 폴더를 주기적으로 훑어 새 사진을 자동으로 가져옵니다. 끄면 끌어다 놓기·[파일 선택]으로만 들어옵니다.',
          },
          on: { click: () => ctx.dispatch({ type: 'photos/settings', patch: { autoIntake: !auto } }) },
        }),
      )
    : el('p', {
        class: 'tabpane__hint',
        text: '이 브라우저는 폴더 자동 수집을 지원하지 않습니다(Chrome에서만 됩니다) — 아래로 끌어다 놓거나 [파일 선택]을 쓰세요.',
      });

  const drop = el(
    'div',
    {
      class: 'dropzone',
      tabIndex: 0,
      data: {
        tip: '사진(jpg/png/webp)을 끌어다 놓으면 긴 변 1920으로 줄여 브라우저 안(IndexedDB)에 보관합니다. 인터넷 불필요, 창을 닫아도 남습니다. 폴더의 원본은 그대로입니다.',
      },
      on: {
        dragover: (ev) => {
          ev.preventDefault();
          drop.classList.add('is-over');
        },
        dragleave: () => drop.classList.remove('is-over'),
        drop: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
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
    el('div', { class: 'dropzone__title', text: '이 탭 어디든 사진을 끌어다 놓기' }),
    el('div', {
      class: 'dropzone__sub',
      text: '또는 아래 [파일 선택] · 이 칸을 클릭한 뒤 ⌘V 로 붙여넣기 · 여러 장 한 번에 가능',
    }),
    el('label', { class: 'btn btn--tiny', attrs: { for: 'photo-file' } }, '파일 선택'),
    el('input', {
      class: 'visually-hidden',
      id: 'photo-file',
      type: 'file',
      accept: 'image/*',
      multiple: true,
      data: { fid: 'photo-file' },
      on: {
        change: (ev) => {
          const files = (ev.target as HTMLInputElement).files;
          if (files?.length) void ingest(files, ctx);
        },
      },
    }),
  );

  return el('div', { class: 'photo-source-block' }, folderRow, drop);
}

// ---------------------------------------------------------------- 상태 줄

interface PhotoCounts {
  total: number;
  shown: number;
  hidden: number;
  /** 잠금 중 목록에서 빠진 사진 수 (= `p2` 도장이 찍힌 것) */
  locked: number;
  p2: number;
  broken: number;
}

function countPhotos(ctx: Ctx): PhotoCounts {
  const s = ctx.state;
  const unlocked = s.p2.unlocked;
  const items = s.photos.items;
  const p2 = items.filter((p) => p.p2).length;
  const universe = unlocked ? items : items.filter((p) => !p.p2);
  const st = status();
  return {
    total: items.length,
    // `표시`는 실제로 송출되는 목록의 길이다 — display가 쓰는 것과 **같은 술어**로 센다.
    // 여기서 따로 조건을 짜면 숨김·잠금 판정이 두 벌이 되어 언젠가 어긋난다.
    // 큐(`photoQueue`)를 만들어 길이를 재지 않는 이유: 이 함수는 상태 줄을 그릴 때마다
    // 도는데, 큐를 만들면 그때마다 500장을 정렬한다. 개수에는 순서가 필요 없다(§M8).
    shown: items.reduce((n, p) => (isPhotoPlayable(p, unlocked) ? n + 1 : n), 0),
    hidden: universe.filter((p) => p.hidden).length,
    locked: unlocked ? 0 : p2,
    p2,
    // 깨진 수는 목록 길이를 넘을 수 없다. `IntakeStatus.broken`은 부팅·리더 인수·배치 후에만
    // 다시 세므로, 전체 삭제 직후처럼 아직 갱신되지 않은 순간에 `총 0 · 깨진 340` 같은
    // 앞뒤가 맞지 않는 줄이 나온다. 표시하는 쪽에서 상한을 건다.
    broken: Math.min(st.broken || brokenIds.size, items.length),
  };
}

function statusLine(ctx: Ctx): HTMLElement {
  const c = countPhotos(ctx);
  const st = status();
  const unlocked = ctx.state.p2.unlocked;
  const busy = st.scanning || st.pending > 0;

  const parts: string[] = [`총 ${c.total}`, `표시 ${c.shown}`, `숨김 ${c.hidden}`];
  // 잠금 중에는 **후반 어휘를 쓰지 않는다** — 개수만 중립적인 이름으로 알린다.
  if (!unlocked && c.locked) parts.push(`잠긴 항목 ${c.locked}`);
  if (unlocked && c.p2) parts.push(`2부 수집 ${c.p2}`);
  if (c.broken) parts.push(`깨진 ${c.broken}`);
  if (st.skippedHeic) parts.push(`건너뜀 ${st.skippedHeic}`);
  if (busy) parts.push(`수집 중 ${st.done}/${st.done + st.pending}`);
  if (st.lastAddAt) parts.push(`마지막 수집 ${hhmmss(st.lastAddAt)}`);

  const budget = photosBudgetRatio(ctx.state.photos.items);
  const tip = [
    `총 ${c.total}장 중 지금 송출되는 것은 ${c.shown}장입니다.`,
    `숨김 ${c.hidden}장은 목록에 남아 있고 언제든 되돌릴 수 있습니다.`,
    !unlocked && c.locked ? `잠긴 항목 ${c.locked}장은 잠금을 해제해야 목록에 나오고 송출됩니다.` : null,
    unlocked && c.p2 ? `그중 ${c.p2}장은 잠금 해제 뒤에 수집된 사진입니다 — 다시 잠그면 자동으로 송출에서 빠집니다.` : null,
    c.broken ? `깨진 ${c.broken}장은 목록에는 있는데 이미지 원본이 사라진 사진입니다. 출력에서는 조용히 건너뜁니다.` : null,
    st.skippedHeic
      ? `HEIC ${st.skippedHeic}장은 이 브라우저가 열지 못해 건너뛰었습니다 — 아이폰 [설정 → 카메라 → 포맷]을 '높은 호환성'으로 두세요.`
      : null,
    st.failed.length ? `열지 못한 파일(최근 ${st.failed.length}건): ${st.failed.join(', ')}` : null,
    `사진 목록이 쓰는 저장 공간: 한도의 ${(budget * 100).toFixed(1)}% (사진 원본은 별도 보관소에 있습니다)`,
    st.usage !== null && st.quota
      ? `브라우저 저장소: ${fmtBytes(st.usage)} / ${fmtBytes(st.quota)} 사용 중`
      : null,
    `마지막 스캔 ${hhmmss(st.lastScanAt)} · 마지막 수집 ${hhmmss(st.lastAddAt)}`,
  ]
    .filter(Boolean)
    .join('\n');

  return el('div', {
    class: `photo-status${busy ? ' is-busy' : ''}`,
    text: parts.join(' · '),
    data: { tip },
    tabIndex: 0,
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
}

// ---------------------------------------------------------------- 재생 설정

function settingsSection(ctx: Ctx): HTMLElement {
  const st = ctx.state.photos.settings;
  const toggle = (
    key: 'sepia' | 'vignette' | 'grain' | 'standbyBackdrop',
    label: string,
    tip: string,
  ): HTMLElement => {
    const on = st[key];
    return el('button', {
      class: `seg__btn${on ? ' is-on' : ''}`,
      type: 'button',
      text: `${on ? '☑' : '☐'} ${label} ${on ? '켬' : '끔'}`,
      attrs: { 'aria-pressed': on ? 'true' : 'false' },
      data: { fid: `photo-${key}`, tip },
      on: {
        click: () =>
          ctx.dispatch({
            type: 'photos/settings',
            patch: { [key]: !on } as Partial<PhotoSettings>,
          }),
      },
    });
  };
  return el(
    'div',
    { class: 'field photo-settings' },
    el(
      'span',
      { class: 'field__inline' },
      el('label', {
        class: 'field__label',
        text: '표시 시간',
        attrs: { for: 'photo-interval' },
        data: { tip: '사진 한 장이 화면에 머무는 시간입니다. 바꾸면 다음 사진부터 반영됩니다 — 지금 나가고 있는 한 장은 흔들지 않습니다.' },
        tabIndex: 0,
      }),
      el('input', {
        class: 'input input--num input--compact',
        id: 'photo-interval',
        type: 'number',
        min: PHOTO_INTERVAL_MIN,
        max: PHOTO_INTERVAL_MAX,
        step: 0.5,
        value: String(st.intervalSec),
        data: { fid: 'photo-interval' },
        on: {
          change: (ev) => {
            const input = ev.target as HTMLInputElement;
            const next = clampIntervalSec(Number(input.value));
            // 클램프된 값을 입력칸에도 되돌려 준다 — 화면의 숫자와 실제 값이 어긋나지 않게
            input.value = String(next);
            ctx.dispatch({ type: 'photos/settings', patch: { intervalSec: next } });
          },
        },
      }),
      el('span', { class: 'field__unit', text: '초' }),
    ),
    el('button', {
      class: `seg__btn${st.kenBurns ? ' is-on' : ''}`,
      type: 'button',
      text: `${st.kenBurns ? '☑ Ken Burns 켬' : '☐ Ken Burns 끔'}`,
      attrs: { 'aria-pressed': st.kenBurns ? 'true' : 'false' },
      data: {
        fid: 'photo-kenburns',
        tip: "느린 확대·이동으로 정지 사진에 움직임을 줍니다. 시스템 '동작 줄이기'가 켜져 있으면 이 설정과 무관하게 자동으로 꺼집니다.",
      },
      on: { click: () => ctx.dispatch({ type: 'photos/settings', patch: { kenBurns: !st.kenBurns } }) },
    }),
    toggle('sepia', '세피아', '따뜻한 인화지 색조를 사진에 적용합니다. 다른 필터와 함께 켤 수 있습니다.'),
    toggle('vignette', '비네팅', '사진 가장자리를 은은하게 어둡혀 중앙을 강조합니다.'),
    toggle('grain', '그레인', "저강도 필름 입자를 얹습니다. 시스템 '동작 줄이기'에서는 질감은 유지하고 움직임만 멈춥니다."),
    toggle('standbyBackdrop', '대기 배경', '대기 화면 그래픽 뒤에서 같은 사진 큐를 낮은 명암으로 재생합니다.'),
    el(
      'span',
      { class: 'field__inline' },
      el('label', {
        class: 'field__label',
        text: '순서',
        attrs: { for: 'photo-order' },
        data: { tip: '시간순은 촬영 시각(EXIF) 오름차순입니다. 무작위는 한 바퀴 안에서는 순서가 고정되고 루프할 때마다 다시 섞입니다.' },
        tabIndex: 0,
      }),
      el(
        'select',
        {
          class: 'input input--select',
          id: 'photo-order',
          data: { fid: 'photo-order' },
          attrs: { 'aria-label': '사진 재생 순서' },
          on: {
            change: (ev) =>
              ctx.dispatch({
                type: 'photos/settings',
                patch: { order: (ev.target as HTMLSelectElement).value === 'random' ? 'random' : 'time' },
              }),
          },
        },
        el('option', {
          value: 'time',
          text: '시간순',
          attrs: { selected: st.order === 'time' ? 'selected' : undefined },
        }),
        el('option', {
          value: 'random',
          text: '무작위',
          attrs: { selected: st.order === 'random' ? 'selected' : undefined },
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------- 썸네일 그리드

/**
 * 동시에 열어 두는 썸네일 읽기 수.
 *
 * 셀 300개가 한꺼번에 `getPhotoThumb`을 부르면 IndexedDB 트랜잭션 300개가 동시에 열리고,
 * 그 blob 300개가 한 번에 objectURL이 되어 디코드가 몰린다 — 그리드가 처음 뜰 때 패널이
 * 눈에 띄게 멈추던 자리다. **뷰포트에 들어온 셀만**(아래 `observeCell`) 이 큐에 들어오고,
 * 그마저도 한 번에 이만큼씩만 나간다. 나머지는 앞의 것이 끝나는 대로 이어 나간다.
 */
const THUMB_MAX_INFLIGHT = 12;

function startThumb(id: string): void {
  thumbPending.add(id);
  thumbInflight += 1;
  const settle = () => {
    thumbPending.delete(id);
    thumbInflight -= 1;
    pumpThumbs();
  };
  void getPhotoThumb(id)
    .then((blob) => {
      if (!blob) {
        brokenIds.add(id);
        gridCells.get(id)?.classList.add('is-broken');
        return;
      }
      brokenIds.delete(id);
      const url = URL.createObjectURL(blob);
      thumbUrls.set(id, url);
      const img = gridCells.get(id)?.querySelector('img');
      if (img) img.src = url;
    })
    .catch(() => undefined)
    .finally(settle);
}

/** 빈 슬롯만큼 대기열에서 꺼내 보낸다 */
function pumpThumbs(): void {
  while (thumbInflight < THUMB_MAX_INFLIGHT && thumbQueue.size) {
    const id: string = thumbQueue.values().next().value!;
    thumbQueue.delete(id);
    // 대기하는 동안 이미 읽혔거나(다른 경로) 목록에서 사라졌을 수 있다
    if (thumbUrls.has(id) || thumbPending.has(id)) continue;
    startThumb(id);
  }
}

function ensureThumb(id: string): void {
  if (thumbUrls.has(id) || thumbPending.has(id) || thumbQueue.has(id)) return;
  thumbQueue.add(id);
  pumpThumbs();
}

/**
 * 화면에 들어온 셀만 썸네일을 읽는다.
 *
 * `content-visibility: auto`(CSS)가 화면 밖 셀의 **그리기**를 건너뛰지만, blob을 읽는 것은
 * 막아 주지 않는다. 실제 요청을 미루는 것은 이 관찰자다. `rootMargin`으로 한 화면 못 미쳐
 * 미리 시작해 스크롤이 빈 칸을 지나가지 않게 한다.
 *
 * IntersectionObserver가 없는 환경(아주 오래된 브라우저·테스트 하네스)에서는 곧바로 큐에
 * 넣는다 — 그때도 동시 요청 상한은 그대로 걸린다.
 */
let thumbObserver: IntersectionObserver | null = null;

function observeCell(cell: HTMLElement, id: string): void {
  if (thumbUrls.has(id)) return; // 이미 읽어 둔 사진은 관찰할 이유가 없다
  if (typeof IntersectionObserver !== 'function') {
    ensureThumb(id);
    return;
  }
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          thumbObserver?.unobserve(target); // 한 번 들어왔으면 다시 볼 일이 없다
          const pid = target.dataset.photoId;
          if (pid) ensureThumb(pid);
        }
      },
      { rootMargin: '200px 0px' },
    );
  }
  thumbObserver.observe(cell);
}

/** 상태에서 사라진 사진의 objectURL을 놓아 준다 (그리드가 500장이면 누수가 곧 메모리다) */
function revokeMissing(items: readonly PhotoMeta[]): void {
  const live = new Set(items.map((p) => p.id));
  for (const [id, url] of thumbUrls) {
    if (live.has(id)) continue;
    URL.revokeObjectURL(url);
    thumbUrls.delete(id);
    brokenIds.delete(id);
  }
  for (const id of thumbQueue) if (!live.has(id)) thumbQueue.delete(id);
}

/**
 * 썸네일 자원을 통째로 놓아 준다 — 탭을 떠날 때(§L7)와 [사진 전체 삭제] 때 쓴다.
 *
 * objectURL은 **문서가 살아 있는 동안 revoke하기 전까지 blob을 붙잡는다.** 300~500장을
 * 붙잡은 채 다른 탭에서 리허설을 계속하면 그 메모리가 그대로 남는다. 다시 들어오면
 * IndexedDB에서 읽으면 그만이고, 그 비용은 화면에 들어온 셀 몫만 든다(위 관찰자).
 */
function releaseThumbs(): void {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  thumbQueue.clear();
  brokenIds.clear();
  thumbObserver?.disconnect();
  // 셀 DOM도 함께 버린다 — 남겨 두면 다시 들어왔을 때 `gridSig`가 같아 재사용되는데,
  // 그 `<img>`들은 revoke된 URL을 물고 있어 깨진 칸으로 보인다.
  gridCells.clear();
  gridEl = null;
  gridSig = '';
}

/**
 * 탭 이탈 감시 — `control.ts`의 `render()`는 **활성 탭만** 그리므로, 탭을 떠나면 이 모듈은
 * 다시 호출되지 않는다(언마운트 훅이 없다). 그래서 우리 루트가 DOM에서 빠졌는지를 직접 본다.
 *
 * `render()`는 `#app`을 비우고 통째로 다시 붙인다 → `#app`의 childList 변화가 매 렌더 신호다.
 * 관찰자 콜백은 그 두 변경(비우기·붙이기)이 **끝난 뒤** 마이크로태스크로 돌기 때문에,
 * 이 시점에 우리 루트가 안 붙어 있으면 그것은 "다른 탭이 그려졌다"는 뜻이다.
 */
let rootEl: HTMLElement | null = null;
let leaveObserver: MutationObserver | null = null;

function watchTabLeave(root: HTMLElement): void {
  rootEl = root;
  if (leaveObserver || typeof MutationObserver !== 'function' || typeof document === 'undefined') {
    return;
  }
  const app = document.getElementById('app');
  if (!app) return;
  leaveObserver = new MutationObserver(() => {
    if (!rootEl || rootEl.isConnected) return;
    rootEl = null;
    releaseThumbs();
  });
  leaveObserver.observe(app, { childList: true });
}

function cellTip(p: PhotoMeta, unlocked: boolean): string {
  return [
    p.name || '(이름 없음)',
    `촬영 ${fmtDateTime(p.takenAt)}`,
    `수집 ${fmtDateTime(p.addedAt)}`,
    `${p.w}×${p.h} · ${fmtBytes(p.bytes)}`,
    unlocked && p.p2 ? '잠금 해제 뒤에 수집된 사진 — 다시 잠그면 송출에서 자동으로 빠집니다.' : null,
    p.hidden
      ? '지금 숨김 — 목록 아래로 내려왔습니다. 클릭·Space·Enter 로 다시 표시합니다.'
      : 'Delete로 빠르게 숨기거나, 클릭·Space·Enter 로 송출에서 뺍니다.',
  ]
    .filter(Boolean)
    .join('\n');
}

function applyCellState(cell: HTMLElement, p: PhotoMeta, index: number, unlocked: boolean): void {
  cell.classList.toggle('is-hidden', p.hidden);
  cell.classList.toggle('is-broken', brokenIds.has(p.id));
  cell.setAttribute('aria-pressed', p.hidden ? 'true' : 'false');
  // 파일명은 라벨이 아니라 툴팁에만 둔다 — 화면엔 요약, hover에 근거.
  cell.setAttribute('aria-label', `사진 ${index + 1}번째, ${p.hidden ? '숨김' : '표시'}`);
  cell.dataset.tip = cellTip(p, unlocked);
  cell.tabIndex = p.id === focusId ? 0 : -1;

  const badge = cell.querySelector('.photocell__badge');
  if (badge) badge.textContent = p.hidden ? '숨김' : '';
  cell.classList.toggle('has-badge', p.hidden);
}

/**
 * 셀 한 칸을 만든다 — 상태 표시는 전부 `applyCellState()`가 맡는다(재렌더 때 갱신되도록).
 *
 * `2부 수집` 배지는 **잠금 해제 중에만 노드를 만든다.** `hidden` 속성으로 감추기만 하면
 * 문자열이 DOM에 그대로 남아 잠금 검사망(innerHTML 기준)에 걸린다. 잠금이 바뀌면 셀 목록이
 * 달라져 그리드가 통째로 다시 만들어지므로(`gridSig`), 만들 시점의 판정으로 충분하다.
 */
function buildCell(ctx: Ctx, p: PhotoMeta, unlocked: boolean): HTMLElement {
  const cell = el(
    'button',
    {
      class: 'photocell',
      type: 'button',
      tabIndex: -1,
      data: { fid: `photo-cell-${p.id}`, photoId: p.id },
      on: {
        click: () => {
          focusId = p.id;
          // 셀 DOM은 재렌더 사이에 재사용되므로 이 클로저의 `p`는 **만들 때의 스냅샷**이다.
          // `p.hidden`을 그대로 뒤집으면 두 번째 클릭이 같은 값을 다시 보내 아무 일도
          // 일어나지 않는다(reducer가 같은 참조를 돌려준다). 지금 값을 상태에서 읽는다.
          const cur = ctx.state.photos.items.find((x) => x.id === p.id);
          if (!cur) return;
          ctx.dispatch({ type: 'photos/hidden', id: p.id, hidden: !cur.hidden });
        },
        focus: () => {
          focusId = p.id;
        },
      },
    },
    el('img', {
      class: 'photocell__img',
      // 런타임 이미지에 사진 메타 문자열을 싣지 않는다 — alt는 빈 값, title·aria-label 미설정.
      alt: '',
      attrs: { loading: 'lazy', decoding: 'async' },
    }),
    el('span', { class: 'photocell__badge' }),
    unlocked && p.p2 ? el('span', { class: 'photocell__p2', text: '2부 수집' }) : null,
  );
  const cached = thumbUrls.get(p.id);
  // 이미 읽어 둔 사진은 그 자리에서 붙이고, 나머지는 **화면에 들어올 때** 읽는다(§M6).
  if (cached) cell.querySelector('img')!.src = cached;
  else observeCell(cell, p.id);
  return cell;
}

/** 그리드의 실제 열 수 — 첫 셀과 같은 줄(offsetTop)에 있는 셀 수 */
function columnCount(grid: HTMLElement): number {
  const cells = [...grid.children] as HTMLElement[];
  if (cells.length < 2) return 1;
  const top = cells[0].offsetTop;
  let n = 0;
  for (const c of cells) {
    if (c.offsetTop !== top) break;
    n += 1;
  }
  return Math.max(1, n);
}

/**
 * 그리드 키보드 내비 — ←→ wrap · ↑↓ 열 유지 · Home/End · PageUp/PageDown.
 *
 * **처리한 키는 `stopPropagation()`으로 반드시 막는다.** `control.ts`가 `window` 버블 단계에서
 * ArrowLeft/ArrowRight를 큐시트 이전/다음에 물려 두었기 때문에, 막지 않으면 그리드에서
 * 방향키를 누를 때마다 큐시트가 같이 넘어간다.
 *
 * Space/Enter는 `preventDefault()`하지 않는다 — `<button>`의 네이티브 활성화에 맡겨야
 * 클릭 핸들러가 정확히 한 번 돈다. 다만 전역 Space(타이머 시작/정지)로 새지 않게
 * 전파는 여기서 끊는다.
 */
function onGridKey(ev: KeyboardEvent, ids: readonly string[]): void {
  const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.photocell');
  if (!target || !gridEl) return;
  const id = target.dataset.photoId;
  if (!id) return;

  if (ev.key === ' ' || ev.key === 'Enter') {
    ev.stopPropagation();
    return;
  }

  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    const ctx = gridCtx;
    if (!ctx) return;
    const current = ctx.state.photos.items.find((p) => p.id === id);
    ev.preventDefault();
    ev.stopPropagation();
    if (!current || current.hidden) return;
    const unlocked = ctx.state.p2.unlocked;
    const allowed = ctx.state.photos.items.filter((p) => unlocked || !p.p2);
    const next = nextPhotoFocusAfterHide(photoGridOrder(allowed), id);
    focusId = next;
    ctx.dispatch({ type: 'photos/hidden', id, hidden: true });
    if (next) {
      requestAnimationFrame(() => {
        const cell = gridCells.get(next);
        if (!cell) return;
        for (const c of gridCells.values()) c.tabIndex = -1;
        cell.tabIndex = 0;
        cell.focus();
        cell.scrollIntoView({ block: 'nearest' });
      });
    }
    return;
  }

  const i = ids.indexOf(id);
  if (i < 0) return;
  const n = ids.length;
  const cols = columnCount(gridEl);
  let next = -1;

  switch (ev.key) {
    case 'ArrowRight':
      next = (i + 1) % n;
      break;
    case 'ArrowLeft':
      next = (i - 1 + n) % n;
      break;
    case 'ArrowDown':
      next = Math.min(n - 1, i + cols);
      break;
    case 'ArrowUp':
      next = Math.max(0, i - cols);
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = n - 1;
      break;
    case 'PageDown':
      next = Math.min(n - 1, i + cols * 4);
      break;
    case 'PageUp':
      next = Math.max(0, i - cols * 4);
      break;
    default:
      return;
  }

  ev.preventDefault();
  ev.stopPropagation();
  const cell = gridCells.get(ids[next]);
  if (!cell) return;
  focusId = ids[next];
  for (const c of gridCells.values()) c.tabIndex = -1;
  cell.tabIndex = 0;
  cell.focus();
  cell.scrollIntoView({ block: 'nearest' });
}

function gridSection(ctx: Ctx): HTMLElement {
  gridCtx = ctx;
  const s = ctx.state;
  const unlocked = s.p2.unlocked;
  const items = s.photos.items;
  revokeMissing(items);

  // 잠금 중에는 2부에 수집된 사진의 **셀 자체를 그리지 않는다** (§11 H2)
  const visible = photoGridOrder(unlocked ? items : items.filter((p) => !p.p2));
  const limit = Math.min(shownLimit, visible.length);
  const cellItems = visible.slice(0, limit);
  const ids = cellItems.map((p) => p.id);

  if (!focusId || !ids.includes(focusId)) focusId = ids[0] ?? null;

  const sig = ids.join(',');
  if (!gridEl || sig !== gridSig) {
    gridSig = sig;
    gridCells.clear();
    // 옛 셀은 버려진다 → 그 관찰 등록과, 아직 안 나간 요청 대기열도 함께 버린다.
    // (지금 날아가 있는 요청은 그대로 둔다 — 도착하면 `gridCells`에 없어 조용히 캐시만 된다.)
    thumbObserver?.disconnect();
    thumbQueue.clear();
    gridEl = el('div', {
      class: 'photogrid',
      attrs: { role: 'group', 'aria-label': '수집한 사진' },
    });
    for (const p of cellItems) {
      const cell = buildCell(ctx, p, unlocked);
      gridCells.set(p.id, cell);
      gridEl.appendChild(cell);
    }
    // 리스너는 그리드 컨테이너에 **한 번만** 건다. 셀마다 걸면 500개가 된다.
    // 순서는 `gridCells`(Map은 삽입 순서를 지킨다)에서 그때그때 읽는다.
    gridEl.addEventListener('keydown', (ev) => onGridKey(ev, [...gridCells.keys()]));
  }
  cellItems.forEach((p, i) => {
    const cell = gridCells.get(p.id);
    if (cell) applyCellState(cell, p, i, unlocked);
  });

  const rest = visible.length - limit;
  const emptyNote = !visible.length
    ? unlocked || !items.length
      ? '아직 수집한 사진이 없습니다. 위로 끌어다 놓거나 폴더를 연결하세요.'
      : '지금 볼 수 있는 사진이 없습니다 — 잠긴 항목만 있습니다.'
    : null;

  return el(
    'div',
    { class: 'photogrid-block' },
    el(
      'div',
      { class: 'photogrid-head' },
      el('h3', { class: 'section__title', text: `사진 목록 (${visible.length})` }),
      !unlocked && items.length !== visible.length
        ? el('span', {
            class: 'chip',
            text: `잠긴 항목 ${items.length - visible.length}`,
            data: { tip: '잠금을 해제해야 목록에 나오고 송출됩니다. 개수만 알립니다.' },
            tabIndex: 0,
          })
        : null,
    ),
    emptyNote ? el('p', { class: 'empty', text: emptyNote }) : gridEl,
    rest > 0
      ? el('button', {
          class: 'btn btn--tiny',
          type: 'button',
          text: `나머지 ${rest}장 보기`,
          data: {
            fid: 'photo-more',
            tip: `한 번에 ${GRID_INITIAL}장까지만 그립니다. 썸네일 수백 장을 한꺼번에 그리면 패널이 눈에 띄게 멈추기 때문입니다. 목록에 없어도 송출에는 전부 나갑니다.`,
          },
          on: {
            click: () => {
              shownLimit += GRID_STEP;
              ctx.refresh();
            },
          },
        })
      : null,
  );
}

// ---------------------------------------------------------------- 초기화

function dangerSection(ctx: Ctx): HTMLElement {
  const items = ctx.state.photos.items;
  const hiddenCount = items.filter((p) => p.hidden).length;

  return el(
    'div',
    { class: 'btnrow' },
    el('button', {
      class: 'btn btn--tiny',
      type: 'button',
      text: '숨김 전체 해제',
      disabled: hiddenCount === 0,
      data: {
        tip: hiddenCount
          ? `숨김 ${hiddenCount}장을 한 번에 되돌립니다. 되돌릴 수 있는 동작이라 확인을 받지 않습니다.`
          : '숨긴 사진이 없습니다.',
      },
      on: {
        click: () => {
          // 잠금 중이라도 숨김 해제는 전부 대상이다 — 숨김은 송출 여부일 뿐 잠금과 다른 축이다.
          // 액션 **하나**로 낸다: 장당 `photos/hidden`을 내면 reducer·저장·방송이 장수만큼
          // 돌아 300장에서 클릭 한 번이 눈에 보이게 멈췄다(§M7).
          ctx.dispatch({ type: 'photos/unhideAll' });
          toast(`숨김 ${hiddenCount}장을 되돌렸습니다`);
        },
      },
    }),
    el('button', {
      class: 'btn btn--danger btn--tiny',
      type: 'button',
      text: '사진 전체 삭제',
      disabled: items.length === 0,
      data: { tip: '수집한 사진을 모두 지웁니다. 폴더의 원본 파일은 그대로입니다.' },
      on: {
        click: () =>
          openModal({
            title: '사진 전체 삭제',
            body: `수집한 사진 ${items.length}장을 목록에서 지우고, 브라우저 안(IndexedDB)에 보관한 사진 원본도 함께 지웁니다. 폴더의 원본 파일은 그대로입니다. 되돌릴 수 없습니다. 계속하려면 DELETE 를 입력하세요.`,
            danger: true,
            confirmLabel: '삭제',
            requireText: 'DELETE',
            onConfirm: () => {
              ctx.dispatch({ type: 'photos/clear' });
              releaseThumbs();
              focusId = null;
              shownLimit = GRID_INITIAL;
              void clearPhotos().catch(() => toast('사진 원본을 지우지 못했습니다', 'bad'));
              toast('사진을 모두 지웠습니다', 'warn');
            },
          }),
      },
    }),
  );
}

// ---------------------------------------------------------------- 탭

export function render(ctx: Ctx): HTMLElement {
  const root = el(
    'div',
    {
      class: 'tabpane photo-drop-surface',
      on: {
        dragover: (ev) => {
          ev.preventDefault();
          root.classList.add('is-drop-over');
        },
        dragleave: (ev) => {
          if (!(ev.currentTarget as HTMLElement).contains((ev as DragEvent).relatedTarget as Node | null)) {
            root.classList.remove('is-drop-over');
          }
        },
        drop: (ev) => {
          ev.preventDefault();
          root.classList.remove('is-drop-over');
          const files = (ev as DragEvent).dataTransfer?.files;
          if (files?.length) void ingest(files, ctx);
        },
      },
    },
    sourceSection(ctx),
    statusLine(ctx),
    settingsSection(ctx),
    gridSection(ctx),
    dangerSection(ctx),
    el('p', {
      class: 'tabpane__hint',
      text: '사진은 [씬 런처]의 [현장 사진] 또는 F6 으로 송출합니다. 셀에서 Delete를 누르면 완전 삭제하지 않고 숨김 목록으로 내려갑니다.',
    }),
  );
  // 탭을 떠나면 썸네일 objectURL을 놓아 준다 (§L7). 언마운트 훅이 없어 DOM 이탈을 직접 본다.
  watchTabLeave(root);
  return root;
}
