/**
 * 보조 조작 패널 잠금 오버레이 — 리더가 아닌 control 창을 통째로 덮는다.
 *
 * 조작을 막는 것만으로는 부족하다. 운영자는 "버튼이 왜 안 먹지"가 아니라
 * **왜 안 먹는지와 무엇을 하면 되는지**를 그 자리에서 봐야 한다.
 * 그래서 안내 + [인수] + [닫기] 두 갈래만 남기고 Esc로 빠져나갈 길은 두지 않는다
 * (Esc로 닫히면 조작 불가 상태만 남아 더 혼란스럽다).
 *
 * 리더 판정 대기(`pending`) 중에도 오버레이를 **띄운 채** 문구만 바꾼다.
 * 잠깐 걷었다가 다시 덮으면 그 사이 뒤 화면의 버튼이 눌리는데, 그중 일부(에셋 등록·로고 삭제·
 * 전체 초기화)는 dispatch를 거치지 않고 IndexedDB를 직접 쓴다 — 리더 가드가 닿지 않는 경로다.
 */

import { clear, el } from './dom';

export type PassiveOverlayPhase = 'pending' | 'passive';

export interface PassiveOverlayOptions {
  phase: PassiveOverlayPhase;
  /** 이 창이 리더였다가 다른 창에 자리를 빼앗긴 경우 — 문구가 달라진다 */
  yielded: boolean;
  onTakeover: () => void;
}

const ROOT_ID = 'passive-root';

/** 포커스가 오버레이 밖으로 새면 되돌릴 지점 */
let focusAnchor: HTMLElement | null = null;
let noticeEl: HTMLElement | null = null;

function onFocusIn(ev: FocusEvent): void {
  const root = document.getElementById(ROOT_ID);
  if (!root || !root.firstChild || !focusAnchor) return;
  const target = ev.target as Node | null;
  if (target && root.contains(target)) return;
  // 뒤 화면은 inert지만 브라우저·확장에 따라 포커스가 샐 수 있다 — 무조건 되돌린다
  focusAnchor.focus();
}

function ensureRoot(): HTMLElement {
  const existing = document.getElementById(ROOT_ID);
  if (existing) return existing;
  const root = document.createElement('div');
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

export function hidePassiveOverlay(): void {
  document.removeEventListener('focusin', onFocusIn, true);
  focusAnchor = null;
  noticeEl = null;
  document.getElementById(ROOT_ID)?.remove();
}

/** 오버레이에 한 줄 경고를 덧붙인다 (인수 거절 등). 오버레이가 없으면 무시. */
export function setPassiveOverlayNotice(text: string): void {
  if (!noticeEl) return;
  noticeEl.textContent = text;
  noticeEl.hidden = false;
}

export function showPassiveOverlay(opts: PassiveOverlayOptions): void {
  const root = ensureRoot();
  clear(root);

  const pending = opts.phase === 'pending';
  const title = pending
    ? '조작 패널 확인 중…'
    : opts.yielded
      ? '다른 창이 조작 패널을 인수했습니다'
      : '조작 패널이 이미 다른 창에 열려 있습니다';
  const desc = pending
    ? '다른 창이 이미 열려 있는지 확인하고 있습니다.'
    : '두 창이 동시에 조작하면 씬과 점수가 서로 덮어써집니다. 기존 창을 계속 쓰려면 이 창을 닫으세요.';

  const notice = el('p', { class: 'control-passive__notice' });
  notice.hidden = true;
  noticeEl = notice;

  const hint = el('p', {
    class: 'control-passive__hint',
    text: '브라우저가 스크립트로 이 창을 닫지 못했습니다 — 탭을 직접 닫아 주세요 (⌘W).',
  });
  hint.hidden = true;

  const takeoverBtn = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: '이 창을 주 패널로 인수',
    on: { click: () => opts.onTakeover() },
  });

  const closeBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: '이 창 닫기',
    on: {
      click: () => {
        window.close();
        // 스크립트로 열지 않은 창은 close()가 무시된다 → 안내로 대체한다
        window.setTimeout(() => {
          if (!window.closed) hint.hidden = false;
        }, 400);
      },
    },
  });

  const card = el(
    'div',
    {
      class: 'control-passive__card',
      // pending은 버튼이 없으므로 카드 자체가 포커스를 받는다 (포커스가 뒤 화면으로 새지 않게)
      tabIndex: -1,
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    },
    el('h2', { class: 'control-passive__title', text: title }),
    el('p', { class: 'control-passive__desc', text: desc }),
    pending ? null : el('div', { class: 'control-passive__actions' }, takeoverBtn, closeBtn),
    notice,
    pending ? null : hint,
  );

  const overlay = el('div', { class: 'control-passive' }, card);

  overlay.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key === 'Escape') {
        // 닫을 길이 없다 — 인수하거나 창을 닫는 두 갈래뿐
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.key === 'Tab') {
        const list = pending ? [] : [takeoverBtn, closeBtn];
        ev.preventDefault();
        ev.stopPropagation();
        if (!list.length) {
          card.focus();
          return;
        }
        const idx = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = ev.shiftKey ? (idx - 1 + list.length) % list.length : (idx + 1) % list.length;
        list[next].focus();
        return;
      }
      if (ev.key === 'Enter') {
        if (pending) return;
        // 버튼 위 Enter는 네이티브 활성화에 맡긴다 (닫기 버튼에서 인수가 실행되면 안 된다)
        if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
        if (ev.isComposing) return;
        ev.preventDefault();
        ev.stopPropagation();
        opts.onTakeover();
      }
    },
    true,
  );

  root.appendChild(overlay);
  focusAnchor = pending ? card : takeoverBtn;
  document.removeEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusin', onFocusIn, true);
  focusAnchor.focus();
}
