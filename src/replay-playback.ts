/**
 * 슬로우 리플레이 재생 구동기 (Q5 A안).
 *
 * `display.ts`에서 떼어 낸 이유는 순수하게 **테스트 가능성**이다. 이 흐름은
 * `cut()` → objectURL → 메타데이터 로드 → 시크 → 재생 → 종료의 비동기 사슬이고,
 * 중간 어디서든 정지·씬 이탈·다음 재생이 끼어들 수 있다. 소스 문자열을 grep해서
 * "이렇게 짰다"를 확인하는 것으로는 이 사슬이 실제로 안 끊기는지 알 수 없다.
 *
 * ## 이 모듈이 지키는 계약
 * - **어떤 실패도 조용히 끝나지 않는다.** 잘라 낼 것이 없거나(`cut()` null), 로드가
 *   실패하거나, 상한 시간 안에 메타데이터가 오지 않거나, `play()`가 거부되면 반드시
 *   `replay-unavailable`을 낸다. 안 그러면 control의 상태에 `replay`가 남아 배지와
 *   상단 칩이 화면에 붙은 채 굳는다.
 * - **실패 정리는 상태 왕복을 기다리지 않는다.** 실패 시 그 자리에서 pause·hidden·revoke를
 *   끝낸다. control 창이 닫혀 있거나 리더가 아니어도 카메라 위에 정지 프레임이 남지 않는다.
 * - **정상 종료는 마지막 프레임을 붙잡고 기다린다 (U85).** 끝까지 돈 재생은 pause만 하고
 *   화면을 놓지 않는다 — 나가는 컷을 스팅어가 덮기로 했기 때문이다. 여기서 곧바로 `hidden`을
 *   세우면 스팅어가 도착하기 전에 카메라가 드러나 "덮는다"는 말이 무의미해진다. 화면을 실제로
 *   놓는 것은 control이 컷을 내려 상태의 `replay`가 비고 `stop()`이 불릴 때다.
 *   그 왕복이 영영 오지 않는 경우(리더 없음·창 닫힘)를 위해 `holdTimeoutMs` 안전망을 함께 건다 —
 *   정지 프레임이 화면에 영영 붙어 있는 것이 U85 이전 계약이 막고 있던 사고다.
 * - **토큰이 주인이다.** 비동기 사슬의 모든 재개 지점에서 자기 토큰이 아직 유효한지 본다.
 *   늦게 도착한 결과는 화면을 건드리지 않고 조용히 버린다(그 자리의 주인은 다음 재생이다).
 */

import { replaySeekSec, type ReplayRingLike } from './replay-ring';

/** 이 모듈이 내는 사건. `DisplayEvent`의 부분집합이라 그대로 emit할 수 있다. */
export type ReplayPlaybackEvent = `replay-ended:${number}` | 'replay-unavailable';

export interface ReplayRequest {
  token: number;
  /** 되감을 길이(초) */
  seconds: number;
  /** 재생 배속 */
  rate: number;
}

