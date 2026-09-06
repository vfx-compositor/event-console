/**
 * 대기 화면 사진 배경 켬/끔 크로스디졸브(U19) — 순수 계산만.
 *
 * 예전에는 `standbyBackdrop` 토글이 `<video>`의 `src`를 그 자리에서 갈아치웠다. `renderInto`가
 * HTML 문자열 변화로 stage를 통째로 교체하므로 화면이 한 프레임 깜빡이고 영상이 처음부터 다시 돌았다.
 * 이제 씬은 light/dark 두 영상을 **항상 함께** 렌더하고(HTML 고정), 어느 쪽을 보여줄지는
 * display가 이 함수들로 계산한 opacity로만 정한다.
 *
 * ## 세 레이어가 한 계산식에서 나온다
 * dark 영상 · light 영상 · 사진 백드롭은 **같은 progress 하나**에서 파생된다. 레이어마다 곡선을
 * 따로 두면 크로스 중간에 사진이 먼저 나타나거나 light가 늦게 사라지는 어긋남이 반드시 생긴다
 * (슬라이더 핸들·fill을 한 식에서 뽑는 것과 같은 원칙).
 */

import { clampUnit, isRampDone, makeRamp, rampTarget, rampValueAt, type ValueRamp } from './fade-ramp';
import type { AppState, SceneId } from './types';

export interface StandbyBackdropLayers {
  /** OFF 스택 — 밝은 대기 영상 (불투명, 하단) */
  off: number;
  /** ON 스택 — 알파 대기 영상 + 사진 백드롭 + 검정 지면 (상단) */
  on: number;
}

/**
 * progress 0 = 사진 배경 꺼짐(OFF 스택), 1 = 켜짐(ON 스택).
 *
 * ## 왜 두 레이어를 동시에 줄이지 않는가 — "둔탁함"의 정체
 * 예전에는 `{ light: 1 - p, dark: p }`로 **양쪽을 동시에 감쇠**했다. 두 영상은 검정 무대 위에
 * 겹쳐 있으므로 중간에서 합성 가중치가 1에 못 미친다: p=0.5면 0.5·dark + 0.5·(0.5·light) =
 * 0.75, 즉 **25%가 검정으로 새어 나온다.** 화면은 디졸브 중간에 한 번 푹 꺼졌다가 올라오고,
 * 그게 사용자가 말한 "둔탁하다"였다.
 *
 * 고전적인 A→B 크로스디졸브의 해법 그대로 간다 — **하단 스택은 1을 유지**하고 상단만 0→1로
 * 올린다. 이러면 합성 가중치가 항상 1 이상이라 검정이 새지 않는다. 성립 조건은 두 스택이
 * 각자 불투명해야 한다는 것이고, 그래서 ON 스택은 CSS에서 자기 검정 지면을 갖는다
 * (`.standby-stack--on { background: #000 }`). 알파인 dark 영상의 투명한 구멍으로 사진과
 * 검정이 비치는 "켠 상태의 최종 그림"이 스택 안에서 먼저 완성된 뒤, 그 그림 전체가
 * 한 덩어리로 페이드 인한다.
 *
 * 양 끝값은 예전과 **정확히 같다**(0 → light만, 1 → dark+사진만). 달라진 것은 중간뿐이다.
 * 하단을 0으로 내리는 것은 상단이 이미 완전히 덮은 뒤(p=1)라 눈에 보이는 변화가 없고,
 * 목적은 가려진 1080p 영상의 디코딩을 멈추는 것뿐이다.
 */
export function standbyBackdropLayers(progress: number): StandbyBackdropLayers {
  const p = clampUnit(progress);
  return { off: p >= 1 ? 0 : 1, on: p };
}

/** 두 대기 영상의 재생 시각 허용 오차(초). 이보다 벌어지면 맞춘다. */
export const STANDBY_SYNC_TOLERANCE_SEC = 0.1;

/**
 * 인커밍 대기 영상을 아웃고잉 쪽 시각으로 맞출 값 — 맞출 필요가 없으면 `null`.
 *
 * light/dark는 **같은 모션의 밝기·알파 변형**이다(둘 다 14.017초 60fps). 그런데 보이지 않는
 * 쪽은 디코딩을 멈춰 두므로, 다시 켤 때 낡은 프레임에 멈춰 있다. 그 상태로 디졸브를 걸면
 * 같은 장면 두 벌이 서로 다른 시점을 보여 주며 겹친다 — 물체가 두 개로 갈라져 미끄러지는
 * 것처럼 보이고, 이것이 "자연스럽지 않다"의 두 번째 원인이다.
 *
 * 루프 영상이라 나머지 연산으로 접고, 경계를 넘는 차이(9.9초 ↔ 0.05초)는 원형 거리로 잰다.
 */
export function standbyVideoResyncTime(
  sourceSec: number,
  targetSec: number,
  durationSec: number | undefined,
  toleranceSec: number = STANDBY_SYNC_TOLERANCE_SEC,
): number | null {
  if (!Number.isFinite(sourceSec) || !Number.isFinite(targetSec)) return null;
  const loop =
    typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0
      ? durationSec
      : null;
  const wrap = (v: number) => (loop === null ? Math.max(0, v) : ((v % loop) + loop) % loop);
  const wanted = wrap(sourceSec);
  const current = wrap(targetSec);
  const raw = Math.abs(wanted - current);
  const drift = loop === null ? raw : Math.min(raw, loop - raw);
  return drift > toleranceSec ? wanted : null;
}

