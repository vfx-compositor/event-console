/**
 * 커스텀 툴팁 — 화면엔 요약, hover/focus에 근거.
 * `data-tip="..."`가 붙은 요소에 hover, keyboard focus, touch tap 모두 같은 상세를 연다.
 * (native title 대신: 지연이 길고 키보드/터치에서 안 열림)
 */

let tipEl: HTMLElement | null = null;
let current: HTMLElement | null = null;

function ensureEl(): HTMLElement {
  if (tipEl) return tipEl;
  const node = document.createElement('div');
  node.className = 'tip';
  node.setAttribute('role', 'tooltip');
  node.id = 'event-console-tip';
  document.body.appendChild(node);
  tipEl = node;
  return node;
}

function show(target: HTMLElement): void {
  const text = target.dataset.tip;
  if (!text) return;
  const node = ensureEl();
  node.textContent = text;
  node.classList.add('is-on');
  target.setAttribute('aria-describedby', 'event-console-tip');
  current = target;

  const r = target.getBoundingClientRect();
  const tr = node.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
  let top = r.top - tr.height - 10;
  if (top < 8) top = r.bottom + 10;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function hide(): void {
  tipEl?.classList.remove('is-on');
  current?.removeAttribute('aria-describedby');
  current = null;
}

export function installTooltips(): void {
  const findTip = (t: EventTarget | null): HTMLElement | null =>
    (t as HTMLElement | null)?.closest?.('[data-tip]') ?? null;

  document.addEventListener('mouseover', (ev) => {
    const t = findTip(ev.target);
    if (t) show(t);
  });
  document.addEventListener('mouseout', (ev) => {
    if (findTip(ev.target)) hide();
  });
  document.addEventListener('focusin', (ev) => {
    const t = findTip(ev.target);
    if (t) show(t);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('click', (ev) => {
    // 터치: 탭하면 열고, 다른 곳 탭하면 닫힘
    const t = findTip(ev.target);
    if (t) show(t);
    else hide();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, true);
}
