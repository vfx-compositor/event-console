/**
 * 행사 엠블럼 — 성화 불꽃 + 골드 링 + "EC" 모노그램.
 *
 * 오륜(五輪)은 IOC 상표라 쓰지 않는다. 링은 **하나**뿐이고 불꽃과 모노그램으로 정체성을 만든다.
 * 색은 전부 `currentColor` — 쓰는 쪽에서 `color`만 바꾸면 골드/레드/모노 버전이 된다.
 * (standby · 씬 전환 스윕 · 시상 리빌 · 조작 패널 헤더가 같은 마크를 공유한다.)
 */

import { h, toHTML, type VNode } from './vdom';

export interface EmblemOpts {
  /** 링/불꽃 두께 톤. 큰 화면은 'display', 작은 아이콘은 'compact' */
  weight?: 'display' | 'compact';
  /** 추가 클래스 */
  class?: string;
}

/* 불꽃은 윤곽선(외곽) + 채워진 심지(내부) 2단으로 그린다.
   한 색으로 통짜로 채우면 작은 크기에서 '물방울'로 읽힌다 — 실제로 그렇게 보여서 고쳤다. */
/* 좌우 대칭 물방울은 '불꽃'이 아니라 '물'로 읽힌다. 꼭짓점을 한쪽으로 기울이고
   반대쪽에 작은 봉우리와 홈을 넣어야 불꽃으로 읽힌다. */
const FLAME_OUTER =
  'M105 28 C 113 66, 136 78, 136 103 C 136 125, 120 141, 100 141 C 80 141, 64 125, 64 103 C 64 85, 77 74, 83 57 C 88 77, 95 84, 100 90 C 107 77, 109 50, 105 28 Z';
const FLAME_CORE =
  'M101 98 C 108 111, 114 117, 114 125 C 114 133, 108 138, 100 138 C 92 138, 86 133, 86 125 C 86 117, 93 111, 101 98 Z';

/** 씬(vdom)에서 쓰는 엠블럼 */
export function emblem(opts: EmblemOpts = {}): VNode {
  const compact = opts.weight === 'compact';
  const cls = ['emblem', compact ? 'emblem--compact' : 'emblem--display', opts.class]
    .filter(Boolean)
    .join(' ');

  return h(
    'svg',
    {
      class: cls,
      viewBox: '0 0 200 200',
      xmlns: 'http://www.w3.org/2000/svg',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    // 바깥 링 — 이 마크의 유일한 원. 오륜 연상을 피하려 한 겹으로 둔다.
    h('circle', {
      class: 'emblem__ring',
      cx: 100,
      cy: 100,
      r: 92,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': compact ? 7 : 4,
    }),
    h('circle', {
      class: 'emblem__ring emblem__ring--inner',
      cx: 100,
      cy: 100,
      r: 84,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1,
      opacity: 0.34,
    }),
    // 성화 — 윤곽선 + 심지. 아래 모노그램 자리를 비우려 살짝 줄여 올린다.
    h(
      'g',
      { transform: 'translate(14, 2) scale(0.86)' },
      h('path', {
        class: 'emblem__flame',
        d: FLAME_OUTER,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': compact ? 10 : 7,
        'stroke-linejoin': 'round',
      }),
      h('path', { class: 'emblem__core', d: FLAME_CORE, fill: 'currentColor' }),
    ),
    // 구획선 + 모노그램
    h('path', {
      class: 'emblem__rule',
      d: 'M76 137 H124',
      stroke: 'currentColor',
      'stroke-width': 1.5,
      opacity: 0.45,
    }),
    // 모노그램은 <text>가 아니라 패스로 그린다.
    // 이유 두 가지: (1) 폰트가 없는 환경에서도 형태가 같다(P1 오프라인 완결)
    //              (2) transform 애니메이션이 걸린 레이어 안의 SVG <text>가
    //                  Chrome에서 래스터되지 않는 사례를 실제로 겪었다.
    h(
      'g',
      {
        class: 'emblem__mark',
        stroke: 'currentColor',
        'stroke-width': compact ? 8 : 6.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        fill: 'none',
      },
      // E
      h('path', { d: 'M94 150 H76 V182 H94 M76 166 H90' }),
      // C
      h('path', { d: 'M124 155 C120 150, 114 148, 109 151 C101 156, 101 176, 109 181 C114 184, 120 182, 124 177' }),
    ),
  );
}

/*
 * `emblemElement()`는 없앴다 (U46 이후 dead export).
 *
 * 조작 패널 상단 바가 이 불꽃 엠블럼을 실 DOM으로 쓰던 유일한 자리였는데, U46에서 브랜드 계약이
 * 공용 벡터 모노그램(`topbar__mark` <img>)으로 바뀌면서 호출자가 사라졌다. 남겨 두면 다음 사람이
 * "패널 엠블럼은 이걸 쓰는구나" 하고 되살려 두 마크가 섞인다. 출력 화면·전환 오버레이가 쓰는
 * `emblem()`/`emblemHTML()`은 그대로다.
 */

/** 전환 오버레이용 원본 마크업 */
export function emblemHTML(opts: EmblemOpts = {}): string {
  return toHTML(emblem(opts));
}
