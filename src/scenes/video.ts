import { h, renderInto, type VNode } from '../vdom';
import type { AppState } from '../types';

/**
 * 등록 영상 풀스크린 재생.
 * `.video-slot`은 비워 두고 display.ts가 싱글턴 <video>를 붙인다
 * (IndexedDB Blob → objectURL. 재생 중 HTML이 교체돼도 끊기지 않도록 재부착).
 */
export function view(state: AppState): VNode {
  const id = state.sceneOpts.video.assetId;
  const asset = state.assets.find((a) => a.id === id);
  return h(
    'div',
    { class: 'scene scene--video' },
    h('div', { class: 'video-slot', 'data-video-slot': id ?? '' }),
    !asset ? h('div', { class: 'video__empty' }, '등록된 영상이 없습니다 — 패널 [영상·에셋] 탭에서 등록하세요') : null,
  );
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
