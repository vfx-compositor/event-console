import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

// 네임스페이스로 받는다 — `meta`를 이름 그대로 import하면 Vite SSR 변환이 같은 파일의
// `import.meta.url`과 충돌해 스위트 자체가 로드되지 않는다.
import * as ledgerTab from './tab-ledger';
import { TABS, findTab } from './tabs';

const source = readFileSync(new URL('./tab-ledger.ts', import.meta.url), 'utf8');
const controlSource = readFileSync(new URL('../control.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles/control.css', import.meta.url), 'utf8');
const p1Source = readFileSync(new URL('./tab-p1.ts', import.meta.url), 'utf8');
const p2Source = readFileSync(new URL('./tab-p2.ts', import.meta.url), 'utf8');
const toastSource = readFileSync(new URL('./toast.ts', import.meta.url), 'utf8');

describe('점수 원장 탭', () => {
  it('탭 레지스트리에 등록되고 compact 라벨을 갖는다', () => {
    expect(ledgerTab.meta).toEqual({ id: 'ledger', label: '점수 원장' });
    expect(TABS).toContain(findTab('ledger'));
    expect(controlSource).toMatch(/ledger:\s*'원장'/);
  });

  it('우측 상시 레일과 접기 토글을 남기지 않는다', () => {
    expect(controlSource).not.toContain('renderLedger');
    expect(controlSource).not.toContain("col col--right");
    expect(css).not.toContain('.ledger--rail');
    expect(css).not.toContain('.ledger__rail-label');
    expect(css).not.toContain('.ledger__toggle');
    expect(css).not.toContain('is-ledger-collapsed');
    expect(source).not.toContain('y9.ui.ledgerCollapsed');
    expect(source).not.toContain('ledger__toggle');
  });

  it('레일이 쓰던 폭을 중앙 탭이 가져간다 (좌측 열 U134 1.1배 + U137 드래그 구분선 트랙)', () => {
    const main = css.match(/\.main\s*\{([^}]*)\}/)?.[1] ?? '';
    // U137로 가운데 12px 트랙(구분선)이 들어와 3열이 됐다. 좌측 열의 기본값은 여전히
    // U134의 범위이고, 사용자가 실제로 끌었을 때만 `--sidebar-w`가 그 자리를 대신한다.
    expect(main).toMatch(
      /grid-template-columns:\s*var\(--sidebar-w,\s*minmax\(277px,\s*330px\)\)\s+12px\s+minmax\(0,\s*1fr\);/,
    );
    // 옛 우측 상시 레일이 돌아오지 않았는지가 이 단언의 본래 목적이다
    expect(main).not.toMatch(/minmax\(0,\s*1fr\)\s+\d+px\s*;/);
  });

  it('항목별 역분개를 원장 액션으로 유지한다', () => {
    expect(source).toContain("type: 'ledger/reverse'");
    expect(source).toContain("text: '되돌리기'");
    expect(source).toContain("confirmLabel: '역분개'");
    // append-only 계약: 탭이 원장을 직접 지우거나 자르지 않는다
    expect(source).not.toMatch(/ledger\.splice|ledger\.filter\(/);
  });

  it('수동 가감점은 ledger/manual 한 줄만 추가한다', () => {
    expect(source).toContain("type: 'ledger/manual'");
    expect(source).toContain("class: 'ledger-manual'");
    expect(css).toMatch(/\.ledger-manual\s*\{/);
    expect(css).toMatch(/\.ledger-manual__chip\.is-on\s*\{/);
  });

  it('빈 값·0·문자는 기록하지 않고 부호는 그대로 통과시킨다', () => {
    expect(ledgerTab.parseManualDelta('')).toBeNull();
    expect(ledgerTab.parseManualDelta('   ')).toBeNull();
    expect(ledgerTab.parseManualDelta('0')).toBeNull();
    expect(ledgerTab.parseManualDelta('abc')).toBeNull();
    expect(ledgerTab.parseManualDelta('50')).toBe(50);
    expect(ledgerTab.parseManualDelta(' -30 ')).toBe(-30);
  });
});

describe('확정 직후 되돌리기 안전망', () => {
  it('토스트가 액션 버튼과 더 긴 노출 시간을 지원한다', () => {
    expect(toastSource).toContain('ToastAction');
    expect(toastSource).toContain("class: 'btn btn--tiny toast__action'");
    expect(toastSource).toMatch(/ACTION_MS\s*=\s*\d{4}/);
    expect(css).toMatch(/\.toast--action\s*\{[^}]*pointer-events:\s*auto/);
  });

  it('1부·후반 확정 토스트에 역분개 액션을 붙인다', () => {
    expect(p1Source).toMatch(/toast\(`\$\{ev\.name\} 점수를 확정했습니다`, 'ok', \{/);
    // 1부는 확인 1단계를 거친다 — 확정 당시 회차를 스냅샷해 그 회차만 역분개한다
    expect(p1Source).toMatch(/label: '되돌리기',[\s\S]{0,600}type: 'p1\/revoke'/);
    expect(p1Source).toContain('const revokeRound = ev.round;');
    expect(p1Source).toMatch(/round: revokeRound/);
    expect(p2Source).toMatch(/toast\(`\$\{st\.name\} 점수를 확정했습니다`, 'ok', \{/);
    expect(p2Source).toMatch(/label: '되돌리기',[\s\S]{0,220}type: 'p2\/revoke'/);
  });
});

describe('2부 잠금', () => {
  it('원장 탭은 후반 문자열을 스스로 만들지 않는다', () => {
    // 원장은 상태에 기록된 reason만 그린다. p2 항목은 잠금 해제 뒤에야 생기므로
    // 1부 중에는 목록에 나타날 수 없다.
    expect(source).not.toMatch(/후반|용의자|범인|2부/);
  });
});

/**
 * D6 — 수동 가감점 [기록]이 조용히 아무 일도 하지 않았다.
 *
 * 원인: 제출 핸들러가 **렌더 시점**에 파싱한 `delta`를 클로저에 담고 있었다. `input` 이벤트는
 * draft만 갱신하고 재렌더를 일으키지 않으므로, 타이핑한 값은 그 스냅샷에 영원히 반영되지 않는다.
 * 소스 문자열 매칭으로는 잡히지 않아 "입력 → 제출"을 값으로 재현한다.
 */
describe('수동 가감점 제출 (D6)', () => {
  it('제출 시점의 입력값을 읽는다 — 렌더 이후 타이핑이 반영된다', () => {
    ledgerTab.setManualDraft({ teamId: 't1', delta: '', reason: '' });
    // 렌더 시점: 입력이 비어 있다 (버튼 disabled)
    expect(ledgerTab.manualLedgerAction('t1', 1)).toBeNull();

    // 사용자가 타이핑한다 — 재렌더는 일어나지 않는다
    ledgerTab.setManualDraft({ delta: '50' });
    expect(ledgerTab.manualLedgerAction('t1', 1)).toEqual({
      type: 'ledger/manual',
      teamId: 't1',
      delta: 50,
      reason: '수동 조정',
      now: 1,
    });

    // 값을 더 고쳐도 매번 최신 값을 읽는다
    ledgerTab.setManualDraft({ delta: '-30', reason: ' 벌점 ' });
    expect(ledgerTab.manualLedgerAction('t1', 2)).toMatchObject({ delta: -30, reason: '벌점' });
  });

  it('팀이 없거나 값이 0·빈 칸이면 액션을 만들지 않는다', () => {
    ledgerTab.setManualDraft({ teamId: 't1', delta: '50', reason: '' });
    expect(ledgerTab.manualLedgerAction(null, 1)).toBeNull();
    ledgerTab.setManualDraft({ delta: '0' });
    expect(ledgerTab.manualLedgerAction('t1', 1)).toBeNull();
    ledgerTab.setManualDraft({ delta: '  ' });
    expect(ledgerTab.manualLedgerAction('t1', 1)).toBeNull();
  });

  it('제출 경로가 렌더 스냅샷이 아니라 이 함수를 쓴다', () => {
    expect(source).toContain('const action = manualLedgerAction(teamId, Date.now());');
    expect(source).toContain('ctx.dispatch(action)');
    // 렌더 스냅샷은 버튼 disabled 판정에만 쓴다
    expect(source).toContain('disabled: deltaAtRender === null');
  });

  it('죽은 modifier 클래스를 남기지 않는다', () => {
    expect(source).not.toContain('tabpane--ledger');
  });
});

/**
 * U126 — 사용자 지시 "점수 리셋"(2026-09-05 10:51) → 보강(10:5x) "점수만 되돌리는 거야.
 * 게임을 오늘 새로 시작할 수 있도록." 목적이 새 게임 시작이라 점수 일괄 역분개(`state.ts`의
 * `ledger/reverseAll`)만으로는 부족해, 승리 팀 선택·점수 공개·2부 제출 기록·시상 박자·진행
 * 단계·큐 커서까지 함께 되돌리는 `game/restart` 복합 액션으로 바뀌었다. 리듀서 값 검증은
 * state.test.ts가 하고, 여기서는 UI 배선(액션 이름·위험 확인·불변 항목 안내·레이아웃)만 본다.
 */
describe('새 게임 시작 버튼 (U126 → U126b)', () => {
  it('game/restart 액션을 dispatch하고 danger 확인 모달을 거친다', () => {
    expect(source).toContain("text: '새 게임 시작 (점수 되돌리기)'");
    expect(source).toContain("type: 'game/restart'");
    expect(source).toContain("reason: '새 게임 시작'");
    expect(source).toMatch(/title: '새 게임 시작',\s*body: el\(/);
    expect(source).toMatch(/confirmLabel: '새 게임 시작',/);
  });

  it('점수가 이미 0이어도 모달을 생략하지 않는다 — 진행 상태는 남아 있을 수 있다', () => {
    // 점수만 보고 조용히 넘어가면 "눌렀는데 안 됐다"가 된다 — 모달은 항상 열리고
    // 첫 줄의 점수 항목 문구만 역분개 유무에 따라 갈린다.
    expect(source).not.toMatch(/activeCount === 0\)[\s\S]{0,80}return;/);
    expect(source).toMatch(/activeCount > 0\s*\?/);
  });

  it('모달 본문 두 줄이 "초기화: … / 유지: …" 형식으로 각각을 말한다', () => {
    expect(source).toMatch(/text: `초기화: \$\{scoreNote\}·승리 팀·점수 공개·1부 진행·단계별 제출·시상 진행·큐 커서`/);
    expect(source).toContain("text: '유지: 설정·에셋·팀·음악(라이브러리·북마크)·현재 화면·타이머'");
  });

  it('진행 단계와 무관하게 열리는 탭이라 아직 해제되지 않은 단계를 드러내는 낱말을 쓰지 않는다', () => {
    expect(source).not.toMatch(/후반|용의자|범인|2부/);
  });

  it('단축키를 배선하지 않는다 (실수로 새 게임 시작 방지)', () => {
    const fnMatch = source.match(/function resetAllButton[\s\S]*?\n}\n/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).not.toMatch(/keydown|shortcut/i);
  });

  it('hover 근거(data-tip)를 붙인다', () => {
    expect(source).toMatch(/text: '새 게임 시작 \(점수 되돌리기\)',\s*data: \{\s*tip: '점수를 0으로 되돌리고/);
  });

  it('count와 같은 그룹에 두어 head 레이아웃이 2분할을 유지한다', () => {
    expect(source).toContain("class: 'ledger__head-actions'");
    expect(css).toMatch(/\.ledger__head-actions\s*\{/);
  });

  it('append-only 계약: 여기서도 원장을 직접 지우거나 자르지 않는다', () => {
    expect(source).not.toMatch(/ledger\.splice|ledger\.filter\(/);
  });
});
