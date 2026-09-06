// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  blackoutAudioAxis,
  blackoutAudioGain,
  blackoutAudioMoving,
  cancelTeardown,
  idleTrack,
  cameraMuted,
  policyGain,
  requiresDocumentPresence,
  isAudible,
  rampGain,
  setGain,
  stepGain,
  teardownDecision,
  trackVolume,
  TRACK_FULL_GAIN,
  type GainTrack,
} from './audio-gain';
import { blackoutDurationMs, blackoutOpacity } from './blackout';
import { createInitialState, reducer } from './state';

/** 램프를 끝까지 굴려 정리 신호가 언제 나오는지 본다 */
function run(track: GainTrack, from: number, to: number, stepMs = 50) {
  const finishes: string[] = [];
  const gains: number[] = [];
  let t = track;
  for (let now = from; now <= to; now += stepMs) {
    const stepped = stepGain(t, now);
    t = stepped.track;
    gains.push(t.gain);
    if (stepped.finish !== 'none') finishes.push(stepped.finish);
  }
  return { track: t, finishes, gains };
}

describe('오디오 게인 매니저 (U27)', () => {
  it('정리는 게인이 0에 닿은 뒤 딱 한 번만 나온다', () => {
    const track = rampGain(idleTrack(1), 0, 0.6, 0, 'pause');
    const { finishes, track: end } = run(track, 0, 1500);
    expect(finishes).toEqual(['pause']);
    expect(end.gain).toBe(0);
    expect(end.after).toBe('none');
    // 다 끝난 트랙을 더 굴려도 정리가 다시 나오지 않는다
    expect(run(end, 1500, 3000).finishes).toEqual([]);
  });

  it('내려가는 도중에는 정리 신호가 없다 — 소리가 남아 있는데 끊으면 안 된다', () => {
    const track = rampGain(idleTrack(1), 0, 0.6, 0, 'release');
    for (const now of [0, 100, 300, 599]) {
      const stepped = stepGain(track, now);
      expect(stepped.finish).toBe('none');
      expect(stepped.track.gain).toBeGreaterThan(0);
    }
  });

  it('페이드 아웃 도중 다시 올리면 예약된 정리가 취소된다', () => {
    let track = rampGain(idleTrack(1), 0, 0.6, 0, 'release');
    track = stepGain(track, 300).track;
    const mid = track.gain;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    track = rampGain(track, 1, 0.6, 300);
    expect(track.after).toBe('none');
    // 현재 값에서 이어 올라간다 (점프 없음)
    expect(stepGain(track, 300).track.gain).toBeCloseTo(mid, 6);
    expect(run(track, 300, 1500).finishes).toEqual([]);
  });

  it('여러 트랙이 서로 간섭하지 않는다', () => {
    const a = rampGain(idleTrack(1), 0, 0.6, 0, 'pause');
    const b = rampGain(idleTrack(0), 1, 2, 0);
    const ra = run(a, 0, 2500);
    const rb = run(b, 0, 2500);
    expect(ra.finishes).toEqual(['pause']);
    expect(rb.finishes).toEqual([]);
    expect(ra.track.gain).toBe(0);
    expect(rb.track.gain).toBe(1);
  });

  it('페이드 길이 0이면 기다리지 않고 즉시 끊는다 (사용자가 컷을 고른 경우)', () => {
    expect(teardownDecision(idleTrack(1), 0)).toBe('now');
    expect(teardownDecision(idleTrack(1), 0.6)).toBe('fade');
    // 이미 무음이면 페이드할 것이 없다
    expect(teardownDecision(idleTrack(0), 0.6)).toBe('now');
  });

  it('내려가는 중인 트랙도 아직 들린다고 본다', () => {
    const track = rampGain(idleTrack(1), 0, 0.6, 0, 'pause');
    expect(isAudible(track)).toBe(true);
    expect(isAudible(idleTrack(0))).toBe(false);
    // 0에서 올라가려는 참이면 들릴 예정이다
    expect(isAudible(rampGain(idleTrack(0), 1, 0.6, 0))).toBe(true);
  });

  it('setGain은 소유자 곡선을 그대로 싣고 램프를 지운다 (검정 페이드 등)', () => {
    const track = setGain(idleTrack(1), 0.42);
    expect(track.gain).toBe(0.42);
    expect(track.ramp).toBeNull();
    expect(setGain(idleTrack(0), 9).gain).toBe(1);
    expect(setGain(idleTrack(0), -3).gain).toBe(0);
  });

  /**
   * **회귀 재현.** `⏭ 스킵`이 페이드 아웃을 걸어 두면 다음 프레임부터 `tickFade`의 idle 분기가
   * 매 프레임 `setGain(track, 1)`을 부른다. 예전 구현은 여기서 램프를 지워 게인이 1로 되돌아가고
   * 예약된 pause가 영영 실행되지 않았다 — 화면은 다음 씬인데 설명 영상 소리만 끝까지 나왔다.
   */
  it('정리가 예약된 트랙은 setGain을 무시한다 — 매 프레임 곡선이 정리를 덮지 못한다', () => {
    const pending = rampGain(idleTrack(1), 0, 0.6, 0, 'pause');
    // 곡선 소유자가 매 프레임 1로 되돌리려 해도 트랙이 그대로다
    expect(setGain(pending, 1)).toBe(pending);
    expect(setGain(pending, 0.5)).toBe(pending);
    expect(setGain(pending, 0)).toBe(pending);
  });

  it('매 프레임 setGain이 끼어들어도 정리는 제때 실행된다 (스킵 시나리오 전체)', () => {
    let track = rampGain(idleTrack(1), 0, 0.6, 0, 'pause');
    const finishes: string[] = [];
    let gainAtFinish = -1;
    let finishedAt = -1;
    for (let now = 0; now <= 1500; now += 16) {
      // display의 tickFade idle 분기가 하는 일 — 정리 중에는 무시되어야 한다
      track = setGain(track, 1);
      const stepped = stepGain(track, now);
      track = stepped.track;
      if (stepped.finish !== 'none') {
        finishes.push(stepped.finish);
        gainAtFinish = track.gain;
        finishedAt = now;
      }
    }
    expect(finishes).toEqual(['pause']);
    // 소리가 0에 닿은 뒤에 멈춘다
    expect(gainAtFinish).toBe(0);
    // 페이드 길이(0.6초)에 맞춰 멈춘다 — 즉시도 아니고 영영도 아니다
    expect(finishedAt).toBeGreaterThanOrEqual(600);
    expect(finishedAt).toBeLessThan(650);
  });

  it('정리가 끝난 뒤에는 setGain이 다시 통한다 (다음 재생이 살아난다)', () => {
    let track = rampGain(idleTrack(1), 0, 0.6, 0, 'pause');
    track = stepGain(track, 1000).track;
    expect(track.after).toBe('none');
    expect(setGain(track, 1).gain).toBe(1);
  });

  it('cancelTeardown 뒤에도 setGain이 곧바로 통한다 (새 소스가 붙은 경우)', () => {
    const pending = rampGain(idleTrack(1), 0, 0.6, 0, 'release');
    expect(setGain(cancelTeardown(pending), 1).gain).toBe(1);
  });

  it('마스터 볼륨은 곱으로만 합성된다 — 페이드 중 바꿔도 곡선이 흔들리지 않는다', () => {
    const track = idleTrack(0.5);
    expect(trackVolume(1, track)).toBeCloseTo(0.5, 9);
    expect(trackVolume(0.4, track)).toBeCloseTo(0.2, 9);
    expect(trackVolume(0, track)).toBe(0);
    // 마스터를 바꿔도 트랙 게인 자체는 그대로다
    expect(track.gain).toBe(0.5);
  });
});

