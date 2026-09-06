/**
 * 팀 설정 탭 — 이름 · 컬러 · 로고.
 *
 * 로고 입력 경로는 셋 다 열려 있다: **파일 선택 · 드래그앤드롭 · 클립보드 붙여넣기(⌘V)**.
 * 스크린샷을 찍어 바로 ⌘V 하는 게 현장에서 제일 빠르기 때문이다.
 *
 * 저장 위치: IndexedDB(blob) + 상태에는 assetId만. base64를 상태에 넣으면
 * localStorage 5MB를 조용히 넘겨 **저장 전체가 실패**한다 (P4 생존 위반).
 */

import { activeTeams } from '../state';
import { deleteAsset, putAsset } from '../db';
import { el } from './dom';
import { forgetLogo, logoUrl } from '../logos';
import { toast } from './toast';
import type { Ctx } from './ctx';
import type { TeamId } from '../types';

export const meta = { id: 'teams', label: '팀 설정' };

const LOGO_MAX = 256;

/** 원본 이미지를 256px PNG blob으로 줄인다 (원본 그대로 두면 수 MB짜리 로고가 들어온다) */
async function toLogoBlob(src: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(src);
  const scale = Math.min(1, LOGO_MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 실패'))), 'image/png');
  });
}

/** 로고 에셋 id는 `logo_` 접두사로 구분한다 — 영상·에셋 목록에는 나오지 않아야 한다 */
export function isLogoAssetId(id: string): boolean {
  return id.startsWith('logo_');
}

async function applyLogo(ctx: Ctx, teamId: TeamId, src: Blob): Promise<void> {
  const team = ctx.state.teams.find((t) => t.id === teamId);
  if (!team) return;
  const blob = await toLogoBlob(src);
  const id = `logo_${teamId}_${Date.now().toString(36)}`;
  await putAsset({
    id,
    name: `${team.name} 로고`,
    type: 'image',
    kind: 'logo',
    mime: 'image/png',
    size: blob.size,
    blob,
    addedAt: Date.now(),
  });
  const prev = team.logoAssetId;
  ctx.dispatch({ type: 'team/patch', teamId, patch: { logoAssetId: id, logoDataUrl: undefined } });
  if (prev) {
    forgetLogo(prev);
    void deleteAsset(prev);
  }
  toast(`${team.name} 로고를 등록했습니다`);
}

function clearLogo(ctx: Ctx, teamId: TeamId): void {
  const team = ctx.state.teams.find((t) => t.id === teamId);
  const prev = team?.logoAssetId;
  ctx.dispatch({ type: 'team/patch', teamId, patch: { logoAssetId: undefined, logoDataUrl: undefined } });
  if (prev) {
    forgetLogo(prev);
    void deleteAsset(prev);
  }
}

/** 클립보드 items에서 첫 이미지를 꺼낸다 */
function imageFromClipboard(data: DataTransfer | null): Blob | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  for (const f of Array.from(data.files ?? [])) {
    if (f.type.startsWith('image/')) return f;
  }
  return null;
}

// ---------------------------------------------------------------- 붙여넣기 경로
//
// ⌘V 의 paste 이벤트는 **포커스된 요소**로 간다. 그래서 드롭존마다 직접 리스너를 달고(주 경로),
// 카드 위에 커서만 올려 둔 채 붙여넣는 경우를 위해 document 레벨 폴백을 하나 더 둔다(hover 경로).

/** 공통 처리 — 클립보드/드래그 데이터에서 이미지를 찾아 로고로 넣는다. 처리했으면 true. */
function handleImageData(ctx: Ctx, teamId: TeamId, data: DataTransfer | null): boolean {
  const img = imageFromClipboard(data);
  if (!img) return false;
  void applyLogo(ctx, teamId, img).catch(() => toast('이미지를 읽지 못했습니다', 'bad'));
  return true;
}

let focusTarget: TeamId | null = null;
let hoverTarget: TeamId | null = null;
let liveCtx: Ctx | null = null;
let pasteInstalled = false;

function installPaste(): void {
  if (pasteInstalled) return;
  pasteInstalled = true;
  document.addEventListener('paste', (ev: ClipboardEvent) => {
    const ctx = liveCtx;
    if (!ctx || ctx.tab !== meta.id) return;
    const target = focusTarget ?? hoverTarget;
    if (!target) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // 텍스트 붙여넣기 방해 금지
    // 드롭존 자신이 이미 처리했으면(요소 리스너) 여기서 또 처리하지 않는다
    if (ev.defaultPrevented) return;
    if (handleImageData(ctx, target, ev.clipboardData)) ev.preventDefault();
  });
}

// ---------------------------------------------------------------- 렌더

