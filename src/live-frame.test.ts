// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  LIVE_FRAME_DARK_SRC,
  LIVE_FRAME_MODES,
  LIVE_FRAME_SCRIM_ALPHA,
  LIVE_FRAME_SCRIM_FILL,
  isPureCameraOverlay,
  liveFrameVisible,
  liveOverlayAllOff,
  normalizeLiveFrameMode,
} from './live-frame';
import { buildCue, cueActions } from './cue';
import { createInitialState, migrate, reducer } from './state';
import type { DeepPartialSceneOpts } from './state';
import type { AppState, SceneId } from './types';
import { ATHLETE_OATH_IMAGE } from './scenes/standby';

const displaySource = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
const displayCss = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');
const standbySource = readFileSync(new URL('./scenes/standby.ts', import.meta.url), 'utf8');

describe('라이브 다크 프레임 — 판정 (U118)', () => {
  const base = {
    scene: 'live',
    mode: 'dark-standby' as const,
    moodActive: false,
    moodPhase: 'idle' as const,
  };

  it('중계 씬에서 모드가 켜져 있을 때만 나온다', () => {
    expect(liveFrameVisible(base)).toBe(true);
    expect(liveFrameVisible({ ...base, mode: 'none' })).toBe(false);
    expect(liveFrameVisible({ ...base, scene: 'standby' })).toBe(false);
    expect(liveFrameVisible({ ...base, scene: 'submit' })).toBe(false);
  });

  it('글리치 동안에는 남는다 — 캔버스가 이 영상에서 픽셀을 읽어 간다 (U91 계약)', () => {
    expect(liveFrameVisible({ ...base, moodActive: true, moodPhase: 'glitch' })).toBe(true);
  });

  it('검정이 덮은 뒤에는 사라진다 — 반전 영상이 화면의 주인이다', () => {
    expect(liveFrameVisible({ ...base, moodActive: true, moodPhase: 'blackout' })).toBe(false);
    expect(liveFrameVisible({ ...base, moodActive: true, moodPhase: 'crossfade' })).toBe(false);
  });
});

describe('라이브 다크 프레임 — 화이트리스트 (U118)', () => {
  it('모르는 값과 없는 값은 똑같이 none이다', () => {
    expect(normalizeLiveFrameMode(undefined)).toBe('none');
    expect(normalizeLiveFrameMode(null)).toBe('none');
    expect(normalizeLiveFrameMode('dark_standby')).toBe('none');
    expect(normalizeLiveFrameMode('standby-dark')).toBe('none');
    expect(normalizeLiveFrameMode(7)).toBe('none');
  });

  it('아는 값은 그대로 통과한다', () => {
    for (const mode of LIVE_FRAME_MODES) expect(normalizeLiveFrameMode(mode)).toBe(mode);
  });

  it('migrate가 저장본의 이상한 값을 none으로 접는다', () => {
    const raw = JSON.parse(JSON.stringify(createInitialState()));
    raw.sceneOpts.liveOverlay.frame = 'aurora';
    expect(migrate(raw).sceneOpts.liveOverlay.frame).toBe('none');
  });

  it('migrate가 아는 값은 지우지 않는다', () => {
    const raw = JSON.parse(JSON.stringify(createInitialState()));
    raw.sceneOpts.liveOverlay.frame = 'dark-standby';
    expect(migrate(raw).sceneOpts.liveOverlay.frame).toBe('dark-standby');
  });

  it('기본 상태는 프레임 없음이다', () => {
    expect(createInitialState().sceneOpts.liveOverlay.frame).toBe('none');
  });
});

describe('라이브 다크 프레임 — 끈적이지 않는다 (U118)', () => {
  const setScene = (state: AppState, scene: SceneId, opts?: DeepPartialSceneOpts): AppState =>
    reducer(state, { type: 'scene/set', scene, opts });

  it('명시한 씬 전환에서만 켜진다', () => {
    const on = setScene(createInitialState(), 'live', {
      liveOverlay: { frame: 'dark-standby' },
    });
    expect(on.sceneOpts.liveOverlay.frame).toBe('dark-standby');
  });

  it('다음 scene/set이 명시하지 않으면 꺼진다 — 2부 톤이 1부 중계로 새지 않는다', () => {
    const on = setScene(createInitialState(), 'live', {
      liveOverlay: { frame: 'dark-standby' },
    });
    const nextLive = setScene(on, 'live', { liveOverlay: { badge: 'curling', scorebar: true } });
    expect(nextLive.sceneOpts.liveOverlay.frame).toBe('none');
    expect(setScene(on, 'standby').sceneOpts.liveOverlay.frame).toBe('none');
  });

  it('씬 안에서는 sceneOpts/patch로 계속 켜고 끌 수 있다 (런처·1부 컨트롤 자리)', () => {
    const live = setScene(createInitialState(), 'live');
    const patched = reducer(live, {
      type: 'sceneOpts/patch',
      patch: { liveOverlay: { frame: 'dark-standby' } },
    });
    expect(patched.sceneOpts.liveOverlay.frame).toBe('dark-standby');
  });
});

