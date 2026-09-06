/**
 * 분위기 반전 글리치 — **한 프레임에 무엇을 그릴지**를 정하는 순수 계산만 (U26).
 *
 * ## 왜 이 파일이 따로 있는가
 * 앞선 사고가 정확히 이 자리에서 났다. 글리치는 CSS 애니메이션 한 장으로 되어 있었고,
 * 그 CSS가 통째로 빠진 채 배포돼 **아무것도 보이지 않았다.** 화면에 뭔가 나온다는 사실을
 * 검증할 방법이 없었기 때문이다. 이제 글리치는 캔버스에 실제 화면 내용을 그려서 망가뜨리는
 * 방식이고, "무엇을 얼마나 망가뜨리는가"는 전부 여기서 값으로 나온다 — DOM 없이 단언할 수 있다.
 *
 * 난수는 주입받는다(`rand`). 그래야 테스트가 결정적이고, 같은 프레임을 두 번 그려도 같은 그림이 된다.
 */

export interface GlitchSlice {
  /** 띠의 위쪽 y (캔버스 픽셀) */
  y: number;
  /** 띠 높이 */
  h: number;
  /** 좌우 밀림 (px, 부호 있음) */
  dx: number;
}

export interface GlitchBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  /** true면 밝은 블록, false면 검은 블록 */
  bright: boolean;
}

export interface GlitchFrame {
  /** 0~1. 시간이 갈수록 오르고 `strength`가 상한을 정한다 */
  intensity: number;
  /** 가로 슬라이스 밀림 */
  slices: GlitchSlice[];
  /** RGB 채널 분리 폭 (px) */
  rgbSplitPx: number;
  /** 블록 노이즈 */
  blocks: GlitchBlock[];
  /** 라인 드롭아웃(까맣게 지워지는 가로줄) */
  dropouts: { y: number; h: number }[];
  /** 밝기 플리커 배수 (1 = 그대로) */
  brightness: number;
  /** 스캔라인 오버레이 불투명도 */
  scanlineAlpha: number;
}

