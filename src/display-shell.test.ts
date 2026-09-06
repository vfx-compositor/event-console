// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('출력창 초기 셸', () => {
  it('첫 paint 전에도 전체화면 버튼을 노출하지 않는다', () => {
    const html = readFileSync(new URL('../display.html', import.meta.url), 'utf8');
    expect(html).toContain('<button id="fs-btn" type="button" title="전체화면 (F)" hidden>');
  });

  /**
   * 음소거 버튼도 같은 규칙이다 (U88) — 첫 paint가 표시 여부를 정하기 전까지는 감춰 둔다.
   * 라벨을 마크업에 적지 않는 이유는 상태를 그리는 곳이 하나여야 하기 때문이다
   * (`updateMuteBtn()`이 라벨·툴팁·`aria-pressed`를 함께 쓴다).
   */
  it('첫 paint 전에도 음소거 버튼을 노출하지 않는다', () => {
    const html = readFileSync(new URL('../display.html', import.meta.url), 'utf8');
    expect(html).toContain('<button id="mute-btn" type="button" aria-pressed="false" hidden>');
  });
});
