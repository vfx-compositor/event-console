/**
 * 슬로우 리플레이 세그먼트 링 (Q5 A안 · 2026-09-04 사용자 선택).
 *
 * 근거: `docs/spikes/2026-09-03-slow-replay/report.md`. MediaRecorder는 **완결된 파일**만
 * 재생 가능한 Blob으로 만들 수 있다(중간 조각만 모아서는 헤더가 없어 열리지 않는다).
 * 그래서 레코더를 두 개 굴리고 반 주기씩 어긋나게 회전시킨다 — 어느 순간에 잘라도
 * 항상 한쪽이 `replaySec` 이상을 덮고 있다.
 *
 * ## 계약
 * - **오디오를 담지 않는다.** 호출자가 `videoOnlyStream()`으로 비디오 트랙만 넘긴다.
 *   재생용 `<video>`는 항상 `muted`이고 audio-gain 매니저에 등록하지 않는다.
 * - 모든 외부 의존(레코더 생성·시계·타이머·Blob)은 주입식이다. 순수 단위테스트가 목적이고,
 *   display.ts는 기본값(전역)을 그대로 쓴다.
 * - `duration`이 `Infinity`로 오는 것이 정상이다(WebM live profile · Cues 없음). 재생 위치는
 *   `replaySeekSec()`이 **벽시계로 아는 커버 길이**에서 역산한다.
 */

/** 이 링이 쓰는 MediaRecorder의 최소 계약. 테스트는 이 모양만 흉내 낸다. */
export interface RecorderLike {
  readonly state: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  /** 인코더 오류. 이게 오면 `onstop`은 영영 오지 않을 수 있다 — `cut()`이 함께 기다린다 */
  onerror: (() => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
}

export interface RecorderInit {
  mimeType: string;
  videoBitsPerSecond?: number;
}

export interface RingDeps {
  createRecorder(stream: MediaStream, init: RecorderInit): RecorderLike;
  /** 단조 증가 시계(ms). 기본은 `performance.now()` */
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  createBlob(parts: Blob[], type: string): Blob;
}

export interface RingOptions {
  mimeType: string;
  /** 슬롯 하나가 도는 주기(ms). `segmentMsFor(replaySec)` */
  segmentMs: number;
  /** 조각이 떨어지는 간격(ms). 기본 1000 */
  timesliceMs?: number;
  /**
   * `cut()`이 `onstop`을 기다리는 상한(ms). 기본 2000.
   *
   * 인코더가 오류로 죽으면 `onstop`이 영영 오지 않는다. 그대로 두면 `cut()`의 Promise가
   * 미해결로 남아 재생이 시작도 실패도 하지 않고 배지가 화면에 붙은 채 굳는다.
   */
  stopTimeoutMs?: number;
  videoBitsPerSecond?: number;
}

/** `cut()`이 필요로 하는 링의 최소 계약 — 재생 모듈이 이 모양만 주입받는다. */
export interface ReplayRingLike {
  bufferedMs(): number;
  cut(): Promise<RingCut | null>;
}

export interface RingCut {
  blob: Blob;
  /** 이 Blob이 실제로 덮는 길이(ms) — 벽시계 실측이다 */
  coveredMs: number;
}

interface Slot {
  rec: RecorderLike;
  chunks: Blob[];
  startedAt: number;
}

/**
 * 되감기 길이의 **두 배**가 세그먼트 주기다.
 *
 * 두 슬롯이 반 주기씩 어긋나 있으므로, 오래된 쪽은 언제나 `segmentMs/2 = replaySec` 이상을
 * 덮고 있다(양쪽이 갓 시작한 순간은 부팅 직후뿐이고 그때는 버퍼 부족으로 걸러진다).
 */
export function segmentMsFor(replaySec: number): number {
  return Math.round(2 * replaySec * 1000);
}

/**
 * 코덱 우선순위. H.264는 macOS에서 VideoToolbox 하드웨어 인코더를 타 상주 메모리가
 * +4 MB인 반면 VP8은 +150 MB, VP9는 +440 MB였다(spike 실측).
 */
export const REPLAY_MIME_CANDIDATES: string[] = [
  'video/webm;codecs=h264',
  'video/webm;codecs=vp8',
  'video/webm',
];

/** 지원되는 첫 후보. 하나도 없으면 null — 호출자가 리플레이를 통째로 끈다. */
export function pickMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const type of REPLAY_MIME_CANDIDATES) {
    if (isTypeSupported(type)) return type;
  }
  return null;
}

