/**
 * 씬 전환 — 엠블럼 스윕.
 *
 * 골드 라이트 스트릭이 먼저 지나가고, 대각 패널이 화면을 덮는 순간(=onCover) 씬을 갈아끼운 뒤,
 * 엠블럼이 화면을 훑고 지나가며 패널이 걷혀 새 씬이 드러난다.
 *
 * 구현 규칙:
 *  - 라이브러리 없이 Web Animations API + transform/opacity 만 (레이아웃 속성 애니메이션 금지 → 60fps).
 *  - 오버레이는 `#stage` 밖(#viewport 자식)에 둔다. 씬 렌더가 stage.innerHTML을 통째로 갈아치우기 때문.
 *  - `prefers-reduced-motion`이면 이 모듈을 아예 쓰지 않고 호출부가 크로스페이드로 강등한다.
 */

import { emblemHTML } from '../emblem';

export type FxMode = 'gold' | 'red';

/** 전체 길이(ms) — 0.9~1.1s 구간 */
export const FX_DURATION = 1000;
const DUR = FX_DURATION;
/** 패널이 화면을 완전히 덮는 시점(ms). 이 순간에 씬을 교체한다. */
const COVER_AT = 450;

const EASE_IN = 'cubic-bezier(0.7, 0, 0.84, 0)';
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';

const SPARK_COUNT = 9;
/** 엠블럼이 지나가는 대각선 (화면 밖 → 화면 밖) */
const PATH = { x0: -1360, y0: 780, x1: 1360, y1: -780 };

export class SceneFx {
  readonly root: HTMLElement;
  private panel: HTMLElement;
  private streak: HTMLElement;
  private emblem: HTMLElement;
  private sparks: HTMLElement[] = [];
  private glitch: HTMLElement;
  private running: Animation[] = [];
  private coverTimer = 0;
  private endTimer = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'fx';
    this.root.dataset.mode = 'gold';

    this.streak = div('fx__streak');
    this.panel = div('fx__panel');
    this.glitch = div('fx__glitch');
    this.emblem = div('fx__emblem');
    this.emblem.innerHTML = emblemHTML();

    for (let i = 0; i < SPARK_COUNT; i += 1) this.sparks.push(div('fx__spark'));

    this.root.append(this.streak, this.panel, this.glitch, ...this.sparks, this.emblem);
  }

  /**
   * 전환 재생. `onCover`는 화면이 완전히 가려진 순간 한 번 호출된다(씬 교체 타이밍).
   * 전환 중 다시 호출되면 진행 중인 애니메이션을 버리고 새로 시작한다 —
   * 단축키를 연타해도 마지막 요청 씬으로 수렴한다.
   */
  play(mode: FxMode, onCover: () => void): void {
    this.cancel();
    this.root.dataset.mode = mode;
    this.root.classList.add('is-on');

    const A = (el: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions): void => {
      this.running.push(el.animate(frames, { fill: 'both', ...opts }));
    };

    // 1) 라이트 스트릭 — 패널보다 한 발 앞서 지나간다
    A(
      this.streak,
      [
        { transform: 'translateX(-170%) skewX(-15deg)', opacity: 0, offset: 0 },
        { transform: 'translateX(-40%) skewX(-15deg)', opacity: 1, offset: 0.28 },
        { transform: 'translateX(90%) skewX(-15deg)', opacity: 0.9, offset: 0.52 },
        { transform: 'translateX(200%) skewX(-15deg)', opacity: 0, offset: 0.72 },
      ],
      { duration: DUR, easing: 'linear' },
    );

    // 2) 대각 패널 — 덮고(EASE_IN) 잠깐 머물렀다가 걷힌다(EASE_OUT)
    A(
      this.panel,
      [
        { transform: 'translateX(-200%) skewX(-15deg)', offset: 0, easing: EASE_IN },
        { transform: 'translateX(-30%) skewX(-15deg)', offset: 0.44, easing: 'linear' },
        { transform: 'translateX(-30%) skewX(-15deg)', offset: 0.54, easing: EASE_OUT },
        { transform: 'translateX(130%) skewX(-15deg)', offset: 1 },
      ],
      { duration: DUR },
    );

    // 3) 엠블럼 — 화면을 대각으로 훑고 지나간다
    A(
      this.emblem,
      [
        { transform: `translate(${PATH.x0}px, ${PATH.y0}px) rotate(-16deg) scale(0.62)`, opacity: 0, offset: 0 },
        { transform: 'translate(-330px, 190px) rotate(-7deg) scale(0.94)', opacity: 1, offset: 0.34 },
        { transform: 'translate(0px, 0px) rotate(0deg) scale(1.06)', opacity: 1, offset: 0.52 },
        { transform: 'translate(360px, -206px) rotate(7deg) scale(0.94)', opacity: 1, offset: 0.7 },
        { transform: `translate(${PATH.x1}px, ${PATH.y1}px) rotate(16deg) scale(0.62)`, opacity: 0, offset: 1 },
      ],
      { duration: DUR, easing: 'cubic-bezier(0.45, 0, 0.35, 1)' },
    );

    // 4) 잔광 파티클 — 엠블럼 뒤를 따라 흩어진다
    this.sparks.forEach((s, i) => {
      const t = i / SPARK_COUNT;
      const jitter = (i % 2 ? 1 : -1) * (30 + ((i * 47) % 90));
      const sx = PATH.x0 * (1 - t) * 0.5 + jitter;
      const sy = PATH.y0 * (1 - t) * 0.5 - jitter * 0.6;
      A(
        s,
        [
          { transform: `translate(${sx}px, ${sy}px) scale(1)`, opacity: 0, offset: 0 },
          { transform: `translate(${sx + 90}px, ${sy - 60}px) scale(1)`, opacity: 0.95, offset: 0.25 },
          { transform: `translate(${sx + 300}px, ${sy - 210}px) scale(0.25)`, opacity: 0, offset: 1 },
        ],
        { duration: 620, delay: 120 + i * 34, easing: EASE_OUT },
      );
    });

    // 5) 2부 진입 — 스캔라인 글리치 한 겹
    if (mode === 'red') {
      A(
        this.glitch,
        [
          { opacity: 0, offset: 0 },
          { opacity: 0.85, offset: 0.3 },
          { opacity: 0.3, offset: 0.6 },
          { opacity: 0, offset: 1 },
        ],
        { duration: DUR, easing: 'steps(6)' },
      );
    }

    this.coverTimer = window.setTimeout(onCover, COVER_AT);
    this.endTimer = window.setTimeout(() => this.finish(), DUR + 40);
  }

  /** 진행 중인 전환을 즉시 정리 (연타·강제 종료) */
  cancel(): void {
    window.clearTimeout(this.coverTimer);
    window.clearTimeout(this.endTimer);
    for (const a of this.running) a.cancel();
    this.running = [];
  }

  private finish(): void {
    this.cancel();
    this.root.classList.remove('is-on');
  }
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
