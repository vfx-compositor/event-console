// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  canMeasureVideoTail,
  shouldEnterVideoAudioTail,
  shouldEnterVideoTail,
  shouldStartVideoAudioTail,
  shouldStartVideoTail,
  type VideoPlaybackSample,
  type VideoSourceBinding,
  type VideoTailRequest,
} from './video-hold';
import { fadeOpacityAt, volumeForOpacity } from './fade';
import { idleTrack, isAudible, rampGain, setGain, stepGain, type GainTrack } from './audio-gain';

describe('영상 종료 프레임 홀드', () => {
  it('홀드 영상은 ended나 tail 시각에 도달해도 꼬리 페이드를 시작하지 않는다', () => {
    expect(shouldStartVideoTail(true, true, 10, 10, 0.5)).toBe(false);
    expect(shouldStartVideoTail(true, false, 9.8, 10, 0.5)).toBe(false);
  });

  it('일반 영상은 ended 또는 duration-fadeSec 시점에 꼬리 페이드를 시작한다', () => {
    expect(shouldStartVideoTail(false, true, 1, undefined, 0.5)).toBe(true);
    expect(shouldStartVideoTail(false, false, 9.5, 10, 0.5)).toBe(true);
    expect(shouldStartVideoTail(false, false, 9.4, 10, 0.5)).toBe(false);
  });
});

/**
 * D1 재현 — display의 `<video>` 하나를 상태 기계로 흉내 낸다.
 *
 * 실제 순서를 그대로 흘린다: `playFull` → covering(옛 영상 그대로) → playing 진입 틱(tickFade가
 * ensureVideo보다 먼저 돈다) → `ensureVideo`의 blob 조회 await → `src` 대입 → 메타데이터 도착.
 */
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_ENOUGH_DATA = 4;

class FakeVideoElement {
  srcAssetId: string | null = null;
  srcRestartToken = -1;
  readyState = HAVE_NOTHING;
  currentTime = 0;
  duration: number | undefined = undefined;
  ended = false;

  /** 옛 영상이 끝까지 재생돼 마지막 프레임에 멈춰 있는 상태 (holdEndFrame 소개 영상) */
  holdingEndOf(assetId: string, restartToken: number, durationSec: number): void {
    this.srcAssetId = assetId;
    this.srcRestartToken = restartToken;
    this.readyState = HAVE_ENOUGH_DATA;
    this.duration = durationSec;
    this.currentTime = durationSec;
    this.ended = false;
  }

  /** `ensureVideo`의 `videoEl.src = url` — 이 순간에만 바인딩이 새 영상으로 넘어간다 */
  attachSrc(assetId: string, restartToken: number): void {
    this.srcAssetId = assetId;
    this.srcRestartToken = restartToken;
    this.readyState = HAVE_NOTHING;
    this.currentTime = 0;
    this.duration = undefined;
    this.ended = false;
  }

  /** `loadedmetadata` */
  loadMetadata(durationSec: number): void {
    this.readyState = HAVE_ENOUGH_DATA;
    this.duration = durationSec;
  }

  binding(): VideoSourceBinding {
    return {
      srcAssetId: this.srcAssetId,
      srcRestartToken: this.srcRestartToken,
      readyState: this.readyState,
    };
  }

  sample(): VideoPlaybackSample {
    return { currentTime: this.currentTime, duration: this.duration, ended: this.ended };
  }
}

const PART2: VideoTailRequest = {
  assetId: 'media:260831_pt2_v001.mp4',
  restartToken: 1_756_000_000_200,
  holdEndFrame: false,
  fadeSec: 0.5,
};

