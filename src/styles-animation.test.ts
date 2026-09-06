// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  animationRefs,
  CSS,
  declOf,
  fillingAnimations,
  fillingKeyframeNames,
  keyframeNames,
  keyframeToBlock,
  statePropsFor,
} from './scenes/luxe-css.testkit';

const CONTROL = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');

/**
 * 정의되지 않은 keyframe 이름을 쓰면 브라우저는 조용히 무시한다 — 애니메이션이 그냥 안 돈다.
 * `sb-rise`가 정의 없이 참조만 남아 진입 모션이 죽어 있던 사고가 실제로 있었다.
 */
describe('애니메이션 참조 무결성', () => {
  for (const [name, source] of [
    ['display.css', CSS],
    ['control.css', CONTROL],
  ] as const) {
    it(`${name}이 참조하는 keyframe은 전부 정의돼 있다`, () => {
      const defined = new Set(keyframeNames(source));
      const missing = [...new Set(animationRefs(source))].filter((n) => !defined.has(n));
      expect(missing).toEqual([]);
    });
  }

  it('스캐너가 실제 참조와 정의를 찾아낸다 — 빈 배열 비교로 통과하지 않게', () => {
    expect(animationRefs(CSS).length).toBeGreaterThan(20);
    expect(keyframeNames(CSS).length).toBeGreaterThan(10);
    expect(animationRefs('a{animation:sb-rise var(--dur-in) var(--ease-out) both}')).toEqual([
      'sb-rise',
    ]);
    expect(animationRefs('a{animation:none}')).toEqual([]);
  });
});

/**
 * `both` fill 진입 모션의 `to` 블록은 끝난 뒤에도 계속 적용된다.
 * `sb-rise`가 `to { opacity: 1 }`을 두는 바람에 `.sub__bar.is-wait`의
 * 40% 디밍(디자인 시스템 §3.2)이 화면에서 영영 안 먹던 사고가 있었다.
 */
describe('진입 keyframe이 상태 클래스를 덮지 않는다', () => {
  it('.sub__bar.is-wait 디밍이 sb-rise에 덮이지 않는다', () => {
    expect(declOf(CSS, '.sub__bar.is-wait', 'opacity')).toBe('0.44');
    expect(declOf(CSS, '.sub__bar', 'animation')).toContain('sb-rise');
    // to 블록이 없어야 애니메이션이 끝난 뒤 요소가 자기 원래 값(=상태 클래스)으로 돌아간다
    expect(keyframeToBlock(CSS, 'sb-rise')).toBeNull();
  });

  for (const [name, source] of [
    ['display.css', CSS],
    ['control.css', CONTROL],
  ] as const) {
    it(`${name}: both fill keyframe이 같은 요소의 상태 클래스 속성을 고정하지 않는다`, () => {
      const offenders: string[] = [];
      for (const { selector, keyframe } of fillingAnimations(source)) {
        const to = keyframeToBlock(source, keyframe);
        if (!to) continue;
        for (const prop of statePropsFor(source, selector)) {
          if (new RegExp(`(?:^|;)\\s*${prop}\\s*:`).test(to)) {
            offenders.push(`${selector} + ${keyframe} → ${prop}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('스캐너가 both fill 애니메이션과 to 블록을 실제로 찾아낸다', () => {
    expect(fillingKeyframeNames(CSS).length).toBeGreaterThan(5);
    expect(fillingAnimations(CSS).some((p) => p.selector === '.sub__bar')).toBe(true);
    expect(keyframeToBlock('@keyframes x{from{opacity:0}to{opacity:1}}', 'x')).toContain('opacity');
    // 사고 재현: to가 opacity를 고정하면 .is-wait 디밍이 잡힌다
    const broken = '.b{animation:r 1s both}.b.is-wait{opacity:.44}@keyframes r{from{opacity:0}to{opacity:1}}';
    expect(statePropsFor(broken, '.b')).toContain('opacity');
    expect(keyframeToBlock(broken, 'r')).toContain('opacity');
  });
});
