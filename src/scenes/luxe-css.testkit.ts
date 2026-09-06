/**
 * display.css를 셀렉터·속성 단위로 조회하는 테스트 보조기.
 * 그룹 셀렉터(`.luxe-board, .sb__board { … }`)를 쓰기 시작하면서 정규식 문자열 매칭이
 * 깨지기 쉬워졌다 — 여기서 한 번 파싱해 세 씬 테스트가 같은 방식으로 확인한다.
 *
 * 파일명이 `*.test.ts`가 아니므로 vitest가 이 파일 자체를 테스트로 수집하지 않고,
 * 앱 코드가 import하지 않으므로 번들에도 들어가지 않는다.
 */
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

export const CSS: string = readFileSync(
  new URL('../styles/display.css', import.meta.url),
  'utf8',
);

/** 재사용 토큰의 정본. --luxe-* 는 세 씬이 공유하므로 display.css가 아니라 여기 있다. */
export const TOKENS: string = readFileSync(
  new URL('../styles/tokens.css', import.meta.url),
  'utf8',
);

export interface CssRule {
  selectors: string[];
  body: string;
}

/** 주석 제거 — 안 하면 앞선 주석이 셀렉터 문자열에 딸려 들어온다. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 중첩 없는 선언 블록을 전부 뽑는다. @media 안쪽 규칙도 개별 규칙으로 잡힌다. */
export function parseRules(source: string): CssRule[] {
  return [...stripComments(source).matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    body: m[2],
  }));
}

/**
 * display.css에서 `S4 리더보드`처럼 이름 붙은 섹션 하나를 잘라 온다.
 * `endMark`를 생략하면 파일 끝까지 — 마지막 섹션(시상)에 쓴다.
 */
export function section(startMark: string, endMark?: string): string {
  const start = CSS.indexOf(startMark);
  if (start < 0) throw new Error(`섹션 시작을 찾지 못했다: ${startMark}`);
  const end = endMark === undefined ? -1 : CSS.indexOf(endMark, start + startMark.length);
  const slice = CSS.slice(start, end < 0 ? undefined : end);
  // 섹션 이름은 주석 안에 있으므로 잘린 조각이 주석 중간에서 시작한다.
  // 여는 `/*`를 되살려 두어야 stripComments가 머리 주석을 제대로 걷어낸다.
  const close = slice.indexOf('*/');
  const open = slice.indexOf('/*');
  return close >= 0 && (open < 0 || close < open) ? `/*${slice}` : slice;
}

/**
 * 그 셀렉터에 최종적으로 적용되는 선언값. 같은 셀렉터가 여러 번 나오면 마지막 값을 준다.
 * 상속·다른 셀렉터의 우선순위는 보지 않는다 — "이 규칙을 이 값으로 적었는가"만 확인한다.
 */
export function declOf(source: string, selector: string, prop: string): string | null {
  let found: string | null = null;
  for (const rule of parseRules(source)) {
    if (!rule.selectors.includes(selector)) continue;
    const m = rule.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) found = m[1].trim();
  }
  return found;
}