describe('직전 영상이 끝까지 재생된 뒤 다음 영상 재생 (D1)', () => {
  it('playing 진입 틱에서 엘리먼트가 아직 옛 영상이면 꼬리 페이드로 들어가지 않는다', () => {
    const el = new FakeVideoElement();
    // 몸으로 말해요 소개 영상(holdEndFrame)이 끝까지 재생돼 마지막 프레임에서 멈춰 있다
    el.holdingEndOf('media:intro_sync.mp4', 1_756_000_000_100, 10);

    // tickFade가 ensureVideo보다 먼저 돈다 — 여기서 true가 나오면 Part 2가 1초 만에 스킵된다
    expect(shouldEnterVideoTail(el.binding(), PART2, el.sample())).toBe(false);
  });

  it('ensureVideo가 assetId만 예약하고 blob 조회를 기다리는 동안에도 판정하지 않는다', () => {
    const el = new FakeVideoElement();
    el.holdingEndOf('media:intro_sync.mp4', 1_756_000_000_100, 10);
    // `videoAssetId = assetId`는 await 앞에서 동기로 끝나지만 `videoEl.src`는 아직 옛 영상이다.
    // 예약 값을 바인딩으로 쓰면 여기서 게이트가 열려 D1이 그대로 재현된다.
    const reserved: VideoSourceBinding = {
      srcAssetId: PART2.assetId,
      srcRestartToken: PART2.restartToken,
      readyState: el.readyState,
    };
    expect(canMeasureVideoTail(reserved, PART2)).toBe(true);
    expect(shouldEnterVideoTail(reserved, PART2, el.sample())).toBe(true);
    // 실제 src 기준 바인딩은 막는다
    expect(shouldEnterVideoTail(el.binding(), PART2, el.sample())).toBe(false);
  });

  it('src를 막 붙여 메타데이터가 오기 전에는 판정하지 않는다', () => {
    const el = new FakeVideoElement();
    el.holdingEndOf('media:intro_sync.mp4', 1_756_000_000_100, 10);
    el.attachSrc(PART2.assetId as string, PART2.restartToken);
    expect(el.readyState).toBe(HAVE_NOTHING);
    expect(shouldEnterVideoTail(el.binding(), PART2, el.sample())).toBe(false);
  });

  it('메타데이터가 온 뒤에는 새 영상의 시간으로 정상 판정한다', () => {
    const el = new FakeVideoElement();
    el.holdingEndOf('media:intro_sync.mp4', 1_756_000_000_100, 10);
    el.attachSrc(PART2.assetId as string, PART2.restartToken);
    el.loadMetadata(120);

    el.currentTime = 0.2;
    expect(shouldEnterVideoTail(el.binding(), PART2, el.sample())).toBe(false);
    el.currentTime = 119.5;
    expect(shouldEnterVideoTail(el.binding(), PART2, el.sample())).toBe(true);

    // duration/currentTime이 새 소스의 값이 되는 시점은 HAVE_METADATA다 — 그 이상 기다리지 않는다
    el.readyState = HAVE_METADATA;
    expect(shouldEnterVideoTail(el.binding(), PART2, el.sample())).toBe(true);
  });

  it('같은 영상을 다시 트는 경우 되감기가 반영되기 전에는 판정하지 않는다', () => {
    const el = new FakeVideoElement();
    el.holdingEndOf(PART2.assetId as string, 1_756_000_000_100, 120);
    // assetId는 같고 restartToken만 새로 온 상태 = ensureVideo의 되감기 전
    expect(shouldEnterVideoTail(el.binding(), PART2, el.sample())).toBe(false);
    el.srcRestartToken = PART2.restartToken;
    el.currentTime = 0;
    expect(shouldEnterVideoTail(el.binding(), PART2, el.sample())).toBe(false);
  });

  it('holdEndFrame 영상은 바인딩이 맞아도 꼬리 페이드로 들어가지 않는다', () => {
    const el = new FakeVideoElement();
    el.attachSrc('media:intro_sync.mp4', 1_756_000_000_100);
    el.loadMetadata(10);
    el.currentTime = 10;
    const hold: VideoTailRequest = {
      assetId: 'media:intro_sync.mp4',
      restartToken: 1_756_000_000_100,
      holdEndFrame: true,
      fadeSec: 0.5,
    };
    expect(shouldEnterVideoTail(el.binding(), hold, el.sample())).toBe(false);
  });

  it('blob 조회 실패로 소스가 끝내 안 붙으면 판정을 열지 않는다 (워치독에 위임)', () => {
    const el = new FakeVideoElement();
    el.holdingEndOf('media:intro_sync.mp4', 1_756_000_000_100, 10);
    // ensureVideo가 `if (!url) return`으로 빠진 뒤에도 바인딩은 옛 영상 그대로다
    expect(shouldEnterVideoTail(el.binding(), PART2, el.sample())).toBe(false);
  });

  it('요청된 영상이 없으면 판정하지 않는다', () => {
    const el = new FakeVideoElement();
    const idle: VideoTailRequest = { assetId: null, restartToken: 0, holdEndFrame: false, fadeSec: 0.5 };
    expect(shouldEnterVideoTail(el.binding(), idle, el.sample())).toBe(false);
  });
});

