import { describe, expect, it, vi } from 'vitest';

import {
  REPLAY_MIME_CANDIDATES,
  SegmentRing,
  formatReplayRate,
  pickMimeType,
  replayBufferedSec,
  replaySeekSec,
  segmentMsFor,
  videoOnlyStream,
  type RecorderLike,
  type RingDeps,
} from './replay-ring';

/**
 * 가짜 MediaRecorder — `start(timeslice)`마다 조각을 뱉지 않고, 테스트가 `pushChunk()`로
 * 직접 넣는다. 실제 인코더의 타이밍은 spike에서 이미 실측했고, 여기서 확인할 것은
 * **슬롯 회전과 완결 규칙**이다.
 */
class FakeRecorder implements RecorderLike {
  state: string = 'inactive';
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  startedWith: number | undefined;
  /** true면 stop()이 아무 신호도 내지 않는다 — 인코더가 죽은 상황 재현 */
  wedged = false;
  constructor(readonly init: { mimeType: string; videoBitsPerSecond?: number }) {}
  start(timesliceMs?: number): void {
    this.state = 'recording';
    this.startedWith = timesliceMs;
  }
  stop(): void {
    this.state = 'inactive';
    if (this.wedged) return;
    // 실제 MediaRecorder는 stop 직후 **남은 구간을 마지막 조각으로 한 번 더 흘린 뒤**
    // onstop을 부른다. 링이 그 tail flush에 의존하므로 여기서도 같은 순서로 낸다.
    this.pushChunk('tail');
    this.onstop?.();
  }
  pushChunk(text: string): void {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
}

/** 결정적 시계 + 수동으로 굴리는 타이머 */
function harness() {
  let clock = 0;
  const timers = new Map<number, { fn: () => void; at: number; every: number | null }>();
  let nextId = 1;
  const recorders: FakeRecorder[] = [];

  const deps: RingDeps = {
    createRecorder: (_stream, init) => {
      const rec = new FakeRecorder(init);
      recorders.push(rec);
      return rec;
    },
    now: () => clock,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms, every: null });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    setInterval: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms, every: ms });
      return id;
    },
    clearInterval: (id) => void timers.delete(id),
    createBlob: (parts, type) => new Blob(parts, { type }),
  };

  /** 시계를 ms만큼 전진시키며 그 사이에 만기가 된 타이머를 순서대로 실행한다 */
  const advance = (ms: number): void => {
    const target = clock + ms;
    for (;;) {
      let due: { id: number; at: number } | null = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (due === null || t.at < due.at)) due = { id, at: t.at };
      }
      if (!due) break;
      clock = due.at;
      const timer = timers.get(due.id)!;
      if (timer.every === null) timers.delete(due.id);
      else timer.at = clock + timer.every;
      timer.fn();
    }
    clock = target;
  };

  return { deps, recorders, advance, timerCount: () => timers.size, at: () => clock };
}

const STREAM = {} as MediaStream;

