/** 조작 패널용 DOM 빌더 — 이벤트 핸들러가 필요하므로 실제 엘리먼트를 만든다. */

export type Child = Node | string | number | null | false | undefined;

type Props = {
  class?: string;
  id?: string;
  title?: string;
  type?: string;
  value?: string | number;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  rows?: number;
  accept?: string;
  multiple?: boolean;
  href?: string;
  src?: string;
  alt?: string;
  style?: string;
  text?: string | number;
  tabIndex?: number;
  data?: Record<string, string | number | boolean | undefined>;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { data, attrs, on, text, ...rest } = props;

  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'style') node.setAttribute('style', String(v));
    else if (k === 'tabIndex') node.tabIndex = Number(v);
    else if (k in node) (node as unknown as Record<string, unknown>)[k] = v;
    else node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = String(text);
  if (data) for (const [k, v] of Object.entries(data)) if (v !== undefined) node.dataset[k] = String(v);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined) node.setAttribute(k, String(v));
  if (on) {
    for (const [k, fn] of Object.entries(on)) {
      node.addEventListener(k, fn as EventListener);
    }
  }

  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function frag(...children: (Child | Child[])[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    f.append(c instanceof Node ? c : String(c));
  }
  return f;
}
