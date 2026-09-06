/**
 * PGM 모니터 카드 (U72) — 조작 패널 좌측 열 맨 위.
 *
 * `display.html?monitor=1`을 iframe으로 띄워 **지금 출력에 나가는 그림**을 조작 화면 안에서
 * 본다. 프로젝터를 등지고 앉는 자리에서 씬·전환·오버레이가 실제로 어떻게 나갔는지 확인할
 * 방법이 없었다.
 *
 * ## 이것은 출력 창이 **아니다**
 * 이 카드가 켜져 있으면 그림이 나가고 있다고 착각하기 쉽다. 실제 출력은 별도 창이고, 그 창이
 * 닫혀 있으면 프로젝터에는 아무것도 안 나간다. 그래서 카드 안에 `PGM` 라벨과 **출력 창 연결
 * 상태**를 함께 띄우고, 툴팁이 그 관계를 말한다. 클릭도 먹지 않는다(`pointer-events: none`) —
 * 여기를 조작해서 뭔가 되는 것처럼 보이면 안 된다.
 *
 * ## 접기가 곧 CPU 절약이다
 * 접으면 iframe을 `hidden`으로 내린다. 렌더 트리에서 빠지면 안쪽 rAF가 멎으므로 조작 PC의
 * 부담이 실제로 사라진다. **제거하지는 않는다** — DOM에서 떼면 브라우징 컨텍스트가 폐기되어
 * 다시 펼 때 통째로 다시 로드된다.
 */

import { el } from './dom';
import type { Ctx } from './ctx';

export const PGM_MONITOR_SRC = './display.html?monitor=1';

/**
 * 카드 안 출력 창 상태 한 줄 (순수 — 테스트가 이 문구를 잠근다).
 *
 * 모니터는 **출력 창이 없어도 정상으로 보인다** (같은 상태를 그리는 별개의 창이므로).
 * 그래서 여기서 연결 여부를 반드시 말해 줘야 "화면이 나오고 있으니 괜찮다"는 오판을 막는다.
 */
export function pgmStatusView(connected: boolean): { text: string; tip: string } {
  return connected
    ? {
        text: '출력 창 연결됨',
        tip: '실제 출력 창이 붙어 있습니다. 아래 미리보기는 그 창과 같은 상태를 따로 그린 것입니다.',
      }
    : {
        text: '출력 창 없음',
        tip: '실제 출력 창이 열려 있지 않습니다 — 프로젝터에는 아무것도 나가지 않습니다. 아래 미리보기는 출력이 아니라 조작 패널이 그린 그림이므로, 이것만 보고 나가고 있다고 판단하면 안 됩니다. 상단 [출력창 열기]를 누르세요.',
      };
}

/** 접기 버튼 라벨 — 형태(삼각형) + 텍스트 두 신호를 같이 준다. */
export function pgmToggleLabel(open: boolean): string {
  return open ? '▾ 접기' : '▸ 펼치기';
}

/**
 * 접힘 상태는 **창 로컬 UI 값**이라 상태·저장본에 두지 않는다(설정 탭 장치 목록 캐시와 같은
 * 관례). 카드가 재렌더 사이에 살아남는 노드라 모듈 스코프가 곧 그 카드의 수명이다.
 */
let open = true;

export function renderPgmMonitor(ctx: Ctx): HTMLElement {
  const status = pgmStatusView(ctx.status.displayConnected);

  const frame = el('iframe', {
    class: 'pgm-monitor__frame',
    src: PGM_MONITOR_SRC,
    title: 'PGM 모니터',
    attrs: { tabindex: '-1', 'aria-hidden': 'true' },
  });

  const body = el('div', { class: 'pgm-monitor__body' }, frame);

  const toggle = el('button', {
    class: 'pgm-monitor__toggle',
    type: 'button',
    text: pgmToggleLabel(open),
    attrs: { 'aria-expanded': open ? 'true' : 'false' },
    data: {
      fid: 'pgm-monitor-toggle',
      tip: '접으면 미리보기가 렌더 트리에서 빠져 조작 PC의 부담이 사라집니다. 창을 새로 로드하지는 않으므로 다시 펴면 즉시 이어집니다.',
    },
  });

  const card = el(
    'section',
    {
      class: `pgm-monitor${open ? '' : ' is-collapsed'}`,
      data: {
        tip: '출력에 나가는 그림을 조작 화면 안에서 보는 모니터입니다. 실제 출력 창이 아니므로 이 카드가 보인다고 프로젝터에 나가는 것은 아닙니다. 조작은 먹지 않습니다.',
      },
    },
    el(
      'div',
      { class: 'pgm-monitor__head' },
      el('span', { class: 'pgm-monitor__label mono-label', text: 'PGM' }),
      el('span', {
        class: `pgm-monitor__status${ctx.status.displayConnected ? ' is-on' : ''}`,
        text: status.text,
        data: { live: 'pgm-status', tip: status.tip },
        tabIndex: 0,
      }),
      toggle,
    ),
    body,
  );

  frame.hidden = !open;
  toggle.addEventListener('click', () => {
    open = !open;
    card.classList.toggle('is-collapsed', !open);
    toggle.textContent = pgmToggleLabel(open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    frame.hidden = !open;
  });

  return card;
}