/**
 * **D5 회귀 — 문서에서 떨어지면 브라우저가 알아서 멈춘다.**
 *
 * HTML 명세: media element가 문서에서 제거되면 사용자 에이전트가 `pause()`한다. 씬이 갈리며
 * stage innerHTML이 통째로 바뀌면 그 안의 `<video>`가 정확히 그렇게 된다 — 볼륨 램프는 멀쩡히
 * 돌지만 소리는 이미 하드 컷이고, 페이드는 멈춘 엘리먼트 위에서 헛돈다.
 * 여기서는 그 브라우저 동작을 흉내 낸 하네스로 파킹이 실제로 소리를 지켜 내는지 본다.
 */
describe('고스트 테일은 문서 안에 남아야 한다 (U27 D5)', () => {
  /** 문서에서 떼면 스스로 멈추는 media element (명세 동작) */
  class FakeMedia {
    connected = true;
    paused = false;
    volume = 1;
    /** 실제로 소리가 나간 프레임 수 — 페이드가 들릴 자리가 있었는지의 증거 */
    audibleFrames = 0;

    /** stage innerHTML이 갈려 문서에서 떨어진다 */
    detach(): void {
      this.connected = false;
      this.pendingAutoPause = true;
    }

    /** 화면 밖 보관함으로 옮긴다 — 문서에는 남는다 */
    park(): void {
      this.connected = true;
    }

    /**
     * 명세의 "await a stable state" — 제거 처리는 **같은 동기 턴이 끝난 뒤** 실행되고,
     * 그때까지 문서에 다시 붙어 있으면 pause하지 않는다. 파킹이 통하는 근거가 이 지연이다.
     */
    settle(): void {
      if (!this.pendingAutoPause) return;
      this.pendingAutoPause = false;
      if (!this.connected) this.paused = true;
    }

    pendingAutoPause = false;

    tick(volume: number): void {
      this.volume = volume;
      if (!this.paused && volume > 0) this.audibleFrames += 1;
    }
  }

  /** 씬 컷 → 페이드 아웃 → 정리까지 한 번 돌린다 */
  function runCut(park: boolean) {
    const el = new FakeMedia();
    let track = rampGain(idleTrack(1), 0, 0.6, 0, 'pause');
    // 씬이 갈린다 — stage innerHTML 교체
    el.detach();
    if (park) el.park();
    el.settle(); // 동기 턴이 끝난다
    let finished = false;
    for (let now = 0; now <= 1200; now += 16) {
      const stepped = stepGain(track, now);
      track = stepped.track;
      el.tick(track.gain);
      if (stepped.finish === 'pause') {
        finished = true;
        el.paused = true;
      }
    }
    return { el, finished, track };
  }

  it('파킹하지 않으면 램프가 도는 내내 소리가 이미 끊겨 있다 (하드 컷)', () => {
    const { el, finished } = runCut(false);
    expect(el.connected).toBe(false);
    expect(el.paused).toBe(true);
    // 페이드가 들릴 자리가 한 프레임도 없었다
    expect(el.audibleFrames).toBe(0);
    // 램프 자체는 멀쩡히 끝난다 — 그래서 코드만 봐서는 정상으로 보였다
    expect(finished).toBe(true);
  });

  it('파킹하면 페이드가 실제로 들린 뒤에 멈춘다', () => {
    const { el, finished, track } = runCut(true);
    expect(el.connected).toBe(true);
    expect(finished).toBe(true);
    expect(track.gain).toBe(0);
    // 0.6초 페이드 동안 소리가 계속 나갔다 (16ms 간격이면 35프레임 안팎)
    expect(el.audibleFrames).toBeGreaterThan(30);
    // 끝나면 멈춘다
    expect(el.paused).toBe(true);
  });

  it('소리가 남았거나 정리가 예약된 동안에는 문서에 남아 있어야 한다', () => {
    expect(requiresDocumentPresence(rampGain(idleTrack(1), 0, 0.6, 0, 'pause'))).toBe(true);
    expect(requiresDocumentPresence(idleTrack(1))).toBe(true);
    expect(requiresDocumentPresence(rampGain(idleTrack(0), 1, 0.6, 0))).toBe(true);
    // 무음이고 예약도 없으면 떼어 내도 된다
    expect(requiresDocumentPresence(idleTrack(0))).toBe(false);
  });

  /**
   * **D5-3 회귀.** 실측: 씬 컷 후 카메라 volume이 1 → 0으로 내려갔다가 **+880ms에 1로 복귀**하고
   * unmute됐다. 정리가 끝나며 `after`가 `'none'`으로 돌아가는 순간, 매 프레임 게인을 1로
   * 되돌리던 정책이 그 다음 프레임부터 다시 통했기 때문이다.
   */
  describe('카메라는 치워 둔 동안 소리가 되살아나지 않는다 (D5-3)', () => {
    /** display의 매 프레임 카메라 정책을 그대로 흉내 낸다 */
    function runCameraCut(parkedPolicy: boolean) {
      let track = rampGain(idleTrack(1), 0, 0.6, 0, 'mute');
      const parked = true; // 씬 컷으로 화면 밖에 있다
      let muted = false;
      let finished = false;
      const afterFinish: { gain: number; muted: boolean }[] = [];

      for (let frame = 0; frame <= 120; frame += 1) {
        const now = frame * 16;
        const stepped = stepGain(track, now);
        track = stepped.track;
        if (stepped.finish === 'mute') {
          muted = true; // camMedia.finish
          finished = true;
        }
        // 매 프레임 정책 — `parkedPolicy`가 false면 옛 동작(무조건 게인 복원)
        muted = cameraMuted({
          audioEnabled: true,
          policyBlocked: false,
          parked: parkedPolicy ? parked : false,
          gain: track.gain,
        });
        track = policyGain(track, parkedPolicy ? parked : false, 1);
        if (finished) afterFinish.push({ gain: track.gain, muted });
      }
      return { finished, afterFinish };
    }

    /** 컷 순간부터 완료까지 매 프레임의 (volume, muted)를 기록한다 */
    function traceCut() {
      let track = rampGain(idleTrack(1), 0, 0.6, 0, 'mute');
      const parked = true;
      const during: { gain: number; muted: boolean }[] = [];
      const after: { gain: number; muted: boolean }[] = [];
      let finished = false;
      for (let frame = 0; frame <= 120; frame += 1) {
        const stepped = stepGain(track, frame * 16);
        track = stepped.track;
        if (stepped.finish === 'mute') finished = true;
        track = policyGain(track, parked, 1);
        const muted = cameraMuted({
          audioEnabled: true,
          policyBlocked: false,
          parked,
          gain: track.gain,
        });
        (finished ? after : during).push({ gain: track.gain, muted });
      }
      return { during, after };
    }

    it('컷 후 램프가 도는 동안 실제로 들린다 — 매 프레임 unmuted이고 볼륨이 내려간다', () => {
      const { during } = traceCut();
      expect(during.length).toBeGreaterThan(30);
      for (const frame of during) {
        expect(frame.muted).toBe(false);
        expect(frame.gain).toBeGreaterThan(0);
      }
      // 단조 하강
      for (let i = 1; i < during.length; i += 1) {
        expect(during[i].gain).toBeLessThanOrEqual(during[i - 1].gain + 1e-9);
      }
      expect(during[during.length - 1].gain).toBeLessThan(during[0].gain);
    });

    it('완료 뒤에는 muted를 유지한다', () => {
      const { after } = traceCut();
      expect(after.length).toBeGreaterThanOrEqual(60);
      for (const frame of after.slice(0, 60)) {
        expect(frame.gain).toBe(0);
        expect(frame.muted).toBe(true);
      }
    });

    it('옛 정책은 정리 직후 게인 1로 복귀하고 unmute된다 (재현)', () => {
      const { finished, afterFinish } = runCameraCut(false);
      expect(finished).toBe(true);
      // 정리 다음 프레임부터 소리가 되살아난다
      const revived = afterFinish.filter((f) => f.gain > 0 && !f.muted);
      expect(revived.length).toBeGreaterThan(50);
    });

    /**
     * 페이드가 끝나기 **전에** 중계로 돌아오는 경우. 예약된 `'mute'`가 살아 있으면
     * 화면에 카메라가 떠 있는데 소리만 죽는다.
     */
    it('audioCutFadeSec 안에 중계로 돌아오면 소리가 유지된다', () => {
      let track = rampGain(idleTrack(1), 0, 0.6, 0, 'mute');
      let parked = true;
      let muted = false;

      // 0.3초 뒤 중계 복귀 — 아직 페이드가 도는 중이다
      for (let now = 0; now < 300; now += 16) {
        track = stepGain(track, now).track;
        track = policyGain(track, parked, 1);
      }
      const atReturn = track.gain;
      expect(atReturn).toBeGreaterThan(0);
      expect(atReturn).toBeLessThan(1);

      // attachSlots의 camSlot 분기가 하는 일
      parked = false;
      track = rampGain(cancelTeardown(track), 1, 0.6, 300);
      expect(track.after).toBe('none');

      const finishes: string[] = [];
      const rising: number[] = [];
      let prev = atReturn;
      for (let now = 300; now <= 2000; now += 16) {
        const stepped = stepGain(track, now);
        track = stepped.track;
        if (stepped.finish !== 'none') finishes.push(stepped.finish);
        track = policyGain(track, parked, 1);
        muted = cameraMuted({ audioEnabled: true, policyBlocked: false, parked, gain: track.gain });
        // 복귀 뒤에는 한 프레임도 음소거되지 않는다
        expect(muted).toBe(false);
        // 중간값 — 0.344에서 1로 점프하지 않고 실제로 올라간다
        if (track.gain > prev && track.gain < 1) rising.push(track.gain);
        prev = track.gain;
      }
      // 램프가 살아 있었다는 증거: 사이 값이 여러 프레임 걸쳐 나온다
      expect(rising.length).toBeGreaterThanOrEqual(5);
      // 예약된 mute가 죽었다 — 화면에 뜬 카메라를 뒤늦게 끄지 않는다
      expect(finishes).toEqual([]);
      expect(track.gain).toBe(1);
    });

    it('치워 둔 동안에는 완료 후 60프레임 내내 게인 0·muted를 유지한다', () => {
      const { finished, afterFinish } = runCameraCut(true);
      expect(finished).toBe(true);
      expect(afterFinish.length).toBeGreaterThanOrEqual(60);
      for (const frame of afterFinish.slice(0, 60)) {
        expect(frame.gain).toBe(0);
        expect(frame.muted).toBe(true);
      }
    });
  });

  it('음소거는 설정·정책 차단·"치운 채 무음"에서만 켜진다', () => {
    const base = { audioEnabled: true, policyBlocked: false, parked: false, gain: 1 };
    expect(cameraMuted(base)).toBe(false);
    expect(cameraMuted({ ...base, audioEnabled: false })).toBe(true);
    expect(cameraMuted({ ...base, policyBlocked: true })).toBe(true);
    // **치웠다는 사실만으로는 끄지 않는다** — 그래야 페이드가 들린다
    expect(cameraMuted({ ...base, parked: true })).toBe(false);
    expect(cameraMuted({ ...base, parked: true, gain: 0.4 })).toBe(false);
    expect(cameraMuted({ ...base, parked: true, gain: 0 })).toBe(true);
  });

  it('policyGain은 치워 둔 트랙과 도는 램프를 건드리지 않는다', () => {
    const parkedTrack = idleTrack(0);
    expect(policyGain(parkedTrack, true, 1)).toBe(parkedTrack);
    expect(policyGain(parkedTrack, false, 1).gain).toBe(1);
    // 진행 중인 램프의 주인은 그 램프다 — 덮으면 목표값으로 점프한다
    const ramping = rampGain(idleTrack(0.3), 1, 0.6, 0);
    expect(policyGain(ramping, false, 1)).toBe(ramping);
  });

  it('카메라는 pause가 아니라 mute로 정리한다 (스트림이라 멈추면 미리보기가 죽는다)', () => {
    let track = rampGain(idleTrack(1), 0, 0.6, 0, 'mute');
    const finishes: string[] = [];
    for (let now = 0; now <= 1200; now += 16) {
      const stepped = stepGain(track, now);
      track = stepped.track;
      if (stepped.finish !== 'none') finishes.push(stepped.finish);
    }
    expect(finishes).toEqual(['mute']);
  });
});

