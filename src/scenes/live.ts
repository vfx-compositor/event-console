import { h, renderInto, type VNode } from '../vdom';
import { eventBadge, scorebar, timerBadge } from './common';
import { getTeam } from '../state';
import { logoClass, logoUrl } from '../logos';
import { formatReplayRate } from '../replay-ring';
import { versusIconSides, type VersusIconSide } from '../versus-pairs';
import type { AppState, LiveReplay } from '../types';

/**
 * 슬로우 리플레이 표식 (Q5, 좌상단 위치는 U108). 되감은 그림이 라이브처럼 보이면 사고다.
 *
 * **U108** — 사용자 지시("좌상단에 리플레이라고 써줘")로 우하단(스코어바 바로 위)에서
 * 좌상 종목 배지 **바로 아래**로 옮겼다. 라벨 텍스트도 `REPLAY ×배속`에서 `리플레이`
 * 한 단어로 바꿨다 — 배속 숫자는 `aria-label`에 남겨 스크린리더에서는 여전히 읽힌다.
 * 화면의 리플레이 표식은 이 배지 하나뿐이다(중복 표기 금지). 종목 배지·상단 VS 바·
 * 우상 타이머와는 겹치지 않는다(좌상 세로 스택 한 줄). 움직이는 것은 빨간 점의
 * opacity 하나뿐이다 — 카메라 위에 얹히는 크롬이라 합성기를 나눠 쓰는 다른 애니메이션을
 * 만들지 않는다.
 */
function replayBadge(replay: LiveReplay): VNode {
  return h(
    'div',
    { class: 'replay-badge', 'aria-label': `슬로우 리플레이 ${formatReplayRate(replay.rate)}배속` },
    h('span', { class: 'replay-badge__dot' }),
    h('span', { class: 'replay-badge__label' }, '리플레이'),
  );
}

/**
 * 대결 팀 아이콘 한 쪽 (U21). 로고가 준비돼 있으면 로고, 없으면 팀 색 배지 + 팀명.
 * 좌·우는 컬러 보더와 같은 배열에서 나오므로 방향이 어긋날 수 없다.
 */
function versusIcon(side: VersusIconSide): VNode {
  return h(
    'div',
    {
      class: `vs-teams__side vs-teams__side--${side.side === 'left' ? 'l' : 'r'}`,
      'data-team': side.teamId,
      style: `--team-color:${side.color}`,
    },
    side.logo
      ? h('img', { class: logoClass('vs-teams__logo', side.logo), src: side.logo, alt: '' })
      : h('span', { class: 'vs-teams__badge' }, side.initial),
    h('span', { class: 'vs-teams__name' }, side.name),
  );
}

/**
 * 오버레이 슬롯 (U68) — **조건 없이** 항상 렌더하고, 보임/숨김은 `tick()`이 클래스로만 정한다.
 *
 * ## 왜 조건부 렌더를 그만두는가
 * `vdom.ts`에는 diff가 없다 — HTML 문자열이 1바이트라도 다르면 `innerHTML`을 통째로 갈아끼운다.
 * 토글 하나가 꺼져 vnode가 `null`이 되면 문자열이 달라지고, 씬 전체가 새 엘리먼트로 교체된다.
 * 새로 만들어진 엘리먼트에는 시작점이 없어 CSS transition이 돌 자리가 없다(끝값으로 점프한다).
 *
 * 그래서 켬/끔을 **vnode 밖으로 뺀다**. HTML은 토글과 무관하게 고정되고, 재렌더 자체가
 * 일어나지 않으므로 클래스 변화에 붙은 transition이 제대로 돈다. 대기 화면이 light/dark와
 * 사진 슬롯을 조건 없이 렌더하고 opacity로만 고르는 것(`standby.ts`)과 같은 계약이고,
 * "시간에 따라 변하는 것은 vnode가 아니라 tick에서"(`vdom.ts`)와도 정확히 같은 자리다.
 *
 * 슬롯은 스테이지를 통째로 덮는 상자다(`position:absolute; inset:0`). 안에 든 배지·바가
 * 전부 절대 배치라, 감싸는 상자가 같은 기하를 가져야 좌표가 그대로다. 상자에 걸리는
 * transform은 안쪽 요소의 자기 transform(예: `.vs-teams`의 가운데 정렬)과 곱해질 뿐이다.
 */
