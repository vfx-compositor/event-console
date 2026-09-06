/**
 * 드래그 중 재렌더 보류 (U43 근본원인, U104 리뷰 m2/m4로 소유자 집합 도입).
 *
 * ## 무엇이 깨져 있었나
 * 조작 패널의 `render()`는 `clear(app)` 뒤 트리를 **통째로 새로 만든다**. 볼륨 슬라이더를
 * 끌면 첫 `input`에서 `dispatch → render()`가 돌고, 포인터를 붙잡고 있던 바로 그
 * `<input type="range">` 엘리먼트가 교체된다. 브라우저의 암묵적 포인터 캡처는 떨어져 나간
 * 옛 노드에 남으므로 드래그가 그 자리에서 끊긴다 — **클릭은 되는데 드래그만 안 되던** 이유다.
 * `restoreFocus()`는 포커스만 되살릴 뿐 포인터 캡처를 되살리지 못한다.
 *
 * ## 고치는 방법
 * 포인터를 잡고 있는 동안에는 재렌더를 실행하지 않고 **미뤄 둔다**. dispatch는 그대로 돌아
 * 상태·persist·출력 창 방송은 실시간으로 나가고, DOM만 그 자리에 가만히 있는다. 놓는 순간
 * 미뤄 둔 재렌더를 딱 한 번 흘려보내 화면을 상태에 맞춘다.
 *
 * ## 소유자 집합 (U104 리뷰 m2/m4)
 * 처음엔 `holding: boolean` 하나였다 — 볼륨 슬라이더 하나만 이 계약을 썼을 때는 충분했다.
 * 음악 슬라이더(U104)가 같은 계약을 재사용하면서 문제가 생겼다: 볼륨 슬라이더를 잡고 있는
 * 동안 전역 `holding`이 참이 되어 음악 슬라이더의 라이브 갱신까지 같이 멈췄고(m2), 두 슬라이더를
 * 동시에 잡은 채 한쪽만 놓아도 boolean 하나뿐이라 **둘 다** 풀려버렸다(m4, "놓을 때 한 번만"
 * 계약이 다중 홀더 앞에서 깨짐). 그래서 `holding: boolean` 대신 `owners: Set<소유자>`를 쓴다.
 * `owners.size > 0`가 옛 `holding`과 같고, `isHeld(hold, owner)`로 **특정 소유자**만 볼 수 있다.
 * `releaseRender`는 그 소유자만 집합에서 뺀다 — 다른 소유자가 남아 있으면 재렌더는 계속 보류다.
 *
 * 순수 상태 머신으로 뽑아 둔 이유는 이 계약(“놓을 때 한 번만”, “다시 잡으면 예약이 새지
 * 않는다”, “다른 소유자의 홀드·예약을 건드리지 않는다”)을 DOM 없이 검증하기 위해서다.
 */

/**
 * 지금 이 계약을 쓰는 소유자 — 새 슬라이더가 늘면 여기 추가한다.
 *
 * `'sidebar-resize'`(U137)는 슬라이더가 아니라 좌측 열 구분선이지만 이유가 같다: 끄는 동안
 * 다른 경로(동기화 하트비트·타이머)의 재렌더가 돌면 좌·중앙 열 내용물이 통째로 갈리며
 * 드래그 내내 리플로가 튄다. 구분선 자체는 `.main`과 함께 재렌더에서 살아남는 뼈대(U72)라
 * 교체되지는 않는다 — 여기서 막는 것은 드래그가 끊기는 것이 아니라 화면이 떠는 것이다.
 */
export type RenderHoldOwner = 'volume' | 'music-scrub' | 'sidebar-resize';

export interface RenderHold {
  /** 지금 재렌더를 미루게 만들고 있는 소유자들 (비어 있으면 아무도 안 잡은 것) */
  readonly owners: ReadonlySet<RenderHoldOwner>;
  /** 미뤄 둔 재렌더가 있는가 (소유자 전원이 놓을 때 딱 한 번 흘려보낸다) */
  readonly pending: boolean;
}

export const IDLE_RENDER_HOLD: RenderHold = { owners: new Set(), pending: false };

/** `owner`를 생략하면 "누구라도 잡고 있는가"(옛 `holding`), 넘기면 그 소유자만 본다. */
export function isHeld(hold: RenderHold, owner?: RenderHoldOwner): boolean {
  return owner === undefined ? hold.owners.size > 0 : hold.owners.has(owner);
}

/**
 * `owner`가 잡았다. **같은 소유자가 놓지 않고 다시 잡으면**(중복 pointerdown 등) 그 사이
 * 예약은 버린다 — 원래 U43 계약("아무것도 안 움직인 새 드래그가 놓는 순간 한 번 더 그리지
 * 않는다")이다. 반대로 **다른 소유자가 새로 끼어드는 것**은 예약을 건드리지 않는다 — 볼륨을
 * 잡은 채 음악 슬라이더를 잡아도(혹은 그 반대) 볼륨 쪽이 쌓아 둔 예약이 사라지면 안 된다(m4).
 */
export function grabRender(hold: RenderHold, owner: RenderHoldOwner): RenderHold {
  const alreadyHeld = hold.owners.has(owner);
  const owners = alreadyHeld ? hold.owners : new Set(hold.owners).add(owner);
  return { owners, pending: alreadyHeld ? false : hold.pending };
}

/**
 * `owner`가 놓았다. **다른 소유자가 아직 잡고 있으면** 재렌더는 계속 보류고 `flush`는
 * 거짓이다(m4) — 예약(`pending`)도 그대로 남아, 마지막 소유자가 놓을 때 흘려보낸다.
 * 잡지 않은 소유자가 놓으면 아무 일도 일어나지 않는다.
 */
export function releaseRender(hold: RenderHold, owner: RenderHoldOwner): { hold: RenderHold; flush: boolean } {
  if (!hold.owners.has(owner)) return { hold, flush: false };
  if (hold.owners.size > 1) {
    const owners = new Set(hold.owners);
    owners.delete(owner);
    return { hold: { owners, pending: hold.pending }, flush: false };
  }
  return { hold: IDLE_RENDER_HOLD, flush: hold.pending };
}

/**
 * 안전망 전용 — **누가 잡고 있었는지 모를 때**(창 밖에서 포인터를 떼거나 창이 포커스를 잃는
 * 전역 이벤트) 소유자와 무관하게 전부 놓는다. 개별 소유자의 `holdRender(owner, false)`
 * 대신 이걸 쓰는 이유는, 전역 리스너는 애초에 "지금 누가 잡고 있었는지" 알 도리가 없기
 * 때문이다 — 아는 것은 "포인터/포커스가 어딘가에서 떨어졌다"뿐이다.
 */
export function releaseAllRender(hold: RenderHold): { hold: RenderHold; flush: boolean } {
  if (hold.owners.size === 0) return { hold, flush: false };
  return { hold: IDLE_RENDER_HOLD, flush: hold.pending };
}

/** 재렌더 요청. `run`이 거짓이면 실행하지 않고 예약만 남긴 것이다. */
export function requestRender(hold: RenderHold): { hold: RenderHold; run: boolean } {
  if (hold.owners.size === 0) return { hold: IDLE_RENDER_HOLD, run: true };
  return { hold: { owners: hold.owners, pending: true }, run: false };
}
