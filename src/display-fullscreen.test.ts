import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FULLSCREEN_TRANSITION_TIMEOUT_MS,
  createFullscreenGate,
  isFullscreenToggleKey,
} from './display-fullscreen';

type ToggleKeyEvent = Parameters<typeof isFullscreenToggleKey>[0];

function key(over: Partial<ToggleKeyEvent> = {}): ToggleKeyEvent {
  return {
    key: 'f',
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 70,
    ...over,
  };
}

describe('출력 창 전체화면 토글 키 (U141)', () => {
  it('맨 f와 F를 토글로 본다', () => {
    expect(isFullscreenToggleKey(key({ key: 'f' }))).toBe(true);
    expect(isFullscreenToggleKey(key({ key: 'F' }))).toBe(true);
  });

  it('Shift+F는 허용한다', () => {
    expect(isFullscreenToggleKey(key({ key: 'F', shiftKey: true }))).toBe(true);
    expect(isFullscreenToggleKey(key({ key: 'f', shiftKey: true }))).toBe(true);
  });

  it('키 반복(누르고 있기)은 무시한다 — 전환 중 두 번째 토글이 되돌리는 사고', () => {
    expect(isFullscreenToggleKey(key({ repeat: true }))).toBe(false);
    expect(isFullscreenToggleKey(key({ key: 'F', repeat: true }))).toBe(false);
  });

  it('Cmd·Ctrl·Alt가 섞이면 무시한다 — 네이티브 전체화면·찾기와 겹치지 않게', () => {
    expect(isFullscreenToggleKey(key({ metaKey: true }))).toBe(false);
    expect(isFullscreenToggleKey(key({ ctrlKey: true }))).toBe(false);
    expect(isFullscreenToggleKey(key({ altKey: true }))).toBe(false);
    expect(isFullscreenToggleKey(key({ metaKey: true, ctrlKey: true }))).toBe(false);
  });

  it('IME 조합 중은 무시한다', () => {
    expect(isFullscreenToggleKey(key({ isComposing: true }))).toBe(false);
    expect(isFullscreenToggleKey(key({ keyCode: 229 }))).toBe(false);
    expect(isFullscreenToggleKey(key({ key: 'Process', keyCode: 229 }))).toBe(false);
    expect(isFullscreenToggleKey(key({ key: 'ㄹ' }))).toBe(false);
  });

  it('다른 키는 무시한다', () => {
    expect(isFullscreenToggleKey(key({ key: 'g' }))).toBe(false);
    expect(isFullscreenToggleKey(key({ key: ' ' }))).toBe(false);
    expect(isFullscreenToggleKey(key({ key: 'Escape' }))).toBe(false);
  });
});

describe('전체화면 전환 잠금 (U141)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('첫 요청만 통과시키고 전환이 끝나기 전 재진입을 막는다', () => {
    vi.useFakeTimers();
    const gate = createFullscreenGate();
    expect(gate.begin()).toBe(true);
    expect(gate.pending).toBe(true);
    expect(gate.begin()).toBe(false);
    expect(gate.begin()).toBe(false);
  });

  it('fullscreenchange가 오면 잠금이 풀려 다시 토글할 수 있다', () => {
    vi.useFakeTimers();
    const gate = createFullscreenGate();
    expect(gate.begin()).toBe(true);
    gate.settle();
    expect(gate.pending).toBe(false);
    expect(gate.begin()).toBe(true);
  });

  it('이벤트가 끝내 오지 않아도 한계 시간이 지나면 잠금이 풀린다', () => {
    vi.useFakeTimers();
    const gate = createFullscreenGate();
    expect(gate.begin()).toBe(true);
    vi.advanceTimersByTime(FULLSCREEN_TRANSITION_TIMEOUT_MS - 1);
    expect(gate.pending).toBe(true);
    vi.advanceTimersByTime(1);
    expect(gate.pending).toBe(false);
    expect(gate.begin()).toBe(true);
  });

  it('settle 뒤에는 옛 타임아웃이 새 잠금을 풀지 않는다', () => {
    vi.useFakeTimers();
    const gate = createFullscreenGate(1000);
    gate.begin();
    vi.advanceTimersByTime(900);
    gate.settle();
    expect(gate.begin()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(gate.pending).toBe(true);
    vi.advanceTimersByTime(900);
    expect(gate.pending).toBe(false);
  });
});