describe('display 배선 (D1)', () => {
  const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

  it('꼬리 페이드 판정에 예약 값이 아니라 src 반영 값을 넘긴다', () => {
    const binding = source.match(/const tailBinding = \{([\s\S]*?)\n {4}\};/)?.[1] ?? '';
    expect(binding).toContain('srcAssetId: videoSrcAssetId');
    expect(binding).toContain('srcRestartToken: videoSrcRestartToken');
    expect(binding).not.toMatch(/srcAssetId:\s*videoAssetId\b/);
    expect(binding).not.toMatch(/srcRestartToken:\s*videoRestartToken\b/);
    // 시각·소리 두 판정이 **같은 한 벌**을 본다 (U93) — 갈라 두면 게이트가 한쪽에서만 열린다
    expect(source).toContain('shouldEnterVideoTail(tailBinding, tailRequest, tailSample)');
    expect(source).toContain('shouldEnterVideoAudioTail(tailBinding, tailRequest, tailSample)');
  });

  it('src 반영 값은 videoEl.src 대입 직후에만 기록한다', () => {
    expect(source).toMatch(/videoEl\.src = url;\n\s*videoSrcAssetId = assetId;/);
  });
});

// ---------------------------------------------------------------- U93
//
// 2부 Part 1~4(`260831_pt*_v001.mp4`)는 manifest에서 `holdEndFrame: true`다. 그 값이
// `shouldStartVideoTail`의 첫 줄에서 꼬리를 막는 바람에 **소리까지** 페이드를 잃고, 파일이
// 끝나는 순간 최대 볼륨에서 무음으로 끊겼다(그 다음 `holding` 분기가 게인을 0으로 못 박는다).

describe('마지막 프레임을 붙잡아도 소리는 페이드한다 (U93)', () => {
  it('소리 꼬리는 holdEndFrame을 보지 않는다', () => {
    // 같은 입력에서 시각은 닫히고 소리는 열린다 — 이 두 줄이 U93의 전부다
    expect(shouldStartVideoTail(true, false, 9.5, 10, 0.5)).toBe(false);
    expect(shouldStartVideoAudioTail(false, 9.5, 10, 0.5)).toBe(true);
    expect(shouldStartVideoAudioTail(true, 1, undefined, 0.5)).toBe(true);
    expect(shouldStartVideoAudioTail(false, 9.4, 10, 0.5)).toBe(false);
  });

  it('일반 영상에서는 시각·소리 판정이 같은 값이다 (곡선이 갈라지지 않는다)', () => {
    for (const t of [0, 5, 9.4, 9.5, 9.9, 10]) {
      expect(shouldStartVideoAudioTail(false, t, 10, 0.5)).toBe(
        shouldStartVideoTail(false, false, t, 10, 0.5),
      );
    }
  });

  it('소리 꼬리도 소스 바인딩 게이트를 그대로 쓴다 (D1이 소리 쪽에서 재현되지 않게)', () => {
    const el = new FakeVideoElement();
    // 직전 홀드 영상이 마지막 프레임에 멈춰 있고, 요청은 새 영상이다
    el.holdingEndOf('media:intro_sync.mp4', 1_756_000_000_100, 10);
    const hold: VideoTailRequest = { ...PART2, holdEndFrame: true };
    expect(shouldEnterVideoAudioTail(el.binding(), hold, el.sample())).toBe(false);

    // 새 소스가 실제로 붙고 메타데이터가 온 뒤에만 열린다
    el.attachSrc(hold.assetId as string, hold.restartToken);
    el.loadMetadata(120);
    el.currentTime = 119.4;
    expect(shouldEnterVideoAudioTail(el.binding(), hold, el.sample())).toBe(false);
    el.currentTime = 119.5;
    expect(shouldEnterVideoAudioTail(el.binding(), hold, el.sample())).toBe(true);
    // 시각은 끝까지 닫혀 있다 — 마지막 프레임은 화면에 선다
    expect(shouldEnterVideoTail(el.binding(), hold, el.sample())).toBe(false);
  });
});

