/**
 * 단축키가 한/영 입력 모드와 무관하게 동작하는지 — `event.code` 매칭 검증.
 * (DOM 없이 순수 함수만 검사한다. installHotkeys는 window가 필요해 여기선 다루지 않는다.)
 */

import { describe, expect, it } from 'vitest';
import { comboOf, isComposingEvent, isSelect, isTyping } from './hotkeys';

/** KeyboardEvent 흉내 — comboOf가 읽는 필드만 채운다 */
function ev(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    ...init,
  } as KeyboardEvent;
}

describe('comboOf — 물리 키(code) 기준 매칭', () => {
  it('한글 입력 모드에서 key가 자모로 와도 code로 매칭된다', () => {
    // 한글 모드에서 R 키 → key는 'ㄱ', code는 'KeyR'
    expect(comboOf(ev({ key: 'ㄱ', code: 'KeyR' }))).toBe('R');
    expect(comboOf(ev({ key: 'ㅁ', code: 'KeyA' }))).toBe('A');
  });

  it('F1~F10은 한글 모드에서도 그대로 F1~F10이다', () => {
    for (const n of [1, 2, 3, 4, 9, 10]) {
      expect(comboOf(ev({ key: `F${n}`, code: `F${n}` }))).toBe(`F${n}`);
    }
  });

  it('Space·방향키·Escape는 code 이름을 그대로 쓴다', () => {
    expect(comboOf(ev({ key: ' ', code: 'Space' }))).toBe('Space');
    expect(comboOf(ev({ key: 'ArrowRight', code: 'ArrowRight' }))).toBe('ArrowRight');
    expect(comboOf(ev({ key: 'ArrowLeft', code: 'ArrowLeft' }))).toBe('ArrowLeft');
    expect(comboOf(ev({ key: 'Escape', code: 'Escape' }))).toBe('Escape');
  });

  it('Cmd+, 는 한글 모드에서도 Meta+Comma 로 온다', () => {
    expect(comboOf(ev({ key: ',', code: 'Comma', metaKey: true }))).toBe('Meta+Comma');
    // 한글 모드에서 key가 다른 문자로 와도 결과는 같다
    expect(comboOf(ev({ key: 'ㅁ', code: 'Comma', metaKey: true }))).toBe('Meta+Comma');
    expect(comboOf(ev({ key: ',', code: 'Comma', ctrlKey: true }))).toBe('Ctrl+Comma');
  });

  it('숫자·넘패드도 정규화된다', () => {
    expect(comboOf(ev({ key: '3', code: 'Digit3' }))).toBe('3');
    expect(comboOf(ev({ key: '3', code: 'Numpad3' }))).toBe('3');
    expect(comboOf(ev({ key: 'Enter', code: 'NumpadEnter' }))).toBe('Enter');
  });

  it('code가 비어 있는 환경에서는 key로 폴백한다', () => {
    expect(comboOf(ev({ key: ' ', code: '' }))).toBe('Space');
    expect(comboOf(ev({ key: 'r', code: '' }))).toBe('R');
    expect(comboOf(ev({ key: ',', code: '', metaKey: true }))).toBe('Meta+Comma');
  });
});

describe('입력 중 불개입', () => {
  it('input·textarea·contenteditable에 포커스가 있으면 타이핑으로 본다', () => {
    expect(isTyping({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it('select는 타이핑은 아니지만 별도로 구분한다 (기능키만 통과시키기 위해)', () => {
    expect(isTyping({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(false);
    expect(isSelect({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
  });

  it('IME 조합 중 이벤트는 isComposing·keyCode 229·key=Process 중 무엇으로 와도 걸러진다', () => {
    expect(isComposingEvent(ev({ isComposing: true, code: 'KeyR' }))).toBe(true);
    expect(isComposingEvent(ev({ keyCode: 229, code: 'KeyR' }))).toBe(true);
    expect(isComposingEvent(ev({ key: 'Process', code: 'KeyR' }))).toBe(true);
    expect(isComposingEvent(ev({ key: 'F2', code: 'F2' }))).toBe(false);
  });
});
