/**
 * 출력 창 전체화면 토글의 판정과 잠금 (U141).
 *
 * 왜 따로 빼는가 — `display.ts`는 부팅과 동시에 DOM을 잡으므로 node 테스트에서 import할 수 없다.
 * 여기에는 DOM을 만지지 않는 두 조각만 둔다: **어떤 키가 토글인가**와 **지금 요청을 내도 되는가**.
 *
 * 사고 (09-06 사용자 보고): "f로 영상 풀스크린했을때 빕 하고 풀스크린됐다가 다시 축소되는현상임".
 * 원인은 두 겹이다.
 *  1. `keydown`에 `ev.repeat` 가드가 없었다. macOS 키 반복 지연(기본 ~250ms)이 전체화면 전환
 *     애니메이션(~0.5s)보다 짧아, f를 아주 잠깐만 길게 눌러도 두 번째 keydown이 도착해
 *     토글이 한 번 더 돌고 `exitFullscreen()`으로 되돌아간다. 전환 중에는 키를 받을 first
 *     responder가 아직 없어 macOS가 경고음(빕)을 낸다.
 *  2. 전환이 끝나기 전에 들어온 두 번째 요청을 막는 장치가 없었다. 키 반복이 아니라 손가락으로
 *     두 번 눌러도, 버튼과 키를 겹쳐 눌러도 같은 왕복이 난다.
 *
 * 그래서 판정에서 반복·수식키·IME를 거르고(1), 그래도 새는 경로는 전환 잠금으로 받는다(2).
 */

/** 전환이 끝났다는 이벤트가 끝내 오지 않을 때 잠금을 푸는 한계 시간 */
export const FULLSCREEN_TRANSITION_TIMEOUT_MS = 1500;

/**
 * 이 keydown이 전체화면 토글인가.
 *
 * - `f`/`F`만. `Shift+F`는 허용한다(대문자를 치려던 손이 실패하면 안 된다).
 * - `ev.repeat`은 거른다 — 위 사고 1의 직접 원인이다.
 * - `Cmd`/`Ctrl`/`Alt`가 섞이면 거른다. `Cmd+Ctrl+F`(macOS 네이티브 전체화면)·`Cmd+F`(찾기)까지
 *   페이지 전체화면을 요청하면 두 전체화면이 겹쳐 서로를 되돌린다.
 * - IME 조합 중도 거른다. 한글 모드에서 `key`는 'ㄹ'/'Process'로 와 이미 무해하지만,
 *   `hotkeys.ts`의 `isComposingEvent`와 같은 판정을 명시해 두 곳이 어긋나지 않게 한다.
 */
export function isFullscreenToggleKey(
  ev: Pick<
    KeyboardEvent,
    'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'
  >,
): boolean {
  if (ev.key !== 'f' && ev.key !== 'F') return false;
  if (ev.repeat) return false;
  // shiftKey는 일부러 보지 않는다 — Shift+F도 토글이다
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  if (ev.isComposing === true || ev.keyCode === 229) return false;
  return true;
}

/**
 * 전환 중 재진입 잠금.
 *
 * `begin()`이 참을 낸 뒤에만 `requestFullscreen()`/`exitFullscreen()`을 부른다. 잠금은
 * `fullscreenchange`/`fullscreenerror`가 오거나(정상) 한계 시간이 지나면(이벤트가 오지 않는
 * 환경) 풀린다. 잠금을 이벤트에만 맡기면 전체화면이 한 번 실패한 창이 영영 토글 불가가 된다.
 */
export interface FullscreenGate {
  /** 지금 요청을 내도 되는가. 참을 내면서 곧바로 잠근다 */
  begin(): boolean;
  /** 전환이 끝났다(또는 실패했다). 잠금을 푼다 */
  settle(): void;
  /** 전환을 기다리는 중인가 (테스트·진단용) */
  readonly pending: boolean;
}

export function createFullscreenGate(
  timeoutMs: number = FULLSCREEN_TRANSITION_TIMEOUT_MS,
): FullscreenGate {
  let pending = false;
  let timer = 0;

  function clear(): void {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  }

  return {
    begin(): boolean {
      if (pending) return false;
      pending = true;
      clear();
      timer = setTimeout(() => {
        timer = 0;
        pending = false;
      }, timeoutMs) as unknown as number;
      return true;
    },
    settle(): void {
      clear();
      pending = false;
    },
    get pending(): boolean {
      return pending;
    },
  };
}