/**
 * 크로스디졸브를 실제로 보여줄 수 있는 화면인가.
 *
 * 대기 영상 두 장이 DOM에 떠 있는 곳에서만 크로스가 의미 있다. 사전미션(이미지 한 장)이나
 * 다른 씬에 있는 동안 토글하면 크로스 없이 목표 상태로 바로 간다 — 다음에 대기 화면으로
 * 돌아왔을 때 10초짜리 페이드가 뒤늦게 시작되면 운영자가 "왜 지금 바뀌지"를 겪는다.
 *
 * 게임 대기(U29)는 여기서 빠졌다. 종목별 고정 이미지 한 장을 그리게 되면서 크로스할 영상도
 * 사진 슬롯도 DOM에 없다 — 남겨 두면 사전미션과 똑같이 "사진 런타임만 도는" 낭비가 된다.
 * 그래서 `gameMode` 인자 자체를 지웠다. 인자가 남아 있으면 호출부가 다시 그것을 믿는다.
 */
export function standbyCrossfadeScene(
  scene: SceneId,
  standbyMode: AppState['sceneOpts']['standby']['mode'],
): boolean {
  if (standbyMode === 'pre-mission') return false;
  return scene === 'standby';
}

/**
 * 새 사진 세션의 **첫 장을 페이드 없이 끊어 넣을 것인가** (U40).
 *
 * 대기 화면 밖에서 사진 배경을 켜고 곧장 들어오면 크로스디졸브는 이미 끝나 있다
 * (`stepBackdropFade`가 스냅한다). 그런데 사진 세션은 진입할 때마다 처음부터 다시 시작하므로
 * 첫 장이 빈 화면에서 페이드 인한다 — 스택은 켜져 있는데 그 안이 잠깐 비어 있어
 * "켜진 채로 로드되지 않았다"로 보인다. 크로스가 이미 끝났으면 첫 장도 끊어 넣는다.
 *
 * 반대로 대기 화면을 **보고 있는 동안** 토글하면 진행률이 0에서 출발한다. 그때는 스택 전체가
 * 10초에 걸쳐 올라오므로 사진까지 따로 페이드시킬 필요가 없고, 끊어 넣어도 스택 뒤에 가려
 * 보이지 않는다 — 그래서 기준을 "지금 크로스가 도는가" 하나로 둔다.
 */
export function standbyPhotoEntryCut(progress: number, target: number): boolean {
  return clampUnit(target) >= 1 && clampUnit(progress) >= 1;
}

/**
 * 사진 재생기를 계속 돌려야 하는가 — 설정이 꺼졌어도 크로스가 남아 있으면 계속 돌린다.
 * 여기서 곧장 끄면 10초 페이드가 시작되는 순간 사진만 먼저 사라진다.
 */
export function backdropRuntimeOn(settingOn: boolean, progress: number): boolean {
  return settingOn || clampUnit(progress) > 0;
}

/**
 * 크로스디졸브의 **전체 상태**. display는 이 객체 하나만 들고 있고, 값을 직접 쓰지 않는다.
 *
 * 왜 통째로 순수 함수에 맡기는가: `snapPending`을 바깥에서 만질 수 있게 두었더니 상태 방송
 * 콜백이 매 방송마다 그것을 다시 세워, 램프 분기가 **한 번도 도달하지 않는** 사고가 났다.
 * 화면상으로는 "크로스디졸브 기능이 통째로 없는 것"과 구별되지 않는다. 유일한 writer를
 * 이 함수로 못 박아 같은 사고가 다시 나지 않게 한다.
 */
export interface BackdropFadeState {
  /** 0 = 사진 배경 꺼짐(light 영상), 1 = 켜짐(dark 영상 + 사진 백드롭) */
  progress: number;
  ramp: ValueRamp | null;
  /** 첫 상태 방송을 화면에 반영하기 전인가 — 그동안은 크로스 없이 목표로 스냅한다 */
  snapPending: boolean;
}

export interface BackdropFadeInput {
  /** 설정이 원하는 최종 상태 (1 = 사진 배경 ON) */
  target: number;
  /** 대기 영상 두 장이 실제로 떠 있는 화면인가 (`standbyCrossfadeScene`) */
  crossfadeHere: boolean;
  /** 리더의 첫 상태 방송을 받았는가 */
  sawFirstSyncState: boolean;
  fadeSec: number;
  now: number;
}

export function initialBackdropFade(standbyBackdrop: boolean): BackdropFadeState {
  return { progress: standbyBackdrop ? 1 : 0, ramp: null, snapPending: true };
}

/**
 * 한 프레임 전진. 세 갈래뿐이다.
 *  1) 스냅 — 크로스할 화면이 아니거나 첫 방송 전이면 목표로 즉시 간다.
 *  2) 램프 시작 — 목표가 지금 향하는 곳과 다르면 **현재 값에서** 새 램프를 건다(점프 금지).
 *  3) 램프 전진 — 진행 중이면 값을 갱신하고 끝났으면 정확히 끝값에 맞춘다.
 */
export function stepBackdropFade(
  prev: BackdropFadeState,
  input: BackdropFadeInput,
): BackdropFadeState {
  const target = clampUnit(input.target);

  if (!input.crossfadeHere || prev.snapPending) {
    return {
      progress: target,
      ramp: null,
      // 첫 방송을 실제로 화면에 반영한 뒤에야 크로스를 연다. 그 전에는 값이 또 갱신될 수 있다.
      snapPending: prev.snapPending ? !input.sawFirstSyncState : false,
    };
  }

  let ramp = prev.ramp;
  if (target !== rampTarget(ramp, prev.progress)) {
    ramp = makeRamp(prev.progress, target, input.fadeSec, input.now);
  }
  if (!ramp) return { progress: prev.progress, ramp: null, snapPending: false };

  const progress = rampValueAt(ramp, input.now);
  return isRampDone(ramp, input.now)
    ? { progress: ramp.to, ramp: null, snapPending: false }
    : { progress, ramp, snapPending: false };
}