describe('라이브 다크 프레임 — 큐 (U118)', () => {
  const items = buildCue();

  it('part2-live 큐 하나만 프레임을 켠다', () => {
    const turnsOn = items.filter((i) => i.opts?.liveOverlay?.frame === 'dark-standby');
    expect(turnsOn.map((i) => i.id)).toEqual(['part2-live']);
  });

  it('part2-live의 scene/set이 프레임을 싣고 나간다', () => {
    const index = items.findIndex((i) => i.id === 'part2-live');
    const actions = cueActions(items[index], index);
    const set = actions.find((a) => a.type === 'scene/set');
    expect(set).toBeTruthy();
    expect((set as { opts?: { liveOverlay?: { frame?: string } } }).opts?.liveOverlay?.frame).toBe(
      'dark-standby',
    );
    // 크롬은 전부 꺼져 있어야 한다 — 다음 큐가 이 그림을 통째로 캔버스에 옮겨 그린다
    const overlay = (set as { opts?: { liveOverlay?: Record<string, unknown> } }).opts?.liveOverlay;
    expect(overlay).toMatchObject({ badge: null, scorebar: false, timer: false, versus: null });
  });

  it('다른 라이브 큐는 프레임을 적지 않는다', () => {
    const liveCues = items.filter((i) => i.scene === 'live' && i.id !== 'part2-live');
    expect(liveCues.length).toBeGreaterThan(0);
    for (const cue of liveCues) expect(cue.opts?.liveOverlay?.frame).toBeUndefined();
  });
});

describe('라이브 다크 프레임 — 화면 배선 (U118)', () => {
  it('대기 화면과 **같은 파일**을 쓴다 — 사본을 뜨지 않는다', () => {
    expect(LIVE_FRAME_DARK_SRC).toBe('./media/main_05_dark.webm');
    expect(standbySource).toContain('main_05_${variant}.webm');
    // 붙박이 그림이라는 성질도 같다 (매니페스트가 아니라 URL 직접 참조)
    expect(ATHLETE_OATH_IMAGE.startsWith('./media/')).toBe(true);
  });

  it('싱글턴 래퍼가 스크림 → 영상 순으로 조립된다 (어둡힘이 프레임 아래)', () => {
    expect(displaySource).toContain("liveFrameEl.className = 'live-frame';");
    expect(displaySource).toContain("liveFrameScrimEl.className = 'live-frame__scrim';");
    expect(displaySource).toContain("liveFrameVideoEl.className = 'live-frame__video';");
    expect(displaySource).toContain('liveFrameEl.append(liveFrameScrimEl, liveFrameVideoEl);');
    expect(displaySource).toContain('liveFrameVideoEl.muted = true;');
    expect(displaySource).toContain('liveFrameVideoEl.loop = true;');
  });

  it('카메라 슬롯 안, 카메라·리플레이 뒤에 붙는다 — DOM 순서가 곧 층이다', () => {
    expect(displaySource).toContain(
      "if (liveFrameEl.parentElement !== camSlot) camSlot.appendChild(liveFrameEl);",
    );
    // 크롬은 슬롯 밖이므로 프레임은 언제나 스코어바·배지 아래다
    expect(displaySource).toContain("const camSlot = stage.querySelector('[data-cam-slot]');");
  });

  it('슬롯을 비우는 attachSlots 뒤에 다시 붙는다', () => {
    const attach = displaySource.indexOf('if (changed) attachSlots();');
    const sync = displaySource.indexOf('syncLiveFrame(scene);');
    expect(attach).toBeGreaterThan(0);
    expect(sync).toBeGreaterThan(attach);
  });

  it('9MB 파일은 처음 켤 때만 물린다', () => {
    expect(displaySource).toContain(
      "if (!liveFrameVideoEl.getAttribute('src')) liveFrameVideoEl.src = LIVE_FRAME_DARK_SRC;",
    );
  });

  it('CSS에 규칙이 있고 검정 지면이 없다 — 있으면 카메라가 한 픽셀도 안 나온다', () => {
    expect(displayCss).toMatch(/\.live-frame\s*\{[^}]*position:\s*absolute/s);
    expect(displayCss).toMatch(/\.live-frame__video\s*\{[^}]*object-fit:\s*cover/s);
    const block = /\.live-frame\s*\{([^}]*)\}/.exec(displayCss)?.[1] ?? '';
    expect(block).not.toMatch(/background/);
  });

  it('스크림 값이 상수와 CSS에서 같다', () => {
    expect(LIVE_FRAME_SCRIM_ALPHA).toBe(0.25);
    expect(LIVE_FRAME_SCRIM_FILL).toBe('rgba(0, 0, 0, 0.25)');
    expect(displayCss).toMatch(
      /\.live-frame__scrim\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*0\.25\)/s,
    );
  });
});

