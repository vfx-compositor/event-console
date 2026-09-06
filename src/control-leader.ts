/**
 * control 창 리더 락 — 조작 패널은 한 번에 **한 창만** 상태를 바꾼다.
 *
 * 왜 필요한가: 런처는 더블클릭마다 control.html 탭을 새로 연다. 같은 origin에 control이
 * 둘 이상 뜨면 각 인스턴스가 자기 메모리 상태를 진실로 알고, display가 3초마다 보내는
 * `hello`에 **모두** 응답해 localStorage와 BroadcastChannel state를 서로 다른 씬으로
 * 번갈아 덮어쓴다(실측: standby↔live 플랩). 현장에서 실수로 두 번 열면 씬이 튄다.
 *
 * 설계 원칙
 *  · 기존 동기화 프로토콜은 **건드리지 않는다**. 리더 선출은 별도 호환 채널을 쓴다.
 *  · BroadcastChannel이 없는 환경(파일 프로토콜·구형 브라우저)은 단일 창으로 보고 즉시 리더.
 *  · DOM·타이머·난수 의존을 전부 주입 가능하게 두어 테스트에서 두 인스턴스를 시뮬레이션한다.
 *
 * ## epoch — 지연 메시지로 인한 리더 플랩 방지
 *
 * 채널 배달은 즉시가 아니다(다른 탭이 바쁘면 수백 ms 밀린다). id 사전순만으로 리더를
 * 정하면, 강제 인수 직후 도착한 **옛 리더의 잔여 heartbeat**가 새 리더를 도로 끌어내린다
 * (leader→passive→leader 플랩 = 상태 재적재가 두 번 도는 사고).
 * 그래서 승격할 때마다 `epoch`를 올리고, 리더 간 우열은 **(epoch 큰 쪽 → 같으면 id 작은 쪽)**
 * 으로 판정한다. 낮은 epoch의 lead는 무시하고 자기 lead를 되쏘아 상대를 물러나게 한다.
 *
 * ## 인수(takeover)의 한계
 *
 * 정상 경로는 "기존 리더가 저장(beforeYield) → yield → 요청자가 localStorage 재적재"라
 * 상태가 유실되지 않는다. 반면 **강제 경로**(기존 리더가 아예 응답하지 않아 타임아웃으로
 * 승격)는 기존 리더의 마지막 디바운스 저장분이 아직 안 밀렸을 수 있어, 요청자가 읽는
 * localStorage가 최대 150ms(저장 디바운스)만큼 과거일 수 있다. 이 역전을 없애려면 응답 없는
 * 창을 무한정 기다려야 하므로(행사 중 조작 불가) 확률을 낮추는 쪽을 택했다 —
 * `takeoverTimeoutMs` 기본값을 1.5초로 두어 정상 yield가 거의 항상 먼저 도착한다.
 */

export type ControlRole = 'pending' | 'leader' | 'passive';

/** 인수 거절 사유 — UI 문구는 control.ts가 정한다(프로토콜에 한글을 두지 않는다). */
export type TakeoverRefusedReason = 'save-failed';

export type LeaderMsg =
  | { type: 'probe'; id: string }
  | { type: 'lead'; id: string; epoch: number }
  | { type: 'takeover'; id: string }
  | { type: 'yield'; from: string; to: string; epoch: number }
  | { type: 'busy'; to: string; reason: TakeoverRefusedReason }
  | { type: 'resign'; id: string; epoch: number };

/**
 * BroadcastChannel의 최소 계약.
 * (`onmessage` 프로퍼티 대신 `subscribe`를 쓰는 이유: MessageEvent 전체를 흉내 내지 않고도
 *  테스트에서 가짜 버스를 구현할 수 있다.)
 */
export interface LeaderChannelLike {
  postMessage(msg: LeaderMsg): void;
  subscribe(handler: (msg: LeaderMsg) => void): void;
  close(): void;
}

/** 기존 설치의 열린 창 및 운영 데이터 호환을 위해 내부 채널 이름을 유지한다. */
export const CONTROL_LEADER_CHANNEL = 'nsdh-console.control';

