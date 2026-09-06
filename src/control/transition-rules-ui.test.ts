/**
 * 조작 패널 "전환 할당" 섹션의 **2부 잠금 유출** 검증.
 *
 * `lock.test.ts`가 지키는 것은 출력 화면(관객이 보는 쪽)이다. 이 파일은 같은 규약을
 * **조작 패널**에 건다 — 1부 진행 중에는 진행자 화면을 어깨너머로 보는 참가자가 있고,
 * 전환 규칙 목록은 후반 씬 이름을 그대로 드러내던 자리였다(critic H1/H2).
 *
 * 테스트 환경이 `environment: 'node'`(DOM 없음)라 `renderTransitionRules()`를 부를 수 없다.
 * 대신 렌더가 쓰는 문자열을 전부 만드는 순수 함수 `buildTransitionRulesModel()`을 검사한다 —
 * 렌더는 이 모델의 값을 옮기기만 하므로 여기서 0건이면 화면에도 0건이다.
 */

import { describe, expect, it } from 'vitest';
import { SCENE_IDS, createInitialState, reducer, type Action } from '../state';
import { danglingRules } from '../transition-rules';
import {
  buildTransitionRulesModel,
  collectTransitionRulesStrings,
  describeRulesUsing,
} from './transition-rules-ui';
import { P2_SCENES } from '../types';
import type { AppState, AssetMeta } from '../types';

const FORBIDDEN = /2부|추리|용의자|도핑|수사/g;

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

function asset(id: string, patch: Partial<AssetMeta> = {}): AssetMeta {
  return {
    id,
    // 에셋 이름은 사람이 붙이는 값이라 검사 대상이 아니다 — 중립적인 이름을 쓴다
    name: `대판 ${id}`,
    type: 'video',
    size: 1024,
    mime: 'video/webm',
    playMode: 'transition',
    durationSec: 1.5,
    switchAtSec: 0.5,
    ...patch,
  };
}

const ASSETS: AssetMeta[] = [asset('a1'), asset('a2'), asset('a3')];

/**
 * 후반 씬이 from/to 양쪽에 잔뜩 걸린 상태 — 잠금이 없으면 반드시 이름이 새는 조건.
 * (`p2/unlock` 없이도 규칙 액션은 통과한다 — 규칙 값 자체는 잠금과 무관하게 남는다)
 */
function rulesLoaded(): AppState {
  return run(
    { ...createInitialState(), assets: ASSETS },
    { type: 'transitionRules/setDefault', assetId: 'a1' },
    { type: 'transitionRules/setByTo', to: 'live', assetId: 'a2' },
    { type: 'transitionRules/setByTo', to: 'suspects', assetId: 'a2' },
    { type: 'transitionRules/setByTo', to: 'submit', assetId: 'a3' },
    { type: 'transitionRules/setPair', from: 'live', to: 'score', assetId: 'a1' },
    { type: 'transitionRules/setPair', from: 'breaking', to: 'suspects', assetId: 'a2' },
    { type: 'transitionRules/setPair', from: 'live', to: 'submit', assetId: 'a3' },
    { type: 'transitionRules/setPair', from: 'suspects', to: 'award', assetId: 'a3' },
  );
}

function hits(strings: string[]): string[] {
  return strings.flatMap((t) => t.match(FORBIDDEN) ?? []);
}

