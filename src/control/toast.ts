import { el } from './dom';

export interface ToastAction {
  label: string;
  onClick(): void;
  /** hover / focus 시 뜨는 한 단계 깊은 설명 */
  tip?: string;
}

/** 액션 없는 알림은 읽고 지나가면 그만이다. 액션이 붙으면 손이 갈 시간을 줘야 한다. */
const PLAIN_MS = 2400;
const ACTION_MS = 7000;

export function toast(message: string, kind: 'ok' | 'warn' | 'bad' = 'ok', action?: ToastAction): void {
  const root = document.getElementById('toast-root');
  if (!root) return;

  const node = el('div', { class: `toast toast--${kind}${action ? ' toast--action' : ''}` });
  node.append(el('span', { class: 'toast__text', text: message }));

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    node.classList.add('is-out');
    window.setTimeout(() => node.remove(), 260);
  };

  if (action) {
    node.append(
      el('button', {
        class: 'btn btn--tiny toast__action',
        type: 'button',
        text: action.label,
        data: { tip: action.tip },
        on: {
          click: () => {
            close();
            action.onClick();
          },
        },
      }),
    );
  }

  root.appendChild(node);
  window.setTimeout(close, action ? ACTION_MS : PLAIN_MS);
}
