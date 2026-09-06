/**
 * U132 — 보너스 스트립.
 *
 * 이 저장소의 vitest는 `environment: 'node'`라 DOM이 없다(package.json에 jsdom도 없다).
 * 그래서 다른 탭 스위트와 같은 관례를 따른다 — **판단이 들어가는 부분은 순수 함수로 빼서
 * 값으로 검증하고**, DOM 배선은 소스 문자열로 잠근다. 클릭 핸들러 자체를 돌릴 수 없으므로
 * `bonusAction`(무엇을 dispatch하는가)과 `lastBonusEntryId`(무엇을 되돌리는가)를 나눠 뒀다.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import {
  BONUS_PRESETS,
  bonusAction,
  bonusRef,
  bonusToastMessage,
  lastBonusEntryId,
} from './bonus-strip';
import type { Ctx } from './ctx';
import type { AppState, LedgerEntry } from '../types';

const source = readFileSync(new URL('./bonus-strip.ts', import.meta.url), 'utf8');
const p1Source = readFileSync(new URL('./tab-p1.ts', import.meta.url), 'utf8');
const p2Source = readFileSync(new URL('./tab-p2.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles/control.css', import.meta.url), 'utf8');

function ctxWith(ledger: LedgerEntry[]): Ctx {
  return { state: { ledger } as unknown as AppState } as unknown as Ctx;
}

const ENTRY: LedgerEntry = {
  id: 'L00007',
  ts: 1,
  teamId: 't1',
  delta: 50,
  reason: '사회자 보너스',
  ref: 'p1:bonus',
};

describe('프리셋과 액션', () => {
  it('프리셋은 사회자가 입으로 부르는 다섯 단위다', () => {
    expect(BONUS_PRESETS).toEqual([10, 20, 30, 50, 100]);
  });

  it('클릭은 누른 탭의 part를 그대로 실어 보낸다', () => {
    expect(bonusAction('t1', 50, { minus: false }, 'p1', 7)).toEqual({
      type: 'ledger/bonus',
      teamId: 't1',
      delta: 50,
      part: 'p1',
      reason: '사회자 보너스',
      now: 7,
    });
    expect(bonusAction('t3', 20, { minus: false }, 'p2', 7)).toMatchObject({
      part: 'p2',
      delta: 20,
    });
  });

  it('Shift+클릭은 같은 프리셋을 음수로 뒤집고 사유도 감점으로 바꾼다', () => {
    expect(bonusAction('t2', 30, { minus: true }, 'p1', 7)).toMatchObject({
      delta: -30,
      reason: '사회자 감점',
    });
  });

  it('ref 규칙은 리듀서와 같은 문자열을 만든다', () => {
    expect(bonusRef('p1')).toBe('p1:bonus');
    expect(bonusRef('p2')).toBe('p2:bonus');
  });

  it('토스트 문구는 부호를 말로 한 번 더 확인시킨다', () => {
    expect(bonusToastMessage('레드', 50)).toBe('레드 +50 보너스');
    expect(bonusToastMessage('블루', -30)).toBe('블루 −30 감점');
  });
});

describe('되돌리기 대상 특정 (lastBonusEntryId)', () => {
  it('방금 쌓인 마지막 줄이 세 필드 모두 맞으면 그 id를 준다', () => {
    const ctx = ctxWith([{ ...ENTRY, id: 'L00001', delta: 10 }, ENTRY]);
    expect(lastBonusEntryId(ctx, { teamId: 't1', delta: 50, ref: 'p1:bonus' })).toBe('L00007');
  });

  it('팀·점수·ref 중 하나라도 어긋나면 null — 엉뚱한 줄을 역분개하지 않는다', () => {
    const ctx = ctxWith([ENTRY]);
    expect(lastBonusEntryId(ctx, { teamId: 't2', delta: 50, ref: 'p1:bonus' })).toBeNull();
    expect(lastBonusEntryId(ctx, { teamId: 't1', delta: 20, ref: 'p1:bonus' })).toBeNull();
    expect(lastBonusEntryId(ctx, { teamId: 't1', delta: 50, ref: 'p2:bonus' })).toBeNull();
  });

  it('원장이 비어 있으면 null', () => {
    expect(lastBonusEntryId(ctxWith([]), { teamId: 't1', delta: 50, ref: 'p1:bonus' })).toBeNull();
  });
});

describe('DOM 배선', () => {
  it('팀마다 한 줄, 프리셋마다 버튼 하나를 그린다', () => {
    expect(source).toContain('ids.map((id)');
    expect(source).toContain('BONUS_PRESETS.map((preset)');
    expect(source).toContain("class: 'bonus-strip__btn'");
    expect(source).toContain('text: `+${preset}`');
  });

  it('확인 모달 없이 즉시 dispatch한다 — 되돌리기는 토스트에 붙는다', () => {
    expect(source).not.toContain('openModal');
    expect(source).toContain('ctx.dispatch(action)');
    expect(source).toContain("label: '되돌리기'");
    expect(source).toContain("type: 'ledger/reverse'");
  });

  it('Shift+클릭이 클릭 핸들러에 배선돼 있고 tip·aria-label에 적혀 있다', () => {
    expect(source).toContain('give(id, preset, ev.shiftKey)');
    expect(source).toMatch(/tip: `[^`]*Shift\+클릭[^`]*`/);
    expect(source).toMatch(/'aria-label': `[^`]*Shift\+클릭[^`]*`/);
  });

  it('[직접 입력…]은 원장 탭으로 보낸다', () => {
    expect(source).toContain("ctx.setTab('ledger')");
    expect(source).toContain("text: '직접 입력…'");
  });

  it('두 컨트롤 탭이 같은 컴포넌트를 part만 바꿔 쓴다', () => {
    expect(p1Source).toContain("renderBonusStrip(ctx, 'p1')");
    expect(p2Source).toContain("renderBonusStrip(ctx, 'p2')");
    // 잠금 화면은 이른 return으로 빠져나가므로 그 위에 그려지지 않는다
    expect(p2Source.indexOf("renderBonusStrip(ctx, 'p2')")).toBeGreaterThan(
      p2Source.indexOf("class: 'tabpane tabpane--locked'"),
    );
  });

  it('CSS가 있고 자간을 넓히지 않는다', () => {
    expect(css).toMatch(/\.bonus-strip\s*\{/);
    expect(css).toMatch(/\.bonus-strip__btn\s*\{/);
    expect(css).toMatch(/\.bonus-strip__btn:focus-visible\s*\{/);
    /**
     * U139 m3 — 옛 검사는 `/letter-spacing:\s*0?\.\d/` **정규식 하나**였고 두 군데가 샜다.
     * (1) `0.01em`류만 잡고 `1px`·`0.5px` 같은 **단위 있는 양수**는 통과시켰다. (2) 부정
     * 선읽기로 바꿔도 `\s*`가 0글자로 되짚어 늘 통과한다. 그래서 정규식으로 "없음"을 보는
     * 대신 **값을 전부 뽑아 하나씩 판정한다** — 허용은 음수·0·`normal` 셋뿐이고 단위는 무관.
     * U136 `.standings*`도 같은 검사에 넣는다.
     */
    const trackingValues = (block: string): string[] =>
      [...block.matchAll(/letter-spacing:\s*([^;}]+)/g)].map((m) => m[1].trim());
    // 첫 글자로 가르면 `0.5px`이 0으로 읽혀 새어 나간다. 숫자만 떼어 0 이하인지 본다.
    const isTight = (v: string): boolean => v === 'normal' || parseFloat(v) <= 0;

    const bonusBlock = css.slice(css.indexOf('.bonus-strip {'), css.indexOf('.bonus-strip__more'));
    const bonusValues = trackingValues(bonusBlock);
    expect(bonusValues.length).toBeGreaterThan(0); // 검사 대상이 실제로 있는지부터 확인
    expect(bonusValues.filter((v) => !isTight(v))).toEqual([]);

    // `.ledger__list`는 파일 앞쪽에도 나온다 — 반드시 standings **뒤**에서 끝을 찾는다
    const standingsStart = css.indexOf('.standings {');
    const standingsBlock = css.slice(standingsStart, css.indexOf('.ledger__list', standingsStart));
    const standingsValues = trackingValues(standingsBlock);
    expect(standingsValues.length).toBeGreaterThan(0);
    expect(standingsValues.filter((v) => !isTight(v))).toEqual([]);

    // 검사기 자체가 무는지 확인 — 옛 정규식이 놓치던 두 형태를 여기서 잡는다
    expect(trackingValues('a { letter-spacing: 1px }').every(isTight)).toBe(false);
    expect(trackingValues('a { letter-spacing: 0.5px }').every(isTight)).toBe(false);
    expect(trackingValues('a { letter-spacing: .02em }').every(isTight)).toBe(false);
    expect(trackingValues('a { letter-spacing: -0.01em }').every(isTight)).toBe(true);
    expect(trackingValues('a { letter-spacing: 0 }').every(isTight)).toBe(true);
  });

  /**
   * U139 m4 — 버튼 실측 높이가 27px이라 줄(`min-height: 32px`) 안에서 위아래로 떠 있었다.
   * 사회자가 말하면서 누르는 자리라 히트 영역이 줄보다 작을 이유가 없다.
   */
  it('프리셋 버튼 높이가 줄 높이(32px)와 같다', () => {
    const row = css.match(/\.bonus-strip__row\s*\{([^}]*)\}/)?.[1] ?? '';
    const btn = css.match(/\.bonus-strip__btn\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(row).toMatch(/min-height:\s*32px/);
    expect(btn).toMatch(/min-height:\s*32px/);
    expect(btn).toMatch(/padding:\s*7px/);
  });
});

describe('진행 잠금 계약', () => {
  it('스트립이 만드는 문자열에 잠금 대상 낱말이 없다', () => {
    // 잠금 해제 전 컨트롤 탭에도 그려지므로, 이 파일에는 후반부를 가리키는 말이 없어야 한다
    expect(source).not.toMatch(/후반|용의자|범인|2부/);
  });
});