describe('전환 할당 UI — 2부 잠금', () => {
  it('잠금 중에는 섹션이 내는 모든 문자열에 금지어가 0건이다', () => {
    const m = buildTransitionRulesModel(rulesLoaded());
    expect(m.locked).toBe(true);
    expect(hits(collectTransitionRulesStrings(m))).toEqual([]);
  });

  it('해제하면 실제로 후반 씬 이름이 나온다 (검사기가 유출을 잡아낼 수 있음을 증명)', () => {
    const m = buildTransitionRulesModel(run(rulesLoaded(), { type: 'p2/unlock' }));
    expect(m.locked).toBe(false);
    expect(hits(collectTransitionRulesStrings(m)).length).toBeGreaterThan(0);
  });

  it('잠금 중에는 후반 씬이 걸린 예외 행을 그리지 않고 개수만 알린다', () => {
    const locked = buildTransitionRulesModel(rulesLoaded());
    // 4개 중 live→score 하나만 양쪽 다 드러내도 되는 조합이다
    expect(locked.pairs.map((p) => `${p.from}>${p.to}`)).toEqual(['live>score']);
    expect(locked.hiddenPairCount).toBe(3);
    expect(locked.hiddenPairNote).toContain('3개');

    const open = buildTransitionRulesModel(run(rulesLoaded(), { type: 'p2/unlock' }));
    expect(open.pairs).toHaveLength(4);
    expect(open.hiddenPairCount).toBe(0);
    expect(open.hiddenPairNote).toBeNull();
  });

  it('예외 행의 씬 드롭다운 후보에도 잠긴 씬이 들어가지 않는다', () => {
    const locked = buildTransitionRulesModel(rulesLoaded());
    const ids = locked.sceneOptions.map((o) => o.id);
    expect(ids).not.toContain('suspects');
    expect(ids).not.toContain('submit');
    expect(ids).not.toContain('breaking');
    expect(ids).toContain('live');

    const open = buildTransitionRulesModel(run(rulesLoaded(), { type: 'p2/unlock' }));
    expect(open.sceneOptions.map((o) => o.id)).toContain('suspects');
  });

  it('도착 씬 행도 잠긴 씬은 빠지지만 배지 숫자에는 그대로 잡힌다', () => {
    const locked = buildTransitionRulesModel(rulesLoaded());
    expect(locked.byTo.map((r) => r.to)).not.toContain('suspects');
    // 기본 1 · 도착 씬 3(live/suspects/submit 전부) · 예외 4 — 숫자는 감추지 않는다
    expect(locked.badge).toBe('기본 1 · 도착 씬 3 · 예외 4');
  });

  it('잠금 중 배지에는 목록이 짧은 이유를 알리는 툴팁이 붙는다', () => {
    expect(buildTransitionRulesModel(rulesLoaded()).badgeTip).toMatch(/잠금을 해제/);
    expect(buildTransitionRulesModel(run(rulesLoaded(), { type: 'p2/unlock' })).badgeTip).toBeNull();
  });
});

describe('describeRulesUsing — 에셋 탭 `규칙 N개` 툴팁', () => {
  it('잠금 중에는 잠긴 씬 항목을 개수로 뭉갠다', () => {
    const s = rulesLoaded();
    const text = describeRulesUsing(s, 'a2');
    expect(text).not.toMatch(FORBIDDEN);
    // byTo(suspects) + pair(breaking→suspects) = 2곳, 드러나는 것은 live 하나
    expect(text).toContain('잠긴 씬 2곳');
    expect(text).toContain('경기 중계로 갈 때');
  });

  it('해제하면 잠긴 씬 뭉치가 사라지고 이름이 나온다', () => {
    const s = run(rulesLoaded(), { type: 'p2/unlock' });
    const text = describeRulesUsing(s, 'a2');
    expect(text).not.toContain('잠긴 씬');
    expect(text).toMatch(FORBIDDEN);
  });

  it('기본 규칙만 걸린 에셋은 잠금과 무관하게 같은 문장을 낸다', () => {
    expect(describeRulesUsing(rulesLoaded(), 'a1')).toContain('규칙이 없는 모든 전환(기본)');
  });

  it('아무 규칙도 없는 에셋은 없다고 말한다', () => {
    expect(describeRulesUsing(rulesLoaded(), 'nope')).toBe('이 에셋을 쓰는 전환 규칙이 없습니다.');
  });
});

