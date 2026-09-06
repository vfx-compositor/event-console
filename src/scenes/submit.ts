import { activeTeamIds, activeTeams, getStage } from '../state';
import { rankSubmissions } from '../scoring';
import { fmtRemaining } from '../p2-remaining';
import { h, renderInto, type VNode } from '../vdom';
import { timerBadge } from './common';
import type { AppState, P2StageId } from '../types';

export function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 후반 각 단계의 **대기 이미지** (U97).
 *
 * 1부 게임 대기(`GAME_STEADY_IMAGES`)와 같은 계약이다: 매니페스트에 올리지 않고 URL로 직접
 * 읽는다 — 운영자가 고르는 에셋이 아니라 씬에 붙박인 그림이라, 등록 여부에 따라 화면이
 * 달라지면 안 된다. 파일은 `public/media/`에 두고 git에는 넣지 않는다(1920×1080 JPEG).
 *
 * 단계 ↔ 그림 매핑은 진행 대본이 정한 값이다. 뒤섞이면 진행자가 설명하는 게임과 화면의
 * 그림이 어긋나므로, 테스트가 세 장이 서로 다른 파일인지까지 본다.
 */
export const P2_STEADY_IMAGES: Record<P2StageId, string> = {
  s1: './media/p2_steady_stage1.svg',
  s2: './media/p2_steady_stage2.svg',
  s3: './media/p2_steady_stage3.svg',
};

/** 단계 id → 사람이 읽는 번호. 폴백 카드와 큐 라벨이 같은 값을 쓴다. */
export const P2_STAGE_NUMBER: Record<P2StageId, number> = { s1: 1, s2: 2, s3: 3 };

/**
 * 파일이 아직 없을 때 검은 화면이 나가지 않게 하는 폴백 (선서 화면 U60과 같은 장치).
 *
 * 이미지가 없으면 브라우저는 깨진 아이콘 하나만 남기고 나머지는 검정이다 — 프로젝터에서는
 * "송출이 끊겼다"로 보인다. `onerror`가 프레임에 `is-missing`을 붙이면 CSS가 이미지를 감추고
 * 뒤에 깔린 타이포 카드가 드러난다. JS 없이 CSS 상태 전환이라 렌더 경로를 타지 않는다.
 */
const P2_STEADY_FALLBACK_ONERROR = "this.closest('.p2-steady').classList.add('is-missing')";

// ───────────────────────────────────────────────────────────── 램프 플리커

/**
 * 꺼져 가는 스탠드 조명의 흔들림 (U97).
 *
 * 사용자 원문: "그냥 떠 있으면 재미없으니까. 약한 플리커를 넣어줘." 그림 자체는 어두운 취조
 * 책상이라 **강한 스트로브는 그림을 망가뜨리고 광과민성 위험도 있다.** 그래서 대부분의 시간은
 * 0.96~1.0 사이에서 숨만 쉬고, 가끔 **짧게** 한 번 꺼졌다 들어온다.
 *
 * ## 왜 순수 함수인가
 * `tick`이 매 프레임 부르는 값이라 난수 상태를 들고 있으면 창을 두 개 띄웠을 때 서로 다르게
 * 깜박이고, 테스트로 밝기 하한·깜박임 밀도를 확인할 방법이 없다. 시각 하나만 받는 순수
 * 함수로 두면 (1) 출력 창이 몇 개든 같은 그림이고 (2) 아래 계약을 전부 검사할 수 있다.
 *
 * ## 계약 (테스트가 지킨다)
 *  - 값은 항상 `[0.85, 1]`. 0.85 아래로는 내려가지 않는다 — 더 내려가면 "고장"이 아니라
 *    "송출 끊김"으로 읽힌다.
 *  - 평균 ≈ 0.97. 화면이 전반적으로 어두워지면 그건 플리커가 아니라 디밍이다.
 *  - 한 번의 하강(dip)은 **120ms 이하**, 초당 **3회 이하**. 광과민성 발작 가이드(초당 3회
 *    이하 섬광)를 위쪽 한계로 잡고, 실제 평균은 초당 1회 남짓이다.
 */
const FLICKER_MIN = 0.85;
const FLICKER_MAX = 1;

/** 흔들림의 바탕. 세 사인의 합이라 눈에 주기가 잡히지 않는다. */
const BASE_LEVEL = 0.982;

