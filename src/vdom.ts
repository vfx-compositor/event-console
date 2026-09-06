/**
 * 초경량 vnode — 프레임워크 없이 "순수 뷰 함수"를 얻기 위한 최소 레이어.
 *
 * 왜 필요한가:
 *  - display 씬을 `view(state) -> VNode` 순수 함수로 두면 DOM 라이브러리(jsdom/happy-dom) 없이
 *    `toText()` 로 렌더 결과 텍스트를 테스트할 수 있다. (AC-2: 1부 중 2부 문자열 0건 자동 검증)
 *  - 실제 마운트는 HTML 문자열 비교 후 변경됐을 때만 innerHTML 교체 → CSS 애니메이션이
 *    매 프레임 리셋되지 않는다. 시간에 따라 변하는 텍스트는 vnode에 넣지 않고
 *    `data-bind` 슬롯으로 두고 씬의 tick()에서 textContent만 갱신한다.
 */

export type VChild = VNode | string | number | null | false | undefined;

export interface VNode {
  tag: string;
  props: Record<string, string | number | boolean | null | undefined>;
  children: VChild[];
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'source', 'track']);

export function h(
  tag: string,
  props: Record<string, string | number | boolean | null | undefined> | null = null,
  ...children: (VChild | VChild[])[]
): VNode {
  const flat: VChild[] = [];
  for (const c of children) {
    if (Array.isArray(c)) flat.push(...c);
    else flat.push(c);
  }
  return { tag, props: props ?? {}, children: flat };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attrs(props: VNode['props']): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (v === true) {
      out.push(k);
      continue;
    }
    out.push(`${k}="${escapeHtml(String(v))}"`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}

export function toHTML(node: VChild): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return escapeHtml(node);
  if (typeof node === 'number') return escapeHtml(String(node));
  const inner = node.children.map(toHTML).join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs(node.props)}>`;
  return `<${node.tag}${attrs(node.props)}>${inner}</${node.tag}>`;
}

/**
 * 렌더 결과의 "사람이 읽는 텍스트" — 잠금 검증(AC-2)에 사용.
 * 텍스트 노드뿐 아니라 화면에 노출될 수 있는 속성(title/alt/aria-label/placeholder)도 포함한다.
 */
export function toText(node: VChild): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  const parts: string[] = [];
  for (const key of ['title', 'alt', 'aria-label', 'placeholder', 'data-badge']) {
    const v = node.props[key];
    if (typeof v === 'string') parts.push(v);
  }
  for (const c of node.children) parts.push(toText(c));
  return parts.filter(Boolean).join(' ');
}

interface RenderRoot extends HTMLElement {
  __eventConsoleHtml?: string;
}

/** HTML이 달라졌을 때만 교체. 교체했으면 true. */
export function renderInto(root: HTMLElement, node: VChild): boolean {
  const r = root as RenderRoot;
  const html = toHTML(node);
  if (r.__eventConsoleHtml === html) return false;
  r.__eventConsoleHtml = html;
  r.innerHTML = html;
  return true;
}

export function invalidate(root: HTMLElement): void {
  (root as RenderRoot).__eventConsoleHtml = undefined;
}