/**
 * **계약 잠금.** 소리가 나는 엘리먼트의 `pause()`·`src` 해제는 게인이 0에 닿은 뒤에만 일어나야
 * 한다. display에서 그 호출부를 전수로 훑어 매니저 경유인지 확인한다 — 새 경로가 매니저를
 * 우회하면 여기서 걸린다.
 */
describe('소리 나는 미디어는 매니저를 통해서만 끊긴다', () => {
  const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

  /**
   * **꼬리 페이드를 갖는** 엘리먼트. 이 목록의 `pause()`·`src` 해제는 게인이 0에 닿은 뒤여야 한다.
   *
   * `transitionVideoEl`은 U102부터 소리를 내지만 여기 없다 — 스팅어는 1.5초 컷 효과음이라
   * 애초에 내릴 꼬리가 없고, 게인은 언제나 만점 그대로다(램프를 걸지 않는다). 그 자리의 계약은
   * "끊기 전에 페이드"가 아니라 "겹쳐서 나되 볼륨은 매니저가 쥔다"이며,
   * `src/transition-audio.test.ts`가 그쪽을 따로 잠근다. `.volume` 단일 경로 계약은 아래 첫 번째
   * 검사가 파일 전체를 훑으므로 전환도 그대로 포함된다.
   */
  const AUDIBLE = ['videoEl', 'overlayVideoEl'];

  it('el.volume을 쓰는 자리는 매니저 한 곳뿐이다', () => {
    const writes = [...display.matchAll(/(\w+)\.volume = ([^\n;]+)/g)].map((m) => `${m[1]}.volume = ${m[2]}`);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write).toMatch(/trackVolume\(/);
    }
  });

  it('카메라는 pause 호출 자체가 없다 — 스트림이라 멈추면 미리보기가 죽는다', () => {
    expect(display).not.toMatch(/camEl\.pause\(\)/);
    // 정리는 mute다. U88부터 그 mute도 단일 헬퍼를 거친다(창 모드·모니터 축이 함께 곱해진다).
    expect(display).toContain('setOutputMuted(camEl, true);');
  });

  it('소리 나는 엘리먼트의 pause()·src 해제는 정리 콜백 안이거나 명시적으로 면제된 자리뿐이다', () => {
    for (const name of AUDIBLE) {
      const calls = [...display.matchAll(new RegExp(`${name}\\.(pause\\(\\)|removeAttribute\\('src'\\))`, 'g'))];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // 매니저의 정리 콜백(`finish:`)이거나, 이유를 적은 `AUDIO-CUT-EXEMPT` 표식이 있어야 한다.
        // 표식을 일부러 써야만 우회할 수 있으므로 새 경로가 조용히 새지 않는다.
        const before = display.slice(Math.max(0, call.index - 500), call.index);
        const ok = before.includes('finish:') || before.includes('AUDIO-CUT-EXEMPT');
        expect([name, call[0], ok]).toEqual([name, call[0], true]);
      }
    }
  });

  it('면제는 조작 패널 일시정지 한 자리뿐이다 (화면도 함께 멎어야 하는 경우)', () => {
    const marks = [...display.matchAll(/AUDIO-CUT-EXEMPT/g)];
    expect(marks).toHaveLength(1);
    expect(display).toMatch(/AUDIO-CUT-EXEMPT[\s\S]{0,400}videoEl\.pause\(\)/);
  });

  it('페이드 아웃 중 새 소스가 붙으면 예약을 먼저 취소하고 게인을 올린다', () => {
    // 순서가 뒤집히면 `setGain`이 예약 때문에 무시되어 옛 페이드 아웃 램프가 새 소스에 남는다
    expect(display).toContain('setGain(cancelTeardown(videoMedia.track), 1)');
    expect(display).not.toContain('cancelTeardown(setGain(videoMedia.track, 1))');
  });

  it('소리가 남은 엘리먼트가 문서 밖이면 도로 붙인다 (자가 복구 그물)', () => {
    expect(display).toContain(
      'if (requiresDocumentPresence(media.track) && !media.el.isConnected) parkMedia(media.el);',
    );
  });

  it('중계 복귀는 예약된 정리를 취소하고 램프로 올린다 (컷 금지)', () => {
    expect(display).toMatch(
      /cameraAudioParked = false;\s*\n\s*camMedia\.track = rampGain\(\s*\n?\s*cancelTeardown\(camMedia\.track\),/,
    );
  });

  it('슬롯이 사라지면 문서에 남긴 채 보관함으로 옮긴다 (D5)', () => {
    expect(display).toContain("mediaTailEl.id = 'media-tail'");
    expect(display).toContain('function parkMedia(el: HTMLMediaElement)');
    // 두 슬롯 모두 else 분기에서 파킹한다 — 하나라도 빠지면 그 경로가 하드 컷이 된다
    expect(display).toMatch(/const videoSlot[\s\S]{0,200}\} else \{\s*\n\s*parkMedia\(videoEl\);/);
    expect(display).toMatch(/\} else \{[\s\S]{0,200}parkMedia\(camEl\);\s*\n\s*requestAudioTeardown\(camMedia, 'mute', now\);/);
  });

  it('카메라 음소거·게인 복원은 치움 플래그를 함께 본다 (D5-3)', () => {
    expect(display).toContain('let cameraAudioParked = false;');
    expect(display).toContain('parked: cameraAudioParked,');
    expect(display).toContain('camMedia.track = policyGain(camMedia.track, cameraAudioParked, 1);');
    // 무조건 게인을 되돌리던 옛 정책이 되살아나면 소리가 다시 살아난다
    expect(display).not.toContain('camMedia.track = setGain(camMedia.track, 1)');
    // 치움은 파킹과 같은 자리에서 세우고, 중계 재진입에서만 풀린다
    expect(display).toMatch(/cameraAudioParked = true;\s*\n\s*parkMedia\(camEl\);/);
    expect(display).toMatch(/cameraAudioParked = false;[\s\S]{0,220}rampGain\(\s*\n?\s*cancelTeardown\(camMedia\.track\)/);
  });

  it('급격한 전환 경로는 requestAudioTeardown을 지난다', () => {
    expect(display).toContain('function requestAudioTeardown(');
    expect(display).toContain("requestAudioTeardown(overlayMedia, 'release'");
    expect(display).toContain("requestAudioTeardown(videoMedia, 'pause', now)");
    // 시각은 기다리지 않는다 — 숨김은 요청 시점에 이미 끝나 있다
    expect(display).toMatch(/overlayVideoEl\.hidden = true;\s*\n\s*requestAudioTeardown/);
  });

  it('음악 덱도 같은 매니저 위에 있다 (볼륨 경로가 둘로 갈리지 않는다)', () => {
    expect(display).toContain('deck.track = stepped.track');
    // 음악 덱은 마스터에 덕킹 축(U44)까지 곱한 값을 쓴다 — 게인 경로 자체는 그대로 하나다
    expect(display).toContain('deck.el.volume = trackVolume(musicMaster, deck.track)');
    // U95부터 암전 축이 하나 더 곱해진다 — 축이 늘어도 게인 경로는 여전히 이 두 줄뿐이다
    expect(display).toContain('const musicMaster = heardMusic(now) * musicDuck.value * blackoutAudio;');
    expect(display).toContain('media.el.volume = trackVolume(master, media.track)');
  });
});