/**
 * dip 슬롯 길이(초). 한 슬롯 안에 dip은 최대 하나이고 슬롯 경계를 넘지 않는다 →
 * **1초 창에 걸치는 슬롯이 최대 3개**이므로 초당 dip 3회 상한이 산수로 보장된다.
 * (0.34초처럼 더 잘게 쪼개면 1초 창에 4개가 걸려 상한이 깨진다.)
 */
const DIP_SLOT_SEC = 0.5;
/** 슬롯에 dip이 생길 확률. 평균 초당 약 1.2회. */
const DIP_CHANCE = 0.6;
const DIP_MIN_SEC = 0.05;
/** 120ms 계약의 실제 상한 — 여유를 두고 115ms에서 끊는다. */
const DIP_MAX_SEC = 0.115;
const DIP_MIN_DEPTH = 0.06;
const DIP_MAX_DEPTH = 0.12;

/**
 * 정수 해시 → 0~1. `Math.sin` 기반 해시와 달리 부동소수 정밀도에 기대지 않아
 * 브라우저·Node 어디서 돌려도 같은 수열이 나온다(출력 창 두 개가 같이 깜박이는 근거).
 */
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 램프 플리커의 불투명도. `tSec`은 아무 기준 시각이나 좋다(주기가 없는 의사난수 수열). */
export function p2FlickerOpacity(tSec: number): number {
  if (!Number.isFinite(tSec)) return FLICKER_MAX;
  const t = tSec;

  // 1) 바탕 — 서로 나눠떨어지지 않는 세 주기의 합
  const base =
    BASE_LEVEL +
    0.006 * Math.sin((t / 3.7) * Math.PI * 2) +
    0.008 * Math.sin((t / 1.31) * Math.PI * 2 + 1.7) +
    0.004 * Math.sin((t / 0.53) * Math.PI * 2 + 0.4);

  // 2) 짧은 하강 — 슬롯당 최대 하나, 슬롯 안에서 시작하고 끝난다
  const slot = Math.floor(t / DIP_SLOT_SEC);
  const roll = hash01(slot);
  let dip = 0;
  if (roll < DIP_CHANCE) {
    const dur = DIP_MIN_SEC + hash01(slot + 1013) * (DIP_MAX_SEC - DIP_MIN_SEC);
    // dip 전체가 슬롯 안에 들어오도록 시작점을 `슬롯길이 - 최대길이` 안에서 뽑는다
    const start = slot * DIP_SLOT_SEC + (roll / DIP_CHANCE) * (DIP_SLOT_SEC - DIP_MAX_SEC);
    const p = (t - start) / dur;
    if (p > 0 && p < 1) {
      const depth = DIP_MIN_DEPTH + hash01(slot + 2027) * (DIP_MAX_DEPTH - DIP_MIN_DEPTH);
      // 반주기 사인 봉투 — 시작·끝에서 기울기가 0이라 컷이 아니라 "훅 꺼졌다 들어옴"이 된다
      dip = depth * Math.sin(Math.PI * p);
    }
  }

  return Math.max(FLICKER_MIN, Math.min(FLICKER_MAX, base - dip));
}

/**
 * 단계 대기 이미지 한 장 (U97).
 *
 * 골격은 선서 화면(U60)과 같다: 어두운 지면 위에 이미지와 폴백 카드가 서고, 그 둘을 담은
 * 플리커 레이어의 불투명도만 흔들린다. 그 위에 그레인 한 장이 덮인다. 움직이는 속성은
 * `opacity`·`transform`뿐이다 — `filter`나 `blur`를 매 프레임 걸면 1920×1080 전체가
 * 매 프레임 재합성돼 출력 창의 프레임 예산을 먹는다.
 */
