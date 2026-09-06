import { h, renderInto, type VNode } from '../vdom';
import type { AppState } from '../types';

/** 풀스크린 타이머 — 숫자는 data-bind 슬롯, 마지막 10초 레드 펄스는 tick에서 클래스 토글 */
export function view(_state: AppState): VNode {
  return h(
    'div',
    { class: 'scene scene--timer', 'data-bind': 'timerbox' },
    h('div', { class: 'bigtimer__label' }, '남은 시간'),
    h('div', { class: 'bigtimer', 'data-bind': 'timer' }, '00:00'),
    h('div', { class: 'bigtimer__bar' }, h('div', { class: 'bigtimer__fill', 'data-bind': 'timerfill' })),
  );
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