/**
 * display의 `videoMedia` 게인 기계를 프레임 단위로 흉내 낸다 (U93 재현 하네스).
 *
 * vitest 환경이 `node`라 `display.ts`를 통째로 import할 수 없다. 그래서 게인을 실제로 움직이는
 * 네 자리 — `tickFade`의 playing/holding/idle 분기, `paint()`의 씬 이탈 정리, `tickAudioGains`의
 * `stepGain` — 만 **같은 순서로** 옮겨 심고, 계산은 전부 실제 모듈(`fade`·`audio-gain`·
 * `video-hold`)을 그대로 부른다. 값이 갈리면 그건 display가 아니라 이 하네스의 버그다.
 */
const FRAME_MS = 50;
const HAVE_ENOUGH = 4;

interface DriverOpts {
  /** 영상 길이(초). `undefined` = duration을 못 읽는 에셋 */
  durationSec: number | undefined;
  holdEndFrame: boolean;
  /** 꼬리 페이드 길이 = `settings.fadeSec` */
  fadeSec: number;
  /** 급격한 전환에서 쓰는 정리 페이드 = `settings.audioCutFadeSec` */
  audioCutFadeSec: number;
}

class FullVideoAudioDriver {
  track: GainTrack = idleTrack(1);
  now = 1_000_000;
  phase: 'playing' | 'holding' | 'idle' = 'playing';
  /** `pickScene(state)` — 상태가 **원하는** 씬. `scene/set`이 떨어지는 그 프레임에 바뀐다 */
  wantScene: 'video' | 'submit' = 'video';
  /** 화면이 **실제로 보여 주는** 씬. 스팅어 스윕이 도는 동안 `wantScene`보다 늦다 */
  shownScene: 'video' | 'submit' = 'video';
  currentTime = 0;
  ended = false;
  elementPaused = false;
  opacity = 0;
  private fadeInTail = false;
  private fadeTailStartedAt = 0;
  private audioInTail = false;
  private audioTailStartedAt = 0;
  private phaseStartedAt = this.now;
  private endedSeen = false;
  private teardownDone = false;
  /** 매 프레임 **실제로 들리는** 볼륨 — 멎은 엘리먼트는 게인이 얼마든 0이다 */
  heard: number[] = [];

  constructor(private readonly opts: DriverOpts) {}

  private request(): VideoTailRequest {
    return {
      assetId: 'media:260831_pt2_v001.mp4',
      restartToken: 7,
      holdEndFrame: this.opts.holdEndFrame,
      fadeSec: this.opts.fadeSec,
    };
  }

  private binding(): VideoSourceBinding {
    return { srcAssetId: this.request().assetId, srcRestartToken: 7, readyState: HAVE_ENOUGH };
  }

  private sample(): VideoPlaybackSample {
    return { currentTime: this.currentTime, duration: this.opts.durationSec, ended: this.endedSeen };
  }

  /** `tickFade` — playing / holding / idle 세 분기 (display.ts와 같은 순서·같은 함수) */
  private tickFade(): void {
    const tailMs = this.opts.fadeSec * 1000;
    if (this.phase === 'playing') {
      if (!this.fadeInTail && shouldEnterVideoTail(this.binding(), this.request(), this.sample())) {
        this.fadeInTail = true;
        this.fadeTailStartedAt = this.now;
      }
      if (
        !this.audioInTail &&
        shouldEnterVideoAudioTail(this.binding(), this.request(), this.sample())
      ) {
        this.audioInTail = true;
        this.audioTailStartedAt = this.now;
      }
      this.opacity = this.fadeInTail
        ? fadeOpacityAt(this.now - this.fadeTailStartedAt, tailMs, 'to-black')
        : fadeOpacityAt(this.now - this.phaseStartedAt, tailMs, 'from-black');
      const audioOpacity = this.audioInTail
        ? fadeOpacityAt(this.now - this.audioTailStartedAt, tailMs, 'to-black')
        : this.opacity;
      this.track = setGain(this.track, volumeForOpacity(audioOpacity));
      return;
    }
    if (this.phase === 'holding') {
      this.opacity = 0;
      if (isAudible(this.track)) {
        if (this.track.ramp === null) {
          this.track = rampGain(this.track, 0, this.opts.audioCutFadeSec, this.now);
        }
      } else {
        this.track = setGain(this.track, 0);
      }
      return;
    }
    // idle — 게인 복원은 이 영상이 아직 화면의 주인일 때만. `shownScene`이 아니라 `pickScene`이다:
    // `maybeTransition()`이 `tickFade()`보다 뒤에 돌아 씬이 바뀌는 첫 프레임의 `shownScene`은
    // 아직 'video'이고, 그 한 프레임의 게인 1이 정리 페이드의 시작값이 되어 소리가 튄다.
    if (this.wantScene === 'video') this.track = setGain(this.track, 1);
  }