describe('리플레이 세그먼트 링 (Q5 A안)', () => {
  it('세그먼트 길이는 되감기 길이의 두 배다 — 어느 순간에도 한 슬롯이 replaySec를 덮는다', () => {
    expect(segmentMsFor(10)).toBe(20_000);
    expect(segmentMsFor(3)).toBe(6_000);
  });

  it('start()는 첫 슬롯을 즉시, 두 번째 슬롯을 반 주기 뒤에 연다', () => {
    const h = harness();
    const ring = new SegmentRing(STREAM, { mimeType: 'video/webm', segmentMs: 20_000 }, h.deps);
    ring.start();

    expect(h.recorders).toHaveLength(1);
    expect(h.recorders[0].state).toBe('recording');
    // timeslice 기본값 1초 — 조각이 1초마다 떨어져야 cut()이 완결 Blob을 만들 수 있다
    expect(h.recorders[0].startedWith).toBe(1000);

    h.advance(10_000);
    expect(h.recorders).toHaveLength(2);
    expect(h.recorders[1].state).toBe('recording');
  });

  it('각 슬롯은 자기 주기마다 회전하고, 회전한 자리는 즉시 새 레코더로 채워진다', () => {
    const h = harness();
    const ring = new SegmentRing(STREAM, { mimeType: 'video/webm', segmentMs: 20_000 }, h.deps);
    ring.start();

    h.advance(20_000); // 슬롯1 개시(10s) + 슬롯0 회전(20s)
    expect(h.recorders).toHaveLength(3);
    expect(h.recorders[0].state).toBe('inactive');
    expect(h.recorders[2].state).toBe('recording');

    h.advance(10_000); // 슬롯1 회전(30s)
    expect(h.recorders).toHaveLength(4);
    expect(h.recorders[1].state).toBe('inactive');
  });

  it('bufferedMs는 가장 오래된 녹화 슬롯의 경과다 — 회전해도 절대 0으로 떨어지지 않는다', () => {
    const h = harness();
    const ring = new SegmentRing(STREAM, { mimeType: 'video/webm', segmentMs: 20_000 }, h.deps);
    expect(ring.bufferedMs()).toBe(0);

    ring.start();
    h.advance(5_000);
    expect(ring.bufferedMs()).toBe(5_000);

    h.advance(15_000); // 20s — 슬롯0이 회전했고 슬롯1은 10초째다
    expect(ring.bufferedMs()).toBe(10_000);

    h.advance(10_000); // 30s — 슬롯1이 회전했고 슬롯0은 10초째다
    expect(ring.bufferedMs()).toBe(10_000);
  });

  it('cut()은 가장 오래된 슬롯을 닫아 완결 Blob과 실제 커버 길이를 주고 그 자리를 다시 연다', async () => {
    const h = harness();
    const ring = new SegmentRing(STREAM, { mimeType: 'video/webm;codecs=h264', segmentMs: 20_000 }, h.deps);
    ring.start();

    h.advance(3_000);
    h.recorders[0].pushChunk('aaa');
    h.advance(9_000); // 12s — 슬롯1도 열려 있다
    h.recorders[0].pushChunk('bb');

    const cut = await ring.cut();
    expect(cut).not.toBeNull();
    expect(cut!.coveredMs).toBe(12_000);
    expect(cut!.blob.type).toBe('video/webm;codecs=h264');
    // 'aaa'(3) + 'bb'(2) + stop이 흘린 tail(4). tail을 빠뜨리면 마지막 구간이 잘려 나간다
    expect(cut!.blob.size).toBe(9);
    // 잘라 낸 자리는 즉시 다시 녹화 중이다 (다음 리플레이가 바로 가능해야 한다)
    expect(h.recorders[0].state).toBe('inactive');
    expect(h.recorders.filter((r) => r.state === 'recording')).toHaveLength(2);
  });

  it('cut()은 더 오래된 쪽을 고른다 — 회전 직후에도 긴 구간이 나간다', async () => {
    const h = harness();
    const ring = new SegmentRing(STREAM, { mimeType: 'video/webm', segmentMs: 20_000 }, h.deps);
    ring.start();
    h.advance(25_000); // 슬롯0은 5초째, 슬롯1은 15초째

    const cut = await ring.cut();
    expect(cut!.coveredMs).toBe(15_000);
    expect(h.recorders[1].state).toBe('inactive');
  });

  it('시작하지 않았거나 폐기된 링의 cut()은 null이다 (버퍼 없음 보고 경로)', async () => {
    const h = harness();
    const ring = new SegmentRing(STREAM, { mimeType: 'video/webm', segmentMs: 20_000 }, h.deps);
    expect(await ring.cut()).toBeNull();

    ring.start();
    ring.dispose();
    expect(await ring.cut()).toBeNull();
  });

  it('dispose()는 타이머와 레코더를 전부 끊는다 — 씬을 떠나면 인코더가 남지 않는다', () => {
    const h = harness();
    const ring = new SegmentRing(STREAM, { mimeType: 'video/webm', segmentMs: 20_000 }, h.deps);
    ring.start();
    h.advance(12_000);
    expect(h.timerCount()).toBeGreaterThan(0);

    ring.dispose();
    expect(h.timerCount()).toBe(0);
    expect(h.recorders.every((r) => r.state === 'inactive')).toBe(true);
    expect(ring.bufferedMs()).toBe(0);

    // 폐기 뒤에는 남은 타이머가 새 레코더를 만들지 않는다
    const before = h.recorders.length;
    h.advance(60_000);
    expect(h.recorders).toHaveLength(before);
  });

  it('dispose()를 두 번 불러도 안전하다', () => {
    const h = harness();
    const ring = new SegmentRing(STREAM, { mimeType: 'video/webm', segmentMs: 20_000 }, h.deps);
    ring.start();
    ring.dispose();
    expect(() => ring.dispose()).not.toThrow();
  });
});

