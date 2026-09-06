import { describe, expect, it } from 'vitest';
import {
  countRulesUsing,
  danglingRules,
  isUsableTransitionAsset,
  resolveTransitionAsset,
  type TransitionCandidateAsset,
} from './transition-rules';
import { pickTransitionPreloadAssetId } from './transition-video';
import type { TransitionRules } from './types';

function rules(patch: Partial<TransitionRules> = {}): TransitionRules {
  return {
    defaultAssetId: null,
    byTo: {},
    pairs: [],
    ...patch,
  };
}

const ASSETS: TransitionCandidateAsset[] = [
  { id: 'sting-pair', type: 'video', playMode: 'transition' },
  { id: 'sting-to', type: 'video', playMode: 'transition' },
  { id: 'sting-default', type: 'video', playMode: 'transition' },
  { id: 'sting-legacy', type: 'video', playMode: 'transition' },
  { id: 'sting-broken', type: 'video', playMode: 'transition', probeFailed: true },
  { id: 'not-video', type: 'image', playMode: 'transition' },
  { id: 'full-video', type: 'video', playMode: 'full' },
];

describe('isUsableTransitionAsset', () => {
  it('video + transition + probeFailed 아님만 통과', () => {
    expect(isUsableTransitionAsset(ASSETS, 'sting-pair')).toBe(true);
    expect(isUsableTransitionAsset(ASSETS, 'sting-broken')).toBe(false);
    expect(isUsableTransitionAsset(ASSETS, 'not-video')).toBe(false);
    expect(isUsableTransitionAsset(ASSETS, 'full-video')).toBe(false);
  });

  it('null/undefined/삭제된 id는 false', () => {
    expect(isUsableTransitionAsset(ASSETS, null)).toBe(false);
    expect(isUsableTransitionAsset(ASSETS, undefined)).toBe(false);
    expect(isUsableTransitionAsset(ASSETS, 'gone')).toBe(false);
  });
});

describe('resolveTransitionAsset — 우선순위', () => {
  it('pair가 가장 높은 우선순위로 이긴다', () => {
    const r = rules({
      defaultAssetId: 'sting-default',
      byTo: { score: 'sting-to' },
      pairs: [{ from: 'standby', to: 'score', assetId: 'sting-pair' }],
    });
    expect(resolveTransitionAsset(r, ASSETS, 'standby', 'score')).toBe('sting-pair');
  });

  it('pair가 없으면 byTo[to]가 이긴다', () => {
    const r = rules({
      defaultAssetId: 'sting-default',
      byTo: { score: 'sting-to' },
      pairs: [{ from: 'live', to: 'timer', assetId: 'sting-pair' }], // 다른 조합이라 안 걸림
    });
    expect(resolveTransitionAsset(r, ASSETS, 'standby', 'score')).toBe('sting-to');
  });

  it('pair·byTo 둘 다 없으면 defaultAssetId가 이긴다', () => {
    const r = rules({ defaultAssetId: 'sting-default' });
    expect(resolveTransitionAsset(r, ASSETS, 'standby', 'score')).toBe('sting-default');
  });

  it('아무 규칙도 안 걸리면 legacy(pickTransitionPreloadAssetId) 폴백', () => {
    const r = rules();
    expect(resolveTransitionAsset(r, ASSETS, 'standby', 'score')).toBe(
      pickTransitionPreloadAssetId(ASSETS),
    );
    // legacy는 목록의 첫 정상 transition 에셋을 고른다
    expect(resolveTransitionAsset(r, ASSETS, 'standby', 'score')).toBe('sting-pair');
  });

  it('defaultAssetId === null이면 legacy 결과와 정확히 같다 (기존 설치 호환 회귀)', () => {
    const r = rules({ defaultAssetId: null, byTo: {}, pairs: [] });
    expect(resolveTransitionAsset(r, ASSETS, 'live', 'timer')).toBe(
      pickTransitionPreloadAssetId(ASSETS),
    );
  });
});

