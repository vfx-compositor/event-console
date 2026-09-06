import { h, renderInto, type VNode } from '../vdom';
import type { AppState } from '../types';

/**
 * G5 긴급속보 스팅 (1초) — 붉은 플래시 + 글리치.
 * 다음 씬(영상)으로의 전환은 control이 스케줄한다(리더 단일화).
 */
export function view(_state: AppState): VNode {
  return h(
    'div',
    { class: 'scene scene--breaking' },
    h('div', { class: 'breaking__flash' }),
    h('div', { class: 'breaking__scan' }),
    h(
      'div',
      { class: 'breaking__word' },
      h('span', { class: 'breaking__word-a' }, 'BREAKING'),
      h('span', { class: 'breaking__word-b', 'aria-hidden': 'true' }, 'BREAKING'),
      h('span', { class: 'breaking__word-c', 'aria-hidden': 'true' }, 'BREAKING'),
    ),
  );
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
