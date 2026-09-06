import { pickTransitionPreloadAssetId } from './transition-video';
import type { SceneId, TransitionRules, VideoPlayMode } from './types';

export interface TransitionCandidateAsset {
  id: string;
  type: 'video' | 'image';
  playMode?: VideoPlayMode;
  probeFailed?: boolean;
}

/** 전환 오버레이로 실제 재생 가능한 에셋인가 (video + transition 모드 + 정상 probe) */
export function isUsableTransitionAsset(
  assets: ReadonlyArray<TransitionCandidateAsset>,
  id: string | null | undefined,
): boolean {
  if (!id) return false;
  const asset = assets.find((a) => a.id === id);
  if (!asset) return false;
  return asset.type === 'video' && asset.playMode === 'transition' && !asset.probeFailed;
}

/**
 * from → to 전환에 쓸 에셋 id.
 * 우선순위: pairs(from,to) > byTo[to] > defaultAssetId > legacy(pickTransitionPreloadAssetId)
 * 각 단계는 isUsableTransitionAsset()을 통과해야 하며, 실패하면(삭제됨·probeFailed·잘못된 타입)
 * 다음 단계로 내려간다. 전부 실패하면 null (= 영상 전환 없음, 기존 CSS 스윕 폴백).
 */
export function resolveTransitionAsset(
  rules: TransitionRules,
  assets: ReadonlyArray<TransitionCandidateAsset>,
  from: SceneId,
  to: SceneId,
): string | null {
  const pair = rules.pairs.find((p) => p.from === from && p.to === to);
  if (pair && isUsableTransitionAsset(assets, pair.assetId)) return pair.assetId;

  const byTo = rules.byTo[to];
  if (byTo && isUsableTransitionAsset(assets, byTo)) return byTo;

  if (rules.defaultAssetId && isUsableTransitionAsset(assets, rules.defaultAssetId)) {
    return rules.defaultAssetId;
  }

  return pickTransitionPreloadAssetId(assets);
}

/** 이 에셋을 참조하는 규칙 개수 (에셋 탭 배지용). default/byTo/pairs 전체에서 중복 포함 카운트 */
export function countRulesUsing(rules: TransitionRules, assetId: string): number {
  let count = 0;
  if (rules.defaultAssetId === assetId) count += 1;
  for (const to of Object.keys(rules.byTo) as SceneId[]) {
    if (rules.byTo[to] === assetId) count += 1;
  }
  for (const pair of rules.pairs) {
    if (pair.assetId === assetId) count += 1;
  }
  return count;
}

export type DanglingRule =
  | { kind: 'default' }
  | { kind: 'to'; to: SceneId }
  | { kind: 'pair'; from: SceneId; to: SceneId };

/**
 * 삭제/숨김된 에셋을 가리키는 규칙 목록 (경고 칩용).
 *
 * "삭제됨"은 assets 목록에 해당 id가 아예 없는 경우만 뜻한다 — probeFailed나
 * type/playMode 불일치는 "재생 불가"이지 "삭제됨"이 아니라 여기서 다루지 않는다
 * (그 경고는 에셋 행 자체의 `재생 불가?` 칩이 담당한다).
 */
export function danglingRules(
  rules: TransitionRules,
  assets: ReadonlyArray<Pick<TransitionCandidateAsset, 'id'>>,
): DanglingRule[] {
  const exists = (id: string): boolean => assets.some((a) => a.id === id);
  const found: DanglingRule[] = [];

  if (rules.defaultAssetId !== null && !exists(rules.defaultAssetId)) {
    found.push({ kind: 'default' });
  }
  for (const to of Object.keys(rules.byTo) as SceneId[]) {
    const assetId = rules.byTo[to];
    if (assetId && !exists(assetId)) found.push({ kind: 'to', to });
  }
  for (const pair of rules.pairs) {
    if (!exists(pair.assetId)) found.push({ kind: 'pair', from: pair.from, to: pair.to });
  }
  return found;
}
