// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  displayOperatorControlHidden,
  displayOperatorOverlayVisible,
} from './display-presentation';

describe('출력창 운영 컨트롤 표시', () => {
  it('사전미션 image-only에서만 전체화면 버튼을 숨긴다', () => {
    expect(displayOperatorControlHidden('standby', 'pre-mission')).toBe(true);
    expect(displayOperatorControlHidden('standby', 'main')).toBe(false);
  });

  it('다른 씬에서는 전체화면 버튼을 유지한다', () => {
    expect(displayOperatorControlHidden('live')).toBe(false);
    expect(displayOperatorControlHidden('score')).toBe(false);
  });

  it('사전미션에서는 배지를 거부하고 일반 대기영상에서는 요청된 오디오 배지를 허용한다', () => {
    expect(displayOperatorOverlayVisible('standby', true, 'pre-mission')).toBe(false);
    expect(displayOperatorOverlayVisible('standby', true, 'main')).toBe(true);
    expect(displayOperatorOverlayVisible('standby', false, 'main')).toBe(false);
  });

  it('다른 씬에서는 요청된 운영 배지를 표시한다', () => {
    expect(displayOperatorOverlayVisible('live', true)).toBe(true);
    expect(displayOperatorOverlayVisible('live', false)).toBe(false);
  });

  it('게임 대기 이미지도 사전미션과 같은 계약으로 배지·전체화면 버튼을 숨긴다 (U29)', () => {
    // 이미지 한 장짜리 화면이라 안내 문구가 프로젝터에 그대로 찍힌다
    expect(displayOperatorControlHidden('game', 'main', 'standby')).toBe(true);
    expect(displayOperatorOverlayVisible('game', true, 'main', 'standby')).toBe(false);
    // 오프닝은 이미지 단독이 아니므로 그대로 둔다
    expect(displayOperatorControlHidden('game', 'main', 'opening')).toBe(false);
    expect(displayOperatorOverlayVisible('game', true, 'main', 'opening')).toBe(true);
    // 게임 대기 모드가 남아 있어도 다른 씬은 영향받지 않는다
    expect(displayOperatorControlHidden('live', 'main', 'standby')).toBe(false);
    expect(displayOperatorOverlayVisible('standby', true, 'main', 'standby')).toBe(true);
  });

  it('display는 오디오 배지·전체화면 버튼 판정에 게임 모드를 함께 넘긴다', () => {
    const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
    const calls = [
      ...display.matchAll(/displayOperator(?:ControlHidden|OverlayVisible)\(([\s\S]*?)\);/g),
    ].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    // U75 — 시각 판정은 동결 스냅샷(`visualState()`/`vis`)을 읽는다. 인자로 게임 모드를
    // **함께 넘긴다**는 계약이 요점이고, 어느 상태에서 읽는지는 그 다음 문제다.
    expect(calls.filter((args) => !/(?:visualState\(\)|vis)\.sceneOpts\.game\.mode/.test(args))).toEqual([]);
  });
});
