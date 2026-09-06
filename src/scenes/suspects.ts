import { h, renderInto, type VNode } from '../vdom';
import type { AppState } from '../types';

/** 용의자 보드 6칸 — 탈락 시 X 스탬프 → 흑백 → 축소. 2부 잠금 해제 후에만 렌더된다. */
export function view(state: AppState): VNode {
  const list = state.settings.suspects;
  const out = new Set(state.p2.eliminated);
  const remain = list.filter((s) => !out.has(s.code)).length;
  return h(
    'div',
    { class: 'scene scene--suspects' },
    h(
      'div',
      { class: 'sus__head' },
      h('div', { class: 'sus__title' }, '용의자 보드'),
      h(
        'div',
        { class: 'sus__counter' },
        h('span', { class: 'sus__counter-n' }, String(remain)),
        h('span', { class: 'sus__counter-l' }, `/ ${list.length} 남음`),
      ),
    ),
    h(
      'div',
      { class: 'sus__grid' },
      list.map((s) =>
        h(
          'div',
          { class: `sus__card${out.has(s.code) ? ' is-out' : ''}`, 'data-code': s.code },
          h('div', { class: 'sus__code' }, s.code),
          h('div', { class: 'sus__photo' }, h('span', { class: 'sus__silhouette' })),
          h('div', { class: 'sus__name' }, s.name || '이름 미입력'),
          h('div', { class: 'sus__sport' }, s.sport || '—'),
          out.has(s.code) ? h('div', { class: 'sus__stamp' }, '탈락') : null,
        ),
      ),
    ),
  );
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
