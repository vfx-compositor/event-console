/**
 * 전환 영상("대판") 할당 UI — 에셋 탭 안의 접이식 섹션.
 *
 * 왜 별도 모듈인가: `tab-assets.ts`는 이미 650줄이고, 이 섹션은 규칙 3계층(기본 /
 * 도착 씬 / 조합 예외)을 각각 다루느라 자체 로컬 상태(펼침·포커스 이동)를 갖는다.
 * 파일을 나눠 두면 두 관심사가 서로를 밀어내지 않는다.
 *
 * **모델과 렌더가 나뉘어 있다.** 사람이 읽는 문자열(라벨·툴팁·aria-label·안내문)은 전부
 * `buildTransitionRulesModel()`이 **순수 함수로** 만들고, 렌더는 그 값을 DOM에 옮기기만 한다.
 * 이유는 2부 잠금 때문이다 — 잠금 중 조작 패널에 후반 씬 이름이 한 글자도 새면 안 되는데,
 * DOM 없는 테스트 환경(vitest `environment: 'node'`)에서 `renderTransitionRules()`를 부를 수
 * 없다. 모델을 분리해 두면 `collectTransitionRulesStrings()`로 화면에 나갈 문자열 전체를
 * 문자열 배열로 받아 검사할 수 있다(`transition-rules-ui.test.ts`).
 * 렌더에서 `SCENE_LABELS`를 직접 읽지 말 것 — 검사망 밖으로 새는 경로가 된다.
 *
 * UI 관례:
 *  - 네이티브 `<select>`·`<button>`만 쓴다. 방향키 wrap·Home/End·Enter·Esc가 전부
 *    브라우저 기본으로 온다 — 커스텀 리스트박스를 만들지 않는 것이 관례를 지키는
 *    가장 확실한 방법이다. 인라인 폼이므로 포커스 트랩은 넣지 않는다(트랩은 모달 전용).
 *  - 각 행은 `flex-wrap: nowrap`. 좁아지면 씬 라벨이 축약형으로 강등될 뿐 세로로
 *    팽창하지 않는다. `<select>`는 하한 폭을 갖고, 그 아래로는 줄지 않는다.
 *  - hover/focus/tap에 같은 상세가 열린다(`data-tip` + `tabIndex: 0`). native title 금지.
 */

import { SCENE_LABELS } from '../scenes';
import { SCENE_IDS } from '../state';
import { danglingRules, isUsableTransitionAsset } from '../transition-rules';
import { el } from './dom';
import { mediaFileFromId } from '../media-manifest';
import { pickTransitionPreloadAssetId } from '../transition-video';
import { toast } from './toast';
import { P2_SCENES } from '../types';
import type { AppState, AssetMeta, SceneId, TransitionRules } from '../types';
import type { Ctx } from './ctx';

/**
 * 축약 씬 라벨 — 좁은 폭에서 라벨 자리를 줄이기 위한 자체 맵.
 * `control.ts`의 `COMPACT_TAB_LABEL`은 그 파일 로컬 상수라 import할 수 없다(계획 §11 L2).
 */
const COMPACT_SCENE_LABEL: Record<SceneId, string> = {
  standby: '대기',
  game: '게임',
  live: '중계',
  score: '점수',
  timer: '타이머',
  roster: '명단',
  prompt: '제시어',
  breaking: '속보',
  video: '영상',
  photos: '사진',
  suspects: '보드',
  submit: '제출',
  award: '시상',
};

/**
 * 도착 씬 행의 순서 — 씬 런처·큐시트와 같은 진행 순서.
 * `state.ts`의 `SCENE_IDS`(= 전수 테이블의 키 순서)를 그대로 쓴다. 여기에 배열 리터럴을
 * 하나 더 두면 씬이 추가될 때 조용히 낡는다(계획 §11 L1).
 */
const SCENE_ORDER: SceneId[] = SCENE_IDS;

/** 1부 중에는 조작 패널에서도 이름을 감춘다 (P3 비밀 유지 — 규칙 값 자체는 남는다) */
const P2_ONLY: SceneId[] = P2_SCENES;

type RuleKind = 'pair' | 'to' | 'default' | 'legacy' | 'none';

const KIND_LABEL: Record<RuleKind, string> = {
  pair: '조합 예외',
  to: '도착 씬 규칙',
  default: '기본 규칙',
  legacy: '자동 폴백 — 첫 전환 에셋',
  none: '없음 — 화면 스윕으로 전환',
};

