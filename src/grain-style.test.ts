// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');

describe('사진 그레인 합성', () => {
  it('색·명암 blend/filter 없이 독립 노이즈 레이어만 사용한다', () => {
    const block = css.match(/\.photo-stage\.is-grain::after\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).toMatch(/mix-blend-mode:\s*normal/);
    expect(block).not.toMatch(/filter\s*:/);
    expect(block).not.toMatch(/mix-blend-mode:\s*overlay/);
    const backdrop = css.match(/\.photo-backdrop\.is-grain::after\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(backdrop).not.toMatch(/opacity\s*:\s*0\.(?:[2-9]|1[3-9])/);
  });
});
