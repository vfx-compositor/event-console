/**
 * U97 — 2부 단계 대기화면 (이미지 한 장 + 램프 플리커 + 필름 그레인).
 *
 * 사용자 원문(02:51): "2부 게임 대기화면 만들어왔어. 적용시켜. 근데 그냥 떠 있으면 재미없으니까.
 * 약한 플리커를 넣어줘. 그레인도 넣으면 좋고."
 */

// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createInitialState, migrate, reducer, type Action } from '../state';
import { sceneView } from './index';
import { P2_STEADY_IMAGES, p2FlickerOpacity } from './submit';
import { toHTML } from '../vdom';
import type { AppState, P2StageId } from '../types';

const CSS = readFileSync(new URL('../styles/display.css', import.meta.url), 'utf8');
const STAGES: P2StageId[] = ['s1', 's2', 's3'];

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

/** 잠금이 풀린 상태에서 그 단계의 대기화면을 띄운다 */
function steadyState(stageId: P2StageId, mode: 'steady' | 'board' = 'steady'): AppState {
  return run(
    createInitialState(),
    { type: 'p2/unlock' },
    { type: 'scene/set', scene: 'submit', opts: { submit: { stageId, mode } } },
  );
}

describe('2부 단계 대기화면 — 화면 (U97)', () => {
  it.each([
    ['s1', './media/p2_steady_stage1.svg', '1단계'],
    ['s2', './media/p2_steady_stage2.svg', '2단계'],
    ['s3', './media/p2_steady_stage3.svg', '3단계'],
  ] as const)('%s 대기화면은 그 단계의 이미지 한 장을 띄운다', (stageId, src, stageName) => {
    const html = toHTML(sceneView(steadyState(stageId)));
    expect(html).toContain('scene--p2-steady');
    expect(html).toContain('scene--standby-image-only');
    expect(html).toContain(`src="${src}"`);
    expect(html).toContain(`data-stage="${stageId}"`);
    // 폴백 카드는 이미지 뒤에 **항상** 깔려 있다 — 파일이 없어도 검정이 나가지 않는다.
    // 그림이 뜨면 한 픽셀도 보이지 않는다(아래 "이미지만 보인다" 블록이 층 관계를 검사한다).
    expect(html).toContain('p2-steady__fallback');
    expect(html).toContain(stageName);
    // 제출 보드의 요소가 섞이면 안 된다 (같은 씬의 다른 화면)
    expect(html).not.toContain('sub__bars');
    expect(html).not.toContain('scene--submit');
  });

  /**
   * U98 ① — 사용자 지시(03:18): "아니 타이틀 왜 박았어. 저기선 이미지만 뜨면 돼."
   *
   * 폴백 카드는 DOM에 남지만 **보이면 안 된다.** 마크업만으로는 잡히지 않는 결함이라
   * (사고 당시 마크업은 지금과 똑같았다) 층 관계와 덮는 기하를 직접 검사한다.
   */
  it('그림이 뜨면 타이포 카드는 한 픽셀도 보이지 않는다 (이미지만)', () => {
    const image = CSS.match(/\.p2-steady__image\s*\{([^}]*)\}/)?.[1] ?? '';
    const fallback = CSS.match(/\.p2-steady__fallback\s*\{([^}]*)\}/)?.[1] ?? '';
    const z = (block: string) => Number.parseFloat(/z-index:\s*(-?[\d.]+)/.exec(block)?.[1] ?? 'NaN');

    // 층: 이미지가 카드 **위**다. z가 둘 다 auto/0이면 트리 순서상 뒤에 오는 카드가 이긴다.
    expect(z(image)).toBeGreaterThan(z(fallback));
    // 기하: 프레임을 가득 채우는 불투명 cover라야 아래 카드가 실제로 가려진다
    expect(image).toMatch(/inset:\s*0/);
    expect(image).toMatch(/object-fit:\s*cover/);
    expect(image).toMatch(/width:\s*100%/);
    expect(image).toMatch(/height:\s*100%/);
    // 카드에는 반투명·블렌드가 없다 (있으면 위 층이어도 비친다)
    expect(image).not.toMatch(/opacity\s*:/);
    expect(image).not.toMatch(/mix-blend-mode\s*:/);
  });

  it('선서 화면도 같은 층 계약이다 (U60에서 물려받은 같은 결함 · U98에서 함께 고침)', () => {
    const oathImage = CSS.match(/\.oath-image\s*\{([^}]*)\}/)?.[1] ?? '';
    const oathFallback = CSS.match(/\.oath-fallback\s*\{([^}]*)\}/)?.[1] ?? '';
    const z = (block: string) => Number.parseFloat(/z-index:\s*(-?[\d.]+)/.exec(block)?.[1] ?? 'NaN');
    expect(z(oathImage)).toBeGreaterThan(z(oathFallback));
  });

  it('대기화면에는 제출 보드의 타이틀 골격이 아예 없다', () => {
    const html = toHTML(sceneView(steadyState('s1')));
    for (const cls of ['sub__head', 'sub__eyebrow', 'sub__title', 'sub__bars', 'sub__bar']) {
      expect(html).not.toContain(cls);
    }
    expect(html).not.toContain('진행 중');
  });

  it('단계마다 서로 다른 이미지를 쓴다 (매핑 뒤섞임 방지)', () => {
    const srcs = STAGES.map((id) => P2_STEADY_IMAGES[id]);
    expect(new Set(srcs).size).toBe(STAGES.length);
  });

  it('이미지 로드 실패는 폴백 카드로 떨어진다 (검정 금지)', () => {
    const html = toHTML(sceneView(steadyState('s2')));
    // `toHTML`이 속성값의 작은따옴표를 엔티티로 바꾼다 — 실제로 나가는 마크업 그대로 본다
    expect(html).toContain(
      'onerror="this.closest(&#39;.p2-steady&#39;).classList.add(&#39;is-missing&#39;)"',
    );
    // CSS가 그 상태에서 이미지를 감춰야 폴백이 실제로 드러난다
    expect(CSS).toContain('.p2-steady.is-missing .p2-steady__image');
  });

  it('board 모드는 지금까지의 제출 상태 바 그대로다 (기본값)', () => {
    expect(createInitialState().sceneOpts.submit.mode).toBe('board');
    const html = toHTML(sceneView(steadyState('s1', 'board')));
    expect(html).toContain('scene--submit');
    expect(html).toContain('sub__bars');
    expect(html).not.toContain('scene--p2-steady');
  });

  it('알 수 없는 모드가 저장돼 있으면 board로 되돌린다 (빈 씬 방지)', () => {
    const saved = steadyState('s3');
    (saved.sceneOpts.submit as { mode: string }).mode = 'lamp';
    expect(migrate(JSON.parse(JSON.stringify(saved))).sceneOpts.submit.mode).toBe('board');
    // 단계 id는 건드리지 않는다
    expect(migrate(JSON.parse(JSON.stringify(saved))).sceneOpts.submit.stageId).toBe('s3');
  });

  it('구 저장본(모드 필드 자체가 없음)도 board로 온다', () => {
    const saved = JSON.parse(JSON.stringify(createInitialState())) as AppState;
    delete (saved.sceneOpts.submit as Partial<AppState['sceneOpts']['submit']>).mode;
    expect(migrate(saved).sceneOpts.submit.mode).toBe('board');
  });
});

