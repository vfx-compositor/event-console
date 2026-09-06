import { describe, expect, it } from 'vitest';
import {
  createControlLeader,
  type ControlLeader,
  type ControlLeaderOptions,
  type ControlRole,
  type LeaderChannelLike,
  type LeaderMsg,
  type TakeoverRefusedReason,
} from './control-leader';

/** 결정적 가짜 타이머 — 예약 시각 순서대로만 실행한다. */
function createClock() {
  let t = 0;
  let seq = 0;
  let tasks: { id: number; at: number; fn: () => void }[] = [];

  return {
    now: () => t,
    setTimeout(fn: () => void, ms: number): number {
      const id = ++seq;
      tasks.push({ id, at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id: number): void {
      tasks = tasks.filter((task) => task.id !== id);
    },
    advance(ms: number): void {
      const until = t + ms;
      for (;;) {
        const due = tasks
          .filter((task) => task.at <= until)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        tasks = tasks.filter((task) => task !== due);
        t = due.at;
        due.fn();
      }
      t = until;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

interface Endpoint {
  handlers: ((msg: LeaderMsg) => void)[];
  open: boolean;
  inboundDelayMs: number;
}

const owners = new WeakMap<LeaderChannelLike, Endpoint>();

/**
 * BroadcastChannel과 같은 규칙의 가짜 버스 — **자기 자신에게는 배달하지 않는다**.
 *
 * `inboundDelayMs`로 수신 지연을 줄 수 있다(바쁜 탭 흉내). 배달은 가짜 클럭에 태우므로
 * 같은 송신자 → 같은 수신자 순서는 항상 FIFO로 유지된다.
 */
function createBus(clock: Clock, opts: { async?: boolean } = {}) {
  const endpoints: Endpoint[] = [];
  const sent: LeaderMsg[] = [];

  function open(inboundDelayMs = 0): LeaderChannelLike {
    const self: Endpoint = { handlers: [], open: true, inboundDelayMs };
    endpoints.push(self);
    const channel: LeaderChannelLike = {
      postMessage(msg) {
        if (!self.open) return;
        sent.push(msg);
        for (const other of endpoints) {
          if (other === self) continue;
          const deliver = () => {
            if (!other.open) return;
            for (const h of other.handlers) h(msg);
          };
          if (opts.async || other.inboundDelayMs > 0) clock.setTimeout(deliver, other.inboundDelayMs);
          else deliver();
        }
      },
      subscribe(handler) {
        self.handlers.push(handler);
      },
      close() {
        self.open = false;
      },
    };
    owners.set(channel, self);
    return channel;
  }

  /** 채널 파티션 — 엔드포인트를 버스에서 떼거나(false) 다시 붙인다(true). */
  function setOpen(channel: LeaderChannelLike, open: boolean): void {
    const endpoint = owners.get(channel);
    if (endpoint) endpoint.open = open;
  }

  return { open, sent, setOpen };
}

interface Harness {
  leader: ControlLeader;
  roles: ControlRole[];
  yields: number[];
  refusals: TakeoverRefusedReason[];
  /**
   * **채널 파티션**이지 탭 종료가 아니다 — resign 없이 버스에서만 떼어 낸다.
   * 인스턴스의 타이머는 계속 돌고 역할도 그대로 유지되므로, 크래시한 탭이 아니라
   * "메시지가 오가지 않는 창"에 가깝다. 실제 탭 종료는 `leader.close()`다.
   */
  crash: () => void;
  /** 파티션을 되돌린다 — 갈라졌던 두 리더가 서로를 다시 보게 된다 */
  heal: () => void;
}

function spawn(
  bus: ReturnType<typeof createBus>,
  clock: Clock,
  id: string,
  extra: Partial<ControlLeaderOptions> & { inboundDelayMs?: number; saveOk?: boolean } = {},
): Harness {
  const roles: ControlRole[] = [];
  const yields: number[] = [];
  const refusals: TakeoverRefusedReason[] = [];
  const { inboundDelayMs = 0, saveOk = true, ...options } = extra;
  let channel: LeaderChannelLike | null = null;
  const leader = createControlLeader({
    id,
    createChannel: () => {
      channel = bus.open(inboundDelayMs);
      return channel;
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (role) => roles.push(role),
    beforeYield: () => {
      yields.push(clock.now());
      return saveOk;
    },
    onTakeoverRefused: (reason) => refusals.push(reason),
    ...options,
  });
  const own = () => channel as LeaderChannelLike | null;
  return {
    leader,
    roles,
    yields,
    refusals,
    crash: () => {
      const ch = own();
      if (ch) bus.setOpen(ch, false);
    },
    heal: () => {
      const ch = own();
      if (ch) bus.setOpen(ch, true);
    },
  };
}

describe('control 리더 락', () => {
  it('단독으로 부팅하면 probe 대기 후 리더가 된다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');

    // probe 대기 중에는 아직 조작 권한이 없다 (오버레이는 "확인 중" 문구로 덮여 있다)
    expect(a.leader.role()).toBe('pending');
    clock.advance(299);
    expect(a.leader.role()).toBe('pending');
    clock.advance(1);
    expect(a.leader.role()).toBe('leader');
    expect(a.roles).toEqual(['leader']);
    expect(a.leader.epoch()).toBe(1);
  });

  it('BroadcastChannel이 없는 환경은 단일 창으로 보고 즉시 리더가 된다', () => {
    const clock = createClock();
    const solo = createControlLeader({
      id: 'solo',
      createChannel: () => null,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    expect(solo.role()).toBe('leader');
    solo.close();
  });

  it('리더가 이미 있으면 나중에 연 창은 passive가 된다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(700);
    expect(a.leader.role()).toBe('leader');

    const b = spawn(bus, clock, 'b');
    // 리더가 probe에 즉시 lead로 답하므로 대기 없이 판정된다
    expect(b.leader.role()).toBe('passive');
    clock.advance(2_000);
    expect(b.leader.role()).toBe('passive');
    expect(a.leader.role()).toBe('leader');
  });

  it('동시에 부팅하면 id 사전순으로 tie-break 되어 리더가 하나만 남는다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const big = spawn(bus, clock, 'b-window');
    const small = spawn(bus, clock, 'a-window');

    // 큰 쪽은 상대 probe를 보는 순간 물러난다
    expect(big.leader.role()).toBe('passive');
    clock.advance(700);
    expect(small.leader.role()).toBe('leader');
    expect(big.leader.role()).toBe('passive');
  });

  it('창이 셋이어도 리더는 하나이고 인수 후에도 하나다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(700);
    const b = spawn(bus, clock, 'b');
    const c = spawn(bus, clock, 'c');
    clock.advance(1_000);

    expect([a, b, c].map((w) => w.leader.role())).toEqual(['leader', 'passive', 'passive']);

    c.leader.requestTakeover();
    clock.advance(1_000);

    expect([a, b, c].map((w) => w.leader.role())).toEqual(['passive', 'passive', 'leader']);
    // 인수하지 않은 제3의 창이 덩달아 승격하지 않는다
    expect(b.roles).toEqual(['passive']);
  });

  it('인수 요청은 기존 리더가 저장을 끝낸 뒤에 넘어간다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(700);
    const b = spawn(bus, clock, 'b');
    expect(b.leader.role()).toBe('passive');

    b.leader.requestTakeover();

    // beforeYield(=localStorage flush)가 먼저, 그 다음에 역할 교대
    expect(a.yields).toHaveLength(1);
    expect(a.leader.role()).toBe('passive');
    expect(b.leader.role()).toBe('leader');
    expect(a.roles).toEqual(['leader', 'passive']);
    expect(b.roles).toEqual(['passive', 'leader']);
    // 새 리더의 세대가 더 높아야 지연된 옛 heartbeat에 밀리지 않는다
    expect(b.leader.epoch()).toBeGreaterThan(a.leader.epoch());
  });

  it('기존 리더의 저장이 실패하면 인수를 거절하고 자리를 지킨다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a', { saveOk: false });
    clock.advance(700);
    const b = spawn(bus, clock, 'b');

    b.leader.requestTakeover();

    // 저장 못 한 상태를 넘기면 새 리더가 옛 localStorage를 읽어 원장이 사라진다
    expect(a.leader.role()).toBe('leader');
    expect(b.leader.role()).toBe('passive');
    expect(b.refusals).toEqual(['save-failed']);

    // 거절 후 강제 승격 타이머도 취소돼야 한다 — 몰래 리더가 되면 안 된다
    clock.advance(5_000);
    expect(b.leader.role()).toBe('passive');
    expect(a.leader.role()).toBe('leader');
  });

  it('멈춘 리더가 응답하지 않아도 takeoverTimeout 뒤 인수가 완료된다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(700);
    const b = spawn(bus, clock, 'b');

    // 메시지에 아무 응답도 못 하는 창 (resign도 yield도 오지 않는다)
    a.crash();
    b.leader.requestTakeover();

    clock.advance(1_499);
    expect(b.leader.role()).toBe('passive');
    clock.advance(1);
    expect(b.leader.role()).toBe('leader');
  });

  it('리더가 인사 없이 사라진 뒤 새로 연 복구 창을 옛 passive가 끌어내리지 않는다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(300);
    // 운영자가 두 번째 창에서 인수 → 세대가 올라간다
    const p = spawn(bus, clock, 'p');
    p.leader.requestTakeover();
    expect(p.leader.role()).toBe('leader');
    expect(a.leader.role()).toBe('passive');

    // 인수한 창이 resign 없이 사라진다(크래시)
    p.crash();
    // 운영자가 복구용으로 새 창을 연다 — 새 창의 세대는 1부터 다시 시작한다
    const d = spawn(bus, clock, 'd');
    clock.advance(300);
    expect(d.leader.role()).toBe('leader');

    // 옛 passive가 "세대가 낮다"며 새 창의 lead를 통째로 버리면,
    // 3초 뒤 스스로 승격해 방금 연 복구 창을 끌어내린다
    clock.advance(10_000);
    expect(d.leader.role()).toBe('leader');
    expect(a.leader.role()).toBe('passive');
    expect(d.roles).toEqual(['leader']);
  });

  it('파티션으로 리더가 둘로 갈려도 치유되면 하나로 수렴한다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(300);
    const b = spawn(bus, clock, 'b');
    expect(b.leader.role()).toBe('passive');

    // 채널만 끊긴다 — a는 여전히 자기가 리더라고 믿고 heartbeat를 계속 던진다
    a.crash();
    clock.advance(4_000);
    expect(a.leader.role()).toBe('leader');
    expect(b.leader.role()).toBe('leader');

    a.heal();
    clock.advance(2_000);
    expect([a, b].filter((w) => w.leader.role() === 'leader')).toHaveLength(1);
    // 파티션 중 승격해 세대가 높은 쪽이 남는다
    expect(b.leader.role()).toBe('leader');
    expect(a.leader.role()).toBe('passive');
  });

  it('강제 인수 경로에서도 리더 역할이 왕복하지 않는다 (지연 메시지)', () => {
    const clock = createClock();
    const bus = createBus(clock, { async: true });
    // a는 바쁜 탭 — 수신이 900ms 밀린다. b도 400ms 밀려 a의 잔여 heartbeat가
    // b의 강제 승격 이후에 도착한다(= epoch가 없으면 리더가 왕복하는 상황).
    const a = spawn(bus, clock, 'a', { inboundDelayMs: 900, heartbeatMs: 500 });
    clock.advance(700);
    expect(a.leader.role()).toBe('leader');

    clock.advance(100);
    // 배달이 양쪽으로 밀리는 상황이라 probe 왕복(≈1.3초)보다 대기를 길게 줘야
    // b가 "아무도 없다"고 오판하지 않는다 — 지연 자체를 재현하는 것이 이 테스트의 목적이다
    const b = spawn(bus, clock, 'b', {
      inboundDelayMs: 400,
      takeoverTimeoutMs: 800,
      probeWaitMs: 1_500,
    });
    clock.advance(1_200);
    expect(b.leader.role()).toBe('passive');

    b.leader.requestTakeover();
    clock.advance(3_000);

    // pending → passive → leader. 중간에 passive로 떨어졌다 올라오면 상태 재적재가 두 번 돈다.
    expect(b.roles).toEqual(['passive', 'leader']);
    expect(b.leader.role()).toBe('leader');
    expect(a.leader.role()).toBe('passive');
    expect(b.leader.epoch()).toBeGreaterThan(a.leader.epoch());
  });

  it('리더 탭이 사라져 heartbeat가 끊기면 passive가 스스로 승격한다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(700);
    const b = spawn(bus, clock, 'b');
    clock.advance(2_000);
    expect(b.leader.role()).toBe('passive');

    // resign 한마디 없이 사라진 경우(탭 강제 종료·크래시) — lead 단절 3초 감지 + probe 700ms
    a.crash();
    clock.advance(3_000);
    expect(b.leader.role()).not.toBe('leader');
    clock.advance(1_000);
    expect(b.leader.role()).toBe('leader');
  });

  it('리더가 정상 종료하면 resign으로 즉시 승격을 시작한다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(700);
    const b = spawn(bus, clock, 'b');
    clock.advance(1_000);

    a.leader.close();
    // heartbeat 단절 3초를 기다리지 않는다 — probe 대기만 지나면 된다
    expect(b.leader.role()).toBe('pending');
    clock.advance(299);
    expect(b.leader.role()).toBe('pending');
    clock.advance(1);
    expect(b.leader.role()).toBe('leader');
    expect(b.roles).toEqual(['passive', 'pending', 'leader']);
  });

  it('리더가 잠깐 조용해도 다시 응답하면 passive로 복귀한다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    // heartbeat를 아주 길게 줘서 "살아 있지만 조용한 리더"를 만든다
    const a = spawn(bus, clock, 'a', { heartbeatMs: 100_000 });
    clock.advance(700);
    const b = spawn(bus, clock, 'b');
    expect(b.leader.role()).toBe('passive');

    // 단절 감지 → probe → 리더가 lead로 답한다
    clock.advance(4_000);
    expect(b.roles).toEqual(['passive', 'pending', 'passive']);
    expect(b.leader.role()).toBe('passive');
    expect(a.leader.role()).toBe('leader');
  });

  it('pending 중에는 인수 요청을 받지 않는다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');

    a.leader.requestTakeover();

    // 아직 리더가 있는지도 모르는 상태 — takeover를 쏘면 안 된다
    expect(bus.sent.filter((m) => m.type === 'takeover')).toHaveLength(0);
    clock.advance(700);
    expect(a.leader.role()).toBe('leader');
  });

  it('인수 왕복 중에 창이 닫혀도 남은 창이 리더를 되찾는다', () => {
    const clock = createClock();
    const bus = createBus(clock, { async: true });
    const a = spawn(bus, clock, 'a', { inboundDelayMs: 900 });
    clock.advance(700);
    // 비동기 배달이라 리더 발견이 한 틱 늦는다 — probe 대기를 넉넉히 준다
    const b = spawn(bus, clock, 'b', { probeWaitMs: 1_500 });
    clock.advance(1_200);
    expect(b.leader.role()).toBe('passive');

    b.leader.requestTakeover();
    b.leader.close(); // 요청해 놓고 탭을 닫아 버린다

    clock.advance(5_000);
    // a는 yield를 보내고 passive로 내려갔지만, 받을 창이 없으므로 스스로 되돌아온다
    expect(b.leader.role()).toBe('passive');
    expect(a.leader.role()).toBe('leader');
  });

  it('close 후에는 heartbeat를 더 보내지 않는다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(3_000);
    expect(a.leader.role()).toBe('leader');

    a.leader.close();
    const before = bus.sent.length;
    clock.advance(10_000);
    expect(bus.sent.length).toBe(before);
  });

  it('리더는 heartbeat로 lead를 계속 방송한다', () => {
    const clock = createClock();
    const bus = createBus(clock);
    const a = spawn(bus, clock, 'a');
    clock.advance(700);
    const before = bus.sent.filter((m) => m.type === 'lead').length;
    clock.advance(3_100);
    const after = bus.sent.filter((m) => m.type === 'lead').length;
    expect(after - before).toBeGreaterThanOrEqual(3);
    a.leader.close();
  });
});
