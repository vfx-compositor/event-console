// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isRampDone, makeRamp, rampValueAt } from './fade-ramp';
import {
  backdropRuntimeOn,
  initialBackdropFade,
  standbyBackdropLayers,
  standbyCrossfadeScene,
  standbyPhotoEntryCut,
  standbyVideoResyncTime,
  stepBackdropFade,
  type BackdropFadeState,
} from './standby-crossfade';
import type { SceneId } from './types';

describe('대기 배경 크로스디졸브 (U19)', () => {
  it('크로스 중 하단 스택은 1을 유지한다 — 두 레이어를 동시에 줄이면 검정이 샌다', () => {
    for (const p of [0.05, 0.15, 0.5, 0.83, 0.99]) {
      const layers = standbyBackdropLayers(p);
      expect(layers.off).toBe(1);
      expect(layers.on).toBeCloseTo(p, 9);
    }
  });

  /**
   * 합성 가중치 = 상단이 덮는 몫 + 아래로 비치는 몫. 두 스택 모두 불투명하므로
   * `on + (1 - on) * off`가 1이면 검정이 새지 않는다. 옛 상보 감쇠(off = 1 - p)는
   * p=0.5에서 0.75까지 떨어졌고, 그 25%가 사용자가 본 "둔탁함"이다.
   */
  it('합성 가중치가 어느 지점에서도 1 아래로 떨어지지 않는다 (밝기 dip 없음)', () => {
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const { off, on } = standbyBackdropLayers(p);
      expect(off + on).toBeGreaterThanOrEqual(1);
      expect(on + (1 - on) * off).toBeCloseTo(1, 9);
    }
  });

  it('양 끝 그림은 예전과 정확히 같다 — 달라진 것은 중간뿐이다', () => {
    expect(standbyBackdropLayers(0)).toEqual({ off: 1, on: 0 });
    expect(standbyBackdropLayers(1)).toEqual({ off: 0, on: 1 });
    expect(standbyBackdropLayers(-2)).toEqual({ off: 1, on: 0 });
    expect(standbyBackdropLayers(7)).toEqual({ off: 0, on: 1 });
  });

  it('하단을 0으로 내리는 것은 상단이 완전히 덮은 뒤뿐이다 (보이는 변화 없음)', () => {
    expect(standbyBackdropLayers(0.999).off).toBe(1);
    expect(standbyBackdropLayers(1).off).toBe(0);
  });

  it('10초 램프는 절반 시점에 0.5를 지나고 끝나면 정확히 1이다', () => {
    const ramp = makeRamp(0, 1, 10, 0);
    expect(ramp.durationMs).toBe(10_000);
    expect(rampValueAt(ramp, 5000)).toBeCloseTo(0.5, 6);
    expect(isRampDone(ramp, 9999)).toBe(false);
    expect(rampValueAt(ramp, 10_000)).toBe(1);
    expect(isRampDone(ramp, 10_000)).toBe(true);
  });

  it('크로스 도중 재토글하면 현재 opacity에서 역방향으로 이어간다', () => {
    const on = makeRamp(0, 1, 10, 0);
    const mid = rampValueAt(on, 2500);
    const off = makeRamp(mid, 0, 10, 2500);
    expect(rampValueAt(off, 2500)).toBeCloseTo(mid, 6);
    expect(off.durationMs).toBeCloseTo(mid * 10_000, 6);
    expect(rampValueAt(off, 2500 + off.durationMs)).toBe(0);
  });

  it('대기 영상이 떠 있는 화면에서만 크로스한다', () => {
    expect(standbyCrossfadeScene('standby', 'main')).toBe(true);
    expect(standbyCrossfadeScene('score', 'main')).toBe(false);
    // 게임 대기는 종목별 고정 이미지 한 장이라 크로스할 영상이 없다 (U29)
    expect(standbyCrossfadeScene('game', 'main')).toBe(false);
    // 사전미션도 이미지 한 장
    expect(standbyCrossfadeScene('standby', 'pre-mission')).toBe(false);
  });

  it('설정이 꺼져도 크로스가 남아 있는 동안 사진 재생기를 계속 돌린다', () => {
    expect(backdropRuntimeOn(true, 0)).toBe(true);
    expect(backdropRuntimeOn(false, 0.4)).toBe(true);
    expect(backdropRuntimeOn(false, 0)).toBe(false);
  });
});