/**
 * **U95** — 사용자 지시(01:02): "화면 암전 버튼 누를 시 사운드도 페이드아웃 되게 해줘."
 *
 * 암전은 U65에서 화면만 덮었다. 소리는 **덕킹(U44)과 같은 형태의 별도 축**으로 붙는다 —
 * 트랙 게인·`.muted`를 건드리지 않고 매 프레임 곱으로만 합성한다.
 */
describe('암전 오디오 축 (U95)', () => {
  const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
  /** 기본 암전 길이(초). 상태 기본값이 바뀌면 여기서 먼저 걸린다. */
  const SEC = createInitialState().settings.blackoutSec;

  it('켤 때 0 · 중간 · 끝 세 지점이 1 → 0.5 → 0이다', () => {
    const ms = blackoutDurationMs(SEC, 0, 1);
    expect(ms).toBe(5000);
    expect(blackoutAudioGain(0, ms, 0, 1)).toBe(1);
    expect(blackoutAudioGain(2500, ms, 0, 1)).toBeCloseTo(0.5, 6);
    expect(blackoutAudioGain(5000, ms, 0, 1)).toBe(0);
  });

  it('해제 램프는 같은 세 지점을 거꾸로 지난다', () => {
    const ms = blackoutDurationMs(SEC, 1, 0);
    expect(blackoutAudioGain(0, ms, 1, 0)).toBe(0);
    expect(blackoutAudioGain(2500, ms, 1, 0)).toBeCloseTo(0.5, 6);
    expect(blackoutAudioGain(5000, ms, 1, 0)).toBe(1);
  });

  it('그림과 **같은 곡선 하나**에서 나온다 — 값은 정확히 1 − 불투명도', () => {
    const ms = blackoutDurationMs(SEC, 0, 1);
    for (const t of [0, 400, 1200, 2500, 3800, 5000, 9999]) {
      expect(blackoutAudioGain(t, ms, 0, 1)).toBe(1 - blackoutOpacity(t, ms, 0, 1));
    }
  });

  it('길이가 0이면 컷으로 강등된다 (설정에서 암전 페이드를 0으로 둔 경우)', () => {
    expect(blackoutAudioGain(0, blackoutDurationMs(0, 0, 1), 0, 1)).toBe(0);
  });

  it('램프 도중 뒤집어도 지금 들리는 크기에서 이어진다 — 점프가 없다', () => {
    // 상태의 `fromOpacity`가 곧 지금 보이는 값이라, 축은 저절로 현재 값에서 출발한다.
    const base = createInitialState();
    const on = reducer(base, { type: 'blackout/set', on: true, now: 0 });
    // 절반(2.5초) 지점: 소리도 정확히 절반
    expect(blackoutAudioAxis(on.sceneOpts.blackout, SEC, 2_500)).toBeCloseTo(0.5, 6);
    const off = reducer(on, { type: 'blackout/set', on: false, now: 2_500 });
    // 뒤집은 **그 프레임**의 값이 이어진다 (여기서 튀면 소리가 끊긴 것처럼 들린다)
    expect(blackoutAudioAxis(off.sceneOpts.blackout, SEC, 2_500)).toBeCloseTo(0.5, 6);
    // 남은 거리도 절반이라 2.5초 뒤 원래대로 (거리 비례 — 그림과 같은 시각에 도착한다)
    expect(blackoutAudioAxis(off.sceneOpts.blackout, SEC, 5_000)).toBeCloseTo(1, 6);
  });

  it('암전 중에도 상태는 씬·소리 원장을 건드리지 않는다 — 축은 파생값이다', () => {
    const base = createInitialState();
    const on = reducer(base, { type: 'blackout/set', on: true, now: 0 });
    expect(on.music).toBe(base.music);
    expect(on.volumeRamps).toBe(base.volumeRamps);
    expect(on.settings).toBe(base.settings);
  });

  it('덕킹·마스터와 **곱**으로 합성된다 — 축이 서로를 지우지 않는다', () => {
    const music = 1;
    const duck = 0.5;
    const blackout = blackoutAudioGain(2_500, blackoutDurationMs(SEC, 0, 1), 0, 1); // 0.5
    const full = idleTrack(1);
    // 음악: music × duck × blackout = 0.25. 트랙 게인은 만점 그대로다.
    expect(trackVolume(music * duck * blackout, full)).toBeCloseTo(0.25, 6);
    // 축 하나가 1로 돌아와도 나머지는 그대로 살아 있다 (이중 적용 금지의 반대 증거)
    expect(trackVolume(music * 1 * blackout, full)).toBeCloseTo(0.5, 6);
  });

  it('축이 움직이는 동안만 50ms 루프를 깨운다 (엡실론 안이면 멎는다)', () => {
    expect(blackoutAudioMoving(1, false)).toBe(false);
    expect(blackoutAudioMoving(1, true)).toBe(true);
    expect(blackoutAudioMoving(0, true)).toBe(false);
    expect(blackoutAudioMoving(0, false)).toBe(true);
    // 부동소수 잔차로 영영 안 멎는 일이 없어야 한다
    expect(blackoutAudioMoving(0.99999999, false)).toBe(false);
    expect(blackoutAudioMoving(0.99, false)).toBe(true);
  });

  it('display는 축을 곱으로만 심는다 — 두 마스터에 모두 걸린다', () => {
    expect(display).toContain(
      'blackoutAudio = blackoutAudioAxis(state.sceneOpts.blackout, state.settings.blackoutSec, now);',
    );
    expect(display).toContain('const master = heardMaster(now) * blackoutAudio;');
    expect(display).toContain('const musicMaster = heardMusic(now) * musicDuck.value * blackoutAudio;');
    // 영상·오버레이·카메라는 `master`, 음악 덱은 `musicMaster` — 소리 나는 다섯이 전부 덮인다
    expect(display).toContain('media.el.volume = trackVolume(master, media.track)');
    expect(display).toContain('deck.el.volume = trackVolume(musicMaster, deck.track)');
  });

  it('트랙 게인과 `.muted`는 건드리지 않는다 (U88 창 음소거·꼬리 페이드는 별개 축)', () => {
    expect(display).not.toMatch(/setGain\([^)]*blackoutAudio/);
    expect(display).not.toMatch(/rampGain\([^)]*blackoutAudio/);
    expect(display).not.toMatch(/setOutputMuted\([^)]*blackout/i);
  });

  it('라이브 상태를 읽는다 — FREEZE 중에도 암전은 즉시 듣는다', () => {
    expect(display).not.toContain('blackoutAudioAxis(visualState()');
  });

  it('50ms 오디오 루프가 암전 램프에도 깨어난다 (없으면 400ms 계단이 아니라 아예 안 내려간다)', () => {
    expect(display).toContain(
      'const blackoutMoving = blackoutAudioMoving(blackoutAudio, state.sceneOpts.blackout.active);',
    );
    expect(display).toMatch(/!duckMoving &&\s*\n\s*!blackoutMoving &&/);
  });
});