/** 섹션 펼침 상태. 재렌더가 잦아 DOM의 open 속성만으로는 유지되지 않는다 */
let sectionOpen = false;

/**
 * 행 추가·삭제 뒤 손이 허공에 뜨지 않게 포커스를 옮긴다.
 *
 * rAF로 미루는 이유가 둘이다:
 *  1. `ctx.dispatch()`가 **동기로** 트리를 다시 그리므로, 지금 있는 노드에 focus()를 걸어도
 *     곧 버려진다. 새 트리가 붙은 뒤에 걸어야 한다.
 *  2. control.ts의 `restoreFocus()`(동기)가 옛 `data-fid`로 포커스를 되돌려 놓으므로,
 *     그보다 늦게 돌아야 이 지정이 이긴다.
 * 호출을 dispatch 앞뒤 어디에 두어도 되도록 요청 시점에 직접 예약한다.
 */
function requestFocus(fid: string): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-fid="${fid}"]`)?.focus();
  });
}

/** 지금 조작 패널에 **이름을 드러내도 되는** 씬 (잠금 중에는 후반 씬을 뺀다) */
function visibleScenes(s: AppState): SceneId[] {
  if (s.p2.unlocked) return SCENE_ORDER;
  return SCENE_ORDER.filter((id) => !P2_ONLY.includes(id));
}

/** 이 씬 이름을 지금 화면에 써도 되는가 */
function sceneHidden(s: AppState, id: SceneId): boolean {
  return !s.p2.unlocked && P2_ONLY.includes(id);
}

/** 전환 오버레이로 걸 수 있는 후보 (probeFailed도 목록에는 남긴다 — 왜 안 걸리는지 보여야 한다) */
function transitionAssets(assets: ReadonlyArray<AssetMeta>): AssetMeta[] {
  return assets
    .filter((a) => a.type === 'video' && a.playMode === 'transition')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * 우선순위 해석을 **이유와 함께** 되돌려 준다.
 * 값 자체는 `resolveTransitionAsset()`과 같은 순서·같은 판정을 쓴다(툴팁 설명 전용).
 */
function resolveWithKind(
  rules: TransitionRules,
  assets: ReadonlyArray<AssetMeta>,
  from: SceneId,
  to: SceneId,
): { assetId: string | null; kind: RuleKind } {
  const pair = rules.pairs.find((p) => p.from === from && p.to === to);
  if (pair && isUsableTransitionAsset(assets, pair.assetId)) {
    return { assetId: pair.assetId, kind: 'pair' };
  }
  const byTo = rules.byTo[to];
  if (byTo && isUsableTransitionAsset(assets, byTo)) return { assetId: byTo, kind: 'to' };
  if (rules.defaultAssetId && isUsableTransitionAsset(assets, rules.defaultAssetId)) {
    return { assetId: rules.defaultAssetId, kind: 'default' };
  }
  const legacy = pickTransitionPreloadAssetId(assets);
  if (legacy) return { assetId: legacy, kind: 'legacy' };
  return { assetId: null, kind: 'none' };
}

/** 규칙이 없는 전환에 실제로 쓰이는 에셋 id (에셋 탭 `기본 씬 전환` 칩 판정과 공유) */
export function effectiveDefaultAssetId(s: AppState): string | null {
  const explicit = s.transitionRules.defaultAssetId;
  if (isUsableTransitionAsset(s.assets, explicit)) return explicit;
  return pickTransitionPreloadAssetId(s.assets);
}

function fmtSec(n: number | undefined): string {
  return n !== undefined && Number.isFinite(n) ? `${n.toFixed(2)}초` : '길이 미상';
}

/** 파일명 · 길이 · 씬 교체 시각 — "이 값이 왜 이런가"까지 한 줄에 */
function assetDetail(a: AssetMeta | undefined): string {
  if (!a) return '지정된 에셋이 목록에 없습니다 — 삭제됐거나 다른 브라우저에서 등록한 항목입니다.';
  const file = mediaFileFromId(a.id);
  // 이름은 앞머리에 이미 들어가므로, 파일명이 따로 있을 때만 덧붙인다(중복 방지)
  const bits = [
    ...(file ? [`media/${file}`] : []),
    fmtSec(a.durationSec),
    `씬 교체 ${(a.switchAtSec ?? 0.5).toFixed(2)}초 (영상이 화면을 완전히 덮는 구간의 시작 직후 — 아래 씬을 이때 바꿉니다)`,
  ];
  if (a.probeFailed) bits.push('⚠ 브라우저가 열지 못한 파일이라 전환에 걸리지 않고 건너뜁니다');
  return `${a.name} — ${bits.join(' · ')}`;
}

function resolvedLine(s: AppState, from: SceneId, to: SceneId): string {
  const { assetId, kind } = resolveWithKind(s.transitionRules, s.assets, from, to);
  const name = assetId ? (s.assets.find((a) => a.id === assetId)?.name ?? assetId) : '없음';
  return `지금 이 전환에 실제로 재생되는 것: ${name} (${KIND_LABEL[kind]})`;
}

/**
 * 이 에셋을 쓰는 규칙을 사람 말로 나열한다 (에셋 탭 `규칙 N개` 칩 툴팁).
 * `tab-assets.ts`가 import해 쓴다.
 *
 * 잠금 중에는 후반 씬이 걸린 항목을 **개수로만** 뭉갠다 — 조작 패널도 1부 진행 중에는
 * 후반 씬 이름을 드러내지 않는다(계획 §6-1). 개수는 남긴다: 규칙이 있다는 사실 자체는
 * 진행자가 알아야 "왜 이 대판이 걸렸지?"를 추적할 수 있다.
 */
export function describeRulesUsing(s: AppState, assetId: string): string {
  const r = s.transitionRules;
  const out: string[] = [];
  let hidden = 0;

  if (r.defaultAssetId === assetId) out.push('규칙이 없는 모든 전환(기본)');

  for (const to of SCENE_ORDER) {
    if (r.byTo[to] !== assetId) continue;
    if (sceneHidden(s, to)) {
      hidden += 1;
      continue;
    }
    out.push(`${SCENE_LABELS[to]}로 갈 때`);
  }

  for (const p of r.pairs) {
    if (p.assetId !== assetId) continue;
    if (sceneHidden(s, p.from) || sceneHidden(s, p.to)) {
      hidden += 1;
      continue;
    }
    out.push(`${SCENE_LABELS[p.from]} → ${SCENE_LABELS[p.to]}`);
  }

  if (hidden) out.push(`잠긴 씬 ${hidden}곳`);
  if (!out.length) return '이 에셋을 쓰는 전환 규칙이 없습니다.';
  return `이 대판이 걸린 곳: ${out.join(' · ')}`;
}

/* ── 모델 ────────────────────────────────────────────────────────────────── */

/**
 * 삭제된 에셋을 가리키는 규칙 — 판정은 `transition-rules.ts`의 `danglingRules()` 하나로 모은다.
 * (예전에는 UI가 자체 `assetExists()`로 따로 판정해 두 곳이 갈릴 수 있었다 — 계획 §11 L2)
 */
function danglingIndex(s: AppState): {
  default: boolean;
  byTo: Set<SceneId>;
  pairs: Set<string>;
} {
  const list = danglingRules(s.transitionRules, s.assets);
  const byTo = new Set<SceneId>();
  const pairs = new Set<string>();
  let def = false;
  for (const d of list) {
    if (d.kind === 'default') def = true;
    else if (d.kind === 'to') byTo.add(d.to);
    else pairs.add(pairKey(d.from, d.to));
  }
  return { default: def, byTo, pairs };
}

function pairKey(from: SceneId, to: SceneId): string {
  return `${from}>${to}`;
}

export interface DefaultRowModel {
  current: string | null;
  isSet: boolean;
  dangling: boolean;
  labelFull: string;
  labelShort: string;
  emptyLabel: string;
  aria: string;
  tip: string;
  clearToast: string;
}

export interface ByToRowModel {
  to: SceneId;
  current: string | null;
  isSet: boolean;
  dangling: boolean;
  labelFull: string;
  labelShort: string;
  emptyLabel: string;
  aria: string;
  tip: string;
  clearToast: string;
}

export interface PairRowModel {
  from: SceneId;
  to: SceneId;
  assetId: string;
  dangling: boolean;
  fromAria: string;
  toAria: string;
  assetAria: string;
  deleteAria: string;
  tip: string;
}

export interface TransitionRulesModel {
  locked: boolean;
  badge: string;
  /** 잠금 중에만 붙는 안내 (왜 예외 목록이 짧은지) */
  badgeTip: string | null;
  /** 전환 오버레이 에셋이 하나도 없을 때의 안내 */
  noAssetHint: string | null;
  groupTitles: { default: string; byTo: string; pairs: string };
  sectionTitle: string;
  default: DefaultRowModel;
  byTo: ByToRowModel[];
  /** 화면에 실제로 그릴 조합 예외 (잠금 중이면 후반 씬이 걸린 행은 빠진다) */
  pairs: PairRowModel[];
  /** 예외 행 씬 드롭다운의 옵션 (이름을 드러내도 되는 씬만) */
  sceneOptions: { id: SceneId; label: string }[];
  hiddenPairCount: number;
  /** 숨긴 예외가 있을 때만 — 개수만 알리고 이름은 내지 않는다 */
  hiddenPairNote: string | null;
  /** 그릴 예외가 하나도 없을 때의 안내 */
  emptyPairsNote: string | null;
  addPairTip: string;
}

/**
 * 화면에 나갈 문자열을 전부 만든다 — 렌더는 이 값을 옮기기만 한다.
 * 순수 함수라 DOM 없이 테스트할 수 있다(2부 잠금 유출 검사).
 */
export function buildTransitionRulesModel(s: AppState): TransitionRulesModel {
  const locked = !s.p2.unlocked;
  const scenes = visibleScenes(s);
  const dangling = danglingIndex(s);
  const r = s.transitionRules;

  const defaultCur = r.defaultAssetId;
  const effective = effectiveDefaultAssetId(s);
  const effectiveName = effective
    ? (s.assets.find((a) => a.id === effective)?.name ?? effective)
    : '없음 (화면 스윕)';

  const defaultRow: DefaultRowModel = {
    current: defaultCur,
    isSet: defaultCur !== null,
    dangling: dangling.default,
    labelFull: '규칙 없는 전환',
    labelShort: '기본',
    emptyLabel: '자동 (첫 전환 에셋)',
    aria: '규칙에 걸리지 않은 전환에 쓸 기본 대판',
    tip: [
      '어떤 규칙에도 걸리지 않은 전환에 재생할 대판입니다.',
      '비워 두면 첫 전환 오버레이 에셋이 자동으로 쓰입니다(기존 동작).',
      assetDetail(s.assets.find((a) => a.id === (defaultCur ?? effective))),
      `지금 규칙 없는 전환에 실제로 재생되는 것: ${effectiveName}`,
    ].join('\n'),
    clearToast: '기본 전환 규칙을 지웠습니다',
  };

  const byTo: ByToRowModel[] = scenes.map((to) => {
    const cur = r.byTo[to] ?? null;
    return {
      to,
      current: cur,
      isSet: cur !== null,
      dangling: dangling.byTo.has(to),
      labelFull: SCENE_LABELS[to],
      labelShort: COMPACT_SCENE_LABEL[to],
      emptyLabel: '기본 사용',
      aria: `${SCENE_LABELS[to]}로 갈 때 쓸 전환 영상`,
      tip: [
        `${SCENE_LABELS[to]}로 갈 때 재생할 대판입니다. 조합 예외가 걸려 있으면 그쪽이 먼저 이깁니다.`,
        assetDetail(s.assets.find((a) => a.id === cur)),
        resolvedLine(s, s.scene, to),
      ].join('\n'),
      clearToast: `${SCENE_LABELS[to]} 규칙을 지웠습니다`,
    };
  });

  // 잠긴 씬이 from/to 어느 쪽에라도 걸린 예외는 **행 자체를 그리지 않는다**.
  // 예전에는 전부 그리면서 셀렉트에 숨은 씬을 되살려 넣어(`[from, ...scenes]`) 라벨이 새어 나갔다.
  const shownPairs = r.pairs.filter((p) => !sceneHidden(s, p.from) && !sceneHidden(s, p.to));
  const hiddenPairCount = r.pairs.length - shownPairs.length;

  const pairs: PairRowModel[] = shownPairs.map((p, i) => ({
    from: p.from,
    to: p.to,
    assetId: p.assetId,
    dangling: dangling.pairs.has(pairKey(p.from, p.to)),
    fromAria: `예외 ${i + 1} 출발 씬`,
    toAria: `예외 ${i + 1} 도착 씬`,
    assetAria: `예외 ${i + 1} 전환 영상`,
    deleteAria: `${SCENE_LABELS[p.from]} → ${SCENE_LABELS[p.to]} 예외 삭제`,
    tip: [
      `${SCENE_LABELS[p.from]}에서 ${SCENE_LABELS[p.to]}로 갈 때만 쓰는 예외입니다. 도착 씬 규칙·기본보다 우선합니다.`,
      assetDetail(s.assets.find((a) => a.id === p.assetId)),
      resolvedLine(s, p.from, p.to),
    ].join('\n'),
  }));

  const base = r.defaultAssetId ? 1 : 0;
  // 숨겨진 씬의 규칙도 **개수만** 센다 (씬 이름은 노출하지 않는다 — 계획 §6-1)
  const byToCount = Object.values(r.byTo).filter(Boolean).length;

  return {
    locked,
    badge: `기본 ${base} · 도착 씬 ${byToCount} · 예외 ${r.pairs.length}`,
    // L5: 왜 목록이 짧은지 알린다. 잠긴 단계 이름은 쓰지 않는다 — 조작 패널도 1부 중에는
    // 후반 어휘를 내지 않는 것이 이 프로젝트의 잠금 규약이다(lock 검사망이 조작 패널까지 본다).
    badgeTip: locked
      ? '지금은 잠긴 씬이 있어 그 씬이 걸린 규칙은 목록에서 빠져 있습니다. 잠금을 해제하면 여기서 편집할 수 있습니다.'
      : null,
    noAssetHint: transitionAssets(s.assets).length
      ? null
      : '전환 오버레이로 지정된 영상이 없습니다. 아래 목록에서 영상의 [방식]을 "전환 오버레이"로 바꾸면 여기 후보로 뜹니다.',
    sectionTitle: '전환 할당',
    groupTitles: { default: '기본', byTo: '도착 씬별', pairs: '조합 예외 (출발 → 도착)' },
    default: defaultRow,
    byTo,
    pairs,
    sceneOptions: scenes.map((id) => ({ id, label: SCENE_LABELS[id] })),
    hiddenPairCount,
    hiddenPairNote: hiddenPairCount
      ? `숨겨진 예외 ${hiddenPairCount}개 — 잠긴 씬이 걸려 있어 잠금을 해제해야 보이고 편집됩니다.`
      : null,
    emptyPairsNote: pairs.length
      ? null
      : hiddenPairCount
        ? '지금 편집할 수 있는 조합 예외가 없습니다.'
        : '지정된 조합 예외가 없습니다.',
    addPairTip:
      '특정 출발 씬에서 특정 도착 씬으로 갈 때만 다른 대판을 씁니다. 추가하면 첫 드롭다운으로 포커스가 옮겨 갑니다.',
  };
}

/**
 * 이 섹션이 화면에 내보내는 **사람이 읽는 문자열 전부**.
 * 잠금 유출 검사가 이 배열 하나만 훑으면 되도록, 렌더가 쓰는 모든 문자열 필드를 모은다.
 * (에셋 이름은 사용자가 붙인 값이므로 여기 포함된다 — 툴팁에 그대로 나가기 때문이다.)
 */
export function collectTransitionRulesStrings(m: TransitionRulesModel): string[] {
  const out: string[] = [
    m.sectionTitle,
    m.badge,
    m.groupTitles.default,
    m.groupTitles.byTo,
    m.groupTitles.pairs,
    m.addPairTip,
    m.default.labelFull,
    m.default.labelShort,
    m.default.emptyLabel,
    m.default.aria,
    m.default.tip,
    m.default.clearToast,
  ];
  if (m.badgeTip) out.push(m.badgeTip);
  if (m.noAssetHint) out.push(m.noAssetHint);
  if (m.hiddenPairNote) out.push(m.hiddenPairNote);
  if (m.emptyPairsNote) out.push(m.emptyPairsNote);
  for (const row of m.byTo) {
    out.push(row.labelFull, row.labelShort, row.emptyLabel, row.aria, row.tip, row.clearToast);
  }
  for (const row of m.pairs) {
    out.push(row.fromAria, row.toAria, row.assetAria, row.deleteAria, row.tip);
  }
  for (const o of m.sceneOptions) out.push(o.label);
  return out;
}

/* ── 공용 조각 ───────────────────────────────────────────────────────────── */

interface OptionSpec {
  /** `null`이면 빈 옵션 자체를 만들지 않는다 (조합 예외 — 삭제는 [삭제] 버튼만) */
  emptyLabel: string | null;
  selected: string | null;
}

/**
 * 드롭다운 옵션 — (선택적) 빈 항목 + 전환 에셋 전부.
 * 지금 걸린 값이 목록에 없으면(삭제·모드 변경) 그 항목을 만들어 **선택 상태를 유지**한다.
 * 지우지 않는 이유: media 폴더 항목은 "숨김 → 다시 불러오기"로 되살아나기 때문(계획 §1-6).
 */
function assetOptionNodes(assets: ReadonlyArray<AssetMeta>, spec: OptionSpec): HTMLElement[] {
  const list = transitionAssets(assets);
  const nodes: HTMLElement[] = [];
  if (spec.emptyLabel !== null) {
    nodes.push(
      el('option', {
        value: '',
        text: spec.emptyLabel,
        attrs: { selected: spec.selected ? undefined : 'selected' },
      }),
    );
  }
  for (const a of list) {
    nodes.push(
      el('option', {
        value: a.id,
        text: `${a.probeFailed ? '⚠ ' : ''}${a.name}`,
        attrs: { selected: spec.selected === a.id ? 'selected' : undefined },
      }),
    );
  }
  if (spec.selected && !list.some((a) => a.id === spec.selected)) {
    const known = assets.find((a) => a.id === spec.selected);
    nodes.push(
      el('option', {
        value: spec.selected,
        text: known
          ? `⚠ ${known.name} (전환 오버레이 아님)`
          : `없는 에셋 (${spec.selected.slice(0, 10)}…)`,
        attrs: { selected: 'selected' },
      }),
    );
  }
  return nodes;
}

/**
 * `fid`를 반드시 준다 — control이 재렌더 때 `data-fid`로만 포커스를 되살리므로,
 * 없으면 상세를 읽는 도중 다음 tick 렌더에 포커스가 날아가 툴팁이 닫힌다.
 */
function infoIcon(fid: string, tip: string): HTMLElement {
  return el('span', {
    class: 'trule__info',
    text: 'ⓘ',
    data: { fid, tip },
    tabIndex: 0,
    attrs: { role: 'note', 'aria-label': '이 행의 상세 설명' },
  });
}

function setChip(): HTMLElement {
  return el('span', { class: 'chip trule__chip', text: '지정' });
}

/** 삭제된 에셋을 가리키는 행에만 붙는 탈출구 */
function clearRuleButton(fid: string, onClear: () => void): HTMLElement {
  return el('button', {
    class: 'btn btn--tiny btn--danger',
    type: 'button',
    text: '규칙 지우기',
    data: { fid, tip: '이 규칙이 가리키는 에셋이 목록에 없습니다. 규칙을 지우면 다음 우선순위로 내려갑니다.' },
    on: { click: onClear },
  });
}

/* ── 기본 ────────────────────────────────────────────────────────────────── */

function defaultRow(ctx: Ctx, m: DefaultRowModel): HTMLElement {
  return el(
    'div',
    { class: `trule${m.isSet ? ' is-set' : ''}` },
    el(
      'span',
      { class: 'trule__label' },
      // 라벨 자리는 고정폭이라 잘리면 안 된다 — 좁은 폭에서는 축약형으로 강등된다
      el('span', { class: 'trule__label-full', text: m.labelFull }),
      el('span', { class: 'trule__label-short', text: m.labelShort }),
    ),
    el(
      'select',
      {
        class: 'input input--select trule__select',
        data: { fid: 'trule-default' },
        attrs: { 'aria-label': m.aria },
        on: {
          change: (ev) => {
            const v = (ev.target as HTMLSelectElement).value;
            ctx.dispatch({ type: 'transitionRules/setDefault', assetId: v || null });
          },
        },
      },
      assetOptionNodes(ctx.state.assets, { emptyLabel: m.emptyLabel, selected: m.current }),
    ),
    m.isSet ? setChip() : null,
    m.dangling
      ? clearRuleButton('trule-default-clear', () => {
          ctx.dispatch({ type: 'transitionRules/setDefault', assetId: null });
          requestFocus('trule-default');
          toast(m.clearToast, 'warn');
        })
      : null,
    infoIcon('trule-default-info', m.tip),
  );
}

/* ── 도착 씬별 ───────────────────────────────────────────────────────────── */

function byToRow(ctx: Ctx, m: ByToRowModel): HTMLElement {
  const to = m.to;
  return el(
    'div',
    { class: `trule${m.isSet ? ' is-set' : ''}` },
    el(
      'span',
      { class: 'trule__label' },
      el('span', { class: 'trule__label-full', text: m.labelFull }),
      el('span', { class: 'trule__label-short', text: m.labelShort }),
    ),
    el(
      'select',
      {
        class: 'input input--select trule__select',
        data: { fid: `trule-to-${to}` },
        attrs: { 'aria-label': m.aria },
        on: {
          change: (ev) => {
            const v = (ev.target as HTMLSelectElement).value;
            ctx.dispatch({ type: 'transitionRules/setByTo', to, assetId: v || null });
          },
        },
      },
      assetOptionNodes(ctx.state.assets, { emptyLabel: m.emptyLabel, selected: m.current }),
    ),
    m.isSet ? setChip() : null,
    m.dangling
      ? clearRuleButton(`trule-to-${to}-clear`, () => {
          ctx.dispatch({ type: 'transitionRules/setByTo', to, assetId: null });
          requestFocus(`trule-to-${to}`);
          toast(m.clearToast, 'warn');
        })
      : null,
    infoIcon(`trule-to-${to}-info`, m.tip),
  );
}

/* ── 조합 예외 ───────────────────────────────────────────────────────────── */

function sceneSelectNodes(
  options: ReadonlyArray<{ id: SceneId; label: string }>,
  selected: SceneId,
): HTMLElement[] {
  return options.map((o) =>
    el('option', {
      value: o.id,
      text: o.label,
      attrs: { selected: selected === o.id ? 'selected' : undefined },
    }),
  );
}

function pairRow(
  ctx: Ctx,
  model: TransitionRulesModel,
  m: PairRowModel,
  nextFocusFid: string,
): HTMLElement {
  const { from, to, assetId } = m;

  /** 출발·도착을 바꾸는 것은 "옛 조합 삭제 + 새 조합 추가"다 (키가 바뀌므로) */
  const rekey = (nextFrom: SceneId, nextTo: SceneId) => {
    if (nextFrom === nextTo) {
      toast('출발 씬과 도착 씬이 같으면 전환이 일어나지 않습니다', 'bad');
      ctx.refresh();
      return;
    }
    // 이미 그 조합에 예외가 있으면 조용히 덮어쓰지 않는다 — 두 규칙이 하나로 합쳐져
    // 사라진 쪽을 되살릴 방법이 없다(계획 §11 M4).
    const taken = ctx.state.transitionRules.pairs.some(
      (p) => p.from === nextFrom && p.to === nextTo && !(p.from === from && p.to === to),
    );
    if (taken) {
      toast('이미 지정된 조합입니다', 'bad');
      ctx.refresh();
      return;
    }
    ctx.dispatch([
      { type: 'transitionRules/removePair', from, to },
      { type: 'transitionRules/setPair', from: nextFrom, to: nextTo, assetId },
    ]);
    requestFocus(`trule-pair-asset-${nextFrom}-${nextTo}`);
  };

  return el(
    'div',
    { class: 'trule trule--pair is-set' },
    el(
      'select',
      {
        class: 'input input--select trule__scene',
        data: { fid: `trule-pair-from-${from}-${to}` },
        attrs: { 'aria-label': m.fromAria },
        on: { change: (ev) => rekey((ev.target as HTMLSelectElement).value as SceneId, to) },
      },
      sceneSelectNodes(model.sceneOptions, from),
    ),
    el('span', { class: 'trule__arrow', text: '→', attrs: { 'aria-hidden': 'true' } }),
    el(
      'select',
      {
        class: 'input input--select trule__scene',
        data: { fid: `trule-pair-to-${from}-${to}` },
        attrs: { 'aria-label': m.toAria },
        on: { change: (ev) => rekey(from, (ev.target as HTMLSelectElement).value as SceneId) },
      },
      sceneSelectNodes(model.sceneOptions, to),
    ),
    el(
      'select',
      {
        class: 'input input--select trule__select',
        data: { fid: `trule-pair-asset-${from}-${to}` },
        attrs: { 'aria-label': m.assetAria },
        on: {
          change: (ev) => {
            const v = (ev.target as HTMLSelectElement).value;
            // 빈 옵션을 만들지 않으므로 여기 걸리지 않는다 — 삭제는 [삭제] 버튼 하나뿐이다
            // (드롭다운을 훑다가 예외가 사라지던 사고 방지 — 계획 §11 L6).
            if (!v) return;
            ctx.dispatch({ type: 'transitionRules/setPair', from, to, assetId: v });
          },
        },
      },
      assetOptionNodes(ctx.state.assets, { emptyLabel: null, selected: assetId }),
    ),
    m.dangling
      ? clearRuleButton(`trule-pair-${from}-${to}-clear`, () => {
          ctx.dispatch({ type: 'transitionRules/removePair', from, to });
          requestFocus('trule-pair-add');
          toast('없는 에셋을 가리키던 예외를 지웠습니다', 'warn');
        })
      : null,
    infoIcon(`trule-pair-${from}-${to}-info`, m.tip),
    el('button', {
      class: 'btn btn--tiny btn--danger',
      type: 'button',
      text: '삭제',
      data: { fid: `trule-pair-del-${from}-${to}` },
      attrs: { 'aria-label': m.deleteAria },
      on: {
        click: () => {
          // 삭제하면 이 자리에 다음 행이 올라온다 — 손을 그 자리에 그대로 둔다
          requestFocus(nextFocusFid);
          ctx.dispatch({ type: 'transitionRules/removePair', from, to });
        },
      },
    }),
  );
}

/** 아직 안 쓰인 (출발, 도착) 조합 중 첫 번째 — 기존 예외를 조용히 덮어쓰지 않기 위해 */
function nextFreePair(s: AppState): { from: SceneId; to: SceneId } | null {
  const scenes = visibleScenes(s);
  for (const from of scenes) {
    for (const to of scenes) {
      if (from === to) continue;
      if (!s.transitionRules.pairs.some((p) => p.from === from && p.to === to)) return { from, to };
    }
  }
  return null;
}

function addPairButton(ctx: Ctx, tip: string): HTMLElement {
  return el('button', {
    class: 'btn btn--tiny',
    type: 'button',
    text: '+ 예외 추가',
    data: { fid: 'trule-pair-add', tip },
    on: {
      click: () => {
        const s = ctx.state;
        const usable = transitionAssets(s.assets).find((a) => !a.probeFailed);
        if (!usable) {
          toast('전환 오버레이로 쓸 영상이 없습니다 — 에셋의 [방식]을 전환 오버레이로 바꾸세요', 'bad');
          return;
        }
        const slot = nextFreePair(s);
        if (!slot) {
          toast('가능한 조합이 모두 이미 지정돼 있습니다', 'warn');
          return;
        }
        requestFocus(`trule-pair-from-${slot.from}-${slot.to}`);
        ctx.dispatch({
          type: 'transitionRules/setPair',
          from: slot.from,
          to: slot.to,
          assetId: usable.id,
        });
      },
    },
  });
}

/* ── 섹션 ────────────────────────────────────────────────────────────────── */

export function renderTransitionRules(ctx: Ctx): HTMLElement {
  const m = buildTransitionRulesModel(ctx.state);

  const node = el(
    'details',
    { class: 'trules', attrs: { open: sectionOpen ? 'open' : undefined } },
    el(
      'summary',
      { class: 'trules__summary' },
      el('span', { class: 'trules__title', text: m.sectionTitle }),
      el('span', {
        class: 'chip trules__badge',
        text: m.badge,
        ...(m.badgeTip ? { data: { tip: m.badgeTip }, tabIndex: 0 } : {}),
      }),
    ),
    el(
      'div',
      { class: 'trules__body' },
      m.noAssetHint ? el('p', { class: 'tabpane__hint', text: m.noAssetHint }) : null,

      el('h4', { class: 'trules__group-title', text: m.groupTitles.default }),
      defaultRow(ctx, m.default),

      el('h4', { class: 'trules__group-title', text: m.groupTitles.byTo }),
      el('div', { class: 'trules__group' }, m.byTo.map((row) => byToRow(ctx, row))),

      el('h4', { class: 'trules__group-title', text: m.groupTitles.pairs }),
      m.pairs.length
        ? el(
            'div',
            { class: 'trules__group' },
            m.pairs.map((row, i) => {
              const next = m.pairs[i + 1];
              const fid = next ? `trule-pair-from-${next.from}-${next.to}` : 'trule-pair-add';
              return pairRow(ctx, m, row, fid);
            }),
          )
        : null,
      m.emptyPairsNote ? el('p', { class: 'tabpane__hint', text: m.emptyPairsNote }) : null,
      m.hiddenPairNote ? el('p', { class: 'tabpane__hint', text: m.hiddenPairNote }) : null,
      el('div', { class: 'btnrow' }, addPairButton(ctx, m.addPairTip)),
    ),
  );

  node.addEventListener('toggle', () => {
    sectionOpen = node.open;
  });

  return node;
}
