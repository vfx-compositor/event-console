import { describe, expect, it } from 'vitest';

import {
  IDLE_RENDER_HOLD,
  grabRender,
  isHeld,
  releaseAllRender,
  releaseRender,
  requestRender,
} from './render-hold';

describe('드래그 중 재렌더 보류 (U43 근본원인)', () => {
  it('평상시에는 요청이 그대로 통과한다', () => {
    const r = requestRender(IDLE_RENDER_HOLD);
    expect(r.run).toBe(true);
    expect(r.hold.pending).toBe(false);
  });

  it('잡고 있는 동안의 요청은 실행하지 않고 미뤄 둔다', () => {
    let hold = grabRender(IDLE_RENDER_HOLD, 'volume');
    expect(isHeld(hold)).toBe(true);
    expect(isHeld(hold, 'volume')).toBe(true);

    const first = requestRender(hold);
    expect(first.run).toBe(false);
    hold = first.hold;
    const second = requestRender(hold);
    expect(second.run).toBe(false);
    hold = second.hold;
    expect(hold.pending).toBe(true);
  });

  it('놓으면 미뤄 둔 재렌더를 한 번만 흘려보낸다', () => {
    let hold = grabRender(IDLE_RENDER_HOLD, 'volume');
    hold = requestRender(hold).hold;
    hold = requestRender(hold).hold;

    const released = releaseRender(hold, 'volume');
    expect(released.flush).toBe(true);
    expect(released.hold).toEqual(IDLE_RENDER_HOLD);

    // 흘려보낸 뒤에는 남은 예약이 없다 — 두 번 그리지 않는다
    expect(releaseRender(released.hold, 'volume').flush).toBe(false);
  });

  it('잡았다가 아무 변화 없이 놓으면 그리지 않는다', () => {
    const released = releaseRender(grabRender(IDLE_RENDER_HOLD, 'volume'), 'volume');
    expect(released.flush).toBe(false);
  });

  it('다시 잡을 때 이전 예약이 새 드래그로 새지 않는다', () => {
    let hold = grabRender(IDLE_RENDER_HOLD, 'volume');
    hold = requestRender(hold).hold;
    const regrabbed = grabRender(hold, 'volume');
    expect(regrabbed.pending).toBe(false);
    expect(releaseRender(regrabbed, 'volume').flush).toBe(false);
  });

  it('잡지 않은 소유자가 놓아도 아무 일도 없다', () => {
    const released = releaseRender(IDLE_RENDER_HOLD, 'music-scrub');
    expect(released.flush).toBe(false);
    expect(released.hold).toEqual(IDLE_RENDER_HOLD);
  });
});

/**
 * U104 리뷰 m2/m4 — 볼륨 슬라이더와 음악 슬라이더가 같은 계약을 공유하게 되면서 드러난
 * 다중 소유자 문제. `holding: boolean` 하나였을 때는:
 *  - m2: 볼륨을 잡고 있으면 전역 `holding`이 참이 되어 음악 슬라이더의 200ms 라이브 갱신까지
 *    같이 멈췄다(엉뚱한 슬라이더를 잡았는데 음악 핸들이 얼어붙는다).
 *  - m4: 두 슬라이더를 동시에 잡은 채 한쪽만 놓아도 boolean이라 **둘 다** 풀렸다
 *    ("놓을 때 한 번만" 계약이 다중 홀더 앞에서 깨짐).
 * `owners: Set<소유자>`로 바꿔 이 둘을 소유자 단위로 독립시킨다.
 */
describe('재렌더 보류 소유자 집합 (U104 리뷰 m2/m4)', () => {
  it('서로 다른 소유자는 독립적으로 잡을 수 있다', () => {
    let hold = grabRender(IDLE_RENDER_HOLD, 'volume');
    hold = grabRender(hold, 'music-scrub');
    expect(isHeld(hold, 'volume')).toBe(true);
    expect(isHeld(hold, 'music-scrub')).toBe(true);
    expect(isHeld(hold)).toBe(true);
  });

  it('m2 — 한쪽 소유자만 잡고 있으면 다른 소유자는 잡히지 않은 것으로 본다', () => {
    const hold = grabRender(IDLE_RENDER_HOLD, 'volume');
    // 음악 라이브 갱신 가드는 `isHeld(hold, 'music-scrub')`만 본다 — 볼륨만 잡은 상태라 거짓이어야 한다
    expect(isHeld(hold, 'music-scrub')).toBe(false);
    expect(isHeld(hold, 'volume')).toBe(true);
  });

  it('m4 — 두 소유자를 동시에 잡고 한쪽만 놓으면 나머지가 재렌더를 계속 보류한다', () => {
    let hold = grabRender(IDLE_RENDER_HOLD, 'volume');
    hold = grabRender(hold, 'music-scrub');
    hold = requestRender(hold).hold; // 잡혀 있는 동안 재렌더 요청 하나가 예약된다
    expect(hold.pending).toBe(true);

    const releasedVolume = releaseRender(hold, 'volume');
    // music-scrub가 아직 잡고 있으므로 흘려보내면 안 되고, 예약도 사라지면 안 된다(m4 핵심)
    expect(releasedVolume.flush).toBe(false);
    expect(isHeld(releasedVolume.hold, 'music-scrub')).toBe(true);
    expect(releasedVolume.hold.pending).toBe(true);

    const releasedBoth = releaseRender(releasedVolume.hold, 'music-scrub');
    // 마지막 소유자가 놓는 순간에야 비로소 흘려보낸다
    expect(releasedBoth.flush).toBe(true);
    expect(releasedBoth.hold).toEqual(IDLE_RENDER_HOLD);
  });

  it('다른 소유자가 끼어들어도 기존 소유자의 예약은 지워지지 않는다', () => {
    let hold = grabRender(IDLE_RENDER_HOLD, 'volume');
    hold = requestRender(hold).hold;
    expect(hold.pending).toBe(true);

    // 볼륨을 잡은 채로 음악 슬라이더가 새로 끼어든다 — "다시 잡기"가 아니라 "새 소유자"다
    const joined = grabRender(hold, 'music-scrub');
    expect(joined.pending).toBe(true); // 볼륨의 예약이 살아 있어야 한다

    const releasedVolume = releaseRender(joined, 'volume');
    expect(releasedVolume.flush).toBe(false); // music-scrub가 아직 잡고 있다
    const releasedAll = releaseRender(releasedVolume.hold, 'music-scrub');
    expect(releasedAll.flush).toBe(true); // 끝까지 살아남은 예약이 마지막에 흘러나온다
  });

  it('releaseAllRender는 소유자를 몰라도 전부 놓는 안전망이다', () => {
    let hold = grabRender(IDLE_RENDER_HOLD, 'volume');
    hold = grabRender(hold, 'music-scrub');
    hold = requestRender(hold).hold;

    const released = releaseAllRender(hold);
    expect(released.flush).toBe(true);
    expect(released.hold).toEqual(IDLE_RENDER_HOLD);
    expect(isHeld(released.hold)).toBe(false);
  });

  it('releaseAllRender는 아무도 안 잡고 있으면 아무 일도 하지 않는다', () => {
    const released = releaseAllRender(IDLE_RENDER_HOLD);
    expect(released.flush).toBe(false);
  });
});