  /** `paint()` 꼬리 — 씬이 영상을 놓았고 재생 단계가 아니면 정리 페이드를 건다 (U27) */
  private leaveScene(): void {
    if (this.phase === 'playing' || this.shownScene === 'video' || this.teardownDone) return;
    this.teardownDone = true;
    if (!(this.opts.audioCutFadeSec > 0) || !isAudible(this.track)) {
      this.track = idleTrack(0);
      this.elementPaused = true;
      return;
    }
    this.track = rampGain(this.track, 0, this.opts.audioCutFadeSec, this.now, 'pause');
  }

  step(): void {
    this.now += FRAME_MS;
    if (this.phase === 'playing' && !this.elementPaused) {
      this.currentTime += FRAME_MS / 1000;
      const d = this.opts.durationSec;
      if (d !== undefined && this.currentTime >= d) {
        this.currentTime = d;
        this.ended = true;
        this.elementPaused = true;
        // display의 'ended' 리스너: 홀드 영상은 `fullvideo-held`만 내고 `fadeEndedSeen`을 세우지
        // 않는다(그 뒤 control이 `video/held` → `holding`을 돌려준다).
        if (this.opts.holdEndFrame) this.phase = 'holding';
        else this.endedSeen = true;
      }
    }
    this.tickFade();
    this.leaveScene();
    const stepped = stepGain(this.track, this.now);
    this.track = stepped.track;
    if (stepped.finish === 'pause') this.elementPaused = true;
    this.heard.push(this.elementPaused ? 0 : this.track.gain);
  }

  run(frames: number): void {
    for (let i = 0; i < frames; i += 1) this.step();
  }

  /** 한 프레임에 볼륨이 얼마나 크게 떨어졌는가 — 1에 가까우면 페이드 없이 끊긴 것이다 */
  maxDrop(): number {
    let worst = 0;
    for (let i = 1; i < this.heard.length; i += 1) {
      worst = Math.max(worst, this.heard[i - 1] - this.heard[i]);
    }
    return worst;
  }

  /**
   * 내려가던 소리가 **도로 커진** 최대 폭. 머리 페이드 인이 끝난 뒤로만 잰다 —
   * 페이드 인 자체는 정상적인 상승이다.
   */
  maxRiseAfter(fromIndex: number): number {
    let worst = 0;
    for (let i = Math.max(1, fromIndex); i < this.heard.length; i += 1) {
      worst = Math.max(worst, this.heard[i] - this.heard[i - 1]);
    }
    return worst;
  }

  /**
   * **내려가는** 페이드가 걸린 프레임 수 — 마지막으로 최대 볼륨이던 프레임 뒤만 센다.
   * 전체에서 `0<v<1`을 세면 시작의 페이드 인(head)까지 함께 잡혀, 꼬리가 없어도 통과한다.
   */
  tailFadingFrames(): number {
    const lastFull = this.heard.lastIndexOf(1);
    if (lastFull < 0) return 0;
    return this.heard.slice(lastFull + 1).filter((v) => v > 0 && v < 1).length;
  }
}