describe('삭제된 에셋 판정은 danglingRules() 하나로 모은다', () => {
  it('에셋 목록이 비면 모델의 dangling 표시와 danglingRules()가 정확히 일치한다', () => {
    const s = { ...run(rulesLoaded(), { type: 'p2/unlock' }), assets: [] };
    const m = buildTransitionRulesModel(s);
    const list = danglingRules(s.transitionRules, s.assets);

    expect(m.default.dangling).toBe(true);
    expect(m.byTo.filter((r) => r.dangling).map((r) => r.to).sort()).toEqual(
      list.filter((d) => d.kind === 'to').map((d) => (d as { to: string }).to).sort(),
    );
    expect(m.pairs.every((p) => p.dangling)).toBe(true);
    expect(list).toHaveLength(1 + 3 + 4);
  });

  it('에셋이 살아 있으면 아무 행도 dangling이 아니다', () => {
    const m = buildTransitionRulesModel(run(rulesLoaded(), { type: 'p2/unlock' }));
    expect(m.default.dangling).toBe(false);
    expect(m.byTo.some((r) => r.dangling)).toBe(false);
    expect(m.pairs.some((p) => p.dangling)).toBe(false);
  });

  it('probeFailed는 "삭제됨"이 아니다 — 재생 불가 경고는 다른 칩이 맡는다', () => {
    const s = {
      ...run(rulesLoaded(), { type: 'p2/unlock' }),
      assets: [asset('a1', { probeFailed: true }), asset('a2'), asset('a3')],
    };
    expect(buildTransitionRulesModel(s).default.dangling).toBe(false);
  });
});

/**
 * 새 씬이 추가되면 도착 씬 규칙 행에 **자동으로** 편입돼야 한다.
 * `SCENE_ORDER = SCENE_IDS`가 그 자동화의 실체이고, 여기에 배열 리터럴을 하나 더 두면
 * 조용히 낡는다. `COMPACT_SCENE_LABEL`처럼 `Record<SceneId, …>`가 아닌 자리가 빠지면
 * 행은 그려지되 라벨이 `undefined`가 되므로 라벨 자체도 함께 본다(계획 §11 L3).
 */
describe('도착 씬 행은 SCENE_IDS 를 그대로 따라간다', () => {
  it('해제 상태에서는 모든 씬이 한 행씩, 잠금 중에는 잠긴 3개만 빠진다', () => {
    const open = buildTransitionRulesModel(run(rulesLoaded(), { type: 'p2/unlock' }));
    expect(open.byTo.map((r) => r.to)).toEqual(SCENE_IDS);

    const locked = buildTransitionRulesModel(rulesLoaded());
    expect(locked.byTo).toHaveLength(SCENE_IDS.length - P2_SCENES.length);
    expect(locked.byTo.map((r) => r.to)).toEqual(SCENE_IDS.filter((id) => !P2_SCENES.includes(id)));
  });

  it('모든 행이 전체 라벨·축약 라벨을 실제 문자열로 갖는다', () => {
    const open = buildTransitionRulesModel(run(rulesLoaded(), { type: 'p2/unlock' }));
    for (const row of open.byTo) {
      expect(typeof row.labelFull, `${row.to} labelFull`).toBe('string');
      expect(row.labelFull.length, `${row.to} labelFull`).toBeGreaterThan(0);
      expect(typeof row.labelShort, `${row.to} labelShort`).toBe('string');
      expect(row.labelShort.length, `${row.to} labelShort`).toBeGreaterThan(0);
    }
  });

  it('사진 씬도 도착 씬 규칙을 가질 수 있다', () => {
    const s = run(rulesLoaded(), { type: 'p2/unlock' }, {
      type: 'transitionRules/setByTo',
      to: 'photos',
      assetId: 'a1',
    });
    const row = buildTransitionRulesModel(s).byTo.find((r) => r.to === 'photos');
    expect(row?.current).toBe('a1');
    expect(row?.isSet).toBe(true);
  });
});