describe('resolveTransitionAsset — 폴백 스킵', () => {
  it('probeFailed 에셋이 걸린 단계는 건너뛰고 다음 단계로 폴백한다', () => {
    const r = rules({
      pairs: [{ from: 'standby', to: 'score', assetId: 'sting-broken' }],
      byTo: { score: 'sting-to' },
    });
    expect(resolveTransitionAsset(r, ASSETS, 'standby', 'score')).toBe('sting-to');
  });

  it('type: image 에셋이 지정돼도 무시하고 다음 단계로 폴백한다', () => {
    const r = rules({
      pairs: [{ from: 'standby', to: 'score', assetId: 'not-video' }],
      defaultAssetId: 'sting-default',
    });
    expect(resolveTransitionAsset(r, ASSETS, 'standby', 'score')).toBe('sting-default');
  });

  it("playMode: 'full' 에셋이 지정돼도 무시하고 다음 단계로 폴백한다", () => {
    const r = rules({
      byTo: { score: 'full-video' },
      defaultAssetId: 'sting-default',
    });
    expect(resolveTransitionAsset(r, ASSETS, 'standby', 'score')).toBe('sting-default');
  });

  it('삭제된 에셋 id(dangling)가 걸린 단계는 건너뛰고 다음 단계로 폴백한다', () => {
    const r = rules({
      pairs: [{ from: 'standby', to: 'score', assetId: 'deleted-asset' }],
      byTo: { score: 'sting-to' },
    });
    expect(resolveTransitionAsset(r, ASSETS, 'standby', 'score')).toBe('sting-to');
  });

  it('모든 단계가 실패하면 null (CSS 스윕 폴백)', () => {
    const emptyAssets: TransitionCandidateAsset[] = [];
    const r = rules({
      pairs: [{ from: 'standby', to: 'score', assetId: 'gone' }],
      byTo: { score: 'gone-too' },
      defaultAssetId: 'also-gone',
    });
    expect(resolveTransitionAsset(r, emptyAssets, 'standby', 'score')).toBeNull();
  });
});

describe('danglingRules', () => {
  it('삭제/숨김된 에셋을 가리키는 default/byTo/pair 규칙을 전부 찾아낸다', () => {
    const r = rules({
      defaultAssetId: 'gone-default',
      byTo: { score: 'gone-to', timer: 'sting-to' },
      pairs: [
        { from: 'standby', to: 'score', assetId: 'gone-pair' },
        { from: 'live', to: 'timer', assetId: 'sting-pair' },
      ],
    });
    const found = danglingRules(r, ASSETS);
    expect(found).toContainEqual({ kind: 'default' });
    expect(found).toContainEqual({ kind: 'to', to: 'score' });
    expect(found).toContainEqual({ kind: 'pair', from: 'standby', to: 'score' });
    // 살아있는 규칙은 포함되지 않는다
    expect(found).not.toContainEqual({ kind: 'to', to: 'timer' });
    expect(found).not.toContainEqual({ kind: 'pair', from: 'live', to: 'timer' });
    expect(found).toHaveLength(3);
  });

  it('defaultAssetId가 null이면 dangling 대상이 아니다', () => {
    const r = rules({ defaultAssetId: null });
    expect(danglingRules(r, ASSETS)).toEqual([]);
  });
});

describe('countRulesUsing', () => {
  it('default/byTo/pairs 전체에서 같은 assetId를 참조하는 규칙 개수를 중복까지 센다', () => {
    const r = rules({
      defaultAssetId: 'sting-pair',
      byTo: { score: 'sting-pair', timer: 'sting-to' },
      pairs: [
        { from: 'standby', to: 'score', assetId: 'sting-pair' },
        { from: 'live', to: 'timer', assetId: 'sting-pair' },
      ],
    });
    expect(countRulesUsing(r, 'sting-pair')).toBe(4);
    expect(countRulesUsing(r, 'sting-to')).toBe(1);
    expect(countRulesUsing(r, 'unused')).toBe(0);
  });
});
