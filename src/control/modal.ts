/**
 * 확인 모달 — 포커스 트랩 + 첫 포커스 자동 + Enter 확인 + Esc 닫기.
 * (Enter 예외: textarea 줄바꿈, 버튼의 네이티브 활성화, IME 조합 중)
 */

import { clear, el } from './dom';

export interface ModalOptions {
  title: string;
  body: string | Node;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** 지정하면 이 문자열을 정확히 입력해야 확인 버튼이 활성화된다 */
  requireText?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

let openCount = 0;

export function isModalOpen(): boolean {
  return openCount > 0;
}

export function openModal(opts: ModalOptions): void {
  const root = document.getElementById('modal-root');
  if (!root) return;
  openCount += 1;

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const confirmBtn = el('button', {
    class: `btn ${opts.danger ? 'btn--danger' : 'btn--primary'}`,
    type: 'button',
    text: opts.confirmLabel ?? '확인',
    disabled: Boolean(opts.requireText),
  });

  const cancelBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: opts.cancelLabel ?? '취소',
  });

  const input = opts.requireText
    ? el('input', {
        class: 'modal__input',
        type: 'text',
        placeholder: opts.requireText,
        attrs: { 'aria-label': `확인 문구 ${opts.requireText} 입력` },
        on: {
          input: (ev) => {
            const v = (ev.target as HTMLInputElement).value.trim();
            confirmBtn.disabled = v !== opts.requireText;
          },
        },
      })
    : null;

  const dialog = el(
    'div',
    {
      class: `modal${opts.danger ? ' modal--danger' : ''}`,
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
    },
    el('h2', { class: 'modal__title', text: opts.title }),
    el('div', { class: 'modal__body' }, typeof opts.body === 'string' ? el('p', { text: opts.body }) : opts.body),
    input,
    el('div', { class: 'modal__actions' }, cancelBtn, confirmBtn),
  );

  const overlay = el('div', { class: 'modal__overlay' }, dialog);

  const close = () => {
    root.removeEventListener('keydown', onKey, true);
    clear(root);
    openCount = Math.max(0, openCount - 1);
    previouslyFocused?.focus?.();
  };

  const confirm = () => {
    if (confirmBtn.disabled) return;
    close();
    opts.onConfirm?.();
  };

  const cancel = () => {
    close();
    opts.onCancel?.();
  };

  confirmBtn.addEventListener('click', confirm);
  cancelBtn.addEventListener('click', cancel);
  overlay.addEventListener('mousedown', (ev) => {
    if (ev.target === overlay) cancel();
  });

  const focusables = (): HTMLElement[] =>
    [...dialog.querySelectorAll<HTMLElement>('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (e) => !e.hasAttribute('disabled'),
    );

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
      return;
    }
    if (ev.key === 'Tab') {
      // 포커스 트랩
      const list = focusables();
      if (!list.length) return;
      const idx = list.indexOf(document.activeElement as HTMLElement);
      ev.preventDefault();
      const next = ev.shiftKey ? (idx - 1 + list.length) % list.length : (idx + 1) % list.length;
      list[next].focus();
      return;
    }
    if (ev.key === 'Enter') {
      const t = ev.target as HTMLElement;
      if (t.tagName === 'TEXTAREA') return; // 줄바꿈 허용
      if (t.tagName === 'BUTTON') return; // 네이티브 활성화에 맡김
      if (ev.isComposing) return; // IME 조합 확정
      ev.preventDefault();
      confirm();
    }
  };

  root.addEventListener('keydown', onKey, true);
  clear(root);
  root.appendChild(overlay);

  // 첫 포커스: 입력이 있으면 입력, 없으면 확인 버튼
  (input ?? confirmBtn).focus();
}

/** 위험 동작 공통 확인 헬퍼 */
export function confirmDanger(title: string, body: string, onConfirm: () => void, requireText?: string): void {
  openModal({ title, body, danger: true, confirmLabel: '실행', requireText, onConfirm });
}