describe('음악 인커밍 컷 vs 페이드 (U122) — 실제 게인 프레임', () => {
  const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

  /**
   * `fadeInMusicDeck`/`cutInMusicDeck`은 둘 다 `startMusicRamp(deck, TRACK_FULL_GAIN, now,
   * 'none', fadeSec)`를 거쳐 여기 `rampGain`으로 떨어진다 — 그 산수를 그대로 굴려서
   * "즉시 목표"와 "musicFadeSec에 걸쳐 서서히"가 실제로 다른 프레임 수를 낸다는 것을 확인한다.
   */
  function incomingFrames(fadeSec: number, musicFadeSec = 5) {
    const track = rampGain(idleTrack(0), TRACK_FULL_GAIN, fadeSec, 0, 'none');
    return run(track, 0, musicFadeSec * 1000 + 200, 200);
  }

  it('cut-in(fadeSec 0)은 다음 프레임에서 곧바로 목표 게인이다 — 중간값이 없다', () => {
    const { gains } = incomingFrames(0);
    expect(gains[0]).toBe(TRACK_FULL_GAIN);
    expect(gains.every((g) => g === TRACK_FULL_GAIN)).toBe(true);
  });

  it('fade-in(musicFadeSec 5)은 여러 프레임에 걸쳐 서서히 오른다 — 중간값이 있다', () => {
    const { gains } = incomingFrames(5);
    expect(gains[0]).toBeLessThan(TRACK_FULL_GAIN);
    expect(gains.some((g) => g > 0 && g < TRACK_FULL_GAIN)).toBe(true);
    expect(gains[gains.length - 1]).toBe(TRACK_FULL_GAIN);
  });

  it('크로스페이드 중 아웃고잉은 attack과 무관하게 항상 musicFadeSec에 걸쳐 내려간다', () => {
    // 옛 덱은 fadeIn 값을 보지 않는다 — musicFadePlan의 outgoing은 attack 인자를 받지 않는다
    // (실행부는 항상 startMusicRamp(outgoing, 0, now, plan.outgoing)를 그대로 쓴다).
    const outgoing = rampGain(idleTrack(1), 0, 5, 0, 'release');
    const { finishes, gains } = run(outgoing, 0, 5200, 200);
    expect(finishes).toEqual(['release']);
    // 5초 램프이므로 도중(2.4초)에는 아직 완전히 내려가지 않는다
    expect(gains[12]).toBeGreaterThan(0);
    expect(gains[12]).toBeLessThan(1);
  });

  it('display는 plan.incoming을 fade-in/cut-in 둘로 분기하고, cut-in만 fadeSec 0을 넘긴다', () => {
    expect(display).toContain("if (plan.incoming === 'fade-in') fadeInMusicDeck(deck, now);");
    expect(display).toContain("else if (plan.incoming === 'cut-in') cutInMusicDeck(deck, now);");
    expect(display).toContain('startMusicRamp(deck, TRACK_FULL_GAIN, now, \'none\', 0);');
    // fadeInMusicDeck은 musicFadeSec 기본값을 그대로 쓴다 — fadeSec 인자를 따로 넘기지 않는다
    expect(display).toMatch(/function fadeInMusicDeck[\s\S]{0,120}startMusicRamp\(deck, TRACK_FULL_GAIN, now, 'none'\);/);
  });
});