/** 재생에 쓰는 `<video>`의 최소 계약. `HTMLVideoElement`가 그대로 들어맞는다. */
export interface ReplayVideoLike {
  hidden: boolean;
  src: string;
  currentTime: number;
  playbackRate: number;
  pause(): void;
  play(): Promise<void>;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ReplayPlaybackDeps {
  video: ReplayVideoLike;
  /** 지금 쓸 링. 재생성·폐기될 수 있으므로 매 재생마다 다시 묻는다 */
  ring(): ReplayRingLike | null;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  emit(event: ReplayPlaybackEvent): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** 메타데이터 로드 상한(ms). 기본 3000 */
  loadTimeoutMs?: number;
  /** 되감기가 성립하는 최소 버퍼(ms). 기본 1000 */
  minBufferedMs?: number;
  /**
   * 정상 종료 뒤 마지막 프레임을 붙잡고 control의 컷을 기다리는 상한(ms). 기본 5000 (U85).
   *
   * 나가는 스팅어는 `switchAtSec`(기본 0.5~0.65초)에 컷을 내므로 정상 경로에서는 절대
   * 만나지 않는 값이다. 이 타이머의 유일한 목적은 **아무도 컷을 내주지 않는 경우**
   * (control 창이 닫혔거나 리더가 죽었거나 스팅어가 워치독에 걸린 경우) 정지 프레임이
   * 카메라 위에 영영 남지 않게 하는 것이다.
   */
  holdTimeoutMs?: number;
}

type LoadOutcome = 'ok' | 'lost' | 'stale';

export class ReplayPlayback {
  /**
   * 지금 맡고 있는 재생 토큰. `stop()`만 이 값을 비운다 — 재생이 끝나도 비우지 않는다.
   * 끝난 뒤 비우면 상태가 아직 돌아오기 전인 다음 프레임이 같은 요청을 새 재생으로 보고
   * 방금 끝난 구간을 다시 튼다.
   */
  private activeToken: number | null = null;
  /** 이 토큰의 재생이 이미 끝났거나(정상 종료) 실패로 접혔는가 */
  private settled = true;
  private url: string | null = null;
  /** 메타데이터를 기다리는 중이면 그 대기를 즉시 깨우는 함수 */
  private cancelLoad: (() => void) | null = null;
  /** 정상 종료 뒤 마지막 프레임을 붙잡고 있는 안전망 타이머 (U85). 0이면 없다. */
  private holdTimer = 0;

  constructor(private readonly deps: ReplayPlaybackDeps) {
    deps.video.addEventListener('ended', () => this.onEnded());
  }

  /** 지금 화면을 맡고 있는 토큰 (테스트·진단용) */
  get token(): number | null {
    return this.activeToken;
  }

  /**
   * 매 프레임 불린다. 같은 토큰이면 아무 일도 하지 않는다 —
   * 재생이 끝난 뒤에도 상태가 돌아올 때까지 같은 요청이 계속 들어오기 때문이다.
   */
  request(request: ReplayRequest): void {
    if (this.activeToken === request.token) return;
    this.cancelLoad?.();
    this.release();
    this.activeToken = request.token;
    this.settled = false;
    void this.run(request);
  }

  /** 정지·씬 이탈·모니터 창. 화면과 리소스를 놓고 토큰을 비운다. */
  stop(): void {
    if (this.activeToken === null && this.settled && this.url === null) return;
    this.activeToken = null;
    this.settled = true;
    this.cancelLoad?.();
    this.release();
  }

  /**
   * 끝까지 돌았다 (U85 — 화면을 **놓지 않고** 보고한다).
   *
   * 예전에는 여기서 `release()`로 곧바로 숨겼다. 그러면 라이브 카메라가 그 프레임에 드러나고,
   * control이 그 뒤에 띄우는 나가는 스팅어는 **이미 끝난 컷을 덮게** 된다 — 사용자가 본
   * "리플레이 끝날 때 스팅어가 안 나온다"의 실체다(정확히는 스팅어가 컷 뒤에 왔다).
   *
   * 그래서 지금은 pause만 하고 마지막 프레임을 붙잡는다. 화면을 실제로 놓는 것은 control이
   * 스팅어가 덮은 순간 컷을 내려 상태의 `replay`가 비고 `stop()`이 불릴 때다. 그 왕복이 영영
   * 오지 않을 때를 위해 상한 타이머를 함께 건다.
   */
  private onEnded(): void {
    const token = this.activeToken;
    if (token === null || this.settled) return;
    this.settled = true;
    this.deps.video.pause();
    this.holdTimer = this.deps.setTimeout(() => {
      this.holdTimer = 0;
      // 아직 이 재생이 화면의 주인이면(= 컷이 오지 않았다) 그때는 우리가 놓는다
      if (this.activeToken === token) this.release();
    }, this.deps.holdTimeoutMs ?? 5000);
    this.deps.emit(`replay-ended:${token}`);
  }

  /** 되감을 것이 없다 — 화면을 놓고 control에 알린다(그래야 상태의 `replay`가 비워진다). */
  private fail(token: number): void {
    if (this.activeToken !== token || this.settled) return;
    this.settled = true;
    this.release();
    this.deps.emit('replay-unavailable');
  }

