import { h, renderInto, type VNode } from '../vdom';
import type { AppState } from '../types';

/** G8 몸으로 말해요 제시어 카드 — 카테고리 + 제시어 + 라운드 + 3·2·1 카운트 */
export function view(state: AppState): VNode {
  const p = state.sceneOpts.prompt;
  return h(
    'div',
    { class: 'scene scene--prompt' },
    h('div', { class: 'prompt__round' }, `ROUND ${p.round}`),
    p.category ? h('div', { class: 'prompt__cat' }, p.category) : null,
    h('div', { class: 'prompt__word' }, p.text || '제시어 대기'),
    p.countdown !== null
      ? h('div', { class: 'prompt__count', 'data-n': String(p.countdown) }, p.countdown === 0 ? '포즈!' : String(p.countdown))
      : null,
  );
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