function logoDrop(ctx: Ctx, teamId: TeamId): HTMLElement {
  const team = ctx.state.teams.find((t) => t.id === teamId)!;
  const url = logoUrl(team);
  // 미리보기는 화면에 실제로 나가는 그림(= 기본 오피셜 배지 포함)을 보여 주지만,
  // "등록됨" 라벨과 지우기 버튼은 **사용자가 올린 것**에만 걸린다 — 기본 배지에 ×를 달면
  // 눌러도 아무것도 지워지지 않는 죽은 버튼이 된다 (U31).
  const uploaded = Boolean(team.logoAssetId ?? team.logoDataUrl);

  const fileInput = el('input', {
    // 네이티브 file input은 "Choose File / No file chosen" 라벨 폭 때문에 카드를 밀어낸다 → 숨기고 버튼으로 연다
    class: 'visually-hidden',
    id: `logo-file-${teamId}`,
    type: 'file',
    accept: 'image/*',
    data: { fid: `team-logo-${teamId}` },
    on: {
      change: (ev) => {
        const file = (ev.target as HTMLInputElement).files?.[0];
        if (!file) return;
        void applyLogo(ctx, teamId, file).catch(() => toast('이미지를 읽지 못했습니다', 'bad'));
      },
    },
  });

  const zone = el(
    'div',
    {
      class: 'logodrop',
      tabIndex: 0,
      attrs: { role: 'button', 'aria-label': `${team.name} 로고 — 클릭해 파일 선택, 붙여넣기(⌘V), 드래그앤드롭` },
      data: {
        tip: '이미지를 끌어다 놓거나, 이 칸을 클릭·포커스한 뒤 ⌘V 로 클립보드 이미지를 붙여넣으세요. 스크린샷도 됩니다.',
      },
      on: {
        click: (ev) => {
          if ((ev.target as HTMLElement).closest('button')) return;
          fileInput.click();
        },
        keydown: (ev) => {
          const k = (ev as KeyboardEvent).key;
          if (k === 'Enter' || k === ' ') {
            ev.preventDefault();
            fileInput.click();
          }
        },
        focus: () => {
          focusTarget = teamId;
        },
        blur: () => {
          if (focusTarget === teamId) focusTarget = null;
        },
        mouseenter: () => {
          hoverTarget = teamId;
        },
        mouseleave: () => {
          if (hoverTarget === teamId) hoverTarget = null;
        },
        dragover: (ev) => {
          ev.preventDefault();
          zone.classList.add('is-over');
        },
        dragleave: () => zone.classList.remove('is-over'),
        drop: (ev) => {
          ev.preventDefault();
          zone.classList.remove('is-over');
          if (!handleImageData(ctx, teamId, (ev as DragEvent).dataTransfer)) {
            toast('이미지 파일만 등록할 수 있습니다', 'bad');
          }
        },
        // ⌘V — 포커스가 이 존에 있을 때 오는 주 경로
        paste: (ev) => {
          if (handleImageData(ctx, teamId, (ev as ClipboardEvent).clipboardData)) ev.preventDefault();
        },
      },
    },
    el(
      'div',
      { class: `logodrop__preview${url ? ' has-image' : ''}` },
      url
        ? el('img', { class: 'logodrop__img', src: url, alt: `${team.name} 로고` })
        : el('span', { class: 'logodrop__placeholder', text: 'NO LOGO' }),
    ),
    el(
      'div',
      { class: 'logodrop__body' },
      el('span', {
        class: 'logodrop__title',
        text: uploaded ? '로고 등록됨' : url ? '오피셜 기본 로고' : '로고 없음',
      }),
      el('span', { class: 'logodrop__hint', text: '파일 선택 · 붙여넣기(⌘V) · 드래그' }),
    ),
    uploaded
      ? el('button', {
          class: 'btn btn--tiny logodrop__clear',
          type: 'button',
          text: '×',
          attrs: { 'aria-label': `${team.name} 로고 제거` },
          data: { tip: '로고를 지웁니다' },
          on: {
            click: (ev) => {
              ev.stopPropagation();
              clearLogo(ctx, teamId);
            },
          },
        })
      : null,
    fileInput,
  );

  return zone;
}

export function render(ctx: Ctx): HTMLElement {
  liveCtx = ctx;
  installPaste();

  return el(
    'div',
    { class: 'tabpane' },
    el('p', {
      class: 'tabpane__hint',
      text: `참가 팀은 ${activeTeams(ctx.state).length}팀으로 확정되었습니다. 이름·컬러·로고는 출력 화면에 즉시 반영됩니다.`,
    }),
    el(
      'div',
      { class: 'teamgrid' },
      activeTeams(ctx.state).map((t) =>
        el(
          'div',
          { class: 'teamcard', style: `--team:${t.color}` },
          el(
            'div',
            { class: 'teamcard__row' },
            el('label', { class: 'field__label', text: '이름', attrs: { for: `name-${t.id}` } }),
            el('input', {
              class: 'input',
              id: `name-${t.id}`,
              type: 'text',
              value: t.name,
              data: { fid: `team-name-${t.id}` },
              on: {
                change: (ev) =>
                  ctx.dispatch({
                    type: 'team/patch',
                    teamId: t.id,
                    patch: { name: (ev.target as HTMLInputElement).value },
                  }),
              },
            }),
          ),
          el(
            'div',
            { class: 'teamcard__row' },
            el('label', { class: 'field__label', text: '컬러', attrs: { for: `color-${t.id}` } }),
            el('input', {
              class: 'input input--color',
              id: `color-${t.id}`,
              type: 'color',
              value: t.color,
              data: { fid: `team-color-${t.id}` },
              on: {
                change: (ev) =>
                  ctx.dispatch({
                    type: 'team/patch',
                    teamId: t.id,
                    patch: { color: (ev.target as HTMLInputElement).value },
                  }),
              },
            }),
          ),
          logoDrop(ctx, t.id),
        ),
      ),
    ),
  );
}