  /** 이 토큰이 아직 화면의 주인인가 */
  private owns(token: number): boolean {
    return this.activeToken === token && !this.settled;
  }

  private release(): void {
    // 붙잡고 있던 마지막 프레임의 안전망은 여기서 함께 접는다 (U85) — 화면을 놓는 자리가
    // 여기 하나뿐이므로 타이머 수명도 같은 곳에서 끝나야 새 재생 위로 늦게 터지지 않는다
    if (this.holdTimer) {
      this.deps.clearTimeout(this.holdTimer);
      this.holdTimer = 0;
    }
    const { video } = this.deps;
    video.pause();
    video.hidden = true;
    if (this.url === null) return;
    video.removeAttribute('src');
    video.load();
    this.deps.revokeObjectURL(this.url);
    this.url = null;
  }

  private async run(request: ReplayRequest): Promise<void> {
    const ring = this.deps.ring();
    const minBuffered = this.deps.minBufferedMs ?? 1000;
    // 버퍼가 최소치에 못 미치면 빈 화면을 띄우느니 패널에 알리고 만다
    if (!ring || ring.bufferedMs() < minBuffered) {
      this.fail(request.token);
      return;
    }

    const cut = await ring.cut();
    if (!this.owns(request.token)) return;
    /**
     * `cut()`이 null이면 stop 대기 중에 링이 폐기됐다는 뜻이다(재생 도중 `replaySec`
     * 변경·씬 이탈·카메라 교체). **조용히 돌아가면 안 된다** — 상태의 `replay`는 그대로라
     * 배지와 상단 칩이 켜진 채 남는다.
     */
    if (!cut || cut.blob.size === 0) {
      this.fail(request.token);
      return;
    }

    const { video } = this.deps;
    this.url = this.deps.createObjectURL(cut.blob);
    video.src = this.url;
    video.hidden = false;

    const outcome = await this.awaitMetadata(request.token);
    if (outcome === 'stale') return;
    if (outcome === 'lost') {
      this.fail(request.token);
      return;
    }

    // MediaRecorder WebM은 duration이 Infinity로 온다 — 우리가 아는 커버 길이에서 역산한다
    video.currentTime = replaySeekSec(cut.coveredMs, request.seconds);
    video.playbackRate = request.rate;
    try {
      await video.play();
    } catch {
      // 무음 비디오라 autoplay 정책에 걸릴 이유가 없지만, 막히면 라이브로 돌려보낸다
      this.fail(request.token);
    }
  }

  /**
   * `loadedmetadata`를 기다리되 **빠져나올 길을 전부 연다**.
   *
   * `error`/`emptied`(소스 교체·정리), 시간 상한, 외부 정지 중 어느 것이든 먼저 오는 쪽이
   * 이긴다. 하나라도 빠지면 Promise가 미해결로 남아 재생이 시작도 실패도 하지 않는다.
   */
  private awaitMetadata(token: number): Promise<LoadOutcome> {
    const { video } = this.deps;
    return new Promise<LoadOutcome>((resolve) => {
      let done = false;
      let timer = 0;
      const settle = (outcome: LoadOutcome): void => {
        if (done) return;
        done = true;
        this.deps.clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onLost);
        video.removeEventListener('emptied', onLost);
        this.cancelLoad = null;
        // 기다리는 사이에 주인이 바뀌었으면 결과와 무관하게 stale이다
        resolve(this.owns(token) ? outcome : 'stale');
      };
      const onLoaded = (): void => settle('ok');
      const onLost = (): void => settle('lost');
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onLost);
      video.addEventListener('emptied', onLost);
      timer = this.deps.setTimeout(() => settle('lost'), this.deps.loadTimeoutMs ?? 3000);
      // `stop()`이 정리(`load()`)를 하기 **전에** 이 대기를 깨운다 — 정리가 만드는
      // `emptied`를 실패로 오인해 `replay-unavailable`을 내지 않게.
      this.cancelLoad = () => settle('stale');
    });
  }
}