/**
 * 상태 방송이 오가는 실제 순서를 그대로 흘려 **램프가 정말 생기는지** 본다.
 *
 * 문자열 존재만 보는 단언은 이 사고를 못 잡았다 — 스냅 분기와 램프 분기가 둘 다 소스에 있는데
 * 방송 콜백이 매번 스냅 플래그를 되살려 램프 분기가 도달 불가였다. 여기서는 display의 루프를
 * 같은 순서로 재현한다: 방송이 오면 `sawFirstSyncState`만 켜고 곧바로 한 프레임 돌린다.
 */
describe('대기 배경 크로스 — 방송 시퀀스 재현', () => {
  const FADE = 10;

  /** display.ts의 루프를 그대로 흉내 낸 최소 하네스 */
  class Harness {
    fade: BackdropFadeState;
    sawFirstSyncState = false;
    target: number;

    constructor(initialOn: boolean) {
      this.fade = initialBackdropFade(initialOn);
      this.target = initialOn ? 1 : 0;
    }

    /** 리더 상태 방송 — display는 여기서 `sawFirstSyncState`만 켜고 즉시 paint한다 */
    broadcast(target: number, now: number): void {
      this.target = target;
      this.sawFirstSyncState = true;
      this.frame(now);
    }

    /** rAF 한 프레임 */
    frame(now: number, crossfadeHere = true): number {
      this.fade = stepBackdropFade(this.fade, {
        target: this.target,
        crossfadeHere,
        sawFirstSyncState: this.sawFirstSyncState,
        fadeSec: FADE,
        now,
      });
      return this.fade.progress;
    }
  }

  it('첫 방송은 스냅하고, 그 뒤 목표가 바뀌면 램프가 실제로 생긴다', () => {
    const h = new Harness(false);
    // 저장본은 OFF인데 리더는 ON — 창을 열자마자 페이드가 돌면 안 된다
    h.broadcast(1, 0);
    expect(h.fade.progress).toBe(1);
    expect(h.fade.ramp).toBeNull();
    expect(h.fade.snapPending).toBe(false);

    // 운영자가 배경을 끈다 → 이번에는 스냅이 아니라 램프가 걸려야 한다
    h.broadcast(0, 1000);
    expect(h.fade.ramp).not.toBeNull();
    // 램프를 건 그 프레임은 아직 시작값(=현재 값)이다. 점프하지 않는다는 뜻이다.
    expect(h.fade.progress).toBe(1);
    // 다음 프레임부터 실제로 내려간다 — 스냅이었다면 여기서 곧바로 0이다
    const next = h.frame(3000);
    expect(next).toBeLessThan(1);
    expect(next).toBeGreaterThan(0);
  });

  it('두 번째 방송 뒤 progress가 0/1로 점프하지 않고 중간값을 거친다', () => {
    const h = new Harness(false);
    h.broadcast(1, 0);
    h.broadcast(0, 1000);

    const samples: number[] = [];
    for (let t = 1000; t <= 11_000; t += 500) samples.push(h.frame(t));

    const middle = samples.filter((v) => v > 0.001 && v < 0.999);
    expect(middle.length).toBeGreaterThanOrEqual(15);
    // 단조 감소 — 되돌아가거나 튀지 않는다
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
    }
    expect(samples[samples.length - 1]).toBe(0);
  });

  it('페이드 도중 들어오는 방송이 진행을 리셋하지 않는다 (같은 목표 재방송)', () => {
    const h = new Harness(true);
    h.broadcast(1, 0);
    h.broadcast(0, 1000);
    const mid = h.frame(4000);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    // 리더가 같은 상태를 다시 방송해도(무관한 액션마다 일어난다) 값이 유지된다
    h.broadcast(0, 4000);
    expect(h.fade.progress).toBeCloseTo(mid, 9);
    expect(h.fade.ramp).not.toBeNull();
  });

  it('크로스 도중 재토글은 현재 값에서 역방향으로 이어간다', () => {
    const h = new Harness(false);
    h.broadcast(1, 0);
    h.broadcast(0, 1000);
    const mid = h.frame(4000);
    h.broadcast(1, 4000);
    expect(h.fade.progress).toBeCloseTo(mid, 9);
    const later = h.frame(5000);
    expect(later).toBeGreaterThan(mid);
  });

  it('대기 화면 밖에서는 방송 뒤에도 크로스 없이 목표로 스냅한다', () => {
    const h = new Harness(false);
    h.broadcast(1, 0);
    h.target = 0;
    expect(h.frame(1000, false)).toBe(0);
    expect(h.fade.ramp).toBeNull();
  });

  it('첫 방송 전에는 몇 프레임을 돌려도 스냅으로 남는다', () => {
    const h = new Harness(false);
    h.target = 1;
    expect(h.frame(0)).toBe(1);
    expect(h.frame(500)).toBe(1);
    expect(h.fade.snapPending).toBe(true);
    expect(h.fade.ramp).toBeNull();
  });

  it('fadeSec 0이면 방송 뒤에도 즉시 목표값이다 (컷 강등)', () => {
    const h = new Harness(false);
    h.broadcast(1, 0);
    h.fade = stepBackdropFade(h.fade, {
      target: 0,
      crossfadeHere: true,
      sawFirstSyncState: true,
      fadeSec: 0,
      now: 1000,
    });
    expect(h.fade.progress).toBe(0);
    expect(h.fade.ramp).toBeNull();
  });
});