/**
 * `cut()`이 `onstop`만 기다리면 인코더가 죽었을 때 영영 깨어나지 않는다.
 * 그 Promise가 미해결로 남으면 재생이 시작도 실패도 하지 않아 배지가 화면에 붙은 채 굳는다.
 */
describe('cut()이 멈추지 않는다 (인코더 오류·무응답)', () => {
  it('onstop이 오지 않아도 상한 시간에 깨어나 모인 조각으로 답한다', async () => {
    const h = harness();
    const ring = new SegmentRing(
      STREAM,
      { mimeType: 'video/webm', segmentMs: 20_000, stopTimeoutMs: 2_000 },
      h.deps,
    );
    ring.start();
    h.advance(5_000);
    h.recorders[0].pushChunk('abc');
    h.recorders[0].wedged = true;

    const pending = ring.cut();
    h.advance(2_000); // 상한 도달
    const cut = await pending;

    expect(cut).not.toBeNull();
    expect(cut!.blob.size).toBe(3);
    expect(cut!.coveredMs).toBe(7_000);
  });

  it('onerror로 깨어나면 상한을 기다리지 않는다', async () => {
    const h = harness();
    const ring = new SegmentRing(STREAM, { mimeType: 'video/webm', segmentMs: 20_000 }, h.deps);
    ring.start();
    h.advance(4_000);
    h.recorders[0].pushChunk('xy');
    h.recorders[0].wedged = true;

    const pending = ring.cut();
    h.recorders[0].onerror?.();
    const cut = await pending;

    expect(cut!.blob.size).toBe(2);
  });

  it('조각이 하나도 없으면 null이다 — 열리지 않는 빈 Blob을 재생에 넘기지 않는다', async () => {
    const h = harness();
    const ring = new SegmentRing(
      STREAM,
      { mimeType: 'video/webm', segmentMs: 20_000, stopTimeoutMs: 1_000 },
      h.deps,
    );
    ring.start();
    h.advance(3_000);
    h.recorders[0].wedged = true; // tail flush조차 없다

    const pending = ring.cut();
    h.advance(1_000);
    expect(await pending).toBeNull();
    // 그래도 그 자리는 다시 열려 다음 되감기를 준비한다
    expect(h.recorders.filter((r) => r.state === 'recording').length).toBeGreaterThan(0);
  });
});

/**
 * 되감기 **직후의 회복 곡선**. `cut()`은 오래된 슬롯을 가져가고 그 자리를 0부터 다시
 * 시작하므로, 남은 슬롯의 나이가 곧 그 순간의 버퍼다. 최악의 경우(막 회전한 직후에
 * 되감으면) 버퍼가 거의 0으로 떨어지고 **`replaySec`만큼** 지나야 원래 길이를 회복한다.
 * 연속 되감기가 왜 바로 안 되는지가 여기서 나온다 — 패널 툴팁·README가 이 사실을 말한다.
 */
