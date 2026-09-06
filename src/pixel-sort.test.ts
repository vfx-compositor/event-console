import { describe, expect, it } from 'vitest';
import { lineHash, lineSelected, lumaOf, pixelSortInPlace, type PixelSortSpec } from './pixel-sort';

/** w×h RGBA 버퍼. `pick(x,y)`가 [r,g,b] 를 준다. */
function image(w: number, h: number, pick: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = pick(x, y);
      const p = (y * w + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return data;
}

function column(data: Uint8ClampedArray, w: number, h: number, x: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < h; y += 1) {
    const p = (y * w + x) * 4;
    out.push(lumaOf(data[p], data[p + 1], data[p + 2]));
  }
  return out;
}

function row(data: Uint8ClampedArray, w: number, y: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < w; x += 1) {
    const p = (y * w + x) * 4;
    out.push(lumaOf(data[p], data[p + 1], data[p + 2]));
  }
  return out;
}

const spec = (over: Partial<PixelSortSpec> = {}): PixelSortSpec => ({
  width: 8,
  height: 8,
  axis: 'vertical',
  threshold: 100,
  coverage: 1,
  seed: 0,
  ...over,
});

describe('픽셀 소터 (U26b)', () => {
  it('임계값을 넘는 구간을 밝기 오름차순으로 정렬한다', () => {
    // 전 열이 밝고 위에서 아래로 어두워지는 그림 → 정렬하면 뒤집힌다
    const data = image(8, 8, (_x, y) => {
      const v = 240 - y * 10;
      return [v, v, v];
    });
    const before = column(data, 8, 8, 3);
    expect(pixelSortInPlace(data, spec())).toBe(8);
    const after = column(data, 8, 8, 3);
    expect(after).toEqual([...before].sort((a, b) => a - b));
    for (let i = 1; i < after.length; i += 1) expect(after[i]).toBeGreaterThanOrEqual(after[i - 1]);
  });

  it('임계값 아래 픽셀은 건드리지 않는다 — 마스크 밖은 원본 그대로다', () => {
    // 위 절반만 밝다
    const data = image(8, 8, (_x, y) => {
      const v = y < 4 ? 200 - y * 10 : 20;
      return [v, v, v];
    });
    pixelSortInPlace(data, spec());
    const after = column(data, 8, 8, 0);
    expect(after.slice(4)).toEqual([20, 20, 20, 20]);
    expect(after.slice(0, 4)).toEqual([170, 180, 190, 200]);
  });

  it('가로 방향은 행을 정렬한다', () => {
    const data = image(8, 8, (x) => {
      const v = 240 - x * 10;
      return [v, v, v];
    });
    pixelSortInPlace(data, spec({ axis: 'horizontal' }));
    const after = row(data, 8, 2);
    for (let i = 1; i < after.length; i += 1) expect(after[i]).toBeGreaterThanOrEqual(after[i - 1]);
  });

  it('색은 보존된다 — 밝기만 재배치하고 픽셀을 새로 만들지 않는다', () => {
    const data = image(4, 4, (_x, y) => (y % 2 === 0 ? [200, 40, 40] : [120, 200, 60]));
    const copy = new Uint8ClampedArray(data);
    pixelSortInPlace(data, spec({ width: 4, height: 4 }));
    const bag = (buf: Uint8ClampedArray) =>
      [...Array(16).keys()].map((i) => `${buf[i * 4]},${buf[i * 4 + 1]},${buf[i * 4 + 2]}`).sort();
    expect(bag(data)).toEqual(bag(copy));
  });

  it('길이 1짜리 구간은 건너뛴다 (정렬해도 그대로다)', () => {
    const data = image(4, 4, (_x, y) => (y === 1 ? [200, 200, 200] : [10, 10, 10]));
    expect(pixelSortInPlace(data, spec({ width: 4, height: 4 }))).toBe(0);
  });

  it('coverage 0이면 아무것도 하지 않는다 (첫 프레임 = 라이브)', () => {
    const data = image(8, 8, () => [200, 200, 200]);
    const copy = new Uint8ClampedArray(data);
    expect(pixelSortInPlace(data, spec({ coverage: 0 }))).toBe(0);
    expect([...data]).toEqual([...copy]);
  });

  it('coverage가 오르면 무너지는 열이 늘어난다 (단조)', () => {
    const counts = [0.2, 0.5, 0.9, 1].map((coverage) => {
      let n = 0;
      for (let i = 0; i < 480; i += 1) if (lineSelected(i, spec({ coverage, width: 480 }))) n += 1;
      return n;
    });
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts[3]).toBe(480);
  });

  it('같은 seed는 같은 열을 고른다 — 프레임마다 깜빡이지 않는다', () => {
    const a = [...Array(200).keys()].map((i) => lineHash(i, 7));
    const b = [...Array(200).keys()].map((i) => lineHash(i, 7));
    expect(a).toEqual(b);
    // seed가 바뀌면 선택이 달라진다 (번져 나감)
    expect(a).not.toEqual([...Array(200).keys()].map((i) => lineHash(i, 8)));
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('빈 이미지나 잘못된 크기는 조용히 넘어간다', () => {
    expect(pixelSortInPlace(new Uint8ClampedArray(0), spec({ width: 0, height: 0 }))).toBe(0);
  });
});