export interface GlitchFrameInput {
  elapsedMs: number;
  durationMs: number;
  /** 0~1 사용자 설정 세기 */
  strength: number;
  width: number;
  height: number;
  /** [0,1) 난수. 테스트에서 결정적 시퀀스를 주입한다 */
  rand: () => number;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

/**
 * 시간에 따른 세기 — **스멀스멀** 올라온다 (U26b).
 *
 * `t^3.5` 하나로 요구되는 모양이 전부 나온다.
 *  · t=0     → 0      — 첫 프레임은 라이브와 **픽셀 단위로 같다**(효과 0). 화면비 검증의 기준점이다.
 *  · t=0.4   → 0.04   — 앞 40%는 사실상 감지 불가
 *  · t=0.8   → 0.46   — 중반부터 가속
 *  · t=1     → 1      — 마지막 20%에서 붕괴
 *
 * 바닥값을 주지 않는 것이 계약이다. 첫 프레임에 조금이라도 효과가 있으면 라이브에서 넘어오는
 * 순간 화면이 튀고, 화면비 일치 검증도 성립하지 않는다.
 */
export const GLITCH_ONSET_EXPONENT = 3.5;

export function glitchIntensityAt(elapsedMs: number, durationMs: number, strength: number): number {
  const s = clamp01(strength);
  if (s === 0) return 0;
  if (!(durationMs > 0)) return s;
  const t = clamp01(elapsedMs / durationMs);
  return s * Math.pow(t, GLITCH_ONSET_EXPONENT);
}

/**
 * 픽셀 정렬 임계값 (0~255). 세기가 오를수록 내려가 마스크가 넓어진다.
 *
 * 240에서 시작하는 이유: 처음에는 **가장 밝은 하이라이트만** 흘러내린다. 조명 반사나 흰 옷
 * 가장자리가 먼저 늘어지고, 그 다음 중간톤이, 마지막에 화면 전체가 무너진다.
 */
export function sortThresholdAt(intensity: number): number {
  return Math.round(240 - 225 * clamp01(intensity));
}

/** 정렬을 적용할 열(행) 비율. 세기보다 빨리 올라 "번져 나가는" 인상을 만든다. */
export function sortCoverageAt(intensity: number): number {
  return clamp01(Math.pow(clamp01(intensity), 0.6));
}

/** 글리치가 끝났는가 (control 타이머와 별개로 display가 그리기를 멈추는 기준) */
export function isGlitchComplete(elapsedMs: number, durationMs: number): boolean {
  return durationMs <= 0 || elapsedMs >= durationMs;
}

function randRange(rand: () => number, min: number, max: number): number {
  return min + clamp01(rand()) * (max - min);
}

/**
 * 한 프레임의 글리치 명세. 캔버스 그리기는 display가 하고 여기서는 값만 만든다.
 *
 * 슬라이스는 겹치지 않게 위에서 아래로 훑으며 자른다 — 무작위 y로 뽑으면 같은 띠를 두 번
 * 밀어 원본이 사라지는 프레임이 나온다.
 */
export function glitchFrame(input: GlitchFrameInput): GlitchFrame {
  const intensity = glitchIntensityAt(input.elapsedMs, input.durationMs, input.strength);
  const w = Math.max(1, Math.round(input.width));
  const h = Math.max(1, Math.round(input.height));

  // 보조 효과다 — 주효과는 픽셀 소트다(U26b). 예전 값의 절반 이하로 낮춘다.
  const sliceCount = Math.round(4 + 6 * intensity);
  const slices: GlitchSlice[] = [];
  if (intensity > 0) {
    const band = h / sliceCount;
    for (let i = 0; i < sliceCount; i += 1) {
      const top = Math.round(i * band);
      const bottom = Math.round((i + 1) * band);
      // 띠마다 전부 밀지 않는다 — 성한 띠가 섞여 있어야 "밀렸다"가 보인다
      if (rand01(input.rand) > 0.55 * intensity + 0.2) continue;
      const dx = Math.round(randRange(input.rand, -18, 18) * intensity);
      if (dx === 0) continue;
      slices.push({ y: top, h: Math.max(1, bottom - top), dx });
    }
  }

  const blockCount = Math.round(4 * intensity);
  const blocks: GlitchBlock[] = [];
  for (let i = 0; i < blockCount; i += 1) {
    const bw = Math.round(randRange(input.rand, w * 0.02, w * 0.18));
    const bh = Math.round(randRange(input.rand, h * 0.01, h * 0.06));
    blocks.push({
      x: Math.round(randRange(input.rand, 0, Math.max(0, w - bw))),
      y: Math.round(randRange(input.rand, 0, Math.max(0, h - bh))),
      w: Math.max(1, bw),
      h: Math.max(1, bh),
      bright: input.rand() < 0.35,
    });
  }

  const dropoutCount = Math.round(2 * intensity);
  const dropouts: { y: number; h: number }[] = [];
  for (let i = 0; i < dropoutCount; i += 1) {
    const dh = Math.max(1, Math.round(randRange(input.rand, 1, 6)));
    dropouts.push({ y: Math.round(randRange(input.rand, 0, Math.max(0, h - dh))), h: dh });
  }

  return {
    intensity,
    slices,
    rgbSplitPx: Math.round(7 * intensity),
    blocks,
    dropouts,
    // 0.82~1.35 사이를 오간다. 1을 넘는 순간이 있어야 "번쩍"이 생긴다.
    brightness: intensity === 0 ? 1 : randRange(input.rand, 1 - 0.1 * intensity, 1 + 0.18 * intensity),
    scanlineAlpha: 0.16 * clamp01(intensity),
  };
}

function rand01(rand: () => number): number {
  return clamp01(rand());
}

// ---------------------------------------------------------------- 라이브 화면과의 일치 (U26b)

export interface CoverRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * `object-fit: cover`가 실제로 잘라 쓰는 **원본 사각형**.
 *
 * 왜 필요한가: 글리치 캔버스는 카메라 영상을 통째로 늘려 그렸는데, 화면의 라이브는
 * `.cam-video { object-fit: cover }`로 크롭해서 보여 준다. 카메라가 4:3이면 두 그림의
 * 화면비가 달라, 라이브에서 글리치로 넘어가는 순간 화면이 살짝 튀었다(사용자 관찰).
 * 여기서 같은 크롭을 계산해 `drawImage`의 소스 사각형으로 넘기면 첫 프레임이 정확히 일치한다.
 */
export function coverSourceRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): CoverRect {
  if (!(srcW > 0) || !(srcH > 0) || !(dstW > 0) || !(dstH > 0)) {
    return { sx: 0, sy: 0, sw: Math.max(0, srcW), sh: Math.max(0, srcH) };
  }
  // cover = 두 축 중 **큰** 배율. 그 배율로 dst를 채우면 남는 쪽이 잘린다.
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const sw = Math.min(srcW, dstW / scale);
  const sh = Math.min(srcH, dstH / scale);
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

// ---------------------------------------------------------------- 암전 (U26b)

/** 글리치 구간에서 검정이 끼어들기 시작하는 지점 (0~1) */
export const BLACK_OVERLAP_START = 0.65;
/**
 * 전환 전체 길이(ms)와 그중 글리치 단계 길이(ms) (U53).
 *
 * 정본은 `moodTotalSec` 하나다. 글리치는 거기서 암전 길이를 뺀 나머지 — 두 값을 각각 저장하면
 * 합이 15초가 아니게 되고, 그러면 검정이 걷히는 시각과 영상의 첫 그림이 어긋난다.
 */
export function moodTotalMs(settings: { moodTotalSec: number }): number {
  return Math.max(0, settings.moodTotalSec) * 1000;
}

export function moodGlitchMs(settings: { moodTotalSec: number; moodBlackoutSec: number }): number {
  return Math.max(0, moodTotalMs(settings) - Math.max(0, settings.moodBlackoutSec) * 1000);
}

/** 글리치가 끝나는 순간의 검정 불투명도 — 나머지는 blackout 단계가 채운다 */
export const BLACK_AT_GLITCH_END = 0.55;

function easeInOutQuadLocal(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

/**
 * 검정 레이어 불투명도. **디스토션 마지막 구간과 겹친다** — 화면이 무너지는 동안 검정이
 * 스멀스멀 덮고, 다 무너진 뒤 남은 만큼을 blackout 단계가 마저 채운다.
 * 단계가 바뀌는 지점에서 값이 이어지도록 `BLACK_AT_GLITCH_END`를 양쪽이 공유한다.
 *
 * U53: 글리치는 검정이 1에 닿을 때까지 **계속 심해진다**(`glitchIntensityAt`의 기준 시간이
 * 단계가 아니라 전환 전체다). 그래서 이 곡선의 역할도 "글리치가 끝난 뒤 덮기"가 아니라
 * "무너지는 그림 위에 끝까지 겹쳐 오르기"다.
 */
export function moodBlackAt(input: {
  phase: 'idle' | 'glitch' | 'blackout' | 'crossfade';
  phaseElapsedMs: number;
  glitchMs: number;
  blackoutMs: number;
}): number {
  if (input.phase === 'crossfade') return 1;
  if (input.phase === 'blackout') {
    if (!(input.blackoutMs > 0)) return 1;
    const t = clamp01(input.phaseElapsedMs / input.blackoutMs);
    return BLACK_AT_GLITCH_END + (1 - BLACK_AT_GLITCH_END) * easeInOutQuadLocal(t);
  }
  if (input.phase !== 'glitch') return 0;
  if (!(input.glitchMs > 0)) return BLACK_AT_GLITCH_END;
  const t = clamp01(input.phaseElapsedMs / input.glitchMs);
  if (t <= BLACK_OVERLAP_START) return 0;
  const local = (t - BLACK_OVERLAP_START) / (1 - BLACK_OVERLAP_START);
  return BLACK_AT_GLITCH_END * easeInOutQuadLocal(clamp01(local));
}