describe('되감기 직후 버퍼 회복 (Q5 리뷰 #5)', () => {
  const SEC = 10;

  it('가득 찬 상태에서 되감으면 남은 슬롯의 나이만큼만 남는다', async () => {
    const h = harness();
    const ring = new SegmentRing(
      STREAM,
      { mimeType: 'video/webm', segmentMs: segmentMsFor(SEC) },
      h.deps,
    );
    ring.start();
    h.advance(25_000); // 슬롯0 나이 5s, 슬롯1 나이 15s → 표시 버퍼는 상한 10초
    expect(replayBufferedSec(ring.bufferedMs(), SEC)).toBe(SEC);

    await ring.cut(); // 오래된 슬롯1을 가져간다 → 남은 것은 나이 5초짜리 슬롯0
    expect(ring.bufferedMs()).toBe(5_000);
    expect(replayBufferedSec(ring.bufferedMs(), SEC)).toBe(5);
  });

  it('최악의 경우 버퍼가 0 근처로 떨어지고 replaySec만큼 지나야 회복한다', async () => {
    const h = harness();
    const ring = new SegmentRing(
      STREAM,
      { mimeType: 'video/webm', segmentMs: segmentMsFor(SEC) },
      h.deps,
    );
    ring.start();
    // 슬롯0이 막 회전한 직후(나이 0) — 이때 되감으면 남는 것이 가장 어리다
    h.advance(20_000);
    await ring.cut();
    expect(ring.bufferedMs()).toBe(0);

    // 1초면 다시 누를 수는 있지만(최소 버퍼 1초) 길이는 그만큼뿐이다
    h.advance(1_000);
    expect(replayBufferedSec(ring.bufferedMs(), SEC)).toBe(1);

    // 원래 길이 회복은 replaySec 뒤 — 그 사이 되감기는 짧게 나간다
    h.advance(9_000);
    expect(replayBufferedSec(ring.bufferedMs(), SEC)).toBe(SEC);
  });
});

describe('코덱 선택', () => {
  it('H.264 → VP8 → 컨테이너 기본 순서로 고른다 (메모리 실측 근거)', () => {
    expect(REPLAY_MIME_CANDIDATES).toEqual([
      'video/webm;codecs=h264',
      'video/webm;codecs=vp8',
      'video/webm',
    ]);
    expect(pickMimeType(() => true)).toBe('video/webm;codecs=h264');
    expect(pickMimeType((t) => t !== 'video/webm;codecs=h264')).toBe('video/webm;codecs=vp8');
    expect(pickMimeType((t) => t === 'video/webm')).toBe('video/webm');
  });

  it('아무것도 지원하지 않으면 null — 호출자가 리플레이를 통째로 끈다', () => {
    expect(pickMimeType(() => false)).toBeNull();
  });
});

describe('비디오 전용 스트림', () => {
  it('오디오 트랙을 떼고 비디오 트랙만 담은 새 스트림을 만든다 (녹화본은 항상 무음)', () => {
    const video = { kind: 'video' } as MediaStreamTrack;
    const source = {
      getVideoTracks: () => [video],
      getAudioTracks: () => [{ kind: 'audio' } as MediaStreamTrack],
    } as unknown as MediaStream;
    const make = vi.fn((tracks: MediaStreamTrack[]) => ({ tracks }) as unknown as MediaStream);

    const out = videoOnlyStream(source, make);

    expect(make).toHaveBeenCalledWith([video]);
    expect((out as unknown as { tracks: MediaStreamTrack[] }).tracks).toEqual([video]);
  });
});

describe('시크 목표 · 버퍼 표시', () => {
  it('벽시계로 아는 커버 길이에서 되감기 길이를 뺀 자리로 시크한다 (duration=Infinity 대응)', () => {
    expect(replaySeekSec(20_000, 10)).toBe(10);
    expect(replaySeekSec(12_500, 10)).toBe(2.5);
  });

  it('커버가 되감기보다 짧으면 처음부터 튼다 (음수 시크 금지)', () => {
    expect(replaySeekSec(4_000, 10)).toBe(0);
    expect(replaySeekSec(0, 10)).toBe(0);
  });

  it('표시 버퍼는 내림한 정수 초이고 되감기 길이에서 멈춘다', () => {
    expect(replayBufferedSec(0, 10)).toBe(0);
    expect(replayBufferedSec(1_999, 10)).toBe(1);
    expect(replayBufferedSec(9_900, 10)).toBe(9);
    expect(replayBufferedSec(45_000, 10)).toBe(10);
  });
});

describe('배속 표기', () => {
  it('꼬리 0을 붙이지 않는다 — 배지와 상단 칩이 같은 문자열을 쓴다', () => {
    expect(formatReplayRate(0.5)).toBe('0.5');
    expect(formatReplayRate(0.25)).toBe('0.25');
    expect(formatReplayRate(1)).toBe('1');
    expect(formatReplayRate(0.75)).toBe('0.75');
  });
});