describe('라이브 다크 프레임 — 글리치 캡처 (U118 · U91)', () => {
  it('글리치 캔버스가 카메라 **다음에** 프레임을 다시 그린다', () => {
    const draw = /function drawLiveFrame\(ctx: CanvasRenderingContext2D\): void \{([\s\S]*?)\n\}/.exec(
      displaySource,
    )?.[1];
    expect(draw).toBeTruthy();
    const cam = draw!.indexOf('ctx.drawImage(camEl');
    const frame = draw!.indexOf('drawLiveDarkFrame(ctx);');
    expect(cam).toBeGreaterThan(-1);
    expect(frame).toBeGreaterThan(cam);
  });

  it('캔버스도 스크림 → 영상 순서다 (화면과 같은 합성)', () => {
    const draw = /function drawLiveDarkFrame\(ctx: CanvasRenderingContext2D\): void \{([\s\S]*?)\n\}/.exec(
      displaySource,
    )?.[1];
    expect(draw).toBeTruthy();
    const scrim = draw!.indexOf('LIVE_FRAME_SCRIM_FILL');
    const video = draw!.indexOf('ctx.drawImage(\n      liveFrameVideoEl');
    expect(scrim).toBeGreaterThan(-1);
    expect(video).toBeGreaterThan(scrim);
  });

  it('프레임에는 카메라 반전을 걸지 않는다 — 거울모드에서 액자까지 뒤집히면 사고다', () => {
    const draw = /function drawLiveDarkFrame\(ctx: CanvasRenderingContext2D\): void \{([\s\S]*?)\n\}/.exec(
      displaySource,
    )?.[1];
    expect(draw).not.toMatch(/flipX|flipY|cameraTransform/);
  });

  it('프레임이 화면에 없으면 캔버스도 그리지 않는다', () => {
    expect(displaySource).toContain('if (!liveFrameOn) return;');
  });
});

/**
 * U131 — 퓨어 카메라 프리셋의 공용 빌더. 런처 [퓨어] 버튼과 큐시트 `part2-live`가
 * 이 함수 하나를 공유한다(차이는 `frame`뿐).
 */
describe('라이브 오버레이 전부 끄기 — 퓨어 카메라 공용 빌더 (U131)', () => {
  it('liveOverlayAllOff는 크롬 넷을 끄고 frame만 인자를 그대로 싣는다', () => {
    expect(liveOverlayAllOff('none')).toEqual({
      scorebar: false,
      timer: false,
      badge: null,
      versus: null,
      frame: 'none',
    });
    expect(liveOverlayAllOff('dark-standby')).toEqual({
      scorebar: false,
      timer: false,
      badge: null,
      versus: null,
      frame: 'dark-standby',
    });
  });

  it('isPureCameraOverlay는 다섯 축이 전부 꺼졌을 때만 참이다', () => {
    const off = liveOverlayAllOff('none');
    expect(isPureCameraOverlay(off)).toBe(true);
    // 기본 초기 상태(스코어바·타이머 켬)는 퓨어가 아니다
    expect(isPureCameraOverlay(createInitialState().sceneOpts.liveOverlay)).toBe(false);
    // 다섯 축 중 하나라도 켜지면 더 이상 퓨어가 아니다
    expect(isPureCameraOverlay({ ...off, scorebar: true })).toBe(false);
    expect(isPureCameraOverlay({ ...off, timer: true })).toBe(false);
    expect(isPureCameraOverlay({ ...off, badge: 'curling' })).toBe(false);
    expect(isPureCameraOverlay({ ...off, versus: ['t1', 't2'] })).toBe(false);
    expect(isPureCameraOverlay({ ...off, frame: 'dark-standby' })).toBe(false);
  });

  it('part2-live 큐가 이 빌더를 그대로 쓴다 — frame만 dark-standby로 다르다', () => {
    const items = buildCue();
    const index = items.findIndex((i) => i.id === 'part2-live');
    const actions = cueActions(items[index], index);
    const set = actions.find((a) => a.type === 'scene/set') as
      | { opts?: { liveOverlay?: Record<string, unknown> } }
      | undefined;
    expect(set?.opts?.liveOverlay).toEqual(liveOverlayAllOff('dark-standby'));
  });
});
