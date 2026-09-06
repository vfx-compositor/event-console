// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { cueWithVideos, type CueItem } from '../cue';
import { SCRIPTED_OUTRO_FILES } from '../scripted-outro';
import { cueRowPlans, foldPlan } from './cuesheet';

const css = readFileSync(new URL('../styles/control.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./cuesheet.ts', import.meta.url), 'utf8');

/** 대본 그대로의 큐 (등록 영상 없음) — 1부 항목이 실제로 연속 구간인지까지 이 위에서 본다. */
const REAL = cueWithVideos([]);
const REAL_P1 = REAL.reduce<number[]>((acc, item, i) => {
  if (item.phase === 'p1') acc.push(i);
  return acc;
}, []);

function item(id: string, phase: CueItem['phase']): CueItem {
  return { id, label: id, hint: id, scene: 'standby', phase };
}

/** pre 2 · p1 3 · break 1 · p2 1 — 인덱스 1,2,3이 접힐 구간이다. */
const SAMPLE: CueItem[] = [
  item('pre-mission', 'pre'),
  item('p1-a', 'p1'),
  item('p1-b', 'p1'),
  item('p1-c', 'p1'),
  item('break', 'break'),
  item('p2-a', 'p2'),
];

describe('foldPlan — 1부 접기 (U59)', () => {
  it('1부가 끝나기 전에는 토글을 내놓지 않는다', () => {
    for (const phase of ['pre', 'p1'] as const) {
      const plan = foldPlan(SAMPLE, { phase, collapsed: true, currentIndex: 0 });
      expect(plan.showToggle).toBe(false);
      expect(plan.effectiveCollapsed).toBe(false);
      expect(plan.hiddenIndexes).toEqual([]);
      expect(plan.summaryAt).toBeNull();
    }
  });

  it('1부를 지난 뒤에는 토글을 내놓는다', () => {
    for (const phase of ['break', 'p2', 'award', 'end'] as const) {
      expect(
        foldPlan(SAMPLE, { phase, collapsed: false, currentIndex: 4 }).showToggle,
      ).toBe(true);
    }
  });

  it('접기 전에는 아무 줄도 숨기지 않는다', () => {
    const plan = foldPlan(SAMPLE, { phase: 'p2', collapsed: false, currentIndex: 5 });
    expect(plan.effectiveCollapsed).toBe(false);
    expect(plan.hiddenIndexes).toEqual([]);
    expect(plan.summaryAt).toBeNull();
  });

  it('접으면 phase가 p1인 항목만 정확히 숨긴다', () => {
    const plan = foldPlan(SAMPLE, { phase: 'break', collapsed: true, currentIndex: 4 });
    expect(plan.effectiveCollapsed).toBe(true);
    expect(plan.hiddenIndexes).toEqual([1, 2, 3]);
    expect(plan.foldedCount).toBe(3);
    // 요약 줄은 접힌 구간의 첫 자리에 끼운다
    expect(plan.summaryAt).toBe(1);
  });

  it('접어도 나머지 항목의 인덱스는 한 칸도 밀리지 않는다', () => {
    const plan = foldPlan(SAMPLE, { phase: 'break', collapsed: true, currentIndex: 4 });
    const hidden = new Set(plan.hiddenIndexes);
    const visible = SAMPLE.map((cue, i) => ({ i, id: cue.id })).filter((row) => !hidden.has(row.i));
    // goCue(ctx, i)·cueActions(item, i)가 쓰는 인덱스가 원본 그대로여야 한다
    expect(visible).toEqual([
      { i: 0, id: 'pre-mission' },
      { i: 4, id: 'break' },
      { i: 5, id: 'p2-a' },
    ]);
  });

  /**
   * 숨은 줄에는 `control.ts`의 `.cue.is-current` scrollIntoView가 걸리지 않아,
   * 현재 큐가 화면에서 사라지는 형태로 조용히 실패한다. 그래서 자동 펼침이 접기 의사를 이긴다.
   */
  it('큐 커서가 접힐 구간 안에 있으면 접기 의사보다 자동 펼침이 이긴다', () => {
    for (const currentIndex of [1, 2, 3]) {
      const plan = foldPlan(SAMPLE, { phase: 'break', collapsed: true, currentIndex });
      expect(plan.showToggle).toBe(true);
      expect(plan.effectiveCollapsed).toBe(false);
      expect(plan.hiddenIndexes).toEqual([]);
      expect(plan.summaryAt).toBeNull();
    }
  });

  it('접을 1부 항목이 하나도 없으면 토글도 없다', () => {
    const plan = foldPlan([item('break', 'break')], {
      phase: 'p2',
      collapsed: true,
      currentIndex: 0,
    });
    expect(plan.showToggle).toBe(false);
    expect(plan.foldedCount).toBe(0);
  });

  it('대본 그대로의 큐에서도 1부 구간만 접는다', () => {
    expect(REAL_P1.length).toBeGreaterThan(0);
    const plan = foldPlan(REAL, {
      phase: 'break',
      collapsed: true,
      currentIndex: REAL.findIndex((cue) => cue.phase === 'break'),
    });
    expect(plan.hiddenIndexes).toEqual(REAL_P1);
    expect(plan.summaryAt).toBe(REAL_P1[0]);
    for (const i of plan.hiddenIndexes) expect(REAL[i].phase).toBe('p1');
  });
});

