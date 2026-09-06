import { el } from './dom';
import { TIMER_PRESETS, formatMMSS, isRunning, remainingSec } from '../timer';
import type { Ctx } from './ctx';

export const meta = { id: 'timer', label: '타이머' };

export function render(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const running = isRunning(s.timer);
  const remaining = remainingSec(s.timer, Date.now());

  return el(
    'div',
    // U67 — 타이머 전용 스코프(U99에서 숫자 크기·라벨만 남기고 보조 텍스트 축소는 되돌림). 다른 탭에 안 새게 가둔다.
    { class: 'tabpane tabpane--timer' },
    el('p', { class: 'tabpane__hint', text: 'Space 로 시작·일시정지. 마지막 10초는 출력 화면이 레드로 펄스합니다(소리는 나지 않습니다).' }),
    el(
      'div',
      { class: 'timerpanel' },
      el(
        'div',
        { class: 'timerpanel__readout' },
        el('div', { class: 'timerpanel__label', id: 'timer-label', text: '남은 시간' }),
        el('div', {
          class: `timerpanel__time${remaining <= 10 && running ? ' is-danger' : ''}`,
          text: formatMMSS(remaining),
          data: { live: 'timer' },
          attrs: { 'aria-labelledby': 'timer-label' },
        }),
        el('div', {
          class: `timerpanel__state ${running ? 'is-run' : 'is-stop'}`,
          text: running ? '● 구동 중' : '■ 정지',
        }),
      ),
      el(
        'div',
        { class: 'timerpanel__controls' },
        el('button', {
          // 일시정지는 파괴적 동작이 아니다 — 붉은색은 초기화·역분개·잠금해제에만 쓴다.
          class: `btn ${running ? '' : 'btn--primary'} btn--big`,
          type: 'button',
          text: running ? '일시정지' : '시작',
          data: { tip: '단축키 Space' },
          on: {
            click: () =>
              ctx.dispatch(
                running ? { type: 'timer/pause', now: Date.now() } : { type: 'timer/start', now: Date.now() },
              ),
          },
        }),
        el('button', {
          class: 'btn btn--big',
          type: 'button',
          text: '↺ 리셋',
          data: { tip: '프리셋 시간으로 되돌립니다' },
          on: { click: () => ctx.dispatch({ type: 'timer/reset' }) },
        }),
      ),
    ),
    el('h3', { class: 'section__title', text: '프리셋' }),
    el(
      'div',
      { class: 'presetgrid' },
      TIMER_PRESETS.map((p) =>
        el('button', {
          class: `preset${s.timer.preset === p.key ? ' is-on' : ''}`,
          type: 'button',
          text: p.label,
          data: { tip: `${p.sec}초로 설정하고 정지 상태로 리셋합니다` },
          on: { click: () => ctx.dispatch({ type: 'timer/preset', preset: p.key, durationSec: p.sec }) },
        }),
      ),
      el(
        'div',
        { class: `preset preset--custom${s.timer.preset === 'custom' ? ' is-on' : ''}` },
        el('label', { class: 'field__label', text: '커스텀(초)', attrs: { for: 'custom-sec' } }),
        el('input', {
          class: 'input input--num',
          id: 'custom-sec',
          type: 'number',
          min: 1,
          max: 7200,
          value: s.timer.preset === 'custom' ? s.timer.durationSec : 90,
          data: { fid: 'timer-custom' },
          on: {
            change: (ev) => {
              const v = Math.max(1, Math.min(7200, Number((ev.target as HTMLInputElement).value) || 60));
              ctx.dispatch({ type: 'timer/preset', preset: 'custom', durationSec: v });
            },
          },
        }),
      ),
    ),
    el('button', {
      class: 'btn btn--ghost',
      type: 'button',
      text: '풀스크린 타이머 씬으로 (F4)',
      on: { click: () => ctx.dispatch({ type: 'scene/set', scene: 'timer' }) },
    }),
  );
}