describe('2부 영상 이탈 경로별 오디오 페이드 (U93)', () => {
  const BASE: DriverOpts = {
    durationSec: 3,
    holdEndFrame: true,
    fadeSec: 0.5,
    audioCutFadeSec: 0.6,
  };

  it('(b) 홀드 영상이 끝까지 재생되어도 마지막 0.5초 동안 소리가 내려온다', () => {
    const d = new FullVideoAudioDriver(BASE);
    d.run(80);
    // 고친 자리: 예전에는 마지막 프레임까지 1.0이다가 파일이 끝나며 1 → 0 한 방이었다
    // (같은 하네스에 옛 분기를 넣으면 maxDrop이 정확히 1이고 꼬리 프레임이 0이다)
    expect(d.maxDrop()).toBeLessThan(0.35);
    expect(d.tailFadingFrames()).toBeGreaterThanOrEqual(6);
    expect(d.heard[d.heard.length - 1]).toBe(0);
    // 화면은 그대로 선다 — 소리만 내려온다 (검정이 끼면 마지막 프레임 홀드가 깨진다)
    expect(d.opacity).toBe(0);
    expect(d.phase).toBe('holding');
  });

  it('(a) 재생 도중 진행판으로 넘어가면 audioCutFadeSec 동안 내려간 뒤 멎는다', () => {
    const d = new FullVideoAudioDriver({ ...BASE, durationSec: 60 });
    d.run(10);
    expect(d.heard[d.heard.length - 1]).toBe(1);
    // scene/set 'submit' → resetRuntimeVideoPhase가 phase를 idle로 내리고 스윕이 씬을 덮는다
    d.phase = 'idle';
    d.wantScene = 'submit';
    d.shownScene = 'submit';
    d.run(30);
    expect(d.maxDrop()).toBeLessThan(0.35);
    expect(d.heard[d.heard.length - 1]).toBe(0);
    expect(d.elementPaused).toBe(true);
  });

  it('(c) 스팅어가 도는 동안 씬이 늦게 덮여도 그 시점부터 페이드가 걸린다', () => {
    const d = new FullVideoAudioDriver({ ...BASE, durationSec: 60 });
    d.run(10);
    d.phase = 'idle';
    d.wantScene = 'submit';
    // 스윕 0.45초 동안 shownScene은 아직 'video' — 소리는 계속 나가는 것이 맞다
    d.run(9);
    expect(d.heard[d.heard.length - 1]).toBe(1);
    d.shownScene = 'submit';
    d.run(30);
    expect(d.maxDrop()).toBeLessThan(0.35);
    expect(d.heard[d.heard.length - 1]).toBe(0);
  });

  it('(b-2) duration을 못 읽어 꼬리를 못 재도 holding 진입이 램프로 내린다', () => {
    // 꼬리 판정이 영영 안 열리는 에셋 — 예전에는 holding의 setGain(track, 0)이 그 자리에서 끊었다
    const d = new FullVideoAudioDriver({ ...BASE, durationSec: undefined });
    d.run(10);
    expect(d.heard[d.heard.length - 1]).toBe(1);
    d.phase = 'holding';
    d.run(30);
    expect(d.maxDrop()).toBeLessThan(0.35);
    expect(d.heard[d.heard.length - 1]).toBe(0);
  });

  it('(f) 꼬리 페이드 도중에 넘어가도 소리가 도로 커지지 않는다', () => {
    // 3초짜리 영상의 마지막 0.5초 = 소리 꼬리가 도는 중. 그때 운영자가 진행판을 누른다.
    const d = new FullVideoAudioDriver(BASE);
    d.run(57); // 2.85초 — 3초 영상의 꼬리(2.5초~)가 한참 내려간 지점
    const at = d.heard.length;
    expect(d.heard[at - 1]).toBeLessThan(1);
    expect(d.heard[at - 1]).toBeGreaterThan(0);
    d.phase = 'idle';
    d.wantScene = 'submit';
    d.shownScene = 'submit';
    d.run(30);
    // 예전에는 idle 분기가 게인을 1로 올려 소리가 튀어 오른 뒤 내려갔다
    expect(d.maxRiseAfter(at - 1)).toBe(0);
    expect(d.maxDrop()).toBeLessThan(0.35);
    expect(d.heard[d.heard.length - 1]).toBe(0);
  });

  it('(g) 스윕이 도는 0.45초 동안에도 튀지 않고 계속 내려간다', () => {
    const d = new FullVideoAudioDriver(BASE);
    d.run(57); // 2.85초 — 3초 영상의 꼬리(2.5초~)가 한참 내려간 지점
    const at = d.heard.length;
    // scene/set은 상태를 먼저 바꾸고, 화면은 스윕이 덮는 순간에 바뀐다
    d.phase = 'idle';
    d.wantScene = 'submit';
    d.run(9);
    // 스윕 내내 최대 볼륨으로 되돌아가 있으면 안 된다 (간헐 컷의 정체)
    expect(d.maxRiseAfter(at - 1)).toBe(0);
    d.shownScene = 'submit';
    d.run(30);
    expect(d.maxRiseAfter(at - 1)).toBe(0);
    expect(d.heard[d.heard.length - 1]).toBe(0);
  });

  it('(h) video/abort로 취소만 되고 영상은 계속 도는 경우에는 소리를 되돌린다', () => {
    // 취소는 씬을 건드리지 않는다 — 영상 씬에 그대로 머무르므로 소리도 그대로여야 한다
    const d = new FullVideoAudioDriver({ ...BASE, durationSec: 60 });
    d.run(4); // 머리 페이드 인 도중
    expect(d.heard[d.heard.length - 1]).toBeLessThan(1);
    d.phase = 'idle'; // wantScene·shownScene은 'video' 그대로
    d.run(20);
    expect(d.heard[d.heard.length - 1]).toBe(1);
    expect(d.elementPaused).toBe(false);
  });

  it('일반 영상(holdEndFrame false)의 소리는 지금까지대로 검정 불투명도와 같은 값이다', () => {
    const d = new FullVideoAudioDriver({ ...BASE, holdEndFrame: false });
    for (let i = 0; i < 80; i += 1) {
      d.step();
      if (d.phase !== 'playing' || d.elementPaused) continue;
      expect(d.track.gain).toBeCloseTo(volumeForOpacity(d.opacity), 12);
    }
    // 꼬리에서 검정이 끝까지 덮인다 (홀드 영상과 달리 화면도 함께 내려간다)
    expect(d.opacity).toBeCloseTo(1, 6);
  });
});

