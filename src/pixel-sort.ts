/**
 * 픽셀 소터 — 분위기 반전 디스토션의 **주효과** (U26b).
 *
 * 밝기 임계값을 넘는 연속 구간(span)을 밝기 순으로 정렬한다. 정렬된 구간은 원래 그림의 색을
 * 그대로 유지한 채 한 방향으로 길게 늘어져, 화면이 흘러내리거나 녹아내리는 것처럼 보인다.
 * 진행에 따라 임계값을 낮추면 마스크가 넓어지면서 더 많은 영역이 무너진다.
 *
 * ## 왜 계수 정렬인가
 * 실시간이다. 480×270에서 열 480개를 매 프레임 비교 정렬하면 100만 번 넘는 비교가 든다.
 * 밝기는 0~255 정수라 **계수 정렬이 O(n)**으로 끝난다 — 비교가 아예 없다.
 *
 * 이 파일은 순수하다. `data`를 제자리에서 고치고, 무작위성은 seed로만 들어온다.
 */

export type PixelSortAxis = 'vertical' | 'horizontal';

/** ITU-R BT.601 밝기 (0~255 정수). 정렬 키이자 임계 판정 기준이다. */
export function lumaOf(r: number, g: number, b: number): number {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

export interface PixelSortSpec {
  width: number;
  height: number;
  axis: PixelSortAxis;
  /** 0~255. 이 밝기 **이상**인 픽셀만 정렬 대상 */
  threshold: number;
  /** 0~1. 정렬을 적용할 열(또는 행)의 비율 */
  coverage: number;
  /** 결정적 열 선택 — 같은 seed면 같은 열이 무너진다(프레임마다 깜빡이지 않게) */
  seed: number;
}

/**
 * 결정적 0~1 해시. 열마다 난수를 새로 뽑으면 매 프레임 다른 열이 무너져 깜빡인다.
 * seed를 천천히 움직이면 무너지는 열이 서서히 번진다.
 */
export function lineHash(index: number, seed: number): number {
  let h = (index * 374761393 + seed * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 이 열(행)을 정렬할 것인가 */
export function lineSelected(index: number, spec: PixelSortSpec): boolean {
  if (spec.coverage <= 0) return false;
  if (spec.coverage >= 1) return true;
  return lineHash(index, spec.seed) < spec.coverage;
}

let histogram = new Int32Array(256);
let offsets = new Int32Array(256);
let scratch = new Uint8Array(0);
let lumas = new Uint8Array(0);

function ensureScratch(len: number): void {
  if (scratch.length < len * 4) scratch = new Uint8Array(len * 4);
  if (lumas.length < len) lumas = new Uint8Array(len);
}

/**
 * 한 span을 밝기 오름차순으로 정렬한다. `base`는 첫 픽셀의 바이트 오프셋, `step`은 다음
 * 픽셀까지의 바이트 간격(세로 정렬이면 한 줄 길이)이다.
 */
function sortSpan(data: Uint8ClampedArray, base: number, step: number, count: number): void {
  ensureScratch(count);
  histogram.fill(0);
  for (let i = 0; i < count; i += 1) {
    const p = base + i * step;
    const l = lumaOf(data[p], data[p + 1], data[p + 2]);
    lumas[i] = l;
    histogram[l] += 1;
    scratch[i * 4] = data[p];
    scratch[i * 4 + 1] = data[p + 1];
    scratch[i * 4 + 2] = data[p + 2];
    scratch[i * 4 + 3] = data[p + 3];
  }
  let running = 0;
  for (let v = 0; v < 256; v += 1) {
    offsets[v] = running;
    running += histogram[v];
  }
  for (let i = 0; i < count; i += 1) {
    const slot = offsets[lumas[i]];
    offsets[lumas[i]] = slot + 1;
    const p = base + slot * step;
    data[p] = scratch[i * 4];
    data[p + 1] = scratch[i * 4 + 1];
    data[p + 2] = scratch[i * 4 + 2];
    data[p + 3] = scratch[i * 4 + 3];
  }
}

/**
 * 제자리 픽셀 정렬. 정렬한 span 수를 돌려준다(0이면 화면이 원본 그대로다 — 계측·테스트용).
 *
 * 길이 2 미만 span은 건너뛴다 — 한 픽셀은 정렬해도 그대로다.
 */
export function pixelSortInPlace(data: Uint8ClampedArray, spec: PixelSortSpec): number {
  const { width, height, axis } = spec;
  if (width <= 0 || height <= 0 || spec.coverage <= 0) return 0;
  const threshold = Math.max(0, Math.min(255, spec.threshold));
  const lineCount = axis === 'vertical' ? width : height;
  const spanLen = axis === 'vertical' ? height : width;
  // 세로 정렬이면 다음 픽셀은 한 줄 아래(= width * 4 바이트), 가로면 바로 옆(= 4 바이트)
  const step = axis === 'vertical' ? width * 4 : 4;
  const lineStep = axis === 'vertical' ? 4 : width * 4;

  let sorted = 0;
  for (let line = 0; line < lineCount; line += 1) {
    if (!lineSelected(line, spec)) continue;
    const lineBase = line * lineStep;
    let runStart = -1;
    for (let i = 0; i < spanLen; i += 1) {
      const p = lineBase + i * step;
      const bright = lumaOf(data[p], data[p + 1], data[p + 2]) >= threshold;
      if (bright && runStart < 0) runStart = i;
      else if (!bright && runStart >= 0) {
        if (i - runStart >= 2) {
          sortSpan(data, lineBase + runStart * step, step, i - runStart);
          sorted += 1;
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && spanLen - runStart >= 2) {
      sortSpan(data, lineBase + runStart * step, step, spanLen - runStart);
      sorted += 1;
    }
  }
  return sorted;
}
