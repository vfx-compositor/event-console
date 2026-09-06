// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { MASTER_RAMP_DUCK_TARGET } from '../volume-ramp';
import { activateCameraSettings, masterRampChoices } from './topbar';

const topbarSource = readFileSync(new URL('./topbar.ts', import.meta.url), 'utf8');
const controlSource = readFileSync(new URL('../control.ts', import.meta.url), 'utf8');

describe('상단 카메라 상태 바로가기', () => {
  it('설정 탭을 연 뒤 카메라 장치 선택에 포커스한다', () => {
    const calls: string[] = [];
    const setTab = vi.fn((id: string) => calls.push(`tab:${id}`));
    const focusCamera = vi.fn(() => calls.push('focus:camera'));

    activateCameraSettings(setTab, focusCamera);

    expect(calls).toEqual(['tab:settings', 'focus:camera']);
  });
});

/**
 * 상단 바에서 전환 스위처를 걷어냈다 (U43). 같은 선택이 런처에 이미 있고, 한 화면에 두 개를
 * 두면 어느 쪽이 지금 값인지 눈으로 좇게 된다. 단축키·런처 경로는 그대로 살아 있다.
 */
describe('상단 전환 스위처 제거 (U43)', () => {
  it('상단 바는 전환 선택기를 그리지 않는다', () => {
    expect(topbarSource).not.toContain('transition-picker');
    expect(topbarSource).not.toContain('sceneTransitionMode');
  });

  it('전환 선택은 런처에 남아 있다', () => {
    const launcherSource = readFileSync(new URL('./launcher.ts', import.meta.url), 'utf8');
    expect(launcherSource).toContain('sceneTransitionMode');
  });
});

describe('볼륨 램프 버튼 (U43 · U45)', () => {
  it('→40%와 →100% 두 개를 고정 순서로 노출한다 (U74)', () => {
    // 10%는 사실상 무음이라 "깔아 두기"가 되지 않았다 — 사용자 지시로 40%로 올렸다.
    expect(masterRampChoices()).toEqual([
      { id: 'duck', target: 0.4, label: '→40%' },
      { id: 'full', target: 1, label: '→100%' },
    ]);
  });

  it('라벨은 목표값에서 만들어진다 — 숫자만 고치고 글자를 놓치는 사고를 막는다', () => {
    const duck = masterRampChoices()[0];
    expect(duck.label).toBe(`→${Math.round(duck.target * 100)}%`);
    expect(duck.target).toBe(MASTER_RAMP_DUCK_TARGET);
  });

  it('버튼은 값을 즉시 덮지 않고 램프 액션만 낸다', () => {
    expect(topbarSource).toContain("type: 'volume/rampTo'");
    expect(topbarSource).toContain('masterRampSec');
    // 램프 버튼이 저장값을 직접 패치하면 5초 램프가 아니라 컷이 된다
    expect(topbarSource).not.toMatch(/type:\s*'volume\/set',\s*axis,\s*value:\s*choice/);
  });

  it('진행 중인 램프는 버튼과 슬라이더 읽기값에 함께 반영된다', () => {
    expect(topbarSource).toContain('effectiveVolume');
    expect(topbarSource).toContain('volumeRamps[axis]');
  });

  /**
   * U45 — 미디어와 음악은 슬라이더가 따로다. 같은 컴포넌트에서 축만 바꿔 그리므로
   * 한쪽만 드래그 보류를 빠뜨리거나 한쪽 램프가 다른 축을 끌고 갈 자리가 없다.
   */
  it('두 축이 같은 컴포넌트로 그려지고 액션에 축이 실린다', () => {
    expect(topbarSource).toContain('VOLUME_AXES.map((axis) => volumeAxisControl(ctx, axis, now))');
    expect(topbarSource).toContain('function volumeAxisControl(');
    expect(topbarSource).toContain("data: { axis }");
    // 라이브 갱신은 축으로 범위를 좁힌다 — 아니면 한 축 램프가 두 슬라이더를 다 끈다
    expect(topbarSource).toContain('`[data-axis="${axis}"]`');
    // 옛 단일 마스터 경로가 남아 있으면 두 축이 서로를 덮는다
    expect(topbarSource).not.toContain('masterVolume');
  });
});

/**
 * 실사고: 슬라이더를 끌면 첫 `input`에서 dispatch → render()가 돌아 app 전체가 새로 그려지고,
 * 포인터를 붙잡고 있던 **그 input 엘리먼트가 통째로 교체**됐다. 브라우저의 암묵적 포인터
 * 캡처가 떨어져 나간 노드에 남아 드래그가 그 자리에서 끊긴다 — 클릭만 먹던 이유다.
 */
describe('볼륨 슬라이더 드래그 (U43 근본원인)', () => {
  it('포인터를 잡는 동안 재렌더를 보류하고 놓을 때 흘려보낸다', () => {
    expect(topbarSource).toContain('pointerdown');
    expect(topbarSource).toContain('ctx.holdRender');
    expect(controlSource).toContain('grabRender');
    expect(controlSource).toContain('releaseRender');
    expect(controlSource).toContain('requestRender');
  });

  it('슬라이더를 잡으면 그 축의 진행 중인 램프가 취소된다', () => {
    expect(topbarSource).toContain("type: 'volume/rampCancel'");
  });

  it('드래그 중에도 % 읽기값이 따라간다 — 재렌더가 멈춰 있으므로 직접 갱신한다', () => {
    expect(topbarSource).toContain('volume-slider__value');
    expect(topbarSource).toMatch(/paintVolumeReadout|__value['"]\)/);
  });
});
