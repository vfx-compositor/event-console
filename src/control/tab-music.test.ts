import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleMusicScrubKeydown, musicGroupOpen, musicGroupToggleRecorder, musicScrubPaint } from './tab-music';
import { IDLE_RENDER_HOLD, grabRender, isHeld, releaseRender, type RenderHold, type RenderHoldOwner } from './render-hold';

describe('음악 탭 그룹 열림 상태 (D3)', () => {
  const none = new Map<string, boolean>();

  it('기본값은 현재 곡의 섹션과 아이스브레이크만 열려 있다', () => {
    expect(musicGroupOpen('01_아이스브레이크', undefined, none)).toBe(true);
    expect(musicGroupOpen('03_팀소개', '03_팀소개', none)).toBe(true);
    expect(musicGroupOpen('03_팀소개', undefined, none)).toBe(false);
  });

  it('사용자가 연 그룹은 재렌더(3초 hello 등)에도 열린 채로 남는다', () => {
    const overrides = new Map([['03_팀소개', true]]);
    expect(musicGroupOpen('03_팀소개', undefined, overrides)).toBe(true);
  });

  it('사용자가 닫은 그룹은 재렌더에 다시 열리지 않는다', () => {
    const overrides = new Map([['01_아이스브레이크', false]]);
    expect(musicGroupOpen('01_아이스브레이크', undefined, overrides)).toBe(false);
    expect(musicGroupOpen('03_팀소개', '03_팀소개', new Map([['03_팀소개', false]]))).toBe(false);
  });
});

/**
 * `<details>` 하나를 흉내 낸다. `open`을 바꾸면 브라우저처럼 toggle 이벤트가 뜬다 —
 * 렌더가 `open` 속성을 다는 최초 1회(합성)와 사용자의 클릭을 같은 경로로 흘린다.
 */
class FakeDetails {
  open: boolean;
  private listeners: Array<() => void> = [];

  constructor(renderedOpen: boolean) {
    this.open = renderedOpen;
  }

