/**
 * 타이머 — 잔여 시간은 저장하지 않고 startedAt 기준으로 매번 계산한다.
 * (탭이 백그라운드로 밀리거나 새로고침돼도 오차가 누적되지 않는다. AC-4 ±0.1s)
 */

import type { TimerPreset, TimerState } from './types';

export interface PresetDef {
  key: TimerPreset;
  label: string;
  sec: number;
}

export const TIMER_PRESETS: PresetDef[] = [
  { key: 'sticky60', label: '끈끈이 60초', sec: 60 },
  { key: 'sync15', label: '몸으로 말해요 15초', sec: 15 },
  { key: 'stage8', label: '단계 8분', sec: 8 * 60 },
  { key: 'stage10', label: '단계 10분', sec: 10 * 60 },
  { key: 'stage12', label: '단계 12분', sec: 12 * 60 },
];

export function remainingSec(timer: TimerState, now: number): number {
  const base = timer.pausedRemaining ?? timer.durationSec;
  if (timer.startedAt === null) return Math.max(0, base);
  return Math.max(0, base - (now - timer.startedAt) / 1000);
}

export function isRunning(timer: TimerState): boolean {
  return timer.startedAt !== null;
}

export function isFinished(timer: TimerState, now: number): boolean {
  return remainingSec(timer, now) <= 0;
}

export function formatMMSS(sec: number): string {
  const total = Math.max(0, Math.ceil(sec - 1e-6));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 소수 첫째자리까지 — 마지막 10초 카운트다운 표시용 */
export function formatTenths(sec: number): string {
  const v = Math.max(0, sec);
  return v.toFixed(1);
}

/*
 * 타이머 비프(WebAudio 초읽기·종료음)는 **제거했다** (U56 — 사용자: "타이머 띵똥거리는 소리
 * 없애줘. 구려서 그런 거니까 그냥 제거해").
 *
 * 설정 토글도 두지 않는다. 끌 수 있게만 해 두면 켜진 저장본·다른 창에서 다시 울리고, 쓰지 않는
 * 경로를 위해 `AudioContext`와 오실레이터 그래프가 출력 창에 남는다(자동재생 정책 판정에도 걸린다).
 * 남은 것이 없어야 다음 사람이 "이건 왜 있지"를 묻지 않는다.
 *
 * **임계 시각의 화면 표시는 그대로다** — `display.ts`가 `is-danger`(10초 이하)·`is-done`(종료)
 * 클래스를 계속 토글한다. 없앤 것은 소리뿐이다.
 */