describe('display 배선 (U93)', () => {
  const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

  it('holding 분기가 소리를 곡선 없이 0으로 끊지 않는다', () => {
    const branch = source.match(/if \(v\.phase === 'holding'\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    expect(branch).not.toBe('');
    expect(branch).toContain('isAudible(videoMedia.track)');
    expect(branch).toContain('rampGain(videoMedia.track, 0, state.settings.audioCutFadeSec, now)');
    // 램프를 매 프레임 다시 걸면 시작값이 갱신되어 영영 0에 닿지 못한다
    expect(branch).toContain('videoMedia.track.ramp === null');
  });

  it('소리 게인은 시각 불투명도가 아니라 소리 꼬리 곡선에서 나온다', () => {
    expect(source).toContain('setGain(videoMedia.track, volumeForOpacity(audioOpacity))');
    expect(source).toMatch(/const audioOpacity = audioInTail\n\s*\? fadeOpacityAt\(now - audioTailStartedAt, tailMs, 'to-black'\)\n\s*: opacity;/);
  });

  it('되감기·일시정지에서 소리 꼬리도 시각 꼬리와 같이 다뤄진다', () => {
    expect(source).toMatch(/audioInTail = false;\n\s*audioTailStartedAt = 0;/);
    expect(source).toContain('if (audioInTail) audioTailStartedAt += sinceLastTick;');
  });

  it('idle 분기는 씬이 영상을 놓았으면 게인을 되돌리지 않는다', () => {
    // 되돌리면 정리 페이드가 최대 볼륨에서 시작해 소리가 튄다 (간헐 컷)
    expect(source).toContain(
      "if (pickScene(visualState()) === 'video') videoMedia.track = setGain(videoMedia.track, 1);",
    );
    // `shownScene`으로 판정하면 maybeTransition()이 tickFade()보다 뒤에 돌아 첫 프레임을 놓친다
    expect(source).not.toMatch(/if \(shownScene === 'video'\) videoMedia\.track = setGain/);
  });
});