/**
 * 비디오 트랙만 담은 새 스트림.
 *
 * 카메라 오디오가 켜져 있어도 리플레이 녹화본에는 소리가 들어가지 않는다 — 되감아 틀면
 * 몇 초 전 소리가 현장 소리와 겹쳐 나가고, 그 순간 `.volume`을 만질 주인도 없다.
 */
export function videoOnlyStream(
  stream: MediaStream,
  make: (tracks: MediaStreamTrack[]) => MediaStream = (tracks) => new MediaStream(tracks),
): MediaStream {
  return make(stream.getVideoTracks());
}

/**
 * 재생 시작 위치(초).
 *
 * MediaRecorder WebM은 `duration`이 `Infinity`로 오고 Cues가 없다. 그래서 브라우저에게
 * 묻지 않고 **우리가 아는 커버 길이**에서 되감기 길이를 뺀다(spike에서 ±1ms 안착 실측).
 */
export function replaySeekSec(coveredMs: number, seconds: number): number {
  return Math.max(0, coveredMs / 1000 - seconds);
}

/** 패널에 띄우는 버퍼 표시(초) — 내림한 정수, 되감기 길이에서 멈춘다. */
export function replayBufferedSec(bufferedMs: number, replaySec: number): number {
  return Math.max(0, Math.min(replaySec, Math.floor(bufferedMs / 1000)));
}

/** `×0.5` 배지·칩이 함께 쓰는 표기. 꼬리 0을 붙이지 않는다. */
export function formatReplayRate(rate: number): string {
  return String(Number(rate.toFixed(2)));
}

/**
 * 이 출력 창이 리플레이의 **주인**인가 (`location.search` 기준).
 *
 * 출력 창이 둘 이상이면 창마다 인코더가 상주하고 `replay-buffer:`·`replay-ended:` 보고가
 * 경쟁해 control이 어느 쪽을 믿어야 할지 알 수 없다. PGM 모니터 iframe은
 * `display.html?monitor=1`로 뜨기로 되어 있고, 그 창은 녹화도 재생도 하지 않는다.
 */
export function isReplayOwner(search: string): boolean {
  return new URLSearchParams(search).get('monitor') !== '1';
}

/**
 * 지금 링이 돌아야 하는가.
 *
 * 넷이 **모두** 참일 때만이다. 중계 씬을 떠나면 즉시 멈추는 것이 보수안의 핵심이다 —
 * 스팅어 1080p 알파 합성이 60fps 헤드룸을 이미 다 쓴다.
 */
export function shouldRecordReplay(input: {
  owner: boolean;
  scene: string;
  hasStream: boolean;
  enabled: boolean;
}): boolean {
  return input.owner && input.scene === 'live' && input.hasStream && input.enabled;
}

function defaultDeps(): RingDeps {
  return {
    createRecorder: (stream, init) => new MediaRecorder(stream, init) as unknown as RecorderLike,
    now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as number,
    clearInterval: (id) => globalThis.clearInterval(id),
    createBlob: (parts, type) => new Blob(parts, { type }),
  };
}

export class SegmentRing {
  private readonly deps: RingDeps;
  private readonly timesliceMs: number;
  private slots: (Slot | null)[] = [null, null];
  private timeouts: number[] = [];
  private intervals: number[] = [];
  private disposed = false;

  constructor(
    private readonly stream: MediaStream,
    private readonly opts: RingOptions,
    deps?: RingDeps,
  ) {
    this.deps = deps ?? defaultDeps();
    this.timesliceMs = opts.timesliceMs ?? 1000;
  }

