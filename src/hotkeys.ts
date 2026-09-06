/**
 * 단축키 — **물리 키(`event.code`) 기준**으로 매칭한다.
 *
 * 왜 code인가: 한글 입력 모드에서는 `event.key`가 'ㄱ' 같은 자모로 오거나
 * IME 조합 중에는 'Process'/keyCode 229로 온다. 행사 중 한/영 상태를 신경 쓰게 만들 수 없으므로
 * 레이아웃·IME와 무관한 `code`로 본다. (F1~F10, Space, ←/→ 는 code가 항상 동일하다.)
 *
 * 단, 텍스트 입력 중에는 절대 개입하지 않는다. 모달이 열려 있으면 Esc/Enter를 제외한 전역 키는 새지 않는다.
 */

export type HotkeyHandler = (ev: KeyboardEvent) => void;

export interface HotkeyMap {
  [combo: string]: HotkeyHandler;
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * select는 텍스트 입력은 아니지만 Space/방향키가 네이티브 동작이라 가로채면 안 된다.
 * 반면 F1~F10 같은 기능키는 select에 포커스가 있어도 씬을 바꿀 수 있어야 한다
 * (순위 드롭다운을 만지다가 F2를 눌렀는데 아무 일도 안 일어나면 현장에서 사고가 난다).
 */
export function isSelect(target: EventTarget | null): boolean {
  return (target as HTMLElement | null)?.tagName === 'SELECT';
}

const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/;

/** IME 조합 중인 이벤트인가 (한글 입력 중 자모 조합) */
export function isComposingEvent(ev: KeyboardEvent): boolean {
  return ev.isComposing === true || ev.keyCode === 229 || ev.key === 'Process';
}

/** `event.code` → 콤보에 쓰는 짧은 이름 */
function normalizeCode(code: string): string {
  if (code === 'NumpadEnter') return 'Enter';
  if (code === 'NumpadComma') return 'Comma';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  return code; // 'F1' | 'Space' | 'Comma' | 'Escape' | 'ArrowRight' | ...
}

/**
 * 이벤트 → 정규화된 콤보 문자열 ('F1', 'Space', 'Meta+Comma', 'ArrowRight').
 * `code`가 비어 있는 환경(일부 가상 키보드)에서만 `key`로 폴백한다.
 */
export function comboOf(ev: KeyboardEvent): string {
  const parts: string[] = [];
  if (ev.metaKey) parts.push('Meta');
  if (ev.ctrlKey) parts.push('Ctrl');
  if (ev.altKey) parts.push('Alt');
  if (ev.shiftKey) parts.push('Shift');

  let key: string;
  if (ev.code) {
    key = normalizeCode(ev.code);
  } else {
    key = ev.key;
    if (key === ' ') key = 'Space';
    else if (key === ',') key = 'Comma';
    else if (key.length === 1) key = key.toUpperCase();
  }
  parts.push(key);
  return parts.join('+');
}

export interface HotkeyOptions {
  /** true를 반환하면 (모달 열림 등) Esc/Enter 외 키를 무시한다 */
  isBlocked?: () => boolean;
}

export function installHotkeys(map: HotkeyMap, opts: HotkeyOptions = {}): () => void {
  const onKey = (ev: KeyboardEvent) => {
    if (isTyping(ev.target)) return;
    // IME 조합 중에는 어떤 단축키도 가로채지 않는다 (조합 확정이 우선)
    if (isComposingEvent(ev)) return;
    const combo = comboOf(ev);
    if (isSelect(ev.target) && !FUNCTION_KEY.test(combo)) return;
    if (opts.isBlocked?.() && combo !== 'Escape' && combo !== 'Enter') return;
    const handler = map[combo];
    if (!handler) return;
    ev.preventDefault();
    handler(ev);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
