import { describe, expect, it } from 'vitest';

import {
  ReplayPlayback,
  type ReplayPlaybackEvent,
  type ReplayVideoLike,
} from './replay-playback';
import type { ReplayRingLike, RingCut } from './replay-ring';

/** `<video>` 흉내 — 이벤트를 테스트가 직접 쏘고, 붙었다 떨어지는 리스너 수까지 센다. */
class FakeVideo implements ReplayVideoLike {
  hidden = true;
  src = '';
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  loads = 0;
  playCalls = 0;
  playResult: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<string, Set<() => void>>();

  pause(): void {
    this.paused = true;
  }
  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return this.playResult;
  }
  load(): void {
    this.loads += 1;
    // 실제 <video>도 소스를 비우고 load()하면 emptied가 뜬다 — 정리가 만드는 이 신호를
    // 실패로 오인하지 않는지가 이 파일의 검사 대상 중 하나다.
    this.fire('emptied');
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function cutOf(bytes: number, coveredMs: number): RingCut {
  return { blob: new Blob(['x'.repeat(bytes)]), coveredMs };
}

function harness(
  options: {
    bufferedMs?: number;
    cut?: () => Promise<RingCut | null>;
    loadTimeoutMs?: number;
  } = {},
) {
  const video = new FakeVideo();
  const events: ReplayPlaybackEvent[] = [];
  const revoked: string[] = [];
  const created: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  let nextUrlId = 1;
  let ring: ReplayRingLike | null = {
    bufferedMs: () => options.bufferedMs ?? 10_000,
    cut: options.cut ?? (async () => cutOf(64, 20_000)),
  };

  const playback = new ReplayPlayback({
    video,
    ring: () => ring,
    createObjectURL: () => {
      const url = `blob:replay-${nextUrlId++}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => void revoked.push(url),
    emit: (event) => void events.push(event),
    setTimeout: (fn, _ms) => {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    loadTimeoutMs: options.loadTimeoutMs,
  });

  /** 대기 중인 마이크로태스크를 흘려 비동기 사슬을 한 단계씩 진행시킨다 */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  return {
    playback,
    video,
    events,
    revoked,
    created,
    settle,
    fireTimers: () => {
      for (const fn of [...timers.values()]) fn();
    },
    pendingTimers: () => timers.size,
    dropRing: () => {
      ring = null;
    },
  };
}

const REQUEST = { token: 1, seconds: 10, rate: 0.5 };

describe('리플레이 재생 사슬 — 정상 경로', () => {
  it('잘라 낸 구간을 붙이고, 벽시계 역산 위치로 시크한 뒤 배속을 걸고 튼다', async () => {
    const h = harness({ cut: async () => cutOf(64, 20_000) });

    h.playback.request(REQUEST);
    await h.settle();

    expect(h.video.src).toBe('blob:replay-1');
    expect(h.video.hidden).toBe(false);

    h.video.fire('loadedmetadata');
    await h.settle();

    // coveredMs 20s − seconds 10s = 10초 지점부터
    expect(h.video.currentTime).toBe(10);
    expect(h.video.playbackRate).toBe(0.5);
    expect(h.video.playCalls).toBe(1);
    expect(h.events).toEqual([]);
  });

  /**
   * U85 — 나가는 컷도 스팅어가 덮기로 했으므로 종료가 화면을 **놓지 않는다**.
   *
   * 여기서 곧바로 숨기면 라이브 카메라가 그 프레임에 드러나고, control이 그 뒤에 띄우는
   * 스팅어는 이미 끝난 컷을 덮게 된다 — 사용자가 본 "리플레이 끝날 때 스팅어가 안 나온다"의
   * 실체다. 화면을 실제로 놓는 것은 control이 컷을 내려 `stop()`이 불릴 때다.
   */
  it('끝까지 돌면 마지막 프레임을 붙잡은 채 종료만 보고한다 (U85)', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();
    h.video.fire('loadedmetadata');
    await h.settle();

    h.video.fire('ended');

    expect(h.video.paused).toBe(true);
    // 스팅어가 덮기 전에 카메라가 드러나면 안 된다
    expect(h.video.hidden).toBe(false);
    expect(h.revoked).toEqual([]);
    expect(h.events).toEqual(['replay-ended:1']);
  });

  it('control이 컷을 내려 stop()이 불릴 때 비로소 화면과 리소스를 놓는다 (U85)', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();
    h.video.fire('loadedmetadata');
    await h.settle();
    h.video.fire('ended');

    h.playback.stop();

    expect(h.video.hidden).toBe(true);
    expect(h.revoked).toEqual(['blob:replay-1']);
    // 정리가 만드는 `emptied`를 실패로 오인해 unavailable을 내지 않는다
    expect(h.events).toEqual(['replay-ended:1']);
  });

  /**
   * 붙잡기에는 반드시 상한이 있어야 한다. control 창이 닫혔거나 리더가 죽어 컷이 영영 오지
   * 않으면 정지 프레임이 카메라 위에 그대로 남는다 — U85 이전 계약이 막고 있던 사고다.
   */
  it('컷이 영영 오지 않으면 상한 시간 뒤에 스스로 화면을 놓는다 (U85 안전망)', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();
    h.video.fire('loadedmetadata');
    await h.settle();
    h.video.fire('ended');

    expect(h.video.hidden).toBe(false);
    h.fireTimers();

    expect(h.video.hidden).toBe(true);
    expect(h.revoked).toEqual(['blob:replay-1']);
    // 안전망은 화면만 놓는다 — 종료 보고를 두 번 내지 않는다
    expect(h.events).toEqual(['replay-ended:1']);
  });

  it('컷이 제때 오면 안전망 타이머는 남지 않는다', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();
    h.video.fire('loadedmetadata');
    await h.settle();
    h.video.fire('ended');
    expect(h.pendingTimers()).toBe(1);

    h.playback.stop();
    expect(h.pendingTimers()).toBe(0);
  });

  it('종료 뒤에도 같은 요청이 계속 들어오지만 다시 틀지 않는다', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();
    h.video.fire('loadedmetadata');
    await h.settle();
    h.video.fire('ended');
    await h.settle();

    // 상태가 아직 돌아오기 전 프레임들
    h.playback.request(REQUEST);
    h.playback.request(REQUEST);
    await h.settle();

    expect(h.video.playCalls).toBe(1);
    expect(h.events).toEqual(['replay-ended:1']);
  });

  it('정지 뒤에 늦게 온 ended는 아무것도 보고하지 않는다', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();
    h.video.fire('loadedmetadata');
    await h.settle();

    h.playback.stop();
    h.video.fire('ended');

    expect(h.events).toEqual([]);
  });
});

/**
 * 리뷰 #1·#2 — 어떤 실패도 조용히 끝나지 않아야 한다. 조용히 돌아가면 control의 상태에
 * `replay`가 남아 배지와 상단 REPLAY 칩이 화면에 붙은 채로 굳는다.
 */
describe('리플레이 재생 사슬 — 실패는 반드시 보고한다', () => {
  it('링이 없으면 cut을 부르지 않고 곧바로 알린다', async () => {
    const h = harness();
    h.dropRing();

    h.playback.request(REQUEST);
    await h.settle();

    expect(h.events).toEqual(['replay-unavailable']);
    expect(h.video.hidden).toBe(true);
  });

  it('버퍼가 최소치에 못 미치면 알린다', async () => {
    const h = harness({ bufferedMs: 400 });

    h.playback.request(REQUEST);
    await h.settle();

    expect(h.events).toEqual(['replay-unavailable']);
  });

  it('cut()이 null이면 알린다 — 재생 도중 링이 폐기된 경우 (리뷰 #1)', async () => {
    const h = harness({ cut: async () => null });

    h.playback.request(REQUEST);
    await h.settle();

    expect(h.events).toEqual(['replay-unavailable']);
    expect(h.video.hidden).toBe(true);
    expect(h.created).toEqual([]);
  });

  it('빈 Blob도 같은 취급이다', async () => {
    const h = harness({ cut: async () => cutOf(0, 20_000) });

    h.playback.request(REQUEST);
    await h.settle();

    expect(h.events).toEqual(['replay-unavailable']);
  });

  it('로드가 error로 끝나면 알리고 objectURL을 되돌린다 (리뷰 #2)', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();

    h.video.fire('error');
    await h.settle();

    expect(h.events).toEqual(['replay-unavailable']);
    expect(h.video.hidden).toBe(true);
    expect(h.revoked).toEqual(['blob:replay-1']);
    expect(h.video.playCalls).toBe(0);
  });

  it('메타데이터가 상한 시간 안에 오지 않으면 알린다 (리뷰 #2)', async () => {
    const h = harness({ loadTimeoutMs: 3_000 });
    h.playback.request(REQUEST);
    await h.settle();
    expect(h.pendingTimers()).toBe(1);

    h.fireTimers();
    await h.settle();

    expect(h.events).toEqual(['replay-unavailable']);
    expect(h.video.hidden).toBe(true);
    expect(h.revoked).toEqual(['blob:replay-1']);
  });

  it('play()가 거부되면 알린다', async () => {
    const h = harness();
    h.video.playResult = Promise.reject(new Error('blocked'));
    h.playback.request(REQUEST);
    await h.settle();
    h.video.fire('loadedmetadata');
    await h.settle();

    expect(h.events).toEqual(['replay-unavailable']);
    expect(h.video.hidden).toBe(true);
  });

  it('로드를 기다리다 실패해도 리스너와 타이머를 남기지 않는다', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();

    h.video.fire('error');
    await h.settle();

    expect(h.video.listenerCount('loadedmetadata')).toBe(0);
    expect(h.video.listenerCount('error')).toBe(0);
    expect(h.video.listenerCount('emptied')).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });
});

describe('리플레이 재생 사슬 — 중간에 끼어드는 조작', () => {
  it('로드를 기다리는 중에 정지하면 조용히 접는다 — 정리의 emptied를 실패로 오인하지 않는다', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();
    expect(h.video.hidden).toBe(false);

    h.playback.stop();
    await h.settle();

    expect(h.events).toEqual([]);
    expect(h.video.hidden).toBe(true);
    expect(h.video.paused).toBe(true);
    expect(h.revoked).toEqual(['blob:replay-1']);
    expect(h.pendingTimers()).toBe(0);
    expect(h.video.listenerCount('loadedmetadata')).toBe(0);
  });

  it('정지한 뒤 늦게 도착한 loadedmetadata는 화면을 건드리지 않는다', async () => {
    const h = harness();
    h.playback.request(REQUEST);
    await h.settle();
    h.playback.stop();

    h.video.fire('loadedmetadata');
    await h.settle();

    expect(h.video.playCalls).toBe(0);
    expect(h.video.hidden).toBe(true);
    expect(h.events).toEqual([]);
  });

  it('cut을 기다리는 중에 다음 되감기가 오면 앞선 결과를 버린다 (stale 토큰)', async () => {
    const first = deferred<RingCut | null>();
    const cuts: Promise<RingCut | null>[] = [first.promise, Promise.resolve(cutOf(32, 12_000))];
    let index = 0;
    const h = harness({ cut: () => cuts[index++] });

    h.playback.request({ token: 1, seconds: 10, rate: 0.5 });
    await h.settle();
    h.playback.request({ token: 2, seconds: 4, rate: 0.25 });
    await h.settle();

    // 1번의 cut이 뒤늦게 돌아온다
    first.resolve(cutOf(64, 20_000));
    await h.settle();

    expect(h.playback.token).toBe(2);
    h.video.fire('loadedmetadata');
    await h.settle();

    // 2번 구간(covered 12s − 4s)이 걸렸고 1번은 화면을 만지지 못했다
    expect(h.video.currentTime).toBe(8);
    expect(h.video.playbackRate).toBe(0.25);
    expect(h.video.playCalls).toBe(1);
    expect(h.events).toEqual([]);
  });

  it('정지 뒤 새 되감기는 정상적으로 다시 돈다', async () => {
    const h = harness();
    h.playback.request({ token: 1, seconds: 10, rate: 0.5 });
    await h.settle();
    h.playback.stop();
    await h.settle();

    h.playback.request({ token: 2, seconds: 10, rate: 0.5 });
    await h.settle();
    h.video.fire('loadedmetadata');
    await h.settle();

    expect(h.video.playCalls).toBe(1);
    expect(h.created).toEqual(['blob:replay-1', 'blob:replay-2']);
    expect(h.revoked).toEqual(['blob:replay-1']);
  });

  it('아무것도 걸려 있지 않을 때의 stop()은 화면을 건드리지 않는다', () => {
    const h = harness();
    h.playback.stop();
    h.playback.stop();

    expect(h.video.loads).toBe(0);
    expect(h.revoked).toEqual([]);
    expect(h.events).toEqual([]);
  });
});