/** 기본 채널 — BroadcastChannel이 없거나 막히면 null(= 단일 창으로 degrade). */
export function openLeaderChannel(name: string): LeaderChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  let bc: BroadcastChannel;
  try {
    bc = new BroadcastChannel(name);
  } catch {
    return null;
  }
  return {
    postMessage(msg) {
      try {
        bc.postMessage(msg);
      } catch {
        /* 창이 닫히는 중 — 무시 */
      }
    },
    subscribe(handler) {
      bc.addEventListener('message', (ev) => {
        const data = (ev as MessageEvent<LeaderMsg>).data;
        if (data && typeof data.type === 'string') handler(data);
      });
    },
    close() {
      try {
        bc.close();
      } catch {
        /* 무시 */
      }
    },
  };
}

/** 창마다 유일해야 하고 사전순 비교만 가능하면 된다. */
function defaultId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ControlLeaderOptions {
  /** 인스턴스 식별자. 동시 부팅 tie-break가 사전순이므로 비교 가능하기만 하면 된다. */
  id?: string;
  channelName?: string;
  createChannel?: (name: string) => LeaderChannelLike | null;
  /** 생성 직후에는 부르지 않는다 — 초기 역할은 `role()`로 읽는다. */
  onChange?: (role: ControlRole) => void;
  /**
   * 리더 자리를 넘기기 **직전** 호출. localStorage flush 용도.
   * `false`를 반환하면 자리를 넘기지 않고 요청자에게 `busy`로 거절한다 —
   * 저장에 실패한 상태를 넘기면 새 리더가 옛 localStorage를 읽어 원장이 유실된다.
   */
  beforeYield?: () => boolean;
  /** 인수 요청이 거절됐을 때 (역할은 passive 그대로). */
  onTakeoverRefused?: (reason: TakeoverRefusedReason) => void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (handle: number) => void;
  /** probe 후 아무도 응답하지 않으면 리더가 되기까지의 대기 */
  probeWaitMs?: number;
  /** 리더의 lead heartbeat 주기 */
  heartbeatMs?: number;
  /** 이 시간 동안 lead가 끊기면 passive가 승격을 시도한다 */
  leadTimeoutMs?: number;
  /** takeover 요청 후 yield를 기다리는 시간 (지나면 강제 승격) */
  takeoverTimeoutMs?: number;
}

export interface ControlLeader {
  readonly id: string;
  role(): ControlRole;
  /** 현재 리더 세대. 지연 메시지 판별용 — 테스트·디버깅에서 읽는다. */
  epoch(): number;
  /** 이 창을 주 패널로 인수한다. 리더가 flush 후 yield하거나, 타임아웃이면 강제로 승격. */
  requestTakeover(): void;
  close(): void;
}