describe('큐시트 접기 렌더 계약 (U59)', () => {
  /**
   * 배열을 거르면 `goCue(ctx, i)`와 `cueActions(item, i, …)`가 저장하는 인덱스가 어긋나
   * 큐 커서가 통째로 깨진다. 접기는 표시 레이어에서만 일어나야 한다.
   */
  it('items 배열을 걸러 내지 않고 숨기기만 한다', () => {
    expect(source).toContain('items.map((item, i)');
    expect(source).not.toMatch(/items\s*\.\s*filter\(/);
    expect(source).toContain("attrs: folded ? { hidden: 'hidden' } : undefined");
    // 접히는 조건은 phase 하나뿐이다 — 특정 큐 id에 못을 박으면 대본이 바뀔 때 조용히 어긋난다
    expect(source).toContain("item.phase === 'p1'");
  });

  it('접힌 줄은 경계 전환 선택까지 통째로 내려간다', () => {
    // cueBoundary는 `<li>` 안에 있으므로 `<li>`가 hidden이면 함께 사라진다
    const li = source.slice(source.indexOf('const row = el('), source.indexOf('return i === plan.summaryAt'));
    expect(li).toContain('cueBoundary(ctx, item');
    expect(li).toContain("hidden: 'hidden'");
  });

  it('토글은 라벨·aria-expanded·툴팁을 갖춘다', () => {
    expect(source).toContain('1부 접기');
    expect(source).toContain('1부 펼치기');
    expect(source).toContain("'aria-expanded'");
    expect(source).toContain('cuesheet-fold-toggle');
    expect(source).toContain('cuesheet-fold-summary');
  });

  it('접기 상태는 상태 원장이 아니라 모듈 로컬 표시 값이다', () => {
    expect(source).toContain('let p1Collapsed = false;');
    expect(source).not.toMatch(/dispatch\(\{\s*type:\s*'settings\/set'[^}]*p1Collapsed/);
  });

  it('새 클래스마다 CSS 규칙이 있다', () => {
    expect(css).toMatch(/\.cuesheet__fold-toggle\s*\{/);
    expect(css).toMatch(/\.cuesheet__fold-toggle\.is-on\s*\{/);
    expect(css).toMatch(/\.cuesheet__fold-toggle\.is-pending\s*\{/);
    expect(css).toMatch(/\.cuesheet__fold-btn\s*\{/);
    expect(css).toMatch(/\.cuesheet__fold-mark\s*\{/);
    expect(css).toMatch(/\.cuesheet__fold-label\s*\{/);
    expect(css).toMatch(/\.cue--fold\s*\{/);
    // 목록이 flex라 UA의 [hidden] 기본값만 믿으면 접힌 줄이 자리를 남길 수 있다
    expect(css).toMatch(/\.cue--folded\[hidden\]\s*\{[^}]*display:\s*none/s);
  });

  it('접기 요약·토글에 양수 자간을 쓰지 않는다', () => {
    const block = css.slice(css.indexOf('.cuesheet__fold-toggle {'), css.indexOf('.tabbar {'));
    expect(block).not.toMatch(/letter-spacing:\s*0?\.\d/);
    expect(block).not.toMatch(/letter-spacing:\s*[1-9]/);
  });
});

/**
 * 이음선(U42)이 항목 사이마다 상시로 들어가 있어 대본이 한눈에 안 들어온다는 지적
 * (2026-09-05). 기본은 목록만 보이고, [트랜지션 수정]을 켠 동안에만 이음선이 나온다.
 */
describe('cueRowPlans — 트랜지션 수정 토글 (U90)', () => {
  const LOCKABLE: CueItem[] = [
    item('a', 'pre'),
    item('b', 'p1'),
    { ...item('c', 'p2'), locked: true },
  ];

  it('기본(꺼짐)에는 어느 줄에도 이음선을 그리지 않는다', () => {
    const rows = cueRowPlans(SAMPLE, {
      editing: false,
      unlocked: true,
      hiddenIndexes: [],
      transitions: {},
    });
    expect(rows).toHaveLength(SAMPLE.length);
    expect(rows.every((row) => row.boundary === false)).toBe(true);
  });

  it('켜면 모든 줄에 이음선이 돌아온다', () => {
    const rows = cueRowPlans(SAMPLE, {
      editing: true,
      unlocked: true,
      hiddenIndexes: [],
      transitions: {},
    });
    expect(rows.every((row) => row.boundary)).toBe(true);
  });

  it('켜져 있어도 접힌 줄에는 이음선을 그리지 않는다', () => {
    const plan = foldPlan(SAMPLE, { phase: 'break', collapsed: true, currentIndex: 4 });
    const rows = cueRowPlans(SAMPLE, {
      editing: true,
      unlocked: true,
      hiddenIndexes: plan.hiddenIndexes,
      transitions: {},
    });
    expect(rows.filter((row) => row.boundary).map((row) => row.index)).toEqual([0, 4, 5]);
    for (const i of plan.hiddenIndexes) {
      expect(rows[i].folded).toBe(true);
      expect(rows[i].boundary).toBe(false);
    }
  });

  it('잠긴 항목에는 켜져 있어도 이음선이 없다', () => {
    const rows = cueRowPlans(LOCKABLE, {
      editing: true,
      unlocked: false,
      hiddenIndexes: [],
      transitions: {},
    });
    expect(rows[2].locked).toBe(true);
    expect(rows[2].boundary).toBe(false);
    // 잠금이 풀리면 보통 줄과 같아진다
    const open = cueRowPlans(LOCKABLE, {
      editing: true,
      unlocked: true,
      hiddenIndexes: [],
      transitions: {},
    });
    expect(open[2].boundary).toBe(true);
  });

  it('인덱스는 원본 배열 그대로다 — 걸러 내지 않는다', () => {
    const plan = foldPlan(SAMPLE, { phase: 'break', collapsed: true, currentIndex: 4 });
    const rows = cueRowPlans(SAMPLE, {
      editing: false,
      unlocked: true,
      hiddenIndexes: plan.hiddenIndexes,
      transitions: {},
    });
    expect(rows.map((row) => row.index)).toEqual(SAMPLE.map((_, i) => i));
    expect(rows.map((row) => row.cueId)).toEqual(SAMPLE.map((cue) => cue.id));
  });

  it('꺼져 있을 때만, 전역과 다른 전환이 걸린 줄에 점을 찍는다', () => {
    const transitions = { 'p1-b': 'stinger' } as const;
    const off = cueRowPlans(SAMPLE, {
      editing: false,
      unlocked: true,
      hiddenIndexes: [],
      transitions,
    });
    expect(off[2].dot).toBe('stinger');
    expect(off.filter((row) => row.dot).map((row) => row.index)).toEqual([2]);
    // 이음선이 보이는 동안에는 켜진 아이콘이 같은 것을 말한다 — 점은 찍지 않는다
    const on = cueRowPlans(SAMPLE, {
      editing: true,
      unlocked: true,
      hiddenIndexes: [],
      transitions,
    });
    expect(on.every((row) => row.dot === null)).toBe(true);
  });

  it('접히거나 잠긴 줄에는 점도 찍지 않는다', () => {
    const rows = cueRowPlans(SAMPLE, {
      editing: false,
      unlocked: true,
      hiddenIndexes: [1, 2, 3],
      transitions: { 'p1-b': 'stinger', 'p2-a': 'black' },
    });
    expect(rows[2].dot).toBeNull();
    expect(rows[5].dot).toBe('black');
    const locked = cueRowPlans(LOCKABLE, {
      editing: false,
      unlocked: false,
      hiddenIndexes: [],
      transitions: { c: 'white' },
    });
    expect(locked[2].dot).toBeNull();
  });

  it('대본 그대로의 큐에서도 기본은 이음선 0개다', () => {
    const rows = cueRowPlans(REAL, {
      editing: false,
      unlocked: true,
      hiddenIndexes: [],
      transitions: {},
    });
    expect(rows.filter((row) => row.boundary)).toHaveLength(0);
    expect(cueRowPlans(REAL, {
      editing: true,
      unlocked: true,
      hiddenIndexes: [],
      transitions: {},
    }).filter((row) => row.boundary).length).toBe(REAL.length);
  });

  /**
   * 대본이 전환까지 못 박은 경계(U87)는 운영자가 지정한 것이 아니다 — 점의 형태로 구분한다.
   * 이 큐는 영상 에셋이 등록돼야 생기므로(`cueWithVideos`) 여기서는 큐 id를 그대로 세운다.
   */
  it('대본 고정 경계는 지정이 없어도 점이 찍히고 dotLocked로 구분된다', () => {
    const scriptedId = `video:media:${[...SCRIPTED_OUTRO_FILES][0]}`;
    const items: CueItem[] = [item('a', 'pre'), { ...item(scriptedId, 'p1') }];
    const rows = cueRowPlans(items, {
      editing: false,
      unlocked: true,
      hiddenIndexes: [],
      transitions: {},
    });
    expect(rows[0].dotLocked).toBe(false);
    expect(rows[0].dot).toBeNull();
    expect(rows[1].dotLocked).toBe(true);
    // 지정을 하나도 안 했는데도 전역과 다른 방식이 걸린 자리다 — 그 사실이 목록에 남아야 한다
    expect(rows[1].dot).toBe('white');
  });
});

describe('트랜지션 수정 렌더 계약 (U90)', () => {
  it('이음선은 rp.boundary가 참일 때만 그린다', () => {
    expect(source).toContain('rp.boundary ? cueBoundary(ctx, item');
    expect(source).toContain('function cueRowPlans(');
    expect(source).toContain('editing: transitionEdit');
  });

  it('토글은 aria-pressed·문구·툴팁을 갖춘다', () => {
    expect(source).toContain("'aria-pressed': on ? 'true' : 'false'");
    expect(source).toContain('트랜지션 수정');
    expect(source).toContain('큐 사이 전환 방식을 고칩니다 — 켜면 이음선이 보입니다');
    expect(source).toContain('cuesheet-transition-edit');
  });

  it('토글 상태는 상태 원장이 아니라 모듈 로컬 표시 값이다', () => {
    expect(source).toContain('let transitionEdit = false;');
    expect(source).not.toMatch(/dispatch\(\{\s*type:\s*'settings\/set'[^}]*transitionEdit/);
  });

  it('점은 큐 버튼 밖에 둔다 — 눌러도 큐가 실행되면 안 된다', () => {
    const btn = source.slice(source.indexOf("class: 'cue__btn'"), source.indexOf('transitionDot(rp)'));
    expect(btn).not.toContain('cue__tdot');
    expect(source).toContain('transitionDot(rp)');
  });

  it('새 클래스마다 CSS 규칙이 있다', () => {
    expect(css).toMatch(/\.cuesheet__edit-toggle\s*\{/);
    expect(css).toMatch(/\.cuesheet__edit-toggle\.is-on\s*\{/);
    expect(css).toMatch(/\.cue__tdot\s*\{/);
    expect(css).toMatch(/\.cue__tdot\.is-locked\s*\{/);
    expect(css).toMatch(/\.cue\.has-tdot\s+\.cue__btn\s*\{/);
    // 점이 버튼 밖에 절대 배치되므로 줄 자체가 기준 상자여야 한다
    expect(css).toMatch(/\.cue\s*\{[^}]*position:\s*relative/s);
  });

  it('토글·점에 양수 자간을 쓰지 않는다', () => {
    const block = css.slice(
      css.indexOf('.cuesheet__edit-toggle {'),
      css.indexOf('.cue-boundary {'),
    );
    expect(block).not.toMatch(/letter-spacing:\s*0?\.\d/);
    expect(block).not.toMatch(/letter-spacing:\s*[1-9]/);
  });
});