  private startSlot(index: number): void {
    if (this.disposed) return;
    const rec = this.deps.createRecorder(this.stream, {
      mimeType: this.opts.mimeType,
      ...(this.opts.videoBitsPerSecond === undefined
        ? {}
        : { videoBitsPerSecond: this.opts.videoBitsPerSecond }),
    });
    const slot: Slot = { rec, chunks: [], startedAt: this.deps.now() };
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) slot.chunks.push(ev.data);
    };
    rec.start(this.timesliceMs);
    this.slots[index] = slot;
  }

  start(): void {
    if (this.disposed) return;
    const { segmentMs } = this.opts;
    this.startSlot(0);
    this.intervals.push(this.deps.setInterval(() => this.rotate(0), segmentMs));
    // 두 번째 슬롯은 반 주기 늦게 연다 — 이 어긋남이 "언제 잘라도 replaySec를 덮는다"의 근거다
    this.timeouts.push(
      this.deps.setTimeout(() => {
        if (this.disposed) return;
        this.startSlot(1);
        this.intervals.push(this.deps.setInterval(() => this.rotate(1), segmentMs));
      }, segmentMs / 2),
    );
  }

  private rotate(index: number): void {
    if (this.disposed) return;
    const old = this.slots[index];
    if (old && old.rec.state !== 'inactive') old.rec.stop();
    this.startSlot(index);
  }

  /** 지금 되감을 수 있는 최대 길이(ms). 가장 오래된 녹화 슬롯의 경과다. */
  bufferedMs(): number {
    const now = this.deps.now();
    let oldest: number | null = null;
    for (const slot of this.slots) {
      if (!slot || slot.rec.state !== 'recording') continue;
      if (oldest === null || slot.startedAt < oldest) oldest = slot.startedAt;
    }
    return oldest === null ? 0 : Math.max(0, now - oldest);
  }

  /**
   * 가장 오래된 슬롯을 닫아 **완결된** Blob을 돌려주고, 그 자리를 즉시 다시 연다.
   * 녹화 중인 슬롯이 하나도 없으면 null (버퍼 없음 → 호출자가 `replay-unavailable`).
   */
  async cut(): Promise<RingCut | null> {
    if (this.disposed) return null;
    let index = -1;
    for (let i = 0; i < this.slots.length; i += 1) {
      const slot = this.slots[i];
      if (!slot || slot.rec.state !== 'recording') continue;
      if (index < 0 || slot.startedAt < this.slots[index]!.startedAt) index = i;
    }
    if (index < 0) return null;

    const slot = this.slots[index]!;
    /**
     * `onstop`만 기다리면 **인코더가 오류로 죽었을 때 영영 깨어나지 않는다**.
     * 오류와 시간 상한을 함께 걸고, 어느 쪽으로 깨어나든 그때까지 모인 조각으로 답한다.
     */
    const done = new Promise<void>((resolve) => {
      let settled = false;
      let timer = 0;
      const wake = (): void => {
        if (settled) return;
        settled = true;
        this.deps.clearTimeout(timer);
        resolve();
      };
      slot.rec.onstop = wake;
      slot.rec.onerror = wake;
      timer = this.deps.setTimeout(wake, this.opts.stopTimeoutMs ?? 2000);
    });
    slot.rec.stop();
    await done;
    const coveredMs = Math.max(0, this.deps.now() - slot.startedAt);
    // 폐기가 stop 대기 중에 끼어들었으면 그 자리를 다시 열지 않는다
    if (!this.disposed) this.startSlot(index);
    // 조각이 하나도 없으면 열리지 않는 빈 Blob이다 — 호출자가 "되감을 것 없음"으로 다루게 null
    if (slot.chunks.length === 0) return null;
    return { blob: this.deps.createBlob(slot.chunks, this.opts.mimeType), coveredMs };
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.timeouts) this.deps.clearTimeout(id);
    for (const id of this.intervals) this.deps.clearInterval(id);
    this.timeouts = [];
    this.intervals = [];
    for (const slot of this.slots) {
      if (slot && slot.rec.state !== 'inactive') slot.rec.stop();
    }
    this.slots = [null, null];
  }
}