export function createControlLeader(opts: ControlLeaderOptions = {}): ControlLeader {
  const id = opts.id ?? defaultId();
  const now = opts.now ?? (() => Date.now());
  const setT =
    opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) as unknown as number);
  const clearT = opts.clearTimeout ?? ((handle: number) => globalThis.clearTimeout(handle));
  // 살아 있는 리더는 probe에 1ms 안에 답한다 — 이 값은 "아무도 없음"을 확정하는 데만 쓰이므로
  // 짧을수록 좋다. 부팅·승격 때 조작이 잠기는 시간이 그대로 이 값이다.
  const probeWaitMs = opts.probeWaitMs ?? 300;
  const heartbeatMs = opts.heartbeatMs ?? 1_000;
  const leadTimeoutMs = opts.leadTimeoutMs ?? 3_000;
  // 정상 yield가 거의 항상 먼저 도착하도록 넉넉히 (강제 경로의 상태 역전 확률을 낮춘다)
  const takeoverTimeoutMs = opts.takeoverTimeoutMs ?? 1_500;
  const onChange = opts.onChange ?? (() => {});
  const beforeYield = opts.beforeYield ?? (() => true);
  const onTakeoverRefused = opts.onTakeoverRefused ?? (() => {});

  const channel = (opts.createChannel ?? openLeaderChannel)(opts.channelName ?? CONTROL_LEADER_CHANNEL);

  // 채널이 없으면 다른 창을 감지할 수단 자체가 없다 → 단일 창으로 보고 곧장 리더.
  let role: ControlRole = channel ? 'pending' : 'leader';
  let epoch = channel ? 0 : 1;
  /** 지금까지 관측한 가장 높은 리더 세대 */
  let seenEpoch = 0;
  let closed = false;
  let probeTimer = 0;
  let tickTimer = 0;
  let takeoverTimer = 0;
  let lastLeadAt = now();

  function post(msg: LeaderMsg): void {
    if (closed) return;
    channel?.postMessage(msg);
  }

  function setRole(next: ControlRole): void {
    if (role === next) return;
    role = next;
    onChange(next);
  }

  function cancel(handle: number): number {
    if (handle) clearT(handle);
    return 0;
  }

  function noteEpoch(value: number): void {
    if (value > seenEpoch) seenEpoch = value;
  }

  /** 리더 둘이 마주쳤을 때 상대가 이기는가 — epoch 큰 쪽, 같으면 id 사전순 작은 쪽. */
  function otherWins(otherEpoch: number, otherId: string): boolean {
    if (otherEpoch !== epoch) return otherEpoch > epoch;
    return otherId < id;
  }

  function becomeLeader(): void {
    if (closed) return;
    probeTimer = cancel(probeTimer);
    takeoverTimer = cancel(takeoverTimer);
    // 이미 리더면 아무것도 하지 않는다 — 강제 승격 뒤 뒤늦게 도착한 yield로 세대를 낭비하거나
    // onChange를 두 번 흘리면 control이 상태 재적재를 중복 실행한다.
    if (role === 'leader') return;
    epoch = Math.max(epoch, seenEpoch) + 1;
    setRole('leader');
    post({ type: 'lead', id, epoch });
  }

  function becomePassive(): void {
    if (closed) return;
    probeTimer = cancel(probeTimer);
    lastLeadAt = now();
    // 이미 passive면 heartbeat 시각만 갱신한다.
    // (여기서 takeoverTimer까지 끊으면 1초마다 오는 리더 heartbeat가 진행 중인 인수 요청을 죽인다)
    if (role === 'passive') return;
    takeoverTimer = cancel(takeoverTimer);
    setRole('passive');
  }

  function startProbe(): void {
    if (closed || !channel) return;
    probeTimer = cancel(probeTimer);
    takeoverTimer = cancel(takeoverTimer);
    lastLeadAt = now();
    setRole('pending');
    post({ type: 'probe', id });
    probeTimer = setT(() => {
      probeTimer = 0;
      // 아무도 lead로 답하지 않았다 → 이 창이 유일한 조작 패널이다
      if (role === 'pending') becomeLeader();
    }, probeWaitMs);
  }

  function tick(): void {
    if (closed) return;
    if (role === 'leader') {
      post({ type: 'lead', id, epoch });
    } else if (role === 'passive' && now() - lastLeadAt >= leadTimeoutMs) {
      // 리더 탭이 강제 종료되면 lead가 끊긴다 → 스스로 승격을 시도한다
      startProbe();
    }
    scheduleTick();
  }

  function scheduleTick(): void {
    if (closed || !channel) return;
    tickTimer = setT(() => {
      tickTimer = 0;
      tick();
    }, heartbeatMs);
  }

  function onMessage(msg: LeaderMsg): void {
    if (closed || !msg) return;
    switch (msg.type) {
      case 'probe': {
        if (msg.id === id) return;
        if (role === 'leader') {
          post({ type: 'lead', id, epoch });
          return;
        }
        // 동시 부팅 tie-break — 사전순 작은 쪽이 리더 후보, 큰 쪽은 즉시 물러난다
        if (role === 'pending' && msg.id < id) becomePassive();
        return;
      }

      case 'lead': {
        if (msg.id === id) return;
        if (role === 'leader') {
          // 리더가 둘로 갈린 경우 epoch·id로 결정적으로 수렴시킨다.
          // 내가 이기면 무시하고 내 lead를 되쏘아 상대를 물러나게 한다.
          if (otherWins(msg.epoch, msg.id)) {
            noteEpoch(msg.epoch);
            becomePassive();
          } else {
            post({ type: 'lead', id, epoch });
          }
          return;
        }
        // 낮은 epoch의 lead도 **살아 있는 리더의 신호**다 — 승격 시계(lastLeadAt)는 갱신하고
        // 세대 기록만 건너뛴다. 통째로 버리면, 리더가 resign 없이 크래시한 뒤 운영자가 새로 연
        // 복구 창(세대가 1부터 다시 시작)의 lead를 옛 passive가 못 보고 3초 뒤 스스로 승격해
        // 방금 연 창을 끌어내린다.
        if (msg.epoch >= seenEpoch) noteEpoch(msg.epoch);
        becomePassive();
        return;
      }

      case 'takeover': {
        if (msg.id === id || role !== 'leader') return;
        // 넘기기 전에 반드시 저장한다 — 새 리더는 localStorage에서 상태를 다시 읽는다.
        // 저장이 실패했는데 자리를 넘기면 그 사이의 원장·점수가 통째로 사라진다.
        if (!beforeYield()) {
          post({ type: 'busy', to: msg.id, reason: 'save-failed' });
          return;
        }
        // 역할을 **먼저** 내린다. yield 전송은 상대를 그 자리에서 리더로 만들고,
        // 그 리더의 lead heartbeat가 곧바로 되돌아온다 — 그때까지 leader로 남아 있으면
        // 수렴 규칙이 발동해 방금 넘긴 자리를 도로 빼앗는다.
        becomePassive();
        post({ type: 'yield', from: id, to: msg.id, epoch });
        return;
      }

      case 'yield': {
        if (msg.to !== id) return;
        noteEpoch(msg.epoch);
        takeoverTimer = cancel(takeoverTimer);
        becomeLeader();
        return;
      }

      case 'busy': {
        if (msg.to !== id) return;
        takeoverTimer = cancel(takeoverTimer);
        onTakeoverRefused(msg.reason);
        return;
      }

      case 'resign': {
        if (msg.id === id) return;
        noteEpoch(msg.epoch);
        // 리더가 정상 종료했다 — heartbeat 3초를 기다릴 이유가 없다
        if (role === 'passive') startProbe();
        return;
      }
    }
  }

  function requestTakeover(): void {
    // pending은 아직 리더가 있는지조차 모른다 — probe 결과를 먼저 기다린다.
    // (채널이 없으면 역할이 항상 leader이므로 이 가드가 채널 부재 경로도 함께 막는다)
    if (closed || role !== 'passive') return;
    // 타이머를 **먼저** 무장한다. 채널 배달이 동기(같은 프로세스·빠른 응답)면 리더의
    // yield/busy가 post() 안에서 즉시 처리돼 버려, 나중에 타이머를 걸면 이미 끝난 요청의
    // 타이머가 살아남아 뒤늦게 강제 승격한다(거절당했는데도 리더가 되는 사고).
    takeoverTimer = cancel(takeoverTimer);
    takeoverTimer = setT(() => {
      takeoverTimer = 0;
      // 기존 리더가 응답하지 않아도(멈춘 탭) 조작을 되찾을 수 있어야 한다
      becomeLeader();
    }, takeoverTimeoutMs);
    post({ type: 'takeover', id });
  }

  if (channel) {
    channel.subscribe(onMessage);
    startProbe();
    scheduleTick();
  }

  return {
    id,
    role: () => role,
    epoch: () => epoch,
    requestTakeover,
    close() {
      if (closed) return;
      const wasLeader = role === 'leader';
      // closed를 **먼저** 세운다. resign을 받은 창은 그 자리에서 probe를 되쏘는데,
      // 아직 열려 있으면 이 창이 "나 리더야"라고 답해 상대를 도로 passive로 눌러 버린다.
      closed = true;
      probeTimer = cancel(probeTimer);
      tickTimer = cancel(tickTimer);
      takeoverTimer = cancel(takeoverTimer);
      // 정상 종료를 알린다 — 남은 창이 heartbeat 단절 3초를 기다리지 않고 바로 승격한다
      if (wasLeader) channel?.postMessage({ type: 'resign', id, epoch });
      channel?.close();
    },
  };
}