function ovSlot(kind: 'versus' | 'badge' | 'timer' | 'scorebar', child: VNode | null): VNode {
  return h('div', { class: `ov-slot ov-slot--${kind}` }, child);
}

/**
 * S3 라이브캠 — 카메라 풀 + 오버레이.
 * `.cam-slot`은 비워 둔다: 실제 <video>/NO SIGNAL은 display.ts가 싱글턴 엘리먼트로 붙인다.
 * (HTML이 교체돼도 스트림이 끊기지 않도록 재부착)
 */
export function view(state: AppState): VNode {
  const o = state.sceneOpts.liveOverlay;
  const vs = o.versus;
  const left = vs ? getTeam(state, vs[0]) : null;
  const right = vs ? getTeam(state, vs[1]) : null;
  // 좌상 종목 배지·우상 타이머와 겹치지 않게 상단 가운데 바로 띄운다
  const icons = versusIconSides(vs, (id) => getTeam(state, id), logoUrl);
  return h(
    'div',
    { class: 'scene scene--live' },
    h('div', { class: 'cam-slot', 'data-cam-slot': '1' }),
    left && right
      ? h(
          'div',
          { class: 'vs-borders', 'aria-label': `${left.name} 대 ${right.name} 대결 프레임` },
          h('span', { class: 'vs-borders__l', style: `--team-color:${left.color}` }),
          h('span', { class: 'vs-borders__r', style: `--team-color:${right.color}` }),
        )
      : h('div', { class: 'vs-borders vs-borders--neutral' }),
    ovSlot(
      'versus',
      icons
        ? h(
            'div',
            { class: 'vs-teams' },
            versusIcon(icons[0]),
            h('span', { class: 'vs-teams__vs' }, 'VS'),
            versusIcon(icons[1]),
          )
        : null,
    ),
    // 배지·대결은 켬/끔이 곧 데이터다(종목 id·팀 쌍이 null이면 꺼짐). 껍데기는 늘 남기고
    // 속 내용만 데이터를 따른다 — 껍데기가 있어야 사라지는 쪽에도 transition이 붙는다.
    ovSlot('badge', eventBadge(state, o.badge)),
    ovSlot('timer', timerBadge()),
    ovSlot('scorebar', scorebar(state)),
    /**
     * 리플레이 배지만 조건부로 남는다 (Q5).
     *
     * 켜지는 순간이 곧 "지금 나가는 그림이 라이브가 아니다"라는 경고라, 280ms 페이드로
     * 부드럽게 스미면 안 된다 — 있거나 없거나 둘 중 하나로 읽혀야 한다. 배지 자체도
     * 빨간 점의 opacity 펄스로 이미 살아 있다.
     */
    o.replay ? replayBadge(o.replay) : null,
  );
}

/**
 * 오버레이 켬/끔 (U68) — **DOM 클래스만** 만진다. 상태는 건드리지 않는다.
 *
 * `scenes/index.ts`의 tick 훅에서 매 프레임 불린다(`award.ts`의 `data-bind` 슬롯 갱신과 같은
 * 계약). `view()`는 언제나 켜진 모양으로 그리므로, 실제 켬/끔은 여기 한 곳에서만 갈린다.
 */
function toggleSlot(root: HTMLElement, kind: string, on: boolean): void {
  root.querySelector(`.ov-slot--${kind}`)?.classList.toggle('is-off', !on);
}

export function tick(root: HTMLElement, state: AppState): void {
  const o = state.sceneOpts.liveOverlay;
  toggleSlot(root, 'versus', o.versus !== null);
  toggleSlot(root, 'badge', o.badge !== null);
  toggleSlot(root, 'timer', o.timer);
  toggleSlot(root, 'scorebar', o.scorebar);
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