/**
 * display 배선 잠금 — DOM 없는 vitest에서는 소스 단언으로 계약을 고정한다
 * (`video-hold.test.ts`가 같은 방식으로 페이드 배선을 잠근다).
 */
describe('display 배선 잠금 — 대기 배경·음악 페이드', () => {
  const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
  const standby = readFileSync(new URL('./scenes/standby.ts', import.meta.url), 'utf8');

  it('대기 씬은 두 스택을 항상 함께 렌더한다 (HTML 고정 → stage 재생성 없음)', () => {
    expect(standby).toContain("'data-standby-stack': 'off'");
    expect(standby).toContain("'data-standby-stack': 'on'");
    // 사진 백드롭은 ON 스택 **안**에 있어야 한다 — 밖에 두면 따로 페이드돼 dip이 생긴다
    expect(standby).toMatch(
      /standby-stack--on[\s\S]{0,200}photo-backdrop[\s\S]{0,120}standbyVideo\('dark'\)/,
    );
    expect(standby).toContain("'data-standby-video': variant");
    expect(standby).toContain("standbyVideo('light')");
    expect(standby).toContain("standbyVideo('dark')");
    // 토글에 따라 src를 갈아치우던 옛 배선이 되살아나면 안 된다
    expect(standby).not.toMatch(/src:\s*withPhotos\s*\?/);
    expect(standby).not.toMatch(/withPhotos\s*\?\s*h\(/);
  });

  it('display는 스택 두 덩어리의 opacity를 같은 progress에서 계산해 심는다', () => {
    expect(display).toContain('standbyBackdropLayers(');
    expect(display).toContain("applyStandbyStack('off', layers.off)");
    expect(display).toContain("applyStandbyStack('on', layers.on)");
    expect(display).toContain('[data-standby-stack="${stack}"]');
    // U75 — 크로스디졸브는 시각 경로라 동결 스냅샷을 읽는다
    expect(display).toContain('vis.settings.backdropCrossfadeSec');
    // 사진 백드롭은 이제 ON 스택 안에서 함께 합성된다 — 따로 페이드시키면 dip이 돌아온다
    expect(display).not.toContain("querySelector<HTMLElement>('.scene--standby-video .photo-backdrop')");
  });

  it('인커밍 영상은 재생 직전과 크로스 도중 아웃고잉 시각에 맞춘다', () => {
    // 정의만 있고 부르지 않으면 아무 일도 안 일어난다 — 호출 순서를 본다.
    // (1) 크로스 틱은 스택을 심은 **뒤에** 드리프트를 잡는다
    expect(display).toMatch(
      /applyStandbyStack\('on', layers\.on\);\s*\n\s*keepStandbyVideosInStep\(\);/,
    );
    // (2) 멈춰 있던 영상은 play() **직전에** 반대쪽 시각으로 맞춘다
    expect(display).toMatch(
      /if \(video\.paused\) \{[\s\S]{0,320}syncStandbyVideoFrom\(standbyVideoEl\([\s\S]{0,60}\), video\);\s*\n\s*void video\.play\(\)/,
    );
    expect(display).toContain(
      'standbyVideoResyncTime(source.currentTime, target.currentTime, target.duration)',
    );
    // 멈춘 쪽을 기준으로 삼으면 낡은 값이 살아 있는 쪽을 되감는다
    expect(display).toContain('if (!off || !on || off.paused || on.paused) return;');
  });

  it('사진 재생기 게이트는 크로스 진행 중에도 켜져 있다', () => {
    expect(display).toContain('backdropRuntimeOn(');
  });

  it('사진 런타임 판정은 헬퍼 하나로 모여 있다 — setShownScene의 옛 2인자 호출이 없다', () => {
    expect(display).toContain('function wantPhotoRuntimeFor(');
    expect(display).toContain('const prevPhotos = wantPhotoRuntimeFor(prev)');
    expect(display).toContain('const nextPhotos = wantPhotoRuntimeFor(next)');
    expect(display).toContain('let photoRuntimeEnabled = wantPhotoRuntimeFor(shownScene)');
    expect(display).toContain('const wantPhotoRuntime = wantPhotoRuntimeFor(scene)');
    // 게이트를 우회하는 직접 호출이 남으면 게임 대기 씬이 다시 빠진다
    expect(display).not.toContain('photoPlaybackEnabled(prev,');
    expect(display).not.toContain('photoPlaybackEnabled(next,');
    expect(display).not.toContain('photoPlaybackEnabled(scene,');
    expect(display).not.toContain('photoPlaybackEnabled(shownScene,');
  });

  it('사진 세션 재시작 조건도 크로스와 같은 기준이다', () => {
    expect(display).not.toContain("if (next === 'standby' && state.photos.settings.standbyBackdrop)");
    expect(display).not.toContain("if (scene === 'standby') restartStandbyPhotoSession(now)");
    expect(display).toMatch(/standbyCrossfadeScene\([\s\S]{0,160}restartStandbyPhotoSession/);
  });

  it('크로스 상태를 쓰는 곳은 순수 함수 하나뿐이다', () => {
    expect(display).toContain('backdropFade = stepBackdropFade(backdropFade, {');
    expect(display).toContain('initialBackdropFade(state.photos.settings.standbyBackdrop)');
    // 방송 콜백이 스냅 플래그를 되살리면 램프 분기가 영영 도달하지 않는다 (실사고)
    expect(display).not.toMatch(/backdropFade\.(progress|ramp|snapPending)\s*=/);
    expect(display).not.toContain('backdropSnapPending = true');
    const syncCallback = display.slice(
      display.indexOf('const sync = createDisplaySync('),
      display.indexOf('function emit('),
    );
    expect(syncCallback).toContain('sawFirstSyncState = true');
    expect(syncCallback).not.toContain('snapPending');
    expect(syncCallback).not.toContain('backdropFade');
  });

  it('음악은 덱 두 개로 크로스페이드하고 볼륨은 마스터와 곱으로 합성한다', () => {
    expect(display).toContain('musicFadePlan(');
    expect(display).toContain('musicDecks');
    // U44 이후 음악 덱의 마스터는 덕킹 축을 곱한 `musicMaster`다 (곱 합성은 그대로)
    expect(display).toContain('trackVolume(musicMaster, deck.track)');
    expect(display).toContain('musicDuck.value');
    // 페이드 아웃 완료 뒤에만 실제로 멈춘다 (명령 즉시 pause 금지)
    expect(display).toContain("stepped.finish === 'pause'");
    expect(display).toContain("stepped.finish === 'release'");
  });

  it('덱은 src 교체 직전에 element 볼륨을 0으로 내린다 (연속 교체 클릭 노이즈 방지)', () => {
    expect(display).toMatch(
      // 마스터 인자는 저장값 직접 참조에서 `heardMaster()`로 바뀌었다 (U43 램프) —
      // 여기서 중요한 것은 **게인이 0인 채로 src를 간다**는 것뿐이다.
      /deck\.el\.volume = trackVolume\(.*idleTrack\(0\)\);\s*\n\s*deck\.el\.src = /,
    );
  });

  it('덱은 auto로 미리 받아 둔다 — 컷(0초)에서 첫 음절이 잘리지 않게', () => {
    expect(display).toContain("el.preload = 'auto'");
    expect(display).not.toContain("el.preload = 'metadata'");
  });

  it('페이드 아웃이 끝나면 실제로 멎은 위치를 보고한다', () => {
    expect(display).toContain('music-paused-at:${state.music.commandToken}:${at}');
    expect(display).toContain('deck.el.currentTime || 0');
  });

  it('멎은 뒤에는 진행 보고를 멈춘다', () => {
    expect(display).toContain('musicProgressParked');
    expect(display).toContain('const musicLive =');
  });

  it('가려진 창에서도 게인은 별도 짧은 주기로 굴린다 (400ms 계단 방지)', () => {
    expect(display).toMatch(/live\.some\(\(track\) => track\.ramp !== null\)[\s\S]{0,120}tickAudioGains\(Date\.now\(\)\)[\s\S]{0,40}\}, 50\)/);
  });
});

describe('대기 영상 재생 시각 동기 (U19 · 모션 어긋남)', () => {
  const D = 14.017;

  it('허용 오차 안이면 손대지 않는다 — 매 프레임 currentTime을 쓰면 재생이 끊긴다', () => {
    expect(standbyVideoResyncTime(5, 5, D)).toBeNull();
    expect(standbyVideoResyncTime(5, 5.09, D)).toBeNull();
    expect(standbyVideoResyncTime(5, 4.91, D)).toBeNull();
  });

  it('오차를 넘으면 아웃고잉 시각을 그대로 돌려준다', () => {
    expect(standbyVideoResyncTime(5, 5.5, D)).toBeCloseTo(5, 9);
    expect(standbyVideoResyncTime(0, 9, D)).toBeCloseTo(0, 9);
  });

  it('루프 경계를 넘는 차이는 원형 거리로 잰다 — 13.99초와 0.02초는 어긋난 게 아니다', () => {
    expect(standbyVideoResyncTime(13.99, 0.02, D)).toBeNull();
    expect(standbyVideoResyncTime(13.9, 0.2, D)).toBeCloseTo(13.9, 9);
  });

  it('길이를 넘는 시각은 나머지로 접는다 (길이가 다른 파일로 교체돼도 안전)', () => {
    expect(standbyVideoResyncTime(D + 3, 0, D)).toBeCloseTo(3, 9);
    expect(standbyVideoResyncTime(-1, 5, D)).toBeCloseTo(D - 1, 9);
  });

  it('길이를 아직 모르면(메타데이터 전) 단순 차이로 판단한다', () => {
    expect(standbyVideoResyncTime(5, 5.05, undefined)).toBeNull();
    expect(standbyVideoResyncTime(5, 8, undefined)).toBeCloseTo(5, 9);
    expect(standbyVideoResyncTime(5, 8, Number.NaN)).toBeCloseTo(5, 9);
  });

  it('시각을 읽을 수 없으면 아무것도 하지 않는다', () => {
    expect(standbyVideoResyncTime(Number.NaN, 5, D)).toBeNull();
    expect(standbyVideoResyncTime(5, Number.NaN, D)).toBeNull();
  });
});

describe('대기 스택 CSS 계약', () => {
  const css = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');
  const block = (selector: string) =>
    css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  it('두 스택은 같은 자리에 겹치고 ON이 위에 온다', () => {
    expect(block('.standby-stack')).toMatch(/position:\s*absolute/);
    expect(block('.standby-stack')).toMatch(/inset:\s*0/);
    const off = block('.standby-stack--off');
    const on = block('.standby-stack--on');
    expect(Number(/z-index:\s*(\d+)/.exec(on)?.[1])).toBeGreaterThan(
      Number(/z-index:\s*(\d+)/.exec(off)?.[1]),
    );
  });

  /**
   * 검정 지면이 A→B 크로스의 성립 조건이다. 없으면 ON 스택이 opacity 1에서도 아래를 못 덮어
   * 알파 영상의 구멍으로 **밝은 영상**이 비친다 — 켠 상태의 그림이 통째로 달라진다.
   */
  it('ON 스택은 자기 검정 지면을 갖는다', () => {
    expect(block('.standby-stack--on')).toMatch(/background:\s*#000/);
  });

  it('레이어별 개별 opacity 규칙이 남아 있지 않다 (스택 하나만 움직인다)', () => {
    expect(css).not.toMatch(/\.main-standby-video--light\s*\{[^}]*opacity/);
    expect(css).not.toMatch(/\.main-standby-video--dark\s*\{[^}]*opacity/);
    expect(css).not.toMatch(/\.scene--standby-video\s+\.photo-backdrop\s*\{[^}]*opacity/);
  });
});

/**
 * U40 — "대기 화면이 아닌데 사진 배경을 켜고 바로 대기 화면에 가면 켜진 채로 로드"
 *
 * 크로스디졸브는 **대기 화면을 보고 있는 동안 토글할 때만** 돈다. 다른 씬에서 켜고 들어오면
 * 첫 프레임부터 목표 그림이어야 한다 — 진입 스팅어 뒤에 10초 램프가 또 도는 것은 오작동으로 읽힌다.
 */
describe('대기 배경 진입 스냅 (U40)', () => {
  const FADE = 10;

  /** display 루프 한 프레임 — 씬과 설정만 주면 진행률을 돌려준다 */
  function loop(startOn: boolean) {
    let fade = initialBackdropFade(startOn);
    return {
      get progress() {
        return fade.progress;
      },
      get ramping() {
        return fade.ramp !== null;
      },
      tick(scene: SceneId, on: boolean, now: number) {
        fade = stepBackdropFade(fade, {
          target: on ? 1 : 0,
          crossfadeHere: standbyCrossfadeScene(scene, 'main'),
          sawFirstSyncState: true,
          fadeSec: FADE,
          now,
        });
        return fade.progress;
      },
    };
  }

  it('중계 화면에서 켜고 대기 화면에 들어가면 첫 프레임부터 1이고 중간값이 하나도 없다', () => {
    const run = loop(false);
    run.tick('live', false, 0); // 첫 방송 반영 — 스냅 플래그를 내린다
    run.tick('live', true, 16); // 다른 씬에서 ON

    const seen: number[] = [];
    for (let i = 0; i < 60; i += 1) seen.push(run.tick('standby', true, 32 + i * 16));

    expect(seen[0]).toBe(1);
    expect(seen.filter((v) => v > 0 && v < 1)).toEqual([]);
    expect(run.ramping).toBe(false);
  });

  it('반대 방향(끄고 진입)도 첫 프레임부터 0이다', () => {
    const run = loop(true);
    run.tick('live', true, 0);
    run.tick('live', false, 16);
    expect(run.tick('standby', false, 32)).toBe(0);
    expect(run.ramping).toBe(false);
  });

  it('대기 화면을 보는 중 토글하면 예전대로 램프가 돈다', () => {
    const run = loop(false);
    run.tick('standby', false, 0);
    run.tick('standby', true, 16);
    const mid = run.tick('standby', true, 16 + FADE * 500);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(run.ramping).toBe(true);
  });

  it('사전미션에서 켜고 메인 대기로 넘어가도 스냅이다', () => {
    let fade = initialBackdropFade(false);
    const step = (mode: 'main' | 'pre-mission', on: boolean, now: number) => {
      fade = stepBackdropFade(fade, {
        target: on ? 1 : 0,
        crossfadeHere: standbyCrossfadeScene('standby', mode),
        sawFirstSyncState: true,
        fadeSec: FADE,
        now,
      });
      return fade.progress;
    };
    step('pre-mission', false, 0);
    step('pre-mission', true, 16);
    expect(step('main', true, 32)).toBe(1);
    expect(fade.ramp).toBeNull();
  });

  it('크로스 도중 다른 씬으로 나갔다 오면 중간값이 남지 않는다', () => {
    const run = loop(false);
    run.tick('standby', false, 0);
    run.tick('standby', true, 16);
    const mid = run.tick('standby', true, 16 + FADE * 300);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    run.tick('live', true, 16 + FADE * 400);
    expect(run.tick('standby', true, 16 + FADE * 500)).toBe(1);
  });
});

describe('진입 사진 첫 장 (U40)', () => {
  it('크로스가 이미 끝난 채로 들어오면 첫 장을 끊어 넣는다', () => {
    expect(standbyPhotoEntryCut(1, 1)).toBe(true);
  });

  it('대기 화면에서 막 켜서 크로스가 도는 중이면 평소 페이드다', () => {
    for (const p of [0, 0.2, 0.75, 0.99]) expect(standbyPhotoEntryCut(p, 1)).toBe(false);
  });

  it('끄는 방향에는 해당이 없다', () => {
    expect(standbyPhotoEntryCut(1, 0)).toBe(false);
    expect(standbyPhotoEntryCut(0, 0)).toBe(false);
  });

  it('display가 첫 장에만 0ms를 쓰고 플래그를 소비한다', () => {
    const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
    expect(source).toContain('photoCutFirstSwap = standbyPhotoEntryCut(');
    expect(source).toContain('const fadeMs = photoCutFirstSwap ? 0 : photoFadeMs();');
    expect(source).toContain('photoCutFirstSwap = false;');
  });
});