function steadyView(state: AppState, stageId: P2StageId): VNode {
  const stage = getStage(state, stageId);
  const src = P2_STEADY_IMAGES[stageId];
  return h(
    'div',
    {
      class: 'scene scene--standby-image-only scene--p2-steady',
      'data-stage': stageId,
      // 그레인 세기 훅 — 이 화면은 기본(사진 씬)보다 한 단계 굵은 결을 쓴다.
      'data-grain': 'p2',
    },
    h(
      'div',
      { class: 'p2-steady' },
      /**
       * 플리커 레이어는 **덮개가 아니라 불이 켜진 쪽**이다.
       *
       * 검은 덮개의 불투명도를 올리는 방식으로 만들면 값의 의미가 뒤집혀(0.97 = 거의 암전)
       * 계약과 화면이 어긋난다. 대신 지면(`.p2-steady`)을 어둡게 칠하고 **그림 전체를**
       * 이 레이어에 담아 불투명도를 낮춘다 — 0.97이면 3% 어두워지고, dip 바닥인 0.85면
       * 15% 어두워진다. 그래서 폴백 카드도 이미지와 **같이** 깜박인다(램프가 꺼지는 것이지
       * 그림이 사라지는 것이 아니다).
       */
      h(
        'div',
        { class: 'p2-steady__flicker' },
        h('img', {
          class: 'p2-steady__image',
          src,
          alt: '',
          'aria-hidden': 'true',
          onerror: P2_STEADY_FALLBACK_ONERROR,
        }),
        h(
          'div',
          { class: 'p2-steady__fallback' },
          h('div', { class: 'p2-steady__fallback-eyebrow' }, '2부'),
          h('div', { class: 'p2-steady__fallback-title' }, stage.name),
          h('div', { class: 'p2-steady__fallback-rule' }),
        ),
      ),
      // 필름 그레인 — 정지 노이즈 타일 + steps() transform. 프레임당 filter 비용 0.
      h('div', { class: 'p2-steady__grain', 'aria-hidden': 'true' }),
    ),
  );
}

/** G6 제출 상태 바 — 상단 단계 타이틀·타이머 / 하단 참가 4팀별 제출 상태 */
export function view(state: AppState): VNode {
  const { stageId, mode } = state.sceneOpts.submit;
  if (mode === 'steady') return steadyView(state, stageId);

  const stage = getStage(state, stageId);
  const live = rankSubmissions(
    stage.submissions,
    state.settings.tieWindowSec,
    activeTeamIds(state),
  );
  const ranks = stage.confirmedAt ? stage.ranks : live;

  return h(
    'div',
    { class: 'scene scene--submit' },
    h(
      'div',
      { class: 'sub__head' },
      h('div', { class: 'sub__eyebrow' }, '진행 중'),
      h('div', { class: 'sub__title' }, stage.name),
      timerBadge(),
    ),
    h(
      'div',
      { class: 'sub__bars' },
      activeTeams(state).map((team) => {
        const id = team.id;
        const s = stage.submissions[id];
        const rank = ranks[id];
        const cls = !s ? 'is-wait' : s.correct ? 'is-ok' : 'is-ng';
        return h(
          'div',
          { class: `sub__bar ${cls}`, style: `--team:${team.color}` },
          h('div', { class: 'sub__team' }, team.name),
          h(
            'div',
            { class: 'sub__status' },
            !s
              ? h('span', { class: 'sub__wait' }, '대기')
              : h(
                  'span',
                  { class: 'sub__time' },
                  h('span', { class: 'sub__icon' }, s.correct ? '✓' : '✗'),
                  // U135 — 수기 기록은 시각이 아니라 남은 시간이다 (`at`은 음수 사상값이라
                  // 그대로 시각 포맷에 넣으면 1970년 언저리가 찍힌다).
                  s.remainingSec != null ? `남은 ${fmtRemaining(s.remainingSec)}` : hhmmss(s.at),
                ),
          ),
          s && s.correct && rank
            ? h('div', { class: 'sub__rank' }, `${rank}위`)
            : h('div', { class: 'sub__rank is-none' }, '—'),
        );
      }),
    ),
  );
}

/**
 * 램프 플리커를 매 프레임 심는다. **불투명도 하나만** 쓴다.
 *
 * 마크업이 아니라 여기서 값을 쓰는 이유는 스코어보드 재정렬(`score.ts`의 tick)과 같다 —
 * 인라인 스타일은 `renderInto`의 HTML 캐시 키 밖이라 매 프레임 씬을 다시 그리지 않는다.
 * 보드 모드에서는 대상 요소가 없어 그대로 빠진다.
 */
export function tick(root: HTMLElement, _state: AppState, now: number): void {
  const layer = root.querySelector<HTMLElement>('.p2-steady__flicker');
  if (!layer) return;
  layer.style.opacity = p2FlickerOpacity(now / 1000).toFixed(4);
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