/**
 * 램프 플리커의 계약. 값 자체가 아니라 **분포**를 본다 —
 * 사인 계수를 손보다가 화면이 어두워지거나 스트로브가 되는 것을 여기서 잡는다.
 */
describe('램프 플리커 함수 (U97)', () => {
  const T0 = 1.78e9; // 실제로 들어오는 값과 같은 크기(epoch 초)에서 검사한다
  const HZ = 240;
  const SECONDS = 60;
  const samples: number[] = [];
  for (let i = 0; i < HZ * SECONDS; i += 1) samples.push(p2FlickerOpacity(T0 + i / HZ));

  it('값은 항상 0.85~1이다 (송출 끊김으로 읽히는 어둠 금지)', () => {
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0.85);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    // 하한에 딱 붙어만 있으면 플리커가 아니라 고정 디밍이다
    expect(Math.max(...samples)).toBeGreaterThan(0.99);
    expect(Math.min(...samples)).toBeLessThan(0.9);
  });

  it('평균은 0.97 언저리다 (전체가 어두워지면 플리커가 아니라 디밍)', () => {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(0.955);
    expect(mean).toBeLessThan(0.99);
  });

  it('대부분의 시간은 0.96 위에서 조용하다', () => {
    const calm = samples.filter((v) => v >= 0.96).length / samples.length;
    expect(calm).toBeGreaterThan(0.85);
  });

  it('한 번의 하강은 120ms 이하이고 초당 3회를 넘지 않는다 (광과민성 안전)', () => {
    const dips: { at: number; dur: number }[] = [];
    let inDip = false;
    let startAt = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const t = i / HZ;
      const below = samples[i] < 0.955;
      if (below && !inDip) {
        inDip = true;
        startAt = t;
      } else if (!below && inDip) {
        inDip = false;
        dips.push({ at: startAt, dur: t - startAt });
      }
    }
    expect(dips.length).toBeGreaterThan(30); // 60초 동안 실제로 깜박이긴 한다
    expect(Math.max(...dips.map((d) => d.dur))).toBeLessThanOrEqual(0.12);
    for (const d of dips) {
      const inWindow = dips.filter((o) => o.at >= d.at && o.at < d.at + 1).length;
      expect(inWindow).toBeLessThanOrEqual(3);
    }
    // 평균 밀도는 초당 3회 상한보다 훨씬 낮아야 "가끔"이다
    expect(dips.length / SECONDS).toBeLessThan(2);
  });

  it('같은 시각이면 항상 같은 값이다 (출력 창이 몇 개든 같이 깜박인다)', () => {
    for (const t of [0, 0.37, 12.5, T0, T0 + 7.13]) {
      expect(p2FlickerOpacity(t)).toBe(p2FlickerOpacity(t));
    }
    // 이상값이 들어와도 화면을 꺼트리지 않는다
    expect(p2FlickerOpacity(Number.NaN)).toBe(1);
    expect(p2FlickerOpacity(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('그레인·플리커 스타일 (U97)', () => {
  it('JS가 붙이는 클래스·훅에 대응 CSS 규칙이 있다', () => {
    for (const name of [
      'scene--p2-steady',
      'p2-steady',
      'p2-steady__image',
      'p2-steady__fallback',
      'p2-steady__fallback-eyebrow',
      'p2-steady__fallback-title',
      'p2-steady__fallback-rule',
      'p2-steady__flicker',
      'p2-steady__grain',
    ]) {
      expect(CSS).toContain(`.${name}`);
    }
    expect(CSS).toContain(".scene--p2-steady[data-grain='p2']");
  });

  it('그레인은 사진 씬과 같은 방식이다 — 프레임당 filter·blur 비용이 0', () => {
    const block = CSS.match(/\.p2-steady__grain\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).not.toBe('');
    // 정지 노이즈 타일 + steps() transform. 사진 그레인과 **같은 keyframe**을 재사용한다.
    expect(block).toContain('feTurbulence');
    expect(block).toMatch(/animation:\s*photo-grain/);
    expect(block).toMatch(/mix-blend-mode:\s*normal/);
    expect(block).not.toMatch(/filter\s*:/);
    expect(block).not.toMatch(/backdrop-filter/);
    expect(CSS).toContain('@keyframes photo-grain');
    // keyframe이 움직이는 것은 transform 하나뿐이어야 한다
    const frames = CSS.match(/@keyframes photo-grain\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(frames).toContain('transform: translate3d');
    expect(frames).not.toMatch(/filter\s*:/);
  });

  it('이 화면의 그레인이 사진 배경 기본값보다 굵다', () => {
    const boosted = CSS.match(/\.scene--p2-steady\[data-grain='p2'\][^{]*\{([^}]*)\}/)?.[1] ?? '';
    const opacity = Number.parseFloat(/opacity:\s*([\d.]+)/.exec(boosted)?.[1] ?? '0');
    expect(opacity).toBeGreaterThan(0.12);
    expect(opacity).toBeLessThan(0.25);
  });

  it('모션 최소화에서는 플리커·그레인이 멈춘다', () => {
    // tick이 인라인 opacity를 매 프레임 쓰므로 !important가 아니면 실제로 멈추지 않는다
    expect(CSS).toMatch(/\.p2-steady__flicker\s*\{\s*opacity:\s*1\s*!important/);
    expect(CSS).toMatch(/\.p2-steady__grain\s*\{\s*animation:\s*none/);
  });
});

describe('2부 대기 이미지 예열 (U97)', () => {
  it('display는 잠금이 풀린 뒤에만 세 장을 미리 받는다', () => {
    const display = readFileSync(new URL('../display.ts', import.meta.url), 'utf8');
    expect(display).toContain("import { P2_STEADY_IMAGES } from './scenes/submit';");
    expect(display).toContain('for (const src of Object.values(P2_STEADY_IMAGES)) {');
    // 부팅 때 조건 없이 받지 않는다 — 1부 내내 네트워크 탭에 후반 에셋이 드러나면 안 된다
    expect(display).toContain('if (vis.p2.unlocked) warmP2SteadyImages();');
  });
});
