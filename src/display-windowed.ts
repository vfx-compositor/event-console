/**
 * 출력 창의 **창 모드 소리 제어** (U88).
 *
 * ## 무엇을 만들었다가 되돌렸나
 * 첫 구현은 "전체화면이 아니면 **자동으로** 무음"이었다(2026-09-04 00:14 지시). 00:36에
 * 사용자가 되돌렸다 — "창 모드일 때 소리 꺼짐은 취소. 그냥 원래 계획대로 창 모드일 땐 음소거
 * 버튼이 보이고 누를 수 있게." 자동 무음은 **아무도 누르지 않은 규칙이 소리를 끄는** 구조라,
 * 리허설에서 창을 띄워 소리를 확인하는 평범한 동작이 불가능해진다. 끄고 싶은 창이 있으면
 * 그 창에서 끄면 된다.
 *
 * ## 그래서 이 파일이 정하는 것
 * 운영자가 **이 창에서만** 소리를 끄는 토글이다. 서브 모니터에 확인용으로 display를 하나 더
 * 띄웠을 때, 그 창의 소리만 죽여 에코를 없애는 데 쓴다.
 *
 *  - **창 단위다.** 선택은 `sessionStorage`에만 남고 상태 원장에도 방송에도 오르지 않는다.
 *    `localStorage`에 두면 진짜 출력 창이 다음에 열릴 때 그 선택을 물려받아 **프로젝터가
 *    무음으로** 나간다. 방송하면 두 창이 서로의 소리를 끈다. 둘 다 이 기능이 막으려던 것보다
 *    큰 사고다.
 *  - **전체화면에 들어가면 자동으로 풀린다.** 전체화면인 창은 정의상 프로젝터로 나가는 창이고,
 *    무음으로 나가는 것이 가장 나쁜 실패다. 음소거는 창 모드의 편의이지 송출 설정이 아니다.
 *    기억된 선택은 지우지 않는다 — 창 모드로 돌아오면 되살아난다.
 *  - **버튼은 창 모드에서만 보인다.** 전체화면에서는 누를 수 있는 것이 없어야 한다(눌러도
 *    아무 일이 없는 손잡이를 남기지 않는다). 표시 규칙은 `#fs-btn`을 그대로 따라간다.
 *
 * ## 자동재생 잠금과 **다른 축**이다
 * `audio-lock.ts`의 잠금은 브라우저 정책이 막은 사고이고, 이쪽은 운영자가 누른 상태다.
 * 그래서 음소거 때문에 `audioLockLevel`이 올라가서는 안 된다 — 고칠 것이 없는 빨강 배너가
 * 상시로 떠 있으면 진짜 잠금이 왔을 때 아무도 안 본다. 두 상태는 끝까지 분리한다.
 */

/** display가 control에 보내는 두 이벤트 이름 (`sync.ts`의 `DisplayEvent`에 등록되어 있다) */
export type UserMuteEvent = 'audio-user-muted' | 'audio-user-unmuted';

/**
 * 실제로 미디어에 적용되는 음소거.
 *
 * 전체화면에서는 **언제나 거짓**이다(기억된 선택 `wish`는 그대로 두고 무시만 한다).
 * 모니터도 거짓이다 — 저쪽은 `outputMuted`의 `monitor` 축이 이미 전부 끄고 있어, 여기서
 * 한 번 더 참을 내면 "음소거 중"이라는 신호가 조작 패널에 이중으로 뜬다.
 */
export function effectiveUserMute(wish: boolean, fullscreen: boolean, monitor: boolean): boolean {
  return !monitor && wish && !fullscreen;
}

/**
 * 음소거 버튼을 감출 것인가 — `#fs-btn`이 안 보이는 자리 **또는** 전체화면.
 *
 * `fsBtnHidden`을 그대로 받는다. 같은 조건(모니터·운영 크롬을 감춘 씬)을 다시 계산하면
 * 씬 규칙이 바뀌는 날 둘이 어긋나 한쪽만 남는다.
 */
export function userMuteButtonHidden(fsBtnHidden: boolean, fullscreen: boolean): boolean {
  return fsBtnHidden || fullscreen;
}

