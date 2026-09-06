// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createInitialState, reducer } from './state';
import { formatMMSS, remainingSec } from './timer';

const T0 = 1_700_000_000_000;

describe('타이머 잔여 계산', () => {
  it('정지 상태에서는 프리셋 시간 그대로', () => {
    const s = createInitialState();
    expect(remainingSec(s.timer, T0)).toBe(60);
  });

  it('구동 중에는 경과분만큼 줄고 0 아래로 내려가지 않는다', () => {
    const s = reducer(createInitialState(), { type: 'timer/start', now: T0 });
    expect(remainingSec(s.timer, T0 + 10_000)).toBeCloseTo(50, 6);
    expect(remainingSec(s.timer, T0 + 59_900)).toBeCloseTo(0.1, 6);
    expect(remainingSec(s.timer, T0 + 90_000)).toBe(0);
  });

  it('일시정지 → 재시작 시 남은 시간이 이어진다 (경과가 누적되지 않는다)', () => {
    let s = reducer(createInitialState(), { type: 'timer/start', now: T0 });
    s = reducer(s, { type: 'timer/pause', now: T0 + 20_000 });
    expect(remainingSec(s.timer, T0 + 20_000)).toBeCloseTo(40, 6);
    // 정지한 채 1분이 흘러도 잔여는 그대로
    expect(remainingSec(s.timer, T0 + 80_000)).toBeCloseTo(40, 6);

    s = reducer(s, { type: 'timer/start', now: T0 + 80_000 });
    expect(remainingSec(s.timer, T0 + 85_000)).toBeCloseTo(35, 6);
  });

  it('리셋하면 프리셋 시간으로 돌아온다', () => {
    let s = reducer(createInitialState(), { type: 'timer/start', now: T0 });
    s = reducer(s, { type: 'timer/pause', now: T0 + 30_000 });
    s = reducer(s, { type: 'timer/reset' });
    expect(remainingSec(s.timer, T0 + 40_000)).toBe(60);
  });

  it('mm:ss 표기는 올림(ceil) — 59.4초는 01:00이 아니라 01:00 직전 값이 아닌 00:60이 되지 않는다', () => {
    expect(formatMMSS(60)).toBe('01:00');
    expect(formatMMSS(59.4)).toBe('01:00');
    expect(formatMMSS(59)).toBe('00:59');
    expect(formatMMSS(0)).toBe('00:00');
    expect(formatMMSS(8 * 60)).toBe('08:00');
  });
});

/**
 * U56 — 타이머 비프를 **통째로 없앴다** (사용자: "설정에 토글도 두지 마. 구려서 그런 거니까
 * 그냥 제거해"). 끌 수 있게만 두면 켜진 저장본·다른 창에서 다시 울리고, 쓰지 않는 경로를 위해
 * `AudioContext`와 오실레이터 그래프가 출력 창에 남는다.
 *
 * 없앤 것은 **소리뿐**이다 — 임계 시각의 화면 표시는 그대로 나가야 한다.
 */
describe('타이머 비프 제거 (U56)', () => {
  /**
   * 주석을 걷어낸 소스로 본다. 계약은 **실행되는 코드**에 대한 것이고, 왜 없앴는지를 적어 둔
   * 설명이 그 계약을 깨뜨리면 안 된다(같은 실수를 U49 계약 테스트에서 이미 한 번 했다).
   */
  const read = (name: string): string =>
    readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('timer.ts에 비프·WebAudio 코드가 남아 있지 않다', () => {
    const timer = read('timer.ts');
    expect(timer).not.toMatch(/\bexport function beep\b/);
    expect(timer).not.toMatch(/\bcreateBeeper\b/);
    expect(timer).not.toMatch(/AudioContext|createOscillator/);
  });

  it('출력 창이 비프를 부르지 않는다', () => {
    const display = read('display.ts');
    expect(display).not.toMatch(/\bbeep/i);
    expect(display).not.toContain('createBeeper');
  });

  it('설정 탭에 토글이 없다 — 끌 수 있게가 아니라 아예 없앤 것이다', () => {
    const settings = read('control/tab-settings.ts');
    expect(settings).not.toContain('timerBeep');
    expect(settings).not.toContain('비프');
  });

  it('설정 스키마에도 남기지 않는다 — 죽은 키가 저장본마다 쌓이면 안 된다', () => {
    expect(read('types.ts')).not.toContain('timerBeep');
    expect(read('state.ts')).not.toContain('timerBeep');
    expect(Object.keys(createInitialState().settings)).not.toContain('timerBeep');
  });

  /** 없앤 것은 소리뿐 — 10초 이하·종료 표시는 계속 나간다 */
  it('임계 시각 화면 표시는 그대로다', () => {
    const display = read('display.ts');
    expect(display).toContain("classList.toggle('is-danger'");
    expect(display).toContain("classList.toggle('is-done'");
  });
});