  onToggle(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** 렌더가 `open` 속성을 단 것만으로 뜨는 합성 toggle (열린 채로 그렸을 때만 발생) */
  emitInitialToggle(): void {
    if (this.open) for (const fn of this.listeners) fn();
  }

  /** summary 클릭 */
  click(): void {
    this.open = !this.open;
    for (const fn of this.listeners) fn();
  }
}

/** control의 렌더 한 번 — `render()`가 그룹을 통째로 새로 그리는 것과 같다 */
function renderGroup(
  section: string,
  currentSection: string | undefined,
  overrides: Map<string, boolean>,
): FakeDetails {
  const wantOpen = musicGroupOpen(section, currentSection, overrides);
  const group = new FakeDetails(wantOpen);
  const record = musicGroupToggleRecorder(section, wantOpen, overrides);
  group.onToggle(() => record(group.open));
  group.emitInitialToggle();
  return group;
}

describe('음악 탭 그룹 토글 기록 (D3)', () => {
  const SECTION = '03_팀소개';

  it('열어 둔 그룹이 200ms 재렌더에도 접히지 않는다', () => {
    const overrides = new Map<string, boolean>();
    renderGroup(SECTION, undefined, overrides).click(); // 사용자가 펼침
    expect(renderGroup(SECTION, undefined, overrides).open).toBe(true);
    expect(renderGroup(SECTION, undefined, overrides).open).toBe(true);
  });

  it('재렌더 전에 폈다 다시 접으면 닫힘이 기록된다', () => {
    const overrides = new Map<string, boolean>();
    const group = renderGroup(SECTION, undefined, overrides);
    group.click(); // 펼침
    group.click(); // 같은 렌더 안에서 다시 접음
    expect(overrides.get(SECTION)).toBe(false);
    expect(renderGroup(SECTION, undefined, overrides).open).toBe(false);
  });

  it('기본으로 열린 그룹의 합성 toggle은 기록하지 않고, 사용자가 접으면 접힌 채로 남는다', () => {
    const overrides = new Map<string, boolean>();
    const group = renderGroup('01_아이스브레이크', undefined, overrides);
    expect(group.open).toBe(true);
    expect(overrides.has('01_아이스브레이크')).toBe(false); // 합성 toggle은 사용자의 뜻이 아니다

    group.click(); // 사용자가 접음
    expect(renderGroup('01_아이스브레이크', undefined, overrides).open).toBe(false);
  });

  it('다른 섹션 곡을 재생해도 사용자가 연 그룹은 유지된다', () => {
    const overrides = new Map<string, boolean>();
    renderGroup(SECTION, '06_시상식', overrides).click();
    expect(renderGroup(SECTION, '06_시상식', overrides).open).toBe(true);
  });
});

/**
 * U104 리뷰 m7 — 핸들·fill·시간 텍스트를 만드는 `musicScrubPaint`를 실제로 호출해 검증한다.
 * `control-layout.test.ts`의 원문 정규식 스캔은 "배선이 이 함수를 부르는가"만 확인하고,
 * "그 함수가 실제로 옳은 값을 내는가·잡는 동안 정말 멈추는가"는 여기서 실행해서 본다.
 */
describe('음악 슬라이더 페인트 계산 (U104 리뷰 m7)', () => {
  it('잡고 있는 동안(포인터 드래그·키보드 시크)은 null — 아무것도 다시 그리지 않는다', () => {
    // t/d가 무엇이든 held:true면 값을 계산조차 하지 않는다 — 호출자는 DOM에 손대지 않는다
    expect(musicScrubPaint({ held: true, t: 0, d: 0 })).toBeNull();
    expect(musicScrubPaint({ held: true, t: 125.4, d: 250.8 })).toBeNull();
    expect(musicScrubPaint({ held: true, t: 250.8, d: 250.8 })).toBeNull();
  });

  it('놓여 있으면 핸들 값·fill·시간 텍스트를 한 계산식에서 낸다', () => {
    const paint = musicScrubPaint({ held: false, t: 125.4, d: 250.8 });
    expect(paint).not.toBeNull();
    expect(paint!.value).toBeCloseTo(125.4, 6);
    expect(paint!.max).toBeCloseTo(250.8, 6);
    expect(paint!.fillPercent).toBeCloseTo(50, 6); // 정확히 절반 지점
    expect(paint!.timeText).toBe('2:05'); // floor(125.4) = 125s
    expect(paint!.durationText).toBe('4:10'); // floor(250.8) = 250s
    expect(paint!.ariaValueText).toBe('2:05 / 4:10');
  });

  /**
   * 전역 UI 규칙(슬라이더/플레이바) — 핸들 중심 = fill 끝 = 진행률이 한 계산식에서 나와야
   * 하고, 완료 판정은 0%·중간·100% 세 지점에서 실측한다. 여기서는 rect 대신
   * `value/max*100`(핸들이 실제로 앉을 자리의 비율)과 `fillPercent`가 항상 같은 값인지로
   * 같은 계약을 확인한다 — 둘이 따로 계산되면 반드시 어긋난다.
   */
  it('0% · 중간 · 100% 세 지점에서 핸들 비율과 fill 비율이 정확히 일치한다', () => {
    const d = 200;
    for (const t of [0, 50, 100, 150, 200]) {
      const paint = musicScrubPaint({ held: false, t, d })!;
      const handleRatio = (paint.value / paint.max) * 100;
      expect(handleRatio).toBeCloseTo(paint.fillPercent, 6);
    }
    // 명시적으로 0% · 중간 · 100%
    expect(musicScrubPaint({ held: false, t: 0, d: 200 })!.fillPercent).toBe(0);
    expect(musicScrubPaint({ held: false, t: 100, d: 200 })!.fillPercent).toBe(50);
    expect(musicScrubPaint({ held: false, t: 200, d: 200 })!.fillPercent).toBe(100);
  });

  it('실제 재생 위치(liveT)가 바뀌면 그대로 따라간다 — 핸들이 멈춰 서지 않는다', () => {
    const d = 300;
    const early = musicScrubPaint({ held: false, t: 10, d })!;
    const later = musicScrubPaint({ held: false, t: 190, d })!;
    expect(later.value).toBeGreaterThan(early.value);
    expect(later.fillPercent).toBeGreaterThan(early.fillPercent);
    expect(later.timeText).not.toBe(early.timeText);
  });

  it('재생 위치가 곡 길이를 넘겨도(부동소수 오차 등) 핸들·fill이 100%에서 같이 멈춘다', () => {
    const paint = musicScrubPaint({ held: false, t: 205, d: 200 })!;
    expect(paint.value).toBe(200); // Math.min(t, d)로 클램프
    expect(paint.fillPercent).toBe(100); // musicProgress의 clamp01과 같은 지점에서 멈춘다
  });

  it('곡 길이를 아직 모르면(d=0) 진행률 0 — NaN이나 음수로 새지 않는다', () => {
    const paint = musicScrubPaint({ held: false, t: 5, d: 0 })!;
    expect(paint.max).toBe(0);
    expect(paint.fillPercent).toBe(0);
    expect(Number.isFinite(paint.value)).toBe(true);
  });
});

/**
 * U104 재리뷰 Major — `keydown`이 홀드만 잡고 해제 타이머는 `change`에서만 세웠던 사고.
 * 네이티브 range는 **값이 안 바뀌면**(핸들이 이미 끝에 있는데 같은 방향키를 더 누르는 경우)
 * `input`/`change`를 아예 쏘지 않는다 — 곡을 끝까지 듣고 `End`를 한 번 더 누르면 홀드만
 * 잡히고 영영 안 풀려, U104 원래 증상(핸들·fill·시간 텍스트가 전부 멈춤)이 그대로 재현됐다.
 *
 * `Ctx` 전체를 흉내 내지 않고 `holdRender` 하나만 받는 가짜로 검증한다 — 실제
 * `render-hold.ts`(`grabRender`/`releaseRender`, U104 리뷰 m2/m4에서 이미 실동작 검증됨)로
 * 상태를 굴려서, "잡혔다"·"풀렸다"를 `isHeld`로 실제로 확인한다(문자열 스캔이 아니다).
 */
describe('키보드 시크 홀드 해제 (U104 재리뷰 Major)', () => {
  let hold: RenderHold;
  /** `Ctx.holdRender`를 흉내 낸다 — 실제 상태 머신(render-hold.ts)을 그대로 굴린다. */
  const fakeHoldRender = (owner: RenderHoldOwner, on: boolean): void => {
    hold = on ? grabRender(hold, owner) : releaseRender(hold, owner).hold;
  };

  beforeEach(() => {
    hold = IDLE_RENDER_HOLD;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('시크 키가 아니면 아무 일도 하지 않는다', () => {
    handleMusicScrubKeydown(fakeHoldRender, 'a');
    expect(isHeld(hold, 'music-scrub')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(isHeld(hold, 'music-scrub')).toBe(false);
  });

  it('시크 키를 누르면 즉시 잡힌다', () => {
    handleMusicScrubKeydown(fakeHoldRender, 'End');
    expect(isHeld(hold, 'music-scrub')).toBe(true);
  });

  /** 재리뷰가 지적한 핵심 시나리오 — 값이 안 바뀌어 change가 안 오는 경우. */
  it('값 변화 없는 keydown(이미 끝에서 더 진행) 뒤에도 400ms 지나면 스스로 놓인다', () => {
    handleMusicScrubKeydown(fakeHoldRender, 'End'); // 이미 끝 — change가 뒤따르지 않는다고 가정
    expect(isHeld(hold, 'music-scrub')).toBe(true);

    vi.advanceTimersByTime(399);
    expect(isHeld(hold, 'music-scrub')).toBe(true); // 아직 400ms가 안 지났다

    vi.advanceTimersByTime(1);
    expect(isHeld(hold, 'music-scrub')).toBe(false); // 400ms째 — change 없이도 스스로 놓인다
  });

  it('키를 연달아 누르면(값이 바뀌는 정상 경로도 포함) 마지막 keydown 400ms 뒤에만 놓인다', () => {
    handleMusicScrubKeydown(fakeHoldRender, 'ArrowRight');
    vi.advanceTimersByTime(200);
    expect(isHeld(hold, 'music-scrub')).toBe(true);

    handleMusicScrubKeydown(fakeHoldRender, 'ArrowRight'); // 타이머가 다시 선다
    vi.advanceTimersByTime(200);
    // 첫 keydown으로부터는 400ms가 지났지만, 두 번째 keydown으로부터는 200ms뿐이라 아직 잡혀 있다
    expect(isHeld(hold, 'music-scrub')).toBe(true);

    vi.advanceTimersByTime(200); // 두 번째 keydown으로부터 400ms
    expect(isHeld(hold, 'music-scrub')).toBe(false);
  });
});