/** 소스 안의 양수 letter-spacing 값 목록. 비어 있어야 한다(전역 UI 규칙). */
export function positiveLetterSpacings(source: string): string[] {
  return [...stripComments(source).matchAll(/letter-spacing:\s*([^;}]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => v !== '0' && !v.startsWith('-') && !v.startsWith('inherit'));
}

/** `@keyframes <name>`으로 정의된 이름들. */
export function keyframeNames(source: string): string[] {
  return [...stripComments(source).matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
}

/** animation 값에서 이름이 아닌 토큰 — 시간·이징·반복·방향·채움 키워드. */
const ANIM_KEYWORDS = new Set([
  'none', 'both', 'forwards', 'backwards', 'infinite', 'normal', 'reverse',
  'alternate', 'alternate-reverse', 'running', 'paused', 'linear', 'ease',
  'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end', 'initial',
  'inherit', 'unset',
]);

/**
 * `animation` / `animation-name` 선언이 참조하는 keyframe 이름들.
 * var()·cubic-bezier()·steps() 같은 함수 호출과 시간 값은 먼저 걷어낸다.
 */
export function animationRefs(source: string): string[] {
  const names: string[] = [];
  for (const m of stripComments(source).matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    // 쉼표로 나열한 다중 애니메이션도 각각 본다
    for (const part of m[1].split(',')) {
      const cleaned = part.replace(/[\w-]+\([^()]*\)/g, ' ');
      for (const token of cleaned.trim().split(/\s+/)) {
        if (!token || ANIM_KEYWORDS.has(token)) continue;
        if (/^-?[\d.]+m?s$/.test(token) || /^-?[\d.]+$/.test(token)) continue;
        if (!/^-?[A-Za-z_][\w-]*$/.test(token)) continue;
        names.push(token);
      }
    }
  }
  return names;
}

/**
 * 렌더된 HTML에서 각 `.luxe-row`의 세로 오프셋(px)을 계산한다.
 * CSS가 `transform: translateY(calc(var(--row-index) * var(--step)))`로 배치하므로
 * 마크업의 `--row-index`와 `--step`을 곱하면 실제 화면 위치가 된다.
 * D4: 정적 씬(출전명단·시상 표)이 tick 없이도 겹치지 않는지 이 값으로 확인한다.
 */
export function rowOffsets(html: string): number[] {
  const step = Number.parseInt(html.match(/--step:\s*(\d+)px/)?.[1] ?? '0', 10);
  return [...html.matchAll(/--row-index:\s*(\d+)/g)].map((m) => Number.parseInt(m[1], 10) * step);
}

function namesIn(value: string): string[] {
  const out: string[] = [];
  const cleaned = value.replace(/[\w-]+\([^()]*\)/g, ' ');
  for (const token of cleaned.trim().split(/\s+/)) {
    if (!token || ANIM_KEYWORDS.has(token)) continue;
    if (/^-?[\d.]+m?s$/.test(token) || /^-?[\d.]+$/.test(token)) continue;
    if (!/^-?[A-Za-z_][\w-]*$/.test(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * `both`/`forwards` fill로 붙은 애니메이션을 (셀렉터, keyframe 이름) 쌍으로 모은다.
 * 이 keyframe의 `to` 블록은 끝난 뒤에도 계속 적용되므로, 같은 요소에 붙는 상태 클래스가
 * 나중에 주는 값을 영구히 덮어쓴다.
 */
export function fillingAnimations(source: string): { selector: string; keyframe: string }[] {
  const pairs: { selector: string; keyframe: string }[] = [];
  for (const rule of parseRules(source)) {
    for (const m of rule.body.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
      for (const part of m[1].split(',')) {
        if (!/\b(both|forwards)\b/.test(part)) continue;
        for (const keyframe of namesIn(part)) {
          for (const selector of rule.selectors) pairs.push({ selector, keyframe });
        }
      }
    }
  }
  return pairs;
}

/** `both`/`forwards` fill을 쓰는 keyframe 이름들. */
export function fillingKeyframeNames(source: string): string[] {
  return [...new Set(fillingAnimations(source).map((p) => p.keyframe))];
}

/**
 * 셀렉터 `sel`에 상태 클래스 하나를 덧붙인 규칙들(`.sub__bar` → `.sub__bar.is-wait`)이
 * 선언하는 속성 이름. 진입 keyframe의 `to`가 이 속성을 고정하면 상태가 화면에서 죽는다.
 */
export function statePropsFor(source: string, sel: string): string[] {
  const props = new Set<string>();
  for (const rule of parseRules(source)) {
    for (const other of rule.selectors) {
      if (other === sel || !other.startsWith(sel)) continue;
      // 바로 뒤에 클래스 하나만 더 붙은 형태만 본다 (자손·자식 셀렉터는 다른 요소다)
      if (!/^\.[\w-]+$/.test(other.slice(sel.length))) continue;
      for (const d of rule.body.matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)) props.add(d[1]);
    }
  }
  return [...props];
}

/** `@keyframes <name>`의 `to`(= 100%) 블록 본문. 없으면 null. */
export function keyframeToBlock(source: string, name: string): string | null {
  const clean = stripComments(source);
  const head = clean.indexOf(`@keyframes ${name}`);
  if (head < 0) return null;
  const open = clean.indexOf('{', head);
  let depth = 0;
  let end = open;
  for (let i = open; i < clean.length; i += 1) {
    if (clean[i] === '{') depth += 1;
    else if (clean[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = clean.slice(open + 1, end);
  return body.match(/(?:^|[\s,}])(?:to|100%)\s*\{([^}]*)\}/)?.[1] ?? null;
}