export function userMuteEvent(muted: boolean): UserMuteEvent {
  return muted ? 'audio-user-muted' : 'audio-user-unmuted';
}

export function isUserMuteEvent(name: string): name is UserMuteEvent {
  return name === 'audio-user-muted' || name === 'audio-user-unmuted';
}

/**
 * 버튼 라벨 — 색·형태만으로 끝내지 않고 **글자로도** 지금 상태를 말한다.
 * (`aria-pressed`가 접근성 축을 맡고, 이 문자열이 눈으로 읽는 축을 맡는다.)
 */
export function userMuteLabel(muted: boolean): string {
  return muted ? '🔇 음소거 중' : '🔊 소리 켬';
}

/**
 * 음소거 중일 때만 라벨 옆에 붙는 한 줄.
 *
 * 전체화면에 들어가면 저절로 풀린다는 사실은 **누르기 전에** 보여야 한다. 툴팁에만 두면
 * hover하지 않은 운영자는 "껐는데 프로젝터에서 소리가 난다"를 사고로 읽는다.
 */
export const USER_MUTE_AUTO_HINT = '전체화면 시 자동 해제';

export function userMuteHint(muted: boolean): string | null {
  return muted ? USER_MUTE_AUTO_HINT : null;
}

/** 버튼 툴팁 — 무엇을 위한 손잡이인지, 그리고 어디까지만 미치는지 */
export function userMuteTip(muted: boolean): string {
  const what = muted
    ? '이 창의 소리를 껐습니다. 다시 누르면 켜집니다.'
    : '이 창에서만 소리를 끕니다.';
  return (
    `${what} 서브 모니터에 확인용으로 띄운 출력 창의 소리를 죽여 현장 에코를 없애는 손잡이입니다. ` +
    '이 선택은 이 창에만 남고 조작 패널이나 다른 출력 창에는 전달되지 않습니다. ' +
    '전체화면(F)에 들어가면 자동으로 해제됩니다 — 프로젝터로 나가는 창이 무음인 것이 가장 큰 사고입니다. ' +
    '창 모드로 돌아오면 이 선택이 되살아납니다.'
  );
}

/** 조작 패널 상단 칩 라벨. 짧게 — 상단 바가 흔들리면 안 된다 */
export const USER_MUTE_CHIP = '출력 창 음소거 중';

/** 칩 툴팁 — 무엇이 일어났고 어디서 뭘 눌러야 하는지 */
export const USER_MUTE_CHIP_TIP =
  '출력 창에서 음소거 버튼이 눌려 있어 소리가 나가지 않습니다. 출력 창 우하단 [🔇 음소거 중]을 다시 누르거나 F로 전체화면에 들어가면 해제됩니다.';

/**
 * 상단 칩을 그릴 것인가.
 *
 * `null`/`undefined` = 출력 창이 아직 보고하지 않음 — 모르는 것을 경고로 칠하지 않는다
 * (`cameraOk`·`audioLocked`와 같은 관례). 창을 열자마자 1~2초 경고가 떴다 사라지면
 * 그 다음부터 아무도 안 본다.
 */
export function userMuteChipVisible(muted: boolean | null | undefined): boolean {
  return muted === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 창 단위 기억 (sessionStorage)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **`sessionStorage`다 — `localStorage`가 아니다.**
 *
 * `sessionStorage`는 탭·창 하나에 매인 저장소라 이 선택이 다른 창으로 새지 않는다.
 * `localStorage`로 두면 조작 패널·다른 출력 창과 같은 통을 쓰게 되고(게다가 `storage`
 * 이벤트로 새어 나간다), 다음에 여는 진짜 출력 창이 남의 음소거를 물려받는다.
 */
export const USER_MUTE_KEY = 'nsdh.console.display.userMute';

/** 저장본 해석 — 모르는 값은 전부 "소리 켬"이다. 기본값은 언제나 소리가 나는 쪽이다. */
export function parseStoredUserMute(raw: string | null | undefined): boolean {
  return raw === '1';
}

export function storedUserMuteValue(muted: boolean): string {
  return muted ? '1' : '0';
}
